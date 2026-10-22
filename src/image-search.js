// 以图搜图引擎适配层（全部免 API Key：开放接口 + 网页表单直抓）。
//
// 每个引擎接收图片字节，返回统一结构：
//   {
//     engine: 'saucenao',
//     results: [{ title, url, similarity, extra }],   // 最多 3 条，已按相关度排序
//     resultPageUrl: '...',                           // 可分享给群友的结果页（部分引擎有）
//     note: '...'                                     // 给模型看的补充提示（可选）
//   }
//
// 失败约定：抛 Error，message 是给模型看的可读原因（限流/验证码/无结果不算失败，
// 无结果返回 results: [] 并由工具层附换引擎的建议）。
//
// 维护提醒：saucenao(无 key 时) / ascii2d 是网页解析，站点改版会失效；
// 失效表现为"解析不到结果"而非报错，排查时先手动开对应网站确认结构。

import { getConfig } from './config.js';
import { cfFetch, looksLikeCfChallenge } from './cf-fetch.js';
import { describeFetchError } from './fetch-error.js';
import { resolveProxyFor } from './proxy.js';
import { lensSearch } from './lens-search.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── 超时（2026-10-22 第五十二对话 · 用户拍板 Q3「超时预算按你的来，要设置可调」）─────────
//   改造前是**写死** 30000，各引擎又各自写 45000 —— 设置页改不动、也没人知道真实预算是多少。
//   现在一律从 `config.imageSearch` 现读 + 钳制（模板见 `src/jm-download.js` 的 jmDownloadConf）。
//   ⚠️ 这三个函数**每次调用都现读**，所以设置页改完下一次搜图就生效，不用重启。
const TIMEOUT_DEFAULT_MS = 15000;      // 单引擎默认超时
const RETRIES_DEFAULT = 1;             // 默认重试次数
const AUTO_BUDGET_DEFAULT_MS = 90000;  // auto 链默认总预算

function intIn(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 单引擎超时（毫秒）。3000~60000 之外一律收敛回边界值。 */
function engineTimeoutMs() {
  return intIn(getConfig().imageSearch?.engineTimeoutMs, TIMEOUT_DEFAULT_MS, 3000, 60000);
}

/** 失败重试次数（只对幂等瞬时错误用）。0~3。 */
function engineRetries() {
  return intIn(getConfig().imageSearch?.engineRetries, RETRIES_DEFAULT, 0, 3);
}

/** auto 链总预算（毫秒）。留 30 秒余量给 TOOL_TIMEOUT_MS=120_000。 */
function autoBudgetMs() {
  return intIn(getConfig().imageSearch?.autoBudgetMs, AUTO_BUDGET_DEFAULT_MS, 15000, 115000);
}

function timeoutSignal(ms) {
  return AbortSignal.timeout(intIn(ms, engineTimeoutMs(), 3000, 60000));
}

/**
 * 这次请求有没有走代理 —— 只读判断，**不**用来改 cfFetch 的行为。
 * 目的：失败文案里必须能说清"是代理那段断了还是直连那段断了"，否则只能靠猜。
 * ⛔ 解析失败一律当"没走代理"（抛出去会让一条本来只是慢的请求变成崩溃）。
 */
function usingProxyFor(host) {
  try { return !!resolveProxyFor(host); } catch { return false; }
}

/** 代理端点字符串（给 Lens 那份会话用）；没命中规则时返回 null。 */
function proxyEndpointFor(host) {
  try {
    const hit = resolveProxyFor(host);
    if (!hit) return null;
    const ep = hit.endpoint;
    return `${ep.protocol}//${ep.hostname}:${ep.port}`;
  } catch { return null; }
}

// ── 分引擎计时与失败归类（2026-10-23 第五十四对话 · 提案 ce4188cf）────────────
//  提案原话：「soutubot 搜图引擎一直报 aborted，单引擎失败不该拖死整条」「报错区分超时/连接失败/被中断并带引擎耗时」。
//  改造前的问题：① 每个引擎**不留耗时**（全文件没有 duration/elapsed），用户问"哪个引擎慢"只能靠猜；
//             ② 失败只 push 一句字符串拼进大括号，模型分不清是**超时**、**连不上**还是**被掐断**；
//             ③ 一个引擎耗掉整段预算，后面的引擎根本没机会起跑（"拖死整条"）。
//  ⇒ 现在每个引擎都留一条 trace：{key,label,ok,ms,kind}，失败也照留（ok:false），
//     成功也一样；上层（工具层）把它原样交给模型，用户能直接看到"谁慢/谁错/花了几秒"。

/** 毫秒 → 人话（<1s 报毫秒，其余报一位小数秒）。 */
export function fmtMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return n < 1000 ? `${Math.round(n)} 毫秒` : `${(n / 1000).toFixed(1)} 秒`;
}

/**
 * 失败归类（给人看的三个大类 + 兜底）：
 *   timeout   —— 到点被我们自己掐断（DOMException TimeoutError/AbortError，code 是数字 23/20）
 *   connect   —— 根本没连上（DNS / 拒连 / 重置 / 证书 / 裸 fetch failed）
 *   aborted   —— 外部打断（调用方 abort、页面导航被打断），既不是我们超时也不是对面拒绝
 *   other     —— 引擎自己抛的业务错（额度用完 / 结构变了 / 触发了人机验证…）
 * ⚠️ 判 timeout 必须看 **name**：DOMException 的 code 是数字，TIMEOUT_RE 对它永远失配（ce4188cf 的根因）。
 */
