// 「群禁言」状态表。
//
// ── 为什么需要它（2026-09-19 实测，第八对话）────────────────────────────
// 机器人账号在一个群里被禁言 24 小时，症状是**这个群连着 2 小时一条都没发出去**，
// 而我们的编排层**完全不认识这件事**：
//   群消息照常来 → 每一轮都起一次完整的 LLM 调用 → 发送被 QQ 拒（result=120）→ 群里一个字都没有。
// 实测代价：单群 140+ 轮空转，当日全站 promptTokens 1164 万、runs 441。
//
// ── 为什么它藏了 2 小时（这条比 bug 本身重要）─────────────────────────────
// 发送失败 ⇒ `session.sent` 拿不到记录 ⇒ 编排层把那一轮判成 `noreply`；
// 而 `noreply` 在本项目里等于"**刻意保留的漏发（人味，铁律 4）**"
// ⇒ **真故障被自己的统计口径伪装成了设计行为**。
// 判据（orchestrator.js:669 的注释本来就写着，只是没人跟铁律 4 分开）：
//   noreply + messages 里有 draftWithoutSend ⇒ 回复丢失（故障）
//   noreply + 没有 draftWithoutSend          ⇒ 才是刻意不说
//
// ── 三种来源，取"最晚的那个解禁时刻"────────────────────────────────────
//   'event'      OneBot notice/group_ban —— 最准，但**要验证它到底有没有转发**（见 app.js 的日志）
//   'send-error' 发送被拒（result=120）—— 兜底。**不依赖任何新事件**，所以哪怕事件没转发也能生效
//   'info'       get_group_member_info 的 shut_up_timestamp —— 权威时刻，用来把兜底的粗粒度覆盖成精确值
// 三者都可能单独出现，所以这里不做"谁覆盖谁"，只做"谁更晚用谁"。
//
// ⚠️ 刻意**不做持久化**：禁言最长 30 天，但应用一重启这条状态重算即可；
//    落盘反而会引入"重启后还按旧禁言拦着"的假阳性（而真相是禁言可能已被解除）。

/** 发送被拒后的兜底冷却：粗粒度，只为"先停下空转"，随后由 'info' 覆盖成精确值。 */
const SEND_REJECT_COOLDOWN_MS = 10 * 60 * 1000;

const SOURCE_LABEL = {
  event: '群禁言事件',
  'send-error': '发送被拒（兜底）',
  info: '群成员禁言状态查询'
};

/** OneBot v11 的群禁言相关 notice（不同实现会落在不同字段上，所以都要认）。 */
const BAN_NOTICE_TYPES = ['group_ban', 'ban', 'group_mute'];
/** "禁言被解除"的子类型。 */
const LIFT_SUBTYPES = ['lift_ban', 'unban', 'unmute'];

export class GroupMutes {
  /**
   * @param {{ now?: () => number }} [options] now 可注入，便于测试时间流逝而不用真等。
   */
  constructor({ now } = {}) {
    /** chatKey -> { until, source, permanent, at } */
    this.map = new Map();
    this.now = typeof now === 'function' ? now : Date.now;
    /** 最近一次"被拦下"的记录，供 /api/mutes 说人话用 */
    this.lastBlocked = null;
  }

  /** 现在是不是被禁言中（会顺手清掉已过期的条目）。 */
  isMuted(chatKey) {
    const rec = this.map.get(chatKey);
    if (!rec) return false;
    if (rec.permanent) return true;
    if (Number(rec.until) > this.now()) return true;
    this.map.delete(chatKey);   // 过期即清，避免"重启前记下的禁言"永远拦着
    return false;
  }

  /** 距离解禁还有多少毫秒（没被禁言返回 0；永久禁言返回 null）。 */
  msUntilUnmute(chatKey) {
    if (!this.isMuted(chatKey)) return 0;
    const rec = this.map.get(chatKey);
    if (rec.permanent) return null;
    return Math.max(0, Number(rec.until) - this.now());
  }

  /**
   * 记下某个会话被禁言到什么时候。
   * @param {string} chatKey 形如 `group:123456`
   * @param {number|null} untilMs 解禁时刻（epoch ms）；`null` = 永不过期
   * @param {string} source 'event' | 'send-error' | 'info'
   */
  record(chatKey, untilMs, source = 'event') {
    if (!chatKey) return null;
    const permanent = untilMs === null || untilMs === undefined;
    const until = permanent ? null : Number(untilMs);
    if (!permanent && !Number.isFinite(until)) return null;

    const prev = this.map.get(chatKey);
    // 只在"这次更晚"时覆盖：三处来源会先后到达，早到的那次不该把晚到的那次冲掉。
    // ⚠️ 唯一的例外：**解禁时刻已经在过去**（`<= now`）⇒ 这是"禁言已被解除"的确凿信号，
    //    必须采纳，否则一次长禁言会把之后的解除事件全部挡掉、永远拦着。
    //    （第一版用的是"比现在晚一点点也算更早"，判据太脆 —— 被单元测试抓出来，已改。）
    if (prev) {
      const prevUntil = prev.permanent ? Infinity : Number(prev.until)
      const nextUntil = permanent ? Infinity : until
      const isPast = !permanent && nextUntil <= this.now();
      if (nextUntil < prevUntil && !isPast) return prev;
    }

