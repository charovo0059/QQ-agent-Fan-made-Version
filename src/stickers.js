// 表情包体系（移植自原版 sticker-lib.js）：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');

export function nowIso() {
  return new Date().toISOString();
}

/**
 * 从 QQ 图床地址里挖出这张图的**内容哈希**（20 字节，hex）。
 *
 * QQ 的图片 url 形如
 *   https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=EhQ...&spec=0&rkey=...
 * `fileid` 是 base64 的 protobuf，里面 `12 14 <20 字节>` 就是这张图内容的哈希。
 * `rkey` 每条消息都不一样，但**同一个文件的内容哈希永远相同** —— 所以它是判"是不是同一张图"最可靠的依据：
 *   - 同一张图在不同消息里转发 → rkey/url 不同，内容哈希相同 → 判定为重复 ✅
 *   - 两张画面很像但不同的图 → 哈希不同 → 不会误判 ✅
 *
 * 真实数据实测（2026-09-12）：用户把同一批表情包转发了两次，
 * 两次的 url 完全不同，但 28 张图的内容哈希两两相同 —— 抽出哈希才发现存了两遍。
 * 抽 3 对下载真实字节做 sha256 复核，确认字节级完全相同。
 *
 * @returns {string} 20 字节 hex；不是 QQ 图床地址 / 解析不出来 → ''
 */
