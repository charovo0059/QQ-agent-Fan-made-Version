// Cloudflare 感知的多级 fetch：为以图搜图引擎服务。
//
// 背景：soutubot / ascii2d 等站点套了 Cloudflare，普通 Node fetch 的 TLS 指纹
// 一眼假，有概率被弹"Just a moment..."人机验证。本模块按代价从小到大逐级重试：
//
//   第 1 级：Node undici fetch —— 默认快路径，大多数时候直接就过了
//   第 2 级：Electron net.fetch —— Chromium 网络栈，真实 Chrome TLS/HTTP2 指纹，
//             能过掉纯指纹型拦截（本项目后端就跑在 Electron 主进程里，零成本）
//   第 3 级：隐藏 BrowserWindow 打开该站点，等 CF 的 JS 挑战自动跑完，
//             cf_clearance cookie 落进共享 session（net.fetch 自动携带），再重试。
//             与 Cloudflare-Faker 同思路，但用应用自带的 Electron 实现，免外部依赖。
//
// 非 Electron 环境（CLI 冒烟脚本等）自动退化为只有第 1 级，行为与裸 fetch 一致。
//
// 安全约束：第 3 级只允许打开内置引擎白名单里的域名，不加载任意 URL。

import { getConfig } from './config.js';

// CF 验证页特征（403/503 + 这些字样；正常 4xx 业务错误不会带）
const CHALLENGE_RE = /just a moment|请稍候|checking your browser|verify you are human|challenge-platform|cf-chl|__cf_chl|attention required/i;

// 允许开隐藏浏览器过验证的站点（即搜图引擎用到的域名）
// 2026-09-17：随 Yandex / 3d.iqdb 两个引擎移除，这里也去掉 yandex.ru 与 3d.iqdb.org
const BROWSER_SOLVE_HOSTS = new Set([
  'api.trace.moe', 'trace.moe',
  'saucenao.com',
  'ascii2d.net',
  'soutubot.moe',
  'iqdb.org'
]);

// per-host 过验证状态：{ solving: Promise|null, solvedAt, failAt }
// solvedAt 30 分钟内不重开浏览器（cf_clearance 通常能活这么久）；
// failAt 10 分钟失败冷却（挑战要交互/站点抽风时避免反复弹窗）
const hostState = new Map();

export function looksLikeCfChallenge(status, bodySnippet) {
  return (status === 403 || status === 503) && CHALLENGE_RE.test(bodySnippet || '');
}

function bypassEnabled() {
  return getConfig().imageSearch?.cfBypass !== false;
}

async function electronApi() {
  try {
    const e = await import('electron');
    return e?.net && e?.BrowserWindow ? e : null;
  } catch {
    return null;   // 非 Electron 环境（node CLI）
  }
}

// 把响应读成统一形状，引擎代码继续用 .text()/.json()/.ok/.status/.url/.headers
async function normalize(res, viaElectron) {
  const rawText = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    url: res.url,
    headers: res.headers,
    viaElectron,
    rawText,
    text: async () => rawText,
    json: async () => JSON.parse(rawText)
  };
}

// undici 的 FormData 不能跨 realm 传给 Chromium fetch，转成 Buffer + content-type。
async function toElectronBody(body, headers) {
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const r = new Response(body);
    headers['content-type'] = r.headers.get('content-type');
    return Buffer.from(await r.arrayBuffer());
  }
  return body;
}

// 第 2/3 级共用的 Chromium 请求：去掉自定义 UA 和 cookie 头——
// UA 用 Chromium 自己的（与过验证时一致，cf_clearance 和 UA 绑定）；
// cookie 交给共享 session 自动携带。
async function tryElectron(e, url, options, timeoutMs) {
  try {
    const headers = { ...(options.headers || {}) };
    for (const k of Object.keys(headers)) {
      if (/^(user-agent|cookie)$/i.test(k)) delete headers[k];
    }
    const body = await toElectronBody(options.body, headers);
    const res = await e.net.fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: options.signal ?? AbortSignal.timeout(timeoutMs)
    });
    return await normalize(res, true);
  } catch {
    return null;
  }
}

