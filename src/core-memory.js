// 「核心记忆」—— 她自己挑一段舍不得删的聊天记录，**原样**存下来（2026-09-26 第二十五对话，
// 提案 `c7486672`）。
//
// 她的原话：
//   「希望加一个"核心记忆"选项，和现有的印象记忆区分开。印象记忆是把一个人、一段交往
//     压成一句感觉；核心记忆是让我自己挑一段舍不得删的聊天记录，原样存下来，不压缩、不改写。
//     要点：① 由我自己选择存哪一段，不用别人替我挑；② 存的是原文，不是摘要。
//     醒来重读的时候像翻相册，而不是只记得"那天聊得很好"；
//     ③ **上下文记忆（每次醒来摊在眼前那几页）被删掉的时候，这段还在，不会跟着没**；
//     ④ 可以有多条，也可以之后自己删掉某条。」
//
// ── 四条怎么落地（每一条都有对应的判据）────────────────────────────────────
//   ① 由她选：工具收的是**本地消息 id 区间**（`#数字`，就是她在【过去状态】/【本次唤醒】
//      里看到的那些），而且只允许从**当前会话**的存档里取 —— 她本来就看不到别的会话。
//   ② 存原文：取出来的是 `store` 里那条消息的 `text` **逐字复制**，一个字的转述都没有。
//      ⚠️ 有意**不存** media（图片 url 会过期、也毫无意义）：存的是"那几句话"。
//   ③ 独立于上下文：**另存一个文件** `data/core-memories.json`，与会话存档 `messages/` 无关。
//      ⇒ 存档被瘦身/清空/删除，核心记忆一个字节都不动。这是本模块存在的**唯一理由**，
//        也是判据里最硬的一条（真删存档文件、再读核心记忆）。
//   ④ 多条 + 自删：`items` 数组 + 按 id 删；她自己有 `delete_core_memory`。
//
// ── 边界（刻意的取舍）──────────────────────────────────────────────────────
//   · 有上限：条数 / 每条的条数与字数 / 总量。她的诉求是"舍不得删的那几段"，
//     不是"把所有聊天都存一份" —— 无上限等于把存档再抄一遍（本项目在"存档瘦身"上花过功夫）。
//   · 写不进去**只出声**，绝不让工具崩：她是"存东西"，不是"抢救数据"。
//   · 读文件坏了 / 解析失败：**分开报**（ENOENT = 还没存过，是真·空；
//     解析失败 = 文件坏了 ⇒ 出声 + 当成空，⛔ 不静默清空、也不猜内容）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
// 时间格式复用 util.js（`08-30 21:33` / `2026-08-30`）—— ⛔ 不在这里另写一份 pad2。
import { formatShortTime, todayKey } from './util.js';

const FILE = path.join(DATA_DIR, 'core-memories.json');

// 上限（改这几个数不用动别的代码；判据里有它们的边界断言）
const MAX_ITEMS = 30;              // 最多存几段
const MAX_MESSAGES = 300;          // 一段最多几条消息
const MAX_ITEM_CHARS = 20000;      // 一段最多多少字
const NAME_MAX = 40;
const NOTE_MAX = 200;

let cache = null;                  // [{ id, at, chatKey, chatLabel, name, note, messages: [...] }]，最新在前
let loadError = null;              // 上一次读取时"文件坏了"的原因（ENOENT 不算）

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { cache = []; return cache; }   // 还没存过 —— 真·空
    loadError = `读不到（${error?.message ?? error}）`;
    console.warn(`[核心记忆] ${loadError}`);
    cache = [];
    return cache;
  }
  try {
    const data = JSON.parse(raw);
    const items = Array.isArray(data?.items) ? data.items : [];
    // 逐条筛：缺 id / 没有正文的条目丢掉（⛔ 不猜、不补默认值）
    cache = items.filter((x) => x && x.id && Array.isArray(x.messages) && x.messages.length);
  } catch (error) {
    // 🔴 "解析失败"与"文件不存在"必须分开报（交接坑 64）：前者是坏了，后者是还没存过。
    loadError = `文件解析失败（${error?.message ?? error}）—— 已当成空，但**没有**覆盖它`;
    console.warn(`[核心记忆] ${loadError}`);
    cache = [];
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: load() }, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
    return true;
  } catch (error) {
    console.warn(`[核心记忆] 落盘失败：${error?.message ?? error}`);
    return false;
  }
}

