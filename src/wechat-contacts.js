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
  } catch (e) {
    // ⚠️ 2026-09-22（第十一对话 · 隐患排查）修：原来这一行是 `catch { cache = emptyDoc(); }`
    //    —— 注释写着"文件不存在/坏了都当空表"，但**这两种情况必须分开**：
    //    · 文件不存在（ENOENT）= 首次运行 ⇒ 空表是对的，静默即可
    //    · **文件在但读不出来**（损坏 / 权限 / IO）= 异常 ⇒ 绝不能静默当空表
    //    🔴 因为本文件的 `scheduleFlush()` 写的是
    //        `fs.writeFileSync(FILE, JSON.stringify(load(), null, 1))` —— **把 load() 的结果写回原路径**。
    //        于是"读失败 ⇒ 空表 ⇒ 下一条微信消息进来（2 秒防抖）⇒ 空表覆盖原文件"，
    //        与已修的 `stickers.js`、早有设计的 `config.js:loadConfig` 是**同一族**。
    //    ⇒ 做法与它们一致：**原文件另存为 `.corrupt-<时间戳>` 保命 + 大声报**；
    //      仍返回空表（契约不变、调用方一行不用改），但**原数据还在盘上、可人工恢复**。
    if (e?.code !== 'ENOENT') {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const bak = `${FILE}.corrupt-${stamp}`;
      try { fs.copyFileSync(FILE, bak); } catch { /* 连备份都失败也得继续报 */ }
      console.error(`[wechat-contacts] ${FILE} 存在但读不出来（${e?.message || e}）—— 已另存为 `
        + `${path.basename(bak)}；本次按空表启动。⚠️ 原表没有被覆盖，可人工恢复。`);
    }
    cache = emptyDoc();
  }
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
        // 显示串：与 QQ 侧「名字（号码）」同构，末尾多一个平台括号（用户 2026-09-20 要求）。
        // 微信侧的号码是桥派生的 10 位数字（不是微信号），光看它认不出是谁 ⇒ 名字必须带上。
        // ⚠️ 别再退回 `${name} · ${id}` 那种写法 —— 两套格式并存会让人以为是两个东西。
        display: v?.name ? `${v.name}（${id}）（微信）` : `${id}（微信）`,
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
