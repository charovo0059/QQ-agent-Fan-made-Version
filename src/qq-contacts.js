// QQ 联系人名字表：把 QQ 号与**人看得懂的名字**对应起来（2026-09-29 第三十对话新增）。
//
// ── 为什么必须有它 ────────────────────────────────────────────────────────
// 用户报的两个缺口（`交接-给第二十九对话-20260928-1742.md` §3-7，一直没做）：
//   ① **会话列表里 QQ 私聊没有名字** —— 只显示「私聊 2229596136」，用户认不出是谁；
//   ② **记忆/人物视图对 QQ 只认 `config.memberNotes`** —— 而线上 `memberNotes` 是**空的**
//      （实测 `{}`）⇒ 白名单里没印象的人、以及"同一个人"候选清单全都只剩一串数字。
//
// 微信侧早有同款问题的解法（`wechat-contacts.js`）：桥把 id ↔ 昵称学下来，界面就认得出人。
// QQ 侧一直没有对应物 —— 但 OneBot 本来就有一个**权威**来源：`get_friend_list`。
//
// ── 为什么用 get_friend_list 而不是 get_stranger_info（真机实测，2026-09-29）────
//   · `get_friend_list`：**一次问到全部**（实测 14 条），每条带 `nickname` 与 `remark`，
//     而且**remark 就是用户自己在 QQ 里给这个人起的备注**（比昵称更贴近"他认得谁"）。
//   · `get_stranger_info`：一次只能问一个；且它对**微信侧的 id** 也会"成功"返回空昵称
//     （实测 `688171026` → `nickname=""`）⇒ 拿它当判据会**把微信的人误当成 QQ 的人**。
//   · 更关键的一条：`get_friend_list` 让"这个 id 是不是 QQ 好友"变成一个**能查的事实**。
//     实测对账（14 条好友 × 10 个私聊会话）：3 个微信 id **一个都不在**好友列表里，
//     而 4 个 `source` 字段缺失（= 未定）的私聊**全都在**好友列表里 ⇒ 平台归属不再靠猜。
//
// ── 设计取舍 ─────────────────────────────────────────────────────────────
// · **纯显示层**：白名单判定、发送目标、记忆文件全部按数字 id ⇒ 这张表整个坏掉也不会
//   放错人、不会发错人（只是界面显示旧名/退化成数字）。与 `wechat-contacts.js` 同一口径。
// · **只放内存，不落盘**。为什么与微信那张表不同：微信的 id 是桥**派生**的，除了桥没人知道
//   id ↔ 微信昵称的对应关系，所以桥学到的必须存下来；而 QQ 名字的权威来源（OneBot）
//   **每次开机都在**，重新问一遍即可 ⇒ 落盘只会多一份可能与真相漂移的副本。
//   ⚠️ 代价（如实记）：**OneBot 没连上时这张表是空的**，那时界面退回"存档里见过的名字"
//   （`store.chatDisplayName`）与数字 id —— 不是空白，也不会显示错人。
// · 与 `memberNotes`（用户在界面里手填的备注）的关系：**手填的赢**。
//   那张表是用户明确表达的意图，这里只是"他没填时，帮他认人"。
// · ⛔ **不写回 `config.memberNotes`**。写进去会跟着进提示词（`prompt.js` / `memory.js` 都读它），
//   等于让一个"显示用"的缓存**悄悄改变她看到的世界** —— 那种改动没有任何界面能看出来。
// · 本模块**零依赖**（不 import 任何东西）：它只认"给我一个能 getFriendList() 的客户端"，
//   于是判据可以把 OneBot 换成一个假的，不必起网络（见 `测试-现行\test-QQ私聊名字.mjs`）。

/** id → { name, nickname, remark }。只放**有名字**的条目。 */
let table = new Map();

/** 记录最近一次同步的结果（排障用：`/api/status` 之类可以读它）。 */
let lastSync = { at: 0, ok: false, count: 0, error: '' };

/**
 * 取"显示用名字"：QQ 侧的备注优先，其次 QQ 昵称。
 *
 * 为什么备注优先：QQ 客户端自己也是这么显示的（用户给谁起过备注，看到的就是备注）。
 * 与 `wechat-contacts.js` 的 `name` 语义一致 —— 它每次入站都覆盖成最新见到的名字。
 */
function pickName(entry) {
  return String(entry?.remark || entry?.nickname || '').trim();
}

/**
 * 用一次 `get_friend_list` 的结果整体替换名字表。
 *
 * ⚠️ **整体替换，不是合并**：好友列表是"当前全量"，删掉好友之后名字就该消失。
 *   这与 `wechat-contacts.js` 的"只增不删"**故意相反** —— 那张表的名字是桥一点点学来的，
 *   而这张表的来源是**一次完整查询**，旧值留着只会显示一个已经不存在的人。
 *
 * @param {Array<{user_id?:number|string, nickname?:string, remark?:string}>} rows
 * @returns {{count:number, named:number, skipped:number, raw:number}}
 */
