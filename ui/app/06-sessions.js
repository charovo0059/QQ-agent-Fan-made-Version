'use strict';
// 第 7/18 段：06-sessions（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

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

/**
 * 折叠时显示最后几行（🆕 2026-09-23 第十二对话，用户点名："给运行日志加个折叠和滑条，
 * 折叠的时候只显示部分日志"）。取 3：够看出"最近在发生什么"，又不占地方。
 * ⚠️ 裁剪在 `apply()` 里做（不是 CSS 的 `overflow:hidden`）——
 *    因为要留的是**最后** N 行，而 CSS 裁切只会留下**最前** N 行。
 */
const LOGPANEL_COLLAPSED_ROWS = 3;

/** LogPanel 的静态骨架（页头工具 + 空的日志体）。 */
function logPanelShell(title, idPrefix, opts = {}) {
  const tabs = [['all', '全部'], ['key', '关键'], ['warn', '警告'], ['error', '错误']]
    .map(([v, label]) => `<span class="chip${v === 'all' ? ' on' : ''}" data-logtab="${v}">${label}</span>`).join('');
  // ⚠️ 初始就带 `is-collapsed`（默认折叠），初始文案是「展开」—— 与 JS 侧的
  //    `box.__collapsed = box.classList.contains('is-collapsed')` 成对，别只改一边。
  return `<div class="logpanel is-collapsed" id="${idPrefix}">
    <div class="logpanel-head">
      <span class="logpanel-title">${esc(title)}</span>
      <span class="logpanel-tabs">${tabs}</span>
      <span class="logpanel-spacer"></span>
      <input class="logpanel-search" type="search" placeholder="搜索日志" aria-label="搜索日志" data-logsearch>
      <button class="btn btn-small" data-logact="noise" title="折叠连续重复的噪音行">噪音</button>
      <button class="btn btn-small" data-logact="scroll" title="有新日志时自动滚到底部">自动滚动</button>
      <button class="btn btn-small" data-logact="copy">复制</button>
      <button class="btn btn-small btn-quiet" data-logact="clear">清空</button>
      <button class="btn btn-small" data-logact="fold" title="折叠 / 展开日志区（折叠时只看最后 ${LOGPANEL_COLLAPSED_ROWS} 行）">展开</button>
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
  // 折叠态默认**折叠**（见 logPanelShell 里初始的 `is-collapsed`，两边必须一致）
  box.__collapsed = box.classList.contains('is-collapsed');
  const syncFoldBtn = () => {
    const b = box.querySelector('[data-logact="fold"]');
    if (!b) return;
    // 按钮上写的是"点一下会发生什么"，不是当前状态（点了才知道往哪走）
    b.textContent = box.__collapsed ? '展开' : '收起';
    b.classList.toggle('on', !box.__collapsed);
  };
  syncFoldBtn();

  const apply = () => {
    const body = box.querySelector('[data-logbody]');
    if (!body) return;
    const q = box.__search;
    const rows = Array.from(body.querySelectorAll('.logrow'));
    // ── 第一遍：算"本该显示"的集合（档位 + 搜索）──
    // ⚠️ 这一份**与折叠无关**，`复制` 按它走：折叠只是"少显示几行"，
    //    不该把"复制"也变成只复制 3 行（那是个很容易踩的坑）。
    const shows = rows.map((row) => {
      const lvl = row.dataset.lvl || 'info';
      let show = true;
      // 档位：key 档连 error 一起显示（关键行常伴随报错，分开看反而漏）；
      // warn 档显示 warn+error+key；error 档只显示 error+key。这样"越往上越全"。
      if (box.__filter === 'key') show = lvl === 'key' || lvl === 'error';
      else if (box.__filter === 'warn') show = lvl !== 'info';
      else if (box.__filter === 'error') show = lvl === 'error' || lvl === 'key';
      if (show && q) show = row.textContent.toLowerCase().includes(q);
      return show;
    });
    box.__shows = shows;
    // ── 第二遍：折叠时只留**末尾 N 条**本该显示的 ──
    const keep = new Set();
    if (box.__collapsed) {
      let n = 0;
      for (let i = rows.length - 1; i >= 0 && n < LOGPANEL_COLLAPSED_ROWS; i--) {
        if (shows[i]) { keep.add(i); n++; }
      }
    }
    rows.forEach((row, i) => { row.style.display = (shows[i] && (!box.__collapsed || keep.has(i))) ? '' : 'none'; });
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
    } else if (kind === 'fold') {
      box.__collapsed = !box.__collapsed;
      box.classList.toggle('is-collapsed', box.__collapsed);
      syncFoldBtn();
      apply();
    } else if (kind === 'copy') {
      const body = box.querySelector('[data-logbody]');
      const rows = body ? Array.from(body.querySelectorAll('.logrow')) : [];
      // ⚠️ 按 `__shows`（档位+搜索的结果）复制，**不按 `display`** ——
      //    折叠时 display 只剩 3 行，照它复制会让人以为日志丢了。
      const shows = box.__shows || rows.map((r) => r.style.display !== 'none');
      const text = rows.filter((r, i) => shows[i]).map((r) => r.textContent).join('\n');
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
 * 组件 5：Gate —— 连接门控（**只出引导条**，`class="gate"` 由调用方的常驻容器自己带）。
 *
 * 方案原则 4：依赖通道连通的操作（群发、联系人放行等），未连通时**整区禁用** +
 *    「去完成连接引导」链接，连通后自动解锁。
 *
 * ⚠️ 配套的两条 CSS 都要求**直接父子**，所以调用方必须满足这个结构：
 *      <div id="xxx" class="gate">        ← 常驻容器自己带 `gate`（+ 运行时 toggle `locked`）
 *        <div class="gate-inner">…控件…</div>
 *        …gateBarHtml(…) 的输出…
 *      </div>
 *    · `.gate.locked > .gate-inner { opacity:.5; pointer-events:none }`（未连通 ⇒ 整区不可点）
 *    · `.gate:not(.locked) > .gate-bar { display:none }`（已连通 ⇒ **引导条隐藏**）
 *
 * 🔴 2026-09-22（第十一对话 · 代码洁净日）这里原来是个 `gateWrap(html, {...})`，
 *    它自己造 `<div class="gate">` 外壳 —— 而唯一需要门控的地方（SnowLuma 的群发块）
 *    要求外壳是**常驻元素 `#sl-notify-block`**（那块不随 15 秒轮询重建），
 *    `gateWrap` 表达不了 ⇒ 于是那一页**手抄了一份 inner+bar**，`gateWrap` 从此没人调用。
 *    后果是**两条 CSS 规则一起失效**（全 app 再没有任何地方发出 `gate` 类）：
 *      · 未连通时**没禁用**（inner 一直可点 ⇒ 点了必失败，正是方案说的现状问题）；
 *      · 已连通时**引导条没隐藏**（真机实测：已连上的状态下仍显示"未连接，不可用 —— 先把上面的三步走完"）。
 *    真机对照实验（手动补上 `gate` 类）：bar 立刻 `display:none`、再加 `locked` 后 inner 立刻
 *    `pointer-events:none` ⇒ **CSS 是对的，缺的只是那个类**。
 *    ⇒ 收敛成"只出 bar"的纯函数 + 调用方容器带 `gate` 类，两边都能用，且不再有第二份手抄。
 *    ⚠️ 锁定用**类**而不是 `disabled` 属性 —— 整区里有 input/select/button 多种控件，
 *      逐个加 disabled 容易漏（漏了就出现"未连接却可点、点了必失败"）。
 *    ⚠️ 引导链接**永远可点**：它在 `.gate-bar` 里，不在被禁用的 `.gate-inner` 里。
 */
function gateBarHtml(guideText, guideTab) {
  return `<div class="gate-bar"><span>${esc(guideText || '需要先完成连接')}</span>`
    + `<span class="gate-go" data-goto-tab="${esc(guideTab || 'snowluma')}" role="button" tabindex="0">去完成连接引导 →</span></div>`;
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

/**
 * 长文本折叠块（系统提示 / 本次输入）的**底部收起**入口。
 *
 * 🆕 2026-09-23（第十二对话，用户点名）：这两块展开后各几千字符，
 * 翻到底想收起时得再滚回顶部点 summary —— 所以在内容末尾也放一个收起入口。
 *
 * ⚠️ 它必须是 `button` 而**不是** `summary`：`<details>` 只认第一个 `<summary>` 做开关，
 *    把第二个 `summary` 放到内容末尾会被浏览器当成"摘要区的一部分"，
 *    后面所有兄弟节点都会变成它的点击范围（内容被吞进标题里）。
 *    ⇒ 收起动作由 `renderSessionDetail` 末尾统一挂（那里能一次拿到 details 本体）。
 * 样式与顶部 `summary.pt-sec` 同族，见 style.css 的 `.pt-fold-foot`。
 */
function foldFootHtml(label) {
  return `<button type="button" class="pt-fold-foot" data-fold-close="1">`
    + `<span class="chev">▴</span>收起${esc(label)}</button>`;
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
            ${foldFootHtml('系统提示')}
          </div>
        </details>`);
    }
    if (s.userPrompt) {
      // ⚠️ 2026-09-23（第十二对话，用户点名）：**默认折叠**。
      //    原来这里带 `open` ⇒ 一进会话详情就被几千字符的输入铺满整屏，
      //    真正想先看的（触发/时间/模型/用量/过程）反而被顶到屏幕外。
      html.push(`
        <details class="collapsible pt-fold">
          <summary class="pt-sec"><span class="chev">▸</span>本次输入
            <span class="m">${s.userPrompt.length} 字符 —— 零对话历史，全部来自 JSON 存档</span></summary>
          <div class="pt-code">
            <div class="pt-code-head"><span>text</span><span class="pt-tag grey">${s.userPrompt.length} 字符</span></div>
            <pre>${esc(s.userPrompt)}</pre>
            ${foldFootHtml('本次输入')}
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
  // 底部「收起」入口要自己关所属的 details（它是 button 不是 summary，见 foldFootHtml 的注释）。
  // ⚠️ 必须挂在**重渲染之后**的新 DOM 上 —— 上面那句 innerHTML 把旧节点全换掉了，
  //    在渲染前挂等于挂在已经不在页面上的元素上（症状是"按钮点了没反应"，不报错）。
  detail.querySelectorAll('[data-fold-close]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const d = b.closest('details.pt-fold');
      if (!d) return;
      d.open = false;
      // 收起后这一块的高度骤减，别让人停在"半空"里：把折叠标题滚回可视区
      d.scrollIntoView({ block: 'nearest' });
    });
  });
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
