// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function loadChat(chatKey) {
  try {
    let text = fs.readFileSync(chatFile(chatKey), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
  } catch { /* 新会话 */ }
  return { chatKey, nextLocalId: 1, messages: [] };
}

// ── 落盘合并（2026-09-17） ────────────────────────────────────────────────
// 原来每条消息都同步全量重写整份存档：实测 3.83~4.13 ms/条（627 KB 的群
// 光 JSON.stringify 就占 1.48 ms），按 500 条/天/群算 ≈ 每天 1.9 秒纯阻塞
// event loop，多群叠加。而 ChatStore 的读路径**全部走内存缓存**（this.chats），
// 磁盘只是一份留档，所以没必要每条都立刻写。
//
// 策略：同一聊天窗口内的多次改动合并成一次写（尾部合并 200ms）；
//      连续不断改动时封顶 1 秒，避免被无限推迟。
// 代价：进程被强杀时最多丢最后 200ms 的增量（用户已确认接受）。
//      正常退出由下面的 exit 钩子兜底；测试/脚本可手动 flushChatWrites()。
const WRITE_COALESCE_MS = 200;
const WRITE_MAX_DELAY_MS = 1000;
const pendingWrites = new Map(); // chatKey -> { state, firstAt, timer }

function writeChatNow(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey));
}

/**
 * 落盘失败**限流**出声：同一个聊天 60 秒只报一次。
 * 为什么要限流：写盘在热路径上（每条消息都可能触发），磁盘坏掉时会每毫秒失败一次 ——
 * 不限流会把日志刷爆，反而让真正的那条看不见。但**也不能一声不吭**（原来就是只有一行 console.error，
 * 而且调用方还各自再打一遍，用户那边一点痕迹都没有）。
 */
const writeFailReportedAt = new Map();
function reportWriteFailure(key, state, error) {
  const now = Date.now();
  if (now - (writeFailReportedAt.get(key) || 0) < 60000) return;
  writeFailReportedAt.set(key, now);
  const n = Array.isArray(state?.messages) ? state.messages.length : 0;
  console.error(`[store] 存档落盘失败（${key}，内存里 ${n} 条）：${error?.message ?? error}`
    + ' —— ⚠️ 这批改动**仍在内存里**，会随下一次改动 / 下一次 flush / 退出钩子重试；'
    + '若一直失败请检查磁盘空间与数据目录权限。');
}

/** 把某个聊天待写的改动立刻落盘（幂等）。 */
function flushChat(key) {
  const rec = pendingWrites.get(key);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  pendingWrites.delete(key);
  try {
    writeChatNow(rec.state);
  } catch (error) {
    // 🔴 2026-09-24（第十三对话 · T2「只打日志」型 catch 逐条定性）：**失败必须把待写记录放回去**。
    //
    // 原来无论成功失败都已经 `pendingWrites.delete(key)` ⇒ 写盘一抛错，这批改动**永久消失**；
    // 而四个调用方（`flushChatWrites` / `saveChat` 的定时器 / `#state` 重读前 / 退出钩子）
    // 全都只 `console.error` ⇒ **用户完全不会知道聊天记录少了一段**。
    // 这与已收口的 `catch → 默认值 → 写回原路径` 是同一族：本项目最忌讳的"无声丢数据"。
    //
    // ⇒ 放回 `pendingWrites`（存最新状态、保留最早 firstAt 以免封顶失效），
    //   让下一次改动 / 下一次 flush / 退出钩子都还有机会把它写下去。
    const again = pendingWrites.get(key);
    pendingWrites.set(key, {
      state: rec.state,
      firstAt: again?.firstAt ?? rec.firstAt ?? Date.now(),
      timer: null,
    });
    reportWriteFailure(key, rec.state, error);
    throw error;   // 契约不变：四个调用方本来就都自己 catch（并各自打了日志）
  }
}