export function replaceFriendNames(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const next = new Map();
  let skipped = 0;
  for (const row of list) {
    const id = String(row?.user_id ?? row?.uin ?? '').trim();
    const name = pickName(row);
    if (!id) { skipped += 1; continue; }
    if (!name) { skipped += 1; continue; }   // 没名字的条目不入表（有 id 也认不出人）
    next.set(id, {
      name,
      nickname: String(row?.nickname || '').trim(),
      remark: String(row?.remark || '').trim()
    });
  }
  table = next;
  return { count: next.size, named: next.size, skipped, raw: list.length };
}

// 🆕 2026-10-06（第四十六对话 · wheel-gate 复查）：`withDeadline` 原来定义在本文件里，
// 同款实现当时还有一份在 `app.js`、这一轮又在 `tools.js` 出现了第三份 ⇒ 已抽到 `util.js`
// 做**唯一一份**（连同那条"为什么不能用最简写法"的实测注释一起搬过去了 —— 那条注释就是
// 这个坑的全部知识，散在多处迟早只剩一份是对的）。
import { withDeadline } from './util.js';

/**
 * 现问 OneBot 拉一次好友列表，替换名字表。
 *
 * @param {object} client  OneBot 客户端（只用到 `connected` 与 `getFriendList()`）
 * @param {{timeoutMs?:number, reason?:string}} opts
 * @returns {Promise<{ok:boolean, error?:string, count?:number, raw?:number, skipped?:number, reason?:string}>}
 */
export async function syncQqFriendNames(client, { timeoutMs = 8000, reason = '' } = {}) {
  const done = (r) => {
    lastSync = {
      at: Date.now(),
      ok: !!r.ok,
      count: Number(r.count) || 0,
      error: r.ok ? '' : String(r.error || ''),
      reason: String(reason || '')
    };
    return { ...r, reason };
  };
  if (!client || !client.connected) {
    return done({ ok: false, error: 'OneBot 没连上 —— 这时没有名字可同步（界面退回存档里见过的名字）' });
  }
  if (typeof client.getFriendList !== 'function') {
    // 走到这里说明调用方传错了东西（不是"网络失败"，别混成同一类）
    return done({ ok: false, error: '这个客户端没有 getFriendList()（构造方式不对？）' });
  }
  let rows;
  try {
    rows = await withDeadline(client.getFriendList(), timeoutMs, `get_friend_list 超时（${timeoutMs}ms）`);
  } catch (e) {
    return done({ ok: false, error: `问 OneBot 失败：${String(e?.message ?? e)}` });
  }
  const list = Array.isArray(rows) ? rows : (Array.isArray(rows?.data) ? rows.data : []);
  if (!list.length) {
    // ⚠️ 0 条**不覆盖**已有表：与 `syncWechatContactsFromBridge` 同口径 ——
    //    "问到了但一条都没有"更可能是机器人没登录/查询半残，而不是"好友全删了"。
    //    这时保留旧表，界面至少还认得出人（宁可显示旧名，也别一次把所有人的名字抹掉）。
    return done({ ok: false, error: 'OneBot 回了 0 条好友 —— 保留旧名字（更可能是机器人没登录）' });
  }
  const st = replaceFriendNames(list);
  return done({ ok: true, ...st });
}

/**
 * 按 QQ 号取名字。**只查这张表**，拿不到就返回空串。
 *
 * ⛔ 这里**刻意不回落** `memberNotes`：这一层的契约是"OneBot 说的名字是什么"。
 *    名字的优先级（手填备注 > 这张表 > 存档里见过的 > 数字 id）由调用方
 *    （`app.js` 的路由）统一决定 —— 两处各定一套优先级，必然漂移。
 */
export function qqNameOf(userId) {
  const id = String(userId ?? '').trim();
  if (!id) return '';
  return table.get(id)?.name || '';
}

/** 按 QQ 号取一条完整记录（排障/界面要显示"这是 QQ 昵称还是备注"时用）。 */
export function qqContactOf(userId) {
  const id = String(userId ?? '').trim();
  return id ? (table.get(id) || null) : null;
}

/** 当前名字表的一个**快照副本**（id → name）。调用方随便改，不影响内部表。 */
export function qqNames() {
  const out = {};
  for (const [id, v] of table) out[id] = v.name;
  return out;
}

/** 名字表里现在有几条（判据/排障用）。 */
export function qqNameCount() {
  return table.size;
}

/** 最近一次同步的结果（排障用；只读副本）。 */
export function qqSyncStatus() {
  return { ...lastSync };
}

/** 清空（测试用；生产路径不会调它）。 */
export function clearQqNames() {
  table = new Map();
  lastSync = { at: 0, ok: false, count: 0, error: '' };
}
