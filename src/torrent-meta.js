// BT 只读清单 —— 种子元数据（磁力解析 / infohash / .torrent 解析 / 元数据取回）
//
// 🔴 本模块的设计红线（判据 test-种子只读清单.mjs 会逐条断源码）：
//   · **不写盘**：全文件不出现 fs.writeFile / writeFileSync，连 fs 都不 import。
//   · **不做种、不下载**：只做到「拿到 info 字典的原始字节」为止。
//     不构造 piece 请求消息（BT 协议的 msg id 6）、不向 tracker 报到、不开监听端口。
//     fetchTorrentFromCache 只是把 .torrent 拉下来，不涉及任何 piece 传输。
//   · 三重把关一步都不省：content-type / 严格 bencode 走到字节尾 / SHA-1 相等。
//
// 原型见 _bt/bencode.mjs、_bt/dht-par.mjs（已实测跑通），此处为移植 + 加固：
// fork 自 _bt/dht-par.mjs；改动：① 补 let tick = null（原型踩过的 ReferenceError）；
// ② 对外只暴露 dhtFetchMeta（去掉 dhtFetch 那层 budget 包装）；③ infohash/超时先校验 clamp；
// ④ 加 deps 注入点，好让判据在**完全离线**的情况下证明「永不回话也不会挂死」。

import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import { decode, encode, topLevelSpans } from './bencode.js';

// ⚠️ 这四个是标准引导节点。实测只有 dht.transmissionbt.com:6881 与
// dht.libtorrent.org:25401 会回；另外两个超时。放四个但别指望全通（无效的只是白等，不影响结果）。
const BOOT = [
  ['dht.transmissionbt.com', 6881],
  ['dht.libtorrent.org', 25401],
  ['router.bittorrent.com', 6881],
  ['router.utorrent.com', 6881],
];

const isHex40 = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const errText = (e) => String((e && (e.code || e.name + ': ' + e.message)) || e).slice(0, 90);

// ───────────────────────── 文件名净化 ─────────────────────────

// 控制字符 U+0000-U+001F、DEL U+007F、双向排版覆盖 U+202A-U+202E 一律清掉。
const UNSAFE = /[\u0000-\u001f\u007f\u202a-\u202e]/g;

function stripUnsafe(name) {
  return String(name == null ? '' : name).replace(UNSAFE, '').replace(/[\\/]+/g, '/').trim();
}

/** 单条文件名 = 净化 + 截 60 字符（清单一行一个，太长会把界面撑爆）。 */
export function sanitizeFileName(name) {
  const s = stripUnsafe(name);
  return s.length > 60 ? s.slice(0, 60) : s;
}

// ───────────────────────── 磁力链接 ─────────────────────────

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** base32（RFC4648，小写无填充）→ hex；非法字符返回 null。 */
function base32ToHex(s) {
  let bits = 0, val = 0, hex = '';
  for (const ch of String(s).toLowerCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; hex += ((val >>> bits) & 0xff).toString(16).padStart(2, '0'); }
  }
  return hex;
}

function decodeXt(xt) {
  const m = /^urn:btih:([0-9a-zA-Z]+)$/i.exec(String(xt || '').trim());
  if (!m) return null;
  const raw = m[1];
  if (/^[0-9a-fA-F]{40}$/.test(raw)) return raw.toLowerCase();
  if (/^[a-zA-Z2-7]{32}$/.test(raw)) {
    const hex = base32ToHex(raw);
    return hex && hex.length === 40 ? hex : null;
  }
  return null;
}

/**
 * 解析磁力链接。只读：不联网、不写盘。
 * @returns {{infoHash:string, name:string|null, sizeBytes:number|null} | null}
 */
