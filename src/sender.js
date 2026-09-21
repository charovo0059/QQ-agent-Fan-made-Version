// 发送队列：所有对 QQ 的出站消息都经过这里。
// - 每会话串行（sendChain），真人化间隔（随机区间 + 按字数附加）
// - 分钟/小时限频（超限直接拒绝，工具会把错误告诉模型）
// - Markdown → 纯文本、QQ 硬长度切分、CQ 转义
// - 发出的每一条记进 ChatStore（self=true，供下一次运行当"自己的发言"）
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { sleep, randInt, createSendChain, escapeCqText, formatClockTime } from './util.js';
import { mdToPlain, splitForQQ } from './md-to-plain.js';
import { resolveFreshImageUrl } from './onebot.js';

// 限频回退值统一取自 DEFAULT_CONFIG，杜绝"代码默认 80 / 回退值 8 / UI 回退 8"三处打架。
const DEFAULT_MAX_PER_MINUTE = DEFAULT_CONFIG.send.maxPerMinute;
const DEFAULT_MAX_PER_HOUR = DEFAULT_CONFIG.send.maxPerHour;

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
   * options: { replyToMessageId, atUserId }
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
        const data = await client.sendText(kind, id, text, {
          replyToMessageId: i === 0 ? options.replyToMessageId : null, // 引用挂在第一条上：回的就是那条
          atUserId: i === 0 ? options.atUserId : null
        });
        const ts = Date.now();
        this.store.appendSelf(chatKey, { text, ts, mid: data?.message_id ?? null });
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

  /** 发送一个收藏表情（独立气泡）。 */
  sendSticker(chatKey, sticker, options = {}) {
    const [kind, id] = String(chatKey).split(':');
    const chain = this.#chain(chatKey);
    return chain(async () => {
      this.#checkRate(chatKey);
      await sleep(randInt(600, 1500)); // 发表情前真人式的短暂停顿
      // ⚠️ 存下来的 url 里 rkey 只有十几个小时寿命，直接发会失败（实测 download url has expired）。
      // 有 QQ 文件名就拿它换一条新链接；换不到再退回存下来的那条（见 onebot.resolveFreshImageUrl）。
      const { url: sendUrl } = await resolveFreshImageUrl(this.onebot, { url: sticker.url, file: sticker.file });
      const data = await this.onebot.sendSticker(kind, id, sendUrl, {
        replyToMessageId: options.replyToMessageId ?? null,
        atUserId: options.atUserId ?? null
      });
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
      const data = await this.onebot.sendPoke(kind, id, targetUserId);
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
