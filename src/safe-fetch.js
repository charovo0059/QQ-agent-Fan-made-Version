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
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from './config.js';

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
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000 } = {}) {  return new Promise((resolve, reject) => {    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 20000
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
        .then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/** 抓取网页文本（≤50000 字符），SSRF 全防护（不做内网例外）。
 *  `browseLocked: true` 时额外受 `security.browseLock` 域名白名单约束（逐跳校验）。 */
export async function safeFetch(urlString, { browseLocked = false } = {}) {
  assertBrowseLock(urlString, { browseLocked });
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: 50000 });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      assertBrowseLock(next, { browseLocked, what: '重定向目标' });
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return { url: url.toString(), statusCode: result.statusCode, truncated: body.length >= 50000, body };
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
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes });
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
function requestToFile(url, ip, dest, { limit = Infinity, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8,image/avif,image/webp,image/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      // 大文件下载：这是 socket 空闲超时而非总时长上限 —— 数据持续流动时不触发，
      // 卡死的连接才会被掐掉（与 requestOnce 一致，只是上限放宽到 timeoutMs）
      timeout: timeoutMs
    }, (res) => {
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
      const r = await requestToFile(url, ip, dest, { limit, timeoutMs });
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