/** 把所有待写的改动立刻落盘。 */
export function flushChatWrites() {
  for (const key of [...pendingWrites.keys()]) {
    try { flushChat(key); } catch (error) { console.error('[store] 存档落盘失败：', error?.message ?? error); }
  }
}

function saveChat(state) {
  const key = state.chatKey;
  const now = Date.now();
  const rec = pendingWrites.get(key);
  if (rec) {
    rec.state = state;                                // 合并：只保留最新状态
    if (now - rec.firstAt >= WRITE_MAX_DELAY_MS) {    // 连续改动时的封顶
      try { flushChat(key); } catch (error) { console.error('[store] 存档落盘失败：', error?.message ?? error); }
    }
    return;
  }
  // 注意：写盘现在发生在定时器里，异常没有调用方可以抛 —— 必须自己吞掉并记日志，
  // 否则一次磁盘错误会变成 uncaughtException 把整个应用带崩。
  const timer = setTimeout(() => {
    try { flushChat(key); } catch (error) { console.error('[store] 存档落盘失败：', error?.message ?? error); }
  }, WRITE_COALESCE_MS);
  if (typeof timer.unref === 'function') timer.unref();  // 别拖着进程不退出
  pendingWrites.set(key, { state, firstAt: now, timer });
}

// 正常退出前把没落盘的写掉（'exit' 回调必须是同步的，而 writeChatNow 正是同步的）。
// ⚠️ 这里**故意不挂 SIGINT/SIGTERM**：一旦挂了监听器，Node 默认的"收到信号即退出"
// 会被取消，Ctrl+C 就杀不掉进程了。
process.on('exit', () => { try { flushChatWrites(); } catch { /* 退出阶段尽力而为 */ } });

