// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import { getConfig, storeConfigForChat } from './config.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey } from './util.js';
import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError } from './llm.js';
import { buildToolDefs, toOpenAiTools, executeTool, gateToolDefs } from './tools.js';
import { modelImageVerdict } from './vision-scan.js';
import { currentProviders } from './providers.js';

// ── 主动开口的三道闸（纯函数，便于单测）──────────────────────────────────
//
// 为什么提成模块级：这几个判据全是"给定配置和当前时间，算什么"，
// 不需要 store / onebot / 模型。留成类私有方法就只能靠起真循环+定时间接测，
// 而它们恰恰是三处最容易写错边界（跨零点、翻倍封顶、正好等于阈值）的地方。

/**
 * 现在是不是"安静时段"（这段时间内绝不主动开口）。
 *
 * 为什么要它（调研报告 M2 / §10）：我们的 proactive 原本没有这个闸 ⇒ **凌晨 3 点也可能开口**。
 * 跨零点由 start > end 表达（默认 23 → 8）。
 * ⚠️ 用本地时区的小时数，不用 UTC —— 机器人是给本机用户用的。
 */
export function quietHoursAt(cfg, now = new Date()) {
  const s = Number(cfg?.proactive?.quietHoursStart);
  const e = Number(cfg?.proactive?.quietHoursEnd);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  if (s === e) return false;                       // 起止相同 = 不设安静时段
  const h = now.getHours();
  return s < e ? (h >= s && h < e) : (h >= s || h < e);   // 后者跨零点
}

/**
 * 被晾了这么久之后，允许"再戳一次"的等待时长（毫秒）。
 *
 * 依据 lingxi 的 reengage 设计（调研报告 M2）：14h × 2^超出条数，封顶 reengageMaxHours（336h=14天）。
 * 它注释里的原话解释了为什么要封顶：
 *   "一个平铺的 14 小时永远不会放弃：某个收件人的缓冲区里堆了 30 轮、没有一条是他的，
 *    以及 24 条连续没人回的开口。到那时候已经没东西可开口了 —— 没有新事实、没有可跟进的消息，
 *    于是每次尝试都退化成「你还在忙吗」「都一个星期没你消息了」。
 *    那种词被怪到措辞头上；它其实就是'没话可说'听起来的样子。"
 *
 * @param unanswered 超出上限的那一条是第几条（1 = 刚超出，2 = 超出第二条……）
 */
