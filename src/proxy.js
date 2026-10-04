// 代理配置读取与分流判定（2026-10-04 第四十一对话 · 内置代理批 A/批 B）
//
// 这是**唯一**一处解释 `config.proxy` 的地方：`safe-fetch.js`（走隧道）、
// `web-search.js`（裸 fetch）、`cf-fetch.js`（Electron 通道）都从这里取判定，
// 免得三处各写一份正则、日后漂移成"配置里改了、只有一半路径生效"。
//
// ── 拍板依据（回执-内置代理拍板结果与执行须知-20261004.md）──────────────
//   · V1 只做 (A)：**只让 QQ Agent 自己的出网请求走代理**；(B) 整机 VPN 不做；
//   · V4 配置只给"一个本地端口"（协议/地址/端口/认证 四格）；订阅解析与节点 URI 都不做；
//   · 🔴 须知 4 **分流白名单制**：默认 `mode:'off'`；`byRule` 下**只有命中 `rules` 的目标**走代理，
//     其余一律直连。⛔ **不做"全局代理 + 排除名单"** —— DeepSeek API、本机 SearXNG、
//     OneBot（本机 3000/3001）、微信中继（本机 11230）绝不能被代理碰。
//     这一条不是洁癖：把本机回环地址塞进代理，会把"机器人连不上自己的网关"变成
//     一个**看不出原因**的故障（而本项目最忌静默失败）。
//
// ── 三条硬约束（写代码时不许松）────────────────────────────────────────
//   ① `mode` 不是 `'byRule'` ⇒ **一律直连**，且不解析、不校验任何代理字段
//      ⇒ 默认配置下本模块**不改变任何行为**（"没配代理时逐字节等价于现在"的前提）。
//   ② `byRule` 但代理字段填错 ⇒ **抛错出声**，⛔ 不静默降级成"直连"
//      （静默降级 = 用户以为在走代理、其实没有；正是回执要拦的那一类）。
//   ③ 凭据（`user`/`password`）**只用于建隧道**，⛔ 不进任何日志、不进 `describe()`。

/** 默认规则：都是"本机直连不通、必须走代理"的站（pixiv 系 + dlsite + 那几个图搜引擎）。 */
export const PROXY_DEFAULT_RULES = [
  '*.pixiv.net', '*.pximg.net', '*.dlsite.com',
  'trace.moe', 'saucenao.com', 'ascii2d.net', 'iqdb.org', 'soutubot.moe'
];

/** 需要走代理时才认识的协议（`socks5` 也支持，见 `buildTunnelRequest`）。 */
const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/** 取代理配置段（每次现读 ⇒ 改配置立刻生效，不必重启）。 */
export function proxyConfig() {
  const p = getConfigSafe().proxy;
  return (p && typeof p === 'object') ? p : {};
}

// ⚠️ 这里**故意**不在模块顶层 `import { getConfig } from './config.js'`：
//    本模块要被 safe-fetch / web-search / cf-fetch 三家 import，而这三家又都在
//    import config.js —— 本模块保持**零依赖**，交给调用方显式注入，就不会有任何
//    初始化顺序问题（也不需要 async import 那种"等一会儿才好"的隐式时序）。
let _getConfig = null;
function getConfigSafe() {
  if (_getConfig) return _getConfig();
  return {};
}

/**
 * 注入配置读取器。**必须**由入口模块在顶层调用（见 safe-fetch.js 顶部），
 * 否则 `proxyEnabled()` 恒为 false ⇒ 代理静默不生效（"配了却没用"那种最难查的形态）。
 * ⛔ 别把这一步做成 async：那会让"注入完成"与"第一次请求"之间存在竞态。
 */
export function initProxyConfig(getConfigFn) {
  if (typeof getConfigFn === 'function') _getConfig = getConfigFn;
}

/** 代理是否处于"启用"状态（只看 mode，不看规则名单 —— 名单空 = 谁都不走代理）。 */
export function proxyEnabled() {
  return String(proxyConfig().mode || 'off').trim() === 'byRule';
}

