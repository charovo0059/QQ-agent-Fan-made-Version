// 谷歌搜图（Lens）：借 Electron 的隐藏窗口，在**真 Chromium** 里跑一遍，拿结果页正文。
//
// 为什么不用 Node fetch：Lens 的结果页是**渲染出来**的，raw HTML 里只有一页 JS 壳；
// 而且它要真 cookie、真 UA、真 TLS 指纹。这正是本应用已经跑着 Electron 的用处。
//
// 已验证原型：本机探针 _bt/electron-lens/main17.js（日志 run12.log）——
//   预热 + 顶层表单 POST + 轮询正文，全程 3.2~7.6 秒，拿到 AI Overview + 站点名 + 标题。
//
// 🔴 四条硬纪律（判据 '测试-现行/test-谷歌搜图.mjs' 会静态扫，别"顺手优化"掉）：
//   ① **只碰自己那份随机命名的会话**：`session.fromPartition(<随机名>)`，代理只对
//      这一份会话生效。代理配置是**会话级**的 —— 打到默认会话上会外溢到整个应用
//      （实测结论见 'src/cf-fetch.js' 顶部那段），所以本模块**绝不**用默认会话。
//   ② **窗口必定销毁**：硬超时 + `finally { win.destroy() }`，任何失败路径都不许
//      把隐藏窗口留在那儿（漏窗口是本项目最贵的一类 bug）。
//   ③ **ERR_ABORTED(-3) 不是失败**：顶层表单 POST 打 '/v3/upload' 会拿到 303，
//      Chromium 因此把那次 loadURL 判成 ERR_ABORTED —— 而页面其实**已经**跳到结果页了。
//      把它当失败 = 把唯一能用的那条路封死。
//   ④ **生命周期留痕**：render-process-gone / did-fail-load / did-finish-load 各留一条
//      日志，出问题时能分清"窗口崩了"、"加载失败"还是"网络没回来"。
import { describeFetchError } from './fetch-error.js';

/** 结果正文的上限（模型用不着更长的，长了只会挤掉别的东西）。 */
export const LENS_TEXT_CAP = 4000;

