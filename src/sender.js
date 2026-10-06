// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime, toFileUri } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { resolveFreshImageUrl } from './onebot.js';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 🆕 2026-10-05（第四十三对话 · 交接 §3-112）：出站图片先在**我们这边**落成文件
//    （下载要带 Referer、要能压体积），见下面 `stageOutboundImage` 的大段注释。
import { safeFetchBinary } from './safe-fetch.js';
import { compressImage } from './image-compress.js';
import { detectImageType, mimeToExt } from './image-type.js';
// ⚠️ 只为拿本地表情缓存的路径（cachedStickerFilePath）。tools.js 不 import sender.js
//    ⇒ 不构成循环依赖（本轮实测确认过）。
// 🆕 2026-09-29（第三十对话）再加 `ensureStickerImage`：发送侧**自己补缓存**（见 sendSticker 的注释）。
//    同一次 import 里取两个，仍然没有循环依赖。
import { cachedStickerFilePath, ensureStickerImage } from './tools.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;
// 去重窗口的回退值也必须与 DEFAULT_CONFIG 一致（两处一致由 `测试-现行\test-发送去重.mjs` 钉住）。
const DEFAULT_DEDUPE_WINDOW_MS = DEFAULT_CONFIG.send.dedupeWindowMs;
// 🆕 2026-09-29（第三十对话）：发表情时"补本地缓存"那一步的超时上限。
// 为什么需要：本机表情缓存里单个 GIF 有 2~8MB，而这一步挂在**每会话串行**的发送链上
// ⇒ 服务器不响应就会把该会话后面所有出站都堵住。超时后放弃补缓存、走原远程链接那条路。
// 12 秒的依据：实测同一批图在本地缓存写入时"下载 + 落盘"是秒级，留一个数量级的余量。
export const STICKER_FILL_TIMEOUT_MS = 12000;

/**
 * 读"补缓存超时"的当前值。
 *
 * 为什么留一个可以改的钩子（而不是把常量写死在调用处）：那条超时路是
 * "**服务器不响应**"才走到的，而它的失效形态正是本项目最忌的**静默卡死**
 * （没人报错，整条会话的出站排在那里）。要给它写判据，就不能让判据真等 12 秒 ——
 * 判据跑一次要 12 秒，很快就会被后人从回归里摘掉，那时这条防线就名存实亡。
 * 所以：**生产路径读的就是这个函数**（默认值不变），判据临时改成一个小值来跑。
 */
let stickerFillTimeoutMs = STICKER_FILL_TIMEOUT_MS;
export function stickerFillTimeout() { return stickerFillTimeoutMs; }
/** 只给判据用：改这个值。生产路径不会调它。 */
export function __setStickerFillTimeoutForTest(ms) {
  stickerFillTimeoutMs = Math.max(1, Number(ms) || STICKER_FILL_TIMEOUT_MS);
}

// ── 出站图片：先落到本地，再交给协议端（2026-10-05 第四十三对话 · 交接 §3-112）────
//
// 🔴 为什么必须改（两个病一次治，证据链见 `分析-搜图发图超时与R18登录-20261005.md` §1/§2）：
//   ① **协议端下载没有 Referer**：`i.pximg.net` 不带 Referer 一律 403，而这个 Referer
//      **只有我们自己的 `safe-fetch` 会补**（`buildHeaders` 按 host 补，交接 §2.2 第 1 条）。
//      原来 `send_image` 是把 **URL 交给协议端**去下载的 ⇒ 她发 pximg 链接**必然失败**，
//      而界面上只看到一句"超时"（403 被协议端吞成了"卡住"）。
//   ② **15 秒来不及**（§3-111 已把这一档放宽到 60 秒，但让它少传几倍体积更根本）：
//      协议端要"先下载、再上传到 QQ"两段网络，1.9MB 原图必然超时。
//   ⇒ 形状：我们自己下（带 Referer）→ 必要时压 → **`file://` 交给协议端**（它只读盘、不出网）。
//
// ⚠️ 四条纪律（都别改回去）：
//   ① **下载失败就不发**（⛔ 别"退回把 URL 交给协议端"）—— 那正是要修的那条路，
//      退回去等于把"看得见的失败"换成"看不见的失败"。
//   ② **动图（GIF）不压**：`compressImage` 走 ffmpeg 重编码，动图会被拍成一张静图，
//      而那是**静默降级**（她以为发的是动图，对面看到的是静止的）。宁可原样发、慢一点。
//   ③ **临时文件发完就删**（`cleanup`，成功失败都删）：不留垃圾，也不让上一次的残图
//      被下一次读到。⚠️ 删的时机是"协议端返回之后" —— 那时的语义是"它已经把文件读走了"。
//   ④ **只压"确实需要压"的**：`compressImage` 自己会在 ≤512KB 时直接放过；
//      加上 `maxBytes`/`maxDim` 两道判据 ⇒ 小图**一个字节都不动**（不做"能压就顺手压一下"）。
//
// ⚠️ 顺带一句（别误读）：微信那条通道的桥（`工具-中继`）目前只对 `file`/`video` 段解析
//    `file://`，**图片段只认 `base64://` 与附件目录里的文件名** ⇒ 微信发图**本来就发不出去**
//    （它收到 http 链接也一样找不到文件）。这次改动**没有让它更坏**，但也没修好它；
//    要修得动中继的 `ob_protocol.py`（另一件事，已记进交接的待办）。
const OUTBOUND_IMAGE_MAX_BYTES = 24 * 1024 * 1024;      // 我们自己下载的字节上限
const OUTBOUND_COMPRESS_TARGET_BYTES = 2 * 1024 * 1024; // 超过它才压
const OUTBOUND_COMPRESS_MAX_DIM = 2048;                 // 压缩时的最长边（QQ 自己也会再缩一次）

