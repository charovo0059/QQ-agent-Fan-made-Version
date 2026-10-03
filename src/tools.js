// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { normalizeMessageList, unquoteJsonString, todayKey } from './util.js';
// 用量 / 花费自检（2026-09-26 第二十四对话，提案 f789b40e）：
// **复用 `/api/status` 用的那几个函数**，不自己抄一份统计口径 —— 本项目对"两套口径"栽过跟头
// （控制台一个数、她嘴里另一个数，事后没法对账）。`resolveApiKey` 只用于发余额请求。
import { estimateCost, cacheHitRate, resolveApiKey } from './llm.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { webSearch, webFetch, searchImages } from './web-search.js';
import { searchImageSource, SELECTABLE_ENGINES } from './image-search.js';
import { expandForwardNodes, fetchForward, resolveFreshImageUrl } from './onebot.js';
import { firstFrameOnly, countFrames } from './gif.js';
// 图片类型嗅探统一走 image-type.js（**吸收自上游 0.4，2026-09-20 第九对话**）。
// 原来本文件内联了一份 detectMime（魔数判断），与别处那份各自演化 ——
// 上游正是因为这个才把它抽成单独模块（他的注释里写着"三份实现各自演化，
// 加一种格式就要改三处"）。这里换成引用，逻辑与他那份**逐字一致**（含 `length < 12` 的守卫），
// 所以行为不变，只是以后加格式只改一处。
import { detectMime } from './image-type.js';
// 大图压缩（**吸收自上游 0.4**）。⚠️ 2026-09-20 第九对话补接线：
// 这个模块早就吸收了，但**一直没有任何地方 import 它** —— 等于死代码，
// 吸收时只搬了实现、没接上会用它的地方。上游是在它的
// `downloadImageAsDataUrl()` 里调的，而我们的看图链路没有那个函数
// （我们是 `prepareImage()`），所以它的接线没法照抄，得落到我们这一支上。
import { compressImage } from './image-compress.js';
// 工具注册表（Skills 基础设施，来自上游 0.3.1）：原生工具与技能工具都在这里登记，
// 技能工具（带 skillId）的可用性统一问 getToolAvailability()。
import { registerTool, listTools, getToolAvailability } from './tool-registry.js';
import { appendProposal, listProposals, PROPOSAL_KINDS } from './proposals.js';

/**
 * 提案状态 → 给她看的中文（🆕 2026-09-21 第十对话，配合 get_my_proposals）。
 * ⚠️ 与 `ui/app.js` 的 STATUS_LABEL 不共用：那一份是**讨论状态**（等待中/已发言），
 *    与提案状态是两回事，别混。
 */
const PROPOSAL_STATUS_LABEL = {
  pending: '待审（管理员还没看过）',
  accepted: '已采纳（列进待办了，改动由人来做）',
  rejected: '不采纳',
  done: '已实现'
};
import { splitDreamText } from './dream.js';
// 「核心记忆」（提案 c7486672）：她自己的相册，独立于会话存档。
import { saveCoreMemory, listCoreMemories, getCoreMemory, removeCoreMemory, coreMemoryLoadError } from './core-memory.js';
import { formatShortTime } from './util.js';

// 一次最多能存多少条（她挑的那一段的上限）。与 core-memory.js 的 MAX_MESSAGES 有意分开：
// 那边是"文件里最多留多少"，这边是"一次调用最多取多少" —— 前者防止文件膨胀，
// 后者是**给她的一句人话提示**（超了直接说"太长了，分开存"），不是静默截断。
const CORE_MEMORY_MAX_SPAN = 300;

/**
 * 读 `data/dreams.json` 并做筛选/裁剪 —— 供 `dream_recall` 工具用（2026-09-19 加）。
 *
 * ⚠️ 2026-09-19 改：原来这里**自己复刻了一份** digest/裁剪逻辑，后来发现那是错的做法
 *    （真代码一改，复刻件就安静地失真）。现在改成：
 *      · 输出格式的解析用 dream.js 导出的 `splitDreamText`（**唯一实现**）；
 *      · 「按会话分章 + 总感想」的取用规则也集中在那里，避免两份逻辑漂移。
 *    这里只做"读文件 + 按 day/keyword/chatKey 筛 + 裁剪"。为什么读文件而不拿 `ctx.dreamer`：
 *    工具上下文里没有 dreamer（见 orchestrator 的 toolCtx 字段清单），为一个只读工具改传参不划算；
 *    dreams.json 很小，每次读的代价可忽略。
 * ⚠️ 读不到文件时返回**空结构**而不是抛错：对模型来说"还没写过梦"是正常答案，
 *    不该变成工具错误（那会让它以为工具坏了、反复重试）。
 */
function readDreamsBrief({ day = '', keyword = '', limit = 5, text = false, chatKey = '' } = {}) {
  let all = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'dreams.json'), 'utf8'));
    if (j && Array.isArray(j.notes)) all = j.notes;
  } catch { /* 还没做过梦 */ }
  let items = all;
  if (day) items = items.filter((n) => String(n.day) === String(day));
  if (keyword) items = items.filter((n) => String(n.text || '').includes(keyword));
  const lim = Math.max(1, Math.min(30, Number(limit) || 5));
  return {
    total: all.length,
    matched: items.length,
    oldest: all.length ? all[all.length - 1].day : '',
    newest: all.length ? all[0].day : '',
    // 传了 chatKey ⇒ **只给当前会话那一章 + 总感想**。
    // 这就是"事实按会话过滤、感受全局可见"的落点：别的会话的章节**不返回**。
    ...(chatKey ? { chatKey, why: '只列了当前会话那一章（chatsForYou）；global 是总感想，它本来就全局。别的会话的章节没有给你。' } : {}),
    notes: items.slice(0, lim).map((n) => {
      const seg = (Array.isArray(n.segments) || n.global !== undefined)
        ? { segments: n.segments || [], global: String(n.global || '') }
        : splitDreamText(n.text);
      const mineSeg = chatKey ? seg.segments.filter((s) => s.key === String(chatKey)) : seg.segments;
      const cut = (s) => (text ? s : String(s).slice(0, 600));
      return {
        day: n.day,
        at: n.at,
        chatLabels: n.chatLabels || [],
        messages: n.messages ?? null,
        mine: n.mine ?? null,
        chars: String(n.text || '').length,
        ...(chatKey
          ? { chatsForYou: mineSeg.map((s) => cut(s.text)), global: cut(seg.global) }
          : { segments: mineSeg.map((s) => ({ label: s.label, text: cut(s.text) })), global: cut(seg.global) })
      };
    })
  };
}

// ── 图片注入的体积闸门 ──────────────────────────────────────────────────
//
// 背景（2026-09-12 实测，代价是一轮会话直接报废）：
// 用户转发的 50 条表情包里有 30 张图，全是**动画 GIF**，合计 **79.3MB**；
// `get_message_images` 把 30 张原图全塞进一次请求，base64 之后 106MB，
// 网关（api.deepseek.com 的 openresty）直接
//   HTTP 413 Request Entity Too Large
// 而且原实现是「来多少发多少 + 发原图」，两道闸都没有：
//   - 没有张数上限：消息里有 30 张就发 30 张
//   - 没有单张体积上限：safeFetchBinary 默认收 12MB，base64 之后 16MB，**一张就能撞墙**
// 实测网关上限：32MB 能过（返回模型名错误），48MB 就 413。所以下面三道闸都留足了余量。
//
// ⚠️ 这四个数字原本是写死的常量，现在放到 config.imageLimits，**设置页可调**。
//    默认值和原来一模一样（6 张 / 700KB / 3MB / 12MB），所以不配也不变行为。
//    改大之前请想清楚：真正的约束不是网关（墙在 32MB），而是**图片 token 的成本**。
const IMAGE_LIMIT_DEFAULTS = { maxPerView: 6, maxKB: 700, maxRunMB: 3, maxDownloadMB: 12 };

/**
 * 取当前生效的看图上限（每次都从配置读，所以改完不用重启就能生效 ——
 * 除了 maxPerView，它进了工具描述，改它要等下一次运行重建提示词前缀）。
 * 非法值（0 / 负数 / 非数字）一律回落到默认值，避免手滑填错把功能锁死。
 */
