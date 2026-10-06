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
// 🆕 2026-10-06（第四十六对话）：文件坏了就**拒绝写回**。
//
// 为什么必须单开一个标记：`load()` 解析失败时把 `cache` 置成 `[]`，而 `save()` 写的是
// `{ items: load() }` —— 也就是说，"文件坏了"之后的**第一次保存**（她再存一段）
// 会把整份相册**替换成**那一段新的。上面 26-27 行那句"⛔ 不静默清空"原来只对
// **本次读取**成立，对**后续写回**不成立 —— 这一处补的就是那个缺口。
// 口径与 `src/memory.js` 的"留档保命"一致：另存 `.corrupt-<时间戳>`、原文件不动、出声。
// ⚠️ 恢复方式：把那个坏文件修好 / 移走，然后**重启应用**（`cache` 与这个标记都是模块级的）。
let corrupt = false;

/** 把读不出来的原文件**整份另存**一份（只做一次）。⛔ 绝不动原文件本身。 */
let corruptBackedUp = false;
function backupCorruptFile(reason) {
  if (corruptBackedUp) return null;
  corruptBackedUp = true;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${FILE}.corrupt-${stamp}`;
  try {
    fs.copyFileSync(FILE, bak);
    console.warn(`[核心记忆] 原文件读不出来（${reason}）—— 已另存为 ${path.basename(bak)}，原文件不会被覆盖。`);
    return bak;
  } catch (error) {
    console.warn(`[核心记忆] 原文件读不出来（${reason}），而且另存备份也失败：${error?.message ?? error}`
      + ' —— 原文件仍然不会被覆盖。');
    return null;
  }
}

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') { cache = []; return cache; }   // 还没存过 —— 真·空
    loadError = `读不到（${error?.message ?? error}）`;
    console.warn(`[核心记忆] ${loadError}`);
    corrupt = true;                 // 读不到 ≠ 空：⛔ 不许拿"眼前这几条"覆盖掉它
    backupCorruptFile(loadError);
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
    corrupt = true;
    backupCorruptFile('文件解析失败');
    cache = [];
  }
  return cache;
}

function save() {
  if (corrupt) {
    // ⛔ 拒绝写回：写下去就是把整份相册换成内存里这几条（见上面 corrupt 那段注释）。
    console.warn('[核心记忆] 拒绝落盘：上次读这个文件时它坏了（已另存 .corrupt 备份）——'
      + ' 这一条只在内存里，把坏文件修好 / 移走并重启之后才会恢复写入。');
    return false;
  }
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
  // 🆕 2026-10-06：`save()` 现在有两种"没写成"——磁盘/权限问题，**以及**"上次读它时它坏了 ⇒ 拒绝写回"。
  //    两者的处置完全不同（后者要去修那个 .corrupt 文件），所以话必须分开说，⛔ 别一律说成磁盘问题。
  const why = wrote ? undefined
    : (loadError
      ? `相册文件读不出来（${loadError}）—— 这一段**没有写盘**，原文件一个字节都没动；先处理那个 .corrupt 文件`
      : '写盘失败（磁盘/权限问题），这一段没存下来');
  return { ok: wrote, item, dropped: dropped || 0, truncatedByChars, evicted: Math.max(0, over), error: why };
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
// ── 三个块的形状（用户 2026-10-03 逐条拍板）──────────────────────────────
//   ① 目录（每轮都在）：**按人分组**，每组列出那几段的「名字 / 条数 / 日期 / 开头一句」。
//      放在提示词的稳定区（`stickerBlock` 之后、【记忆】之前）—— 只在"她存/删"时才变，
//      ⇒ 不改动已有的前缀缓存收益。
//   ② 当前会话的**逐字原文**（只在这个会话有存档时出现）：仿 `read_core_memory` 的行格式，
//      每行的说话人带上号码（`夏亚（2229596136）`，老条目没有号码就只写名字）。
//   ③ 🆕 **别处提到这个人的原文**（2026-10-03 第三十六对话 · 交接 §3-57）：
//      别的会话里、和这一轮在场的人有关的那几段。⚠️ 它**只认带平台的身份键**
//      （`qq:…` / `wechat:…`）—— 见下面「归属与『人』的身份键」那段注释。
//      ⚠️ 它必须**自带"别主动拿到这里提"的引导语**（`ELSEWHERE_GUIDE`）：这是项目既有的
//         **不串群**纪律，用户 2026-10-03 明确要求"做跨会话召回就必须同时加它"。
//
// 预算：`config.coreMemory.injectMaxChars`（**0 = 不设限**，用户 2026-10-03 的选择）。
//   ⚠️ 设了正数时的**优先级是硬的**："目录 → 当前会话原文 → 别处按人召回"：
//      目录是索引，砍了就等于"她又忘了自己存过什么"；高优先那组装不下时**不再往下装**
//      （否则会出现"自己的会话一段没进、别处陌生会话的原文倒进来了"）。
//      装不下的逐组丢掉，并**如实写明丢了几段**（⛔ 不静默截断）。

const DIR_HEAD_MAX = 40;   // 目录里"开头一句"多长（与 listCoreMemories 的 head 保持一致）

// ── 归属与「人」的身份键 ─────────────────────────────────────────────────────
//
// 🔴 2026-10-03（第三十六对话 · 交接 §3-57）新增：**跨会话按人召回**。
//    在这之前只有"当前会话的原文"能进提示词（用户上一轮选的是"先只限同会话"）。
//    现在加了第三块：**别的会话里、和这个人有关**的那几段也进来（默认开，
//    开关是 `config.coreMemory.crossChat`）。
//
// ⚠️ **按人召回必须按「平台:id」比，⛔ 不能比裸数字**：
//    QQ 与微信的数字 id **在同一个数值空间里会撞号**（微信 id = blake2s(wxid) % (2^31-1) + 1），
//    这是本项目的一条硬纪律 —— `config.memory.identity` 的键就是 `qq:<id>` / `wechat:<id>`，
//    记忆互通、身份关联那两处也都是这么比的。只按数字比会**把两个不同的人当成一个**，
//    后果是"把 A 的私聊原文召回到 B 的会话里"，而且**看不出来**。

/** 一个会话说的是什么平台（取不到就按 qq —— 与 `MemoryStore.platformOf` 的兜底一致）。 */
function platformNameOf(chatKey, platformOf) {
  try {
    if (typeof platformOf === 'function') return String(platformOf(chatKey) || 'qq');
  } catch { /* 取不到就按 qq，与本文件其它处同一取向 */ }
  return 'qq';
}

/**
 * 一个「人」的身份键：`qq:2229596136` / `wechat:1857354535`。
 * @param {string} platform `'qq'` / `'wechat'`
 * @param {string|number} uid 那个平台上那个人的号码
 * @returns {string} 号码为空时回 `''`（调用方负责跳过 —— ⛔ 不许拼出 `qq:` 这种半截键）
 */
export function coreMemoryPersonKey(platform, uid) {
  const id = String(uid ?? '').trim();
  if (!id) return '';
  return `${platform === 'wechat' ? 'wechat' : 'qq'}:${id}`;
}

/**
 * 一段核心记忆里**涉及哪些人**（身份键的集合）。
 *
 * 两个来源，都是有意的：
 *   · 每一行消息的 `uid`（她自己发的那几行 `uid` 为空 ⇒ 不进集合，对）；
 *   · **私聊会话的对端本人**（`private:<id>`）—— 这是给**老条目**兜底的：
 *     `uid` 是 2026-10-03 才加进存档格式的，在那之前存的段一个号码都没有，
 *     而"这一段的会话就是跟他的私聊"这件事本身已经指明了那个人。
 */
export function coreMemoryPeople(item, platformOf) {
  const key = String(item?.chatKey || '');
  const plat = platformNameOf(key, platformOf);
  const out = new Set();
  const [kind, id] = key.split(':');
  if (kind === 'private' && id) out.add(coreMemoryPersonKey(plat, id));
  for (const m of (Array.isArray(item?.messages) ? item.messages : [])) {
    const k = coreMemoryPersonKey(plat, m?.uid);
    if (k) out.add(k);
  }
  return out;
}

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
  const plat = platformNameOf(key, platformOf);
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

/**
 * 一段的逐字原文（`read_core_memory` 的行格式）。
 *
 * @param {object} item 一段核心记忆
 * @param {{sourceLabel?:string}} [opts] 🆕 只在**跨会话召回**那一块用：
 *   传了 `sourceLabel` 就在标题后头缀上「· 来自 某个群（QQ 群 333333）」。
 *   🔴 为什么必须有这一句（2026-10-03 第三十六对话，**真机验证当场发现缺的**）：
 *      第一版的第三块只有「名字 + 日期」—— 她**看不出这一段是从哪个会话召回来的**。
 *      而这一块的整个要点就是"这是**别处**的事" ⇒ 不写清从哪儿来，
 *      那句"别主动拿到这里提"的引导语就**没法执行**（她不知道"这里"相对的是哪儿）。
 *   ⚠️ `read_core_memory` 工具**不传**这个参数 ⇒ 它的输出逐字不变
 *      （那是她已经习惯的格式，不该因为提示词加了标注就跟着变）。
 */
export function coreMemoryItemText(item, { sourceLabel = '' } = {}) {
  const head = `「${String(item?.name || item?.id || '（没起名字）')}」${todayKey(Number(item?.at) || 0)}`;
  const lines = [sourceLabel ? `${head} · 来自 ${sourceLabel}` : head];
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

/**
 * 🆕 别处（**不是当前这个会话**）提到这些人的那几段 —— 跨会话按人召回。
 *
 * @param {object} items 相册全部段
 * @param {{chatKey?:string, platformOf?:Function, personKeys?:string[]}} opts
 *   `personKeys` 是**带平台的身份键**（`qq:…` / `wechat:…`），由调用方按
 *   "这一轮哪几个人在场"算出来（见 `prompt.js` 那段注释）。
 * @returns {Array} 命中的段（相册顺序）
 */
export function coreMemoryForPerson(items, { chatKey = '', platformOf = null, personKeys = [] } = {}) {
  const key = String(chatKey || '');
  const want = new Set((Array.isArray(personKeys) ? personKeys : []).map((k) => String(k || '')).filter(Boolean));
  if (!want.size) return [];
  return (Array.isArray(items) ? items : []).filter((it) => {
    // 当前会话的那几段走 `related` 那一块 —— 这里排除掉，⛔ 不许同一段进两次
    // （"同一段原文在提示词里出现两遍"会让模型以为那是两件事）。
    if (String(it?.chatKey || '') === key) return false;
    for (const k of coreMemoryPeople(it, platformOf)) if (want.has(k)) return true;
    return false;
  });
}

/** 注入块的头部与尾注（尾注里的段数会变，所以长度要现算）。 */
const RELATED_HEAD = (n) => `【核心记忆 · 当前会话的原文】你自己挑的、逐字没改过（${n} 段）`;
const RELATED_TAIL = (n) => `（这一段有 ${n} 段没展开 —— 要看用 read_core_memory 带上 id）`;
// 🆕 第三块（2026-10-03 第三十六对话 · 交接 §3-57）：别处按人召回的那几段。
// ⚠️ **引导语是这块的一部分，不是可选项** —— 用户 2026-10-03 明确要求
//    "跨会话按人召回"必须同时加"别主动拿到这里提"的引导（项目既有的**不串群**纪律）。
//    没有它，她可能把 A 私聊里的事拿到 B 的群里讲 —— 那是这个功能最坏的失败方式。
const ELSEWHERE_HEAD = (n) => `【核心记忆 · 别处提到这个人的原文】别的会话里、和这个人有关的原文（${n} 段）`;
const ELSEWHERE_TAIL = (n) => `（这里还有 ${n} 段没展开 —— 要看用 read_core_memory 带上 id）`;
const ELSEWHERE_GUIDE = '⚠️ 这几段是**别的会话**里发生的事：只当背景，⛔ 别主动拿到当前这个会话里提，'
  + '也别把它们当成"他在这里说过的话"。';
/** 一段都没装下时那句如实说明（措辞里的"没展开"必须与上面两条尾注**同一个词**）。 */
const NOTHING_FITS = (what, n) => `【核心记忆 · ${what}】（${n} 段没展开 —— 这次的注入预算装不下；要看用 read_core_memory 带上 id）`;

/**
 * 组装三个注入块。**提示词与相册页共用这一个函数** ——
 * 页面显示的"本次注入约 N 字"就是这里的 `chars`，⛔ 不许页面上另算一份
 * （本项目最忌"仪表与事实分家"，而分家的表现是"看着完全正常"）。
 *
 * @param {{chatKey?:string, platformOf?:Function, personKeys?:string[], inject?:boolean,
 *          maxChars?:number, crossChat?:boolean}} opts
 * @returns {{directory:string, related:string, elsewhere:string, chars:number, budget:number,
 *            droppedByBudget:number, droppedElsewhere:number, allOriginalsChars:number,
 *            relatedCount:number, elsewhereCount:number}}
 */
export function coreMemoryPromptBlocks({
  chatKey = '', platformOf = null, personKeys = [], inject, maxChars, crossChat
} = {}) {
  const on = inject !== false;                          // 缺省 = 开（与 config 默认一致）
  const cross = on && crossChat !== false;              // 缺省 = 开（与 config 默认一致）
  const cap = Math.max(0, Math.floor(Number(maxChars) || 0));   // 0 = 不设限
  const empty = {
    directory: '', related: '', elsewhere: '', chars: 0, budget: cap,
    droppedByBudget: 0, droppedElsewhere: 0, allOriginalsChars: 0,
    relatedCount: 0, elsewhereCount: 0
  };
  if (!on) return empty;

  const items = load();
  if (!items.length) return empty;

  const directory = coreMemoryDirectory(items, { platformOf, chatKey });
  const mineTexts = coreMemoryForChat(items, chatKey).map((it) => coreMemoryItemText(it));
  // ⚠️ 第三块的每一段都要**带上"来自哪个会话"** —— 少了它，那句"别主动拿到这里提"就没法执行
  //    （见 `coreMemoryItemText` 的注释）。这一段是本轮真机验证当场发现补上的。
  const otherTexts = cross
    ? coreMemoryForPerson(items, { chatKey, platformOf, personKeys })
      .map((it) => coreMemoryItemText(it, { sourceLabel: coreMemorySourceLabel(it, platformOf) }))
    : [];

  // 🔴 这个数是给**相册页**用的上限："相册里全部原文的合计"（与会话无关）。
  //    2026-10-03（第三十六对话）**修掉一个真 bug**：上一版页面拿"不带 chatKey 调本函数
  //    得到的 `related`"当这个上限，而 `coreMemoryForChat(items, '')` 恒回空表
  //    ⇒ 那个数**永远是 0**（页面上写着"当前会话的原文最多再 0 字"）。
  //    相册当时是空的，所以谁都没看出来。现在在这里一次算准。
  //    ⚠️ 口径取**两者中更大的那种渲染**（第三块：带来源标签 + 引导语的完整形态）——
  //       它天然 ≥「当前会话原文那一块」，所以是"两块合计"的真上限（⛔ 别用无标签那种算，
  //       那会给出一个**偏小**的"上限"，等于换了种方式骗人）。
  const allTexts = items.map((it) => coreMemoryItemText(it, { sourceLabel: coreMemorySourceLabel(it, platformOf) }));
  const allOriginalsChars = allTexts.length
    ? [ELSEWHERE_HEAD(allTexts.length), ...allTexts, ELSEWHERE_GUIDE].join('\n').length
    : 0;

  if (cap === 0) {                                       // 不设限：全展开
    const related = mineTexts.length ? [RELATED_HEAD(mineTexts.length), ...mineTexts].join('\n') : '';
    const elsewhere = otherTexts.length
      ? [ELSEWHERE_HEAD(otherTexts.length), ...otherTexts, ELSEWHERE_GUIDE].join('\n')
      : '';
    return {
      directory, related, elsewhere,
      chars: directory.length + related.length + elsewhere.length,
      budget: 0, droppedByBudget: 0, droppedElsewhere: 0, allOriginalsChars,
      relatedCount: mineTexts.length, elsewhereCount: otherTexts.length
    };
  }

  // 有预算：**整份保目录**（它是索引 —— 砍成半张索引等于没有索引），
  // 然后按"当前会话的原文 → 别处按人召回的原文"的**优先级**逐段试装。
  // 装不下的逐组如实写明丢了几段（⛔ 不静默截断）。
  const groups = [
    { texts: mineTexts, kept: [], head: RELATED_HEAD, tail: RELATED_TAIL, what: '当前会话的原文' },
    { texts: otherTexts, kept: [], head: ELSEWHERE_HEAD, tail: ELSEWHERE_TAIL, what: '别处提到这个人的原文', foot: ELSEWHERE_GUIDE }
  ];
  const renderGroup = (g) => {
    const dropped = g.texts.length - g.kept.length;
    if (!g.kept.length) {
      if (!dropped) return '';
      const only = NOTHING_FITS(g.what, dropped);
      // 连这一句都装不下就干脆不说 —— ⛔ 别为了"出声"把预算顶超
      return (directory.length + only.length <= cap) ? only : '';
    }
    const tail = dropped ? g.tail(dropped) : '';
    return [g.head(g.texts.length), ...g.kept, tail, g.foot || ''].filter(Boolean).join('\n');
  };
  for (const g of groups) {
    for (const t of g.texts) {
      g.kept.push(t);
      const used = directory.length + 1 + groups.map(renderGroup).join('\n').length;
      if (used > cap) { g.kept.pop(); break; }
    }
    // 🔴 **优先级是硬的**：高优先那一组装不下任何一段时，**不再往下装**
    //    —— 否则会出现"当前会话的原文一段没进，别处陌生会话的原文倒进来了"。
    if (g.texts.length && !g.kept.length) break;
  }
  const related = renderGroup(groups[0]);
  const elsewhere = renderGroup(groups[1]);
  return {
    directory, related, elsewhere,
    chars: directory.length + related.length + elsewhere.length,
    budget: cap,
    droppedByBudget: groups[0].texts.length - groups[0].kept.length,
    droppedElsewhere: groups[1].texts.length - groups[1].kept.length,
    allOriginalsChars,
    relatedCount: groups[0].kept.length,
    elsewhereCount: groups[1].kept.length
  };
}