/** 规整后的规则名单（小写、去空、去重；非法项直接丢掉）。 */
export function proxyRules() {
  const raw = proxyConfig().rules;
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const v = String(item ?? '').trim().toLowerCase().replace(/^\.+/, '');
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 主机是否命中规则名单。
 *
 * 与 `safe-fetch.js` 的 `hostAllowed`（浏览锁定）**刻意同一条语义**：支持子域，
 * 不支持"把白名单域名当前缀"。
 *   · 规则 `pixiv.net`   ⇒ `www.pixiv.net` ✔、`pixiv.net` ✔
 *   · 规则 `pixiv.net`   ⇒ `pixiv.net.evil.com` ✘（否则规则形同虚设）
 *   · 规则 `*.pixiv.net` ⇒ 与 `pixiv.net` 等价（`*` 只是写法上的通配，**不含**裸域）
 * ⚠️ `*` 只允许出现在**最前面**且后跟一个点；写成 `*pixiv.net` 之类会被当成普通字符串
 *    （不静默扩大匹配范围 —— 那是最危险的一类"配置看起来生效了"）。
 */
export function hostMatchesRules(host, rules = proxyRules()) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!h) return false;
  for (const raw of rules) {
    const rule = raw.startsWith('*.') ? raw.slice(2) : raw;
    if (!rule) continue;
    if (h === rule || h.endsWith(`.${rule}`)) return true;
  }
  return false;
}

/**
 * 解析代理端点。返回 `{ protocol, hostname, port, auth }`。
 * `auth` 是 `Authorization` 头的值（HTTP 代理用），**只在隧道里用，不出现在别处**。
 *
 * 🔴 填错一律抛错（约束②）：`byRule` 下端点解析不出来 = 用户以为在走代理其实没有。
 */
export function parseProxyEndpoint(raw) {
  const s = String(raw ?? '').trim();
  if (!s) throw new Error('代理已启用（mode=byRule），但没填代理地址 —— 请在「设置 → 网络」里填本地代理端口');
  let u;
  try {
    u = new URL(s.includes('://') ? s : `http://${s}`);
  } catch {
    throw new Error(`代理地址无法解析：${s}`);
  }
  if (!SUPPORTED_PROTOCOLS.has(u.protocol)) {
    throw new Error(`代理协议不支持：${u.protocol}（只支持 http / https / socks5）`);
  }
  if (!u.hostname) throw new Error(`代理地址缺少主机名：${s}`);
  // 与 safe-fetch 的既有姿态一致：URL 里不许内嵌凭据（凭据走 user/password 两格）
  if (u.username || u.password) {
    throw new Error('代理地址里不要写用户名/密码 —— 用下面的「用户名 / 密码」两格填');
  }
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : u.protocol === 'http:' ? 80 : 0));
  if (!Number.isFinite(port) || port <= 0) throw new Error(`代理地址缺少端口：${s}`);
  const cfg = proxyConfig();
  const user = String(cfg.user ?? '').trim();
  const pass = String(cfg.password ?? '');
  const auth = user ? `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}` : '';
  return { protocol: u.protocol, hostname: u.hostname, port, auth };
}

/**
 * 判断一次请求要不要走代理。返回 `null`（直连）或
 * `{ endpoint, all }`（`all:true` = Electron 通道那种整会话代理）。
 *
 * @param {string} hostOrUrl 目标主机名或完整 URL
 *
 * ⚠️ 调用方**只在拿到非 null 时**才去解析端点 ⇒ 默认配置下一个字段都不读。
 */
export function resolveProxyFor(hostOrUrl) {
  if (!proxyEnabled()) return null;                  // 约束①：默认路径不碰任何代理字段
  let host = String(hostOrUrl ?? '');
  if (host.includes('://')) {
    try { host = new URL(host).hostname; } catch { return null; }
  }
  const rules = proxyRules();
  if (!rules.length) return null;                    // 名单空 = 谁都不走代理（白名单制）
  if (!hostMatchesRules(host, rules)) return null;
  return { endpoint: parseProxyEndpoint(proxyConfig().http), all: false };
}

/**
 * 代理状态的**人话描述**（供「设置 → 网络」页显示）。
 * ⛔ 绝不包含凭据、也不回显端点完整地址里的敏感成分。
 * @returns {{enabled:boolean, endpoint:string, rules:string[], hasAuth:boolean, error:string}}
 */
export function describeProxy() {
  const cfg = proxyConfig();
  const enabled = proxyEnabled();
  const rules = proxyRules();
  const hasAuth = Boolean(String(cfg.user ?? '').trim());
  const out = { enabled, endpoint: '', rules, hasAuth, error: '' };
  if (!enabled) return out;
  try {
    const ep = parseProxyEndpoint(cfg.http);
    // 只说 host:port（不含凭据，因为 URL 里本来就不许有凭据）
    out.endpoint = `${ep.hostname}:${ep.port}`;
  } catch (error) {
    out.error = String(error?.message ?? error);
  }
  return out;
}