const CONNECT_RE = /fetch\s+failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|CERT_|ERR_TLS|网络|连接|解析/i;
/** ⚠️ 导出是给判据（'测试-现行/test-搜图分引擎计时.mjs'）用的，业务代码只在本文件内调用。 */
export function classifyEngineError(err) {
  const name = String(err?.name || err?.cause?.name || '');
  const code = String(err?.cause?.code || err?.code || '');
  const msg = String(err?.message || '');
  if (name === 'TimeoutError') return 'timeout';
  if (name === 'AbortError') return 'aborted';
  if (/aborted|abort/i.test(msg) && /timeout/i.test(msg)) return 'timeout';
  if (/aborted/i.test(msg) || /aborted/i.test(code)) return 'aborted';
  if (CONNECT_RE.test(code) || CONNECT_RE.test(msg)) return 'connect';
  return 'other';
}

/** 归类 → 中文标签（拼进失败汇总，让模型一眼分出"超时"和"连不上"）。 */
const KIND_LABEL = {
  timeout: '超时（到点被我们自己掐断）',
  connect: '连接失败（根本没连上）',
  aborted: '被中断',
  other: '引擎报错'
};
export function kindText(kind) { return KIND_LABEL[kind] || KIND_LABEL.other; }

/** 一条 trace 的短描述，例：「搜图 bot：超时 15.0 秒」（失败）或「iqdb：1.2 秒」（成功）。 */
function traceLine(t) {
  return t.ok ? `${t.label}：${fmtMs(t.ms)}` : `${t.label}：${kindText(t.kind)}，${fmtMs(t.ms)}`;
}

/**
 * 给一次引擎调用**独立计时**并按超时切片把它掐掉。
 *
 * 🔴 为什么必须切片（提案 ce4188cf「单引擎失败不该拖死整条」）：
 *   各引擎内部已有 AbortSignal.timeout(engineTimeoutMs)，但 soutubot 还会轮询子库
 *   （6 × 2.5 秒）+ 重试 1 次 ⇒ 单个引擎最坏能吃掉 45 秒。auto 链的总预算只有 90 秒，
 *   于是一个慢引擎就能让后面两个根本没机会起跑，用户看到的还是"自动搜图没找到结果"。
 *   ⇒ 这里在**链这一层**再切一刀：每个引擎最多花 min(单引擎超时, 剩余预算)，
 *     到点就记为超时、**继续跑下一个引擎**（不等它）。
 *   ⚠️ 被切掉的那个请求不会立刻停（它自己的 AbortSignal 到点会收），但我们**不再等它** ——
 *      "不等"才是这条提案要的效果；泄漏一个已定死超时的请求是可接受的代价。
 */
