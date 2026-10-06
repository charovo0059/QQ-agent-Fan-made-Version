'use strict';
// 第 2/18 段：01-utils（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

// ── 工具函数 ──
// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
/** 数字加千分位（token 计数用）。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认 —— 这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_sticker:      { name: '发表情包',   cat: '发言',   icon: '🎴' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 🆕 2026-09-26 第二十四对话（提案 f789b40e）：她自己的用量/花费自检（默认关，开关在用量页）
  get_my_usage:        { name: '查自己用量', cat: '查看', icon: '📊' },
  // 🆕 2026-10-03 第三十八对话（补做提案 789584d1 后半条）：别的会话里的我（只在私聊可用）
  get_my_self_elsewhere: { name: '看别处的我', cat: '查看', icon: '🪞' },
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 🆕 2026-10-04 第四十对话 · 批 2（方案 §5.5 / 回执 Q8）：补齐缺的 10 个。
  //    此前这张表 21 条、缺 10 个工具 ⇒ 「调用明细」里它们只显示英文原名（`TOOL_META[key]`
  //    取不到就回落成 `{name: key, cat:'其他'}`）——"工具对她/对你可不可见"的另一半。
  //    🔴 它与 `ui/landing.html` 里那份副本**必须逐条一致**（那边是官网的实时总览），
  //       判据 `test-工具可见性体检.mjs` 第 8 节会核对两份的键集合 + 覆盖到每个原生工具。
  read_forward:        { name: '看合并转发', cat: '查看', icon: '📨' },
  search_images:       { name: '找图',       cat: '联网', icon: '🔎' },
  send_image:          { name: '发图片',     cat: '发言', icon: '🖼️' },
  save_core_memory:    { name: '存核心记忆', cat: '记忆', icon: '📸' },
  list_core_memories:  { name: '列核心记忆', cat: '记忆', icon: '🗂️' },
  read_core_memory:    { name: '读核心记忆', cat: '记忆', icon: '📖' },
  delete_core_memory:  { name: '删核心记忆', cat: '记忆', icon: '🗑️' },
  dream_recall:        { name: '翻自己的日记', cat: '记忆', icon: '🌙' },
  submit_proposal:     { name: '提改进提议', cat: '其他', icon: '💡' },
  get_my_proposals:    { name: '查提议进度', cat: '其他', icon: '📌' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  search_image_source: { name: '以图搜图', cat: '联网',   icon: '🖼️' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' }
};

/** 分类的展示顺序（"其他"垫底） */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '记忆', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

const CONSOLE_MARKER = 'qq-agent-console';

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统）
   ══════════════════════════════════════════════════════════════
   三种取值：'dark' | 'light' | 'system'（跟随系统偏好）。
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。

   ⛔ 2026-09-23（第十二对话，用户点名）：**删掉第四种主题 '?'（整活/VHS）**。
      用户理由："用不上，还有很多卡顿 bug"。实测对得上：
        · 它那层 CSS 是几百行高频动画（steps() 抖动 + will-change + 逐元素 rotate/translate），
          而且**对每个列表项都生效**（`.session-item:nth-child(4n)` 那一组）；
        · JS 层还挂着一个**全局 click 监听**：'?' 下每次点击都新建 3~5 个 span、850ms 后再移除；
        · `工具-设计改造\截图.mjs` 里已经记着被它坑过（想要 `--theme=light`，结果被带偏成 '?'）。
      ⇒ 取值只剩三种；**老配置/localStorage 里的 '?' 落到"跟随系统"**（用户选的回退目标），
        不会卡在一个已经不存在的主题上（见下面的 THEME_RETIRED）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统' };