export function reengageWaitMs(cfg, unanswered) {
  const after = Math.max(1, Number(cfg?.proactive?.reengageAfterHours) || 14);
  const backoff = Math.max(1, Number(cfg?.proactive?.reengageBackoff) || 2);
  const maxH = Math.max(after, Number(cfg?.proactive?.reengageMaxHours) || 336);
  const over = Math.max(0, Number(unanswered) - 1 || 0);
  return Math.min(after * Math.pow(backoff, over), maxH) * 3600000;
}

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null, mutes = null }) {
    this.store = store;
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    // 群禁言状态表（见 src/mutes.js）。可以为 null —— 那种情况下退化成旧行为（不拦）。
    // ⚠️ 这里刻意用"可缺省"而不是"必需"：老调用方（测试、工具）不传也能跑。
    this.mutes = mutes;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
    this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    // chatKey -> 本次唤醒**掷定的**随机档骰子（见 scheduleWake 顶部注释：预判与实跑必须用同一个）
    this.pendingRoll = new Map();
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey
    this.activeRuns = new Map();       // chatKey -> sessionId
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.aborted = false;
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
    // ── 群禁言：认出来就别再起编排了（2026-09-19 第八对话新增）────────────────
    //
    // 为什么卡在这里而不是卡在发送处：被禁言时**发言注定失败**，而起一轮运行的代价
    // 是**一整次 LLM 调用**。实测那次单群 140+ 轮空转、当日全站 1164 万 prompt token。
    // 消息**照样落 store**（只是不叫醒），所以解禁后内容不丢、还能当上下文。
    if (this.mutes?.isMuted?.(chatKey)) {
      this.mutes.lastBlocked = { chatKey, at: Date.now(), reason: this.mutes.describe(chatKey) };
      this.emit('chat-update', chatKey);
      return;
    }
    if (this.runningChats.has(chatKey)) return;   // 运行结束后 drain 会接管
    this.scheduleWake(chatKey);
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @param {number|null} roll 随机档的骰子结果（0-100）。**必须由调用方固定并复用**
   *   —— 见 `wake()` 里那段长注释：这个参数就是本条 bug 的修法。
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  #predictTier(chatKey, roll = null) {
    const cfg = getConfig();
    const entries = this.store.peekUnread(chatKey, 200) || [];
    const r = resolveContextTier({
      triggerEntries: entries,
      selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),   // 按会话取档位：统一开关关闭时各群可以有独立滑条
      roll
    });
    // pending / hasUnread 是给「唤醒一次处理」按钮回报用的（原先只有 shouldRespond）。
    const extra = { pending: entries.length, hasUnread: entries.length > 0 };
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, ...extra, shouldRespond: false, reason: '无未读' };
    return { ...r, ...extra };
  }

  scheduleWake(chatKey, delay = null, pinnedRoll = null) {
    const ms = delay ?? Math.max(0, Number(getConfig().wakeDelayMs) || 2000);
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);

    // 🔴 随机档的骰子在这里掷**一次**，然后一路复用（预判 → 等待会话 → 实跑）。
    //    2026-09-20 第八对话修：原来预判掷一次、实跑又掷一次，两次互相独立 ⇒
    //    预判放行（该群 10%）之后，实跑有 ~90% 的概率判成"未触发"。
    //    后果不是"少回一句"，而是**那一轮不带任何历史**（contextLimit=0）：
    //    她只看到刚到的 1~3 条新消息，完全不知道谁在跟谁说话 ⇒
    //    就会去接明显不是说给她的话。用户报的"回复不属于她的消息"主要就是它。
    //    （prompt.js 的 resolveContextTier 注释早就写明"随机档结果必须固定下来"，
    //      orchestrator 的注释也写了"在唤醒时算一次并固定下来"—— 但**没人真的传 roll**。）
    const roll = pinnedRoll === null || pinnedRoll === undefined ? Math.random() * 100 : Number(pinnedRoll);
    this.pendingRoll.set(chatKey, roll);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      const predicted = this.#predictTier(chatKey, roll);
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 3);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.get(existing);
        if (s && s.status === 'waiting') {
          s.waitUntil = waitUntil;
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      const waitingId = this.pendingSessions.get(chatKey);
      this.pendingSessions.delete(chatKey);
      // 把上面掷的那一次骰子**原样**带进实跑（见 scheduleWake 顶部的注释）
      const pinnedRoll = this.pendingRoll.get(chatKey);
      this.pendingRoll.delete(chatKey);
      if (this.paused || this.aborted || this.runningChats.has(chatKey)) {
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null, roll: pinnedRoll ?? null })
        .catch((error) => console.error(`[orchestrator] wake ${chatKey} 出错:`, error));
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /**
   * 「唤醒一次处理」按钮：**立刻**按现行规则醒一次（不走 2 秒防抖），并把"会发生什么"如实回报。
   *
   * 它用的是和自动唤醒**同一条路径**，所以档位判定照旧生效 —— 于是有三种"点了等于没点"：
   *   - 没有未读 → 什么都不做（不花 token）
   *   - 正在处理该会话 → 排不上队
   *   - 有未读但档位不命中 → **老行为是顺手把这批标为已读**
   *
   * 最后那种是**不可逆**的：未读一没，这批消息就再也不会单独叫醒它了（只能日后被艾特时
   * 作为背景被带出来）。所以现在默认**不扫**，只回报 `tier-miss` 让界面去确认；
   * 界面确认过再带 `force: true` 回来，才真的扫。
   *
   * @returns {{started:boolean, reason:string, tier?:number, count?:number, tierReason?:string, pending?:number, marked?:number}}
   */
  forceWake(chatKey, { force = false } = {}) {
    if (this.aborted) return { started: false, reason: 'aborted' };
    if (this.paused) return { started: false, reason: 'paused' };
    if (this.runningChats.has(chatKey)) return { started: false, reason: 'running' };

    const roll = Math.random() * 100;
    const t = this.#predictTier(chatKey, roll);
    if (!t.hasUnread) return { started: false, reason: 'no-unread' };

    if (t.shouldRespond === false) {
      // 注意 t.tier 是"**命中的**档位"，没命中时是 0（见 resolveContextTier 的注释）。
      // 界面要显示的是"**设置成**第几档"，所以额外带上 configTier。
      const configTier = Number(storeConfigForChat(chatKey)?.contextTier) || 4;
      if (!force) {
        return {
          started: false, reason: 'tier-miss',
          tier: t.tier, configTier, tierReason: t.reason, pending: t.pending
        };
      }
      const marked = this.store.markAllRead(chatKey);
      this.emit('chat-update', chatKey);
      return { started: false, reason: 'swept', marked, tier: t.tier, configTier, tierReason: t.reason };
    }

    this.scheduleWake(chatKey, 0, roll);
    return { started: true, tier: t.tier, count: t.count, tierReason: t.reason, pending: t.pending };
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  async wake(chatKey, { proactive = false, waitingSessionId = null, roll = null } = {}) {
    if (this.aborted) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.paused && !proactive) { if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted'); return; }
    if (this.runningChats.has(chatKey)) return;

    // ── 群禁言：**这里也必须拦**（2026-09-19 第八对话新增）────────────────────
    // ⚠️ 只在 onIncoming 拦是不够的 —— 禁言可能发生在"已经排好唤醒"之后：
    //    防抖窗口（wakeDelayMs，默认 2 秒）里被禁言、或主动开口/续聊那条线排的唤醒，
    //    都会绕过 onIncoming 直接走到这儿。**实测就是这么漏的**：
    //    单测里"禁言后不再叫起编排"通过、但那个群照样起了一轮 —— 因为起它的是先前排的唤醒。
    // 处置：不消费未读、干净撤掉等待会话 ⇒ 解禁后这批消息还能被正常处理，一条不丢。
    if (this.mutes?.isMuted?.(chatKey)) {
      this.mutes.lastBlocked = { chatKey, at: Date.now(), reason: this.mutes.describe(chatKey) };
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '该群禁言中');
      this.emit('chat-update', chatKey);
      return;
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 全局并发限制：满了就稍后重试
    if (this.runningChats.size >= Math.max(1, Number(getConfig().maxConcurrentRuns) || 2)) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        if (s && s.status === 'waiting') {
          this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          // 带上**同一个** roll：刚才那次判定已经说"要回应"，重排只是等并发位
          // （不传的话会重掷，可能反而判成未响应 —— 见 scheduleWake 顶部注释）
          this.scheduleWake(chatKey, 0, roll);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要不要取走未读 ──
    //
    // 关键顺序：判定必须发生在 drainUnread() 之前。
    // drainUnread 会把未读取走并全部置为已读（作为触发批），
    // 如果先取走再判定，未命中时就拿不到"该标记已读"的对象了。
    //
    // 未命中时：标记已读、不创建会话、不调模型 —— 这才是省 token 的关键
    // （消息内容仍留在存档里，日后被艾特时会作为"已读历史"带进提示词）。
    const cfgNow = getConfig();
    let pendingEntries = [];
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本）
      pendingEntries = this.store.peekUnread(chatKey, 200) || [];
      if (pendingEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }

      // 复用 scheduleWake 那一份判定逻辑，避免两处各写一套、日后漂移
      // ⚠️ 必须传同一个 roll（见 scheduleWake 顶部注释）—— 不传就退回"掷两次"的老 bug
      const tierResult0 = this.#predictTier(chatKey, roll);

      if (tierResult0.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markAllRead(chatKey);
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult0.tier}），已标记已读、不响应`);
        }
        return;
      }
    }

    // 触发批：当前所有未读（含之前积压的）—— 到这说明确定要响应了
    let triggerEntries = proactive ? [] : this.store.drainUnread(chatKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
    }
    if (!proactive && triggerEntries.length === 0) {
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }

    // ── 档位：响应时带多少条已读历史 ──
    // 在唤醒时算一次并固定下来（尤其是随机档的骰子结果），
    // 否则后续每次渲染提示词都会重新掷，会话记录与提示词会对不上。
    const tierResult = resolveContextTier({
      triggerEntries,
      selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfgNow.persona?.botName || '',
      selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
      cfg: storeConfigForChat(chatKey),   // 与 #predictTier 同一来源，保证预判/实跑一致
      roll                                // 🔴 同一个骰子（见 scheduleWake 顶部注释）
    });

    // 🔴 兜底：**绝不允许"不带历史"地跑一轮**。
    //    上面那个 roll 修好之后，这里理论上不该再命中；留着是因为这类不一致的代价特别大：
    //    contextLimit=0 ⇒ 【过去状态】里一条历史都没有 ⇒ 她只看到刚到的 1~3 条消息，
    //    不知道谁在跟谁说话，就会去接根本不是对她说的话（用户报的现象）。
    //    宁可这一轮不跑（消息标已读，日后被艾特时还会作为已读历史带上），也不要瞎答。
    if (!proactive && tierResult.shouldRespond === false) {
      // 注意：走到这儿时 `drainUnread` 已经把触发批取走并标为已读（它会成为"已读历史"），
      // 所以这里**不是**"再标一次已读"，只是把等待会话清掉、不发这一轮。
      if (waitingSessionId) this.#discardWaiting(waitingSessionId);
      this.emit('chat-update', chatKey);
      console.warn(`[orchestrator] ${chatKey} 预判放行、实跑却判成「${tierResult.reason}」`
        + `⇒ 按不响应处理（${triggerEntries.length} 条触发消息已并入已读历史）。`
        + '这不该发生，出现即说明某条路径没把 roll 传下来 —— 见 scheduleWake 顶部注释。');
      return;
    }

    this.runningChats.add(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);
    const [kind, chatId] = String(chatKey).split(':');

    // 🔴 2026-09-19 第七对话修（proactive 拿不到历史的真 bug）：
    //    主动开口时 `triggerEntries` 是**空数组**（这就是它"不打扰、无触发批"的定义），
    //    而 `resolveContextTier` 是**从触发批里**找 @/关键词/随机命中的 ⇒ 空数组必然走到底部
    //    返回 `{ tier: 0, count: 0, reason: '未触发' }`。
    //    于是 `contextLimit = 0` ⇒ `buildPastState` 直接返回 `skipped: true` ⇒
    //    **【过去状态】里一条历史都没有**，只写"本次档位设定为不带历史"。
    //    后果：它要"开话题"，手里却没有任何这个群最近聊了什么 —— **只能瞎编或说空话**。
    //    ⚠️ 实测证据（真跑提示词构建）：proactive 下 tier=0/count=0，
    //       【过去状态】长度 0 字且不含任何历史行；对照"被 @"时 503 字 / tier=1/count=20。
    //
    //    修法：**主动开口没有触发批可依据，就该按"全读档"给它历史**（相当于 tier 4 的 allCount）。
    //    为什么不是"给它一套独立的条数"：那会多一个没人调的旋钮；而 `allCount` 是用户
    //    已经在「设置」里调过的"全读档读多少条"，语义正好对得上。
    //    ⚠️ 注意：这**不会**让机器人更爱插嘴 —— 它只影响主动开口那一次带多少上下文，
    //       与"要不要回应某条消息"的判定无关（那个走 gateToolDefs/档位门控，本函数没碰）。
    const contextLimit = proactive
      ? Math.max(1, Number(storeConfigForChat(chatKey)?.allCount) || 80)
      : tierResult.count;

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? '主动机会（冷场开话题）'
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // ── 同一轮的上文（2026-09-17 加，修"引用引错 / 答非所问"）──────────────
    //
    // 触发批只收"未读"，但**未读不等于"本轮说的话"**：防抖窗（wakeDelayMs，默认 2 秒）
    // 会把同一轮对话拆成两批，先到的那批若不含 @/关键词就会被档位门控**静默扫成已读**
    // （store.markAllRead），于是它永远进不了触发批 —— 模型只看到后半句。
    //
    // 实测（442 个会话）：78 个（17.6%）存在这种情况，共 85 条被拆开，其中 15 条带图。
    // 用户报的那一例就是：10:23:39「[图片]」被静默扫掉，10:23:42「@DeepSleep」单独成批，
    // 模型手里只有 @ 那条的 id → 引用只能引它，看着就像"引用到了别的消息上"。
    //
    // ⚠️ 这里算出来的只当**上下文**用，**不参与"要不要回应"的判定**
    //    （判定仍由档位门控在 drainUnread 之前独立完成）—— 所以不会让机器人变得更爱插嘴，
    //    "偶尔漏一次更像人"那条刻意保留的行为不受影响。
    // 只读不消费：不改 read 标记、不动 swept、不落盘。
    let sameTurnContext = [];
    if (!proactive && triggerEntries.length) {
      try {
        sameTurnContext = this.store.sameTurnContext(chatKey, triggerEntries[0]?.mid, triggerEntries[0]?.ts, { maxAgeMs: 8000, maxCount: 6 }) || [];
      } catch (error) {
        console.warn('[orchestrator] 取同轮上文失败（忽略，不影响主流程）:', error?.message ?? error);
        sameTurnContext = [];
      }
    }

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.activeRuns.set(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // 「替你收着了」：门控不命中时被静默扫成已读的消息量，在这里取一次就清。
    // 放在重试循环**之外**：会话级重试会重跑 #runAgent，若在循环内取，
    // 第一次就清空了，重试那一轮模型反而看不到这条提醒。
    session.sweptInfo = this.store.takeSwept(chatKey);

    // 同一轮上文：留痕，便于坐实"这次到底补了哪几条"（照 triggerText 的写法，都是小字符串）。
    // ⚠️ 只存 mid + 摘要，**不存条目本身** —— 存档瘦身（2026-09-17）刚把 inputMessages 剥掉，
    //    别在这儿把整条消息对象又塞回会话文件。渲染用内存里的 sameTurnContext。
    if (sameTurnContext.length) {
      session.sameTurnCtxText = sameTurnContext
        .map((m) => `#${m.mid ?? '无id'} ${m.senderName || m.senderId || '?'}: ${String(m.text || '').slice(0, 40)}`)
        .join(' | ')
        .slice(0, 500);
      console.log(`[orchestrator] ${chatKey} 触发批 ${triggerEntries.length} 条，另补同轮上文 ${sameTurnContext.length} 条`);
    }

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit, tierInfo: tierResult, sameTurnContext });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      this.activeRuns.delete(chatKey);
      this.runningChats.delete(chatKey);
      // 🆕 2026-09-21（第十对话）：把「上次看到记忆」推到本次唤醒算出来的时间点。
      //
      // 为什么放在 finally（而不是算提示词时顺手推）：
      //   · 提示词**每一轮都重新渲染**（多轮工具调用会有第 2、3 轮）。若在渲染时推，
      //     第 1 轮渲染完就把时间戳推掉了 ⇒ 第 2 轮算出"没有变化" ⇒ 提示凭空消失，
      //     而第 1 轮恰恰可能只是去调了个工具、根本没说话。
      //   · 这里每个会话只走一次，且**已经**把带提示的提示词递给过模型了
      //     （哪怕这一轮最后出错/中止，模型也已看过），所以推时间戳不算"漏看"。
      //   没有变化时 commitChangedNote 返回 false 且什么都不写（见它的注释）。
      try { this.memory.commitChangedNote(chatKey); } catch { /* 绝不因为它影响收尾 */ }
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, seq, contextLimit = null, tierInfo = null, sameTurnContext = [] }) {
    const cfg = getConfig();
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 🔴 按**会话来源**告诉提示词"这是在哪个平台"（2026-09-20 第八对话）：
    //    微信没有拍一拍/合并转发/表情包，提示词按 QQ 写会诱导模型去调不存在的能力，
    //    她还会张口就说"QQ"（实测：她在微信里回完话，小结写的是"发送者QQ"）。
    //    ⚠️ 缺省 'qq'，且 QQ 分支的文本逐字不变 —— 别为了微信改动 QQ 侧一个字。
    const platform = (() => {
      try { return this.store.chatSource(chatKey) } catch { return 'qq' }
    })();
    const isWechat = platform === 'wechat';

    // 表情库快照（提示词用）
    // ⚠️ 微信侧**不取**：微信没有表情包，给了目录她就会去发（发不出去，白花一次调用）
    let stickerEntries = [];
    if (!isWechat && cfg.sticker?.enabled !== false) {
      try { stickerEntries = (await this.stickers.sync(false)).entries ?? []; } catch { stickerEntries = []; }
    }

    // 组装提示词（无 LLM 历史）
    const systemPrompt = buildSystemPrompt({ platform });
    const userPrompt = buildUserPrompt({
      chatKey, kind, chatId, chatName,
      // 平台一并传下去：记忆互通要在提示词里标出"这条来自哪个平台"（QQ↔微信）。
      // 不传的话 formatForPrompt 会自己去问 memory.platformOf（有缓存），只是多一次查找。
      platform,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      selfLastMessageAt,
      // 我自己最近发过的话（已在上面查过，不额外查库）—— buildUserPrompt 用它统计
      // "我最近开口爱用什么词"，治 38.2% 以接话词开头的口癖。详见 prompt.js recentSelfOpeners。
      recentSelfMessages: myMessages,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      sweptInfo: session.sweptInfo || null
    });

    // 主动唤醒时，真正发给模型的 user 消息会多一句引导语。
    // 现在直接把它并进 userPrompt 本体 —— 于是 userPrompt 就等于"实际发出去的那份"，
    // 不必再另存一份完整输入副本（inputMessages 曾占会话存档的 45%，实测 14.8MB/32.6MB）。
    // 界面（会话详情的 JSON 模式）用 systemPrompt + userPrompt 重建即可，旧存档仍优先读原件。
    const proactiveNote = '\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就安静结束。';
    const userContent = proactive ? userPrompt + proactiveNote : userPrompt;

    session.systemPrompt = systemPrompt;
    session.userPrompt = userContent;
    session.promptChars = systemPrompt.length + userContent.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    // 工具集按配置过滤（搜索开关 / 视觉 / 本子查询开关）—— 判定逻辑在 tools.js 里，便于单测
    const toolDefs = gateToolDefs(this.toolDefs, cfg, { visionEnabled });
    const openAiTools = toOpenAiTools(toolDefs);

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      triggerEntries,                   // 提示词要用它排除重复（【过去状态】不该再带这几条）
      sameTurnContext,                  // 同一轮的上文（见 wake() 里的说明）
      emit: (type, payload) => this.emit(type, payload)
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    let nudged = false;          // 「写了正文但没发出去」是否已经追问过（每次运行最多一次）
    let roundsUsed = 0;          // ⚠️ 循环外的计数器：`round` 是 for 的块级作用域，循环外访问不到
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      // 在**调用之前**取：这一轮模型看到的输入里有没有工具结果（用于位置标注）
      const hadToolResult = messages.some((m) => m.role === 'tool');
      markActivity('正在思考…');
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      const response = await chatCompletionWithRetry({ messages, tools: openAiTools });
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      session.usage.calls += 1;

      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null,
        // ── 位置与结果标注（2026-09-15 加，纯记录，不影响行为）──
        //
        // 用途：以后想研究"工具返回之后那一轮是不是更容易出事"时，直接按这些字段筛样本，
        // 不用事后从 messages[] 反推 —— 反推规则一旦有偏差会污染全部样本。
        //
        //   round          这是本次运行的第几次模型调用（1 起）
        //   hadToolResult  这一轮**模型看到的输入里**是否已经含工具结果
        //                  （在调用前求值，所以取的是"它当时看到的状态"）
        //   draftWithoutSend
        //                  本轮既没调任何工具、content 又非空 —— 也就是"写好了稿子却没寄出去"。
        //                  这条会直接 break 掉循环，所以它是**回复丢失**的精确判据。
        //                  （另有一种更宽松的"没调发送类工具但调了别的工具、同时写了正文"，
        //                    那种回复只是推迟到下一轮，不算丢失；两者的原始字段都在，
        //                    需要时用 tool_calls + content 自行推导。）
        round: round + 1,
        hadToolResult,
        draftWithoutSend: !(Array.isArray(msg.tool_calls) && msg.tool_calls.length)
          && typeof msg.content === 'string' && msg.content.trim().length > 0
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        //
        // ⚠️ 但这里有个实测出来的失效模式：模型把**完整的、面向用户的回答**写进正文、
        // 又没调用 send_message —— 那段话谁都没收到（会话页显示"未回复"）。
        //
        // 实测数据（冻结上下文重放，每个上下文各 20 遍）：
        //   · "工具返回后、准备作答"这个位置，漏发率 25%~40%
        //   · 与温度无关：温度 0（贪心）也漏 20~25%
        //   · 生产数据：152 次该位置的生成里有 6 次这种形态，其中 2 次真的一个字都没发出去；
        //     而"本轮之前没有工具结果"的位置 100 次里一次都没有
        //
        // ⚠️ 追问**不在这里做**（2026-09-19 改动）：原先它挂在这个分支里，
        //    结果只覆盖"模型没调任何工具"这一条退出路径 ——
        //    模型调 `finish` 或用满 maxRounds 时都够不到，正文照样丢（见循环后的兜底注释）。
        //    现在统一交给循环后的那一处，判据也更简单：整次没发过 + 最后一条有正文。
        break;
      }

      const toolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      for (const call of toolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const result = await executeTool(toolDefs, ctx, name, argsRaw);
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        toolResults.push({ role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError });
        // ── 工具结果原样落盘（2026-09-15 改）──
        //
        // 原来这里写的是 `contentStr.slice(0, 2000)`，超长结果会被**写掉一截且不可恢复** ——
        // 于是"拿 session 原样重放"这件事在长结果上就做不到了（而长结果恰恰是最值得重放的：
        // 研究"工具返回之后那一轮"的失败时，上下文必须逐字节一致）。
        //
        // 先量过再决定的：140 个会话 / 364 条工具结果里只有 6 条（1.6%）触及 2000 字上限，
        // 工具结果文本总共只占 session 体积的 0.8% —— 所以直接不截断，代价可以忽略。
        // 留一个 50000 字的兜底只为防病态输入（真触发会置 truncated，以便事后辨认）。
        const TOOL_RESULT_MAX = 50000;
        const resultFull = contentStr.length > TOOL_RESULT_MAX ? contentStr.slice(0, TOOL_RESULT_MAX) : contentStr;
        session.messages.push({
          toolCall: {
            name,
            args: safeParse(argsRaw),
            result: resultFull,
            resultChars: contentStr.length,          // 原始长度（不看内容也能筛样本）
            truncated: contentStr.length > TOOL_RESULT_MAX,
            isError: !!result.isError
          }
        });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        if (name === 'finish') finish = true;
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      // 图片消息跟随在全部 tool 结果之后（OpenAI 校验要求每个 tool_call 都有对应 tool 消息）
      messages.push(...imageUserMessages);
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
      roundsUsed = round + 1;
    }

    // ── 循环后的漏发兜底（2026-09-19 新增）────────────────────────────────
    //
    // 为什么要在这里再兜一次：原来的追问**只挂在"模型没调任何工具"这一条路径的分支里**
    // （见上面 `if (!toolCalls.length)` 那段）。而循环还有另外两条退出路径：
    //   · 模型调了 `finish` ⇒ 循环条件 `!finish` 直接结束，追问**够不到**
    //   · 用满 `maxRounds` ⇒ 同上
    // ⇒ 只要模型在这两条路径上把**用户可见的正文**写进了 content 却没调发送工具，
    //   那段话就永久丢失，而且模型自己以为已经回了。
    //
    // 实测证据（2026-09-19，449 个真实会话逐条排查）：
    //   `mu6mhmro-7f20755c`：模型把回答写进 finish 的 content
    //     （"P3 大概 94%，sRGB 是满的。响应实测 2.46ms 左右…"），
    //     `sent` 为空，finishReason 却自称"一条消息答完" ⇒ 用户一个字都没收到。
    //   `mu1j1m6b-771c157f`：同样形态（25 字正文、0 个工具调用、sent 为空）。
    //
    // ⚠️ 为什么不区分"是发言还是独白"：我们不去猜，让模型自己判断 ——
    //    这与上面那段分支里的追问设计一致（实测它确实会用「【内心】」这类标记自我区分）。
    // ⚠️ 为什么不用 `!finish` 做条件：循环走到这儿 `finish` 必为 true（否则条件不成立），
    //    所以判据只能落在"**整次运行一条都没发过 + 最后一条有正文**"上。
    //    这同时覆盖"它有话说却写进了 finish 的 content"这个真实失效模式。
    // ⚠️ maxRounds 保护：追问要再发一次请求，给它单独一轮预算，不占用正常轮次。
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    const leftoverDraft = typeof lastAssistant?.content === 'string' ? lastAssistant.content.trim() : '';
    if (!nudged && !this.aborted && leftoverDraft && session.sent.length === 0
        && roundsUsed < maxRounds && !session.error) {
      nudged = true;
      session.nudged = true;
      session.messages.push({ nudgeDraft: leftoverDraft.slice(0, 300), nudgeReason: finish ? 'finish' : 'no-tool-call' });
      messages.push({ role: 'user', content: NUDGE_TEXT });
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
      markActivity('追问…');
      try {
        const retry = await chatCompletionWithRetry({ messages, tools: openAiTools });
        addUsage(session.usage, retry.usage);
        session.usage.calls += 1;
        session.model = retry.model || session.model;
        const rmsg = retry.message;
        const rContent = typeof rmsg.content === 'string' ? rmsg.content : '';
        const rToolCalls = Array.isArray(rmsg.tool_calls) ? rmsg.tool_calls : [];
        const rEntry = {
          role: 'assistant', content: rContent, tool_calls: rmsg.tool_calls ?? null,
          raw: retry.raw ?? null,
          // ⚠️ 记账必须与循环一致（2026-09-19 修）：
          //    `round` 的语义是"**本次运行的**第几次模型调用"（27 个正常会话里
          //    `session.rounds` 与最后一条 assistant 的 round 100% 相等，这就是判据）。
          //    重试是**紧接着的第 2 次调用**，所以是 `roundsUsed + 2`、`session.rounds = roundsUsed + 2`。
          //    第一版写成 +1，导致重试条目拿到 `round=1` —— 而它明明是第 2 次说话，
          //    于是"首轮必为 false"的不变式被破坏（真实数据里抓出来 2 例，回归 check-fields.mjs 报红）。
          round: roundsUsed + 2, hadToolResult: true, nudgeRetry: true,
          draftWithoutSend: !rToolCalls.length && rContent.trim().length > 0
        };
        messages.push(rEntry);
        session.messages.push(structuredClone(rEntry));
        session.rounds = roundsUsed + 2;
        // 追问后如果它这次调了工具，就把工具跑掉（只跑一轮，不再递归追问）
        for (const call of rToolCalls) {
          const nm = call?.function?.name ?? '';
          markActivity(`正在调用 ${nm}…`);
          const res = await executeTool(toolDefs, ctx, nm, call?.function?.arguments ?? '{}');
          const text = Array.isArray(res.content)
            ? res.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
            : String(res.content ?? '');
          messages.push({ role: 'tool', tool_call_id: call.id, name: nm, content: text });
        }
      } catch (error) {
        session.messages.push({ nudgeError: String(error?.message ?? error).slice(0, 200) });
      }
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');
    // 追问有没有救回来（给研究统计用：nudged=追问过，nudgeRecovered=追问之后真的发出去了）
    if (session.nudged) session.nudgeRecovered = session.sent.length > 0;
    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused || cfg.proactive?.enabled !== true) return;
      // ① 安静时段：先判这个再判别的 —— 它是唯一一个"跟聊天内容完全无关"的闸，
      //    而且它的默认档（23→8）本身就表达了一种立场：半夜不吵人。
      if (this.#quietHours(cfg)) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      if (Math.random() > (Number(cfg.proactive?.probability) || 0.25)) return;
      // 挑一个"安静且允许"的群
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      // 先记"开口了一次"，再唤醒。
      // ⚠️ 顺序：必须在 wake 之前记 —— wake 是异步的，而且它可能什么都没发出去
      //    （模型有权决定"这次不说话"）。**记的是"给了它一次主动开口的机会"**，
      //    这正是我们要限制的东西（为什么半夜/连发要受限），而不是"它真的说了几句"。
      this.store.markProactiveSent(chatKey);
      this.wake(chatKey, { proactive: true }).catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
  }

  /** 现在是不是"安静时段"（判定见模块级 quietHoursAt） */
  #quietHours(cfg) {
    return quietHoursAt(cfg);
  }

  /**
   * 主动开口的**只读**评估（2026-09-19 加）—— 给设置页那一块显示"现在会不会开口、为什么"。
   *
   * 为什么需要：主动开口的判定链有**六道**（开关 → 安静时段 → 并发 → 掷骰子 →
   *   冷场阈值/白名单/未读 → 连发上限+退避），而其中四道的参数原来在界面上根本看不见。
   *   结果就是"它到底会不会开口"完全靠猜 —— 这个方法是把那条链**摊开说清**。
   * ⚠️ **只读**：不掷骰子（否则每次调接口都消耗一次机会）、不改任何状态、不唤醒。
   *    "掷骰子"那一项只报概率，不报结果。
   */
  proactiveReport() {
    const cfg = getConfig();
    const p = cfg.proactive || {};
    const enabled = p.enabled === true;
    const idleMs = Math.max(300000, Number(p.idleThresholdMs) || 1800000);
    const maxConsec = Math.max(1, Number(p.maxConsecutive) || 2);
    const quietNow = quietHoursAt(cfg);
    const busy = this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2);

    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const chats = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      const inAllow = allowGroups.length > 0 ? allowGroups.includes(id) : !!cfg.allowAllWhenEmpty;
      const meta = this.store.getChatMeta(chatKey);
      const pro = this.store.peekProactive(chatKey);
      const idleForMs = Math.max(0, Date.now() - (Number(meta.lastTs) || 0));
      // 逐条说清"为什么不行"，顺序与 #proactiveCandidates 一致
      let blocked = '';
      if (!inAllow) blocked = '不在白名单里';
      else if (Number(meta.unread) > 0) blocked = `有 ${meta.unread} 条未读`;
      else if (idleForMs < idleMs) blocked = `只静默了 ${Math.round(idleForMs / 60000)} 分钟（要 ${Math.round(idleMs / 60000)} 分钟）`;
      else if (this.runningChats.has(chatKey)) blocked = '正在处理这个会话';
      else if (Number(pro.consecutive) >= maxConsec) {
        const waited = Date.now() - (Number(pro.lastAt) || 0);
        const need = this.#reengageWaitMs(cfg, Number(pro.consecutive) - maxConsec + 1);
        blocked = waited >= need
          ? ''   // 等够了，"再戳一次"是允许的
          : `已开口 ${pro.consecutive} 次没人理，还要再等 ${Math.max(0, Math.round((need - waited) / 3600000))} 小时`;
      }
      chats.push({
        chatKey, consecutive: Number(pro.consecutive) || 0,
        idleMinutes: Math.round(idleForMs / 60000), ok: !blocked, blocked
      });
    }
    // 全局层面先说清
    const globalBlock = !enabled ? '总开关关着'
      : quietNow ? `现在是安静时段（${Number(p.quietHoursStart) || 23} 点 ~ ${Number(p.quietHoursEnd) || 8} 点），不会开口`
        : busy ? `正在忙（并发上限 ${Math.max(1, Number(cfg.maxConcurrentRuns) || 2)}），这次跳过`
          : '';
    return {
      enabled, quietNow, busy, globalBlock,
      intervalMinutes: [Math.round((Number(p.checkIntervalMinMs) || 1800000) / 60000), Math.round((Number(p.checkIntervalMaxMs) || 5400000) / 60000)],
      probability: Number(p.probability) || 0.25,
      idleThresholdMinutes: Math.round(idleMs / 60000),
      quietHours: [Number(p.quietHoursStart) || 23, Number(p.quietHoursEnd) || 8],
      maxConsecutive: maxConsec,
      reengage: {
        afterHours: Number(p.reengageAfterHours) || 14,
        backoff: Number(p.reengageBackoff) || 2,
        maxHours: Number(p.reengageMaxHours) || 336
      },
      chats
    };
  }

  /** 被晾久了允许"再戳一次"的等待时长（算式见模块级 reengageWaitMs） */
  #reengageWaitMs(cfg, unanswered) {
    return reengageWaitMs(cfg, unanswered);
  }

  #proactiveCandidates(cfg) {
    const idleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind !== 'group') continue;
      if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      // ② 连发上限 + ③ 退避：没人搭理就收手，被晾久了只允许按翻倍等待"再戳一次"。
      const pro = this.store.peekProactive(chatKey);
      const maxConsec = Math.max(1, Number(cfg.proactive?.maxConsecutive) || 2);
      if (pro.consecutive >= maxConsec) {
        const waited = Date.now() - (pro.lastAt || 0);
        if (waited < this.#reengageWaitMs(cfg, pro.consecutive - maxConsec + 1)) continue;
      }
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      const maxPerMember = Math.max(2, Number(cfg.memory?.maxImpressionsPerMember) || 5);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      const minInterval = Math.max(30 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 6 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) { failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' }); continue; }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    this.#markConsolidated(chatKey, targets.map((t) => t.userId).filter(Boolean));
    return { ok: true, note, changed, results, skipped, failed };
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号（必要时反查名字并回写记忆文件）。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            try {
              this.memory.replaceMember(chatKey, userId, mem.name, mem.impressions.map((e) => e.content));
            } catch { /* 回写失败不阻塞整理 */ }
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;

    // 整理模式：条数变多 = 疑似幻觉，放弃（保留原印象）
    if (!isNew && raw.length > existing.length) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数变多（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean);
  }

  /** 整理模式：合并/删减已有印象。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。你只做合并、改写与删除，绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 把同义/重复的印象合并成一条，以最新的观感为准。',
        '2. 明显过时、矛盾、或一次性事件（不会再次影响相处）的印象删除。',
        `3. 最多保留 ${maxKeep} 条，每条不超过 120 字。`,
        '原则：所有信息只能来自原文，语义不变，宁少勿错；没有可保留的时输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Number(getConfig().memory?.maxImpressionsPerMember) || 5;
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      return chatCompletion({ messages, temperature: 0.2 });
    }    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    if (!p?.baseURL || !p?.apiKey || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: p.apiKey, model: mem.model, timeoutMs: 180000 }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();
    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].map(([chatKey, sessionId]) => ({ chatKey, sessionId })),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

// ── 内联工具调用解析（少数模型不返回原生 tool_calls，而是把调用写进文本） ──
// 支持的格式：
//   1. <tool_call> <function=send_message> <parameter=messages>…</parameter> </function> </tool_call>
//   2. <tool_call> {"name":"send_message","arguments":{...}} </tool_call>
//   3. <tool_call> send_message \n {"messages":"..."} </tool_call>
// 返回 [{ name, args }]；没有解析到则返回 []。
export function parseInlineToolCalls(text) {
  const out = [];
  const blockRe = /<tool_call\b[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let match;
  while ((match = blockRe.exec(String(text || ''))) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    const call = parseInlineBlock(block);
    if (call) out.push(call);
  }
  return out;
}

function parseInlineBlock(block) {
  // 1) 整个块是 JSON：{"name": "...", "arguments": {...}}（部分模型用 parameters/args）
  const jsonMatch = block.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const name = obj.name || obj.function || obj.tool;
      const args = obj.arguments || obj.parameters || obj.args || obj.input || {};
      if (name) return { name: String(name), args: (args && typeof args === 'object' && !Array.isArray(args)) ? args : {} };
    } catch { /* 不是 JSON，继续按 XML 解析 */ }
  }

  // 2) <function=send_message> + <parameter=key>value</parameter>
  const fnMatch = block.match(/<function\s*=\s*([^>]+)>/i);
  let name = fnMatch ? fnMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  const args = {};
  const paramRe = /<parameter\s*=\s*([^>]+)>([\s\S]*?)<\/parameter>/gi;
  let pm;
  while ((pm = paramRe.exec(block)) !== null) {
    const key = pm[1].trim().replace(/^["']|["']$/g, '');
    let value = pm[2].trim();
    try { value = JSON.parse(value); } catch { /* 保持原始文本 */ }
    args[key] = value;
  }
  if (name && fnMatch) return { name, args };

  // 3) 首行是函数名，其余是 JSON 参数（GLM/Qwen 部分格式）
  const lines = block.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!name && lines.length >= 2 && /^[a-zA-Z_][\w.-]*$/.test(lines[0])) {
    name = lines[0];
    try {
      const parsed = JSON.parse(lines.slice(1).join('\n'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { name, args: parsed };
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 「写了正文但没调用发送工具」时的追问文本。
 *
 * ⚠️ 它是**追加在对话末尾**的，不会动到前面已经缓存的前缀（这点很重要，
 *    见 prompt.js 里关于块顺序的注释：改前面一个字，后面全部按原价重算）。
 *
 * 措辞要点：
 *   · 说清后果（"不会发出去、群友看不到"）—— 模型并不知道正文不发送
 *   · 给出两条路（发 / 不发），并明确"本来就决定不说话就直接结束"
 *     —— 否则它可能为了配合追问硬发一条不该发的
 *   · 强调**原样发即可**，避免它借机重写一遍（重写可能改得更好，也可能改坏，
 *     而我们要的是把它已经想好的那句话送出去）
 */
const NUDGE_TEXT = '[系统：你刚才写了一段话，但**没有调用 send_message** —— 那样不会发出去，群友看不到。\n'
  + '如果那是你想说的：现在调用 send_message 把它发出去，原样发即可，不用重写。\n'
  + '如果你本来就决定这次不说话：直接结束就好，什么都不用做。]';

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
