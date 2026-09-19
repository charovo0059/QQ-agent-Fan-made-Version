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
  '可以有一点情绪，也可以淡淡地写；但必须是真的。'
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
  lines.push('写一条 200~400 字的笔记。直接写正文，不要加标题，不要写"笔记："。');
  return lines.join('\n');
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

      const note = {
        day,
        at: Date.now(),
        text,
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