export function parseMagnet(input) {
  const s = String(input == null ? '' : input).trim();
  if (!/^magnet:/i.test(s)) return null;
  const q = s.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(s.slice(q + 1));
  let infoHash = null;
  for (const xt of params.getAll('xt')) { const h = decodeXt(xt); if (h) { infoHash = h; break; } }
  if (!infoHash) return null;
  const dn = params.get('dn');
  // 🔴 dn 也要过净化：磁力链接是外源输入，RLO 能把文件名显示成另一个样子
  const name = dn ? (stripUnsafe(dn).slice(0, 80) || null) : null;
  const xl = params.get('xl');
  const sizeBytes = xl != null && /^\d+$/.test(xl.trim()) ? Number(xl.trim()) : null;
  return { infoHash, name, sizeBytes };
}

// ───────────────────────── .torrent 解析 ─────────────────────────

function sha1Hex(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

const utf8 = (b) => (Buffer.isBuffer(b) ? b.toString('utf8') : String(b));

/** 从 .torrent 原始字节取 40 位小写 infohash（对 info 字典的**原始区间**做 SHA-1）。 */
export function infoHashFromTorrent(buf) {
  const spans = topLevelSpans(buf);
  const sp = spans.get('info');
  if (!sp) throw new Error('.torrent 缺少 info 字典');
  return sha1Hex(buf.subarray(sp.start, sp.end));
}

function joinPath(parts) {
  if (!parts.length) return '';
  if (parts.length === 1) return sanitizeFileName(parts[0]);
  return parts.slice(0, -1).map(sanitizeFileName).join('/') + '/' + sanitizeFileName(parts[parts.length - 1]);
}

/**
 * 解析 .torrent。解不动**抛错**（调用方自己 catch，不许静默当成成功）。
 * @returns {{ok:true, infoHash:string, name:string, totalBytes:number, files:{path:string,length:number}[]}}
 */
/** 从 info 字典值出清单（parseTorrent 与 listFromInfo 共用**一份**，别各写一份）。 */
function filesFromInfo(info, infoHash) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw new Error('info 不是字典');
  const rawName = utf8(info['name.utf-8'] || info.name || '') || infoHash;
  const name = sanitizeFileName(rawName);

  const files = [];
  if (Array.isArray(info.files)) {
    for (const f of info.files) {
      const parts = (Array.isArray(f['path.utf-8']) ? f['path.utf-8'] : f.path) || [];
      const pathStr = joinPath(parts.map(utf8));
      const full = pathStr ? name + '/' + pathStr : name;
      files.push({ path: sanitizeFileName(full), length: Number(f.length) || 0 });
    }
  } else if (info.length != null) {
    files.push({ path: sanitizeFileName(name), length: Number(info.length) || 0 });
  } else {
    throw new Error('info 里既没有 files 也没有 length');
  }
  const totalBytes = files.reduce((a, f) => a + (Number(f.length) || 0), 0);
  return { name, totalBytes, files };
}

export function parseTorrent(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('parseTorrent: 不是 Buffer 或为空');
  const { value, end } = decode(buf, 0);
  if (end !== buf.length) throw new Error('parseTorrent: 尾部有多余 ' + (buf.length - end) + ' 字节（可能是截断/拼接）');
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.info) throw new Error('parseTorrent: 顶层没有 info');
  const infoHash = infoHashFromTorrent(buf);
  return { ok: true, infoHash, ...filesFromInfo(value.info, infoHash) };
}

/**
 * 从**裸 info 字典字节**出清单。
 *
 * 🔴 为什么需要它（与 `parseTorrent` 的分工）：DHT/BEP9 抓回来的**就是 info 字典本身**
 *    （metadata_size 那么长的一段 bencode，没有外层 `d4:info…e` 壳），拿 `parseTorrent` 去解
 *    它会报「顶层没有 info」。镜像站拿到的才是完整 .torrent。
 *    ⇒ 两条路线各用自己的解析入口，但**清单构造共用 filesFromInfo**（一份实现）。
 * @param {Buffer} infoBuf 裸 info 字典的 bencode 字节
 * @param {string} [infoHashHint] 已知的 40 位 hex；不传现算
 */
