// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
//
// ── 代理支持（2026-10-04 第四十一对话 · 内置代理批 A）──────────────────────
// 见 `proxy.js` 与 `回执-内置代理拍板结果与执行须知-20261004.md`。三条要害：
// ① **HTTP 代理**：HTTPS 目标走 `CONNECT` 隧道、HTTP 目标走"绝对地址请求行"，
//    HTTP 代理与 **SOCKS5** 都在 `buildTunnelOptions` 里 —— 不引任何新依赖
//    （`undici 6.28` 虽然自带 `ProxyAgent`，但它的 `Socks5ProxyAgent` 实测不存在，
//     而且改用 undici 就得把下面这套 SSRF 校验重写一遍 —— 那是本文件存在的理由）。
// ② 🔴 **目标地址的校验一个字都没松，但有一处**有意识的**委托**（须如实说，别写"全松/全不松"）：
//    · **hostname 级**校验（协议、URL 内嵌凭据、DNS 解析、逐跳重定向重校验）
//      **对代理连接同样生效** —— 走的还是 `validateFetchUrl`，一行没跳过；
//    · **IP 级**校验（"解析出内网/环回/链路本地就拒"）**只对直连生效**；
//      走隧道时域名由**代理端**解析，我们拿不到它的解析结果 ⇒ 这一层是
//      **有意识地委托**给代理端，而不是"我们仍然在查"。
//    ⇒ 判据/文档里⛔不许写成"校验一个字都没松"，那是字面上做不到的。
// ③ **代理端点本身（127.0.0.1:3067 之类）必须有唯一一处有意豁免**：
//    它是本机回环地址，会被下面的 `isPrivateIp` 挡掉；豁免的**位置与范围**写死在
//    `buildTunnelOptions` 里 —— 只对"连代理的那一跳"放行，目标 host **照样**过
//    `validateFetchUrl`（⛔ 不是"给 127.0.0.1 开个白名单"，那样目标也能变回内网）。
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from './config.js';
import { initProxyConfig, resolveProxyFor } from './proxy.js';

// 🔴 必须在这里注入（见 proxy.js 的 initProxyConfig 注释）：不注入 ⇒ proxyEnabled()
//    恒 false ⇒ 用户配了代理却完全没生效，且**没有任何报错**。
initProxyConfig(getConfig);

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

/**
 * 是否允许访问内网/本机地址（既有安全开关 `security.allowPrivateImageHosts`，默认 false）。
 *
 * 🔴 2026-10-04（第四十一对话）**补上的一处接线缺口**：这个开关的既有语义是
 *   "图片下载跳过内网检查（仅供本地测试/自建图床）"，而**只有 `safeFetchBinary` /
 *   `safeFetchBinaryToFile` 在读它** —— `safeFetch`（抓网页正文）的
 *   `validateFetchUrl` 调用**从来没传过**它，于是"打开了开关，`web_fetch` 照样拒绝本机地址"。
 *   症状是"开关看着生效了、实际只有一半路生效"（本项目最忌的静默不一致）。
 *   ⚠️ 这里**只是让四个入口对同一个开关的解释一致**，默认值仍是 false
 *      ⇒ **不打开开关时行为逐字节不变**（回归底线）。
 */
function allowPrivateHosts() {
  return getConfig().security?.allowPrivateImageHosts === true;
}

// ── 代理隧道 ────────────────────────────────────────────────────────────
//
// 目标：把"用哪个 socket 出去"这一件事与"请求怎么发"解耦。原来的两个请求函数
// 都是 `mod.request({ hostname: 已校验的IP, ... })`；现在多一个可选 `tunnel`：
//   · 没有 tunnel ⇒ 逐字节等于改造前（同一个 hostname/port/path/headers）；
//   · 有 tunnel   ⇒ HTTPS 走 CONNECT + TLS（servername/host 仍是**目标域名**，
//                   证书校验与 SNI 一点不松）；HTTP 走"绝对地址请求行"（代理侧解析域名）。
//
// 🔴 唯一一处有意豁免就在 `buildTunnelOptions`：连**代理端点**那一跳放行内网检查。
//    目标 host **不经过这里** —— 它仍然走 `validateFetchUrl`。

