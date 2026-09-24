// 群友印象记忆：每个会话一个文件夹，每个群友一个以 QQ 号命名的 JSON 文件。
// 目录结构：
//   data/memory/group_<群号>/<QQ>.json
//   data/memory/private_<QQ>/<QQ>.json
// 每个成员文件：{ userId, name, impressions: [{ content, createdAt }], updatedAt, lastConsolidatedAt }
// 旧版单文件 data/memory/group_<群号>.json 会在首次访问时自动迁移。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from './config.js';

const MEMORY_DIR = path.join(DATA_DIR, 'memory');

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function legacyFile(chatKey) {
  return path.join(MEMORY_DIR, `${chatDirName(chatKey)}.json`);
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

/**
 * 🆕 2026-09-21（第十对话）：把某个会话的记忆目录暴露出来。
 * 为什么需要导出：目录名由内部的 `chatDirName()` 决定（含转义规则），
 * 而**测试需要往 `_meta.json` 里写 `lastSeenAt`** 来构造场景。
 * 不导出的话测试只能去猜目录名或"先写一条占位再到处找" —— 那是在测实现细节，
 * 而且 chatDirName 一改测试就碎（本项目已经把"测试硬编码实现细节"吃过好几次亏）。
 */
export function memoryDirOf(chatKey) {
  return chatDir(String(chatKey || ''));
}

/**
 * 「同一个人」候选清单（2026-09-24 第十三对话加）。
 *
 * 为什么在 memory.js 里：身份表（`memory.identity`）本来就归它管
 * （见下面的 `#identityMap` / `identityMap()`），候选清单是同一件事的另一半 ——
 * "有哪些人可以跟谁标成同一个人"。
 *
 * 为什么写成**纯函数**（依赖全部由参数传入）：这段逻辑有三个来源、四种去重/标记规则，
 * 而它出错的样子是**静默的**（用户想关联的那个人根本没出现在列表里 —— 见
 * 待办与决策记录 §51.4，线上就是这么坏的）。要能脱离 HTTP、真实数据目录与机器人状态
 * 单独钉住它，就必须把"取数据"和"算清单"分开。
 *
 * 三个来源（同一个「平台:id」只出现一次 —— 候选是**人**，不是"人在哪些会话里出现"）：
 *   ① 有记忆文件的成员           —— count = 印象条数，`noImpression: false`
 *   ② 白名单里还没有印象的私聊   —— 对端本人就是那个人，count = 0，`noImpression: true`
 *   ③ 微信联系人表里的联系人     —— 桥学过 id ↔ 昵称，没聊过也在，count = 0，`noImpression: true`
 *
 * ⚠️ **群聊成员不在此列**：群成员名单本地没有，要列就得调 OneBot
 *    （`get_group_member_list`）⇒ 记忆页会依赖网络与机器人状态。这里有意不调。
 *
 * ⚠️ ②③ 的 `count` 是 0，但它与"有记忆文件、只是印象数恰好为 0"**不是一回事**，
 *    所以必须带 `noImpression` 让界面说「还没有印象」而不是"0 条"。
 *
 * @param {object}   deps
 * @param {string[]} deps.chatKeys     有记忆文件的会话（`memory.listChats()`）
 * @param {Function} deps.membersOf    `(chatKey) => [{userId,name,impressions}]`
 * @param {Function} deps.platformOf   `(chatKey) => 'qq'|'wechat'`
 * @param {Array}    deps.contacts     微信联系人表（`listContacts({kind:'private'})`）
 * @param {object}   deps.notes        `config.memberNotes`（QQ 侧没有昵称时的名字来源）
 * @param {string[]} deps.allowPrivate `config.allow.private`
 */
export function buildIdentityCandidates({
  chatKeys = [], membersOf, platformOf, contacts = [], notes = {}, allowPrivate = []
} = {}) {
  const chats = [];
  const byChat = new Map();
  const byKey = new Map();
  const seenKey = new Set();
  const addPerson = (chatKey, platform, userId, name, count, noImpression) => {
    const uid = String(userId ?? '');
    if (!uid) return;
    const key = `${platform}:${uid}`;
    if (seenKey.has(key)) {
      // 同一个人可能在**多个会话**里都有记忆文件 ⇒ 条数**累加**。
      // 为什么不是"先到先得"：那会让界面上显示的数字取决于 `memory.listChats()` 的排序，
      // 而那个顺序是任意的 ⇒ 同一份数据换个顺序显示的数就变，属于"看着有依据其实是噪声"。
      const prev = byKey.get(key);
      if (prev && !prev.noImpression) prev.count += Number(count) || 0;
      return;
    }
    seenKey.add(key);
    if (!byChat.has(chatKey)) {
      const entry = { chatKey, platform, members: [] };
      byChat.set(chatKey, entry);
      chats.push(entry);
    }
    const member = {
      userId: uid,
      name: String(name || ''),
      count: Number(count) || 0,
      identityKey: key,
      noImpression: !!noImpression
    };
    byChat.get(chatKey).members.push(member);
    byKey.set(key, member);
  };

  // ① 有记忆文件的成员（原有来源，语义不变）
  for (const chatKey of chatKeys) {
    const platform = platformOf(chatKey);
    for (const m of membersOf(chatKey)) {
      if (!m.userId) continue;
      addPerson(chatKey, platform, m.userId, m.name, (m.impressions || []).length, false);
    }
  }
  // ② 白名单里的私聊：没有记忆也要能选（对端本人就是"那个人"）
  const contactName = new Map((contacts || []).map((c) => [String(c.id), String(c.name || '')]));
  for (const uid of allowPrivate) {
    const chatKey = `private:${String(uid)}`;
    const platform = platformOf(chatKey);
    const name = platform === 'wechat' ? (contactName.get(String(uid)) || '') : (notes[String(uid)] || '');
    addPerson(chatKey, platform, uid, name, 0, true);
  }
  // ③ 微信联系人表：桥学过的人都列出来（微信 id 只有桥知道，用户认的是昵称）
  for (const c of (contacts || [])) addPerson(`private:${String(c.id)}`, 'wechat', c.id, c.name, 0, true);

  return chats.filter((c) => c.members.length);
}

function memberFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_\u4e00-\u9fa5]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function memberFile(chatKey, userId, name = '') {
  return path.join(chatDir(chatKey), memberFileName(userId, name));
}

// ── 读不出来时：ENOENT 静默；其它错误"留档保命 + 限流出声" ────────────────────
// 🆕 2026-09-22（第十二对话）：与 `config.js` / `stickers.js` / `wechat-contacts.js` /
//    `dream.js` 同一取向（它们是本族的先例）。这一处当时被记成"低危、记录不改，
//    要做得配套限流，属独立课题"（见 `待办与决策记录.md` §47.4 第 5 行 / §48.6）——
//    现在按**同样的判据**补上，并把它当时缺的那一半（限流）一起做掉。
//
// 判据（用户 2026-09-22 给的原话）：
//   **"核心不是有没有返回值，而是后续是否存在隐式写回原路径的风险。"**
// 本文件的链路确实成立：`loadMember()` 读失败 ⇒ `{ impressions: [] }`
//   ⇒ `#appendRaw` / `editMemberImpression` / 整理 都会 `writeJson(memberFile(...))`
//   ⇒ **那个人的印象被无声清空**。
// 返回值契约**一字不变**（仍返回 fallback），所以调用方一行都不用改。
//
// 为什么这一处要限流而那四处不用：它们在**冷路径**（启动读一次、收到消息防抖读一次），
// 而 `readJson` 是**热路径** —— 每次记忆读取都要走它，一个坏文件会按"每条消息 × 每人"刷屏。
// 两条口径都**按文件**（一个坏文件不该把别的坏文件的报警压掉）：
//   1. 出声 —— 同一文件最多每 60 秒一次；
//   2. 留档 —— 同一文件**只做一次**。`copyFileSync` 是整份复制，热路径上重复复制会白占磁盘；
//      而且一次读失败在本文件里会触发**两次** `readJson`（`#ensureChat` 的扫描 + `loadMember`），
//      不去重就会立刻多出一份。
const READ_FAIL_LOG_COOLDOWN_MS = 60 * 1000;
/** file -> { lastLogAt, backedUp }。一人一个文件，群多了可能上千个键 ⇒ 到顶整体清空。 */
const readFailState = new Map();