/** ⚠️ 同上，导出给判据用；业务代码只在 searchImageSource 里调用。 */
export async function runEngineTimed(key, label, fn, timeoutMs) {
  const started = Date.now();
  let timer = null;
  let timedOut = false;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const e = new Error(`${label} 超过 ${fmtMs(timeoutMs)} 还没回来，先跳过它`);
      e.name = 'TimeoutError';   // 让 classifyEngineError 认成 timeout
      reject(e);
    }, Math.max(1000, Number(timeoutMs) || 1000));
  });
  try {
    const out = await Promise.race([Promise.resolve().then(fn), guard]);
    return { ok: true, out, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - started, kind: timedOut ? 'timeout' : classifyEngineError(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 把引擎抛出来的失败补成人话（判据 'test-搜图失败分类.mjs' 钉的那句）。
 * ⚠️ 引擎自己**已经**给过人话的错（比如「额度用完了」）不要覆盖 —— 那些不是网络问题。
 */
// 🔴 2026-10-23（提案 ce4188cf 的可见症状修复）：这条正则原来**漏了 aborted**。
//   `AbortSignal.timeout` 抛的 DOMException 文案是英文 "The operation was aborted" /
//   "...aborted due to timeout" —— 既没有 'fetch failed'、也没有中文'超时'两个字
//   ⇒ `humanizeEngineError` 判它"不是网络问题"，**原样抛给模型**
//   ⇒ 用户看到的就是那句莫名其妙的 "aborted"（实测 soutubot 每次慢都这样）。
//   ⚠️ 加入 aborted 之后，这类错误才会被翻成「等到超时了（到点被我们自己掐断…）」。
const NETWORKY_RE = /fetch\s+failed|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|CERT_|network|网络|超时|连接|abort(?:ed)?|TimeoutError|AbortError|operation was aborted/i;
function humanizeEngineError(err, host) {
  const msg = String(err?.message ?? err ?? '');
  const isNetworky = NETWORKY_RE.test(msg) || !msg;
  if (!isNetworky) return err;
  const human = describeFetchError(err, { host, usedProxy: usingProxyFor(host) });
  return Object.assign(new Error(human), { cause: err?.cause, attempts: err?.attempts });
}

/**
 * 幂等瞬时错才值得重试。
 * ⛔ 4xx / 人机验证 / 额度用完 一律不重试：重试一个 403 只是把这次运行的时间烧掉。
 */
const TRANSIENT_RE = /TIMEOUT|ETIMEDOUT|UND_ERR_SOCKET|ECONNRESET|EPIPE|ECONNABORTED|ERR_SOCKET|ENOTFOUND|EAI_AGAIN|socket hang up|fetch\s+failed/i;
function isTransient(err) {
  // 🔴 2026-10-23（提案 ce4188cf）：**被我们自己掐断的那一类不重试**。
  //   原因：`AbortSignal.timeout(engineTimeoutMs)` 到点抛 DOMException，文案里带 'timeout'
  //   ⇒ 会被下面的 TRANSIENT_RE 判成"值得重试"，于是同一个引擎再来一遍、再烧 15 秒。
  //   而这次超时说明**这条路本来就慢/不通**，重试只是把一条命拖成两条（实测 soutubot 最坏 ~45 秒，
  //   用户在那边看到的就是"一直转圈然后报 aborted"）。
  //   超时该做的是**换引擎**，那是 auto 链（上层）的事，不是这里原地重试。
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return false;
  const code = String(err?.cause?.code || err?.code || '');
  const status = Number(err?.status ?? err?.statusCode ?? 0);
  if (status >= 400 && status <= 599) return false;      // 对方答话了 ⇒ 不是"没连上"，重试没意义
  if (CHALLENGE_LIKE.test(String(err?.message ?? ''))) return false;
  return TRANSIENT_RE.test(code) || TRANSIENT_RE.test(String(err?.message ?? ''));
}
const CHALLENGE_LIKE = /人机验证|Cloudflare|额度用完|Rate Limit|rate limit|API Key/i;

/**
 * 跑一个引擎：失败按"幂等瞬时错"重试，次数来自配置。
 * @param {string} label 引擎标签（只进错误文案）
 * @param {string} host 目标主机（只进错误文案：说清走没走代理）
 * @param {() => Promise<any>} fn
 */
async function runWithRetry(label, host, fn) {
  const retries = engineRetries();
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const canRetry = attempt < retries && isTransient(error);
      if (!canRetry) break;
      // 退避：给对面一点喘息（同时避免"重试三次＝三次一起撞限流"）
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw humanizeEngineError(last, host);
}

function htmlUnescape(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/')
    .replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function makeImageForm(buffer, mime, fieldName, filename = 'image.jpg') {
  const form = new FormData();
  form.append(fieldName, new Blob([buffer], { type: mime || 'image/jpeg' }), filename);
  return form;
}


// ── trace.moe：动画截图识番（官方免费 JSON API，无需 key）──────────────────
async function tracemoe(buffer, mime) {
  const ms = engineTimeoutMs();
  const res = await runWithRetry('trace.moe', 'api.trace.moe', () => cfFetch('https://api.trace.moe/search?anilistInfo', {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'image'),
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`trace.moe 查询失败：${data.error || `HTTP ${res.status}`}`);
  const results = (data.result || []).slice(0, 3).map((r) => {
    const a = r.anilist || {};
    const title = a.title?.native || a.title?.romaji || a.title?.english || r.filename || '未知作品';
    const mins = Math.floor((r.from || 0) / 60);
    const secs = Math.floor((r.from || 0) % 60);
    const epInfo = r.episode != null ? `第 ${r.episode} 集` : '';
    const timeInfo = `${mins}:${String(secs).padStart(2, '0')}`;
    return {
      title,
      url: a.id ? `https://anilist.co/anime/${a.id}` : '',
      similarity: `${(Number(r.similarity || 0) * 100).toFixed(1)}%`,
      extra: [epInfo, `${timeInfo} 处`].filter(Boolean).join(' ')
    };
  });
  return {
    engine: 'tracemoe',
    results,
    // ⚠️ 这里的 similarity **不能当可信度用**（2026-09-17 实测，见 备份-搜图引擎精简）：
    //    送纯灰图进去得 100.0%、纯白 100.0%、随机噪声 98.1%、群二维码 94.8% ——
    //    它显然是"像不像动画"之类的域内分数，不是"匹配到这一帧有多可信"。
    //    而且 trace.moe **对任何图都返回 top-3，从不说"没搜到"**。
    //    所以提示词必须让模型按"这张图到底是不是动画截图"来判断，而不是看百分比
    //    —— 原来那句"相似度 90% 以上基本可信"会让模型把一张纯色图当成 100% 可信的番名报出去。
    note: results.length
      ? '⚠️ trace.moe 对任何图都会返回最像的 3 条，它的相似度**不能当可信度**（实测纯色图也能得 100%）。'
        + '只在这张图**确实是动画截图**时才采信；不是动画截图就当它没搜到。'
        + '报给群友时带不确定语气（说"看着像 X"，不要说"就是 X"）。'
      : undefined
  };
}

// ── SauceNAO：插画/画师出处 ────────────────────────────────────────────────
// 两种模式：填了 API Key（设置 → 搜索服务，注册 saucenao.com 账号免费获取）→
// 官方 JSON API（稳定、额度独立）；没填 → 匿名网页表单抓 HTML（有频率限制兜底用）。
async function saucenao(buffer, mime) {
  const apiKey = String(getConfig().imageSearch?.saucenaoApiKey || '').trim();
  return apiKey ? saucenaoApi(buffer, mime, apiKey) : saucenaoHtml(buffer, mime);
}

// 官方 JSON API（output_type=2）
async function saucenaoApi(buffer, mime, apiKey) {
  const qs = new URLSearchParams({ output_type: '2', api_key: apiKey, numres: '3', db: '999', hide: '0' });
  const ms = engineTimeoutMs();
  const res = await runWithRetry('SauceNAO API', 'saucenao.com', () => cfFetch(`https://saucenao.com/search.php?${qs}`, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'file'),
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms }));
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`SauceNAO API 返回了无法解析的内容（HTTP ${res.status}）`);
  const status = Number(data.header?.status ?? 0);
  if (status !== 0) {
    const msg = String(data.header?.message || `status ${status}`);
    if (/rate limit/i.test(msg)) throw new Error('SauceNAO API 额度用完了（免费 key 每天约 200 次），明天重置；可先换 iqdb');
    if (/api key|invalid|anonymous account/i.test(msg)) throw new Error('SauceNAO API Key 无效，去设置 → 搜索服务里检查（留空则自动退回网页抓取模式）');
    throw new Error(`SauceNAO API 错误：${msg}`);
  }
  const results = (data.results || []).slice(0, 3).map((r) => {
    const h = r.header || {};
    const d = r.data || {};
    const urls = Array.isArray(d.ext_urls) ? d.ext_urls : [];
    return {
      title: String(d.title || d.member_name || h.index_name || '（无标题）'),
      url: urls[0] || '',
      similarity: h.similarity ? `${h.similarity}%` : '',
      extra: [d.member_name ? `画师：${d.member_name}` : '', h.index_name ? `索引：${h.index_name}` : ''].filter(Boolean).join(' · ')
    };
  });
  return {
    engine: 'saucenao',
    results,
    note: results.length && Number.parseFloat(results[0].similarity) < 60
      ? '最高相似度不足 60%，结果可信度低，建议换 iqdb 再搜一次'
      : undefined
  };
}

// 匿名网页表单（无 key 兜底；有频率限制）
async function saucenaoHtml(buffer, mime) {
  const form = makeImageForm(buffer, mime, 'file');
  form.append('url', '');
  form.append('frame', '1');
  form.append('hide', '0');
  form.append('database', '999');
  const ms = engineTimeoutMs();
  const res = await runWithRetry('SauceNAO', 'saucenao.com', () => cfFetch('https://saucenao.com/search.php', {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: form,
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms }));
  const html = await res.text();
  if (/Search Rate Limit Exceeded/i.test(html)) {
    throw new Error('SauceNAO 匿名额度用完了（有频率限制），等 30 秒～几小时再试，或换 iqdb');
  }
  if (/No results found|Problem encountered/i.test(html) && !/resultsimilarityinfo/i.test(html)) {
    return { engine: 'saucenao', results: [], note: 'SauceNAO 没有找到相似图' };
  }
  const blocks = html.split(/<div class="result["\s>]/i).slice(1);
  const results = [];
  for (const b of blocks) {
    const sim = b.match(/resultsimilarityinfo[^>]*>\s*(?:<[^>]+>\s*)*([\d.]+)\s*%/i)?.[1];
    const title = htmlUnescape(b.match(/<div class="resulttitle"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '');
    // 结果区第一条外部链接即出处（pixiv / twitter / danbooru …）
    const links = [...b.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: htmlUnescape(m[1]), text: htmlUnescape(m[2]) }))
      .filter((l) => l.href && !/saucenao\.com/i.test(l.href));
    if (!sim && !links.length) continue;
    // 推特结果的"标题"是发推时间（2014-09-23T11:13:41Z），换成作者名更可读
    const titleFixed = /^\d{4}-\d{2}-\d{2}T/.test(title) && links[1]?.text
      ? `${links[1].text} 的推文`
      : title;
    results.push({
      title: titleFixed || links[0]?.text || '（无标题）',
      url: links[0]?.href || '',
      similarity: sim ? `${sim}%` : '',
      extra: links[1] ? `另有链接：${links[1].text || links[1].href}` : ''
    });
    if (results.length >= 3) break;
  }
  return {
    engine: 'saucenao',
    results,
    note: results.length && Number.parseFloat(results[0].similarity) < 60
      ? '最高相似度不足 60%，结果可信度低，建议换 iqdb 再搜一次'
      : undefined
  };
}