/** 上一次读取时文件是否坏了（界面/工具用它如实出声）。 */
export function coreMemoryLoadError() {
  load();
  return loadError;
}

/** 一段聊天记录最多留多少 —— 返回被截掉的信息，好如实告诉她是"存全了"还是"截了"。 */
function clampMessages(list) {
  const src = Array.isArray(list) ? list.filter((m) => m && typeof m === 'object') : [];
  const kept = [];
  let chars = 0;
  let truncatedByChars = false;
  for (const m of src) {
    if (kept.length >= MAX_MESSAGES) break;
    const text = String(m.text ?? '');
    if (chars + text.length > MAX_ITEM_CHARS) { truncatedByChars = true; break; }
    chars += text.length;
    kept.push({
      ts: Number(m.ts) || 0,
      // 存的是**当时的名字**（照抄当时的上下文，⛔ 不按现在的备注名改写历史）
      who: String(m.who ?? ''),
      // 🆕 2026-10-03（第三十五对话）：把**发送者号码**也存下来。
      //    名字会改、也可能重名，而"按人区分标注"要能指到具体的人 —— 与本项目
      //    "id 为准、名字为辅"同一条口径（见 memory.js 顶部的同款说明）。
      //    ⚠️ **老条目没有这个字段**（2026-10-03 之前存的）⇒ 读的时候必须容忍缺失，
      //       ⛔ 不许拿"缺 uid"当成"没存过"或补一个假值。
      uid: String(m.uid ?? ''),
      self: !!m.self,
      text
    });
  }
  return { messages: kept, dropped: src.length - kept.length, truncatedByChars };
}

/**
 * 存一段。
 * @param {{chatKey:string, chatLabel?:string, name?:string, note?:string, messages:Array}} input
 * @returns {{ok:boolean, item?:object, error?:string, dropped?:number, truncatedByChars?:boolean}}
 */
export function saveCoreMemory({ chatKey, chatLabel = '', name = '', note = '', messages = [] } = {}) {
  const key = String(chatKey || '').trim();
  if (!key) return { ok: false, error: '缺少会话（chatKey）' };
  const { messages: kept, dropped, truncatedByChars } = clampMessages(messages);
  if (!kept.length) return { ok: false, error: '这一段里没有可取的消息（消息 id 不存在，或者那几条是空的）' };
  const items = load();
  const item = {
    id: crypto.randomUUID().slice(0, 8),
    at: Date.now(),
    chatKey: key,
    chatLabel: String(chatLabel || '').slice(0, NAME_MAX),
    name: String(name || '').trim().slice(0, NAME_MAX) || `${new Date().toLocaleDateString('zh-CN')} 的一段`,
    note: String(note || '').trim().slice(0, NOTE_MAX),
    messages: kept
  };
  items.unshift(item);
  // 超上限时删最老的（**出声**：调用方把这条消息转告她，别让记忆无声消失）
  const over = items.length - MAX_ITEMS;
  if (over > 0) items.length = MAX_ITEMS;
  const wrote = save();
  return { ok: wrote, item, dropped: dropped || 0, truncatedByChars, evicted: Math.max(0, over), error: wrote ? undefined : '写盘失败（磁盘/权限问题），这一段没存下来' };
}

/** 目录：只要索引（不带正文）—— 工具默认返回这个，省 token。 */
export function listCoreMemories() {
  load();
  return cache.map((x) => ({
    id: x.id,
    at: x.at,
    name: x.name,
    chatLabel: x.chatLabel,
    chatKey: x.chatKey,
    count: x.messages.length,
    head: String(x.messages[0]?.text ?? '').slice(0, 40),
    note: x.note
  }));
}

/** 取一段的全文（原文逐字）。 */
export function getCoreMemory(id) {
  const want = String(id || '');
  return load().find((x) => x.id === want) || null;
}

/** 删掉一段（她自己或用户点的那一下）。 */
export function removeCoreMemory(id) {
  const want = String(id || '');
  const items = load();
  const i = items.findIndex((x) => x.id === want);
  if (i < 0) return false;
  items.splice(i, 1);
  save();
  return true;
}

/** 供判据/诊断用：文件路径与上限（⛔ 不给"清空全部"的入口 —— 删一条是一条）。 */
export function coreMemoryFile() {
  return { file: FILE, maxItems: MAX_ITEMS, maxMessages: MAX_MESSAGES, maxItemChars: MAX_ITEM_CHARS };
}