/** 建立与代理端点的连接（http/https 直连代理；socks5 见 buildTunnelOptions）。 */
function connectToProxy(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const onErr = (err) => reject(err);
    if (endpoint.protocol === 'https:') {
      // HTTPS 代理（代理本身要 TLS）：`rejectUnauthorized` 保持默认 true。
      const sock = tls.connect({ host: endpoint.hostname, port: endpoint.port, servername: endpoint.hostname }, () => {
        sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`连接代理超时：${endpoint.hostname}:${endpoint.port}`)));
        resolve(sock);
      });
      sock.once('error', onErr);
    } else {
      const sock = net.connect({ host: endpoint.hostname, port: endpoint.port }, () => {
        sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`连接代理超时：${endpoint.hostname}:${endpoint.port}`)));
        resolve(sock);
      });
      sock.once('error', onErr);
    }
  });
}

/** 读一个 HTTP 响应头（到 \r\n\r\n 为止，含 body 的起始部分）。 */
function readResponseHead(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end >= 0) { cleanup(); resolve(buf); }
      else if (buf.length > 64 * 1024) { cleanup(); reject(new Error('代理响应头过大')); }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('代理在响应前提早关闭了连接')); };
    const cleanup = () => {
      sock.off('data', onData); sock.off('error', onErr); sock.off('close', onClose);
      if (timer) clearTimeout(timer);
    };
    const timer = timeoutMs ? setTimeout(() => { cleanup(); reject(new Error('等待代理响应超时')); }, timeoutMs) : null;
    sock.on('data', onData); sock.once('error', onErr); sock.once('close', onClose);
  });
}

/**
 * 取响应头第一行的状态码。
 *
 * 🔴 2026-10-05 真机抓到的 bug（如实记）：第一版写的是 `head.split('\r\n')`，
 *   而 `readResponseHead` 返回的是 **Buffer**（刻意不转字符串：要用 Buffer 找 `\r\n\r\n`，
 *   转成 utf8 字符串在二进制边界上会失真）⇒ `Buffer` 上没有 `split`，
 *   报 **`head.split is not a function`**。
 *   ⚠️ 这个 bug **只在 HTTPS（走 CONNECT）那条路上**才出现 —— 而我的离线判据当时只覆盖了
 *     HTTP 目标（那条走"绝对地址请求行"、不经过本函数）⇒ 判据漏了一个分支。
 *     ⇒ 教训：**两条分支都要有判据**（现在 `test-代理分流与隧道.mjs` 的 ⑥ 段补上了 HTTPS 隧道）。
 */
function headStatus(head) {
  const first = String(head ?? '').split('\r\n')[0] || '';
  const m = first.match(/^HTTP\/\d\.\d\s+(\d{3})/);
  return m ? Number(m[1]) : 0;
}

