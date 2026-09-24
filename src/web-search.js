// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
import { getConfig } from './config.js';
import { safeFetch } from './safe-fetch.js';

/** 查询词清洗：去 CQ 码、控制字符、超长截断。 */
export function sanitizeQuery(query) {
  return String(query ?? '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing 搜索（解析 b_algo 结果块）。searchUrl 可在配置中替换（测试/换引擎）。 */
/**
 * 从 Bing 搜索页 HTML 里解析结果（`b_algo` 块）。
 *
 * 🆕 2026-09-20 第九对话：**吸收自上游 0.4**。抽出来的理由是**去重** ——
 *    我们本来有两处逐字相同的解析（`bingSearch` 与 `bingSearchWithUrl`），
 *    上游那边把同一段抽成了一个函数。抽出来还有个附带好处：它是**纯函数**，
 *    回归里可以直接喂 HTML 驱动它，不必真的联网搜一次。
 */
export function parseBingResults(html, maxResults = 6) {
  const results = [];
  for (const block of String(html ?? '').split('<li class="b_algo"').slice(1)) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * 站内搜索 URL 拼装（吸收自上游 0.4，与刚吸收的「浏览锁定」配套）。
 *
 * 上游原注释：**配合 browseLock 使用** —— 锁定站点 + 站内搜索模板 = "机器人只能在这几个站里搜"。
 * 模板里没有 `{query}` 时按 Bing 的 `?q=` 约定兜底（而不是静默拼错 URL）。
 *
 * @param {string} template 形如 'https://example.com/search?q={query}'（也兼容 `%s` 写法）
 * @param {string} query 关键词
 */
export function buildSiteSearchUrl(template, query) {
  const tpl = String(template || '').trim();
  const q = encodeURIComponent(String(query || '').trim());
  if (!tpl) return '';
  if (tpl.includes('{query}')) return tpl.replaceAll('{query}', q);
  // 兼容 %s 写法（部分搜索站用这个占位）
  if (tpl.includes('%s')) return tpl.replaceAll('%s', q);
  // 没有占位符：按是否已有 query string 决定拼 ?q= 还是 &q=
  return tpl + (tpl.includes('?') ? '&' : '?') + 'q=' + q;
}

export async function bingSearch(query) {
  const cfg = getConfig().webSearch ?? {};
  const searchUrl = String(cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const url = new URL(searchUrl);
  url.searchParams.set('q', query);
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`搜索服务 HTTP ${res.status}`);
  const html = await res.text();
  const results = parseBingResults(html, maxResults);
  return { query, results };
}

/** 给工具用的统一入口：搜索 + 紧凑序列化。 */
export async function webSearch(query) {
  const clean = sanitizeQuery(query);
  if (!clean) throw new Error('查询词为空');
  const cfg = getConfig().webSearch ?? {};
  const provider = String(cfg.provider || 'bing').toLowerCase();
  if (provider === 'deepseek') return deepSeekSearch(clean);
  if (provider === 'zhipu') return zhipuSearch(clean);
  if (provider === 'bocha') return bochaSearch(clean);
  if (provider === 'baidu') return baiduSearch(clean);
  if (provider === 'metaso') return metasoSearch(clean);
  // 自定义：'custom'（旧单槽位）或 'custom:<id>'（设置页添加的多个之一）
  if (provider === 'custom' || provider.startsWith('custom:')) {
    return customSearch(clean, provider);
  }
  return bingSearch(clean);
}

/**
 * DeepSeek 服务端原生搜索（Responses API，web_search 工具）。
 * 文档：https://api-docs.deepseek.com/zh-cn/guides/responses_api
 * 说明：搜索在 DeepSeek 服务端完成并注入上下文，客户端能拿到的是模型基于
 * 搜索结果生成的最终回答；URL/标题/摘要为黑盒，拿不到结构化来源。适合
 * “只要能搜到并总结”的场景；需要引用列表时请用 Bing / 其他搜索 API。
 */
export async function deepSeekSearch(query) {
  const cfg = getConfig().webSearch?.deepseek ?? {};
  const apiKey = String(cfg.apiKey || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) throw new Error('DeepSeek 搜索需要 API Key（设置里填，或环境变量 DEEPSEEK_API_KEY）');
  const baseUrl = String(cfg.baseUrl || 'https://api.deepseek.com/responses').replace(/\/+$/, '');
  const model = String(cfg.model || 'deepseek-v4-flash');

  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: `请联网搜索并回答（用中文，简洁、只给结论和关键信息）：${query}`,
      tools: [{ type: 'web_search' }],
      stream: false
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 60000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek 搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('DeepSeek 搜索返回了无法解析的 JSON'); });
  const outputText = String(data?.output_text ?? '').trim();
  if (!outputText) {
    // 兼容不同字段位置
    const alt = data?.output?.find?.((item) => item?.type === 'message' && item?.content?.length)
      ?.content?.map((c) => c?.text ?? '').join('') ?? '';
    if (!alt) throw new Error('DeepSeek 搜索没有返回文本（可能是模型不支持 web_search 工具）');
    return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: alt }] };
  }
  return { query, results: [{ title: 'DeepSeek 搜索', url: '', snippet: outputText }] };
}

