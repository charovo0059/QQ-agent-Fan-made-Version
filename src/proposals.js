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

export { FILE as PROPOSALS_FILE, KIND_LABEL };
