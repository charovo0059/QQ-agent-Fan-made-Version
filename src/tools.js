// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR } from './config.js';
import { normalizeMessageList, unquoteJsonString } from './util.js';
import { formatStickerList } from './stickers.js';
import { validateImageUrl, safeFetchBinary } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { searchImageSource, SELECTABLE_ENGINES } from './image-search.js';
import { expandForwardNodes, fetchForward, resolveFreshImageUrl } from './onebot.js';
import { firstFrameOnly, countFrames } from './gif.js';
// 工具注册表（Skills 基础设施，来自上游 0.3.1）：原生工具与技能工具都在这里登记，
// 技能工具（带 skillId）的可用性统一问 getToolAvailability()。
import { registerTool, listTools, getToolAvailability } from './tool-registry.js';
import { appendProposal, PROPOSAL_KINDS } from './proposals.js';
import { splitDreamText } from './dream.js';

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
 * 当前唯一的压缩手段：**动画 GIF 只留第一帧**（纯字节截断，见 gif.js）。
 * 其它格式（PNG/JPEG/WEBP）不改，超上限就明确拒绝 —— 宁可不发，也不能把整轮请求搞成 413。
 *
 * ⚠️ 传进来的 url 很可能是**已经过期的**存档链接（rkey 只有十几小时寿命）。
 * 只要能拿到 QQ 文件名，就先换一条新链接再下（见 onebot.js 的 resolveFreshImageUrl）。
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
  if (data.length > lim.bytes && mime === 'image/gif') {
    const one = firstFrameOnly(data);
    if (one && one.length < data.length) {
      const frames = countFrames(data);
      note = `动画表情，只取了第一帧（原 ${fmtBytes(data.length)}${frames > 1 ? ` / ${frames} 帧` : ''}）`;
      data = one;
    }
  }
  if (data.length > lim.bytes) {
    throw new Error(`图太大（${fmtBytes(data.length)}，上限 ${fmtBytes(lim.bytes)}）`);
  }
  return { dataUrl: `data:${mime};base64,${data.toString('base64')}`, note };
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
// 缓存键用 `entry.id` 而不是 QQ 文件名：QQ 收藏那 5 条**没有 file 字段**（31/36 才有）。
// 存成 `.bin`、不记扩展名 —— 服务时用 detectMime 嗅探魔数就够了，省一套索引。
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

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
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

/**
 * 本次唤醒是否"有人明确要求查图出处"。
 *
 * 两级判定：
 *   1. 本次唤醒的消息里有求出处的措辞 → 放行。
 *   2. 历史兜底：机器人**最近一条发言**就是在问"要我帮你查吗"，且之后有群友回过话
 *      → 视为对方同意了。这一条是为了让"先问一句再查"的路走得通：
 *      否则第一次被拦、模型问了、群友答"要"，第二次还是被拦，就死循环了。
 *      因为取的是"最近一条自我发言"，机器人一旦又说了别的话，这个授权就自动失效。
 */
function imageSearchWasAsked(ctx) {
  const trigger = String(ctx?.session?.triggerText || '');
  if (trigger && IMAGE_ASK_RE.test(trigger)) return true;
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
export function gateToolDefs(defs, cfg, { visionEnabled = true } = {}) {
  const searchEnabled = cfg?.webSearch?.enabled !== false;
  const imageSearchEnabled = cfg?.imageSearch?.enabled !== false;
  return defs.filter((d) => {
    // ① 原生工具：保持改造前那一套逐条判断，一个字都没动
    //    （回归 test-image-limits.mjs / test-doujin-lookup.mjs 直接验这三条）
    if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image')) return false;
    if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch')) return false;
    if (!imageSearchEnabled && d.name === 'search_image_source') return false;
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
    return true;
  });
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
          ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
          ctx.emit('session-update', ctx.session.id);
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), note: note.join('') });
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
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
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
        + '返回值里的 total/index/quotaLeft 会告诉你这条消息一共几张、这是第几张、本小时还能再收几张。',
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

          const saved = ctx.stickers.collect(args.messageId, {
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
            return ok({
              collected: false, reason: saved.reason, index, total: images.length,
              quotaLeft: saved.quotaLeft, id: saved.entry?.id ?? null, note: saved.entry?.localNote ?? '', message: `${where}：${why}`
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
          const safeUrl = await validateImageUrl(url);
          const { buffer, contentType } = await safeFetchBinary(safeUrl);
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
            fromOtherChats: cross.map((x) => ({ content: x.content, from: x.fromLabel, createdAt: x.createdAt })),
            note: 'fromOtherChats 是**别的会话**里记下的印象，只在那个场合说，别主动拿到这里提。'
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
          const result = await webFetch(String(args.url ?? ''));
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
