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
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
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
const THEME_VALUES = ['dark', 'light', 'system', '?'];

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
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
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
    ? `<button class="btn btn-small skill-settings-btn" data-skill-id="${esc(s.id)}">设置（${renderable.length || allFields.length}）</button>` : '';
  // 类型徽章用后端给的 kind 判，不用 source（source 只反映清单文件名，是另一件事）
  const kindTag = s.kind == null
    ? '<span class="tool-dep-warn">目录未识别</span>'
    : (s.kind === 'plugin' ? '确定性型' : 'LLM 型');
  const catLabel = { model: '模型', message: '消息', knowledge: '知识', media: '媒体', utility: '工具' };
  return `<div class="tool-card ${s.active ? 'enabled' : (s.loaded && s.enabled ? 'disabled' : 'dep-disabled')}" data-skill-id="${esc(s.id)}">
    <div class="tool-header">
      <label class="tool-checkbox-square" title="打开 / 关闭这个扩展">
        <input type="checkbox" class="skill-toggle" data-skill-id="${esc(s.id)}" ${s.enabled ? 'checked' : ''} ${s.loaded ? '' : 'disabled'} />
        <span class="tool-checkbox-box">${s.enabled ? '✓' : '✕'}</span>
      </label>
      <div class="tool-title">
        <div class="skill-card__name">${esc(s.name)}<span class="skill-card__ver">v${esc(s.version || '')}</span></div>
        <div class="skill-card__desc">${esc(s.description || '（没有写介绍）')}</div>
      </div>
      <span class="status-badge ${badge}">${stateText}</span>
    </div>
    <div class="tool-meta" style="align-items:center">
      <span class="tool-dep">${catLabel[s.category] || esc(s.category || '未分类')}</span>
      <span class="tool-dep">${kindTag}</span>
      ${s.dir ? `<span class="tool-dep" title="条目所在目录">${esc(s.dir)}</span>` : ''}
      ${s.deprecated ? '<span class="tool-dep-warn">已弃用</span>' : ''}
      ${(s.toolIds || []).length ? `<span class="tool-dep">${s.toolIds.length} 个工具</span>` : ''}
      ${(s.hooks || []).length ? `<span class="tool-dep">${s.hooks.length} 个钩子</span>` : ''}
      ${settingsBtn ? `<span style="margin-left:auto">${settingsBtn}</span>` : ''}
    </div>
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

  const sectionOf = (meta) => {
    const items = groups[meta.key];
    if (!items.length) {
      return `<h3 class="usage-h3">${meta.title}（0）</h3>
        <div class="empty-hint">${meta.empty}</div>
        <div class="hint" style="margin:6px 0 16px">${meta.lead}</div>`;
    }
    const active = items.filter((s) => s.active).length;
    const rows = items.map(skillCardHtml).join('');
    // 尾注：技能页最有用的信息是"它注册了哪些工具"（模型看到的就是这些）；
    // 插件页是"它提供哪些能力"（核心按名字找的就是这些）。
    const tools = items.flatMap((s) => s.toolIds || []);
    const caps = [...new Set(items.flatMap((s) => s.capabilities || []))].sort();
    const footer = meta.key === 'skill'
      ? `<div class="hint" style="margin:6px 0">这组技能共注册 <b>${tools.length}</b> 个工具 —— 这些工具会被放进发给模型的 function 列表，模型只能看到工具，看不到技能本身。</div>
         <div class="tool-meta" style="gap:6px;margin-bottom:16px">${tools.map((t) => `<span class="tool-dep">${esc(t)}</span>`).join('') || '<span class="muted">（没有注册任何工具）</span>'}</div>`
      : `<div class="hint" style="margin:6px 0">这组插件共提供 <b>${caps.length}</b> 个能力 —— 核心模块按能力名找提供者，不依赖具体插件名，所以换实现不用改核心代码。</div>
         <div class="tool-meta" style="gap:6px;margin-bottom:16px">${caps.map((c) => `<span class="tool-dep">${esc(c)}</span>`).join('') || '<span class="muted">（没有声明任何能力）</span>'}</div>`;
    return `<h3 class="usage-h3">${meta.title}（${items.length} · ${active} 生效）</h3>
      <div class="tool-list">${rows}</div>
      ${footer}`;
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
  const html = `<div class="usage-wrap">
    <div class="usage-head">
      <h2>技能 / 插件</h2>
      <div class="usage-days">
        <span class="uc-tag" title="生效中 / 全部条目">${activeAll} / ${total} 生效</span>
        <span class="uc-tag" title="${hot ? '放进 skills/ 或 plugins/ 的扩展会被自动加载（约 0.5 秒后生效）' : '新扩展要手动点「刷新」才会加载'}">热重载：${hot ? '开' : '关'}</span>
        <button class="btn btn-small" id="skills-hotreload-btn" title="切换热重载（放进目录的 .js 会被自动执行，这是它的代价）">${hot ? '关掉热重载' : '打开热重载'}</button>
        <button class="btn btn-small" id="skills-refresh-btn" title="重新扫描 skills/ 与 plugins/ 目录">刷新</button>
      </div>
    </div>
    <div class="hint" style="margin-bottom:14px">
      <b>开关只有这一处</b> —— 关闭后它注册的工具、提供的能力、提示词片段会<b>同时</b>失效。
      状态徽章与"为什么没生效"的说明都由后端判定，界面不自己猜。<br />
      放新扩展：在 <code>skills/&lt;id&gt;/</code> 或 <code>plugins/&lt;id&gt;/</code> 放清单与入口文件${hot ? '，约 0.5 秒后自动加载' : '，然后点「刷新」'}。<br />
      ⚠️ 热重载开着时，<b>放进这两个目录的任何 <code>.js</code> 都会被自动执行</b> —— 别把不信任的代码丢进去。
    </div>
    ${sectionOf(SKILL_KINDS.skill)}
    ${sectionOf(SKILL_KINDS.plugin)}
    ${unHtml}
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
  $('#skills-hotreload-btn')?.addEventListener('click', async () => {
    const want = state.skillsHotReload === false;   // 当前关着 → 点它就是打开
    const btn = $('#skills-hotreload-btn');
    if (btn) btn.disabled = true;
    try {
      const r = await api('/api/skills/hotreload', { method: 'POST', body: JSON.stringify({ enabled: want }) });
      state.skills = r.skills || state.skills;
      state.skillsHotReload = r.hotReload !== false;
      renderSkillsPage();
    } catch (e) {
      alert(`切换热重载失败：${e.message}`);
      if (btn) btn.disabled = false;
    }
  });
  $$('#skills-page .skill-toggle').forEach((cb) => {
    cb.addEventListener('change', () => toggleSkill(cb.dataset.skillId, cb.checked));
  });
  $$('#skills-page .skill-settings-btn').forEach((b) => {
    b.addEventListener('click', () => openSkillSettings(b.dataset.skillId));
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
    const dot = $('#onebot-dot');
    const label = $('#onebot-label');
    dot.className = 'dot ' + (s.onebot.connected ? 'dot-on' : (s.onebot.everConnected ? 'dot-wait' : 'dot-off'));
    label.textContent = s.onebot.connected
      ? `OneBot 已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}`
      : 'OneBot 未连接';
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
    const d = JSON.parse(ev.data);
    if (!appReady && d?.text) {
      setLoadingStatus(d.text);
    }
    if (appReady && (state.tab === 'snowluma' || state.tab === 'settings')) {
      refreshSnowlumaLogs();
    }
  });
  es.addEventListener('feedback', (ev) => {
    const d = JSON.parse(ev.data);
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
    renderSessionList();
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
    if (state.tab === 'usage') loadUsageView();   // 无 force：只更新数值，不重建 DOM
    if (state.tab === 'settings') refreshStatus();
  }, refreshIntervalMs());
}
startListPoller();