    const rec = {
      until: permanent ? null : until,
      permanent,
      source,
      at: this.now(),
      prevSource: prev?.source ?? null
    };
    this.map.set(chatKey, rec);
    return rec;
  }

  /**
   * 从 OneBot 事件里认出"机器人自己在这个群被禁言"。
   *
   * 🔴 判据的核心（第一版写错、被单元测试抓出来）：
   *    **不能靠 `sub_type === 'ban'` 区分"整群禁言"和"某人被禁言"** ——
   *    实测两个形状用的都是 `sub_type: 'ban'`。可靠的区分是**有没有 `user_id`**：
   *      · 无 `user_id`            ⇒ 整群禁言 ⇒ 我们也不能说话 ⇒ 认
   *      · 有 `user_id` 且 == 我们  ⇒ 点名禁言我们   ⇒ 认
   *      · 有 `user_id` 且 != 我们  ⇒ 只是别人被禁言 ⇒ **不认**
   *    这一条至关重要：实测那次群里**一批人**（伊落/拉弥亚/Mio/TT-Snow…）各被禁言 86400 秒，
   *    若判据写松，就会把"别人被禁言"当成"我们不能说话"，平白冻住一个本来正常的群。
   *
   * @returns {{chatKey:string, untilMs:number|null, lifting:boolean}|null}
   */
  static parseBanNotice(event, selfId) {
    if (!event || event.post_type !== 'notice') return null;
    const nt = String(event.notice_type ?? '');
    if (!BAN_NOTICE_TYPES.includes(nt)) return null;
    if (event.group_id == null) return null;

    const sub = String(event.sub_type ?? '').toLowerCase();
    // duration=0 表示解除
    const duration = Number(event.duration ?? 0);
    const lifting = duration === 0 || LIFT_SUBTYPES.includes(sub);

    const hasUserId = event.user_id != null && String(event.user_id) !== '';
    const target = String(event.user_id ?? event.target_id ?? '');
    const self = String(selfId ?? '');
    const wholeGroup = !hasUserId;

    if (wholeGroup) {
      // 整群禁言：不需要知道 selfId 就能判定
    } else if (self && target === self) {
      // 点名禁言我们
    } else {
      return null;   // 别人被禁言 —— 与我们能不能说话无关
    }

    const ts = Number(event.time) ? Number(event.time) * 1000 : Date.now();
    const untilMs = lifting ? Date.now() : (duration > 0 ? ts + duration * 1000 : null);
    return { chatKey: `group:${event.group_id}`, untilMs, lifting };
  }

  /**
   * 从"发送被 QQ 拒"里认出禁言（**兜底路径，不依赖任何事件转发**）。
   * 只认 QQ 侧拒绝码 —— 实测原文：
   *   `OneBot send_group_msg 失败: retcode=100 send group message rejected: result=120 err=`
   * 刻意**不认** `HTTP download failed: 400`（那是图片下载失败，与禁言无关，
   * 实测在别的群出现过 4 次，认了就会误伤）。
   *
   * @returns {boolean} 是否已按禁言记下
   */
  recordFromSendError(chatKey, errorMessage) {
    const text = String(errorMessage ?? '');
    if (!text) return false;
    if (!/send group message rejected/i.test(text)) return false;
    if (!/result=120\b/.test(text)) return false;
    this.record(chatKey, this.now() + SEND_REJECT_COOLDOWN_MS, 'send-error');
    return true;
  }

  /**
   * 从 get_group_member_info 的返回值里取权威解禁时刻。
   * `shut_up_timestamp` 单位是**秒**；0/缺失 = 当前没被禁言 ⇒ 解除。
   * @returns {boolean} 是否处于禁言
   */
  recordFromMemberInfo(chatKey, info) {
    const ts = Number(info?.shut_up_timestamp ?? 0);
    if (!ts || ts <= 0) {
      this.map.delete(chatKey);
      return false;
    }
    this.record(chatKey, ts * 1000, 'info');
    return true;
  }

  /** 仅供读取/展示：当前所有生效中的禁言（已过期的先清掉）。 */
  list() {
    for (const k of [...this.map.keys()]) this.isMuted(k);
    return [...this.map.entries()].map(([chatKey, rec]) => ({
      chatKey,
      until: rec.until,
      permanent: !!rec.permanent,
      source: rec.source,
      sourceLabel: SOURCE_LABEL[rec.source] ?? rec.source,
      at: rec.at,
      msLeft: rec.permanent ? null : Math.max(0, Number(rec.until) - this.now())
    }));
  }

  clear(chatKey) { return this.map.delete(chatKey); }

  /** 给日志/接口用的一句话（把"为什么它不说话"直接说出来，别再让人猜）。 */
  describe(chatKey) {
    if (!this.isMuted(chatKey)) return '';
    const rec = this.map.get(chatKey);
    if (rec.permanent) return `该群已禁言（未给出解禁时刻，来源：${SOURCE_LABEL[rec.source] ?? rec.source}）`;
    const left = Math.max(0, Number(rec.until) - this.now());
    const mins = Math.ceil(left / 60000);
    return `该群禁言至 ${new Date(Number(rec.until)).toLocaleString('zh-CN')}`
      + `（还剩约 ${mins >= 60 ? (mins / 60).toFixed(1) + ' 小时' : mins + ' 分钟'}，来源：${SOURCE_LABEL[rec.source] ?? rec.source}）`;
  }
}