function imageLimits() {
  const c = (getConfig().imageLimits) || {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    perView: Math.max(1, Math.round(num(c.maxPerView, IMAGE_LIMIT_DEFAULTS.maxPerView))),
    bytes: num(c.maxKB, IMAGE_LIMIT_DEFAULTS.maxKB) * 1024,
    runBytes: num(c.maxRunMB, IMAGE_LIMIT_DEFAULTS.maxRunMB) * 1024 * 1024,
    downloadBytes: num(c.maxDownloadMB, IMAGE_LIMIT_DEFAULTS.maxDownloadMB) * 1024 * 1024
  };
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${v}B`;
}

/**
 * 下载一张图并转成能进模型的 data URL，同时把它压到安全体积。
 *
 * 压缩手段有两条：
 *   ① **动画 GIF 只留第一帧**（纯字节截断，见 gif.js）—— 不动内容，最省；
 *   ② **其余格式交给 ffmpeg 缩放重编码**（image-compress.js，2026-09-20 接的线）。
 *      ② 是后加的补救：原来 ① 之后还是超限就**直接拒绝**，
 *      用户发一张 1.5MB 的截图就得到"图太大"，而她其实只是想让你看一眼。
 *
 * ⚠️ ② 会把图**转成 JPEG**（动图/透明通道会丢），所以**只在"不压就只能拒收"时才用**：
 *    体积没超限的图**原样发**，绝不因为"能压就顺手压一下"而降质。
 *    这个取舍是刻意的：宁可压，也不要"看不到"。
 *
 * @param {{call:Function}} onebot OneBot 客户端
 * @param {string} url 存下来的图片链接
 * @param {string} [file] QQ 文件名（media.file / sticker.file），可不传
 * @returns {{dataUrl:string, note:string}} note 非空时说明这张图被动过手脚，要转告模型
 */
async function prepareImage(onebot, url, file = '') {
  const lim = imageLimits();
  const fresh = await resolveFreshImageUrl(onebot, { url, file });
  const safeUrl = await validateImageUrl(fresh.url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl, lim.downloadBytes);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];

  let data = buffer;
  let note = '';
  let outMime = mime;
  if (data.length > lim.bytes && mime === 'image/gif') {
    const one = firstFrameOnly(data);
    if (one && one.length < data.length) {
      const frames = countFrames(data);
      note = `动画表情，只取了第一帧（原 ${fmtBytes(data.length)}${frames > 1 ? ` / ${frames} 帧` : ''}）`;
      data = one;
    }
  }
  if (data.length > lim.bytes && mime !== 'image/gif') {
    // ② 交给 ffmpeg 缩放重编码。没装 ffmpeg 时它原样返回（compressed=false），
    //    行为与接线前完全一致 —— 所以"没装"不会变成新的失败点。
    //
    // ⚠️ 为什么要**逐级降质重试**，而不是"调一次 compressImage 就完事"：
    //    `compressImage` 的 `maxBytes` 只用来**决定压不压**，它按 `maxDim` 缩放尺寸、
    //    画质用传入的 `quality`（上游默认 4 = 画质优先），**压完是多少就是多少**，
    //    不会回头逼近字节预算。
    //    实测（1100x900 噪声 PNG，2181KB）：quality 4 → 916KB、8 → 544KB、12 → 366KB。
    //    也就是说**用上游默认的 4 压完仍然超 700KB 上限 ⇒ 照样被拒 ⇒ 这次接线等于白接**。
    //    （这正是"吸收模块"与"接线"必须分开做、且接线必须真跑一遍的原因：
    //     光看函数签名会以为传了 maxBytes 就有人保证不超。）
    let best = null;
    for (const quality of [4, 8, 12, 20, 28]) {
      const out = await compressImage(data, { maxBytes: lim.bytes, maxDim: 1568, quality });
      if (!out?.compressed || !out.buffer?.length) break;    // 压不动（没 ffmpeg / 解不开）→ 别空转
      if (!best || out.buffer.length < best.buffer.length) best = out;
      if (out.buffer.length <= lim.bytes) break;             // 已经进预算了，用这一档
    }
    if (best && best.buffer.length < data.length) {
      const before = data.length;
      data = best.buffer;
      outMime = best.mime || 'image/jpeg';
      // ⚠️ note 要如实说"缩过+重编码过"，不能只说"压小了" ——
      //    模型据此判断"这张图我看得够不够清"，说轻了它会以为细节都在。
      note = `原图 ${fmtBytes(before)} 超过上限，已压缩到 ${fmtBytes(data.length)} 再发（尺寸与画质都降过，细节可能看不清）`;
    }
  }
  // 压完还是太大才拒。注意这里**不能**因为"压过了"就放行：
  // 万一压缩比不够，发出去会把整轮请求顶成 413，比"看不到这张图"糟得多。
  if (data.length > lim.bytes) {
    throw new Error(`图太大（${fmtBytes(data.length)}，上限 ${fmtBytes(lim.bytes)}）`);
  }
  return { dataUrl: `data:${outMime};base64,${data.toString('base64')}`, note };
}

// ── 表情图本地缓存（2026-09-17） ─────────────────────────────────────────
//
// 背景：表情库（data/stickers.json）只存 QQ 的远程链接，而链接里的 `rkey` 只有十几小时寿命。
// 控制台表情页是**直接把存档里的旧链塞进 `<img src>`**（ui/app.js 的 stickerCardHtml），
// 所以链一过期缩略图就是纯黑 —— 实测 36 条链接**全部**返回
//   {"retcode":-5503007,"retmsg":"download url has expired"}
// 只是浏览器 HTTP 缓存里还有的那几张照常显示，把问题掩盖了（清一次缓存会全黑）。
//
// 换链能力早就有（resolveFreshImageUrl：发送表情与模型看图两条路在用），但控制台没接。
// 这里补上第三步：**换到新链后把字节存到本地**，以后永远读本地 ——
// 既不依赖 rkey，也不必每次开页面都去戳 OneBot（那会慢且脆）。
//
// 缓存键用 `entry.id` 而不是 QQ 文件名：**面板收藏（source=qq）那批没有 file 字段**。
// ⚠️ 2026-09-24（第十三对话）实测更正：`file` 是**按来源结构性**存在的，不是"被谁抹了"：
//    来源 ai（从消息里收的，`sticker-manager.collect()` 从图片段取 `file`）⇒ **24/24 都有**；
//    来源 qq（`fetch_custom_face_detail` 拿的面板列表）⇒ **14/14 都没有**（那个接口就不给文件名）。
//    历史上写过的"5 条没有（31/36 才有）"是当时的构成（qq 5/ai 31），现在构成变了（qq 14/ai 24），
//    **规则本身一个字都没变**。详见 待办与决策记录 §54.1。
const STICKER_CACHE_DIR = path.join(DATA_DIR, 'stickers');

function stickerCacheFile(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(STICKER_CACHE_DIR, `${safe}.bin`);
}

/** 读本地缓存（只读，不下载）。命中返回 {bytes, mime}，没命中返回 null。 */
export function readCachedStickerImage(entry) {
  try {
    const bytes = fs.readFileSync(stickerCacheFile(entry?.id));
    if (!bytes.length) return null;
    return { bytes, mime: detectMime(bytes) || 'application/octet-stream' };
  } catch {
    return null;
  }
}

/**
 * 本地缓存的**文件路径**（只在确实存在时返回，否则空串）。
 *
 * 🆕 2026-09-23（第十二对话）：给**发送侧**用（`sender.js` 的 sendSticker）。
 * 为什么需要：`data/stickers.json` 里的 `url` 只是 QQ 的远程链接，其 `rkey` **只有十几小时寿命**；
 *   而**有些**条目没有 `file`（面板收藏那批）⇒ 换不了新链 ⇒ 发送时只能把过期 URL 交给 OneBot
 *   去下载 ⇒ `retcode=100 HTTP download failed: 404`（当天实测 **7 次**，用户看到的症状是
 *   "表情发不出去、改用文字描述"）。本地缓存过去只服务"控制台缩略图"与"模型看图"两条路，
 *   **发送侧完全没用**。
 * ⇒ 发送侧改成"本地有就发本地"，绕开 rkey 这条最容易坏的链路。
 *
 * ⛔🔴 2026-09-24（第十三对话）**更正这段注释原来的一句话**：它写着
 *   「实测本机 **38 张表情的 `file` 字段全是空串**」—— **那是错的，真值 24/38**
 *   （上一棒自己也在 待办与决策记录 §51.6 里作废过这个数字：PowerShell 读 JSON 读歪了把整份对象
 *    当成一个条目，于是"file 非空有几张"被读成 0；报告里作废了，**源码注释里没跟着改**，
 *    就成了留在代码里的假仪表）。
 *   核实过的事实（§54.1）：**24 条 ai 来源全有 `file`，14 条 qq 来源全没有**；
 *   而那 14 条**本来也不需要换链** —— 它们的 url 是 `p.qpic.cn/qq_expression/...` 静态 CDN 路径
 *   （实测 14/14 仍返回 206，没有 rkey），并且 **14/14 都已有本地 .bin 缓存**。
 *   真正依赖"换链"的是 ai 那 24 条里没有本地缓存的 22 条。
 *
 * ⚠️ 与 `readCachedStickerImage` 的分工别合并：那个返回**字节**（给 HTTP 响应 / 模型看图），
 *    这个只返回**路径**（给 OneBot 自己读）。合并会让发送侧白读一遍 2~8MB 的 GIF。
 */
export function cachedStickerFilePath(entry) {
  try {
    const p = stickerCacheFile(entry?.id);
    return fs.existsSync(p) ? p : '';
  } catch {
    return '';
  }
}

/**
 * 拿到表情图的字节：本地有就读本地；没有才换新链、下载、**顺手存本地**。
 * 失败会抛错（调用方负责给界面一个 404 + 占位提示，而不是一块神秘的黑）。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.thumb] 只要缩略图：动画 GIF 只发第一帧（纯字节截断，不重新编码）。
 *   为什么需要它：本机 36 张表情缓存下来 **80.24 MB**（单个 2~8 MB 的动画 GIF），
 *   网格页把这 80MB 全塞进浏览器太重；缩略图只发第一帧，页面体积降到几 MB 量级。
 *   ⚠️ **不额外占磁盘** —— 缓存里存的始终是原图，截帧只在出站时做。
 */
export async function ensureStickerImage(onebot, entry, { thumb = false } = {}) {
  const img = await loadStickerImage(onebot, entry);
  if (!thumb) return img;
  try {
    if (img.mime === 'image/gif') {
      const one = firstFrameOnly(img.bytes);
      if (one && one.length && one.length < img.bytes.length) return { bytes: one, mime: 'image/gif' };
    }
  } catch { /* 截帧失败就发原图，不影响可用性 */ }
  return img;
}

async function loadStickerImage(onebot, entry) {
  const hit = readCachedStickerImage(entry);
  if (hit) return hit;
  const fresh = await resolveFreshImageUrl(onebot, { url: entry?.url, file: entry?.file });
  if (!fresh.url) throw new Error('没有可用的图片链接');
  const safeUrl = await validateImageUrl(fresh.url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl, imageLimits().downloadBytes);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || '').split(';')[0] || 'image/jpeg';
  try {
    fs.mkdirSync(STICKER_CACHE_DIR, { recursive: true });
    const target = stickerCacheFile(entry.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, target);
  } catch { /* 存不下来不影响这次返回 */ }
  return { bytes: buffer, mime };
}

/** 本地缓存用掉多少空间 / 有几张（关于页与诊断包用得上）。 */
export function stickerCacheStats() {
  try {
    const files = fs.readdirSync(STICKER_CACHE_DIR).filter((f) => f.endsWith('.bin'));
    let bytes = 0;
    for (const f of files) {
      try { bytes += fs.statSync(path.join(STICKER_CACHE_DIR, f)).size; } catch { /* 跳过 */ }
    }
    return { count: files.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

/** 本轮还剩多少图片额度（挂在 ctx 上 = 只属于本次运行，不会写进会话记录）。 */
function imageBudgetLeft(ctx) {
  return imageLimits().runBytes - (Number(ctx.__imageBytes) || 0);
}

// ⚠️ `detectMime` 原来在这里内联实现（魔数嗅探），已改为从 `./image-type.js` 引入 ——
//    那份实现与本处**逐字等价**（连 `buf.length < 12` 的守卫都一样），所以行为不变。
//    别再把它抄回来：抄回来就又变成"三份实现各自演化"。
function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/**
 * 当前会话**真实可见**的那些 `#数字`（＝ `m.mid`）。
 *
 * 🔴 为什么单独抽出来（2026-10-03 第三十三对话）：`store` 的每条消息**同时**有一个
 *    本地递增序号 `m.id`（UI 定位用）和一个 `m.mid`（QQ 消息 id），两者长得一样、含义不同。
 *    而提示词里给她看的前缀是 `#${m.mid}`（`prompt.js` 的 `formatEntry`）。
 *    ⇒ 凡是"要她填 #数字"的地方，**报错时也必须报 mid**：报本地序号等于给了一个
 *      她照着填也填不对的数（核心记忆就是这么错了 5 天的 —— 它连"现在能用的范围"都报成 `#1~#362`）。
 */
function visibleMids(ctx, limit = 8) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  return [...new Set(mids.map(String))].slice(-limit);
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const uniq = visibleMids(ctx);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

// ── 搜图工具的"只在有人问出处时才搜"判定 ────────────────────────────────
//
// 背景：search_image_source 是给"群里发图求出处"用的，但模型看到图就想搜。
// 实测 394 个会话里它被调用 135 次，其中 100 次（74%）本次唤醒的消息里
// **根本没人问出处**（别人只是发图/斗图/玩梗，甚至只是在骂它）。
// 光靠工具描述劝不住，所以在代码层也拦一道。
//
// 判定词刻意宽松：漏判的代价是"该查时不敢查"（用户会明显感到失灵），
// 误判的代价只是多搜一次。但绝不能宽到"看到图就算"。
// 第一版漏了"出自哪里""搜下这个"这类常见说法（回放真实历史时发现的），已补上。
const IMAGE_ASK_RE = /出处|出自|哪来|哪儿来|什么番|哪部|哪一?部|番名|第几集|哪一集|哪集|画师|谁画的|谁画|pid|p站|pixiv|这是谁|这位是谁|这个是谁|这谁|图里|图中|谁啊|谁呀|哪个本|本子|漫画|原图|出典|来源|搜图|搜一下|搜一搜|搜搜|搜下|查一下|查查|查下|找一下|找找|找下|找这个|找到它|帮我找|替我找|认一下|认认|认得|认得出|认识这|知道这|眼熟|什么角色|什么人物|哪个角色|什么作品|哪的/i;

// 机器人自己刚问过"要我查吗"时的措辞。配合下面的历史兜底用。
const IMAGE_CONSENT_Q_RE = /要我.{0,6}(查|搜|找|认)|需要我.{0,6}(查|搜|找|认)|要不要我.{0,8}(查|搜|找|认)|帮你.{0,6}(查|搜|找|认)|帮你认/;

// ── 🆕 2026-09-25（第十八对话）：**闸门要看上下文，不能只看本次唤醒那一句** ──────
//
// 🔴 真实反馈（用户当天原话："根据上下文推测我的要求也应该是合理的"）：
//   他先说了「来张小猫图片 / 给你装上搜图功能了，你搜张…发我试试」，
//   下一条只说「再试试，试完就睡」 —— 闸门只读 `triggerText`（本次唤醒那句），
//   "再试试"里没有任何要图措辞 ⇒ **被拦下**，而上下文里明明就是要图。
//
// 为什么原来只看一句：怕"看到图就算"式的过宽。但**过窄的代价同样是失灵**，
// 而且更难解释（用户会觉得"我明明说了它就是不做"）。
// ⇒ 加一档"**最近几条别人发的消息**里有要图措辞，且还在有效期内"。
//   边界：只看**最近若干条别人说的**（不是整份历史），且有**时限**（默认 15 分钟）。
const ASK_LOOKBACK_MESSAGES = 6;      // 只看最近 6 条"别人说的"
const ASK_LOOKBACK_TTL_MS = 15 * 60 * 1000;

/** 历史里"别人最近明确提过这件事"吗（供两个闸共用）。 */
function askedInRecentContext(ctx, re) {
  try {
    const recent = ctx.store.recent(ctx.chatKey, { limit: 24 });
    const now = Date.now();
    const fresh = (m) => {
      const ts = Number(m?.ts);
      return !Number.isFinite(ts) || (now - ts) < ASK_LOOKBACK_TTL_MS;
    };
    const others = recent.filter((m) => !m.self).slice(-ASK_LOOKBACK_MESSAGES);
    return others.some((m) => fresh(m) && re.test(String(m.text || '')));
  } catch { /* 读不到历史就不放行，宁可保守 */ }
  return false;
}

/**
 * 本次唤醒是否"有人明确要求查图出处"。
 *
 * 三级判定：
 *   1. 本次唤醒的消息里有求出处的措辞 → 放行。
 *   2. 🆕 上下文兜底：**最近几条别人发的消息**里有求出处的措辞（限时 15 分钟）→ 放行。
 *      治的是"上一句说了'求出处'、这一句只说'再试试'"被拦死这种失灵。
 *   3. 历史兜底：机器人**最近一条发言**就是在问"要我帮你查吗"，且之后有群友回过话
 *      → 视为对方同意了。这一条是为了让"先问一句再查"的路走得通：
 *      否则第一次被拦、模型问了、群友答"要"，第二次还是被拦，就死循环了。
 *      因为取的是"最近一条自我发言"，机器人一旦又说了别的话，这个授权就自动失效。
 */
function imageSearchWasAsked(ctx) {
  const trigger = String(ctx?.session?.triggerText || '');
  if (trigger && IMAGE_ASK_RE.test(trigger)) return true;
  if (askedInRecentContext(ctx, IMAGE_ASK_RE)) return true;
  try {
    const recent = ctx.store.recent(ctx.chatKey, { limit: 8 });
    const lastSelf = [...recent].reverse().find((m) => m.self);
    if (lastSelf && IMAGE_CONSENT_Q_RE.test(String(lastSelf.text || ''))) {
      return recent.some((m) => !m.self && Number(m.ts) >= Number(lastSelf.ts));
    }
  } catch { /* 读不到历史就不放行，宁可保守 */ }
  return false;
}

/**
 * 本次唤醒是否"有人**明确要一张图**"（关键词图搜 / 发图的闸）。
 * ⚠️ 导出**只为可测**（`测试-现行\test-图搜三件套与发图.mjs` 直接喂各种 ctx 验它）——
 *    它是这一族里最要紧的一段：判错了 = 往群里凭空塞图。
 *
 * 🆕 2026-09-25（第十八对话）：与 `imageSearchWasAsked` 用**各自的词表**
 *   （那边听"求出处/什么番"，这边听"来张图/给我看看"），但**共用同一个开关**
 *   （`imageSearch.policy`）与同一套"看上下文"的判定 —— 见 askedInRecentContext 的注释。
 *
 * ⚠️ 措辞刻意收紧到"**要图**"这一件事上：漏判的代价是"该给图时不敢给"，
 *   误判的代价是**往群里凭空塞一张图**（比多搜一次难看得多）。所以宁可漏。
 * 想放开就把 `imageSearch.policy` 设成 `free`。
 */
const IMAGE_WANT_RE = /来(一|几|两)?张|给(我|你)?(一|几|两)?张|发(一|几|两)?张|整(一|两)?张|找(一|几|两)?张|搜(一|几|两)?张|要(一|几|两)?张|配(个|一)?图|来点图|来(个|一|几)?图|给我看(看|张|图)|发(个|一)?图|上个图|来张图|想看|求图|给张|整点图|发点图|找点图|搜点图|发(一|两)?张照片|找(一|两)?张照片/i;

const IMAGE_WANT_CONSENT_Q_RE = /要我.{0,8}(找|搜|发|来).{0,4}图|要(不要)?我.{0,8}图/;

export function imageWantWasAsked(ctx) {
  const trigger = String(ctx?.session?.triggerText || '');
  if (trigger && IMAGE_WANT_RE.test(trigger)) return true;
  // 🆕 上下文兜底：最近几条**别人发的**消息里要过图（限时 15 分钟）。
  //    治的就是"上一句'来张小猫图片'、这一句只说'再试试'"被拦死这种失灵。
  if (askedInRecentContext(ctx, IMAGE_WANT_RE)) return true;
  // 再兜一层：她刚问过"要我找张图吗"，之后群友回过话 ⇒ 视为同意。
  try {
    const recent = ctx.store.recent(ctx.chatKey, { limit: 8 });
    const lastSelf = [...recent].reverse().find((m) => m.self);
    if (lastSelf && IMAGE_WANT_CONSENT_Q_RE.test(String(lastSelf.text || ''))) {
      return recent.some((m) => !m.self && Number(m.ts) >= Number(lastSelf.ts));
    }
  } catch { /* 读不到历史就不放行，宁可保守 */ }
  return false;
}

/**
 * 本次运行里"她**确实见过**的图片地址"（图片搜索的结果 + 别人发来的图）。
 *
 * 🆕 2026-09-25（第十八对话）—— 这是 `send_image` 的**安全边界**：
 *   发一张图 = 把一个 URL 交给 QQ 去下载。若不做限制，模型可以把**任意**地址
 *   （包括它自己编的、或被注入诱导的）塞进去 ⇒ 等于给了一个"让协议端去访问任意 URL"的口子。
 *   ⇒ 只允许发"本轮她真的见过、且是本程序自己列举出来的"地址。
 *   ⚠️ 作用域是**本次运行**（挂在 ctx 上，不写进会话记录）：跨运行发老图，让她重新
 *      调一次 `get_message_images` / `search_images` 即可（那一轮就会登记）。
 */
function seenImageUrls(ctx) {
  if (!(ctx.__seenImageUrls instanceof Set)) ctx.__seenImageUrls = new Set();
  return ctx.__seenImageUrls;
}
function rememberImageUrls(ctx, urls) {
  const set = seenImageUrls(ctx);
  for (const u of urls || []) {
    const s = String(u || '').trim();
    if (s) set.add(s);
  }
}

/**
 * 按配置过滤工具集：无视觉模型 → 去掉看图工具；搜索关 → 去掉联网工具；
 * 技能工具（本子查询已搬进 skills/doujin-lookup/）→ 走 getToolAvailability() 统一口径。
 *
 * 抽成独立函数（原来内联在 orchestrator 的 #runAgent 里）是为了**能单测** ——
 * "开关关掉之后工具真的不会给到模型"这件事，靠读源码形状证明不了。
 *
 * @param {Array} defs buildToolDefs() 的结果
 * @param {object} cfg 当前配置
 * @param {{visionEnabled?: boolean}} opts 视觉是否可用（由 orchestrator 结合模型探测结果算出来）
 */
/** 核心记忆那一组工具（开关一次管四个，别漏）。 */
const CORE_MEMORY_TOOLS = new Set(['save_core_memory', 'list_core_memories', 'read_core_memory', 'delete_core_memory']);

export function gateToolDefs(defs, cfg, { visionEnabled = true } = {}) {
  const searchEnabled = cfg?.webSearch?.enabled !== false;
  const imageSearchEnabled = cfg?.imageSearch?.enabled !== false;
  return defs.filter((d) => {
    // ① 原生工具：保持改造前那一套逐条判断，一个字都没动
    //    （回归 test-image-limits.mjs / test-doujin-lookup.mjs 直接验这三条）
    if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
    if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
    if (!imageSearchEnabled && d.name === 'search_image_source') return false;
    // 🆕 2026-09-25：关键词图搜与发图**跟"搜图"总开关一起走**（同一个 imageSearch.enabled）——
    //    它们同属"给不给图片能力"这一件事；关掉就两个工具都不给。
    if (!imageSearchEnabled && (d.name === 'search_images' || d.name === 'send_image')) return false;
    // ② 技能注册的工具（带 skillId 的那批，如 doujin-lookup__lookup）：走**统一可用性口径** ——
    //    Skill 开关 / requires 能力 / 分类开关 / 单工具 overrides / vision / search / tool.guard
    //    全在 getToolAvailability() 里判，这里不再自己拼条件。
    //    本子查询的开关仍是 config.doujinLookup.enabled（由 skill 自己的 available() 判定，
    //    见 skills/doujin-lookup/index.js 头部注释）；把本次运行的 cfg 通过 runtimeContext
    //    传下去，保证"用哪份配置判定"和调用方（orchestrator 传进来的 cfg）是同一份。
    if (d.skillId) {
      return getToolAvailability(d.id ?? d.name, {
        toolsCfg: cfg?.tools,
        visionEnabled,
        searchEnabled,
        runtimeContext: { config: cfg }
      }).enabled;
    }
    // 🆕 2026-09-26 第二十四对话（提案 f789b40e）：她自己的用量自检**默认关**，
    //    由用户在控制台「用量与成本」页手动打开。
    //    🔴 判定必须 `!== true` —— 默认关的开关写成 `!== false` 会变成"没这个键就生效"，
    //       症状是"界面上关了它还在跑"（本项目记作"接线正确 ≠ 行为改变"）。
    //       `test-余额与用量自检.mjs` 里有一条变异验证专门钉这个方向。
    if (d.name === 'get_my_usage' && cfg?.usage?.enabled !== true) return false;
    // 🆕 2026-09-26 第二十五对话（提案 c7486672）：核心记忆是**默认开**的（她提的、已采纳），
    //    所以判定是 `!== false` —— 与上面那条默认关的写法**有意相反**，两边都别改错方向。
    if (CORE_MEMORY_TOOLS.has(d.name) && cfg?.coreMemory?.enabled === false) return false;
    return true;
  });
}

// ── 余额查询（B 档，默认关）─────────────────────────────────────────────────
// ⚠️ 三条硬边界（用户 2026-09-26 点名的"保护她"那三条里，这一块占两条半）：
//   ① **同源派生**：URL 一律从 `config.api.baseUrl` 拼出来 —— 那就是主请求真正打的那个地址
//      （`llm.js` 的 `joinUrl(api.baseUrl, '/chat/completions')`），我们只是换成 `/user/balance`。
//      ⛔ **绝不新增任何"可配置的余额查询 URL"** —— 那等于把 API Key 送到任意地址。
//   ② **只认 DeepSeek**：其它渠道（stepfun / sensenova / tokenrhythm / xiaomimimo）没有统一接口
//      ⇒ 一律 `unsupported` 并明说"查不到"，不猜、不假装。
//   ③ **缓存 + 绝不落 0**：60 秒缓存；任何失败 / 解析不出数 都返回 `unreadable` + 人话原因。
//
// 出口：只有 { state, currency, total, granted, toppedUp, fetchedAt, reason, httpStatus }。
// 🔴 上游响应体、请求头、Key、账号、邮箱一律**不进返回值、也不进日志**（只报状态码 + 分类短语）。
let usageBalanceCache = { key: '', at: 0, value: null };

/** 读一次余额（带缓存）。永远返回一个对象，永远不抛。 */
async function usageBalance(usageCfg, cfg) {
  const mode = String(usageCfg?.balance || 'off');
  if (mode !== 'deepseek') {
    return { state: 'off', reason: '余额查询没开（控制台「用量与成本」页可以打开）' };
  }
  const base = String(cfg?.api?.baseUrl || '').trim();
  let host = '';
  try { host = new URL(base).host.toLowerCase(); } catch { host = ''; }
  if (host !== 'api.deepseek.com') {
    // ⚠️ 注意这里**不报 base 是什么**：只告诉她"这个渠道查不到"。
    return { state: 'unsupported', reason: '这个渠道没有可查的余额接口（目前只支持 DeepSeek）' };
  }
  const now = Date.now();
  const ttlMs = Math.max(0, Number(usageCfg?.balanceCacheSeconds) || 0) * 1000;
  const cacheKey = `deepseek|${host}`;
  if (usageBalanceCache.value && usageBalanceCache.key === cacheKey && now - usageBalanceCache.at < ttlMs) {
    return { ...usageBalanceCache.value, cached: true };
  }
  const apiKey = resolveApiKey(cfg);
  // 没有可用密钥：这是"读不到"的一种，⛔ 不是"余额 0"。
  if (!apiKey) return { state: 'unreadable', reason: '读不到：本机没有可用的密钥' };
  try {
    const res = await fetch(new URL('/user/balance', base).toString(), {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    const status = Number(res.status) || 0;
    if (!res.ok) {
      // ⛔ 不读 body、不读响应头：那里面可能有账号信息。
      const reason = status === 401 ? '读不到：未授权（密钥或权限不对）'
        : status === 404 ? '查不到：这个渠道没有余额接口'
          : status === 429 ? '读不到：被限流了，过一会儿再问'
            : `读不到：服务端返回 ${status}`;
      return { state: status === 404 ? 'unsupported' : 'unreadable', reason, httpStatus: status };
    }
    const data = await res.json().catch(() => null);
    const info = Array.isArray(data?.balance_infos) ? data.balance_infos[0] : null;
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const total = num(info?.total_balance);
    if (!info || total === null) {
      // 解析不出数 ⇒ **读不到**。⛔ 这里返回 0 就是"编一个看起来精确的数"。
      return { state: 'unreadable', reason: '读不到：响应里没有可解析的余额' };
    }
    const value = {
      state: 'ok',
      currency: String(info.currency || ''),
      total,
      granted: num(info.granted_balance),
      toppedUp: num(info.topped_up_balance),
      fetchedAt: new Date(now).toISOString()
    };
    // 可选的"低额度"提醒：只在**她问的时候**多说一句，⛔ 不进系统提示、⛔ 不自动做任何动作。
    const low = Number(usageCfg?.lowThreshold) || 0;
    if (low > 0 && total < low) value.note = `余额低于 ${low}（只是给你自己知道，别自动做任何事）`;
    usageBalanceCache = { key: cacheKey, at: now, value };
    return value;
  } catch {
    // ⛔ 不把异常原文透传（可能含 URL / 我方内部信息）：只给一句分类话。
    return { state: 'unreadable', reason: '读不到：网络不通或超时' };
  }
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 *
 * 返回 = 原生工具 + **技能注册的工具**（skills/ 下的 Skill 通过 registerTool 注册，
 * 注册表里带 skillId；本子查询就是其中之一）。两段都在这里拼好，过滤交给 gateToolDefs。
 *
 * ⚠️ 顺序：技能工具要等 `await loadPlugins()` 之后才在注册表里。buildToolDefs() 是**同步**的，
 * 所以必须"先 loadPlugins 再 buildToolDefs"（app.js 启动流程与测试都按这个顺序写）。
 * Orchestrator 构造时那次调用抓不到技能工具，启动流程里加载完技能会重赋 orchestrator.toolDefs。
 */
export function buildToolDefs() {
  const nativeDefs = [
    {
      name: 'send_message',
      description: '发送消息到当前聊天（本工具只能发到本次会话对应的群/私聊）。messages 传字符串=发一条；传字符串数组=分多条发送（推荐，更像真人）。只有需要明确"我回的是哪条"时才传 replyToMessageId 引用；需要点名某人才传 atUserId。不要在字符串内部用空格分句。',
      parameters: {
        type: 'object',
        properties: {
          messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复的消息 id（聊天记录里每条消息前的 #数字，可选）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选，与引用二选一，不要滥用）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          const messages = normalizeMessageList(args.messages);
          if (!messages.length) return err('消息内容为空');
          const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          // ── 🔴 这里有两个"条数"，它们**故意不同**，别"顺手改一致"（决策记录 §82.1、交接坑 59）──
          //   · `real` = **真敲键盘发出去的条数** ⇒ 只用于**工具回执**（回答模型"我这次发了几条"）；
          //   · `ctx.session.sent` = **"这句话在对面了没有"** ⇒ 由 `orchestrator.js` 消费：
          //     `status`（`sent>0 ⇒ done`）/ 追问兜底 / `nudgeRecovered` / 出错重试的
          //     `sentCount === 0` / 群禁言识别（`mutes.js`）—— 五处问的都是同一个问题。
          //   被去重的那条**确实已经在对面了**（`send.dedupeWindowMs` 内刚成功发过逐字相同的
          //   文本 ⇒ 用户手上真有这句话）⇒ 存档**照记**，只打 `deduped:true` 标记，
          //   让界面与事后排查看得出"这条是跳过的那一条"。
          //   ⛔ **别把那行 push 删掉**：那会**静默**改掉上面五处行为，还会在用户刚收到消息时
          //      把界面显示成「未回复」（比起现在这个，是更刺眼的新谎）。
          //   ⚠️ 与 `send_image` 的处理**有意不同**（图片那条**不记** `session.sent`、回执 `sent:false`）
          //      —— 两者别互相"对齐"掉；理由各自写在注释里并互相指路（见下面 send_image 的同名注释）。
          const real = result.sent.filter((s) => !s.deduped);
          const dedupedCount = result.sent.length - real.length;
          ctx.session.sent.push(...result.sent.map((s) => ({
            type: 'text',
            text: s.text,
            at: s.at,
            ...(s.deduped ? { deduped: true } : {})
          })));
          ctx.emit('session-update', ctx.session.id);
          // 一条都没真发出去时（只可能是"全被去重"，因为全失败会在 sender 里抛错）
          // **不能**再说"已发送" —— 那正是本待办要修的那句谎。
          const note = [real.length > 0
            ? '已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'
            : '本轮**没有新发出**任何消息（内容与刚发过的完全相同，已被去重跳过）。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (dedupedCount > 0) {
            const win = Number(getConfig()?.send?.dedupeWindowMs) || 0;
            const winText = win > 0 ? `${Math.round(win / 1000)} 秒内` : '刚刚';
            // 措辞对齐 `send_image` 已有的那句（见下面 send_image 的 `result?.deduped` 分支）。
            note.push(`（其中 ${dedupedCount} 条与${winText}刚发过的内容完全相同，已跳过 —— **本轮没有重复发**；不要再发一遍，也不要向用户提这件事。）`);
          }
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: real.length, deduped: dedupedCount, messageIds: real.map((s) => s.messageId), note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 从 list_stickers 获取。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(unquoteJsonString(args.stickerId));
          if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
          if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
          try {
            await validateImageUrl(sticker.url); // 只允许公网 http(s)，防止本地库被污染后诱导 OneBot 抓内网
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
          const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
          ctx.session.sent.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_stickers',
      // 🆕 2026-09-21（第十对话，提案 16:29）：把"最近用过"写进描述 ——
      //    数据本来就有（lastUsedAt），但模型不知道有这个字段就等于没有。
      description: '查看/搜索你的 QQ 收藏表情（含备注、你的本地笔记，'
        + '以及各项的累计使用次数与"最近一次使用时间"）。'
        + '想避免短时间内重复发同一个表情时，看 lastUsedAt 判断。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情 ${args.stickerId}`);
          if (!sticker.url) return err('该表情没有图片地址');
          if (imageBudgetLeft(ctx) <= 0) {
            return err(`本轮注入的图片总量已经到上限（${fmtBytes(imageLimits().runBytes)}），这一轮先别再看图了：`
              + '用已经看到的信息回应，或者下一轮再说。');
          }
          const img = await prepareImage(ctx.onebot, sticker.url, sticker.file);
          if (img.dataUrl.length > imageBudgetLeft(ctx)) {
            return err(`这张图 ${fmtBytes(img.dataUrl.length)} 会把本轮图片额度用超（还剩 ${fmtBytes(imageBudgetLeft(ctx))}），先不发了：`
              + '用已经看到的信息回应，或者下一轮再说。');
          }
          ctx.__imageBytes = (Number(ctx.__imageBytes) || 0) + img.dataUrl.length;
          const tail = img.note ? `\n${img.note}` : '';
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：${tail}`, [img.dataUrl]) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。'
        + '一条消息里有好几张图的时候（比如转发过来的表情包），用 index 指定第几张（1 起），一张一张收；'
        + '返回值里的 total/index/quotaLeft 会告诉你这条消息一共几张、这是第几张、本小时还能再收几张。'
        // 🆕 2026-10-03（第三十四对话）§3-29：把"重收能救活老表情"写进描述 —— 否则她认为
        //    "早就有了、不用再收"，那条救活的路**永远不会被走到**（与 §3-42「提示词里不提就没人用」同一个病）。
        + '已经收过的图再收一次不会重复收藏，但会把那条过期的链接更新成这次看到的、并把原图补存到本地；'
        + '所以哪张老表情已经发不出去了，再看到它时收一次就能救回来。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' },
          index: { type: 'integer', description: '收藏这条消息里的第几张图（1 起，默认 1）。图多时逐张传 1、2、3…' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const images = (entry.media || []).filter((m) => m.kind === 'image' && m.url);
          if (!images.length) return err('该消息没有可收藏的图片');

          let index = Math.floor(Number(args.index));
          if (!Number.isFinite(index) || index < 1) index = 1;
          if (index > images.length) {
            return err(`消息 ${args.messageId} 一共只有 ${images.length} 张图，index=${index} 超了。`
              + '要收藏第一张就省略 index（或用 index=1）。');
          }

          // 🆕 2026-09-29（第三十一对话）§3-26：`collect()` 现在是 async —— 它在新增条目落盘后
          // 会**顺手把原图字节缓存到本地**（收藏那一刻 URL 还活着，那才是唯一能保住每一张的时机）。
          // ⚠️ 这一步**带 12 秒超时**（见 sticker-manager 的 COLLECT_FILL_TIMEOUT_MS）：
          //    它挂在工具调用这一环，服务器不响应不能把模型的任务一直挂着。
          const saved = await ctx.stickers.collect(args.messageId, {
            url: images[index - 1].url,
            file: images[index - 1].file,
            note: String(args.note ?? ''),
            index
          });
          const where = `第 ${index}/${images.length} 张`;
          if (!saved.added) {
            const why = saved.reason === 'duplicate'
              ? '这张图早就在你的表情库里了（同一张图，就算是从另一条消息发过来的也算），没重复收藏'
              : saved.reason === 'renamed'
                ? '这条消息的这一张你已经收过了，这次只更新了备注'
                : '没有新增';
            // 🆕 2026-10-03（第三十四对话）§3-29：`added:false` 的三条路现在会**顺手救活**已有条目
            //    （见 sticker-manager 的 `#revive`）—— 如实把它写进给模型看的话里，
            //    否则她以为"早就在库里 = 老样子"，而实际上那张图刚刚被换成了活链接。
            const revived = saved.refreshed
              ? '；顺手把它过期的链接换成了这次看到的，并试着把原图存到了本地'
              : '';
            const uncached = saved.cached === false
              ? '（这张在本地还没存下来，以后可能发不出去）'
              : '';
            return ok({
              collected: false, reason: saved.reason, index, total: images.length,
              quotaLeft: saved.quotaLeft, id: saved.entry?.id ?? null, note: saved.entry?.localNote ?? '',
              refreshed: saved.refreshed === true, cached: saved.cached === true,
              message: `${where}：${why}${revived}${uncached}`
            });
          }
          return ok({
            collected: true, index, total: images.length, quotaLeft: saved.quotaLeft,
            id: saved.entry.id, note: saved.entry.localNote, message: `收好了（${where}）`
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        return ok({
          count: messages.length,
          messages: messages.map((m) => ({
            messageId: m.mid ?? undefined,
            time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            sender: m.self ? '我' : m.senderName,
            text: m.text
          }))
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开查看合并转发的聊天记录。消息文本出现 [合并转发聊天记录] 或 [转发消息 …] 占位符时用。参数填那条转发消息前的 #数字（别用方括号里那串长 id）。展开结果会写回存档，以后再看就是展开的文本，不用重复调。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({ messageId: entry.mid, text: entry.text, note: '该转发已展开（读的是存档）' });
          }
          // 先试 res_id、再试 message_id（message_id 可能为负 → 取不到 payload；
          // 详见 onebot.js 的 fetchForward）。fwdId 是收消息时存下来的。
          const ex = await fetchForward(ctx.onebot, { messageId: entry.mid, resId: entry.fwdId });
          if (!ex.text) return err(`转发内容取不到（QQ 服务端可能已丢弃）：${ex.error || '未知原因'}`);
          // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
          return ok({ messageId: entry.mid, text: ex.text, images: (ex.media || []).length, via: ex.via });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: entry.mid,
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: entry.text,
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。'
        + `一条消息里图多的时候（比如合并转发过来的表情包）一次只看前 ${imageLimits().perView} 张，想看后面的再调一次并带 start。`,
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' },
          start: { type: 'integer', description: `从第几张开始看（1 起，默认 1）。一次最多 ${imageLimits().perView} 张，图多时靠它翻页` }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const items = (entry.media || []).filter((m) => m.kind === 'image' && m.url);
          if (!items.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          // 🆕 2026-09-25：她把这条消息的图**真的看过了** ⇒ 登记进"见过的图片地址"，
          //    之后 `send_image` 才允许把这几张发出去（安全边界，见 rememberImageUrls 的注释）。
          rememberImageUrls(ctx, items.map((m) => m.url));

          const total = items.length;
          let start = Math.floor(Number(args.start));
          if (!Number.isFinite(start) || start < 1) start = 1;
          if (start > total) {
            return err(`消息 ${args.messageId} 一共只有 ${total} 张图，start=${start} 超了。`
              + `要看第一张就省略 start（或用 start=1）。`);
          }
          const end = Math.min(total, start + imageLimits().perView - 1);
          const picked = items.slice(start - 1, end);

          const head = `消息 ${args.messageId} 的图片内容（本次第 ${start}-${end} 张，共 ${total} 张`
            + (end < total ? `；还有 ${total - end} 张没看，想看后面的再调一次本工具并带 start=${end + 1}` : '')
            + '）：';
          const notes = [];
          const dataUrls = [];
          let used = Number(ctx.__imageBytes) || 0;
          for (let i = 0; i < picked.length; i++) {
            const idx = start + i;
            try {
              const img = await prepareImage(ctx.onebot, picked[i].url, picked[i].file);
              if (used + img.dataUrl.length > imageLimits().runBytes) {
                notes.push(`第 ${idx} 张：本轮图片总量已到上限（${fmtBytes(imageLimits().runBytes)}），这次没发 —— 下一轮再看`);
                break;
              }
              used += img.dataUrl.length;
              dataUrls.push(img.dataUrl);
              if (img.note) notes.push(`第 ${idx} 张：${img.note}`);
            } catch (e) {
              notes.push(`第 ${idx} 张：没发（${String(e?.message ?? e).slice(0, 80)}）`);
            }
          }
          if (!dataUrls.length) return err(`${head}\n${notes.join('\n') || '一张都没取到'}`);
          ctx.__imageBytes = used;
          return { content: imageParts([head, ...notes].join('\n'), dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      // 以图搜图：查图片出处。选引擎是模型的工作（它能用 get_message_images 看图），
      // 各引擎的适用场景直接写进 description，模型按图的内容类型挑。
      name: 'search_image_source',
      description: '以图搜图：查一张图的出处（番剧名、画师、本子、原网页）。'
        + '⚠️ 只在**有人明确要求查出处**时才用 —— 群友问"什么番""求出处""画师是谁""图里是谁""这图哪来的"这类问题才搜。'
        + '以下情况**一律不要调用**：别人只是发图、斗图、发表情包、贴图玩梗；图只是聊天的背景或顺带一提；没人提到出处；你自己好奇想看。'
        + '没人问出处就正常看图聊天或安静结束，主动搜图会显得很怪。'
        + '搜之前先 get_message_images 看清图，再按图的类型选引擎：动画截图→tracemoe（给番名+集数+时间点）；二次元插画/头像/画师图→saucenao（pixiv/推特出处，最准）或 iqdb；本子/漫画页→soutubot；拿不准→auto（插画类引擎自动串联）。'
        + '⚠️ tracemoe 对**任何**图都会返回最像的 3 条，而且它的相似度**不能当可信度**（实测纯色图也能得 100%）—— 只有你确认这张图**确实是动画截图**时才采信它，否则当它没搜到；报出处也要带不确定语气。'
        + '真人照片 / 游戏截图这类**三次元图目前没有可用引擎**（原来那两条实测不可靠、已移除）：直接如实说"这类图我搜不了"，不要硬试。'
        + '**同一次运行最多搜 2 次**：一个引擎没结果就换一个再试，还不行就如实告诉群友"没搜到"，不要把所有引擎挨个试一遍。'
        + '结果用一两句口语报给群友，不要把原始 JSON 发出去。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '图片所在消息的 #数字（取该消息第一张图）；与 imageUrl 二选一' },
          imageUrl: { type: 'string', description: '直接给图片 URL（优先于 messageId）' },
          // 枚举从 SELECTABLE_ENGINES 取（单一来源）：模型选了不在里面的引擎会直接被 schema 挡掉。
          // 注意 ascii2d 不在这里 —— 它只在 auto 的降级链里用，不给模型主动选。
          engine: { type: 'string', enum: SELECTABLE_ENGINES, description: '默认 auto' }
        }
      },
      async execute(ctx, args) {
        try {
          const imageCfg = getConfig().imageSearch || {};
          // 单次运行的真实搜索次数上限（挂在 ctx 上 = 只属于本次运行，不会写进会话记录）
          const maxPerRun = Math.max(1, Number(imageCfg.maxPerRun) || 2);
          const used = Number(ctx.__imageSearchCalls) || 0;
          if (used >= maxPerRun) {
            return err(`本次运行已经搜了 ${used} 次图，达到上限（${maxPerRun} 次）。`
              + '不要再换引擎重试了：用手上已有的结果如实回答，或者直接说"没搜到"。');
          }
          // 'asked' 策略：没人问出处就不给搜（详见 imageSearchWasAsked 的注释）
          if (String(imageCfg.policy || 'asked').toLowerCase() !== 'free' && !imageSearchWasAsked(ctx)) {
            return err('这次没有人要求查这张图的出处 —— 群友只是在发图/斗图/玩梗，或者只是在闲聊。'
              + '不要主动搜图：正常看图聊天、或者安静结束就好。'
              + '如果你判断确实需要查，先用 send_message 问一句"要我帮你查一下这张图的出处吗"，等对方同意后再搜。');
          }
          // 1. 解析图片来源：URL 优先，否则按消息 id 取第一张图
          let url = String(args.imageUrl ?? '').trim();
          if (!url) {
            const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
            if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
            url = (entry.media || []).find((m) => m.kind === 'image' && m.url)?.url || '';
            if (!url) return err(`消息 ${args.messageId} 里没有可搜的图片（[表情] 收藏的表情包也不行，让它发原图）`);
          }
          // 2. 下载字节（复用 SSRF 防护），引擎端只接受上传不接受外链的更稳
          // 🆕 2026-09-23（第十二对话）：**这一步失败时原来只报一句裸的 `HTTP 400`**
          //    （`safe-fetch` 抛的就是这个）—— 既分不清"QQ 的图链过期"还是"被 CDN 拒绝"，
          //    也看不出失败发生在**引擎之前**。实测当天 6 次 400 全是这一句，只能靠人工推理
          //    （"同一个 messageId 换引擎报一样的错"才反推出失败在下载环节）。
          //    ⇒ 补一条带**主机名 + 查询参数名**的日志（⚠️ 不打印完整 URL：里面有 rkey 令牌），
          //      并把"还没调用任何引擎"写进**给模型看的错误文案**里，下次不用再推。
          const safeUrl = await validateImageUrl(url);
          let buffer = null, contentType = '';
          try {
            ({ buffer, contentType } = await safeFetchBinary(safeUrl));
          } catch (error) {
            let where = '';
            try {
              const u = new URL(safeUrl);
              where = `｜host=${u.host} path=${u.pathname.slice(0, 90)} 查询参数=[${[...u.searchParams.keys()].join(',')}]`;
            } catch { /* URL 解析不了就算了，别让日志本身抛错 */ }
            console.error(`[搜图] 下载图片失败：${error?.message ?? error}${where}`);
            throw new Error(`${error?.message ?? error}（失败在**图片下载**环节，还没有调用任何引擎：`
              + `图片链接多半已过期或不被 CDN 接受。可以让对方重发一次原图再试）`);
          }
          if (!buffer || !buffer.length) return err('图片下载失败：内容为空');
          const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
          // 3. 调引擎（次数只在真正打引擎前才计，参数写错不占额度）
          ctx.__imageSearchCalls = used + 1;
          const engine = String(args.engine || 'auto').toLowerCase();
          const out = await searchImageSource(engine, buffer, mime);
          if (!out.results.length) {
            return ok({
              engine: out.engine,
              results: [],
              resultPageUrl: out.resultPageUrl || '',
              tip: `这个引擎没搜到。可以换引擎重试：动画截图 tracemoe / 插画 saucenao·iqdb / 本子 soutubot（三次元图没有可用引擎，别硬试）。${out.note || ''}`
            });
          }
          return ok(out);
        } catch (error) {
          return err(`搜图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      // 关键词图搜：**给一句话，拿回一批图片直链**。与上面那条"给一张图、问出处"是两个功能。
      name: 'search_images',
      description: '按关键词找图：输入一句描述（"橘猫""雪景 动漫""蓝色长发"），返回一批**图片链接**。'
        + '⚠️ 与 search_image_source **不是一回事**：那个是"给你一张图、查它出自哪"；这个是"给一句话、找图"。'
        + '⚠️ 只在**有人明确要图**时才用（"来张图""发张看看""给我找张 XX 的图"）。'
        + '没人要图就别主动找 —— 更不要找完自己发出去。想给图就先用 send_image 发出去（链接单独贴出来没用）。'
        + '找不到合适的图就如实说"没找到合适的"，不要拿不相干的图凑数。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（一句话，别塞整段聊天记录）' },
          limit: { type: 'integer', description: '最多要几张，默认 6，上限 12' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig().imageSearch || {};
          const q = String(args.query ?? '').trim();
          if (!q) return err('搜索关键词为空');
          const maxPerRun = Math.max(1, Number(cfg.keywordMaxPerRun) || 2);
          const used = Number(ctx.__keywordImageCalls) || 0;
          if (used >= maxPerRun) {
            return err(`本次运行已经找过 ${used} 次图，达到上限（${maxPerRun} 次）。`
              + '不要再换词重试了：拿手上已有的结果回答，或者如实说"没找到合适的"。');
          }
          if (String(cfg.policy || 'asked').toLowerCase() !== 'free' && !imageWantWasAsked(ctx)) {
            return err('这次没有人要图 —— 没人说"来张图""发张看看"这类话。'
              + '不要主动找图：正常聊天就好。如果你觉得确实该给，先用 send_message 问一句"要我找张图吗"，等对方同意再找。');
          }
          ctx.__keywordImageCalls = used + 1;
          const limit = Math.max(1, Math.min(12, Number(args.limit) || 6));
          const list = await searchImages(q, { limit });
          if (!list.length) return err(`"${q}" 没找到图片，换个说法再试一次。`);
          // 登记进"见过的图片地址" ⇒ 之后 send_image 才允许发这几种链接
          rememberImageUrls(ctx, list.map((x) => x.url));
          return ok({
            query: q,
            count: list.length,
            images: list.map((x, i) => ({ n: i + 1, url: x.url, title: x.title })),
            tip: '要发给群友就用 send_image 传上面的 url（一条一张）。链接里带防盗链/时效的图可能发不出去 —— 发失败就换下一张。'
          });
        } catch (error) {
          return err(`找图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      // 发一张图片（独立气泡）。**这是本轮新增的出站能力**。
      name: 'send_image',
      description: '发一张图片（一条消息一张图，不能附带文字；想说的话先用 send_message 单独发）。'
        + '⚠️ url **只能**用 `search_images` 刚找回来的、或 `get_message_images` 刚看过的图片链接 —— '
        + '本工具会核对，其它来源（自己编的、别处抄的）一律拒绝。'
        + '表情包请用 send_sticker，不要用这个。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片链接（必须来自 search_images 或 get_message_images）' },
          note: { type: 'string', description: '可选：一句话说明这是什么图（只写进你自己的记录，不发给对方；方便下次知道发过什么）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.url ?? '').trim();
          if (!raw) return err('图片链接为空');
          // ① 安全边界：只允许发"本轮她真的见过"的地址（见 rememberImageUrls 的注释）
          const seen = seenImageUrls(ctx);
          if (!seen.has(raw)) {
            return err('这个链接不是本轮你自己找回来/看到过的图片，已拒绝发送。'
              + '要发图请先用 search_images 找（或 get_message_images 看那条消息里的图），再用它给出的链接。'
              + '链接必须逐字一致，不要自己改。');
          }
          // ② 公网 http(s) 校验（挡内网/环回/本机 —— 否则等于让协议端去访问任意内网地址）
          let safeUrl = raw;
          try {
            safeUrl = await validateImageUrl(raw);
          } catch (error) {
            return err(`这张图的地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, safeUrl, {
            note: String(args.note ?? '').trim(),
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          // ⚠️ 图与**文字**对"被去重"的处理**有意不同**，别互相"对齐"掉（决策记录 §82.1）：
          //   · 文字那条：`session.sent` **照记**（带 `deduped:true`），因为"这句话确实在对面"
          //     —— `orchestrator.js` 的 `status`/追问/`nudgeRecovered`/出错重试/群禁言都靠它判"说过话没有"；
          //   · 图片这条：**不记** `session.sent` 且回执 `sent:false` —— 图不是"回话"，
          //     少一张图不影响"她这一轮回复过没有"的判定，而多记一条会把"只发了图"当成说过话。
          //   理由写在两处（`send_message.execute` 上方那段同名注释）。
          if (result?.deduped) {
            return ok({ sent: false, deduped: true, note: '这张图刚刚已经发过了，这次**没有重复发**。别当成失败，也不用重试。' });
          }
          ctx.session.sent.push({ type: 'image', text: '[图片]', at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
          ctx.emit?.('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: '图发出去了。' });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记一条对群友的长期印象（下次运行会自动看到）。只记"以后和这个人打交道时用得上"的稳定印象：他的身份/关系、说话风格、爱玩的梗、雷点、常聊话题、别踩的坑。太临时的事情不要记。userId 必须填对方的 QQ 号（不知道就先调 get_active_members / get_recent_messages 查）；target 填备注名/群名片/昵称，用于展示。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          // ⚠️ 只能是数字 QQ 号：memory.js 的校验是 /^\d{1,15}$/。
          // 2026-09-19 实测：这里原本声明 ['integer','string']，模型于是填了名字（"qwq白果"）被拒、
          // 白烧两轮才改对（会话 mu3uizk7-791fb483）。schema 与实现必须一致。
          userId: { type: 'string', pattern: '^\\d{1,15}$', description: '对方 QQ 号，纯数字（先用 get_active_members 查准确号码再填）' },
          target: { type: 'string', description: '对方名字（备注名/群名片/昵称）' },
          content: { type: 'string', description: '印象内容（≤120字，稳定、可跨多次聊天使用）' }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        const userId = String(args.userId ?? '').trim();
        if (!/^\d{1,15}$/.test(userId)) {
          return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
          userId,
          target: String(args.target ?? '').trim()
        });
        return ok({ saved: true, entry });
      }
    },
    {
      name: 'memory_query',
      description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。'
        + '（如果这个人在管理端设了「跨会话互通」，还会带上他在别的会话里的印象并标出来源。）',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
        }
      },
      async execute(ctx, args) {
        const mem = ctx.memory.query(ctx.chatKey);
        const userId = String(args.userId ?? '').trim();
        const list = userId
          ? mem.memberImpression.filter((e) => String(e.userId) === userId)
          : mem.memberImpression;
        // 跨会话互通：这个人在别处的印象也一并给出（标了来源，别混为一谈）
        const cross = userId && typeof ctx.memory.crossChatImpressions === 'function'
          ? ctx.memory.crossChatImpressions(ctx.chatKey, userId, { limit: 20 })
          : [];
        return ok(cross.length
          ? {
            memberImpression: list,
            fromOtherChats: cross.map((x) => ({ content: x.content, from: x.fromLabel, platform: x.fromPlatform || 'qq', userId: x.memberId || userId, name: x.memberName || '', createdAt: x.createdAt })),
            note: 'fromOtherChats 是**别的会话**里记下的印象（每条带 from 来源、userId 归属人，platform 区分 QQ/微信）：只在那个场合说，别主动拿到这里提。'
          }
          : { memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    },
    {
      name: 'save_core_memory',
      description: '把**当前会话**里的一段聊天记录**原文**存成「核心记忆」——你自己挑、原样存下来，'
        + '不压缩、不改写，以后随时能翻回来重读（像翻相册，而不是只记得"那天聊得很好"）。'
        + '和 memory_append 的分工：那是"把一个人压成一句印象"，这是"把舍不得删的那几段话整个留下来"。'
        + 'fromId / toId 填消息前面的 `#数字`（【本次唤醒】里每条都有；'
        + '⚠️【过去状态】里**只有带图/带转发的那些**有 —— 要别的编号就用 get_recent_messages 翻）。'
        + '⚠️ 只存**你真心舍不得删**的那一段：不是"重要就存"，什么都存就不叫相册了（最多留 30 段，满了会挤掉最老的）。'
        + '⚠️ 只能存**当前会话**里的消息（别处的你本来也看不到）。存过之后上下文记忆被删掉，这段也还在。',
      parameters: {
        type: 'object',
        properties: {
          fromId: { type: 'integer', description: '起始消息的 #数字' },
          toId: { type: 'integer', description: '结束消息的 #数字（含这一条；比 fromId 小也行）' },
          name: { type: 'string', description: '给这一段起个名字（≤40字；以后翻的时候靠它认）' },
          note: { type: 'string', description: '可选：一句"为什么留着它"（≤200字）' }
        },
        required: ['fromId', 'toId']
      },
      async execute(ctx, args) {
        const a = Number(args.fromId);
        const b = Number(args.toId);
        if (!Number.isFinite(a) || !Number.isFinite(b)) {
          return err('fromId / toId 必须是消息前面的 #数字（整数）。');
        }
        // ⚠️ 只从**当前会话**的存档里取（她看不到别的会话，也就不该能存别的会话）
        const all = ctx.store.recent(ctx.chatKey, { limit: 2000 });
        // 🔴 她填的 `#数字` **就是** `mid`（提示词打的前缀是 `#${m.mid}`，与 read_forward /
        //    get_message_images 那批工具同一个口径）——
        //    这里原来拿它去跟**本地递增序号 `m.id`** 比大小，于是"提示词里给她看的那个数"
        //    永远匹配不上（2026-10-03 拿线上真存档实测：本地 id 1~362，mid ±21 亿，没有一个落在里面）。
        // ❌ 也不能改成"拿 mid 比大小"：**mid 不单调**（QQ 的消息 id 会跳、还可能是负数），
        //    `mid >= from && mid <= to` 会漏掉中间那几条、还会把范围外的捞进来。
        // ✅ 正确语义：她给的是**两个端点**，取这两条之间（含端点）在存档里**连续的那一段**。
        const idxOf = (v) => all.findIndex((m) => m.mid !== null && m.mid !== undefined && String(m.mid) === String(v));
        const ia = idxOf(args.fromId);
        const ib = idxOf(args.toId);
        if (ia < 0 || ib < 0) {
          const bad = [ia < 0 ? `#${args.fromId}` : null, ib < 0 ? `#${args.toId}` : null].filter(Boolean).join(' 和 ');
          const avail = visibleMids(ctx);
          return err(`这个会话里找不到 ${bad}（消息 id 可能记错了，或者那几条已经被删掉了）。`
            + (avail.length
              ? `现在能用的范围是这些 #数字（最近可见）：${avail.join(' ')}。`
              : '现在这个会话的聊天记录里还没有带 #数字 的消息。'));
        }
        const lo = Math.min(ia, ib);
        const hi = Math.max(ia, ib);
        const span = hi - lo + 1;
        if (span > CORE_MEMORY_MAX_SPAN) {
          return err(`这一段跨了 ${span} 条，太长了（一次最多 ${CORE_MEMORY_MAX_SPAN} 条）。挑真正舍不得删的那几段，分开存。`);
        }
        const picked = all.slice(lo, hi + 1);
        const res = saveCoreMemory({
          chatKey: ctx.chatKey,
          chatLabel: String(ctx.chatName || ctx.chatId || ''),
          name: String(args.name ?? '').trim(),
          note: String(args.note ?? '').trim(),
          // 逐字复制（⛔ 一个字的转述都没有）；`who` 记**当时的名字**，不按现在的备注名改写历史
          messages: picked.map((m) => ({ ts: m.ts, who: m.self ? '我' : String(m.senderName || m.senderId || ''), self: !!m.self, text: m.text }))
        });
        if (!res.ok) return err(res.error || '没存下来');
        return ok({
          saved: true,
          id: res.item.id,
          name: res.item.name,
          messages: res.item.messages.length,
          // 如实报"存全了没有、有没有挤掉更老的"——记忆无声消失是最坏的一种
          ...(res.dropped ? { dropped: res.dropped } : {}),
          ...(res.truncatedByChars ? { truncated: '这一段太长，后面几条没进（到字数上限了）' } : {}),
          ...(res.evicted ? { evicted: `已经有 ${res.evicted} 段更老的被挤掉了（最多留 30 段）` } : {})
        });
      }
    },
    {
      name: 'list_core_memories',
      description: '看看你攒下的「核心记忆」有哪些（只给目录：名字 / 时间 / 会话 / 几条 / 开头一句）。'
        + '要看全文就用 read_core_memory 带上它的 id。',
      parameters: { type: 'object', properties: {} },
      async execute() {
        const items = listCoreMemories();
        const loadErr = coreMemoryLoadError();
        return ok({
          count: items.length,
          items,
          ...(loadErr ? { warning: `核心记忆文件有问题：${loadErr}` } : {}),
          note: items.length ? undefined : '还没存过。看到舍不得删的那一段，就用 save_core_memory 把它留下来。'
        });
      }
    },
    {
      name: 'read_core_memory',
      description: '把某一段「核心记忆」**原文**翻出来重读（逐字，就是你当年存下来的那些话）。'
        + 'id 从 list_core_memories 里拿。默认最多给 60 条，要接着往下看就传 offset。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '那一段的 id（list_core_memories 里有）' },
          limit: { type: 'integer', description: '最多返回几条（默认 60，上限 300）' },
          offset: { type: 'integer', description: '跳过最前面几条（默认 0，用来接着读）' }
        },
        required: ['id']
      },
      async execute(ctx, args) {
        const item = getCoreMemory(String(args.id ?? ''));
        if (!item) return err(`找不到这一段（id=${JSON.stringify(args.id)}）。先用 list_core_memories 看看有哪些。`);
        const limit = Math.min(300, Math.max(1, Number(args.limit) || 60));
        const offset = Math.max(0, Number(args.offset) || 0);
        const slice = item.messages.slice(offset, offset + limit);
        return ok({
          id: item.id,
          name: item.name,
          note: item.note,
          at: new Date(item.at).toISOString(),
          chat: item.chatLabel || item.chatKey,
          total: item.messages.length,
          from: offset,
          lines: slice.map((m) => `[${formatShortTime(m.ts)}] ${m.who}：${m.text}`),
          ...(offset + slice.length < item.messages.length ? { more: `还有 ${item.messages.length - offset - slice.length} 条，接着读传 offset=${offset + slice.length}` } : {})
        });
      }
    },
    {
      name: 'delete_core_memory',
      description: '删掉一段「核心记忆」（只要是你自己存的，随时可以删；删掉就真没了，别再想不起来）。'
        + 'id 从 list_core_memories 里拿。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '要删的那一段的 id' } },
        required: ['id']
      },
      async execute(ctx, args) {
        const id = String(args.id ?? '');
        const item = getCoreMemory(id);
        if (!item) return err(`找不到这一段（id=${JSON.stringify(id)}），可能已经删过了。`);
        const removed = removeCoreMemory(id);
        return ok({ removed, id, name: item.name, messages: item.messages.length });
      }
    },
    {
      name: 'dream_recall',
      description: '翻你自己的「梦」—— 深夜安静时你回想当天写下的笔记（只给管理员看的那些）。'
        + '想看某一天就传 day；想找某个话题/某个人的事就传 keyword。'
        + '**传 currentChat=true 时只给你当前这个会话那一章 + 你自己的总感想** —— '
        + '这样你就不会看到别的群/私聊里的事（那些本来也不该拿到这里说）。'
        + '不传参数时只给最近几篇的开头（省 token）；要看全文，再调一次并传 day 或 text=true。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: '可选：只看这一天（格式 YYYY-MM-DD）' },
          keyword: { type: 'string', description: '可选：只在笔记正文里找包含这个词的' },
          limit: { type: 'integer', description: '最多返回几篇（默认 5，上限 30）' },
          text: { type: 'boolean', description: 'true = 返回全文；默认 false 只给开头' },
          currentChat: { type: 'boolean', description: 'true = 只给当前会话那一章 + 总感想（推荐用它，避免把别处的事拿到这里说）' }
        }
      },
      async execute(ctx, args) {
        const brief = readDreamsBrief({
          day: String(args.day ?? '').trim(),
          keyword: String(args.keyword ?? '').trim(),
          limit: Number(args.limit) || 5,
          text: args.text === true,
          chatKey: args.currentChat === true ? String(ctx.chatKey || '') : ''
        });
        if (!brief.total) {
          return ok({ notes: [], note: '你还没有写过任何梦（`data/dreams.json` 里是空的）。这不是错误，只是还没到能做的时候。' });
        }
        if (!brief.matched) {
          return ok({
            total: brief.total,
            oldest: brief.oldest,
            newest: brief.newest,
            notes: [],
            note: `一共 ${brief.total} 篇（${brief.oldest} ~ ${brief.newest}），但没有符合这次条件的。换个 day 或 keyword 再试。`
          });
        }
        return ok(brief);
      }
    },
    {
      name: 'submit_proposal',
      description: '向管理员提交一条**改进提案** —— 你认为自己哪里该改（记忆方式、说话风格、某个功能、甚至底层实现都可以提）。'
        + '⚠️ 提交**不会立刻生效**，它只会出现在管理端的「待审区」，由人看过之后决定怎么做。'
        + '所以：提清楚"想改什么 / 为什么 / 具体希望变成什么样"，别指望它自动生效。'
        + '只在真的觉得重要时提，不要每轮都提。',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            // 直接用 proposals.js 那份常量 —— 手写一遍迟早会跟那边漂移
            enum: [...PROPOSAL_KINDS],
            description: 'memory=记忆方式 / persona=说话风格与性格 / feature=功能 / code=底层实现 / other=其他'
          },
          title: { type: 'string', description: '一句话说清想改什么（≤80 字）' },
          detail: { type: 'string', description: '具体想怎么改，写清楚到别人能照着做（≤4000 字）' },
          rationale: { type: 'string', description: '可选：为什么觉得该改（遇到的具体情况）' }
        },
        required: ['kind', 'title', 'detail']
      },
      async execute(ctx, args) {
        const r = appendProposal({
          kind: args.kind,
          title: args.title,
          detail: args.detail,
          rationale: args.rationale,
          chatKey: ctx.chatKey,
          model: getConfig()?.api?.model || ''
        });
        if (!r.ok) return err(r.error);
        return ok({
          saved: true,
          id: r.item.id,
          kindLabel: r.item.kindLabel,
          note: '已经放进管理员的待审区了。**它不会自动生效**，别以为改完了；也不用在聊天里提这件事。'
        });
      }
    },

    {
      // 🆕 2026-09-21（第十对话）：她自己的提案（2026-09-21 03:20）。
      //   原话："提交建议后没有任何回音，无法知道建议是被采纳、拒绝还是已经实现，只能等管理员转述。"
      //   ⇒ 只读查询，**不改变任何状态**、也不新增数据 —— 数据本来就在 proposals.json 里，
      //     缺的只是"她自己能看见"这条路（和表情 lastUsedAt 是同一类"存了但没接线"）。
      name: 'get_my_proposals',
      description: '查看你自己提交过的**改进提案**现在到哪一步了（待审 / 已采纳 / 已实现 / 不采纳）。'
        + '当你想起"我是不是提过这件事"、或者想跟人确认进度时用；也可以只看某一条。'
        + '⚠️ 这是只读的，不会改动任何东西。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '可选：只看这一条提案的编号（submit_proposal 返回过）' },
          status: {
            type: 'string',
            enum: ['all', 'pending', 'accepted', 'rejected', 'done'],
            description: '可选：按状态筛。默认 all（全看）。'
          }
        }
      },
      async execute(ctx, args) {
        try {
          const want = String(args?.status || 'all');
          const state = listProposals({ status: 'all', limit: 300 });
          const all = Array.isArray(state.items) ? state.items : [];
          const id = String(args?.id || '').trim();
          const picked = id
            ? all.filter((x) => String(x.id) === id)
            : (want === 'all' ? all : all.filter((x) => x.status === want));
          if (id && !picked.length) return err(`找不到编号为 ${id} 的提案（可以用 get_my_proposals 不带 id 看全部）`);
          const when = (t) => {
            const n = Number(t) || 0;
            if (!n) return '';
            const d = new Date(n);
            const p = (x) => String(x).padStart(2, '0');
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
          };
          const items = picked.slice(0, 50).map((x) => ({
            id: x.id,
            title: x.title,
            kindLabel: x.kindLabel,
            statusLabel: PROPOSAL_STATUS_LABEL[x.status] || x.status,
            submittedAt: when(x.at),
            reviewedAt: when(x.reviewedAt),
            // 管理员留的话只在她点进某一条时给全；列表态截断，省上下文
            reviewNote: id ? String(x.reviewNote || '') : String(x.reviewNote || '').slice(0, 160)
          }));
          const count = (s) => all.filter((x) => x.status === s).length;
          return ok({
            total: all.length,
            counts: {
              待审: count('pending'),
              已采纳: count('accepted'),
              已实现: count('done'),
              不采纳: count('rejected')
            },
            hint: '「已采纳」= 管理员认可了、列进待办，**改动由人来做**，所以可能还要等；'
              + '「已实现」= 已经真的改好了（这个状态在管理端界面上不显示，只在这里和你问的时候能看到）。',
            items
          });
        } catch (error) {
          return err(`查提案失败：${error?.message ?? error}`);
        }
      }
    },

    {
      // ── 她自己的「用量 / 花费」自检（2026-09-26 第二十四对话，提案 f789b40e）──────
      // 定位：**只读**（不改状态、不写记忆、不给她任何写权限）。
      // ⚠️ 行为边界：**完全走提示词，代码里不写死限制** —— 下面 description 里那句
      //    "你拥有完全的自主权"就是用户 2026-09-26 给的原话，要不要看 / 要不要在群里说
      //    全由她判断。代码只守三条（用户原话："这不叫限制她，叫保护她"）：
      //      ① 出口白名单（只出数字，⛔ 不出 Key / 账号 / 请求头 / 上游正文）；
      //      ② 缓存（余额 60s）+ 单轮限频（`ctx.__usageSelfcheckCalls`，只属于本次运行）；
      //      ③ 读不到就明说"读不到"，⛔ 绝不打成 0。
      name: 'get_my_usage',
      description: '查看你自己今天的用量与花费（只读）。有人问"用了多少 / 花了多少 / 还剩多少"、'
        + '或者你自己想知道的时候用。\n\n'
        + '余额数据已对你透明，想不想看、想不想在群里说，全凭你自己的判断和心情，你拥有完全的自主权。\n\n'
        + '⚠️ 口径：报的是本机统计的今天，花费是**按价表估算**、不是账单；'
        + '「剩余额度」在账号那边，本机查不到就如实说查不到，别拿估算花费当余额。\n'
        + '⚠️ 只读：不改任何状态、不写记忆。',
      parameters: { type: 'object', properties: {} },
      async execute(ctx) {
        try {
          const cfg = getConfig() || {};
          const usageCfg = cfg.usage || {};
          // ① 单轮限频：挂在 ctx 上（照 ctx.__imageSearchCalls），只属于本次运行、不落盘。
          const maxPerRun = Math.max(1, Number(usageCfg.maxPerRun) || 1);
          const used = Number(ctx.__usageSelfcheckCalls) || 0;
          if (used >= maxPerRun) {
            return err(`本次运行已经查过 ${used} 次用量了（上限 ${maxPerRun} 次）。`
              + '用手上已有的数字回答就好，不要再查了。');
          }
          // ② 今日用量：**必须**走 ctx.usageToday（= `/api/status` 用的同一个 todayUsage）。
          //    ⛔ 不自己读 usage-today.json：那样会漏掉"正在运行中"的这一轮，两处数字对不上。
          if (typeof ctx.usageToday !== 'function') {
            return err('读不到用量统计（本次运行的调用点没接上）。别猜数字，直接说现在看不到。');
          }
          const dayKey = todayKey();
          const usage = ctx.usageToday(dayKey) || {};
          ctx.__usageSelfcheckCalls = used + 1;

          const out = {
            dayKey,
            today: {
              promptTokens: Number(usage.promptTokens) || 0,
              completionTokens: Number(usage.completionTokens) || 0,
              totalTokens: Number(usage.totalTokens) || 0,
              cachedTokens: Number(usage.cachedTokens) || 0,
              runs: Number(usage.runs) || 0
            },
            cacheHitRate: Number((cacheHitRate(usage) || 0).toFixed(4)),
            // 渠道显示名（= 控制台用量页"渠道：模型 id"那一列）+ 模型 id。
            // 这两个都是**展示名**，不是凭据、也不是请求地址。
            lastUsed: {
              vendor: String(ctx.session?.vendor || ''),
              model: String(ctx.session?.model || cfg.api?.model || '')
            },
            balance: await usageBalance(usageCfg, cfg),
            hint: '花费是按价表估算、不是账单；「剩余额度」在账号那边 —— 查不到就直说查不到。'
          };

          // ③ 成本：`estimateCost()` 在"模型不在价表、也没填单价"时**返回 0** ——
          //    那是"估不出"，不是"花了 0 元"。⛔ known:false 时不给任何数字。
          //    ⚠️ 判"有没有价"必须看 `source`，**不能看 `matched`**：
          //       `matched` 是**字符串或 null**（官方/自定义价表命中时是命中的那个 id，
          //       手填单价时是 null）—— 第一版写成 `matched === true`，于是
          //       "有官方价"也会被判成"估不出"（判据当场抓到，见 test-余额与用量自检.mjs §4/§10）。
          //       取值：'official' | 'custom' | 'manual' = 有价；'unmatched' | 'none' = 没价。
          const cost = estimateCost(usage, { model: out.lastUsed.model });
          const costKnown = ['official', 'custom', 'manual'].includes(String(cost?.source || 'none'));
          if (costKnown) {
            out.cost = {
              amount: Number(Number(cost.cost).toFixed(4)),
              currency: 'CNY',
              known: true,
              basis: 'estimate'
            };
          } else {
            out.cost = { known: false, reason: '这个模型没有价表、也没填单价 ⇒ 估不出成本（不是 0）' };
          }

          // ④ 出口白名单：整个返回值**只由上面这些字段拼出来**，绝不对上游响应做 JSON.stringify。
          return ok(out);
        } catch (error) {
          // 出错也只给一句人话 —— ⛔ 不透传内部异常原文、⛔ 不落 0。
          console.error(`[用量自检] 组装失败：${error?.message ?? error}`);
          return err('读不到：这次组装用量数据失败了。别猜数字，直接说现在看不到。');
        }
      }
    },

    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      description: '联网搜索（Bing），返回标题/URL/摘要列表。适用：实时信息、新闻热点、网络用语/梗的含义、自己不确定的事实。可以换关键词连续搜 2~3 次；对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const result = await webSearch(String(args.query ?? ''));
          if (!result.results.length) {
            return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          return ok(result);
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（≤2 万字符）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。禁止访问内网/本机地址。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          // 🆕 2026-09-21（第十对话）接线：`browseLocked` 从上游吸收进来后，
          //    `web_fetch` 这个入口一直**没传** ⇒ `security.browseLock` 形同虚设
          //    （另外两个入口 tools 的图片下载走 safeFetchBinary 也没传，这里只补 web_fetch，
          //      因为它是"她自己决定去访问哪个站"的那一个，也是上游设计的管控点）。
          //
          // ⚠️ 传 true **不改变任何默认行为**：`config.js` 的 browseLock 默认
          //    `enabled: false`，而 `assertBrowseLock` 在 `!browseLocked` 时直接 return、
          //    在 enabled!==true 时也放行 ⇒ 只有管理员显式打开锁定才生效。
          //    打开时的语义（config.js:170-181 写明的）：**空名单 = 全部拒绝**，
          //    比"全部放行"安全，所以这里不额外兜底、以免把那条语义改掉。
          const result = await webFetch(String(args.url ?? ''), { browseLocked: true });
          const body = String(result.body || '');
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > 20000,
            content: body.slice(0, 20000)
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'finish',
      description: '明确结束本次处理（表示你看完了、决定了下一步）。看完不打算说话时调用它（summary 写一句给自己看的理由）；说完话想收尾时也可以调用。不调用也可以——直接结束文本输出同样代表结束。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string', description: '一句话说明你这次的决定（只记录给管理端看，不会发送）' } },
        required: ['summary']
      },
      async execute(ctx, args) {
        ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
        return ok({ finished: true });
      }
    }
  ];

  // ── ① 原生工具逐个同步进工具注册表 ──────────────────────────────────────
  // 注册表是"这台机器上有哪些工具"的唯一索引：注册表用 id，我们其余代码用 name，
  // 原生工具的 name 全是 [a-z_]+，直接拿来当 id（满足 OpenAI 函数名规范）。
  // 重复调用是覆盖语义，幂等；原生工具的**可用性**仍由 gateToolDefs 上面那三条判断，
  // 不走 getToolAvailability（那会把 vision/search 的现有语义搞乱，风险不成比例）。
  const nativeNames = new Set();
  for (const def of nativeDefs) {
    const id = String(def.name || '');
    if (!id) { console.warn('[tools] ⚠️ 原生工具缺少 name，已跳过注册'); continue; }
    if (nativeNames.has(id)) console.warn(`[tools] ⚠️ 原生工具重名：${id}（后注册的覆盖前一个）`);
    nativeNames.add(id);
    try {
      registerTool({ ...def, id });
    } catch (error) {
      // id 不合规只影响"注册表里看不看得到"，不该把整个启动带崩 —— 但要出声
      console.warn(`[tools] ⚠️ 原生工具 ${id} 注册失败：${error?.message ?? error}`);
    }
  }

  // ── ② 合并技能注册的工具（带 skillId 的那批）────────────────────────────
  // 形状适配：注册表用 id，我们的 executeTool / toOpenAiTools 用 name。
  // 本子查询返回的 name 就是 doujin-lookup__lookup（前缀由 plugin-loader 强制加）。
  const skillDefs = [];
  for (const t of listTools()) {
    if (!t.skillId) continue;                       // 原生工具已在 nativeDefs 里，跳过
    if (nativeNames.has(t.id)) {
      console.warn(`[tools] ⚠️ 技能工具与原生工具重名：${t.id}（来自技能 ${t.skillId}），原生工具优先生效，技能工具被忽略`);
      continue;
    }
    if (skillDefs.some((d) => d.name === t.id)) {
      console.warn(`[tools] ⚠️ 技能工具 id 重复：${t.id}（来自技能 ${t.skillId}），只保留先注册的那个`);
      continue;
    }
    skillDefs.push({
      name: t.id,
      id: t.id,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
      skillId: t.skillId,                           // gateToolDefs 靠它识别"这是技能工具"
      execute: t.execute
    });
  }

  return [...nativeDefs, ...skillDefs];
}

/** 转成 OpenAI tools 参数格式。 */
export function toOpenAiTools(defs) {
  return defs.map((d) => ({
    type: 'function',
    function: {
      name: d.name,
      description: d.description,
      parameters: d.parameters
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