/**
 * 把一张**远程图**先落成协议端能直接读的本地文件。
 *
 * @param {string} url 已经过公网校验的 http(s) 图片地址
 * @returns {Promise<{uri:string, bytes:number, originalBytes:number, compressed:boolean, cleanup:Function}>}
 *   `uri` 是 `file://…`；`cleanup()` 删临时文件（幂等）。
 * @throws 下载/写盘/路径任一环失败都抛错，**且消息里写明"没有发出去"**（交给模型如实回报）。
 */
export async function stageOutboundImage(url) {
  let buffer;
  let contentType;
  try {
    ({ buffer, contentType } = await safeFetchBinary(url, OUTBOUND_IMAGE_MAX_BYTES));
  } catch (error) {
    throw new Error(`发图前我们自己下载失败（这张图**没有**发出去）：${error?.message ?? error}`);
  }
  if (!buffer || !buffer.length) {
    throw new Error('发图前我们自己下载失败（这张图**没有**发出去）：内容是空的');
  }
  const sniffed = detectImageType(buffer);
  let out = buffer;
  let outMime = sniffed?.mime || String(contentType || 'image/jpeg').split(';')[0];
  let compressed = false;
  if (outMime !== 'image/gif') {   // 纪律②：动图不压
    const r = await compressImage(buffer, {
      maxDim: OUTBOUND_COMPRESS_MAX_DIM,
      maxBytes: OUTBOUND_COMPRESS_TARGET_BYTES,
      quality: 4
    });
    if (r?.compressed && r.buffer?.length && r.buffer.length < buffer.length) {
      out = r.buffer;
      outMime = r.mime || 'image/jpeg';
      compressed = true;
    }
  }
  const file = path.join(os.tmpdir(),
    `qqa_sendimg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${mimeToExt(outMime)}`);
  const cleanup = () => { try { fs.unlinkSync(file); } catch { /* 已经不在了就当删过 */ } };
  try {
    fs.writeFileSync(file, out);
  } catch (error) {
    cleanup();
    throw new Error(`发图前写本地临时文件失败（这张图**没有**发出去）：${error?.message ?? error}`);
  }
  const uri = toFileUri(file);
  if (!uri) {
    cleanup();
    throw new Error('发图前生成的本地路径不合法（这张图**没有**发出去）');
  }
  return { uri, bytes: out.length, originalBytes: buffer.length, compressed, cleanup };
}

let outboundImageStager = stageOutboundImage;

/**
 * 只给判据用：替换"下载 + 压缩 + 落临时文件"这一步。
 *
 * 为什么需要这个缝：那一步**要出网**（判据里不能连真图站），而它恰恰是本轮要钉住的
 * 那一步。与 `__setStickerFillTimeoutForTest` 同一套做法（生产路径不会调它）。
 * 传非函数 = 还原成真的实现（判据之间互不串味）。
 */
export function __setOutboundImageStagerForTest(fn) {
  outboundImageStager = typeof fn === 'function' ? fn : stageOutboundImage;
}