export function listFromInfo(infoBuf, infoHashHint = '') {
  if (!Buffer.isBuffer(infoBuf) || infoBuf.length === 0) throw new Error('listFromInfo: 不是 Buffer 或为空');
  const { value, end } = decode(infoBuf, 0);
  if (end !== infoBuf.length) throw new Error('listFromInfo: 尾部有多余 ' + (infoBuf.length - end) + ' 字节（可能是截断）');
  const infoHash = /^[0-9a-f]{40}$/.test(String(infoHashHint || '').toLowerCase())
    ? String(infoHashHint).toLowerCase()
    : sha1Hex(infoBuf);
  return { ok: true, infoHash, ...filesFromInfo(value, infoHash) };
}

// ───────────────────────── 缓存站取 .torrent（三重把关）────────────────────────

/**
 * 从 itorrents 缓存站取 .torrent 并**逐条验真**。
 * 🔴 必须主动 abort：实测 AbortSignal.timeout 到点也不返回、会挂死 ⇒ setTimeout + AbortController。
 * @param deps 仅测试用注入（{fetch}）；生产调用不要传。
 * @returns {Promise<{ok:true, buf:Buffer} | {ok:false, error:string}>}
 */
export async function fetchTorrentFromCache(infoHashHex, { timeoutMs = 12000 } = {}, deps = {}) {
  const hash = String(infoHashHex || '').toLowerCase();
  if (!isHex40(hash)) return { ok: false, error: 'infohash 非法（要 40 位 hex）' };
  const doFetch = deps.fetch || globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, error: 'no-fetch' };
  const upper = hash.toUpperCase();
  const mirrors = [
    'https://itorrents.org/torrent/' + upper + '.torrent',
    'https://itorrents.net/torrent/' + upper + '.torrent',
  ];
  let last = '未发起请求';
  for (const url of mirrors) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await doFetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'user-agent': 'dsh-bt-readonly' } });
      if (!res || !res.ok) { last = url + ' → HTTP ' + (res && res.status); continue; }
      // 把关①：content-type 必须含 bittorrent
      const ct = String((res.headers && res.headers.get && res.headers.get('content-type')) || '');
      if (!/bittorrent/i.test(ct)) { last = 'content-type 不是 bittorrent：' + ct.slice(0, 40); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      // 把关②：严格 bencode 解码必须走到字节尾
      const d = decode(buf, 0);
      if (d.end !== buf.length) { last = 'bencode 尾部多余 ' + (buf.length - d.end) + ' 字节'; continue; }
      // 把关③：SHA-1 必须与 infoHash 相等
      const got = infoHashFromTorrent(buf);
      if (got !== hash) { last = 'infohash 不匹配：拿到 ' + got; continue; }
      return { ok: true, buf };
    } catch (e) {
      last = url + ' → ' + errText(e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: last };
}

// ───────────────────────── DHT（UDP krpc get_peers）─────────────────────────

/**
 * 打引导节点 + 扩散，收集 peer 地址。只发 get_peers 查询，不宣布自己有什么。
 * @param deps 仅测试用注入（{createSocket}）；生产调用不要传。
 */
export function findPeers(infoHashHex, { timeoutMs = 15000, maxPeers = 120, concurrency = 90 } = {}, deps = {}) {
  return new Promise((resolve) => {
    const ih = Buffer.from(infoHashHex, 'hex');
    const mkSock = deps.createSocket || ((type) => dgram.createSocket(type));
    const sock = mkSock('udp4');
    const peers = new Set();
    const queue = [];
    let inflight = 0, sent = 0, nodesSeen = 0;
    const myId = crypto.randomBytes(20);
    let finished = false;
    let tick = null; // 🔴 必须 let：finish() 可能早于 setInterval 赋值，const 会 ReferenceError
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(tick);
      try { sock.close(); } catch {}
      resolve({ peers: [...peers], sent, nodesSeen });
    };
    sock.on('message', (msg) => {
      let d; try { d = decode(msg).value; } catch { return; }
      const r = d && d.r;
      if (!r) return;
      inflight = Math.max(0, inflight - 1);
      if (Buffer.isBuffer(r.nodes)) {
        for (let i = 0; i + 26 <= r.nodes.length; i += 26) {
          const ip = [...r.nodes.subarray(i + 20, i + 24)].join('.');
          const port = r.nodes.readUInt16BE(i + 24);
          if (port && ip !== '0.0.0.0') { nodesSeen++; if (queue.length < 4000) queue.push([ip, port]); }
        }
      }
      if (Array.isArray(r.values)) {
        for (const v of r.values) if (Buffer.isBuffer(v) && v.length === 6) peers.add([...v.subarray(0, 4)].join('.') + ':' + v.readUInt16BE(4));
      }
    });
    sock.on('error', () => {});
    const t0 = Date.now();
    sock.bind(0, () => {
      for (const [h, p] of BOOT) queue.push([h, p]);
      tick = setInterval(() => {
        while (queue.length && inflight < concurrency) {
          const [h, p] = queue.shift();
          try { sock.send(encode({ t: Buffer.from('aa'), y: 'q', q: 'get_peers', a: { id: myId, info_hash: ih } }), p, h, () => {}); } catch {}
          inflight++; sent++;
        }
        if (Date.now() - t0 > timeoutMs || peers.size >= maxPeers) finish();
      }, 12);
      setTimeout(finish, timeoutMs + 3000); // 兜底：绝不挂死
    });
  });
}