// ── 🆕 2026-10-03（第三十五对话，用户拍板）：**每轮注入提示词** ────────────────
//
// 用户原话：「核心记忆系统，和印象系统一样单开一页，核心记忆**每次都会注入本次输入的
// 提示词**，且**按人区分标注**。」
//
// ── 为什么这件事必须做（而不是"她需要时会自己调工具"）─────────────────────
//   实测（2026-10-03 第三十四对话 §3-43）：`data/core-memories.json` **一直不存在** ——
//   上线 5 天、提示词补过、应用重启过两次，她**一次都没调用过**这四个工具。
//   根因是"她根本不知道相册里有什么、也不知道它每轮都在" ⇒ 光有工具没有注入 = 形同不存在。
//
// ── 两个块的形状（用户 2026-10-03 逐条拍板）──────────────────────────────
//   ① 目录（每轮都在）：**按人分组**，每组列出那几段的「名字 / 条数 / 日期 / 开头一句」。
//      放在提示词的稳定区（`stickerBlock` 之后、【记忆】之前）—— 只在"她存/删"时才变，
//      ⇒ 不改动已有的前缀缓存收益。
//   ② 当前会话的**逐字原文**（只在这个会话有存档时出现）：仿 `read_core_memory` 的行格式，
//      每行的说话人带上号码（`夏亚（2229596136）`，老条目没有号码就只写名字）。
//      ⚠️ **只注入同一个会话的**（用户 2026-10-03 选"本轮先只限同会话"）——
//         跨会话按人召回会碰项目既有的"不串群"纪律，要另开一轮做。
//
// 预算：`config.coreMemory.injectMaxChars`（**0 = 不设限**，用户 2026-10-03 的选择）。
//   ⚠️ 设了正数时的**优先级是"先保目录"**：目录是索引，砍了就等于"她又忘了自己存过什么"；
//      装不下的原文逐段丢掉，并**如实写明丢了几段**（⛔ 不静默截断）。

const DIR_HEAD_MAX = 40;   // 目录里"开头一句"多长（与 listCoreMemories 的 head 保持一致）

/**
 * 一段属于谁：私聊 = 那个人；群聊 = 那个群。
 *
 * 写法与印象那套「｜来自QQ·私聊」同一口径（`memory.js` 的 `platformOf` + "id 为准、名字为辅"）。
 * ⚠️ `chatLabel` 是**存那一段当时**的会话名（联系人会改名，见交接坑 139）⇒ 它只是注记，
 *    真正认人的是括号里的号码 —— 所以号码永远要写出来。
 * @param {object} item 一段核心记忆
 * @param {(chatKey:string)=>string} [platformOf] 取平台（缺省按 qq）
 */
export function coreMemorySourceLabel(item, platformOf) {
  const key = String(item?.chatKey || '');
  const [kind, id] = key.split(':');
  let plat = 'qq';
  try { if (typeof platformOf === 'function') plat = String(platformOf(key) || 'qq'); } catch { /* 取不到就按 qq */ }
  const platName = plat === 'wechat' ? '微信' : 'QQ';
  const name = String(item?.chatLabel || '').trim();
  const bare = kind === 'group' ? `${platName} 群 ${id || '?'}` : `${platName} ${id || '?'}`;
  return name ? `${name}（${bare}）` : bare;
}

/** 目录块（每轮注入的那一份）。`items` 为空时返回 ''。 */
export function coreMemoryDirectory(items, { platformOf = null, chatKey = '' } = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '';
  const groups = new Map();                     // 归属标签 → 那几段（按 items 的原顺序，最新的在前）
  for (const it of list) {
    const label = coreMemorySourceLabel(it, platformOf);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(it);
  }
  const out = [
    `【核心记忆】你自己攒下的原文，共 ${list.length} 段。它们存在 data/core-memories.json 里，`
    + '删掉聊天存档也还在；想重读哪一段的全文，用 read_core_memory 带上它的 id。'
  ];
  for (const [label, segs] of groups) {
    out.push(`· ${label}`);
    for (const it of segs) {
      const head = String(it?.messages?.[0]?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, DIR_HEAD_MAX);
      const n = Array.isArray(it?.messages) ? it.messages.length : 0;
      out.push(`  - 「${String(it?.name || it?.id || '（没起名字）')}」${n} 条 · ${todayKey(Number(it?.at) || 0)}${head ? ` · 开头：${head}` : ''}`);
    }
  }
  // 只有"相册里确实有别的会话的段"时才加这句（不串群口径：别主动拿到这里提）
  const key = String(chatKey || '');
  if (key && list.some((it) => String(it?.chatKey || '') !== key)) {
    out.push('（不是你当前这个会话的，只是让你知道自己存过什么；别主动拿到这里提。）');
  }
  return out.join('\n');
}