/** 一次 CONNECT 的目标地址编码：IPv6 要带方括号。 */
function authorityOf(host, port) {
  return net.isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * 与代理建好一条到 `targetHost:targetPort` 的隧道，返回一个可直接当 socket 用的流。
 *
 * @param {object} endpoint `parseProxyEndpoint` 的产物
 * @param {{host:string, port:number}} target
 * @param {number} timeoutMs
 */
async function openProxyTunnel(endpoint, target, timeoutMs = 20000) {
  if (endpoint.protocol === 'socks5:' || endpoint.protocol === 'socks5h:') {
    return openSocks5Tunnel(endpoint, target, timeoutMs);
  }
  const sock = await connectToProxy(endpoint, timeoutMs);
  const target6 = net.isIP(target.host) === 6;
  const lines = [
    `CONNECT ${authorityOf(target.host, target.port)} HTTP/1.1`,
    `Host: ${authorityOf(target.host, target.port)}`,
    'Proxy-Connection: keep-alive',
    'Connection: keep-alive'
  ];
  if (endpoint.auth) lines.push(`Proxy-Authorization: ${endpoint.auth}`);
  sock.write(lines.join('\r\n') + '\r\n\r\n');
  let head;
  try {
    head = await readResponseHead(sock, timeoutMs);
  } catch (error) {
    try { sock.destroy(); } catch { /* ignore */ }
    throw error;
  }
  const status = headStatus(head);
  if (status === 407) {
    sock.destroy();
    throw new Error('代理要求认证（HTTP 407）—— 请在「设置 → 网络」里填代理用户名与密码');
  }
  if (status !== 200) {
    sock.destroy();
    throw new Error(`代理拒绝建立隧道（HTTP ${status || '无响应'}）`);
  }
  sock.setTimeout(0);          // 隧道已建立 ⇒ 交给请求自己的 timeout 管
  return sock;
}

/**
 * SOCKS5 隧道（CONNECT 命令）—— 只为"karing 那种混合端口只给 socks5"的情形兜底。
 *
 * 为什么自己实现而不加依赖：`undici 6.28` 实测**没有** `Socks5ProxyAgent`
 *   （见事项文档 §四），而本项目"零新依赖"是硬约束（`复用账本.md`）。
 * `socks5h:` 与 `socks5:` 在这里**同等对待**（域名都交给代理端解析）——
 *   理由：走代理时我们**本来就把 DNS 委托给代理端**（见文件头注释 ②），
 *   所以两者对我们没有区别；刻意不为一个做不到的区分写两套代码。
 *
 * ⚠️ 只实现 CONNECT（无认证 / 用户名密码）。UDP ASSOCIATE 不支持（我们只用 TCP）。
 */
function openSocks5Tunnel(endpoint, target, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: endpoint.hostname, port: endpoint.port }, async () => {
      sock.setTimeout(timeoutMs, () => sock.destroy(new Error(`SOCKS5 代理超时：${endpoint.hostname}:${endpoint.port}`)));
      try {
        // ① 问候：支持"无认证"(0x00) 与"用户名密码"(0x02)
        const methods = endpoint.auth ? [0x00, 0x02] : [0x00];
        const greeting = Buffer.from([0x05, methods.length, ...methods]);
        sock.write(greeting);
        let resp = await readExact(sock, 2, timeoutMs);
        if (resp[0] !== 0x05) throw new Error('SOCKS5 代理响应无效（版本不符）');
        const method = resp[1];
        if (method === 0xff) throw new Error('SOCKS5 代理拒绝了所有认证方式');
        if (method === 0x02) {
          // ② 用户名密码认证（RFC 1929）。endpoint.auth 这里只有 base64，需还原。
          const { user, pass } = decodeBasicAuth(endpoint.auth);
          const u = Buffer.from(user, 'utf8');
          const p = Buffer.from(pass, 'utf8');
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          const authResp = await readExact(sock, 2, timeoutMs);
          if (authResp[1] !== 0x00) throw new Error('SOCKS5 代理认证失败（用户名或密码不对）');
        } else if (method !== 0x00) {
          throw new Error(`SOCKS5 代理要求不支持的认证方式：0x${method.toString(16)}`);
        }
        // ③ CONNECT 请求：域名交给代理端解析（0x03），IP 直接给（0x01/0x04）
        const host = String(target.host || '');
        const ipVer = net.isIP(host);
        let addrPart;
        if (ipVer === 4) addrPart = Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))]);
        else if (ipVer === 6) addrPart = Buffer.concat([Buffer.from([0x04]), Buffer.from(expandIpv6(host))]);
        else {
          const hb = Buffer.from(host, 'utf8');
          // ⚠️ SOCKS5 的域名长度只有 1 字节 ⇒ 超过 255 字节只能拒绝（不静默截断）
          if (hb.length > 255) throw new Error(`SOCKS5 目标域名过长：${host}`);
          addrPart = Buffer.concat([Buffer.from([0x03, hb.length]), hb]);
        }
        const portBuf = Buffer.alloc(2);
        portBuf.writeUInt16BE(Number(target.port) || 443, 0);
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));
        const head = await readExact(sock, 4, timeoutMs);
        if (head[1] !== 0x00) throw new Error(`SOCKS5 代理拒绝连接（${socks5ErrorText(head[1])}）`);
        // ④ 吃掉绑定地址（长度由 ATYP 决定）
        const atyp = head[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await readExact(sock, 1, timeoutMs))[0] : 0;
        if (addrLen) await readExact(sock, addrLen + 2, timeoutMs);
        sock.setTimeout(0);
        resolve(sock);
      } catch (error) {
        try { sock.destroy(); } catch { /* ignore */ }
        reject(error);
      }
    });
    sock.once('error', reject);
  });
}

