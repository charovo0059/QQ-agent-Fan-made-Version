// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

const state = {
  tab: 'sessions',
  // 当前看哪个平台（'qq' | 'wechat'）。初始化时以后端 config.ui.mode 为准。
  // ⚠️ 只影响显示 —— 两个平台的后端都照常跑（见 applyPlatformMode 那段说明）。
  platformMode: 'qq',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  // 阶段 C2：侧栏本地过滤（搜索关键词 + 状态档位）。纯前端状态，不落盘、不发给后端。
  // status: 'all' | 'active' | 'ended' | 'noreply'（口径见 matchSessionFilter）
  sessionFilter: { query: '', status: 'all' },
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  // 系统提示：{ fullOverride, segments:[{key,label,default,override}], effective }
  // 由 loadSettings 从 /api/system-prompt 拉取；null = 没拉到（保存时不动逐段覆盖）
  systemPrompt: null,
  // 表情包页：{ stickers:[...], syncedAt, fromCache, syncError } + 搜索/筛选状态
  // （搜索词存 state 而不是只存 DOM，重渲染后不会把用户正在敲的字吞掉）
  stickers: null,
  stickerQuery: '',
  stickerFilter: 'all',
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}   // chatKey -> { note, at, failed? }
};

// 记忆页的「显示空记忆」是纯界面偏好，存 localStorage（不进配置，省得每次保存设置都带上它）
try { state.showEmptyMemory = localStorage.getItem('dsh-mem-show-empty') === '1'; } catch { state.showEmptyMemory = false; }

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
  // 表情包
  list_stickers:     { name: '列表情库',   cat: '表情',   icon: '📚' },
  get_sticker_image: { name: '看表情图',   cat: '表情',   icon: '🖼️' },
  collect_sticker:   { name: '收藏表情',   cat: '表情',   icon: '⭐' },
  sticker_note:      { name: '备注表情',   cat: '表情',   icon: '📝' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
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
   主题（明/暗/系统/？）
   ══════════════════════════════════════════════════════════════
   四种取值：'dark' | 'light' | 'system'（跟随系统偏好）| '?'（整活主题）。
   持久化两层：
     1. localStorage —— 立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme —— 跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', '?': '❓' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', '?': '？' };
const THEME_VALUES = ['light', 'dark', 'system', '?'];

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  syncChaosLayers(actual === '?');
  const btn = $('#theme-btn');
  if (btn) {
    btn.textContent = THEME_ICON[pref] || THEME_ICON.dark;
    btn.title = `主题：${THEME_LABEL[pref] || '暗色'}（点击切换）`;
  }
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }
}, { passive: true });

/** 点击按钮：暗 → 亮 → 跟随系统 → ？ → 暗。 */
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

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}

// ── 就绪度体检（傻瓜式引导的核心） ──
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  const obOk = status?.onebot?.connected;
  checks.push({ ok: !!obOk, label: obOk ? `OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}` : 'OneBot（SnowLuma）未连接 —— 到 SnowLuma 页签：启动网关 → WebUI 登录 → 在「进程」页注入已登录的 QQ', fix: obOk ? null : 'snowluma-tab' });
  // 可选功能的提示：**不影响 ready**（不是必要条件，不该拦住别人跑起来）。
  // 为什么放在这张卡上：默认关闭的可选功能最容易"没人知道它存在"。
  // 本子查询的程序（jm_server.exe）随包附带，但**离线库 nh.db 不随包**（151MB）——
  // 2026-09-17 用户决定改为在设置页导入，见 项目记忆.md §16。
  const tips = [];
  if (!cfg.doujinLookup?.enabled) {
    tips.push('「本子查询」是可选功能，默认关闭。需要时到「设置 → 搜索服务 → 本子查询」打开，再用「导入离线库」导入 .db 或 .csv（离线库不随安装包分发）。');
  } else {
    // 开关**开着**的时候才检查资源 —— 这才是真的会出事的状态：
    // 离线库 nh.db 不随包分发，所以"开着开关但没导库"是装完新包后很常见的一步之差。
    // 后果是**静默半失效**：JM 直连照常能用，`source=auto` 的 NH 兜底却永远查不到东西，
    // 而界面上一点提示都没有（§7「静默失效」那条）。
    const dj = status?.doujin;
    // ⚠️ 顺序要紧：入口缺失是更严重、更靠前的一环（没有 jm_server 就什么都查不了，
    // 包括 JM 直连）。先报它，再说"库没导入"这种"只坏一半"的情况。
    if (dj && dj.serverExists === false) {
      tips.push('「本子查询」已开启，但**找不到服务入口**（jm_server.exe / jm_server.py）—— 现在查不了任何东西。到「设置 → 搜索服务 → 本子查询」检查工具目录。');
    } else if (dj && dj.nhDbExists === false) {
      tips.push('「本子查询」已开启，但**离线库（nh.db）还没导入** —— 现在只有 JM 直连能用，JM 查不到时不会自动兜底。到「设置 → 搜索服务 → 本子查询 → 导入离线库」选一个 .db 或 .csv。');
    }
  }
  return { ready: urlOk && modelOk && allowOk && obOk, checks, tips };
}

// 「我已保存」的记忆：**按密码值记**，不按时间戳。
// 为什么：如果只记一个时间点，下次安装又生成一个新密码时会被旧的记录吞掉，
// 用户就再也看不到提示了。按值记 = 每个不同的密码各提示一次。
const CRED_ACK_KEY = 'qqagent.credAckd';
function credAckd(value) {
  try {
    const seen = JSON.parse(localStorage.getItem(CRED_ACK_KEY) || '[]');
    return Array.isArray(seen) && seen.includes(String(value));
  } catch { return false; }
}
function setCredAckd(value) {
  try {
    const seen = JSON.parse(localStorage.getItem(CRED_ACK_KEY) || '[]');
    const next = Array.isArray(seen) ? seen : [];
    if (!next.includes(String(value))) next.push(String(value));
    localStorage.setItem(CRED_ACK_KEY, JSON.stringify(next.slice(-10)));
  } catch { /* 存不了就下次再提示，不影响使用 */ }
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 首次安装的 WebUI 初始密码 —— 优先级最高，且**不随"暂停/未连接"被挤掉**。
  // 为什么它最重要：这串密码只打印一次、关闭后无法找回；拿不到它，用户就进不去 WebUI，
  // 也就走不完「登录 → 注入 QQ 进程」这套流程，整个应用对他就是废的。
  const cred = s?.snowluma?.initialPassword;
  if (cred?.value && !credAckd(cred.value)) {
    show = true;
    html = `<div class="cred-banner">
      <div style="margin-bottom:4px">🔑 <b>SnowLuma 首次登录密码</b>（只出现这一次，关闭后无法找回）：</div>
      <div class="cred-value"><code id="cred-pw">${esc(cred.value)}</code>
        <button class="btn btn-small" id="cred-copy-btn">复制</button>
        <button class="btn btn-small" id="cred-ack-btn" title="确认已保存，不再显示这条提示">我已保存</button>
        <span class="muted" id="cred-hint" style="font-size:12px"></span></div>
      <div class="muted" style="font-size:12px;margin-top:4px">
        接下来：用它在 <b>SnowLuma → WebUI</b> 登录，电脑上的 <b>QQ 先登录好</b>，
        再到 WebUI 的「<b>进程</b>」页选中那个 QQ 进程点「<b>注入</b>」。
      </div>
    </div>`;
    banner.classList.remove('hidden');
    banner.innerHTML = html;
    const hint = $('#cred-hint');
    const copyBtn = $('#cred-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const pw = cred.value;
      try {
        await navigator.clipboard.writeText(pw);
        if (hint) hint.textContent = '已复制到剪贴板';
      } catch {
        // 剪贴板被拒时不要让用户以为复制成功了 —— 直接把文本选中，让他自己按 Ctrl+C
        const el = $('#cred-pw');
        if (el) {
          const r = document.createRange();
          r.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(r);
          if (hint) hint.textContent = '已选中，请按 Ctrl+C 复制';
        }
      }
    });
    const ackBtn = $('#cred-ack-btn');
    if (ackBtn) ackBtn.addEventListener('click', () => { setCredAckd(cred.value); renderBanner(); });
    return;
  }
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请到「SnowLuma」页签，按顺序做三步 —— 启动网关 → 用访问密码登录 WebUI → 在「进程」页注入已登录的 QQ。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   平台切换：QQ / 微信（2026-09-20 第八对话新增）

   用户 2026-09-20 拍板的语义（**别改**）：
   · 这**只是前端切换显示** —— 两个平台的后端**都继续跑**，不是"停掉另一边"。
   · 微信模式下：会话/存档/记忆**只看微信**；隐藏「表情包」页签、设置里的表情区、
     以及「SnowLuma」页签（那是 QQ 专属的协议栈）。
   · 「笔记」（梦）**不做**平台过滤 —— 梦本来就是全局回想，强行筛反而丢东西。
   · 切换状态**存进配置**（`ui.mode`），刷新/重启后保持。

   ⚠️ 为什么过滤放在**渲染**而不是放在接口：接口是给所有页面共用的，
   而"这一步看哪边"是界面状态；放接口里会让"两边同时要看"的场景没法做。
   ⚠️ `ui/app.js` 是**经典脚本**，不许出现 export（写了整个控制台白屏）。
   ══════════════════════════════════════════════════════════════════════ */

/** 当前是不是在看微信。默认 qq（配置缺省时也是 qq）。 */
function isWechatMode() { return state.platformMode === 'wechat'; }

/** 某个会话条目属不属于当前平台。source 缺省当 qq（接入微信之前建的会话都是 QQ）。 */
function matchPlatform(item) {
  const src = String((item && (item.source || item.chatSource)) || 'qq');
  return isWechatMode() ? src === 'wechat' : src !== 'wechat';
}

/**
 * 按 chatKey 判断平台时用的映射表（`chatKey -> 'qq' | 'wechat'`）。
 *
 * ⚠️ 为什么需要它：`/api/sessions` 的条目**没有 source 字段**
 * （只有 `/api/chats` 有）⇒ 会话列表只能靠 chatKey 去查这张表。
 * 每次渲染都去请求一次 /api/chats 太浪费（列表是 4 秒轮询的），所以缓存住，
 * 由 loadChats / loadSessions 顺手刷新。
 */
async function refreshSourceMap() {
  try {
    const data = await api('/api/chats');
    const m = new Map();
    for (const c of data.chats || []) m.set(c.key || c.chatKey, String(c.source || 'qq'));
    state.sourceMap = m;
  } catch { /* 拿不到就沿用旧表（宁愿显示多，也别把该显示的藏了） */ }
}

/** 会话（历史运行记录）属于哪个平台 —— 查表；查不到时**倾向显示**（默认 qq）。 */
function sessionPlatform(item) {
  const key = item && item.chatKey;
  const fromMap = key && state.sourceMap ? state.sourceMap.get(key) : null;
  return String(item?.source || fromMap || 'qq');
}

function matchPlatformSession(item) {
  const src = sessionPlatform(item);
  return isWechatMode() ? src === 'wechat' : src !== 'wechat';
}

/** 会话条目最终显示什么（微信模式下顺带把平台标出来，避免两个平台串味）。 */
function platformIconOf(item) {
  return String((item && item.source) || 'qq') === 'wechat' ? '（微信）' : '';
}

/**
 * 把平台模式应用到界面：按钮态、页签显隐、当前页重载。
 * 只碰 DOM 与 state，**不发任何影响后端行为的请求**（除了把偏好存回配置）。
 */
function applyPlatformMode({ reload = true } = {}) {
  const wx = isWechatMode();
  const box = $('#platform-switch');
  if (box) {
    box.classList.toggle('wechat-mode', wx);
    $$('.plat-btn', box).forEach((b) => {
      const on = b.dataset.platform === state.platformMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }
  // 微信模式下藏掉 QQ 专属页签。用 hidden 而不是 display:none —— 与项目里其它地方一致。
  const hideInWechat = ['stickers', 'snowluma'];
  for (const name of hideInWechat) {
    const btn = $(`.tab[data-tab="${name}"]`);
    if (btn) btn.classList.toggle('hidden', wx);
  }
  // 如果当前正停在要被隐藏的页上，切回会话页（否则用户会停在一个"没有入口"的页）
  if (wx && hideInWechat.includes(state.tab)) switchTab('sessions');

  // 顶栏/底部状态跟着平台走 —— 否则切到微信还显示 QQ 的连接状态，会误导
  updatePlatformStatusLabel();

  if (!reload) return;
  // 当前页重载一次，让过滤立即生效
  if (state.tab === 'sessions') loadSessions();
  else if (state.tab === 'chats') loadChats();
  else if (state.tab === 'memory') loadMemoryView();
}

/** 切换平台并**记进配置**（下次打开还是这一边）。 */
async function setPlatformMode(mode) {
  const next = mode === 'wechat' ? 'wechat' : 'qq';
  if (next === state.platformMode) return;
  state.platformMode = next;
  applyPlatformMode();
  try {
    // ⚠️ body 必须自己 JSON.stringify —— `api()` 只设 content-type，不做序列化。
    //    第一版传了对象，服务端 readBody 解析失败当空 body ⇒ 偏好**静默没存上**
    //    （界面照样切、只有下次打开才发现回到 QQ）。这类"看起来成功其实没生效"正是本项目最忌讳的。
    await api('/api/config', { method: 'POST', body: JSON.stringify({ ui: { mode: next } }) });
  } catch (e) {
    // 存不上只是"下次打开回到 QQ"，不影响这次切换 —— 说出来但不打断
    console.warn('[platform] 偏好没存上：', e);
  }
}

/**
 * 顶栏那行状态文案：微信模式下显示**微信通道**的状态。
 * 为什么必须切：`OneBot 未连接` 在微信模式下指的是 QQ 那条线，
 * 而用户此刻关心的是微信通没通 —— 显示错了比不显示更坏。
 */
function updatePlatformStatusLabel() {
  const dot = $('#onebot-dot');
  const label = $('#onebot-label');
  if (!dot || !label) return;
  if (!isWechatMode()) {
    // QQ：恢复原有表现（由 updateStatus 那套逻辑驱动）
    if (state.status) applyQqStatusLabel(state.status);
    return;
  }
  const w = state.status?.wechat || null;
  const on = !!w?.connected;
  // 🔴 「连上了中继」≠「收得到消息」（2026-09-20 实测补）：
  //    `connected` 只表示 agent 连上了中继；中继有没有连上 Bridge 是另一回事。
  //    实测把 Bridge 杀掉后 `connected` 仍然是 true ⇒ 那时候显示"微信已连接"就是在骗人
  //    （消息永远进不来，而用户看到的是一切正常 —— 本项目最忌的静默失败）。
  //    ⚠️ `bridgeConnected` 为 null 表示**还没问出来**，不能当成 false（否则中继刚起来时会误报）。
  const upstreamDown = on && w?.bridgeConnected === false;
  dot.className = 'dot ' + ((on && !upstreamDown) ? 'dot-on' : 'dot-off');
  if (upstreamDown) {
    label.textContent = '微信未接通（中继没连上 Bridge）';
  } else if (on) {
    const nick = w?.self?.nickname ? ` ${w.self.nickname}` : '';
    label.textContent = `微信已连接${nick}`;
  } else if (!w?.enabled) {
    // 常见误判：用户以为"接进来了"，其实 config.wechat.enabled 还是 false
    label.textContent = '微信未启用（config.wechat.enabled）';
  } else {
    label.textContent = '微信未连接（中继/Bridge 没起来？）';
  }
  label.className = (on && !upstreamDown) ? '' : 'muted';
}

/** QQ 模式的顶栏文案（抽出来是为了让"切回 QQ"能恢复原样，而不是留着我改过的痕迹）。 */
function applyQqStatusLabel(status) {
  const dot = $('#onebot-dot');
  const label = $('#onebot-label');
  if (!dot || !label || !status) return;
  const o = status.onebot || {};
  // 三态与改动前保持一致（连上 / 连过但现在断了 / 从没连上）—— 别顺手简化成两态
  dot.className = 'dot ' + (o.connected ? 'dot-on' : (o.everConnected ? 'dot-wait' : 'dot-off'));
  label.textContent = o.connected
    ? `OneBot 已连接${o.self ? `（${o.self.nickname}）` : ''}`
    : 'OneBot 未连接';
  label.className = o.connected ? '' : 'muted';
}

function switchTab(name) {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  state.tab = name;
  if (state.quoteMode && name !== 'chats') exitQuoteMode();   // 离开存档页自动退出金句勾选
  if (name === 'sessions') loadSessions();
  if (name === 'chats') loadChats();
  if (name === 'memory') loadMemoryView();
  if (name === 'stickers') loadStickerPage();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'dreams') loadDreams();
  if (name === 'snowluma') loadSnowlumaPage();
  if (name === 'wechat') loadWechatPage();
  if (name === 'skills') loadSkillsPage();
  if (name === 'settings') loadSettings();
}

/* ══════════════════════════════════════════════════════════════════════
   技能 / 插件管理页（2026-09-19 第七对话新增）
   ──────────────────────────────────────────────────────────────────────
   背景：装了 send-forward 之后发现**没有任何界面能开关扩展**，只能手改 config.json，
   而那条路有个静默坑（见项目记忆 §0 铁律 13）。0.3.1 本来有这一页，我们只回移了
   `src/skills/*` 基础设施，界面没跟着回移。

   ⚠️ 三条设计约束（改这一页前必读）：
   1. **状态一律用后端 /api/skills 的判定结果，前端不自己推断能不能用** ——
      否则又会出现"界面说能用、实际不生效"的两套口径（上游踩过）。
   2. **开关只写 /api/skills/:id**，不要在别处再开一个写 config 的口子。
   3. **不要按 manifest 文件名猜类型** —— 用后端返回的 `kind`
      （'skill' = LLM 型 / 'plugin' = 确定性型 / null = 目录未识别）。
   ══════════════════════════════════════════════════════════════════════ */

/** 本页要展示的扩展状态（内存态，由 loadSkillsPage 拉取）。 */
if (!state.skills) state.skills = [];
if (!state.skillsSummary) state.skillsSummary = {};
if (!state.uninstalledSkills) state.uninstalledSkills = [];
if (state.skillsHotReload === undefined) state.skillsHotReload = true;
// 待审提案（记忆页顶部那块）。取不到时保持原值，别清空成"没有提案"的假象。
if (!Array.isArray(state.proposals)) state.proposals = [];
if (!state.proposalCounts) state.proposalCounts = {};

/**
 * 拉取列表（不含磁盘重扫）。**失败时保持原值**，不要覆盖成空数组 ——
 * 那会表现为"条目突然都不见了"，比报错更难排查。
 */
async function loadSkillsStatus() {
  try {
    const data = await api('/api/skills');
    state.skills = data.skills || [];
    state.skillsSummary = data.summary || {};
    state.uninstalledSkills = data.uninstalled || [];
    state.skillsHotReload = data.hotReload !== false;
  } catch (e) {
    console.warn('[skill] 拉取技能列表失败：', e?.message || e);
  }
}

/** 重扫磁盘：页面「刷新」按钮的完整动作（先让后端重扫，再重取列表）。 */
async function rescanSkills({ quiet = false } = {}) {
  try {
    const r = await api('/api/skills/reload', { method: 'POST' });
    if (r && r.skills) {
      state.skills = r.skills;
      state.skillsSummary = r.summary || {};
      await loadSkillsStatus();   // 重扫响应里没有 uninstalled，补拉一次
      if (!quiet && r.failed?.length) console.warn('[skill] 本次重扫失败条目：', r.failed);
      return r;
    }
  } catch (e) {
    console.warn('[skill] 重扫请求失败：', e?.message || e);
  }
  await loadSkillsStatus();
  return null;
}

async function loadSkillsPage() {
  const box = $('#skills-page');
  if (!box) return;
  await loadSkillsStatus();
  renderSkillsPage();
}

/** 上游把技能/插件分成两页；我们合成一页两个分组，定义仍保留，方便日后拆开。 */
const SKILL_KINDS = {
  skill: {
    key: 'skill',
    title: '技能（Skill）· LLM 型',
    lead: '这些扩展注册工具进模型的 function 列表，<b>用不用、什么时候用由模型自己判断</b> —— 所以它们不会"一定生效"。需要"条件满足必跑"的功能该做成插件。',
    empty: '还没有加载到任何技能。技能放在 <code>skills/&lt;id&gt;/</code>，需要 <code>skill.json</code> + <code>index.js</code>。'
  },
  plugin: {
    key: 'plugin',
    title: '插件（Plugin）· 确定性型',
    lead: '这些扩展提供<b>能力</b>或<b>钩子</b>，由核心代码按能力名确定性调用 —— <b>条件满足就一定会执行，不经过模型</b>。代价是何时触发必须在代码里写死。',
    empty: '还没有加载到任何插件。插件放在 <code>plugins/&lt;id&gt;/</code>，需要 <code>plugin.json</code> + <code>index.js</code>。'
  }
};

/** 一张扩展卡片。 */
function skillCardHtml(s) {
  const loadedOk = !!s.loaded;
  const stateText = !loadedOk ? '加载失败' : (!s.enabled ? '已关闭' : (s.active ? '生效中' : '依赖未就绪'));
  const badge = !loadedOk ? 'status-error' : (!s.enabled ? 'status-noreply' : (s.active ? 'status-done' : 'status-waiting'));
  // 后端给的错误码（src/skills/errors.js 的 SKILL_ERROR）翻成人话。
  // 为什么要多显示这一行：徽章只说"依赖未就绪"，而"我该去开开关"和"我该去装个东西"
  // 是两件完全不同的事 —— 后端已经把 code 给了，前端不显示就等于让用户猜。
  const CODE_TEXT = {
    'skill-not-found': '这个扩展不在目录里',
    'skill-not-loaded': '扩展加载失败',
    'skill-disabled': '被开关关掉了',
    'skill-unavailable': '依赖不满足（缺 Key / 缺可执行文件 / 模型不支持）',
    'skill-timeout': '扩展执行超时（已跳过，防止卡死整轮对话）',
    'capability-missing': '缺少它需要的能力'
  };
  const codeText = (!s.active && s.code && CODE_TEXT[s.code]) ? CODE_TEXT[s.code] : '';
  const codeHtml = codeText
    ? `<div class="hint" style="color:var(--muted)">原因：${esc(codeText)} <code>${esc(s.code)}</code></div>` : '';
  // 加载失败的原因必须亮出来 —— 否则用户看到的是"它不存在"
  const loadErr = (!loadedOk && s.loadError)
    ? `<div class="hint" style="color:var(--red)">加载失败：${esc(s.loadError)}</div>` : '';
  const missing = (s.missingRequires || []).length
    ? `<div class="hint" style="color:var(--orange)">缺少能力：${esc(s.missingRequires.join('、'))}</div>` : '';
  // 不可用原因原文照显示："为什么不能用"要一眼看到，而不是笼统的"工具关闭"
  const reason = (!s.active && s.reason)
    ? `<div class="hint" style="color:${s.loaded && s.enabled ? 'var(--orange)' : 'var(--muted)'}">${esc(s.reason)}</div>` : '';
  const err = s.lastError ? `<div class="hint" style="color:var(--red)">上次出错：${esc(s.lastError)}</div>` : '';
  // ── 声明 vs 实现在代码里的对账（后端 status() 特意把两个都给了）──
  // 两类静默故障，光看"已启用"永远发现不了：
  //   · 声明了但没实现 → 别人按能力名来取，拿到空数组，功能悄悄失效
  //   · 实现了但没声明 → 用户看不出它提供什么，也可能被别人重复实现
  const declared = s.capabilities || [];
  const impl = s.implementedCapabilities || [];
  const notImpl = declared.filter((c) => !impl.includes(c));
  const notDecl = impl.filter((c) => !declared.includes(c));
  const capWarn = (notImpl.length || notDecl.length)
    ? `<div class="hint" style="color:var(--orange)">⚠️ 能力对账不一致：${
        notImpl.length ? `声明了但代码里没实现 —— ${esc(notImpl.join('、'))}` : ''
      }${notImpl.length && notDecl.length ? '；' : ''}${
        notDecl.length ? `实现了但没声明 —— ${esc(notDecl.join('、'))}` : ''
      }</div>` : '';
  // ⚠️ 开关另有真实去处时（本子查询用 config.doujinLookup.enabled），必须写在卡片上 ——
  //    否则用户会以为这个勾选框就是那个功能的开关，关不掉时无从查起。
  const ovNote = s.enabledOverride
    ? `<div class="hint" style="color:var(--muted)">开关位置：<code>${esc(s.enabledOverride.label)}</code>（这个功能不用 config.skills，用上面那个键；本页的勾选框写的就是它）</div>` : '';
  const caps = declared.length
    ? `<div class="tool-meta">${declared.map((x) => `<span class="tool-dep">${esc(x)}</span>`).join('')}</div>` : '';
  // 只有声明了设置项的条目才给按钮，否则一排"设置"点开是空的，纯噪音
  const allFields = Object.keys(s.configSchema || {});
  const renderable = allFields.filter((k) => s.configSchema[k]?.type !== 'internal');
  const settingsBtn = allFields.length
    ? `<button class="btn btn-small skill-settings-btn" data-skill-id="${esc(s.id)}" title="就地展开配置表单">配置（${renderable.length || allFields.length}）</button>` : '';
  // 类型徽章用后端给的 kind 判，不用 source（source 只反映清单文件名，是另一件事）
  const kindTag = s.kind == null
    ? '<span class="tool-dep-warn">目录未识别</span>'
    : (s.kind === 'plugin' ? '确定性型' : 'LLM 型');
  const catLabel = { model: '模型', message: '消息', knowledge: '知识', media: '媒体', utility: '工具' };
  // ── UI 改造第二阶段 条目 4 改动点 4：卡片单行化 ──────────────────────────
  // 方案："名称+版本+徽章 / 一句话描述 / 类型·工具数小标签；路径与 config 键细节进卡片 ⓘ"
  // ⇒ 原来 `.tool-header` 里有 5 个块（勾选框/名称/描述/状态徽章），现在收成：
  //    第 1 行 = 名称 + 版本 + 状态徽章 + ⓘ + Toggle
  //    第 2 行 = 一句话描述
  //    第 3 行 = 类型 · 工具数（小标签）
  // ⚠️ 状态徽章用**既有的 `.status-badge`**（会话状态那套，后端给的 badge 值直接映射），
  //    不换成新 StatusBadge —— 后端的 badge 字段有它自己的取值（enabled/disabled/…），
  //    硬套三态会把"未加载""依赖缺失"这些中间态压平。
  const detailHint = [
    s.dir ? `目录：${s.dir}` : '',
    s.id ? `id：${s.id}` : '',
    (s.toolIds || []).length ? `注册工具：${s.toolIds.join('、')}` : '',
    (s.capabilities || []).length ? `提供能力：${s.capabilities.join('、')}` : '',
    (s.hooks || []).length ? `钩子：${s.hooks.join('、')}` : '',
    `配置键：skills.${s.id}`,
  ].filter(Boolean).join('；');
  return `<div class="tool-card ${s.active ? 'enabled' : (s.loaded && s.enabled ? 'disabled' : 'dep-disabled')}" data-skill-id="${esc(s.id)}">
    <div class="skill-line1">
      <div class="skill-card__name">${esc(s.name)}<span class="skill-card__ver">v${esc(s.version || '')}</span></div>
      <span class="status-badge ${badge}">${stateText}</span>
      ${s.deprecated ? '<span class="tool-dep-warn">已弃用</span>' : ''}
      <span class="ihint" role="note" tabindex="0" title="${esc(detailHint)}" aria-label="扩展详情">i</span>
      <span class="ph-spacer"></span>
      ${settingsBtn}
      ${toggleHtml(`skill-tg-${s.id}`, !!s.enabled, '已启用', '已停用',
        `class="skill-toggle" data-skill-id="${esc(s.id)}"${s.loaded ? '' : ' disabled'}`)}
    </div>
    <div class="skill-card__desc">${esc(s.description || '（没有写介绍）')}</div>
    <div class="tool-meta skill-line3">
      <span class="tool-dep">${catLabel[s.category] || esc(s.category || '未分类')}</span>
      <span class="tool-dep">${kindTag}</span>
      ${(s.toolIds || []).length ? `<span class="tool-dep">${s.toolIds.length} 个工具</span>` : ''}
      ${(s.hooks || []).length ? `<span class="tool-dep">${s.hooks.length} 个钩子</span>` : ''}
    </div>
    <div class="skill-cfg-inline" data-cfg-for="${esc(s.id)}" hidden></div>
    ${caps}${missing}${codeHtml}${capWarn}${reason}${loadErr}${err}${ovNote}
  </div>`;
}

/** 渲染整页（技能组 + 插件组 + 残留配置 + 安装说明）。 */
function renderSkillsPage() {
  const box = $('#skills-page');
  if (!box) return '';
  const all = state.skills || [];
  // kind 为 null 的条目归入技能组，**不丢** —— "界面上凭空少一条"比"归错组"难查得多
  const groups = { skill: [], plugin: [] };
  for (const s of all) groups[s.kind === 'plugin' ? 'plugin' : 'skill'].push(s);

  // ── UI 改造第二阶段 条目 4：搜索 + 类型筛选 ────────────────────────────
  // 方案："页头：标题 + 生效统计徽标（2/2）+ 搜索 + 类型筛选（全部/LLM 型/确定性型）+ 热重载开关 + 刷新"
  // ⚠️ 过滤只作用于**已加载的条目**（技能页一次全量渲染，不分页），
  //    所以直接在这一层过滤、不涉及"加载更多"的计数问题。
  const q = String(state.skillsQuery || '').toLowerCase();
  const kindFilter = state.skillsKindFilter || 'all';
  const matchFilter = (s) => {
    if (kindFilter !== 'all') {
      const k = s.kind === 'plugin' ? 'plugin' : 'skill';
      if (k !== kindFilter) return false;
    }
    if (!q) return true;
    return `${s.name || ''} ${s.id || ''} ${s.description || ''}`.toLowerCase().includes(q);
  };
  const shownCount = all.filter(matchFilter).length;

  const sectionOf = (meta) => {
    const itemsAll = groups[meta.key];
    const items = itemsAll.filter(matchFilter);
    if (!items.length) {
      // 空状态要说清是"真的没有"还是"被筛掉了"—— 两种空不能让用户分不清（本项目反复踩的静默失效）
      if (itemsAll.length) {
        return `<h3 class="usage-h3">${meta.title}（0 / ${itemsAll.length}）</h3>
          <div class="hint" style="margin:6px 0 16px">${itemsAll.length} 条都被搜索/筛选条件挡住了 —— 清空搜索框或把类型切回「全部」就能看到。</div>`;
      }
      return `<h3 class="usage-h3">${meta.title}（0）</h3>
        <div class="empty-hint">${meta.empty}</div>`;
    }
    const active = itemsAll.filter((s) => s.active).length;
    const rows = items.map(skillCardHtml).join('');
    // 尾注：技能页最有用的信息是"它注册了哪些工具"（模型看到的就是这些）；
    // 插件页是"它提供哪些能力"（核心按名字找的就是这些）。
    // ⚠️ 条目 4：这两段说明**下沉到「开发者说明」折叠区**（方案："四段说明文字收进底部
    //    「开发者说明」折叠区"）。这里只留一句"共 N 个工具"的短标签在卡片上。
    const tools = itemsAll.flatMap((s) => s.toolIds || []);
    const caps = [...new Set(itemsAll.flatMap((s) => s.capabilities || []))].sort();
    return `<h3 class="usage-h3">${meta.title}（${items.length}${items.length !== itemsAll.length ? ` / ${itemsAll.length}` : ''} · ${active} 生效）</h3>
      <div class="tool-list">${rows}</div>
      <div data-devnote="${meta.key}" data-tools="${esc(tools.join(','))}" data-caps="${esc(caps.join(','))}"></div>`;
  };

  // 已配置但未安装：删掉目录后 config.skills.<id> 还留着（单开关制没有"影子开关"要清，
  // 但残留的 enabled 与设置仍在，重装同名扩展会自动恢复）。
  const un = state.uninstalledSkills || [];
  const unHtml = un.length
    ? `<h3 class="usage-h3">已配置但未安装（${un.length}）</h3>
       <div class="hint" style="margin-bottom:6px">这些条目在配置里留着开关/设置，但 <code>skills/</code> 与 <code>plugins/</code> 目录里已经没有对应文件夹。重装同名扩展会自动恢复这些设置；确认不要了可以清理掉。</div>
       <div class="tool-meta" style="gap:6px;margin-bottom:8px">${un.map((u) => `<span class="tool-dep">${esc(u.id)}${u.enabled ? '' : '（已关）'}${u.hasSettings ? ' · 有设置' : ''}</span>`).join('')}</div>
       <button class="btn btn-small" id="skills-cleanup-btn">清理这些残留配置</button>
       <div style="height:16px"></div>` : '';

  const total = all.length;
  const activeAll = all.filter((s) => s.active).length;
  // 热重载状态（config.skills.hotReload，默认 on）。显示出来是因为它决定了
  // "放了新扩展要不要手动点刷新"—— 这是用户最需要知道的一件事，不该藏在配置里。
  const hot = state.skillsHotReload !== false;

  // ── 开发者说明折叠区（条目 4 改动点 1 + 6 的落点）──────────────────────
  // 方案："四段说明文字收进底部「开发者说明」折叠区（一个明显入口，默认收起，
  //   因含开发者受众不藏图标）"
  const toolsAll = groups.skill.flatMap((s) => s.toolIds || []);
  const capsAll = [...new Set(groups.plugin.flatMap((s) => s.capabilities || []))].sort();
  const devNotes = `<details class="devnotes" id="skills-devnotes">
    <summary>开发者说明</summary>
    <div class="devnotes-body">
      <h4>开关只有一处</h4>
      <div>关闭后它注册的工具、提供的能力、提示词片段会<b>同时</b>失效。状态徽章与"为什么没生效"的说明都由后端判定，界面不自己猜。</div>
      <h4>怎么放新扩展</h4>
      <div>在 <code>skills/&lt;id&gt;/</code> 或 <code>plugins/&lt;id&gt;/</code> 放清单与入口文件${hot ? '，约 0.5 秒后自动加载' : '，然后点「刷新」'}。</div>
      <h4>技能的「工具」是什么</h4>
      <div>技能注册的工具会被放进发给模型的 function 列表 —— <b>模型只能看到工具，看不到技能本身</b>。
        当前这组共注册 <b>${toolsAll.length}</b> 个工具：</div>
      <div class="tool-meta" style="gap:6px;margin:6px 0 2px">${toolsAll.map((t) => `<span class="tool-dep">${esc(t)}</span>`).join('') || '<span class="muted">（没有注册任何工具）</span>'}</div>
      <h4>插件的「能力」是什么</h4>
      <div>插件声明能力，核心模块按<b>能力名</b>找提供者，不依赖具体插件名 —— 所以换实现不用改核心代码。
        当前这组共提供 <b>${capsAll.length}</b> 个能力：</div>
      <div class="tool-meta" style="gap:6px;margin:6px 0 2px">${capsAll.map((c) => `<span class="tool-dep">${esc(c)}</span>`).join('') || '<span class="muted">（没有声明任何能力）</span>'}</div>
    </div>
  </details>`;

  const html = `<div class="usage-wrap">
    <div class="pagehead">
      <h3>技能 / 插件</h3>
      ${statusBadge(activeAll === total && total > 0 ? 'ok' : (activeAll ? 'warn' : 'off'), `${activeAll} / ${total} 生效`)}
      <span class="ph-spacer"></span>
      <input class="ph-search" type="search" id="skills-search" placeholder="搜索技能或插件" aria-label="搜索" value="${esc(state.skillsQuery || '')}">
      <span class="segchips" id="skills-kind-filter">
        <span class="chip${kindFilter === 'all' ? ' on' : ''}" data-kind="all">全部</span>
        <span class="chip${kindFilter === 'skill' ? ' on' : ''}" data-kind="skill">LLM 型</span>
        <span class="chip${kindFilter === 'plugin' ? ' on' : ''}" data-kind="plugin">确定性型</span>
      </span>
      ${toggleHtml('skills-hotreload-toggle', hot, '热重载开', '热重载关',
        `title="放进 skills/ 或 plugins/ 的扩展会被自动加载（约 0.5 秒后生效）；关掉则要手动点「刷新」"`)}
      <button class="btn btn-small" id="skills-refresh-btn" title="重新扫描 skills/ 与 plugins/ 目录">刷新</button>
    </div>
    ${hot ? safetyBar('热重载开着时，放进 skills/ 或 plugins/ 目录的任何 .js 都会被自动执行 —— 请勿放入不信任的代码。') : ''}
    ${q || kindFilter !== 'all' ? `<div class="hint">筛出 ${shownCount} / ${total} 条${q ? `（关键词「${esc(state.skillsQuery)}」）` : ''}</div>` : ''}
    ${sectionOf(SKILL_KINDS.skill)}
    ${sectionOf(SKILL_KINDS.plugin)}
    ${unHtml}
    ${devNotes}
  </div>`;
  box.innerHTML = html;
  bindSkillsPageEvents();
  return html;
}

function bindSkillsPageEvents() {
  $('#skills-refresh-btn')?.addEventListener('click', async () => {
    const btn = $('#skills-refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '重扫中…'; }
    await rescanSkills();
    renderSkillsPage();   // 重绘会重建按钮，不必再手动恢复文案
  });
  // 热重载：条目 4 起改用**标准 Toggle**（原来是一个文案会变的按钮"关掉热重载/打开热重载"）。
  // 🔴 方案原则 2 点名"禁止用按钮样式表达状态"—— 那个按钮正是反例：
  //    它的**文字**是状态（"热重载：开"另有一个 uc-tag），而**按钮**是动作，
  //    两者混在一个控件里，用户看不出"现在到底开着没有"。
  //    现在：Toggle 表达状态与动作，状态文字由 toggleHtml 的 on/off 文案承担。
  $('#skills-hotreload-toggle')?.addEventListener('change', async (e) => {
    const want = !!e.target.checked;
    e.target.disabled = true;
    try {
      const r = await api('/api/skills/hotreload', { method: 'POST', body: JSON.stringify({ enabled: want }) });
      state.skills = r.skills || state.skills;
      state.skillsHotReload = r.hotReload !== false;
      renderSkillsPage();
    } catch (err) {
      // 🔴 存不上必须把开关退回去，否则界面在说谎（用户以为开了，其实没开）
      e.target.checked = !want;
      e.target.disabled = false;
      alert(`切换热重载失败：${err.message}`);
    }
  });
  // 搜索（debounce 150ms 与侧栏会话搜索同量级：每敲一个字符都重绘会让人输入发涩）
  const sInput = $('#skills-search');
  if (sInput) {
    let t = null;
    sInput.addEventListener('input', () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        t = null;
        const v = sInput.value.trim();
        if (v === (state.skillsQuery || '')) return;
        state.skillsQuery = v;
        renderSkillsPage();
        // 重绘后把焦点与光标放回搜索框 —— 否则打字打一半焦点就没了
        //（本项目反复踩的"打字被打断"，这里是同一个病）
        const el = $('#skills-search');
        if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* ignore */ } }
      }, 150);
    });
  }
  // 类型筛选（分段芯片，参照侧栏会话筛选那套）
  $$('#skills-kind-filter .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const v = chip.dataset.kind || 'all';
      if (v === (state.skillsKindFilter || 'all')) return;
      state.skillsKindFilter = v;
      renderSkillsPage();
    });
  });
  $$('#skills-page .skill-toggle').forEach((cb) => {
    cb.addEventListener('change', () => toggleSkill(cb.dataset.skillId, cb.checked));
  });
  // 配置：条目 4 改动点 6 要求 **就地展开**（原来弹 modal）。
  // ⚠️ 就地展开的 DOM 放在卡片内的 `.skill-cfg-inline`，由 openSkillSettingsInline 填。
  $$('#skills-page .skill-settings-btn').forEach((b) => {
    b.addEventListener('click', () => openSkillSettingsInline(b.dataset.skillId, b));
  });
  $('#skills-cleanup-btn')?.addEventListener('click', async () => {
    const ids = (state.uninstalledSkills || []).map((u) => u.id);
    if (!ids.length) return;
    if (!confirm(`要清掉这 ${ids.length} 条残留配置吗？\n\n${ids.join('、')}\n\n只删配置，不动任何文件。`)) return;
    try {
      const r = await api('/api/skills/cleanup', { method: 'POST', body: JSON.stringify({ ids }) });
      state.skills = r.skills || state.skills;
      state.skillsSummary = r.summary || state.skillsSummary;
      state.uninstalledSkills = r.uninstalled || [];
      renderSkillsPage();
    } catch (e) {
      alert(`清理失败：${e.message}`);
    }
  });
}

/** 切开关。失败要把勾选框状态改回去，否则界面会显示一个并未生效的状态。 */
async function toggleSkill(id, enabled) {
  try {
    const r = await api(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ enabled })
    });
    const idx = (state.skills || []).findIndex((x) => x.id === id);
    if (idx >= 0 && r.skill) state.skills[idx] = { ...state.skills[idx], ...r.skill };
    renderSkillsPage();
  } catch (e) {
    alert(`切换失败：${e.message}`);
    await loadSkillsStatus();
    renderSkillsPage();
  }
}

/**
 * 技能设置弹窗：**完全按 manifest 的 configSchema 渲染**，前端不硬编码字段名 ——
 * 加一个新技能、加一个字段，这里一行都不用改。
 * 支持 type：boolean / number / enum / string（secret 用密码框，留空 = 不修改）。
 */
function renderSkillSettingsModal(skill) {
  if (!skill) return { error: '技能不存在' };
  const skillId = skill.id;
  const schema = skill.configSchema || {};
  const values = skill.settings || {};
  const allKeys = Object.keys(schema);
  if (!allKeys.length) return { error: '这个扩展没有可配置项' };
  // internal 字段（列表/对象类）不渲染成表单，但仍要列出来并说明去哪改，
  // 否则用户会以为"这个设置根本不存在"
  const internalKeys = allKeys.filter((k) => schema[k]?.type === 'internal');
  const keys = allKeys.filter((k) => schema[k]?.type !== 'internal');

  const fieldHtml = (key) => {
    const d = schema[key] || {};
    const v = values[key] ?? d.default ?? '';
    const hint = d.description ? `<div class="hint">${esc(d.description)}</div>` : '';
    const id = `skset-${esc(skillId)}-${esc(key)}`;
    const isSecret = d.secret === true;
    const isWide = d.type === 'string' && (d.multiline === true || String(d.description || '').length > 60);
    const cls = 'field' + (isWide ? ' field--wide' : '');
    let input;
    if (d.type === 'boolean') {
      input = `<label class="skill-toggle-row">
        <input type="checkbox" id="${id}" data-key="${esc(key)}" data-type="boolean" ${v ? 'checked' : ''} />
        <span class="st-text">${v ? '已开启' : '已关闭'}</span>
      </label>`;
    } else if (d.type === 'number') {
      input = `<input type="number" id="${id}" data-key="${esc(key)}" data-type="number" value="${esc(v)}" step="any" />`;
    } else if (d.type === 'enum' && Array.isArray(d.values)) {
      input = `<select id="${id}" data-key="${esc(key)}" data-type="enum">${
        d.values.map((x) => `<option value="${esc(x)}" ${String(v) === String(x) ? 'selected' : ''}>${esc(x)}</option>`).join('')
      }</select>`;
    } else {
      input = `<input type="${isSecret ? 'password' : 'text'}" id="${id}" data-key="${esc(key)}" data-type="string" value="${isSecret ? '' : esc(v)}" placeholder="${isSecret ? (v ? '已设置（留空 = 不修改）' : '未设置') : ''}" autocomplete="off" />`;
    }
    return `<div class="${cls}"><label>${esc(d.label || key)}${isSecret ? ' 🔒' : ''}</label>${input}${hint}</div>`;
  };

  return { html: `<div class="modal skill-modal" role="dialog" aria-modal="true" aria-label="${esc(skill.name)} 设置">
    <div class="skill-modal__head">
      <div class="skill-modal__titles">
        <div class="skill-modal__name">${esc(skill.name)}<span class="skill-modal__ver">v${esc(skill.version || '')}</span></div>
        <div class="skill-modal__id">${esc(skillId)}</div>
        <div class="skill-modal__desc">${esc(skill.description || '（这个扩展没有写介绍）')}</div>
      </div>
      <button class="icon-btn" id="skset-x" title="关闭" aria-label="关闭">✕</button>
    </div>
    <div class="skill-modal__body">
      <div class="skill-modal__note">共 <b>${keys.length}</b> 项设置 · 保存在 <code>config.skills['${esc(skillId)}']</code>，只有这个扩展会读到它们。</div>
      <div class="skill-form">${keys.map(fieldHtml).join('')}</div>
      ${internalKeys.length ? `<div class="skill-modal__internal">
        <div class="skill-modal__internal-head">以下设置不在这里改</div>
        ${internalKeys.map((k) => `<div class="skill-modal__internal-item"><b>${esc(schema[k].label || k)}</b><br />${esc(schema[k].description || '')}</div>`).join('')}
      </div>` : ''}
    </div>
    <div class="skill-modal__foot">
      <span class="skill-modal__foot-tip">改动即时生效，无需重启</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="skset-cancel">取消</button>
      <button class="btn btn-primary" id="skset-save">保存</button>
    </div>
  </div>` };
}

/**
 * 技能/插件的配置表单：**就地展开**（UI 改造第二阶段 条目 4 改动点 6）。
 *
 * 方案原文："「设置（N）」改「配置（N）」，**行内展开配置表单**"。
 * ⇒ 原来是弹 modal。改成在卡片内展开。
 *
 * ⚠️ 实现上**不重写表单**：复用 `renderSkillSettingsModal()` 产出的同一份 HTML，
 *    只把它的 `.skill-modal__body` 与 `.skill-modal__foot` 抽出来放进就地容器。
 *    理由：表单字段的渲染规则（boolean/number/enum/secret、internal 字段的兜底说明）
 *    有一大堆细节，写第二份必然漂移 —— 而漂移的症状是"某个类型的字段在就地表单里
 *    长得不一样/存不进去"，很难查。
 * ⚠️ 就地版**不能复用 modal 的 aid`id**：`#skset-save` / `#skset-cancel` /
 *    `#skset-x` 是 modal 的固定 id，同页同时只应有一个。就地表单用自己的 id
 *    （`skinline-*`），并且**不渲染关闭按钮** —— 再点一次「配置」就是收起。
 * ⚠️ 同一时刻只允许展开一个：展开前把别的 `.skill-cfg-inline` 清空并收起
 *    （否则页面上会出现两份带相同 `data-key` 的表单，保存时按卡片查询会串）。
 */
function openSkillSettingsInline(skillId, btn) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const host = document.querySelector(`.skill-cfg-inline[data-cfg-for="${CSS.escape(skillId)}"]`);
  if (!host) return;

  // 已经展开 ⇒ 再点一次收起（按钮是切换语义，与折叠块一致）
  if (!host.hidden) {
    host.hidden = true;
    host.innerHTML = '';
    if (btn) btn.textContent = btn.dataset.label || btn.textContent;
    return;
  }

  // 收起别的卡片上已展开的表单，避免同页两份带相同 data-key 的表单
  for (const other of document.querySelectorAll('.skill-cfg-inline:not([hidden])')) {
    other.hidden = true;
    other.innerHTML = '';
  }

  const built = renderSkillSettingsModal(skill);
  if (built.error) {
    host.hidden = false;
    host.innerHTML = `<div class="safetybar"><span>⚠️</span><span>${esc(built.error)}</span></div>`;
    return;
  }
  // 从同一份 HTML 里抠出 body 与 foot（不重写表单）
  const tmp = document.createElement('div');
  tmp.innerHTML = built.html;
  const bodyHtml = tmp.querySelector('.skill-modal__body')?.innerHTML || '';
  const footHtml = tmp.querySelector('.skill-modal__foot')?.innerHTML || '';

  host.hidden = false;
  host.innerHTML = `<div class="skinline">
    <div class="skinline-head">
      <b>${esc(skill.name)}</b> <span class="muted">配置</span>
      <span class="ph-spacer"></span>
      <span class="muted" style="font-size:12px">改动即时生效，无需重启</span>
    </div>
    ${bodyHtml}
    <div class="skinline-foot">
      <span class="muted" style="font-size:12px">保存在 <code>config.skills['${esc(skillId)}']</code></span>
      <span class="ph-spacer"></span>
      <button class="btn btn-small" id="skinline-cancel">取消</button>
      <button class="btn btn-primary" id="skinline-save">保存</button>
    </div>
  </div>`;
  if (btn) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.textContent = '收起';
  }
  // 齿轮按钮点进来时页面会跳一下，把表单滚进视野（否则用户以为没反应）
  try { host.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }

  const close = () => {
    host.hidden = true;
    host.innerHTML = '';
    if (btn) btn.textContent = btn.dataset.label || '配置';
  };
  host.querySelector('#skinline-cancel')?.addEventListener('click', close);
  // 布尔字段旁边的"已开启/已关闭"要跟着变，否则看不出当前状态
  host.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });
  host.querySelector('#skinline-save')?.addEventListener('click', async (ev) => {
    const saveBtn = ev.currentTarget;
    saveBtn.disabled = true;
    // ⚠️ 只在**本卡片**内按 data-key 取值：同页有多个卡片，全局 querySelectorAll
    //    会把别的卡片的字段一起收进来（那就是"改 A 存 B"）。
    const settings = {};
    host.querySelectorAll('[data-key]').forEach((el) => {
      const type = el.dataset.type;
      if (type === 'boolean') settings[el.dataset.key] = el.checked;
      else if (type === 'number') {
        const num = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(num)) settings[el.dataset.key] = num;
      } else settings[el.dataset.key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      await api(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'POST', body: JSON.stringify({ settings }) });
      await loadSkillsStatus();
      renderSkillsPage();   // 重绘后表单自然收起（新 DOM 里 .skill-cfg-inline 是 hidden）
    } catch (err) {
      saveBtn.disabled = false;
      alert(`保存失败：${err.message}`);
    }
  });
}

function openSkillSettings(skillId) {
  const skill = (state.skills || []).find((x) => x.id === skillId);
  if (!skill) return;
  const built = renderSkillSettingsModal(skill);
  if (built.error) { alert(built.error); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = built.html;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#skset-x').addEventListener('click', close);
  overlay.querySelector('#skset-cancel').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  overlay.setAttribute('tabindex', '-1');
  overlay.focus();

  // 复选框旁的"已开启/已关闭"要跟着变，否则看不出当前状态
  overlay.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const span = cb.parentElement?.querySelector('.st-text');
      if (span) span.textContent = cb.checked ? '已开启' : '已关闭';
    });
  });

  overlay.querySelector('#skset-save').addEventListener('click', async () => {
    const settings = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      const type = el.dataset.type;
      if (type === 'boolean') settings[el.dataset.key] = el.checked;
      else if (type === 'number') {
        const n = Number(el.value);
        // 空值/非数字：不提交这个键，让后端保留原值（而不是写进一个 NaN）
        if (el.value.trim() !== '' && Number.isFinite(n)) settings[el.dataset.key] = n;
      } else settings[el.dataset.key] = el.value;   // secret 留空 → 后端按"不修改"处理
    });
    try {
      await api(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'POST', body: JSON.stringify({ settings }) });
      await loadSkillsStatus();
      renderSkillsPage();
      close();
    } catch (err) {
      alert(`保存失败：${err.message}`);
    }
  });
}

// ── 状态栏 ──
async function refreshStatus() {
  try {
    state.status = await api('/api/status');
    const s = state.status;
    // 顶栏那颗点与文案**跟着当前平台走**（见 updatePlatformStatusLabel 的注释：
    // 在微信模式下显示 QQ 的连接状态会误导）。这里不再直接写死 OneBot 文案。
    updatePlatformStatusLabel();
    $('#model-label').textContent = `模型：${s.orchestrator.model || '未设置'}`;
    const u = s.usage;
    // 成本：官方价匹配得上就显示；匹配不上（中转站常见）只显示 token，不显示误导性的 ¥0
    const c = s.cost;
    const costTxt = c && c.cost > 0 ? ` · ¥${c.cost.toFixed(3)}` : '';
    const rate = s.cacheHitRate;
    const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
    $('#usage-label').textContent = `今日：${u.runs} 次运行 · ${fmtTokens(u.totalTokens)}${rateTxt}${costTxt}`;
    $('#search-count-label').textContent = `搜索：${s.webSearchCount ?? u.webSearchCount ?? 0} 次`;
    state.paused = s.paused;
    state.pauseReason = s.pauseReason;
    $('#pause-btn').textContent = state.paused ? '恢复' : '暂停';
    renderBanner();
  } catch (e) { /* 忽略瞬时错误 */ }
}

function fmtTokens(n) {
  n = Number(n) || 0;
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k tok` : `${n} tok`;
}

$('#pause-btn').addEventListener('click', async () => {
  if (state.paused) {
    await resumePause({ skipBacklog: false });
  } else {
    await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: true }) });
    refreshStatus();
  }
});

// ── 会话渲染合批 ──
// 运行中的会话 SSE 事件非常密：每轮"正在思考…"开/关两次 + 每个工具调用一次。
// 曾经来一条事件就全量重建一次会话列表 + 会话详情（含大提示词的 esc/innerHTML），
// 主线程被反复长阻塞，详情内容反而"更新缓慢"、还伴随滚动跳动。
// 现在：patch 立即进 state（数据不延迟），渲染合并到短定时器一次；
// 窗口内的多次事件只渲染最终状态（中间的 activity 翻转根本不必上屏）。
//
// ⚠️ 用 setTimeout 而不是 requestAnimationFrame：
//    窗口被遮挡/最小化时 Chromium 会完全停发 rAF，渲染全部积压到切回前台
//    才一次性出现 —— 用户看到的就是"不手动刷新就不更新"。
//    setTimeout 在后台页面仍会执行（最多被节流到 1s），远比不执行强。
const pendingSessionDetail = new Map();   // sessionId -> 合并后的 patch
let sessionRenderScheduled = false;

function scheduleSessionRender() {
  if (sessionRenderScheduled) return;
  sessionRenderScheduled = true;
  setTimeout(() => {
    sessionRenderScheduled = false;
    if (state.tab === 'sessions') renderSessionList();
    const id = state.currentSessionId;
    const patch = id ? pendingSessionDetail.get(id) : null;
    pendingSessionDetail.clear();
    if (patch && state.tab === 'sessions') {
      // 详情用事件里的消息流渲染：HTTP 详情（systemPrompt 等）打底，SSE patch 覆盖动态字段。
      // sent/finishReason 等收尾字段 patch 优先 —— 它们走 SSE 实时推，HTTP 详情里的是旧值。
      renderSessionDetail({
        ...(state.sessionDetail || {}),
        ...patch,
        triggerSummary: patch.triggerSummary ?? state.sessionDetail?.triggerSummary ?? '',
        systemPrompt: state.sessionDetail?.systemPrompt ?? '',
        userPrompt: state.sessionDetail?.userPrompt ?? '',
        sent: patch.sent ?? state.sessionDetail?.sent ?? [],
        error: patch.error !== undefined ? patch.error : (state.sessionDetail?.error ?? null),
        finishReason: patch.finishReason ?? state.sessionDetail?.finishReason ?? null,
        endedAt: patch.endedAt ?? state.sessionDetail?.endedAt ?? null
      });
    }
  }, 80);
}

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/api/events');
  es.addEventListener('session-start', () => {
    loadSessions();
    refreshStatus();
    // 自动跟随新会话（等待中/运行中）
    if (state.autoFollowRunning) {
      loadSessions({ quiet: true }).then(() => {
        const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
        if (active && active.id !== state.currentSessionId) selectSession(active.id);
      });
    }
  });
  es.addEventListener('session-update', (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    const id = data.sessionId;
    if (!id) return;
    // SSE 事件本身携带完整会话快照：patch 立即进 state，渲染走合批（见上）
    const patch = {
      id,
      chatKey: data.chatKey || '',
      status: data.status,
      waitUntil: data.waitUntil ?? null,
      activity: data.activity || '',
      webSearchCount: data.webSearchCount || 0,
      rounds: data.rounds || 0,
      usage: data.usage || null,
      messages: data.messages || [],
      triggerSummary: data.triggerSummary ?? '',
      startedAt: data.startedAt ?? 0
    };
    // sent/finishReason 等收尾字段：后端给了才进 patch。
    // 不能无脑写 null —— pending 合并时 null 会把之前已有的值冲掉。
    if (Array.isArray(data.sent)) patch.sent = data.sent;
    if (data.finishReason !== undefined) patch.finishReason = data.finishReason;
    if (data.error !== undefined) patch.error = data.error;
    if (data.endedAt !== undefined) patch.endedAt = data.endedAt;
    const existing = state.sessions.find((s) => s.id === id);
    if (existing) {
      Object.assign(existing, patch);
    } else {
      state.sessions.unshift({ ...patch, trigger: data.trigger || '', triggerSummary: data.triggerSummary || '', startedAt: data.startedAt ?? Date.now() });
      // 上限要大于一次可取的数量，否则新会话一进来就把旧的挤没了
      state.sessions = state.sessions.slice(0, SESSION_KEEP);
    }
    // 详情 patch 合并暂存，渲染合批到每帧一次（不再来一条事件全量重建一次）
    pendingSessionDetail.set(id, { ...pendingSessionDetail.get(id), ...patch });
    scheduleSessionRender();
  });
  es.addEventListener('session-end', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { /* 数据坏了也照常刷列表 */ }
    loadSessions();
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
    // ⚠️ 会话刚结束必须主动重拉一次详情：轮询只刷 running/waiting 的会话，
    //    最终态（sent / finishReason / error）之后再也不来 —— 不重拉的话，
    //    "已发送到 QQ"徽标和收尾状态只能等用户手动刷新才出现。
    const id = data.sessionId;
    if (id && id === state.currentSessionId) {
      pendingSessionDetail.delete(id);   // 丢弃残留的过期 patch，防止把刚拉的最终态回闪成旧值
      loadSessionDetail(id, { quiet: true });
    }
  });
  es.addEventListener('chat-update', () => {
    if (state.tab === 'chats') loadChats({ quiet: true });
    refreshStatus();
  });
  es.addEventListener('memory-update', (ev) => {
    let data = {};
    try { data = JSON.parse(ev.data); } catch { data = { phase: 'refresh' }; }
    const phase = data.phase || '';
    const chatKey = data.chatKey || '';

    // 状态一律记进 state（不依赖当前 DOM），这样切走页签再切回也能恢复显示。
    // 原先只操作 DOM 且 tab 不对就 return，导致切回来完全看不出整理是否还在跑。
    if (phase === 'consolidate-start') {
      if (chatKey) state.consolidating[chatKey] = { startedAt: Date.now() };
    } else if (phase === 'consolidate-done') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) state.consolidateResult[chatKey] = { note: data.note || '整理完成', at: Date.now() };
    } else if (phase === 'consolidate-error') {
      if (chatKey) delete state.consolidating[chatKey];
      if (chatKey) {
        state.consolidateResult[chatKey] = { note: `整理失败：${data.error || '未知错误'}`, at: Date.now(), failed: true };
      }
    }

    // 只有停在记忆页时才操作 DOM / 刷新列表
    if (state.tab !== 'memory') return;

    if (phase === 'consolidate-start') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = true;
      if (status) status.textContent = '整理中…';
      renderMemoryList();
    } else if (phase === 'consolidate-done') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = data.note || '整理完成';
      loadMemoryView();
    } else if (phase === 'consolidate-error') {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      if (btn) btn.disabled = false;
      if (status) status.textContent = `整理失败：${data.error || '未知错误'}`;
      renderMemoryList();
    } else {
      loadMemoryView();
    }
  });
  es.addEventListener('onebot-status', () => {
    refreshStatus();
    if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
  });
  es.addEventListener('status', () => refreshStatus());
  es.addEventListener('snowluma-status', () => { refreshStatus(); if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true }); });
  es.addEventListener('snowluma-log', (ev) => {
    // ⚠️ 必须带守卫：这个监听器**在首屏完成前就会收到日志帧**，而它下面
    //    第一件事就是 setLoadingStatus()。原来这里裸 JSON.parse，一旦收到
    //    半截/非 JSON 帧就抛 SyntaxError 把整段回调打断（同一帧的处理直接
    //    没了），首屏就停在"加载中…"不动 —— 症状和项目坑里记的"页面卡在
    //    加载中"一模一样，很难往"一行日志解析失败"上想。
    //    这个文件里其它 SSE 监听器（1192/1229/1248 行）**都已经**这样包了，
    //    只有这两处漏掉。来源：上游 audit-round1 的 L-4【B】。
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.level === 'error') console.warn('[agent 反馈]', d.message);
  });
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// ── 会话视图 ──
async function loadSessions({ quiet = false } = {}) {
  try {
    // 一次全取：后端上限 2^20（约等于不限），前端靠分页渲染（SESSION_PAGE）避免卡顿
    const data = await api('/api/sessions?limit=1048576');
    state.sessions = data.sessions || [];
    // 顺手刷新"chatKey → 平台"映射表：会话条目本身没有 source，只能靠它筛。
    // 只在还没有表时取（它在 loadChats 里也会刷），免得每 4 秒多打一个接口。
    if (!state.sourceMap) await refreshSourceMap();
    renderSessionList();
    // 自动跟随最新运行中的会话
    if (state.autoFollowRunning && !state.currentSessionId) {
      const active = state.sessions.find((s) => s.status === 'waiting' || s.status === 'running');
      if (active) selectSession(active.id);
    }
    // 当前打开的会话在等待/运行中时，也顺手刷新详情
    if (state.currentSessionId) {
      const cur = state.sessions.find((s) => s.id === state.currentSessionId);
      if (cur && (cur.status === 'running' || cur.status === 'waiting')) {
        loadSessionDetail(state.currentSessionId, { quiet: true });
      }
    }
  } catch (e) { if (!quiet) console.error(e); }
}

// 会话列表定时刷新：只要停在会话页，就持续更新列表（运行中会话也会轮询详情）
// 间隔取自配置的 ui.refreshMs（设置页「界面刷新间隔」）；此前这里硬编码 4000，
// 配置项从未被读取 —— 用户改了完全没效果。
let listPoller = null;
function refreshIntervalMs() {
  const n = Number(state.config?.ui?.refreshMs);
  return Number.isFinite(n) && n >= 1000 ? n : 4000;
}
/**
 * 给滚动容器挂"滚到底部就加载更多"的监听。
 *
 * 要点：
 *   1. 节流必须带"尾随调用"：曾经是被节流的事件直接丢弃 —— 快速滚动时
 *      事件密集，"抵达底部"那一下几乎总是落在 120ms 窗口内被扔掉，
 *      用户停手后又不会再有新事件 → 加载永远不触发，表现为
 *      "滚得快会滚不下去，像撞墙"。现在窗口内的事件会留下一个尾随定时器，
 *      停手后最多 120ms 内补一次检查。
 *   2. 距底部 <400px 就触发（曾经是 100px）：快速甩滚时惯性大，
 *      100px 的提前量太小，内容还没加载出来人已经撞底了。
 *   3. 交给 onLoadMore 自己判断是否真有更多数据；没有就直接返回，避免空转重渲染
 */
function attachScrollLoader(elId, onLoadMore) {
  const el = document.getElementById(elId);
  if (!el) return;

  // ⚠️ 防重复绑定：这个函数会被多次调用（渲染一次调一次），
  //    曾经没做防护，结果加载 N 批就挂了 N 个监听器 ——
  //    滚一次会同时触发 N 次 onLoadMore，一次跳好几批，
  //    而且每个监听器各有自己的 last 变量，120ms 节流形同虚设。
  //    这里把状态存在元素自身上，重复调用直接复用。
  if (el.__scrollLoader) {
    el.__scrollLoader.onLoadMore = onLoadMore;   // 只更新回调，不重复挂监听
    return;
  }
  const stateLoader = { last: 0, pending: null, onLoadMore };
  el.__scrollLoader = stateLoader;

  const THROTTLE_MS = 120;
  const NEAR_BOTTOM_PX = 400;
  const check = () => {
    stateLoader.last = Date.now();
    // scrollTop + 可视高度 >= 总高度 - 400 就认为快到底了
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - NEAR_BOTTOM_PX) stateLoader.onLoadMore();
  };

  el.addEventListener('scroll', () => {
    const elapsed = Date.now() - stateLoader.last;
    if (elapsed >= THROTTLE_MS) {
      // 窗口外的正常事件：立即处理；有尾随定时器就取消（避免重复检查）
      if (stateLoader.pending) { clearTimeout(stateLoader.pending); stateLoader.pending = null; }
      check();
    } else if (!stateLoader.pending) {
      // 窗口内被节流的事件：不丢，留一个尾随调用 —— 停手后补做最后一次检查
      stateLoader.pending = setTimeout(() => { stateLoader.pending = null; check(); }, THROTTLE_MS - elapsed);
    }
  }, { passive: true });
}

/** 会话列表：滚到底部再加载 SESSION_PAGE 条。 */
function initSessionScrollLoader() {
  attachScrollLoader('session-list', () => {
    const all = state.sessions || [];
    if (state.sessionLimit >= all.length) return;   // 已经全显示了
    state.sessionLimit = Math.min(all.length, state.sessionLimit + SESSION_PAGE);
    // 🔴 只**追加**新的一批，不再整块重建。
    //    原先是 renderSessionList()，而它是 box.innerHTML = 全部条目 ——
    //    ⇒ 每滚一批，把**已经渲染过的全部**重新生成一遍，成本随条数二次增长。
    //    实测（1680×1050，会话 1335 条）：50 条 → 6ms、100 条 → 22ms、
    //    200 条 → 50ms、400 条 → 62ms、800 条 → 142ms；
    //    "滚到底加载一批"整整 **73.6ms 主线程阻塞** ⇒ 越滚越顿。
    //    这个坑项目里记过（存档页为此专门写了 appendChatMessageRows），
    //    会话列表这一条一直没改。现在对齐同一套做法。
    appendSessionRows();
  });
}

/**
 * 存档页消息列表：滚到底部再追加 CHAT_MSG_MORE 条。
 *
 * ⚠️ 监听目标是 #chat-detail —— 它自带 .detail-pane 类（overflow-y:auto），
 *   是真正滚动的容器。曾经在它内部又套了一层 .archive-scroll 想做内层滚动，
 *   结果内层没有高度基准、被内容撑开，滚动事件全发生在外层，
 *   导致监听挂空、"继续滚动没反应"。现在只保留一层滚动容器。
 *
 * ⚠️ 加载更多只走"追加"（appendChatMessageRows）：
 *   曾经这里调 updateChatMessagesBody(true)，每批都要全量 sort + 全量
 *   innerHTML 重建（行数越滚越多），还有 scrollTop 补偿把视口"吸"在底部
 *   → 连锁触发下一批加载 → 主线程被反复长阻塞，
 *   表现为"滑到临界线继续向下滚动反应迟钝"。
 */
function initChatScrollLoader() {
  attachScrollLoader('chat-detail', () => {
    const total = (state.chatMessages || []).length;
    const prev = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
    if (prev >= total) return;                     // 已经全显示了
    state.chatMsgLimit = Math.min(total, prev + CHAT_MSG_MORE);
    // 行数账本对不上（结构刚被轮询重建过等异常）→ 全量兜底；正常走追加
    if ((state.chatMsgRendered || 0) !== Math.min(prev, total)) {
      updateChatMessagesBody(true);
    } else {
      appendChatMessageRows(prev);
    }
  });
}

function startListPoller() {
  if (listPoller) clearInterval(listPoller);
  listPoller = setInterval(() => {
    if (state.tab === 'sessions') loadSessions({ quiet: true });
    if (state.tab === 'chats') loadChats({ quiet: true });
    if (state.tab === 'snowluma') loadSnowlumaPage({ quiet: true });
    if (state.tab === 'wechat') loadWechatPage();   // 只重建状态区，日志框只更新文本（见那一页的约束 2）
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}
startListPoller();

/**
 * 会话侧栏的本地过滤（阶段 C2）：关键词 + 状态。
 *
 * 设计取舍 —— **为什么在数据层过滤，而不是像原型那样切 display**：
 *   原型（index.prototype.html 的 applySessionFilter）是对已渲染的行
 *   `el.style.display = 'none'`。线上列表有分页（SESSION_PAGE/SESSION_PAGE），
 *   切 display 只会过滤"当前已经渲染出来的那一批"：关键词命中的会话若在第 2 页，
 *   用户搜不到；而且 `#session-count` 的「已显示/总数」与
 *   「向下滚动加载更多（还有 N 条）」的 N 都会算错 —— 正是本项目反复踩的
 *   「显示的数字与实际不符」。放在这里过滤，分页与两个数字天然一致。
 *
 * 关键词范围：群名/好友名、触发内容、chatKey。
 *   `formatChatTitle(chatKey, chatNameOf(chatKey))` 与列表行上**印出来的字符串
 *   同源**，用户"照着自己看到的字去搜"必然命中，不会出现"屏幕上明明有这几个字
 *   却搜不到"。
 *
 * 状态口径（4 档，覆盖全部可能的 status，不漏项）：
 *   all      全部
 *   active   进行中 = running | waiting
 *   ended    已结束 = done | error | aborted | 以及任何未知/空状态
 *   noreply  未回复 = noreply
 *   ⚠️ 若把「已结束」写成 `status === 'done'`，那么 error/aborted 的会话
 *      在不选「全部」时会**静默消失**。所以这里用"排除法"兜底：不属于
 *      active、也不是 noreply 的一律算已结束。
 */
function matchSessionFilter(s, query, filter) {
  if (filter === 'active') {
    if (s.status !== 'running' && s.status !== 'waiting') return false;
  } else if (filter === 'ended') {
    if (s.status === 'running' || s.status === 'waiting' || s.status === 'noreply') return false;
  } else if (filter === 'noreply') {
    if (s.status !== 'noreply') return false;
  }
  if (!query) return true;
  const text = `${formatChatTitle(s.chatKey, chatNameOf(s.chatKey))} ${s.chatKey || ''} ${s.trigger || ''}`.toLowerCase();
  return text.includes(query);
}

/** 把 state.sessionFilter 落到 DOM（胶囊选中态 + 输入框值，防止重建后视觉不同步）。 */
function syncSessionFilterUI() {
  const q = state.sessionFilter.query || '';
  const f = state.sessionFilter.status || 'all';
  const input = $('#session-filter-input');
  if (input && input.value !== q) input.value = q;
  $$('#session-filters .chip').forEach((el) => {
    el.classList.toggle('on', (el.dataset.v || 'all') === f);
  });
}

/**
 * 绑定侧栏搜索/筛选（**只绑一次**）。
 *
 * ⚠️ 这两个元素是 index.html 里的常驻元素，不在 #session-items 内 —— 列表每
 *    15 秒被整体 innerHTML 重建一次，若把监听器挂在重建范围里就会丢。
 *    与 renderSessionList 末尾那两个 `__bound` 守卫同一个道理。
 * ⚠️ 输入用 debounce：每敲一个字符都重排列表会让人输入发涩，而且
 *    renderSessionList 是整块 innerHTML 重建。150ms 与项目其它处的节流同量级。
 */
function initSessionFilter() {
  // 兜底：state 里没有这个键（例如别处重建过 state）也不至于在这里抛错
  if (!state.sessionFilter) state.sessionFilter = { query: '', status: 'all' };
  const input = $('#session-filter-input');
  if (input && !input.__bound) {
    input.__bound = true;
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const q = input.value.trim().toLowerCase();
        if (q === (state.sessionFilter.query || '')) return;   // 没变就别重建
        state.sessionFilter.query = q;
        state.sessionLimit = SESSION_PAGE;                     // 换过滤条件 → 回到第一页
        renderSessionList();
      }, 150);
    });
  }
  const bar = $('#session-filters');
  if (bar && !bar.__bound) {
    bar.__bound = true;
    // 事件委托：胶囊是静态的，但用委托可以让将来加档不必再动这里
    bar.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const v = chip.dataset.v || 'all';
      if (v === (state.sessionFilter.status || 'all')) return;  // 重复点同一档不重建
      state.sessionFilter.status = v;
      state.sessionLimit = SESSION_PAGE;
      syncSessionFilterUI();
      renderSessionList();
    });
  }
  syncSessionFilterUI();
}

/* ══════════════════════════════════════════════════════════════════════════
   UI 改造第二阶段 · 五个全局共享组件（2026-09-22）
   依据《QQ Agent UI 改造实施方案（第二阶段）》v1.0 §一「通用设计原则」。
   方案原文：「这五条原则在多个页面反复出现，请落实为**全局共享组件与规范，
   不要各页面各写各的**」。所以它们都放在这里，页面只调用、不自己拼 HTML。

   ⚠️ 设计取舍：这五个组件都是**纯函数返回 HTML 字符串**，不是 class/自定义元素。
      理由：① 整个 ui/app.js 就是这个风格（renderXxx 返回模板串），混两套写法更难维护；
      ② 自定义元素要处理生命周期与属性同步，对这几个静态结构是过度设计；
      ③ 字符串模板能被现有测试的"读源码文本"方式覆盖到。
      需要交互的部分（开关、折叠、过滤）由**事件委托**在各自页面的接线处统一处理，
      组件本身只管长相。

   ⚠️ 组件之间的取值口径（三态色）只在这里定义一份 —— 各页别再自己写
      `ok ? 'green' : 'red'` 这类判断，否则三态语义必然漂移。
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 组件 1：StatusBadge —— 状态一律徽章化。
 *
 * 🔴 方案原则 2：**禁止用按钮样式表达状态**（点名反例：SnowLuma 页那个「已运行」蓝色按钮
 *    —— 它其实是可点击的启停开关，但长得像状态，用户不知道该不该点）。
 *    三态固定：红=异常/断开、琥珀=警告/中间态、绿=正常/连通。
 *
 * ⚠️ 徽章**不是按钮**：用 span 渲染、不带 tabindex、不带点击。
 *    要点击的开关请用 `.toggle`（见 toggleHtml），别往徽章上挂事件 ——
 *    那正是方案要消除的"状态与操作混在一起"。
 *
 * @param {'ok'|'warn'|'err'|'off'|'busy'} tone
 * @param {string} text 徽章文字（如「运行中」「未连接」）
 */
function statusBadge(tone, text) {
  const t = ['ok', 'warn', 'err', 'off', 'busy'].includes(tone) ? tone : 'off';
  // busy 用琥珀底 + 呼吸点，表达"正在连接/进行中"这个中间态
  const cls = t === 'busy' ? 'warn busy' : t;
  return `<span class="sbadge ${cls}"><span class="sdot"></span>${esc(text)}</span>`;
}

/**
 * 组件 2：InfoHint —— 说明文档与操作界面分层。
 *
 * 🔴 方案原则 1：主界面任何区块**最多保留一行说明文字**，细节一律进 ⓘ 气泡或折叠区。
 *    判断标准：说明是在解释"怎么用"⇒ 下沉；**安全警告保留可见**（如热重载执行 .js，
 *    那个用 `safetyBar`，不要塞进 ⓘ）。
 *
 * 用法：`${hintLine('只记录想法，不会自动执行', '采纳流程：…；SnowLuma 链接：…')}`
 *   →  一行灰字 + 一个可悬浮/可聚焦的 ⓘ。
 *
 * ⚠️ 用原生 `title` 属性做气泡：零 JS、读屏软件可识别、不引入新的层级/定位问题。
 *    代价是不能富文本 —— 但方案要的就是"一句话 + 细节"，纯文本够用；
 *    真要富文本的场合本来就该用折叠区（`devnotes`）。
 * ⚠️ `title` 里的换行在气泡里会原样显示，所以 detail 用 '；' 分隔而不是拼 \n。
 */
function hintLine(line, detail) {
  const dot = detail
    ? `<span class="ihint" role="note" tabindex="0" title="${esc(detail)}" aria-label="${esc(detail)}">i</span>`
    : '';
  return `<div class="ihint-line">${esc(line)}${dot}</div>`;
}

/**
 * 组件 3：Stepper —— 交互式分步器。
 *
 * 方案对 SnowLuma / 微信页的要求：序号 + 标题 + 一句说明 + 动作按钮；
 * 实时进度；**未到步骤置灰**。
 *
 * @param {Array<{title:string, desc?:string, state:'done'|'active'|'todo', actionHtml?:string, note?:string}>} steps
 * @returns {string} HTML
 * ⚠️ `actionHtml` 由调用方给（按钮的 id/事件各不相同），组件不猜。
 *    但 `todo` 态的按钮会被 CSS 置灰并 `pointer-events:none` —— 这样即使调用方
 *    忘了禁用，用户也点不动（双保险）。
 */
function stepperHtml(steps) {
  const rows = (steps || []).map((s, i) => {
    const st = ['done', 'active', 'todo'].includes(s.state) ? s.state : 'todo';
    // 已完成显示 ✓ 而不是序号 —— 一眼能看出"走到哪了"
    const num = st === 'done' ? '✓' : String(i + 1);
    return `<div class="step ${st}">
      <span class="step-num">${num}</span>
      <div class="step-body">
        <div class="step-title">${esc(s.title)}${s.note ? ` <span class="step-note">${esc(s.note)}</span>` : ''}</div>
        ${s.desc ? `<div class="step-desc">${esc(s.desc)}</div>` : ''}
      </div>
      ${s.actionHtml ? `<div class="step-action">${s.actionHtml}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="stepper">${rows}</div>`;
}

/**
 * 组件 4：LogPanel —— 所有日志区统一。
 *
 * 方案原则 5：分级过滤（全部/关键/警告/错误）+ 搜索 + 复制 + 清空 +
 * 自动滚动 + ★关键行高亮 + 噪音折叠。
 *
 * 用法（两步）：
 *   ① 页面的静态骨架里放 `logPanelShell('日志标题', 'lp1')`
 *   ② 拿到日志文本后用 `logPanelRows(text, 'lp1')` 渲染行
 *   ③ 用 `initLogPanel('lp1')` 接线（过滤/搜索/复制/清空/自动滚动）——只需调一次
 *
 * ⚠️ 分级判据（**唯一一份，别在页面里重写**）：
 *    · 含 ★ 或「初始密码」「密码」⇒ key（橙色高亮 + 默认在"关键"档显示）
 *    · 含 error/fail/exception/refused/timeout/失败/错误 ⇒ error 档
 *    · 含 warn/警告 ⇒ warn 档
 *    · 其余为 info；连续重复行（≥3 次同样内容）标 noise，可一键折叠
 *   方案点名"噪音刷屏淹没 ★ 初始密码等关键行"，所以 key 的判据必须**优先于** error。
 */
function logLevelOf(line) {
  const t = String(line);
  if (t.includes('★') || /初始密码|访问密码|password/i.test(t)) return 'key';
  if (/error|fail|exception|refused|timeout|失败|错误|异常/i.test(t)) return 'error';
  if (/warn|警告|注意/i.test(t)) return 'warn';
  return 'info';
}

/** LogPanel 的静态骨架（页头工具 + 空的日志体）。 */
function logPanelShell(title, idPrefix, opts = {}) {
  const tabs = [['all', '全部'], ['key', '关键'], ['warn', '警告'], ['error', '错误']]
    .map(([v, label]) => `<span class="chip${v === 'all' ? ' on' : ''}" data-logtab="${v}">${label}</span>`).join('');
  return `<div class="logpanel" id="${idPrefix}">
    <div class="logpanel-head">
      <span class="logpanel-title">${esc(title)}</span>
      <span class="logpanel-tabs">${tabs}</span>
      <span class="logpanel-spacer"></span>
      <input class="logpanel-search" type="search" placeholder="搜索日志" aria-label="搜索日志" data-logsearch>
      <button class="btn btn-small" data-logact="noise" title="折叠连续重复的噪音行">噪音</button>
      <button class="btn btn-small" data-logact="scroll" title="有新日志时自动滚到底部">自动滚动</button>
      <button class="btn btn-small" data-logact="copy">复制</button>
      <button class="btn btn-small btn-quiet" data-logact="clear">清空</button>
    </div>
    <div class="logpanel-body" data-logbody>${opts.emptyText ? `<div class="logpanel-empty">${esc(opts.emptyText)}</div>` : ''}</div>
  </div>`;
}

/** 把一段日志文本渲染成行（含分级与噪音标记）。 */
function logPanelRows(text, idPrefix) {
  const raw = String(text || '').split('\n').filter((l) => l.trim() !== '');
  // 连续重复行 ≥3 次 ⇒ 除第一行外都标 noise（"噪音刷屏"的判据）
  const noiseFlags = raw.map(() => false);
  let i = 0;
  while (i < raw.length) {
    let j = i + 1;
    while (j < raw.length && raw[j] === raw[i]) j++;
    if (j - i >= 3) for (let k = i + 1; k < j; k++) noiseFlags[k] = true;
    i = j;
  }
  return raw.map((line, idx) => {
    const lvl = logLevelOf(line);
    const cls = ['logrow', lvl === 'key' ? 'key' : '', lvl === 'error' ? 'err' : '', noiseFlags[idx] ? 'noise' : '']
      .filter(Boolean).join(' ');
    return `<div class="${cls}" data-lvl="${lvl}">${esc(line)}</div>`;
  }).join('');
}

/**
 * 给一个 LogPanel 接线。**每个 idPrefix 只需调一次**（内部用 `__bound` 防重复）。
 * 过滤/搜索/噪音/自动滚动全部靠 CSS 类 + 行上已有的 data 属性，不重建 DOM ——
 * 日志每 5 秒刷一次，重建会让"正在搜索"的状态丢掉、也会闪。
 */
function initLogPanel(idPrefix) {
  const box = document.getElementById(idPrefix);
  if (!box || box.__bound) return;
  box.__bound = true;
  box.__filter = 'all';
  box.__search = '';
  box.__noise = false;
  box.__autoscroll = true;

  const apply = () => {
    const body = box.querySelector('[data-logbody]');
    if (!body) return;
    const q = box.__search;
    for (const row of body.querySelectorAll('.logrow')) {
      const lvl = row.dataset.lvl || 'info';
      let show = true;
      // 档位：key 档连 error 一起显示（关键行常伴随报错，分开看反而漏）；
      // warn 档显示 warn+error+key；error 档只显示 error+key。这样"越往上越全"。
      if (box.__filter === 'key') show = lvl === 'key' || lvl === 'error';
      else if (box.__filter === 'warn') show = lvl !== 'info';
      else if (box.__filter === 'error') show = lvl === 'error' || lvl === 'key';
      if (show && q) show = row.textContent.toLowerCase().includes(q);
      row.style.display = show ? '' : 'none';
    }
    box.classList.toggle('hide-noise', box.__noise);
    if (box.__autoscroll) body.scrollTop = body.scrollHeight;
  };
  box.__apply = apply;

  box.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-logtab]');
    if (tab) {
      box.__filter = tab.dataset.logtab;
      box.querySelectorAll('[data-logtab]').forEach((c) => c.classList.toggle('on', c === tab));
      apply();
      return;
    }
    const act = e.target.closest('[data-logact]');
    if (!act) return;
    const kind = act.dataset.logact;
    if (kind === 'noise') {
      box.__noise = !box.__noise;
      act.classList.toggle('on', box.__noise);
      apply();
    } else if (kind === 'scroll') {
      box.__autoscroll = !box.__autoscroll;
      act.classList.toggle('on', box.__autoscroll);
      apply();
    } else if (kind === 'copy') {
      const body = box.querySelector('[data-logbody]');
      const text = body ? Array.from(body.querySelectorAll('.logrow'))
        .filter((r) => r.style.display !== 'none').map((r) => r.textContent).join('\n') : '';
      try { await navigator.clipboard.writeText(text); act.textContent = '已复制'; }
      catch { act.textContent = '复制失败'; }
      setTimeout(() => { act.textContent = '复制'; }, 1200);
    } else if (kind === 'clear') {
      // ⚠️ 清空只清**界面显示**，不清后端日志文件 —— 按钮旁已标明，别让它看起来像删了数据
      const body = box.querySelector('[data-logbody]');
      if (body) body.innerHTML = '<div class="logpanel-empty">（已清空显示，后端日志文件未动）</div>';
    }
  });
  box.addEventListener('input', (e) => {
    if (!e.target.matches('[data-logsearch]')) return;
    box.__search = e.target.value.trim().toLowerCase();
    apply();
  });
}

/**
 * 组件 5：Gate —— 连接门控。
 *
 * 方案原则 4：依赖通道连通的操作（群发、联系人放行等），未连通时**整区禁用** +
 *    「去完成连接引导」链接，连通后自动解锁。
 *
 * 用法：`gateWrap(html, { locked, guideTab, guideText })`
 * ⚠️ 锁定用**类**（`.gate.locked > .gate-inner { pointer-events:none }`）而不是
 *    `disabled` 属性 —— 因为整区里有 input/select/button 多种控件，
 *    逐个加 disabled 容易漏（漏了就出现"未连接却可点、点了必失败"，正是方案说的现状问题）。
 * ⚠️ 引导链接**永远可点**：它在 .gate-bar 里，不在被禁用的 .gate-inner 里。
 */
function gateWrap(innerHtml, { locked, guideTab, guideText } = {}) {
  const bar = `<div class="gate-bar"><span>${esc(guideText || '需要先完成连接')}</span>`
    + `<span class="gate-go" data-goto-tab="${esc(guideTab || 'snowluma')}" role="button" tabindex="0">去完成连接引导 →</span></div>`;
  return `<div class="gate${locked ? ' locked' : ''}"><div class="gate-inner">${innerHtml}</div>${bar}</div>`;
}

/**
 * 破坏性操作：次级按钮（方案原则 3"关闭服务、清空数据等操作降为次级按钮"）。
 * ⚠️ 只负责**长相**；二次确认仍必须走既有的 `confirmDanger()` ——
 *    别因为"按钮变低调了"就省掉确认。
 */
function quietBtnHtml(id, text, title) {
  return `<button class="btn btn-small btn-quiet" id="${esc(id)}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</button>`;
}

/** 标准 Toggle（条目 4：对勾改开关 + 已启用/已停用文字）。 */
function toggleHtml(id, checked, onText = '已启用', offText = '已停用', attrs = '') {
  return `<label class="toggle"><input type="checkbox" id="${esc(id)}"${checked ? ' checked' : ''}${attrs ? ' ' + attrs : ''}>`
    + `<span class="tg-track"><span class="tg-knob"></span></span>`
    + `<span class="tg-text">${esc(checked ? onText : offText)}</span></label>`;
}

/** 安全警告条（**保留可见**，不进 ⓘ —— 方案条目 4.2"安全信息不折叠"）。 */
function safetyBar(text) {
  return `<div class="safetybar"><span>⚠️</span><span>${esc(text)}</span></div>`;
}

/**
 * 「去完成连接引导 →」链接的**全局事件委托**（只绑一次）。
 *
 * 为什么用委托而不是逐个绑：Gate 会出现在多个页面（SnowLuma / 微信 / 设置页），
 * 而其中几个区块是每 15 秒重建的（SnowLuma 的 #sl-dyn）。逐个绑就要跟着重建重绑，
 * 漏一处那个链接就变死链 —— 而它恰恰是"用户走投无路时唯一的出口"。
 * ⇒ 绑在 document 上一次，用 data 属性找目标页面，重建多少次都有效。
 * ⚠️ 同时支持键盘（Enter/Space）：它带 role="button" 与 tabindex="0"，
 *    必须真的能用键盘激活，否则那个 role 是在骗读屏软件。
 */
function initGateLinks() {
  if (document.__gateLinksBound) return;
  document.__gateLinksBound = true;
  const go = (el) => {
    const tab = el && el.dataset ? el.dataset.gotoTab : '';
    if (tab && typeof switchTab === 'function') switchTab(tab);
  };
  document.addEventListener('click', (e) => {
    const el = e.target.closest && e.target.closest('[data-goto-tab]');
    if (el) { e.preventDefault(); go(el); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const el = e.target.closest && e.target.closest('[data-goto-tab]');
    if (el) { e.preventDefault(); go(el); }
  });
}

/**
 * 无边框窗口：自绘标题栏的接线（2026-09-22）。
 *
 * 依据《无边框窗口改造实施方案》v1.0。窗口已由 electron/main.js 的 `frame: false`
 * 去掉系统标题栏，所以原生能做的事要在这里补齐：
 *
 *   ① 三个控制按钮 → IPC 到主进程（`window.qqaWin`，由 electron/preload.js 暴露）
 *   ② 顶栏空白区双击 = 最大化 / 还原
 *      （拖拽本身不用 JS：CSS 的 `-webkit-app-region: drag` 由系统接管，见 style.css）
 *   ③ 最大化状态 → 图标切换 + `html.maximized` 类（后者驱动 #shell 去圆角/去边距）
 *
 * ⚠️ 三件必须注意的事：
 *
 *   1）**普通浏览器里没有 `window.qqaWin`** —— 控制台页面在 Edge 里也能打开
 *      （我就是靠它做界面验证的）。所以这里必须优雅降级：把 #win-ctrl 保持
 *      `.hidden`、不绑 dblclick，而不是抛错或显示三个点不动的按钮。
 *      按钮在 HTML 里**默认就带 `hidden` 类**，这里只负责在 Electron 里摘掉它。
 *
 *   2）**状态必须以主进程的推送为准**，不能只跟按钮点击走。用户还能用
 *      Win+↑/↓、任务栏右键、Aero Snap 贴边、双击拖拽区 改变窗口状态 ——
 *      只跟点击走的话图标会与实际状态不一致（方案 §5 列为中风险）。
 *      主进程在 maximize / unmaximize / 全屏切换 / resize 时推 `win:state`。
 *
 *   3）**首帧要主动查一次**：页面可能在窗口已经最大化时被加载（比如重启前就是最大化），
 *      只等推送的话首帧图标是错的。
 */
function initWindowControls() {
  const bridge = window.qqaWin;
  const box = $('#win-ctrl');
  if (!bridge || !box) return;    // 浏览器里就是这条路：什么都不做，保持 hidden

  box.classList.remove('hidden');

  // 图标与外壳形态的唯一开关：一个 html 类，CSS 负责长相（见 style.css）
  const applyMaximized = (on) => {
    document.documentElement.classList.toggle('maximized', !!on);
    const btn = $('#win-max');
    if (btn) {
      const label = on ? '还原' : '最大化';
      btn.title = label;
      btn.setAttribute('aria-label', label);
    }
  };

  $('#win-min')?.addEventListener('click', () => { bridge.minimize(); });
  $('#win-max')?.addEventListener('click', () => { bridge.toggleMaximize(); });
  $('#win-close')?.addEventListener('click', () => { bridge.close(); });

  // ② 双击拖拽区 = 最大化/还原。
  // ⚠️ 挂在 #topbar 与 #tabs 上（那两处才是 drag 区），而且必须**排除可点击元素** ——
  //    否则双击「暂停」按钮会顺带把窗口最大化，那是很烦人的误触。
  const dblTargets = ['#topbar', '#tabs'];
  for (const sel of dblTargets) {
    const el = $(sel);
    if (!el) continue;
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, input, select, textarea, a, label, summary, [role="tab"], [role="button"]')) return;
      bridge.toggleMaximize();
    });
  }

  // ③ 状态同步：先订阅（避免首查与首推之间漏事件），再主动查一次
  bridge.onState((s) => applyMaximized(s && s.maximized));
  Promise.resolve(bridge.isMaximized())
    .then((r) => applyMaximized(r && r.maximized))
    .catch(() => { /* 查不到就保持默认（未最大化），比抛错好 */ });
}

/** 筛选胶囊的档位文案：**唯一来源是 index.html 的 data-v ↔ 文字**，这里只是回读，
 *  让「没有匹配」那句提示与用户在胶囊上看到的字完全一致（不另写一份中文字符串）。 */
function chipLabelOf(v) {
  const el = $$('#session-filters .chip').find((x) => (x.dataset.v || 'all') === v);
  return el ? el.textContent.trim() : v;
}

/**
 * 写侧栏底部两个数字：`#session-more`（还有多少条没显示）与 `#session-count`（已显示/总数）。
 *
 * ⚠️ 过滤生效时**分母是过滤后的集合**（`totalOverride` 与 `filtered` 都为此设）——
 *    用户搜出来的"N 条"必须是他眼前这个集合的 N，而不是全部会话的条数。
 *    空结果时也走这里（totalOverride=0），把上一次的数字清掉；
 *    否则会出现"列表说没有匹配的会话，页脚却还写着 12/40"的自相矛盾。
 */
function setSessionFootCounts({ shown = 0, total = 0, totalOverride = null, filtered = false } = {}) {
  const more = $('#session-more');
  if (more) {
    const rest = Math.max(0, total - shown);
    if (!total) more.textContent = '';
    else if (rest > 0) more.textContent = `向下滚动加载更多（还有 ${rest} 条）`;
    else more.textContent = (total > SESSION_PAGE || filtered) ? `已显示全部 ${total} 条` : '';
  }
  const cnt = $('#session-count');
  if (cnt) {
    const t = totalOverride === null ? total : totalOverride;
    cnt.textContent = t ? `${Math.min(shown, t)}/${t}` : '';
  }
}

/** 空结果（没有匹配 / 没有记录）时把页脚数字清空，避免与列表内容自相矛盾。 */
function resetSessionFootCounts() {
  setSessionFootCounts({ shown: 0, total: 0 });
}

/**
 * 渲染一条会话卡片。**抽出来是为了让"整块重建"与"滚动追加"共用同一份模板** ——
 * 两份模板必然漂移（本项目踩过：同一个东西两处拼字符串，改了一处忘了另一处）。
 */
function sessionRowHtml(s) {
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const waitHtml = s.status === 'waiting' && s.waitUntil
    ? `<span class="session-wait" data-until="${Number(s.waitUntil)}">等待中 · ${fmtWaitRemain(Number(s.waitUntil))}</span>`
    : '';
  const activityHtml = s.status === 'running' && s.activity
    ? `<span class="session-activity">${esc(s.activity)}</span>`
    : '';
  const searchHtml = Number(s.webSearchCount) > 0
    ? `<span class="muted">搜 ${s.webSearchCount}</span>`
    : '';
  const isNew = !state.seenSessionIds.has(s.id);
  return `
      <div class="session-item ${s.id === state.currentSessionId ? 'selected' : ''} ${s.status === 'waiting' ? 'session-waiting-row' : ''} ${isNew ? 'new-item' : ''}" data-id="${s.id}">
        <div class="session-title">
          <span class="session-chat">${esc(chatName)}</span>
          <span class="session-time">${fmtTime(s.startedAt)}</span>
        </div>
        <div class="session-trigger">${esc(s.trigger || '')}</div>
        <div class="session-meta">
          <span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>
          ${waitHtml}
          ${activityHtml}
          ${s.status !== 'waiting' ? `<span>${s.usage ? fmtTokens(s.usage.totalTokens) : '-'}</span><span>${s.rounds || 0} 轮</span>${searchHtml}</span>` : ''}
          <button class="btn btn-small btn-danger session-del" data-id="${s.id}" title="删除这条会话记录" style="margin-left:auto;padding:1px 7px;font-size:11px;line-height:1.5">删除</button>
        </div>
      </div>`;
}

/**
 * 给**一批**会话卡片挂事件。scope 传整块容器（首次渲染）或刚追加的那一段（增量）。
 *
 * ⚠️ `.session-item` 上是 querySelectorAll 全扫 —— 追加时只扫新插入的那段，
 *    否则每追加一批都要给前面所有条目重挂一遍监听（重复绑定 + 白跑）。
 */
function bindSessionRowHandlers(scope) {
  $$('.session-item', scope).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
  // 每行的删除按钮：必须 stopPropagation，否则会顺带把"选中这条会话"也触发
  $$('.session-del', scope).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(el.dataset.id, (state.sessions || []).find((x) => x.id === el.dataset.id));
    });
  });
}

/** 「清空全部会话」按钮是常驻元素 → 只绑一次。 */
function bindClearSessionsButton() {
  const clearBtn = $('#sessions-clear-btn');
  if (clearBtn && !clearBtn.__bound) {
    clearBtn.__bound = true;
    clearBtn.addEventListener('click', clearAllSessions);
  }
}

/**
 * 滚到底时**只追加新的一批**（阶段 D 性能修复）。
 *
 * 为什么单独一个函数：`renderSessionList()` 是 `box.innerHTML = 全部条目`，
 * 拿它来加载下一批等于把已渲染的全部重造一遍，成本随条数二次增长。
 * 见 initSessionScrollLoader 里那组实测数字。
 *
 * ⚠️ 必须与 renderSessionList 的**过滤口径完全一致**，否则追加出来的条目
 *    会和已有列表对不上（比如把被过滤掉的会话追加进来）。所以这里重算了一遍
 *    同一套过滤 —— 抽成 chooseVisibleSessions() 共用，避免两份口径漂移。
 */
function appendSessionRows() {
  const box = $('#session-items');
  if (!box || !box.querySelector('.session-item')) { renderSessionList(); return; }  // 还没有内容 → 走整块渲染
  const { all, filtering } = chooseVisibleSessions();
  const already = box.querySelectorAll('.session-item').length;
  const more = all.slice(already, state.sessionLimit);
  if (!more.length) { setSessionFootCounts({ shown: already, total: all.length, filtered: filtering }); return; }
  // ⚠️ 用 insertAdjacentHTML 而不是 `box.innerHTML +=` ——
  //    后者会把已有节点全部销毁重建（等于没优化）。
  //    用"插入点前一个兄弟节点"来界定**新插入的那一段**，这样只需给新条目挂监听，
  //    不必给前面所有条目重挂一遍（重复挂监听 = 白跑 + 同一动作触发多次）。
  const lastOld = box.lastElementChild;
  box.insertAdjacentHTML('beforeend', more.map(sessionRowHtml).join(''));
  const fresh = [];
  for (let el = lastOld ? lastOld.nextElementSibling : box.firstElementChild; el; el = el.nextElementSibling) fresh.push(el);
  // 传一个**真节点**当 scope：$$ 内部是 root.querySelectorAll(sel)，
  // 用 DocumentFragment 装这一段即可（它同样支持 querySelectorAll）。
  const scope = document.createDocumentFragment();
  fresh.forEach((el) => scope.appendChild(el));
  bindSessionRowHandlers(scope);
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  setSessionFootCounts({ shown: already + more.length, total: all.length, filtered: filtering });
  // 新追加里若有"等待中"，得把 0.1s 本地刷新器拉起来
  if (fresh.some((el) => el.querySelector('.session-wait[data-until]'))) startWaitTicker();
}

/**
 * 算出"现在该显示哪些会话" + "是否处于过滤态"。
 * 抽出来的唯一理由：整块渲染与增量追加**必须用同一套口径**（平台 → 关键词/状态）。
 */
function chooseVisibleSessions() {
  const allPlatforms = state.sessions || [];
  const byPlatform = allPlatforms.filter(matchPlatformSession);
  const q = (state.sessionFilter && state.sessionFilter.query) || '';
  const f = (state.sessionFilter && state.sessionFilter.status) || 'all';
  const filtering = !!q || f !== 'all';
  const all = byPlatform.filter((s) => matchSessionFilter(s, q, f));
  return { allPlatforms, byPlatform, all, q, f, filtering };
}

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  // 平台过滤：只显示当前平台的历史运行记录。
  // ⚠️ 会话条目没有 source 字段 ⇒ 用 chatKey 查 refreshSourceMap 那张表。
  // ⚠️ 空列表要说清原因 —— "切到微信却什么都没有"与"被过滤掉了"是两种不同的状态，
  //    不区分的话用户会以为坏了（这正是本项目反复踩的"静默失效"）。
  const { allPlatforms, byPlatform, all, q, f, filtering } = chooseVisibleSessions();
  if (!all.length) {
    // ⚠️ 三种"空"必须说清是哪一种，否则用户会以为坏了：
    //    ① 有记录但被**平台**过滤掉（切到微信时最常见）
    //    ② 有记录但被**搜索/状态**过滤掉（本轮 C2 新增）
    //    ③ 真的没有任何记录
    if (byPlatform.length && filtering) {
      box.innerHTML = `<div class="session-nomatch">没有匹配的会话。<br>当前平台共 ${byPlatform.length} 条，`
        + `${q ? `关键词「${esc(q)}」` : ''}${q && f !== 'all' ? ' + ' : ''}`
        + `${f !== 'all' ? `筛选「${esc(chipLabelOf(f))}」` : ''}之下一条都没有。`
        + `<br>把筛选切回「全部」、或清空关键词就能看到它们。</div>`;
    } else {
      box.innerHTML = `<div class="list-head muted">${isWechatMode()
        ? (allPlatforms.length
          ? `这里只显示微信会话 —— 当前 ${allPlatforms.length} 条记录都属于 QQ。切回「QQ」能看到它们。`
          : '还没有微信会话记录。中继与 Bridge 跑起来、且白名单放行之后才会有。')
        : '还没有会话记录。'}</div>`;
    }
    resetSessionFootCounts();
    return;
  }
  const shown = all.slice(0, state.sessionLimit);
  box.innerHTML = shown.map(sessionRowHtml).join('');
  // 底部提示 + 头部计数：过滤生效时分母用过滤后的集合（见 setSessionFootCounts 注释）
  setSessionFootCounts({ shown: shown.length, total: all.length, filtered: filtering });
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  bindSessionRowHandlers(box);
  bindClearSessionsButton();
  // 等待中会话的剩余时间按 0.1s 本地刷新（不重新拉列表）
  if ($$('.session-wait[data-until]', box).length) startWaitTicker();
}

/**
 * 删除一条会话留档。
 *
 * ⚠️ 会话文件同时是「用量」页的唯一数据源（buildUsageStats 是扫 data/sessions/
 * 重算的），所以删掉一条会话 = 这次运行也从用量统计里消失。确认文案必须写明，
 * 否则用户会以为是"只删了列表里的显示"。
 */
function deleteSession(id, s) {
  if (!id) return;
  const label = s
    ? `${formatChatTitle(s.chatKey, chatNameOf(s.chatKey))} · ${fmtTime(s.startedAt)}`
    : id;
  const running = !!s && s.status === 'running';
  confirmDanger({
    head: '删除会话记录',
    okText: '删除',
    text: `<b>${esc(label)}</b><br><br>
      会一并删除磁盘上的 <code>data/sessions/${esc(id)}.json</code>。<br>
      ⚠️ 「用量」页是按会话文件重新统计的，所以<b>这次运行的 token 与费用也会从统计里消失</b>。<br><br>
      ${running
        ? '<b style="color:var(--red)">这条会话正在运行中，后端会拒绝删除 —— 请等它跑完再删。</b>'
        : '此操作不可撤销（不进回收站）。其他会话不受影响。'}`,
    onOk: async () => {
      await api(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
      // 删的正好是当前打开的那条 → 详情区清空，别留着一份已删除的记录
      if (state.currentSessionId === id) {
        state.currentSessionId = null;
        state.sessionDetail = null;
        lastDetailFp = null;
        const detail = $('#session-detail');
        if (detail) detail.innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      }
      state.seenSessionIds?.delete(id);
      await loadSessions();
    }
  });
}

/** 清空全部会话留档（运行中的会自动保留）。 */
function clearAllSessions() {
  const all = state.sessions || [];
  if (!all.length) { showNoticeModal('清空全部会话', '现在没有任何会话记录。'); return; }
  const running = all.filter((s) => s.status === 'running').length;
  confirmDanger({
    head: '清空全部会话记录',
    okText: `删除全部 ${all.length - running} 条`,
    text: `将删除 <b>${all.length - running}</b> 条会话记录文件（data/sessions/*.json）。<br><br>
      ${running ? `其中 <b>${running}</b> 条正在运行，会<b>自动保留</b>不被删除。<br><br>` : ''}
      ⚠️ 「用量」页是按会话文件重新统计的，清空后<b>历史 token 与费用统计会一并归零</b>（今日汇总数字另存于 usage-today.json，不受影响）。<br><br>
      此操作不可撤销。`,
    onOk: async () => {
      const r = await api('/api/sessions', { method: 'DELETE', body: '{}' });
      state.currentSessionId = null;
      state.sessionDetail = null;
      lastDetailFp = null;
      const detail = $('#session-detail');
      if (detail) detail.innerHTML = '<div class="empty-hint">← 选择左侧会话查看完整过程</div>';
      state.seenSessionIds = new Set();
      await loadSessions();
      if (Number(r.skipped) > 0) {
        showNoticeModal('清空完成', `已删除 ${r.files ?? r.removed} 条；${r.skipped} 条运行中的会话已保留。`);
      }
    }
  });
}

function fmtWaitRemain(untilMs) {
  const remain = Math.max(0, Number(untilMs) - Date.now());
  return `${(remain / 1000).toFixed(1)}s`;
}

let waitTicker = null;
function startWaitTicker() {
  if (waitTicker) return;
  waitTicker = setInterval(() => {
    const els = $$('.session-wait[data-until]');
    if (!els.length) {
      clearInterval(waitTicker);
      waitTicker = null;
      return;
    }
    for (const el of els) {
      const until = Number(el.dataset.until);
      const remain = until - Date.now();
      el.textContent = remain > 0 ? `等待中 · ${(remain / 1000).toFixed(1)}s` : '等待中 · 启动…';
    }
  }, 100);
}

async function selectSession(id) {
  state.currentSessionId = id;
  state.sessionDetail = null;
  lastDetailFp = null;
  renderSessionList();
  $('#session-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadSessionDetail(id);
}

// 上次渲染会话详情的指纹：内容没变就不重渲染（轮询期间避免闪烁与滚动重置）
let lastDetailFp = null;

async function loadSessionDetail(id, { quiet = false } = {}) {
  try {
    const s = await api(`/api/sessions/${id}`);
    state.sessionDetail = s;
    if (state.currentSessionId === id && state.tab === 'sessions') renderSessionDetail(s);
  } catch (e) {
    if (!quiet) $('#session-detail').innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSessionDetail(s) {
  const detail = $('#session-detail');
  if (!detail) return;
  // 内容没变（轮询/SSE 重复推送）→ 完全不动 DOM，保住滚动位置和展开状态
  // json 模式切换也要触发重渲染
  const fp = `${s.id}|${s.status}|${s.rounds || 0}|${(s.messages || []).length}|${(s.sent || []).length}|${s.error ? 1 : 0}|${s.activity || ''}|${state.sessionJsonMode === s.id ? 'json' : 'ui'}`;
  if (lastDetailFp === fp) return;
  const firstRender = lastDetailFp === null;
  lastDetailFp = fp;

  // 保留用户的阅读位置；仅当用户本来就贴着底部时才跟随新内容（聊天式）
  const wasAtBottom = detail.scrollHeight - detail.scrollTop - detail.clientHeight < 48;
  const keepScroll = detail.scrollTop;
  const chatName = formatChatTitle(s.chatKey, chatNameOf(s.chatKey));
  const statusBadge = `<span class="status-badge status-${s.status}">${STATUS_LABEL[s.status] || s.status}</span>`;
  const usage = s.usage || {};

  const html = [];
  // ── 阶段 C1（2026-09-21 苹果风改造）：头部改「标题行 + 摘要卡」──────────────
  // 概念版把那一长串平铺字段收进一张摘要卡里，视觉重心落回标题。
  // ⚠️ 字段一个没删、也没改数据来源；只换了承载它们的 DOM（`.sub` 的 span → 摘要卡的格子）。
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        <button class="btn btn-small btn-danger" id="session-del-btn" style="margin-left:6px">删除本次会话</button>
      </h2>
    </div>
    <div class="pt-summary">
      <div class="pt-sum-row"><span class="k">触发</span><span class="v">${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span></div>
      <div class="pt-sum-row"><span class="k">时间</span><span class="v">开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span></div>
      <div class="pt-sum-row"><span class="k">模型</span><span class="v">${esc(s.model || '-')}</span></div>
      <div class="pt-sum-row"><span class="k">用量</span><span class="v">${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span></div>
      <div class="pt-sum-row"><span class="k">过程</span><span class="v">${s.rounds || 0} 轮工具 · 联网搜索 ${Number(s.webSearchCount) || 0} 次</span></div>
    </div>`);

  const jsonMode = state.sessionJsonMode === s.id;
  if (jsonMode) {
    // JSON 模式：原模原样展示输入给模型的内容 + 模型返回的原始内容
    const raw = {
      sessionId: s.id,
      chatKey: s.chatKey,
      model: s.model || '',
      systemPrompt: s.systemPrompt || '',
      userPrompt: s.userPrompt || '',
      // 存档已不再单独存这份副本（曾占会话存档 45%），用两个提示词字段原样重建；
      // 旧会话里还带着 inputMessages 的，优先显示原件。
      inputMessages: (Array.isArray(s.inputMessages) && s.inputMessages.length)
        ? s.inputMessages.map((m) => ({ role: m.role, content: m.content }))
        : [{ role: 'system', content: s.systemPrompt || '' }, { role: 'user', content: s.userPrompt || '' }],
      llmMessages: (s.messages || []).filter((m) => m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        raw: m.raw ?? null
      })),
      toolResults: (s.messages || []).filter((m) => m.toolCall).map((m) => ({
        toolCall: m.toolCall
      })),
      sent: s.sent || [],
      usage: s.usage || null,
      status: s.status,
      error: s.error ?? null
    };
    html.push(`
      <details class="collapsible" open>
        <summary>JSON 模式（模型输入/输出的原始内容）</summary>
        <div class="coll-body" style="max-height:none">${esc(JSON.stringify(raw, null, 2))}</div>
      </details>`);
  } else {
    if (s.systemPrompt) {
      // 阶段 C1：`.collapsible`/`.coll-body` → `details.pt-fold` + `.pt-code`
      //（⚠️ 类名仍是 collapsible，见函数末尾"展开状态保留"那段要按类名+序号恢复）
      html.push(`
        <details class="collapsible pt-fold">
          <summary class="pt-sec"><span class="chev">▸</span>系统提示
            <span class="m">${s.systemPrompt.length} 字符 · 每次运行重发</span></summary>
          <div class="pt-code">
            <div class="pt-code-head"><span>text</span><span class="pt-tag grey">${s.systemPrompt.length} 字符</span></div>
            <pre>${esc(s.systemPrompt)}</pre>
          </div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible pt-fold" open>
          <summary class="pt-sec"><span class="chev">▸</span>本次输入
            <span class="m">${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档</span></summary>
          <div class="pt-code">
            <div class="pt-code-head"><span>text</span><span class="pt-tag grey">${s.userPrompt.length} 字符</span></div>
            <pre>${esc(s.userPrompt)}</pre>
          </div>
        </details>`);
    }
  }

  html.push('<div class="msg-flow">');
  if (!jsonMode) {
    for (const item of s.messages || []) {
      if (item.toolCall) {
        html.push(`
          <div class="tool-card ${item.toolCall.isError ? 'tool-error' : ''}">
            <div class="tool-head"><span class="tool-name">${esc(item.toolCall.name)}</span></div>
            <div class="tool-args">${esc(JSON.stringify(item.toolCall.args, null, 1))}</div>
            <div class="tool-result ${item.toolCall.isError ? 'is-error' : ''}">${esc(item.toolCall.result)}</div>
          </div>`);
      } else if (item.toolImages) {
        html.push(`
          <div class="tool-card">
            <div class="tool-head"><span class="tool-name">${esc(item.toolImages.tool)}</span>
            <span class="muted">→ ${item.toolImages.count} 张图片已作为图像输入注入模型</span></div>
          </div>`);
      } else if (item.nudgeDraft) {
        // 系统追问：它写了回复却没调用 send_message，代码层追问了一次让它自己决定发不发
        html.push(`
          <div class="tool-card">
            <div class="tool-head"><span class="tool-name">系统追问</span>
            <span class="muted">→ 写了回复但没调用 send_message，追问一次让它自己决定</span></div>
            <div class="tool-result">它当时写的：${esc(item.nudgeDraft)}</div>
          </div>`);
      } else if (item.role === 'assistant') {
        const text = typeof item.content === 'string' ? item.content : '';
        if (item.tool_calls && item.tool_calls.length && !text.trim()) continue; // 纯工具调用轮，卡片已展示
        html.push(`
          <div class="bubble bubble-assistant">
            <div class="asr-label">思考（不发送）</div>
            ${esc(text || '（无文本输出，仅调用工具）')}
          </div>`);
      }
    }
    // 发出的消息
    for (const sent of s.sent || []) {
      // 🔴 这里原来写死「已发送到 QQ」—— 微信的回复也显示成 QQ，用户一眼就发现"它不知道自己在微信"。
      //    平台要从**这条会话的 chatKey** 查（列表接口不带 source）。
      const plat = sessionPlatform({ chatKey: s.chatKey }) === 'wechat' ? '微信' : 'QQ';
      // 阶段 C1：`.sent-badge` → `.pt-out` 绿色输出卡（概念版形态）
      html.push(`
        <div class="pt-out">
          <div class="pt-out-head"><span class="who">已发送到 ${plat}</span>${sent.at ? `<span class="muted">${esc(sent.at)}</span>` : ''}</div>
          <p>${esc(sent.text)}</p>
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  // 阶段 C1：结束行用 `.pt-endline`（带一个圆点，与概念版一致）
  if (s.finishReason) html.push(`<div class="pt-endline"><span class="dot"></span>finish：${esc(s.finishReason)}</div>`);
  html.push('</div>');

  // 折叠面板的展开状态也要保留（否则每次刷新"系统提示"都被折回去）
  const openStates = new Map();
  detail.querySelectorAll('details.collapsible').forEach((d, i) => openStates.set(i, d.open));
  detail.innerHTML = html.join('');
  detail.querySelectorAll('details.collapsible').forEach((d, i) => { if (openStates.has(i)) d.open = openStates.get(i); });
  const jsonBtn = $('#json-mode-btn');
  if (jsonBtn) jsonBtn.addEventListener('click', () => {
    state.sessionJsonMode = state.sessionJsonMode === s.id ? null : s.id;
    lastDetailFp = null;   // 强制重渲染
    renderSessionDetail(s);
  });
  $('#session-del-btn')?.addEventListener('click', () => deleteSession(s.id, s));
  if (firstRender || (s.status === 'running' && wasAtBottom)) {
    detail.scrollTop = detail.scrollHeight;      // 首次打开 / 贴底跟随新内容
  } else {
    detail.scrollTop = keepScroll;               // 保留阅读位置
  }
  // 说明：此处原先有一段"运行中每 2s 自递归拉详情"的兜底轮询，已移除。
  // 原因：renderSessionDetail 会被 SSE 事件和 4s 主轮询反复调用，每次都新起一个
  // setTimeout 且从不取消旧的，切换/高频刷新时 timer 会不断累积；
  // 而下面的 4s 主轮询（loadSessions）已经会对 running/waiting 的会话刷新详情，
  // 功能完全覆盖，2s 递归属于纯重复请求。
}

// ── SnowLuma 独立页签 ──
/**
 * 只刷新 SnowLuma 的日志区（不重建整个页面）。
 * SSE 每来一条新日志就调一次 —— 如果这里重建整页，
 * 用户正在看的日志会被反复重绘，滚动位置也保不住。
 *
 * ⚠️ 2026-09-22（UI 改造第二阶段条目 2）改成走 **LogPanel**：
 *    原来这里直接改 `<pre class="snowluma-logs-view">` 的 textContent。
 *    现在日志面板是分级行（.logrow + data-lvl），所以只重画 `[data-logbody]` 的内容，
 *    再让面板自己 re-apply 过滤/搜索 —— 这样"用户选的过滤档与搜索词"不会被新日志冲掉。
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const panel = box.querySelector('#sl-logpanel');
  const body = panel && panel.querySelector('[data-logbody]');
  if (!body) return;                      // 页面还没渲染过，等下次整页刷新
  try {
    const logs = await api('/api/snowluma/logs');
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n');
    body.innerHTML = logPanelRows(logText, 'sl-logpanel');
    if (typeof panel.__apply === 'function') panel.__apply();
  } catch { /* 刷新失败静默，不影响主流程 */ }
}

async function loadSnowlumaPage({ quiet = false } = {}) {
  try {
    const [status, logs] = await Promise.all([
      api('/api/status'),
      api('/api/snowluma/logs')
    ]);
    const s = status;
    const box = $('#snowluma-page');
    if (!box) return;
    const running = !!(s.snowluma?.running);
    const onebotConnected = !!s.onebot?.connected;
    const dir = s.snowluma?.dir || '';
    const embedded = !!s.snowluma?.embedded;
    const pid = s.snowluma?.pid ?? null;
    const webuiUrl = s.snowluma?.webuiUrl || '';
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';

    // ⚠️ 2026-09-22：原来这里要"记住日志滚动位置再补偿"，因为日志区每轮重建。
    //    现在日志面板是**常驻**的（#sl-logpanel 不在 #sl-dyn 里）⇒ 滚动位置天然保留，
    //    补偿代码反而会打架（新节点还没有高度，scrollTop 设了也没用）。
    //    ⇒ 删掉。真要恢复"贴底跟随"由 LogPanel 的「自动滚动」开关负责（默认开）。

    // ⚠️ 同一个坑的另一面：listPoller 每 15 秒 quiet 重建一次整页，
    //    会把「群发」那块的**正在输入的内容、选好的范围、以及刚显示出来的结果**一起冲掉。
    //    所以这里一并保存/还原。焦点也还原（否则打字打到一半光标就没了）。
    //    多行框还要连**用户自己拖出来的宽高**一起还原 —— 不然每 15 秒把你拖好的尺寸弹回去。
    const oldTextEl = box.querySelector('#sl-notify-text');
    const keepNotify = {
      text: oldTextEl ? oldTextEl.value : '',
      focused: !!oldTextEl && document.activeElement === oldTextEl,
      start: oldTextEl ? oldTextEl.selectionStart : null,
      end: oldTextEl ? oldTextEl.selectionEnd : null,
      w: oldTextEl?.style?.width || '',
      h: oldTextEl?.style?.height || '',
      scrollTop: oldTextEl ? oldTextEl.scrollTop : 0,
      scope: box.querySelector('#sl-notify-scope')?.value || 'groups',
      hint: box.querySelector('#sl-notify-hint')?.textContent || '',
      hintColor: box.querySelector('#sl-notify-hint')?.style?.color || ''
    };

    // 🔴 2026-09-19 结构性修复（用户报"群发打字打一半经常被打断"）：
    //    根因 —— `startListPoller()` 每 15 秒（`ui.refreshMs`）走 `loadSnowlumaPage({quiet:true})`，
    //    而它**整页重建 `#snowluma-page` 的 innerHTML**；「自定义内容」那个 textarea 是死在里面的 DOM
    //    ⇒ 元素被销毁重造。之前的 `keepNotify` 补偿有三个真漏洞：
    //      ① **capture 发生在两个 `await` 之后** —— 你在拉 status/logs 那段时间里打的字还没进 textarea，
    //         capture 到的是旧的，重建后 `t.value = keepNotify.text` **把它整段覆盖掉**
    //         （症状就是"打一半突然没了"）；
    //      ② **完全没管中文输入法组词** —— 拼音还在组字框里没上屏时元素被销毁，组字被打断/丢字；
    //      ③ 只还原了 textarea，别的输入没管。
    //    ⇒ **补丁式还原治不了根**（13 个输入点要逐个还原，而且永远有第 14 个）。
    //      改成**结构上让它重建不到这一块**：群发那块单独放一个**常驻容器** `#sl-notify-block`，
    //      页面重建时只重建 `#sl-dyn`（状态 + 按钮 + 日志），**输入元素根本不是新造的** ——
    //      焦点、光标、输入法组词、拖出来的尺寸、选中的范围**全部天然保留**，不需要任何还原代码。
    const notifyBlockHtml = `
      <div class="pt-sec">群发通知 <span class="muted" style="font-weight:400">发给白名单里的会话</span></div>
      <div class="gate-inner">
        <div class="snowluma-actions">
          <span class="muted" style="font-size:12.5px">通知白名单：</span>
          <select id="sl-notify-scope" class="btn btn-small" style="padding:2px 6px" title="发给谁：只群聊 / 只私聊 / 两者都发">
            <option value="groups">只群聊</option>
            <option value="privates">只私聊</option>
            <option value="both">群聊 + 私聊</option>
          </select>
          <button class="btn btn-small" id="sl-notify-on-btn" title="按上面的范围，各发一条「开机」。建议在 SnowLuma 启动、OneBot 连上之后再点。">发「开机」</button>
          <button class="btn btn-small" id="sl-notify-off-btn" title="按上面的范围，各发一条「关机」。建议在关闭 SnowLuma 之前点。">发「关机」</button>
        </div>
        <div class="snowluma-actions">
          <span class="muted" style="font-size:12.5px">自定义内容：</span>
          <div class="notify-composer">
            <textarea id="sl-notify-text" rows="3" spellcheck="false"
              placeholder="支持多行 —— 直接粘贴即可（Enter 换行，Ctrl+Enter 发送）。最多 200 字，右下角能拖大。"></textarea>
            <div class="notify-actions">
              <span id="sl-notify-count" class="muted">0 / 200</span>
              <button class="btn btn-small" id="sl-notify-send-btn">发送</button>
              <span id="sl-notify-hint" class="muted" style="font-size:12px"></span>
            </div>
          </div>
        </div>
      </div>
      <div class="gate-bar"><span>未连接，不可用 —— 先把上面的三步走完。</span><span class="gate-go" data-goto-tab="snowluma" role="button" tabindex="0">去完成连接引导 →</span></div>`;

    // ── 状态区（**每轮重建**，里面全是只读展示，没有任何输入元素）──────────────
    // UI 改造第二阶段条目 2。改动点对照方案原文：
    //   1 状态徽章化 + 元信息行（端口/pid/路径，带复制）+ 5 秒自动轮询
    //   2 指引改交互式分步器（序号+标题+一句说明+动作按钮，未到步骤置灰）
    //   3 报错人性化：顶部一句人话结论，原始报错进「查看原始报错」折叠区
    //   5 「关闭 SnowLuma」次级化 + 二次确认
    //   7 顶栏重复警示条下线（信息并入状态徽章）—— 顶栏那条是全局 banner，见 renderBanner
    //
    // ⚠️ `s.snowluma.injected` 等字段是这一轮后端新加的（src/app.js 的 /api/status）。
    //    方案原意是"从日志里抓 login detected/session started"，但**日志会被群消息刷掉**
    //    （实测只留 200 行，那两类行命中 0）⇒ 改用内存里的可靠信号，
    //    详见 src/app.js 那段注释。**别再改回按日志文本判断。**
    const slRunning = running;
    const slGateway = !!s.snowluma?.gatewayUp || slRunning;
    const slWebui = !!s.snowluma?.webuiUp;
    const slInjected = !!s.snowluma?.injected;
    const slEverInjected = !!s.snowluma?.everInjected;
    // 三步的状态：已注入 ⇒ 三步全绿；否则逐级判断"卡在哪一步"
    const stepState = (n) => {
      if (slInjected) return 'done';
      if (n === 1) return slGateway ? 'done' : 'active';
      if (n === 2) return slGateway ? 'active' : 'todo';
      return 'todo';   // 第三步（注入）只有"注入成功"才算完成，前面无法代判
    };
    // 人话结论：把 ECONNREFUSED / 401 这类术语翻成"下一步该做什么"
    const slErrorText = String(s.onebot?.error || '');
    let slConclusion = '';
    if (!slGateway) slConclusion = 'SnowLuma 网关还没起来 —— 点第 1 步的「启动」。';
    else if (/401/.test(slErrorText)) slConclusion = '网关在跑，但还没有注入的 QQ 账号 —— 完成第 2、3 步即可。';
    else if (/ECONNREFUSED/i.test(slErrorText)) slConclusion = '连不上网关端口（连接被拒绝）—— 网关可能刚退出，点第 1 步重启一次。';
    else if (slInjected) slConclusion = '';
    else slConclusion = '网关在跑，但 OneBot 还没连上 —— 按第 2、3 步做。';

    const dynHtml = () => `
        <div class="snowluma-state-row">
          <span class="sbadge ${slRunning ? 'ok' : 'err'}"><span class="sdot"></span>SnowLuma ${slRunning ? '运行中' : '未运行'}</span>
          <span class="sbadge ${slInjected ? 'ok' : (slGateway ? 'busy' : 'off')}"><span class="sdot"></span>OneBot ${slInjected ? `已连接${s.onebot.self ? `（${esc(s.onebot.self.nickname)}）` : ''}` : (slGateway ? '连接中/未连上' : '未连接')}</span>
          ${running ? `<span class="sbadge off"><span class="sdot"></span>${embedded ? '内置模式（随应用退出）' : '独立模式'}</span>` : ''}
          <span class="ph-spacer"></span>
          <button class="btn btn-primary" id="sl-start-btn" ${slRunning ? 'disabled' : ''}>${slRunning ? '已运行' : '启动 SnowLuma'}</button>
          <button class="btn btn-small" id="sl-open-webui-btn" ${webuiUrl ? '' : 'disabled'} title="在浏览器中打开 SnowLuma 控制台">打开 WebUI</button>
        </div>
        <div class="snowluma-state-row muted" style="font-size:12px;gap:10px;flex-wrap:wrap">
          <span>目录 ${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
          <span class="ihint" role="note" tabindex="0" title="SnowLuma 的安装目录。点右侧「打开文件夹」可在资源管理器里打开。" aria-label="目录说明">i</span>
          <span>WebUI ${esc(webuiUrl || '（启动后自动识别）')}</span>
          <span>pid ${slRunning ? esc(String(pid ?? '-')) : '-'}</span>
          <span class="snowluma-actions" style="margin:0;gap:6px">
            <button class="btn btn-small" id="sl-copy-meta" title="复制端口 / pid / 目录 / WebUI 地址，便于排查时贴给别人">复制</button>
            <button class="btn btn-small" id="sl-refresh-btn">刷新</button>
            <span class="muted">5 秒自动刷新</span>
          </span>
        </div>

        <div class="pt-sec">连接引导 <span class="muted" style="font-weight:400">按顺序完成三步即可连通</span></div>
        ${hintLine('三步走完就能连通；第 3 步在 WebUI 的「进程」页里做。',
          '第 1 步：启动本地 SnowLuma 网关进程，首次启动会生成初始访问密码（只出现一次，应用抓到后会显示在下面）。'
          + '第 2 步：用访问密码登录 WebUI —— 登录发生在浏览器里，应用看不到，所以这一步是否完成要靠你自己确认。'
          + '第 3 步：在 WebUI 的「进程」页选中那个已经登录好的 QQ 进程并点注入；注入成功后本节自动变绿，不用重启。'
          + '注意：SnowLuma 是注入到已登录的 QQ 里的，它自己不会登录 QQ，所以先确认电脑上的 QQ 已经登录好。')}
        ${stepperHtml([
          {
            title: '启动网关', note: '（本地 SnowLuma 进程）',
            desc: slGateway ? '网关已在运行。' : '还没起来。首次启动会生成初始访问密码。',
            state: stepState(1),
            actionHtml: `<button class="btn btn-small${slGateway ? '' : ' btn-primary'}" id="sl-step-start" ${slGateway ? 'disabled' : ''}>${slGateway ? '已启动' : '启动'}</button>`,
          },
          {
            title: '登录 WebUI', note: '（需要访问密码）',
            desc: slInjected ? '已连通，无需再操作。'
              : (slWebui ? 'WebUI 端口已打开。用访问密码登录后到「进程」页继续。' : '网关起来后 WebUI 端口才会打开。'),
            state: stepState(2),
            note: '',
            actionHtml: `<button class="btn btn-small" id="sl-step-webui" ${slWebui ? '' : 'disabled'}>打开 WebUI</button>`,
          },
          {
            title: '注入 QQ 进程', note: '（在进程页选已登录的 QQ）',
            desc: slInjected ? '已注入并连通。'
              : (slEverInjected ? '曾经注入成功过，现在断了 —— 到进程页重新注入。'
                : '进去后在「进程」页选那个已登录的 QQ 进程，点注入。成功后本节自动变绿，不用重启。'),
            state: stepState(3),
            actionHtml: `<button class="btn btn-small" id="sl-step-open-folder">打开文件夹</button>`,
          },
        ])}
        ${initialPwdHtml}
        ${slConclusion ? `<div class="safetybar"><span>⚠️</span><span>连接失败：${esc(slConclusion)}
          <details style="display:inline-block"><summary style="cursor:pointer;display:inline">查看原始报错</summary>
          <div class="muted" style="font-family:var(--mono);font-size:11px;margin-top:4px">${esc(slErrorText || '（无）')}</div></details></span></div>` : ''}

        <div class="snowluma-actions">
          ${quietBtnHtml('sl-stop-btn', '关闭 SnowLuma', '会先发一条「关机」提示再到托盘；执行前会二次确认')}
          <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
          <span id="sl-hint" class="muted" style="font-size:12px"></span>
        </div>`;

    // ── 日志区：**常驻容器**（不放 #sl-dyn 里）─────────────────────────────
    // ⚠️ 为什么必须常驻：LogPanel 有过滤档/搜索词/噪音折叠/自动滚动这些**界面状态**，
    //    而 #sl-dyn 每 15 秒整体重建一次。放进去的话每 15 秒你的搜索词和筛选档就被清掉
    //    —— 这就是本项目反复踩的「打字打一半被打断」同一个病（群发那块当初也是这么修的）。
    //    ⇒ 骨架只搭一次，之后只**换日志行**（logPanelRows 重写 [data-logbody] 的内容）。
    const logPanelHtml = logPanelShell('运行日志', 'sl-logpanel', {
      emptyText: '暂无日志 —— 启动 SnowLuma 后这里会输出运行日志',
    });

    // ── 群发通知：独立成卡 + **连接门控**（条目 2 改动点 6）─────────────────
    // 🔴 方案现状问题原文：「未连接时全部可点（必失败）」。
    //    ⇒ 未连通时整卡禁用（`.gate.locked` 让 .gate-inner 不可点）+ 引导链接。
    //    判据用 `slInjected`（= OneBot 真连上了）而不是"SnowLuma 在跑" ——
    //    网关在跑但没注入 QQ 时，发消息同样必失败。
    //    ⚠️ 锁定状态由**常驻块自己**（#sl-notify-block）带类控制，因为这块不随
    //      #sl-dyn 重建；重建时只需 syncNotifyGate() 同步一次类，不必重搭 DOM。
    const syncNotifyGate = () => {
      const blk = $('#sl-notify-block');
      if (!blk) return;
      blk.classList.toggle('locked', !slInjected);
    };

    // 初始密码：**只在后端真的抓到过、且用户还没改密时才有值**（`snowluma.initialPassword`）。
    // ⚠️ 方案原本担心"★ 初始密码被群消息日志刷掉"，这个担心是**对的**（实测那行确实被刷没了），
    //    但后端早就把它单独存成字段了 ⇒ 这里直接用它，**不要**去日志里翻 ★ 行。
    //    只出现一次的东西，必须放在日志之外的地方。
    const initialPwdHtml = s.snowluma?.initialPassword
      ? `<div class="safetybar"><span>🔑</span><span>WebUI 初始访问密码：
          <code style="font-size:13px;font-weight:600;padding:1px 8px;border-radius:6px;background:rgba(var(--orange-rgb),.18)">${esc(s.snowluma.initialPassword)}</code>
          <button class="btn btn-small" id="sl-copy-pwd" style="margin-left:6px">复制</button>
          <span class="muted"> — 登录 WebUI 用。改密后这里就不再显示。</span></span></div>`
      : '';

    // 日志行：**每次重建都换**，但 LogPanel 的骨架（含过滤档/搜索词那些界面状态）不动 ——
    // 所以只重写 [data-logbody] 的内容，不重建整个面板。
    const paintLogs = (scope) => {
      const body = scope.querySelector('#sl-logpanel [data-logbody]');
      if (!body) return;
      // ⚠️ 用户在面板里点过「清空」之后，body 里留的是那句提示而不是行；
      //    这里每轮都会重画，所以"清空"只在本轮有效 —— 这是有意的：
      //    日志是活数据，5 秒后就有新行了，永久清空会让人以为日志不更新了。
      body.innerHTML = logPanelRows(logText, 'sl-logpanel');
      const panel = scope.querySelector('#sl-logpanel');
      if (panel && typeof panel.__apply === 'function') panel.__apply();
    };

    // ① 常驻容器已经在 ⇒ **只重建动态区**，输入元素与日志面板一个都不动（这就是根治点）
    if (box.querySelector('#sl-notify-block')) {
      const dyn = box.querySelector('#sl-dyn');
      const html = dynHtml();
      if (dyn) dyn.innerHTML = html;
      paintLogs(box);
      syncNotifyGate();
      bindSnowlumaDynamic();
      applySnowlumaInputs(keepNotify);
      return;
    }

    // ② 首次渲染：常驻容器只搭这一次
    //    ⚠️ 结构上分成三块，各有明确理由：
    //      #sl-dyn          每轮重建（纯只读展示：徽章/分步器/按钮）
    //      #sl-logpanel     常驻（有过滤档/搜索词/噪音折叠/自动滚动等界面状态）
    //      #sl-notify-block 常驻（有 textarea 等输入元素 —— 2026-09-19 那次修复的成果）
    box.innerHTML = `<div class="snowluma-page-card">
      <div id="sl-dyn">${dynHtml()}</div>
      <div id="sl-log-wrap">${logPanelHtml}</div>
      <div id="sl-notify-block">${notifyBlockHtml}</div>
    </div>`;
    initLogPanel('sl-logpanel');
    paintLogs(box);
    syncNotifyGate();
    bindSnowlumaDynamic();
    applySnowlumaInputs(keepNotify);

    // 恢复「群发」那块的输入与结果（见上面 keepNotify 的注释：15 秒一次的重建会冲掉它们）
    {
      const t = $('#sl-notify-text');
      if (t) {
        t.value = keepNotify.text;
        // 用户自己拖出来的宽高：必须还原，否则每 15 秒被打回默认尺寸
        if (keepNotify.w) t.style.width = keepNotify.w;
        if (keepNotify.h) t.style.height = keepNotify.h;
        t.scrollTop = keepNotify.scrollTop || 0;
        if (keepNotify.focused) {
          t.focus();
          try { t.setSelectionRange(keepNotify.start ?? t.value.length, keepNotify.end ?? t.value.length); } catch { /* 某些类型不支持 */ }
        }
      }
      const sc = $('#sl-notify-scope');
      if (sc) sc.value = keepNotify.scope;
      const h = $('#sl-notify-hint');
      if (h) { h.textContent = keepNotify.hint; if (keepNotify.hintColor) h.style.color = keepNotify.hintColor; }
    }

  } catch (e) {
    if (!quiet) console.error(e);
  }
}

function bindSnowlumaDynamic() {
  // 启动/关闭/刷新/打开文件夹/打开WebUI —— 这五个按钮住在 #sl-dyn 里，每次重建都会变成新元素，
  // 所以每次重建后都必须重绑（用 ?. 兜底，防止某个按钮这一轮不存在时整页报错）。
  $('#sl-start-btn')?.addEventListener('click', async () => {
    const btn = $('#sl-start-btn');
    if (btn) { btn.disabled = true; btn.textContent = '启动中…'; }
    if ($('#sl-hint')) $('#sl-hint').textContent = '';
    try {
      const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
      if ($('#sl-hint')) $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
    } catch (e) {
      if ($('#sl-hint')) $('#sl-hint').textContent = `启动失败：${e.message}`;
    }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
  });
  // 「关闭 SnowLuma」：**破坏性操作 ⇒ 二次确认**（UI 改造第二阶段 原则 3 / 条目 2 改动点 5）。
  // ⚠️ 确认文案必须说清后果：断的是"机器人收不到也发不出消息"这件事，
  //    而不只是"关掉一个后台进程"。用户点之前要能预见这个后果。
  const doStopSnowluma = async () => {
    const btn = $('#sl-stop-btn');
    if (btn) { btn.disabled = true; btn.textContent = '关闭中…'; }
    if ($('#sl-hint')) $('#sl-hint').textContent = '';
    try {
      await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
      if ($('#sl-hint')) $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
    } catch (e) {
      if ($('#sl-hint')) $('#sl-hint').textContent = `关闭失败：${e.message}`;
    }
    setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
  };
  $('#sl-stop-btn')?.addEventListener('click', () => {
    const connected = !!state.status?.onebot?.connected;
    confirmDanger({
      head: '关闭 SnowLuma？',
      okText: '关闭',
      text: `关掉之后<b>机器人收不到也发不出任何消息</b>${connected ? '（包括现在正在群里说话的那些）' : ''}。<br><br>
        要恢复得重新走一遍「启动网关 → 登录 WebUI → 注入 QQ」。<br>
        ${connected ? '<br>💡 如果只是想让机器人别再说话，用顶栏的<b>「暂停」</b>就够了 —— 通道留着，恢复更快。' : ''}
        <br>此操作可撤销：随时能再启动。`,
      onOk: doStopSnowluma,
    });
  });
  $('#sl-refresh-btn')?.addEventListener('click', () => loadSnowlumaPage());
  // ── 分步器的动作按钮（条目 2 改动点 2）─────────────────────────────────
  // 第 1 步「启动」= 与页头主按钮同一个接口，复用同一段逻辑（避免两处实现漂移）
  $('#sl-step-start')?.addEventListener('click', () => $('#sl-start-btn')?.click());
  $('#sl-step-webui')?.addEventListener('click', () => $('#sl-open-webui-btn')?.click());
  $('#sl-step-open-folder')?.addEventListener('click', () => $('#sl-open-folder-btn')?.click());
  // 复制元信息（端口/pid/目录/WebUI）—— 方案改动点 1 要求"带复制"
  $('#sl-copy-meta')?.addEventListener('click', async (e) => {
    const s2 = (state.status || {});
    const sl = s2.snowluma || {};
    const txt = [
      `SnowLuma 目录：${sl.dir || '-'}`,
      `运行中：${sl.running ? '是' : '否'}${sl.pid ? `（pid ${sl.pid}）` : ''}`,
      `WebUI：${sl.webuiUrl || '-'}`,
      `OneBot：${s2.onebot?.connected ? `已连接 ${s2.onebot?.self?.nickname || ''}` : '未连接'}`,
    ].join('\n');
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(txt); btn.textContent = '已复制'; }
    catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
  // 复制初始密码（它只出现一次，必须让人一键拿走）
  $('#sl-copy-pwd')?.addEventListener('click', async (e) => {
    const pwd = (state.status?.snowluma?.initialPassword) || '';
    if (!pwd) return;
    const btn = e.currentTarget;
    try { await navigator.clipboard.writeText(pwd); btn.textContent = '已复制'; }
    catch { btn.textContent = '复制失败'; }
    setTimeout(() => { btn.textContent = '复制'; }, 1200);
  });
  $('#sl-open-folder-btn')?.addEventListener('click', async () => {
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { if ($('#sl-hint')) $('#sl-hint').textContent = `失败：${e.message}`; }
  });
  $('#sl-open-webui-btn')?.addEventListener('click', async () => {
    try {
      const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
      if (!r.ok && $('#sl-hint')) $('#sl-hint').textContent = r.error;
    } catch (e) {
      if ($('#sl-hint')) $('#sl-hint').textContent = `打开失败：${e.message}`;
    }
  });
  bindNotifyBlockOnce();
}

const NOTIFY_MAX = 200;   // 接口硬上限；超了会被 400 拦下，所以前端提前说清楚
let _notifyBound = false;

// 群发的**常驻区**：只绑一次。第一版每 15 秒连元素一起重造、再重绑一次，
// 结果把"打字打一半被打断"这类问题掩盖成了偶发现象。
function bindNotifyBlockOnce() {
  if (_notifyBound) return;
  const ta = $('#sl-notify-text');
  if (!ta || !$('#sl-notify-send-btn')) return;   // 结构还没搭好，等下一轮
  _notifyBound = true;

  // 给白名单里的会话群发（范围可选：群聊 / 私聊 / 两者）。开机、关机是快捷按钮，另有自定义文本。
  for (const [btnId, text] of [['#sl-notify-on-btn', '开机'], ['#sl-notify-off-btn', '关机']]) {
    $(btnId)?.addEventListener('click', () => broadcastSend(text, btnId));
  }

  const syncNotifyCount = () => {
    const el = $('#sl-notify-text');
    const c = $('#sl-notify-count');
    if (!el || !c) return;
    const n = el.value.length;
    c.textContent = `${n} / ${NOTIFY_MAX}`;
    c.classList.toggle('over', n > NOTIFY_MAX);
    c.title = n > NOTIFY_MAX ? `超过 ${NOTIFY_MAX} 字，发不出去（接口上限）` : '';
  };
  ta.addEventListener('input', syncNotifyCount);
  syncNotifyCount();

  // 中文输入法：组词期间一律不响应 Enter。
  // 否则选词/上屏的那个回车会被当成"发送"，把没写完的内容发出去（这也是"打字被打断"的一种）。
  ta.addEventListener('compositionstart', () => { state._imeComposing = true; });
  ta.addEventListener('compositionend', () => { state._imeComposing = false; });
  // 多行输入框：Enter 换行，Ctrl/Cmd+Enter 才发送（placeholder 里已写明）
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing || state._imeComposing) return;
    e.preventDefault();
    $('#sl-notify-send-btn')?.click();
  });

  $('#sl-notify-send-btn').addEventListener('click', () => {
    const input = $('#sl-notify-text');
    const text = String(input?.value || '').trim();
    const h = $('#sl-notify-hint');
    const bad = (msg) => { if (h) { h.textContent = msg; h.style.color = 'var(--orange)'; } input?.focus(); };
    if (!text) return bad('先写点内容');
    if (text.length > NOTIFY_MAX) return bad(`超长 ${text.length - NOTIFY_MAX} 字（上限 ${NOTIFY_MAX}）—— 删掉一些再发`);
    broadcastSend(text, '#sl-notify-send-btn', { clearInput: true });
  });
}

// 把草稿/尺寸/焦点/范围/hint 还原回**常驻**的输入元素。
// ⚠️ 这个版本**不是"先备份再重造"**：输入元素根本不会被销毁，所以这里只在
//    "首次渲染"或"被别处整页重建过"时才起作用。这正是能彻底修掉打断的原因。
function applySnowlumaInputs(keep) {
  if (!keep) return;
  const t = $('#sl-notify-text');
  if (t) {
    if (keep.text && t.value !== keep.text) t.value = keep.text;
    // 用户自己拖出来的宽高：还原，否则被打回默认尺寸
    if (keep.w) t.style.width = keep.w;
    if (keep.h) t.style.height = keep.h;
    if (typeof keep.scrollTop === 'number' && keep.scrollTop > 0) t.scrollTop = keep.scrollTop;
    if (keep.focused && document.activeElement !== t) {
      t.focus();
      try { t.setSelectionRange(keep.start ?? t.value.length, keep.end ?? t.value.length); } catch { /* 某些类型不支持 */ }
    }
  }
  const sc = $('#sl-notify-scope');
  if (sc && keep.scope) sc.value = keep.scope;
  const h = $('#sl-notify-hint');
  if (h && keep.hint) { h.textContent = keep.hint; if (keep.hintColor) h.style.color = keep.hintColor; }
}

/**
 * 给**白名单里的会话**群发一条内容（「开机」/「关机」/自定义通知用）。
 *
 * 三个要点：
 * - **范围由 `#sl-notify-scope` 决定**（只群聊 / 只私聊 / 两者）。先 `GET /api/broadcast?scope=` 
 *   **空跑一次**，把"到底会发给几个会话"从**服务端**问出来，再放进确认框 ——
 *   不拿前端缓存的配置猜，白名单可能刚在设置页改过。
 * - 服务端只发白名单里的会话（群聊那侧在白名单为空且勾了"全部放行"时才退化成全部群）。
 *   发出去撤不回来，所以这里有一道确认。
 * - 按钮状态用完恢复原状（失败也要恢复），否则一次报错之后按钮就废了。
 */
async function broadcastSend(text, btnId, { clearInput = false } = {}) {
  const hint = $('#sl-notify-hint');
  const btn = $(btnId);
  const scope = String($('#sl-notify-scope')?.value || 'groups');
  const say = (t, color) => { if (hint) { hint.textContent = t; hint.style.color = color || ''; } };
  say('查询发送范围…');
  let dry;
  try {
    dry = await api(`/api/broadcast?scope=${encodeURIComponent(scope)}`);
  } catch (e) {
    say(`查不到发送范围：${e.message}`, 'var(--orange)');
    return;
  }
  if (!dry.total) {
    say(`白名单里没有可发的会话（${dry.scopeLabel || scope}）`, 'var(--orange)');
    return;
  }
  const split = `其中群聊 <b>${dry.counts?.groups ?? 0}</b> 个、私聊 <b>${dry.counts?.privates ?? 0}</b> 个`;
  say('');
  confirmDanger({
    head: `群发「${esc(text)}」？`,
    text: `将向 <b>${dry.total}</b> 个会话各发一条「${esc(text)}」<br>`
      + `<span class="muted">范围：${esc(dry.scopeLabel || '')}；${split}</span><br><br>`
      + '发出去就撤不回来了。',
    okText: `发送「${esc(text)}」`,
    onOk: async () => {
      if (btn) { btn.disabled = true; btn.dataset.old = btn.textContent; btn.textContent = '发送中…'; }
      say('发送中…');
      try {
        const r = await api('/api/broadcast', { method: 'POST', body: JSON.stringify({ text, scope }) });
        if (r.failed?.length) {
          const detail = r.failed.map((f) => `${f.chatKey.replace(/^(group|private):/, '')}：${f.error}`).join('；');
          say(`发出 ${r.sent?.length || 0}/${r.total} 条，失败 ${r.failed.length} —— ${detail}`.slice(0, 300), 'var(--orange)');
        } else {
          say(`已发给 ${r.sent?.length || 0} 个会话 ✓（${r.scopeLabel || ''}）`, 'var(--green)');
          if (clearInput) { const input = $('#sl-notify-text'); if (input) input.value = ''; }
        }
      } catch (e) {
        say(`发送失败：${e.message}`, 'var(--orange)');
      }
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.old || '发送'; }
    }
  });
}

/**
 * 「唤醒一次处理」：立刻按现行规则醒一次，并**如实说明发生了什么**。
 *
 * 以前这个按钮点了没有任何反馈，于是三种"等于没点"的情况用户分不出来：
 * 没有未读 / 正在处理 / 档位没命中。最后那种更危险 —— 老代码会**顺手把这批未读扫成已读**，
 * 而那是不可逆的（未读一没，这批消息再也不会单独叫醒它）。所以现在：
 * 后端默认只回报不扫，界面在"会扫掉消息"时先弹一次确认，确认后才带 force 再发一次。
 */
async function wakeOnce(chatKey) {
  const hint = $('#chat-wake-hint');
  const say = (t, color) => { if (hint) { hint.innerHTML = t; hint.style.color = color || ''; } };
  const path = `/api/chats/${chatKey.replace(':', '_')}/wake`;
  say('正在唤醒…');
  let r;
  try {
    r = await api(path, { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    say(`唤醒失败：${esc(e.message)}`, 'var(--orange)');
    return;
  }
  // 注意：命中时 r.tier 是"命中的那一档"；没命中时它是 0，所以要显示"设置成第几档"得用 configTier。
  const bucket = r.tier ? `（命中第 ${r.tier} 档${r.tierReason ? '：' + esc(r.tierReason) : ''}）` : '';
  switch (r.reason) {
    case 'started':
      say(`已开始处理${bucket}${r.count !== undefined ? `，将带 ${r.count} 条已读历史` : ''} —— 去「会话」页看过程`, 'var(--green)');
      refreshStatus();
      return;
    case 'no-unread':
      say('没有未读消息，什么都没做（也不花 token）', 'var(--orange)');
      return;
    case 'running':
      say('这个会话正在处理中，这次没排上队', 'var(--orange)');
      return;
    case 'paused':
      say('当前处于暂停状态，先恢复运行再唤醒', 'var(--orange)');
      return;
    case 'aborted':
      say('正在退出/中止，暂时不能唤醒', 'var(--orange)');
      return;
    case 'swept':
      say(`已将 ${r.marked ?? 0} 条未读标为已读，未响应`, 'var(--green)');
      loadChats();
      loadChatMessages(chatKey, { keepView: true });
      return;
    case 'tier-miss': {
      // 关键的一步：说清"点下去会怎样"，再让用户决定。扫掉未读也撤不回来。
      const why = `这个会话设的是<b>第 ${r.configTier ?? '?'} 档</b>，本次判定结果：<b>${esc(r.tierReason || '未触发')}</b>`;
      say(`<b>没有响应</b>：${why}<br>`
        + `<span class="muted">继续的话，这 ${r.pending ?? 0} 条未读会被直接标为已读 —— 它一句话都不会说，`
        + '而且这批消息以后也不会再单独叫醒它了（只能等下次被人艾特时作为背景带出来）。</span>', 'var(--orange)');
      confirmDanger({
        head: '这次它不会响应，仍要把未读标为已读？',
        text: `本次判定：<b>不响应</b><br>${why}<br><br>`
          + `继续 → 这 <b>${r.pending ?? 0}</b> 条未读立刻变成"已读"，它<b>不会说话</b>。<br>`
          + '取消 → 什么都不做，未读原样留着（下次被艾特或被叫到时还能用上）。<br><br>'
          + '⚠️ 这一步不可撤销。',
        okText: `标记 ${r.pending ?? 0} 条为已读`,
        onOk: async () => {
          try {
            const r2 = await api(path, { method: 'POST', body: JSON.stringify({ force: true }) });
            say(`已将 ${r2.marked ?? 0} 条未读标为已读，未响应`, 'var(--green)');
            loadChats();
            loadChatMessages(chatKey, { keepView: true });
          } catch (e) {
            say(`操作失败：${esc(e.message)}`, 'var(--orange)');
          }
        }
      });
      return;
    }
    default:
      say(`未知结果：${esc(JSON.stringify(r))}`, 'var(--orange)');
  }
}

// ── 存档视图 ──
async function loadChats({ quiet = false } = {}) {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    // 顺手重建"chatKey → 平台"映射表（它会随新会话出现而变化）
    state.sourceMap = new Map((data.chats || []).map((c) => [c.key || c.chatKey, String(c.source || 'qq')]));
    renderChatList();
    if (state.currentChatKey) {
      // 打开着某群详情时也刷新该群消息。
      // keepView=true：只更新内容，不动分页与滚动位置 ——
      // 否则用户滚出来的内容会被每 15 秒的轮询刷回去。
      loadChatMessages(state.currentChatKey, { keepView: true });
    }
  } catch (e) { if (!quiet) console.error(e); }
}

function renderChatList() {
  const box = $('#chat-items');
  state.seenChatKeys = state.seenChatKeys || new Set();
  // 平台过滤（`/api/chats` **有** source 字段，直接用即可）
  const allChats = state.chats || [];
  const chats = allChats.filter(matchPlatform);
  if (!chats.length) {
    // 空的时候必须说清"是被过滤了"还是"真没有" —— 否则切到微信看到空白会以为坏了
    box.innerHTML = `<div class="list-head muted">${isWechatMode()
      ? (allChats.length
        ? `这里只显示微信存档 —— 当前 ${allChats.length} 个都属于 QQ。切回「QQ」能看到它们。`
        : '还没有微信存档。中继与 Bridge 跑起来、且白名单放行之后才会有。')
      : '还没有消息存档（等白名单里的群/好友来消息）'}</div>`;
    return;
  }
  box.innerHTML = chats.map((c) => {
    const name = formatChatTitle(c.key, chatNameOf(c.key));
    const isNew = !state.seenChatKeys.has(c.key);
    return `
      <div class="chat-item ${c.key === state.currentChatKey ? 'selected' : ''} ${c.unread ? 'unread-row' : ''} ${isNew ? 'new-item' : ''}" data-key="${c.key}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(name)}</span>
          ${c.unread ? `<span class="unread-pill">${c.unread}</span>` : ''}
        </div>
        <div class="chat-item-sub">${esc(c.lastText || '（空）')}</div>
        <div class="session-meta"><span>${c.total} 条</span><span>${fmtTime(c.lastTs)}</span></div>
      </div>`;
  }).join('') || '<div class="list-head muted">还没有消息存档（等白名单里的群/好友来消息）</div>';
  for (const c of state.chats) state.seenChatKeys.add(c.key);
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => selectChat(el.dataset.key));
  });
}

async function selectChat(key) {
  state.currentChatKey = key;
  if (state.quoteMode) state.quoteSelected = new Set();   // 金句按单段对话收录，换会话清空勾选
  renderChatList();
  $('#chat-detail').innerHTML = '<div class="empty-hint">加载中…</div>';
  await loadChatMessages(key);
}

/**
 * 拉取并渲染某会话的存档消息。
 *
 * @param {string} key
 * @param {boolean} keepView  true = 保留当前分页与滚动位置（轮询刷新用）；
 *                            false = 重置为第一页并重建结构（切换会话用）。
 *
 * ⚠️ 这个参数是修"滚动被冲掉"的关键：
 *    轮询每 15 秒一次、每次 SSE 事件也会触发，如果都走"重置分页 + 重建 DOM"，
 *    用户辛辛苦苦滚出来的内容会瞬间被刷回前 500 条，滚动位置也回到顶部
 *    —— 表现为"明明滚下去了，过一会儿自己弹回上面"。
 */
async function loadChatMessages(key, { keepView = false } = {}) {
  try {
    const data = await api(`/api/chats/${key.replace(':', '_')}/messages?limit=100000`);
    // 期间用户可能切走了会话，那就别覆盖当前视图
    if (state.currentChatKey !== key) return;
    state.chatMessages = data.messages || [];

    if (keepView && (state.chatMsgLimit || 0) > 0 && $('#chat-msg-body')) {
      // 只更新表格内容：分页不变、滚动位置不变
      updateChatMessagesBody(true);
    } else {
      // 切换会话：重置分页并从第一页开始
      state.chatMsgLimit = CHAT_MSG_PAGE;
      renderChatMessages();
    }
  } catch (e) {
    if (state.currentChatKey !== key) return;
    const box = $('#chat-detail');
    if (box) box.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 存档消息列表：首次建结构 + 填充内容。
 *
 * ⚠️ 关键：这个只在"切换会话 / 首次打开"时调用，负责建出完整骨架并绑定工具栏事件。
 *    滚动加载更多时走 updateChatMessagesBody() —— 只替换 tbody 与底部文案，
 *    不碰外层结构。
 *
 *    曾经每次加载更多都走整个函数（innerHTML 全量重建），后果有两个：
 *      1. 浏览器丢失 scrollTop → 表现为"明明在往下滚，却自己弹回上面"
 *      2. 工具栏事件被反复绑定 → 点一次发好几条
 */
function renderChatMessages() {
  const key = state.currentChatKey;
  if (!key) return;
  const detail = $('#chat-detail');
  if (!detail) return;

  // 切换会话时重置分页（每个会话独立从第一页开始）
  state.chatMsgLimit = CHAT_MSG_PAGE;

  const name = formatChatTitle(key, chatNameOf(key));
  const meta = state.chats.find((c) => c.key === key) || {};

  detail.innerHTML = `
    <div class="detail-header">
      <h2>${esc(name)} ${meta.unread ? `<span class="unread-pill">${meta.unread} 未读</span>` : ''}</h2>
      <div class="sub"><span data-field="chat-msg-count"></span></div>
    </div>
    <div class="chat-toolbar">
      <button class="btn btn-small" id="chat-wake-btn">唤醒一次处理</button>
      <button class="btn btn-small" id="chat-read-btn">全部标为已读</button>
      <input type="text" id="test-send-text" placeholder="手动发一条测试消息" style="flex:1" />
      <button class="btn btn-small" id="chat-testsend-btn">发送</button>
      <button class="btn btn-small btn-danger" id="chat-clear-btn" title="删除本会话的全部消息存档（不可撤销）">清空本会话存档</button>
    </div>
    <div class="hint" id="chat-wake-hint" style="margin:-4px 0 8px 0"></div>
    <table class="archive-table"><tbody id="chat-msg-body"></tbody></table>
    <div class="list-more muted" id="chat-msg-more"></div>`;

  // 工具栏事件：只在这里绑一次
  $('#chat-wake-btn').addEventListener('click', () => wakeOnce(key));
  $('#chat-read-btn').addEventListener('click', async () => {
    await api(`/api/chats/${key.replace(':', '_')}/mark-read`, { method: 'POST', body: '{}' });
    loadChats();
    // 保持视图：用户可能已经滚到中间了，别把他弹回顶部
    loadChatMessages(key, { keepView: true });
  });
  $('#chat-testsend-btn').addEventListener('click', async () => {
    const input = $('#test-send-text');
    const text = input.value.trim();
    if (!text) return;
    await api(`/api/chats/${key.replace(':', '_')}/test-send`, {
      method: 'POST', body: JSON.stringify({ text })
    });
    input.value = '';
    // 同理，保持当前分页与滚动位置
    loadChatMessages(key, { keepView: true });
  });
  // 清空本会话存档：删磁盘文件 + 内存态，删完这个会话就从左侧列表消失
  $('#chat-clear-btn').addEventListener('click', () => clearChatArchive(key));

  updateChatMessagesBody();
  // 滚动加载只挂一次（attachScrollLoader 内部有防重复）
  initChatScrollLoader();
  // 金句勾选：事件委托挂在容器上（tbody 会被轮询重建，委托不受影响的）。
  // 防重复：renderChatMessages 每次切会话都会跑，容器只绑一次。
  if (!detail.__quoteBound) {
    detail.__quoteBound = true;
    detail.addEventListener('change', (e) => {
      const cb = e.target.closest?.('.quote-check');
      if (!cb) return;
      const mid = Number(cb.dataset.mid);
      if (cb.checked) state.quoteSelected.add(mid); else state.quoteSelected.delete(mid);
      cb.closest('tr')?.classList.toggle('quote-selected', cb.checked);
    });
  }
  // 单条消息删除同样走事件委托：tbody 每 15 秒被轮询整体重建，
  // 把监听绑在行/按钮上会随重建一起丢掉。
  if (!detail.__msgDelBound) {
    detail.__msgDelBound = true;
    detail.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.msg-del');
      if (!btn) return;
      deleteOneMessage(state.currentChatKey, Number(btn.dataset.id), btn.dataset.text || '');
    });
  }
}

/**
 * 删除存档里的一条消息。
 *
 * 删掉的不只是存档页上的一行 —— 这条消息同时也从提示词的【过去状态】里消失，
 * 这正是管理端删存档的主要用途（把不想再进入上下文的内容拿掉）。
 */
function deleteOneMessage(chatKey, localId, preview) {
  if (!chatKey || !Number.isFinite(localId)) return;
  const text = String(preview || '');
  confirmDanger({
    head: '删除这条消息',
    okText: '删除',
    text: `<b>${esc(text.slice(0, 120))}${text.length > 120 ? '…' : ''}</b><br><br>
      这条消息会从存档里永久删除，并且<b>不会再被拼进机器人下一次的【过去状态】上下文</b>。<br><br>
      想清掉整段对话，用工具栏的「清空本会话存档」。此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/chats/${chatKey.replace(':', '_')}/messages/${localId}`, { method: 'DELETE', body: '{}' });
      await loadChats({ quiet: true });
      await loadChatMessages(chatKey, { keepView: true });
    }
  });
}

/** 清空某个会话的全部消息存档（连磁盘文件一起删，删完就从左侧列表消失）。 */
function clearChatArchive(chatKey) {
  if (!chatKey) return;
  const meta = (state.chats || []).find((c) => c.key === chatKey) || {};
  const name = formatChatTitle(chatKey, chatNameOf(chatKey));
  confirmDanger({
    head: '清空本会话存档',
    okText: `删除全部 ${meta.total || 0} 条`,
    text: `<b>${esc(name)}</b> 的 <b>${meta.total || 0}</b> 条消息存档将全部删除，
      磁盘文件 <code>data/messages/${esc(chatKey.replace(':', '_'))}.json</code> 一并删除。<br><br>
      ⚠️ 机器人从此<b>完全不记得</b>这段对话（提示词里不再有【过去状态】）。<br>
      「记忆」页里对群友的长期印象是另一个文件，不受影响 —— 要清得去记忆页。<br><br>
      此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/chats/${chatKey.replace(':', '_')}`, { method: 'DELETE', body: '{}' });
      state.currentChatKey = null;
      state.chatMessages = [];
      state.chatMsgLimit = CHAT_MSG_PAGE;
      chatMsgSortCache = { src: null, newestFirst: [] };
      const detail = $('#chat-detail');
      if (detail) detail.innerHTML = '<div class="empty-hint">← 选择会话查看消息存档</div>';
      await loadChats();
    }
  });
}

/**
 * 排序缓存：state.chatMessages 的引用不变就复用上次的排序结果。
 *
 * 曾经在 updateChatMessagesBody 里每次都 slice + sort + 再 slice + reverse
 * （两遍全量拷贝 + O(n log n)）。轮询进来数据确实会变（新数组引用，重排一次），
 * 但滚动加载更多时数据根本没动 —— 每滚一批就白排一遍，几万条时卡在滚动事件里。
 *
 * 用"稳定排序"而不是简单 reverse：存档里 ts 是秒级精度（实测 2000 条中有 18 处
 * 同一秒内的消息毫秒级逆序）。直接 reverse 会把这些也翻过来，导致同一秒内的
 * 消息顺序不对。先按 ts 稳定升序排一遍（Array.sort 在现代引擎里是稳定的），
 * 再反转，就能保证"新的在上"且同秒内顺序也正确。
 */
let chatMsgSortCache = { src: null, newestFirst: [] };
function chatMessagesNewestFirst() {
  const src = state.chatMessages || [];
  if (chatMsgSortCache.src !== src) {
    const sorted = src.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    sorted.reverse();
    chatMsgSortCache = { src, newestFirst: sorted };
  }
  return chatMsgSortCache.newestFirst;
}

/** 单行消息 HTML（全量渲染与滚动追加共用同一个模板，保证两处长得一样）。 */
function chatMsgRowHtml(m) {
  // 金句勾选模式：行首加勾选框；选中态存 state.quoteSelected（按消息 id），
  // 轮询重建行时勾选状态不丢
  const q = state.quoteMode
    ? `<td class="q-check"><input type="checkbox" class="quote-check" data-mid="${m.id}" ${state.quoteSelected.has(m.id) ? 'checked' : ''} /></td>`
    : '';
  const sel = state.quoteMode && state.quoteSelected.has(m.id) ? ' quote-selected' : '';
  return `
    <tr class="${m.read ? '' : 'unread'}${sel}" data-midrow="${m.id}">${q}
      <td class="t">${fmtTime(m.ts)}</td>
      <td class="w ${m.self ? 'self' : ''}">${m.self ? '我' : esc(m.senderName)}</td>
      <td class="text">${esc(m.text)}${m.read ? '' : ' <span class="unread-pill">未读</span>'}</td>
      <td style="width:34px;text-align:right"><button class="btn btn-small btn-danger msg-del" data-id="${m.id}" data-text="${esc(String(m.text || '').slice(0, 60))}" title="删除这条消息">×</button></td>
    </tr>`;
}

/** 更新底部"还有 N 条"与顶部计数文案（全量渲染与追加都要刷这两处）。 */
function updateChatMessagesMeta(newestFirst) {
  const total = newestFirst.length;
  const shownCount = Math.min(Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE), total);
  const rest = total - shownCount;
  const more = $('#chat-msg-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更早的（还有 ${rest} 条）`
      : (total > CHAT_MSG_PAGE ? `已显示全部 ${total} 条` : '');
  }
  const cnt = $('#chat-detail')?.querySelector('[data-field="chat-msg-count"]');
  if (cnt) {
    const meta = state.chats.find((c) => c.key === state.currentChatKey) || {};
    const t = meta.total || total || 0;
    cnt.textContent = t
      ? `共 ${t} 条 · 已显示 ${shownCount} 条 · 存储于 data/messages/`
      : '暂无消息';
  }
}

/**
 * 滚动加载更多的追加路径：只把新批次的行插到 tbody 末尾。
 * 不重排（走缓存）、不重建已有行、不碰滚动位置 —— 内容加在视口下方，
 * 浏览器天然保持视口稳定，所以这里**绝对不能**做 scrollTop 补偿。
 */
function appendChatMessageRows(prevShown) {
  const tbody = $('#chat-msg-body');
  if (!tbody) return;
  const newestFirst = chatMessagesNewestFirst();
  const limit = Math.min(state.chatMsgLimit, newestFirst.length);
  const rows = newestFirst.slice(prevShown, limit);
  if (rows.length) tbody.insertAdjacentHTML('beforeend', rows.map(chatMsgRowHtml).join(''));
  state.chatMsgRendered = limit;
  updateChatMessagesMeta(newestFirst);
}

/**
 * 只更新消息表格的内容（不重建外层结构）。
 * 轮询刷新与首次填充走这里 —— 表格内容变长，但滚动容器没动，
 * 所以用户的滚动位置天然保持，不会再"自己弹回上面"。
 *
 * @param {boolean} keepScroll 轮询路径传 true：新消息从**顶部**进来，
 *        内容高度变化会把视口顶走，按增量补偿回阅读位置。
 *        （滚动加载更多不走这里，走 appendChatMessageRows —— 底部追加不需要补偿）
 */
function updateChatMessagesBody(keepScroll = false) {
  const detail = $('#chat-detail');
  const tbody = $('#chat-msg-body');
  if (!detail || !tbody) return;

  const prevTop = keepScroll ? detail.scrollTop : 0;
  const prevHeight = keepScroll ? detail.scrollHeight : 0;

  // 倒序后取前 N 条 = 最新的 N 条（排序结果走引用缓存，数据没变不重排）
  const newestFirst = chatMessagesNewestFirst();
  state.chatMsgLimit = Math.max(CHAT_MSG_PAGE, Number(state.chatMsgLimit) || CHAT_MSG_PAGE);
  const shown = newestFirst.slice(0, state.chatMsgLimit);

  tbody.innerHTML = shown.map(chatMsgRowHtml).join('');
  state.chatMsgRendered = shown.length;   // 行数账本：滚动追加靠它判断该不该走增量
  updateChatMessagesMeta(newestFirst);

  // 保险：若内容高度变了导致视口跳动，按增量补偿回来
  if (keepScroll) {
    const delta = detail.scrollHeight - prevHeight;
    if (delta !== 0) detail.scrollTop = prevTop + delta;
  }
}

function renderUsageSkeleton() {
  const card = '<div class="usage-card skeleton"><div class="sk-line"></div><div class="sk-line short"></div></div>';
  const row = '<div class="sk-row"></div>';
  // 五张卡一行（与正式页面一致），加载完成时布局不跳
  return `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days"><span class="sk-line" style="width:180px"></span></div>
      </div>
      <div class="usage-cards">${card.repeat(5)}</div>
      <div class="sk-block">${row.repeat(5)}</div>
      <div class="sk-block">${row.repeat(4)}</div>
    </div>`;
}

/** 建骨架（只建一次，轮询走 updateUsagePage 以免滚动位置丢失）。 */
function renderUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>用量与成本</h2>
        <div class="usage-days">
          ${USAGE_RANGES.map(([v, label]) => `<button class="btn btn-small" data-range="${v}">${label}</button>`).join('')}
          <button class="btn btn-small" id="usage-refresh-btn" title="立即刷新">刷新</button>
        </div>
      </div>

      <!-- 估算成本放第一张：它是这张页的主指标（accent 描边/底色突出）。
           五张卡固定一行（曾经第一张跨两列、整体占两行，已按需求改单行）。 -->
      <div class="usage-cards">
        <div class="usage-card accent">
          <div class="uc-label">估算成本</div>
          <div class="uc-value" data-field="cost">-</div>
          <div class="uc-sub" data-field="cost-sub">-</div>
        </div>
        <div class="usage-card clickable" id="runs-card" title="点击查看各类工具分别调用了多少次">
          <div class="uc-label">调用次数 <span class="uc-more">明细 ›</span></div>
          <div class="uc-value" data-field="runs">-</div>
          <div class="uc-sub" data-field="runs-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">搜索次数 <span class="uc-tag">不计入成本</span></div>
          <div class="uc-value" data-field="search">-</div>
          <div class="uc-sub" data-field="search-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">输入 token</div>
          <div class="uc-value" data-field="prompt">-</div>
          <div class="uc-sub" data-field="prompt-sub">-</div>
        </div>
        <div class="usage-card">
          <div class="uc-label">缓存命中率</div>
          <div class="uc-value" data-field="rate">-</div>
          <div class="usage-bar"><div class="usage-bar-fill ok" data-field="rate-bar" style="width:0%"></div></div>
          <div class="uc-sub" data-field="rate-sub">-</div>
        </div>
      </div>

      <div data-block="days">
        <h3 class="usage-h3">按天</h3>
        <table class="usage-table clickable" data-table="days">
          <thead><tr><th>日期</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">缓存命中</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="chats">
        <h3 class="usage-h3">按会话</h3>
        <table class="usage-table clickable" data-table="chats">
          <thead><tr><th>会话</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div data-block="models">
        <h3 class="usage-h3">按模型
          <button class="btn btn-small ub-expand" id="models-expand" style="display:none">展开全部</button>
        </h3>
        <table class="usage-table clickable" data-table="models">
          <thead><tr><th>模型（渠道：模型 id）</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>`;

  // 「调用次数」卡片可点开明细（骨架重建后重新绑定，所以放在 renderUsagePage 里）
  const runsCard = $('#usage-page #runs-card');
  if (runsCard) runsCard.addEventListener('click', () => openToolBreakdown());

  $$('#usage-page [data-range]').forEach((el) => {
    el.addEventListener('click', () => {
      usageRange = el.dataset.range;
      loadUsageView({ force: true });
    });
  });
  $('#usage-refresh-btn')?.addEventListener('click', () => loadUsageView({ force: true }));

  // 行点击 → 弹明细
  box.querySelector('[data-table="days"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('day', tr.dataset.key);
  });
  box.querySelector('[data-table="chats"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('chat', tr.dataset.key);
  });
  box.querySelector('[data-table="models"]')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-key]');
    if (tr) openUsageBreakdown('model', tr.dataset.key);
  });

  updateUsagePage(stats, st, prices);
}

/** 只更新数值与表格行，不碰骨架。 */
function updateUsagePage(stats, st, prices) {
  const box = $('#usage-page');
  if (!box) return;
  const t = stats?.totals || {};
  const cfg = state.config || {};

  // 统一存字符串：曾经这里把数字直接赋给 textContent（如 runs=0 时存的是数字 0
  // 而非 '0'）。浏览器会隐式转换所以显示没问题，但类型不一致会在别处埋雷
  // （比较、测试断言、序列化时都可能踩到）。这里显式转成字符串。
  const set = (f, v) => {
    const el = box.querySelector(`[data-field="${f}"]`);
    if (!el) return;
    const s = String(v);
    if (el.textContent !== s) el.textContent = s;
  };

  // 价格口径说明（不再显示"当前模型" —— 全天可能换过多个模型）
  const today = st?.usage || {};
  set('runs', t.runs || 0);
  set('runs-sub', `今日 ${today.runs ?? 0} 次`);
  // 搜索次数：只列数量，不参与成本计算（搜索通常是资源包或免费的）
  const searches = Number(stats?.searchCount) || 0;
  set('search', fmtTok(searches));
  set('search-sub', searches
    ? (Number(stats?.toolCounts?.web_search) || 0) + (Number(stats?.toolCounts?.web_fetch) || 0) === searches
      ? '联网搜索 + 抓网页'
      : '联网搜索 + 抓网页'
    : '本区间没有联网');
  set('prompt', fmtTok(t.promptTokens));
  set('prompt-sub', `输出 ${fmtTok(t.completionTokens)}`);
  set('rate', `${((t.cacheHitRate || 0) * 100).toFixed(1)}%`);
  set('rate-sub', `命中 ${fmtTok(t.cachedTokens)} / 输入 ${fmtTok(t.promptTokens)}`);
  set('cost', fmtYuan(t.cost));
  set('cost-sub', stats?.rangeLabel || '');
  const bar = box.querySelector('[data-field="rate-bar"]');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, (t.cacheHitRate || 0) * 100)).toFixed(1)}%`;

  // 范围按钮高亮
  $$('#usage-page [data-range]').forEach((el) => {
    el.classList.toggle('btn-primary', el.dataset.range === String(usageRange));
  });

  // 单日/24小时 → 隐藏"按天"；「全部」也要显示（历史越长越需要按天看）
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days' || stats?.mode === 'all') ? '' : 'none';

  // 行数很多时（按模型常有几十行）默认只显示前 N 行，点"展开全部"再看全部。
  // 注意：后端不截断（保证求和一致），这里只是前端显示层面的折叠。
  const COLLAPSE_AT = 20;
  const fill = (name, list, build, opts = {}) => {
    const tbody = box.querySelector(`[data-table="${name}"] tbody`);
    if (!tbody) return;
    const wanted = list || [];
    const collapsed = Boolean(opts.collapsible) && wanted.length > COLLAPSE_AT
      && tbody.dataset.expanded !== '1';
    const shown = collapsed ? wanted.slice(0, COLLAPSE_AT) : wanted;
    const moreBtn = opts.expandBtn ? box.querySelector(opts.expandBtn) : null;
    if (moreBtn) {
      if (wanted.length > COLLAPSE_AT) {
        moreBtn.style.display = '';
        moreBtn.textContent = collapsed
          ? `展开全部（还有 ${wanted.length - COLLAPSE_AT} 行）`
          : '收起';
      } else {
        moreBtn.style.display = 'none';
      }
    }
    if (!wanted.length) {
      if (tbody.dataset.empty !== '1') {
        tbody.innerHTML = '<tr><td colspan="7" class="muted">无</td></tr>';
        tbody.dataset.empty = '1';
      }
      return;
    }
    tbody.dataset.empty = '0';
    const html = shown.map(build).join('');
    if (tbody.dataset.sig !== html) { tbody.innerHTML = html; tbody.dataset.sig = html; }
  };

  fill('days', stats?.days, (d) => `
    <tr data-key="${esc(d.day)}">
      <td>${esc(d.day)}</td>
      <td class="r">${d.runs}</td>
      <td class="r">${fmtTok(d.promptTokens)}</td>
      <td class="r">${fmtTok(d.completionTokens)}</td>
      <td class="r">${fmtTok(d.cachedTokens)}</td>
      <td class="r">${((d.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(d.cost)}</td>
    </tr>`);

  fill('chats', stats?.chats, (c) => `
    <tr data-key="${esc(c.key)}">
      <td>${esc(formatChatTitle(c.key, chatNameOf(c.key)))}</td>
      <td class="r">${c.runs}</td>
      <td class="r">${fmtTok(c.promptTokens)}</td>
      <td class="r">${fmtTok(c.completionTokens)}</td>
      <td class="r">${((c.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(c.cost)}</td>
    </tr>`);

  // 模型与供应商分两列显示：同一个 id 走不同渠道是不同的"商品"，
  // 价格可能差很多（中转站加价、:free 版本等），必须能区分开。
  fill('models', stats?.models, (m) => `
    <tr data-key="${esc(m.key)}">
      <td>${esc(m.vendor ? `${m.vendor}：${m.model}` : (m.model ?? m.key))}</td>
      <td class="r">${m.runs}</td>
      <td class="r">${fmtTok(m.promptTokens)}</td>
      <td class="r">${fmtTok(m.completionTokens)}</td>
      <td class="r">${((m.cacheHitRate || 0) * 100).toFixed(0)}%</td>
      <td class="r">${fmtYuan(m.cost)}</td>
    </tr>`, { collapsible: true, expandBtn: '#models-expand' });
}

/** 峰谷拆分条（弹窗外部上方展示；没用到分时段计价的模型则不显示）。 */
/**
 * 加载用量页。
 *
 * @param {boolean} force  true = 重建整个页面骨架（切换页签、切换时间范围、点刷新）；
 *                         false = 轮询刷新，只更新数值与表格行，不重建 DOM。
 *
 * ── 为什么要分开 ──
 * 轮询每 15 秒一次，如果每次都重建 DOM，用户正在看的行会被重新渲染、
 * 滚动位置也会丢。所以轮询走"只更新数值"这条路。
 *
 * ── 加载为什么快 ──
 * 1. 三个接口用 Promise.all **并行**请求（串行会慢 3 倍）
 * 2. 骨架屏**立即**显示，不等数据回来 —— 用户切过去马上看到布局，不会"黑一会"
 * 3. 竞态防护：请求期间用户可能切走或改了时间范围，回来时丢弃过期结果
 */
let usageLoadToken = 0;          // 每次加载递增，用于丢弃过期结果
let usageLastData = null;        // 上一次加载成功的数据：{ range, stats, st, prices }
                                 // 用于切回用量页时先立即画出旧内容，避免"黑一下"

async function loadUsageView({ force = false } = {}) {
  const box = $('#usage-page');
  if (!box) return;

  // ── 轮询刷新：只更新数值，不重建 DOM ──
  if (!force) {
    try {
      const [stats, st] = await Promise.all([
        api(`/api/usage/stats?range=${usageRange}`),
        api('/api/status')
      ]);
      // 用户可能已经切走页签了，那就别动了
      if (state.tab !== 'usage') return;
      state.usageStats = stats;
      // ⚠️ 价格不用再请求：启动时已加载进 state.modelPrices（/api/model-prices），
      //    更新时按需拉取即可。曾经这里请求了一个**不存在的** /api/usage/prices，
      //    404 会让整个 Promise.all reject → 用量页永远加载失败。
      updateUsagePage(stats, st, state.modelPrices || {});
    } catch (e) { /* 轮询失败静默，不打扰用户 */ }
    return;
  }

  // ── 强制重建 ──
  const token = ++usageLoadToken;
  const range = usageRange;

  // ★ 先用上一次的数据立即渲染（如果有的话），而不是先画骨架等网络。
  //   后端统计的冷启动实测约 200ms（要遍历全部会话文件），热数据只要 24ms；
  //   但缓存 TTL 只有 5 秒、轮询 4 秒一次，切回用量页时缓存经常已经过期，
  //   于是每次都要等那 200ms —— 表现就是"点过去黑一下"。
  //   有旧数据时直接先画出来（0ms 可见），再在后台拉新的覆盖。
  const cached = usageLastData && usageLastData.range === range ? usageLastData : null;
  if (cached) {
    state.usageStats = cached.stats;
    renderUsagePage(cached.stats, cached.st, cached.prices);
  } else {
    box.innerHTML = renderUsageSkeleton();
  }

  try {
    const [stats, st] = await Promise.all([
      api(`/api/usage/stats?range=${range}`),
      api('/api/status')
    ]);
    const prices = state.modelPrices || {};   // 启动时已加载，无需再请求
    // 竞态：期间用户切走了页签、或又点了别的时间范围 → 这次结果作废
    if (token !== usageLoadToken) return;
    if (state.tab !== 'usage' || usageRange !== range) return;

    state.usageStats = stats;
    usageLastData = { range, stats, st, prices };

    if (cached) {
      // 已有页面：只更新数值，不重建（避免打断用户的滚动/交互）
      updateUsagePage(stats, st, prices);
    } else {
      // ⚠️ renderUsagePage 不返回字符串 —— 它内部自己写 box.innerHTML、
      //    绑定事件、并调用 updateUsagePage 填数值。
      //    所以这里只能"直接调用"，不能再赋值（赋 undefined 会把页面清空）。
      renderUsagePage(stats, st, prices);
    }
  } catch (e) {
    if (token !== usageLoadToken) return;
    // 旧数据还在页面上就别用错误覆盖它（用户至少能看到上一次的数字）
    if (!cached) box.innerHTML = `<div class="empty-hint">用量加载失败：${esc(e?.message || e)}</div>`;
  }
}

function peakSplitHtml(sum) {
  if (!sum || !sum.hasPeakModel) return '';
  if (!(sum.peakCost > 0 || sum.offPeakCost > 0)) return '';
  const ratio = sum.peakRatio || 0;
  return `
    <div class="usage-peak">
      <div class="up-title">峰谷拆分</div>
      <div class="up-row">
        <span class="up-dot peak"></span>
        <span class="up-label">高峰时段</span>
        <span class="up-val">${fmtYuan(sum.peakCost)}</span>
        <span class="up-bar"><i style="width:${(ratio * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${(ratio * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-row">
        <span class="up-dot off"></span>
        <span class="up-label">闲时</span>
        <span class="up-val">${fmtYuan(sum.offPeakCost)}</span>
        <span class="up-bar"><i class="off" style="width:${((1 - ratio) * 100).toFixed(1)}%"></i></span>
        <span class="up-pct">${((1 - ratio) * 100).toFixed(0)}% token</span>
      </div>
      <div class="up-hint">高峰 = 北京时间工作日 9:00-12:00、14:00-18:00；周末全天闲时。</div>
    </div>`;
}

/**
 * 点表格行 → 弹明细。
 * dim 决定可选的第二个维度：
 *   chat  → 按模型 / 按天
 *   model → 按会话 / 按天
 *   day   → 按模型 / 按会话
 */
function openUsageBreakdown(dim, key) {
  const tabs = {
    chat: [['model', '各模型'], ['day', '各天']],
    model: [['chat', '各群聊'], ['day', '各天']],
    day: [['model', '各模型'], ['chat', '各群聊']]
  }[dim] || [['model', '各模型']];

  const dimLabel = { chat: '会话', model: '模型', day: '日期' }[dim] || '';
  let activeBy = tabs[0][0];

  const overlay = modelModalShell({
    head: `明细：${dimLabel} ${esc(key)}`,
    body: `
      <div class="ub-wrap">
        <div class="ub-tabs" id="ub-tabs">${tabs.map(([v, l]) => `<button class="btn btn-small" data-by="${v}">${l}</button>`).join('')}</div>
        <div id="ub-peak"></div>
        <div class="ub-scroll">
          <table class="usage-table">
            <thead><tr><th id="ub-col">项目</th><th class="r">调用</th><th class="r">输入</th><th class="r">输出</th><th class="r">命中率</th><th class="r">成本</th></tr></thead>
            <tbody id="ub-body"><tr><td colspan="6" class="muted">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>`,
    foot: `<button class="btn" id="ub-close">关闭</button>`
  });

  const bodyEl = overlay.querySelector('#ub-body');
  const peakEl = overlay.querySelector('#ub-peak');
  const colEl = overlay.querySelector('#ub-col');

  async function load() {
    bodyEl.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>';
    try {
      const r = await api(`/api/usage/breakdown?range=${encodeURIComponent(usageRange)}&dim=${dim}&key=${encodeURIComponent(key)}&by=${activeBy}`);
      peakEl.innerHTML = peakSplitHtml(r.totals);
      colEl.textContent = { model: '模型', chat: '会话', day: '日期' }[activeBy] || '项目';
      bodyEl.innerHTML = (r.rows || []).length
        ? r.rows.map((x) => `
            <tr>
              <td>${esc(activeBy === 'chat'
                ? formatChatTitle(x.key, chatNameOf(x.key))
                : (x.vendor ? `${x.vendor}：${x.model}` : (x.model ?? x.key)))}</td>
              <td class="r">${x.runs}</td>
              <td class="r">${fmtTok(x.promptTokens)}</td>
              <td class="r">${fmtTok(x.completionTokens)}</td>
              <td class="r">${((x.cacheHitRate || 0) * 100).toFixed(0)}%</td>
              <td class="r">${fmtYuan(x.cost)}</td>
            </tr>`).join('')
        : '<tr><td colspan="6" class="muted">无数据</td></tr>';
    } catch (e) {
      bodyEl.innerHTML = `<tr><td colspan="6" class="muted">加载失败：${esc(e.message)}</td></tr>`;
    }
  }

  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((el) => {
    el.addEventListener('click', () => {
      activeBy = el.dataset.by;
      overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
      load();
    });
  });
  overlay.querySelector('#ub-close').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelectorAll('#ub-tabs [data-by]').forEach((x) => x.classList.toggle('btn-primary', x.dataset.by === activeBy));
  load();
}

// ── 记忆视图 ──
/**
 * 待审提案区（渲染进「记忆」页顶部）。
 *
 * 设计边界：**只展示与打标记，不执行**。理由见 src/proposals.js 顶部（注入通道 + 无审核点）。
 * 位置选在记忆页顶部而不是新开页签：提案里最多的就是"想改记忆方式"，
 * 放在记忆旁边最容易被看到；也不必再写一个页面的骨架。
 */
function renderProposalReview() {
  const box = $('#proposal-review');
  if (!box) return;
  const items = state.proposals || [];
  const accepted = state.proposalsAccepted || [];
  const counts = state.proposalCounts || {};
  const pending = counts.pending ?? items.length;

  const kindCls = { memory: 'ok', persona: 'warn', feature: 'info', code: 'err', other: '' };
  // 卡片。⚠️ accepted 的卡片去掉"采纳"按钮（已经采纳了），换成"标记已实现" ——
  //    否则那一栏永远越积越长，而且看不出哪条真的做完了。
  const card = (p, isAccepted) => {
    const when = p.at ? new Date(p.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const from = p.fromChat ? `　来自 ${esc(p.fromChat)}` : '';
    const reviewed = isAccepted && p.reviewedAt
      ? `<span class="muted" style="font-size:11px">　采纳于 ${esc(new Date(p.reviewedAt).toLocaleString('zh-CN', { hour12: false }))}</span>`
      : '';
    return `<div class="proposal-card${isAccepted ? ' proposal-card--accepted' : ''}" data-id="${esc(p.id)}">
      <div class="proposal-card__head">
        <span class="proposal-kind ${isAccepted ? 'ok' : (kindCls[p.kind] || '')}">${isAccepted ? '已采纳' : esc(p.kindLabel || p.kind)}</span>
        <span class="proposal-card__title">${esc(p.title)}</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size:11px">${esc(when)}${from}</span>
      </div>
      <div class="proposal-card__detail">${esc(p.detail)}</div>
      ${p.rationale ? `<div class="hint">理由：${esc(p.rationale)}</div>` : ''}
      ${reviewed}
      <div class="proposal-card__foot">
        <span class="hint" style="margin:0">${isAccepted ? '已列入待办，改动由人来做' : '提案只是文字，勾选不会执行任何改动'}</span>
        <span class="spacer"></span>
        ${isAccepted
          ? `<button class="btn btn-small" data-proposal="pending" data-id="${esc(p.id)}" title="放回待审">撤回</button>
             <button class="btn btn-small btn-primary" data-proposal="done" data-id="${esc(p.id)}">标记已实现</button>`
          : `<button class="btn btn-small" data-proposal="rejected" data-id="${esc(p.id)}">不采纳</button>
             <button class="btn btn-small btn-primary" data-proposal="accepted" data-id="${esc(p.id)}">采纳（待办）</button>`}
      </div>
    </div>`;
  };

  if (!items.length && !accepted.length) {
    box.innerHTML = `<div class="proposal-head">
      <span class="proposal-title">改进提案</span>
      <span class="segchips"><span class="chip">待审<span class="n">0</span></span></span>
    </div>
    ${hintLine('她可以在聊天里提议改自己（记忆/人设/功能/底层都行），提议不会自动生效。',
      '她用 submit_proposal 提交，提议只会出现在这里，任何一项都不会自动执行；'
      + '「采纳」只是打个标记、列进待办，真正动手由人来做（见 src/proposals.js 顶部）。')}`;
    return;
  }

  // 已采纳那一栏默认折叠：这是"工单存档"，平时不占地方，但要能查得到
  //（2026-09-19 修：原来只拉 pending ⇒ 一采纳就从列表消失，用户问"采纳之后在哪看"才发现）
  const acceptedHtml = accepted.length
    ? `<details class="proposal-accepted"><summary>已采纳（${accepted.length}）—— 列在待办里，改动由人来做</summary>
         ${accepted.map((p) => card(p, true)).join('')}
       </details>`
    : '';

  // ── UI 改造第二阶段 条目 5：提案块降噪 ─────────────────────────────────
  // 方案要求："标题+「待审 0」「已采纳 5」分段芯片+刷新收为一行；删重复标签「改进提案（5）」；
  //   两段说明压成一行「只记录想法，不会自动执行 ⓘ」（采纳流程、SnowLuma 链接进 ⓘ）"
  // ⇒ 标题与计数合成**一行**，说明压成**一行 + ⓘ**（hintLine）。
  // ⚠️ 原来标题是两处（`.proposal-title` 写了两次，一份在"暂无"分支一份在这里），
  //    且 `.uc-tag` 与 `已采纳（N）` 在折叠头里**又重复了一次**。全部收掉。
  box.innerHTML = `<div class="proposal-head">
      <span class="proposal-title">改进提案</span>
      <span class="segchips">
        <span class="chip${pending ? ' on' : ''}" title="还没处理的条数">待审<span class="n">${pending}</span></span>
        ${accepted.length ? `<span class="chip" title="已采纳、还没做完的条数">已采纳<span class="n">${accepted.length}</span></span>` : ''}
      </span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="proposal-refresh">刷新</button>
    </div>
    ${hintLine('只记录想法，不会自动执行。',
      '采纳只是打个标记、列进待办，真正动手由人来做（见 src/proposals.js 顶部）。'
      + '提案里最多的就是"想改记忆方式"，所以放在记忆页而不是新开页签。')}
    ${items.map((p) => card(p, false)).join('')}
    ${acceptedHtml}`;

  $('#proposal-refresh')?.addEventListener('click', () => loadProposals().then(() => renderProposalReview()));
  $$('#proposal-review [data-proposal]').forEach((b) => {
    b.addEventListener('click', async () => {
      const status = b.dataset.proposal;
      b.disabled = true;
      try {
        await api(`/api/proposals/${encodeURIComponent(b.dataset.id)}`, {
          method: 'POST',
          body: JSON.stringify({ status })
        });
        await loadProposals();
        renderProposalReview();
      } catch (e) {
        alert(`标记失败：${e.message}`);
        b.disabled = false;
      }
    });
  });
}

async function loadProposals() {
  try {
    // ⚠️ 2026-09-19 修：原来只拉 `status=pending` ⇒ **一采纳就从列表里消失**，
    //    用户问"采纳之后在哪看"时才暴露出这个洞。现在待审与已采纳都拉。
    //    已实现(done)与不采纳(rejected)刻意不进列表：它们已归档，留着只会让这块越来越长。
    const [pend, acc] = await Promise.all([
      api('/api/proposals?status=pending'),
      api('/api/proposals?status=accepted')
    ]);
    state.proposals = pend.items || [];
    state.proposalsAccepted = acc.items || [];
    state.proposalCounts = { ...(pend.counts || {}), ...(acc.counts || {}) };
  } catch (e) {
    // 取不到就保持原值，别清空成"没有提案"的假象
    console.warn('[proposal] 拉取失败：', e?.message || e);
  }
}

async function loadMemoryView() {
  try {
    const [cfg, chats] = await Promise.all([api('/api/config'), api('/api/chats')]);
    state.config = cfg;
    const files = await api('/api/memory-files');
    state.memoryFiles = files.files || [];
    state.chats = chats.chats || [];
    await loadProposals();   // 待审提案（记忆页顶部那块）
    // 用后端状态校正本地记录：覆盖"页面刚刷新""SSE 断连期间状态变化"两种情况。
    // 后端 consolidating 是唯一可信来源（它在 orchestrator 里真实维护）。
    for (const f of state.memoryFiles) {
      if (f.consolidating) {
        if (!state.consolidating[f.chatKey]) {
          state.consolidating[f.chatKey] = { startedAt: Date.now() };
        }
      } else if (state.consolidating[f.chatKey]) {
        // 后端已经不在整理，说明完成了（结果由 SSE 事件补充）
        delete state.consolidating[f.chatKey];
        if (!state.consolidateResult[f.chatKey]) {
          state.consolidateResult[f.chatKey] = { note: '整理完成', at: Date.now() };
        }
      }
    }
    renderMemoryList();
    if (state.currentMemoryChatKey) loadMemoryDetail(state.currentMemoryChatKey);
  } catch (e) {
    console.error('加载记忆视图失败:', e);
    $('#memory-items').innerHTML = '<div class="list-head muted">加载失败</div>';
  }
}

// 整理中的计时刷新：让"已 Ns"持续走动，并在没有活跃任务时自动停掉。
// 整理可能持续几十秒，用户切走再切回时靠它维持可见状态。
let consolidateTicker = null;
function startConsolidateTicker() {
  if (consolidateTicker) return;
  consolidateTicker = setInterval(() => {
    const active = Object.keys(state.consolidating);
    if (!active.length) {
      clearInterval(consolidateTicker);
      consolidateTicker = null;
      if (state.tab === 'memory') renderMemoryList();
      return;
    }
    if (state.tab !== 'memory') return;
    // 只更新计时文本，不重建整个详情页（避免打断用户阅读/滚动）
    const key = state.currentMemoryChatKey;
    const el = $('#mem-consolidate-status');
    if (key && state.consolidating[key] && el) {
      const sec = Math.max(0, Math.round((Date.now() - (state.consolidating[key].startedAt || Date.now())) / 1000));
      el.textContent = `整理中…（已 ${sec}s）`;
    }
    renderMemoryList();
  }, 1000);
}

// ── 笔记页（夜里做的「梦」）───────────────────────────────────────────────
//
// 只读功能：模型写这条笔记时**一个工具都没给**，所以它改不了记忆、碰不了人设卡、
// 发不了消息（原因见 src/dream.js 开头）。这里只负责显示 + 开关 + 手动做一次。
async function loadDreams() {
  const page = $('#dreams-page');
  if (!page) return;

  let data;
  try {
    data = await api('/api/dreams');
  } catch (error) {
    page.innerHTML = `<div class="empty-hint">读不到笔记：${esc(error?.message || error)}</div>`;
    return;
  }

  const notes = Array.isArray(data.notes) ? data.notes : [];
  // 渲染一篇笔记：现在是「按会话分章 + 总感想」，所以按章节分段显示而不是糊成一大块。
  // ⚠️ 老笔记没有 segments 字段（改造前写的）⇒ 退回显示整篇 text，别让它变空白。
  const noteBody = (n) => {
    const segs = Array.isArray(n.segments) ? n.segments : [];
    if (!segs.length && !n.global) return `<div class="dream-text">${esc(n.text || '')}</div>`;
    const parts = segs.map((s) => `<div class="dream-seg">
        <div class="dream-seg__label">${esc(s.label || s.key || '（未标会话）')}</div>
        <div class="dream-text">${esc(s.text || '')}</div>
      </div>`).join('');
    const g = String(n.global || '').trim()
      ? `<div class="dream-seg dream-seg--global">
          <div class="dream-seg__label">总感想（全局可见）</div>
          <div class="dream-text">${esc(n.global)}</div>
        </div>`
      : '';
    return parts + g;
  };
  const listHtml = notes.length
    ? notes.map((n) => `
      <div class="dream-card">
        <div class="dream-head">
          <span class="dream-day">${esc(n.day)}</span>
          <span class="muted">${esc(fmtClock(n.at))}</span>
          <span class="muted" style="margin-left:auto">${Number(n.messages) || 0} 条消息 · ${Number(n.chats) || 0} 个会话${n.model ? ` · ${esc(n.model)}` : ''}</span>
        </div>
        ${noteBody(n)}
      </div>`).join('')
    : `<div class="empty-hint">还没有笔记。${data.enabled ? '等夜里安静下来，它就会写一条。' : '「夜里做『梦』」现在是关着的。'}</div>`;

  // 关着的时候也把原因说清楚，免得点了"现在做一次"像是没反应
  const hint = data.running
    ? '正在做梦…'
    : (data.whyNot
      ? `自动做梦的条件还没满足：${data.whyNot}。（手动点「现在做一次」不受这些限制）`
      : '条件都满足了，下一次检查（5 分钟内）就会写一条。');

  page.innerHTML = `
    <div class="dream-wrap">
      <div class="dream-bar">
        <label class="dream-toggle" title="夜里没人说话时，让它把当天的事整理成一条笔记">
          <input type="checkbox" id="dream-enabled" ${data.enabled ? 'checked' : ''} />夜里做「梦」
        </label>
        <span class="muted">时段 ${esc(data.startHour)}:00 ~ ${esc(data.endHour)}:00 · 需安静 ${esc(data.minIdleMinutes)} 分钟</span>
        <span style="margin-left:auto"></span>
        <button class="btn btn-small" id="dream-now">现在做一次</button>
        <button class="btn btn-small btn-danger" id="dream-clear">清空笔记</button>
      </div>
      <div class="hint dream-hint">${esc(hint)}</div>
      <div class="dream-list">${listHtml}</div>
    </div>`;

  // ── 开关 ──
  $('#dream-enabled')?.addEventListener('change', async (e) => {
    const enabled = !!e.target.checked;
    e.target.disabled = true;
    try {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ dream: { enabled } }) });
      await loadDreams();
    } catch (error) {
      alert(`保存失败：${error?.message || error}`);
      e.target.checked = !enabled;
      e.target.disabled = false;
    }
  });

  // ── 现在做一次 ──
  $('#dream-now')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在做梦…';
    try {
      // force=true：跳过开关/时段/"今天做过了"，但仍然要有模型、要有人说过话
      const r = await api('/api/dream', { method: 'POST', body: JSON.stringify({ force: true }) });
      if (!r.ok) alert(`这次没写成：${r.reason || '未知原因'}`);
      await loadDreams();
    } catch (error) {
      alert(`做梦失败：${error?.message || error}`);
      btn.textContent = label;
      btn.disabled = false;
    }
  });

  // ── 清空 ──
  $('#dream-clear')?.addEventListener('click', async () => {
    const n = notes.length;
    if (!n) { alert('还没有笔记。'); return; }
    if (!confirm(`删掉全部 ${n} 条笔记？删了就找不回来了。`)) return;
    try {
      await api('/api/dreams', { method: 'DELETE' });
      await loadDreams();
    } catch (error) {
      alert(`清空失败：${error?.message || error}`);
    }
  });
}

function renderMemoryList() {
  const box = $('#memory-items');
  const files = state.memoryFiles || [];
  const names = {};
  for (const c of state.chats || []) names[c.key] = formatChatTitle(c.key, chatNameOf(c.key));

  // ── 待审提案区（2026-09-19 第七对话加）────────────────────────────────
  // ⚠️ 这是**只读展示 + 打标记**，这一页**不会执行任何提案内容**。
  //    为什么坚持不自动执行：她的上下文混着群友说的话，而"待审条目本身"就是一条注入通道；
  //    只要自动执行存在，"诱导她提一条看起来无害的改动 + 管理员瞟一眼点同意"就能被利用。
  //    详见 src/proposals.js 顶部的边界说明。
  renderProposalReview();

  // 「显示空记忆」开关（**常驻元素、只绑一次**；状态记在 localStorage 里）
  // ⚠️ UI 改造第二阶段条目 5：这个开关原来在**列表头**，现在移到记忆详情的「记忆」分区标题右侧
  //    （方案要求"「显示空记忆」归位其右侧"——它管的是"详情里列哪些人"，放列表头语义错位）。
  // ⚠️ 它现在住在**每轮重建的详情区**里 ⇒ 每次重建都会换一个新元素，
  //    所以 `__bound` 这个"只绑一次"的守卫必须**每次渲染后清掉**，否则第二次渲染后
  //    新元素上没有监听器 —— 开关变死件（点不动、也不报错）。
  const showEmptyBox = $('#mem-show-empty');
  if (showEmptyBox) {
    showEmptyBox.checked = state.showEmptyMemory === true;
    showEmptyBox.addEventListener('change', () => {
      state.showEmptyMemory = showEmptyBox.checked;
      try { localStorage.setItem('dsh-mem-show-empty', showEmptyBox.checked ? '1' : '0'); } catch { /* ignore */ }
      renderMemoryList();
    });
  }

  // 空记忆（白名单里还没有记忆文件的会话）默认不显示；手动隐藏过的同理。
  // 它们**不是文件**，删不掉 —— 记忆页是按白名单生成的，删了下次渲染又长出来。
  const showEmpty = state.showEmptyMemory === true;
  const visible = files.filter((f) => {
    if (f.hidden) return showEmpty;          // 手动隐藏的：只在打开开关时出现
    if (f.empty && !showEmpty) return false; // 白名单里的空壳：默认折叠
    return true;
  });

  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何记忆（等机器人使用记忆工具后才会出现）</div>';
    return;
  }
  if (!visible.length) {
    box.innerHTML = '<div class="list-head muted">这里没有有记忆的会话。勾选上面的「显示空记忆」可以看到白名单里那些还没有记忆的。</div>';
    return;
  }
  box.innerHTML = visible.map((f) => {
    const key = f.chatKey;
    const busy = !!state.consolidating[key];
    // 整理中：在列表项上直接标出，切页签回来也能一眼看到
    const busyHtml = busy
      ? `<span class="unread-pill" style="background:var(--color-background-warning)">整理中…</span>`
      : '';
    const sub = busy
      ? '正在整理本群记忆'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : (f.hidden ? '没有记忆文件（已隐藏）' : '没有记忆文件（空壳，删不掉）'));
    // 有记忆 → 清空；空壳 → 隐藏 / 恢复隐藏
    const action = !f.empty
      ? `<button class="btn btn-small btn-danger mem-list-del" data-key="${esc(key)}" data-act="wipe" title="清空这个会话的记忆">删除</button>`
      : (f.hidden
        ? `<button class="btn btn-small mem-list-del" data-key="${esc(key)}" data-act="unhide" title="重新显示这个空壳">恢复</button>`
        : `<button class="btn btn-small mem-list-del" data-key="${esc(key)}" data-act="hide" title="从列表里隐藏（它不是文件，删不掉）">隐藏</button>`);
    return `
      <div class="chat-item ${key === state.currentMemoryChatKey ? 'selected' : ''}" data-key="${esc(key)}">
        <div class="chat-item-title">
          <span class="session-chat">${esc(names[key] || key)}</span>
          ${busyHtml}
        </div>
        <div class="chat-item-sub">${esc(sub)}</div>
        <div class="session-meta"><span>更新于 ${fmtTime(f.updatedAt || 0)}</span>
          <span style="margin-left:auto">${action}</span></div>
      </div>`;
  }).join('');
  $$('.chat-item', box).forEach((el) => {
    el.addEventListener('click', () => {
      state.currentMemoryChatKey = el.dataset.key;
      renderMemoryList();
      loadMemoryDetail(state.currentMemoryChatKey);
    });
  });
  $$('.mem-list-del', box).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();   // 别顺带把"选中这条"也触发了
      memoryListAction(el.dataset.act, el.dataset.key);
    });
  });
}

/**
 * 记忆列表行上的操作。
 *   wipe   —— 有记忆：清空（等价于详情页的「清空本群记忆」）
 *   hide   —— 空壳：记进 config.memory.hiddenEmptyChats，列表里不再显示
 *   unhide —— 把隐藏的空壳放出来
 */
async function memoryListAction(act, chatKey) {
  if (!chatKey) return;
  const name = formatChatTitle(chatKey, chatNameOf(chatKey));
  const f = (state.memoryFiles || []).find((x) => x.chatKey === chatKey) || {};

  if (act === 'wipe') {
    confirmDanger({
      head: '清空本会话记忆',
      okText: '清空',
      text: `<b>${esc(name)}</b> 的 <b>${f.memberCount || 0}</b> 位群友、<b>${f.impressionCount || 0}</b> 条印象将全部删除：
        <code>data/memory/${esc(chatKey.replace(':', '_'))}/</code> 整个目录连同整理备份一起删掉。<br><br>
        ⚠️ 聊天记录存档不受影响（那是另一个文件）。<br>此操作不可撤销。`,
      onOk: async () => {
        await api(`/api/memory-files/${chatKey.replace(':', '_')}`, { method: 'DELETE', body: '{}' });
        if (state.currentMemoryChatKey === chatKey) {
          state.currentMemoryChatKey = null;
          const detail = $('#memory-detail');
          if (detail) detail.innerHTML = '<div class="empty-hint">← 选择会话查看记忆</div>';
        }
        await loadMemoryView();
      }
    });
    return;
  }

  // hide / unhide：改 config.memory.hiddenEmptyChats（用 __replace__ 整体替换，这样"恢复"才能真的删掉键）
  try {
    const cfg = await api('/api/config');
    const list = (cfg.memory?.hiddenEmptyChats || []).map(String);
    const next = act === 'hide'
      ? [...new Set([...list, chatKey])]
      : list.filter((k) => k !== chatKey);
    await api('/api/config', { method: 'POST', body: JSON.stringify({ memory: { hiddenEmptyChats: { __replace__: next } } }) });
    await loadMemoryView();
    if (act === 'hide') {
      showNoticeModal('已隐藏这个空壳', `「${name}」本来就没有记忆文件 —— 它出现在列表里，是因为它在白名单里（这是为了让你从列表点进去手动添加印象）。\n\n现在它不再占用列表位置。想找回来：勾选列表上方的「显示空记忆」。\n\n注意：这不影响机器人在这个会话里工作；如果你是不想让它在这个群/私聊里干活，请去「白名单」页把它移除。`);
    }
  } catch (e) {
    alert(`操作失败：${e.message}`);
  }
}

async function loadMemoryDetail(chatKey) {
  const detail = $('#memory-detail');
  detail.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    const [mem, cfg, ident] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config'),
      // 身份表 + 各会话平台：给"同一个人…"按钮用。
      // 失败不能拖垮整页（它只是锦上添花），所以单独 catch 成空数据。
      api('/api/memory-identity').catch(() => ({ chats: [], identity: {} }))
    ]);
    // 把刚取到的配置存回 state：下面 memInteropHtml() 从 state.config 读（与页面其它处一致），
    // 不存的话它读到的是空对象 —— 复选框就会显示成"关"，而实际可能是开的（显示与真相不符）。
    state.config = cfg;
    // 会话 → 平台：身份键必须带平台，否则 QQ 与微信撞号会认错人（见 config.js 的 memory.identity）
    state.chatPlatforms = {};
    for (const c of (ident.chats || [])) state.chatPlatforms[c.chatKey] = c.platform;
    const identMap = ident.identity || {};
    state.identityChats = ident.chats || [];
    const notes = cfg.memberNotes || {};
    const shareMap = (cfg.memory && cfg.memory.share) || {};
    const kind = chatKey.startsWith('group') ? 'group' : 'private';
    const chatId = chatKey.split(':')[1] || '';
    const members = Array.isArray(mem.members) ? mem.members : [];
    const membersHtml = kind === 'group'
      ? `<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>`
      : '';
    const rows = members.map((m) => {
      const who = notes[String(m.userId)] || m.name || m.userId || '某人';
      const qq = m.userId ? ` <span class="muted">(QQ ${esc(m.userId)})</span>` : '';
      const imps = m.impressions.map((e) => `- ${e.content}`).join('\n');
      // 没有 QQ 号的旧数据（早期按名字落文件的兜底条目）定位不到成员接口，
      // 只能走"清空本群记忆"，这里把按钮禁掉并说明原因，别让用户点了没反应。
      const canDel = /^\d{1,15}$/.test(String(m.userId || ''));
      const delTitle = canDel
        ? '删除这个人的全部印象'
        : '这条记忆没有 QQ 号（旧数据），请用右上角「清空本群记忆」删除';
      // 跨会话互通：方向是**按 QQ 号全局**设的（不是按会话），所以在哪个会话里改都一样。
      // 没有 QQ 号的旧数据选不了，直接不显示这个下拉。
      const shareSel = canDel
        ? `<label class="mem-share" title="让这个人在**别的会话**里的印象也进当前会话的提示词。只影响读，写入仍然只写当前会话。方向是按 QQ 号全局生效的。">
             跨会话
             <select class="mem-share-sel" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}">
               <option value=""${!shareMap[String(m.userId)] ? ' selected' : ''}>不互通</option>
               <option value="both"${shareMap[String(m.userId)] === 'both' ? ' selected' : ''}>双向（私聊 ⇄ 群）</option>
               <option value="toPrivate"${shareMap[String(m.userId)] === 'toPrivate' ? ' selected' : ''}>只并进私聊</option>
               <option value="toGroup"${shareMap[String(m.userId)] === 'toGroup' ? ' selected' : ''}>只并进群聊</option>
             </select>
           </label>`
        : '';
      // 「同一个人」：把这个会话里的这个人，与**别的会话**里的某人标成同一人。
      // 为什么必须人工标：QQ 号与微信派生 id 在同一个数值空间里会撞号，
      // 而同一个真人两边 id 又不同 ⇒ 自动合并两头都错（详见 config.js 的 memory.identity 注释）。
      const chatPlat = state.chatPlatforms?.[chatKey] || 'qq';
      const linked = !!(identMap[`${chatPlat}:${m.userId}`]);
      const identLabel = canDel
        ? `<button class="btn btn-small mem-ident-btn" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px"
             title="把这个人与别的会话里的某人标成「同一个人」，跨平台/跨会话认人才成立">${linked ? '✓ 已关联' : '同一个人…'}</button>`
        : '';
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
          <button class="btn btn-small btn-danger mem-del-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" ${canDel ? '' : 'disabled'} title="${delTitle}">删除</button>
          ${identLabel}
          ${shareSel}
        </summary>
        <div class="coll-body">${esc(imps)}</div>
      </div>`;
    }).join('');
    // 整理状态从 state 恢复：切页签回来 / 刷新页面后依然可见
    const busy = !!state.consolidating[chatKey];
    const result = state.consolidateResult[chatKey];
    let consolidateStatusHtml = '';
    if (busy) {
      const started = state.consolidating[chatKey]?.startedAt || Date.now();
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">整理中…（已 ${sec}s）</span>`;
    } else if (result) {
      const ago = Math.max(0, Math.round((Date.now() - (result.at || 0)) / 1000));
      const when = ago < 60 ? `${ago}s 前` : `${Math.round(ago / 60)} 分钟前`;
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted">${esc(result.note)}（${when}）</span>`;
    } else {
      consolidateStatusHtml = `<span id="mem-consolidate-status" class="muted"></span>`;
    }
    detail.innerHTML = `
      <div class="detail-header">
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的记忆</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群记忆'}</button>
          <button class="btn btn-small btn-danger" id="mem-clear-btn" ${members.length ? '' : 'disabled title="这个会话没有记忆文件（它出现在列表里是因为在白名单里），没什么可清的"'}>清空本群记忆</button>
          <span id="mem-share-status" class="muted"></span>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${memInteropHtml(chatKey)}
      <div class="pt-sec">记忆 <span class="muted" style="font-weight:400">这个会话记住的每个人</span>
        <span class="ph-spacer"></span>
        <label class="toggle" id="mem-empty-toggle-wrap" title="勾上之后，白名单里那些还没有记忆文件的会话也会出现在左侧列表里 —— 便于点进去手动添加印象">
          <input type="checkbox" id="mem-show-empty">
          <span class="tg-track"><span class="tg-knob"></span></span>
          <span class="tg-text">显示空记忆</span>
        </label>
      </div>
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
    // 「记忆互通」这一节：三个开关都**默认关**，改完立刻写 config（见 saveMemoryInterop）
    const uniOn = $('#mem-unified');
    if (uniOn) {
      uniOn.addEventListener('change', () => saveMemoryInterop({ unified: uniOn.checked }, detail));
      uniOn.checked = !!(cfg.memory && cfg.memory.unified === true);
    }
    const scopeSel = $('#mem-members-scope');
    if (scopeSel) {
      scopeSel.addEventListener('change', () => saveMemoryInterop({ unifiedMembers: scopeSel.value }, detail));
    }
    $$('.mem-group-toggle', detail).forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); toggleChatInGroup(el.dataset.group, chatKey, detail) });
    });
    $('#mem-group-add')?.addEventListener('click', () => addGroupWithChat(chatKey, detail));
    const loadMembersBtn = $('#mem-load-members-btn');
    if (loadMembersBtn) loadMembersBtn.addEventListener('click', () => loadGroupMembers(chatId, chatKey));
    $$('.mem-edit-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openMemberImpressModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name, impressions: [] });
      });
    });
    $('#mem-add-imp-btn')?.addEventListener('click', () => openMemberImpressModal(chatKey, null));
    $('#mem-clear-btn')?.addEventListener('click', () => clearChatMemory(chatKey));
    // 「同一个人」关联：把这个会话里的这个人，与别的会话里的某人标成同一人
    $$('.mem-ident-btn', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();   // 别把 <details> 收起来
        const m = members.find((x) => String(x.userId) === String(el.dataset.qq));
        openIdentityModal(chatKey, m || { userId: el.dataset.qq, name: el.dataset.name });
      });
    });
    // 跨会话互通方向：按 QQ 号全局设，改完写进 config.memory.share
    $$('.mem-share-sel', detail).forEach((el) => {
      el.addEventListener('click', (e) => e.stopPropagation());   // 别把 <details> 收起来
      el.addEventListener('change', async () => {
        const okSaved = await saveMemoryShare(String(el.dataset.qq || ''), el.value, detail);
        if (!okSaved) { el.value = el.dataset.prev || ''; return }
        el.dataset.prev = el.value;
      });
      el.dataset.prev = el.value;
    });
    // 删除单个群友的全部印象
    $$('.mem-del-imp', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        deleteMemberMemory(chatKey, String(el.dataset.qq || ''), el.dataset.name || '');
      });
    });
    // 针对单个群友更新记忆：有印象→整理合并；无印象→从聊天记录提炼
    $$('.mem-refresh-imp', detail).forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const uid = String(el.dataset.qq || '').trim();
        if (!/^\d{1,15}$/.test(uid)) { alert('该群友缺少 QQ 号，无法定位聊天记录'); return; }
        el.disabled = true;
        const old = el.textContent;
        el.textContent = '更新中…';
        // 同样记进 state，切页签回来后仍能看到进行中
        state.consolidating[chatKey] = { startedAt: Date.now() };
        delete state.consolidateResult[chatKey];
        startConsolidateTicker();
        renderMemoryList();
        try {
          await api('/api/memory-files/consolidate', {
            method: 'POST',
            body: JSON.stringify({ chatKey, userIds: [uid] })
          });
          el.textContent = '已提交 ✓';
        } catch (err) {
          el.textContent = '失败';
          alert(`更新记忆失败：${err.message}`);
        }
        setTimeout(() => { el.disabled = false; el.textContent = old; }, 2500);
      });
    });
    $('#mem-consolidate-btn')?.addEventListener('click', async () => {
      const btn = $('#mem-consolidate-btn');
      const status = $('#mem-consolidate-status');
      // 立刻记进 state：即使马上切走页签，回来也能看到"整理中"
      state.consolidating[chatKey] = { startedAt: Date.now() };
      delete state.consolidateResult[chatKey];
      startConsolidateTicker();
      renderMemoryList();
      if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
      if (status) status.textContent = '整理中…';
      try {
        const r = await api('/api/memory-files/consolidate', {
          method: 'POST',
          body: JSON.stringify({ chatKey })
        });
        if (r.error) {
          delete state.consolidating[chatKey];
          state.consolidateResult[chatKey] = { note: `失败：${r.error}`, at: Date.now(), failed: true };
          if (status) status.textContent = `失败：${r.error}`;
          if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群记忆'; }
        renderMemoryList();
      }
    });
    // 若本群正在整理，启动计时刷新（切回来时也能接着走）
    if (state.consolidating[chatKey]) startConsolidateTicker();
  } catch (e) {
    detail.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 「记忆互通」设置区（记忆页里那个折叠块）—— 2026-09-20 第九对话加。
 *
 * 三个开关的语义（都**默认关**，见 config.js 的 memory 段注释）：
 *   · 全互通          `memory.unified`        —— 忽略分组，所有会话一个池子（含 QQ↔微信）
 *   · 同一个人的记忆   `memory.unifiedMembers` —— off / samePlatform / all
 *   · 互通组          `memory.groups`         —— { 组名: [chatKey, ...] }，一个会话可在多个组
 *
 * ⚠️ 这里是**跨人**的互通，所以默认关：开了之后 A 私聊里的事可能出现在 B 私聊里。
 *    用户明确要这个能力，但"默认打开"会让没配过的人凭空泄露 ⇒ 必须由人显式打开。
 *
 * ⚠️ 2026-09-22 第十对话：**去掉了这里原先的 10 处内联 `style="…"`，改用 style.css 的
 *    `.mem-interop*` 一族**。原因是核查发现这一块从来没进过设计层（它比 K3 的设计更晚），
 *    而内联写法里藏着一个真 bug：
 *      `border:1px solid var(--line,#333)` —— `--line` 在 style.css 里**从来没定义过**，
 *      而 `var()` 的第二个参数是"未定义时的兜底值"，所以它**永远**是 `#333`；
 *      亮色主题下实测 `border-color = rgb(51,51,51)`，而设计系统用的是 rgba(0,0,0,.08) 发丝线
 *      ⇒ 亮色下多出一条突兀的深灰描边（暗色下恰好看不出来）。
 *    ⇒ 教训：**要用 token 就用存在的 token**；写 `var(--x, #硬编码)` 等于埋一个静默的错色。
 *
 * ⚠️ 下面这些 **id 与类名是三个界面验证脚本的锚点**，改名会直接弄坏它们
 *    （`工具-会话诊断\验-记忆互通界面.mjs` / `验-新建互通组弹窗.mjs` / `验-记忆互通会改配置的动作.mjs`）：
 *    `details.mem-interop`、其中的 `summary`、`#mem-unified`、`#mem-members-scope`、
 *    `#mem-group-add`、`.mem-group-toggle`。
 */
function memInteropHtml(chatKey) {
  const cfg = (state.config || {});
  const mem = cfg.memory || {};
  const groups = (mem.groups && typeof mem.groups === 'object') ? mem.groups : {};
  const unified = mem.unified === true;
  const scope = ['off', 'samePlatform', 'all'].includes(mem.unifiedMembers) ? mem.unifiedMembers : 'off';

  // 每个组一行：本会话在不在组里，决定按钮是「已加入」还是「加入」
  const groupRows = Object.entries(groups).map(([name, list]) => {
    const arr = Array.isArray(list) ? list.map(String) : [];
    const inside = arr.includes(String(chatKey));
    const others = arr.filter((k) => k !== String(chatKey));
    const preview = others.slice(0, 4).map((k) => formatChatTitle(k, chatNameOf(k))).join('、');
    return `<div class="mem-interop-group">
      <button class="btn btn-small mem-group-toggle${inside ? '' : ' btn-ghost'}" data-group="${esc(name)}">${inside ? '✓ 已加入' : '加入'}</button>
      <b>${esc(name)}</b>
      <span class="muted">${arr.length} 个会话${others.length ? '：' + esc(preview) + (others.length > 4 ? ' …' : '') : ''}</span>
    </div>`;
  }).join('');

  // ── UI 改造第二阶段 条目 5：互通块默认折叠 + **折叠态显示配置摘要** ──────
  // 方案要求："默认折叠为单行（▸ 记忆互通 · 跨会话共享印象），**折叠态显示配置摘要**
  //   （如「当前：全互通 开 · 全平台互通 · 0 个互通组」）；展开态三组设置卡片化（各一行说明）；
  //   总说明压底部一行 ⓘ；互通组空态文案保留（本身是操作引导）"
  //
  // 🔴 折叠态摘要为什么重要：这块设的是**跨人共享**（开了之后 A 私聊的事可能出现在 B 私聊），
  //    而它的默认形态是收起的。如果收起后完全看不出当前配置，用户就**无法察觉它被打开过** ——
  //    一个影响隐私的开关，收起时必须把当前状态写在脸上。
  const scopeLabel = { off: '各聊各的', samePlatform: '同平台内互通', all: '全平台互通' }[scope] || scope;
  const groupCount = Object.keys(groups).length;
  const summaryText = `当前：${unified ? '全互通 开' : '全互通 关'} · ${esc(scopeLabel)} · ${groupCount} 个互通组`;

  return `<details class="mem-interop">
    <summary>🔗 记忆互通 <span class="mi-sum">${summaryText}</span></summary>
    <div class="mem-interop-body">
      <label class="mem-interop-row">
        <input type="checkbox" id="mem-unified" ${unified ? 'checked' : ''}>
        <b>全互通</b>
        <span class="mem-interop-note">所有会话一个池子（含 QQ ↔ 微信）；开了它就忽略下面的分组</span>
      </label>
      <label class="mem-interop-row">
        <b>同一个人的记忆</b>
        <select id="mem-members-scope">
          <option value="off"${scope === 'off' ? ' selected' : ''}>各聊各的</option>
          <option value="samePlatform"${scope === 'samePlatform' ? ' selected' : ''}>同平台内互通（QQ 自己通、微信自己通）</option>
          <option value="all"${scope === 'all' ? ' selected' : ''}>全平台互通（QQ 认识的他，微信里也认得）</option>
        </select>
      </label>
      <div class="mem-interop-groups">
        <div class="mem-interop-groups-head">
          <b>互通组</b>
          <span class="mem-interop-note">（一个会话可同时属于多个组）</span>
          <button class="btn btn-small" id="mem-group-add">＋ 新建组并加入本会话</button>
        </div>
        ${groupRows || '<div class="mem-interop-empty">还没有互通组。点上面「新建组」把本会话放进去，再到另一个会话里把它也加进同一个组。</div>'}
      </div>
      ${hintLine('这里是跨会话（含跨人）共享印象，所以默认关闭。',
        '打开后，别的会话里记下的印象也会进这里的提示词，每条都会标明来自哪个会话与属于谁（id 为准）。'
        + '⚠️ 这是**跨人**的互通：开了之后 A 私聊里的事可能出现在 B 私聊里 —— 所以必须由人显式打开。')}
    </div>
  </details>`;
}

/** 写 config.memory 的互通设置（只 POST 这一小块，绝不整体回传配置）。 */
async function saveMemoryInterop(patch, detail) {
  const status = $('#mem-share-status');
  const say = (t, color) => { if (status) { status.textContent = t; status.style.color = color || ''; } };
  try {
    // 现取现用：别的标签页/设置页可能刚改过，拿缓存去算 next 会把它抹掉
    const fresh = await api('/api/config');
    const cur = (fresh && fresh.memory) || {};
    const body = { memory: {} };
    if ('unified' in patch) body.memory.unified = !!patch.unified;
    if ('unifiedMembers' in patch) body.memory.unifiedMembers = String(patch.unifiedMembers);
    if ('groups' in patch) body.memory.groups = { __replace__: patch.groups };
    await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
    state.config = await api('/api/config');
    say('已保存（下一轮对话就生效）', 'var(--green)');
    setTimeout(() => { if (status) status.textContent = ''; }, 4000);
    void cur;
    return true;
  } catch (e) {
    say(`保存失败：${e.message}`, 'var(--orange)');
    return false;
  }
}

/** 把当前会话加入/移出某个互通组，然后重渲染。 */
async function toggleChatInGroup(groupName, chatKey, detail) {
  const fresh = await api('/api/config');
  const groups = Object.assign({}, (fresh && fresh.memory && fresh.memory.groups) || {});
  const arr = Array.isArray(groups[groupName]) ? groups[groupName].map(String) : [];
  const key = String(chatKey);
  groups[groupName] = arr.includes(key) ? arr.filter((k) => k !== key) : [...arr, key];
  if (!groups[groupName].length) delete groups[groupName];   // 空组没有意义，顺手清掉
  if (await saveMemoryInterop({ groups }, detail)) loadMemoryDetail(chatKey);
}

/**
 * 新建一个组并把当前会话放进去。
 *
 * 🔴 2026-09-20（第九对话）修：原来这里用的是 `window.prompt(...)`，**用户报「按了没反应」**。
 *    实测（CDP 在真页面里点了一下）：`window.prompt` **确实被调用到了**，函数没坏 ——
 *    坏的是**那个原生弹窗在应用里不显示**（Electron 渲染进程里不可靠；本应用自己也
 *    基本不用它，`ui/app.js` 里只剩两处，另一处是"复制这段文本"的兜底）。
 *    ⇒ 用户看到的就是"点了没动静"。
 *    ⇒ 改成应用自己的**页内弹窗** `modelModalShell`（项目里 19 处都这么做），
 *      顺带能一次填「组名 + 可选会话」，比原生 prompt 更好用。
 *
 * ⚠️ 别再用 `window.prompt` / `window.confirm` / `window.alert` 做交互 ——
 *    本项目其余 18 个弹窗都是页内的，只有这里漏了。
 */
async function addGroupWithChat(chatKey, detail) {
  const fresh = await api('/api/config');
  const groups = Object.assign({}, (fresh && fresh.memory && fresh.memory.groups) || {});
  // 候选会话：优先白名单里的会话（有名字可显示），当前会话排最前
  const chats = (state.chats || []).map((c) => c.key).filter(Boolean);
  if (!chats.includes(chatKey)) chats.unshift(chatKey);
  const ordered = [chatKey, ...chats.filter((k) => k !== chatKey)];

  const overlay = modelModalShell({
    head: '新建互通组',
    body: `
      <div class="field"><label>组名</label>
        <input type="text" id="mg-name" placeholder="例如：家人 / 同事 / 全平台" style="width:100%" /></div>
      <div class="hint">同一个组里的会话<b>互相可见</b>彼此记下的印象；一个会话可以同时属于多个组。</div>
      <div class="field" style="margin-top:8px"><label>要放进这个组的会话（可多选）</label>
        <div style="max-height:260px;overflow:auto;border:1px solid var(--line,#333);border-radius:6px;padding:6px">
          ${ordered.map((k) => `
            <label style="display:flex;align-items:center;gap:8px;padding:3px 0">
              <input type="checkbox" class="mg-chat" value="${esc(k)}" ${k === chatKey ? 'checked' : ''}>
              <span>${esc(formatChatTitle(k, chatNameOf(k)))}</span>
              <span class="muted" style="font-size:11px;white-space:nowrap">${esc(k)}</span>
            </label>`).join('')}
        </div>
      </div>
      <div class="hint" id="mg-err" style="color:var(--orange)"></div>`,
    foot: `<button class="btn" id="mg-cancel">取消</button>
           <button class="btn btn-primary" id="mg-save">创建</button>`
  });
  overlay.querySelector('#mg-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mg-save').addEventListener('click', async () => {
    const name = (overlay.querySelector('#mg-name')?.value || '').trim();
    const err = overlay.querySelector('#mg-err');
    if (!name) { if (err) err.textContent = '请先填一个组名'; return }
    if (groups[name]) { if (err) err.textContent = `「${name}」已经存在了，换个名字，或直接在列表里点「加入」`; return }
    const picked = [...overlay.querySelectorAll('.mg-chat')].filter((el) => el.checked).map((el) => el.value);
    if (!picked.length) { if (err) err.textContent = '至少要选一个会话'; return }
    groups[name] = picked;
    // ⚠️ 关弹窗要放在保存**成功之后**分支里；失败时留着让用户改（saveMemoryInterop 会把错误写在
    //    记忆页的状态行里）。这里先关再保存的话，失败时用户看不到任何提示 —— 与"按了没反应"同类。
    const okSaved = await saveMemoryInterop({ groups }, detail);
    if (!okSaved) { if (err) err.textContent = '保存失败，看记忆页右上角的状态提示'; return }
    closeModelModal(overlay);
    await loadMemoryDetail(chatKey);
  });
}

/** 旧实现（保留注释，别再改回去）：
 *  const name = (window.prompt('给这个互通组起个名字（例如「家人」「同事」）：') || '').trim();
 *  if (!name) return;
 *  ... window.prompt 在应用里不显示 ⇒ 用户看到"按了没反应"。
 */

/**
 * 「同一个人」关联弹窗（2026-09-20 第九对话加）。
 *
 * 用途：把**当前会话里的这个人**与**别的会话里的某人**标成同一个人。
 * 为什么必须人工标（不能自动）：
 *   · QQ 号与微信派生 id **在同一个数值空间里**（微信 id = blake2s(wxid) % (2^31-1) + 1）
 *     ⇒ 按 id 相等合并会**撞号认错人**；
 *   · 同一个真人两边的 id 又**不同** ⇒ 不声明就**永远合不上**。
 *   实测线上就是这个状态：跨平台一对都没合上。所以只能人来回答"这俩是不是同一个人"。
 *
 * 🔴 身份键带**平台**：`qq:<id>` / `wechat:<id>` —— 这是撞号不会误合的关键。
 */
function openIdentityModal(chatKey, member) {
  const uid = String(member?.userId || '');
  const chats = (state.identityChats || []).filter((c) => c.chatKey !== chatKey);
  const identMap = (state.config?.memory?.identity) || {};
  const myPlat = state.chatPlatforms?.[chatKey] || 'qq';
  const myKey = `${myPlat}:${uid}`;
  const myPerson = identMap[myKey] || '';

  // 当前已关联到哪些（同一 person 值的其它键）
  const linked = Object.entries(identMap)
    .filter(([k, v]) => v === myPerson && k !== myKey)
    .map(([k]) => k);

  const rows = chats.length
    ? chats.map((c) => {
      const opts = c.members.map((mm) => {
        const k = `${c.platform}:${mm.userId}`;
        const on = linked.includes(k);
        return `<label style="display:flex;align-items:center;gap:8px;padding:3px 0">
          <input type="checkbox" class="id-pick" value="${esc(k)}" ${on ? 'checked' : ''}>
          <span>${esc(mm.name || mm.userId)}</span>
          <span class="muted" style="font-size:11px;white-space:nowrap">${esc(k)} · ${mm.count} 条</span>
        </label>`;
      }).join('');
      return `<details style="margin:4px 0">
        <summary style="cursor:pointer">${esc(formatChatTitle(c.chatKey, chatNameOf(c.chatKey)))} <span class="muted">（${esc(c.platform)}，${c.members.length} 人）</span></summary>
        <div style="padding:4px 0 4px 16px">${opts}</div>
      </details>`;
    }).join('')
    : '<div class="muted">别的会话还没有任何有 id 的记忆成员。</div>';

  const overlay = modelModalShell({
    head: `同一个人：${member?.name || uid}`,
    body: `
      <div class="hint">本会话这个人：<b>${esc(member?.name || uid)}</b>
        <span class="muted">${esc(myKey)}</span></div>
      <div class="hint" style="margin-top:6px">
        勾上<b>别的会话里属于同一个真人</b>的条目。勾选后，两边的印象会互相看见（受「记忆互通」里的
        「同一个人的记忆」开关控制）。<br>
        ⚠️ <b>只勾真的是同一个人的</b> —— QQ 与微信的数字 id 会撞号，勾错等于把两个人合并。
      </div>
      <div style="max-height:300px;overflow:auto;margin-top:8px;border:1px solid var(--line,#333);border-radius:6px;padding:6px">
        ${rows}
      </div>
      <div class="hint" id="id-err" style="color:var(--orange)"></div>`,
    foot: `${linked.length ? '<button class="btn btn-danger" id="id-unlink">解除全部关联</button>' : ''}
           <button class="btn" id="id-cancel">取消</button>
           <button class="btn btn-primary" id="id-save">保存</button>`
  });

  overlay.querySelector('#id-cancel').addEventListener('click', () => closeModelModal(overlay));

  /** 把"本会话这个人 + 勾选的其它 id"写成身份表（幂等：先清掉这些键再写）。 */
  const applyIdentity = async (picked) => {
    const fresh = await api('/api/config');
    const next = { ...((fresh.memory && fresh.memory.identity) || {}) };
    // 先解掉本键与所有"原同一人"的键（用户可能取消了某几个勾）
    delete next[myKey];
    for (const k of linked) delete next[k];
    if (picked.length) {
      // 复用已有 person 值（保持既有分组），没有就新生成一个
      const person = myPerson || `p_${Date.now().toString(36)}`;
      next[myKey] = person;
      for (const k of picked) next[k] = person;
    }
    await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ memory: { identity: { __replace__: next } } })
    });
    state.config = await api('/api/config');
  };

  overlay.querySelector('#id-save').addEventListener('click', async () => {
    const err = overlay.querySelector('#id-err');
    const picked = [...overlay.querySelectorAll('.id-pick')].filter((el) => el.checked).map((el) => el.value);
    try {
      await applyIdentity(picked);
      closeModelModal(overlay);
      await loadMemoryDetail(chatKey);
      await loadMemoryView();
    } catch (e) { if (err) err.textContent = `保存失败：${e.message}` }
  });

  const unlink = overlay.querySelector('#id-unlink');
  if (unlink) unlink.addEventListener('click', async () => {
    const err = overlay.querySelector('#id-err');
    try {
      await applyIdentity([]);
      closeModelModal(overlay);
      await loadMemoryDetail(chatKey);
      await loadMemoryView();
    } catch (e) { if (err) err.textContent = `解除失败：${e.message}` }
  });
}

/**
 * 保存某个 QQ 号的「跨会话记忆互通」方向。
 *
 * 几个要点：
 * - 方向是**按 QQ 号全局**的（config.memory.share），在哪个会话里改都一样；
 * - 只 POST `{ memory: { share: { __replace__: {...} } } }` 这一小块 ——
 *   用 __replace__ 是因为普通深合并**删不掉已有键**（选「不互通」时要能删掉）；
 *   而且绝不整体回传配置（GET 是脱敏的，会把真实 Key 抹成空）；
 * - 服务端只影响**读**：写入仍然只写当前会话，每条印象都还能追溯来源。
 *
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveMemoryShare(userId, mode, detail) {
  const qq = String(userId || '').trim();
  const status = $('#mem-share-status');
  const say = (t, color) => { if (status) { status.textContent = t; status.style.color = color || ''; } };
  if (!/^\d{1,15}$/.test(qq)) { say('这个成员没有 QQ 号，设不了互通', 'var(--orange)'); return false; }
  const want = ['both', 'toPrivate', 'toGroup'].includes(mode) ? mode : '';
  try {
    // 现取现用：share 是 { __replace__: 整体替换 }，拿缓存里的旧表去算 next
    // 会把"别处刚加的"一起抹掉（比如另一个标签页、或设置页刚改过）。
    // 为了这个只多一次 GET，换来的是不会静默吞掉别人的改动。
    const fresh = await api('/api/config');
    const cur = (fresh && fresh.memory && fresh.memory.share) || {};
    const next = { ...cur };
    if (want) next[qq] = want; else delete next[qq];
    await api('/api/config', { method: 'POST', body: JSON.stringify({ memory: { share: { __replace__: next } } }) });
    // 重新拉一份（脱敏的）配置当本地真相，别用 POST 返回的那份带 Key 的
    state.config = await api('/api/config');
    const label = { both: '双向互通', toPrivate: '只并进私聊', toGroup: '只并进群聊' }[want] || '不互通';
    say(`已保存：QQ ${qq} → ${label}`, 'var(--green)');
    // 提示需要重开一次会话才生效（提示词是每轮现拼的，其实下一轮就生效）
    setTimeout(() => { if (status) status.textContent = ''; }, 4000);
    return true;
  } catch (e) {
    say(`保存失败：${e.message}`, 'var(--orange)');
    return false;
  }
}

/**
 * 删除某个群友在本会话里的全部印象（= 删掉他的记忆文件 <QQ>.json）。
 * 与「编辑 → 印象内容留空 → 保存」等价，但管理端直觉上就该有个直接的删除。
 */
function deleteMemberMemory(chatKey, userId, name) {
  if (!/^\d{1,15}$/.test(String(userId || ''))) {
    showNoticeModal('无法删除', '这条记忆没有 QQ 号（早期按名字落文件的旧数据），只能用右上角的「清空本群记忆」删除。');
    return;
  }
  const cfg = state.config || {};
  const who = (cfg.memberNotes || {})[userId] || name || userId;
  confirmDanger({
    head: '删除群友记忆',
    okText: '删除',
    text: `将删除 <b>${esc(who)}</b>（QQ ${esc(userId)}）在本群的<b>全部印象</b>。<br><br>
      机器人之后不会再记得这些印象 —— 除非以后重新整理记忆又把它总结出来。<br><br>
      此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      await loadMemoryView();
    }
  });
}

/**
 * 清空某个会话的全部记忆。
 *
 * 后端连 data/memory/<会话>/ 目录、旧版单文件、以及 data/memory/backups/<会话>/
 * 里的整理备份一起删 —— 备份是"整理前自动留的一份"，如果留着，用户以为删干净了
 * 其实磁盘上还有一份。
 */
function clearChatMemory(chatKey) {
  if (!chatKey) return;
  const entry = (state.memoryFiles || []).find((f) => f.chatKey === chatKey) || {};
  const name = formatChatTitle(chatKey, chatNameOf(chatKey));
  const n = Number(entry.memberCount) || 0;
  const imps = Number(entry.impressionCount) || 0;
  const dir = esc(chatKey.replace(':', '_'));
  confirmDanger({
    head: '清空本群记忆',
    okText: '清空',
    text: `<b>${esc(name)}</b> 的 <b>${n}</b> 位群友、<b>${imps}</b> 条印象将全部删除。<br><br>
      磁盘上这些都会被删掉：<br>
      · <code>data/memory/${dir}/</code>（每个群友一个文件）<br>
      · <code>data/memory/backups/${dir}/</code>（整理前的自动备份）<br><br>
      ⚠️ 聊天记录存档是另一个文件，不受影响 —— 要清去「存档」页。<br>
      ${state.consolidating[chatKey] ? '<b style="color:var(--red)">本群正在整理记忆：建议等整理结束再清空，否则整理结果可能又写回来。</b><br><br>' : ''}
      此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}`, { method: 'DELETE', body: '{}' });
      state.currentMemoryChatKey = null;
      delete state.consolidating[chatKey];
      delete state.consolidateResult[chatKey];
      const detail = $('#memory-detail');
      if (detail) detail.innerHTML = '<div class="empty-hint">← 选择会话查看记忆</div>';
      await loadMemoryView();
    }
  });
}

/** 编辑/添加某个群友的印象（一行一条，保存后整体替换）。 */
function openMemberImpressModal(chatKey, member) {
  const isEdit = !!(member && member.userId);
  const userId = member?.userId || '';
  const name = member?.name || '';
  const imps = (member?.impressions || []).map((e) => e.content).join('\n');
  const cfg = state.config || {};
  const notes = cfg.memberNotes || {};
  const note = notes[String(userId)] || '';
  const overlay = modelModalShell({
    head: isEdit ? `编辑群友印象：${note || name || userId}` : '添加群友印象',
    body: `
      ${isEdit ? `
      <div class="field-row">
        <div class="field"><label>QQ 号</label><input type="text" id="mi-qq" value="${esc(userId)}" readonly /></div>
        <div class="field"><label>QQ 昵称</label><input type="text" id="mi-nickname" value="${esc(name)}" readonly /></div>
        <div class="field"><label>群内昵称</label><input type="text" id="mi-card" value="${esc(member?.card || '')}" readonly /></div>
      </div>
      <div class="field"><label>QQ agent 对群友的当前备注</label><input type="text" id="mi-note" value="${esc(note)}" placeholder="留空则使用原群名片/昵称" /></div>` : `
      <div class="field"><label>QQ 号（必填）</label><input type="text" id="mi-qq" value="${esc(userId)}" /></div>
      <div class="field"><label>名字（备注名/群名片/昵称）</label><input type="text" id="mi-name" value="${esc(name)}" /></div>`}
      <div class="field"><label>印象内容（一行一条；留空 = 删除该成员全部印象）</label><textarea id="mi-imps" style="min-height:160px" placeholder="老王喜欢钓鱼，周末常不在&#10;说话爱玩梗，别太认真">${esc(imps)}</textarea></div>`,
    foot: `<button class="btn" id="mi-cancel">取消</button>
           ${isEdit ? '<button class="btn btn-danger" id="mi-del">删除此人</button>' : ''}
           <button class="btn btn-primary" id="mi-save">保存</button>`
  });
  overlay.querySelector('#mi-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mi-save').addEventListener('click', async () => {
    const qq = ($('#mi-qq')?.value || '').trim();
    const nm = ($('#mi-name')?.value || $('#mi-nickname')?.value || '').trim();
    const newNote = ($('#mi-note')?.value || '').trim();
    const lines = ($('#mi-imps')?.value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!/^\d{1,15}$/.test(qq)) { alert('QQ 号必须是数字'); return; }
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${qq}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nm, note: newNote, impressions: lines })
      });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mi-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm(`确定删除 ${note || name || userId} 的全部印象？`)) return;
    try {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      closeModelModal(overlay);
      loadMemoryDetail(chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}

async function loadGroupMembers(chatId, chatKey) {
  const status = $('#mem-members-status');
  if (status) status.textContent = '拉取中…';
  try {
    const data = await api(`/api/groups/${chatId}/members`);
    state.groupMembers = data.members || [];
    state.groupMembersLoaded = true;
    const cfg = state.config || await api('/api/config');
    const notes = cfg.memberNotes || {};
    const box = $('#mem-members');
    if (box) {
      box.innerHTML = `<div class="collapsible" open><summary>群成员（${state.groupMembers.length} 人）</summary><div class="coll-body"><table class="member-table">
        <tr><th style="text-align:left">群名片</th><th style="text-align:left">QQ昵称</th><th style="text-align:left">QQ号</th><th style="width:90px;text-align:right">备注</th></tr>
        ${state.groupMembers.map((m) => {
          const note = notes[String(m.userId)];
          return `<tr>
            <td>${esc(note || m.card || '—')}${note && (m.card || m.nickname) ? ` <span class="muted">(${esc(m.card || m.nickname)})</span>` : ''}</td>
            <td>${esc(m.nickname || '—')}</td>
            <td class="muted" style="font-size:11px">${esc(m.userId)}</td>
            <td style="text-align:right"><button class="btn btn-small member-note-edit" data-qq="${esc(m.userId)}">编辑备注</button></td>
          </tr>`;
        }).join('')}
      </table></div></div>`;
      box.querySelectorAll('.member-note-edit').forEach((el) => {
        el.addEventListener('click', () => openMemberNoteModal(el.dataset.qq, chatKey));
      });
    }
    if (status) status.textContent = `已拉取 ${state.groupMembers.length} 人`;
  } catch (e) {
    if (status) status.textContent = `拉取失败：${e.message}`;
  }
}

async function openMemberNoteModal(qq, chatKey) {
  const cfg = state.config || await api('/api/config');
  const notes = cfg.memberNotes || {};
  const oldNote = notes[String(qq)] || '';
  const member = (state.groupMembers || []).find((m) => String(m.userId) === String(qq));
  const displayName = member ? String(member.card || member.nickname || '') : '';
  const overlay = modelModalShell({
    head: `编辑备注：${oldNote || displayName || qq}`,
    body: `
      <div class="field"><label>QQ 号</label><input type="text" value="${esc(qq)}" readonly style="width:100%" /></div>
      <div class="field"><label>备注名</label><input type="text" id="mn-note" value="${esc(oldNote)}" placeholder="${esc(displayName || '备注名（如 老王）')}" style="width:100%" /></div>
      <div class="hint">保存后，聊天记录、记忆、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
    foot: `<button class="btn" id="mn-cancel">取消</button>
           ${oldNote ? '<button class="btn btn-danger" id="mn-delete">删除备注</button>' : ''}
           <button class="btn btn-primary" id="mn-save">保存</button>`
  });
  overlay.querySelector('#mn-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#mn-save').addEventListener('click', async () => {
    const name = $('#mn-note')?.value.trim() || '';
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    if (name) nextNotes[String(qq)] = name; else delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`保存失败：${e.message}`);
    }
  });
  const delBtn = overlay.querySelector('#mn-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    const nextNotes = { ...(state.config?.memberNotes || {}) };
    delete nextNotes[String(qq)];
    try {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ memberNotes: nextNotes }) });
      state.config = data.config;
      closeModelModal(overlay);
      await loadGroupMembers(chatKey.split(':')[1] || '', chatKey);
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });
}
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData, sysPromptData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null })),
    api('/api/system-prompt').catch(() => null)
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.systemPrompt = sysPromptData && Array.isArray(sysPromptData.segments) ? sysPromptData : null;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '未配置远程价格表 —— 当前使用内置表。填上 URL 并保存后，启动时与每 24 小时自动拉取。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */
/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function matchPriceTable(modelId, table) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  const list = table || [];

  const exact = list.find((x) => String(x.id).toLowerCase() === id);
  if (exact) return exact;

  if (id.includes('/')) {
    const bare = id.split('/').pop();
    const hit = list.find((x) => String(x.id).toLowerCase() === bare);
    if (hit) return hit;
  }

  let best = null;
  for (const x of list) {
    const xid = String(x.id).toLowerCase();
    if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x;
  }
  return best;
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * ⚠️ 关键：所有输入都读**界面控件的实时值**，不读 state.config。
 *   否则没点「保存设置」之前，开关/模型名怎么改都是旧值，
 *   看起来就像"按了没反应" —— 这与"可编辑性只跟开关绑定"的意图直接冲突。
 *
 * 匹配判断在本地用 state.modelPrices.prices 算，不读 state.modelPrices.current
 * —— 后者是后端按「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    // 自定义价读已保存的配置（那才是用户存的），但模型身份用实时模型名去查
    const custom = (api.modelPrices || {})[model];
    if (custom && (Number(custom.in) || Number(custom.out))) {
      shown = {
        in: Number(custom.in) || 0,
        out: Number(custom.out) || 0,
        cached: custom.cached == null ? Number(custom.in) || 0 : Number(custom.cached) || 0
      };
      sourceTxt = '正在使用你为该模型设定的单价。';
    } else {
      shown = {
        in: Number(api.priceInputPerM) || 0,
        out: Number(api.priceOutputPerM) || 0,
        cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
      };
      sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
    }
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) card.classList.toggle('locked', locked);
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      $('#provider-action-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}

function renderHealthCard() {
  const { ready, checks, tips } = assessReadiness(state.config, state.status);
  const rows = checks.map((c) => {
    let extra = '';
    if (!c.ok && c.fix === 'snowluma-tab') {
      extra = ' <button class="btn btn-small" id="hc-goto-snowluma">前往 SnowLuma 页签</button>';
    }
    return `
    <div class="h-item ${c.ok ? 'ok' : 'bad'}">
      <span>${c.ok ? '✓' : '✗'}</span>
      <span class="h-label">${esc(c.label)}${extra}</span>
    </div>`;
  }).join('');
  const testRow = `
    <div class="h-item ${'mute'}">
      <span>·</span>
      <span class="h-label">API 连通性：
        <button class="btn btn-small" id="test-api-btn">测试一下</button>
        <span id="test-api-result" class="muted"></span>
      </span>
    </div>`;
  // 可选功能提示（不影响 ready）：用和 API 连通性同一档的弱化样式，别喧宾夺主
  const tipRows = (tips || []).map((t) => `
    <div class="h-item mute">
      <span>·</span>
      <span class="h-label">${esc(t)}</span>
    </div>`).join('');
  return `
    <div class="health-card ${ready ? 'all-ok' : ''}">
      <div class="h-title">${ready ? '✅ 一切就绪，机器人运行中' : '🧭 完成下面缺失项就能跑起来'}</div>
      ${rows}
      ${testRow}
      ${tipRows}
    </div>`;
}

// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）

// ── 模型目录（多提供商；面板式选择 + 图片输入能力徽标） ──
function visionBadge(providerId, model) {
  const r = (state.visionResults || {})[`${providerId}|||${model}`];
  const src = r?.source === 'docs' ? '官方资料' : (r?.source === 'probe' ? '在线探测' : '');
  const show = state.config?.ui?.showVision !== false;
  const t = (cls, text) => `<span class="vbadge ${cls}" style="${show ? '' : 'display:none'}" title="${esc((src ? `【${src}】` : '') + (r?.note || ''))}">${text}</span>`;
  if (!r) return t('unk', '未检测');
  if (r.verdict === 'vision') return t('ok', '支持图片输入');
  if (r.verdict === 'no-vision') return t('no', '不支持图片输入');
  return t('unk', '无法判定');
}

// ── 两栏悬停下拉：左供应商 / 右模型 ──
function visionVerdictOf(providerId, model) {
  return (state.visionResults || {})[`${providerId}|||${model}`]?.verdict;
}

// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;
function bindModelDdDismiss() {
  if (modelDdDismissBound) return;
  modelDdDismissBound = true;
  document.addEventListener('click', (e) => {
    const dd = document.getElementById('model-dd');
    if (!dd || dd.hidden || dd.contains(e.target)) return;
    const btn = document.getElementById('model-pick-btn');
    if (btn && btn.contains(e.target)) return;   // 按钮自己负责开合
    dd.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    const dd = document.getElementById('model-dd');
    if (dd && !dd.hidden && e.key === 'Escape') dd.hidden = true;
  });
}

function renderProviderColumn(c) {
  const provs = state.providers || [];
  // 旧文案指向的"从 DSH 导入"功能早已移除，这里改成能实际操作的指引
  if (!provs.length) {
    return '<div class="muted" style="padding:10px;font-size:12px;line-height:1.7">'
      + '目录还是空的。先在右边「手动添加提供商」填地址与 API Key，'
      + '点「获取列表」勾选模型，或直接手填模型 id 后点「确认添加」。'
      + '<br>Key 可以去 DeepSeek / 智谱 / Kimi / OpenAI 的开放平台申请。'
      + '</div>';
  }
  let html = '<div class="mdd-prov" data-pid="__manual__"><span class="mdd-prov-name">（手动输入模型名）</span></div>';
  for (const p of provs) {
    const warn = [!p.hasKey ? '⚠无密钥' : '', p.needsBaseUrl ? '⚠需补地址' : ''].filter(Boolean).join(' ');
    const visionOk = (p.models || []).filter((m) => visionVerdictOf(p.id, m) === 'vision').length;
    const meta = warn || `${p.models.length} 模型${visionOk ? ` · ${visionOk} 可看图` : ' · 0 可看图'}`;
    html += `<div class="mdd-prov" data-pid="${esc(p.id)}">
      <span class="mdd-prov-name">${esc(p.displayName || p.id)}</span>
      <span class="mdd-prov-meta">${esc(meta)}</span>
    </div>`;
  }
  return html;
}

function renderModelColumn(pid, c) {
  if (pid === '__manual__') {
    return '<div class="muted" style="padding:12px;font-size:12px">选此项后直接在下方"模型"输入框填任意模型名，并手动填 Base URL / Key。</div>';
  }
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) return '';
  const current = `${c.api.provider || ''}|||${c.api.model || ''}`;
  return `<div class="mp-provider"><span>${esc(p.displayName || p.id)}${p.anthropicOrigin ? ' · Anthropic 协议' : ''}</span><span class="mp-url">${esc(p.baseURL || '无端点')}</span></div>
    ${p.models.map((m) => {
      const v = `${p.id}|||${m}`;
      return `<div class="mp-row${v === current ? ' current' : ''}" data-v="${esc(v)}"><span class="mp-name">${esc(m)}</span>${visionBadge(p.id, m)}</div>`;
    }).join('')}`;
}

function applyProviderPick(value, { silent = false } = {}) {
  const hint = $('#provider-hint');
  const store = $('#cfg-provider');
  if (!value || value === '__manual__') {
    store.value = '';
    if (!silent) hint.textContent = '手动模式：直接在下面填 Base URL / Key / 模型名。';
    return;
  }
  const [pid, model] = value.split('|||');
  const p = (state.providers || []).find((x) => x.id === pid);
  if (!p) { hint.textContent = '未找到该提供商，请重新从 DSH 导入。'; return; }
  store.value = pid;
  $('#cfg-model').value = model;
  // 价格卡片直接读界面控件的值，这里只需要通知它刷新
  refreshModelPriceCard();
  const notes = [];
  if (p.baseURL) {
    $('#cfg-baseurl').value = p.baseURL;
    notes.push(`端点 ${p.baseURL}`);
  } else {
    notes.push('⚠ 该提供商地址未知，请手动填 Base URL');
  }
  if (p.hasKey) {
    $('#cfg-apikey').value = '******';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('该提供商已保存密钥（显示为 ******，点「显示」查看明文，输入新 Key 可替换）');
  } else {
    $('#cfg-apikey').value = '';
    $('#cfg-apikey').type = 'password';
    const toggleBtn = $('#cfg-apikey-toggle');
    if (toggleBtn) toggleBtn.textContent = '显示';
    notes.push('⚠ 该提供商没有可用密钥，请手动粘贴 API Key');
  }
  if (p.anthropicOrigin) notes.push('DSH 中为 Anthropic 协议，已按 OpenAI 兼容模式调用，若报错请换用其他模型');
  const vr = (state.visionResults || {})[`${pid}|||${model}`];
  if (vr && (vr.verdict === 'vision' || vr.verdict === 'no-vision')) {
    notes.push(vr.verdict === 'vision' ? '✅ 该模型支持图片输入' : '🚫 该模型不支持图片输入');
  }
  hint.textContent = `已选 ${p.displayName || p.id} · ${model}：${notes.join('；')}`;
}

/* ══════════════════════════════════════════════════════════════
   表情包页
   ──────────────────────────────────────────────────────────────
   数据源：data/stickers.json（由 /api/stickers 读出）。
   注意：这里**不存图片**——每条只有一个 QQ CDN 地址，图片由浏览器直接去
   p.qpic.cn 取，所以断网时图会裂，但备注/标签照常可读可改。
   可改的只有"机器人认知层"三个字段（localNote / tags / usage）；
   desc 是你在 QQ 里写的备注，url/md5 来自 QQ，界面不给改。
   ══════════════════════════════════════════════════════════════ */

async function loadStickerPage({ force = false, quiet = false } = {}) {
  const page = $('#stickers-page');
  if (!page) return;
  if (!quiet && !state.stickers) page.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    // 收藏上限要在这一页上直接改，所以每次进页面都重新拿一份配置。
    // ⚠️ 不能用 if (!state.config) 缓存 —— 别处（或上次打开）拿到的可能是旧值：
    //    实测过"服务器上已经是 60、输入框还显示 10"。
    try { state.config = await api('/api/config'); } catch { /* 拿不到就沿用旧的，不影响表情列表 */ }
    // force=true 会让后端真的去调 OneBot 重新拉一次 QQ 收藏表情
    const data = await api(`/api/stickers${force ? '?refresh=1' : ''}`);
    state.stickers = data;
    renderStickerPage();
    if (force) {
      const tip = $('#sticker-sync-tip');
      if (tip) {
        tip.textContent = data.syncError
          ? `同步失败，仍在用本地缓存：${data.syncError}`
          : `已从 QQ 重新同步 ✓ 共 ${(data.stickers || []).length} 个表情`;
      }
    }
  } catch (e) {
    page.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 按搜索词与筛选档过滤（搜索覆盖备注/标签/用途/id）。 */
function stickerFiltered() {
  const list = (state.stickers && state.stickers.stickers) || [];
  const q = String(state.stickerQuery || '').trim().toLowerCase();
  const f = state.stickerFilter || 'all';
  return list.filter((s) => {
    if (q) {
      const hay = [s.desc, s.localNote, s.usage, s.id, s.resId, ...(s.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f === 'nonote') return !String(s.localNote || '').trim();
    if (f === 'note') return !!String(s.localNote || '').trim();
    if (f === 'used') return Number(s.useCount) > 0;
    if (f === 'unused') return !(Number(s.useCount) > 0);
    if (f === 'ai') return s.source === 'ai';
    if (f === 'qq') return s.source !== 'ai';
    return true;
  });
}

function stickerCardHtml(s) {
  const note = String(s.localNote || '');
  const tags = (s.tags || []).map((t) => `<span class="sticker-tag">${esc(t)}</span>`).join('');
  // 走本地缓存接口（服务端优先读 data/stickers/<id>.bin，没有才换新链下载并缓存）。
  // 不再直接把存档里的 QQ 链接塞进 src —— 那链里的 rkey 十几小时就过期，实测 36 条**全部**已失效；
  // 旧写法会让缩略图变成一块没有解释的黑（.thumb 的底色是 #0b0d11），连"是不是坏了"都看不出来。
  const img = s.url
    ? `<img src="/api/stickers/${encodeURIComponent(s.id)}/image?thumb=1" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.parentNode.classList.add('failed')" />`
    : '<span class="muted" style="font-size:12px">没有图片地址</span>';
  const srcLabel = s.source === 'qq' ? 'QQ收藏' : (s.source === 'ai' ? 'AI收藏' : '手动');
  return `
    <div class="sticker-card" data-id="${esc(s.id)}">
      <div class="thumb">${img}</div>
      <div class="sbody">
        <div class="sticker-srow">
          <span class="sticker-src ${esc(s.source)}">${srcLabel}</span>
          <span style="margin-left:auto">用过 ${Number(s.useCount) || 0} 次</span>
        </div>
        ${note
          ? `<div class="sticker-note">${esc(note)}</div>`
          : '<div class="sticker-note empty">（还没写备注 —— 机器人只能看图和 QQ 备注来猜）</div>'}
        ${s.desc && s.desc !== note ? `<div class="sticker-sub">QQ 备注：${esc(s.desc)}</div>` : ''}
        ${s.usage ? `<div class="sticker-sub">什么时候用：${esc(s.usage)}</div>` : ''}
        ${tags ? `<div class="sticker-tags">${tags}</div>` : ''}
        ${s.lastUsedAt ? `<div class="sticker-sub">最后使用 ${fmtTime(s.lastUsedAt)}</div>` : ''}
        <div class="sticker-id">${esc(s.id)}</div>
        <div class="sticker-edit-row">
          <button class="btn btn-small sticker-edit" data-id="${esc(s.id)}">编辑备注 / 标签</button>
          ${s.source !== 'qq'
            ? `<button class="btn btn-small btn-danger sticker-del" data-id="${esc(s.id)}" title="从本地表情库删掉这一条（QQ 收藏的表情要回 QQ 里取消收藏）">删除</button>`
            : ''}
        </div>
      </div>
    </div>`;
}

/**
 * 表情包页「每小时收藏上限」输入框：改完 POST 一小块配置，然后重新 GET 一份配置。
 *
 * 只 POST `{ sticker: { maxCollectPerHour } }` 这一个字段，**绝不把整份配置回传**：
 * GET /api/config 是脱敏过的（所有 Key 都被清空），拿它整体回传会把真实 Key 抹掉。
 * 服务端 updateConfig 是浅合并，传一小块正好。
 */
function bindStickerCollectCap() {
  const input = $('#sticker-collect-cap');
  if (!input) return;
  const tip = $('#sticker-cap-tip');
  const say = (text, color) => {
    if (!tip) return;
    tip.textContent = text;
    tip.style.color = color || '';
  };
  input.addEventListener('change', async () => {
    const n = Math.max(1, Math.min(500, Math.floor(Number(input.value)) || 1));
    input.value = n;
    input.disabled = true;
    say('保存中…');
    try {
      // ⚠️ body 必须自己 JSON.stringify —— api() 不会替你序列化，
      // 传裸对象的话 fetch 会把它变成字符串 "[object Object]"，后端报 is not valid JSON。
      await api('/api/config', { method: 'POST', body: JSON.stringify({ sticker: { maxCollectPerHour: n } }) });
      // 重新拉一份（脱敏的）配置当本地真相，别用 POST 返回的那份带 Key 的
      state.config = await api('/api/config');
      say(`已保存：一小时最多收 ${n} 条`, 'var(--green)');
    } catch (e) {
      say(`保存失败：${e.message}`, 'var(--orange)');
    }
    input.disabled = false;
  });
}

function renderStickerPage() {
  const page = $('#stickers-page');
  if (!page) return;
  const data = state.stickers || {};
  const all = data.stickers || [];

  const syncedTxt = data.syncedAt ? fmtTime(data.syncedAt) : '本次读出';
  const disabled = data.disabled
    ? '<span style="color:var(--orange)">表情包功能已在「设置 → 表情包」里关闭</span>'
    : '';
  // 每小时收藏上限（改的是配置里的 sticker.maxCollectPerHour，见 src/sticker-manager.js 的 collect）
  const collectCap = Math.max(1, Math.floor(Number(state.config?.sticker?.maxCollectPerHour)) || 60);
  const chips = [
    ['all', '全部'],
    ['note', '有备注的'],
    ['nonote', '没备注的'],
    ['used', '用过的'],
    ['unused', '没用过的'],
    ['ai', 'AI 收藏的']
  ].map(([k, label]) => `<span class="chip ${state.stickerFilter === k ? 'on' : ''}" data-sf="${k}">${label}</span>`).join('');

  // 一次性把全部卡片渲染出来，筛选只切 .hidden —— 不重建 DOM。
  // 重建的代价是浏览器会把 QQ CDN 上的图全部重新请求一遍（边打字边闪图），
  // 而且隐藏的卡片带 loading="lazy"，display:none 时根本不会去下载。
  page.innerHTML = `
    <div class="sticker-toolbar">
      <input type="search" id="sticker-search" placeholder="搜备注 / 标签 / 用途 / id…" value="${esc(state.stickerQuery)}" />
      <button class="btn btn-small" id="sticker-refresh-btn">刷新</button>
      <button class="btn btn-small" id="sticker-sync-btn" title="调 OneBot 重新拉一次 QQ 收藏表情（新收藏的表情要同步才会出现）">从 QQ 同步</button>
      <span id="sticker-sync-tip" class="muted" style="font-size:12px">${disabled}</span>
    </div>
    <div class="sticker-toolbar">
      <label class="sticker-cap" title="一小时最多让机器人新增几条收藏（改备注不算）。默认 60 —— 一条合并转发常带 30 张表情包，太小就收不完。">
        每小时收藏上限
        <input type="number" id="sticker-collect-cap" min="1" max="500" step="1" value="${esc(collectCap)}" />
      </label>
      <span id="sticker-cap-tip" class="muted" style="font-size:12px">改完立刻生效，不用重启</span>
    </div>
    <div class="sticker-toolbar" id="sticker-chips">${chips}</div>
    <div class="sticker-count">
      共 <b>${all.length}</b> 个表情，显示 <b id="sticker-shown">${all.length}</b> 个 ·
      库文件 <code>data/stickers.json</code> · 上次同步 ${esc(syncedTxt)} ·
      有备注 ${all.filter((s) => String(s.localNote || '').trim()).length} 个
      ${data.fromCache ? '（本次用缓存）' : '（本次已同步）'}
      ${data.syncError ? `<br><span style="color:var(--orange)">同步失败：${esc(data.syncError)}</span>` : ''}
    </div>
    ${all.length
      ? `<div class="sticker-grid" id="sticker-grid">${all.map(stickerCardHtml).join('')}</div>
         <div class="empty-hint" id="sticker-noresult" style="display:none">没有符合条件的表情。</div>`
      : '<div class="empty-hint">还没有任何表情。点「从 QQ 同步」把 QQ 收藏的表情拉过来。</div>'}`;

  $('#sticker-search')?.addEventListener('input', (e) => {
    state.stickerQuery = e.target.value;
    applyStickerFilter();
  });
  $$('#sticker-chips .chip').forEach((c) => c.addEventListener('click', () => {
    state.stickerFilter = c.dataset.sf;
    $$('#sticker-chips .chip').forEach((x) => x.classList.toggle('on', x === c));
    applyStickerFilter();
  }));
  $('#sticker-refresh-btn')?.addEventListener('click', () => loadStickerPage({ quiet: true }));
  bindStickerCollectCap();
  $('#sticker-sync-btn')?.addEventListener('click', async () => {
    const btn = $('#sticker-sync-btn');
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    await loadStickerPage({ force: true, quiet: true });
    const b2 = $('#sticker-sync-btn');
    if (b2) { b2.disabled = false; b2.textContent = '从 QQ 同步'; }
  });
  bindStickerEditButtons();
  applyStickerFilter();
}

/**
 * 按当前搜索词 + 筛选档切换卡片的显示，并刷新"显示 N 个"。
 *
 * 筛选条件本身只由纯函数 stickerFiltered() 决定（唯一真相），这里只负责
 * 把结果映射成 .hidden —— 故意不重建 DOM：重建会让浏览器把 QQ CDN 上的图
 * 全部重新请求一遍（边打字边闪图），而隐藏卡片带 loading="lazy"，
 * display:none 时根本不会去下载。
 */
function applyStickerFilter() {
  const grid = $('#sticker-grid');
  if (!grid) return;
  const shownIds = new Set(stickerFiltered().map((s) => s.id));
  let shown = 0;
  for (const el of grid.children) {
    const on = shownIds.has(el.dataset.id);
    el.classList.toggle('hidden', !on);
    if (on) shown += 1;
  }
  const shownEl = $('#sticker-shown');
  if (shownEl) shownEl.textContent = String(shown);
  const nr = $('#sticker-noresult');
  if (nr) nr.style.display = shown === 0 ? '' : 'none';
}

function bindStickerEditButtons() {
  $$('.sticker-edit').forEach((el) => {
    if (el.__bound) return;
    el.__bound = true;
    el.addEventListener('click', () => openStickerEditModal(el.dataset.id));
  });
  // 删除按钮只渲染在非 QQ 收藏的卡片上（QQ 收藏要回 QQ 里取消，见后端 removeSticker）
  $$('.sticker-del').forEach((el) => {
    if (el.__bound) return;
    el.__bound = true;
    el.addEventListener('click', () => deleteSticker(el.dataset.id));
  });
}

/** 编辑一个表情的备注/标签/用途。保存后只改本地这条 + 重渲染，不再整页重拉。 */
function openStickerEditModal(id) {
  const s = ((state.stickers && state.stickers.stickers) || []).find((x) => x.id === id);
  if (!s) return;
  const overlay = modelModalShell({
    head: `编辑表情：${s.desc || s.localNote || s.id}`,
    body: `
      ${s.url ? `<div class="sticker-preview"><img src="/api/stickers/${encodeURIComponent(s.id)}/image" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.parentNode.classList.add('failed')" /></div>` : ''}
      <div class="field"><label>机器人自己的备注（它会照这句判断什么时候用）</label>
        <textarea id="st-note" style="min-height:90px" placeholder="例如：笨蛋女仆馋到流口水，别人发来看鲸鱼犯傻">${esc(s.localNote || '')}</textarea></div>
      <div class="field"><label>标签（逗号或空格分隔，最多 20 个）</label>
        <input type="text" id="st-tags" value="${esc((s.tags || []).join(', '))}" placeholder="吃, 馋, 自黑" /></div>
      <div class="field"><label>什么时候用（可选）</label>
        <input type="text" id="st-usage" value="${esc(s.usage || '')}" placeholder="别人喊馋 / 喊饿的时候回一张" /></div>
      <div class="hint">这里改的是<b>机器人自己的认知</b>；「QQ 备注」是你在 QQ 里写的，改不了。</div>
      <details class="hint-more">
        <summary>说明：这些值写在哪、图片从哪来</summary>
        <div class="hint-more-body">
          写进 <code>data/stickers.json</code> 的 <code>localNote</code> / <code>tags</code> / <code>usage</code>。
          当前 QQ 备注：<code>${esc(s.desc || '无')}</code>；图片地址来自 QQ。
        </div>
      </details>`,
    foot: `<button class="btn" id="st-cancel">取消</button>
           <button class="btn btn-primary" id="st-save">保存</button>`
  });
  overlay.querySelector('#st-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#st-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '保存中…';
    try {
      const r = await api(`/api/stickers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          note: $('#st-note')?.value ?? '',
          tags: $('#st-tags')?.value ?? '',
          usage: $('#st-usage')?.value ?? ''
        })
      });
      // 用后端返回的规范化结果覆盖本地那条（trim / 截断 / 去空标签都以服务端为准）
      if (r && r.sticker && state.stickers) {
        const i = state.stickers.stickers.findIndex((x) => x.id === id);
        if (i >= 0) state.stickers.stickers[i] = r.sticker;
      }
      closeModelModal(overlay);
      renderStickerPage();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = oldText;
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 删除一个"机器人自己收藏的"表情（QQ 收藏的卡片上不渲染删除按钮）。
 * 后端也会再拦一道：QQ 收藏是同步来的源，删了下次 sync 又回来。
 */
function deleteSticker(id) {
  const s = ((state.stickers && state.stickers.stickers) || []).find((x) => x.id === id);
  if (!s) return;
  const label = String(s.localNote || s.desc || id);
  confirmDanger({
    head: '删除表情',
    okText: '删除',
    text: `<b>${esc(label.slice(0, 120))}</b><br><br>
      这是机器人自己收藏的表情，会从本地表情库 <code>data/stickers.json</code> 里删掉。<br>
      删掉后它不再出现在提示词的【可用表情包】里，<code>send_sticker</code> 也用不了它了。<br><br>
      被删的条目会在 <code>data/stickers-removed.json</code> 留一份记录（备注/标签都在），需要时能捞回来。<br>
      <b>QQ 收藏的表情没有这个按钮</b> —— 那种要回 QQ 里取消收藏，同步一次它就没了。`,
    onOk: async () => {
      await api(`/api/stickers/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
      // 本地同步删掉，省一次全量重拉（图片不会重新加载）
      if (state.stickers) {
        state.stickers.stickers = (state.stickers.stickers || []).filter((x) => x.id !== id);
      }
      renderStickerPage();
    }
  });
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['memory', '记忆'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['wechat', '微信联系人'],
    ['chat', '聊天设置'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（SnowLuma）']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}${id === 'desktop' && updateAvailable ? '<span class="update-dot" title="发现新版本"></span>' : ''}</button>`).join('')}
      <button class="settings-menu-item egg-hot" id="qrcode-egg-btn">！？群群？！</button>
    </div>`;
  // 群二维码彩蛋：点一下弹出，再点屏幕任意位置关闭
  sidebar.querySelector('#qrcode-egg-btn')?.addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'qrcode-egg-overlay';
    ov.innerHTML = '<img src="group-qrcode.jpg" alt="群二维码" />';
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  });
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  // 白名单芯片的增删接线（事件委托，只绑一次）—— 条目 6。
  // ⚠️ 必须在 innerHTML **之后**调：事件委托要挂到 **#settings-form**（真实容器）上，
  //    元素得先在 DOM 里。别写 #settings-page —— 那个 id 不存在（踩过，见 bindAllowChips）。
  bindAllowChips();
  // ⚠️ 必须在 innerHTML **之后**再读状态 —— loadProactiveStatus 是去查 DOM 元素再填内容的，
  //    放在 renderSettingsSection 里面（模板字符串求值阶段）时元素还没进 DOM，
  //    于是它查不到 #proactive-status、静默什么都不做（界面上就永远停在"正在读当前状态…"）。
  //    第一版就是这么写错的。
  if ((state.settingsSection || 'api') === 'chat') loadProactiveStatus();
  // 微信联系人同理：必须在 innerHTML 之后再去拉，拉到后再填进 #wx-contact-list。
  // （第一版想直接在模板里同步渲染，但那是异步数据 —— 会永远停在"正在读取…"）
  if ((state.settingsSection || 'api') === 'wechat') loadWechatContacts();
}

/**
 * 拉微信联系人清单并填进设置页。
 * 顺带把勾选框绑上：勾=放行、取消=移出（都打 /api/wechat-contacts/allow）。
 */
async function loadWechatContacts() {
  const box = $('#wx-contact-list');
  if (!box) return;
  try {
    const data = await api('/api/wechat-contacts');
    state.wechatContacts = data.contacts || [];
  } catch (e) {
    state.wechatContacts = [];
    box.innerHTML = `<div class="hint">读取失败：${esc(e.message)}</div>`;
    return;
  }
  // 只重画这一个容器，不动整页 —— 免得把用户在别的输入框里敲的内容冲掉
  const tmp = document.createElement('div');
  tmp.innerHTML = renderWechatContactsSection(state.config).trim();
  const fresh = tmp.querySelector('#wx-contact-list');
  if (fresh) box.innerHTML = fresh.innerHTML;
  $$('.wx-contact-cb', box).forEach((cb) => {
    cb.addEventListener('change', async () => {
      const id = cb.dataset.id;
      const kind = cb.dataset.kind;
      const allow = cb.checked;
      cb.disabled = true;
      try {
        await api('/api/wechat-contacts/allow', {
          method: 'POST',
          body: JSON.stringify({ id, kind, allow })
        });
      } catch (e) {
        cb.checked = !allow;   // 失败要回滚勾选状态，否则界面与配置不一致
        alert('保存失败：' + e.message);
      } finally {
        cb.disabled = false;
      }
      // 白名单改了 ⇒ 让"聊天白名单"那页与顶栏状态下次打开时是新的
      try { state.config = await api('/api/config'); } catch { /* ignore */ }
      loadWechatContacts();
    });
  });
}

/* ══════════════════════════════════════════════════════════════════════
   微信通道页（2026-09-20 第八对话新增；用户要求"和 snowluma 一样的操作逻辑"）
   ──────────────────────────────────────────────────────────────────────
   为什么要有这一页：在此之前微信通道**只能靠人在命令行开窗口**
   （`中继.mjs` + `跑Bridge.mjs`，后来合成 `跑微信通道.mjs`）——用户看不到状态、
   也没法在界面里开或关。SnowLuma 早就有"启动 / 停止 / 日志"那一套。

   ⚠️ 三条约束（**改这一页前必读**）：
   1. **状态一律取后端 `/api/wechat/channel/status`**，前端不自己推断通没通 ——
      否则又会出现"界面说通了、实际收不到"的两套口径（本项目栽过，见 §12.15）。
   2. **日志框放在常驻容器里**，轮询只重建状态区 —— 整页重建会把用户正在看的位置
      冲掉，这正是 §29「群发打字打一半被打断」的同一个病。
   3. **三段分开显示**（WeFlow / 通道 / 我的链路），断在哪一段要一眼看出来 ——
      "微信没反应"最常见的原因就是中间那段断了而界面不说。
   ══════════════════════════════════════════════════════════════════════ */

/** 页面的骨架（只建一次；之后只重建 `#wx-status` 与更新日志面板的内容）。
 *
 *  ⚠️ 2026-09-22（UI 改造第二阶段条目 3）改版要点，对照方案原文：
 *   · 「三段状态是纯文字编号行」→ StatusBadge + 三段流水线分步器（启停为段内两态开关）
 *   · 「启动/停止是两个按钮；五个按钮平铺无主次，一键自检被埋没」
 *     → 页级只留「一键自检」（主）+「微信联系人（放行）」（次，且门控）；
 *       启停下沉到各自段内；「启动 WeFlow」也沉降到第 1 段内
 *   · 「自动拉起复选框与操作混排」→ 收进底部「偏好」折叠区
 *   · 「顶部说明文字冗余（状态即说明）」→ 压成一行 + ⓘ
 *   · 「pid/路径裸排」→ 元信息行（带复制）
 *   · 日志区 → LogPanel（常驻，理由同 SnowLuma 页）
 *   ⚠️ `#wx-log` 这个 **id 保留**：`loadWechatPage` 与 SSE 都在用它更新日志，
 *      而且 LogPanel 的容器 id 不能变。改成 data-logbody 之后由面板负责渲染。
 */
function wechatPageShell() {
  return `
    <div id="wx-head"></div>
    <div id="wx-status"></div>
    <!-- 「一键自检」的结论区：只在点了之后填，**不参与 15 秒轮询** ——
         自检是"用户主动要一份完整体检"，每次轮询都重跑它既没必要也会冲掉用户正在看的结论。 -->
    <div id="wx-check"></div>
    <!-- 开机自动启动的两个开关。为什么要放在这个页签而不是「设置」：
         它们管的就是这一页在管的那条链，放一起用户才找得到（SnowLuma 那个开关在设置里，
         是因为 SnowLuma 页签早于设置页；这次不重复那个割裂）。
         ⚠️ 条目 3 起收进**偏好折叠区**（方案："自动拉起复选框与操作混排"），
            但 DOM 位置仍在常驻区 —— 复选框不该每 15 秒被重建。 -->
    <details class="devnotes" id="wx-prefs-wrap">
      <summary>偏好设置</summary>
      <div class="devnotes-body" id="wx-autostart"></div>
    </details>
    <div id="wx-log-wrap"></div>`;
}

/** 一行状态：圆点 + 标题 + 说明。
 *  ⚠️ 遗留函数：条目 3 之后微信页改用 StatusBadge + Stepper（见 channelStatusPageHtml），
 *    这个只在少数尚未迁移的地方还在用。**新代码不要再用它** —— 它写死了三个色值
 *    （#35c46a / #e0574a / #8a8a8a），与设计系统的 --green / --red / --muted 是两套，
 *    暗色主题下对不齐。 */
function wxRow(okState, title, detail) {
  const color = okState === true ? '#35c46a' : (okState === false ? '#e0574a' : '#8a8a8a');
  const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>`;
  return `<div style="margin:6px 0">${dot}<b>${esc(title)}</b> <span class="muted">${esc(detail || '')}</span></div>`;
}

/* ══════════════════════════════════════════════════════════════════════════
   通道状态页模板（ChannelStatusPage）—— UI 改造第二阶段条目 3
   ══════════════════════════════════════════════════════════════════════════
   方案原文：「**不做一次性设计。** 本页与 SnowLuma 页同构（多段通道状态+操作+日志），
   抽象配置驱动的『通道状态页』模板：stepper 由 `steps: [{title, desc, status, action}]`
   配置填充，徽章/日志卡/门控全部模板内置。未来新增通道直接复用。」

   ⇒ 所以这里不写"微信专用"的一堆 div，而是吃一份**配置**：
       head:   { title, badges[], meta[], actions[] }
       steps:  [{ title, note, desc, state, actionHtml }]   ← 直接喂给 stepperHtml
       extras: 模板不替你做主的附加区块（自检结果 / 偏好折叠）
       logs:   日志面板的 idPrefix（由调用方自己放常驻容器里）

   ⚠️ 三条结构约定（SnowLuma 那轮踩出来的，这里必须照做）：
     1）**动态区与常驻区分离**。凡是有"界面状态"的东西（日志面板的过滤档与搜索词、
        输入框的草稿与焦点）**都不能放进每 15 秒重建的动态区**。
     2）分步器的动作按钮 id 由调用方给（各通道接口不同），但**每轮重建后必须重绑**。
     3）徽章/分步器/日志/门控**模板内置**，页面不再自己拼 —— 否则"同构"的两份必然漂移。
*/
function channelStatusPageHtml(cfg) {
  const head = cfg.head || {};
  const metaRow = (head.meta || []).filter(Boolean).join(' ');
  return `
    <div class="pagehead">
      <h3>${esc(head.title || '')}</h3>
      ${(head.badges || []).join('')}
      <span class="ph-spacer"></span>
      ${(head.actions || []).join('')}
    </div>
    ${metaRow ? `<div class="snowluma-state-row muted" style="font-size:12px;gap:10px;flex-wrap:wrap">${metaRow}</div>` : ''}
    ${cfg.hintHtml || ''}
    ${cfg.steps && cfg.steps.length ? stepperHtml(cfg.steps) : ''}
    ${cfg.extrasHtml || ''}`;
}

/**
 * 微信通道页：状态区（走 ChannelStatusPage 模板）。
 *
 * 改动点对照方案原文：
 *   · 「三段状态是纯文字编号行」→ 三段流水线分步器（启停为**段内两态开关**）
 *   · 「聚合徽标」→ 三段全通才绿；断开则红**并指出哪段**
 *   · 「启动/停止是两个按钮；五个按钮平铺无主次，一键自检被埋没」
 *     → 页级只留「一键自检」(主) +「微信联系人（放行）」(次，门控)；
 *       启停下沉到段内；「启动 WeFlow」也沉到第 1 段
 *   · 「pid/路径裸排」→ 元信息行（带复制）
 *   · 「顶部说明文字冗余（状态即说明）」→ 一行 + ⓘ
 */
function renderWechatStatus(st) {
  if (!st) {
    return channelStatusPageHtml({
      head: { title: '微信通道', badges: [statusBadge('err', '读不到状态')] },
      hintHtml: hintLine('后端没响应，稍后自动重试。', '这是 /api/wechat/channel/status 没返回 —— 通常是应用刚启动，或后端进程出了问题。'),
    });
  }
  const w = st.weflow || {}, c = st.channel || {}, a = st.agent || {};

  // ── 三段的"通没通"判据（**只在这里定义一次**）──────────────────────────
  // ⚠️ WeFlow 有两种"在"，方案也点到了：端口通 = 真能读库；只有进程 = 还在加载/停在登录页。
  //    这两个状态的处置完全不同，混成一句话会让用户白等。
  const s1 = !!w.running;
  const s2 = !!(c.running && c.bridgeConnected);
  const s3 = !!(a.enabled && a.connected && a.bridgeConnected !== false);
  const allOk = s1 && s2 && s3;

  // ── 聚合徽标：三段全通才绿，断开则**指出哪段**（方案要求）───────────────
  const broken = [s1 ? null : 'WeFlow', s2 ? null : '通道', s3 ? null : '我的链路'].filter(Boolean);
  const aggBadge = allOk
    ? statusBadge('ok', '链路已连通')
    : statusBadge('err', `未连通：${broken.join(' / ')}`);

  // ── 元信息行（方案："pid/路径裸排" → 带复制）────────────────────────────
  const managed = st.managed?.pid
    ? `本应用拉起的通道进程 pid=${st.managed.pid}`
    // ⚠️ 这一句要**提前说清"停止按钮会动它"**：用户看到"外面的窗口里跑的，正常"，
    //    会以为那个按钮碰不到它 —— 于是要么不敢点，要么点了被吓一跳。
    //    ⚠️ 措辞必须保留「停止通道」这四个字：`test-微信WeFlow生命周期.mjs` 有一道
    //       断言专门钉这条文案（那是加这道防线时留下的锚点，别改成「停止」）。
    : (c.running
      ? '通道进程不是本应用拉起的（可能在外面窗口里跑）—— 点「停止通道」会把它一起停掉'
      : '通道进程不是本应用拉起的（可能在外面窗口里跑，正常）');
  const meta = [
    `<span>WeFlow 端口 ${esc(String(w.port || 5031))}</span>`,
    st.managed?.pid ? `<span>pid ${esc(String(st.managed.pid))}</span>` : '',
    `<span class="ihint" role="note" tabindex="0" title="${esc(managed + '；脚本：' + (st.script?.path || '（没找到）'))}" aria-label="运行位置说明">i</span>`,
    `<span class="snowluma-actions" style="margin:0;gap:6px">
       <button class="btn btn-small" id="wx-copy-meta" title="复制端口 / pid / 脚本路径 / WeFlow 程序路径，便于排查时贴给别人">复制</button>
     </span>`,
  ];

  // ── 三段分步器：启停是**段内两态开关**（方案要求）────────────────────────
  const step1Desc = s1
    ? `在跑（端口 ${w.port || 5031} 已通）`
    : (w.starting
      ? `进程在（pid ${(w.pids || []).join(',')}），但端口 ${w.port || 5031} 还没通 —— 它可能还在加载，或停在登录/选数据的界面`
      : '没在跑。WeFlow 是第三方应用，我们只能替你点一下火。');
  const step2Desc = !c.running
    ? '中继没在跑。'
    : (!c.bridgeConnected
      ? '中继在跑，但 Bridge 没连上来 ⇒ 消息进不来也发不出。'
      : `通（Bridge 已连入${c.login ? `，微信侧登录 ${c.login.nickname || c.login.userId}` : ''}${c.eventsIn !== null && c.eventsIn !== undefined ? `，累计收到事件 ${c.eventsIn}` : ''}）`);
  const step3Desc = !a.enabled
    ? '本应用的微信通道没启用（config.wechat.enabled=false）。'
    : (!a.connected ? '本应用没连上中继（会自己重试）。' : (a.bridgeConnected === false ? '连上中继了，但上游（②）不通。' : '通。'));

  const steps = [
    {
      title: 'WeFlow', note: '（读微信本地库、推新消息）',
      desc: step1Desc, state: s1 ? 'done' : 'active',
      actionHtml: s1
        ? `<button class="btn btn-small" id="wx-weflow-btn" title="已经通了；再点一次会尝试重新拉起">重启</button>`
        : `<button class="btn btn-small btn-primary" id="wx-weflow-btn" title="WeFlow 是第三方应用，我们只能替你点一下火">启动 WeFlow</button>`,
    },
    {
      title: '中继 + Bridge', note: '（我们的通道）',
      desc: step2Desc, state: s2 ? 'done' : (s1 ? 'active' : 'todo'),
      actionHtml: c.running
        ? `${quietBtnHtml('wx-stop-btn', '停止通道', '会连 Bridge 一起停；执行前会二次确认')}`
        : `<button class="btn btn-small" id="wx-start-btn">启动通道</button>`,
    },
    {
      title: '我的链路', note: '（QQ Agent 与中继的连接）',
      desc: step3Desc, state: s3 ? 'done' : (s2 ? 'active' : 'todo'),
      // 这一段没有"启动/停止"——它是本应用自己连中继，会自动重试。方案也说了"——"（无操作）
      actionHtml: `<span class="muted" style="font-size:12px">自动连接</span>`,
    },
  ];

  return channelStatusPageHtml({
    head: {
      title: '微信通道',
      badges: [aggBadge, statusBadge(a.enabled ? (a.connected ? 'ok' : 'busy') : 'off', a.enabled ? (a.connected ? '本应用已连接' : '连接中') : '本应用未启用')],
      // ⚠️ 忘了传 meta 就等于"元信息行整行不见了"（端口/pid/复制/说明全没）——
      //    模板只认 head.meta，不会去猜别处的变量。
      meta,
      actions: [
        `<button class="btn btn-small" id="wx-contacts-btn" title="放行谁能收她的消息 —— 在「设置 → 微信联系人」里勾选">微信联系人（放行）</button>`,
        `<button class="btn btn-primary" id="wx-check-btn">一键自检</button>`,
      ],
    },
    // ⚠️ 自检按钮**不加门控**：它的用途恰恰是"不通的时候诊断为什么不通"，
    //    锁住它等于把唯一的诊断入口关掉（方案里的门控是给"依赖连通才能成功"的操作用的）。
    hintHtml: hintLine('三段各管一件事，三段都得通才收得到微信消息。',
      '① WeFlow：第三方应用，读微信本地库并把新消息推出来。'
      + '② 中继 + Bridge：我们的通道，负责把 WeFlow 的消息转成 OneBot 事件。'
      + '③ 我的链路：本应用连上中继 —— 它会自己重试，不需要手动操作。'
      + '断了哪一段，上面的徽章会直接点名。'),
    steps,
  });
}

/** 开机自动启动的两个开关（值来自 /api/config，不是 status）。 */
function renderWechatAuto(cfg) {
  const w = cfg?.wechat || {}
  return `
    <div class="checkbox-row" style="margin:2px 0"><input type="checkbox" id="wx-autorelay" ${w.autoLaunchRelay ? 'checked' : ''} />
      <label for="wx-autorelay">应用启动时自动拉起微信通道（中继 + Bridge）</label></div>
    <div class="checkbox-row" style="margin:2px 0 10px"><input type="checkbox" id="wx-autoweflow" ${w.autoLaunchWeFlow !== false ? 'checked' : ''} />
      <label for="wx-autoweflow">自动拉起通道时，顺手把 WeFlow 也点着（不点着的话：通道看着全通，却收不到消息）</label></div>`
}

/** ⚠️ 2026-09-22（条目 3）：`wechatVerdict()` 已删除。
 *  它做的是"把三段通没通写成一句人话"，而现在这件事由**聚合徽标**承担
 *  （`renderWechatStatus` 里的 `aggBadge`：三段全通才绿，断开则直接点名哪段），
 *  信息更结构化，且不用维护第二份"三段判据"。留着一个没人调的旧函数
 *  比删掉更危险 —— 下次有人改判据时不知道要改两处。 */

let wechatPageBound = false
function bindWechatPageEvents() {
  if (wechatPageBound) return
  wechatPageBound = true
  const page = document.getElementById('wechat-page')
  if (!page) return
  page.addEventListener('click', async (e) => {
    const id = e.target && e.target.id
    if (!id || !id.startsWith('wx-')) return
    const map = {
      // 启动通道时**顺带把 WeFlow 点着**（后端默认这么做）：少了这一步，用户会遇到
      // "通道起来了、日志也正常，就是收不到消息"，原因是 WeFlow 没开。
      'wx-start-btn': ['/api/wechat/channel/start', '启动通道', { launchWeFlowFirst: true }],
      'wx-stop-btn': ['/api/wechat/channel/stop', '停止通道', { force: true }],
      // 拉起后等端口通（最多 45 秒）—— 否则用户点完立刻看到的还是"没在跑"，会以为失败了
      'wx-weflow-btn': ['/api/wechat/channel/weflow/launch', '启动 WeFlow', { wait: true }]
    }
    if (id === 'wx-check-btn') {
      // 🔴 真的去查（POST /api/wechat/channel/selfcheck），**不是**把页面重拉一遍。
      //    旧实现是 `loadWechatPage({force:true})`，而这一页每 15 秒本来就自动刷
      //    ⇒ 那是个"看起来会做事、其实什么也不做"的按钮。
      //
      // ⚠️ 2026-09-22（条目 3）：自检结果**按三段结构化展示**（方案要求
      //    "结果按三段结构化展示（通过/失败+修复指引，不混入日志流）"）。
      //    后端 items 里已带 title/detail；这里按微信的三段分组，组内失败项展开、
      //    全通过的组收成一行 —— 这样"哪一段坏了"一眼可见，不用读五条流水账。
      const box = $('#wx-check')
      const btn = e.target.closest('button')
      if (btn) { btn.disabled = true; btn.textContent = '自检中…' }
      if (box) box.innerHTML = '<div class="hint">自检中…（会真的去探端口，最多几十秒）</div>'
      try {
        const r = await api('/api/wechat/channel/selfcheck', { method: 'POST', body: '{}' })
        if (box) box.innerHTML = renderSelfcheck(r)
      } catch (err) {
        if (box) box.innerHTML = `<div class="safetybar"><span>⚠️</span><span>自检失败：${esc(err.message)}</span></div>`
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '一键自检' }
      }
      return
    }
    // 两个开机自启动开关：`change` 也会走 click 分支，e.target.checked 此时已是新值。
    if (id === 'wx-autorelay' || id === 'wx-autoweflow') {
      const key = id === 'wx-autorelay' ? 'autoLaunchRelay' : 'autoLaunchWeFlow'
      const val = !!e.target.checked
      // ⚠️ 反馈不写进日志面板、也不写进每轮重建的 #wx-status（会被冲掉）——
      //    写进不参与轮询的 #wx-check 区，并让它自己消失（存/失败都是瞬时的）。
      const say = (text, ok) => {
        const box2 = $('#wx-check')
        if (box2) box2.innerHTML = `<div class="${ok ? 'hint' : 'safetybar'}">${ok ? '' : '<span>⚠️</span>'}<span>${esc(text)}</span></div>`
        setTimeout(() => { const b3 = $('#wx-check'); if (b3 && b3.textContent.includes(text.slice(0, 12))) b3.innerHTML = '' }, 4000)
      }
      try {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ wechat: { [key]: val } }) })
        say(`已保存：${key} = ${val}${key === 'autoLaunchRelay' && val ? '（下次启动应用时自动拉起通道）' : ''}`, true)
      } catch (err) {
        // 🔴 存不上必须**把勾选退回去**，否则界面在说谎（用户以为开了，其实没开）
        e.target.checked = !val
        say(`保存失败（已把勾选退回）：${err.message}`, false)
      }
      return
    }
    // 「微信联系人（放行）」：跳到设置页那一节。
    // 为什么要有个跳转而不是在这里直接勾选：放行 = 让机器人开始对**某个真人**说话，
    // 那是用户的决定，入口应该只有一处（设置页那节），页签只负责把人送过去。
    if (id === 'wx-contacts-btn') {
      state.settingsSection = 'wechat';
      switchTab('settings');    // 内部会 loadSettings()，按 state.settingsSection 渲染
      return
    }
    // 复制元信息（端口 / pid / 脚本 / WeFlow 程序）—— 条目 3 的"带复制"
    if (id === 'wx-copy-meta') {
      const st2 = state.wechatStatus || {}
      const w2 = st2.weflow || {}, c2 = st2.channel || {}
      const txt = [
        `WeFlow 端口：${w2.port || 5031}（${w2.running ? '通' : (w2.starting ? '进程在但端口未通' : '未运行')}）`,
        `WeFlow 程序：${w2.exe || '（没找到）'}`,
        `中继 + Bridge：${c2.running ? '中继在跑' : '未运行'}${c2.bridgeConnected ? '，Bridge 已连入' : '，Bridge 未连入'}`,
        `通道进程 pid：${st2.managed?.pid ?? '（不是本应用拉起的）'}`,
        `通道脚本：${st2.script?.path || '（没找到）'}`,
      ].join('\n')
      try { await navigator.clipboard.writeText(txt); e.target.textContent = '已复制' }
      catch { e.target.textContent = '复制失败' }
      setTimeout(() => { const b = $('#wx-copy-meta'); if (b) b.textContent = '复制' }, 1200)
      return
    }
    const hit = map[id]
    if (!hit) return
    const [path, label, body] = hit
    // ⚠️ 反馈写进 #wx-check（不参与轮询、不会被冲掉），**不要**写进每轮重建的 #wx-status。
    const say = (text, ok) => {
      const box2 = $('#wx-check')
      if (!box2) return
      box2.innerHTML = ok
        ? `<div class="hint">${esc(text)}</div>`
        : `<div class="safetybar"><span>⚠️</span><span>${esc(text)}</span></div>`
    }
    // 「停止通道」是**破坏性操作** ⇒ 二次确认（条目 3 原则 3）。
    // 确认文案说清后果：停的是"微信消息进不来"这件事，不只是关一个进程。
    const runAction = async () => {
      say(`${label}中…${id === 'wx-weflow-btn' ? '（要等它的端口起来，最多 45 秒）' : ''}`, true)
      try {
        const r = await api(path, { method: 'POST', body: JSON.stringify(body || {}) })
        if (!r?.ok) {
          // 失败要把**原文**带上（比如"找过这几个路径都不存在"），别只说"未知原因"
          say(`${label}失败：${r?.error || '未知原因'}`, false)
        } else if (r.note) {
          // 🔴 有 note 就直接用它：`stopped:false` 也是 `ok:true`，
          //    这时候说"停止通道成功"是**界面在说谎**（什么都没停）。
          //    note 是后端写好的完整句子，含"它原本是谁拉起的、现在怎么了"。
          say(`${label}：${r.note}`, true)
        } else {
          say(`${label}成功${r.alreadyRunning ? '（本来就在跑）' : (r.launched ? '（已拉起）' : '')}${r.waitedMs ? `，等了 ${Math.round(r.waitedMs / 1000)} 秒` : ''}`, true)
        }
      } catch (err) {
        say(`${label}失败：${err.message}`, false)
      }
      loadWechatPage({ force: true })
    }
    if (id === 'wx-stop-btn') {
      confirmDanger({
        head: '停止微信通道？',
        okText: '停止',
        text: `停掉之后<b>微信消息进不来，她也发不出去</b>。<br><br>
          通道是「中继 + Bridge」两个进程${state.status?.wechat?.managedPid ? '（其中一个由本应用拉起）' : ''}，
          停止会一起停掉。<br><br>
          要恢复得重新点「启动通道」。<br><br>
          ⚠️ 如果通道进程不是本应用拉起的（在你自己开的窗口里跑），这一步也会把它一起停掉。`,
        onOk: runAction,
      })
      return
    }
    await runAction()
  })
}

async function loadWechatPage({ force = false } = {}) {
  const box = document.getElementById('wechat-page')
  if (!box) return
  if (force || !document.getElementById('wx-status')) {
    box.innerHTML = wechatPageShell()
    // 日志面板：**常驻**（不随 #wx-status 重建）—— 理由同 SnowLuma 页：
    // LogPanel 有过滤档/搜索词/自动滚动这些界面状态，放动态区里每 15 秒就被清掉。
    const logWrap = document.getElementById('wx-log-wrap')
    if (logWrap) {
      logWrap.innerHTML = logPanelShell('通道日志', 'wx-log', {
        emptyText: '（还没有日志：通道还没由本应用启动过，或者你是在外面的窗口里跑的）',
      })
      // 面板外壳里带 <details>/<summary> 吗？没有 —— 但按钮是 <button>，
      // 在无边框窗口的 drag 区外，无需 no-drag。
      initLogPanel('wx-log')
    }
    bindWechatPageEvents()
  }
  let st = null
  let logs = []
  let cfg = null
  try { st = await api('/api/wechat/channel/status') } catch { st = null }
  state.wechatStatus = st || {}   // 「复制元信息」要用（见 bindWechatPageEvents）
  try { logs = (await api('/api/wechat/channel/logs?limit=100')).logs || [] } catch { /* 日志读不到不影响状态 */ }
  try { cfg = await api('/api/config') } catch { /* 配置读不到就保留上一次的勾选，不闪 */ }
  const sBox = document.getElementById('wx-status')
  // ⚠️ 2026-09-22：状态区改由 ChannelStatusPage 模板渲染（含页头徽章 + 三段分步器）。
  //    它里面**没有输入元素**（按钮每轮重建、由 bindWechatPageEvents 重绑），
  //    所以整块重建是安全的。日志面板与偏好折叠区都在它外面（常驻）。
  if (sBox) sBox.innerHTML = renderWechatStatus(st)
  else {
    // 状态容器被别处重建掉了（例如切页签回来）⇒ 重搭骨架，避免整页空白
    const headBox = document.getElementById('wx-head')
    if (headBox) { box.innerHTML = wechatPageShell(); bindWechatPageEvents() }
  }
  // ⚠️ 自启动开关**只在值真的变了时才重建 DOM**：这个函数是轮询调用的，
  //    每轮重写勾选框会和"用户正在点它"打架（点下去又被旧值刷回去）。
  const aBox = document.getElementById('wx-autostart')
  if (aBox && cfg?.wechat) {
    const key = `${!!cfg.wechat.autoLaunchRelay}|${cfg.wechat.autoLaunchWeFlow !== false}`
    if (aBox.dataset.renderKey !== key) {
      aBox.dataset.renderKey = key
      aBox.innerHTML = renderWechatAuto(cfg)
    }
  }
  // 日志：只重画面板里的行，**不重建面板**（面板的过滤/搜索状态要留住）。
  const logPanel = document.getElementById('wx-log')
  if (logPanel) {
    const body = logPanel.querySelector('[data-logbody]')
    if (body) {
      body.innerHTML = logRowsHtml(logs)
      if (typeof logPanel.__apply === 'function') logPanel.__apply()
    }
  }
}

/** 把微信通道日志行渲染成 LogPanel 的分级行。 */
function logRowsHtml(logs) {
  if (!logs || !logs.length) {
    return '<div class="logpanel-empty">（还没有日志：通道还没由本应用启动过，或者你是在外面的窗口里跑的）</div>'
  }
  const text = logs.map((l) => `[${new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })}] ${l.text}`).join('\n')
  return logPanelRows(text, 'wx-log')
}

/**
 * 「一键自检」结果：**按三段结构化**展示（方案条目 3 要求：
 * "自检结果按三段结构化展示（通过/失败+修复指引，不混入日志流）"）。
 *
 * 为什么不能只列流水账：后端 items 是一个平铺列表（端口探测、进程检查、配置检查…混在一起），
 * 用户读五条之后仍然不知道"到底哪一段坏了"。按三段归组之后，**坏的组展开、好的组收一行**，
 * 一眼就能定位。
 *
 * ⚠️ 归组判据用**关键词匹配**，不是靠 items 的顺序 —— 顺序是后端的实现细节，
 *    改了顺序不该让分组错位。匹配不到的关键词项归入"其它"，**不丢**。
 */
function renderSelfcheck(r) {
  const items = r?.items || []
  const groups = [
    { name: '① WeFlow', re: /weflow|端口\s*5031|读库/i },
    { name: '② 中继 + Bridge', re: /中继|bridge|relay|akasha|11230|11229/i },
    { name: '③ 我的链路', re: /本应用|agent|启用|连接|配置|config/i },
  ]
  const used = new Set()
  const buckets = groups.map((g) => {
    const hit = items.filter((i, idx) => {
      if (used.has(idx)) return false
      const ok = g.re.test(`${i.title || ''} ${i.detail || ''}`)
      if (ok) used.add(idx)
      return ok
    })
    return { name: g.name, items: hit }
  })
  buckets.push({ name: '其它检查', items: items.filter((_, idx) => !used.has(idx)) })

  const head = `<div class="pagehead" style="margin-bottom:6px">
      <h3 style="font-size:13px">自检结果</h3>
      ${r?.ok ? statusBadge('ok', '全部通过') : statusBadge('err', '有项目未通过')}
      <span class="ph-spacer"></span>
      <span class="muted" style="font-size:12px">${esc(r?.summary || '')}</span>
    </div>`

  const body = buckets.filter((b) => b.items.length).map((b) => {
    const bad = b.items.filter((i) => !i.ok)
    // 全通过的组收成一行（方案："3 秒内定位"—— 好的东西不该占地方）
    if (!bad.length) {
      return `<div class="mem-interop-group"><span class="sbadge ok"><span class="sdot"></span>${esc(b.name)}</span>
        <span class="muted">${b.items.length} 项全通过</span></div>`
    }
    return `<div class="mem-interop-group" style="display:block">
      <span class="sbadge err"><span class="sdot"></span>${esc(b.name)}</span>
      <span class="muted">${bad.length} 项未通过</span>
      <div style="margin:4px 0 0 6px">
        ${bad.map((i) => `<div style="margin:3px 0"><b>${esc(i.title)}</b>
          <span class="muted">${esc(i.detail)}</span></div>`).join('')}
      </div>
    </div>`
  }).join('')

  return `<div class="pt-summary" style="margin:6px 0 12px">${head}${body}</div>`
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    wechat: () => renderWechatContactsSection(c),
    chat: () => renderChatSection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  return `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
    </div>
    ${render()}`;
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空保存则保持原 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入（关闭则移除看图工具，模型只会看到 [图片] 占位符）</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="settings-divider"></div>

    <h3>成本核算</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
      <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

    <div class="field" style="margin-bottom:12px"><label>远程价格表 URL</label>
      <div class="field-row-inline">
        <input type="text" id="cfg-price-remote-url" placeholder="例如 https://你的服务器/prices.json" value="${esc(c.api.priceRemoteUrl || '')}" />
        <button class="btn btn-small" id="price-feed-refresh-btn" title="不等定时，立即拉一次">立即拉取</button>
      </div>
      <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
    </div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="form-panel">
      <div class="panel-head">
        <span class="panel-title">接入信息</span>
        <span class="panel-note">填地址与 Key，再添加模型</span>
      </div>

      <div class="field"><label>Base URL</label>
        <div class="field-row-inline">
          <input type="text" id="new-baseurl" placeholder="https://api.deepseek.com/v1" />
          <button class="btn btn-small" id="fetch-models-btn" title="从上面的地址拉取可用模型，弹窗里勾选加入">获取列表</button>
        </div>
        <div class="hint">支持 OpenAI 兼容接口，例如 <code>https://api.deepseek.com/v1</code>、<code>https://open.bigmodel.cn/api/paas/v4</code>。</div>
      </div>

      <div class="field"><label>API Key</label>
        <div class="field-row-inline">
          <input type="password" id="new-apikey" placeholder="sk-…" autocomplete="new-password" />
          <button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>
        </div>
        <div class="hint">只保存在本机 <code>data/config.json</code>，不会随诊断包导出。</div>
      </div>

      <div class="field"><label>模型</label>
        <div id="model-rows"></div>
        <div class="field-row-inline" style="margin-top:6px">
          <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
          <span class="hint" style="margin-top:0">左列是模型 ID（发给接口的那个），右列只是目录里的显示名</span>
        </div>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button>
      <button class="btn btn-danger" id="delete-model-btn">删除模型…</button>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}


function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <div class="field">
      <div class="checkbox-row"><input type="checkbox" id="cfg-doujin" ${c.doujinLookup?.enabled ? 'checked' : ''} />
        <label for="cfg-doujin">本子查询：启用 <code>doujin-lookup__lookup</code> 工具（由 <code>skills/doujin-lookup/</code> 提供；JM 禁漫<b>直连</b>查「本子码 + 名字」，JM 搜不到时用本地 NH 英文库兜底）</label></div>
      <div class="field-row">
        <div class="field"><label>一次最多返回几本</label>
          <input type="number" id="cfg-doujin-max" min="1" max="50" value="${esc(c.doujinLookup?.maxResults ?? 10)}" /></div>
        <div class="field"><label>单次查询超时（毫秒）</label>
          <input type="number" id="cfg-doujin-timeout" min="3000" max="120000" value="${esc(c.doujinLookup?.timeoutMs ?? 30000)}" /></div>
        <div class="field"><label>群聊里也允许</label>
          <span><input type="checkbox" id="cfg-doujin-group" ${c.doujinLookup?.allowInGroup !== false ? 'checked' : ''} /> 允许</span>
          <div class="hint">关掉则只在<b>私聊</b>里可用 —— 群聊里发本子名容易被盯上。</div></div>
      </div>
      <div class="field-row">
        <div class="field"><label>工具目录（留空＝默认）</label>
          <input type="text" id="cfg-doujin-dir" value="${esc(c.doujinLookup?.toolDir || '')}" placeholder="&lt;dsh qq&gt;/JM工具" /></div>
        <div class="field"><label>Python 解释器（留空＝自动找 venv）</label>
          <input type="text" id="cfg-doujin-python" value="${esc(c.doujinLookup?.pythonPath || '')}" placeholder="自动" /></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <button class="btn btn-small" id="doujin-check-btn">检测连通</button>
        <button class="btn btn-small" id="doujin-search-btn">试查"校园"</button>
        <span id="doujin-check-hint" class="muted" style="font-size:12px"></span>
      </div>

      <div style="margin-top:10px">
        <div id="doujin-db-line" class="muted" style="font-size:12px">离线库：读取中…</div>
        <div id="doujin-db-note" class="muted" style="font-size:12px"></div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
          <!-- 原生 <input type=file> 的按钮是系统样式，与 UI 割裂：隐藏本体，用统一的 .btn 触发（同意见反馈那张图） -->
          <input type="file" id="doujin-import-file" accept=".db,.sqlite,.csv" style="display:none" />
          <button class="btn btn-small" id="doujin-import-btn">导入离线库（.db / .csv）</button>
          <span id="doujin-import-hint" class="muted" style="font-size:12px"></span>
        </div>
        <!-- file.path 拿不到时的退路（较新的 Electron 只给 File 对象、不给真实路径）：
             让用户直接把路径粘进来。默认隐藏，只有真拿不到才显示。 -->
        <div id="doujin-import-manual" style="display:none;margin-top:6px">
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" id="doujin-import-path" placeholder="把离线库/CSV 的完整路径粘到这里，例如 D:\data\nh.db"
              style="flex:1;min-width:320px" />
            <button class="btn btn-small" id="doujin-import-go">用这个路径导入</button>
          </div>
        </div>
        <div class="hint">
          导入 <code>.csv</code> 会本地转成 <code>nh.db</code>（约几秒，期间别关窗口）；
          导入 <code>.db</code>/<code>.sqlite</code> 是直接换库，旧库自动改名备份。
          ⚠️ 只校验文件头/表头，表结构不对要到<b>下一次真实查询</b>才会暴露。
        </div>
        <details class="hint-more">
          <summary>说明：表头要求、备份与回滚、耗时</summary>
          <div class="hint-more-body">
            表头要能对上 <code>id,title,upload_date,tags</code>；Excel 的 <code>.xlsx</code> 不行，
            先在 Excel 里「另存为 → CSV UTF-8」。<br>
            实测 52 万行 / 89.4MB 的表约 <b>2~3 秒</b>（本机 2.3 秒）；转换期间 JM 查询会排队等它跑完。<br>
            旧库会改名成 <code>nh.db.bak-日期-时间</code> 留在原地；想回滚就把备份改回 <code>nh.db</code>。<br>
            库文件在<b>你选的路径上就地生效</b>（即配置里的这个路径；改路径要保存才生效）。
          </div>
        </details>
      </div>
      <div class="hint">
        JM 搜索是<b>真直连</b>（本机 Python 子进程，不需要代理）。<b>首次查询约 3 秒</b>，之后同一进程内就快了。
        ⚠️ 兜底的 NH 离线库标题<b>几乎全是英文</b>，中文/日文关键词基本查不到 —— 模型会自己先翻成英文再查。
      </div>
    </div>

    <h3 id="settings-search">搜索服务</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${c.webSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-imagesearch" ${c.imageSearch?.enabled !== false ? 'checked' : ''} />
      <label for="cfg-imagesearch">以图搜图：启用 search_image_source 工具（trace.moe / SauceNAO / iqdb / 搜图 bot，均免 Key）</label></div>
    <div class="field">
      <label>看图（视觉）的体积上限</label>
      <div class="field-row">
        <div class="field"><label>单张原图（KB）</label>
          <input type="number" id="cfg-img-maxkb" min="1" max="32768" value="${esc(c.imageLimits?.maxKB ?? 700)}" /></div>
        <div class="field"><label>一轮累计（MB）</label>
          <input type="number" id="cfg-img-maxrun" min="1" max="64" value="${esc(c.imageLimits?.maxRunMB ?? 3)}" /></div>
        <div class="field"><label>一次最多看几张</label>
          <input type="number" id="cfg-img-perview" min="1" max="50" value="${esc(c.imageLimits?.maxPerView ?? 6)}" /></div>
        <div class="field"><label>下载阶段上限（MB）</label>
          <input type="number" id="cfg-img-maxdl" min="1" max="128" value="${esc(c.imageLimits?.maxDownloadMB ?? 12)}" /></div>
      </div>
      <div class="hint">
        超过「单张原图」的图<b>直接拒绝</b>（只有动画 GIF 会先截首帧再比），模型收到一句"图太大"。改完<b>不用重启</b>。
        <b>真正的代价是图片 token</b>：调得越大，它就越会真去看大图，每次看图都按输入 token 计费。
      </div>
      <details class="hint-more">
        <summary>说明：700KB 这个默认值是怎么定的、调大会怎样</summary>
        <div class="hint-more-body">
          默认 700KB 是当初为了防网关 413 定的；实测网关 <b>32MB 能过、48MB 才 413</b>，所以往上调是安全的。
          「一次最多看几张」会写进工具描述，<b>改它等于换一次提示词前缀</b>（前缀缓存要重新热身一次，一次性成本）。
        </div>
      </details>
    </div>
    <div class="field-row">
      <div class="field"><label>搜图触发策略</label>
        <select id="cfg-imagesearch-policy">
          <option value="asked" ${(c.imageSearch?.policy || 'asked') === 'asked' ? 'selected' : ''}>只在有人问出处时才搜（推荐）</option>
          <option value="free" ${c.imageSearch?.policy === 'free' ? 'selected' : ''}>交给模型自己判断（容易看到图就搜）</option>
        </select>
        <div class="hint">「只在被要求时」是<b>代码层拦截</b>，不只靠提示词。</div>
        <details class="hint-more">
          <summary>说明：什么算"被要求"</summary>
          <div class="hint-more-body">
            本次唤醒的消息里没有"出处 / 什么番 / 画师 / 哪来的 / 图里是谁"这类措辞时，工具会直接拒绝，
            并提示模型先问一句"要我帮你查吗"再搜。
          </div>
        </details>
      </div>
      <div class="field"><label>单次运行最多真搜几次</label>
        <input type="number" id="cfg-imagesearch-max" min="1" max="10" value="${esc(c.imageSearch?.maxPerRun ?? 2)}" />
        <div class="hint">上限只统计<b>真正打到引擎</b>的次数，参数写错不占额度。</div>
        <details class="hint-more">
          <summary>说明：为什么要设这个上限</summary>
          <div class="hint-more-body">
            实测一次运行会把多个引擎挨个试一遍（同一张图搜 5 次），又慢又费 SauceNAO 额度。
          </div>
        </details>
      </div>
    </div>
    <div class="field"><label>SauceNAO API Key（可选：注册 saucenao.com 账号免费获取；填了走官方 JSON API，更稳且不怕网页改版）</label>
      <input type="password" id="cfg-saucenao-key" value="${esc(c.imageSearch?.hasSaucenaoApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" /></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-cfbypass" ${c.imageSearch?.cfBypass !== false ? 'checked' : ''} />
      <label for="cfg-cfbypass">Cloudflare 验证自动绕过（被拦截时用内置浏览器自动完成验证，仅限搜图引擎域名）</label></div>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-v4-pro')}" />
        <div class="hint">必须是账号里真实存在、<b>且支持 web_search 工具</b>的模型。
          ⚠️ <b>写错模型不会报错，只会让搜索悄悄失效</b>。</div>
        <details class="hint-more">
          <summary>说明：哪些模型名可用、写错会怎样</summary>
          <div class="hint-more-body">
            实测 <code>deepseek-v4-pro</code> 会真的联网；<code>deepseek-flash</code> 会忽略联网工具、
            直接回答"我无法联网搜索"；<code>deepseek-v4-flash</code> 这个模型名不存在，
            API 会静默回退到 flash。
          </div>
        </details></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">记忆整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用记忆自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>记忆整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（毫秒）</label><input type="number" id="cfg-mem-interval" min="1800000" step="600000" value="${esc(mem.consolidateMinIntervalMs ?? 21600000)}" /></div>
    <div class="hint">两个条件<b>都</b>满足才整理：条数超过阈值，且距上次整理超过这个冷却时间。默认 6 小时。</div>`;
}

/**
 * 「系统提示自定义」区块。
 * 内置系统提示硬编码在 src/prompt.js（安全规则/工具协议/反 AI 味…），原设置页只能
 * 看不能改。这里提供两个入口，写进 persona 的两个字段：
 *   1. 整份替换 —— persona.systemPrompt
 *   2. 逐段替换 —— persona.systemPromptSegments[key]
 * 逐段输入框预填"当前生效文本"（没有覆盖就是内置默认），保存时与加载到的内置默认比较，
 * 一致就不写覆盖 —— 于是"改回默认"等价于自动取消该段覆盖。
 */
function renderSystemPromptEditor(c) {
  const persona = c.persona || {};
  const sp = state.systemPrompt;
  const overrides = persona.systemPromptSegments || {};
  const overrideCount = Object.values(overrides).filter((v) => String(v ?? '').trim()).length;
  const fullText = String(persona.systemPrompt || '');
  const fullOverride = fullText.trim();

  // 生效状态徽标（反映已保存的配置；未保存的改动由 #sysprompt-state 单独提示）
  const badge = fullOverride
    ? '<span class="sp-badge sp-badge-full">整份覆盖</span>'
    : overrideCount
      ? `<span class="sp-badge sp-badge-seg">逐段覆盖 ${overrideCount} 段</span>`
      : '<span class="sp-badge sp-badge-default">内置默认</span>';
  const mode = fullOverride
    ? '当前生效：整份覆盖'
    : (overrideCount ? `当前生效：逐段覆盖 ${overrideCount} 段` : '当前生效：内置系统提示');

  const segHtml = sp
    ? sp.segments.map((s) => {
      const overridden = String(overrides[s.key] ?? '').trim();
      const cur = overridden || s.default || '';
      // data-default 存内置默认，供「恢复默认」按钮和实时「已覆盖」标记比对用
      return `<div class="sp-seg">
        <div class="sp-seg-head">
          <span class="sp-seg-title">${esc(s.label)}</span>
          <span class="sp-badge sp-badge-seg sp-seg-flag${overridden ? '' : ' hidden'}">已覆盖</span>
          <span class="sp-seg-count">${cur.length} 字符</span>
          <button type="button" class="btn btn-small sp-seg-reset" title="恢复为内置默认文本">恢复默认</button>
        </div>
        <textarea class="persona-role-text sysprompt-seg" data-seg-key="${esc(s.key)}" data-default="${esc(s.default || '')}" spellcheck="false">${esc(cur)}</textarea>
      </div>`;
    }).join('')
    : '<div class="hint">未能读取内置段落（后端没有返回 /api/system-prompt）。为安全起见，本次保存不会改动已有的逐段覆盖。</div>';

  return `
    <details class="collapsible sp-editor" id="sysprompt-box">
      <summary>
        <span class="sp-summary-title">系统提示自定义</span>
        <span class="sp-summary-sub">高级 · 修改内置提示词</span>
        ${badge}
      </summary>
      <div class="coll-body">
        <div class="sp-callout">
          <span class="sp-callout-icon">⚠</span>
          <div>整份替换会连工具协议一起覆盖（如「发言必须调用 send_message」），删掉那段机器人就不会再说话。建议先「载入内置默认」再改，或优先用下面的逐段替换。</div>
        </div>
        <div class="hint sp-explain">
          保存后<b>下一条消息</b>即生效，无需重启。优先级：完整系统提示 &gt; 逐段替换 &gt; 内置默认。
          覆盖文本可用 <code>{botName}</code>、<code>{participation}</code> 占位符。
        </div>
        <div class="sp-callout">
          <span class="sp-callout-icon">🆕</span>
          <div><b>逐段替换只对 QQ 生效</b>（2026-09-20 起）。微信侧一律用内置的平台版——
            因为人写覆盖时想的是 QQ 的能力（<code>send_sticker</code>、<code>send_poke</code>、表情包…），
            套到微信侧会<b>诱导她去调一个不存在的能力</b>。
            想让微信侧也有自定义措辞，请等「微信专用覆盖」这个功能（还没做）。</div>
        </div>
        <div class="field"><label>完整系统提示（留空 = 使用内置）</label>
          <textarea id="cfg-sysprompt" class="persona-role-text sp-full-text" placeholder="留空即使用内置系统提示。点下方「载入内置默认」可把内置提示填进来再改。" spellcheck="false">${esc(persona.systemPrompt || '')}</textarea></div>
        <div class="sp-toolbar">
          <button class="btn btn-small" id="sysprompt-load">载入内置默认</button>
          <button class="btn btn-small" id="sysprompt-clear">清空整份覆盖</button>
          <span id="sysprompt-count" class="sp-seg-count">${fullText.length} 字符</span>
          <span id="sysprompt-state" class="sp-state">${esc(mode)}</span>
        </div>
        <details class="sp-segments">
          <summary>逐段替换<span class="sp-summary-sub">只改其中几段，推荐</span></summary>
          <div class="sp-seg-list">${segHtml}</div>
        </details>
      </div>
    </details>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderSystemPromptEditor(c)}
    ${renderPersonaSaveBar()}`;
}

/**
 * 聊天白名单（UI 改造第二阶段 条目 6 重写）。
 *
 * 🔴 方案原文：「核心问题是「复选框 × 两个可空列表」交互产生四种语义，两段说明文字是打补丁。
 *   **改三选一模式单选**：允许所有会话 / 禁止所有会话 / 只运行在白名单（默认）——
 *   复选框与说明文字全删，空列表行为由模式自明。逗号文本框改**芯片输入**。
 *   仅存一行「与『微信联系人』勾选共用同一份配置 ⓘ」」
 *
 * ⚠️ 模式值的来源：`allow.mode`。老配置没有这个键时**按旧语义推导**（`deriveAllowModeUi`），
 *    保证"还没迁移/迁移失败"时界面显示的是**真实生效的那个模式**，而不是默认值。
 *    （后端的 allowed() 也是同样的兜底逻辑 —— 两边必须一致，否则界面会说谎。）
 */
/**
 * 允许模式的三个取值（与后端 `allowed()` 里的 ALLOW_MODES 必须一致）。
 * ⚠️ 前端这份只用于"校验读到的值合不合法"，判定权威永远在后端。
 */
const ALLOW_MODES_UI = ['allowAll', 'denyAll', 'whitelist'];

function deriveAllowModeUi(c) {
  const g = (c.allow?.groups || []).filter((x) => String(x).trim() !== '');
  const p = (c.allow?.private || []).filter((x) => String(x).trim() !== '');
  if (g.length || p.length) return 'whitelist';
  return c.allowAllWhenEmpty === true ? 'allowAll' : 'denyAll';
}

function renderAllowSection(c) {
  const mode = ['allowAll', 'denyAll', 'whitelist'].includes(c.allow?.mode)
    ? c.allow.mode
    : deriveAllowModeUi(c);   // 老配置没有 mode ⇒ 按旧语义推导（与后端 allowed() 一致）
  const groups = (c.allow?.groups || []).map(String);
  const privates = (c.allow?.private || []).map(String);

  const MO = [
    ['allowAll', '允许所有会话', '任何群聊和私聊都会响应 —— 黑名单里的人除外'],
    ['denyAll', '禁止所有会话', '谁都不响应（临时停机用；比「暂停」更彻底）'],
    ['whitelist', '只运行在白名单', '只有下面名单里的群和好友会响应（默认）'],
  ];

  const modeOpt = ([v, title, desc]) => `<label class="modeopt${mode === v ? ' on' : ''}">
      <input type="radio" name="allow-mode" value="${v}" ${mode === v ? 'checked' : ''}>
      <span><span class="mo-title">${title}</span><span class="mo-desc">${desc}</span></span>
    </label>`;

  // 芯片输入：一个群一个芯片，点 × 删；回车或点「添加」加。
  // ⚠️ 前缀区分群与好友（方案要求）：`群 123456` / `好友 123456` —— 两类 id 都在同一个
  //    数字空间里，不标前缀的话用户分不清这个数字是群还是人。
  const chip = (kind, id) => `<span class="wchip ${kind === 'groups' ? 'grp' : 'frd'}"
      >${kind === 'groups' ? '群' : '好友'} ${esc(id)}<span class="wchip-x" data-rm="${kind}" data-id="${esc(id)}" role="button" tabindex="0" title="移除">×</span></span>`;

  const box = (kind, label, placeholder) => `
    <div class="field">
      <label>${label}</label>
      <div class="chipbox" data-chipbox="${kind}">
        ${(kind === 'groups' ? groups : privates).map((id) => chip(kind, id)).join('')}
        <input type="text" inputmode="numeric" data-chipinput="${kind}"
               placeholder="${placeholder}" aria-label="${label}">
      </div>
    </div>`;

  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="modepick" id="allow-mode-pick">${MO.map(modeOpt).join('')}</div>
    <div class="field-row" style="margin-top:12px">
      ${box('groups', '允许的群', '输入群号后回车')}
      ${box('private', '允许的好友', '输入 QQ 号后回车')}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-small" id="pick-groups-btn">从 QQ 账号选群</button>
      <button class="btn btn-small" id="pick-friends-btn">从 QQ 账号选好友</button>
      <span id="pick-result" class="muted"></span>
      <span id="allow-hint" class="muted" style="font-size:12px"></span>
    </div>
    ${hintLine('与「微信联系人」勾选共用同一份配置。',
      '微信联系人在「设置 → 微信联系人」里勾选，勾上就是把人加进这里的好友名单 —— 两边是同一份 allow.private，'
      + '在哪边改都生效。名单里的数字：群号来自 QQ 群；微信好友的 id 是从收到的微信消息里学到的派生数字，'
      + '所以别手填，去「微信联系人」页点选。')}`;
}

/**
 * 微信联系人（2026-09-20 第八对话新增）
 *
 * 为什么需要这一节：微信侧的会话 id 是桥**派生出来的数字**（实测某群友 = 1000000001），
 * 而白名单装的就是这个数字；用户在微信里看到的是**昵称** ⇒
 * 不放这个清单出来，想放行某人只能猜数字，而且配错了**没有任何报错**
 * （消息就是静静地不回 —— 本项目最忌讳的那种静默失效）。
 *
 * 数据来源：/api/wechat-contacts（从**收到的微信消息**里学来的）。
 * ⚠️ 第一次放行有"先有鸡还是先有蛋"：没放行 ⇒ 消息进不来 ⇒ 学不到 ⇒ 看不到。
 *    界面必须把这句话说出来，否则用户会以为功能坏了。
 */
function renderWechatContactsSection(c) {
  const list = state.wechatContacts;
  // 🔴 「有人发过消息、但没放行」的提示（2026-09-20 补，并**改成由联系人表派生**）。
  //    为什么必须有：实测里用户在没放行时连发消息，界面上**一点反馈都没有**
  //    ⇒ 只会以为"接微信坏了"，而它其实正常工作、只是没放行。
  //    为什么**派生**而不是另存一份：第一版我在后端内存里记了"最近收到的未放行消息"，
  //    结果 03:07 真收到一条、03:08 一重启就抹掉了 ⇒ 用户什么都看不到。
  //    而联系人表（`wechat-contacts.json`）本来就落盘着 count / lastSeen / allowed ——
  //    **提示要的东西它全有**；再从别处记一份，两份状态必然漂移。
  //    ⚠️ 判据：`count > 0 && !allowed` = 有人敲过门、而且现在还没放行。
  const pending = (Array.isArray(list) ? list : []).filter((x) => (x.count || 0) > 0 && !x.allowed);
  const ago = (ts) => {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return '';
    const m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    return `${Math.floor(m / 60)} 小时前`;
  };
  const blockedHint = pending.length
    ? `<div class="hint" style="margin-bottom:10px;padding-left:8px;border-left:3px solid #e0a030">
         ⚠️ <b>收到过微信消息，但下面这些还没放行 ⇒ 机器人不会回它们。</b><br>
         ${pending.map((x) => `${esc(x.name || x.id)}（${x.count} 条${x.lastSeen ? '，最后一条 ' + ago(x.lastSeen) : ''}）`).join('、')}
         —— 在下面<b>勾选</b>即可开始回话。
       </div>`
    : '';
  const rows = (() => {
    if (list === null || list === undefined) {
      return '<div class="hint">正在读取…（如果一直这样，说明 /api/wechat-contacts 没通）</div>';
    }
    if (!list.length) {
      return `<div class="hint">还没有学到任何微信联系人。<br>
        <b>这是正常的"第一次"状态</b>：这些条目是从<b>收到的微信消息</b>里学来的，
        而白名单没放行时消息不会进来 ⇒ 第一次放行需要：<b>让别人给这个小号发一条消息</b>
        （那条消息会被挡下，但联系人会被记下来），然后回到这里勾选放行。</div>`;
    }
    return list.map((x) => `
      <div class="checkbox-row" style="align-items:center">
        <input type="checkbox" class="wx-contact-cb" data-id="${esc(x.id)}" data-kind="${esc(x.kind)}" ${x.allowed ? 'checked' : ''} />
        <label style="flex:1">
          <b>${esc(x.name || '(没拿到昵称)')}（${esc(x.id)}）（微信）</b>
          <span class="muted">· ${x.kind === 'group' ? '群' : '私聊'}${x.count ? ` · 收到过 ${x.count} 条` : ''}</span>
        </label>
      </div>`).join('');
  })();
  return `
    <h3 id="settings-wechat">微信联系人</h3>
    <div class="hint" style="margin-bottom:10px">
      勾选 = 放进白名单（与「聊天白名单」是<b>同一份</b>配置：私聊进 <code>allow.private</code>、群进 <code>allow.groups</code>）。
      <br>这里显示的是<b>从收到的微信消息里学到</b>的 id 与昵称 —— 微信侧的会话 id 是桥派生的<b>数字</b>，
      光看微信是看不到的，所以请在这里点选，别去手填。
    </div>
    ${blockedHint}
    <div class="field"><label>已知的微信联系人 / 群（勾选即放行）</label>
      <div id="wx-contact-list" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        ${rows}
      </div></div>
    <div class="hint">排障：微信通道通没通，看顶栏那个状态点（切到「微信」模式）。</div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号  —— 微信来源的末尾再加「（微信）」
 *
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 * ⚠️ **QQ 侧的显示必须逐字不变**（"不许为了微信把 QQ 改坏"是硬要求）⇒ 只有微信加后缀。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return (name ? `${name}（${m[1]}）` : `群 ${m[1]}`) + platformSuffix(chatKey);
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return (name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`) + platformSuffix(chatKey);
  return String(chatKey || '');
}

/**
 * 平台后缀：**只有微信**才加「（微信）」，QQ 不加。
 * 为什么要单独一个函数：这段判断有三处要用（会话标题 / "已发送到"徽标 / 联系人列表），
 * 各写一份必然漂移；而"QQ 不加"这条是硬要求，集中在一处才好守住。
 * 数据来自 refreshSourceMap 那张 chatKey→source 表（`/api/sessions` 不带 source，只能查表）。
 */
function platformSuffix(chatKey) {
  return sessionPlatform({ chatKey }) === 'wechat' ? '（微信）' : '';
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/app.js 是普通 script（非 ES module），无法 import，只能镜像一份。
 */
const TIER_SLIDER_BANDS = { tier1End: 10, tier2End: 20, tier3End: 90 };

function sliderToTierUI(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const b = TIER_SLIDER_BANDS;
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  const pct = Math.min(100, Math.max(0, Number(st?.randomPercent) || 0));
  if (t === 1) return b.tier1End / 2;
  if (t === 2) return (b.tier1End + b.tier2End) / 2;
  if (t === 3) return b.tier2End + (pct / 100) * (b.tier3End - b.tier2End);
  return (b.tier3End + 100) / 2;
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
    const st = c.store || {};
  // 滑条位置是唯一真相；档位与概率都由它派生（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { tier: curTier, randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 模板里要按各段占比画刻度条，这里简写成 B 供下方 ${B.xxx} 使用。
  // ⚠️ 这个别名不能删 —— 曾经漏掉它，导致模板里 B 未定义，
  //    整个 renderChatSection 抛 ReferenceError，聊天设置页直接打不开。
  const B = TIER_SLIDER_BANDS;
return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）—— 等连发消息聚成一批再开运行</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）—— 上轮结束到下轮处理的间隔</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <!-- 实时状态：把六道闸摊开，回答"现在会不会开口、为什么"。数据来自 GET /api/proactive（只读） -->
    <div id="proactive-status" class="hint" style="margin:-2px 0 10px">（正在读当前状态…）</div>
    <!-- ⚠️ 界面用**分钟**，存储仍是**毫秒**（proactive.checkIntervalMinMs/MaxMs）。
           为什么不改存储单位：那几个键的名字里就带 Ms、值也一直是毫秒；改成分钟会让键名与值不符，
           而且已有配置文件里存的是毫秒，会被按"分钟"读成天文数字（1800000 分钟 ≈ 3.4 年）—— 静默出错。
           ⚠️ 注意：本段注释在**模板字符串里面**，所以**不能出现反引号**（会提前结束字符串）。
           ⇒ 只在渲染与保存两处 ×/÷ 60000，见 msToMin / minToMs。 -->
    <div class="field-row">
      <div class="field"><label>检查间隔下限（分钟）</label><input type="number" id="cfg-pro-min" min="1" step="1" value="${esc(msToMin(c.proactive.checkIntervalMinMs, 30))}" /></div>
      <div class="field"><label>检查间隔上限（分钟）</label><input type="number" id="cfg-pro-max" min="1" step="1" value="${esc(msToMin(c.proactive.checkIntervalMaxMs, 90))}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>
    <div class="field-row">
      <!-- 群里安静多久才算"冷场"（原来这个键界面上没有 ⇒ 看不见也调不了） -->
      <div class="field"><label>群里安静多久才算冷场（分钟）</label><input type="number" id="cfg-pro-idle" min="5" step="5" value="${esc(msToMin(c.proactive.idleThresholdMs, 30))}" /></div>
      <!-- 安静时段：默认 23 → 8（跨零点）；这两键原来界面上也没有 -->
      <div class="field"><label>安静时段（点，含起点）</label><input type="number" id="cfg-pro-quiet-start" min="0" max="23" step="1" value="${esc(Number(c.proactive.quietHoursStart ?? 23))}" /></div>
      <div class="field"><label>到（点，不含终点）</label><input type="number" id="cfg-pro-quiet-end" min="0" max="24" step="1" value="${esc(Number(c.proactive.quietHoursEnd ?? 8))}" /></div>
      <!-- 连发上限：没人理最多连开几次。⚠️ 超过它之后的"退避"见下面只读那一行 -->
      <div class="field"><label>没人理最多连开（次）</label><input type="number" id="cfg-pro-maxconsec" min="1" max="10" step="1" value="${esc(Number(c.proactive.maxConsecutive ?? 2))}" /></div>
    </div>
    <div class="hint" style="margin:-4px 0 10px">
      间隔是"隔多久检查一次冷场"，不是"多久必说一次" —— 每次检查还要过安静时段、并发、掷骰子、冷场阈值、连发上限/退避。
      超过连发上限后不再无限开口，只在等够退避时间后允许"再戳一次"：
      <span id="proactive-reengage">…</span>
    </div>

    <h3>表情包</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-sticker" ${c.sticker.enabled ? 'checked' : ''} />
      <label for="cfg-sticker">启用表情包（收藏表情同步 + 发送工具）</label></div>

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label], i) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <h3>响应档位</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置全部响应档位（关掉就能给白名单里的每个群聊 / 私聊单独拖档位）</label></div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应档位滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curTier === 1 ? ' on' : ''}" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
        <span class="tier-seg seg2${curTier === 2 ? ' on' : ''}" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
        <span class="tier-seg seg3${curTier === 3 ? ' on' : ''}" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
        <span class="tier-seg seg4${curTier === 4 ? ' on' : ''}" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分会话模式：下拉选会话（群聊 + 私聊），各拖各的。
         滑条实时值是 DOM，切换会话时先收进隐藏 JSON 再换 -->
    <div id="tier-perchat-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的会话（白名单里的群聊 + 私聊）</label>
        <select id="tier-chat-select"></select>
      </div>
      <input type="hidden" id="tier-chat-json" value="${esc(JSON.stringify(st.chatSliderPos || {}))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该会话响应档位滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small btn-danger" id="tier-chat-clear-btn">清除该会话的单独设置</button>
        <span class="hint" style="margin:0">没单独设置过的会话跟随上方统一档位的滑条位置。</span>
      </div>
    </div>

    <div class="tier-params">
      <div class="tier-param${curTier === 1 ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @机器人时才响应。<b>任何档位下被艾特都会响应</b>。</div>
      </div>
      <div class="tier-param${curTier === 2 ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <div class="hint">关键词（每行一个，不区分大小写）：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
      </div>
      <div class="tier-param${curTier === 3 ? '' : ' dim'}">
        <label>③ 随机命中时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
      </div>
      <div class="tier-param${curTier >= 4 ? '' : ' dim'}">
        <label>④ 其余情况也响应：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint"><b>任何消息都响应</b>。</div>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${['light', 'dark', 'system', '?'].map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（毫秒）</label><input type="number" id="cfg-refreshms" min="1000" step="1000" value="${esc(c.ui?.refreshMs ?? 15000)}" /></div>
    <h3>版本更新</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b><span id="update-status-text">${updateAvailable ? '<b style="color:var(--warn)">；发现新版本</b>' : '；检查线上是否有新版本'}</span></label>
      <div style="display:flex;gap:10px;align-items:center">
        <button class="btn btn-small" id="check-update-btn">检查更新</button>
        <span class="hint" id="update-hint" style="margin:0"></span>
      </div></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma.accessToken || '')}" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma.httpAccessToken || '')}" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

function bindSettingsEvents(c) {
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      refreshStatus();
      startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // 系统提示自定义：把当前生效的提示词填进"整份覆盖"框 / 清空覆盖
  const syncFullCount = () => {
    const box = $('#cfg-sysprompt');
    const cnt = $('#sysprompt-count');
    if (box && cnt) cnt.textContent = `${box.value.length} 字符`;
  };
  $('#cfg-sysprompt')?.addEventListener('input', syncFullCount);
  $('#sysprompt-load')?.addEventListener('click', () => {
    const box = $('#cfg-sysprompt');
    if (!box) return;
    box.value = state.systemPrompt?.effective || '';
    syncFullCount();
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已载入当前生效的系统提示 —— 改完记得点下面「保存人设修改」';
  });
  $('#sysprompt-clear')?.addEventListener('click', () => {
    const box = $('#cfg-sysprompt');
    if (box) box.value = '';
    syncFullCount();
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已清空整份覆盖 —— 记得点下面「保存人设修改」';
  });

  // 逐段替换：实时字数 + 「已覆盖」标记 + 一键恢复默认。
  // 判定逻辑与保存时一致：非空且与内置默认不同才算覆盖。
  const syncSegUi = (ta) => {
    const seg = ta.closest('.sp-seg');
    if (!seg) return;
    const flag = seg.querySelector('.sp-seg-flag');
    const count = seg.querySelector('.sp-seg-count');
    const isOverridden = ta.value.trim() !== '' && ta.value.trim() !== String(ta.dataset.default ?? '').trim();
    if (flag) flag.classList.toggle('hidden', !isOverridden);
    if (count) count.textContent = `${ta.value.length} 字符`;
  };
  $$('.sysprompt-seg').forEach((ta) => ta.addEventListener('input', () => syncSegUi(ta)));
  $$('.sp-seg-reset').forEach((btn) => btn.addEventListener('click', () => {
    const ta = btn.closest('.sp-seg')?.querySelector('.sysprompt-seg');
    if (!ta) return;
    ta.value = String(ta.dataset.default ?? '');
    syncSegUi(ta);
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已恢复该段为内置默认 —— 保存后生效';
  }));

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率 + 参数高亮）──
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  // ── 参数区高亮：只点亮"当前真正会用到的那一档" ──
  //
  // ⚠️ 这里最容易错的一点：**两种模式的高亮来源不是同一个**。
  //    统一模式 → 上面那根全局滑条；分会话模式 → 下拉里选中的那个会话的滑条。
  //    原来两处各算各的：渲染时用**全局**位置定初始 dim，而全局滑条有监听会实时改、
  //    分会话滑条却只更新自己的提示行 —— 于是把「统一设置」关掉之后，
  //    全局滑条被 display:none 藏起来、四行高亮却还跟着它走，
  //    看起来就变成"莫名其妙只有③亮着"（而当前会话其实是 2 档）。
  //    现在两条路径都调这一个函数，谁显示就听谁的。
  const highlightTierParams = (tier) => {
    document.querySelectorAll('.tier-param').forEach((el, idx) => {
      el.classList.toggle('dim', idx + 1 !== tier);
    });
  };
  // 分会话那条路径的"重新同步"入口（下面 if (chatSel) 里挂上）。
  // 切换统一/分会话开关时要用它把高亮拨到刚显示出来的那根滑条上。
  let resyncPerChatTier = null;

  const tierSlider = $('#ctx-tier-slider');
  if (tierSlider) {
    const sync = () => {
      const pos = Number(tierSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      // 提示行：显示当前档位与概率
      const note = $('#ctx-tier-note');
      if (note) note.innerHTML = sliderDesc(pos);
      // 参数区高亮：1档→只亮①；2档→亮②；3档→亮③；4档→亮④（且①②③失效）
      highlightTierParams(t);
      // 刻度段高亮：滑到哪一档，那一档的标签 + 上边线一起变色。
      // ⚠️ 之前这段完全没做，颜色全靠 CSS 写死（.s1 永远亮、.s4 永远橙），
      //    所以拖动滑条时刻度毫无反应 —— 看起来就像"没生效"。
      const segs = document.querySelectorAll('#tier-scale .tier-seg');
      segs.forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.seg) === t);
      });
      // 滑条填充色（用 CSS 变量告诉样式当前百分比）
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 统一/分会话开关：切换两块 UI 的显隐 ──
  const unifiedChk = $('#cfg-unifiedtier');
  if (unifiedChk) unifiedChk.addEventListener('change', () => {
    const on = unifiedChk.checked;
    const uw = $('#tier-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#tier-perchat-wrap'); if (pw) pw.style.display = on ? 'none' : '';
    // 换了一根滑条，参数区高亮必须跟着换 —— 否则又回到"高亮跟当前滑条不是同一根"
    if (on) {
      const g = $('#ctx-tier-slider');
      highlightTierParams(sliderToTierUI(Number(g?.value ?? 100)).tier);
    } else if (resyncPerChatTier) {
      resyncPerChatTier();
    }
  });

  // ── 分会话档位：下拉选会话（群聊 + 私聊）+ 一条滑条 ──
  // ⚠️ 唯一真相是隐藏 input 里的 JSON（tier-chat-json），滑条每次 input 都即时写回 ——
  //    不用全局变量（这个文件里"全局变量被重渲染覆盖"的坑已经踩过两次了）。
  //    键是完整 chatKey（group:123 / private:456），与后端 storeConfigForChat 一致。
  const chatSel = $('#tier-chat-select');
  if (chatSel) {
    const jsonEl = $('#tier-chat-json');
    const gSlider = $('#ctx-tier-slider-g');
    const gNote = $('#ctx-tier-note-g');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };

    const map0 = readMap();
    const allowGroups = (c.allow?.groups || []).map(String).map((id) => ({ key: `group:${id}`, kind: 'group', id }));
    const allowPrivates = (c.allow?.private || []).map(String).map((id) => ({ key: `private:${id}`, kind: 'private', id }));
    const knownKeys = new Set([...allowGroups, ...allowPrivates].map((e) => e.key));
    // 已单独设置过、但已经不在白名单里的会话：留在列表里让用户能清理掉
    const extras = Object.keys(map0).filter((k) => !knownKeys.has(k)).map((k) => {
      const [kind, id] = String(k).split(':');
      return { key: k, kind, id: id || '' };
    });
    const optHtml = (e, extra) =>
      `<option value="${esc(e.key)}" data-kind="${esc(e.kind)}" data-id="${esc(e.id)}" data-extra="${extra ? '1' : '0'}">${esc(e.id)}${extra ? ' · 已不在白名单' : ''}</option>`;
    const optGroup = (label, list, extra) =>
      list.length ? `<optgroup label="${label}">${list.map((e) => optHtml(e, extra)).join('')}</optgroup>` : '';
    chatSel.innerHTML = [
      optGroup('群聊', allowGroups, false),
      optGroup('私聊', allowPrivates, false),
      optGroup('已不在白名单（可在这里清理）', extras, true)
    ].join('') || '<option value="">（白名单为空，先去「白名单」页签加群或好友）</option>';

    // 异步补名字：群名 / 好友备注名（协议端不在线就保持纯号码，不影响使用）
    Promise.all([
      api('/api/onebot/groups').catch(() => ({ groups: [] })),
      api('/api/onebot/friends').catch(() => ({ friends: [] }))
    ]).then(([gd, fd]) => {
      const names = new Map();
      for (const g of (gd.groups || [])) names.set(`group:${String(g.id)}`, g.name);
      for (const f of (fd.friends || [])) names.set(`private:${String(f.id)}`, f.name);
      chatSel.querySelectorAll('option').forEach((o) => {
        if (!o.value) return;
        const n = names.get(o.value);
        if (n) o.textContent = `${n}（${o.dataset.id}）${o.dataset.extra === '1' ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => {});

    const syncG = () => {
      const pos = Number(gSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      if (gNote) gNote.innerHTML = sliderDesc(pos);
      document.querySelectorAll('#tier-scale-g .tier-seg')
        .forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === t));
      gSlider.style.setProperty('--pos', pos + '%');
      // ⚠️ 参数区高亮也必须跟着这根滑条走 —— 这一句原来漏了，
      //    结果分会话模式下四行高亮还停在"渲染时算出来的全局档位"上。
      //    只在分会话这块真的显示时才改，免得在统一模式下把它覆盖掉。
      const pw = $('#tier-perchat-wrap');
      if (!pw || pw.style.display !== 'none') highlightTierParams(t);
    };
    const loadChat = () => {
      const key = chatSel.value;
      const m = readMap();
      // 没单独设置过的会话：从全局滑条当前值起步，所见即所得
      gSlider.value = key && m[key] !== undefined ? m[key] : (Number($('#ctx-tier-slider')?.value) || 100);
      syncG();
    };
    chatSel.addEventListener('change', loadChat);
    resyncPerChatTier = loadChat;   // 供「统一/分会话」开关切换时重新点亮
    gSlider.addEventListener('input', () => {
      syncG();
      const key = chatSel.value;
      if (!key) return;
      const m = readMap(); m[key] = Number(gSlider.value); writeMap(m);
    });
    $('#tier-chat-clear-btn')?.addEventListener('click', () => {
      const key = chatSel.value;
      if (!key) return;
      const m = readMap(); delete m[key]; writeMap(m); loadChat();
    });
    loadChat();
  }

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 本子查询：检测连通 / 试查一次 ──
  const djHint = $('#doujin-check-hint');
  const djSay = (t, color) => { if (djHint) { djHint.textContent = t; djHint.style.color = color || ''; } };

  // 进设置页就顺手看一眼"工具目录 / 脚本 / 解释器 / NH 库"在不在。
  // ⚠️ 不带 ping：那条会拉起 Python 子进程，进个设置页不该有这种副作用。
  // 为什么要**主动**查：本子查询最容易的坏法是静默失效（开关开着、接口 200、就是查不到东西），
  // 与其等模型查空了再回来猜，不如在这里直接说清"缺什么、本该在哪"。
  (async () => {
    if (!djHint) return;
    try {
      const r = await api('/api/doujin/status');
      const p = r.paths || {};
      if (p.hint) djSay(`⚠️ ${p.hint}`, 'var(--orange)');
      else if (p.toolDir) djSay(`工具目录：${p.toolDir}　${p.toolDirFromConfig ? '（设置里指定的）' : '（自动找到的）'}`, 'var(--muted)');
    } catch { /* 后端没起来就不显示 —— 设置页不该因为这一条显示不出来而报错 */ }
  })();

  $('#doujin-check-btn')?.addEventListener('click', async () => {
    const btn = $('#doujin-check-btn');
    btn.disabled = true; djSay('检测中…首次要 3 秒左右（拉子进程 + 探域名）');
    try {
      const r = await api('/api/doujin/status?ping=1');
      const p = r.paths || {};
      const okAll = p.serverExists && r.ping?.ok;
      const detail = `脚本 ${p.serverExists ? '✓' : '✗'} · NH库 ${p.nhDbExists ? '✓' : '✗'} · ping ${r.ping?.ok ? '✓' : '✗ ' + (r.ping?.error || '')}`
        + ` — 解释器：${p.pythonPath}`;
      // 有 hint 就优先显示它 —— 那是一句人话（"工具目录不存在：… 找过这些位置都没有：…"），
      // 比一串 ✓/✗ 更能直接告诉人该去干什么
      djSay(p.hint ? `⚠️ ${p.hint}　〔${detail}〕` : detail, okAll ? 'var(--green)' : 'var(--orange)');
    } catch (e) { djSay(`检测失败：${e.message}`, 'var(--orange)'); }
    btn.disabled = false;
  });
  $('#doujin-search-btn')?.addEventListener('click', async () => {
    const btn = $('#doujin-search-btn');
    btn.disabled = true; djSay('查「校园」中…');
    try {
      const r = await api('/api/doujin/test', { method: 'POST', body: JSON.stringify({ keyword: '校园' }) });
      const res = r.result || {};
      if (!res.ok) djSay(`查询失败：${res.error}`, 'var(--orange)');
      else {
        const items = res.items || [];
        const one = items[0];
        djSay(`查到 ${res.total} 条（取前 ${items.length}）：${one ? `码 ${one.code}、标题 ${String(one.title).length} 字` : '（空）'}`
          + `  用时 ${res.ms}ms`, 'var(--green)');
      }
    } catch (e) { djSay(`查询失败：${e.message}`, 'var(--orange)'); }
    btn.disabled = false;
  });

  // ── 本子查询：离线库（nh.db）状态 + 导入 ──
  const djDbLine = $('#doujin-db-line');
  const djDbSay = (t, color) => { if (djDbLine) { djDbLine.textContent = t; djDbLine.style.color = color || ''; } };
  const djiHint = $('#doujin-import-hint');
  const djiSay = (t, color) => { if (djiHint) { djiHint.textContent = t; djiHint.style.color = color || ''; } };
  const djNote = $('#doujin-db-note');
  const djNoteSay = (t, color) => { if (djNote) { djNote.textContent = t; djNote.style.color = color || ''; } };

  /** MB 显示：小文件别显示成 0.00 MB。 */
  const fmtMB = (n) => {
    const b = Number(n) || 0;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  };
  /** 行数：几十万也带千分位，一眼能看出量级。 */
  const fmtNum = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n ?? '');
  };

  // 刷新「离线库：<路径> — <状态>」那一行（数据来自 /api/doujin/db-info，只读、不拉子进程）
  const refreshDoujinDbInfo = async () => {
    if (!djDbLine) return;
    try {
      const r = await api('/api/doujin/db-info');
      const d = r.db || {};
      if (!d.exists) {
        djDbSay(`离线库：${d.path || '(未配置路径)'} — 未导入（用下面的按钮导入 .db 或 .csv）`, 'var(--orange)');
        return;
      }
      // rows 只有小库才给（大库数一遍太贵，后端会省略）—— 有就带上，没有就不编
      const extra = [
        d.rows !== undefined ? `${fmtNum(d.rows)} 行` : '',
        d.hasIndex === true ? '带标题索引' : (d.hasIndex === false ? '⚠️ 缺 idx_nh_title 索引' : ''),
        d.valid === false ? '⚠️ 不是 SQLite 文件' : ''
      ].filter(Boolean).join(' · ');
      djDbSay(`离线库：${d.path} — 已导入 ${fmtMB(d.bytes)}${extra ? `（${extra}）` : ''}`,
        d.valid === false ? 'var(--orange)' : 'var(--muted)');
    } catch (e) {
      djDbSay(`离线库信息读取失败：${e.message}`, 'var(--orange)');
    }
  };
  void refreshDoujinDbInfo();

  /**
   * 取 File 对象的真实路径。
   * Electron < 32 上 `File.path` 直接可用；较新版本改成 `webUtils.getPathForFile()`
   * （只能在有 preload 的渲染进程里拿到）。这个应用**没有 preload**、渲染进程也没有 Node，
   * 所以两条都试一遍，拿不到就返回空串 —— 由调用方走"手填路径"那条路，绝不猜。
   */
  const pathOfFile = (f) => {
    if (!f) return '';
    try {
      if (typeof f.path === 'string' && f.path) return f.path;
    } catch { /* 某些版本上访问它会抛 */ }
    try {
      const wu = globalThis.webUtils || globalThis.require?.('electron')?.webUtils;
      if (wu?.getPathForFile) return String(wu.getPathForFile(f) || '');
    } catch { /* 拿不到就走手填 */ }
    return '';
  };

  const djImportFile = $('#doujin-import-file');
  const djImportBtn = $('#doujin-import-btn');
  const djImportManual = $('#doujin-import-manual');

  /** 真正发请求那一步：两条路（选文件 / 手填路径）最后都汇到这里。 */
  const runDoujinImport = async (p) => {
    const btn = djImportBtn;
    const isCsv = /\.csv$/i.test(p);
    if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
    djNoteSay('');
    djiSay(isCsv
      ? `正在转库（本地跑，52 万行实测约 2~3 秒）…期间 JM 查询会排队等它`
      : `正在安装数据库…`, 'var(--muted)');
    try {
      const r = await api('/api/doujin/import-db', { method: 'POST', body: JSON.stringify({ path: p }) });
      // 后端 ok:false 也走不到这里（api() 会把非 2xx 抛出来），但 .csv 转库失败是 200 + error，
      // 所以两种都要判 —— 而且 **error 原文照显示**，那是给用户看的一句话，不能吃掉换成泛化文案
      if (!r.ok) {
        djiSay(`导入失败：${r.error || '未知原因'}`, 'var(--orange)');
        return;
      }
      const size = r.bytes != null ? `，${fmtMB(r.bytes)}` : '';
      if (r.kind === 'csv') {
        djiSay(`导入成功：${fmtNum(r.rows)} 行${size}（用了 ${r.ms != null ? Math.round(r.ms / 1000) + ' 秒' : '—'}）`, 'var(--green)');
      } else {
        djiSay(`导入成功：已换上 ${fmtMB(r.bytes)} 的库`
          + (r.backup ? `，旧库备份在 ${r.backup}` : '（原本没有旧库，未产生备份）'), 'var(--green)');
      }
      // 后端如实说明了"只校验文件头、表结构要靠下一次真实查询暴露" —— 单独一行显示，不跟成功文案揉一起
      if (r.note) djNoteSay(r.note, 'var(--muted)');
    } catch (e) {
      // 502/500 也带着后端那句人话（api() 已经把它塞进 e.message 了）
      djiSay(`导入失败：${e.message}`, 'var(--orange)');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '导入离线库（.db / .csv）'; }
      // 导入完刷新那一行（成败都刷：失败的 .csv 也可能已经留下半成品别的东西）
      void refreshDoujinDbInfo();
    }
  };

  djImportBtn?.addEventListener('click', () => {
    if (!djImportFile) {
      // 连 file input 都没有（老页面/被裁过）→ 直接给手填那条路
      if (djImportManual) djImportManual.style.display = '';
      djiSay('把文件路径填到下面的输入框里再点「用这个路径导入」', 'var(--orange)');
      return;
    }
    djImportFile.value = '';   // 清空：选同一个文件第二次也要能触发 change
    djImportFile.click();
  });

  djImportFile?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const p = pathOfFile(f);
    if (p) {
      if (djImportManual) djImportManual.style.display = 'none';
      djiSay(`已选中：${f.name}`, 'var(--muted)');
      void runDoujinImport(p);
      return;
    }
    // 拿不到真实路径：明确告诉用户该怎么办，并把输入框亮出来
    if (djImportManual) djImportManual.style.display = '';
    djiSay('这个 Electron 版本拿不到文件真实路径 —— 请把完整路径填到下面的输入框，再点「用这个路径导入」', 'var(--orange)');
    const box = $('#doujin-import-path');
    if (box) { box.focus(); if (!box.value) box.placeholder = `例如：D:\\data\\${f.name}`; }
  });

  $('#doujin-import-go')?.addEventListener('click', () => {
    const p = String($('#doujin-import-path')?.value || '').trim().replace(/^"(.*)"$/, '$1');
    if (!p) { djiSay('先填一个路径再点它', 'var(--orange)'); return; }
    void runDoujinImport(p);
  });

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    // URL 改了还没保存就先拉会拉到旧地址 —— 先顺手保存配置再拉
    try { await saveConfig({ quiet: true }); } catch { /* 保存失败也继续尝试拉取 */ }
    if (statusEl) statusEl.textContent = '正在拉取…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 显示真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  //
  // ⚠️ 2026-09-17 修 bug：原来「显示」分支无条件写 `input.value = real`。
  //    对于**还没保存过**的 Key（典型：新 provider 的 API Key 框），后端返回空串，
  //    于是用户刚敲进去的内容被清成空 —— 就是他截图里那个现象。
  //    现在只在这两种情况下才用后端的值覆盖：
  //      ① 框里是掩码 "******"（我们放的占位符，需要换成真值）；
  //      ② 框里是空的（没有用户输入可保护，能填就填）。
  //    其余一律保留用户正在输入的内容。
  const MASK = '******';
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：只有在"没有用户输入可保护"时才用后端明文覆盖
          const cur = input.value || '';
          input.type = 'text';
          if (real && (cur === '' || cur === MASK)) input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === MASK)) {
            input.value = MASK;
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // 健康卡片上的「测试一下」：此前 renderHealthCard 渲染后从未绑定事件
  // （绑的是 test-provider-btn，id 不匹配），按钮点了完全没反应。
  const testApiBtn = $('#test-api-btn');
  if (testApiBtn) testApiBtn.addEventListener('click', () => runConnectivityTest(testApiBtn, $('#test-api-result'), '测试一下'));

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th>模型 ID</th><th>目录显示名</th><th class="mr-ops"></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td class="mr-ops"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''} title="${modelRows.length <= 1 ? '至少保留一行' : '删掉这一行'}">删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  // ⚠️ `currentPersonaId()` / `syncPersonaButtons()` **已提到模块作用域**（本文件上方、
  //    `openPersonaPicker` 前面）—— 原来它们定义在这里，导致弹窗那边跨作用域调用时报
  //    `ReferenceError: syncPersonaButtons is not defined`。改回去会重新引入那个 bug。
  const personaPick = $('#cfg-persona-pick');
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 检查更新（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  const checkUpdateBtn = $('#check-update-btn');
  if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-hint');
    checkUpdateBtn.disabled = true;
    if (hint) hint.textContent = '检查中…';
    const data = await runUpdateCheck({ manual: true });   // 手动：即使关过浮窗也再弹一次
    if (!data) {
      if (hint) hint.textContent = '检查失败：网络不可达';
    } else if (!data.ok) {
      if (hint) hint.textContent = `检查失败：${data.error || '未知错误'}`;
    } else if (data.hasUpdate) {
      // 有新版：给下载链接。Electron 里 target=_blank 会被 main.js 转给系统浏览器。
      if (hint) hint.innerHTML = `发现新版本 <b>v${esc(data.latest)}</b>（当前 v${esc(data.current)}） <a href="${esc(data.url)}" target="_blank" rel="noopener">去下载</a>`;
    } else if (hint) hint.textContent = `已是最新（v${data.current}）`;
    checkUpdateBtn.disabled = false;
  });

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}

// ── 模型选择/添加/删除 模态框 ──
function closeModelModal(overlay) {
  if (overlay) overlay.remove();
}

/**
 * 弹窗外壳。
 * 主体方向判定：body **以 `<div class="model-modal-left"` 开头**才加 .row（横向），
 * 其余一律纵向堆叠。
 * ⚠️ 曾经只要 body 里"包含" model-modal-left 就加 row —— 但复合结构的弹窗
 *    （顶部工具栏 + 中部双栏 + 底部提示，如批量价格编辑、模型添加）需要的是
 *    外层纵向、双栏在 .ma-body 内部横向。误判成 row 后，工具栏与提示文
 *    两个 flex 项把宽度吃光，.ma-body（flex:1, basis 0）被挤成 0 宽，
 *    整个内容区隐形（2026-09-05 批量价格弹窗"空白"事故）。
 */
function modelModalShell({ head, body, foot = '', danger = false }) {
  const overlay = document.createElement('div');
  overlay.className = 'model-modal-overlay';
  overlay.innerHTML = `
    <div class="model-modal ${danger ? 'danger' : ''}">
      <div class="model-modal-head">
        <span>${head}</span>
        <button class="model-modal-close">×</button>
      </div>
      <div class="model-modal-body${/^\s*<div class="model-modal-left"/.test(String(body)) ? ' row' : ''}">${body}</div>
      ${foot ? `<div class="model-modal-foot">${foot}</div>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModelModal(overlay);
  });
  overlay.querySelector('.model-modal-close').addEventListener('click', () => closeModelModal(overlay));
  return overlay;
}

/**
 * 「关于」弹窗。
 *
 * 为什么要有它：
 *   ① LICENSE 是 MIT —— **署名是许可要求**，不是客气话；
 *   ② 别人（包括几个月后的自己）需要一眼看清"这台机器跟上游差在哪"，
 *      否则升级时不知道该保留什么；
 *   ③ 出问题时第一反应就是找"版本 / 关于"，所以**一键导出诊断包**也放这儿。
 */
async function openAboutModal() {
  let info;
  try {
    info = await api('/api/about');
  } catch (error) {
    modelModalShell({
      head: '关于',
      body: `<div class="empty-hint">读不到版本信息：${esc(error?.message || error)}</div>`
    });
    return;
  }
  const rt = info.runtime || {};
  const paths = info.paths || {};
  const patches = Array.isArray(info.localPatches) ? info.localPatches : [];

  const row = (k, v) => `<div style="display:flex;gap:10px;padding:2px 0;align-items:baseline">
      <span class="muted" style="width:82px;flex:none">${esc(k)}</span>
      <span class="mono" style="word-break:break-all;font-size:12px">${esc(v)}</span>
    </div>`;
  const section = (title, inner) =>
    `<div style="margin:0 0 14px">
      <div class="muted" style="font-size:11.5px;letter-spacing:.08em;margin:0 0 4px">${esc(title)}</div>
      ${inner}
    </div>`;

  const body = `
    <div style="margin:0 0 14px">
      <div style="font-size:17px;font-weight:600">${esc(info.name)} <span class="mono">${esc(info.version)}</span></div>
      <div class="hint" style="margin-top:3px">
        基于 <a href="${esc(info.homepage || info.repository)}" target="_blank" rel="noreferrer">Kondius/qq-agent</a>
        · ${esc(info.license)} 许可 · 作者 ${esc(info.author)}
      </div>
    </div>
    ${section('运行环境',
      row('系统', `${rt.os || '-'}（${rt.platform || '-'} ${rt.arch || '-'}）`) +
      row('CPU / 内存', `${rt.cpus ?? '-'} 核 / ${rt.memoryGB ?? '-'} GB`) +
      row('Electron', rt.electron || '（headless 模式，无 Electron）') +
      row('Chrome / Node', `${rt.chrome || '-'} / ${rt.node || '-'}`) +
      row('已运行', `${Math.floor((info.uptimeSeconds || 0) / 60)} 分钟`)
    )}
    ${section('路径', row('程序目录', paths.app || '-') + row('数据目录', paths.data || '-'))}
    ${section('本机自加改动（不是上游自带的）',
      `<div class="hint" style="margin-bottom:5px">升级时对着这份清单核对"哪些要重新合并"。</div>
       <ol style="margin:0;padding-left:20px;font-size:12px;line-height:1.65">${patches.map((p) => `<li>${esc(p)}</li>`).join('')}</ol>`
    )}
    <div class="hint">数据目录里是记忆、存档和配置本身 —— 升级或搬家前记得整个复制走。</div>`;

  const foot = `
    <button class="btn btn-small" id="about-export" title="打包版本、脱敏配置、状态和日志（不含密钥、不含聊天正文）">导出诊断包</button>
    <button class="btn btn-small" id="about-copy">复制信息</button>`;

  const overlay = modelModalShell({ head: '关于', body, foot });

  // ── 导出诊断包 ──
  // 走 fetch 而不是 <a href> 直接下载：设置里配了 server.token 时，
  // 直接点链接不会带上请求头，会 401。这里和 api() 用同一个头。
  const exportBtn = overlay.querySelector('#about-export');
  exportBtn?.addEventListener('click', async () => {
    const label = exportBtn.textContent;
    exportBtn.disabled = true;
    exportBtn.textContent = '正在打包…';
    try {
      const res = await fetch('/api/diagnostics', { headers: { 'x-console-token': CONSOLE_MARKER } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const dispo = String(res.headers.get('content-disposition') || '');
      const m = /filename="([^"]+)"/.exec(dispo);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = m ? m[1] : 'qq-agent-diag.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      exportBtn.textContent = `已导出 ${Math.round(blob.size / 1024)} KB`;
    } catch (error) {
      exportBtn.textContent = '导出失败';
      alert(`导出诊断包失败：${error?.message || error}`);
    }
    setTimeout(() => { exportBtn.textContent = label; exportBtn.disabled = false; }, 4000);
  });

  // ── 复制信息（贴到群里问人时用，比截图好）──
  overlay.querySelector('#about-copy')?.addEventListener('click', async (e) => {
    const text = [
      `${info.name} ${info.version}（${info.license}，基于 Kondius/qq-agent）`,
      `系统：${rt.os}（${rt.platform} ${rt.arch}）`,
      `Electron ${rt.electron || '-'} / Node ${rt.node}`,
      `数据目录：${paths.data}`,
      `本机自加改动 ${patches.length} 条`
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      e.target.textContent = '已复制';
    } catch {
      window.prompt('复制下面这段：', text);
    }
    setTimeout(() => { e.target.textContent = '复制信息'; }, 2000);
  });
}

/**
 * 调用明细弹窗：点「调用次数」卡片打开，列出各类工具分别被调用了多少次。
 *
 * 这东西对省钱没什么实际帮助 —— 但一张纯数字的成本表太无聊了，
 * 而"机器人这周发了 133 条消息、戳了 6 次、翻了 3 次聊天记录"这类数字
 * 恰恰是最能反映它"活成什么样"的。所以做出来，纯粹因为好看又好玩。
 */
function openToolBreakdown() {
  const counts = (state.usageStats && state.usageStats.toolCounts) || {};
  const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
  const total = entries.reduce((a, [, n]) => a + n, 0);

  if (!total) {
    modelModalShell({
      head: '调用明细',
      body: '<div class="empty-hint">这个时间区间内还没有任何工具调用记录。</div>'
    });
    return;
  }

  const max = Math.max(...entries.map(([, n]) => n));

  // 按分类分组，分类内按次数降序
  const byCat = new Map();
  for (const [key, n] of entries) {
    const meta = TOOL_META[key] || { name: key, cat: '其他', icon: '🔧' };
    if (!byCat.has(meta.cat)) byCat.set(meta.cat, []);
    byCat.get(meta.cat).push({ key, n, ...meta });
  }
  const cats = TOOL_CAT_ORDER.filter((c) => byCat.has(c));
  for (const c of byCat.keys()) if (!cats.includes(c)) cats.push(c);

  const rows = cats.map((cat) => {
    const items = byCat.get(cat).sort((a, b) => b.n - a.n);
    const catTotal = items.reduce((a, x) => a + x.n, 0);
    return `
      <div class="tb-cat">
        <div class="tb-cat-head">
          <span>${esc(cat)}</span>
          <span class="tb-cat-sum">${catTotal} 次 · ${(catTotal / total * 100).toFixed(0)}%</span>
        </div>
        ${items.map((it) => `
          <div class="tb-row">
            <span class="tb-icon">${it.icon}</span>
            <span class="tb-name">${esc(it.name)}</span>
            <span class="tb-code">${esc(it.key)}</span>
            <span class="tb-bar"><i style="width:${(it.n / max * 100).toFixed(1)}%"></i></span>
            <span class="tb-n">${it.n}</span>
          </div>`).join('')}
      </div>`;
  }).join('');

  // 一句话小结（让这堆数字有个"人味"的结论）
  const say = counts.send_message ? `发了 ${counts.send_message} 条消息` : '一条都没发';
  const poke = counts.send_poke ? `、戳了 ${counts.send_poke} 次` : '';
  const sticker = counts.send_sticker ? `、贴了 ${counts.send_sticker} 张表情` : '';
  const search = (Number(counts.web_search) || 0) + (Number(counts.web_fetch) || 0);
  const searchTxt = search ? `、联网查了 ${search} 次` : '';

  modelModalShell({
    head: `调用明细（${state.usageStats?.rangeLabel || ''} · 共 ${total} 次）`,
    body: `
      <div class="tool-breakdown">
        <div class="tb-lead">这段时间里，机器人${say}${poke}${sticker}${searchTxt}。</div>
        ${rows}
      </div>`,
    foot: '<div class="muted" style="font-size:11.5px">工具调用本身不额外计费，成本来自它们消耗的 token。</div>'
  });
}

// ── 人设选择/添加 模态框 ──

// ⚠️ 这两个函数**必须挂在模块作用域**（2026-09-18 修）：
// 它们原来定义在 `bindSettingsEvents(c)` 内部，而 `openPersonaPicker()` 是顶层函数、
// 从弹窗里调 `syncPersonaButtons()` —— **跨作用域调用，运行时抛
// `ReferenceError: syncPersonaButtons is not defined`**（真的发生过：朋友那台机器
// 20:08:53 的诊断日志里就有这条，见 项目记忆.md §23.12）。
// 症状是"选完人设点确定，界面上那两个按钮的状态没跟着更新"，
// 而且因为它抛在事件回调里，**不会让页面整体崩**，所以很容易没人发现。
// 两者只依赖模块级的 `state` 与 `$`，提到顶层不需要任何额外参数。
function currentPersonaId() {
  const roleText = $('#cfg-roletext')?.value ?? '';
  const found = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === roleText);
  return found ? found[0] : '';
}

function syncPersonaButtons() {
  const id = currentPersonaId();
  const tpl = state.personaTemplates[id];
  const isCustom = id.startsWith('custom_');
  const delBtn = $('#del-persona-btn');
  if (delBtn) delBtn.classList.toggle('hidden', !isCustom);
  const hint = $('#persona-pick-hint');
  if (hint) hint.textContent = tpl ? (tpl.builtin ? '内置人设' : '自定义人设') : '';
}

/** 选择人设：弹窗列出所有人设（含自定义），点击后填入角色设定文本框。 */
function openPersonaPicker() {
  const entries = Object.entries(state.personaTemplates || {});
  if (!entries.length) {
    $('#persona-pick-hint').textContent = '人设列表为空';
    return;
  }
  const overlay = modelModalShell({
    head: '选择人设',
    body: `
      <div class="model-modal-right" id="persona-list" style="flex:1">
        ${entries.map(([id, p]) => `
          <div class="mm-model" data-id="${esc(id)}">
            <span class="mm-check">${(state.personaTemplates[id]?.text === ($('#cfg-roletext')?.value ?? '')) ? '✓' : ''}</span>
            <span>${esc(p.name)}</span>
            <span class="muted" style="font-size:11px">${p.builtin ? '内置' : '自定义'}</span>
          </div>`).join('')}
      </div>`,
    foot: `<button class="btn" id="persona-cancel">取消</button>`
  });
  overlay.querySelectorAll('.mm-model').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const tpl = state.personaTemplates[id];
      if (tpl) {
        $('#cfg-roletext').value = tpl.text;
        $('#cfg-customrules').value = tpl.customRules || '';
        const input = $('#cfg-persona-pick');
        if (input) input.value = tpl.name;
      }
      closeModelModal(overlay);
      syncPersonaButtons();
    });
  });
  overlay.querySelector('#persona-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 添加人设：弹窗填写人设名称、角色设定、管理员附加规则。 */
function openPersonaCreateModal() {
  const overlay = modelModalShell({
    head: '添加人设',
    body: `
      <div class="field" style="flex:1;min-width:0">
        <label>人设名称</label>
        <input type="text" id="new-persona-name" placeholder="例如：毒舌老哥" />
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>角色设定</label>
        <textarea id="new-persona-text" class="persona-role-text" style="min-height:220px" placeholder="人设文本"></textarea>
      </div>
      <div class="field" style="flex:1;min-width:0">
        <label>管理员附加规则（可选）</label>
        <textarea id="new-persona-rules" style="min-height:90px" placeholder="可选：追加到系统提示的规则"></textarea>
      </div>`,
    foot: `<button class="btn" id="persona-add-cancel">取消</button>
           <button class="btn btn-primary" id="persona-add-apply">确认添加</button>`
  });
  overlay.querySelector('#persona-add-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#persona-add-apply').addEventListener('click', async () => {
    const name = overlay.querySelector('#new-persona-name').value.trim();
    const text = overlay.querySelector('#new-persona-text').value.trim();
    const customRules = overlay.querySelector('#new-persona-rules').value.trim();
    if (!name) { $('#persona-pick-hint').textContent = '人设名称不能为空'; return; }
    if (!text) { $('#persona-pick-hint').textContent = '角色设定不能为空'; return; }
    try {
      await api('/api/persona-templates', {
        method: 'POST',
        body: JSON.stringify({ name, text, customRules })
      });
      closeModelModal(overlay);
      $('#cfg-roletext').value = text;
      $('#cfg-customrules').value = customRules;
      const input = $('#cfg-persona-pick');
      if (input) input.value = name;
      $('#persona-pick-hint').textContent = `人设「${name}」已添加。记得点「保存人设修改」使当前填写生效。`;
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `添加失败：${e.message}`;
    }
  });
}

/** 选择模型：左提供商 / 右模型，点击模型后保存到当前 api 配置并关闭。 */
function openModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-hint').textContent = '模型目录为空：请先在下方的“手动添加提供商”里添加。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  const current = state.config?.api?.provider;
  let activePid = current || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === state.config?.api?.model && p.id === current ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 只更新 provider/model/baseUrl；apiKey 保持当前已保存值，不把密钥回写到接口请求里
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ api: { provider: pid, model, baseUrl: p.baseURL } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#provider-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** 选择记忆整理专用模型：复用模型目录选择器，保存到 config.memory.provider/model。 */
function openMemoryModelPicker() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#mem-model-hint').textContent = '模型目录为空：请先到「模型 API」页签添加提供商。';
    return;
  }
  const overlay = modelModalShell({
    head: '选择记忆整理模型',
    body: `
      <div class="model-modal-left" id="mm-left"></div>
      <div class="model-modal-right" id="mm-right"></div>`,
    foot: `<button class="btn" id="mm-cancel">取消</button>`
  });
  const left = overlay.querySelector('#mm-left');
  const right = overlay.querySelector('#mm-right');
  // 从 DOM 的隐藏字段读当前值（而非 state.config）：
  // 用户可能刚选过但还没保存，或 state 还没刷新，DOM 才是最新真相。
  const currentProvider = $('#cfg-mem-provider')?.value || state.config?.memory?.provider || '';
  const currentModel = $('#cfg-mem-model')?.value || state.config?.memory?.model || '';
  let activePid = currentProvider || providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-pid="${esc(p.id)}" data-model="${esc(m)}">
        <span class="mm-check">${m === currentModel && p.id === currentProvider ? '✓' : ''}</span>
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.addEventListener('click', async () => {
        const pid = el.dataset.pid;
        const model = el.dataset.model;
        try {
          // 必须把"是否跟随聊天模型"的当前勾选状态一并提交。
          // 否则：用户取消勾选（→ 只改了 DOM，state.config 仍是 true）后直接点模型，
          // 这次提交不带 useChatModel，随后 loadSettings() 又按 state.config(true)
          // 重新渲染 —— 复选框被打回"已勾选"，迫使必须先保存一次才能选模型。
          const useChatBox = $('#cfg-mem-usechat');
          const useChatModel = useChatBox ? !!useChatBox.checked
            : (state.config?.memory?.useChatModel !== false);
          await api('/api/config', {
            method: 'POST',
            body: JSON.stringify({ memory: { provider: pid, model, useChatModel } })
          });
          closeModelModal(overlay);
          loadSettings();
        } catch (e) {
          $('#mem-model-hint').textContent = `选择失败：${e.message}`;
          closeModelModal(overlay);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#mm-cancel').addEventListener('click', () => closeModelModal(overlay));
}

/** “获取列表”后的勾选添加弹窗：已添加的模型显示为已选（不可重复勾选）。 */
/**
 * “获取列表”后的勾选添加弹窗。
 *
 * 两个针对中转站的优化：
 *   1. 搜索框：中转站常返回几百上千个模型，没有搜索就没法用
 *   2. 双列模式：若模型 id 普遍带 "/"（OpenRouter 风格的 vendor/model），
 *      拆成左厂商 / 右模型两列，比一长条列表好找得多；否则保持单列 + 搜索
 */
function openModelAddModal(baseUrl, apiKey, remoteModels) {
  const providers = state.providers || [];
  const existingProvider = providers.find((p) => (p.baseURL || '').replace(/\/+$/, '') === baseUrl.replace(/\/+$/, ''));
  const existingIds = new Set(existingProvider?.models || []);
  const all = (remoteModels || []).slice();

  // 有多少比例的 id 是 vendor/model 形式？超过一半就启用双列
  const slashed = all.filter((m) => String(m).includes('/'));
  const dual = all.length > 0 && slashed.length / all.length >= 0.5;

  // 预先按厂商分组（仅双列模式用）
  const groups = new Map();
  for (const m of all) {
    const s = String(m);
    const vendor = dual ? (s.includes('/') ? s.slice(0, s.indexOf('/')) : '(其他)') : '';
    if (!groups.has(vendor)) groups.set(vendor, []);
    groups.get(vendor).push(s);
  }
  const vendorList = [...groups.keys()].sort((a, b) => {
    if (a === '(其他)') return 1;
    if (b === '(其他)') return -1;
    return groups.get(b).length - groups.get(a).length;
  });

  const countText = `共 ${all.length} 个模型${dual ? ` · ${vendorList.length} 个厂商` : ''}`;

  const overlay = modelModalShell({
    head: '勾选模型加入列表',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="ma-search" placeholder="搜索模型或厂商…" autocomplete="off" />
        <span class="muted" id="ma-count" style="font-size:12px;white-space:nowrap">${esc(countText)}</span>
      </div>
      <div class="ma-body ${dual ? 'dual' : 'single'}">
        ${dual ? '<div class="model-modal-left" id="ma-left"></div>' : ''}
        <div class="model-modal-right" id="ma-right"></div>
      </div>`,
    foot: `<button class="btn" id="ma-cancel">取消</button>
           <button class="btn btn-primary" id="ma-apply">加入列表</button>`
  });

  const searchEl = overlay.querySelector('#ma-search');
  const countEl = overlay.querySelector('#ma-count');
  const right = overlay.querySelector('#ma-right');
  const left = dual ? overlay.querySelector('#ma-left') : null;

  let activeVendor = dual ? vendorList[0] : '';
  let keyword = '';

  // 渲染成 checkbox 行
  const rowHtml = (m) => {
    const added = existingIds.has(m);
    const modelPart = dual && String(m).includes('/') ? String(m).slice(String(m).indexOf('/') + 1) : String(m);
    return `
      <label class="mm-model">
        <input type="checkbox" class="ma-check" value="${esc(m)}" ${added ? 'checked disabled' : ''} />
        <span class="mm-model-text">${esc(modelPart)}</span>
        ${added ? '<span class="muted" style="font-size:11px">已添加</span>' : ''}
      </label>`;
  };

  function matches(m) {
    if (!keyword) return true;
    return String(m).toLowerCase().includes(keyword);
  }

  function renderRight() {
    const pool = dual ? (groups.get(activeVendor) || []) : all;
    const list = pool.filter(matches);
    right.innerHTML = list.length
      ? list.map(rowHtml).join('')
      : '<div class="muted" style="padding:10px">没有匹配的模型</div>';
    // 更新计数：显示当前筛选出来的数量
    countEl.textContent = keyword
      ? `${list.length} / ${dual ? pool.length : all.length}`
      : countText;
  }

  function renderLeft() {
    if (!left) return;
    const vendors = vendorList.filter((v) => (groups.get(v) || []).some(matches));
    left.innerHTML = vendors.length
      ? vendors.map((v) => `
          <div class="mm-prov ${v === activeVendor ? 'active' : ''}" data-vendor="${esc(v)}">
            ${esc(v)} <span class="muted" style="font-size:11px">${(groups.get(v) || []).filter(matches).length}</span>
          </div>`).join('')
      : '<div class="muted" style="padding:10px">没有匹配的厂商</div>';
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => {
        activeVendor = el.dataset.vendor;
        renderLeft();
        renderRight();
      });
    });
    // 当前厂商被搜索过滤掉了 → 自动切到第一个可见的
    if (vendors.length && !vendors.includes(activeVendor)) {
      activeVendor = vendors[0];
      renderLeft();
      renderRight();
    }
  }

  // 搜索：输入时同时刷两列（双列模式下左列的计数也要跟着变）
  searchEl.addEventListener('input', () => {
    keyword = String(searchEl.value || '').trim().toLowerCase();
    renderLeft();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#ma-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#ma-apply').addEventListener('click', async () => {
    const picked = [...overlay.querySelectorAll('.ma-check:checked')].map((el) => el.value);
    const newModels = picked.filter((m) => !existingIds.has(m));
    if (!newModels.length) {
      closeModelModal(overlay);
      return;
    }
    try {
      const body = existingProvider
        ? { providerId: existingProvider.id, models: newModels.map((m) => ({ id: m, name: m })) }
        : { baseUrl, apiKey, models: newModels.map((m) => ({ id: m, name: m })) };
      const endpoint = existingProvider ? '/api/providers/models' : '/api/providers';
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) });
      closeModelModal(overlay);
      $('#provider-action-hint').textContent = `已加入 ${newModels.length} 个模型。`;
      loadSettings();
    } catch (e) {
      $('#provider-action-hint').textContent = `加入失败：${e.message}`;
      closeModelModal(overlay);
    }
  });
}

/** 删除模型：左提供商 / 右模型（带删除按钮），暗红色调。 */
function openModelDeleteModal() {
  const providers = state.providers || [];
  if (!providers.length) {
    $('#provider-action-hint').textContent = '模型目录为空，没有可删除的模型。';
    return;
  }
  const overlay = modelModalShell({
    head: '删除模型',
    body: `
      <div class="model-modal-left" id="md-left"></div>
      <div class="model-modal-right" id="md-right"></div>`,
    foot: `<button class="btn" id="md-cancel">关闭</button>`,
    danger: true
  });
  const left = overlay.querySelector('#md-left');
  const right = overlay.querySelector('#md-right');
  let activePid = providers[0].id;
  function renderLeft() {
    left.innerHTML = providers.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.displayName || p.id)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }
  function renderRight() {
    const p = providers.find((x) => x.id === activePid);
    if (!p) { right.innerHTML = ''; return; }
    const names = p.modelNames || {};
    right.innerHTML = p.models.map((m) => `
      <div class="mm-model" data-model="${esc(m)}">
        <span>${esc(names[m] || m)}</span>
        <span class="muted" style="font-size:11px">${esc(m)}</span>
        <button class="mm-del">删除</button>
      </div>`).join('') || '<div class="muted" style="padding:10px">该提供商下没有模型</div>';
    right.querySelectorAll('.mm-model').forEach((el) => {
      el.querySelector('.mm-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        const model = el.dataset.model;
        if (!confirm(`确定从「${p.displayName || p.id}」删除模型 ${model}？`)) return;
        try {
          await api('/api/providers/models', {
            method: 'DELETE',
            body: JSON.stringify({ providerId: p.id, modelId: model })
          });
          renderRight();
          loadSettings();
        } catch (err) {
          alert(`删除失败：${err.message}`);
        }
      });
    });
  }
  renderLeft();
  renderRight();
  overlay.querySelector('#md-cancel').addEventListener('click', () => closeModelModal(overlay));
}

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  // ⚠️ 条目 6：名单不再是"逗号文本框"，而是芯片盒子 ⇒
  //    候选项的"已选"状态从**芯片**读、确定时把选中的**写回芯片**。
  const kindKey = isGroups ? 'groups' : 'private';
  const selected = new Set(readAllowChips(kindKey));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    // 写回芯片（先清空再重建 —— 用户可能在弹窗里取消了原来勾着的）
    setAllowChips(kindKey, picked);
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

/** 读一个芯片盒子里的名单（**唯一来源是 DOM**，因为用户可能刚点 × 删过）。 */
function readAllowChips(kind) {
  return Array.from(document.querySelectorAll(`.chipbox[data-chipbox="${kind}"] .wchip`))
    .map((el) => String(el.textContent).replace(/^[^ ]+\s*/, '').replace(/×$/, '').trim())
    .filter(Boolean);
}

/** 把名单写回芯片盒子（先清空再重建）。 */
function setAllowChips(kind, ids) {
  const box = document.querySelector(`.chipbox[data-chipbox="${kind}"]`);
  if (!box) return;
  for (const el of Array.from(box.querySelectorAll('.wchip'))) el.remove();
  const input = box.querySelector(`[data-chipinput="${kind}"]`);
  const label = kind === 'groups' ? '群' : '好友';
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;   // 去重：同一个号加两次会变成两个芯片，删一个还剩一个
    seen.add(id);
    const el = document.createElement('span');
    el.className = `wchip ${kind === 'groups' ? 'grp' : 'frd'}`;
    el.innerHTML = `${label} ${esc(id)}<span class="wchip-x" data-rm="${kind}" data-id="${esc(id)}" role="button" tabindex="0" title="移除">×</span>`;
    box.insertBefore(el, input);
  }
  bindAllowChips();
}

/** 芯片的删除/添加接线。⚠️ 用事件委托挂在**设置表单容器**上，只绑一次 ——
 *  芯片是动态增删的，逐个绑会在每次增删后丢监听（芯片变死件）。
 *
 *  🔴 踩坑记录：第一版挂到了 `#settings-page` —— **那个 id 在这个应用里根本不存在**
 *     （真实容器是 `#settings-form`）。`getElementById` 返回 null ⇒ 整个函数早退 ⇒
 *     芯片的添加/删除**从来没被接线**，而界面上看不出任何异常（点了没反应、也不报错）。
 *     这正是本项目最忌讳的静默失效。
 *  ⇒ 现在的做法：容器找不到就**大声报错**，而不是悄悄 return。
 */
function bindAllowChips() {
  const root = document.getElementById('settings-form')
  if (!root) {
    // 宁可吵一点：这条路径出错的表现是"芯片点不动"，比一条控制台报错难查得多
    console.error('[allow] 找不到 #settings-form，白名单芯片的增删不会工作（芯片会变成死件）')
    return
  }
  if (root.__allowChipsBound) return
  root.__allowChipsBound = true
  const addFrom = (input) => {
    const kind = input.dataset.chipinput;
    const v = String(input.value || '').trim().replace(/[,，\s]+/g, '');
    if (!v) return;
    const ids = readAllowChips(kind);
    if (!ids.includes(v)) setAllowChips(kind, [...ids, v]);
    input.value = '';
    input.focus();
  };
  root.addEventListener('click', (e) => {
    const x = e.target.closest('.wchip-x');
    if (x) {
      const kind = x.dataset.rm;
      const id = x.dataset.id;
      setAllowChips(kind, readAllowChips(kind).filter((v) => v !== id));
      return;
    }
    // 点盒子空白处 = 聚焦到输入框（不然点了没反应，像坏了）
    const box = e.target.closest('.chipbox');
    if (box) box.querySelector('input')?.focus();
  });
  root.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-chipinput]');
    if (!input) return;
    if (e.key === 'Enter') { e.preventDefault(); addFrom(input); return; }
    // 退格键在空输入框上 = 删掉最后一个芯片（常见的标签输入习惯，
    // 用键盘就能删，不必去够那个 ×）
    if (e.key === 'Backspace' && !input.value) {
      const kind = input.dataset.chipinput;
      const ids = readAllowChips(kind);
      if (ids.length) { e.preventDefault(); setAllowChips(kind, ids.slice(0, -1)); }
    }
  });
}

/** ⚠️ 2026-09-22（条目 6）：`parseList()` 已删除。
 *  它做的是"把逗号文本框的内容切成数组"，而白名单现在用**芯片输入**（`.chipbox`），
 *  名单的权威来源是 DOM 里的芯片（`readAllowChips`）。
 *  ⇒ 留着一个没人调的旧函数比删掉更危险：下次有人改名单格式时不知道要改两处。 */

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000
    };
  }

  if (sec === 'api') {
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      priceRemoteUrl: val('#cfg-price-remote-url', c.api.priceRemoteUrl || '').trim(),
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入 —— 那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const ca = Number(val('#cfg-price-cached', 0)) || 0;
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca || i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || []
    };
    // 以图搜图开关（引擎均免 Key，只有开/关 + 可选 SauceNAO Key）
    const enteredSaucenaoKey = val('#cfg-saucenao-key', '').trim();
    patch.imageSearch = {
      ...(c.imageSearch || {}),
      enabled: chk('#cfg-imagesearch', c.imageSearch?.enabled !== false),
      // 触发策略 + 单次运行上限（见 src/tools.js 的 search_image_source）
      policy: val('#cfg-imagesearch-policy', c.imageSearch?.policy || 'asked'),
      maxPerRun: Math.max(1, Math.min(10, Number(val('#cfg-imagesearch-max', c.imageSearch?.maxPerRun ?? 2)) || 2)),
      cfBypass: chk('#cfg-cfbypass', c.imageSearch?.cfBypass !== false),
      // ****** = 保持原 Key 不变；明文或新输入才更新
      ...(enteredSaucenaoKey && enteredSaucenaoKey !== '******' ? { saucenaoApiKey: enteredSaucenaoKey } : {})
    };
    // 看图（视觉）的体积上限：四个数字一起收。
    // 界面侧先钳一道，后端 imageLimits() 还会再兜一道（非法值回落默认），两道都不信任对方。
    const intIn = (sel, def, lo, hi) => {
      const n = Math.round(Number(val(sel, def)));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    patch.imageLimits = {
      maxKB: intIn('#cfg-img-maxkb', c.imageLimits?.maxKB ?? 700, 1, 32768),
      maxRunMB: intIn('#cfg-img-maxrun', c.imageLimits?.maxRunMB ?? 3, 1, 64),
      maxPerView: intIn('#cfg-img-perview', c.imageLimits?.maxPerView ?? 6, 1, 50),
      maxDownloadMB: intIn('#cfg-img-maxdl', c.imageLimits?.maxDownloadMB ?? 12, 1, 128)
    };
    // 本子查询（JM + NH 兜底）：开关 + 参数 + 可选的路径覆盖
    patch.doujinLookup = {
      ...(c.doujinLookup || {}),
      enabled: chk('#cfg-doujin', !!c.doujinLookup?.enabled),
      maxResults: intIn('#cfg-doujin-max', c.doujinLookup?.maxResults ?? 10, 1, 50),
      timeoutMs: intIn('#cfg-doujin-timeout', c.doujinLookup?.timeoutMs ?? 30000, 3000, 120000),
      allowInGroup: chk('#cfg-doujin-group', c.doujinLookup?.allowInGroup !== false),
      toolDir: val('#cfg-doujin-dir', '').trim(),
      pythonPath: val('#cfg-doujin-python', '').trim()
    };
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || ''),
      // 整份替换：留空 = 用内置系统提示
      systemPrompt: val('#cfg-sysprompt', c.persona.systemPrompt || '')
    };
    // 逐段替换：只有输入框真的渲染出来了才动这个字段 —— 万一 /api/system-prompt
    // 没拉到，就保持原值，绝不把已有覆盖静默清空。
    const segEls = $$('.sysprompt-seg');
    if (segEls.length) {
      const loaded = {};
      for (const s of (state.systemPrompt?.segments || [])) loaded[s.key] = String(s.default ?? '');
      const segs = {};
      for (const node of segEls) {
        const key = node.getAttribute('data-seg-key');
        const value = String(node.value ?? '').trim();
        // 与"加载时的内置默认"一致 → 不写覆盖；于是把某段改回原样就等于取消该段覆盖。
        if (value && value !== String(loaded[key] ?? '').trim()) segs[key] = value;
      }
      // __replace__：整体替换，这样"清空某段"才会真的删掉该段的覆盖（深合并删不掉键）。
      patch.persona.systemPromptSegments = { __replace__: segs };
    }
  }

  if (sec === 'allow') {
    // ── 条目 6：三选一模式 + 芯片输入 ────────────────────────────────────
    // ⚠️ 名单的**权威来源是 DOM 里的芯片**（用户可能刚点 × 删过），
    //    不是 state.config 里的旧数组 —— 用旧数组会把"刚删掉的"又存回去。
    const picked = (kind) => Array.from(document.querySelectorAll(`.chipbox[data-chipbox="${kind}"] .wchip`))
      .map((el) => String(el.textContent).replace(/^[^ ]+\s*/, '').replace(/×$/, '').trim())
      .filter(Boolean);
    patch.allow = {
      groups: picked('groups'),
      private: picked('private'),
      // 模式：从单选读；读不到就保持原值（不回退成默认值 —— 那会悄悄改用户的选择）
      mode: (document.querySelector('input[name="allow-mode"]:checked') || {}).value
        || (ALLOW_MODES_UI.includes(c.allow?.mode) ? c.allow.mode : deriveAllowModeUi(c)),
    };
    patch.deny = { groups: [], private: [] };
    // ⚠️ 旧字段**继续写**，而且要与 mode 保持一致：
    //    旧版本读的是它们，回滚后行为才不会变。写成"与 mode 等价的旧形态"：
    //      allowAll      ⇒ allowAllWhenEmpty=true（名单空时靠它兜底放行）
    //      denyAll       ⇒ allowAllWhenEmpty=false + 名单**清空**（名单非空会盖过复选框！）
    //      whitelist     ⇒ allowAllWhenEmpty 保持用户原来的值（不影响判定），名单照实写
    //    🔴 denyAll 那一支必须清空名单：旧判定是"名单非空 ⇒ 只看名单"，不清空的话
    //       回滚后会变成"只放行名单里的人"，而用户选的是"谁都不许" —— 方向正好相反。
    if (patch.allow.mode === 'allowAll') {
      patch.allowAllWhenEmpty = true;
    } else if (patch.allow.mode === 'denyAll') {
      patch.allowAllWhenEmpty = false;
      patch.allow.groups = [];
      patch.allow.private = [];
    } else {
      patch.allowAllWhenEmpty = c.allowAllWhenEmpty === true;
    }
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      // 界面是分钟 ⇒ 存盘前 ×60000 换回毫秒（键名带 Ms，见上面 HTML 里的注释）
      checkIntervalMinMs: minToMs(val('#cfg-pro-min', msToMin(c.proactive?.checkIntervalMinMs, 30)), 1800000),
      checkIntervalMaxMs: minToMs(val('#cfg-pro-max', msToMin(c.proactive?.checkIntervalMaxMs, 90)), 5400000),
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25,
      // 新增到界面上的四个（原来它们只在 config 里，看不见也调不了）
      idleThresholdMs: minToMs(val('#cfg-pro-idle', msToMin(c.proactive?.idleThresholdMs, 30)), 1800000),
      quietHoursStart: clampInt(val('#cfg-pro-quiet-start', c.proactive?.quietHoursStart ?? 23), 0, 23, 23),
      quietHoursEnd: clampInt(val('#cfg-pro-quiet-end', c.proactive?.quietHoursEnd ?? 8), 0, 24, 8),
      maxConsecutive: clampInt(val('#cfg-pro-maxconsec', c.proactive?.maxConsecutive ?? 2), 1, 10, 2)
      // ⚠️ reengageAfterHours / Backoff / MaxHours 三个**故意不做输入框**：
      //    它们是"没人理就慢慢收手"的退避参数，逻辑绕；而 proactive.enabled 目前是关着的，
      //    为一个没开的功能够造三个输入框不划算。面板上只**只读显示**当前值。
    };
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0))
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    patch.store = {
      ...(c.store || {}),
      // 档位 = 滑条位置换算（唯一真相是滑条的实时 value）。
      // 后端 updateConfig 还会用 tier-slider.js 再权威换算一次，双保险。
      contextTier: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).tier;
      })(),
      // 滑条位置存下来，重开设置页能还原到用户拖动的位置
      contextSliderPos: (() => {
        const sl = $('#ctx-tier-slider');
        return sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
      })(),
      // 3 档概率由滑条位置线性决定（不再让用户单独填数字）
      randomPercent: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).randomPercent;
      })(),
      atCount: clampInt(val('#cfg-atcount', c.store?.atCount), 1, 500, 20),
      keywordCount: clampInt(val('#cfg-kwcount', c.store?.keywordCount), 1, 500, 15),
      keywords: String($('#cfg-keywords')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean),
      randomPercent: clampInt(val('#cfg-randpct', c.store?.randomPercent), 0, 100, 10),
      randomCount: clampInt(val('#cfg-randcount', c.store?.randomCount), 1, 500, 8),
      allCount: clampInt(val('#cfg-allcount', c.store?.allCount), 1, 500, 80),
      // 统一开关 + 分会话滑条表（群聊私聊同一套，键是完整 chatKey）
      // __replace__：整体替换，这样"清除某会话的单独设置"才会真的删掉那个键（深合并删不掉）
      unifiedTier: chk('#cfg-unifiedtier', c.store?.unifiedTier !== false),
      chatSliderPos: {
        __replace__: (() => { try { return JSON.parse($('#tier-chat-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
    // 清掉已废弃的字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;
    // groupSliderPos 是被 chatSliderPos 取代的旧字段（只有群聊）：
    // 后端 loadConfig 已经迁移过了，这里再删一次，防止它被 ...c.store 展开重新写回文件
    delete patch.store.groupSliderPos;
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}

/* ══════════════════════════════════════════════════════════════
   社区功能：意见收集 + 金句上传
   ══════════════════════════════════════════════════════════════
   数据流向：浏览器 → https://kondius.cn/qq-agent/api（作者自建的公开
   收件箱，静态站之外的一个小型接收服务）。不经过本地后端 ——
   本地后端只服务本机，碰不到作者的服务器；分发版用户也是这个地址
   （意见和金句本来就是发给作者看的）。
*/
const COMMUNITY_API = 'https://kondius.cn/qq-agent/api';

/** 统一的提示小模态框（替代 alert —— 原生对话框与 UI 风格割裂）。 */
function showNoticeModal(title, text) {
  const overlay = modelModalShell({
    head: title,
    body: `<div class="hint" style="font-size:13.5px;line-height:1.7">${esc(text)}</div>`,
    foot: `<button class="btn btn-primary" id="notice-ok">知道了</button>`
  });
  overlay.querySelector('#notice-ok').addEventListener('click', () => closeModelModal(overlay));
}

/**
 * 危险操作确认框（所有"删除"都走这里，不用原生 confirm）。
 *
 * 原生 confirm 的问题：一是说不清"删的是什么、能不能恢复"，二是风格割裂。
 * text 支持 HTML（动态部分由调用方自己 esc），便于把要删的对象名写进正文。
 * onOk 抛错时不关弹窗，方便用户看完错误再决定要不要重试。
 */
function confirmDanger({ head = '确认删除', text = '', okText = '确认删除', onOk }) {
  const overlay = modelModalShell({
    head,
    danger: true,
    body: `<div style="font-size:13.5px;line-height:1.75">${text}</div>`,
    foot: `<button class="btn" id="cdg-cancel">取消</button>
           <button class="btn btn-danger" id="cdg-ok">${esc(okText)}</button>`
  });
  const okBtn = overlay.querySelector('#cdg-ok');
  overlay.querySelector('#cdg-cancel').addEventListener('click', () => closeModelModal(overlay));
  okBtn.addEventListener('click', async () => {
    okBtn.disabled = true;
    const oldText = okBtn.textContent;
    okBtn.textContent = '处理中…';
    try {
      await onOk();
      closeModelModal(overlay);
    } catch (e) {
      okBtn.disabled = false;
      okBtn.textContent = oldText;
      alert(`操作失败：${e.message}`);
    }
  });
}

/**
 * 上传成功浮框（右上角）：不自动消失，只能手动关闭，带目标网址。
 * 意见收集 / 金句上传成功后调用。
 */
function showUploadToast(title, url, { onClose } = {}) {
  // 同类型只留一个（连着传两次不堆叠）
  document.querySelectorAll('.upload-toast').forEach((el) => el.remove());
  const el = document.createElement('div');
  el.className = 'upload-toast';
  el.innerHTML = `
    <div class="ut-head">
      <span class="ut-title">${esc(title)}</span>
      <button class="ut-close" title="关闭">×</button>
    </div>
    <a class="ut-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>`;
  document.body.appendChild(el);
  el.querySelector('.ut-close').addEventListener('click', () => { el.remove(); onClose?.(); });
}

// ── 屏蔽名单 ──
// 左栏选白名单群聊，右栏拉取群成员逐个勾选；勾选 = 屏蔽。
// 弹窗内的改动只落在 pending 工作副本上，点「保存设置」才一次性 POST。
function openBlocklistModal() {
  const cfg = state.config || {};
  const allowIds = (cfg.allow?.groups || []).map(String);
  if (!allowIds.length) {
    modelModalShell({
      head: '屏蔽名单',
      body: '<div class="empty-hint">白名单为空——先去「白名单」页签添加群聊，再来屏蔽群员。</div>'
    });
    return;
  }
  const pending = structuredClone(cfg.blocklist || {});
  const selfId = String(cfg.onebot?.selfId || '');
  let activeGid = allowIds[0];
  let members = [];       // 当前群成员缓存（{userId, nickname, card}）
  let kw = '';

  const overlay = modelModalShell({
    head: '屏蔽名单',
    body: `
      <div class="ma-body dual">
        <div class="model-modal-left" id="bl-left"></div>
        <div class="model-modal-right" id="bl-right"></div>
      </div>
      <div class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        勾选 = 屏蔽：被屏蔽群员的消息不存档、不触发回复、不进提示词背景。
      </div>`,
    foot: `<span class="muted" id="bl-status" style="flex:1;text-align:left;font-size:12px"></span>
           <button class="btn" id="bl-cancel">取消</button>
           <button class="btn btn-primary" id="bl-save">保存设置</button>`
  });
  const left = overlay.querySelector('#bl-left');
  const right = overlay.querySelector('#bl-right');
  const statusEl = overlay.querySelector('#bl-status');

  const groupNames = new Map();   // 异步补群名
  function renderLeft() {
    left.innerHTML = allowIds.map((id) =>
      `<div class="mm-prov ${id === activeGid ? 'active' : ''}" data-gid="${esc(id)}">${esc(groupNames.get(id) || id)}<div class="muted" style="font-size:11px">${esc(id)}</div></div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activeGid = el.dataset.gid; renderLeft(); loadMembers(); });
    });
  }
  api('/api/onebot/groups').then((d) => {
    for (const g of (d.groups || [])) groupNames.set(String(g.id), g.name);
    renderLeft();
  }).catch(() => {});

  function isBlocked(uid) { return (pending[activeGid] || []).map(String).includes(String(uid)); }

  function renderRight() {
    const filtered = kw
      ? members.filter((m) => `${m.card} ${m.nickname} ${m.userId}`.toLowerCase().includes(kw))
      : members;
    const rows = filtered.map((m) => {
      const label = m.card || m.nickname || m.userId;
      return `<label class="bl-member">
        <input type="checkbox" class="bl-chk" data-uid="${esc(m.userId)}" ${isBlocked(m.userId) ? 'checked' : ''} />
        <span class="bl-name">${esc(label)}</span>
        <span class="muted" style="font-size:11px">${esc(m.userId)}</span>
      </label>`;
    }).join('');
    right.innerHTML = `
      <div class="ma-toolbar">
        <input type="text" id="bl-search" placeholder="搜索群员（昵称 / 群名片 / QQ 号）…" autocomplete="off" value="${esc(kw)}" />
      </div>
      <div id="bl-list">${rows || '<div class="empty-hint" style="padding:18px">没有匹配的群员</div>'}</div>`;
    right.querySelector('#bl-search').addEventListener('input', (e) => { kw = e.target.value.trim().toLowerCase(); renderRight(); });
    right.querySelectorAll('.bl-chk').forEach((chkEl) => {
      chkEl.addEventListener('change', () => {
        const uid = chkEl.dataset.uid;
        const set = new Set((pending[activeGid] || []).map(String));
        if (chkEl.checked) set.add(uid); else set.delete(uid);
        if (set.size) pending[activeGid] = [...set]; else delete pending[activeGid];
        const n = (pending[activeGid] || []).length;
        statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
      });
    });
  }

  async function loadMembers() {
    right.innerHTML = '<div class="empty-hint" style="padding:18px">正在拉取群成员…</div>';
    try {
      const d = await api(`/api/groups/${activeGid}/members`);
      // 机器人自己列出来也没意义（自己的消息本来就不走这条管道）
      members = (d.members || []).filter((m) => String(m.userId) !== selfId);
      kw = '';
      renderRight();
      const n = (pending[activeGid] || []).length;
      statusEl.textContent = n ? `当前群已屏蔽 ${n} 人` : '';
    } catch (e) {
      right.innerHTML = `<div class="empty-hint" style="padding:18px">拉取失败：${esc(e.message)}（SnowLuma 在线才能拿到群成员列表）</div>`;
    }
  }

  overlay.querySelector('#bl-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bl-save').addEventListener('click', async () => {
    const saveBtn = overlay.querySelector('#bl-save');
    saveBtn.disabled = true;
    statusEl.textContent = '保存中…';
    try {
      // __replace__：清空的群要从配置里真删掉，深合并做不到
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ blocklist: { __replace__: pending } }) });
      state.config = data.config;
      closeModelModal(overlay);
    } catch (e) {
      statusEl.textContent = `保存失败：${e.message}`;
      saveBtn.disabled = false;
    }
  });

  renderLeft();
  loadMembers();
}

// ── 意见收集 ──
const FB_DRAFT_KEY = 'qqa-feedback-draft';

/** 读草稿（昵称/正文/图片 dataURL 列表）。 */
function fbLoadDraft() {
  try {
    const d = JSON.parse(localStorage.getItem(FB_DRAFT_KEY) || '{}');
    return {
      nickname: String(d.nickname || ''),
      text: String(d.text || ''),
      images: Array.isArray(d.images) ? d.images.slice(0, 9) : []
    };
  } catch { return { nickname: '', text: '', images: [] }; }
}

/** 图片压缩：最大边 1200px、JPEG 0.75 —— 够看清，又不会把 localStorage 塞爆。 */
function fbCompressImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src);
      const max = 1200;
      let { width: w, height: h } = img;
      if (w > max || h > max) {
        const r = Math.min(max / w, max / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(cv.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('图片读取失败')); };
    img.src = URL.createObjectURL(file);
  });
}

function openFeedbackModal() {
  const draft = fbLoadDraft();
  const state2 = { images: draft.images.slice() };   // 弹窗内的图片列表（dataURL）

  const overlay = modelModalShell({
    head: '意见收集',
    body: `
      <div id="fb-form">
        <div class="hint" style="flex-shrink:0">
          昵称和意见会上传到作者的服务器（kondius.cn/qq-agent/comments 公开展示）。
          内容实时保存在本机，误点弹窗外面也不会丢。
        </div>
        <div class="field"><label>昵称</label>
          <input type="text" id="fb-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(draft.nickname)}" /></div>
        <div class="field"><label>意见 / 建议</label>
          <textarea id="fb-text" rows="6" maxlength="5000" placeholder="哪里好用、哪里难用、想要什么功能…">${esc(draft.text)}</textarea></div>
        <div class="field"><label>附图（最多 9 张，自动压缩）</label>
          <!-- 原生 <input type=file> 的"选择文件"按钮是系统样式，与 UI 割裂：
               隐藏本体，用统一的 .btn 风格 label 触发 -->
          <input type="file" id="fb-file" accept="image/*" multiple style="display:none" />
          <label for="fb-file" class="btn btn-small" id="fb-file-btn" style="cursor:pointer">＋ 添加图片（<span id="fb-img-count">${state2.images.length}</span>/9）</label>
          <div class="fb-imgs" id="fb-imgs"></div>
        </div>
        <div id="fb-hint" class="muted" style="font-size:12px"></div>
      </div>
      <div id="fb-confirm" style="display:none">
        <div class="hint">请确认上传内容：</div>
        <div id="fb-summary" style="white-space:pre-wrap;font-size:13px;max-height:300px;overflow-y:auto"></div>
        <div id="fb-confirm-hint" class="muted" style="font-size:12px;margin-top:8px"></div>
      </div>`,
    foot: `
      <button class="btn" id="fb-cancel">取消</button>
      <button class="btn btn-primary" id="fb-next">下一步</button>
      <button class="btn hidden" id="fb-back">返回修改</button>
      <button class="btn btn-primary hidden" id="fb-submit">确认上传</button>`
  });

  const $q = (sel) => overlay.querySelector(sel);
  const formEl = $q('#fb-form'), confirmEl = $q('#fb-confirm');
  const nextBtn = $q('#fb-next'), backBtn = $q('#fb-back'), submitBtn = $q('#fb-submit');

  // ── 草稿实时保存（300ms 防抖）──
  let saveTimer = null;
  const saveDraft = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
          nickname: $q('#fb-nickname').value,
          text: $q('#fb-text').value,
          images: state2.images
        }));
      } catch { /* 图片太多塞不下时至少保住文字 */ 
        try {
          localStorage.setItem(FB_DRAFT_KEY, JSON.stringify({
            nickname: $q('#fb-nickname').value, text: $q('#fb-text').value, images: []
          }));
        } catch { /* 放弃 */ }
      }
    }, 300);
  };
  $q('#fb-nickname').addEventListener('input', saveDraft);
  $q('#fb-text').addEventListener('input', saveDraft);

  // ── 图片九宫格 ──
  function renderImgs() {
    const cnt = $q('#fb-img-count');
    if (cnt) cnt.textContent = state2.images.length;
    $q('#fb-imgs').innerHTML = state2.images.map((d, i) => `
      <div class="fb-img"><img src="${d}" alt="附图${i + 1}" />
        <button class="fb-img-del" data-i="${i}" title="移除">×</button></div>`).join('');
    $q('#fb-imgs').querySelectorAll('.fb-img-del').forEach((el) => {
      el.addEventListener('click', () => {
        state2.images.splice(Number(el.dataset.i), 1);
        renderImgs();
        saveDraft();
      });
    });
  }
  renderImgs();

  $q('#fb-file').addEventListener('change', async (e) => {
    const hint = $q('#fb-hint');
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const f of files) {
      if (state2.images.length >= 9) { hint.textContent = '最多 9 张，超出的已忽略'; break; }
      try {
        state2.images.push(await fbCompressImage(f));
      } catch (err) { hint.textContent = String(err.message || err); }
    }
    renderImgs();
    saveDraft();
  });

  // ── 步骤切换 ──
  $q('#fb-cancel').addEventListener('click', () => closeModelModal(overlay));
  nextBtn.addEventListener('click', () => {
    const nickname = $q('#fb-nickname').value.trim();
    const text = $q('#fb-text').value.trim();
    if (!nickname) { $q('#fb-hint').textContent = '先填个昵称'; return; }
    if (!text) { $q('#fb-hint').textContent = '意见还没写'; return; }
    saveDraft();
    $q('#fb-summary').textContent =
      `昵称：${nickname}\n\n${text}\n\n附图：${state2.images.length} 张`;
    formEl.style.display = 'none';
    confirmEl.style.display = '';
    nextBtn.classList.add('hidden');
    backBtn.classList.remove('hidden');
    submitBtn.classList.remove('hidden');
  });
  backBtn.addEventListener('click', () => {
    formEl.style.display = '';
    confirmEl.style.display = 'none';
    nextBtn.classList.remove('hidden');
    backBtn.classList.add('hidden');
    submitBtn.classList.add('hidden');
  });

  // ── 上传 ──
  submitBtn.addEventListener('click', async () => {
    const hint = $q('#fb-confirm-hint');
    hint.textContent = '上传中…';
    submitBtn.disabled = true;
    try {
      const res = await fetch(`${COMMUNITY_API}/comment`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nickname: $q('#fb-nickname').value.trim(),
          text: $q('#fb-text').value.trim(),
          images: state2.images
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      localStorage.removeItem(FB_DRAFT_KEY);   // 上传成功才清草稿
      closeModelModal(overlay);
      showUploadToast('意见已上传，感谢反馈！', 'https://kondius.cn/qq-agent/comments');
    } catch (err) {
      hint.textContent = `上传失败：${err.message}（内容已保存在本机，可稍后再试）`;
      submitBtn.disabled = false;
    }
  });
}

// ── 打开网站 ──
// Electron 里 window.open 会被 main.js 的 setWindowOpenHandler 转给系统默认浏览器；
// 开发模式（纯浏览器）则正常开新标签页。
function openSite() {
  window.open('https://kondius.cn/qq-agent', '_blank', 'noopener');
}

// ── 自动检查更新 ──
// 节奏：启动时一次 + 之后每小时一次（version.json 作者手动改，这个频率足够）。
// 有更新 → 弹浮窗引导下载；用户手动关掉浮窗 → 本次启动内不再弹（重启恢复）。
// 但只要检测到新版，设置侧栏「桌面端」右侧就一直挂红点，直到版本追平。
let updateAvailable = false;
let updateToastDismissed = false;   // 本次启动内用户关过更新浮窗

function renderUpdateDot() {
  // 侧栏菜单每次重渲染都会重建（菜单 HTML 里已按 updateAvailable 画了点）；
  // 这里兜底处理"侧栏已渲染完、检测结果刚到"的情况。
  const item = document.querySelector('.settings-menu-item[data-section="desktop"]');
  if (!item) return;
  let dot = item.querySelector('.update-dot');
  if (updateAvailable && !dot) {
    dot = document.createElement('span');
    dot.className = 'update-dot';
    item.appendChild(dot);
  } else if (!updateAvailable && dot) {
    dot.remove();
  }
  // 桌面端页签的版本文案同步：有新版时"检查线上是否有新版本"→"发现新版本"
  const st = document.getElementById('update-status-text');
  if (st) {
    st.innerHTML = updateAvailable ? '<b style="color:var(--warn)">；发现新版本</b>' : '；检查线上是否有新版本';
  }
}

async function runUpdateCheck({ manual = false } = {}) {
  try {
    const data = await api('/api/update-check');
    if (!data?.ok) return data;   // 网络/服务器错误原样返回，手动检查要显示原因
    updateLatest = data;
    updateAvailable = !!data.hasUpdate;
    renderUpdateDot();
    // 自动检查弹浮窗；本次启动内被用户关过就不再弹（手动点「检查更新」除外）
    if (updateAvailable && (!updateToastDismissed || manual)) {
      showUploadToast(
        `发现新版本 v${data.latest}（当前 v${data.current}）`,
        data.url,
        { onClose: () => { updateToastDismissed = true; } }
      );
    }
    return data;
  } catch { return null; }
}
let updateLatest = null;

// ── 金句上传 ──
state.quoteMode = false;
state.quoteSelected = new Set();   // 当前存档会话里勾选的消息 id（m.id）

/** 进入/退出勾选模式时切换顶栏按钮形态。 */
function syncQuoteButtons() {
  const qb = $('#quote-btn'), qc = $('#quote-confirm-btn');
  if (!qb || !qc) return;
  if (state.quoteMode) {
    qb.textContent = '取消';
    qc.classList.remove('hidden');
  } else {
    qb.textContent = '金句上传';
    qc.classList.add('hidden');
  }
}

function enterQuoteMode() {
  state.quoteMode = true;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  switchTab('chats');
  if (state.currentChatKey) renderChatMessages();   // 重建出勾选框
}

function exitQuoteMode() {
  if (!state.quoteMode) return;
  state.quoteMode = false;
  state.quoteSelected = new Set();
  syncQuoteButtons();
  if (state.tab === 'chats' && state.currentChatKey) updateChatMessagesBody(true);
}

/** 勾选模式下的确认：二次确认框 + 昵称。 */
function openQuoteConfirmModal() {
  const all = state.chatMessages || [];
  const picked = all.filter((m) => state.quoteSelected.has(m.id))
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));   // 按时间正序，读起来才是对话
  if (!picked.length) { showNoticeModal('金句上传', '还没有勾选任何消息。先在存档列表里勾几段对话吧。'); return; }
  const botCount = picked.filter((m) => m.self).length;
  if (!botCount) {
    showNoticeModal('金句上传', '勾选的消息里必须包含至少一条机器人发送的消息 —— 金句墙收的是机器人的发言。');
    return;
  }

  const key = state.currentChatKey || '';
  const chatName = formatChatTitle(key, chatNameOf(key));
  const lastNickname = localStorage.getItem('qqa-quote-nickname') || '';

  const overlay = modelModalShell({
    head: '确认上传金句',
    body: `
      <div class="hint">将上传 ${picked.length} 条消息（含机器人 ${botCount} 条），
        来自「${esc(chatName)}」，公开展示在 kondius.cn/qq-agent/holyshits。</div>
      <div class="field"><label>昵称（收录人）</label>
        <input type="text" id="q-nickname" maxlength="32" placeholder="怎么称呼你" value="${esc(lastNickname)}" /></div>
      <div style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:10px;font-size:12.5px">
        ${picked.map((m) => `<div style="margin-bottom:8px">
          <span class="muted">${esc(m.self ? '🤖 ' : '')}${esc(m.senderName || '?')}：</span>${esc(String(m.text || '').slice(0, 200))}
        </div>`).join('')}
      </div>
      <div id="q-hint" class="muted" style="font-size:12px"></div>`,
    foot: `<button class="btn" id="q-cancel">取消</button>
           <button class="btn btn-primary" id="q-submit">确认上传</button>`
  });

  overlay.querySelector('#q-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#q-submit').addEventListener('click', async () => {
    const nickname = overlay.querySelector('#q-nickname').value.trim();
    const hint = overlay.querySelector('#q-hint');
    if (!nickname) { hint.textContent = '先填个昵称'; return; }
    overlay.querySelector('#q-submit').disabled = true;
    try {
      // ── 先取图：QQ 图床 URL 会过期（老消息全网 400），
      //    让本地后端走 OneBot get_image 从 NapCat 缓存里把原图读出来转 dataURL，
      //      随消息一起上传 —— 服务器不再依赖 URL 时效。
      const mediaItems = [];
      const mediaOwners = [];   // 记录每个 item 属于哪条消息，方便回填
      for (const m of picked) {
        for (const x of (Array.isArray(m.media) ? m.media : [])) {
          if (x && (x.url || x.file)) {
            mediaItems.push({ file: x.file || '', url: x.url || '' });
            mediaOwners.push(m);
          }
        }
      }
      const dataUrls = new Map();   // message -> [dataUrl,...]
      if (mediaItems.length) {
        hint.textContent = `正在从本地缓存取图（${mediaItems.length} 张）…`;
        try {
          const r = await api('/api/media-data', {
            method: 'POST', body: JSON.stringify({ items: mediaItems })
          });
          (r.results || []).forEach((res, i) => {
            if (res?.dataUrl) {
              const m = mediaOwners[i];
              if (!dataUrls.has(m)) dataUrls.set(m, []);
              dataUrls.get(m).push(res.dataUrl);
            }
          });
          hint.textContent = `取到 ${[...dataUrls.values()].flat().length}/${mediaItems.length} 张图，上传中…`;
        } catch { hint.textContent = '取图失败（按无图上传），上传中…'; }
      } else {
        hint.textContent = '上传中…';
      }
      const res = await fetch(`${COMMUNITY_API}/holyshits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nickname,
          // 不传 chatKey / chatName：金句墙只展示时间和收录人，群信息不出本机
          messages: picked.map((m) => {
            const dus = dataUrls.get(m) || [];
            let di = 0;
            return {
              ts: m.ts, senderName: m.senderName, text: m.text,
              self: !!m.self,
              media: (Array.isArray(m.media) ? m.media : [])
                .filter((x) => x && (x.url || x.file))
                .map((x) => ({
                  kind: 'image',
                  url: x.url || '',
                  file: x.file || '',
                  // 取到就带上（服务器直接落盘）；取不到服务器再尝试 URL 下载
                  ...(dus[di] ? { dataUrl: dus[di++] } : {})
                }))
            };
          })
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      localStorage.setItem('qqa-quote-nickname', nickname);
      closeModelModal(overlay);
      exitQuoteMode();
      showUploadToast('金句已收录！', 'https://kondius.cn/qq-agent/holyshits');
    } catch (err) {
      hint.textContent = `上传失败：${err.message}`;
      overlay.querySelector('#q-submit').disabled = false;
    }
  });
}

// 顶栏按钮绑定
$('#feedback-btn')?.addEventListener('click', () => openFeedbackModal());
$('#open-site-btn')?.addEventListener('click', () => openSite());
$('#about-btn')?.addEventListener('click', () => openAboutModal());
$('#quote-btn')?.addEventListener('click', () => {
  if (state.quoteMode) exitQuoteMode(); else enterQuoteMode();
});
$('#quote-confirm-btn')?.addEventListener('click', () => openQuoteConfirmModal());

// ── 标签页切换 ──
// ⚠️ 必须统一走 switchTab：曾经这里把切换逻辑 inline 复制了一份，
//    结果漏了 usage 分支 —— 点「用量」页签只切了视图、从不加载内容，
//    页面永远空白（轮询走的是"只更新数值"路径，骨架从未建立也救不回来）。
//    两条路径各维护一份必然再次分叉，所以这里只准调 switchTab。
$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── 启动 ──
(async function init() {
  // 主题：先按本地偏好应用（index.html 的内联脚本已做过一次，这里同步按钮图标），
  // 再用后端配置覆盖（若用户换了设备，以后端为准）。
  applyTheme(getThemePref());
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)');
    // 仅在"跟随系统"时响应系统主题变化
    mq?.addEventListener?.('change', () => { if (getThemePref() === 'system') applyTheme('system'); });
  } catch { /* 老浏览器不支持 addEventListener，忽略 */ }
  $('#theme-btn')?.addEventListener('click', cycleTheme);

  // 启动 loading：先等 HTTP 服务可用（页面可能先于服务打开）
  setLoadingStatus('正在启动 QQ Agent 服务…');
  await bootLoop();
  runUpdateCheck();                                 // 启动时静默查一次（失败不打扰）
  setInterval(() => runUpdateCheck(), 3600_000);    // 之后每小时查一次

  // 主题：以后端配置为准（跨设备同步），仅当后端确实存过才覆盖本地
  try {
    const cfg0 = await api('/api/config');
    const t = cfg0?.ui?.theme;
    if (THEME_VALUES.includes(t)) applyTheme(t);
    else if (cfg0 && !('ui' in cfg0)) { /* 后端还没这个字段，保持本地值 */ }
  } catch { /* 接口不可用就用本地的 */ }

  // 平台模式：同样以后端配置为准（用户选了微信，下次打开还在微信）
  // ⚠️ 用 reload:false —— 此刻页面还没加载任何列表，重载是白跑；
  //    真正的首次加载由下面那几行 loadSessions / loadChats 按当前模式做。
  try {
    const cfg1 = await api('/api/config');
    state.platformMode = cfg1?.ui?.mode === 'wechat' ? 'wechat' : 'qq';
  } catch { state.platformMode = 'qq'; }
  applyPlatformMode({ reload: false });

  // 平台切换按钮：只切显示（后端两个平台都继续跑）
  $$('#platform-switch .plat-btn').forEach((b) => {
    b.addEventListener('click', () => setPlatformMode(b.dataset.platform));
  });

  // 首启引导：关键配置（模型/白名单）没填就直接带去设置页
  try {
    const cfg = await api('/api/config');
    const ready = !!cfg.api.model && ((cfg.allow.groups?.length || cfg.allow.private?.length) || cfg.allowAllWhenEmpty);
    if (!ready) {
      switchTab('settings');
      connectSSE();
      refreshStatus();
      setInterval(refreshStatus, 15000);
      return;
    }
  } catch { /* 按默认流程走 */ }
  refreshStatus();
  setInterval(refreshStatus, 15000);
  connectSSE();
  loadSessions();
  loadMemoryView();
  initSessionScrollLoader();
  initSessionFilter();
  initGateLinks();   // 连接门控的「去完成连接引导」链接（全局委托，只绑一次）
  // 无边框窗口：自绘标题栏的按钮与拖拽（普通浏览器里会自动跳过，见函数注释）
  initWindowControls();
})();