export class SendQueue {
  /**
   * @param registry 可选：按平台登记更多客户端，`{ bySource: { wechat: onebotClient } }`。
   *   为什么需要（2026-09-20 接入微信）：同一个控制台要同时管两个平台，
   *   而**发到哪个平台不能靠 chatKey 猜** —— 实测微信侧由桥派生的是**数字 id**
   *   （某群友 = 1000000001），形态与 QQ 号无法区分。
   *   ⇒ 由 `sourceOf(chatKey)`（store 记的来源）决定用哪个客户端。
   *   ⚠️ 不传 registry 时行为与以前**逐字节一致**（一律走 this.onebot）——
   *      这是为了不让 QQ 侧受这次改动影响。
   */
  constructor({ onebot, store, onSent = null, onSendError = null, registry = null, sourceOf = null }) {
    this.onebot = onebot;
    this.store = store;
    this.onSent = onSent;
    // 发送失败的回调（2026-09-19 第八对话新增）。
    // 用途：认群禁言 —— QQ 拒绝群发言时只回报 `result=120`，这是**不依赖任何事件转发**的兜底信号。
    // 见 src/mutes.js 顶部注释与 待办与决策记录.md §30。
    this.onSendError = onSendError;
    /** 平台客户端登记表：source -> OneBotClient */
    this.registry = registry && registry.bySource ? registry.bySource : {};
    /** 取某个会话属于哪个平台；由上层注入（通常就是 store.chatSource）。 */
    this.sourceOf = typeof sourceOf === 'function' ? sourceOf : null;
    this.chains = new Map();      // chatKey -> enqueue fn
    this.minuteTimes = new Map(); // chatKey -> [ts]
    this.hourTimes = new Map();   // chatKey -> [ts]
    // 🆕 2026-09-21（第十对话）：拍一拍限频的滑动窗口。
    //    chatKey -> [ts]，以及 chatKey -> Map(targetUserId|'self' -> [ts])。
    //    为什么用 Map 而不是写进 store：这是**发送侧的自我保护**、不是需要持久化的业务数据；
    //    重启后窗口清空是可以接受的（重启本身也意味着隔了一段时间）。
    this.pokeTimes = new Map();        // chatKey -> [ts]
    this.pokeTargetTimes = new Map();  // chatKey -> Map(target -> [ts])
    // 🆕 2026-09-25（第十八对话 · 交接 §3 待办 5）：发送去重窗口。
    //    "chatKey::文本" -> ts。移植自上游 0.4 的 `sender.js`（同一份 8 秒窗口的语义），
    //    只搬"文本去重"这一件 —— 上游整份 sender.js **不能整体替换**（构造函数不兼容，
    //    会砸掉微信通道 / 认群禁言 / 拍一拍限频，见待办 5 的边界）。
    this.recentSent = new Map();
  }

  /**
   * 选出发送用的客户端。
   * 只有"登记了该平台"且"这个会话确实属于该平台"时才换；
   * 其它情况一律回落到默认客户端 ⇒ 未接入微信时行为不变。
   */
  clientFor(chatKey) {
    try {
      const src = this.sourceOf ? this.sourceOf(chatKey) : null;
      if (src && this.registry[src]) return this.registry[src];
    } catch { /* 取来源失败就用默认，不让发送因此失败 */ }
    return this.onebot;
  }

