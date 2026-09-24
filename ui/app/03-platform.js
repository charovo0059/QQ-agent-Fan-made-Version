'use strict';
// 第 4/18 段：03-platform（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

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
