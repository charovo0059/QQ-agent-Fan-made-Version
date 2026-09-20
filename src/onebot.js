// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

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
  }

  #closedByUs;

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
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
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
      setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
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
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
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
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。 */
  async call(action, params = {}, timeoutMs = 15000) {
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

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
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

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
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
    return this.sendSegments(kind, id, segments);
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
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

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
          out.push(self && String(d.qq) !== self ? `${who}（在叫别人）` : who);
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
      case 'json': out.push('[卡片消息]'); break;
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
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
      if (/^[a-zA-Z]:[\\/]/.test(fresh)) return { url: `file:///${fresh.replace(/\\/g, '/')}`, via: 'cache-file' };
    } catch { /* 缓存里没有（换机器/清过缓存）→ 退回存下来的链接 */ }
  }
  return { url: String(url || ''), via: 'stored' };
}