// ── ascii2d：二次元插画（需先取 CSRF token 和 cookie，再上传）────────────────
// 关键点：_session_id cookie 必须和 authenticity_token 同源。POST 被 CF 拦时，
// 如果首页 GET 走的是 undici、POST 升级走 Chromium，cookie 就对不上了——
// 所以一旦 POST 被拦，整个流程（含首页 GET）都切到 Electron 通道重来一遍。
async function ascii2d(buffer, mime) {
  for (const forceElectron of [false, true]) {
    const out = await runWithRetry('ascii2d', 'ascii2d.net', () => ascii2dAttempt(buffer, mime, forceElectron));
    if (out !== null) return out;
    // null = POST 被 CF 拦且本层没绕过去，升级到全 Electron 通道再来
  }
  throw new Error('ascii2d 触发了 Cloudflare 交互验证（要人工点的那种），自动绕过失败；换 saucenao / iqdb');
}

async function ascii2dAttempt(buffer, mime, forceElectron) {
  const ms = engineTimeoutMs();
  const home = await runWithRetry('ascii2d', 'ascii2d.net', () => cfFetch('https://ascii2d.net/', {
    headers: { 'user-agent': UA },
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms, forceElectron }));
  const homeHtml = await home.text();
  const token = homeHtml.match(/id="file_upload"[\s\S]*?name="authenticity_token" value="([^"]+)"/)?.[1]
    || homeHtml.match(/name="authenticity_token" value="([^"]+)"/)?.[1];
  if (!token) throw new Error('ascii2d 页面结构变了：取不到 authenticity_token');
  // 走 Electron 通道时 _session_id 在 Chromium session 里自动携带，不用手工传
  const cookie = home.viaElectron
    ? ''
    : (home.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

  const form = makeImageForm(buffer, mime, 'file');
  form.append('utf8', '✓');
  form.append('authenticity_token', token);
  // ⚠️ 这一发**不**套 runWithRetry：它返回 null 表示"被 CF 拦住、该升级到全 Electron 通道"，
  //    那是**控制流**不是异常；重试逻辑放在调用方 `ascii2d()` 那一层（只对真抛出来的瞬时错重试）。
  const res = await cfFetch('https://ascii2d.net/search/file', {
    method: 'POST',
    headers: {
      'user-agent': UA,
      referer: 'https://ascii2d.net/',
      origin: 'https://ascii2d.net',
      'accept-language': 'ja,en;q=0.9',
      ...(cookie ? { cookie } : {})
    },
    body: form,
    redirect: 'follow',
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms, forceElectron });
  const html = await res.text();
  if (res.status === 403 && looksLikeCfChallenge(res.status, html.slice(0, 2000))) return null;
  if (!res.ok) throw new Error(`ascii2d 上传失败：HTTP ${res.status}`);
  const resultPageUrl = res.url;

  const boxes = html.split(/<div class="item-box">/i).slice(1);
  const results = [];
  for (const b of boxes) {
    const links = [...b.matchAll(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ href: htmlUnescape(m[1]), text: htmlUnescape(m[2]) }))
      .filter((l) => l.href && !/ascii2d\.net/i.test(l.href));
    if (!links.length) continue;
    results.push({
      title: links[0].text || '（无标题）',
      url: links[0].href,
      similarity: '',
      extra: links[1] ? `作者/来源：${links[1].text || links[1].href}` : ''
    });
    if (results.length >= 3) break;
  }
  // 色合搜索之外还有特征搜索，结果页给群友时两个都附上
  const bovwUrl = resultPageUrl.includes('/search/color/')
    ? resultPageUrl.replace('/search/color/', '/search/bovw/')
    : '';
  return {
    engine: 'ascii2d',
    results,
    resultPageUrl,
    note: bovwUrl ? `特征搜索结果页：${bovwUrl}（色合搜不准时看这个）` : undefined
  };
}

