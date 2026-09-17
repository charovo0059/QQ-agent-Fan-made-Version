// 空闲「梦」—— 夜里没人说话的时候，让它把当天的事整理成一条笔记。
//
// ── 只读是**结构性**的，不是靠叮嘱 ──────────────────────────────────────
// 这次模型调用**一个工具都不给**（压根不传 tools）。所以它在物理上就写不了任何东西：
// 不能改记忆、不能碰人设卡、不能发消息。笔记只有一个去处 —— data/dreams.json，给人看。
//
// 为什么坚持只读：我们有实测，记忆再巩固会漂移 —— 整理「**自称**我爹」时写成了「爸爸」。
// 让它自己改自己的人设卡，一次漂移就走样，而且没有审核点。
// 等看过几十条笔记、质量稳定了，再谈要不要放开写权限。
//
// ── 成本 ──────────────────────────────────────────────────────────────
// 一天一次：输入是当天的消息（上限 8000 字），输出几百字，几分钱。
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
const MAX_INPUT_CHARS = 8000;    // 当天消息进提示词的总字数上限
const MAX_NOTE_CHARS = 2000;     // 笔记长度上限（超出截断）
const MAX_NOTES = 120;           // 最多留多少条
const TICK_MS = 5 * 60 * 1000;   // 每 5 分钟检查一次

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

  /** 当天消息摘要（每个会话一段，逐条裁到 120 字，总量封顶）。 */
  #digest(dayStartTs) {
    const chats = [];
    let total = 0;
    let mine = 0;
    let chars = 0;
    let keys = [];
    try { keys = this.store.listChats() } catch { keys = [] }

    for (const key of keys) {
      if (chars >= MAX_INPUT_CHARS) break;
      let msgs = [];
      try {
        msgs = this.store.recent(key, { limit: 400 }).filter((m) => m.ts >= dayStartTs);
      } catch { msgs = [] }
      if (!msgs.length) continue;

      const lines = [];
      for (const m of msgs) {
        if (chars >= MAX_INPUT_CHARS) break;
        const text = String(m.text ?? '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const t = new Date(m.ts);
        const hh = String(t.getHours()).padStart(2, '0');
        const mm = String(t.getMinutes()).padStart(2, '0');
        const cut = text.slice(0, 120);
        lines.push(`${hh}:${mm} ${m.self ? '我' : (m.senderName || m.senderId)}：${cut}`);
        chars += cut.length;
        total += 1;
        if (m.self) mine += 1;
      }
      if (lines.length) {
        const label = key.startsWith('group:') ? `群 ${key.slice(6)}` : `私聊 ${key.slice(8)}`;
        chats.push({ key, label, lines });
      }
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
