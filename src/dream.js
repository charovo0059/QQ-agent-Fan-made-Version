// 空闲「梦」—— 夜里没人说话的时候，让它把当天的事整理成一条笔记。
//
// ── 只读是**结构性**的，不是靠叮嘱 ──────────────────────────────────────
// 这次模型调用**一个工具都不给**（压根不传 tools）。所以它在物理上就写不了任何东西：
// 不能改记忆、不能碰人设卡、不能发消息。笔记只有一个去处 —— data/dreams.json，给人看。
//
// 为什么坚持只读：
//   ⚠️ **2026-09-19 更正一处归因错误**。这里原来写着"我们有实测，记忆再巩固会漂移 ——
//      整理「**自称**我爹」时写成了「爸爸」"。**那条归因是错的**：用户确认
//      「自称我爹 → 爸爸」是**用户自己改人设卡**时加的彩蛋（当时卡里确实还没有"我是她爸爸"这条），
//      **不是任何自动流程改的**。
//   ⇒ 所以"只读"不是因为有"记错了"的实测证据，而是**设计上的审慎**：
//      让它自己改人设卡/记忆会**没有审核点**，一旦改坏难以追责、也难回滚。
//      等看过几十条笔记、质量稳定了，再谈要不要放开写权限。
//   （注：另一条**真实存在**的漂移是"记忆整理把 createdAt 刷新了"，那是记忆整理逻辑的问题，
//     与梦无关，见 项目记忆 §6 / memory.js。）
//
// ⚠️ 成本一行里的"上限 8000 字"已过时：现在是 config.dream.maxInputChars，默认 20000。
//
// ── 成本 ──────────────────────────────────────────────────────────────
// 一天一次：输入是当天的消息（上限 config.dream.maxInputChars，默认 20000 字），输出几百字，几分钱。
// 用量走 sessions.recordExternalUsage() 记账 —— 一个每天悄悄花钱、账上却不显示的功能，
// 比没有这个功能更糟。
//
// ── 什么时候做 ────────────────────────────────────────────────────────
// 定时器每 5 分钟看一次，全部条件都满足才做：
//   开着（dream.enabled）+ 在夜里那个时段 + 今天还没做过 + 已经安静够久 + 今天有人说过话
// 定时器 unref()：不留一个能拖住进程退出的句柄。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { chatCompletionWithRetry } from './llm.js';
import { todayKey } from './util.js';

const DREAMS_FILE = path.join(DATA_DIR, 'dreams.json');
// 默认值；**权威值在 config.dream**（2026-09-19 挪进配置，以便按需调节）
const DEF_MAX_INPUT_CHARS = 20000;  // 全局预算（权威值在 config.dream.maxInputChars）
const DEF_PER_CHAT_MIN = 150;       // 每会话保底
const DEF_PER_CHAT_MAX = 1500;      // 每会话上限
const RECENT_WINDOW = 3000;         // 每个会话最多捞多少条候选（够覆盖一天了）
const PER_MSG_CUT = 120;            // 单条截断
const MAX_NOTE_CHARS = 2000;        // 笔记长度上限（超出截断）
const MAX_NOTES = 120;              // 最多留多少条
const TICK_MS = 5 * 60 * 1000;      // 每 5 分钟检查一次

/**
 * 剔除控制字符（2026-09-19 第七对话修的真 bug）。
 *
 * 为什么必须有：实测有位群友的**显示名**就是 `\n\u000B\u0012\t哈气了\n\u0005\n\u0003喵\u0010\u0000`
 * （含 U+0000/0003/0005/0010/0012）。而原来的净化只用 `replace(/\s+/g,' ')`，
 * 而 **`\s` 并不匹配** U+0003/U0005/U000B/U0010/U0012/U0000 这些 ⇒ 原样写进提示词，
 * 把 `HH:MM 名：正文` 的格式撑成多行、还塞进一堆不可见字符。
 * ⚠️ 而且**昵称（m.senderName）原来完全没净化**，只有正文过了一遍。
 * 实测占比：正文含控制字符 9 条（0.26%）、**昵称 27 条（0.79%）**。
 *
 * 口径：保留 \t \n（后续会被折叠成空格），剔除其余 C0 控制字符与 DEL。
 */
function sanitize(s) {
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')   // 剔控制字符
    .replace(/\s+/g, ' ')                                            // 折叠空白（含 \t\n）
    .trim();
}

