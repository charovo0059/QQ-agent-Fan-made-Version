// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText, toFileUri, fmtBytes } from './util.js';
import { getConfig, DEFAULT_CONFIG } from './config.js';
import { initProxyConfig, resolveProxyFor } from './proxy.js';

// 🔴 注入（同 safe-fetch/web-search/cf-fetch）：不注入 ⇒ 代理判定恒 false ⇒
//    pximg 那条"有代理就走原链"的优先级会静默失效（退回一律加反代，看不出区别）。
initProxyConfig(getConfig);

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

/**
 * 文字/查询类 OneBot 调用的超时（**这个值一个字都没改**，保持历史行为）。
 *
 * ⚠️ 抽成具名常量只是为了让"两档超时"这件事**看得见** —— 原来它是 `call()` 的
 *    默认参数里那个裸的 `15000`，而图片那一档要读配置（见 `imageSendTimeoutMs`），
 *    两档摆在一起才能一眼看出"图片没有跟着文字一起变"。
 */
export const TEXT_TIMEOUT_MS = 15000;

/**
 * 发**图片**那一档的超时（毫秒）—— 从 `config.send.imageTimeoutMs` 现读。
 *
 * 为什么在这里读、而不是让 `sender.js` 传进来：
 *   `onebot.js` 本来就是"那个 15000 的所在地"，而图片两档的分界也长在这两个方法上
 *   （`sendImage` / `sendSticker`→`sendImage`）。放在一处 ⇒ 只有一个真相源，
 *   也顺手让 `sendSticker`（同一个报文）自动跟上，不必再改一遍调用方。
 *
 * ⚠️ 非法值（0 / 负数 / 非数字）一律回落到 `DEFAULT_CONFIG.send.imageTimeoutMs`
 *    —— 与 `sender.js` 的 `#pokeLimits` / `#dedupeWindow` 同一套口径，
 *    也防止判据里"设成 0 想表达立刻超时"变成"0 = 没有超时"。
 */
export function imageSendTimeoutMs() {
  let raw;
  try { raw = getConfig()?.send?.imageTimeoutMs; } catch { raw = undefined; }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONFIG.send.imageTimeoutMs;
}

/** 判断一个错误是不是 `AbortSignal.timeout` 抛出来的超时（要把它翻译成人话）。 */
function isTimeoutError(error) {
  const name = String(error?.name ?? '');
  const msg = String(error?.message ?? error);
  return name === 'TimeoutError' || /aborted due to timeout|operation was aborted/i.test(msg);
}

// ── 入站去重 + 静默判定（🆕 2026-10-06 第四十六对话 · 第三方报告 S5 复核后落地）──────────
//
// 报告说这两条缺了，**核实成立**：
//   · 没有存活检测 ⇒ "假在线"（连接对象还在、但事件一个都收不到），机器人长时间丢消息且无告警；
//   · 没有入站 `message_id` 去重 ⇒ 协议端重投 / 重连重放时，同一条消息被处理两次
//     （重复调模型 + 重复发言）。
//
// 🔴 为什么抽成**独立类 / 纯函数**：判据要能**真跑**它们，而不是起一个真的 WS ——
//    这也是本项目"判据要能验真实现"的一贯要求。
// ⚠️ 报告建议的三件事里，**离线消息队列有意不抄**（它自己也这么说）：`sender.js` 已有失败登记与重发
//    （`data/send-failures.json`），再加一层会出现"两套失败账"，违反本项目"单一口径"的原则。

