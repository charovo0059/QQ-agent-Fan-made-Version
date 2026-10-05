// 联网搜索（移植自原版 bingSearch）：Bing 中文搜索，无需 API key。
// 搜索请求本身用普通 fetch（搜索 URL 是管理端配置的可信地址，只需清洗查询词）；
// 对外抓取网页正文一律走 safe-fetch（web_fetch 工具）。
//
// ── 代理支持（2026-10-04 第四十一对话 · 内置代理批 A 的"路径③"）──────────────
// 本文件的 6 处 `fetch` 打的是各家**搜索 API**（DeepSeek / 智谱 / 博查 / 百度千帆 /
// 秘塔）与 Bing —— 它们**都在国内可达**，默认**不该**走代理（回执 §四 须知 4 的白名单制）。
// 但"不该默认走"≠"永远不该走"：所有者可能想把某一家也纳入 `proxy.rules`。
// ⇒ 统一走下面的 `proxiedFetch`：
//     · 目标**没命中** `proxy.rules`（含"代理没启用"）⇒ **原样用全局 `fetch`**
//       —— 这一条是"没配代理时逐字节等价于现在"的实现方式（连 fetch 实现都没换）；
//     · 命中 ⇒ 换用 **undici 自带的 `fetch` + `ProxyAgent`**。
//       ⚠️ 为什么不能继续用全局 fetch 而只传 `dispatcher`：那是 undici 的私有选项，
//          Node 内建的 fetch **不认**（实测：全局 fetch 的签名里没有它，传了等于没传）。
//       ⇒ 必须显式用 undici 那个 fetch；`undici@6.28.0` 已是本 app 的既有依赖（零新增）。
import { getConfig } from './config.js';
import { safeFetch } from './safe-fetch.js';
import { initProxyConfig, resolveProxyFor } from './proxy.js';

// 🔴 必须注入（与 safe-fetch.js 同一个理由）：不注入 ⇒ proxyEnabled() 恒 false
//    ⇒ 用户把某家搜索 API 写进 rules 也不会生效，且**没有任何报错**。
initProxyConfig(getConfig);