/** 精确读 n 字节（SOCKS5 是定长协议，不能像 HTTP 那样等分隔符）。 */
function readExact(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length >= n) { cleanup(); resolve(buf.subarray(0, n)); }
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      sock.off('data', onData); sock.off('error', onErr);
      if (timer) clearTimeout(timer);
    };
    const timer = timeoutMs ? setTimeout(() => { cleanup(); reject(new Error('SOCKS5 代理响应超时')); }, timeoutMs) : null;
    sock.on('data', onData); sock.once('error', onErr);
  });
}

function decodeBasicAuth(authHeader) {
  const m = /^Basic\s+(.+)$/i.exec(String(authHeader || ''));
  if (!m) return { user: '', pass: '' };
  const raw = Buffer.from(m[1], 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return i < 0 ? { user: raw, pass: '' } : { user: raw.slice(0, i), pass: raw.slice(i + 1) };
}

const SOCKS5_ERRORS = {
  1: '通用失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达',
  5: '连接被拒', 6: 'TTL 超时', 7: '命令不支持', 8: '地址类型不支持'
};
function socks5ErrorText(code) { return SOCKS5_ERRORS[Number(code)] || `错误码 ${code}`; }

/** 把 `::1` 之类展开成 16 字节（SOCKS5 的 IPv6 地址形态）。 */
function expandIpv6(addr) {
  const h = String(addr || '');
  const [headPart, tailPart] = h.includes('::') ? h.split('::') : [h, null];
  const head = headPart ? headPart.split(':').filter(Boolean) : [];
  const tail = tailPart ? tailPart.split(':').filter(Boolean) : [];
  const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  const out = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16) || 0, i * 2));
  return out;
}

/**
 * 按目标 URL 决定这次的连接方式。返回 `null`（直连）或
 * `{ socket, host, port, path, hostHeader, servername }`。
 *
 * 🔴 **两种形态**（这是 HTTP 代理的两条标准语义，别混）：
 *   · **HTTPS 目标** ⇒ `CONNECT host:443` 建隧道，然后在隧道里自己 TLS。
 *   · **HTTP 目标**  ⇒ **不建隧道**：直接连上代理，把"绝对地址"写进请求行
 *     （`GET http://host/path HTTP/1.1`），由代理转发。域名由**代理端**解析。
 *   ⚠️ 第一版把两者都写成了"先 CONNECT" —— 对 HTTP 目标那是**错的**：
 *      代理收到的第一条是 `CONNECT`，而它会回一句"No connection established"
 *      之类（判据当场抓到：解析响应头时炸在 `head.split is not a function`）。
 *
 * 🔴 **`validateFetchUrl` 的调用方仍然是逐跳调用的**（见各入口函数）——
 *    本函数**不做**任何安全校验，它只决定"从哪个 socket 出去"。
 *    ⛔ 别把校验挪进来：那样"代理开着时少查一次"会变成一个静默的口子。
 */
async function buildTunnelOptions(url, ip, timeoutMs = 20000) {
  const hit = resolveProxyFor(url.hostname);
  if (!hit) return null;
  const endpoint = hit.endpoint;
  const targetHost = url.hostname;
  const targetPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (url.protocol !== 'https:') {
    // HTTP 目标：连代理本身，请求行写绝对地址（代理侧解析域名）。
    return {
      socket: await connectToProxy(endpoint, timeoutMs),
      host: endpoint.hostname,
      port: endpoint.port,
      path: url.href,
      hostHeader: url.host,
      servername: undefined
    };
  }
  const socket = await openProxyTunnel(endpoint, { host: targetHost, port: targetPort }, timeoutMs);
  return {
    socket,
    // HTTPS 走隧道后由我们自己 TLS：hostname 用**目标域名**（不是代理、也不是 IP）
    // ⇒ SNI 与证书校验都指向真实目标，与直连时的行为一致。
    host: targetHost,
    port: targetPort,
    path: url.pathname + url.search,
    hostHeader: url.host,
    servername: targetHost
  };
}

