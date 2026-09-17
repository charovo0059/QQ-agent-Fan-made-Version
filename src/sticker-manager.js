// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import fs from 'node:fs';
import path from 'node:path';
import { OneBotClient } from './onebot.js';
import { getConfig, DATA_DIR } from './config.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary, removeSticker,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed, contentHashOfUrl
} from './stickers.js';

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
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
   * 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。
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
   * @returns {{entry:object, added:boolean, reason:string, quotaLeft:number}}
   *   reason = 'added' 新增成功 ｜ 'renamed' 这条消息这一张已收过，只更新了备注
   *          ｜ 'duplicate' 同一个图片地址已经在库里（同一张图），没重复收
   *   quotaLeft = 本小时还能新增几条（收藏限频用）
   *
   * 出错仍然抛异常（收藏功能关闭 / 没图地址 / 限频到顶），
   * 但限频的报错里会带上"每小时上限多少"，好让模型如实告诉用户。
   */
  collect(messageId, { url, note = '', index = 1, file = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');

    const limit = Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10);
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    const quotaLeft = Math.max(0, limit - this.collectTimes.length);

    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');

    const idx = Math.max(1, Math.floor(Number(index)) || 1);
    const id = idx === 1 ? `collected_${messageId}` : `collected_${messageId}_${idx}`;

    // ① 先看"这条消息的这一张"收过没有 —— 收过就只更新备注（不算新增、不占额度）
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return { entry: this.note(id, { note: String(note || '') }), added: false, reason: 'renamed', quotaLeft };
    }

    // ② 同一个图片地址 = 同一张图：已经在库里（别的消息收的）也直接返回，不重复收
    const byUrl = this.entries.find((e) => e.url && e.url === url);
    if (byUrl) return { entry: byUrl, added: false, reason: 'duplicate', quotaLeft };

    // ③ 同一张图但 url 不同（rkey 每条消息都不一样）= 还是同一张图，照样不重复收。
    //    这一条就是这次"同一批表情包发两次、存了两遍 28 张"的护栏：
    //    两次转发的 url 完全不同，只有内容哈希能把它们认成同一张。
    const hash = contentHashOfUrl(url);
    if (hash) {
      const byHash = this.entries.find((e) => e.url && contentHashOfUrl(e.url) === hash);
      if (byHash) return { entry: byHash, added: false, reason: 'duplicate', quotaLeft };
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
    return { entry, added: true, reason: 'added', quotaLeft: Math.max(0, quotaLeft - 1) };
  }
}