// ── 搜图 bot（soutubot.moe）：本子/漫画页 → nhentai 出处（官方 JSON 接口）──────
// payload 结构（2026-09 实测）：results[].score 是 0~100 分；结果详情在
// results[].path_segments[0] 里（page_url / source_url / page_no / metadata.title/
// creators / works / facts.page_count）。同一本的不同页会重复出现，按 external_id 去重。
export function parseSoutubotPayload(payload) {
  const items = Array.isArray(payload?.results) ? payload.results : [];
  // 数组顺序 ≠ 相关度顺序：结果按子库（api_id）分组排列，高分匹配可能在数组中部。
  // 必须先按 score 降序排，再去重取 top —— 否则会把 40% 的噪声当最佳结果报出去。
  const sorted = items.slice().sort((a, b) => Number(b?.score ?? 0) - Number(a?.score ?? 0));
  const seen = new Set();
  const results = [];
  for (const it of sorted) {
    const seg = it?.path_segments?.[0] || it || {};
    const meta = seg.metadata || {};
    const galleryId = seg.external_id || meta.source?.id || seg.source_url || seg.page_url;
    if (galleryId && seen.has(galleryId)) continue;   // 同本不同页只留最高分那条
    if (galleryId) seen.add(galleryId);

    const score = Number(it.score ?? seg.score);
    const creators = (meta.creators || []).map((c) => c?.name).filter(Boolean).join('、');
    const works = (meta.works || []).map((w) => w?.name).filter(Boolean).join('、');
    const pages = meta.facts?.page_count;
    const title = meta.title?.primary || meta.title?.japanese_or_alias || it.title || it.title_alt || '';
    const pageInfo = seg.page_no != null ? `第 ${seg.page_no}${pages ? ` / ${pages}` : ''} 页` : '';
    results.push({
      title: htmlUnescape(title) || '（无标题）',
      url: seg.page_url || seg.source_url || meta.source?.url || it.page_url || it.source_url || '',
      similarity: Number.isFinite(score) ? `${score.toFixed(1)}%` : '',
      extra: [creators && `作者：${creators}`, works && `作品：${works}`, pageInfo].filter(Boolean).join(' · ')
    });
    if (results.length >= 3) break;
  }
  return results;
}