  #chain(chatKey) {
    if (!this.chains.has(chatKey)) this.chains.set(chatKey, createSendChain());
    return this.chains.get(chatKey);
  }

  #checkRate(chatKey) {
    const now = Date.now();
    const cfg = getConfig().send;
    const minute = (this.minuteTimes.get(chatKey) || []).filter((t) => now - t < 60000);
    const hour = (this.hourTimes.get(chatKey) || []).filter((t) => now - t < 3600000);
    // 回退值必须与 config.js 的默认值一致（80）。此前这里是 8，
    // 配置缺失/为 0 时限频突然收紧 10 倍，行为不可预测。
    if (minute.length >= Math.max(1, Number(cfg.maxPerMinute) || DEFAULT_MAX_PER_MINUTE)) {
      throw new Error(`发送频率超限（每分钟最多 ${cfg.maxPerMinute || DEFAULT_MAX_PER_MINUTE} 条），请等一会再发`);
    }
    if (hour.length >= Math.max(1, Number(cfg.maxPerHour) || DEFAULT_MAX_PER_HOUR)) {
      throw new Error(`发送频率超限（每小时最多 ${cfg.maxPerHour} 条）`);
    }
    minute.push(now);
    hour.push(now);
    this.minuteTimes.set(chatKey, minute);
    this.hourTimes.set(chatKey, hour);
  }

  /**
   * 发送去重：同一会话短时间内**完全相同**的文本只发一次（2026-09-25 第十八对话，
   * 移植上游 0.4 `sender.js` 的 #dedupeWindow / #isDuplicate / #markSent）。
   *
   * 背景（重复发言的根因之一）：模型在一次会话里可能重复调用 send_message 传入相同内容
   * （内联工具调用解析 + 原生 tool_calls 并存时尤其如此），或 OneBot 超时看似失败、
   * 上层重试再发一遍 ⇒ 用户看到一模一样的两条。
   *
   * ⚠️ 去重是**按发出去的纯文本**（mdToPlain 之后、切分之后的每一段）比对的，
   *    不是按模型的原话 —— 否则"只差一个标点"就绕过去了。
   */
  #dedupeWindow() {
    let raw;
    try { raw = getConfig().send?.dedupeWindowMs; } catch { return DEFAULT_DEDUPE_WINDOW_MS; }
    // 0 是明确的**关闭**值，不能用 `|| 默认` 把它误当缺省（这正是本项目反复记过的那类坑）。
    if (raw === null || raw === undefined || raw === '') return DEFAULT_DEDUPE_WINDOW_MS;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_DEDUPE_WINDOW_MS;
    // ⚠️ 与上游**有意不同的一处**：上游是 `Math.max(0, n)` ⇒ 负值会被悄悄夹成 0（= 关掉去重），
    //    于是一个手抖打出来的 `-1` 会**静默关掉这道防线**。这里改成"负值 = 没填好" ⇒ 回落默认。
    //    `0` 仍然是明确的关闭（那条路径不受影响）。
    return n >= 0 ? n : DEFAULT_DEDUPE_WINDOW_MS;
  }

  /**
   * 只读判断：窗口期内是否已发出过**相同**内容。
   * ⚠️ 绝不在发送前记账 —— 发送失败（OneBot 报错 / 限频）的消息必须允许重发，
   *    提前记账会把合法重试误判成重复、导致消息**静默丢失**。
   */
  #isDuplicate(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return false;
    const last = this.recentSent.get(`${chatKey}::${String(text)}`);
    return Boolean(last && Date.now() - last < win);
  }

  /** 发送成功后才记账（去重指纹）。 */
  #markSent(chatKey, text) {
    const win = this.#dedupeWindow();
    if (!win) return;
    const now = Date.now();
    this.recentSent.set(`${chatKey}::${String(text)}`, now);
    // 顺手清理过期条目，避免 Map 无限增长（发送是热路径，不能每轮全扫）
    if (this.recentSent.size > 500) {
      for (const [k, t] of this.recentSent) {
        if (now - t > win) this.recentSent.delete(k);
      }
    }
  }

  #gap(text, isLast) {
    const cfg = getConfig().send;
    const min = Math.max(200, Number(cfg.minGapMs) || 1000);
    const max = Math.max(min, Number(cfg.maxGapMs) || 3000);
    if (isLast) return 0;
    const byLength = Math.min(8000, (String(text || '').length) * (Number(cfg.byLengthMs) || 20));
    return Math.min(15000, Math.max(min, randInt(min, max) * 0.5 + byLength * 0.5));
  }

  /**
   * 发送一批文本消息（一条或多条）。
   * options: { replyToMessageId, atUserId, origin }
   *   `origin`（2026-09-26 第二十四对话，提案 57e7ab37）：`'self'`（默认，她自己说的）
   *   或 `'admin'`（**管理端代发**，如群发通知 / 测试发送）。它只影响**记账**：
   *   成功那条会带上 `origin:'admin'`，她看上下文时就能分清"这句不是我说的"。
   * 返回 { sent: [{text, messageId}], failed: [{text, error}] }；全部失败时抛错。
   */
  async sendTextBatch(chatKey, messages, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') throw new Error(`非法会话 key：${chatKey}`);
    const list = Array.isArray(messages) ? messages : [messages];
    if (!list.length) throw new Error('消息列表为空');
    const hardSplitAt = Number(getConfig().send?.hardSplitAt) || 0;
    const parts = [];
    for (const m of list) {
      const plain = mdToPlain(String(m ?? ''));
      if (!plain) continue;
      // 最后防线：任何上游畸形路径漏下来的 "[object Object]" 到这儿直接拦掉，
      // 用户永远不该在 QQ 里看到这串字符。全被拦 → 下方抛"消息内容为空"回给模型。
      if (/^\[object Object\]$/.test(plain)) continue;
      if (hardSplitAt > 0 && plain.length > hardSplitAt) parts.push(...splitForQQ(plain, hardSplitAt));
      else parts.push(plain);
    }
    if (!parts.length) throw new Error('消息内容为空');

    const chain = this.#chain(chatKey);
    // 按会话来源选客户端（不传 registry 时就是 this.onebot，行为不变）
    const client = this.clientFor(chatKey);
    // 多平台之后"发错平台"是最难查的一类错（两边都报成功、对方却没收到）。
    // 默认只在**真的换了平台**时记一行；想看每次选择就把 send.verboseRoute 打开。
    // ⚠️ 不要改成无条件 console.log：发送是热路径，QQ 侧每次发消息都会走到这里。
    const routeLog = getConfig().send?.verboseRoute === true;
    const viaDefault = client === this.onebot;
    if (routeLog || !viaDefault) {
      let src = '(未配来源)';
      try { src = this.sourceOf ? this.sourceOf(chatKey) : src } catch { src = '(取来源出错)' }
      console.log(`[sender] ${chatKey} → 发往平台 ${viaDefault ? 'default' : src}`
        + `（${viaDefault ? '默认客户端' : 'registry 命中'}，http=${client?.httpUrl || '?'}）`);
    }
    const promises = [];
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      const isLast = i === parts.length - 1;
      const gap = this.#gap(text, isLast);
      promises.push(chain(async () => {
        this.#checkRate(chatKey);
        if (gap > 0) await sleep(gap);
        // 发送去重：窗口期内 identical 文本直接跳过（防模型重复调用 / 超时重试造成的重复发言）。
        // 返回 `deduped: true` 而不是抛错 —— 这不是失败，是"这条本来就不该再发一次"。
        if (this.#isDuplicate(chatKey, text)) {
          console.warn(`[sender] 跳过重复消息（${this.#dedupeWindow()}ms 内已发过相同内容）：${String(text).slice(0, 30)}`);
          return { text, messageId: null, at: formatClockTime(Date.now()), deduped: true };
        }
        const data = await client.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        // ⚠️ 顺序要紧：**只有** OneBot 成功返回之后才记入去重窗口。
        this.#markSent(chatKey, text);
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null, origin: options.origin || 'self' });
        this.onSent?.({ chatKey, text, messageId: data?.message_id ?? null });
        return { text, messageId: data?.message_id ?? null, at: formatClockTime(ts) };
      }));
    }

    const settled = await Promise.allSettled(promises);
    const sent = [];
    const failed = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled') sent.push(r.value);
      // 带上 index 和原文：调用方需要知道"哪一条"失败了（才能重发或告知模型）。
      // 原先 failed 里只有 error，没有任何定位信息。
      else {
        const errText = String(r.reason?.message ?? r.reason);
        failed.push({ index: i, text: parts[i], error: errText });
        // 通知上层（认群禁言用；回调自身出错不能影响发送结果）
        try { this.onSendError?.({ chatKey, text: parts[i], error: errText }); } catch { /* ignore */ }
      }
    }
    // 部分成功也要让调用方知道：原先只在"全败"时抛错，部分成功会静默丢消息
    if (failed.length > 0) {
      const detail = failed.map((f) => `第${f.index + 1}条「${String(f.text).slice(0, 20)}」：${f.error}`).join('；');
      if (sent.length === 0) throw new Error(detail);
      console.warn(`[sender] 部分发送失败（${failed.length}/${parts.length}）：${detail}`);
    }
    return { sent, failed };
  }

  /**
   * 发一张**图片**（独立气泡；不能附带文字 —— 想说的话先用 `sendTextBatch` 单独发）。
   *
   * 🆕 2026-09-25（第十八对话 · 交接 §3 待办 1 的选项 B）：这是"按关键词搜图并发出来"
   *   那条链路的**出口**。移植上游 0.4 `sender.js` 的 `sendImage`，但按我们的既有形状写：
   *   · 与文字**共享同一套限频**（图比文字更容易刷屏，不能另开配额）；
   *   · 按 **URL 指纹**去重（模型可能对同一个链接连发两次），走的是本文件已有的 `#isDuplicate/#markSent`；
   *   · **发成功后才记账**，失败必须允许重发；
   *   · **留档**（`[图片]`）—— 不留档的话下一轮她不知道自己发过图，会重复发。
   *
   * ⚠️ 去重放在限频**之前**：被去重的那条根本没发出去，不该吃掉发送配额。
   *    （`sendTextBatch` 那边是"先限频后去重"，因为文字那条路要先把间隔算出来；这里没有间隔，
   *      顺序按"先判要不要发"更合理。）
   *
   * 🆕 2026-10-05（第四十三对话 · 交接 §3-112）：**交给协议端的不再是这个 URL，而是一个 `file://`**
   *    —— 我们先自己下下来（`safeFetchBinary` 会补 `i.pximg.net` 要的 Referer）、
   *    必要时压一下、落成临时文件。理由与四条纪律见 `stageOutboundImage` 上面那一大段。
   *    ⚠️ 去重仍按**原始 URL**记账（`dedupeKey`），而且排在下载**之前**：被判重的那条
   *    一次网络都不该发生。`onSent.image` 也仍然是原始 URL（"她发的是这张图的哪个地址"）。
   *
   * @param {string} imageUrl 公网 http(s) 链接（内部会落成本地文件再发），**或** `file://` 本地路径
   *   （调用方负责合法性校验；本地路径直接交给协议端，不再下载）
   * @param {object} options { note, replyToMessageId, atUserId }
   */
  sendImage(chatKey, imageUrl, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    if (kind !== 'group' && kind !== 'private') return Promise.reject(new Error(`非法会话 key：${chatKey}`));
    const url = String(imageUrl ?? '').trim();
    if (!url) return Promise.reject(new Error('图片地址为空'));
    const chain = this.#chain(chatKey);
    const client = this.clientFor(chatKey);
    const dedupeKey = `__img__${url}`;
    return chain(async () => {
      if (this.#isDuplicate(chatKey, dedupeKey)) {
        console.warn(`[sender] 跳过重复图片（${this.#dedupeWindow()}ms 内已发过同一张）：${url.slice(0, 60)}`);
        return { message_id: null, deduped: true };
      }
      this.#checkRate(chatKey);
      // 🔴 先落本地（下载 → 必要时压 → 临时文件）。失败会抛，**不会**退回"把 URL 交给协议端"。
      // ⚠️ 但**调用方直接给本地路径**时不再下载 —— 本函数的文档一直写着
      //    "公网 http(s) 链接，**或 `file://` 本地路径**"，本次改动**不该把它收窄**。
      //    （真机第一次跑就踩到：探针把 stage 好的 `file://` 又喂了进来，报的是
      //     "下载失败：仅允许 http/https" —— 而那张图其实已经好好地在本机了，
      //     那句话会把人引到完全错误的方向。）
      const alreadyLocal = /^file:/i.test(url);
      const staged = alreadyLocal
        ? { uri: url, bytes: null, originalBytes: null, compressed: false, cleanup() {} }
        : await outboundImageStager(url);
      try {
        await sleep(randInt(500, 1300));   // 发图前真人式的短暂停顿
        const data = await client.sendImage(kind, id, staged.uri, {
          replyToMessageId: options.replyToMessageId ?? null,
          atUserId: options.atUserId ?? null
        });
        this.#markSent(chatKey, dedupeKey);   // 只有协议端成功返回后才记账
        const ts = Date.now();
        const note = options.note ? `:${String(options.note).slice(0, 40)}` : '';
        this.store.appendSelf(chatKey, { text: `[图片${note}]`, ts, mid: data?.message_id ?? null });
        this.onSent?.({ chatKey, text: `[图片${note}]`, messageId: data?.message_id ?? null, image: url });
        return {
          message_id: data?.message_id ?? null,
          // 如实带上"发出去的那份有多大"（工具层据此告诉她"这张图被压过"，见 tools.js 的 send_image）
          sentBytes: Number(staged.bytes) || null,
          originalBytes: Number(staged.originalBytes) || null,
          compressed: staged.compressed === true
        };
      } finally {
        // 协议端已经返回 ⇒ 它把文件读走了 ⇒ 删掉（失败路径同样删，不留残图）
        try { staged.cleanup?.(); } catch { /* 删不掉不该影响发送结果 */ }
      }
    });
  }

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      // ⚠️ 存下来的 url 里 rkey 只有十几个小时寿命，直接发会失败（实测 download url has expired）。
      // ── 🆕 2026-09-23（第十二对话）：改成**两条路，本地缓存优先** ──────────────
      // 为什么：`file` 字段在本机**38 张全是空串** ⇒ `resolveFreshImageUrl` 换不到新链，
      //   只剩"把过期 URL 交给 OneBot 让它去下载"这一条 ⇒ `retcode=100 ... 404`（当天 7 次）。
      //   而本地 `data/stickers/<id>.bin` 缓存有 16/38 张，过去**只有控制台缩略图与模型看图在用**。
      // ① 本地缓存 → 给 OneBot 一个 `file://` 路径，它不必去 QQ 下载，**绕开 rkey 过期**；
      // ② 换新链 → 本地没有缓存时才走（= 原来的唯一路径）。
      // ⚠️ 两条都留：① 依赖 OneBot 接受 `file://`（不是协议强制项），② 在 file 字段还在时仍然有效。
      const pickOpts = {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      };
      // 🆕 2026-10-06（第四十七对话 · 与 B4 同一条）：**按会话来源选客户端**。
      //    原来下面三处都写 `this.onebot`（= 默认的 QQ 通道）⇒ 在**微信会话**里"发表情"
      //    会把请求发到 QQ 上（**发错平台**）。`clientFor()` 取不到来源时仍回落默认客户端
      //    ⇒ QQ 侧行为**逐字不变**。
      //    ⚠️ 下面那两处**取图字节**的调用（`ensureStickerImage` / `resolveFreshImageUrl`）
      //       继续用 `this.onebot` —— 那是从图床下载，与"发给哪个平台"无关。
      const client = this.clientFor(chatKey);
      const cached = cachedStickerFilePath(sticker);
      let data = null, lastErr = null;
      if (cached) {
        try {
          data = await client.sendSticker(kind, id, pathToFileURL(cached).href, pickOpts);
        } catch (error) {
          lastErr = error;
          console.error(`[sender] 发表情：走本地缓存失败（${error?.message ?? error}），改用远程链接重试`);
        }
      }
      // ── 🆕 2026-09-29（第三十对话）：**缓存没命中时，发送侧自己补一次缓存** ──────────
      // 🔴 为什么必须补（线上实测，不是推测）：原实现只在"缓存**已经**存在"时走本地那条路，
      //    而**缓存从来不会在发送路径上被填充** —— 它只由控制台缩略图（`/api/stickers/<id>/image`）
      //    与 `get_sticker_image`（模型看图）顺手写下来。于是"模型选中一张**从没被看过**的表情"
      //    ⇒ 无缓存 + `get_image` 换不到新链（ai 收藏那批靠的是 QQ 侧临时缓存，会过期）
      //    ⇒ 把存下来的死链接交给 OneBot 去下载 ⇒ `retcode=100 HTTP download failed: 404`。
      //
      // 数据（扫全部会话存档 + `data/stickers.json`，2026-09-29）：
      //    · **成功发出 34 次，全部是"有本地缓存"的（含 2 次 ai 来源）**；
      //    · **失败 27 次，全部是"没有本地缓存"的**（22 张 ai 收藏 + 早期几次）；
      //    · 库 43 条里只有 21 条有缓存 ⇒ 剩下 22 条**每次发都注定失败**。
      //   ⇒ 结论很硬：**本地缓存那条路是好的，坏的是"没人去填它"**。
      //
      // 做法：复用既有的 `ensureStickerImage`（它内部 = 先读缓存 → 换新链 → `safeFetchBinary`
      //   下载 → **顺手写进 data/stickers/**）⇒ 补完之后**再取一次路径**，就落进上面那条
      //   "已经证明能用"的分支。
      // ⚠️ 四条分寸（都别改）：
      //   ① `ensureStickerImage` **自己会先读缓存** ⇒ 真命中时它是纯本地、零网络，不会白下；
      //   ② 它**失败不能中断发送** ⇒ 整个包在 try/catch 里，原样落到下面的远程链接那条路
      //      （退化成改动前的行为，不会更糟）；
      //   ③ `cachedStickerFilePath` 是**真去 existsSync** 的 ⇒ 下载没落盘也不会拿到空路径；
      //   ④ 🆕 **必须带超时**：这一步是"发消息之前先下载 2~8MB"，而它挂在**每会话串行**的发送链上
      //      ⇒ 服务器不响应时会把这条会话后面**所有**的出站都堵住。超时就放弃补缓存、
      //      走原来的远程那条路（宁可这一次发不出去，也不能把会话卡死）。
      let fillErr = null;
      if (!data && !cached) {
        try {
          await Promise.race([
            ensureStickerImage(this.onebot, sticker),
            new Promise((_, rej) => {
              // ⚠️ 定时器**保持 ref**（不许 unref）：unref 过的定时器在事件循环没别的活时不会触发，
              //    那会让这条 race 永不 settle（本项目 2026-09-29 刚踩过，见经验库 promise-unref-13-fail）。
              const limit = stickerFillTimeout();
              const t = setTimeout(() => rej(new Error(`补缓存超时（${limit}ms）`)), limit);
              if (typeof t.ref === 'function') t.ref();
            })
          ]);
          const filled = cachedStickerFilePath(sticker);
          if (filled) {
            try {
              data = await client.sendSticker(kind, id, pathToFileURL(filled).href, pickOpts);
            } catch (error) {
              lastErr = error;
              console.error(`[sender] 发表情：补完缓存后仍然发送失败（${error?.message ?? error}），改用远程链接重试`);
            }
          }
        } catch (error) {
          fillErr = error;   // 补缓存失败：只记原因，不打断（下面还有远程那条路）
        }
      }
      if (!data) {
        const { url: sendUrl } = await resolveFreshImageUrl(this.onebot, { url: sticker.url, file: sticker.file });
        if (!sendUrl) throw lastErr || new Error('发表情失败：本地缓存与远程链接都没有可用的图片');
        try {
          data = await client.sendSticker(kind, id, sendUrl, pickOpts);
        } catch (error) {
          lastErr = error;
        }
      }
      if (!data) {
        // 两条都失败 ⇒ 把**每条路各自的失败原因**都说出来，别只报最后一条
        // （否则永远查不出是哪条坏）。补缓存那一环的失败原因单独带上。
        throw new Error(`发表情失败（本地缓存${cached ? '有但发送失败' : '不存在'}`
          + `、远程链接也不可用${fillErr ? `；补缓存也失败：${fillErr?.message ?? fillErr}` : ''}）：`
          + `${lastErr?.message ?? lastErr}`);
      }
      const ts = Date.now();
      this.store.appendSelf(chatKey, { text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[表情包]`, messageId: data?.message_id ?? null, sticker: sticker.id });
      return { message_id: data?.message_id ?? null };
    });
  }

  /** 拍一拍。发送成功后留档（self 记录），否则下一次运行不知道自己拍过。 */
  poke(chatKey, targetUserId) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      // 🆕 2026-09-21（第十对话）：限频。放在**这里**而不是 send_poke 工具里，
      //    因为 poke() 是**所有**发送路径的必经点（工具、以后可能的主动行为），
      //    只拦工具那条路等于留个后门。
      //    ⚠️ 放在 chain 内部：chain 是每会话串行的，这样"查窗口→计数"不会有竞态。
      //    超限时**抛错**（与文件顶部写明的既有惯例一致："超限直接拒绝，
      //    工具会把错误告诉模型"）—— 不静默丢弃，否则她会以为自己拍过了。
      this.#assertPokeAllowed(chatKey, targetUserId);
      await sleep(randInt(300, 900));
      // 🆕 2026-10-06（第四十七对话 · 用户拍板 B4）：**按会话来源选客户端**，与 sendText/sendImage 同一口径。
      //    原来这里写的是 `this.onebot`（默认客户端 = QQ 那条通道）⇒ 在**微信会话**里拍一拍会
      //    拿微信那边的数字 id 当 QQ 号打到 **QQ 客户端**上 —— 那是"**发错平台**"，比"不支持"严重。
      //    （`clientFor()` 取不到来源时仍回落到默认客户端，所以 QQ 侧行为**逐字不变**。）
      const client = this.clientFor(chatKey);
      const data = await client.sendPoke(kind, id, targetUserId);
      const ts = Date.now();
      this.#recordPoke(chatKey, targetUserId, ts);
      const target = kind === 'group' && targetUserId != null ? ` ${targetUserId}` : '对方';
      this.store.appendSelf(chatKey, { text: `[拍一拍] 你拍了拍${target}`, ts, mid: data?.message_id ?? null });
      this.onSent?.({ chatKey, text: `[拍一拍]${target}`, messageId: null });
      return data;
    });
  }

  /** 拍一拍限频的窗口长度与两个上限（都从 config 现读，改设置不用重启）。 */
  #pokeLimits() {
    let c = {};
    try { c = getConfig()?.send?.poke || {}; } catch { /* 读不到就用下面的默认 */ }
    const num = (v, d) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : d;
    };
    return {
      windowMs: 10 * 60 * 1000,
      // 默认值写在这里，同时 config.js 的 DEFAULT_CONFIG.send.poke 也有一份 ——
      // 两处一致由 test-poke限频.mjs 钉住（那个测试直接 import config 比对）。
      maxPerChat: num(c.maxPerChatPer10Min, 3),
      maxPerTarget: num(c.maxPerTargetPer10Min, 2)
    };
  }

  #prunePokes(arr, now, windowMs) {
    return (arr || []).filter((t) => now - t < windowMs);
  }

  #assertPokeAllowed(chatKey, targetUserId) {
    const { windowMs, maxPerChat, maxPerTarget } = this.#pokeLimits();
    const now = Date.now();
    if (maxPerChat > 0) {
      const hist = this.#prunePokes(this.pokeTimes.get(chatKey), now, windowMs);
      this.pokeTimes.set(chatKey, hist);
      if (hist.length >= maxPerChat) {
        throw new Error(describePokeLimit('chat', maxPerChat, hist[0] + windowMs));
      }
    }
    const key = targetUserId == null ? 'self' : String(targetUserId);
    if (maxPerTarget > 0) {
      const perTarget = this.pokeTargetTimes.get(chatKey) || new Map();
      const hist = this.#prunePokes(perTarget.get(key), now, windowMs);
      perTarget.set(key, hist);
      this.pokeTargetTimes.set(chatKey, perTarget);
      if (hist.length >= maxPerTarget) {
        throw new Error(describePokeLimit('target', maxPerTarget, hist[0] + windowMs));
      }
    }
  }

  #recordPoke(chatKey, targetUserId, ts) {
    const list = this.pokeTimes.get(chatKey) || [];
    list.push(ts);
    this.pokeTimes.set(chatKey, list);
    const perTarget = this.pokeTargetTimes.get(chatKey) || new Map();
    const key = targetUserId == null ? 'self' : String(targetUserId);
    const tl = perTarget.get(key) || [];
    tl.push(ts);
    perTarget.set(key, tl);
    this.pokeTargetTimes.set(chatKey, perTarget);
  }
}

/**
 * 把"拍不成了"说成一句**对模型说**的话（不是给用户看的）。
 *
 * 为什么要单独写：这句话会被 `send_poke` 工具原样回给模型，用词会直接影响她怎么处理
 * （是"换个方式表达"还是"反复重试"）。所以：
 *   · 说清是**限频**、不是坏掉（否则她会以为工具出错而重试）；
 *   · 给出"过多久可以再来"，让她能自己判断要不要等；
 *   · 提醒"这次没拍成"，避免她把没发生的事当成发生了（本项目最忌静默失败）。
 * ⚠️ 措辞归 K3 的地盘只限于**人设/系统提示词**；这一句是工具返回的错误信息
 *    （等同于 `errUnsaved` 那一类内部文案），所以留在工程侧。
 */
export function describePokeLimit(scope, max, nextAllowedAt) {
  const wait = Math.max(1, Math.round((nextAllowedAt - Date.now()) / 60000));
  const who = scope === 'target' ? '对同一个人' : '在这个会话里';
  return `拍一拍被限频拦下了：${who} 10 分钟内最多 ${max} 次，还要等约 ${wait} 分钟。`
    + '**这次没有拍出去**，别当成已经拍了；也不用重试，过一会儿自然就好了。';
}