function renderSessionList() {
  const box = $('#session-items');
  state.seenSessionIds = state.seenSessionIds || new Set();
  // 分页：一次只渲染 sessionLimit 条，滚到底部再加载下一批（见 SESSION_PAGE 常量）。
  // 会话可能积累到几百条，全量渲染会让列表变卡。
  state.sessionLimit = Math.max(SESSION_PAGE, Number(state.sessionLimit) || SESSION_PAGE);
  const all = state.sessions || [];
  const shown = all.slice(0, state.sessionLimit);
  const rest = all.length - shown.length;
  box.innerHTML = shown.map((s) => {
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
  }).join('');
  // 底部提示：还有多少条没显示 / 已全部显示
  const more = $('#session-more');
  if (more) {
    more.textContent = rest > 0
      ? `向下滚动加载更多（还有 ${rest} 条）`
      : (all.length > SESSION_PAGE ? `已显示全部 ${all.length} 条` : '');
  }
  // 头部显示总数（已显示 / 总数），便于确认分页是否真的加载完了
  const cnt = $('#session-count');
  if (cnt) {
    cnt.textContent = all.length ? `${shown.length}/${all.length}` : '';
  }
  for (const s of state.sessions) state.seenSessionIds.add(s.id);
  $$('.session-item', box).forEach((el) => {
    el.addEventListener('click', () => selectSession(el.dataset.id));
  });
  // 每行的删除按钮：必须 stopPropagation，否则会顺带把"选中这条会话"也触发
  $$('.session-del', box).forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteSession(el.dataset.id, (state.sessions || []).find((x) => x.id === el.dataset.id));
    });
  });
  // 「清空全部会话」（按钮在 index.html 的列表头里，是常驻元素 → 只绑一次）
  const clearBtn = $('#sessions-clear-btn');
  if (clearBtn && !clearBtn.__bound) {
    clearBtn.__bound = true;
    clearBtn.addEventListener('click', clearAllSessions);
  }
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
  html.push(`
    <div class="detail-header">
      <h2>${esc(chatName)} ${statusBadge}
        <button class="btn btn-small" id="json-mode-btn" style="margin-left:10px">JSON 模式</button>
        <button class="btn btn-small btn-danger" id="session-del-btn" style="margin-left:6px">删除本次会话</button>
      </h2>
      <div class="sub">
        <span>触发：${esc(s.triggerSummary || (s.trigger === 'proactive' ? '主动机会' : '-'))}</span>
        <span>开始 ${fmtClock(s.startedAt)}${s.endedAt ? ` · 结束 ${fmtClock(s.endedAt)}` : ' · 进行中'}</span>
        <span>模型 ${esc(s.model || '-')}</span>
        <span>${usage.calls || 0} 次调用 · ${fmtTokens(usage.promptTokens)} 入 / ${fmtTokens(usage.completionTokens)} 出 / ${fmtTokens(usage.totalTokens)} 总</span>
        <span>${s.rounds || 0} 轮工具</span>
        <span>联网搜索 ${Number(s.webSearchCount) || 0} 次</span>
      </div>
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
      html.push(`
        <details class="collapsible">
          <summary>系统提示（${s.systemPrompt.length} 字符，每次运行重发）</summary>
          <div class="coll-body">${esc(s.systemPrompt)}</div>
        </details>`);
    }
    if (s.userPrompt) {
      html.push(`
        <details class="collapsible" open>
          <summary>本次输入（${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档）</summary>
          <div class="coll-body">${esc(s.userPrompt)}</div>
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
      html.push(`
        <div class="sent-badge">
          <div class="asr-label">已发送到 QQ${sent.at ? ` · ${sent.at}` : ''}</div>
          ${esc(sent.text)}
        </div>`);
    }
  }
  if (s.error) html.push(`<div class="session-error">${esc(s.error)}</div>`);
  if (s.finishReason) html.push(`<div class="bubble bubble-user">finish：${esc(s.finishReason)}</div>`);
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
 */