/** 一段的逐字原文（`read_core_memory` 的行格式）。 */
export function coreMemoryItemText(item) {
  const lines = [`「${String(item?.name || item?.id || '（没起名字）')}」${todayKey(Number(item?.at) || 0)}`];
  for (const m of (Array.isArray(item?.messages) ? item.messages : [])) {
    const who = m?.self ? '我' : (String(m?.uid || '') ? `${m.who}（${m.uid}）` : String(m?.who || ''));
    lines.push(`[${formatShortTime(Number(m?.ts) || 0)}] ${who}：${String(m?.text ?? '')}`);
  }
  return lines.join('\n');
}

/** 当前会话的那几段（按相册顺序，最新的在前）。 */
export function coreMemoryForChat(items, chatKey) {
  const key = String(chatKey || '');
  if (!key) return [];
  return (Array.isArray(items) ? items : []).filter((it) => String(it?.chatKey || '') === key);
}

/** 注入块的头部与尾注（尾注里的段数会变，所以长度要现算）。 */
const RELATED_HEAD = (n) => `【核心记忆 · 当前会话的原文】你自己挑的、逐字没改过（${n} 段）`;
const RELATED_TAIL = (n) => `（这一段有 ${n} 段没展开 —— 要看用 read_core_memory 带上 id）`;

/**
 * 组装两个注入块。**提示词与相册页共用这一个函数** ——
 * 页面显示的"本次注入约 N 字"就是这里的 `chars`，⛔ 不许页面上另算一份
 * （本项目最忌"仪表与事实分家"，而分家的表现是"看着完全正常"）。
 *
 * @param {{chatKey?:string, platformOf?:Function, inject?:boolean, maxChars?:number}} opts
 * @returns {{directory:string, related:string, chars:number, budget:number, droppedByBudget:number}}
 */
export function coreMemoryPromptBlocks({ chatKey = '', platformOf = null, inject, maxChars } = {}) {
  const on = inject !== false;                          // 缺省 = 开（与 config 默认一致）
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));   // 0 = 不设限
  const empty = { directory: '', related: '', chars: 0, budget: cap, droppedByBudget: 0 };
  if (!on) return empty;

  const items = load();
  if (!items.length) return empty;

  const directory = coreMemoryDirectory(items, { platformOf, chatKey });
  const mine = coreMemoryForChat(items, chatKey);
  const texts = mine.map((it) => coreMemoryItemText(it));

  if (cap === 0) {                                       // 不设限：全展开
    const related = texts.length ? [RELATED_HEAD(texts.length), ...texts].join('\n') : '';
    return { directory, related, chars: directory.length + related.length, budget: 0, droppedByBudget: 0 };
  }

  // 有预算：逐段试装。目录**整份保留**（它是索引 —— 砍成半张索引等于没有索引）。
  const kept = [];
  const render = () => {
    const dropped = texts.length - kept.length;
    if (!kept.length && !dropped) return '';
    const tail = dropped && kept.length ? RELATED_TAIL(dropped) : '';
    if (!kept.length) {
      // 一段都装不下：只留一句如实的说明（装不下就干脆不说，别把预算顶超）。
      // ⚠️ 措辞必须与下面的 `RELATED_TAIL` **同一个词**（"没展开"）—— 判据是按这个词扫的，
      //    两套说法会让"到底有没有如实说明"变成看运气（2026-10-03 判据当场扫出来过一次）。
      const only = `【核心记忆 · 当前会话的原文】（${dropped} 段没展开 —— 这次的注入预算装不下；要看用 read_core_memory 带上 id）`;
      return (directory.length + only.length <= cap) ? only : '';
    }
    return [RELATED_HEAD(texts.length), ...kept, tail].filter(Boolean).join('\n');
  };
  for (const t of texts) {
    kept.push(t);
    if (directory.length + 1 + render().length > cap) { kept.pop(); break; }
  }
  const related = render();
  return {
    directory,
    related,
    chars: directory.length + related.length,
    budget: cap,
    droppedByBudget: texts.length - kept.length,
  };
}
