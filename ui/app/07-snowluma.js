'use strict';
// 第 8/18 段：07-snowluma（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

/**
 * 三步引导的**第一句**：按 `hookAutoLoad` 的**实际值**说人话；`''` = 不用提示。
 *
 * 🔴 为什么要说这一句（2026-09-26 第二十三对话 · 交接 §3 待办 27 / 决策记录 §82.3）：
 *    `hookAutoLoad`（"发现 QQ 进程就自动注入"）**不随我们的仓库走** ——
 *    `snowluma/config/` 在 `.gitignore` 里 ⇒ 换机器/重装后它可能变回默认，而症状是
 *    "**应用起来了、WebUI 也在、就是连不上**"（`/api/status` 给
 *    `snowluma.lastError = ECONNREFUSED 127.0.0.1:3001` + `injected=false`）。
 *    以前这件事只写在文档里、靠人记；现在界面自己在"重启后不会自动注入"时说出来。
 *
 * ⚠️ **三种取值说三句不同的话**，⛔ 不许把 `null`（读不到）说成 `false`（明确关掉了）：
 *    · `true`  → 不提（自动注入开着，提了只是吵）
 *    · `false` → "重启后**不会**自动注入（hookAutoLoad=false）"
 *    · `null`  → "**读不到** hookAutoLoad…无法确认重启后会不会自动注入"
 *    `injected === true`（已经连通）时一律不提。
 * 抽成纯函数是为了判据能**抠进沙箱真跑**（三种取值各说各的话、且不许混口径）。
 */
function hookAutoLoadHint(hookAutoLoad, injected) {
  if (injected) return '';                 // 已经连通了，不用再提
  if (hookAutoLoad === true) return '';    // 开着，不提
  if (hookAutoLoad === false) {
    return '⚠️ 重启后不会自动注入（hookAutoLoad=false）—— 跑一次 node 工具-运维\\开-SnowLuma自动注入.mjs 即可一劳永逸。';
  }
  return '⚠️ 读不到 hookAutoLoad（snowluma/config/runtime.json）—— 无法确认重启后会不会自动注入；跑一次 node 工具-运维\\开-SnowLuma自动注入.mjs 即可一劳永逸。';
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
      ${gateBarHtml('未连接，不可用 —— 先把上面的三步走完。')}`;

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
    // 🆕 待办 27：`true` / `false` / `null`（读不到）——**三态**，别把 null 当 false 用。
    const slHookAutoLoad = s.snowluma?.hookAutoLoad;
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
        ${hintLine(hookAutoLoadHint(slHookAutoLoad, slInjected) || '三步走完就能连通；第 3 步在 WebUI 的「进程」页里做。',
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
      <div id="sl-notify-block" class="gate">${notifyBlockHtml}</div>
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