async function refreshSnowlumaLogs() {
  const box = $('#snowluma-page');
  if (!box) return;
  const pre = box.querySelector('.snowluma-logs-view');
  if (!pre) return;                       // 页面还没渲染过，等下次整页刷新
  try {
    const logs = await api('/api/snowluma/logs');
    const logText = (logs.logs || []).map((l) => {
      const t = new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false });
      return `[${t}]${l.stream === 'stderr' ? ' ⚠' : ''} ${l.text}`;
    }).join('\n') || '暂无日志';
    // ⚠️ 先记贴底状态再换内容：新日志追加在底部，scrollTop 不变 = 阅读位置不变；
    //    只有用户本来就贴底才跟随到底，往上翻历史时绝不把他拽回去。
    //    滚动容器是 <pre> 自己（overflow-y:auto），不是 parentElement —— 之前滚错了对象。
    const wasAtBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 40;
    pre.textContent = logText;
    if (wasAtBottom) pre.scrollTop = pre.scrollHeight;
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

    // 整页重建前记住日志滚动位置：SSE/轮询触发的 quiet 重建会重置 DOM，
    // 不补偿的话用户往下翻日志会被弹回顶部（Kondius 实测：划两下就蹦上去）
    const oldPre = box.querySelector('.snowluma-logs-view');
    const prevScroll = oldPre
      ? { top: oldPre.scrollTop, atBottom: oldPre.scrollTop + oldPre.clientHeight >= oldPre.scrollHeight - 40 }
      : null;

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

    box.innerHTML = `
      <div class="snowluma-page-card">
        <h2>SnowLuma（OneBot 网关）</h2>
        <div class="snowluma-state-row">
          <span class="dot ${running ? 'dot-on' : 'dot-off'}"></span>
          <span>SnowLuma：<strong>${running ? '运行中' : '未运行'}</strong></span>
          ${pid ? `<span class="muted">pid ${pid}</span>` : ''}
          <span class="muted">${embedded ? '内置模式（随 QQ Agent 退出）' : (running ? '独立模式' : '')}</span>
        </div>
        <div class="snowluma-state-row">
          <span class="dot ${onebotConnected ? 'dot-on' : 'dot-off'}"></span>
          <span>OneBot：<strong>${onebotConnected ? `已连接${s.onebot.self ? `（${s.onebot.self.nickname}）` : ''}` : '未连接'}</strong></span>
          <span class="muted">WS ${s.onebot?.error ? `：${s.onebot.error}` : ''}</span>
        </div>
        <div class="snowluma-state-row muted">
          <span>目录：${esc(dir || '（未找到项目内 snowluma/ 文件夹）')}</span>
        </div>
        <div class="snowluma-state-row">
          <span>WebUI：</span>
          ${webuiUrl
            ? `<button class="btn btn-small" id="sl-open-webui-btn" title="在浏览器中打开 SnowLuma 控制台">${esc(webuiUrl)}</button>`
            : '<span class="muted">等待 SnowLuma 启动后自动识别…</span>'}
        </div>
        ${onebotConnected ? '' : `
        <div class="snowluma-state-row" style="display:block;border-left:3px solid var(--orange);padding-left:10px;margin-top:6px">
          <div style="margin-bottom:4px"><strong>OneBot 没连上，按顺序做这三步：</strong></div>
          ${running ? `
          <div>① 先确认电脑上的 <strong>QQ 已经登录好</strong>（SnowLuma 是注入到已登录的 QQ 进程里，它自己不会登录 QQ）。</div>
          <div>② 点上面的 <strong>WebUI</strong> 按钮（${esc(webuiUrl || 'http://127.0.0.1:5099/')}），
               用<strong>访问密码</strong>登录 —— 首次安装的随机初始密码在下面「运行日志」里，
               标着 <code>★ WebUI 初始登录凭据</code>（<strong>只出现这一次，请先把日志往上翻到最早</strong>）。</div>
          <div>③ 登进去后在 <strong>「进程」</strong>页选那个已登录的 QQ 进程，点<strong>注入</strong>。
               注入成功后这里会自动变绿（<strong>不用重启</strong>；应用每 5 秒自己重试一次）。</div>
          ` : `
          <div>① 先点下面的「<strong>启动 SnowLuma</strong>」把网关起来。</div>
          <div>② 起来之后，电脑上的 QQ 要<strong>先登录好</strong>；然后点 <strong>WebUI</strong> 按钮用访问密码登录
               （首次安装的随机初始密码在下面「运行日志」里，标着 <code>★ WebUI 初始登录凭据</code>）。</div>
          <div>③ 在「<strong>进程</strong>」页选已登录的 QQ 进程并<strong>注入</strong>，注入成功后这里会自动变绿。</div>
          `}
          ${s.onebot?.error ? `<div class="muted" style="margin-top:4px">当前报错：${esc(s.onebot.error)}${
            String(s.onebot.error).includes('401')
              ? ' —— 401 通常表示<b>网关在跑但还没有已注入的 QQ 账号</b>，照上面三步走即可。'
              : ''}</div>` : ''}
          <div class="muted" style="margin-top:4px">日志只保留最近 500 行，会被群消息刷掉 ——
            <strong>首次安装请第一时间把日志翻到最早</strong>，把那个初始密码记下来（关闭后无法找回）。</div>
        </div>`}
        <div class="snowluma-actions">
          <button class="btn btn-primary" id="sl-start-btn" ${running ? 'disabled' : ''}>${running ? '已运行' : '启动 SnowLuma'}</button>
          <button class="btn btn-danger" id="sl-stop-btn" ${running ? '' : 'disabled'}>关闭 SnowLuma</button>
          <button class="btn btn-small" id="sl-refresh-btn">刷新状态</button>
          <button class="btn btn-small" id="sl-open-folder-btn">打开文件夹</button>
          <span id="sl-hint" class="muted" style="font-size:12px"></span>
        </div>
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
        <div>
          <div class="hint" style="margin-bottom:6px">运行日志（仅保留最近 500 行）</div>
          <pre class="snowluma-logs-view">${esc(logText)}</pre>
        </div>
      </div>`;

    // 恢复日志滚动：贴底跟随新日志；否则回到原阅读位置；首次渲染贴底
    const newPre = box.querySelector('.snowluma-logs-view');
    if (newPre) newPre.scrollTop = prevScroll ? (prevScroll.atBottom ? newPre.scrollHeight : prevScroll.top) : newPre.scrollHeight;

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

    $('#sl-start-btn').addEventListener('click', async () => {
      const btn = $('#sl-start-btn');
      btn.disabled = true; btn.textContent = '启动中…';
      $('#sl-hint').textContent = '';
      try {
        const r = await api('/api/snowluma/launch', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = r.alreadyRunning ? 'SnowLuma 已经在运行 ✓' : (r.ok ? '已启动，日志见下方。首次 QQ 登录需要几秒到几十秒。' : `启动失败：${r.error}`);
      } catch (e) {
        $('#sl-hint').textContent = `启动失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 2500);
    });
    $('#sl-stop-btn').addEventListener('click', async () => {
      const btn = $('#sl-stop-btn');
      btn.disabled = true; btn.textContent = '关闭中…';
      $('#sl-hint').textContent = '';
      try {
        await api('/api/snowluma/stop', { method: 'POST', body: '{}' });
        $('#sl-hint').textContent = '已请求关闭 SnowLuma。';
      } catch (e) {
        $('#sl-hint').textContent = `关闭失败：${e.message}`;
      }
      setTimeout(() => loadSnowlumaPage({ quiet: true }), 1500);
    });
    $('#sl-refresh-btn').addEventListener('click', () => loadSnowlumaPage());
    // 给白名单里的会话群发（范围可选：群聊 / 私聊 / 两者）。开机、关机是快捷按钮，另有自定义文本。
    for (const [btnId, text] of [['#sl-notify-on-btn', '开机'], ['#sl-notify-off-btn', '关机']]) {
      $(btnId).addEventListener('click', () => broadcastSend(text, btnId));
    }
    // 自定义内容框的实时字数：接口硬上限 200 字，超了直接被 400 拦下，所以提前说清楚
    const NOTIFY_MAX = 200;
    const syncNotifyCount = () => {
      const el = $('#sl-notify-text');
      const c = $('#sl-notify-count');
      if (!el || !c) return;
      const n = el.value.length;
      c.textContent = `${n} / ${NOTIFY_MAX}`;
      c.classList.toggle('over', n > NOTIFY_MAX);
      c.title = n > NOTIFY_MAX ? `超过 ${NOTIFY_MAX} 字，发不出去（接口上限）` : '';
    };
    $('#sl-notify-text').addEventListener('input', syncNotifyCount);
    syncNotifyCount();   // 还原草稿之后也要刷一次
    $('#sl-notify-send-btn').addEventListener('click', () => {
      const input = $('#sl-notify-text');
      const text = String(input?.value || '').trim();
      const h = $('#sl-notify-hint');
      const bad = (msg) => { if (h) { h.textContent = msg; h.style.color = 'var(--orange)'; } input?.focus(); };
      if (!text) return bad('先写点内容');
      // 超长必须自己拦：接口会 400，但这里的提示能说清"超了多少"
      if (text.length > NOTIFY_MAX) return bad(`超长 ${text.length - NOTIFY_MAX} 字（上限 ${NOTIFY_MAX}）—— 删掉一些再发`);
      broadcastSend(text, '#sl-notify-send-btn', { clearInput: true });
    });
    // ⚠️ 这里**不能**再让 Enter 直接发送：这是个多行输入框，Enter 是"换行"。
    //    改成 Ctrl+Enter / Cmd+Enter 发送（并在 placeholder 里写明）。
    $('#sl-notify-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#sl-notify-send-btn').click(); }
    });
    $('#sl-open-folder-btn').addEventListener('click', async () => {
      try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
      catch (e) { $('#sl-hint').textContent = `失败：${e.message}`; }
    });
    const webuiBtn = $('#sl-open-webui-btn');
    if (webuiBtn) webuiBtn.addEventListener('click', async () => {
      try {
        const r = await api('/api/snowluma/open-webui', { method: 'POST', body: '{}' });
        if (!r.ok) $('#sl-hint').textContent = r.error;
      } catch (e) {
        $('#sl-hint').textContent = `打开失败：${e.message}`;
      }
    });
  } catch (e) {
    if (!quiet) console.error(e);
  }
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
  box.innerHTML = state.chats.map((c) => {
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

  // 单日/24小时 → 隐藏"按天"
  const daysBlock = box.querySelector('[data-block="days"]');
  if (daysBlock) daysBlock.style.display = (stats?.mode === 'days') ? '' : 'none';

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
  const counts = state.proposalCounts || {};
  const pending = counts.pending ?? items.length;

  if (!items.length) {
    box.innerHTML = `<div class="proposal-head">
      <span class="proposal-title">改进提案</span>
      <span class="uc-tag">暂无待审</span>
    </div>
    <div class="hint" style="margin-bottom:10px">她可以在聊天里用 <code>submit_proposal</code> 提议改自己（记忆/人设/功能/底层都行）。
      提议只会出现在这里，<b>不会自动生效</b> —— 由你看过之后决定怎么做。</div>`;
    return;
  }

  const kindCls = { memory: 'ok', persona: 'warn', feature: 'info', code: 'err', other: '' };
  const card = (p) => {
    const when = p.at ? new Date(p.at).toLocaleString('zh-CN', { hour12: false }) : '';
    const from = p.fromChat ? `　来自 ${esc(p.fromChat)}` : '';
    return `<div class="proposal-card" data-id="${esc(p.id)}">
      <div class="proposal-card__head">
        <span class="proposal-kind ${kindCls[p.kind] || ''}">${esc(p.kindLabel || p.kind)}</span>
        <span class="proposal-card__title">${esc(p.title)}</span>
        <span class="spacer"></span>
        <span class="muted" style="font-size:11px">${esc(when)}${from}</span>
      </div>
      <div class="proposal-card__detail">${esc(p.detail)}</div>
      ${p.rationale ? `<div class="hint">理由：${esc(p.rationale)}</div>` : ''}
      <div class="proposal-card__foot">
        <span class="hint" style="margin:0">提案只是文字，勾选不会执行任何改动</span>
        <span class="spacer"></span>
        <button class="btn btn-small" data-proposal="rejected" data-id="${esc(p.id)}">不采纳</button>
        <button class="btn btn-small btn-primary" data-proposal="accepted" data-id="${esc(p.id)}">采纳（待办）</button>
      </div>
    </div>`;
  };

  box.innerHTML = `<div class="proposal-head">
      <span class="proposal-title">改进提案</span>
      <span class="uc-tag">待审 ${pending}</span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="proposal-refresh">刷新</button>
    </div>
    <div class="hint" style="margin-bottom:8px">这里只记她想改什么，<b>任何一项都不会被自动执行</b> ——
      采纳只是打个标记，真正动手由人来做（见 <code>src/proposals.js</code> 顶部）。</div>
    ${items.map(card).join('')}`;

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
    const r = await api('/api/proposals?status=pending');
    state.proposals = r.items || [];
    state.proposalCounts = r.counts || {};
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

  // 列表头的「显示空记忆」开关（常驻元素，只绑一次；状态记在 localStorage 里）
  const showEmptyBox = $('#mem-show-empty');
  if (showEmptyBox && !showEmptyBox.__bound) {
    showEmptyBox.__bound = true;
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
    const [mem, cfg] = await Promise.all([
      api(`/api/memory-files/${chatKey.replace(':', '_')}`),
      api('/api/config')
    ]);
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
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新记忆</button>
          <button class="btn btn-small btn-danger mem-del-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" ${canDel ? '' : 'disabled'} title="${delTitle}">删除</button>
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
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群记忆」让模型从聊天记录里提炼）。</div>'}
    `;
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
  // ⚠️ 必须在 innerHTML **之后**再读状态 —— loadProactiveStatus 是去查 DOM 元素再填内容的，
  //    放在 renderSettingsSection 里面（模板字符串求值阶段）时元素还没进 DOM，
  //    于是它查不到 #proactive-status、静默什么都不做（界面上就永远停在"正在读当前状态…"）。
  //    第一版就是这么写错的。
  if ((state.settingsSection || 'api') === 'chat') loadProactiveStatus();
}

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
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

function renderAllowSection(c) {
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="hint" style="margin-bottom:10px">白名单为空时机器人不会在任何群聊/私聊内运行。</div>
    <div class="field"><label>从 QQ 账号直接勾选</label>
      <div style="display:flex;gap:8px">
        <button class="btn btn-small" id="pick-groups-btn">选择群</button>
        <button class="btn btn-small" id="pick-friends-btn">选择好友</button>
        <span id="pick-result" class="muted" style="align-self:center"></span>
      </div></div>
    <div class="field-row">
      <div class="field"><label>允许的群号（逗号分隔）</label><input type="text" id="cfg-allowgroups" value="${esc((c.allow.groups || []).join(','))}" /></div>
      <div class="field"><label>允许的 QQ（逗号分隔）</label><input type="text" id="cfg-allowprivate" value="${esc((c.allow.private || []).join(','))}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allowallwhenempty" ${c.allowAllWhenEmpty === true ? 'checked' : ''} />
      <label for="cfg-allowallwhenempty">白名单留空时允许所有会话</label></div>
    <div class="hint">说明：勾选后，若上方两个列表都为空，机器人会在<b>所有</b>群聊和私聊中运行；只要填了任意一项，就只按名单过滤。</div>`;
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
 * 会话标题：群名（群号） / 群 群号 / 私聊 号
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return name ? `${name}（${m[1]}）` : `群 ${m[1]}`;
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`;
  return String(chatKey || '');
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
        ${['dark', 'light', 'system', '?'].map((t) => `
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
  const inputEl = $(isGroups ? '#cfg-allowgroups' : '#cfg-allowprivate');
  const selected = new Set(parseList(inputEl.value));
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
    inputEl.value = picked.join(',');
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

function parseList(s) {
  return String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

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
    patch.allow = {
      groups: parseList(val('#cfg-allowgroups', (c.allow?.groups || []).join(','))),
      private: parseList(val('#cfg-allowprivate', (c.allow?.private || []).join(',')))
    };
    patch.deny = { groups: [], private: [] };
    // 原先这里硬编码 false：只要点过保存就把该开关永久重置，
    // 而 UI 里根本没有输入控件 —— 只能手改 JSON，改完一保存就丢。改为读取复选框。
    const allowAllBox = $('#cfg-allowallwhenempty');
    patch.allowAllWhenEmpty = allowAllBox ? !!allowAllBox.checked : (c.allowAllWhenEmpty === true);
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
})();
