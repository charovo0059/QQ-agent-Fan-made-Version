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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;

function timeoutSignal(ms = TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
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

// 从 HTML 里抓 "key":[ ... ] 的 JSON 数组（手工括号配对，容忍字符串内的括号）。
function extractJsonArray(html, marker) {
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const arrStart = html.indexOf('[', start + marker.length);
  if (arrStart === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = arrStart; i < html.length; i++) {
    const ch = html[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '[') depth++;
    else if (ch === ']') { depth--; if (depth === 0) return html.slice(arrStart, i + 1); }
  }
  return null;
}

// ── trace.moe：动画截图识番（官方免费 JSON API，无需 key）──────────────────
async function tracemoe(buffer, mime) {
  const res = await cfFetch('https://api.trace.moe/search?anilistInfo', {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'image'),
    signal: timeoutSignal()
  }, { timeoutMs: TIMEOUT_MS });
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
  const res = await cfFetch(`https://saucenao.com/search.php?${qs}`, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'file'),
    signal: timeoutSignal(45000)
  }, { timeoutMs: 45000 });
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
  const res = await cfFetch('https://saucenao.com/search.php', {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: form,
    signal: timeoutSignal(45000)
  }, { timeoutMs: 45000 });
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
    const out = await ascii2dAttempt(buffer, mime, forceElectron);
    if (out !== null) return out;
    // null = POST 被 CF 拦且本层没绕过去，升级到全 Electron 通道再来
  }
  throw new Error('ascii2d 触发了 Cloudflare 交互验证（要人工点的那种），自动绕过失败；换 saucenao / iqdb');
}

async function ascii2dAttempt(buffer, mime, forceElectron) {
  const home = await cfFetch('https://ascii2d.net/', {
    headers: { 'user-agent': UA },
    signal: timeoutSignal()
  }, { timeoutMs: TIMEOUT_MS, forceElectron });
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
    signal: timeoutSignal(45000)
  }, { timeoutMs: 45000, forceElectron });
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
  const res = await cfFetch('https://soutubot.moe/api/search', {
    method: 'POST',
    headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'zh-CN' },
    body: form,
    signal: timeoutSignal(45000)
  }, { timeoutMs: 45000 });
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
    for (let i = 0; i < 6 && incomplete(payload); i++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pRes = await cfFetch(`https://soutubot.moe/api/results/${encodeURIComponent(payload.result_id)}`, {
        headers: { 'user-agent': UA, accept: 'application/json', 'accept-language': 'zh-CN' },
        signal: timeoutSignal(20000)
      }, { timeoutMs: 20000 }).catch(() => null);
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
  const res = await cfFetch(host, {
    method: 'POST',
    headers: { 'user-agent': UA },
    body: makeImageForm(buffer, mime, 'file'),
    signal: timeoutSignal(45000)
  }, { timeoutMs: 45000 });
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

// ── 统一入口 ───────────────────────────────────────────────────────────────
export const IMAGE_ENGINES = {
  tracemoe: { label: 'trace.moe（动画截图识番）', run: tracemoe },
  saucenao: { label: 'SauceNAO（插画/画师出处）', run: saucenao },
  iqdb: { label: 'iqdb（插画/完整图）', run: (b, m) => iqdbSearch('https://iqdb.org/', 'iqdb', b, m) },
  // ascii2d **不在**下面 SELECTABLE_ENGINES 里（模型选不了），但保留在 auto 的降级链里当第三级保险。
  // 理由：它 0 次被模型选中、且常触 CF 交互验证；而在链里是懒执行，不触发就零成本。
  ascii2d: { label: 'ascii2d（二次元插画）', run: ascii2d },
  soutubot: { label: '搜图 bot（本子/漫画页）', run: soutubot }
};

/**
 * 模型**可以主动选**的引擎 —— 工具枚举与"换了引擎"提示都从这里取，避免两处漂移。
 * 2026-09-17 精简：原来 8 个选项太多（实测 381 个会话里只有 6 次调用，
 * 而 tracemoe/ascii2d/iqdb3d 一次都没被选过），且 yandex/iqdb3d 那一格"三次元"两个引擎都不可靠。
 */
export const SELECTABLE_ENGINES = ['auto', 'tracemoe', 'saucenao', 'iqdb', 'soutubot'];

/**
 * 以图搜图统一入口。
 * engine = 'auto' 时按插画场景串联：saucenao → iqdb → ascii2d（前者限流/无结果/低相似度时换后者）。
 * 其余引擎单独调用 —— 选引擎是模型的工作（它能看图，提示词里教了怎么选）。
 */
export async function searchImageSource(engine, buffer, mime) {
  if (engine === 'auto') {
    const errors = [];
    let bestEffort = null;   // 沿途最好的低置信结果，全链路失败时兜底返回
    for (const key of ['saucenao', 'iqdb', 'ascii2d']) {
      try {
        const out = await IMAGE_ENGINES[key].run(buffer, mime);
        const top = Number.parseFloat(out.results?.[0]?.similarity);
        if (out.results.length && (!Number.isFinite(top) || top >= 50)) return out;
        if (out.results.length && !bestEffort) bestEffort = out;
        errors.push(`${IMAGE_ENGINES[key].label} 没有高相似度结果`);
      } catch (e) {
        errors.push(`${IMAGE_ENGINES[key].label}：${e.message}`);
      }
    }
    // 有低置信候选也比两手空空强：附上候选 + 说明，bot 可以如实说"不太确定"
    if (bestEffort) {
      return {
        ...bestEffort,
        note: `所有引擎都没有高置信匹配，下面是相似度偏低的候选（不一定准）。${bestEffort.note || ''}`.trim()
      };
    }
    const err = new Error(`自动搜图没找到结果。${errors.join('；')}`);
    err.attempts = errors;
    throw err;
  }
  const eng = IMAGE_ENGINES[engine];
  if (!eng) throw new Error(`未知引擎 ${engine}，可用：${SELECTABLE_ENGINES.join(' / ')}`);
  return eng.run(buffer, mime);
}