/** 抓取网页正文（走 safe-fetch 的 SSRF 全防护）。 */
/**
 * 抓取网页。
 *
 * 🆕 2026-09-20 第九对话：补上 `browseLocked` 透传（**上游有、我们缺**）。
 *    它与刚吸收的「浏览锁定」（`security.browseLock`）配套：传 `true` 时
 *    `safeFetch` 会校验域名白名单（含逐跳校验重定向）。
 *    ⚠️ 默认 `false` = 沿用我们原来的行为，所以这个改动**不影响现有调用方**
 *      （`tools.js` 的 web_fetch 没传 ⇒ 行为一字未变）。
 *      要让工具真正受锁定约束，得在调用处显式传 —— 那是**策略决定**，
 *      留给"要不要给浏览加闸门"这件事单独拍板（见 config.security.browseLock 注释）。
 */
export async function webFetch(url, { browseLocked = false } = {}) {
  const result = await safeFetch(url, { browseLocked });
  return result;
}

/** 智谱 Web Search API（结构化结果：标题/链接/摘要/网站名/日期）。 */
export async function zhipuSearch(query) {
  const cfg = getConfig().webSearch?.zhipu ?? {};
  const apiKey = String(cfg.apiKey || process.env.ZHIPU_API_KEY || '').trim();
  if (!apiKey) throw new Error('智谱搜索需要 API Key（设置里填，或环境变量 ZHIPU_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://open.bigmodel.cn/api/paas/v4/web_search').replace(/\/+$/, '');
  const engine = String(cfg.engine || 'search_std');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ search_engine: engine, search_query: query, count }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`智谱搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('智谱搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.search_result) ? data.search_result : [];
  const results = arr
    .filter((r) => r?.link || r?.url)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.link ?? r.url ?? ''),
      snippet: String(r.content ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('智谱搜索没有返回有效结果（检查 API Key 或搜索引擎编码）');
  return { query, results };
}

/** 博查 Web Search API（国内中文优化，网页结果在 data.webPages.value）。 */
export async function bochaSearch(query) {
  const cfg = getConfig().webSearch?.bocha ?? {};
  const apiKey = String(cfg.apiKey || process.env.BOCHA_API_KEY || '').trim();
  if (!apiKey) throw new Error('博查搜索需要 API Key（设置里填，或环境变量 BOCHA_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://api.bochaai.com/v1/web-search').replace(/\/+$/, '');
  const count = Math.min(50, Math.max(1, Number(cfg.count) || 10));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ query, count, freshness: 'noLimit', summary: false }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`博查搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('博查搜索返回了无法解析的 JSON'); });
  if (data?.code && Number(data.code) !== 200) {
    throw new Error(`博查搜索 API 错误（code ${data.code}）：${data.message || data.msg || '未知'}`);
  }
  const arr = Array.isArray(data?.data?.webPages?.value) ? data.data.webPages.value : [];
  const results = arr
    .filter((r) => r?.url)
    .map((r) => ({
      title: String(r.name ?? r.title ?? '').trim() || '（无标题）',
      url: String(r.url ?? ''),
      snippet: String(r.snippet ?? r.summary ?? r.content ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('博查搜索没有返回网页结果');
  return { query, results };
}

/** 百度千帆 AI Search（web_search，返回 references）。 */
export async function baiduSearch(query) {
  const cfg = getConfig().webSearch?.baidu ?? {};
  const apiKey = String(cfg.apiKey || process.env.BAIDU_SEARCH_API_KEY || '').trim();
  if (!apiKey) throw new Error('百度搜索需要 API Key（设置里填，或环境变量 BAIDU_SEARCH_API_KEY）');
  const endpoint = String(cfg.baseUrl || 'https://qianfan.baidubce.com/v2/ai_search/web_search').replace(/\/+$/, '');
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: query }],
      search_source: 'baidu_search_v2',
      resource_type_filter: [{ type: 'web', top_k: topK }]
    }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`百度搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('百度搜索返回了无法解析的 JSON'); });
  if (data?.error_code && Number(data.error_code) !== 0) {
    throw new Error(`百度搜索 API 错误（code ${data.error_code}）：${data.error_msg || data.message || '未知'}`);
  }
  const arr = Array.isArray(data?.references) ? data.references : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('百度搜索没有返回有效结果');
  return { query, results };
}

/** 秘塔 AI 搜索（metaso.cn，每天 100 次免费）。 */
export async function metasoSearch(query) {
  const cfg = getConfig().webSearch?.metaso ?? {};
  const apiKey = String(cfg.apiKey || process.env.METASO_API_KEY || '').trim();
  const endpoint = String(cfg.baseUrl || 'https://metaso.cn/api/open/v1/search').replace(/\/+$/, '');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify({ query, top_k: Math.min(10, Math.max(1, Number(cfg.count) || 6)) }),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`秘塔搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('秘塔搜索返回了无法解析的 JSON'); });
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : [];
  const results = arr
    .filter((r) => r?.url || r?.link)
    .map((r) => ({
      title: String(r.title ?? r.name ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) throw new Error('秘塔搜索没有返回有效结果（可能已用完免费额度或接口地址需要更新）');
  return { query, results };
}

/**
 * 解析自定义搜索配置。
 * providerId 形如 'custom:abc123' 时从 webSearch.providers 数组里取对应项；
 * 否则退回旧的单槽位 webSearch.custom（兼容早期配置）。
 */
function resolveCustomConfig(providerId = null) {
  const ws = getConfig().webSearch ?? {};
  if (providerId && String(providerId).startsWith('custom:')) {
    const id = String(providerId).slice('custom:'.length);
    const found = (Array.isArray(ws.providers) ? ws.providers : []).find((p) => String(p?.id) === id);
    if (found) return found;
    // 列表里找不到 → 回退单槽位，避免配置丢失后完全搜不了
  }
  return ws.custom ?? {};
}

/**
 * 用户自定义的搜索服务（provider = 'custom' 或 'custom:<id>'）。
 *
 * 两种类型：
 *   - 'openai'：POST 一个 JSON 搜索接口。为兼容各家实现，会尝试多种常见请求体字段
 *     （query / q / messages）与响应结构（results / data / sources / references / webPages）。
 *     适合 SearXNG、Tavily、自建聚合搜索等。
 *   - 'bing'：GET 一个搜索页并用 b_algo 块解析（兼容 Bing 结果格式的引擎，如部分 SearXNG 实例）。
 */
export async function customSearch(query, providerId = null) {
  const cfg = resolveCustomConfig(providerId);
  const type = String(cfg.type || 'openai').toLowerCase();

  if (type === 'bing') {
    return bingSearchWithUrl(query, String(cfg.baseUrl || ''));
  }

  const endpoint = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!endpoint) {
    // ⚠️ 2026-09-17 修：原来这里直接抛「自定义搜索未配置接口地址」。
    //    但 `customSearch(q, null)` 的语义是"按当前配置搜"，而当前配置可能是内置提供方
    //    （webSearch.provider = 'deepseek' | 'bing' | ...），跟"自定义提供商"是两条路。
    //    结果：控制台的「搜索测试」按钮（走 customSearch）在 providers[] 为空时，
    //    无论传什么 / 不传都返回这句误导性报错，latencyMs 0~2ms（**根本没发请求**）——
    //    用户会以为搜索坏了，其实配置好得很。
    //    ⇒ 没有自定义提供商可用时，交回 webSearch() 按配置分发。
    //    注意：webSearch 是 dev 的兄弟函数，两者互相引用但在调用时才解析，不会循环初始化。
    return webSearch(query);
  }
  const apiKey = String(cfg.apiKey || '').trim();
  const model = String(cfg.model || '').trim();
  const topK = Math.min(10, Math.max(1, Number(cfg.count) || 6));

  // 兼容多种请求体：优先 query / q，带 model 时额外附上 messages（Responses API 风格）
  const body = { query, q: query, top_k: topK, count: topK };
  if (model) {
    body.model = model;
    body.messages = [{ role: 'user', content: query }];
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(10000, Number(cfg.timeoutMs) || 20000))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`自定义搜索 HTTP ${res.status}：${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => { throw new Error('自定义搜索返回了无法解析的 JSON'); });

  // 兜住各家字段名
  const arr = Array.isArray(data?.results) ? data.results
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.sources) ? data.sources
    : Array.isArray(data?.references) ? data.references
    : Array.isArray(data?.webPages?.value) ? data.webPages.value
    : Array.isArray(data) ? data
    : [];

  const results = arr
    .filter((r) => r && (r.url || r.link))
    .map((r) => ({
      title: String(r.title ?? r.name ?? r.headline ?? '').trim() || '（无标题）',
      url: String(r.url ?? r.link ?? ''),
      snippet: String(r.content ?? r.snippet ?? r.summary ?? r.body ?? '').trim()
    }))
    .slice(0, Math.max(1, Number(getConfig().webSearch?.maxResults) || 6));
  if (!results.length) {
    throw new Error('自定义搜索没有返回可识别的结果（请检查接口返回是否包含 results/data/sources 等数组，或改用 bing 类型抓页面）');
  }
  return { query, results };
}

/** 用指定 URL 跑一次 Bing 结果的 HTML 解析（供自定义 bing 类型复用）。 */
async function bingSearchWithUrl(query, searchUrl) {
  const cfg = getConfig().webSearch ?? {};
  const url = String(searchUrl || cfg.searchUrl || 'https://cn.bing.com/search');
  const maxResults = Math.max(1, Math.min(10, Number(cfg.maxResults) || 6));
  const target = new URL(url);
  target.searchParams.set('q', query);
  const res = await fetch(target, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'zh-CN,zh;q=0.9'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`自定义搜索（bing 类型）HTTP ${res.status}`);
  const html = await res.text();
  // 🆕 用抽出来的纯函数（原来这里有一份与 bingSearch 逐字相同的解析，已去重）
  const results = parseBingResults(html, maxResults);
  if (!results.length) throw new Error('自定义搜索（bing 类型）没有解析到结果，请确认该引擎返回 b_algo 结构');
  return { query, results };
}

// ═══════════════════════════════════════════════════════════════════════════
// 关键词图搜（"按一句话找一批图片直链"）—— 2026-09-25 第十八对话移植上游 0.4
//
// ⚠️ 它和 `src/image-search.js` 的"以图搜图"是**两个功能**，别混：
//     · image-search.js：**给一张图**，问"它出自哪"（番剧/画师/本子）
//     · 这里：**给一句话**，拿回一批**图片直链**
//   ⇒ 上游那份里还有 `simplifyQuery` / `queryKeywords` / `extractPageDigest` 三个导出，
//     我们**没有搬**：上游自己也没有任何调用点（搬过来就是死码）。
//
// ⚠️ 只**追加**导出、绝不整份替换本文件 —— 我们比上游多几处修补，最关键的是
//    `customSearch` 在没有 endpoint 时回落 `webSearch`（设置页"测试搜索"按钮的修复）。
//
// 🔴 与「浏览锁定」的关系（用户 2026-09-25 拍板）：**图搜不受浏览锁定管**。
//    理由：既有的"以图搜图"走的是 `cf-fetch`（内置浏览器过 JS 验证）那条路，本来就绕开锁定
//    ⇒ 图搜跟它保持一致，**不是新开一个口子**。何况这两家都会撞人机验证，走 safe-fetch
//    的普通 HTTP 通道本来就拿不到完整页面。
//    ⚠️ 不受**浏览锁定**管 ≠ 不受安全约束：仍然全程走 `safeFetch`（禁内网/环回/链路本地、
//      逐跳校验重定向）。将来若要改口径，就是下面那几个函数的 `browseLocked` 参数传 true。
// ═══════════════════════════════════════════════════════════════════════════

const IMAGE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 图片搜索页地址（纯函数：抽出来才能单测"关键词真的被编码了"）。 */
export function bingImageSearchUrl(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  return `https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`;
}

/** 百度图片搜索页地址（纯函数，同上）。 */
export function baiduImageSearchUrl(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  return `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(q)}`;
}

/**
 * 从 Bing 图片搜索页里抽直链（**纯函数**）。
 *
 * 做法：Bing 把媒体直链塞在 `m="{\"murl\":\"...\",\"turl\":\"...\"}"` 这种 JSON 属性里。
 * 解析失败（页面改版/属性被截断）就兜一次正则 —— 两种都拿不到时返回空数组，
 * 由调用方抛"没解析到结果"（**不在这里抛**，纯函数好测）。
 */
export function parseBingImages(html, limit = 8) {
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const out = [];
  const seen = new Set();
  for (const m of String(html ?? '').matchAll(/m="([^"]+)"/g)) {
    const raw = decodeHtml(m[1]).replace(/&quot;/g, '"');
    let hit = '';
    try {
      const j = JSON.parse(raw);
      hit = String(j.murl || j.mediaurl || '').trim();
    } catch {
      const mm = raw.match(/"murl"\s*:\s*"([^"]+)"/);
      hit = mm ? mm[1] : '';
    }
    if (!/^https?:\/\//i.test(hit) || seen.has(hit)) continue;
    seen.add(hit);
    out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}

/** 从百度图片搜索页里抽直链（**纯函数**）。直链在 `objURL` / `middleURL` / `thumbURL` / `hoverURL` 四个键上，都能兜。 */
export function parseBaiduImages(html, limit = 8) {
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const out = [];
  const seen = new Set();
  const text = String(html ?? '');
  for (const key of ['objURL', 'middleURL', 'thumbURL', 'hoverURL']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g');
    for (const m of text.matchAll(re)) {
      const u = decodeHtml(m[1]).replace(/\\\//g, '/');
      if (!/^https?:\/\//i.test(u) || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out;
}

/** Bing 图片搜索。 */
export async function bingImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const { body } = await safeFetch(bingImageSearchUrl(query), { browseLocked });
  const out = parseBingImages(body, limit);
  if (!out.length) throw new Error('Bing 图片搜索没解析到结果（页面结构可能已改版）');
  return out.map((url) => ({ title: String(query).trim(), url }));
}

/** 百度图片搜索。 */
export async function baiduImageSearch(query, { limit = 8, browseLocked = false } = {}) {
  const { body } = await safeFetch(baiduImageSearchUrl(query), { browseLocked });
  const out = parseBaiduImages(body, limit);
  if (!out.length) throw new Error('百度图片搜索没解析到结果（页面结构可能已改版）');
  return out.map((url) => ({ title: String(query).trim(), url }));
}

/**
 * 关键词图搜入口：按顺序试源，一个失败自动换另一个。
 *
 * 为什么"自动换源"很重要：这两家的 HTML 结构都随时可能改版，只押一个源的话，
 * 改版当天功能就整个不可用。
 *
 * @param {Array} [opts.sources] **只为测试注入**（给假引擎，验降级链真的换了源）。
 *   默认 `[baiduImageSearch, bingImageSearch]` —— 百度在前，中文关键词命中率更好。
 */
export async function searchImages(query, { limit = 8, browseLocked = false, sources = null } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const list = Array.isArray(sources) && sources.length ? sources : [baiduImageSearch, bingImageSearch];
  const errors = [];
  for (const fn of list) {
    try {
      const hit = await fn(q, { limit: n, browseLocked });
      if (hit && hit.length) return hit;
      errors.push(`${fn.name || '匿名源'}: 没有结果`);
    } catch (error) {
      errors.push(`${fn.name || '匿名源'}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`图片搜索全部失败 —— ${errors.join('；')}`);
}