/** 从一个数组里均匀取 n 个下标（保留时间顺序）。用于"在全天范围里取样"而不是只取尾部。 */
function pickEvenly(len, n) {
  if (n >= len) return Array.from({ length: len }, (_, i) => i);
  if (n <= 0) return [];
  if (n === 1) return [Math.floor((len - 1) / 2)];   // 只取一条时取正中间，最有代表性
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (len - 1)) / (n - 1));
    if (!out.length || out[out.length - 1] !== idx) out.push(idx);
  }
  return out;
}

/**
 * 媒体占位串（2026-09-19 第七对话加）。
 *
 * 为什么：`onebot.js` 对图片只推一个 `media` 数组进存档，而正文里往往就是一个 `[图片]`。
 * 实测当天 **637 条带 media（17.2%）**，其中 image 614 / face 65。
 * 对"做梦"来说，"谁发了图、发了几张、是图还是表情"是有意义的信息。
 *
 * ⚠️ **只在能补充信息时才加**：正文里本来就有 `[图片]`/`[表情]` 占位符时，
 *    再加一个 `[图片×1]` 就变成 `[图片×1] [图片]` —— 纯啰嗦，还占预算。
 *    （实测第一版就是这样，43 行重复。）所以：
 *      · 正文已声明该类型 → 不再重复声明；
 *      · 只有"数量 > 1"这种正文表达不出来的信息，才额外补一个 `×N`。
 *
 * ⚠️ **刻意不带 url**：① 素材是给人看/给模型回想用的，url 又长又没用；
 *    ② 带 url 等于把 QQ 的临时下载链写进提示词与留档，没必要。
 */
