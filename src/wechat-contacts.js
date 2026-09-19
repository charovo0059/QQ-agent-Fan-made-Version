// 微信联系人登记表：把"桥派生的数字 id"与**人看得懂的昵称**对应起来。
//
// ── 为什么必须有它（2026-09-20 接入微信时实测）──────────────────────────
// 微信侧的会话 id 是桥**派生出来的数字**（实测：某群友 = 1000000001），
// 而白名单（`config.allow.private` / `allow.groups`）装的就是这个数字。
// 但用户在微信里看到的是**昵称**（"某群友"），**看不到那个数字** ⇒
// 想放行某个人，只能靠猜 —— 正是本项目最忌讳的"静默失效"（配错了没人报错，就是不回话）。
//
// 所以这里做一件事：**每收到一个微信事件，就把 id ↔ 昵称 记下来**，
// 于是设置页能把它们列成"可点选的清单"，点一下加进白名单。
//
// ── 设计取舍 ─────────────────────────────────────────────────────────
// · 只在**入站事件**里学（那就是桥把 id 和昵称一起给的唯一时机）。
// · 落盘到数据目录（跟 store 一样），**只增不删、幂等**：id → 昵称可被后来者覆盖
//   （用户改昵称后以最新的为准），但条目永远保留（否则改个昵称就"人不见了"）。
// · **不做任何行为决策**：它不参与白名单判定，只是给人看的清单与排障依据。
//   白名单判定仍然只看 config.allow —— 免得两处都能决定"放不放行"、日后漂移。
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './config.js'

const FILE = path.join(DATA_DIR, 'wechat-contacts.json');

/** 内存态：`{ private: {id: {name, firstSeen, lastSeen, count}}, group: {...} }` */
let cache = null;
/** 攒一点再写盘：微信消息可能来得密，但这份表的写入没有时效性 */
let dirty = false;
let timer = null;
const FLUSH_MS = 2000;

function emptyDoc() { return { version: 1, private: {}, group: {} }; }

function load() {
  if (cache) return cache;
  try {
    const t = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(t);
    cache = {
      version: 1,
      private: (j && typeof j.private === 'object' && j.private) || {},
      group: (j && typeof j.group === 'object' && j.group) || {}
    };
  } catch { cache = emptyDoc(); }   // 文件不存在/坏了都当空表
  return cache;
}

function scheduleFlush() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(load(), null, 1), 'utf8');
    } catch (e) {
      // 落盘失败不该影响消息处理 —— 但要说出来，别静默
      console.error('[wechat-contacts] 落盘失败：' + (e?.message ?? e));
    }
  }, FLUSH_MS);
  // 别把它变成吊住事件循环的活跃句柄（本项目在 fs.watch 上踩过）
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * 从事件里学一条。
 * @param kind 'private' | 'group'
 * @param id   数字 id（桥派生）
 * @param name 昵称/群名（可能为空 —— 那时不覆盖已有的名字）
 */
export function learnContact(kind, id, name) {
  const k = kind === 'group' ? 'group' : 'private';
  const key = String(id ?? '').trim();
  if (!key) return;
  const doc = load();
  const table = doc[k];
  const now = Date.now();
  const prev = table[key];
  const cleanName = String(name ?? '').trim();
  if (prev) {
    prev.lastSeen = now;
    prev.count = (Number(prev.count) || 0) + 1;
    // 只在有新名字时覆盖 —— 免得空昵称把已经学到的好名字抹掉
    if (cleanName && cleanName !== prev.name) { prev.name = cleanName; prev.nameAt = now; }
  } else {
    table[key] = { name: cleanName, firstSeen: now, lastSeen: now, count: 1 };
  }
  scheduleFlush();
}

/** 列出已知联系人（给设置页/排障用），按最近活跃排序。 */
export function listContacts({ kind = null } = {}) {
  const doc = load();
  const out = [];
  for (const k of (kind ? [kind] : ['private', 'group'])) {
    for (const [id, v] of Object.entries(doc[k] || {})) {
      out.push({
        kind: k,
        id,
        name: v?.name || '',
        // 界面上没有名字时至少显示 id，别让它看着像"空条目"
        display: v?.name ? `${v.name} · ${id}` : id,
        firstSeen: v?.firstSeen || 0,
        lastSeen: v?.lastSeen || 0,
        count: v?.count || 0
      });
    }
  }
  out.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  return out;
}

/** 立即落盘（测试与退出前用）。 */
export function flushContacts() {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(load(), null, 1), 'utf8');
  } catch (e) {
    console.error('[wechat-contacts] 落盘失败：' + (e?.message ?? e));
  }
}

export const contactsFilePath = FILE;