const DEFAULT_TIMEOUT_MS = 30000;
const WARM_URL = 'https://lens.google.com/';                    // 预热：先把 cookie 落了
const UPLOAD_URL = 'https://lens.google.com/v3/upload?hl=en';   // 顶层表单 POST 的落点
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
// 🆕 2026-10-23（提案 a0009a16）：这里原来**只取 `document.body.innerText`**，一个锚点都不解析
//   ⇒ 结果页里明明有"直连作品页"的链接，模型却只能看到一段正文摘录（用户原话：
//   「谷歌搜图通道希望返回直连的作品页链接，而不是只给结果页」）。
//   现在同时交回 `{ text, links }`：正文不变（既有判据与模型口径都还认它），links 另跑一遍解析。
//   ⚠️ 老版本只会返回**字符串**；`pollPage` 里对两种形状都兼容（假的 browserApi 回字符串）。
// 🆕 2026-10-23（第五十五对话）：**加分区与纵坐标**。
//   🔴 为什么要动它：这一版实测发现 Lens 结果页的链接**全部**是
//      `https://www.google.com/goto?url=<加密串>` —— DOM 里**一个真实网址都没有**
//      （page 里 111 个锚点、82 个 goto，其它全是谷歌自家）。所以：
//        ① 光靠 `a.href` 永远拿不到作品页/论坛帖的真地址（上一版"直连作品页"实际一直为空）；
//        ② 真地址只能靠**让它真的跳一次**、在重定向里截（见下面 resolveGotoLinks）。
//   `y` 是相对文档顶部的纵坐标，用来把链接归到它所在的那个 h1/h2 分区
//   （"Visual matches" / "Web results" / AI Overview 那一段）—— 分区归属在 Node 侧算，
//   页面里只负责把数据取回来，方便离线判据。
const EXTRACT = `(() => {
  const out = { text: '', sections: [], links: [] };
  try { out.text = document.body ? document.body.innerText : ''; } catch (e) {}
  // ① 分区标题（h1/h2）：Lens 用它们分段，实测有 "Visual matches"、"Web results"、页脚等
  try {
    const hs = document.querySelectorAll('h1,h2');
    for (let i = 0; i < hs.length; i++) {
      const h = hs[i];
      out.sections.push({
        tag: String(h.tagName || ''),
        text: String(h.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
        y: Math.round(h.getBoundingClientRect().top + window.scrollY)
      });
    }
  } catch (e) { /* 拿不到分区就当没有分区，链接照旧返回 */ }
  // ② 所有锚点 + 纵坐标（上层用它算分区归属）
  try {
    const nodes = document.querySelectorAll('a[href]');
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const href = a.href || a.getAttribute('href') || '';
      if (!href) continue;
      out.links.push({
        url: String(href),
        title: String(a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90),
        y: Math.round(a.getBoundingClientRect().top + window.scrollY)
      });
      if (out.links.length >= 500) break;
    }
  } catch (e) { /* 拿不到锚点就当没有 */ }
  return out;
})()`;
// ── 直连作品页的解析（提案 a0009a16）──────────────────────────────────────
//   🔴 硬纪律：**取不到就诚实给 null，绝不拿结果页冒充作品页**。
//      结果页（google.com/search?vsrid=…）是你这次搜索的地址，不是"这幅画的出处"；
//      把它当 url 交出去，模型就会把一条谷歌搜索链接报给群友，而群友点开还是同一张图。
//
//   谷歌外链有两种形态，都要处理：
//     ① 直链：https://www.pixiv.net/artworks/123
//     ② 壳链：/url?q=<encodeURIComponent(真地址)>&sa=…  → 必须 decode 后再判域名
//   🔴 2026-10-23（第五十五对话 · 用户 ③ 问「按 pixiv/DLsite/E-Hentai 优先级排序会不会对
//      除二次元外的搜图有影响」）：**会，只要那张表里混着通用平台就会**。
//      原来 X/Twitter、bilibili、YouTube、微博、LOFTER、花瓣/堆糖 全在这张表里 ⇒ 一张现实照片
//      搜出来的推特帖会被当成"已知作品站直链"排到 pixiv 后面、还被说成"点开基本就是出处"，
//      而用户的原话正好相反：「有的也可能是 x 上的转发画师帖子的链接，非常鱼龙混杂」。
//      ⇒ 拆成两张表：
//        · WORK_HOSTS   = **真·作品站/图站**：页面上的 id 就是这个作品的编号（pixiv/artworks/123）
//        · PLATFORM_HOSTS = **通用平台**：同一条链接可能是原帖、也可能是别人的转发/搬运
//      排序只在 WORK_HOSTS 内部生效；平台页与论坛页按页面顺序原样给出，**不参与优先级竞争**。
const WORK_HOSTS = [
  // 优先级 = 数组顺序（用户点名要的那四类排最前）
  { re: /(^|\.)(pixiv\.net)$/i, site: "pixiv" },
  { re: /(^|\.)(fanbox\.cc)$/i, site: "pixivFANBOX" },
  { re: /(^|\.)(dlsite\.com|dlsite\.net)$/i, site: "DLsite" },
  { re: /(^|\.)(dmm\.co\.jp|dmm\.com)$/i, site: "FANZA/DMM" },
  { re: /(^|\.)(e-hentai\.org|exhentai\.org)$/i, site: "E-Hentai" },
  { re: /(^|\.)(fanaza\.jp|fanza\.co\.jp)$/i, site: "FANZA" },
  { re: /(^|\.)(danbooru\.donmai\.us)$/i, site: "Danbooru" },
  { re: /(^|\.)(gelbooru\.com|safebooru\.org|konachan\.com|yande\.re)$/i, site: "图站" },
  { re: /(^|\.)(sankakucomplex\.com)$/i, site: "Sankaku" }
];
// 通用平台：**不**算作品站。同一条链接可能是原画师本人的帖（那就是出处），
// 也可能是别人的转发/搬运（那就只是线索）—— 这一层判断留给模型，代码不替它下结论。
const PLATFORM_HOSTS = [
  { re: /(^|\.)(twitter\.com|x\.com)$/i, site: "X/Twitter" },
  { re: /(^|\.)(weibo\.com)$/i, site: "微博" },
  { re: /(^|\.)(lofter\.com)$/i, site: "LOFTER" },
  { re: /(^|\.)(bilibili\.com)$/i, site: "bilibili" },
  { re: /(^|\.)(nicovideo\.jp)$/i, site: "niconico" },
  { re: /(^|\.)(youtube\.com|youtu\.be)$/i, site: "YouTube" },
  { re: /(^|\.)(huaban\.com|duitang\.com)$/i, site: "图片收藏站" },
  { re: /(^|\.)(reddit\.com)$/i, site: "Reddit" },
  { re: /(^|\.)(deviantart\.com)$/i, site: "DeviantArt" }
];
// 谷歌自家的域名一律不算"出处"（结果页、图片代理、静态资源、协议文档…）
const SELF_HOST_RE = /(^|\.)(google\.[a-z.]{2,10}|googleusercontent\.com|gstatic\.com|googleapis\.com|ggpht\.com|schema\.org|w3\.org)$/i;

/** 把谷歌的 /url?q= 壳链拆成真地址；不是壳链就原样返回。 */
export function unwrapGoogleUrl(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, "https://www.google.com");
    // ① /url?q= / /url?url= （老式重定向壳）；② /imgres?imgurl= （图片结果的壳）
    const q = u.searchParams.get("q") || u.searchParams.get("url") || u.searchParams.get("imgurl");
    if (q && /(^|\.)google\./i.test(u.hostname)) return decodeURIComponent(q);
    // 非壳链：只认"本来就是 http(s) 绝对地址"的。
    // 🔴 不能直接返回 u.href —— new URL(raw, base) 会把 "not a url at all" 这种垃圾
    //    当成相对路径补成 https://www.google.com/not%20a%20url…，那等于凭空造出一个出处。
    return /^https?:\/\//i.test(raw) ? u.href : "";
  } catch {
    return "";
  }
}

/** 谷歌自家的 /goto?url=<加密串> 壳链：DOM 里**只**有这一种形态，真地址必须真跳一次才看得到。 */
export function isGotoUrl(href) {
  const raw = String(href || "").trim();
  if (!raw) return false;
  try {
    const u = new URL(raw, "https://www.google.com");
    if (!/(^|\.)google\./i.test(u.hostname)) return false;
    return u.pathname === "/goto";
  } catch {
    return false;
  }
}

function safeHost(href) {
  try { return new URL(String(href)).hostname; } catch { return ""; }
}

// ── 分区归属（实测：Lens 结果页用 h1/h2 分段，"Visual matches" 北方是 AI 概览，南方是 Web results）──
//   🔴 只认**实测见过**的那几个标题。认不出来就不标（宁可没有 section，也不要瞎归）。
//   ⚠️ 特别注意「Exact matches」：它是顶部的一排 tab，**不是** h1/h2 分区标题
//      （页面 111 个锚点里它是个 <a>，href 带 lns_surface=26）。所以它永远不会出现在这里；
//      想看那一页得**点进去**（见 lensSearch 里的 exactPass）。
const SECTION_MARKS = [
  { re: /visual\s*match|视觉匹配|相似图片/i, key: "visual", label: "视觉匹配" },
  { re: /exact\s*match|完全匹配/i, key: "exact", label: "完全匹配" },
  { re: /web\s*result|网页结果|搜索结果/i, key: "web", label: "网页结果" },
  { re: /ai\s*overview|ai\s*概览/i, key: "ai", label: "AI 概览" }
];

/**
 * 从页面取回的 h1/h2 里挑出能当"分区边界"的那几个，按 y 升序。
 * @param {Array<{tag?:string,text?:string,y?:number}>} sections EXTRACT 交回的 headings
 * @returns {Array<{key:string,label:string,y:number}>}
 */
export function sectionMarks(sections) {
  const list = Array.isArray(sections) ? sections : [];
  const out = [];
  for (const s of list) {
    const text = String(s?.text || "").replace(/\s+/g, " ").trim();
    const y = Number(s?.y);
    // y <= 0 的是隐藏对话框标题（实测 "Shared"/"Share" 都是 y=0），不是正文分区
    if (!text || !Number.isFinite(y) || y <= 0) continue;
    const hit = SECTION_MARKS.find((m) => m.re.test(text));
    if (!hit) continue;
    if (out.some((o) => o.key === hit.key && o.y === y)) continue;
    out.push({ key: hit.key, label: hit.label, y });
  }
  out.sort((a, b) => a.y - b.y);
  return out;
}

/** 一个链接落在哪个分区：取它上面最近的那个分区边界；在第一个边界之前就返回 null。 */
export function pickSectionFor(y, marks) {
  const yy = Number(y);
  if (!Number.isFinite(yy) || !Array.isArray(marks) || !marks.length) return null;
  let found = null;
  for (const m of marks) { if (m.y <= yy) found = m; else break; }
  return found ? found.key : null;
}

// ── 解壳：把 /goto?url=<加密串> 换成真地址 ──────────────────────────────
//   实测（第五十五对话，probe4/probe5）：
//     · 加密串 base64 解出来是 protobuf 二进制，**静态解不出 URL** ⇒ 只能真跳一次；
//     · `ses.webRequest.onBeforeRedirect` 能拿到 redirectURL（那一跳的 Location）；
//     · `ses.fetch(url, {redirect:"follow"})` 也能拿 resp.url；两条互补；
//     · 12 条并发、每条 3 秒上限 ≈ 3.0 秒全部解开，0 失败 ⇒ 这个代价可以接受。
//   🔴 纪律：
//     ① 任何一条失败都不许影响别的（并发 + 各自 try/catch）；
//     ② 解出来的还是谷歌自家域名的，一律当失败（别把 google.com 当出处）；
//     ③ 会话上没有 webRequest/fetch（离线判据里的假件）⇒ 原样返回，不许抛；
//     ④ 钩子用完必须摘掉，否则这份会话后续的每一次跳转都会往这里灌数据。
/**
 * @param {Array<{url:string,title?:string,y?:number}>} links EXTRACT 交回的锚点
 * @param {{ses?:object|null,budgetMs?:number,maxLinks?:number,onNote?:(m:string)=>void}} opts
 * @returns {Promise<{links:Array<object>,resolved:number,attempted:number,failed:number,note:string}>}
 */
export async function resolveGotoLinks(links, { ses = null, budgetMs = 6000, maxLinks = 28, onNote = null } = {}) {
  const list = Array.isArray(links) ? links : [];
  const note = typeof onNote === "function" ? onNote : () => {};
  const targets = [];
  for (const item of list) {
    if (!isGotoUrl(item?.url)) continue;
    targets.push(item);
    if (targets.length >= Math.max(1, Number(maxLinks) || 28)) break;
  }
  if (!targets.length) return { links: list, resolved: 0, attempted: 0, failed: 0, note: "没有壳链" };
  if (!ses || !ses.webRequest || typeof ses.fetch !== "function") {
    return { links: list, resolved: 0, attempted: 0, failed: 0, note: "这份会话没有 webRequest/fetch，壳链原样保留" };
  }

  const resolved = new Map();   // goto 地址 → 真地址
  const onRedirect = (details) => {
    try {
      const from = String(details?.url || "");
      const to = String(details?.redirectURL || "");
      if (!from || !to) return;
      if (!/^https?:\/\//i.test(to)) return;
      if (SELF_HOST_RE.test(safeHost(to))) return;          // 谷歌自家跳谷歌自家：不算解开
      if (!resolved.has(from)) resolved.set(from, to);
    } catch { /* 回调里绝不抛 */ }
  };
  let hooked = false;
  try { ses.webRequest.onBeforeRedirect(onRedirect); hooked = true; } catch (err) { note("注册重定向钩子失败：" + shortErr(err)); }

  const budget = Math.max(1500, Number(budgetMs) || 6000);
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* 已经停了 */ } }, budget) : null;
  try {
    await Promise.all(targets.map(async (item) => {
      const url = String(item.url);
      try {
        const resp = await ses.fetch(url, { redirect: "follow", credentials: "omit", cache: "no-store", signal: ctrl?.signal });
        const finalUrl = String(resp?.url || "");
        if (finalUrl && !isGotoUrl(finalUrl) && !SELF_HOST_RE.test(safeHost(finalUrl)) && !resolved.has(url)) resolved.set(url, finalUrl);
        try { if (resp?.body && typeof resp.body.cancel === "function") await resp.body.cancel(); } catch { /* 有的实现没有 cancel */ }
      } catch { /* 单条失败不影响其它条 */ }
    }));
  } finally {
    if (timer) clearTimeout(timer);
    if (hooked) { try { ses.webRequest.onBeforeRedirect(null); } catch { /* 摘不掉也不影响结果 */ } }
  }

  let ok = 0;
  const out = [];
  for (const item of list) {
    const url = String(item?.url || "");
    const real = resolved.get(url);
    if (real) { ok++; out.push({ ...item, url: real, fromGoto: true }); continue; }
    // 解不开的壳链**丢掉**：留着它只会被当成"谷歌自家链接"再筛一遍，白占位置
    if (isGotoUrl(url)) continue;
    out.push(item);
  }
  const failed = targets.length - ok;
  const detail = targets.length ? ("壳链 " + targets.length + " 条 ⇒ 解开 " + ok + (failed ? "，失败 " + failed : "")) : "没有壳链";
  return { links: out, resolved: ok, attempted: targets.length, failed, note: detail };
}

/**
 * 从锚点列表里挑"能当出处"的链接。
 * @param {Array<{url:string,title?:string,y?:number}>} links 页面里的原始锚点（已解过壳的）
 * @param {{limit?:number,marks?:Array<object>}} opts limit=最多给几条（默认 8，管理端可改）；marks=分区边界
 * @returns {{direct: Array<object>, others: Array<object>, scanned: number}}
 *          direct = 已知作品站（pixiv/DLsite/E-Hentai/FANZA…，kind="work"）
 *          others = 其它非谷歌站点（kind="thirdparty"：论坛帖/贴吧/推特转发/博客…可能提到出处，但不是权威）
 */
export function pickWorkLinks(links, { limit = 8, marks = [] } = {}) {
  const list = Array.isArray(links) ? links : [];
  const direct = [];
  const social = [];
  const others = [];
  const seen = new Set();
  let scanned = 0;
  for (const item of list) {
    const href = unwrapGoogleUrl(item?.url);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    scanned++;
    let u;
    try { u = new URL(href); } catch { continue; }
    if (SELF_HOST_RE.test(u.hostname)) continue;      // 谷歌自家：不是出处
    const clean = u.origin + u.pathname;               // 去掉 ?utm_… 这类跟踪参数
    const dedupKey = clean.replace(/\/$/, "");
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    const title = String(item?.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
    const section = pickSectionFor(item?.y, marks);
    const hit = WORK_HOSTS.find((h) => h.re.test(u.hostname));
    if (hit) direct.push({ url: clean, site: hit.site, title, kind: "work", section });
    else {
      // 通用平台（X/微博/bilibili/YouTube/Reddit/DeviantArt…）：可能是原帖、也可能是转发
      const plat = PLATFORM_HOSTS.find((h) => h.re.test(u.hostname));
      if (plat) social.push({ url: clean, site: plat.site, title, kind: "social", section });
      // 兜底：论坛求图帖 / 贴吧 / 博客 / 自建站 —— 用户原话「非常鱼龙混杂」
      else others.push({ url: clean, site: u.hostname, title, kind: "thirdparty", section });
    }
  }
  // 已知作品站按 WORK_HOSTS 的优先级排（用户点名的那几类排最前），同级保持页面顺序
  const rank = (site) => { const i = WORK_HOSTS.findIndex((h) => h.site === site); return i < 0 ? 999 : i; };
  direct.sort((a, b) => rank(a.site) - rank(b.site));
  // ⚠️ social 与 others **不排序**：优先级只属于真正的作品站。
  //    通用平台按页面顺序反而更有信息量（Lens 把最像的排在上面）。
  return { direct: direct.slice(0, limit), social: social.slice(0, limit), others: others.slice(0, limit), scanned };
}

const READY_LEN = 600;          // 正文超过这个长度就算渲染好了（实测结果页 1300~6400）
const KEYWORD_MIN_LEN = 200;    // 出现结果关键词时，短一点也认（AI Overview 有时先到）
const RESULT_RE = /visual matches|exact matches|search results|ai overview|相似|搜索结果|视觉匹配/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortErr = (err) => String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 120);
const capText = (t) => (t.length > LENS_TEXT_CAP ? t.slice(0, LENS_TEXT_CAP) : t);

/** 与 'src/cf-fetch.js' 的 electronApi() 同款：非 Electron 环境（CLI/测试）返回 null。 */
async function electronApi() {
  try {
    const e = await import('electron');
    return e?.net && e?.BrowserWindow ? e : null;
  } catch {
    return null;
  }
}

/** 顶层表单 POST 的 multipart 体（字段名 `encoded_image`，与浏览器表单一致）。 */
function multipart(buf, mime) {
  const type = mime || 'application/octet-stream';
  const name = type === 'image/png' ? 'q.png' : type === 'image/jpeg' ? 'q.jpg' : type === 'image/webp' ? 'q.webp' : 'q.bin';
  const B = '----WebKitFormBoundary' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const head = Buffer.from('--' + B + '\r\nContent-Disposition: form-data; name="encoded_image"; filename="' + name + '"\r\nContent-Type: ' + type + '\r\n\r\n');
  const tail = Buffer.from('\r\n--' + B + '--\r\n');
  return { body: Buffer.concat([head, buf, tail]), contentType: 'multipart/form-data; boundary=' + B };
}

/** 🔴 303 的正常副作用：导航被新地址打断，Chromium 报 ERR_ABORTED(-3)。这不叫失败。 */
function isAbortedNavigation(err) {
  const code = String(err?.code || err?.cause?.code || '');
  const errno = Number(err?.errno ?? err?.cause?.errno);
  return code === 'ERR_ABORTED' || errno === -3;
}

/** loadURL + 硬超时（负载那一跳可能永远不返回，绝不能死等）。 */
function loadGuarded(win, url, opts, ms) {
  const p = Promise.resolve().then(() => win.loadURL(url, opts));
  p.catch(() => {});   // 超时后它再 reject 也不该变成 unhandledRejection
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('loadURL 超时 ' + ms + 'ms')), Math.max(200, ms));
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

/** 跑一次导航，把 ERR_ABORTED 吞掉；返回 null 表示"可以继续"，否则返回那次真实错误。 */
async function safeLoad(win, url, opts, ms, logNote) {
  try {
    await loadGuarded(win, url, opts, ms);
    return null;
  } catch (err) {
    if (isAbortedNavigation(err)) {
      logNote('忽略 ERR_ABORTED(-3)（顶层表单 POST 的 303 会这样，页面其实已经跳走了）');
      return null;
    }
    logNote('loadURL 未正常返回：' + shortErr(err));
    return err;
  }
}

/** 结果页地址：先看窗口当前地址，再回头翻 did-finish-load 见过的那些。 */
function resolveResultUrl(win, seenUrls) {
  let url = '';
  try { url = String(win.webContents.getURL() || ''); } catch { url = ''; }
  const looksResult = (u) => /vsrid=|\/search\?/i.test(u) && !u.includes('/v3/upload');
  if (looksResult(url)) return url;
  for (let i = seenUrls.length - 1; i >= 0; i--) if (looksResult(seenUrls[i])) return seenUrls[i];
  return url;
}

/**
 * 轮询结果页，直到"正文够长"或"出现结果关键词"；到点还没好就返回 null。
 * @returns {Promise<{text: string, links: Array<{url:string,title:string}>} | null>}
 *
 * ⚠️ 两种返回形状都要认（EXTRACT 现在回 {text,links}，但注入的假 browserApi —— 判据里那些 ——
 *    回的是**纯字符串**）。把这里写成只认对象，会让既有的六段判据全红，而线上其实没事：
 *    这正是"测试夹具的形状漏进了被测代码"那一类错。
 */
async function pollPage(win, left, logNote) {
  let last = { text: "", links: [], sections: [] };
  let first = true;
  // 锚点宽限的截止时刻（**必须是局部变量**：写到函数属性上就成了模块级共享状态，
  // 两次并发搜图会互相把对方的宽限清掉 —— 那类 bug 只在"同时搜两张图"时才出现）。
  let linksGraceUntil = 0;
  while (left() > 0) {
    await sleep(Math.min(600, Math.max(50, left())));
    try {
      const raw = await win.webContents.executeJavaScript(EXTRACT);
      if (raw && typeof raw === "object") {
        last = {
          text: String(raw.text || ""),
          links: Array.isArray(raw.links) ? raw.links : [],
          sections: Array.isArray(raw.sections) ? raw.sections : []
        };
      } else {
        last = { text: String(raw || ""), links: [], sections: [] };
      }
    } catch (err) {
      logNote("取正文失败：" + shortErr(err));
    }
    if (first) { logNote("结果页首帧长度 " + last.text.length + (last.links.length ? "、锚点 " + last.links.length + " 个" : "") + (last.sections.length ? "、标题 " + last.sections.length + " 个" : "")); first = false; }
    // 正文够长就收；但**锚点可能比正文晚到**（Lens 是动态渲染的）⇒ 正文够了也再给锚点一小段时间。
    if (last.text.length > READY_LEN) {
      // 剩余时间不够宽限就别等了（否则"为了多等链接"会把整次搜图拖到超时，反而全丢）
      if (last.links.length || left() < 1400) return last;
      // 还没锚点：再等最多 1.2 秒（Lens 的锚点常比正文晚到），拿不到就诚实按"没有链接"返回
      if (!linksGraceUntil) linksGraceUntil = Date.now() + 1200;
      else if (Date.now() >= linksGraceUntil) return last;
      continue;
    }
    if (last.text.length > KEYWORD_MIN_LEN && RESULT_RE.test(last.text)) return last;
  }
  return null;
}

function timeoutError(url, budget) {
  const tail = url ? `（最后停在 ${String(url).slice(0, 80)}）` : '';
  return `谷歌搜图没拿到结果：等了 ${budget} 毫秒，结果页还是没出现可读内容${tail}。这多半是出口网络被挡或太慢，不是搜图功能坏了；可以稍后重试或换一条线路。`;
}

/** 失败的统一出口：网络类错误复用 fetch-error 的人话（含"有没有走代理"）。 */
function describeLensFailure(err, notes, usedProxy) {
  const base = describeFetchError(err, { host: 'lens.google.com', usedProxy });
  const last = notes.length ? notes[notes.length - 1] : '';
  return last ? `${base} 窗口内最近一条线索：${last}` : base;
}

/**
 * 走谷歌 Lens 搜一张图。
 * @param {Buffer|Uint8Array} buffer 图片字节
 * @param {string} mime 例 'image/webp'
 * @param {{timeoutMs?: number, proxyEndpoint?: string|null, browserApi?: object|null}} opts
 *        browserApi 不给就自己 await import('electron')（测试注入假件）
 * @returns {Promise<{ok: true, text: string, url: string, directLinks: Array<{url:string,site:string,title:string}>, otherLinks: Array<object>, linksScanned: number} | {ok: false, error: string}>}
 */