const THEME_VALUES = ['light', 'dark', 'system'];
/** 已下线的主题取值 → 迁移目标。读到就地改写，别让它每轮都走迁移分支。 */
const THEME_RETIRED = { '?': 'system' };

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
function getThemePref() {
  try {
    const raw = localStorage.getItem('qqa-theme');
    if (raw && THEME_RETIRED[raw]) {
      const to = THEME_RETIRED[raw];
      // 老版本存过已下线的主题 ⇒ 迁到替代值并**就地改写 localStorage**，
      // 否则每次启动都要再走一遍这个分支（后端那份旧值也该被顺手覆盖，见 applyTheme）
      try { localStorage.setItem('qqa-theme', to); } catch { /* 忽略 */ }
      return to;
    }
    if (THEME_VALUES.includes(raw)) return raw;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system（以及任何认不出的取值）：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  // 已下线的取值先迁移（用户可能从老配置/老 localStorage 里带过来）
  const p = THEME_RETIRED[pref] || pref;
  const actual = resolveTheme(p);
  document.documentElement.setAttribute('data-theme', actual);
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[p] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[p] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', p); } catch { /* 忽略 */ }
}

/** 点击按钮：暗 → 亮 → 跟随系统 → 暗。 */
function cycleTheme() {
  const order = THEME_VALUES;
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  applyTheme(next);
  // 尽力同步到后端，失败不影响本地使用
  api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { theme: next } }) })
    .catch(() => { /* 后端不可达时静默：localStorage 已经生效 */ });
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'content-type': 'application/json',
      'x-console-token': CONSOLE_MARKER,
      ...(options.headers || {})
    },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 毫秒 ↔ 分钟（2026-09-19 加）。
 *
 * 为什么只在这里换算、不改存储单位：那几个键的名字就是 `checkIntervalMinMs` / `…MaxMs`
 * （带 `Ms`），**值也一直是毫秒**。若把存储改成分钟，键名与值就不符了，
 * 而且**已有的配置文件里存的是毫秒**，会被按"分钟"读成天文数字（1800000 分钟 ≈ 3.4 年）——
 * 那是静默出错（配置看着有值、行为全错）。⇒ 存储保持毫秒，只在界面 ×/÷ 60000。
 */
function msToMin(ms, fallbackMin = 30) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return fallbackMin;
  return Math.max(1, Math.round(n / 60000));
}
function minToMs(min, fallbackMs = 1800000) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  return Math.max(60000, Math.round(n * 60000));   // 下限 1 分钟，与原来 min="60000" 一致
}

/**
 * 读并显示「主动开话题」的实时状态（2026-09-19 加）。
 *
 * 目的：那六道闸原来有四道的参数界面上看不见，于是"它到底会不会开口"只能靠猜。
 * 这里把 GET /api/proactive 的结果摊成一句话 + 每群一行原因。
 * ⚠️ 接口是**只读**的（不掷骰子、不改状态），所以可以随时刷新。
 */
async function loadProactiveStatus() {
  const box = $('#proactive-status')
  const rg = $('#proactive-reengage')
  if (!box && !rg) return
  let d = null
  try { d = await api('/api/proactive') } catch (e) { /* 拿不到就保持原样 */ }
  if (!d || !d.ok) {
    if (box) box.textContent = '（读不到主动开口状态）'
    return
  }
  if (rg) rg.textContent = `首次 ${d.reengage.afterHours} 小时起、每次 ×${d.reengage.backoff}、最多等 ${d.reengage.maxHours} 小时`
  if (!box) return
  const iv = d.intervalMinutes || [30, 90]
  const head = d.globalBlock
    ? `现在不会开口：${d.globalBlock}`
    : `现在每 ${iv[0]}~${iv[1]} 分钟检查一次，掷骰子概率 ${d.probability}`
  const oks = (d.chats || []).filter((x) => x.ok)
  const detail = !d.enabled
    ? ''
    : (oks.length
      ? `　可开口的群：${oks.map((x) => x.chatKey.slice(6) + `（静默 ${x.idleMinutes} 分钟）`).join('、')}`
      : `　暂时没有"冷场且允许"的群（共看了 ${(d.chats || []).length} 个群，逐条原因如下）`)
  box.textContent = head + detail
  if (box) {
    box.innerHTML = esc(head) + (detail ? `<br />${esc(detail.trim())}` : '')
    // 逐群原因：只在"一个都不能开口"时展开，避免平时太吵
    if (d.enabled && !oks.length && (d.chats || []).length) {
      box.innerHTML += `<br /><span style="color:var(--faint)">` +
        (d.chats || []).slice(0, 8).map((x) => `${esc(x.chatKey.slice(6))}：${esc(x.blocked || '可以开口')}`).join('　·　') +
        `</span>`
    }
  }
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };
