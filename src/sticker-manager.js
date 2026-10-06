// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import fs from 'node:fs';
import path from 'node:path';
import { OneBotClient } from './onebot.js';
import { getConfig, DATA_DIR } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary, removeSticker,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed, contentHashOfUrl,
  lookupSticker,
  refreshStickerSource
} from './stickers.js';
// 🆕 2026-09-29（第三十一对话）§3-26：**收藏那一刻就把字节缓存下来** ⇒ 复用 tools.js 的
// `ensureStickerImage`（内部 = 先读缓存 → 换新链 → 下载 → 顺手写进 `data/stickers/`）。
// ⛔ 不新写第二份下载器/缓存器（那会变成两个口径，迟早分家）。
// ⚠️ 循环依赖核查（与 `sender.js` import tools.js 同一个形状，那边已实测确认无环）：
//    本仓库里 import `sticker-manager.js` 的**只有** `app.js`；`tools.js` 不 import 它。
import { ensureStickerImage } from './tools.js';

// 🆕 2026-09-29（第三十一对话）：收藏时"补本地缓存"那一步的超时上限。
// 为什么需要：这一步是"收藏之后立刻去下 2~8MB 原图"，而它挂在**模型的工具调用**那一环
// ⇒ 服务器不响应时那次工具调用会一直挂着（模型在等它回来）。
// 12 秒的依据与 `sender.js` 的 `STICKER_FILL_TIMEOUT_MS` 同源：实测本地缓存"下载 + 落盘"是秒级，
// 留一个数量级的余量。
// ⚠️ 与 `sender.js` 那个**有意各留一份、不合并**：两者的爆炸半径不同（那个堵的是**每会话串行**的
//    发送链，这个堵的是**一次工具调用**），值以后也可能分道扬镳；而合并要动 `sender.js`
//    —— 它上一轮刚被 25 条断言 + 变异钉住，为省这 8 行不值得冒那个险。
export const COLLECT_FILL_TIMEOUT_MS = 12000;
let collectFillTimeoutMs = COLLECT_FILL_TIMEOUT_MS;
/** 读"收藏时补缓存超时"的当前值（**生产路径读的就是它**）。 */
export function collectFillTimeout() { return collectFillTimeoutMs; }
/** 只给判据用：改这个值。生产路径不会调它。
 *  为什么要有这个钩子：那条超时路是"服务器不响应"才走到的，而它的失效形态正是本项目最忌的
 *  **静默卡死**。要给它写判据就**不能让判据真等 12 秒** —— 否则那 12 秒会被后人当成"太慢"
 *  而从回归里摘掉，那时这条防线就名存实亡。（与 `sender.js` 的 `__setStickerFillTimeoutForTest` 同一理由。） */