export async function lensSearch(buffer, mime, { timeoutMs = DEFAULT_TIMEOUT_MS, proxyEndpoint = null, browserApi = null, linkLimit = 8 } = {}) {
  const api = browserApi || await electronApi();
  if (!api) return { ok: false, error: '当前环境没有 Electron，谷歌搜图不可用' };
  if (!buffer || !buffer.length) return { ok: false, error: '谷歌搜图：没有拿到图片字节，发不出去' };

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
  // 最多交回几条线索（管理端可改 imageSearch.lensLinkLimit）：夹在 1~20，防手滑填 0 或 999
  const linkLimitClamped = Math.max(1, Math.min(20, Math.round(Number(linkLimit)) || 8));
  const deadline = Date.now() + budget;
  const left = () => deadline - Date.now();
  const notes = [];
  const logNote = (m) => { notes.push(String(m)); if (notes.length > 30) notes.shift(); };

  const partition = 'lens-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const seenUrls = [];
  let win = null;
  let loadErr = null;
  try {
    const ses = api.session.fromPartition(partition);
    // 没传代理就**不动**这份会话的代理配置（别把别人的设置改成"直连"）
    if (proxyEndpoint) await ses.setProxy({ proxyRules: String(proxyEndpoint), proxyBypassRules: '<local>' });

    win = new api.BrowserWindow({
      show: false, width: 1200, height: 900,
      webPreferences: { session: ses, partition, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    });
    win.on('closed', () => logNote('窗口已关闭'));
    win.webContents.on('render-process-gone', (e, d) => logNote('render-process-gone ' + JSON.stringify(d)));
    win.webContents.on('did-fail-load', (e, code, desc) => logNote('did-fail-load ' + code + ' ' + desc));
    win.webContents.on('did-finish-load', () => {
      const u = String(win.webContents.getURL() || '');
      seenUrls.push(u);
      logNote('did-finish-load ' + u.slice(0, 90));
    });
    win.webContents.setUserAgent(UA);

    // ① 预热：把 cookie/会话先落下（少了这步，上传那一跳容易被判成机器人）
    loadErr = await safeLoad(win, WARM_URL, undefined, Math.min(left(), 12000), logNote) || loadErr;

    // ② 顶层表单 POST 图片 ⇒ 303 ⇒ 结果页（ERR_ABORTED 是这一跳的正常副作用）
    const mp = multipart(buffer, mime);
    const uploadOpts = { postData: [{ type: 'rawData', bytes: mp.body }], extraHeaders: 'Content-Type: ' + mp.contentType + '\r\n' };
    loadErr = await safeLoad(win, UPLOAD_URL, uploadOpts, Math.min(left(), 20000), logNote) || loadErr;

    // ③ 轮询结果页正文 + 锚点
    const pageUrl = resolveResultUrl(win, seenUrls);
    const page = await pollPage(win, left, logNote);
    if (!page) {
      // 有过真实加载错误 ⇒ 报网络人话；否则就是纯粹"等不到内容"
      return { ok: false, error: loadErr ? describeLensFailure(loadErr, notes, !!proxyEndpoint) : timeoutError(pageUrl, budget) };
    }
    // ④ 🔴 先把 goto 壳链解成真地址（不解的话锚点里**一个真实网址都没有**，实测）
    //   代价实测：12 条并发 ≈ 3.0 秒；解不开的丢掉，绝不留谷歌自己的壳链。
    const unRes = await resolveGotoLinks(page.links, {
      ses,
      budgetMs: Math.max(1500, Math.min(6000, left() - 1200)),
      maxLinks: 40,
      onNote: logNote
    });
    if (unRes.attempted) logNote('解壳：' + unRes.note);

    // ⑤ 分区边界（h1/h2 实测有 Visual matches / Web results；Exact matches 不在其中，是顶部 tab）
    const marks = sectionMarks(page.sections);
    if (marks.length) logNote('分区：' + marks.map((m) => m.label + '@' + m.y).join(' / '));

    // ⑥ 从锚点里挑"能当出处"的链接（提案 a0009a16 + 用户第五十五对话追加：第三方页也要列）
    //   🔴 挑不到就给空数组，**不要**退回 resultPageUrl —— 那是本次搜索的地址，
    //      不是这幅画的出处（把这句写进注释，是因为"顺手兜一下"太自然了）。
    const picked = pickWorkLinks(unRes.links, { limit: linkLimitClamped, marks });
    logNote('锚点 ' + page.links.length + ' 个 ⇒ 作品站 ' + picked.direct.length +
      ' 条、通用平台 ' + picked.social.length + ' 条、其它第三方页 ' + picked.others.length + ' 条');
    return {
      ok: true,
      text: capText(page.text),
      url: pageUrl,
      directLinks: picked.direct,
      // 通用平台（X/微博/bilibili/YouTube/Reddit/DeviantArt…）：可能是原帖、也可能是转发，
      // 代码不替模型下结论 —— 单列一类交上去（用户原话「非常鱼龙混杂」）。
      socialLinks: picked.social,
      otherLinks: picked.others,
      linkSections: marks,
      linksScanned: picked.scanned,
      linksResolved: unRes.resolved,
      linksResolveAttempted: unRes.attempted,
      // 解壳后仍没有一条外部链接 ⇒ 上层要如实说"只有正文"，不许拿结果页充数
      linksEmpty: picked.direct.length === 0 && picked.social.length === 0 && picked.others.length === 0
    };
  } catch (err) {
    return { ok: false, error: describeLensFailure(err, notes, !!proxyEndpoint) };
  } finally {
    try { win?.destroy(); } catch { /* 窗口已经没了 */ }
  }
}