function mediaTag(media, text = '') {
  if (!Array.isArray(media) || !media.length) return '';
  const n = (k) => media.filter((x) => x && x.kind === k).length;
  const t = String(text);
  const parts = [];
  const img = n('image'), face = n('face');
  // 正文里已经有 [图片] 之类的占位符 ⇒ 类型已知，只在"不止一张"时补数量
  const saidImg = /\[图片/.test(t);
  const saidFace = /\[表情/.test(t);
  if (img && !saidImg) parts.push(img > 1 ? `图片×${img}` : '图片');
  else if (img > 1) parts.push(`图片×${img}`);
  if (face && !saidFace) parts.push(face > 1 ? `表情×${face}` : '表情');
  else if (face > 1) parts.push(`表情×${face}`);
  const other = media.length - img - face;
  if (other > 0) parts.push(`其他×${other}`);
  return parts.length ? `[${parts.join(' ')}]` : '';
}

const SYSTEM_PROMPT = [
  '现在是深夜，群里都安静了。没有人跟你说话，你也不用回复任何人。',
  '你要写一条只给管理员看的短笔记 —— 像睡前随手记的一笔。',
  '只写下面给过你的消息里真实发生过的事，不要编造没出现的人或事。',
  '不要写成报告，不要分点罗列，不要总结成"今天共收到 N 条消息"。',
  '用第一人称，像一个人回想今天：谁说的什么让你在意、哪句话你没接住、你当时其实想说什么。',
  '可以有一点情绪，也可以淡淡地写；但必须是真的。',
  // ⚠️ 2026-09-19 加：素材是多个会话混在一起的，而这条笔记将来会被她自己回想、
  //    甚至在某一个群里被她提起来。所以在这里就把边界讲清，别让她养成"把别处的事拿到这里说"的习惯。
  '注意：下面的消息来自**好几个不同的群和私聊**。想的时候可以一起想，',
  '但要记住哪个事是在哪儿发生的 —— 以后跟人聊起今天，别把这个群的事说给另一个群听。'
].join('\n');

function buildUserContent({ botName, day, digest }) {
  const lines = [
    `今天是 ${day}，你叫「${botName}」。`,
    `今天在这些会话里一共有 ${digest.total} 条消息，其中你自己说了 ${digest.mine} 条。`,
    ''
  ];
  for (const chat of digest.chats) {
    lines.push(`── ${chat.label} ──`);
    lines.push(...chat.lines);
    lines.push('');
  }
  // ⚠️ 2026-09-19 改成「按会话分章 + 末尾一段总感想」。为什么这么改（用户拍板，查过同类做法）：
  //    一篇把好几个会话揉在一起的日记，**没有任何办法在文本层面把"事实"和"感受"分开**，
  //    于是隐私边界只能靠叮嘱（实测那段日记 5 段里 4 段是事实与感受揉在同一句）。
  //    同类项目的教训很一致：nanobot 的 session-level memory isolation PR 就是
  //    因为"dream/consolidation 把不同会话的事实混起来"才做的隔离；
  //    dsh-memento 则是给每条记录带 `scope: user-global | workspace`。
  //    ⇒ 我们的对应做法：**事实按会话分章（各自 scope），感受单独一段（全局 scope）**。
  //    ⚠️ 这仍是提示词约束，不是结构保证 —— 但"要守格式"的范围从"整篇"缩到"一段"。
  lines.push('写的时候分成两部分：');
  lines.push('');
  lines.push('一、**按会话分段**：上面每个 ── 段落 ── 各写一小段，只写那个会话里发生的事与你的反应。');
  lines.push('   段首原样照抄那个分隔标题（例如 `【群 1000000007】`），这样程序能认出每段属于谁。');
  lines.push('   某个会话你实在没什么想说的，就整段略过，不用硬写。');
  lines.push('');
  lines.push('二、**最后写一段【总感想】**：今天整体上你怎么样了 —— 心情、变化、学到的东西、对自己的看法。');
  lines.push('   ⚠️ **这一段里不许出现任何具体的人名、群名、群号、私聊内容或可辨认的具体事件** ——');
  lines.push('   它是你自己的心里话，不该带着别人的事。');
  lines.push('');
  lines.push('不要加别的标题，不要写"笔记："，不要分点罗列，不要总结"今天共收到 N 条消息"。');
  return lines.join('\n');
}

/**
 * 把模型的输出切成「按会话的章节」+「总感想」（2026-09-19 加）。
 *
 * ⚠️ **容错优先**：模型不一定守格式。解析不出来时**整篇当作 global**，
 *    也就是**退化回改造前的行为** —— 宁可不分章，也不要因为格式没写对就丢掉整篇笔记。
 *
 * 识别规则（宽松）：
 *   · 同时接受 `【群 123】` / `【私聊 123】` / `【群123】` 与 `── 群 123 ──` 两种写法；
 *   · `【总感想】` 起进入全局段；
 *   · 章节没有匹配到会话标签 → 保留 `key: ''`，不算错（模型可能改了群名）。
 */
export function splitDreamText(text) {
  const t = String(text || '');
  const out = { segments: [], global: '' };
  if (!t.trim()) return out;
  // 行首的章节标题：中文书名号或长破折号包裹、内含"群/私聊 + 数字"
  const HEAD = /^[ \t]*(?:【\s*(群|私聊)\s*[:：]?\s*(\d+)\s*】|──\s*(群|私聊)\s*(\d+)\s*──)[ \t]*$/;
  const TOTAL = /^[ \t]*【\s*总感想\s*】[ \t]*$/;
  const lines = t.split('\n');
  let cur = null;
  const push = () => { if (cur && cur.text.trim()) out.segments.push({ key: cur.key, label: cur.label, text: cur.text.trim() }); };
  let inGlobal = false;
  for (const line of lines) {
    const m = HEAD.exec(line);
    if (m) {
      push();
      inGlobal = false;
      const kind = m[1] || m[3];
      const id = m[2] || m[4];
      cur = { key: `${kind === '群' ? 'group' : 'private'}:${id}`, label: `${kind} ${id}`, text: '' };
      continue;
    }
    if (TOTAL.test(line)) {
      push();
      inGlobal = true;
      cur = { key: '', label: '', text: '' };   // 全局段也用 cur 暂存，最后搬到 out.global
      continue;
    }
    if (cur) cur.text += line + '\n';
    else out.global += line + '\n';            // 标题之前的文字：归到全局
  }
  // 收尾：最后一个 cur 可能是"总感想"段
  if (cur && !cur.key) out.global = ((out.global || '') + '\n' + cur.text).trim();
  else push();
  out.global = String(out.global || '').trim();
  return out;
}

/**
 * 取一条笔记的「章节 + 总感想」，带**懒解析兜底**（2026-09-19 加）。
 *
 * 为什么要兜底：`segments`/`global` 是这次改造才写进笔记的新字段，
 * **之前写下的老笔记没有**。工具/界面/探针都可能读到它们，所以：
 *   · 有 `segments` 字段（哪怕是空数组）→ 直接用（空数组是"真的没分章"，不是"缺字段"）；
 *   · 没有该字段 → 现场用 `splitDreamText` 解析一次，并**写回对象**（同一进程内只用解析一次）。
 * ⚠️ 判据必须是 `Array.isArray(n.segments)` 而不是 `n.segments?.length` ——
 *    后者会把"解析出来确实没有章节"跟"老笔记缺字段"混为一谈，前者会白解析、甚至覆盖掉真实结果。
 */
export function segmentsOf(note) {
  if (!note || typeof note !== 'object') return { segments: [], global: '' };
  if (Array.isArray(note.segments)) {
    return { segments: note.segments, global: String(note.global || '') };
  }
  const r = splitDreamText(note.text);
  note.segments = r.segments;
  note.global = r.global;
  return r;
}

export class Dreamer {
  constructor({ store, sessions, emit = () => {} } = {}) {
    this.store = store;
    this.sessions = sessions;
    this.emit = emit;
    this.running = false;
    this.timer = null;
    this.state = this.#load();
  }

  #load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(DREAMS_FILE, 'utf8'));
      if (parsed && Array.isArray(parsed.notes)) {
        return { lastDay: String(parsed.lastDay || ''), notes: parsed.notes };
      }
    } catch { /* 还没做过梦 */ }
    return { lastDay: '', notes: [] };
  }

  #save() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DREAMS_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1), 'utf8');
      fs.renameSync(tmp, DREAMS_FILE);
      return true;
    } catch (error) {
      console.warn(`[dream] 笔记写盘失败：${error?.message ?? error}`);
      return false;
    }
  }

  /** 给界面看的快照（返回副本，不让外面改到内部状态）。 */
  list() {
    const cfg = getConfig();
    return {
      enabled: cfg.dream?.enabled === true,
      startHour: Number(cfg.dream?.startHour ?? 2),
      endHour: Number(cfg.dream?.endHour ?? 6),
      minIdleMinutes: Number(cfg.dream?.minIdleMinutes ?? 60),
      lastDay: this.state.lastDay,
      today: todayKey(),
      running: this.running,
      whyNot: this.whyNot(),
      idleMinutes: Math.round(this.#idleMinutes()),
      notes: this.state.notes.map((n) => ({ ...n }))
    };
  }

  /**
   * 供**工具**用的查询（2026-09-19 加）—— 这就是白天"翻日记"的数据源。
   *
   * 设计取舍（用户把粒度交给我决定）：
   *   · `text: false` 时只给**元信息 + 开头几句**，让模型先看清"有哪几天、都是什么调子"，
   *     而不是一上来就把几百字全文塞进上下文（那是真花钱的）；
   *   · 想看全文就再调一次并指定 `day`（或 `text: true`）。
   *   ⇒ 默认省、按需细 —— 与"prefix cache 敏感"这个成本规律一致。
   */
  brief({ day = '', keyword = '', limit = 10, text = false, maxChars = 600, chatKey = '' } = {}) {
    const all = this.state.notes || [];
    let items = all;
    if (day) items = items.filter((n) => String(n.day) === String(day));
    if (keyword) {
      const k = String(keyword).trim();
      if (k) items = items.filter((n) => String(n.text || '').includes(k));
    }
    const lim = Math.max(1, Math.min(30, Number(limit) || 10));
    const picked = items.slice(0, lim);
    return {
      total: all.length,
      matched: items.length,
      oldest: all.length ? all[all.length - 1].day : '',
      newest: all.length ? all[0].day : '',
      // 传了 chatKey 时，只给"这个会话那一章" + 总感想 —— 这就是两级可见（事实按会话、感受全局）的落点
      ...(chatKey ? { chatKey, note: 'chatsForYou 只给当前会话那一章；global 是总感想（全局）。别的会话的章节没有给你。' } : {}),
      notes: picked.map((n) => {
        const seg = segmentsOf(n);
        const mineSeg = chatKey ? seg.segments.filter((s) => s.key === String(chatKey)) : seg.segments;
        return {
          day: n.day,
          at: n.at,
          // 这篇梦涉及哪几个会话 —— 模型据此判断"哪些事不该拿到别的群里说"
          chatLabels: n.chatLabels || [],
          messages: n.messages ?? null,
          mine: n.mine ?? null,
          chars: String(n.text || '').length,
          ...(chatKey
            ? { chatsForYou: mineSeg.map((s) => s.text), global: text ? seg.global : String(seg.global).slice(0, Math.max(60, Number(maxChars) || 600)) }
            : {
              segments: mineSeg.map((s) => ({ label: s.label, text: text ? s.text : String(s.text).slice(0, Math.max(60, Number(maxChars) || 600)) })),
              global: text ? seg.global : String(seg.global).slice(0, Math.max(60, Number(maxChars) || 600)),
              text: text ? String(n.text || '') : String(n.text || '').slice(0, Math.max(60, Number(maxChars) || 600))
            })
        };
      })
    };
  }

  clear() {
    const n = this.state.notes.length;
    this.state = { lastDay: '', notes: [] };
    this.#save();
    return n;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.#tick().catch(() => { /* tick 自己会兜底 */ }) }, TICK_MS);
    // unref：定时器不该拖着进程不退出（headless/测试里尤其重要）
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** 现在算不算"夜里"（支持跨零点，比如 23 点到 5 点）。 */
  #inWindow(now = new Date()) {
    const cfg = getConfig();
    const start = Math.max(0, Math.min(23, Number(cfg.dream?.startHour ?? 2)));
    const end = Math.max(0, Math.min(24, Number(cfg.dream?.endHour ?? 6)));
    if (start === end) return false;
    const h = now.getHours();
    return start < end ? (h >= start && h < end) : (h >= start || h < end);
  }

  /** 最后一次有人说话是多久以前（所有会话里最新的那条）。 */
  #idleMinutes() {
    let latest = 0;
    try {
      for (const key of this.store.listChats()) {
        const meta = this.store.getChatMeta(key);
        if (meta.lastTs > latest) latest = meta.lastTs;
      }
    } catch { /* 读不到就当一直很闲 */ }
    if (!latest) return Infinity;
    return (Date.now() - latest) / 60000;
  }

  /**
   * 现在为什么不做梦。返回空串 = 可以做。
   * 单独抽出来是为了界面能如实显示原因（"还没到夜里""今天已经做过了"），
   * 而不是点了没反应。
   */
  whyNot() {
    const cfg = getConfig();
    if (cfg.dream?.enabled !== true) return '梦里功能关着';
    if (!String(cfg.api?.model || '').trim()) return '还没设置模型';
    if (this.running) return '正在做梦';
    if (this.state.lastDay === todayKey()) return '今天已经做过梦了';
    if (!this.#inWindow()) return `还没到夜里（设定 ${cfg.dream?.startHour ?? 2} 点 ~ ${cfg.dream?.endHour ?? 6} 点）`;
    const idle = this.#idleMinutes();
    const need = Math.max(0, Number(cfg.dream?.minIdleMinutes ?? 60));
    if (idle < need) return `群里 ${Math.round(idle)} 分钟前还有人说话（要求安静 ${need} 分钟）`;
    return '';
  }

  async #tick() {
    if (this.whyNot()) return;
    const result = await this.runNow({ force: false });
    if (result.ok) console.log(`[dream] 写了一条笔记：${result.note.text.length} 字`);
    else if (result.reason !== '今天还没人说话，没什么可整理的') console.warn(`[dream] 今晚没写成：${result.reason}`);
  }

  /**
   * 当天消息摘要（每个会话一段）。
   *
   * ── 2026-09-19 第七对话重写（治"赢者通吃 + 只取一天的开头"）────────────────
   * 旧实现是：全局 8000 字预算 + `recent(key,{limit:400})` 后置过滤当天。实测后果：
   *   · 11 个会话里**只有 2 个**进了提示词，其余 9 个（含 5 个私聊）**一条都没有**；
   *   · 会话顺序由目录读出顺序决定 ⇒ **谁靠前谁吃光**，不是"今天谁更重要"；
   *   · `recent(400)` 是"先取最后 400 条再筛今天" ⇒ 一天超 400 条的群
   *     **当天更早的部分整个丢掉**（实测 group:1098345913 当天 2684 条，丢了 2284 条）；
   *   · 于是素材变成"磁盘顺序前两个会话当天最早那一段"（实测是 00:07–00:19 的 12 分钟）。
   *
   * 现在的做法：
   *   ① 候选窗口放到 RECENT_WINDOW 条，**按"当天"筛完之后**再取样；
   *   ② 每个会话有自己的配额（perChatMin/Max），**会话内部在全天范围里均匀取样**
   *      （不再是"取尾"）—— 这样一天的早/中/晚都有代表；
   *   ③ **优先保证它自己的发言**：提示词要求写"我当时其实想说什么"，
   *      而实测素材里它自己只占 3.4%，那样"第一人称回想"就成了复述别人；
   *   ④ 最后按全局 maxInputChars 收敛，**收敛时优先丢别人的、尽量留它自己的**。
   */
  #digest(dayStartTs) {
    const c = getConfig()?.dream || {};
    const MAX_INPUT_CHARS = Math.max(200, Number(c.maxInputChars) || DEF_MAX_INPUT_CHARS);
    const PER_MIN = Math.max(0, Number(c.perChatMinChars ?? DEF_PER_CHAT_MIN));
    const PER_MAX = Math.max(PER_MIN, Number(c.perChatMaxChars) || DEF_PER_CHAT_MAX);

    const chats = [];
    let total = 0, mine = 0, chars = 0;
    let keys = [];
    try { keys = this.store.listChats(); } catch { keys = [] }

    // ── 第一遍：每个会话各自选材（此时不判全局上限，避免"靠前的会话吃光"）──
    const prepared = [];
    for (const key of keys) {
      let msgs = [];
      try {
        msgs = this.store.recent(key, { limit: RECENT_WINDOW }).filter((m) => m.ts >= dayStartTs);
      } catch { msgs = [] }
      if (!msgs.length) continue;

      // 归一到 {hh,mm,who,text}，顺便净化（正文与昵称**都要**净化，见 sanitize 的注释）
      const rows = [];
      for (const m of msgs) {
        const text = sanitize(m.text);
        const tag = mediaTag(m.media, text);    // 只在能补充信息时才加，见 mediaTag 注释
        if (!text && !tag) continue;
        const t = new Date(m.ts);
        rows.push({
          self: !!m.self,
          hh: String(t.getHours()).padStart(2, '0'),
          mm: String(t.getMinutes()).padStart(2, '0'),
          who: m.self ? '我' : (sanitize(m.senderName) || String(m.senderId ?? '?')),
          // 正文与媒体标记拼在一起：`[图片×2] 配文…`
          text: [tag, text].filter(Boolean).join(' ').slice(0, PER_MSG_CUT)
        });
      }
      if (!rows.length) continue;
      total += rows.length;
      mine += rows.filter((r) => r.self).length;

      // ── 选材：先保它自己的，再补别人的；两类都在**全天范围**里均匀取 ──
      const selfIdx = rows.map((r, i) => (r.self ? i : -1)).filter((i) => i >= 0);
      const otherIdx = rows.map((r, i) => (r.self ? -1 : i)).filter((i) => i >= 0);
      const budgetForChat = Math.min(PER_MAX, Math.max(PER_MIN, Math.round(MAX_INPUT_CHARS / Math.max(1, keys.length))));

      const chosen = new Set();
      let used = 0;
      const take = (idxArr, budget) => {
        for (const i of pickEvenly(idxArr.length, idxArr.length)) {
          const j = idxArr[i];
          if (chosen.has(j)) continue;
          const cost = rows[j].text.length + 12;
          if (used + cost > budget) break;
          chosen.add(j);
          used += cost;
        }
      };
      // ① 它自己的发言：这一半单独封顶，**不能占满整个会话配额**
      //    （全是"我"的独白、没有别人的话，回想就没有上下文了）
      take(selfIdx, Math.min(budgetForChat, Math.round(budgetForChat / 2)));
      // ② 别人的补足到配额：**全天均匀取，不是取尾** —— 这是修掉"只看到一天开头"的关键
      take(otherIdx, budgetForChat);

      const picked = [...chosen].sort((a, b) => a - b);
      if (!picked.length) continue;
      prepared.push({
        key,
        label: key.startsWith('group:') ? `群 ${key.slice(6)}` : `私聊 ${key.slice(8)}`,
        rows: picked.map((i) => rows[i]),
        selfCount: picked.filter((i) => rows[i].self).length
      });
    }

    // ── 第二遍：全局收敛。**优先丢别人的**，尽量留它自己的（先放 self，再放 other）──
    const takeSelfFirst = [];
    for (const ch of prepared) for (const r of ch.rows) takeSelfFirst.push({ ch, r, self: r.self });
    takeSelfFirst.sort((a, b) => (a.self === b.self) ? 0 : (a.self ? -1 : 1));

    const keptByChat = new Map();
    for (const item of takeSelfFirst) {
      const cost = item.r.text.length + 12 + item.r.who.length;
      if (chars + cost > MAX_INPUT_CHARS) continue;
      if (!keptByChat.has(item.ch.key)) keptByChat.set(item.ch.key, []);
      keptByChat.get(item.ch.key).push(item.r);
      chars += cost;
    }

    for (const ch of prepared) {
      const rows2 = (keptByChat.get(ch.key) || []).slice().sort((a, b) => (a.hh + a.mm) < (b.hh + b.mm) ? -1 : 1);
      if (!rows2.length) continue;
      const lines = rows2.map((r) => `${r.hh}:${r.mm} ${r.who}：${r.text}`);
      chats.push({ key: ch.key, label: ch.label, lines, self: rows2.filter((r) => r.self).length });
    }

    return { chats, total, mine, chars };
  }

  /**
   * 做一次梦。
   *
   * @param {{force?: boolean}} opts force = 手动点"现在做一次"（跳过开关/时段/是否做过的检查，
   *        但仍然要有模型、要有人说过话）
   * @returns {Promise<{ok: boolean, reason?: string, note?: object}>}
   */
  async runNow({ force = false } = {}) {
    const cfg = getConfig();
    if (this.running) return { ok: false, reason: '正在做梦，等这次做完' };
    if (!force) {
      const why = this.whyNot();
      if (why) return { ok: false, reason: why };
    }
    if (!String(cfg.api?.model || '').trim()) return { ok: false, reason: '还没设置模型' };

    const day = todayKey();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const digest = this.#digest(dayStart.getTime());
    if (!digest.total) return { ok: false, reason: '今天还没人说话，没什么可整理的' };

    this.running = true;
    this.emit('dream-start', { day });
    try {
      const botName = String(cfg.persona?.botName || '我');
      const res = await chatCompletionWithRetry({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserContent({ botName, day, digest }) }
        ],
        temperature: 1.0
      }, 1);

      // 记账要在"拿到响应"之后立刻做 —— 就算下面写盘失败，钱也已经花了
      try { this.sessions?.recordExternalUsage?.(res?.usage) } catch (error) {
        console.warn(`[dream] 用量记账失败：${error?.message ?? error}`);
      }

      const text = String(res?.message?.content ?? '').trim().slice(0, MAX_NOTE_CHARS);
      if (!text) return { ok: false, reason: '模型没写出内容' };
      const parts = splitDreamText(text);   // 只解析一次（下面 segments/global 都用它）

      const note = {
        day,
        at: Date.now(),
        text,
        // 「按会话分章 + 总感想」的解析结果（2026-09-19 加）。
        // ⚠️ 在**写入时**解析一次并落盘，而不是读的时候每次解析 —— 探针/工具/界面都要用，
        //    解析一次省事；而老笔记（这条之前写的）没有这个字段，读的时候会懒解析兜底。
        // `segments[].key` 是会话 id（`group:123`），**这是"事实按会话过滤"的依据**。
        segments: parts.segments,
        global: parts.global,
        // 素材统计 + **这篇梦涉及哪几个会话**（2026-09-19 加）。
        // 为什么要记 chats：白天的 `dream_recall` 工具要能按会话/日期筛，
        // 或至少告诉模型"这篇里有几个会话的事、是哪些"——否则它不知道哪些内容不该拿到别的群里说。
        // ⚠️ `chats`（会话数组）只存在于 `#digest` 的局部作用域，`runNow` 里拿不到；
        //    `#digest` 已经把 key/label 放进它返回的 `chats` 数组里了，这里从 digest 取。
        chatKeys: (digest.chats || []).map((c) => c.key),
        chatLabels: (digest.chats || []).map((c) => c.label),
        chats: digest.chats.length,
        messages: digest.total,
        mine: digest.mine,
        model: String(cfg.api?.model || ''),
        usage: res?.usage || null
      };
      this.state.notes.unshift(note);
      if (this.state.notes.length > MAX_NOTES) this.state.notes.length = MAX_NOTES;
      this.state.lastDay = day;
      this.#save();
      this.emit('dream', note);
      return { ok: true, note };
    } catch (error) {
      const reason = String(error?.message ?? error);
      console.warn(`[dream] 失败：${reason}`);
      return { ok: false, reason };
    } finally {
      this.running = false;
      this.emit('dream-end', { day });
    }
  }
}