/** 统一的请求参数构造（保证"直连"与"走代理"除连接方式外**逐字段相同**）。 */
function buildRequestOptions(url, ip, tunnel, headers, timeout) {
  const direct = {
    hostname: ip,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'GET',
    headers: { ...headers, host: url.host },
    timeout
  };
  if (!tunnel) {
    return { ...direct, servername: url.protocol === 'https:' ? url.hostname : undefined, rejectUnauthorized: url.protocol === 'https:' };
  }
  if (url.protocol === 'https:') {
    // 隧道 socket 由 https.request 自己包 TLS（createConnection 给的就是裸连接）
    return { ...direct, createConnection: () => tunnel.socket, servername: tunnel.servername, rejectUnauthorized: true };
  }
  // HTTP 目标走 HTTP 代理：请求行必须是**绝对地址**（`tunnel.path` 已经是 url.href），
  // 域名由代理端解析。⚠️ Host 头仍是目标域名（给目标服务器看），代理看的是请求行 —— 两者都对。
  return { ...direct, hostname: tunnel.host, port: tunnel.port, path: tunnel.path, createConnection: () => tunnel.socket };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。原实现还额外判断了 text.length >= maxBytes，
      // 但 text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes));
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, sliceByCodePoints(text, maxBytes));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// ── 浏览锁定（域名白名单）────────────────────────────────────────────────
// 吸收自上游 0.4 preview（2026-09-20，第九对话）。**我们那份实现为准，这里只做加法。**
//
// 用途：把"她能浏览哪些域名"收成一个显式白名单（`security.browseLock`），
// 默认**不启用**（`enabled !== true` ⇒ `hostAllowed` 一律放行），所以加了它不改变现有行为。
//
// 为什么值得吸收：这是一道**普通配置项驱动**的闸门，与上游那套社区云服务无关
// （它只读本地 `getConfig().security.browseLock`）⇒ 可以单独拿来，不必连社区一起要。