export class ChatStore {
  constructor(maxPerChat = 0) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) {
      // 从磁盘重读之前，先把该聊天待写的改动落盘。
      // 否则"同一进程里新建一个实例读盘"会看到旧数据（写盘是合并推迟的），
      // 而任何一次重读都应当能看到已经完成的改动。
      try { flushChat(chatKey); } catch (error) { console.error('[store] 存档落盘失败：', error?.message ?? error); }
      this.chats.set(chatKey, loadChat(chatKey));
    }
    return this.chats.get(chatKey);
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\w+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\w+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    // `source`（'qq' / 'wechat'）一并带出：前端要按它区分平台，发送路由也要按它选客户端。
    // ⚠️ 老会话没有这个字段（接入微信之前建的）：那时只可能是 QQ ⇒ 兜底成 'qq'。
    //    不兜底的话前端会把所有老会话当成"未知平台"、切到微信模式时全都不显示。
    return {
      chatKey,
      total: st.messages.length,
      unread,
      lastTs: last?.ts ?? 0,
      lastText: last?.text ?? '',
      source: st.source || 'qq'
    };
  }

  /** 某个会话属于哪个平台（'qq' / 'wechat'）。给发送路由用。 */
  chatSource(chatKey) {
    const st = this.#state(chatKey);
    return st.source || 'qq';
  }

  /** 所有指定平台的会话（前端切换视图要用）。 */
  chatsBySource(source) {
    const want = String(source || '');
    const out = [];
    for (const key of this.listChats()) {
      if (this.chatSource(key) === want) out.push(key);
    }
    return out;
  }

  /**
   * 追加一条收到的消息（未读）。
   *
   * `source` = 这条会话属于哪个平台（`'qq'` / `'wechat'`），2026-09-20 加。
   * 为什么要它：接入微信后同一个控制台要同时显示两个平台的会话，
   * 而**QQ 与微信的 id 形态不保证可区分**（微信侧由桥派生数字 id ⇒ 看起来和 QQ 号一样）。
   * ⇒ 只能由"事件从哪个客户端来的"记住，不能靠 chatKey 猜。
   * 它同时是**发送路由的依据**：要发到哪个平台，就看这个会话记的是谁。
   * ⚠️ 只在首次见到该会话时写入（后续不覆盖），避免"一次误标把整段历史改掉"。
   */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], fwdId = null, source = null }) {
    const st = this.#state(chatKey);
    if (source && !st.source) {
      st.source = String(source);
    }
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 合并转发卡片的 res_id。**只在入站事件里出现这一次**，事后拿不回来，
      // 而它是 read_forward 最可靠的抓手（message_id 可能为负、取不到 payload，
      // 详见 onebot.js 的 fetchForward）。不是转发消息就是 null。
      fwdId: fwdId ? String(fwdId) : null
    };
    st.messages.push(entry);
    this.#trim(st);
    // 对方真的回话了 ⇒ 主动开口的连发计数清零。
    // ⚠️ 放在**入站**而不是 appendSelf 里 —— "开口"不是"被回应"（见 peekProactive 的说明）。
    //    主动消息也是 self，所以绝不能在 appendSelf 里清零，否则计数永远回不到 1 以上。
    if (st.proactive) delete st.proactive;
    saveChat(st);
    return entry;
  }

  /**
   * 记录机器人自己发出的消息（已读）。
   *
   * `origin`（2026-09-26 第二十四对话，提案 `57e7ab37`）：
   *   · `'self'`（默认）= 她自己说的；
   *   · `'admin'` = **管理端代发**（群发通知 / 测试发送那一类）。
   * 为什么必须记：管理端可以拿她的名义往任何白名单会话发话，而她的上下文里那些消息
   * 原来和"我自己说的"**长得一模一样** ⇒ 她只会以为是自己说的，等下次醒来才发现锅在头上
   * （她的原话："这样我就不用替别人的话背锅"）。
   * ⚠️ 只写**非默认值**（`self` 不落字段）：老存档与绝大多数消息一个字节都不多占。
   * ⚠️ 别把 `self: true` 改掉：`self` 还是"这条是我发的"，`origin` 只回答"谁按的发送键"。
   */
  appendSelf(chatKey, { text, ts, mid = null, origin = 'self' }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    if (String(origin) === 'admin') entry.origin = 'admin';
    st.messages.push(entry);
    this.#trim(st);
    saveChat(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    saveChat(st);
    return unread;
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    let firstTs = 0;
    let lastTs = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) {
        m.read = true;
        n++;
        if (!firstTs || m.ts < firstTs) firstTs = m.ts;
        if (m.ts > lastTs) lastTs = m.ts;
      }
    }
    if (n) {
      // 累计"被静默收着"的消息量。门控判定这批不值得回应时，消息沉入历史，
      // 模型这边只看到它们变成普通历史 —— **它永远不知道有人说过话、只是没叫它**。
      // 记在这里是因为 markAllRead 的三处调用（门控、手动强制扫、恢复运行清积压）
      // 语义完全一致：都是"没让模型看到就置为已读"。
      const prev = st.swept && typeof st.swept === 'object' ? st.swept : null;
      st.swept = {
        count: (Number(prev?.count) || 0) + n,
        firstTs: Number(prev?.firstTs) || firstTs,
        lastTs: Math.max(Number(prev?.lastTs) || 0, lastTs)
      };
      saveChat(st);
    }
    return n;
  }

  /**
   * 读取"替你收着了"的累计量。**只读**，可安全重复调用。
   * @returns {{count:number, firstTs:number, lastTs:number}|null}
   */
  peekSwept(chatKey) {
    const st = this.#state(chatKey);
    const s = st.swept;
    if (!s || !(Number(s.count) > 0)) return null;
    return { count: Number(s.count) || 0, firstTs: Number(s.firstTs) || 0, lastTs: Number(s.lastTs) || 0 };
  }

  /**
   * 取走并清空 —— 模型已经在提示词里看到过这条提醒，不重复说第二遍。
   * 与 drainUnread 同一个思路：说过一次就算说过了。
   */
  takeSwept(chatKey) {
    const info = this.peekSwept(chatKey);
    if (!info) return null;
    const st = this.#state(chatKey);
    delete st.swept;
    saveChat(st);
    return info;
  }

  /**
   * 主动开口的连发状态（治"没人搭理还一直开口"）。
   *
   * 为什么需要它（2026-09-19，调研报告 M2 / §10）：
   *   我们的 `config.proactive` 原本只有 4 个键（enabled/两个间隔/idleThreshold/probability），
   *   **没有安静时段、没有连发上限** ⇒ 凌晨 3 点也可能主动开口、没人理也会一直开口。
   *   对标项目 lingxi 的注释记着真实事故："没有这个上限的话，用户静默 24 小时、
   *   冷却 3 小时 = 8 条主动消息 —— 像跟踪狂。"
   *
   * ⚠️ 关键设计（两边都踩过的坑，必须照做）：
   *   **"开口"不等于"被回应"** —— 只有**对方真的回话**才清零。
   *   开口本身只让计数 +1（配合 orchestrator 的退避）。
   *   lingxi 的 `resetConnection()` 就是因为放在"开口后"而翻过车；
   *   xiyuai 的 v1.13 更严重：把状态更新错放在 idle 路径上，
   *   导致"用户越不理她、信任越涨"。
   *
   * ⚠️ 与"沉默驱动情绪"的区别：这里记的是**行为**（发了几条），不是**感受**。
   *   静默只允许驱动行为，绝不允许驱动情绪 —— 见报告 §7 红线 1。
   */
  peekProactive(chatKey) {
    const st = this.#state(chatKey);
    const p = st.proactive;
    if (!p || !(Number(p.consecutive) > 0)) return { consecutive: 0, lastAt: 0 };
    return { consecutive: Number(p.consecutive) || 0, lastAt: Number(p.lastAt) || 0 };
  }

  /** 记一次主动开口（计数 +1，并记时间）。**不是**"对方回话了"。 */
  markProactiveSent(chatKey, ts = Date.now()) {
    const st = this.#state(chatKey);
    const prev = st.proactive && Number(st.proactive.consecutive) > 0 ? Number(st.proactive.consecutive) : 0;
    st.proactive = { consecutive: prev + 1, lastAt: Number(ts) || Date.now() };
    saveChat(st);
    return st.proactive;
  }

  /** 对方真的回话了 → 连发计数清零。**只应由"收到对方消息"触发。** */
  resetProactive(chatKey) {
    const st = this.#state(chatKey);
    if (!st.proactive) return false;
    delete st.proactive;
    saveChat(st);
    return true;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /**
   * 取"紧挨在某条消息之前、时间上属于同一轮"的消息（不含锚点这条）。
   *
   * ⚠️ 为什么需要它（2026-09-17 用户报"引用到别的消息上"，实测根因）：
   *   防抖窗口是 wakeDelayMs（默认 2 秒）。**超过 2 秒的两条消息会被拆成两批**，
   *   于是「[图片]」和 3 秒后的「@我」分属两批：
   *   前者单独过档位（无 @、无关键词）→ 判定不值得回应 → markAllRead **静默扫成已读**；
   *   后者单独成触发批。结果模型只看到 @，看不到它紧挨着的那张图，只能引用错。
   *   实测：442 个会话里 78 个（17.6%）有此现象，85 条被拆开，其中 15 条带图。
   *
   * 语义边界（两个都要，缺一个就会带进别的轮次）：
   *   ① 只取"最近一次自己发言之后"的消息 —— 上一轮已经翻篇，不该再带；
   *   ② 只取 maxAgeMs 内的 —— 超过这个窗口的就不是同一口气说的话了
   *      （实测 9~15 秒段的平均文本长是 29 字、而 0~8 秒段只有 11~14 字，
   *       说明 8 秒是"同一轮"的自然边界）。
   * 再加 maxCount 条数上限：群里刷屏时 8 秒内可能挤进十几条，兜个底。
   *
   * @param {string} chatKey
   * @param {number|string|null} anchorMid 锚点消息（触发批第一条）的 mid
   * @param {number} anchorTs 锚点的时间戳（只作 mid 找不到时的兜底定位）
   * @param {{maxAgeMs?:number, maxCount?:number}} opts
   * @returns {Array} 时间正序的条目（老的在前）
   */
  sameTurnContext(chatKey, anchorMid, anchorTs, { maxAgeMs = 8000, maxCount = 6 } = {}) {
    const st = this.#state(chatKey);
    const list = st.messages;
    let idx = -1;
    // ⚠️ 优先按 mid 定位，**不要**按 ts 定位：`while (ts > anchorTs) idx--` 这种写法会把
    //    "与锚点同一时刻、但排在锚点前面"的兄弟条目误当成锚点位置，
    //    于是它们会被当"上文"再带一遍（同一批消息在提示词里出现两次）。
    //    这正是 2026-09-17 写测试时抓到的：同一毫秒到达的两条未读，第二条会重复出现。
    if (anchorMid !== null && anchorMid !== undefined && String(anchorMid).trim() !== '') {
      const want = String(anchorMid).trim();
      const hit = (m) => m.mid !== null && m.mid !== undefined && String(m.mid) === want;
      // 取**最近一次**出现（findLastIndex；老运行时用倒序循环兜底，不赌版本）。
      // 应用里 mid 全局唯一，正常不会重复；但历史脏数据/重放场景下，
      // 取到更早那一次会把整段历史当"上文"灌进来（2026-09-17 实测踩过）。
      if (typeof list.findLastIndex === 'function') {
        idx = list.findLastIndex(hit);
      } else {
        for (let i = list.length - 1; i >= 0; i--) { if (hit(list[i])) { idx = i; break; } }
      }
    }
    if (idx < 0) {
      idx = list.length - 1;
      while (idx >= 0 && Number(list[idx].ts ?? 0) > Number(anchorTs ?? 0)) idx--;
    }
    if (idx < 0) return [];
    const windowMs = Math.max(0, Number(maxAgeMs) || 0);
    const cap = Math.max(1, Number(maxCount) || 1);
    const out = [];
    for (let i = idx - 1; i >= 0; i--) {
      const m = list[i];
      if (m.self) break;                                   // ① 上一轮到此为止
      const age = Number(anchorTs ?? 0) - Number(m.ts ?? 0);
      if (!(age >= 0)) continue;                           // 时间戳异常（晚于锚点）直接跳过
      if (age > windowMs) break;                           // ② 超出窗口
      out.push(m);
    }
    return out.reverse().slice(-cap);
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    saveChat(st);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  // ── 删除（管理端"存档"页用）────────────────────────────────────────────
  // 注意：删掉的消息不会再出现在提示词的【过去状态】里 —— 这正是管理端
  // 删存档的用途（去掉不想留在上下文里的内容）。nextLocalId 不回退，
  // 避免新消息复用刚删掉的 id（前端按 id 定位行、金句勾选也按 id）。

  /** 按本地 id 删除一条存档消息。返回是否真的删掉了一条。 */
  deleteMessage(chatKey, localId) {
    const st = this.#state(chatKey);
    const id = Number(localId);
    const idx = st.messages.findIndex((m) => m.id === id);
    if (idx < 0) return false;
    st.messages.splice(idx, 1);
    saveChat(st);
    return true;
  }

  /** 清空某会话的全部存档消息（保留存档文件本身）。返回删除条数。 */
  clearMessages(chatKey) {
    const st = this.#state(chatKey);
    const n = st.messages.length;
    if (!n) return 0;
    st.messages = [];
    saveChat(st);
    return n;
  }

  /**
   * 彻底删除某会话的存档：内存态 + 磁盘文件一起删。
   * 删完这个会话就不再出现在「存档」列表里（listChats 是扫目录的）。
   * 返回被删掉的条数。
   */
  deleteChat(chatKey) {
    const st = this.#state(chatKey);
    const n = st.messages.length;
    this.chats.delete(chatKey);
    try { fs.rmSync(chatFile(chatKey), { force: true }); } catch { /* ignore */ }
    return n;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