// 第 3 级：隐藏窗口过 CF 的 JS 挑战。返回 true = 该 host 的验证已搞定。
// 注意打开的是站点首页（origin），不是触发拦截的那个 API 地址——
// 对 POST 接口做 GET 既不会触发挑战、也拿不到 clearance，纯属白等。
async function solveWithBrowser(e, host, timeoutMs = 30000) {
  if (!BROWSER_SOLVE_HOSTS.has(host)) return false;
  const st = hostState.get(host) || { solving: null, solvedAt: 0, failAt: 0 };
  hostState.set(host, st);
  if (st.solving) return st.solving;                                  // 同 host 只开一个窗口
  if (st.solvedAt && Date.now() - st.solvedAt < 30 * 60e3) return true;
  if (st.failAt && Date.now() - st.failAt < 10 * 60e3) return false;

  st.solving = (async () => {
    let win = null;
    try {
      win = new e.BrowserWindow({
        show: false,
        width: 900,
        height: 680,
        webPreferences: { sandbox: true, contextIsolation: true }
      });
      console.log(`[cf-fetch] ${host} 打开隐藏窗口过 CF 验证…`);
      await win.loadURL(`https://${host}/`);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        if (win.isDestroyed()) return false;
        // 强信号：cf_clearance 落盘 = 验证通过，缓存 30 分钟
        const cookies = await e.session.defaultSession.cookies
          .get({ url: `https://${host}/`, name: 'cf_clearance' })
          .catch(() => []);
        if (cookies.length) {
          st.solvedAt = Date.now();
          console.log(`[cf-fetch] ${host} CF 验证通过（拿到 cf_clearance）`);
          return true;
        }
        // 弱信号：标题和正文都不再是验证页 → 放行这一次，但不写成功缓存
        // （没拿到 clearance 可能只是这个 GET 没触发挑战，POST 未必过得去；
        //  不写缓存，下次被拦还能立刻再开窗口）
        const title = win.webContents.getTitle?.() || '';
        if (title && !CHALLENGE_RE.test(title)) {
          const body = await win.webContents
            .executeJavaScript('document.body ? document.body.innerText.slice(0, 1500) : ""', true)
            .catch(() => '');
          if (!CHALLENGE_RE.test(body)) {
            console.log(`[cf-fetch] ${host} 页面已恢复正常（无 clearance，按放行处理）`);
            return true;
          }
        }
      }
      st.failAt = Date.now();   // 超时：多半是要点滑块/勾选项，自动过不了
      console.log(`[cf-fetch] ${host} CF 验证超时（可能需要人工交互），10 分钟内不再重试`);
      return false;
    } catch (error) {
      st.failAt = Date.now();
      console.log(`[cf-fetch] ${host} 过验证异常：${error?.message ?? error}`);
      return false;
    } finally {
      st.solving = null;
      try { win?.destroy(); } catch { /* ignore */ }
    }
  })();
  return st.solving;
}

/**
 * CF 感知 fetch。返回统一响应形状（见 normalize）。
 * options 与原生 fetch 相同（method / headers / body / signal）；
 * 第三个参数：timeoutMs（无显式 signal 时的默认超时）、
 * forceElectron（跳过第 1 级直接走 Chromium 通道——ascii2d 这类
 * 应用级 cookie 必须和过验证的 session 同源时会用到）。
 */
export async function cfFetch(url, options = {}, { timeoutMs = 30000, forceElectron = false } = {}) {
  const host = new URL(url).hostname;
  const canBypass = bypassEnabled();
  const e = (forceElectron || canBypass) ? await electronApi() : null;

  // 第 1 级：裸 fetch（forceElectron 时跳过）
  let t1 = null;
  if (!forceElectron) {
    const res = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
    t1 = await normalize(res, false);
    if (!looksLikeCfChallenge(t1.status, t1.rawText.slice(0, 2000))) return t1;
    if (!canBypass || !e) return t1;   // CLI 环境无计可施，交回原始 403（引擎自己报可读错误）
    console.log(`[cf-fetch] ${host} 普通请求被 CF 拦截，切换 Chromium 通道`);
  } else if (!e) {
    throw new Error('当前环境没有 Electron，无法使用 Chromium 通道');
  }

  // 第 2 级：Chromium 网络栈
  const t2 = await tryElectron(e, url, options, timeoutMs);
  if (t2 && !looksLikeCfChallenge(t2.status, t2.rawText.slice(0, 2000))) {
    console.log(`[cf-fetch] ${host} Chromium 通道成功（HTTP ${t2.status}）`);
    return t2;
  }

  // 第 3 级：隐藏浏览器过 JS 挑战 → 带 clearance 再试
  console.log(`[cf-fetch] ${host} Chromium 直接请求仍被拦，尝试隐藏窗口过验证`);
  const solved = await solveWithBrowser(e, host).catch(() => false);
  if (!solved) {
    if (t2) return t2;
    if (t1) return t1;
    throw new Error(`${host} 所有请求通道都失败了（CF 拦截 + Chromium 通道异常）`);
  }
  const t3 = await tryElectron(e, url, options, timeoutMs);
  return t3 ?? t2 ?? t1 ?? (() => { throw new Error(`${host} 所有请求通道都失败了`); })();
}