async function soutubot(buffer, mime) {
  const form = makeImageForm(buffer, mime, 'file', 'clipboard.png');
  form.append('factor', '1.2');
  form.append('metadata_mode', 'display');
  const ms = engineTimeoutMs();
  const res = await runWithRetry('搜图 bot', 'soutubot.moe', () => cfFetch('https://soutubot.moe/api/search', {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'zh-CN' },
    body: form,
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms }));
  let payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 多级绕过后仍被拦（多半是需要点滑块的交互验证）
    if (looksLikeCfChallenge(res.status, res.rawText?.slice(0, 2000))) {
      throw new Error('搜图 bot 触发了 Cloudflare 交互验证（要人工点的那种），自动绕过失败，等几分钟再试');
    }
    throw new Error(`搜图 bot 查询失败：${payload?.error || payload?.message || `HTTP ${res.status}`}`);
  }

  // soutubot 后端并行查多个子库，超时/报错的子库结果会缺席（api_results[].status != 'ok'），
  // 稍后才会补齐 —— 实测顶层 status 恒为 ok 不能作数，必须看子库状态。
  // 有缺席子库时轮询 /api/results/{id} 等它补全（最多 ~15 秒）。
  const incomplete = (p) => Array.isArray(p?.api_results) && p.api_results.some((a) => a && a.status && a.status !== 'ok');
  if (payload.result_id && incomplete(payload)) {
    const pollMs = Math.min(20000, engineTimeoutMs());
    for (let i = 0; i < 6 && incomplete(payload); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pRes = await cfFetch(`https://soutubot.moe/api/results/${encodeURIComponent(payload.result_id)}`, {
        headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'zh-CN' },
        signal: timeoutSignal(pollMs)
      }, { timeoutMs: pollMs }).catch(() => null);
      if (!pRes?.ok) continue;
      const p = await pRes.json().catch(() => null);
      if (p && Array.isArray(p.results)) payload = p;
    }
  }
  const stillIncomplete = incomplete(payload);

  const results = parseSoutubotPayload(payload);
  return {
    engine: 'soutubot',
    results,
    resultPageUrl: payload.result_id ? `https://soutubot.moe/results/${payload.result_id}` : undefined,
    note: stillIncomplete
      ? `搜图 bot 有部分子库超时，结果可能不全；完整列表看结果页：${payload.result_id ? `https://soutubot.moe/results/${payload.result_id}` : ''}`
      : results.length
        ? undefined
        : (payload.result_id
          ? `结果页 ${`https://soutubot.moe/results/${payload.result_id}`} 里没解析到条目（结构可能变了），可以先把链接发给群友`
          : '搜图 bot 的库是 nhentai，只覆盖本子/同人志；搜不到不代表图不存在，插画类换 saucenao。')
  };
}

// 2026-09-17 **移除**：这里原来有个 Yandex 引擎（三次元/通用）。移除理由：
//   ① 实测唯一一次调用就失败 ——「Yandex 拒绝了上传（可能触发了验证码）」；
//   ② 它是这几个引擎里逆向难度最高的（要反爬 token），维护成本 vs 收益最差；
//   ③ 它还会**占掉 `maxPerRun=2` 里的一次额度** —— 模型试完它就只剩一次，
//      很容易就此放弃、告诉群友"没搜到"，而 saucenao/iqdb 本来能搜到。
// 要恢复：备份-搜图引擎精简\ 里有改动前的原文件，照抄回来即可。

// ── iqdb：插画/完整图（免 key、反爬弱，ascii2d 被拦时的替代）──
async function iqdbSearch(host, engineName, buffer, mime) {
  const ms = engineTimeoutMs();
  const res = await runWithRetry(engineName, 'iqdb.org', () => cfFetch(host, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'file'),
    signal: timeoutSignal(ms)
  }, { timeoutMs: ms }));
  const html = await res.text();
  if (!res.ok) throw new Error(`${engineName} 查询失败：HTTP ${res.status}`);
  const tables = html.match(/<table>[\s\S]*?<\/table>/gi) || [];
  const results = [];
  for (const t of tables) {
    const type = htmlUnescape(t.match(/<th>([\s\S]*?)<\/th>/i)?.[1] || '');
    if (/your image/i.test(type)) continue;
    let href = t.match(/<td class='image'>[\s\S]*?<a href="([^"]+)"/i)?.[1] || '';
    if (href.startsWith('//')) href = `https:${href}`;
    if (!href) continue;
    const service = htmlUnescape(t.match(/service-icon[^>]*>\s*([^<]+?)\s*<\/td>/i)?.[1] || '');
    const sim = t.match(/(\d+)\s*%\s*similarity/i)?.[1];
    results.push({
      title: service ? `${service} 上的匹配图` : '匹配图',
      url: href,
      similarity: sim ? `${sim}%` : '',
      extra: type   // Best match / Additional match / Possible match
    });
    if (results.length >= 3) break;
  }
  return {
    engine: engineName,
    results,
    note: /No relevant matches/i.test(html)
      ? '没有找到高置信匹配（列出的只是低相似度候选），可以换其他引擎'
      : undefined
  };
}

