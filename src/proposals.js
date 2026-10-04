// 「改进提案」队列 —— 机器人可以提议任何事，**但没有任何东西会自动生效**。
//
// 设计边界（用户 2026-09-19 拍板，改这块之前先读完）：
//   · 她可以提议**任何**事：记忆、人设、功能，甚至底层实现；
//   · 但提案只是**写进这个队列的文本** —— `data/proposals.json`，给管理员看；
//   · **不存在任何自动执行路径**。放行之后由人（用户或 AI）手动实施。
//
// ⚠️ 为什么坚决不自动执行（这条比"省事"重要得多）：
//   她的上下文里**混着群友说的话**（群消息、私聊、被 @ 的内容都会进上下文）。
//   而"待审条目本身"就是一条注入通道 —— 有人可以诱导她提交一条看起来无害的改动，
//   管理员瞟一眼觉得"这没啥"就点了同意。**只要自动执行存在，这个组合就是可被利用的。**
//   要开自动执行，必须逐类设计：路径白名单 + 改动行数上限 + 强制备份 + 明确的不可触碰清单。
//   在那之前，**提案队列的价值本来就是"让人看见她想要什么"**，而不是"让改动自己跑起来"。
//
// 另一个刻意的选择：**条目里存的都是纯文本**（title/detail/rationale/kind），
// 不存可执行的 patch、不存文件路径指令。这样即使有人往队列里塞指令式文本，
// 它最多也只是"一段读起来像指令的文字"，不会有任何东西去解析并执行它。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from './config.js';

const FILE = path.join(DATA_DIR, 'proposals.json');
const MAX_TITLE = 80;
const MAX_DETAIL = 4000;
const MAX_RATIONALE = 800;

/** 分类：只用于**显示分组**与将来按类开白名单，现在不改变任何行为。 */
export const PROPOSAL_KINDS = ['memory', 'persona', 'feature', 'code', 'other'];
const KIND_LABEL = {
  memory: '记忆',
  persona: '人设',
  feature: '功能',
  code: '底层/代码',
  other: '其他'
};

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && Array.isArray(j.items)) return { version: j.version || 1, items: j.items };
  } catch { /* 还没有过提案 */ }
  return { version: 1, items: [] };
}

function save(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);   // 先写 tmp 再 rename：半截文件比不写更糟
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 记一条提案。
 * @returns {{ok: true, item: object} | {ok: false, error: string}}
 */
export function appendProposal({ kind, title, detail, rationale, chatKey = '', model = '' } = {}) {
  const cfg = getConfig();
  if (cfg?.proposals?.enabled === false) {
    return { ok: false, error: '提案功能当前被管理员关掉了（config.proposals.enabled=false）' };
  }
  const k = PROPOSAL_KINDS.includes(String(kind)) ? String(kind) : 'other';
  const t = clip(title, MAX_TITLE);
  const d = clip(detail, MAX_DETAIL);
  if (!t) return { ok: false, error: 'title 不能为空（一句话说清你想改什么）' };
  if (!d) return { ok: false, error: 'detail 不能为空（说清具体想怎么改，好让别人能照着做）' };

  const state = load();
  const pending = state.items.filter((x) => x.status === 'pending').length;
  const cap = Math.max(1, Number(cfg?.proposals?.maxPending) || 50);
  if (pending >= cap) {
    return { ok: false, error: `待审提案已经积压 ${pending} 条（上限 ${cap}），先等管理员处理掉再提` };
  }
  // 去重：同分类 + 同标题的待审条目不再重复收（她容易连着提同一件事）
  if (state.items.some((x) => x.status === 'pending' && x.kind === k && x.title === t)) {
    return { ok: false, error: '这条（同分类同标题）已经在待审区里了，不用重复提' };
  }

  const item = {
    id: crypto.randomBytes(4).toString('hex'),
    at: Date.now(),
    kind: k,
    kindLabel: KIND_LABEL[k],
    title: t,
    detail: d,
    rationale: clip(rationale, MAX_RATIONALE),
    fromChat: String(chatKey || ''),
    model: String(model || ''),
    status: 'pending',        // pending | accepted | rejected | done
    reviewedAt: null,
    reviewNote: ''
  };
  state.items.unshift(item);
  // 只保留最近 300 条（含已处理的），避免文件无限长
  if (state.items.length > 300) state.items.length = 300;
  save(state);
  return { ok: true, item };
}

/** 列提案。默认只列待审的。 */
export function listProposals({ status = 'pending', limit = 50 } = {}) {
  const state = load();
  const items = status === 'all' ? state.items : state.items.filter((x) => x.status === status);
  return {
    items: items.slice(0, Math.max(1, Number(limit) || 50)),
    counts: {
      pending: state.items.filter((x) => x.status === 'pending').length,
      accepted: state.items.filter((x) => x.status === 'accepted').length,
      rejected: state.items.filter((x) => x.status === 'rejected').length,
      done: state.items.filter((x) => x.status === 'done').length,
      total: state.items.length
    }
  };
}

/** 标记处理结果。⚠️ 这里**只改状态字符串**，不执行提案里的任何内容。 */
export function reviewProposal(id, { status, note = '' } = {}) {
  const allowed = ['accepted', 'rejected', 'done', 'pending'];
  if (!allowed.includes(String(status))) {
    return { ok: false, error: `status 只能是 ${allowed.join(' / ')}` };
  }
  const state = load();
  const it = state.items.find((x) => x.id === String(id));
  if (!it) return { ok: false, error: `找不到提案 ${id}` };
  it.status = String(status);
  it.reviewedAt = Date.now();
  it.reviewNote = clip(note, 500);
  save(state);
  return { ok: true, item: it };
}

