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
const EXTRACT = 'document.body ? document.body.innerText : ""';
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

/** 轮询正文，直到"够长"或"出现结果关键词"；到点还没好就返回 null。 */
async function pollText(win, left, logNote) {
  let last = '';
  let first = true;
  while (left() > 0) {
    await sleep(Math.min(600, Math.max(50, left())));
    try {
      last = String((await win.webContents.executeJavaScript(EXTRACT)) || '');
    } catch (err) {
      logNote('取正文失败：' + shortErr(err));
    }
    if (first) { logNote('结果页首帧长度 ' + last.length); first = false; }
    if (last.length > READY_LEN) return last;
    if (last.length > KEYWORD_MIN_LEN && RESULT_RE.test(last)) return last;
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
 * @returns {Promise<{ok: true, text: string, url: string} | {ok: false, error: string}>}
 */
export async function lensSearch(buffer, mime, { timeoutMs = DEFAULT_TIMEOUT_MS, proxyEndpoint = null, browserApi = null } = {}) {
  const api = browserApi || await electronApi();
  if (!api) return { ok: false, error: '当前环境没有 Electron，谷歌搜图不可用' };
  if (!buffer || !buffer.length) return { ok: false, error: '谷歌搜图：没有拿到图片字节，发不出去' };

  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;
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

    // ③ 轮询结果页正文
    const pageUrl = resolveResultUrl(win, seenUrls);
    const text = await pollText(win, left, logNote);
    if (!text) {
      // 有过真实加载错误 ⇒ 报网络人话；否则就是纯粹"等不到内容"
      return { ok: false, error: loadErr ? describeLensFailure(loadErr, notes, !!proxyEndpoint) : timeoutError(pageUrl, budget) };
    }
    return { ok: true, text: capText(text), url: pageUrl };
  } catch (err) {
    return { ok: false, error: describeLensFailure(err, notes, !!proxyEndpoint) };
  } finally {
    try { win?.destroy(); } catch { /* 窗口已经没了 */ }
  }
}