// ── 谷歌 Lens：真 Chromium 里跑一遍（2026-10-22 第五十二对话 · 用户拍板 Q10「选免费的 Electron 路线」）──
//   ⚠️ 它与上面五个引擎**有一个本质区别**：它不是 HTTP 抓取，而是开一个隐藏窗口在真 Chromium
//      里跑一遍（详见 `src/lens-search.js` 头部的四条硬纪律）。所以：
//      · 慢得多（顺利也要 3~7 秒，还可能等不到结果）；
//      · **不并入 auto 链** —— auto 是"随手试三个快的"，把它放进去会让每次都慢一大截；
//      · 只由模型在明确要"谷歌搜一下"、或在别的引擎都没结果时**显式选**。
//   🔴 它的失败**不抛错**（lensSearch 返回 {ok:false,error}），因为"没等到内容"和"引擎报错"
//      在这里的成因几乎一样（出口网络），而文案已经够清楚；这里把它转成 Error 交给上层统一处理。
async function lens(buffer, mime) {
  const timeoutMs = intIn(getConfig().imageSearch?.lensTimeoutMs, 30000, 5000, 120000);
  const out = await lensSearch(buffer, mime, {
    timeoutMs,
    proxyEndpoint: proxyEndpointFor('lens.google.com')
  });
  if (!out.ok) throw new Error(out.error);
  // 🆕 2026-10-23（提案 a0009a16「希望返回直连的作品页链接，而不是只给结果页」）：
  //   改造前这里**只有一条** result，url 是结果页地址（= 你刚才那次搜索），正文塞进 extra
  //   ⇒ 模型手里除了"一段网页正文"什么都没有，报出处只能报个站点名。
  //   现在把从锚点里解析出的**直连作品页**放在 results 最前面，结果页单独收在 resultPageUrl。
  //
  //   🔴 三个不许：
  //     ① 解析不到就**不编**（directLinks 空 ⇒ 只剩结果页 + 正文，note 里明说"没解析到直连"）；
  //     ② **不拿结果页冒充作品页**（见 lens-search.js 里 pickWorkLinks 的注释）；
  //     ③ 不动"这不是结构化匹配结果"这个诚实口径 —— 解析出来的链接也只是"页面上的锚点"，
  //        不保证就是这张图的出处（Lens 结果页会混推荐、广告）。
  const body = String(out.text || '').replace(/\s+/g, ' ').trim();
  const direct = Array.isArray(out.directLinks) ? out.directLinks : [];
  const others = Array.isArray(out.otherLinks) ? out.otherLinks : [];
  const results = [];
  for (const d of direct.slice(0, 4)) {
    results.push({
      title: d.title ? `${d.site}：${d.title}` : d.site,
      url: d.url,
      similarity: '',
      extra: '从结果页锚点解析出的**直连作品页**（点开就是原站点，不是谷歌搜索页）'
    });
  }
  // 再补一条"结果页正文"（既有口径保留：模型认识这个形状，判据也钉着）
  results.push({
    title: '谷歌 Lens 结果页正文',
    url: out.url || '',
    similarity: '',
    extra: body.slice(0, 1200)
  });
  const noteLines = [
    '🔴 这是**谷歌 Lens 结果页**的解析结果，不是结构化匹配结果：正文里可能混着无关推荐、广告文案或界面文字。',
    direct.length
      ? `上面的 ${direct.length} 条${direct.length >= 4 ? '+' : ''}是结果页里**指向已知站点的直连链接**（站点：${[...new Set(direct.map((d) => d.site))].join('/')}），优先用它们报出处。`
      : '⚠️ 这次**没解析到直连作品页**（只拿到正文）：只能按正文里出现过的站点名/作品名/作者说，别自己拼链接。',
    others.length ? `另有 ${others.length} 条其它外链（非已知作品站，仅供参考）。` : '',
    '只采纳其中**明确指向出处**的部分，拿不准就说不确定。'
  ].filter(Boolean);
  return {
    engine: 'lens',
    results,
    resultPageUrl: out.url || '',
    note: noteLines.join('')
  };
}

// ── 统一入口 ───────────────────────────────────────────────────────────────
export const IMAGE_ENGINES = {
  tracemoe: { label: 'trace.moe（动画截图识番）', run: tracemoe },
  saucenao: { label: 'SauceNAO（插画/画师出处）', run: saucenao },
  iqdb: { label: 'iqdb（插画/完整图）', run: (b, m) => iqdbSearch('https://iqdb.org/', 'iqdb', b, m) },
  // ascii2d **不在**下面 SELECTABLE_ENGINES 里（模型选不了），但保留在 auto 的降级链里当第三级保险。
  // 理由：它 0 次被模型选中、且常触 CF 交互验证；而在链里是懒执行，不触发就零成本。
  ascii2d: { label: 'ascii2d（二次元插画）', run: ascii2d },
  soutubot: { label: '搜图 bot（本子/漫画页）', run: soutubot },
  // 🆕 2026-10-22 第五十二对话（用户拍板 Q10）：谷歌 Lens。⚠️ 有意**不**并入 auto 链（见上面注释）。
  lens: { label: '谷歌搜图（Lens，最全但最慢）', run: lens }
};

/**
 * 模型**可以主动选**的引擎 —— 工具枚举与"换了引擎"提示都从这里取，避免两处漂移。
 * 2026-09-17 精简：原来 8 个选项太多（实测 381 个会话里只有 6 次调用，
 * 而 tracemoe/ascii2d/iqdb3d 一次都没被选过），且 yandex/iqdb3d 那一格"三次元"两个引擎都不可靠。
 */
export const SELECTABLE_ENGINES = ['auto', 'tracemoe', 'saucenao', 'iqdb', 'soutubot', 'lens'];

/**
 * 以图搜图统一入口。
 * engine = 'auto' 时按插画场景串联：saucenao → iqdb → ascii2d（前者限流/无结果/低相似度时换后者）。
 * 其余引擎单独调用 —— 选引擎是模型的工作（它能看图，提示词里教了怎么选）。
 */