function reportReadFailure(file, err, { backup = false } = {}) {
  const now = Date.now();
  const st = readFailState.get(file) || { lastLogAt: 0, backedUp: false };
  if (readFailState.size >= 512) readFailState.clear();   // 清空只会让某个文件多报一次，不会漏报
  let bak = null;
  if (backup && !st.backedUp) {
    // 与那四处同款：原文件另存为 `.corrupt-<时间戳>`，**原文件不动** ⇒ 数据还在盘上、可人工恢复
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    bak = `${file}.corrupt-${stamp}`;
    try { fs.copyFileSync(file, bak) } catch { bak = null }   // 连备份都失败也得继续报
    st.backedUp = true;
  }
  if (now - st.lastLogAt >= READ_FAIL_LOG_COOLDOWN_MS) {
    st.lastLogAt = now;
    console.error(`[memory] ${file} 存在但读不出来（${err?.message || err}）`
      + (bak ? `—— 已另存为 ${path.basename(bak)}` : '—— 本次按空值处理')
      + `；⚠️ 原文件没有被覆盖，可人工恢复。`
      + `（同一文件的这条提示 ${READ_FAIL_LOG_COOLDOWN_MS / 1000} 秒内只报一次）`);
  }
  readFailState.set(file, st);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
    // 读到了合法 JSON、但不是我们写出来的形状（不是对象）⇒ 同样算"读不出来"：
    // 回退值一样会被调用方写回原路径。这里**不**留档（`dream.js` 对"结构不对"也只出声不留档）。
    reportReadFailure(file, new Error(`内容不是对象（${parsed === null ? 'null' : typeof parsed}）`));
    return fallback;
  } catch (err) {
    // 文件不存在 = 首次运行 / 该人还没印象 ⇒ 这是**正常路径**，静默（与那四处一致）
    if (err?.code !== 'ENOENT') reportReadFailure(file, err, { backup: true });
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function loadMember(chatKey, userId, name = '') {
  const file = memberFile(chatKey, userId, name);
  const raw = readJson(file, null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    impressions: Array.isArray(raw?.impressions) ? raw.impressions : [],
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function loadMeta(chatKey) {
  const raw = readJson(metaFile(chatKey), null);
  return { lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0 };
}

// ── 印象召回：门槛制（2026-09-19）─────────────────────────────────────────
//
// 为什么改：原来是**配额制** —— `all.slice(0, 15)` + 每人 `impressions.slice(-3)`。
//   配额制的病是"凑数"：不相关的印象被硬塞进上下文充场面，模型拿着一堆不贴题的
//   "已记得"说话。实测（调研报告 §1.3）：印象层等权、无轻重、无衰减。
//
// 依据 WrenWen docs/01-记忆召回打分.md（作者自己说"这份是纯逻辑，架在 CC/Codex 上的人也能直接搬"）：
//   "早期版本是配额制：每源固定名额，结果是凑数……现行制度整个反过来：
//    **一道绝对相关度门槛，过线才进，低于门槛宁可零条。**"
//   它的实测结论："top1 分数的中位数是 67.95 < 75 ⇒ 弱相关的一轮直接 0 条，
//    正是要的行为（**错的不如空着**）。"
//
// ⚠️ 我们**没有 embedding**（配置里没有 embedding provider），所以不能照搬它的 semantic×100。
//    这里用**词法重合 + 时间衰减**替代，判据落在同一句原则上：**过线才进，宁缺毋滥。**
//
// ⚠️ 门槛值不拍脑袋：它**锚在公式自己的"噪声水位"上** —— 见 IMPRESSION_THRESHOLD 的推导。
//    WrenWen 的方法论原话："定阈值的方法比这个数值钱：要么挂在系统里已有的同类水位线上，
//    要么拿真实分布标定；**孤立的数没有来历，只会被下一个人顺手调掉。**"

/** 时间衰减：30 天半衰式的线性近似，归一到 [0,1]。 */
const IMPRESSION_RECENCY_HALFLIFE_DAYS = 30;
/** 每条印象最多贡献多少分给"关键词重合"。 */
const IMPRESSION_KEYWORD_CAP = 3;

/**
 * 给一条印象打分。**纯函数**，返回 0~1。
 *
 * ⚠️ 权重分配是**实测调出来的**，不是拍的。第一版把"讲的人正在说话"当最强信号（+0.35），
 *    结果在测试里立刻暴露问题：`userIds` 在这套系统里是「**这一轮卷进来的所有人**」
 *    （触发批 + 档位选中的已读，见 prompt.js 的 relevantUserIds），**群里可能有好几个人**，
 *    所以这个加成区分不了谁——而 0.35 单独就能过线 ⇒ **只要是"这轮里出现的人"，
 *    哪怕印象是 400 天前的"他喜欢喝咖啡"，也会被放进来**。那正是要治的病。
 *    ⇒ 改成：**关键词重合当主信号，时间衰减当基线**，去掉那个区分不出东西的讲话人加成。
 *
 * 三个分项：
 *   · keyword    —— 与"这一轮在聊什么"的词法重合（每个 2 字词 +0.25，封顶 0.75）。
 *                   **主信号**："这件事现在被提到"才是真正相关的证据。
 *   · recency    —— 30 天半衰，满值 0.30。**基线**：够新的印象本身有一点价值，
 *                   但**单独不够过线**（刻意如此 —— 不然就退化成"总是带最近的"，
 *                   那正是原实现 `slice(-3)` 的毛病）。
 *   · reinforced —— 被用过（写过 reinforcedAt）+0.05，只是打破平局用。
 *                   ⚠️ 权重必须小、且**必须配合时间衰减** —— 否则会自我强化锁死。
 *                   这是 Generative Agents 踩过的坑（`retrieve.py` 检索后刷 `last_accessed`，
 *                   而 reflect 按 `last_accessed` 排序，"被想起的更容易再被想起"，它没做任何抑制）。
 */
export function scoreImpression(entry, { member = {}, isSpeaking = false, keywords = [], now = Date.now() } = {}) {
  if (!entry || typeof entry !== 'object') return 0;
  const text = String(entry.content ?? '');
  if (!text.trim()) return 0;

  let score = 0;
  // ① 与当前这轮的关键词重合（主信号）
  let hits = 0;
  for (const kw of keywords) {
    if (kw && text.includes(kw)) hits += 1;
  }
  score += Math.min(IMPRESSION_KEYWORD_CAP, hits) * 0.25;
  // ② 时间衰减（基线）
  const at = Number(entry.createdAt) || 0;
  if (at > 0) {
    const days = Math.max(0, (now - at) / 86400000);
    score += 0.3 * Math.pow(0.5, days / IMPRESSION_RECENCY_HALFLIFE_DAYS);
  }
  // ③ 被用过（打破平局用的小权重）
  if (Number(entry.reinforcedAt) > 0) score += 0.05;
  return Math.min(1, score);
}

/**
 * 绝对门槛。**推导（不是拍的）**：
 *
 *   本公式的"噪声水位" = 只有 ② 时间衰减、其他全不命中时能拿到的最大值。
 *   刚写下的印象：0.30×0.5^0 = 0.30。再加 ③ 被用过 0.05 = **0.35**。
 *   ⇒ 门槛取 **0.30**，含义是：
 *     **"仅仅是新"（刚写下、跟这轮毫无关系）刚好等于门槛，不算过线。**
 *     必须**至少命中一个关键词**（0.25 + 衰减）才真正进来。
 *
 *   ⇒ 一句话：**进不进提示词，取决于"这件事现在有没有被提到"，而不是"够不够新"。**
 *     这正是门槛制与配额制（原 `slice(-3)`）的分野。
 *
 *   ⚠️ 这个门槛刻意与 WrenWen 的 75 同构：它把门槛压在同一条水位线上
 *      （语义准入线 = base + 0.71×100 = 75），"两条通道一把尺子"。
 *      我们这里是**一条通道一把尺子：噪声不得入选**。
 *   ⚠️ 调这个数之前请先想清楚：改的不是"严格程度"，而是"什么叫噪声"。
 */
export const IMPRESSION_THRESHOLD = 0.3;

/** 从这一轮的消息里抽关键词（只取 2 字及以上的中文词与 2+ 的英文/数字串，去重、限量）。 */
export function extractKeywords(text, limit = 40) {
  const t = String(text ?? '');
  if (!t.trim()) return [];
  const out = [];
  const seen = new Set();
  // 中文 2~4 字滑窗 + 英文/数字词。刻意粗一点：宁可多抽，反正后面按"命中"计分。
  const cjk = t.match(/[\u4e00-\u9fa5]{2,4}/g) || [];
  const latin = t.match(/[A-Za-z0-9_]{2,}/g) || [];
  for (const w of [...cjk, ...latin]) {
    const k = w.toLowerCase();
    if (seen.has(k) || k.length < 2) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

// ── 跨会话互通的两个上限（控 token）──
// 记忆是按「会话 + 群友」切的，互通后同一个人可能同时带来好几个会话的印象。
// 一次提示词里，跨会话部分最多 CROSS_CHAT_TOTAL 行，单个人最多 CROSS_CHAT_PER_MEMBER 条。
const CROSS_CHAT_PER_MEMBER = 4;
const CROSS_CHAT_TOTAL = 12;

/** 给跨会话印象标来源用：私聊 / 群 123456。 */
function chatLabel(chatKey) {
  const s = String(chatKey || '');
  if (s.startsWith('private:')) return '私聊';
  const m = /^group:(\d+)$/.exec(s);
  return m ? `群 ${m[1]}` : s;
}

/**
 * 「这个印象属于谁」的标签 —— 用户 2026-09-20 的硬要求：
 * **"要让她知道记忆印象来自哪里以及属于谁，不以名字而是以 id 为准，名字为辅，
 *   微信侧则是以名字为主，因为微信通常是固定备注不会变"**。
 *
 * 落到字面上两边**恰好同形**：`名字（id 数字）`。区别在**读的人怎么用**（写进提示词的引导语里说清）：
 *   · QQ   ：名字随时会改（群名片/昵称）⇒ 真正的锚是 **id**，名字只是线索
 *   · 微信 ：名字是固定备注 ⇒ **名字**可信、可直接当她认人的依据，id 是补充
 *
 * ⚠️ 名字缺失时只给 `id 数字`，**不要编一个名字**。
 * ⚠️ `id` 这两个字是故意写的：QQ 号与微信派生 id **形态一样、会撞号**
 *    （微信 id 是桥派生的 31 位数字，见 store.js 的 chatSource 注释），
 *    所以这个标签本身**不足以区分平台** —— 跨平台时调用方必须另外标出平台
 *    （见 `sourceTag`），否则"id 1234"到底是 QQ 还是微信根本看不出来。
 *
 * @param {string} uid  印象所属人的 id（可能为空）
 * @param {string} name 名字（备注/群名片/昵称）
 */
function whoLabel(uid, name) {
  const n = String(name || '').trim();
  const id = String(uid || '').trim();
  if (!id) return n || '某人';
  if (!n || n === id) return `id ${id}`;
  return `${n}（id ${id}）`;
}

/**
 * 「这个印象来自哪里」的标签。
 *
 * 同平台（或同一个会话）时**不标平台名** —— 那是最常见的情况，标了只是噪声。
 * 跨平台时标出平台：`QQ·群 111` / `微信·私聊`。
 *
 * 🔴 2026-09-20 **K3 第四轮回执已定：选 C，维持 `｜来自QQ·私聊` 这个写法**（别再"优化"它）。
 *    他的三条理由（原文要点）：
 *      ① **【别露馅】保护的是"对方的体验"，不是"她的知情权"。**
 *         第 3 条是**输出侧**禁令，管她说出来的话；记忆标记是**输入侧**事实，管她知道什么 ——
 *         两者本来就不是一回事。而且**早有判例**：微信提示词里
 *         "你现在在微信里，不是 QQ"那句就是"输入侧允许、输出侧不许"的既定口径。
 *         记忆标记与它同类：**她知道，但不说。**
 *      ② 用户要的就是"让她知道来自哪里"—— 跨平台认人需要她推理"微信的某群友 = QQ 的那位"，
 *         写成"另一个平台"是逼她做多余的推断，而本项目的工程哲学正是
 *         **"让事实看得见，而不是要她记规则"**（同一条哲学见 `@别人` 那个修复）。
 *      ③ 输出行为由第 3 条约束，**不由输入措辞决定** —— 实测已证明提示词里有"不是 QQ"
 *         而回复零泄漏；把事实藏起来**加固不了输出侧**，只会削弱认人能力。
 *
 *    ⚠️ K3 同时指出**真正的缝不在"标记里有 QQ"**，而在
 *       **没有测试覆盖"上下文含跨平台标记时，输出侧守不守得住"**。
 *       ⇒ 工程侧已加 `工具-会话诊断\查-跨平台标记与回复漏出.mjs`（扫真实会话存档：
 *          `userPrompt` 含 `｜来自QQ·` 的轮次，其 `send_message` 正文里有没有漏出字样）。
 *         现在**样本为 0**（identity 还是空的，跨平台要人工关联才会出现）——
 *          这条判据的价值在于关联生效后样本会自己长出来。**如实标注，不假装验过。**
 *
 *    📌 另有一条 K3 的**标注**（本次不动，将来要放宽得**单独立项**）：
 *       【别露馅】第 3 条目前是**一刀切**措辞；对**已被人工关联的跨平台熟人**来说，
 *       "我在那边也见过你"其实未必算露馅。但那是**输出侧行为**的放宽，是另一次独立变更。
 */
function sourceTag(chatKey, { mine, platform }) {
  const p = String(platform || 'qq');
  const parts = [];
  if (p !== mine) parts.push(p === 'wechat' ? '微信' : 'QQ');
  parts.push(chatLabel(chatKey));
  return parts.join('·');
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // chatKey -> Map(userId|_n_xx, member)
    // 会话 → 平台（'qq'/'wechat'）的缓存，来源是 messages/<chatKey>.json 的 source 字段。
    // 见 platformOf 的注释：不能 import store.js（循环依赖），所以这里自己读 + 缓存。
    this._platCache = null;
    this._platStamp = -1;
    // 🆕 2026-09-21（第十对话，提案 16:45「希望记忆的增删改对本人可见/可感知」）：
    //    chatKey -> { at, items:[{name,userId,delta,at}] } —— **本次唤醒周期内**算出来的
    //    "记忆变过"的那一份。
    //
    //    为什么要缓存在内存里而不是每次现算：
    //    提示词**每一轮都重新渲染**（多轮工具调用时会有第 2、3 轮）。若每次渲染都
    //    重新比对并把 lastSeenAt 推到现在，那么第 2 轮就再也算不出"变过"了
    //    ⇒ 提示只在第一轮出现，而第一轮恰恰可能只是去调了个工具。
    //    ⇒ 所以"算一次、记在内存里、整个唤醒周期都用它"，并在**真正跑完**时调
    //      `commitChangedNote(chatKey)` 才把 lastSeenAt 推上去（见那里的注释）。
    this._changedNote = new Map();
  }

  /** 扫描所有有记忆的会话（文件夹或旧版单文件）。 */
  listChats() {
    const out = new Set();
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory()) {
          const m = /^(group|private)_(\w+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        } else {
          const m = /^(group|private)_(\w+)\.json$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* 目录不存在 */ }
    return [...out];
  }

  /** 旧版单文件 → 新版每成员文件。迁移后旧文件移到 backups/。 */
  #migrateLegacy(chatKey) {
    const legacy = legacyFile(chatKey);
    if (!fs.existsSync(legacy)) return;
    try {
      if (fs.statSync(legacy).isDirectory()) return;
      const old = readJson(legacy, null);
      if (!old) return;
      const notes = getConfig().memberNotes || {};
      const nameToQq = {};
      for (const [qq, name] of Object.entries(notes)) {
        if (name) nameToQq[String(name)] = String(qq);
      }
      const migrated = [];
      for (const e of Array.isArray(old.memberImpression) ? old.memberImpression : []) {
        if (!e?.content) continue;
        const target = String(e.target || '').trim();
        let userId = /^\d{5,15}$/.test(target) ? target : (nameToQq[target] || '');
        migrated.push({
          userId,
          name: target,
          content: String(e.content).slice(0, 300),
          createdAt: Number(e.createdAt) || Date.now()
        });
      }
      // 旧的 activeTopic/pendingThought 直接丢弃（本版只保留群友印象）
      for (const m of migrated) this.#appendRaw(chatKey, m.userId, m.name, m.content, m.createdAt, 'legacy');
      const backupDir = path.join(MEMORY_DIR, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, path.basename(legacy));
      if (fs.existsSync(backup)) fs.rmSync(backup, { force: true });
      fs.renameSync(legacy, backup);
    } catch (error) {
      console.error('[memory] 旧记忆迁移失败:', error?.message ?? error);
    }
  }

  #ensureChat(chatKey) {
    this.#migrateLegacy(chatKey);
    if (!this.cache.has(chatKey)) {
      const map = new Map();
      try {
        for (const f of fs.readdirSync(chatDir(chatKey))) {
          if (!f.endsWith('.json') || f === '_meta.json') continue;
          const raw = readJson(path.join(chatDir(chatKey), f), null);
          if (!raw) continue;
          const key = raw.userId ? String(raw.userId) : `_n_${f}`;
          map.set(key, loadMember(chatKey, raw.userId, raw.name));
        }
      } catch { /* 尚无文件夹 */ }
      this.#mergeNameDuplicates(chatKey, map);
      this.cache.set(chatKey, map);
    }
    return this.cache.get(chatKey);
  }

  /**
   * 合并"同一个人被存成两份"的历史数据。
   *
   * 背景：早期没有 QQ 号时会按名字落文件（_n_xxx.json）。后来拿到 QQ 号再次写入时，
   * 会新建 <QQ>.json，但旧的 _n_ 文件不会被清理 → 同一个人在记忆里出现两次，
   * 印象重复、整理时互相干扰，也让"印象总数"虚高。
   *
   * 规则：无 QQ 号的条目，只要有同名（且该名字对应的条目有 QQ 号），
   * 就把它的印象并入该 QQ 号条目，然后删除 _n_ 文件。
   */
  #mergeNameDuplicates(chatKey, map) {
    const nameToId = new Map();
    for (const m of map.values()) {
      const uid = String(m.userId || '').trim();
      const nm = String(m.name || '').trim();
      if (uid && nm) nameToId.set(nm, uid);
    }
    const toDelete = [];
    for (const [key, m] of map.entries()) {
      const uid = String(m.userId || '').trim();
      if (uid) continue;                       // 已有 QQ 号，不是兜底条目
      const nm = String(m.name || '').trim();
      const targetId = nameToId.get(nm);
      if (!targetId) continue;
      const target = map.get(targetId);
      if (!target) continue;

      const seen = new Set(target.impressions.map((e) => e.content));
      let added = 0;
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        seen.add(e.content);
        target.impressions.push({ ...e });
        added += 1;
      }
      if (added) {
        target.impressions.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
        writeJson(memberFile(chatKey, targetId, target.name), target);
      }
      // 删除已被并入的兜底文件
      try { fs.rmSync(memberFile(chatKey, '', nm), { force: true }); } catch { /* ignore */ }
      toDelete.push(key);
      console.log(`[memory] 合并重复记忆：${nm}（无 QQ 号）→ ${targetId}，并入 ${added} 条`);
    }
    for (const k of toDelete) map.delete(k);
  }

  #appendRaw(chatKey, userId, name, content, createdAt = Date.now(), source = 'model') {
    const map = this.#ensureChat(chatKey);
    const key = userId ? String(userId) : `_n_${memberFileName('', name)}`;
    const member = map.get(key) || loadMember(chatKey, userId, name);
    const entry = {
      content: String(content ?? '').slice(0, 300),
      createdAt: Number(createdAt) || Date.now(),
      // 2026-09-19 加：这条印象是谁写的。
      //   model        = 聊天时模型自己记的（原话在会话日志里可查）
      //   consolidation= 整理（做梦）重写/合并出来的 —— 原来是不可追的那一半
      //   manual       = 在记忆页签手工编辑的
      // 老条目没有这个字段 ⇒ 消费方按 undefined 显示"未知（早于 09-19）"
      source: String(source || 'model')
    };
    // ⚠️ 只比 content：entry 现在多了 source 字段，用整个对象比较会**永远不相等**、去重直接失效
    if (!member.impressions.some((e) => e.content === entry.content)) {
      member.impressions.push(entry);
    }
    member.userId = String(userId ?? member.userId ?? '');
    member.name = String(name || member.name || '');
    member.updatedAt = Date.now();
    writeJson(memberFile(chatKey, userId, name), member);
    map.set(key, member);
    return entry;
  }

  /** 记一条对群友的印象。extra: { userId, target } */
  append(chatKey, category, content, extra = {}) {
    if (category !== 'memberImpression') return null;
    const userId = String(extra.userId ?? '').trim();
    const target = String(extra.target ?? '').trim().slice(0, 60);
    if (!userId && !target) return null;
    return this.#appendRaw(chatKey, userId, target || userId, content);
  }

  /** 所有成员的印象（扁平列表，兼容旧消费方）。 */
  query(chatKey, category = '') {
    if (category && category !== 'memberImpression') return { [category]: [] };
    const map = this.#ensureChat(chatKey);
    const memberImpression = [];
    for (const m of map.values()) {
      for (const e of m.impressions) {
        memberImpression.push({
          userId: String(m.userId || ''),
          target: String(m.name || m.userId || '某人'),
          content: e.content,
          createdAt: e.createdAt,
          source: e.source
        });
      }
    }
    memberImpression.sort((a, b) => b.createdAt - a.createdAt);
    return { memberImpression };
  }

  /** 成员级视图（记忆页签用）。 */
  members(chatKey) {
    const map = this.#ensureChat(chatKey);
    const list = [];
    for (const m of map.values()) {
      if (!m.impressions.length) continue;
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 单个成员的印象（含空成员）。 */
  getMember(chatKey, userId) {
    const map = this.#ensureChat(chatKey);
    const m = map.get(String(userId)) || loadMember(chatKey, String(userId));
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 编辑群友印象（管理端）：QQ 号由调用方提供，自动回填名字，保存备注到配置。 */
  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [] }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    // 未改动过的条目（内容与旧条目逐字相同）继承它原来的形成时间，只有真正改写的才盖 now
    const prevAt = new Map();
    for (const e of old.impressions || []) {
      const c = String(e?.content ?? '');
      if (c && !prevAt.has(c)) prevAt.set(c, Number(e?.createdAt) || now);
    }
    const entries = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => {
        const c = content.slice(0, 300);
        return { content: c, createdAt: prevAt.get(c) || now, source: 'manual' };
      });
    const member = {
      userId: uid,
      name: finalName,
      impressions: entries,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    // 备注写入配置 memberNotes
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 手动替换某成员的全部印象（管理端编辑用）。返回更新后的成员。 */
  replaceMember(chatKey, userId, name, contents) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    const map = this.#ensureChat(chatKey);
    const old = map.get(uid) || loadMember(chatKey, uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(contents) ? contents : [contents];
    const now = Date.now();
    const impressions = list
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, 20)
      .map((content) => ({ content: content.slice(0, 300), createdAt: now }));
    const member = {
      userId: uid,
      name: finalName,
      impressions,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0
    };
    // 单个成员替换也备份原文件（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.mkdirSync(backupDir, { recursive: true });
      const src = memberFile(chatKey, uid, finalName);
      if (fs.existsSync(src)) {
        const dst = path.join(backupDir, path.basename(src));
        if (fs.existsSync(dst)) fs.rmSync(dst, { force: true });
        fs.copyFileSync(src, dst);
      }
    } catch { /* 备份失败不阻塞 */ }
    writeJson(memberFile(chatKey, uid, finalName), member);
    map.set(uid, member);
    return {
      userId: member.userId,
      name: member.name,
      impressions: member.impressions.map((e) => ({ ...e })),
      updatedAt: member.updatedAt
    };
  }

  /** 删除某成员的印象文件。 */
  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    const map = this.#ensureChat(chatKey);
    const m = map.get(uid) || loadMember(chatKey, uid);
    map.delete(uid);
    try { fs.rmSync(memberFile(chatKey, uid, m.name), { force: true }); } catch { /* ignore */ }
    return true;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    const map = this.#ensureChat(chatKey);
    let removed = false;
    for (const [key, m] of [...map.entries()]) {
      if (userId) {
        if (String(m.userId) === String(userId)) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      } else if (target) {
        const matchName = String(target).trim();
        if (String(m.name || m.userId) === matchName) {
          if (content) {
            const before = m.impressions.length;
            m.impressions = m.impressions.filter((e) => e.content !== content);
            removed = removed || m.impressions.length !== before;
          } else {
            removed = true;
            m.impressions = [];
          }
          if (!m.impressions.length) {
            map.delete(key);
            try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
          } else {
            m.updatedAt = Date.now();
            writeJson(memberFile(chatKey, m.userId, m.name), m);
          }
        }
      }
    }
    return removed;
  }

  clear(chatKey) {
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    writeJson(metaFile(chatKey), { lastConsolidatedAt: Date.now() });
  }

  /**
   * 彻底删除某会话的全部记忆（管理端「记忆」页的"清空本群记忆"）。
   *
   * 比 clear() 彻底：连会话目录、旧版单文件、以及整理前的自动备份一起删。
   * 否则 data/memory/backups/<会话>/ 里还留着一份，用户以为删干净了其实没有。
   * 删完该会话就从「记忆」列表消失（listChats 是扫目录的）。
   *
   * @returns {number} 被删掉的成员数（含无 QQ 号的兜底条目）
   */
  removeChat(chatKey) {
    const map = this.#ensureChat(chatKey);
    const count = map.size;
    map.clear();
    this.cache.delete(chatKey);
    try { fs.rmSync(chatDir(chatKey), { recursive: true, force: true }); } catch { /* ignore */ }
    try {
      const legacy = legacyFile(chatKey);
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    } catch { /* ignore */ }
    try {
      fs.rmSync(path.join(MEMORY_DIR, 'backups', chatDirName(chatKey)), { recursive: true, force: true });
    } catch { /* ignore */ }
    return count;
  }

  /**
   * 生成提示词里的【对群友的印象】摘要。
   * opts.userIds 提供时只包含这些成员（相关成员注入，控制 token）。
   *
   * ── 互通的三条来源（2026-09-20 第九对话扩，**取并集**）──
   *   ① 本会话的印象（原行为，speaking 的人会加权，**不占跨会话额度**）
   *   ② 同一个人的印象来自别处（`config.memory.share` 按人 + `unifiedMembers` 跨平台/跨组）
   *   ③ **别的会话里别人的印象**（`config.memory.groups` 按组 / `memory.unified` 全互通）
   * ②③ 都要标「来自哪、属于谁」，并且都占 `CROSS_CHAT_TOTAL` 的额度、都要过门槛。
   *
   * ⚠️ ②③ 是**一个循环里轮流取**的，不能分两趟：分两趟就等于给先跑的那趟
   *    额外发一份额度，"公平取样"当场失效（本项目 2026-09-15 已经因为
   *    "按 createdAt 全局排序"吃过一次亏，见 crossChatImpressions 的注释）。
   *
   * @param {string} chatKey
   * @param {{userIds?: string[]|null, queryText?: string, now?: number, platform?: string}} opts
   *        platform = 当前会话的平台（'qq'/'wechat'），由 orchestrator 传进来；
   *        缺省时自己去问 platformOf（会读 messages 目录，有缓存）。
   */
  formatForPrompt(chatKey, { userIds = null, queryText = '', now = Date.now(), platform = '' } = {}) {
    const notes = getConfig().memberNotes || {};
    const mine = String(platform || this.platformOf(chatKey) || 'qq');
    const all = this.members(chatKey);
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    const picked = filter
      ? all.filter((m) => !m.userId || filter.has(String(m.userId)))  // 无 QQ 号的旧数据始终带上
      : all.slice(0, 15);

    // 门槛制：按相关度打分，过线才进（低于门槛宁可零条）。
    const keywords = extractKeywords(queryText);
    const speaking = new Set(userIds ? [...userIds].map(String) : []);

    // 每个 (会话, 成员) 装一桶 —— 公平取样的单位是**成员**不是会话：
    // 组里有 5 个会话时，只按会话轮转会让"每个会话的第一个成员"占尽额度。
    //
    // ⚠️ 三条来源必须**在一个桶集合里**轮流取，不能分几趟各取各的：
    //    分趟等于给每趟单独发一份额度，"公平取样"当场失效
    //    （本项目 2026-09-15 已经因为"按 createdAt 全局排序"吃过一次亏）。
    const buckets = [];
    const pushed = new Set();
    const pushBucket = (chat, m, isSpeaking, cross) => {
      const items = (m?.impressions || []).filter((e) => e?.content);
      if (!items.length) return;
      // 同一个 (会话, 成员) 可能被多条轴同时选中 ⇒ 去重，否则那一桶的权重凭空翻倍。
      const sig = chat + '\u0000' + String(m?.userId || '') + '\u0000' + (cross ? 'x' : 's');
      if (pushed.has(sig)) return;
      pushed.add(sig);
      buckets.push({ chat, m, items, isSpeaking, sameChat: chat === chatKey, cross });
    };

    // ① 本会话：按 userIds 过滤（原行为，speaking 的人会加权）
    for (const m of picked) pushBucket(chatKey, m, !!(m.userId && speaking.has(String(m.userId))), false);

    // ② **按人**那条轴（`config.memory.share`）—— 原有功能，必须继续有效。
    //    对这一轮相关的人，把他在**别处**的印象也装进来。
    //    ⚠️ 不看 `userIds`：`picked` 里没有的人，他照样可能在别处有印象。
    for (const uid of speaking) {
      if (!this.sharesInto(chatKey, uid)) continue;
      for (const other of this.listChats()) {
        if (other === chatKey) continue;
        const m = this.memberIn(other, uid);
        if (m) pushBucket(other, m, true, true);
      }
    }

    // ③ **按会话组 / 全互通**那条轴 —— 组内**所有人**的印象（`groups` / `unified`）。
    //    这是"别的会话里别人说的话也能带过来"，占额度、也要过门槛。
    for (const other of this.memberVisibleChats(chatKey, mine)) {
      for (const m of this.members(other)) pushBucket(other, m, false, true);
    }

    // ④ **跨平台/同平台的"同一个人的记忆"**（`unifiedMembers`），哪怕他一个组都没进。
    //    🔴 这里必须**先按身份表换 id**：同一个人在微信里的 id 与 QQ 里不同，
    //       直接拿 QQ 号去微信会话里 `memberIn(other, uid)` 是**找不到的** ——
    //       实测线上就是因为这个，"跨平台认人"一对都没合上（详见 `#identityMap` 注释）。
    for (const uid of speaking) {
      const plain = String(uid);
      for (const other of this.ownVisibleChats(chatKey, mine, plain)) {
        if (other === chatKey) continue;
        // 先用身份表在这个会话里找出"同一个人"的 id；没声明就退回按 id 相等（老行为）
        const otherId = this.samePersonIdIn(other, mine, plain) || plain;
        const m = this.memberIn(other, otherId);
        if (m) pushBucket(other, m, true, true);
      }
    }

    const lines = ['【对群友的印象】'];
    let crossBudget = CROSS_CHAT_TOTAL;
    let admitted = 0;
    let otherCross = false;   // 出现了"别人的"印象（③别人的会话内容）
    const seen = new Set();

    // ⚠️ 两条轴**分开轮流**，别让一条把额度吃光（第九对话实测踩到）：
    //    `groups`/`unified` 一开，别的会话里**所有人**的印象都会来抢；
    //    而"正在说话这个人在私聊里那份"只有一条 —— 单人打不过一堆人，
    //    实测它就被挤出去了（而那条恰恰是"他在别处是谁"最该带上的）。
    //    ⇒ 同一轮里两条轴各取一条。
    const ownAxis = buckets.filter((b) => !b.cross);    // 本会话
    const crossAxis = buckets.filter((b) => b.cross);   // 别的会话（按人 + 按组）

    // 每一轮，每个桶各拿一条（从各自**最新的一条往前**），拿满额度为止。
    for (let round = 0; ; round++) {
      let progressed = false;
      for (const axis of [ownAxis, crossAxis]) {
        for (const b of axis) {
          const e = b.items[b.items.length - 1 - round];
          if (!e) continue;
          progressed = true;
          const content = String(e.content ?? '').trim();
          if (!content || seen.has(content)) continue;
          // ⚠️ `keywords` / `now` 必须**显式传**：`scoreImpression` 的签名是
          //    `{ member, isSpeaking, keywords = [], now = Date.now() }`，而桶对象里
          //    **没有** keywords 这个字段 ⇒ 展开 b 之后它会被默认成 `[]`，
          //    关键词那一项恒为 0、所有印象都卡在 0.295 过不了 0.30 的门槛 ——
          //    症状是"记忆段永远为空"，**不报错**。（第九对话实测踩到。）
          const s = scoreImpression({ content, createdAt: e.createdAt }, { ...b, keywords, now });
          if (s <= IMPRESSION_THRESHOLD) continue;

          const uid = String(b.m?.userId || '');
          const name = notes[uid] || b.m?.name || '';
          if (b.sameChat) {
            // 本会话：原样，不带来源标记（最常见的情况，标了只是噪声）
            seen.add(content);
            lines.push(`- ${whoLabel(uid, name)}：${content}`);
            admitted += 1;
            continue;
          }
          // 跨会话：占额度。带「来自…」标出来源会话与归属人。
          if (crossBudget <= 0) continue;
          seen.add(content);
          const tag = sourceTag(b.chat, { mine, platform: this.platformOf(b.chat) });
          lines.push(`- ${whoLabel(uid, name)}｜来自${tag}：${content}`);
          crossBudget -= 1;
          admitted += 1;
          if (!speaking.has(uid)) otherCross = true;   // 这条属于**这个会话里没在说话的人**
        }
      }
      if (!progressed) break;   // 所有桶都取空了
    }

    // 一条都没过线 ⇒ 宁可不给（"错的不如空着"）。
    // ⚠️ 这会让"记忆"段经常为空 —— 那是**预期行为**，不是故障。
    if (!admitted) return '';

    // 引导语：把"id 是锚、名字只是线索"说清楚（用户明确要求"让她知道属于谁"）。
    // 插在标题下面，尽量短 —— 这段每轮都在提示词里，占 token。
    lines.splice(1, 0, '（名字后面的 `id` 才是认人的依据：同一个人可能换名字；id 相同就是同一个人。）');
    if (crossBudget < CROSS_CHAT_TOTAL) {
      const note = otherCross
        ? '（带「来自…」的是在**别的会话**里记下的、属于那里的人：这里的人不知道那些事，'
          + '别拿出来说、也别把两个会话的人搞混。）'
        : '（带「来自…」的是**别的场合**记下的：那件事只在那个场合说，别主动拿到这里提；'
          + '对方自己提起来再接。）';
      lines.splice(2, 0, note);
    }
    // 🆕 2026-09-21（第十对话）：把"你不在时记忆被动过"那句也插进说明区。
    //    放在这里而不是末尾，理由与上面两句相同：它是**关于这份材料的说明**，
    //    不是一条印象 —— 混在印象列表末尾会被当成"某个群友的事"。
    //    没有变化时 changedSinceLastWake 返回 ''，`lines.splice` 一条都不插 ⇒ 零开销。
    const changedNote = this.changedSinceLastWake(chatKey, now);
    if (changedNote) lines.splice(2, 0, changedNote);
    return lines.join('\n');
  }

  /**
   * 🆕 2026-09-21（第十对话）——「睡了一觉发现书被翻过」的那一声招呼。
   *
   * 起因：她自己的提案（16:45，原话）：
   *   「希望在管理端对记忆做增删改时，小鲸鱼这边能收到一点可感知的变化，而不是完全无感……
   *     目的是减少『睡了一觉发现书被翻过』的不确定感，**不是要监督或审计管理端操作**。」
   *
   * 判据只用**已有的数据**，不新造账本：
   *   · `_meta.json` 里记一个 `lastSeenAt` = 上一次真正跑完时的时间；
   *   · 每个成员文件本来就有 `updatedAt`（每次写印象都会刷新，见 #appendRaw / editMemberImpression）。
   *   ⇒ `updatedAt > lastSeenAt` 就是"她不在的这段时间里，这个人的印象被动过"。
   *
   * ⚠️ 这条判据**分不清"管理端改的"和"别的东西改的"**（整理/互通同步/她自己上一轮写记忆
   *    都会刷新 updatedAt）。⇒ 提示的措辞刻意说得**保守**："变了 N 个人的记忆"，
   *    而不是"管理员改了 N 条" —— 不编造它区分不出来的因果。
   *    （这正是她提案里那句"不是要监督或审计"的分寸：她要知道的是"书被动过"，
   *      不是"谁动的、动了几笔"。）
   *
   * @returns {string} 给提示词用的一行；没有变化时返回 ''（**不占 token**）
   */
  changedSinceLastWake(chatKey, now = Date.now()) {
    // ⚠️ 只在**有内容**时缓存（第一版把"算出来是空"也缓存了，被测试当场抓住）：
    //    缓存空结果会让"这次没有变化"永远粘住 —— 之后真的变了也不再提示。
    //    空的时候每次重算的代价只是读几个已缓存的成员对象，可以接受；
    //    而正确的、已提交的"没有变化"是由 `_meta.json` 的 lastSeenAt 表达的，
    //    不靠内存缓存。
    const hit = this._changedNote.get(chatKey);
    if (hit && hit.items.length) return hit.text;

    // ⚠️ 这里**不能**用 `loadMeta()`：那个函数只挑出 `lastConsolidatedAt`
    //    （见它的实现与调用方，返回的是一个**裁剪过**的对象），`lastSeenAt` 会被丢掉
    //    ⇒ 读回来恒为 0 ⇒ 永远算不出"有变化"。
    //    （第一版就是这么写的，被 测试-现行\test-记忆变更对bot可见.mjs 当场抓住。）
    //    直接读原始 `_meta.json` 才拿得到自己写进去的那个字段。
    const lastSeen = Number(readJson(metaFile(chatKey), null)?.lastSeenAt) || 0;
    const items = lastSeen > 0
      // lastSeen===0（第一次跑这个会话 / 老数据没这个字段）⇒ **不出提示**：
      // 那时全部成员都"比它新"，说"变了 15 个人"是假信息，不如不说。
      ? this.members(chatKey)
        .filter((m) => m.userId && Number(m.updatedAt) > lastSeen)
        .map((m) => ({ userId: m.userId, name: m.name || '', at: Number(m.updatedAt) }))
        .slice(0, 6)
      : [];

    let text = '';
    if (items.length) {
      const who = items.map((x) => x.name || x.userId).slice(0, 4).join('、');
      const more = items.length > 4 ? ` 等 ${items.length} 个人` : '';
      text = items.length <= 4
        ? `（你不在的时候，${who} 的印象被更新过。）`
        : `（你不在的时候，有 ${items.length} 个人的印象被更新过：${who}${more}。）`;
      // 只缓存有内容的这一支 —— 见上面的说明
      this._changedNote.set(chatKey, { at: now, items, text });
    } else {
      this._changedNote.delete(chatKey);
    }
    return text;
  }

  /**
   * 把「上次看到」推到"本次唤醒算出来的那个时间点"。
   *
   * ⚠️ **必须在真正跑完之后调**，不能在算提示词时顺手调 —— 否则第一次渲染就把
   *    `lastSeenAt` 推掉了，同一轮里后面的重渲染（多轮工具调用）会算出"没有变化"。
   *    调用点在 orchestrator 的一轮结束处（见那里的注释）。
   */
  commitChangedNote(chatKey) {
    const hit = this._changedNote.get(chatKey);
    if (!hit) return false;
    this._changedNote.delete(chatKey);
    // 有新内容才推时间戳；否则只清缓存（不推，免得把没读到的变化一起"标记成已读"）
    if (!hit.items.length) return false;
    const prev = loadMeta(chatKey);
    writeJson(metaFile(chatKey), { ...prev, lastSeenAt: Number(hit.at) || Date.now() });
    return true;
  }

  // ── 跨会话互通 ──────────────────────────────────────────────────────
  //
  // 背景：印象文件是按「会话 + 群友」切的（data/memory/<chatKey>/<QQ>.json），
  // 所以同一个人在私聊和各个群里本来是互不相通的几份。管理端「记忆」页可以逐个
  // QQ 号选方向（config.memory.share），让这个人在别处的印象也进当前会话的提示词。
  //
  // 只影响**读**：写入永远只写当前会话，所以每条印象都还能追溯到是哪个场合记下的。

  /**
   * ══ 按会话自由成组的互通（2026-09-20 第九对话加）══
   *
   * 与上面按 QQ 号的 `share` 是**两条独立的轴**，取**并集**：
   *   · `sharesInto`        = 按人（这个人在别处的印象）
   *   · `visibleChatsIn`    = 按会话组（这几个会话之间的记忆互通）
   *
   * 配置见 `config.memory.groups` / `unified` / `unifiedMembers`。
   * ⚠️ 全部**只放宽读**，写入照旧只写当前会话 —— 这是本文件既有的硬规矩（见上面那段注释）。
   */

  /** 当前会话所属的全部互通组名。 */
  groupsOf(chatKey) {
    const g = getConfig().memory?.groups;
    if (!g || typeof g !== 'object') return [];
    const key = String(chatKey || '');
    const out = [];
    for (const [name, list] of Object.entries(g)) {
      if (!Array.isArray(list)) continue;
      if (list.some((x) => String(x) === key)) out.push(String(name));
    }
    return out;
  }

  /** 全互通开关开没开。 */
  unifiedOn() {
    return getConfig().memory?.unified === true;
  }

  /** `unifiedMembers` 的合法值归一（非法值一律当最保守的 off，不炸）。 */
  membersScope() {
    const v = getConfig().memory?.unifiedMembers;
    return v === 'all' || v === 'samePlatform' || v === 'off' ? v : 'samePlatform';
  }

  /**
   * 当前会话的**成员**能看到哪些会话的东西（不含当前会话自己；`unified` 时返回全部会话）。
   * 这就是"按组互通"那一条轴。
   *
   * 🔴 **刻意不看 `unifiedMembers` 的平台限制**（2026-09-20 第九对话定的）：
   *    用户要的是"自由选择组合、qq 可以通微信" ⇒ **进了同一个组就该通**，
   *    再按平台偷偷过滤会让"我把 QQ 群和微信私聊编成一组"这种配置**静默失效**
   *    （用户明明配了、却什么都没发生 —— 本项目最忌讳的坏法）。
   *    `unifiedMembers` 的 `samePlatform` 只约束**"同一个人"**那条轴（见 `ownVisibleChats`）：
   *    那条轴是**猜**"两边的 id 是不是同一个人"（微信 id 是桥派生的 31 位数字，与 QQ 号会撞号），
   *    猜错了就会把不相干的人认成同一个人 —— 所以它必须保守。
   *    而这条轴是用户**显式指定**的会话，没有"猜"的成分，不该替他打折扣。
   */
  memberVisibleChats(chatKey, platform) {
    if (!chatKey) return [];
    if (this.unifiedOn()) return this.listChats().filter((k) => k !== chatKey);
    const mine = this.groupsOf(chatKey);
    if (!mine.length) return [];
    const out = [];
    for (const other of this.listChats()) {
      if (other === chatKey) continue;
      if (mine.some((name) => this.groupsOf(other).includes(name))) out.push(other);
    }
    void platform;   // 保留入参：将来若要"按平台排除某些组"再启用，现在刻意不用
    return out;
  }

  /**
   * 同一个人的印象**跨会话**能看到哪些会话（`unifiedMembers`）。
   * 与 `memberVisibleChats` 的区别只有一个：这个**只带同一个人的**印象，
   * 因此不受 `groups` 限制 —— 那是"跨人"的泄露风险，而"同一个人"不是。
   *
   * 🔴 2026-09-20 修一处**真实的安全缺口**（第九对话）：
   *    原来是 `scope === 'all'` 时返回**所有**会话，然后由调用方**按 id 字面相等**去别的会话里找。
   *    而 QQ 号与微信 id 在同一个数值空间里（见 `#identityMap` 注释）⇒
   *    **QQ 的 123 和微信派生出来的 123 会被当成同一个人**，把不相干的人的记忆带过来。
   *    ⇒ 现在：`'all'` 时先看这个人在**身份表**里有没有声明别的平台 id；
   *      有 ⇒ 只去"那些 id 所在的会话"（精确，且不会撞号）；
   *      没有 ⇒ 退回同平台（与 `'samePlatform'` 同语义），**不再跨平台按数字撞**。
   *    这条同时意味着：**跨平台认人必须先人工声明**（`memory.identity`），否则不生效 ——
   *    这是刻意的，因为在 id 会撞号的前提下，"自动猜"必然是错的。
   */
  ownVisibleChats(chatKey, platform, userId = '') {
    if (!chatKey) return [];
    const scope = this.membersScope();
    if (scope === 'off') return [];
    const mine = String(platform || this.platformOf(chatKey));
    const others = this.listChats().filter((k) => k !== chatKey);

    if (scope === 'all') {
      // 声明过别的平台 id ⇒ 只认那些 id 所在的会话；没声明 ⇒ 退回同平台（不猜）
      const declared = this.otherPlatformIdsOf(mine, userId);
      if (declared.length) {
        const want = new Set(declared.map((d) => `${d.platform}:${d.userId}`));
        const hits = others.filter((k) => want.has(`${this.platformOf(k)}:${this.samePersonIdIn(k, mine, userId)}`));
        if (hits.length) return hits;
      }
      return others.filter((k) => this.platformOf(k) === mine);
    }
    return others.filter((k) => this.platformOf(k) === mine);
  }

  /**
   * ══ 「同一个人」身份表（2026-09-20 第九对话加）══
   *
   * 为什么需要人工声明，而不是靠 id 相等自动合并：QQ 号与微信 id **在同一个数值空间里**
   * （微信 id 是桥派生的 31 位数字：`blake2s(wxid) % (2^31-1) + 1`）⇒
   *   ① 同一个真人两边 id 不同 ⇒ **永远合不上**（实测线上就是这个状态：跨平台一对都没合上）；
   *   ② 微信 id 撞上一个真 QQ 号 ⇒ 会把**两个不相干的人认成同一个**。
   * ⇒ 只有人工能可靠回答"这两个 id 是不是同一个人"。
   *
   * 🔴 键**必须带平台**：`"<platform>:<userId>"`。只用数字做键就会踩上面 ② ——
   *    把 QQ 的 123 和微信派生出来的 123 当成一个人。
   */
  #identityMap() {
    const raw = getConfig().memory?.identity;
    const out = new Map();   // "platform:userId" → personId
    if (!raw || typeof raw !== 'object') return out;
    for (const [k, v] of Object.entries(raw)) {
      const key = String(k || '').trim();
      const person = String(v ?? '').trim();
      // 只认 `平台:数字id` 形式；非法项直接忽略（宁可退回"各聊各的"，也不猜）
      if (!person || !/^(qq|wechat):[0-9A-Za-z_]+$/.test(key)) continue;
      out.set(key, person);
    }
    return out;
  }

  /** 这个 id 在这个平台上的身份键；没声明返回 ''。 */
  #identityKeyOf(platform, userId) {
    const uid = String(userId ?? '').trim();
    if (!uid) return '';
    const p = String(platform) === 'wechat' ? 'wechat' : 'qq';
    return `${p}:${uid}`;
  }

  /** 一个人在**别的平台**的 id（按身份表查；没声明则空数组）。返回值不含传入的那个。 */
  otherPlatformIdsOf(platform, userId) {
    const map = this.#identityMap();
    const self = this.#identityKeyOf(platform, userId);
    if (!self) return [];
    const person = map.get(self);
    if (!person) return [];
    const out = [];
    for (const [k, v] of map) {
      if (v !== person || k === self) continue;
      const m = /^([a-z]+):(.+)$/.exec(k);
      if (m) out.push({ platform: m[1], userId: m[2] });
    }
    return out;
  }

  /** 某个会话里，这个人的 id（优先按该会话自己的平台匹配；查不到返回 ''）。 */
  samePersonIdIn(chatKey, platform, userId) {
    const key = this.#identityKeyOf(platform, userId);
    if (!key) return '';
    const map = this.#identityMap();
    const person = map.get(key);
    const ids = this.memberIdsIn(chatKey);
    if (!person) return '';   // 没声明"同一个人" ⇒ 不猜（调用方会退回按 id 相等的老行为）
    const mine = this.platformOf(chatKey);
    // 按**该会话自己的平台**去匹配：微信会话就用 wechat 键，QQ 会话就用 qq 键。
    // ⚠️ 不能拿数字直接比 —— QQ 与微信 id 会撞号，那正是要修掉的 bug。
    for (const id of ids) {
      if (map.get(this.#identityKeyOf(mine, id)) === person) return id;
    }
    return '';
  }

  /** 管理端用：当前身份表（只回合法项）。 */
  identityMap() {
    const out = {};
    for (const [k, v] of this.#identityMap()) out[k] = v;
    return out;
  }

  /**
   * 某个会话属于哪个平台（`'qq'` / `'wechat'`）。
   *
   * ⚠️ 平台信息是 `store` 记在**消息文件**里的（`messages/<chatKey>.json` 的 `source`），
   *    而 `memory.js` **不能 import store.js**（会形成循环依赖：store → config → …
   *    而本文件只依赖 config）。所以这里直接读那个字段，并**缓存**：
   *    提示词是每轮现拼的，不缓存就会每轮把所有会话文件都读一遍。
   *    失效判据用目录 mtime —— 新会话落盘时目录 mtime 一定会变。
   */
  platformOf(chatKey) {
    const key = String(chatKey || '');
    if (!key) return 'qq';
    const map = this.#platformMap();
    return map.get(key) || 'qq';   // 老会话没有 source 字段 ⇒ 兜底 qq（与 store.chatSource 一致）
  }

  #platformMap() {
    const dir = path.join(DATA_DIR, 'messages');
    let stamp = 0;
    try { stamp = fs.statSync(dir).mtimeMs; } catch { /* 目录不存在 */ }
    if (this._platCache && this._platStamp === stamp) return this._platCache;

    const map = new Map();
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = /^(group|private)_(\w+)\.json$/.exec(f);
        if (!m) continue;
        try {
          const j = readJson(path.join(dir, f), null);
          if (j && typeof j.source === 'string' && j.source) map.set(`${m[1]}:${m[2]}`, j.source);
        } catch { /* 单个文件坏了不影响别人 */ }
      }
    } catch { /* 目录不存在 */ }
    this._platCache = map;
    this._platStamp = stamp;
    return map;
  }

  /** 这个会话自己记下的那个成员（可能是当前正在说话的人）。 */
  memberIn(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!uid) return null;
    try { return this.getMember(chatKey, uid); } catch { return null; }
  }

  /** 这个会话里所有有印象的成员 id。 */
  memberIdsIn(chatKey) {
    try { return this.members(chatKey).map((m) => String(m.userId || '')).filter(Boolean); } catch { return []; }
  }

  /** 这个 QQ 号的互通方向；'' = 不互通。 */
  shareModeOf(userId) {
    const share = getConfig().memory?.share;
    const v = share && typeof share === 'object' ? share[String(userId ?? '').trim()] : '';
    return v === 'both' || v === 'toPrivate' || v === 'toGroup' ? v : '';
  }

  /** 当前会话能不能看到这个人在别处的记忆。 */
  sharesInto(chatKey, userId) {
    const mode = this.shareModeOf(userId);
    if (!mode) return false;
    const isPrivate = String(chatKey || '').startsWith('private:');
    if (mode === 'both') return true;
    if (mode === 'toPrivate') return isPrivate;   // 只并进私聊：群里看不到别处
    return !isPrivate;                            // toGroup：只并进群聊
  }

  /**
   * 这个人在**其它会话**里的印象。
   *
   * 来源会话 = 两条轴的并集（2026-09-20 第九对话扩）：
   *   ① 按人：`sharesInto` 允许时**所有**会话（`config.memory.share`，原有行为）
   *   ② 按组：`ownVisibleChats` —— 同一个人的印象跨组/跨平台的可见范围（`unifiedMembers`）
   *
   * @returns {Array<{content, from, fromLabel, fromPlatform, memberName, memberId, sameChat, createdAt}>}
   *          没开互通 / 方向不允许 / 没有别处数据 → 空数组
   */
  crossChatImpressions(chatKey, userId, { limit = CROSS_CHAT_PER_MEMBER, platform = '' } = {}) {
    const uid = String(userId ?? '').trim();
    if (!uid) return [];

    const mine = this.platformOf(chatKey);
    const from = [];
    // ① 按人（原有那条轴，行为不变）
    if (this.sharesInto(chatKey, uid)) {
      for (const other of this.listChats()) if (other !== chatKey) from.push(other);
    }
    // ② 按组 / 跨平台同人（新那条轴）。⚠️ 去重 —— 两条轴会重叠。
    for (const other of this.ownVisibleChats(chatKey, mine)) {
      if (!from.includes(other)) from.push(other);
    }
    if (!from.length) return [];

    // 先把每个来源会话各自装一桶，**再轮流取** —— 不能按 createdAt 全局排序取最新 N 条。
    //
    // ⚠️ 为什么不能按时间排（2026-09-15 实测踩到的坑）：
    //    记忆整理（consolidation）会把**所有**印象的 createdAt 一次性刷成整理时间。
    //    于是"取最近的 N 条"就退化成了"取最近被整理的那个会话的 N 条"，
    //    其它会话一条都进不来 —— 实测三个群（00:12~00:18 整理过）把私聊那份（00:12:24）
    //    整个挤了出去，而私聊那份恰恰是"这个人在别处是谁"最该带上的一条。
    //    轮流取能保证：只要某个会话有内容，它就至少有一条进得来。
    const buckets = [];
    for (const other of from) {
      const m = this.memberIn(other, uid);
      const items = (m?.impressions || []).filter((e) => e?.content);
      if (items.length) buckets.push({ from: other, items, name: String(m?.name || '') });
    }

    // 每一轮，每个会话各拿一条（从各自**最新的一条往前**），拿满 limit 为止。
    const out = [];
    for (let round = 0; out.length < limit; round++) {
      let picked = 0;
      for (const b of buckets) {
        if (out.length >= limit) break;
        const e = b.items[b.items.length - 1 - round];
        if (!e) continue;
        out.push({
          content: String(e.content),
          from: b.from,
          fromLabel: chatLabel(b.from),
          fromPlatform: this.platformOf(b.from),
          memberName: b.name,
          memberId: uid,
          sameChat: false,
          createdAt: Number(e.createdAt) || 0
        });
        picked += 1;
      }
      if (!picked) break;   // 所有会话都取空了
    }
    return out;
  }

  /** 管理端用：当前开了互通的 QQ 号 → 方向。 */
  shareMap() {
    const share = getConfig().memory?.share;
    const out = {};
    if (!share || typeof share !== 'object') return out;
    for (const [qq, v] of Object.entries(share)) {
      if (v === 'both' || v === 'toPrivate' || v === 'toGroup') out[String(qq)] = v;
    }
    return out;
  }

  // ── 自动整理（consolidation）──

  consolidationState(chatKey) {
    const map = this.#ensureChat(chatKey);
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of map.values()) {
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt: loadMeta(chatKey).lastConsolidatedAt || lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  /**
   * 记录一次整理完成的时间。
   * 同时写会话级 _meta.json（供冷却判断）与各成员文件的 lastConsolidatedAt。
   * userIds 为空时只更新会话级时间。
   */
  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    try {
      fs.mkdirSync(chatDir(chatKey), { recursive: true });
      const prev = readJson(metaFile(chatKey), {}) || {};
      writeJson(metaFile(chatKey), { ...prev, lastConsolidatedAt: Number(at) || Date.now() });
    } catch (error) {
      console.warn('[memory] 写整理时间失败:', error?.message ?? error);
    }
    const map = this.#ensureChat(chatKey);
    for (const uid of userIds || []) {
      const key = String(uid ?? '').trim();
      if (!key) continue;
      const m = map.get(key);
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(memberFile(chatKey, m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  /**
   * 整理前把「内容 → 首次写入时间」建成索引，供 replaceConsolidated 继承原始 createdAt。
   *
   * ⚠️ 为什么需要它（2026-09-19，P3）：`replaceConsolidated` 是**删光重建**，
   * 原来一律写 `now` ⇒ 整理一跑，所有印象的 createdAt 全被刷成整理时刻，
   * 「这条印象是什么时候形成的」永久丢失。这不是理论问题：2026-09-15 已经因此出过真 bug
   * （见本文件 `sharesInto` 上方那段注释：取最近 N 条退化成"取最近整理过的会话的 N 条"）。
   * 当时的处置是**绕过**（改成按会话轮取），根因一直没治 —— 这里把它治掉。
   * 同一内容出现在多个成员名下时取**最早**的那个时间。
   */
  #createdAtIndex(chatKey) {
    const index = new Map(); // content -> 最早 createdAt
    const map = this.#ensureChat(chatKey);
    for (const m of map.values()) {
      for (const e of m.impressions || []) {
        const c = String(e?.content ?? '');
        if (!c) continue;
        const t = Number(e?.createdAt) || 0;
        if (!t) continue;
        const prev = index.get(c);
        if (prev === undefined || t < prev) index.set(c, t);
      }
    }
    return index;
  }

  /**
   * 用整理结果整体替换本会话的印象（按成员写回各自文件）。
   * next.memberImpression: [{ userId?, target?, content }]
   */
  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    // 删光重建之前先把「内容 → 首次时间」记下来（P3：整理不得抹掉印象的形成时间）
    const bornAt = this.#createdAtIndex(chatKey);
    let inherited = 0;
    const groups = new Map(); // key -> { userId, name, contents }
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, 15) : []) {
      const content = cut(item?.content, 300);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${memberFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    const map = this.#ensureChat(chatKey);
    // 整理前把整个会话文件夹备份到 data/memory/backups/<会话>/（保留最近一次）
    try {
      const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
      fs.rmSync(backupDir, { recursive: true, force: true });
      fs.mkdirSync(backupDir, { recursive: true });
      for (const m of map.values()) {
        const src = memberFile(chatKey, m.userId, m.name);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
      }
      const metaSrc = metaFile(chatKey);
      if (fs.existsSync(metaSrc)) fs.copyFileSync(metaSrc, path.join(backupDir, '_meta.json'));
    } catch { /* 备份失败不阻塞整理 */ }
    // 删除所有现有成员文件（整理结果会重建）
    for (const m of map.values()) {
      try { fs.rmSync(memberFile(chatKey, m.userId, m.name), { force: true }); } catch { /* ignore */ }
    }
    map.clear();
    for (const g of groups.values()) {
      for (const content of g.contents) {
        // 原文照抄的条目继承它原来的形成时间；整理新写出/改写过的内容才用 now
        const at = bornAt.get(content);
        if (at) inherited += 1;
        this.#appendRaw(chatKey, g.userId, g.name, content, at || now, 'consolidation');
      }
      const file = memberFile(chatKey, g.userId, g.name);
      const member = loadMember(chatKey, g.userId, g.name);
      member.lastConsolidatedAt = now;
      member.updatedAt = now;
      writeJson(file, member);
      map.set(g.userId || `_n_${memberFileName('', g.name)}`, member);
    }
    writeJson(metaFile(chatKey), { lastConsolidatedAt: now });
    const totalAfter = [...map.values()].reduce((n, m) => n + m.impressions.length, 0);
    console.log(`[memory] 整理写回：${totalAfter} 条（其中 ${inherited} 条继承原始时间，${totalAfter - inherited} 条为整理新写）`);
    return { memberImpression: groups.size ? this.query(chatKey).memberImpression : [], count: totalAfter };
  }
}