/** 规整域名为小写、去首尾点；不是合法 URL 时返回 ''。 */
export function normalizeDomain(raw) {
  try {
    const u = new URL(String(raw ?? '').includes('://') ? String(raw) : `https://${String(raw ?? '')}`);
    return u.hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch {
    return '';
  }
}

/** 读当前锁定配置（每次现读，保证改配置立即生效）。 */
export function browseLockState() {
  const lock = getConfig().security?.browseLock || {};
  const enabled = lock.enabled === true;
  const domains = (Array.isArray(lock.hosts) ? lock.hosts : [])
    .map(normalizeDomain)
    .filter(Boolean);
  return { enabled, domains, siteSearchUrl: String(lock.siteSearchUrl || '').trim() };
}

/**
 * 主机是否在白名单内。**支持子域**：白名单里有 `example.com` 时
 * `img.example.com` 也算通过 —— 否则一个图床的 CDN 域名就把正常使用挡死了。
 * 但反向不成立：白名单写 `img.example.com` 不会放行 `example.com`。
 */
export function hostAllowed(host, state = browseLockState()) {
  if (!state.enabled) return true;          // 没开锁定 = 不限制
  const h = String(host ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h) return false;
  if (!state.domains.length) return false;  // 开了锁定但没填域名 = 全部拒绝（比"全部放行"安全）
  return state.domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/** 锁定开启时校验一个 URL 的主机；未开启则直接通过。返回 { enabled, host, allowed }。 */
export function checkBrowseLock(rawUrl, state = browseLockState()) {
  if (!state.enabled) return { enabled: false, host: '', allowed: true };
  let host = '';
  try {
    host = new URL(String(rawUrl ?? '')).hostname.toLowerCase();
  } catch {
    return { enabled: true, host: '', allowed: false };
  }
  return { enabled: true, host, allowed: hostAllowed(host, state) };
}

/** 锁定检查。`browseLocked` 为假时**不看锁定**（供"按需才受限"的旧入口用）。 */
function assertBrowseLock(rawUrl, { browseLocked = false, what = '地址' } = {}) {
  if (!browseLocked) return;
  const lock = checkBrowseLock(rawUrl);
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || what} 不在允许的域名清单内`);
}

/**
 * 锁定检查（**无条件**）：只要 `security.browseLock.enabled === true` 就拦。
 *
 * 为什么新入口用"无条件"而旧入口用"按需"：
 *   · `safeFetchBinaryToFile` 是**新加的**，它的调用方（video-reader 等）本来就是
 *     "下载外部资源"这种该受管控的动作 ⇒ 锁定开着就该拦，不该再要调用方记得传开关；
 *   · 而 `safeFetch` / `safeFetchBinary` **早就有别的调用方**（web-search、tools 的图片下载），
 *     给它们加"无条件"会**改变既有行为** ⇒ 保持 `browseLocked` 显式传入（默认不收窄）。
 *   ⚠️ 我第一版把新入口也写成了按需，结果**默认不传就完全不生效** ——
 *      测试当场抓到（"没被拦住"），这条注释就是防止再改回去。
 */
function assertBrowseLockAlways(rawUrl, what = '地址') {
  const lock = checkBrowseLock(rawUrl);
  if (!lock.allowed) throw new Error(`浏览锁定：${lock.host || what} 不在允许的域名清单内`);
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
/**
 * 允许调用方覆盖的请求头**白名单**。
 *
 * 🆕 2026-09-25（第十八对话）：加它是为了修"百度图片搜索"——
 *   实测百度对**默认头**一律回 `{"antiFlag":1,"message":"Forbid spider access"}`，
 *   而**浏览器 UA + `accept: *\/*` + referer** 就能拿到正常 JSON（见下方 baiduImageSearch）。
 *
 * 🔴 为什么是白名单而不是"调用方传什么就给什么"：
 *   `host` 被改 ⇒ 直接绕过 validateFetchUrl 解析出来的 IP（= 变回 SSRF）；
 *   `cookie` 被改 ⇒ 把别的站的凭据带过去。这两个**永远不许覆盖**，本函数只管这四个。
 *   其余一律忽略（不报错、也不生效）—— 免得以后有人以为传了就一定生效。
 */
const ALLOWED_OVERRIDE_HEADERS = ['user-agent', 'accept', 'accept-language', 'referer'];

function buildHeaders(overrides) {
  const headers = {
    host: undefined,   // 下面按 url.host 填
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9'
  };
  if (overrides && typeof overrides === 'object') {
    for (const k of ALLOWED_OVERRIDE_HEADERS) {
      const raw = overrides[k] ?? overrides[k.toLowerCase()];
      if (typeof raw === 'string' && raw.trim()) headers[k] = raw.trim();
    }
  }
  return headers;
}

function requestOnce(url, ip, { asBinary = false, maxBytes = 50000, headers: headerOverrides = null, tunnel = null } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // 🔴 2026-10-05 补的**总时长上限**（真机/判据都抓到过挂住）：
    //    原来只有 `timeout`（= **socket 空闲**超时）。当隧道已建好、但对面**握手后什么都不回**
    //    （VPN 半死、代理吃掉连接、目标挂起）时，socket 上**一个字节都没来过**，
    //    "空闲超时"在某些路径上不会触发 ⇒ 请求**无限期挂着**。
    //    真机上的形态就是"点了「测试连接」一直转圈、既不通也不报错"（本项目最忌的那一类）。
    //    ⇒ 加一个硬上限：到点就 destroy 成 `请求超时`，**必出声**。
    let settledOnce = false;
    const done = (fn, v) => { if (settledOnce) return; settledOnce = true; clearTimeout(hardTimer); fn(v); };
    const hardTimer = setTimeout(() => {
      try { req.destroy(new Error(`请求超时（总时长 30 秒）：${url.hostname}`)); } catch { /* ignore */ }
    }, 30000);
    const req = mod.request(
      buildRequestOptions(url, ip, tunnel, buildHeaders(headerOverrides), 20000),
      (res) => {
        const statusCode = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
          res.resume();
          done(resolve, { statusCode, redirect: String(res.headers.location || '') });
          return;
        }
        readBounded(res, maxBytes, !asBinary)
          .then((body) => done(resolve, { statusCode, body, contentType: String(res.headers['content-type'] || '') }))
          .catch((e) => done(reject, e));
      });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', (e) => done(reject, e));
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/** 抓网页正文的**默认**上限（字符/近似字节）。见 safeFetch 的注释：这是有意保留的护栏。 */
export const DEFAULT_TEXT_MAX_BYTES = 50000;

/**
 * 统一管理"这次请求的隧道 socket 生命周期"。
 *
 * ⚠️ 为什么必须显式销毁：隧道 socket 是**我们自己建的**，不是 http.Agent 池里的，
 *    而 `buildRequestOptions` 用 `createConnection` 把它交给了请求 ——
 *    用完后没人回收就会一直挂着（真机上的形态是"跑几百次之后句柄数不降"）。
 *    ⇒ 请求 settle 之后统一 destroy；出任何错也 destroy（⛔ 不留半开的连接）。
 */
async function withTunnel(url, ip, fn) {
  let tunnel = null;
  try {
    tunnel = await buildTunnelOptions(url, ip);
  } catch (error) {
    throw error;   // 代理建不起来 = 出声（约束②），⛔ 不退化成直连
  }
  const noop = () => {};
  if (tunnel) tunnel.socket.on('error', noop);   // 销毁时的 ECONNRESET 不该炸进程
  try {
    return await fn(tunnel);
  } finally {
    if (tunnel) { try { tunnel.socket.destroy(); } catch { /* ignore */ } }
  }
}

/**
 * 抓取网页文本，SSRF 防护。
 *  `browseLocked: true` 时额外受 `security.browseLock` 域名白名单约束（逐跳校验）。
 *  `security.allowPrivateImageHosts: true` 时放行内网/本机地址（默认 false —— 见 allowPrivateHosts()）。
 *
 * @param {number} [opts.maxBytes=50000] 正文读取上限（默认 5 万）。
 *
 * 🆕 2026-09-25（第十八对话）**加了这个可选上限**，起因是一个线上真 bug：
 *   「按关键词找图」两个源都空手回来，实测真因是**页面数据在 5 万字符之后**——
 *   Bing 图片搜索整页 **239193** 字符、`murl` 首次出现在第 **101818** 字符；
 *   百度图片 JSON **83564** 字符。默认 5 万这一刀把它们**全切掉了**，
 *   而症状只是"没解析到结果"（看着像页面改版，其实是**我们自己把数据截没了**）。
 *   ⚠️ 上游 0.4 那份 `safe-fetch.js` **同样是 50000 写死** ⇒ 这是**继承下来的上游 bug**，
 *      不是我们改出来的。我们这里是**加可选参数**（而不是把全局默认调大）——
 *      默认值 5 万是一道**有意保留的护栏**（防止一个超大页面把内存吃掉），
 *      只有明确知道页面很大、且只用于解析的调用方才该传更大的值。
 *   ⚠️ 只调上限**不动任何 SSRF/锁定校验**：内网、环回、逐跳重定向照旧。
 */
export async function safeFetch(urlString, { browseLocked = false, maxBytes = DEFAULT_TEXT_MAX_BYTES, headers = null } = {}) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : DEFAULT_TEXT_MAX_BYTES;
  assertBrowseLock(urlString, { browseLocked });
  const allowPrivate = allowPrivateHosts();
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await withTunnel(url, ip, (tunnel) => requestOnce(url, ip, { asBinary: false, maxBytes: limit, headers, tunnel }));
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      assertBrowseLock(next, { browseLocked, what: '重定向目标' });
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    const body = result.body || '';
    return { url: url.toString(), statusCode: result.statusCode, truncated: body.length >= limit, body };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。
 *  `browseLocked: true` 时额外受 `security.browseLock` 域名白名单约束（逐跳校验）。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, { browseLocked = false } = {}) {
  assertBrowseLock(urlString, { browseLocked });
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await withTunnel(url, ip, (tunnel) => requestOnce(url, ip, { asBinary: true, maxBytes, tunnel }));
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      assertBrowseLock(next, { browseLocked, what: '重定向目标' });
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

// ── 流式下载到文件（吸收自上游 0.4 preview，2026-09-20）────────────────────
// 为什么需要它：`video-reader.js` 要把视频先落到临时文件再抽帧，
// 而它 import 的正是 `safeFetchBinaryToFile`。我们原来只有"读进内存"的 `safeFetchBinary`。
//
// ⚠️ 与 `safeFetchBinary` 的**超限语义刻意保持一致**：累计字节**到达** maxBytes 即判"读满上限"
//   （服务端文件 ≥ 上限，收到的必是残缺数据），删掉半截文件并抛错，
//   绝不把截断文件留给调用方 —— 调用方往往按"文件存在"判定成功。

/** 把一次响应流式写入 dest（200 时）；重定向只取 Location，响应体直接排空丢弃。 */
function requestToFile(url, ip, dest, { limit = Infinity, timeoutMs = 30000, tunnel = null } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    // 大文件下载：这是 socket 空闲超时而非总时长上限 —— 数据持续流动时不触发，
    // 卡死的连接才会被掐掉（与 requestOnce 一致，只是上限放宽到 timeoutMs）
    const opts = buildRequestOptions(url, ip, tunnel, {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9'
    }, timeoutMs);
    const req = mod.request(opts, (res) => {
      const statusCode = res.statusCode || 0;
      const contentType = String(res.headers['content-type'] || '');
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();   // 丢弃重定向页响应体，不落盘
        resolve({ statusCode, redirect: String(res.headers.location || ''), bytes: 0, contentType });
        return;
      }
      if (statusCode !== 200) {
        res.resume();   // 排空连接便于复用；错误响应体不落盘
        resolve({ statusCode, bytes: 0, contentType });
        return;
      }
      let total = 0;
      let settled = false;
      let overLimit = false;
      const finish = (val) => { if (settled) return; settled = true; resolve(val); };
      const fail = (err) => { if (settled) return; settled = true; try { res.destroy(); } catch { /* ignore */ } reject(err); };
      const out = fs.createWriteStream(dest, { flags: 'w' });
      res.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total >= limit) {
          // 到达上限立即掐断：已写部分反正会被调用方整文件删除，多收无益
          overLimit = true;
          try { res.destroy(); } catch { /* ignore */ }
          out.end();
          finish({ statusCode, bytes: total, contentType, overLimit });
          return;
        }
        if (!out.write(chunk)) {
          // 背压：写盘跟不上网络就读慢一点，别把 chunks 全堆在内存里
          res.pause();
          out.once('drain', () => res.resume());
        }
      });
      res.on('end', () => {
        if (settled) return;
        out.end(() => finish({ statusCode, bytes: total, contentType, overLimit }));
      });
      res.on('error', fail);
      out.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * 流式下载到文件。成功返回 { bytes, contentType }；任何失败（非 200、超限截断、
 * 空响应、网络/磁盘错误、重定向超次）都会**删掉半截文件**再抛错。
 *
 * @param {string} urlString  下载地址
 * @param {string} destPath   目标文件路径（父目录不存在会自动创建）
 * @param {number} maxBytes   硬上限；累计字节**到达**该值即判超限
 * @param {object} [opts]     { timeoutMs = 30000 }
 *   ⚠️ 本入口**无条件**受 `security.browseLock` 约束（锁定开着就拦，含逐跳校验）——
 *      与 `safeFetch`/`safeFetchBinary` 的"按需 browseLocked"不同，理由见 assertBrowseLockAlways 注释。
 */
export async function safeFetchBinaryToFile(urlString, destPath, maxBytes, { timeoutMs = 30000 } = {}) {
  const dest = String(destPath || '');
  if (!dest) throw new Error('缺少目标文件路径');
  const limit = Math.max(1, Number(maxBytes) || 1);
  assertBrowseLockAlways(urlString);

  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let ok = false;
  try {
    let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const r = await withTunnel(url, ip, (tunnel) => requestToFile(url, ip, dest, { limit, timeoutMs, tunnel }));
      if (r.redirect !== undefined) {
        if (!r.redirect) throw new Error(`重定向缺少 Location: ${r.statusCode}`);
        const next = new URL(r.redirect, url).toString();
        // 逐跳校验：重定向目标也必须在白名单内（否则白名单形同虚设）
        assertBrowseLockAlways(next, '重定向目标');
        ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
        continue;
      }
      if (r.statusCode !== 200) throw new Error(`HTTP ${r.statusCode}`);
      if (r.bytes === 0) throw new Error('下载内容为空');
      if (r.overLimit || r.bytes >= limit) throw new Error(`文件达到大小上限（${limit} 字节），已中止`);
      ok = true;
      return { bytes: r.bytes, contentType: r.contentType };
    }
    throw new Error('重定向次数过多，已停止');
  } finally {
    if (!ok) { try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ } }
  }
}

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}