/**
 * BT 扩展握手 + ut_metadata 分块取 info 字典。
 * 🔴 按 bencode 结束位置切 body：body.subarray(d.end, d.end + total_size)
 *    （元数据块的字节**跟在** bencode 头后面，不是从 0 开始）。
 * 💡 只发 msg_type:0（我要第 N 块元数据），从不发 piece 请求。
 * @param deps 仅测试用注入（{connect}）；生产调用不要传。
 * @returns {Promise<{ok:true, meta:Buffer} | {ok:false, err:string}>} meta = **info 字典原始字节**
 */
export function fetchMetadata(infoHashHex, peer, timeoutMs = 7000, deps = {}) {
  const ih = Buffer.from(infoHashHex, 'hex');
  const idx = peer.lastIndexOf(':');
  const host = peer.slice(0, idx), port = Number(peer.slice(idx + 1));
  const connect = deps.connect || ((o) => net.connect(o));
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    let buf = Buffer.alloc(0), hs = false, metaSize = 0, utId = 0;
    const pieces = new Map();
    let settled = false;
    const fin = (v) => { if (settled) return; settled = true; clearTimeout(timer); try { sock.destroy(); } catch {} resolve(v); };
    const timer = setTimeout(() => fin({ ok: false, err: 'timeout' }), timeoutMs);
    sock.on('error', (e) => fin({ ok: false, err: (e && (e.code || e.message)) || 'error' }));
    sock.on('connect', () => {
      const h = Buffer.alloc(68);
      h.writeUInt8(19, 0); h.write('BitTorrent protocol', 1, 'latin1');
      h[25] = 0x10; // 扩展协议位（RSV 第 6 字节）＝ 我会说扩展消息
      ih.copy(h, 28); crypto.randomBytes(20).copy(h, 48);
      sock.write(h);
    });
    const sendExt = (id, payload) => {
      const body = encode(payload);
      const head = Buffer.alloc(6);
      head.writeUInt32BE(body.length + 2, 0); head.writeUInt8(20, 4); head.writeUInt8(id, 5);
      try { sock.write(Buffer.concat([head, body])); } catch {}
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!hs) {
        if (buf.length < 68) return;
        const rsv = buf.subarray(20, 28);
        hs = true;
        buf = buf.subarray(68);
        if (!(rsv[5] & 0x10)) return fin({ ok: false, err: 'no-ext' });
        sendExt(0, { m: { ut_metadata: 1 }, v: 'dsh' });
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) { buf = buf.subarray(4); continue; }
        if (buf.length < 4 + len) break;
        const msg = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        if (msg[0] !== 20) continue; // 只要扩展消息；piece 等一律不看
        const extId = msg[1], body = msg.subarray(2);
        let d; try { d = decode(body); } catch { continue; }
        const m = d.value;
        if (extId === 0) {
          utId = Number((m && m.m && m.m.ut_metadata) || 0);
          metaSize = Number((m && m.metadata_size) || 0);
          if (!utId) return fin({ ok: false, err: 'no-ut_metadata' });
          if (!metaSize) return fin({ ok: false, err: 'no-size' });
          const total = Math.ceil(metaSize / 16384);
          for (let i = 0; i < total; i++) sendExt(utId, { msg_type: 0, piece: i });
        } else if (extId === utId) {
          if (m.msg_type === 1) {
            pieces.set(Number(m.piece), body.subarray(d.end, d.end + Number(m.total_size)));
            const total = Math.ceil(metaSize / 16384);
            if (pieces.size === total) {
              const meta = Buffer.concat([...Array(total).keys()].map((i) => pieces.get(i)));
              if (sha1Hex(meta) !== infoHashHex) return fin({ ok: false, err: 'hash-mismatch' });
              fin({ ok: true, meta });
            }
          } else if (m.msg_type === 2) fin({ ok: false, err: 'rejected' });
        }
      }
    });
  });
}