export function pendingCount() {
  return load().items.filter((x) => x.status === 'pending').length;
}

// ═══════════════════════════════════════════════════════════════════════════
// 「你提过的那件事有回复了」—— **每会话**一个高水位（🆕 2026-10-04 第四十对话 · 批 2，方案 §4.2）
//
// ── 为什么要有它 ────────────────────────────────────────────────────────
// `reviewNote` 后端早就收了（`reviewProposal`），她也能用 `get_my_proposals` 读到 ——
// 但她**不知道有人回复过**：实测全窗口只调过 7 次、近 7 天 0 次、7 次里 0 次带检索词
// （见交接 §6-164 的口径：只数 `tool_calls`）。⇒ 要在**唤醒时**主动跟她说一声。
//
// ── 为什么高水位住在**独立 sidecar** 而不是提案条目里 ────────────────────
//   ① 提案是**全局**的（一份 proposals.json 服务所有会话），而"提醒到哪了"是**每会话**的状态；
//   ② `test-提案队列.mjs` 有一张**字段白名单**（`src/proposals.js` 的条目形状是数据契约）
//      —— 往条目里加字段必红，而那条判据是对的：界面状态不该污染数据形状。
//   ⇒ 形状照抄 `store.js` 的 `trim-marks.json`（模块级导出 + 取走即清 + 只写 `.tmp` 再 rename）。
//
// ── 口径（与 `swept` / 毛边同一套）─────────────────────────────────────
//   · **首次**（这个 chatKey 还没记录）⇒ **不播报**，只记下当前 `max(reviewedAt)` 当天花板。
//     ⛔ 否则她一进新会话就被 22 条历史一次性刷屏。
//   · 只有 `status ∈ {accepted, rejected, done}` 才算"有回复"（`pending` = 还没人看过）。
//   · 取走即把高水位推到当前天花板；`reviewedAt` 早于高水位的不算。
// ═══════════════════════════════════════════════════════════════════════════
const REPLY_SEEN_FILE = path.join(DATA_DIR, 'proposal-reply-seen.json');
/** 最多记多少个会话的高水位（与 trim-marks 同一条思路：防"再也没醒过的会话"把文件撑大）。 */
const REPLY_SEEN_MAX_CHATS = 200;
/** 哪些状态算"有人回复过"。 */
export const REPLIED_STATUSES = ['accepted', 'rejected', 'done'];

function loadReplySeen() {
  try {
    const j = JSON.parse(fs.readFileSync(REPLY_SEEN_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }        // 还没有过提醒 / 文件坏了 ⇒ 当成空（坏文件不该让唤醒失败）
}

function saveReplySeen(all) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${REPLY_SEEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), 'utf8');
    fs.renameSync(tmp, REPLY_SEEN_FILE);   // 先写 tmp 再 rename：半截文件比不写更糟
  } catch (error) {
    // 提醒记不下来**不能**拖垮唤醒（与 trim-marks 同一条纪律）⇒ 只记日志
    console.error('[proposals] 回复提醒高水位落盘失败：', error?.message ?? error);
  }
}

/**
 * 取走"你提过的提案有回复了"的提醒（**只读一次**，取走即把高水位推上去）。
 * @param {string} chatKey
 * @returns {{count:number, lastAt:number}|null} 没有新回复 / 首次 ⇒ null
 */
export function takeProposalReplyNotice(chatKey) {
  const key = String(chatKey || '');
  if (!key) return null;
  const replied = load().items
    .filter((x) => REPLIED_STATUSES.includes(String(x.status)) && Number(x.reviewedAt) > 0);
  const top = replied.reduce((m, x) => Math.max(m, Number(x.reviewedAt) || 0), 0);
  const all = loadReplySeen();
  if (!Object.prototype.hasOwnProperty.call(all, key)) {
    // 首次：只把天花板记下来，**不播报**（否则新会话会被历史一次性刷屏）。
    // 🔴 **天花板是 0 也要写**（第一版判据当场抓到我差点漏掉的东西）：
    //    若"没有已回复"时**不写**，那么等一下真来了第一条回复，这个会话仍然是"首次"
    //    ⇒ 那一条回复的提醒会被当成"历史"吞掉，**永远播报不出来**。
    //    代价只是 sidecar 里多一条 0 —— 换来"这个会话我见过了"这个事实。
    all[key] = top;
    trimReplySeen(all);
    saveReplySeen(all);
    return null;
  }
  const prev = Number(all[key]) || 0;
  const fresh = replied.filter((x) => Number(x.reviewedAt) > prev);
  if (!fresh.length) return null;
  all[key] = top;
  trimReplySeen(all);
  saveReplySeen(all);
  return { count: fresh.length, lastAt: Math.max(...fresh.map((x) => Number(x.reviewedAt) || 0)) };
}

/** 按"最后提醒时间"留最新的一批（与 trim-marks 的 TRIM_MAX_CHATS 同一套）。 */
function trimReplySeen(all) {
  const keys = Object.keys(all);
  if (keys.length <= REPLY_SEEN_MAX_CHATS) return;
  keys.sort((a, b) => (Number(all[b]) || 0) - (Number(all[a]) || 0));
  for (const k of keys.slice(REPLY_SEEN_MAX_CHATS)) delete all[k];
}

export { FILE as PROPOSALS_FILE, KIND_LABEL, REPLY_SEEN_FILE };