/** 入站消息 id 的 LRU（Map 的插入序 = 时间序，从头部淘汰）。 */
export class InboundDedupe {
  #map = new Map();
  #max;
  #ttlMs;
  constructor({ max = 2000, ttlMs = 10 * 60 * 1000 } = {}) {
    this.#max = Math.max(1, Number(max) || 2000);
    this.#ttlMs = Math.max(1000, Number(ttlMs) || 600000);
  }
  /** true = 这条**见过**（调用方应当丢掉）；首次见到返回 false 并记账。 */
  seen(id, now = Date.now()) {
    const key = String(id);
    // 先按时间把过期的从头清掉（插入序就是时间序 ⇒ 遇到没过期的就能停）
    for (const [k, ts] of this.#map) {
      if (now - ts <= this.#ttlMs) break;
      this.#map.delete(k);
    }
    if (this.#map.has(key)) return true;
    this.#map.set(key, now);
    while (this.#map.size > this.#max) this.#map.delete(this.#map.keys().next().value);
    return false;
  }
  get size() { return this.#map.size; }
  clear() { this.#map.clear(); }
}

/**
 * 静默判定的**纯函数**（把"什么时候**不**该重连"写死在一处，判据好钉）。
 * @returns {{reconnect: boolean, reason: string}}
 */
export function judgeSilence({ heartbeatCount, heartbeatGapMs, lastEventAtMs, nowMs, minLimitMs = 90000 }) {
  // 🔴 关键的安全阀：**没见过 ≥2 次心跳就绝不判定**。
  //    有些 OneBot 实现（或某些配置）根本不推心跳；不设这道闸的话，"静默检测"会变成
  //    "每 90 秒无脑重连一次"，把好端端的连接反复掐断 —— **比原来的问题更糟**。
  if (!(Number(heartbeatCount) >= 2)) {
    return { reconnect: false, reason: '还没见到 ≥2 次心跳 ⇒ 不做静默判定（服务端可能根本不发心跳）' };
  }
  const gap = Math.max(0, Number(heartbeatGapMs) || 0);
  const limit = Math.max(Number(minLimitMs) || 90000, gap * 3);   // 3 倍心跳间隔，且不低于 90s
  const silent = Math.max(0, Number(nowMs) - Number(lastEventAtMs));
  if (silent <= limit) {
    return { reconnect: false, reason: `静默 ${Math.round(silent / 1000)}s ≤ 上限 ${Math.round(limit / 1000)}s` };
  }
  return {
    reconnect: true,
    reason: `静默 ${Math.round(silent / 1000)}s > 上限 ${Math.round(limit / 1000)}s`
      + `（见过 ${heartbeatCount} 次心跳、间隔约 ${Math.round(gap / 1000)}s ⇒ 链路多半已经死了）`
  };
}

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
    this.reconnectDelayMs = RECONNECT_MIN_MS;   // 退避当前档位（连上一次就复位）
    this.reconnectTimer = null;                 // 待重连的定时器句柄（close() 要能真的取消它）
    // 🆕 S5：存活信号（`#lastEventAt` 初值给"现在"，免得刚连上就被判成静默）
    this.#lastEventAt = Date.now();
  }

  #closedByUs;
  // 🆕 S5：入站去重 + 心跳统计（都只在这个实例里，不跨连接共享）
  #inbound = new InboundDedupe();
  #lastEventAt = 0;     // 最近一次**收到任何事件**的时刻
  #hbCount = 0;         // 见过几次心跳（`post_type === 'meta_event'`）
  #hbPrevAt = 0;        // 上一次心跳的时刻（用来量间隔）
  #hbGapMs = 0;         // 心跳间隔估计（最近两次心跳之差）
  #livenessTimer = null;   // 每 30 秒看一眼"还活着吗"（unref，不吊住事件循环）

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    // 配置变了是"有意重连"，从最短档重新开始退避（不然一次长时间断线后，
    // 用户改完令牌也要等半分钟才重试）
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  /**
   * 安排下一次重连，**带指数退避**（3s → 6s → 12s → 24s → 封顶 30s；连上一次就复位）。
   *
   * 🔴 2026-09-24（第十三对话 · 交接 §3 待办 9 / T4）：`RECONNECT_MAX_MS` 这个常量
   *    **定义了从来没被用过** —— 两处重连都写死 `RECONNECT_MIN_MS`，也就是"桥挂了就每 3 秒敲一次、
   *    永远敲下去"。症状不是报错，而是**日志被刷 + 无谓的连接尝试**（本项目对"静默"敏感，
   *    对这种"吵闹的浪费"也得治）。⚠️ 上游那一轮早就改成了指数退避，我们当时**记的是"没跟"**
   *    （见 `工具-会话诊断\查-上游审计85项对照.mjs` 的 L-4 条目）—— 本轮跟上。
   *
   * ⚠️ 顺带修掉一个**真 bug**：`#connectLoop` 里"构造 WebSocket 同步抛异常"那条路原来
   *    **无条件** `setTimeout(..., RECONNECT_MIN_MS)`、**不看 `#closedByUs`** ⇒
   *    `close()` 之后只要还处在那 3 秒窗口里，它就会**把连接重新拉起来**
   *    （症状："我明明关了，它自己又连上了"）。现在统一走这里，并且句柄留着、`close()` 真的能取消。
   */
  // ── 🆕 S5：存活性巡检（每 30 秒看一眼"还活着吗"）────────────────────────────
  /** 记一次"链路还活着"；`meta_event` 额外用来量心跳间隔。 */
  #noteEvent(event) {
    const now = Date.now();
    this.#lastEventAt = now;
    if (event?.post_type === 'meta_event') {
      // ⚠️ 各种实现给的 `meta_event_type` 不一样（heartbeat / lifecycle / …）⇒ **一律当心跳**。
      if (this.#hbPrevAt) this.#hbGapMs = now - this.#hbPrevAt;
      this.#hbPrevAt = now;
      this.#hbCount += 1;
    }
  }

  #startLiveness() {
    this.#stopLiveness();
    // ⚠️ unref：别拿它吊住事件循环（本项目在 fs.watch / 300 秒定时器上踩过两次）
    this.#livenessTimer = setInterval(() => this.#checkLiveness(), 30000);
    if (typeof this.#livenessTimer.unref === 'function') this.#livenessTimer.unref();
  }

  #stopLiveness() {
    if (this.#livenessTimer) { clearInterval(this.#livenessTimer); this.#livenessTimer = null; }
  }

  /**
   * 巡检：判定"假在线"（连接对象还在、事件一个都收不到）并主动重连。
   * 判定规则全在 `judgeSilence` 那个纯函数里（判据直接真跑它，⛔ 别把规则抄回这里）。
   */
  #checkLiveness() {
    const verdict = judgeSilence({
      heartbeatCount: this.#hbCount,
      heartbeatGapMs: this.#hbGapMs,
      lastEventAtMs: this.#lastEventAt,
      nowMs: Date.now()
    });
    if (!verdict.reconnect) return;
    console.warn(`[onebot] 判定链路已死：${verdict.reason} ⇒ 主动重连`);
    const dead = this.socket;
    // 先作废旧 socket：它迟到的 close / message 都会被 `isCurrent` 挡掉（不会重复重连、也不重复处理事件）
    this.socket = null;
    this.#stopLiveness();
    try { dead?.terminate ? dead.terminate() : dead?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#closedByUs) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.#closedByUs) return;
      this.#connectLoop();
    }, delay);
    // 别把这个定时器变成"吊住事件循环"的活跃句柄（本项目在 fs.watch / 300 秒定时器上踩过两次）。
    // 应用里 HTTP 服务自己撑着事件循环；测试里则让它能干净退出。
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      this.#scheduleReconnect();     // 带退避；且尊重 #closedByUs（原来这一句没有守卫）
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      this.reconnectDelayMs = RECONNECT_MIN_MS;   // 连上了 ⇒ 退避复位（下次断线仍从 3s 起）
      // 🆕 S5：新连接按"刚活过"起算，并启动存活性巡检（见 #checkLiveness）。
      // ⚠️ 必须在这里重置 `#lastEventAt`/`#hbPrevAt`：否则重连之后第一次巡检会拿着**旧连接**的
      //    静默时长立刻又判一次"死了"，变成重连风暴。
      this.#lastEventAt = Date.now();
      this.#hbPrevAt = 0;
      this.#startLiveness();
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      // 🆕 S5-①：任何事件都算"链路还活着"；`meta_event` 额外用来量心跳间隔。
      this.#noteEvent(event);
      // 🆕 S5-②：入站去重 —— 协议端重投 / 重连重放同一条消息时不重复处理，且**出声**。
      if (event.post_type === 'message' && event.message_id !== undefined && event.message_id !== null) {
        if (this.#inbound.seen(event.message_id)) {
          console.warn(`[onebot] 丢掉重复入站消息（message_id=${event.message_id}）——`
            + ' 协议端重投或重连重放；同一条只处理一次（防重复调模型 + 重复发言）');
          return;
        }
      }
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#stopLiveness();
      this.#setStatus(false);
      this.#scheduleReconnect();      // 内部会看 #closedByUs（`close()` 之后不再重连）
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    this.#stopLiveness();          // 🆕 S5：巡检也跟着停（不然它到点还会去判一次、再去重连）
    // 🆕 2026-09-24：把**待重连的定时器**也取消掉。不然它到点点火又去连一次，
    // 而 `close()` 的语义是"我这次真的不要它了"（原来只有 close 事件那条路看了 #closedByUs，
    // 同步抛异常那条路没看 ⇒ "关了又自己连上"）。
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = TEXT_TIMEOUT_MS) {
    const res = await fetch(`${this.httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const hint = res.status === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      throw new Error(`OneBot ${action} HTTP ${res.status}${hint}`);
    }
    const body = await res.json().catch(() => ({}));
    if (body.status !== 'ok' && body.retcode !== 0) {
      throw new Error(`OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${body.wording ?? ''}`);
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /**
   * 发送消息段。返回 OneBot 响应 data（含 message_id）。
   *
   * @param {number} [timeoutMs] 不传 = 走 `call()` 的默认（文字那一档 15 秒）。
   *   ⚠️ **只有图片那条路传它**（见 `sendImage`）—— 文字/表情包以外的调用一律不传，
   *      免得"发文字"也悄悄跟着图片一起变慢。
   */
  async sendSegments(kind, id, segments, timeoutMs) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params, timeoutMs);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发一张**图片**（独立气泡）。
   *
   * 🆕 2026-09-25（第十八对话）：从 `sendSticker` **泛化**出来 —— 两者的报文体一模一样的
   *   都是 `{ type: 'image', data: { file: <图片地址> } }`，差别只在**业务含义**
   *   （表情包要 sticker id / 走表情限频；普通图片不用）。⇒ 只留**一份**实现，
   *   `sendSticker` 转发到这里（原来那段是重复代码）。
   *
   * ⚠️ `file` 既可以是 http(s) 链接，也可以是 `file://` 本地路径（协议端自己读盘，见 `toFileUri`）。
   *    调用方负责校验地址合法性 —— **本层不做安全判断**（它只负责"把这段话发给协议端"）。
   *
   * 🆕 2026-10-05（第四十三对话 · 交接 §3-111）：这一档的超时**不再吃全局的 15 秒**，
   *    改读 `config.send.imageTimeoutMs`（默认 60 秒，见 `imageSendTimeoutMs` 的注释）。
   *    `sendSticker` 转发到这里 ⇒ 表情包同一个报文、同一个档位。
   *
   * 🔴 超时要**翻译成人话**再抛：协议端给的原文是
   *    `The operation was aborted due to timeout` —— 她（模型）看到这句只会当成"工具坏了"，
   *    于是要么放弃要么原样重试。这里改成"等了多少秒、这次没发出去、换张小图"。
   *    ⚠️ 措辞**不假装成功**：超时意味着没等到回执，图**可能**已经传出去了，
   *       所以只能说"很可能没发出去"，不能说"一定没发"（本项目最忌静默失败，也忌反过来的假话）。
   */
  async sendImage(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    const timeoutMs = imageSendTimeoutMs();
    try {
      return await this.sendSegments(kind, id, segments, timeoutMs);
    } catch (error) {
      if (!isTimeoutError(error)) throw error;
      const secs = Math.max(1, Math.round(timeoutMs / 1000));
      throw new Error(`图片上传超时（等了 ${secs} 秒）：协议端没能在这个时限内把图传完，`
        + '**这次很可能没发出去**。换一张小一点的图再试（或在「设置 → 发送保护 → 发图超时」里调大这个时限）。');
    }
  }

  /** 发一个收藏表情。**就是 `sendImage`**（表情与普通图片走完全相同的报文），保留此名是为了调用方语义清晰。 */
  async sendSticker(kind, id, imageUrl, opts = {}) {
    return this.sendImage(kind, id, imageUrl, opts);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }

  /**
   * 好友列表（2026-09-29 第三十对话加）。
   *
   * 为什么要一个类型化方法而不是在调用方写 `call('get_friend_list')`：
   * 现有那几个（`getGroupInfo` / `getGroupMemberInfo` / `getMsg`）都是这个形状 ——
   * 动作名与参数**只在这一个文件里**出现，调用方读的是意图（"我要好友列表"），
   * 以后某个实现要换动作名（或补协议差异）就只改这一处。
   *
   * 返回形状（实测 SnowLuma / OneBot v11）：`[{ user_id, nickname, remark, ... }]`。
   * ⚠️ `call()` 已经把 OneBot 的 `{status,retcode,data}` 拆过了（返回 `data`），
   *    所以这里的返回值**就是数组本身** —— 调用方不必再解一层。
   * ⚠️ 机器人没登录时这个动作可能**永不返回** ⇒ 调用方必须自带超时
   *    （见 `qq-contacts.js` 的 `syncQqFriendNames`）。
   */
  async getFriendList() {
    const data = await this.call('get_friend_list', {});
    return Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);
  }
}

// ── 卡片 / 富文本段 → 可读文字（2026-09-26 第二十五对话，提案 32bd8267）────────
//
// 她的原话：「现在收到卡片消息时只能看到一个空壳占位符，完全不知道里面是什么内容
// （比如群聊邀请的群名、分享的链接标题、转发的摘要等），只能让对方再打字说一遍……
// 希望能像合并转发一样，给卡片消息一个展开的方式：**要么直接展示卡片里的文字信息
// （标题、描述、来源）**，要么提供一个工具让我能读取卡片内容。」
//
// ⇒ 选的是**前一半**（直接展示）：卡片的内容在**入站那一刻就在手上**（`json` 段的
//    `data.data` 就是一个 JSON 字符串），不像合并转发那样需要事后拿 res_id 去换
//    （那个 id 会过期、message_id 还可能为负，见 fetchForward 的注释）。
//    ⇒ 入站时解析成文字写进那条消息的 text：**一处解析，过去状态 / 本次唤醒 / 引用原文
//    / 合并转发展开四处同时都有了**，不用加工具、不用动存档结构、老存档也不受影响。
//
// 真实形状（**不是猜的**：从 SnowLuma 的 messages.db 里 472 条真卡片统计出来的，
// 2026-09-26 实测 —— `com.tencent.music.lua` 236 条 / `miniapp_01` 171 / `tuwen.lua` 28 /
// `feed.lua` 21 / `gamecenter.mall` 5 / `mannounce` 5 / `activity.md` 4 / `miniapp.lua` 1 /
// `contact.lua` 1）：
//   `{"app":"com.tencent.music.lua","prompt":"[分享]遇见","view":"music",`
//   ` "meta":{"music":{"title":"遇见","desc":"船长—每晚8点弹唱直播","tag":"网易云音乐",`
//   `                 "jumpUrl":"https://music.163.com/#/song?id=..."}}}`
// ⇒ **字段名各家不同**（title / desc / tag / tagName / nickname / contentText / actTitle /
//    contact / qqdocurl / pcJumpUrl / legacyUrl…），所以这里**按 meta 下每个子对象当"视图"
//    依次找**，而不是给每个 app 写一套映射表（映射表会随 QQ 改版过期，而且过期时是静默失效）。
//
// ⚠️ 安全：卡片正文是**对方可控的文本**，会进她的上下文。两道处理：
//    ① 一律 `oneLine()` 压成单行（换行/制表/连续空白全折叠）⇒ 注入不进"新的一行"，
//       伪造不了提示词块；
//    ② 出口仍然走 `sanitizeUserText()`（segmentsToText 最后那一步会做），
//       `[本次唤醒]` 这类标记会被弱化 —— 与普通群消息同一套待遇，没有开新口子。

/** 压成单行 + 截断（卡片正文一律走它，见上面 ⚠️ 第 ① 条）。 */
function oneLine(s, max) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 已知的卡片 app → 人话。认不出就空串（⛔ 不编一个假的类型）。 */
const CARD_APP_KINDS = [
  [/^com\.tencent\.music/, '音乐分享'],
  [/^com\.tencent\.qun\.invite/, '群聊邀请'],
  [/^com\.tencent\.(miniapp|miniapp_01|miniapp\.lua)/, '小程序'],
  [/^com\.tencent\.(tuwen|news)/, '图文分享'],
  [/^com\.tencent\.feed/, '动态分享'],
  [/^com\.tencent\.contact/, '名片分享'],
  [/^com\.tencent\.mannounce/, '群公告'],
  [/^com\.tencent\.activity/, '活动分享'],
  [/^com\.tencent\.gamecenter/, '游戏中心'],
  [/^com\.tencent\.structmsg/, '分享']
];

export function cardKindOf(app) {
  const a = String(app ?? '').trim().toLowerCase();
  for (const [re, label] of CARD_APP_KINDS) if (re.test(a)) return label;
  return '';
}

/** base64 解一段文本（QQ 的群公告卡片把 title/text 编码成 base64，见 `encode:'1'`）。 */
function b64Text(v) {
  try {
    const s = String(v ?? '').replace(/-/g, '+').replace(/_/g, '/');
    const out = Buffer.from(s, 'base64').toString('utf8');
    // 解出来必须是"看得懂的文本"：全是替换符/控制字符就当没解开（⛔ 别把乱码喂给她）
    return /[\uFFFD]/.test(out) || !out.trim() ? '' : out;
  } catch { return '' }
}

/**
 * 解析一张卡片（`json` 段的 data，或其内部那个 JSON 字符串）。
 * @returns {{kind,title,desc,tag,url,prompt}|null} 解析不出任何可读内容 → null
 */
export function summarizeCard(raw) {
  let obj = raw;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  // 段里的形状是 `{ data: "<json 字符串>" }`；再往里一层才是卡片本体。
  if (obj && typeof obj === 'object' && typeof obj.data === 'string') {
    try {
      const inner = JSON.parse(obj.data);
      if (inner && typeof inner === 'object') obj = inner;
    } catch { /* 不是 JSON 字符串就按原对象继续（有些实现直接把对象放这儿） */ }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const views = [];
  const meta = obj.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    for (const v of Object.values(meta)) if (v && typeof v === 'object' && !Array.isArray(v)) views.push(v);
  }
  views.push(obj); // 兜底：有的卡片字段直接挂顶层
  const byKey = (k) => {
    for (const v of views) {
      const x = v[k];
      if (typeof x === 'string' && x.trim()) return x.trim();
    }
    return '';
  };
  const firstOf = (keys) => {
    for (const k of keys) {
      const v = byKey(k);
      if (v) return v;
    }
    return '';
  };
  // 群公告：encode='1' 时 title/text 是 base64（不解码就会把 `576k5YWs5ZGK` 当标题喂给她）。
  // ⚠️ 这个标记实测**长在视图对象里**（`meta.mannounce.encode`），不在卡片顶层 ⇒ 两处都看。
  //    顶层那个 `prompt` 反而是明文（`[群公告]QQ-Agent V0.4 preview已上传…`），不要解它。
  const encoded = String(obj.encode ?? '') === '1' || views.some((v) => String(v.encode ?? '') === '1');
  const dec = (s) => (encoded ? (b64Text(s) || s) : s);
  const title = dec(firstOf(['title', 'actTitle', 'nickname']));
  const desc = dec(firstOf(['desc', 'contentText', 'text', 'contact', 'forwardMessage']));
  const tag = firstOf(['tag', 'tagName', 'source']);
  // 链接**优先给 http(s) 的**（她手里有 web_fetch，这种才打得开）。
  // 实测同一个 app 里几种链接混着：`miniapp_01` 的 `url` 是 `m.q.qq.com/a/s/…`（无协议、点不开），
  // 而同一条的 `qqdocurl` 是 https；`feed` 的 `jumpUrl` 是 `mqzone://…`，
  // 同一条的 `legacyUrl`/`pcJumpUrl` 才是 https。⇒ 先按"能不能打开"选，全都不行才退回原样。
  const URL_KEYS = ['qqdocurl', 'jumpUrl', 'pcJumpUrl', 'legacyUrl', 'url'];
  const url = URL_KEYS.map(byKey).find((u) => /^https?:\/\//i.test(u)) || firstOf(URL_KEYS);
  const prompt = oneLine(obj.prompt, 80);
  if (!title && !desc && !prompt) return null;
  return { kind: cardKindOf(obj.app), title, desc, tag, url, prompt };
}

/** `json` 段 → `[卡片消息：类型｜标题｜描述｜来源：X｜链接]`（解析不出 → ''）。 */
export function cardSegmentText(d) {
  const c = summarizeCard(d?.data ?? d);
  if (!c) return '';
  const bits = [];
  if (c.kind) bits.push(c.kind);
  const head = c.title || c.prompt;
  if (head) bits.push(oneLine(head, 80));
  // prompt 与 title 常常是同一件事（`prompt` 就是 `[分享]<title>`）⇒ 只在没标题时用它
  if (c.desc) bits.push(oneLine(c.desc, 120));
  if (c.tag) bits.push(`来源：${oneLine(c.tag, 40)}`);
  if (c.url) bits.push(oneLine(c.url, 200));
  if (!bits.length) return '';
  return `[卡片消息：${oneLine(bits.join('｜'), 320)}]`;
}

/**
 * `markdown` 段（QQ 官方机器人的图文消息）→ 纯文本。
 *
 * 实测（同一个 db）：这类消息在我们这边以前**只存下 `[markdown][inline_keyboard]`
 * 两个占位符**（247 条），正文全丢 —— 与卡片是同一个病。
 * 正文形如 `[](%7B%22version%22%3A2%7D)\n### ![图片 #140px](https://…)\n> 正位：…`。
 */
export function markdownSegmentText(content) {
  let s = String(content ?? '');
  if (!s.trim()) return '';
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt && !/^图片/.test(alt) ? `[图片：${oneLine(alt, 20)}]` : '[图片]'));
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // 链接只留文字（url 又长又没用）
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');
  s = s.replace(/^[ \t]*>[ \t]?/gm, '');
  s = s.replace(/[*_`~]/g, '');
  const body = oneLine(s, 240);
  return body ? `[卡片消息（图文）]${body}` : '';
}

/** `inline_keyboard` 段 → 有哪些按钮（她想知道"这东西能点/能回什么"）。 */
export function keyboardSegmentText(d) {
  const labels = [];
  for (const row of d?.rows ?? []) {
    for (const b of row?.buttons ?? []) {
      const l = oneLine(b?.label ?? b?.visited_label, 20);
      if (l && !labels.includes(l)) labels.push(l);
      if (labels.length >= 6) break;
    }
    if (labels.length >= 6) break;
  }
  return labels.length ? `[按钮：${labels.join(' / ')}]` : '[按钮]';
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

/**
 * 磁力链接的「名字 + 总大小」—— **零依赖、不出网**（2026-10-03 第三十八对话）。
 *
 * 起因是她自己的提案 `0f6288a1`：「群友发 magnet 链接问里面是什么时，我完全看不到内容，
 *   只能回『我搜不了』」。用户 2026-10-03 拍板只做**最小版**：
 *   **只读磁力链里带的 `dn`（显示名）与 `xl`（总字节数），不引 bt 库、不做 DHT 抓取**。
 *
 * 为什么放在**入站解析**里、而不是做成一个工具（对照「卡片消息能看内容」那一轮）：
 *   ① 她在**过去状态 / 本次唤醒 / 引用原文**三处读的都是同一份 `text`（入库时写一次）；
 *      入库时解析 ⇒ 三处全都有，老消息也一并生效，⛔ 不必她记得去调一个工具；
 *   ② **不加工具定义 = 不占每轮的 token**（工具表在前缀里，多一个工具是常驻成本）。
 *
 * ⛔ 三条边界（别越界）：
 *   ① **绝不联网**：只解析这段字符串里的参数，不连 tracker、不连 DHT；
 *   ② **不删改原链接**：只在它后面追加一段方括号说明（原话一字不动，也不替她判断内容好坏）；
 *   ③ **读不到就说读不到**：链接里没带 `dn`/`xl` 时如实讲"没带"，⛔ 不猜文件名、不编大小。
 *
 * @returns {string} 追加在链接后面的说明；解析不出任何东西时返回空串（原样不动）
 */
export function magnetInfo(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (String(u.protocol).toLowerCase() !== 'magnet:') return '';
  const p = u.searchParams;
  const name = String(p.get('dn') || '').trim();
  const xl = String(p.get('xl') || '').trim();
  const bytes = /^\d+$/.test(xl) ? Number(xl) : 0;
  const parts = [];
  if (name) parts.push(`名字「${name.slice(0, 80)}」`);
  if (bytes > 0) parts.push(`总大小约 ${fmtBytes(bytes)}`);
  if (!parts.length) return '[磁力链接信息：这个链接里没带名字和大小，读不出来]';
  return `[磁力链接信息：${parts.join('｜')}]`;
}

/**
 * 把文本里出现的磁力链接各追加一段「名字 + 总大小」说明（见 `magnetInfo`）。
 * ⚠️ 绝大多数消息**在这里就返回**（先做一次 `includes` 粗筛，正则不跑）—— 那是热路径。
 */
export function annotateMagnetLinks(text) {
  const s = String(text ?? '');
  if (!/magnet:\?/i.test(s)) return s;
  // ⚠️ 链接的结束判定：空白或常见的中文标点/括号 —— 群友常把链接夹在一句话中间，
  //    只按空格切会把后面的字一起吃进来（判据里专门喂了"链接后面直接跟一句话"那种形状）。
  return s.replace(/magnet:\?[^\s"'<>（）()【】「」，。；、]+/gi, (raw) => {
    const info = magnetInfo(raw);
    return info ? `${raw} ${info}` : raw;
  });
}

/**
 * pixiv 图链的反代地址（**纯函数、不出网**）—— 2026-10-04 第四十对话 · 批 1。
 *
 * 起因：群里有人贴 `https://i.pximg.net/...` 的图链时，那条链接**必然超时失败**
 *   （pximg 有防盗链，要 Referer）。实测 `i.pixiv.re` 这个反代能下（HTTP 206，
 *   带 Referer 更快但**不带也通**，尺寸与 source 一致）。
 *
 * ⚠️ 只换 **host**：路径与查询**逐字保留**。⛔ 不用 `new URL()` 拼回去 —— 它会对
 *    路径做一遍百分号编码，把"逐字保留"变成"大多数时候保留"（那种模糊的保证没法判据）。
 *
 * 🔴 2026-10-04（第四十一对话 · 内置代理批 A，回执 §四 须知 5）：**它降级为"没配代理时的备用路径"**。
 *    有了代理之后 pximg **本来就能直连**（那正是这批改动要解锁的东西）⇒ 那时再给一条
 *    `i.pixiv.re` 反而是把人往一个多余的第三方反代上引。
 *    ⇒ 优先级：**有代理走原链**（本函数返回空串 = 调用方原样不动）；**没代理才用反代**。
 *    ⛔ 别把这条判断删掉改回"一律加反代"——那会让"代理生效了"这件事在用户眼里看不出区别。
 *
 * @returns {string} 反代地址；不是 `i.pximg.net` 的链接、或**代理已启用**时返回空串（原样不动）
 */
export function pixivProxyUrl(url) {
  if (resolveProxyFor('i.pximg.net')) return '';   // 有代理 ⇒ 原链可直连，不再引第三方反代
  const m = /^https?:\/\/i\.pximg\.net(\/[^\s]*)?$/i.exec(String(url ?? '').trim());
  return m ? `https://i.pixiv.re${m[1] || ''}` : '';
}

/**
 * 把文本里出现的 pixiv 图链各追加一句「（可用地址：…）」（见 `pixivProxyUrl`）。
 *
 * ⛔ 三条边界（与 `annotateMagnetLinks` 完全一致，别越界）：
 *   ① **绝不联网**（只做字符串替换）；
 *   ② **不删改原链接**（原地追加，群友的原话一字不动）；
 *   ③ 只在**认出是 pximg** 时才出声，别的链接一个字都不碰。
 *
 * 🔴 这**不是**"她就能发这张图了"（用户拍板 Q2=B1）：`send_image` 有一条既有的安全边界
 *    ——只肯发"本轮她真的见过"的地址（由 `search_images`/`get_message_images` 登记），
 *    而入站贴来的链接**不在那里面** ⇒ 她那轮仍发不出去。这条注释写在这儿，是为了下一个人
 *    别把"看见了可用地址"误读成"这条路已经通了"（要真通得动那条安全边界，是 Q2-B2）。
 */
export function annotatePixivLinks(text) {
  const s = String(text ?? '');
  if (!/i\.pximg\.net\//i.test(s)) return s;
  return s.replace(/https?:\/\/i\.pximg\.net\/[^\s"'<>（）()【】「」，。；、]+/gi, (raw) => {
    const proxy = pixivProxyUrl(raw);
    return proxy ? `${raw}（可用地址：${proxy}）` : raw;
  });
}


export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 * selfId: 机器人自己的 QQ 号（**有它才敢标"在叫别人"**，见下面 `at` 分支的注释）。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, selfId = '' } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const self = String(selfId ?? '').trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null } catch { name = null }
          const who = name ? `@${name}` : `@${d.qq}`;
          // 🆕 「@别人」明确标出来（2026-09-20 第八对话，用户提供截图）。
          //
          // ── 为什么需要它 ────────────────────────────────────────────────
          // 实测那一轮：群里 `@年灬少ゞ 妈妈`（**在叫别人**），她引用了那条并回「嗯？怎么啦」，
          // 自述写「达困叫妈妈，简短接住了」——她把"妈妈"当成了在叫她（人设是萝莉妈妈气质版）。
          // 提示词里**没有任何一条规则**覆盖这种情况：场景规则那条只管「引用」
          // （"引用对象不是你时别抢话"），而 @别人 既不是引用也不含她的名字。
          // ⇒ 与其再加一条"要她记住"的规则（规则会被忽略），不如让"这不是叫你"变成
          //   她**看得见的事实**：`@年灬少ゞ（在叫别人） 妈妈`。
          //
          // ⚠️ **只有知道 selfId 时才标**：不知道自己的号就无法判断"别人"是谁，
          //    那时候乱标会把"在叫我"也标成"在叫别人" —— 比不标更糟。
          // ⚠️ 标在**入库时**（而不是渲染时）是刻意的：引用原文、过去状态、本次唤醒
          //    三处都读同一份 text，入库时标一次就全都有了，不会出现三处口径不一。
          //    代价：存档/界面里也会带上这五个字 —— 那是**如实**的（它确实在叫别人）。
          //
          // 🆕 「@我」也标出来（2026-09-20 第九对话，用户报"有人会给她改名"）。
          //
          // ── 为什么不能靠名字判断 ──────────────────────────────────────────
          // 触发标签里原来是用**字面匹配**认 @ 的（`text.includes('@' + 昵称)`）。
          // 实测 40 份最近存档，@ 她的消息被存成**三种互不相同**的形式：
          //     `@DeepSleep （本子搜索版）`  ← 群名片，QQ 把全角括号当分隔符**自动加了空格**（最高频）
          //     `@DeepSleep 关机`            ← 手工打的，不是结构化 at
          //     `@<QQ号>`                    ← resolveAtName 失败时的兜底（只在群聊里解析）
          // ⇒ 名字是被 QQ **化过妆**的，拿它反推"是不是在叫我"必然漏：改名、加前缀、
          //    QQ 塞的那个空格，任何一样都能让判据失效（改名前那句
          //    `@仓库炸了死机中的DeepSleep 评价一下` 就是这么漏掉的）。
          //
          // ⇒ 正解是**用 at 段里的 QQ 号**（它永远是结构化的、不会被化妆），
          //    在入库这一刻就把结论写下来 —— 与「在叫别人」完全同构。
          //    这样改名、加前缀、QQ 加空格、名字缓存过期，一律不影响判定。
          out.push(self
            ? (String(d.qq) === self ? `${who}（在叫我）` : `${who}（在叫别人）`)
            : who);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              // ⚠️ 把**被引用那条消息自己的 id** 一并带出来（2026-09-17 加）。
              //    不加的话模型手里只有"当前这条引用消息"的 id，想引用"被引用的那条"时
              //    无 id 可用 → 只能拿当前这条顶替 → 用户看到的就是"引用到了别的消息上"。
              //    用事件里原样的 d.id（别数字转换：那会毁掉负号与超 32 位的 id）。
              const rid = d?.id;
              const hasRid = rid !== null && rid !== undefined && String(rid).trim() !== '';
              if (hasRid) parts.push(`#${String(rid).trim()}`);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      // 卡片消息：能看到内容了（2026-09-26 第二十五对话，提案 32bd8267）。
      // ⚠️ 解析不出时**保留原来的占位符**（如实说"这是个卡片、但读不出内容"，
      //    比编一个空标题好，也比整条消息消失好）。
      case 'json': out.push(cardSegmentText(d) || '[卡片消息]'); break;
      // QQ 官方机器人的图文消息（markdown + 按钮成对出现，实测 247 组）。
      // 空正文时退回占位符 —— 段存在就说明"对方发了个富文本"，别让整条消息消失。
      case 'markdown': out.push(markdownSegmentText(d?.content) || '[卡片消息]'); break;
      case 'inline_keyboard': out.push(keyboardSegmentText(d)); break;
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  // 🆕 2026-10-03（第三十八对话，提案 0f6288a1 的零依赖版）：磁力链接顺手补上「名字 + 总大小」。
  //    ⚠️ 顺序有意：**先注解、再 sanitize** —— 注解里的名字是从链接里解出来的**用户可控文本**，
  //      它必须和别处的用户文本走同一条消毒（防 `[系统]` 之类伪装）。
  // 🆕 2026-10-04（第四十对话 · 批 1）：pixiv 图链顺手补一句「可用地址」（反代）——同样先注解再消毒。
  return sanitizeUserText(annotatePixivLinks(annotateMagnetLinks(out.join('').trim())));
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只有一个 res_id 占位符，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 *
 * ⚠️ 取节点请用 fetchForward()，不要自己拼 get_forward_msg 参数 —— 见那个函数的注释。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    const name = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}

/**
 * 取一条合并转发的节点并展开成文本 —— **所有地方都该走这里**。
 *
 * ⚠️ 为什么不能只用 message_id（2026-09-12 实测，代价是用户半天的困惑）：
 *   SnowLuma/NapCat 给的 `message_id` 是随机 32 位整数，**可能为负**。
 *   负数时 `get_forward_msg({ message_id })` 一律返回
 *     `retcode=100 download forward message payload is empty`，
 *   而**同一个转发改用 `{ id: <res_id> }` 就能正常取到**。
 *   实测对照（同一群、相隔 5 秒的两条转发）：
 *     负数 message_id → 失败 ｜ 同一条的 res_id → 成功
 *     正数 message_id → 成功 ｜ 同一条的 res_id → 成功
 *   所以 **res_id 更可靠，优先用它**；message_id 作为兜底（老存档里没有 res_id）。
 *   （历史注释里"res_id 会过期、别依赖"的说法是误判，已纠正。）
 *
 * res_id 只在入站事件的 forward 段里出现一次，事后拿不回来 ——
 * 所以 app.js 入站时必须把它存进消息条目（fwdId），read_forward 才有得用。
 *
 * @returns {{text:string, media:Array, via:string}|{text:'',media:[],error:string}}
 */
export async function fetchForward(onebot, { messageId = null, resId = null } = {}) {
  const attempts = [];
  if (resId) attempts.push(['res_id', { id: String(resId) }]);
  if (messageId !== null && messageId !== undefined && String(messageId) !== '') {
    attempts.push(['message_id', { message_id: Number(messageId) }]);
  }
  if (!attempts.length) return { text: '', media: [], error: '没有可用的转发标识（既无 res_id 也无 message_id）' };

  const errors = [];
  for (const [via, params] of attempts) {
    try {
      const r = await onebot.call('get_forward_msg', params);
      const nodes = Array.isArray(r?.messages) ? r.messages : (Array.isArray(r?.data?.messages) ? r.data.messages : []);
      const ex = await expandForwardNodes(nodes);
      if (ex && ex.text) return { ...ex, via };
      errors.push(`${via}: 没有返回节点`);
    } catch (error) {
      errors.push(`${via}: ${error?.message ?? error}`);
    }
  }
  return { text: '', media: [], error: errors.join('；') };
}

/**
 * 把「QQ 文件名」换成一条**当前有效**的图床链接 —— 治"存下来的表情过一阵就发不出去"。
 *
 * ⚠️ 背景（2026-09-12 实测，代价是用户白存了一批表情包）：
 * QQ 图床链接形如 `...download?fileid=…&spec=0&rkey=…`，**rkey 只有十几个小时寿命**。
 * 用户 09:12 转发的一批表情，21:15 还能下载，22:20 就全部变成
 *   HTTP 400 {"retcode":-5503007,"retmsg":"download url has expired"}
 * 也就是说：**只要把 url 存进表情库/存档，过一夜它就是一串死链接**。
 *
 * 但 OneBot 的 `get_image` 能按**文件名**（如 `ACB39C99….gif`）从本地缓存换回一条**新签发的**
 * 链接（实测同一个文件换回来的 url 和存档里那条不同、HTTP 200、811.6KB 下得下来）。
 * 文件名在 QQ 那边是跟着文件走的，不会过期。
 *
 * 所以：**能拿到文件名就优先用它换新链接，换不到再退回存下来的 url**。
 *
 * @param {{call:Function}} onebot OneBot 客户端
 * @param {object} opts `{ url, file }`：存下来的链接与 QQ 文件名（media.file / sticker.file）
 * @returns {Promise<{url:string, via:'cache'|'cache-file'|'stored'}>}
 *   via = 'cache' 换到了新链接 ｜ 'cache-file' 换到了本地路径 ｜ 'stored' 用的还是存下来的那条
 */
export async function resolveFreshImageUrl(onebot, { url = '', file = '' } = {}) {
  const name = String(file || '').trim();
  if (name) {
    try {
      const r = await onebot.call('get_image', { file: name });
      // 实测 SnowLuma/NapCat 把新链接放在 file 和 url 两个字段里，取任意一个非空的
      const fresh = String(r?.url || r?.file || '').trim();
      if (/^https?:\/\//i.test(fresh)) return { url: fresh, via: 'cache' };
      // 有的实现直接给本地缓存路径，转成 file:// 让 OneBot 自己去读
      // ⚠️ 2026-09-25（第十七对话）修：这里原来是**手写的**
      //    `file:///${fresh.replace(/\\/g,'/')}` —— **没做任何百分号编码**，
      //    于是路径里只要有空格 / `#` / `?`（`#` 与 `?` 在 URI 里是分隔符）就坏，
      //    而且坏了不报错：上层拿到的 url 仍是字符串、请求照发，只是协议端读不到。
      //    改用共用件 `toFileUri()`（移植自上游 sender.js，自带单测）。
      //    ⚠️ 它返回空串时**不要**当作有效 url（否则会把 `url: ''` 交给上层）——
      //       落回下面的 'stored' 分支，保持与"缓存里没这条"同样的行为。
      if (/^[a-zA-Z]:[\\/]/.test(fresh)) {
        const uri = toFileUri(fresh);
        if (uri) return { url: uri, via: 'cache-file' };
      }
    } catch { /* 缓存里没有（换机器/清过缓存）→ 退回存下来的链接 */ }
  }
  return { url: String(url || ''), via: 'stored' };
}