export function __setCollectFillTimeoutForTest(ms) {
  collectFillTimeoutMs = Math.max(1, Number(ms) || COLLECT_FILL_TIMEOUT_MS);
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  /**
   * 🆕 2026-10-06（第四十七对话 · 用户拍板 B3①）：**没有"表情包总开关"了**。
   * 用户原话："表情属于聊天系统，随便她发" ⇒ 这道闸**已废弃**（`config.sticker.enabled` 不再被读）。
   * ⚠️ 这里是**唯一**读那个键的地方之一（另两处在 `prompt.js` / `orchestrator.js`，也都删了）；
   *    老 config.json 里残留的 `enabled:false` **一律视为开**。
   * ⛔ 别再把这个 getter 加回来当开关用 —— 要限制她发什么，走 `collectEnabled`（收藏）或平台判断。
   */

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit);
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  /**
   * 🆕 2026-10-06（第四十七对话）：带"为什么没命中"的解析结果 —— `send_sticker` 报错要用。
   * ⚠️ `find` 与 `lookup` 是**两件事**，别合并：`find` 是老口径（只认 id/md5/url，
   *    `note`/`remove`/`markUsed` 这些走在 id 上的路径都靠它保持逐字不变），
   *    `lookup` 多一层"按名字查"（她真的会传名字，实测 30/30 全失败）。
   */
  async lookup(ref) {
    const synced = await this.sync(false);
    return lookupSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /**
   * 从本地表情库删除一条（管理端「表情包」页用）。
   * 规则见 stickers.js 的 removeSticker：**QQ 收藏的不让删**。
   *
   * 删掉的条目会往 data/stickers-removed.json 追加一条（保留最近 200 条）——
   * AI 收藏的表情里那些备注/标签是模型看图后写下来的，删错一次就白写了，
   * 留一份能捞回来。这个文件不参与任何逻辑，纯留档。
   */
  remove(id) {
    const result = removeSticker(this.entries, id);
    if (!result.removed) return result;
    this.entries = result.entries;
    saveStickerStore(this.entries);
    try {
      const file = path.join(DATA_DIR, 'stickers-removed.json');
      let log = [];
      try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次 */ }
      if (!Array.isArray(log)) log = [];
      log.push({ removedAt: new Date().toISOString(), ...result.entry });
      if (log.length > 200) log = log.slice(-200);
      fs.writeFileSync(file, JSON.stringify(log, null, 1), 'utf8');
    } catch { /* 留档失败不影响删除本身 */ }
    return result;
  }

  /**
   * 🆕 2026-09-29（第三十一对话）§3-26：**收藏那一刻就把字节存到本地**（表情包真正的根治）。
   *
   * 🔴 为什么这是"根治"（前一轮只治了症状）：第三十对话修的是**发送路径**
   *   （`sender.sendSticker` 缓存没命中时自己补一次），那让"以后发"能自愈，
   *   但**救不了已经死掉的** —— 真机核对：22 条没缓存的表情里只有 2 条还能换到新链，
   *   另外 20 条连 QQ 侧缓存都没了。那 20 张**在收藏那一刻就注定要丢**：
   *   当时 URL 还活着，只是**没人把字节存下来**。
   *   ⇒ 唯一能保住每一张的做法就是这一句：**收藏时 URL 还活着，就立刻落盘**。
   *
   * ⚠️ 四条分寸（都别改）：
   *   ① **带超时**：这一步挂在模型的工具调用上，服务器不响应会让那次调用一直挂着；
   *   ② 定时器**保持 ref**（⛔ 不许 unref：unref 过的定时器在事件循环没别的活时**不会触发**
   *      ⇒ race 永不 settle。本项目 2026-09-29 踩过，见经验库 `promise-unref-13-fail`），
   *      并在 `finally` 里 `clearTimeout`（不 clear 的话那个定时器会白占事件循环到超时为止）；
   *   ③ **失败不抛**：字节没存下来只是"这一张以后可能发不出去"，而**收藏本身已经成功了**
   *      （条目已落盘）⇒ 不能因为下载失败，把一次成功的收藏报成失败；
   *   ④ 失败要**出声**，并如实说明"发送时会再试一次"（那是上一轮修的那条路）。
   *
   * @returns {Promise<{ok:boolean, error?:string}>} 只给日志与判据用，不改 `collect()` 的返回形状。
   */
  async #fillCache(entry) {
    let timer = null;
    try {
      await Promise.race([
        ensureStickerImage(this.onebot, entry),
        new Promise((_, rej) => {
          const limit = collectFillTimeout();
          timer = setTimeout(() => rej(new Error(`补缓存超时（${limit}ms）`)), limit);
          if (typeof timer.ref === 'function') timer.ref();   // 见分寸②
        })
      ]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 🆕 2026-10-03（第三十四对话）§3-29：**再看到同一张图时，把它救活**。
   *
   * 做的事就两件（顺序不能反）：
   *   ① 把**这次刚看到的** `url` / `file` 用纯函数 `refreshStickerSource` 写回条目并落盘；
   *   ② 再走一遍 `#fillCache` —— 此刻那条 url 是**活的**，所以这一步真的能把字节存下来。
   *
   * ── 为什么这是"救活"而不是"重下一遍" ─────────────────────────────────────
   *   `ensureStickerImage` → `loadStickerImage` **第一步就读本地缓存**：已经缓存过的条目
   *   一次网络都不打（所以"重收一张早就存好的表情"不会变成每次重下 2~8MB）。
   *   真正会去打网络的只有**没有缓存**的那些 —— 而那正是本函数要救的目标。
   *
   * ── 分寸 ───────────────────────────────────────────────────────────────
   *   · 失败**不抛**：补缓存失败只是"这一张以后可能发不出去"，而"这条已经在你库里"这件事
   *     本来就成立 ⇒ 不能把一次成功的重收报成失败（与 `#fillCache` 同一条纪律）；
   *   · 失败要**出声**，并如实说明"发送时会再试一次补缓存"；
   *   · 备注/标签/用法/计数**一个字节都不动**（那是这一侧的认知层，见 `refreshStickerSource`）。
   *
   * @returns {Promise<{entry:object|null, refreshed:boolean, cached:boolean}>}
   */
  async #revive(entry, { url = '', file = '' } = {}) {
    if (!entry) return { entry: null, refreshed: false, cached: false };
    const r = refreshStickerSource(this.entries, entry.id, { url, file });
    if (r.changed) {
      this.entries = r.entries;
      saveStickerStore(this.entries);
    }
    const target = r.entry || entry;
    const filled = await this.#fillCache(target);
    if (!filled.ok) {
      console.warn(`[sticker] 重收时没能把原图存到本地（${target.id}）：${filled.error}`
        + ' —— 这一张以后可能发不出去（发送时会再试一次补缓存）');
    }
    return { entry: target, refreshed: r.changed, cached: filled.ok };
  }

  /**
   * 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。
   *
   * ⚠️ 2026-09-29（第三十一对话）改成 **async**：新增条目落盘后会**顺手把字节缓存下来**
   *    （见 `#fillCache`）。调用方要多一个 `await`（本仓库只有 `tools.js` 那一个调用点）。
   *
   * @param {string|number} messageId 消息 id
   * @param {object} opts
   *   - url    图片地址（必填）
   *   - note   备注
   *   - index  这是消息里的**第几张**图（1 起，默认 1）。
   *            一条合并转发可能带 30 张表情包，靠它逐张收藏。
   *            id 规则：第 1 张沿用历史格式 `collected_<mid>`（老条目不会变孤儿），
   *            第 2 张起是 `collected_<mid>_<index>`。
   *            （2026-09-12：原来 id 不含序号，一条消息里 30 张图会撞成同一个 id、
   *             后一张覆盖前一张，等于只能存 1 张。）
   * @returns {{entry:object, added:boolean, reason:string, quotaLeft:number,
   *            refreshed?:boolean, cached?:boolean}}
   *   reason = 'added' 新增成功 ｜ 'renamed' 这条消息这一张已收过，只更新了备注
   *          ｜ 'duplicate' 同一个图片地址已经在库里（同一张图），没重复收
   *   quotaLeft = 本小时还能新增几条（收藏限频用）
   *   🆕 2026-10-03（第三十四对话）§3-29：`added:false` 那三条路会**顺手救活**已有条目
   *      （把这次看到的新 url/file 写回 + 试着补本地缓存）。
   *      `refreshed` = 来源字段真的被更新了（url/file 至少一个变了）；
   *      `cached` = 这次结束时本地**确实有**字节缓存（本来就有的也算 true）。
   *      ⚠️ 新增那条路（`added:true`）**不带**这两个字段 —— 别拿它们判"新增成功"。沿用 `added`。
   *
   * 出错仍然抛异常（收藏功能关闭 / 没图地址 / 限频到顶），
   * 但限频的报错里会带上"每小时上限多少"，好让模型如实告诉用户。
   */
  async collect(messageId, { url, note = '', index = 1, file = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');

    const limit = Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10);
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    const quotaLeft = Math.max(0, limit - this.collectTimes.length);

    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');

    const idx = Math.max(1, Math.floor(Number(index)) || 1);
    const id = idx === 1 ? `collected_${messageId}` : `collected_${messageId}_${idx}`;

    // ① 先看"这条消息的这一张"收过没有 —— 收过就更新备注 + 救活来源（不算新增、不占额度）
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      const noted = this.note(id, { note: String(note || '') });
      const revived = await this.#revive(noted, { url, file });
      return {
        entry: revived.entry || noted, added: false, reason: 'renamed', quotaLeft,
        refreshed: revived.refreshed, cached: revived.cached
      };
    }

    // ② 同一个图片地址 = 同一张图：已经在库里（别的消息收的）也直接返回，不重复收
    const byUrl = this.entries.find((e) => e.url && e.url === url);
    if (byUrl) {
      const revived = await this.#revive(byUrl, { url, file });
      return {
        entry: revived.entry || byUrl, added: false, reason: 'duplicate', quotaLeft,
        refreshed: revived.refreshed, cached: revived.cached
      };
    }

    // ③ 同一张图但 url 不同（rkey 每条消息都不一样）= 还是同一张图，照样不重复收。
    //    这一条就是这次"同一批表情包发两次、存了两遍 28 张"的护栏：
    //    两次转发的 url 完全不同，只有内容哈希能把它们认成同一张。
    const hash = contentHashOfUrl(url);
    if (hash) {
      const byHash = this.entries.find((e) => e.url && contentHashOfUrl(e.url) === hash);
      if (byHash) {
        const revived = await this.#revive(byHash, { url, file });
        return {
          entry: revived.entry || byHash, added: false, reason: 'duplicate', quotaLeft,
          refreshed: revived.refreshed, cached: revived.cached
        };
      }
    }

    if (quotaLeft <= 0) {
      throw new Error(`收藏太频繁了：一小时最多收 ${limit} 条，本小时已经用完。`
        + '（想让它一次多收几张，去「表情包」页调大「每小时收藏上限」）');
    }

    const entry = {
      id,
      resId: id,
      url,
      // QQ 文件名不随 rkey 过期，存下来才能在链接失效后换新链接（见 onebot.js 的 resolveFreshImageUrl）
      file: String(file || '').trim(),
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);

    // ── 🆕 2026-09-29（第三十一对话）§3-26：这就是"根治"那一句 ─────────────────
    // 条目**先落盘**再补缓存：补缓存失败/超时都不该把一次成功的收藏变成失败，
    // 也不能让"下载到一半崩了"把刚收的条目弄丢。
    // ⚠️ 2026-10-03（第三十四对话）§3-29 **更正下面这段旧注释**：它原来写着
    //    「只在真新增（added）时补，duplicate / renamed 两条路一个字节的网络都不打」——
    //    那个取舍的理由是"旧条目的 url 多半已经死了，换了也是白换"。**现在那两条路也会补**
    //    （见 `#revive`）：因为这次她手里那条 url 是**刚看到的、此刻一定活的**，
    //    所以"救活"是可以做到的；而**已经缓存过的条目**在 `loadStickerImage` 第一步就命中缓存、
    //    仍然一次网络都不打 ⇒ 不会变成"每重收一次就重下 2~8MB"。
    const filled = await this.#fillCache(entry);
    if (!filled.ok) {
      console.warn(`[sticker] 收藏时没能把原图存到本地（${entry.id}）：${filled.error}`
        + ' —— 这一张以后可能发不出去（发送时会再试一次补缓存）');
    }

    return { entry, added: true, reason: 'added', quotaLeft: Math.max(0, quotaLeft - 1) };
  }
}