/** 按 `proxy.rules` 决定这次请求用哪个 fetch 实现（见文件头注释）。 */
export async function proxiedFetch(url, options) {
  const hit = resolveProxyFor(typeof url === 'string' ? url : String(url?.href ?? url));
  if (!hit) return fetch(url, options);           // 未命中 ⇒ 一个字都不变
  const { fetch: undiciFetch, ProxyAgent } = await import('undici');
  const endpoint = hit.endpoint;
  const agent = new ProxyAgent({
    uri: `${endpoint.protocol}//${endpoint.hostname}:${endpoint.port}`,
    ...(endpoint.auth ? { token: endpoint.auth } : {})   // ⚠️ 凭据只进 agent，不进日志
  });
  try {
    return await undiciFetch(url, { ...options, dispatcher: agent });
  } finally {
    // Agent 持有一批连接 ⇒ 用完就关，否则每次搜索都漏一批句柄
    try { await agent.close(); } catch { /* ignore */ }
  }
}

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
  const res = await proxiedFetch(url, {
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

  const res = await proxiedFetch(baseUrl, {
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

  const res = await proxiedFetch(endpoint, {
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

  const res = await proxiedFetch(endpoint, {
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

  const res = await proxiedFetch(endpoint, {
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

  const res = await proxiedFetch(endpoint, {
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

  const res = await proxiedFetch(endpoint, {
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
  const res = await proxiedFetch(target, {
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

/**
 * 图搜页面的正文读取上限。
 *
 * 🔴 2026-09-25（第十八对话）**这是线上真 bug 的修法**：第一版照上游写死了 `safeFetch` 的默认
 *   5 万上限，结果**两个源都空手回来**。实测（`_临时产物-第十八对话\探针-图搜页到底多大.mjs`）：
 *     · Bing 图片搜索整页 **239193** 字符，`murl` 首次出现在第 **101818** 字符；
 *     · 百度图片 JSON **83564** 字符。
 *   ⇒ 5 万那一刀把**数据整个切掉了**，而症状只是"没解析到结果"——**看着像页面改版，其实是我们自己截的**。
 *   （⚠️ 上游 0.4 也是 50000 写死 ⇒ 这是**继承下来的上游 bug**。）
 * 512KB 足够覆盖上面两个实测值，又仍然是**有界**的。
 */
export const IMAGE_SEARCH_MAX_BYTES = 512 * 1024;

/** 图片搜索页地址（纯函数：抽出来才能单测"关键词真的被编码了"）。 */
export function bingImageSearchUrl(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  return `https://cn.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`;
}

/**
 * 百度图片的**数据接口**地址（纯函数）。
 *
 * 🔴 2026-09-25（第十八对话）：**不再是那个 HTML 搜索页**。第一版照上游搬的是
 *   `image.baidu.com/search/index?tn=baiduimage&...`，实测那一页**整页 144801 字符，
 *   而 `objURL` / `middleURL` / `thumbURL` / `hoverURL` 四个键一次都没出现** ——
 *   老解析器**已经完全失效**（百度把结果改成 JS 异步取 JSON 了）。
 *   ⇒ 改打它的 JSON 接口 `search/acjson`，实测 HTTP 200、`application/json`、`data` 31 条，
 *     且 `middleURL`/`thumbURL`/`hoverURL` 都是可直接下载的 `https://img1.baidu.com/...`。
 */
export function baiduImageSearchUrl(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  return `https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&ie=utf-8&word=${encodeURIComponent(q)}&pn=0&rn=30`;
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

/**
 * 从百度图片的 JSON 里抽直链（**纯函数**）。
 *
 * ⚠️ **绝对不要用 `objURL`** —— 实测它是百度自己加密过的串
 *   （形如 `ipprf_z2C$qAzdH3FAzdH3F...`），**不是可下载的地址**，交给协议端只会失败。
 *   能用的三个键是 `middleURL` / `thumbURL` / `hoverURL`（实测都是 `https://img1.baidu.com/...`）。
 * 🔁 兜底：万一百度又改回返回 HTML，就走一遍老的四个键正则（同样**跳过 objURL**）。
 */
export function parseBaiduImages(body, limit = 8) {
  const max = Math.max(1, Math.min(12, Number(limit) || 8));
  const text = String(body ?? '');
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    const u = decodeHtml(String(raw ?? '')).replace(/\\\//g, '/').trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    if (/^ipprf_/i.test(u)) return;          // 百度加密串，不是地址
    seen.add(u);
    out.push(u);
  };
  // ① 正常路径：JSON 接口
  try {
    const j = JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\)\s*$/, ''));
    const data = Array.isArray(j?.data) ? j.data : [];
    for (const it of data) {
      if (!it || typeof it !== 'object') continue;
      for (const key of ['middleURL', 'thumbURL', 'hoverURL']) {
        if (it[key]) { push(it[key]); break; }
      }
      if (out.length >= max) break;
    }
    return out.slice(0, max);
  } catch { /* 不是 JSON ⇒ 走下面的老路 */ }
  // ② 兜底：老的 HTML 形态（同一个键名表，依旧跳过 objURL）
  for (const key of ['middleURL', 'thumbURL', 'hoverURL']) {
    const re = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g');
    for (const m of text.matchAll(re)) {
      push(m[1]);
      if (out.length >= max) break;
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/**
 * 百度要的那套请求头。
 *
 * 🔴 2026-09-25（第十八对话）实测（脚本：`_临时产物-第十八对话\诊断4-百度请求头(https).mjs`）：
 *   用我们**默认的**头（`qq-agent/1.0` UA + `accept: text/html,...`）打 acjson，
 *   百度一律回 `{"antiFlag":1,"message":"Forbid spider access"}`（82 字节）。
 *   逐个变量试下来，**能拿到正常 JSON 的最小组合**是：
 *   `浏览器 UA` + `accept: *​/*` + `referer: https://image.baidu.com/`（86100 字节、data 31 条）。
 *   ⚠️ 缺 UA 不行、缺 `accept: *​/*` 也不行 —— 两个都要。
 * ⚠️ 这四个头走的是 `safeFetch` 的**白名单覆盖**（见 safe-fetch.js 的 ALLOWED_OVERRIDE_HEADERS）：
 *   `host` 与 `cookie` **永远不许覆盖**，所以这不构成 SSRF/凭据泄露的口子。
 */
const BAIDU_IMAGE_HEADERS = {
  'user-agent': IMAGE_UA,
  accept: '*/*',
  'accept-language': 'zh-CN,zh;q=0.9',
  referer: 'https://image.baidu.com/'
};

/**
 * Bing 图片搜索。
 * @param {Function} [opts.fetcher] **只为测试注入**（默认 `safeFetch`）；用来验"上限真的传下去了"。
 */
export async function bingImageSearch(query, { limit = 8, browseLocked = false, maxBytes = IMAGE_SEARCH_MAX_BYTES, fetcher = safeFetch } = {}) {
  const { body } = await fetcher(bingImageSearchUrl(query), { browseLocked, maxBytes });
  const out = parseBingImages(body, limit);
  if (!out.length) throw new Error('Bing 图片搜索没解析到结果（页面结构可能已改版）');
  return out.map((url) => ({ title: String(query).trim(), url }));
}

/** 百度图片搜索（走 JSON 接口 + 它要求的请求头，见上面两条注释）。 */
export async function baiduImageSearch(query, { limit = 8, browseLocked = false, maxBytes = IMAGE_SEARCH_MAX_BYTES, fetcher = safeFetch } = {}) {
  const { body } = await fetcher(baiduImageSearchUrl(query), { browseLocked, maxBytes, headers: BAIDU_IMAGE_HEADERS });
  const out = parseBaiduImages(body, limit);
  if (!out.length) throw new Error('百度图片搜索没解析到结果（接口结构可能已改版）');
  return out.map((url) => ({ title: String(query).trim(), url }));
}

/**
 * 关键词图搜入口：按顺序试源，一个失败自动换另一个。
 *
 * 为什么"自动换源"很重要：这两家的结构都随时可能改版，只押一个源的话，
 * 改版当天功能就整个不可用。
 *
 * @param {Array} [opts.sources] **只为测试注入**（给假引擎，验降级链真的换了源）。
 *   默认 `[baiduImageSearch, bingImageSearch]` —— 百度在前，中文关键词命中率更好。
 *   传 `sources` 时它同时也会被透传 `maxBytes` / `browseLocked`。
 */
export async function searchImages(query, { limit = 8, browseLocked = false, maxBytes = IMAGE_SEARCH_MAX_BYTES, sources = null } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索关键词为空');
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const list = Array.isArray(sources) && sources.length ? sources : [baiduImageSearch, bingImageSearch];
  const errors = [];
  for (const fn of list) {
    try {
      const hit = await fn(q, { limit: n, browseLocked, maxBytes });
      if (hit && hit.length) return hit;
      errors.push(`${fn.name || '匿名源'}: 没有结果`);
    } catch (error) {
      errors.push(`${fn.name || '匿名源'}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`图片搜索全部失败 —— ${errors.join('；')}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 插画路：Safebooru（2026-10-04 第四十对话 · 批 1，方案 §2）
//
// ── 为什么是它、而不是 pixiv 直连 ────────────────────────────────────────
// 用户拍板 A2：**先做能用的**（Safebooru，天花板 = questionable），真 R-18 那条路
// （路线 C：本机直连 pixiv）依赖 `safeFetch` 的代理支持，是另一个改动点。
//
// ── 本机实测契约（探针：`_临时产物-第三十九对话\探-safebooru*.mjs`，别凭印象改）──
//   · `GET /index.php?page=dapi&s=post&q=index&json=1&limit=N&tags=<空格分隔，整体 encodeURIComponent>`
//   · 🔴 **查不到 ⇒ HTTP 200 + 空响应体**（不是 `[]`、也不报错）—— 不存在的 tag、
//     `rating:explicit`、中文 tag 都是这个形态 ⇒ 解析器**必须把空体当"没有"**。
//   · `rating` 与角色 tag 可以 AND（`hatsune_miku rating:questionable` ✔）；
//     **默认检索不含 questionable** ⇒ `rating='any'` 要**发两次**再按 id 去重合并。
//   · 排序是**伪 tag**（`sort:score:desc` 写在 tags 里才有效，`&sort=` 查询参数无效）。
//   · `file_url` / `sample_url` / `preview_url` **我们自己都下得下来**（HTTP 206）⇒
//     **搜索这条路不需要反代**。反代只对"别人贴的 i.pximg.net 链接"有用（见 onebot.js）。
//   · `safebooru.org` **不在** `security.browseLock` 的域名白名单管辖范围内
//     （`validateImageUrl` 不读它）⇒ 不需要改任何白名单。
// ═══════════════════════════════════════════════════════════════════════════

const SAFEBOORU_ENDPOINT = 'https://safebooru.org/index.php';

/**
 * Safebooru 要的请求头。
 * ⚠️ 实测（`探-safebooru契约要点4.mjs`）跑的是**浏览器 UA**；我们默认的 `qq-agent/1.0`
 *    没有被验证过 —— 这里照实测那一套写，⛔ 别"顺手换成默认的"。
 * 🔴 这两个头走的是 `safeFetch` 的**白名单覆盖**（`host`/`cookie` 永远不许覆盖）。
 */
const SAFEBOORU_HEADERS = {
  'user-agent': IMAGE_UA,
  accept: 'application/json,*/*'
};

/** 拼 Safebooru 的 dapi 地址（纯函数：抽出来才能单测"tag 真的编码了、rating 只加在第二次"）。 */
export function safebooruSearchUrl(tags, { limit = 12 } = {}) {
  const t = (Array.isArray(tags) ? tags : [tags])
    .map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
  if (!t) throw new Error('插画搜索的 tag 为空');
  const n = Math.max(1, Math.min(50, Number(limit) || 12));
  return `${SAFEBOORU_ENDPOINT}?page=dapi&s=post&q=index&json=1&limit=${n}&tags=${encodeURIComponent(t)}`;
}

/**
 * 从 `source` 里认出 pixiv 作品页 —— 没有就给空串。
 *
 * 两种形态都认（第二种是**主力**）：
 *   ① `source` 直接写着 `pixiv.net/artworks/<id>`；
 *   ② 🔴 `source` 是 `i.pximg.net/img-original/img/..../<作品id>_p<页码>.<ext>` ——
 *      实测这是最常见的一类（抽样里 4/10 是 pximg），而它**不含 artworks**。
 *      文件名前缀那个数字就是作品 id ⇒ 能直接拼出作品页（这就是方案要的"出处"）。
 */
export function pixivArtworkUrl(source) {
  const s = String(source ?? '');
  const m = /pixiv\.net\/(?:[a-z]{2}\/)?artworks\/(\d+)/i.exec(s);
  if (m) return `https://www.pixiv.net/artworks/${m[1]}`;
  const p = /i\.pximg\.net\/[^\s"']*?\/(\d+)_p\d+\.(?:jpg|jpeg|png|gif|webp)/i.exec(s);
  return p ? `https://www.pixiv.net/artworks/${p[1]}` : '';
}

/**
 * 解析 Safebooru 的 post 列表（**纯函数**）。
 *
 * 🔴 **空响应体 ⇒ 返回 `[]`，⛔ 不抛 JSON 解析异常**：实测"查不到"就是 200 + 空体
 *    （不存在的 tag / `rating:explicit` / 中文 tag 全是这个形态）。第一版若直接
 *    `JSON.parse('')`，症状是"翻一个不存在的角色就报错"，看着像网络问题。
 */
export function parseSafebooruImages(body, limit = 12) {
  const max = Math.max(1, Math.min(50, Number(limit) || 12));
  const text = String(body ?? '').trim();
  if (!text) return [];
  let arr;
  try { arr = JSON.parse(text); } catch { throw new Error('Safebooru 返回的不是 JSON（可能改版或被拦）'); }
  // ⚠️ 正常成功 = **JSON 数组**（实测 `limit=1` 也是长度 1 的数组）。别的形状（对象/字符串/null）
  //    说明接口变了或被拦了 ⇒ **抛**，⛔ 不许静默折成"没找到"（本项目最忌"看着像没结果"）。
  if (!Array.isArray(arr)) throw new Error('Safebooru 返回的不是 post 数组（可能改版或被拦）');
  const out = [];
  for (const p of arr) {
    const url = String(p?.file_url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) continue;      // 没有可下载地址的条目直接跳过（不产出 undefined）
    const source = String(p?.source ?? '').trim();
    out.push({
      url,
      sampleUrl: String(p?.sample_url ?? '').trim(),
      previewUrl: String(p?.preview_url ?? '').trim(),
      rating: String(p?.rating ?? '').trim(),
      size: (p?.width && p?.height) ? `${p.width}x${p.height}` : '',
      source,
      pageUrl: pixivArtworkUrl(source),
      id: p?.id ?? null,
      tags: String(p?.tags ?? '').trim()
    });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 插画路搜索（Safebooru）。
 *
 * @param {object} o
 * @param {string[]} o.tags 已校验过的 tag（至少一个）
 * @param {'safe'|'questionable'|'any'} o.rating `any` = 默认一次 + `rating:questionable` 一次，按 id 去重合并
 * @param {Function} [o.fetcher] **只为测试注入**（默认 `safeFetch`）
 * @returns {Promise<Array>} 每条带 `url/sampleUrl/rating/size/source/pageUrl/title`
 *
 * ⚠️ 空体（= 这个 tag 没图）**不抛错**，返回 `[]` —— 由调用方给"换 tag"的话；
 *    只有**请求本身失败**（网络/非 JSON）才抛。
 */
export async function safebooruImageSearch(query, {
  tags = [], rating = 'any', limit = 8, browseLocked = false,
  maxBytes = IMAGE_SEARCH_MAX_BYTES, fetcher = safeFetch
} = {}) {
  const base = (Array.isArray(tags) ? tags : [tags]).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (!base.length) throw new Error('插画搜索缺少 tag');
  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  // 🔴 实测：默认检索**不含** questionable，所以 'any' 必须发两次（第二次才加 rating 标签）。
  const rounds = rating === 'any' ? [base, [...base, 'rating:questionable']]
    : rating === 'questionable' ? [[...base, 'rating:questionable']]
      : [base];
  const out = [];
  const seen = new Set();
  const errors = [];
  for (const round of rounds) {
    try {
      const { body } = await fetcher(safebooruSearchUrl(round, { limit: n }), { browseLocked, maxBytes, headers: SAFEBOORU_HEADERS });
      for (const it of parseSafebooruImages(body, n)) {
        if (seen.has(it.url)) continue;             // 两轮之间按地址去重（同一个 post 可能两边都出现）
        seen.add(it.url);
        out.push(it);
      }
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }
  if (!out.length && errors.length) throw new Error(`Safebooru 搜索失败 —— ${errors.join('；')}`);
  return out.slice(0, n).map((it) => ({ ...it, title: String(query ?? '').trim() }));
}

// ── 中文 → booru tag 的词典（内置种子 + 配置扩展）─────────────────────────
//
// **为什么必须有它**：bing/百度吃中文，而 booru 的 tag 是英文/罗马字。
// 实测 `tags=初音未来` ⇒ **空响应体**（不是 []）。所以"中文问一句角色名"必须翻译。
// ⚠️ 只做**确定性映射**（不猜、不调模型）：映射不到的候选 tag 会**逐个打接口校验**
//    （空体 = 这个 tag 没有图），所以词典里写歪一条的后果只是"那一条不生效"，不会造假。
// 配置扩展 `imageSearch.extraTags`（映射型）的键**覆盖**内置的同名键 —— 与
// `api.modelPrices` 的既有形状一致。
const ILLUSTRATION_TAG_SEED = {
  // ── VOCALOID / 中文圈常见 ──
  初音未来: 'hatsune_miku', 初音: 'hatsune_miku', miku: 'hatsune_miku',
  镜音铃: 'kagamine_rin', 镜音连: 'kagamine_len', 巡音露卡: 'megurine_luka', 洛天依: 'luo_tianyi',
  // ── 东方 Project ──
  博丽灵梦: 'hakurei_reimu', 雾雨魔理沙: 'kirisame_marisa', 十六夜咲夜: 'izayoi_sakuya',
  芙兰朵露: 'flandre_scarlet', 蕾米莉亚: 'remilia_scarlet', 帕秋莉: 'patchouli_knowledge',
  八云紫: 'yakumo_yukari', 魂魄妖梦: 'konpaku_youmu', 琪露诺: 'cirno', 东风谷早苗: 'kochiya_sanae',
  古明地恋: 'komeiji_koishi', 古明地觉: 'komeiji_satori', 藤原妹红: 'fujiwara_no_mokou',
  蓬莱山辉夜: 'houraisan_kaguya', 西行寺幽幽子: 'saigyouji_yuyuko', 铃仙: 'reisen_udongein_inaba',
  射命丸文: 'shameimaru_aya', 四季映姬: 'shiki_eiki', 比那名居天子: 'hinanawi_tenshi',
  八坂神奈子: 'yasaka_kanako', 洩矢诹访子: 'moriya_suwako', 伊吹萃香: 'ibuki_suika',
  秦心: 'hata_no_kokoro', 鬼人正邪: 'kijin_seija',
  东方: 'touhou', 东方project: 'touhou', 东方红魔乡: 'touhou',
  // ── 原神 / 崩坏 / 其他手游 ──
  原神: 'genshin_impact', 钟离: 'zhongli_(genshin_impact)', 胡桃: 'hu_tao_(genshin_impact)',
  甘雨: 'ganyu_(genshin_impact)', 刻晴: 'keqing_(genshin_impact)', 可莉: 'klee_(genshin_impact)',
  雷电将军: 'raiden_shogun', 派蒙: 'paimon_(genshin_impact)', 荧: 'lumine_(genshin_impact)',
  神里绫华: 'kamisato_ayaka', 八重神子: 'yae_miko',
  崩坏3: 'honkai_impact_3rd', 琪亚娜: 'kiana_kaslana', 雷电芽衣: 'raiden_mei',
  明日方舟: 'arknights', 蔚蓝档案: 'blue_archive', 碧蓝档案: 'blue_archive',
  碧蓝航线: 'azur_lane', 少女前线: 'girls\'_frontline', 舰队collection: 'kantai_collection',
  公主连结: 'princess_connect!', 赛马娘: 'uma_musume_pretty_derby',
  偶像大师: 'idolmaster', lovelive: 'love_live!',
  // ── 动画 / 漫画 ──
  火影忍者: 'naruto', 漩涡鸣人: 'uzumaki_naruto', 春野樱: 'haruno_sakura', 日向雏田: 'hyuuga_hinata',
  旗木卡卡西: 'hatake_kakashi', 宇智波鼬: 'uchiha_itachi',
  海贼王: 'one_piece', 航海王: 'one_piece', 娜美: 'nami_(one_piece)', 索隆: 'roronoa_zoro',
  罗宾: 'nico_robin', 汉库克: 'boa_hancock',
  死神: 'bleach', 黑崎一护: 'kurosaki_ichigo', 朽木露琪亚: 'kuchiki_rukia',
  银魂: 'gintama', 坂田银时: 'sakata_gintoki',
  名侦探柯南: 'detective_conan', 灰原哀: 'haibara_ai', 毛利兰: 'mouri_ran',
  进击的巨人: 'shingeki_no_kyojin', 鬼灭之刃: 'kimetsu_no_yaiba', 咒术回战: 'jujutsu_kaisen',
  间谍过家家: 'spy_x_family', 孤独摇滚: 'bocchi_the_rock!', 葬送的芙莉莲: 'sousou_no_frieren',
  轻音少女: 'k-on!', 凉宫春日: 'suzumiya_haruhi_no_yuuutsu', 长门有希: 'nagato_yui',
  冰菓: 'hyouka', 千反田爱瑠: 'chitanda_eru',
  我的青春恋爱物语果然有问题: 'yahari_ore_no_seishun_love_come_wa_machigatteiru',
  雪之下雪乃: 'yukinoshita_yukino', 由比滨结衣: 'yuigahama_yui', 一色彩羽: 'isshiki_iroha',
  辉夜大小姐想让我告白: 'kaguya-sama_wa_kokurasetai', 四宫辉夜: 'shinomiya_kaguya',
  藤原千花: 'fujiwara_chika', 白银御行: 'shirogane_miyuki',
  从零开始的异世界生活: 're:zero_kara_hajimeru_isekai_seikatsu', re0: 're:zero_kara_hajimeru_isekai_seikatsu',
  雷姆: 'rem_(re:zero)', 拉姆: 'ram_(re:zero)', 艾米莉娅: 'emilia_(re:zero)',
  为美好的世界献上祝福: 'kono_subarashii_sekai_ni_shukufuku_wo!', 阿库娅: 'aqua_(konosuba)',
  惠惠: 'megumin', 达克妮斯: 'darkness_(konosuba)',
  fate: 'fate_(series)', 阿尔托莉雅: 'artoria_pendragon', saber: 'artoria_pendragon',
  远坂凛: 'tohsaka_rin', 间桐樱: 'matou_sakura', 尼禄: 'nero_claudius', 玉藻前: 'tamamo_no_mae',
  玛修: 'mash_kyrielight', 贞德: 'jeanne_d\'arc_(fate)', 冲田总司: 'okita_souji',
  斯卡哈: 'scathach_(fate)', 阿斯托尔福: 'astolfo_(fate)',
  新世纪福音战士: 'neon_genesis_evangelion', eva: 'neon_genesis_evangelion',
  魔法少女小圆: 'mahou_shoujo_madoka_magica', 某科学的超电磁炮: 'toaru_kagaku_no_railgun',
  你的名字: 'kimi_no_na_wa', 天气之子: 'tenki_no_ko', 千与千寻: 'sen_to_chihiro_no_kamikakushi',
  龙猫: 'tonari_no_totoro',
  宝可梦: 'pokemon', 精灵宝可梦: 'pokemon', 宠物小精灵: 'pokemon',
  刀剑神域: 'sword_art_online', 亚丝娜: 'yuuki_asuna',
  // ── 常见 tag / 题材（她可能直接这么问）──
  猫娘: 'catgirl', 女仆: 'maid', 泳装: 'swimsuit', 和服: 'kimono', 校服: 'school_uniform',
  兔女郎: 'bunny_girl', 兽耳: 'animal_ears', 双马尾: 'twintails', 长发: 'long_hair',
  短发: 'short_hair', 银发: 'silver_hair', 金发: 'blonde', 黑发: 'black_hair', 白发: 'white_hair',
  蓝发: 'blue_hair', 粉发: 'pink_hair', 红发: 'red_hair',
  风景: 'scenery', 天空: 'sky', 樱花: 'cherry_blossoms', 星空: 'starry_sky'
};

/**
 * 归一化成 booru tag：小写、空格→下划线、全角括号→半角、剔掉非法字符。
 * ⚠️ 保留 `:`（`rating:questionable` / `sort:score:desc` 要用）与 `-`、`_`、`.`、`(`、`)`。
 * 中文会被整段剔掉 ⇒ 返回空串（调用方据此放弃这个候选、而不是拿中文去打接口白跑一次）。
 */
export function normalizeBooruTag(s) {
  return String(s ?? '')
    .trim().toLowerCase()
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/\s+/g, '_')
    .replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')')
    .replace(/[^a-z0-9_()\-.:]/g, '')
    .replace(/\(\)/g, '')                 // 整段中文被剔掉后可能只剩一对空括号 ⇒ 那不是 tag
    .replace(/_{2,}/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
}

/**
 * 把一句话（可能带角色名）翻成**一串候选 tag**，按优先级排（调用方只校验前几个）。
 *
 * 顺序：① 显式给的 `tags` → ② 整串精确命中词典 → ③ 词典键出现在句子里（长的优先）
 *      → ④ 整串本身归一化（英文/罗马字的情形，如 `hatsune_miku`）。
 * @param {object} [o.extraTags] 配置扩展（`imageSearch.extraTags`），键覆盖内置同名键
 */
export function illustrationTagCandidates(query, { tags = [], extraTags = {} } = {}) {
  const dict = { ...ILLUSTRATION_TAG_SEED };
  for (const [k, v] of Object.entries(extraTags || {})) {
    const key = String(k ?? '').trim().toLowerCase();
    const val = normalizeBooruTag(v);
    if (key && val) dict[key] = val;
  }
  const out = [];
  const push = (t) => {
    const v = normalizeBooruTag(t);
    if (v && !out.includes(v)) out.push(v);
  };
  for (const t of Array.isArray(tags) ? tags : []) push(t);
  const ql = String(query ?? '').trim().toLowerCase();
  if (dict[ql]) push(dict[ql]);
  const keys = Object.keys(dict).filter((k) => k && ql.includes(k)).sort((a, b) => b.length - a.length);
  for (const k of keys) push(dict[k]);
  push(query);
  return out;
}

/**
 * 插画路的完整编排：候选 tag → **逐个校验**（空体 = 这个 tag 没有图）→ 取第一个真的有图的搜。
 *
 * 为什么要"校验"这一步（实测口径）：词典映射不到的候选（中文、拼错的罗马字）打过去
 * 一律是**空响应体**。不校验的话她会拿到一句干巴巴的"没找到"，而**校验过之后**我们能
 * 明确告诉她"按 tag 搜不到，请用罗马字"（方案 §2.4③）。
 *
 * @param {object} o
 * @param {number} [o.maxProbe] 每次调用最多校验几个候选（默认 4，方案 §2.4②）
 * @param {Map}    [o.cache]   **本次运行内**的 tag→有无图 缓存（挂在 ctx 上，见 tools.js）
 * @param {Function} [o.fetcher] / [o.prober] **只为测试注入**
 * @returns {Promise<{ok:boolean, reason?:string, tag?:string, tried:string[], list?:Array}>}
 *   `reason`：`no-candidate`（一个候选都提不出来）/ `no-tag`（都校验不过）—— 都不抛错，
 *   由调用方翻译成给她看的话。
 */
export async function illustrationSearch(query, {
  tags = [], extraTags = {}, rating = 'any', limit = 8, maxProbe = 4,
  cache = null, browseLocked = false, maxBytes = IMAGE_SEARCH_MAX_BYTES,
  fetcher = safeFetch, prober = null
} = {}) {
  const candidates = illustrationTagCandidates(query, { tags, extraTags });
  if (!candidates.length) return { ok: false, reason: 'no-candidate', tried: [] };
  const probe = prober || (async (t) => {
    const { body } = await fetcher(safebooruSearchUrl([t], { limit: 1 }), { browseLocked, maxBytes, headers: SAFEBOORU_HEADERS });
    return parseSafebooruImages(body, 1).length > 0;
  });
  const tried = [];
  let hit = '';
  for (const t of candidates.slice(0, Math.max(1, Number(maxProbe) || 4))) {
    tried.push(t);
    let okTag;
    if (cache instanceof Map && cache.has(t)) {
      okTag = cache.get(t);
    } else {
      // ⚠️ 校验时**网络失败要抛**（别把"网断了"说成"没这个 tag"），由调用方如实转述。
      okTag = await probe(t);
      if (cache instanceof Map) cache.set(t, !!okTag);
    }
    if (okTag) { hit = t; break; }
  }
  if (!hit) return { ok: false, reason: 'no-tag', tried };
  const list = await safebooruImageSearch(query, { tags: [hit], rating, limit, browseLocked, maxBytes, fetcher });
  return { ok: true, tag: hit, tried, list };
}

// ══ pixiv 检索源（2026-10-04 第四十二对话 · 调研 §1）══════════════════════════
//
// **为什么需要它**：用户的抱怨是"p 站图太多、随机搜质量不佳"。而 **pixiv 的"按热度排序"
// 是付费功能**（`order=popular_d`、按收藏数过滤都要 Premium：官方 ajax 文档逐字写着
// "Premium account authorization is required."，实测参数被无视、`bookmarkData` 全 null）。
// ⇒ 免费的两条替代（都真机实测过）：
//   ① `body.popular` —— **同一个搜索响应里**就有一个人工挑选的热门列表（零额外请求；
//      实测"按最新搜"的结果与它 0 重合，条目自带 `N users入り` tag）；
//   ② 把词收窄成 `初音ミク 5000users入り` —— pixiv 按 tag 匹配 ⇒ 池子变成"被 5000 人收藏过"。
//      冷门 tag 会剩个位数 ⇒ **必须自动降档**（5000 → 1000 → 不加修饰词）并如实上报。
//
// 🔴 四条实测钉死的事实（⛔ 别凭印象改）：
//   ① **`order=date` 是"旧→新"**（首条是 2007 年的 258 号作品）⇒ 要**新→旧**必须写
//      `order=date_d`（带 `_d` 后缀）。照抄文档里那个 `date` 会让搜索结果全是远古投稿。
//   ② **匿名拿不到 R-18**（`mode=r18` 要登录；实测 `xRestrict` 恒为 0）⇒ 这条路只有全年龄，
//      ⛔ 工具描述与给她的回话里都不许把它当承诺。
//   ③ **全尺寸地址必须走 `/ajax/illust/<id>/pages`**：改写缩略图 URL 那条路实测 404
//      （文件名后缀都不一样：缩略图 `_square1200.jpg`、原图 `_p0.png`）⇒ ⛔ 别猜文件名。
//   ④ 🔴 **搜索响应是 73KB 级**，而 `safeFetch` 默认只收 50KB ⇒ 必须显式给大 `maxBytes`，
//      否则 `JSON.parse` 在截断处炸（"搜索报错"看着像网络问题，其实是自己截的）。
//
// ⚠️ 这条路**必须有代理**才能走通（pixiv 本机直连不通）；`resolveProxyFor('www.pixiv.net')`
//    为空时 `illustrationSearchAnySource` 直接退 Safebooru，⛔ 不在这里静默直连。
export const PIXIV_DEFAULT_HEAT = 5000;
/** pixiv 搜索响应的大小（见上面事实 ④）。 */
export const PIXIV_TEXT_MAX_BYTES = 2 * 1024 * 1024;
const PIXIV_PAGES_MAX_BYTES = 256 * 1024;
/** ⚠️ `referer` 是**这个站要求的**（不是可选美化）：ajax 与图床都认它。 */
const PIXIV_HEADERS = { referer: 'https://www.pixiv.net/', accept: 'application/json,*/*' };

/** 热度档 → 搜索词。`0` = 不加修饰词（给她传 `heat='off'` 时）。 */
export function pixivHeatWord(tag, heat) {
  const t = String(tag ?? '').trim();
  const h = Number(heat) || 0;
  return h > 0 ? `${t} ${h}users入り` : t;
}

/**
 * 降档链：`5000 → 1000 → 0`（`0` = 不加修饰词）。
 * 传 `10000` ⇒ `[10000, 5000, 1000, 0]`；传 `off`/`0` ⇒ `[0]`。
 * ⚠️ 冷门 tag 走 5000 门槛会**只剩个位数甚至 0 条**，所以"自动降档"不是可选优化。
 */
export function pixivHeatChain(heat) {
  const h = Number(heat) || 0;
  if (h <= 0) return [0];
  const chain = [h];
  for (const s of [5000, 1000]) if (s < h) chain.push(s);
  chain.push(0);
  return [...new Set(chain)];
}

/** 模型给的 `heat` → 数字。`off` = 0；不认识/没给 ⇒ **默认 5000**（⛔ 别把 undefined 当 0）。 */
export function normalizePixivHeat(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return PIXIV_DEFAULT_HEAT;
  const s = String(raw).trim().toLowerCase();
  if (s === 'off' || s === 'none' || s === '0') return 0;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : PIXIV_DEFAULT_HEAT;
}

/** 🔴 `order=date_d` = **新→旧**（见文件段头事实 ①）。纯函数，便于单测。 */
export function pixivSearchUrl(word, { order = 'date_d', mode = 'all' } = {}) {
  const w = String(word ?? '').trim();
  return `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(w)}`
    + `?word=${encodeURIComponent(w)}&order=${order}&mode=${mode}&s_mode=s_tag&lang=zh`;
}

/** 作品全尺寸地址的来源。⛔ 不许改成"改写缩略图 URL"。 */
export function pixivPagesUrl(id) {
  return `https://www.pixiv.net/ajax/illust/${encodeURIComponent(String(id ?? ''))}/pages?lang=zh`;
}

/**
 * 解析 pixiv 搜索响应（**纯函数**）。返回 `{ rows, popular }`。
 * ⚠️ 空响应体 ⇒ `{ rows: [], popular: [] }`（⛔ 不抛）：与 Safebooru 那条实测契约同口径
 *    ——"查不到"在 pixiv 这边也可能表现为空体，把它说成"报错"会让人去查网络。
 * ⚠️ `error:true` 才抛（那才是接口真的拒了）。
 */
export function parsePixivSearch(body) {
  const text = String(body ?? '').trim();
  if (!text) return { rows: [], popular: [] };
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('pixiv 返回的不是 JSON（可能改版、被截断或被拦）'); }
  if (j?.error) throw new Error(`pixiv 搜索报错：${j?.message || '未知'}`);
  const b = j?.body || {};
  const rows = Array.isArray(b?.illustManga?.data) ? b.illustManga.data : [];
  const popular = [...(b?.popular?.recent || []), ...(b?.popular?.permanent || [])];
  return { rows, popular };
}

/** 从 `/pages` 响应里取**第 0 页**的四个地址（纯函数；取不到就给空串，⛔ 不猜文件名）。 */
export function parsePixivPages(body) {
  const text = String(body ?? '').trim();
  if (!text) return { original: '', regular: '', small: '', thumbMini: '' };
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('pixiv /pages 返回的不是 JSON（可能改版或被拦）'); }
  const u = j?.body?.[0]?.urls || {};
  return {
    original: String(u.original || ''),
    regular: String(u.regular || ''),
    small: String(u.small || ''),
    thumbMini: String(u.thumb_mini || '')
  };
}

/**
 * 一条 pixiv 搜索结果 → **与 Safebooru 路同形状**的条目（`illustrationImagesFor` 直接能用）。
 * ⚠️ `url`（全尺寸）留空，等 `/pages` 回来再填；`sampleUrl` 先放搜索响应里的缩略图兜底。
 */
export function pixivRowToItem(row) {
  const id = String(row?.id ?? '');
  const thumb = String(row?.url || '');
  return {
    id,
    url: '',
    sampleUrl: thumb,
    previewUrl: thumb,
    // 匿名 pixiv 恒 `xRestrict === 0`；>0 只可能在"哪天真的登录了"之后出现 ⇒ 调用方会把它剔掉
    rating: Number(row?.xRestrict) > 0 ? 'r18' : 'general',
    size: (row?.width && row?.height) ? `${row.width}x${row.height}` : '',
    source: id ? `https://www.pixiv.net/artworks/${id}` : '',
    pageUrl: id ? `https://www.pixiv.net/artworks/${id}` : '',
    tags: Array.isArray(row?.tags) ? row.tags.join(',') : String(row?.tags || ''),
    title: String(row?.title || ''),
    pageCount: Math.max(1, Number(row?.pageCount) || 1)
  };
}

/**
 * pixiv 插画搜索：降档链 → 并上 `popular` → 逐条取全尺寸。
 *
 * ⚠️ 词的顺序**与 Safebooru 路相反**：pixiv 直接吃中文/日文（实测），所以**先搜原句**，
 *    显式给的 `tags`（多半是 booru 的罗马字）排后面当备选。
 *
 * @returns {Promise<{ok:boolean, reason?:string, word?:string, heat?:number, downgraded?:boolean,
 *   list?:Array, tried:Array, popularCount?:number, fullSizeMiss?:number, r18Dropped?:number}>}
 *   `reason`：`no-proxy`（没配代理，这条路走不通）/ `no-candidate` / `no-result`。
 *   ⛔ 这些都不抛（除了网络本身失败）—— 由调用方决定要不要退到另一条路。
 */
export async function pixivIllustrationSearch(query, {
  tags = [], heat = PIXIV_DEFAULT_HEAT, limit = 8, browseLocked = false,
  rating = 'any',
  maxBytes = PIXIV_TEXT_MAX_BYTES, fetcher = safeFetch, pagesFetcher = null
} = {}) {
  // 没有代理 ⇒ 直连 pixiv 必失败。**在发请求之前**就如实说清楚（省一次必然失败的等待）。
  if (!resolveProxyFor('www.pixiv.net')) return { ok: false, reason: 'no-proxy', tried: [] };

  // 🆕 2026-10-05（第四十三对话 · 交接 §3-113）：登录态下，`rating='questionable'`
  //    才真的去要 R-18（匿名要了也会被忽略），并**保留**结果（下面那道过滤会放过它们）。
  const loggedIn = pixivLoggedIn();
  const mode = pixivModeForRating(rating, loggedIn);
  const keepR18 = loggedIn && mode === 'r18';

  const query_ = String(query ?? '').trim();
  const words = [query_, ...(Array.isArray(tags) ? tags : [tags]).map((x) => String(x ?? '').trim())]
    .filter(Boolean);
  if (!words.length) return { ok: false, reason: 'no-candidate', tried: [] };

  const n = Math.max(1, Math.min(12, Number(limit) || 8));
  const pages = pagesFetcher || fetcher;
  const tried = [];
  let used = null;
  for (const word of words) {
    for (const step of pixivHeatChain(heat)) {
      const w = pixivHeatWord(word, step);
      const { body } = await fetcher(pixivSearchUrl(w, { mode }), { browseLocked, maxBytes, headers: PIXIV_HEADERS });
      const { rows, popular } = parsePixivSearch(body);
      tried.push({ word: w, heat: step, count: rows.length, popular: popular.length });
      if (rows.length || popular.length) { used = { word: w, heat: step, rows, popular }; break; }
    }
    if (used) break;
  }
  if (!used) return { ok: false, reason: 'no-result', tried };

  // 合并：热门（`popular`，有就排前面）→ 按最新搜的结果；按 id 去重。
  const seen = new Set();
  const merged = [];
  const push = (row, hot) => {
    const id = String(row?.id ?? '');
    if (!id || seen.has(id)) return;
    seen.add(id);
    merged.push({ row, hot });
  };
  for (const row of used.popular) push(row, true);
  for (const row of used.rows) push(row, false);

  // ⛔ 匿名拿不到 R-18（`mode=r18` 会被忽略）⇒ 真出现了也只能剔掉，别装作拿到了。
  //    登录态**明确要了** `r18` 时则保留 —— 这是"R-18 也要发"那条用户要求落地的位置。
  const allowed = keepR18 ? merged : merged.filter((x) => !(Number(x.row?.xRestrict) > 0));
  const r18Dropped = keepR18 ? 0 : (merged.length - allowed.length);
  const r18Kept = keepR18 ? allowed.filter((x) => Number(x.row?.xRestrict) > 0).length : 0;
  const chosen = allowed.slice(0, n);

  const list = await Promise.all(chosen.map(async ({ row, hot }) => {
    const item = pixivRowToItem(row);
    let fullSize = false;
    try {
      const { body } = await pages(pixivPagesUrl(item.id), { browseLocked, maxBytes: PIXIV_PAGES_MAX_BYTES, headers: PIXIV_HEADERS });
      const u = parsePixivPages(body);
      if (u.original) { item.url = u.original; fullSize = true; }
      if (u.regular) item.sampleUrl = u.regular;
      else if (u.small) item.sampleUrl = u.small;
    } catch { fullSize = false; }
    // 原图接口没给 ⇒ 至少留一个**能用**的链接（缩略图），并把这件事如实往上带
    if (!item.url) item.url = item.sampleUrl;
    return { ...item, hot, fullSize };
  }));

  const askedHeat = Number(heat) || 0;
  return {
    ok: true,
    source: 'pixiv',
    word: used.word,
    heat: used.heat,
    downgraded: used.heat !== askedHeat,
    // 🆕 §3-113：这次到底按哪个 mode 去要的（匿名恒 'all'）—— 带上它，"为什么没搜到 R-18"
    //    才能被如实解释成"没登录 / 登录态过期"，而不是"这个站没有这类图"。
    mode,
    loggedIn,
    list,
    tried,
    popularCount: used.popular.length,
    hotCount: list.filter((x) => x.hot).length,
    fullSizeMiss: list.filter((x) => !x.fullSize).length,
    r18Dropped,
    r18Kept
  };
}

/** 这次 pixiv 这条路**能不能走**（= 配了代理且名单含 pixiv）。⛔ 不在别处重复这个判断。 */
export function pixivRouted() {
  return resolveProxyFor('www.pixiv.net') !== null;
}

/**
 * 🆕 2026-10-05（第四十三对话 · 交接 §3-113）：pixiv 现在**是不是登录态**。
 *
 * 判据只有一个：配置里有没有那份会话 cookie（`imageSearch.pixivCookie`，由用户在设置页自己粘）。
 * ⛔ 不许"猜"、也不许拿别的东西（比如"能不能取到某个需登录的接口"）当代理信号 ——
 *    那会变成一次额外请求，而且失败原因会被混进"没登录"里。
 *
 * ⚠️ 它**不等于**"cookie 还有效"：会过期，而过期之后 pixiv 多半只是**静默当匿名**处理
 *    （R-18 搜不到、`xRestrict` 又是 0）。所以调用方必须把 `mode=r18` 这件事**如实报上去**，
 *    让"明明配了却搜不到 R-18"看起来像**登录态过期**，而不是"这个站没有这类图"。
 */
export function pixivLoggedIn() {
  let raw;
  try { raw = getConfig()?.imageSearch?.pixivCookie; } catch { raw = ''; }
  return String(raw ?? '').trim().length > 0;
}

/**
 * 「要 questionable」在 pixiv 这边该用哪个 `mode`。
 *
 * 实测（2026-10-04 第四十二对话）：**匿名下 `mode=r18` 会被静默忽略**（`xRestrict` 恒为 0）。
 * ⇒ 只有**登录态**才敢用它；没登录时老老实实 `all`（多要一次也是白要）。
 */
export function pixivModeForRating(rating, loggedIn = pixivLoggedIn()) {
  return (loggedIn && String(rating) === 'questionable') ? 'r18' : 'all';
}

/**
 * 插画路的**来源路由**（第四十二对话 · 调研 §1.7）：`pixiv` / `safebooru` / `auto`。
 *
 * `auto` 的语义（用户拍板"并列、不是替换"）：
 *   · 要 `questionable` **且没配 pixiv 登录态** ⇒ **直接 Safebooru**（匿名只有全年龄，过去也是白跑）；
 *     🆕 §3-113：**配了登录态就去 pixiv 要 `mode=r18`** —— 用户要的 R-18 本来就在那边。
 *   · 没配代理 ⇒ pixiv 走不通 ⇒ **直接 Safebooru**（连一次 pixiv 请求都不发）；
 *   · 配了代理 ⇒ **先 pixiv**，没搜到/出错才退 Safebooru；
 *   · 无论走哪条，**用了哪条 + 为什么**都写进 `source` / `notes` 带回去。
 * 🔴 这三条合起来保证：**没配代理时行为与加 pixiv 之前逐字节等价**（只剩 Safebooru 那一条路）。
 */
export async function illustrationSearchAnySource(query, {
  source = 'auto', tags = [], extraTags = {}, rating = 'any', heat = PIXIV_DEFAULT_HEAT,
  limit = 8, maxProbe = 4, cache = null, browseLocked = false,
  maxBytes = IMAGE_SEARCH_MAX_BYTES, fetcher = safeFetch, pixivPagesFetcher = null, prober = null
} = {}) {
  const src = ['auto', 'pixiv', 'safebooru'].includes(String(source)) ? String(source) : 'auto';
  const notes = [];
  const wantPixiv = src === 'pixiv' || src === 'auto';
  const wantBooru = src === 'safebooru' || src === 'auto';

  // 🆕 2026-10-05（第四十三对话 · 交接 §3-113）：这条分支的判据从"要 questionable"改成
  //    "要 questionable **且没登录**" —— 用户在设置页粘了 pixiv 会话 cookie 之后，
  //    pixiv 这条路**也能**给 R-18（`mode=r18`），再一律退 Safebooru 就是白白丢掉用户要的东西。
  //    ⚠️ 没登录时行为**逐字节不变**（仍然直接退 Safebooru，连一次 pixiv 请求都不发）。
  if (wantPixiv && String(rating) === 'questionable' && !pixivLoggedIn()) {
    notes.push('要 questionable，但没配 pixiv 登录态 ⇒ 这次没走 pixiv（匿名只有全年龄，而且匿名下 `mode=r18` 会被忽略）');
  } else if (wantPixiv && !pixivRouted()) {
    notes.push('没配代理 ⇒ pixiv 这条路走不通，这次走 Safebooru');
  } else if (wantPixiv) {
    try {
      const p = await pixivIllustrationSearch(query, {
        tags, heat, limit, browseLocked, rating,
        maxBytes: PIXIV_TEXT_MAX_BYTES, fetcher, pagesFetcher: pixivPagesFetcher
      });
      if (p.ok) {
        if (p.downgraded) {
          notes.push(`热度门槛降过档：${p.heat > 0 ? `${p.heat}users入り` : '不加门槛'}`
            + `（原本要 ${Number(heat) || 0}users入り，那个门槛下没有结果）`);
        }
        if (p.fullSizeMiss) notes.push(`有 ${p.fullSizeMiss} 张没拿到原图接口的全尺寸，给的是缩略图`);
        if (p.r18Dropped) notes.push(`有 ${p.r18Dropped} 张是 R-18（匿名拿不到，已剔掉）`);
        // 🆕 §3-113：登录态下真的拿到了 R-18 ⇒ 如实说"这次是按登录态要的"。
        //    ⛔ 别写成"放心发" —— 能不能发出去是 QQ 那边的事（概率失败由提示词交代）。
        if (p.r18Kept) notes.push(`按登录态要了 R-18（mode=r18），这批里有 ${p.r18Kept} 张是 R-18`);
        if (p.loggedIn && p.mode === 'r18' && !p.r18Kept) {
          notes.push('配了 pixiv 登录态、也按 mode=r18 要了，但这批里一张 R-18 都没有（也可能是登录态已经过期）');
        }
        return {
          ok: true, source: 'pixiv', tag: p.word, heat: p.heat, downgraded: p.downgraded,
          list: p.list, tried: p.tried, notes,
          // 这几个计数也带回去：它们是"这批图是怎么来的"的事实（工具层可以照实说）
          popularCount: p.popularCount, hotCount: p.hotCount,
          fullSizeMiss: p.fullSizeMiss, r18Dropped: p.r18Dropped, r18Kept: p.r18Kept,
          mode: p.mode, loggedIn: p.loggedIn
        };
      }
      notes.push(p.reason === 'no-result'
        ? `pixiv 没搜到（试过 ${p.tried.map((t) => `「${t.word}」`).join('、')}）`
        : `pixiv 这条路用不了（${p.reason}）`);
      if (src === 'pixiv') return { ok: false, source: 'pixiv', reason: p.reason, tried: p.tried, notes };
    } catch (error) {
      notes.push(`pixiv 这条路出错：${String(error?.message ?? error)}`);
      if (src === 'pixiv') return { ok: false, source: 'pixiv', reason: 'error', tried: [], notes };
    }
  }

  if (!wantBooru) return { ok: false, source: null, reason: 'no-source', tried: [], notes };
  const b = await illustrationSearch(query, {
    tags, extraTags, rating, limit, maxProbe, cache, browseLocked, maxBytes, fetcher, prober
  });
  return { ...b, source: 'safebooru', notes };
}