export async function searchImageSource(engine, buffer, mime) {
  const started = Date.now();
  if (engine === 'auto') {
    // 🔴 2026-10-23（提案 ce4188cf）：auto 链改成"**每引擎独立计时 + 独立失败 + 独立切片**"。
    //   改造前：try/catch 里串行跑，一个引擎慢/挂就把整段时间吃光，错误只拼成一句字符串
    //   （'自动搜图没找到结果。SauceNAO…；iqdb…'）⇒ 模型分不清哪一句是超时、哪一句是连不上。
    //   现在：
    //     · 每个引擎花多少毫秒都记进 trace（成功也记 —— "谁慢"是用户真正在问的那个问题）；
    //     · 失败按 timeout / connect / aborted / other 分类，拼人话给模型；
    //     · 每引擎最多花 min(单引擎超时, 剩余总预算)，到点**跳过它去跑下一个**，不等它。
    const trace = [];
    const errors = [];
    let bestEffort = null;   // 沿途最好的低置信结果，全链路失败时兜底返回
    let budgetCut = false;   // 总预算用完、后面还有引擎没试过
    // 🔴 总预算（用户 10-22 拍板 Q3「要设置可调」）：三个引擎串行 + 各自重试，
    //    合起来最多花 autoBudgetMs，到点就不再起新的引擎。
    //    为什么必须有它：工具层 `TOOL_TIMEOUT_MS = 120_000` 是死线，超了工具被掐掉、
    //    模型只看到一句超时 —— 那时连"我们试过哪些引擎"都报不出来。
    const deadline = started + autoBudgetMs();
    const chain = ['saucenao', 'iqdb', 'ascii2d'];
    for (let i = 0; i < chain.length; i++) {
      const key = chain[i];
      const label = IMAGE_ENGINES[key].label;
      const leftMs = deadline - Date.now();
      if (leftMs <= 0) {
        budgetCut = true;
        const rest = chain.slice(i).map((k) => IMAGE_ENGINES[k].label).join('、');
        errors.push(`总预算用完了（${fmtMs(autoBudgetMs())}），后面的引擎（${rest}）没来得及试`);
        break;
      }
      // 单引擎切片：给剩下的每个引擎至少留一点时间，否则第一个就能把预算吃干净
      const slot = Math.min(engineTimeoutMs(), Math.max(3000, Math.floor(leftMs / (chain.length - i))));
      const r = await runEngineTimed(key, label, () => IMAGE_ENGINES[key].run(buffer, mime), slot);
      if (r.ok) {
        const out = r.out;
        out.trace = trace.concat([{ key, label, ok: true, ms: r.ms }]);
        out.totalMs = Date.now() - started;
        const top = Number.parseFloat(out.results?.[0]?.similarity);
        if (out.results.length && (!Number.isFinite(top) || top >= 50)) return out;
        if (out.results.length && !bestEffort) bestEffort = out;
        trace.push({ key, label, ok: true, ms: r.ms, empty: !out.results.length });
        errors.push(out.results.length
          ? `${label} 有结果但相似度只有 ${out.results[0].similarity || '未知'}（低于 50% 不采信），花了 ${fmtMs(r.ms)}`
          : `${label} 没有搜到（${fmtMs(r.ms)}）`);
      } else {
        trace.push({ key, label, ok: false, ms: r.ms, kind: r.kind });
        errors.push(`${label} ${kindText(r.kind)}，花了 ${fmtMs(r.ms)}`);
      }
    }
    // 有低置信候选也比两手空空强：附上候选 + 说明，bot 可以如实说"不太确定"
    if (bestEffort) {
      return {
        ...bestEffort,
        trace,
        totalMs: Date.now() - started,
        note: `所有引擎都没有高置信匹配，下面是相似度偏低的候选（不一定准）。${bestEffort.note || ''}`.trim()
      };
    }
    // 🔴 失败文案要**带上每个引擎的耗时与归类**（提案原话：「报错区分超时/连接失败/被中断并带引擎耗时」）。
    const spent = trace.map(traceLine).join('；');
    const err = new Error(`自动搜图没找到结果（一共花了 ${fmtMs(Date.now() - started)}）。`
      + `${errors.join('；')}。`
      + (budgetCut ? '预算已经用完，不要再原地重试同一批引擎了 —— 换个引擎或直接如实说"没搜到"。' : '')
      + `【各引擎实测】${spent || '（一个都没跑成）'}`)
    err.attempts = errors;
    err.trace = trace;
    err.totalMs = Date.now() - started;
    throw err;
  }
  const eng = IMAGE_ENGINES[engine];
  if (!eng) throw new Error(`未知引擎 ${engine}，可用：${SELECTABLE_ENGINES.join(' / ')}`);
  // 单引擎调用同样计时：这样"某某引擎这次花了 18 秒"在报错里也能看见。
  const label = eng.label;
  const slot = engineTimeoutMs();
  const r = await runEngineTimed(engine, label, () => eng.run(buffer, mime), slot);
  if (r.ok) {
    r.out.trace = [{ key: engine, label, ok: true, ms: r.ms }];
    r.out.totalMs = Date.now() - started;
    return r.out;
  }
  const e = r.error instanceof Error ? r.error : new Error(String(r.error ?? '未知错误'));
  e.trace = [{ key: engine, label, ok: false, ms: r.ms, kind: r.kind }];
  e.engineKind = r.kind;
  e.engineMs = r.ms;
  throw e;
}