export function contentHashOfUrl(url) {
  let fileid = '';
  try { fileid = new URL(String(url ?? '')).searchParams.get('fileid') || ''; } catch { return ''; }
  if (!fileid) return '';
  let buf;
  try { buf = Buffer.from(fileid.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); } catch { return ''; }
  for (let i = 0; i + 22 <= buf.length; i++) {
    if (buf[i] === 0x12 && buf[i + 1] === 0x14) return buf.subarray(i + 2, i + 22).toString('hex');
  }
  return '';
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    // QQ 那边的图片文件名（如 ACB39C99….gif）。**不过期**，用来在 url 的 rkey 失效后
    // 通过 OneBot get_image 换一条新链接（见 onebot.js 的 resolveFreshImageUrl）。
    file: String(entry.file || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch (e) {
    // ⚠️ 首次运行：文件还不存在（ENOENT）⇒ 空库是对的，静默即可。
    if (e?.code === 'ENOENT') return [];
    // 🔴 2026-09-22（第十一对话 · 隐患排查）：**文件在、但读不出来**时**绝不能静默返回空**。
    //
    // 为什么这是数据丢失级：调用链是
    //     `new StickerManager()` → `this.entries = loadStickerStore()`（本函数）
    //   → `sync()`（`list()` 的正常路径）→ `saveStickerStore(this.entries)`
    // 一旦这里返回 `[]`，下一次同步就会把**空库（或只剩刚拉到的那几条）rename 回原路径**
    // ⇒ 本地攒下来的表情包**无声消失**。
    //
    // ⚠️ 作者其实已经防住了**另一头** —— `sticker-manager.js:40` 写着
    //   "只有拿到合法数组才合并，避免异常响应清空本地库"；
    //   但**读入这一头没有防**，于是"响应异常"防住了、"文件损坏/读不出来"没防。
    //
    // ⇒ 做法：把原文件**另存为 `.corrupt-<时间戳>`（保命）**，并**大声报**；
    //   返回值仍按空库（不改契约，调用方一行都不用动），但**原数据还在盘上，可人工恢复**。
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bak = `${file}.corrupt-${stamp}`;
    try { fs.copyFileSync(file, bak); } catch { /* 连备份都失败也得继续报出来 */ }
    console.error(`[stickers] ${file} 存在但读不出来（${e?.message || e}）—— 已另存为 ${path.basename(bak)}；`
      + `本次按空库启动。⚠️ 原库没有被覆盖，可人工恢复。`);
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/**
 * 解析一个"表情引用"到底指哪一条 —— `send_sticker` 的入口（2026-10-06 第四十七对话）。
 *
 * 为什么要它（真机存档量出来的，⛔ 不是推测）：
 *   `findSticker` 只认 id / resId / md5 / url，而**提示词里从来不给她 id** ——
 *   【可用表情包】那一块只列 `localNote || desc`（见 `buildStickerContext`），
 *   线上的 `stickerRules` 还明说"按角色设定、语境和 desc／localNote／tags 选"
 *   ⇒ 她记住、能引用的本来就是**名字**。实测（1539 份会话存档）：
 *     传 id 28 次 / 失败 0；传备注名 23 次 / 失败 23；传裸数字 7 次 / 失败 7。
 *   ⇒ 失败与"图片好不好"无关，纯粹是**引用形态**对不上。
 *
 * ⛔ 不重写匹配逻辑：id/md5/url 那半仍走 `findSticker`（老口径一个字不动），
 *    近似项提示复用 `formatStickerList` 的搜索口径。这里只补"名字"这一层。
 *
 * @returns {{entry: object|null, how: string, candidates: Array<{id:string,name:string}>}}
 *   how = 'id' | 'md5' | 'url' | 'name' | 'prefix' | 'ambiguous' | 'none'
 *   candidates = 给报错用的"最像的几条"（最多 3 条，只有 id 与名字，⛔ 不吐 url）
 */
export function lookupSticker(entries, ref) {
  const list = Array.isArray(entries) ? entries : [];
  const raw = String(ref ?? '').trim();
  if (!raw) return { entry: null, how: 'none', candidates: [] };
  // ① 原来那条路：id / resId / md5 / url
  const hit = findSticker(list, raw);
  if (hit) {
    const how = hit.id === raw || hit.resId === raw ? 'id'
      : (hit.md5 && hit.md5 === raw.toUpperCase()) ? 'md5' : 'url';
    return { entry: hit, how, candidates: [] };
  }
  // ② 名字：desc（QQ 收藏里那条备注）/ localNote（这一侧能改的笔记）/ tags
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const want = norm(raw);
  const exact = list.filter((e) => norm(e.desc) === want || norm(e.localNote) === want
    || (Array.isArray(e.tags) && e.tags.some((t) => norm(t) === want)));
  if (exact.length === 1) return { entry: exact[0], how: 'name', candidates: [] };
  if (exact.length > 1) return { entry: null, how: 'ambiguous', candidates: briefStickers(exact) };
  // ③ 唯一前缀 —— 只对 desc / localNote 开（tags 通常很短，前缀撞车概率大）
  const pref = list.filter((e) => {
    const d = norm(e.desc); const n = norm(e.localNote);
    return (d && d.startsWith(want)) || (n && n.startsWith(want));
  });
  if (pref.length === 1) return { entry: pref[0], how: 'prefix', candidates: [] };
  if (pref.length > 1) return { entry: null, how: 'ambiguous', candidates: briefStickers(pref) };
  // ④ 一条都没对上：拿近似项当提示（复用 list 的搜索口径；实在没有就给最前面几条，
  //    至少让她下一次调用有个能抄的 id）
  const { stickers } = formatStickerList(list, raw, 3);
  const fallback = stickers.length ? stickers : formatStickerList(list, '', 3).stickers;
  return { entry: null, how: 'none', candidates: briefStickers(fallback) };
}

/** 报错里用的极简三条（只有 id 与名字 —— ⛔ 不吐 url/md5 这些她不需要的东西）。 */
function briefStickers(items) {
  return (Array.isArray(items) ? items : []).slice(0, 3)
    .map((e) => ({ id: String(e?.id ?? ''), name: String(e?.localNote || e?.desc || '') }));
}

export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0,
    // 🆕 2026-09-21（第十对话）：把 `lastUsedAt` 也发出来。
    //    她反馈"只有累计次数看不出刚才有没有发过"（提案 16:29）；数据本来就在库里，
    //    这里只是把它暴露给管理端与 `list_stickers` 的调用方。
    lastUsedAt: e.lastUsedAt || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/** 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。 */
export function buildStickerContext(entries, max = 10) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const top = [...list]
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || ((b.localNote || b.desc) ? 1 : 0) - ((a.localNote || a.desc) ? 1 : 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 10)));
  const lines = top.map((e) => {
    // ⚠️ 优先用**机器人自己的笔记**（localNote），不是 QQ 收藏里那条备注（desc）。
    //    原因：desc 是用户在 QQ 里写的，管理端改不了，而且每次从 QQ 同步都会被
    //    mergeStickerLibrary 用 QQ 的值覆盖回去 —— 拿它当提示词标签，等于
    //    "管理端/表情包页改的备注在提示词里永远不生效"（2026-09-12 修）。
    //    localNote 才是这一侧能改的那一层，desc 退为兜底。
    const label = e.localNote || e.desc || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    // ⚠️ usage（"什么时候用"）原来**根本没进提示词** —— 管理端能填、库里存着，
    //    但模型看不到，等于白写。现在附在后面（2026-09-12 修）。
    const usage = e.usage ? `｜用法：${e.usage}` : '';
    // 🆕 2026-09-21（第十对话，提案 16:29）：补"最近用过"。
    //    她的原话：只有累计次数时不好判断刚才有没有发过，容易短时间内重复发同一个。
    //    `lastUsedAt` 数据**早就在**（本文件 :62 定义、:262 写入），只是从没进过提示词
    //    ⇒ 这条提案的成本几乎为零，是"存了但没接线"的又一例。
    //    ⚠️ 只在**最近 2 小时内**才写出来：这是"避免马上重复"需要的精度，
    //    写成绝对时间（"9月21日 15:04"）既费 token 又对判断没帮助。
    const fresh = lastUsedLabel(e.lastUsedAt);
    return `- ${label}${extra}${used}${fresh}${usage}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/有备注的 ${top.length} 个，完整列表可用 list_stickers 查询）：\n${lines.join('\n')}`;
}

/**
 * 把 `lastUsedAt` 说成一句人话，**只给"最近用过"这个判断所需的精度**。
 * 超过阈值就返回空串 —— 理由是省 token：一个表情上次用是三天前，对她"要不要现在再用一次"
 * 没有任何影响，写进提示词纯属浪费。
 */
export function lastUsedLabel(ts, { freshWithinMs = 2 * 60 * 60 * 1000 } = {}) {
  const t = Number(ts) || 0
  if (!t) return ''
  const diff = Date.now() - t
  if (diff < 0 || diff > freshWithinMs) return ''
  const min = Math.round(diff / 60000)
  if (min < 1) return '（刚刚用过）'
  if (min < 60) return `（${min} 分钟前用过）`
  return `（${Math.floor(min / 60)} 小时前用过）`
}

/** 发送前的表情包策略提示（软策略）。 */
export function buildStickerStrategyHint(level = 1) {
  // 活跃度引导放在系统提示的策略段里（而不是"本次输入"的【表情包用法】）——
  // 同一主题两处引导会左右脑互搏（Kondius 2026-09-07）：策略讲时机、档位讲频率，
  // 合并成一处由档位直接改写频率行。
  // ⚠️ 索引严格对应 0~3 档，与 ui 的 STICKER_LEVELS 一致。
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][Math.min(3, Math.max(0, Number(level) || 0))];
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 send_message 作为单独气泡发出，再单独发表情。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

/**
 * 🆕 2026-10-03（第三十四对话）§3-29：把**刚看到的那份**图片地址/文件名写回一条**已有**条目
 * —— 也就是"再看到同一张图时，把它救活"那一步的纯函数部分（IO 与补缓存在 sticker-manager）。
 *
 * ── 为什么需要它（这条推翻了同文件 `collect()` 里原来那句注释）────────────────
 *   原来的注释写着「duplicate / renamed 两条路一个字节的网络都不打 —— 它们存的是**旧 url**
 *   （可能已经死了）⇒ 换了也是白换」。⚠️ 那句话**只对"拿旧 url 去换链"成立**：
 *   `resolveFreshImageUrl` 优先用 `file` 问 OneBot，`file` 也换不回来时就退回**存下来的那条 url**
 *   ⇒ 旧条目若 url 已死、QQ 侧缓存也没了，就真的救不回来（真机实测：22 条没缓存的表情里
 *   只有 **2** 条还能换到新链，另外 **20** 条彻底没了）。
 *   但这轮的前提不同：**这次是她又看到这张图了**，而我们手里那条 url 是**刚刚从消息里读出来的、
 *   此刻一定是活的** ⇒ 把它写回条目、并立刻落盘，就能真正把这 20 条之外的那些救回来。
 *
 * ── 三条分寸（都别改）────────────────────────────────────────────────────
 *   ① **只在"新的非空且与旧的确实不同"时才写** ⇒ 新值为空串时**绝不覆盖**（别把好值抹成空）；
 *   ② 只碰 `url` / `file` / `updatedAt` 三个字段 —— **备注、标签、用法、使用计数一律不动**
 *      （那些是这一侧攒下来的认知层，`mergeStickerLibrary` 都特意保护它们）；
 *   ③ 返回 `changed` 让调用方决定要不要落盘（本函数**不写盘**，与文件里其它纯函数一致）。
 *
 * @returns {{entries:Array, entry:object|null, changed:boolean, urlChanged:boolean, fileChanged:boolean}}
 */
export function refreshStickerSource(entries, id, { url = '', file = '' } = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null, changed: false, urlChanged: false, fileChanged: false };
  const nextUrl = String(url || '').trim();
  const nextFile = String(file || '').trim();
  const urlChanged = !!nextUrl && nextUrl !== target.url;
  const fileChanged = !!nextFile && nextFile !== target.file;
  if (!urlChanged && !fileChanged) {
    return { entries: list, entry: target, changed: false, urlChanged: false, fileChanged: false };
  }
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    url: urlChanged ? nextUrl : target.url,
    file: fileChanged ? nextFile : target.file,
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: target, changed: false, urlChanged: false, fileChanged: false };
  list[idx] = next;
  return { entries: list, entry: next, changed: true, urlChanged, fileChanged };
}

/**
 * 从本地表情库里删掉一条（管理端「表情包」页用）。
 *
 * ⚠️ **只允许删非 QQ 收藏的条目**（source: 'ai' / 'manual'）。
 *    QQ 收藏是同步来的"源"：mergeStickerLibrary 会把不在 QQ 收藏里的 qq 条目
 *    自动过滤掉 —— 也就是说**在 QQ 里取消收藏，它自己就会消失**。
 *    从这边删 qq 条目，下一次 sync 照样把它拉回来，删了等于没删，
 *    还会让人以为"删除功能坏了"。
 *
 * @returns {{entries:Array, entry:object|null, removed:boolean, reason?:string}}
 */
export function removeSticker(entries, id) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null, removed: false, reason: '找不到这个表情' };
  if (target.source === 'qq') {
    return {
      entries: list,
      entry: target,
      removed: false,
      reason: 'QQ 收藏的表情不在这里删：在 QQ 里取消收藏，再同步一次它就没了（从这边删，下次同步又会被拉回来）'
    };
  }
  return { entries: list.filter((e) => e.id !== target.id), entry: target, removed: true };
}

export function markStickerUsed(entries, id, context = '') {  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
