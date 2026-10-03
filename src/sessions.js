// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { addUsage, emptyUsage } from './llm.js';
import { modelLabel, splitModelLabel } from './model-prices.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      for (const f of pick) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
      return data;
    } catch (e) {
      // 🔴 2026-09-22（第十一对话 · 隐患排查）：这个 catch 原来**吞掉了三种完全不同的失败**
      //    —— ① 文件不存在（ENOENT，正常：这个会话还没落过盘）
      //       ② 文件存在但**解析不了**（存档损坏 / 写了一半被杀进程）
      //       ③ 权限 / IO 错误
      //    它们全都返回 `null`，而 `null` 在这套代码里的语义是"**没有这个会话**"
      //    ⇒ **存档坏了看起来跟没有一样**。对一个曾经丢过一整天存档的项目（09-17 那次事故）
      //      来说，这是最不该静默的那一类：用户与界面都只会以为"这个会话是空的"。
      //    ⚠️ 改动**只加日志、不动返回值**（`null` 的契约保持不变，调用方一行都不用改）——
      //      非 ENOENT 才出声，免得正常路径被刷屏。
      if (e?.code !== 'ENOENT') {
        console.error(`[sessions] 会话 ${id} 读不出来（文件在但解析/IO 失败）：${e?.message || e}`)
      }
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
    } catch (e) {
      // 同 get()：非 ENOENT 要出声（存档坏了不能看起来像"没有"）
      if (e?.code !== 'ENOENT') {
        console.error(`[sessions] 会话 ${id} 读不出来（peek，文件在但解析/IO 失败）：${e?.message || e}`)
      }
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    return this.index.length < before;
  }

  listSummaries(limit = 100) {
    return this.index.slice(0, limit);
  }

  // ── 删除（管理端"会话"页用）────────────────────────────────────────────
  // 与 discard 的区别：discard 只允许删"从未真正跑过"的等待中会话（保护用量账），
  // 这两个是**管理员主动清理留档**，允许删任何已结束的会话。
  // 运行中的一律不删 —— 编排器还在往这个文件里写，删了会边写边复活。

  /**
   * 删除一个会话记录：内存索引 + 磁盘文件。
   * @returns {{ok:boolean, error?:string, fileDeleted?:boolean}}
   */
  remove(id) {
    if (!id) return { ok: false, error: '缺少会话 id' };
    const live = this.current.get(id);
    if (live && live.status === 'running') {
      return { ok: false, error: '这个会话正在运行中，等它跑完再删' };
    }
    this.current.delete(id);
    this._lastPersistAt?.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    let fileDeleted = false;
    try {
      const f = sessionFile(id);
      if (fs.existsSync(f)) { fs.unlinkSync(f); fileDeleted = true; }
    } catch { /* ignore */ }
    // 索引里没有、文件也不存在 → 本来就没这个东西
    if (this.index.length === before && !fileDeleted) return { ok: false, error: '会话不存在' };
    return { ok: true, fileDeleted };
  }

  /**
   * 清空全部会话留档。**运行中的会话保留**（正在跑的不能删）。
   * @returns {{removed:number, files:number, skipped:number}}
   */
  clearAll() {
    const keep = new Set();
    let skipped = 0;
    for (const s of this.current.values()) {
      if (s.status === 'running') { keep.add(s.id); skipped += 1; }
    }
    const removed = this.index.filter((e) => !keep.has(e.id)).length;
    this.index = this.index.filter((e) => keep.has(e.id));
    // 运行中之外的内存态也一并清掉（等待中的会话属于"没跑起来"，可以删）
    for (const id of [...this.current.keys()]) {
      if (!keep.has(id)) {
        this.current.delete(id);
        this._lastPersistAt?.delete(id);
      }
    }
    let files = 0;
    try {
      for (const f of fs.readdirSync(SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue;
        const id = f.slice(0, -'.json'.length);
        if (keep.has(id)) continue;
        try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); files += 1; } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
    return { removed, files, skipped };
  }

  /**
   * 今日 token 统计**按模型**分项（🆕 2026-10-03 第三十八对话，提案 `8ec84f39`）。
   *
   * 为什么必须和 `todayUsage()` 同源（而不是自己去扫会话存档）：
   *   她要回答的是"某个模型今天花了多少"，而**总数**来自 `todayUsage()`
   *   （= `usage-today.json` 的累计 + 运行中的会话）。分项若另走一套来源
   *   （比如扫 `sessions/*.json`），两边就会各说各话 —— 同一个回答里"总数"与"分项之和"
   *   对不上，本项目对"两套口径"栽过跟头（控制台一个数、她嘴里另一个数）。
   *   ⇒ 分项也在**同一份账**里记（`#bumpTodayUsage` 顺手写 `models`），这里只做读取合并。
   *
   * ⚠️ `unattributedTokens` 是**诚实的缺口**，不是 0：
   *   · 不带模型信息的记账（目前只有夜里那条笔记走 `recordExternalUsage`，它没有 vendor/model）；
   *   · 升级前那一天已经写下的老文件（当时还没有 `models` 这一栏）。
   *   ⇒ 恒等式：`sum(models.totalTokens) + unattributedTokens === todayUsage(dayKey).totalTokens`。
   *     ⛔ 不许把这个缺口折成 0 或摊到某个模型头上。
   */
  todayUsageByModel(dayKey) {
    const map = new Map();
    const add = (vendor, model, usage, runs = 1) => {
      if (!String(model || '').trim()) return;      // 没有模型信息 ⇒ 进未分项那一档
      const key = modelLabel(vendor, model);
      const row = map.get(key) || {
        label: key,
        vendor: String(vendor || ''),
        model: String(model || ''),
        promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0
      };
      row.promptTokens += Number(usage?.promptTokens) || 0;
      row.completionTokens += Number(usage?.completionTokens) || 0;
      row.cachedTokens += Number(usage?.cachedTokens) || 0;
      row.totalTokens += Number(usage?.totalTokens) || 0;
      row.runs += Number(runs) || 0;
      map.set(key, row);
    };
    // ① 已结束的会话：记在 usage-today.json 的 models 里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey && data.models && typeof data.models === 'object') {
        for (const [label, row] of Object.entries(data.models)) {
          const { vendor, model } = splitModelLabel(label);
          add(vendor, model, row, Number(row?.runs) || 0);
        }
      }
    } catch { /* 无记录 */ }
    // ② 运行中的（与 todayUsage 的算法一致：它们本轮烧掉的也该看得见）
    for (const s of this.current.values()) add(s.vendor, s.model, s.usage);
    const models = [...map.values()].sort((a, b) => b.totalTokens - a.totalTokens);
    const attributed = models.reduce((n, m) => n + m.totalTokens, 0);
    const unattributedTokens = Math.max(0, (Number(this.todayUsage(dayKey)?.totalTokens) || 0) - attributed);
    return { dayKey, models, unattributedTokens };
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /**
   * 记一次「会话之外的模型调用」的用量（目前只有夜里那条笔记用它）。
   *
   * 为什么要走这里：不记的话，梦里烧掉的钱在成本看板里完全看不见 ——
   * 一个每天悄悄花钱、账上却不显示的功能，比没有这个功能更糟。
   *
   * 口径：token 数照加，runs +1（它确实是一次模型运行，只是没有会话留档），
   * 遥测的 calls 也 +1（与用量页"带 token 用量的调用次数"同一算法）。
   * 传进来的就是 API 原样的 usage（snake_case），交给 addUsage 去兼容各家字段。
   */
  recordExternalUsage(rawUsage) {
    if (!rawUsage) return;
    const usage = emptyUsage();
    addUsage(usage, rawUsage);
    usage.calls = 1;
    this.#bumpTodayUsage({
      startedAt: Date.now(),
      usage,
      webSearchCount: 0,
      // 只为了让遥测那边按同一算法数到这一次调用
      messages: [{ raw: { usage: rawUsage } }]
    });
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0, models: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    // ⚠️ 老文件（升级前写的）没有 `models` 这一栏 ⇒ 补一个空对象，
    //    缺的那部分会如实进 `todayUsageByModel().unattributedTokens`，⛔ 不折成 0、也不摊给某个模型。
    if (!data.models || typeof data.models !== 'object') data.models = {};
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + (Number(s.usage.cachedTokens) || 0);
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    // 🆕 2026-10-03 第三十八对话（提案 8ec84f39）：**同一份账里**顺手记按模型的分项。
    //    没有模型信息的记账（`recordExternalUsage`）刻意**不**进来 —— 它会落到
    //    `todayUsageByModel().unattributedTokens`，于是"总数 = 分项 + 未分项"这条恒等式永远成立。
    if (String(s.model || '').trim()) {
      const key = modelLabel(s.vendor, s.model);
      const row = data.models[key] || { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, runs: 0 };
      row.promptTokens += Number(s.usage.promptTokens) || 0;
      row.completionTokens += Number(s.usage.completionTokens) || 0;
      row.cachedTokens += Number(s.usage.cachedTokens) || 0;
      row.totalTokens += Number(s.usage.totalTokens) || 0;
      row.runs += 1;
      data.models[key] = row;
    }
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));

    // 累计总量（匿名遥测的唯一数据源：调用次数 + 三档 token 数，无任何身份信息）
    try {
      const tPath = path.join(DATA_DIR, 'telemetry-totals.json');
      let t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
      try { t = { ...t, ...JSON.parse(fs.readFileSync(tPath, 'utf8')) }; } catch { /* 首次 */ }
      // ⚠️ calls 的口径是「LLM 调用次数」（与用量页一致：带 token 用量的 raw 条目数），
      //    不是会话数；与 telemetry.js 的重建逻辑保持同一算法。
      let llmCalls = 0;
      for (const m of (s.messages || [])) {
        const ru = m?.raw?.usage || {};
        if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) llmCalls += 1;
      }
      t.calls += llmCalls;
      t.promptTokens += s.usage.promptTokens;
      t.completionTokens += s.usage.completionTokens;
      t.totalTokens += s.usage.totalTokens;
      // 工具调用明细：会话结束时按消息里的 toolCall 逐个点名一次（与用量页同一口径）
      if (!t.toolCounts || typeof t.toolCounts !== 'object') t.toolCounts = {};
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
      fs.writeFileSync(tPath, JSON.stringify(t), 'utf8');
    } catch { /* 遥测记账失败不影响主流程 */ }
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const tmp = `${sessionFile(s.id)}.${process.pid}.tmp`;
      // 紧凑序列化：这些文件只给程序读（界面走 API），缩进纯属浪费体积。
      // 实测缩进只占 1.6%（0.53MB/32.6MB）—— 体积主要是字符串内容，不是结构，别高估这项收益。
      fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
      fs.renameSync(tmp, sessionFile(s.id));
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