/**
 * DHT → peers → 并行打 60 个 peer，第一个成功的即返回。
 * 返回**原始 info 字典字节**，不再包一层。
 * @param deps 仅测试用注入（{createSocket, connect}）；生产调用不要传。
 * @returns {Promise<{ok:true, buf:Buffer} | {ok:false, error:string}>}
 */
export async function dhtFetchMeta(infoHashHex, { timeoutMs = 15000, peerTimeoutMs = 6000 } = {}, deps = {}) {
  const hash = String(infoHashHex || '').toLowerCase();
  if (!isHex40(hash)) return { ok: false, error: 'infohash 非法（要 40 位 hex）' };
  const t0 = Date.now();
  let peers = [];
  try {
    const r = await findPeers(hash, { timeoutMs: Math.max(1000, timeoutMs - 5000), maxPeers: 120 }, deps);
    peers = r.peers || [];
  } catch (e) {
    return { ok: false, error: 'findPeers 失败：' + errText(e) };
  }
  const list = peers.slice(0, 60);
  if (!list.length) return { ok: false, error: 'DHT 没找到任何 peer' };
  const left = Math.max(200, timeoutMs - (Date.now() - t0));
  const result = await new Promise((resolve) => {
    let remaining = list.length, done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, left); // 总闸：绝不挂住
    for (const p of list) {
      fetchMetadata(hash, p, Math.min(peerTimeoutMs, left), deps).then((r) => {
        if (done) return;
        remaining--;
        if (r.ok) { done = true; clearTimeout(timer); resolve(r); }
        else if (remaining === 0) { done = true; clearTimeout(timer); resolve(null); }
      }).catch(() => {
        if (done) return;
        remaining--;
        if (remaining === 0) { done = true; clearTimeout(timer); resolve(null); }
      });
    }
  });
  if (!result || !result.ok) return { ok: false, error: '全部 peer 失败：' + ((result && result.err) || 'timeout') };
  return { ok: true, buf: result.meta };
}
// ───────────────────────── 编排：三条输入 → 一份清单 ─────────────────────────

/**
 * 把「magnet / 裸 infohash / .torrent 字节」统一变成一份只读清单。
 *
 * 🔴 为什么编排放在这里而不是写进 tools.js：两条路线（缓存站 / DHT）的**超时预算与失败原因**
 *    必须能离线判据（`test-种子只读清单.mjs` 靠 `deps` 注入假 fetch / 假 socket 证明「永不回话也不挂死」）。
 *    放在工具层就得把 deps 一路透下来，判据会变成在测一个假工具。
 * ⚠️ 取字节点（`fetchImpl`）由**调用方**传入：工具层会传一个走 `safeFetchBinary` 的适配器
 *    （SSRF 校验 + 代理判定只能有一份，不许在这里再写一份）。不传就用 `globalThis.fetch`（仅测试/离线用）。
 *
 * @param {Buffer|string} input .torrent 的原始字节，或 magnet 链接，或裸 infohash（40 hex / 32 base32）
 * @param {{timeoutMs?:number, cacheLookup?:boolean, fetchImpl?:Function}} [opts]
 * @param {{fetch?:Function, createSocket?:Function, connect?:Function}} [deps] 仅测试注入
 * @returns {Promise<{ok:true, infoHash:string, name:string, totalBytes:number, files:{path:string,length:number}[], source:string, elapsedMs:number}
 *   | {ok:false, infoHash:string, errors:string[], elapsedMs:number}>}
 */
export async function inspectTorrent(input, { timeoutMs = 25000, cacheLookup = true, fetchImpl = null } = {}, deps = {}) {
  const t0 = Date.now();
  const budget = Math.max(3000, Number(timeoutMs) || 25000);
  const errors = [];

  // ① 已经是字节：本地/刚下下来的 .torrent ⇒ 不用联网
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    try {
      const info = parseTorrent(buf);
      return { ok: true, ...info, source: '.torrent 文件', elapsedMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, infoHash: '', errors: ['这个 .torrent 解不动：' + errText(e)], elapsedMs: Date.now() - t0 };
    }
  }

  // ② 文本：magnet / 裸 infohash（40 hex 或 32 base32）
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, infoHash: '', errors: ['没给输入（要么给 magnet / infohash，要么给 .torrent）'], elapsedMs: 0 };
  let infoHash = '';
  const mag = parseMagnet(raw);
  if (mag && mag.infoHash) infoHash = mag.infoHash;
  else {
    // 裸串也走 parseMagnet：它已经实现 40hex / 32base32 两种归一 + 校验，别在这里抄第二份
    const asMagnet = parseMagnet('magnet:?xt=urn:btih:' + raw);
    if (asMagnet && asMagnet.infoHash) infoHash = asMagnet.infoHash;
  }
  if (!infoHash) {
    return { ok: false, infoHash: '', errors: ['读不出 infohash：要 magnet 链接、40 位 hex、32 位 base32，或者直接给 .torrent 文件'], elapsedMs: Date.now() - t0 };
  }

  const cacheDeps = fetchImpl ? { ...deps, fetch: fetchImpl } : deps;

  // ③ 路线 A：种子缓存站（实测 6/7 命中，但要串行 + 主动 abort —— 它会挂住）
  if (cacheLookup) {
    const left = Math.max(2000, Math.min(12000, budget - (Date.now() - t0)));
    const r = await fetchTorrentFromCache(infoHash, { timeoutMs: left }, cacheDeps);
    if (r.ok) {
      try {
        const info = parseTorrent(r.buf);
        return { ok: true, ...info, source: '种子缓存站', elapsedMs: Date.now() - t0 };
      } catch (e) {
        errors.push('缓存站给的种子解不动：' + errText(e));
      }
    } else {
      errors.push('缓存站：' + String(r.error || '没命中').slice(0, 80));
    }
  } else if (!cacheLookup) {
    errors.push('缓存站：设置里关掉了（只用 DHT）');
  }

  // ④ 路线 B：DHT 抓元数据（实测 3/7，慢但常能救回缓存站没有的）
  const leftForDht = budget - (Date.now() - t0);
  if (leftForDht < 3000) {
    errors.push('DHT：时间预算用完了，没来得及试');
    return { ok: false, infoHash, errors, elapsedMs: Date.now() - t0 };
  }
  const dhtBudget = Math.max(3000, Math.min(15000, leftForDht));
  const d = await dhtFetchMeta(infoHash, {
    timeoutMs: dhtBudget,
    peerTimeoutMs: Math.max(2000, Math.min(6000, Math.floor(dhtBudget / 2)))
  }, deps);
  if (d.ok) {
    try {
      const info = listFromInfo(d.buf, infoHash);
      return { ok: true, ...info, source: 'DHT', elapsedMs: Date.now() - t0 };
    } catch (e) {
      errors.push('DHT 抓回来的元数据解不动：' + errText(e));
    }
  } else {
    errors.push('DHT：' + String(d.error || '没抓到').slice(0, 80));
  }
  return { ok: false, infoHash, errors, elapsedMs: Date.now() - t0 };
}
