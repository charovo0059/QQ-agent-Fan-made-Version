'use strict';
// 第 12/18 段：11-wechat-page（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

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
  // 🆕 2026-09-27（第二十七对话）：「↻ 同步名字」——去微信那边现问一次名字表。
  //    为什么要有它：名字原来只在入站消息里学 ⇒ 在微信里改了备注，要等那个人下次发消息界面才变。
  //    ⚠️ 这个按钮**不在** `box`（#wx-contact-list）里面 —— 本函数重画时只换 box 的 innerHTML，
  //       按钮不会被重建 ⇒ 用 dataset 标记**防重复绑定**（整页重渲染后按钮是新的，标记跟着没，会重绑）。
  const syncBtn = $('#wx-contacts-sync');
  if (syncBtn && !syncBtn.dataset.bound) {
    syncBtn.dataset.bound = '1';
    syncBtn.addEventListener('click', async () => {
      const hint = $('#wx-contacts-sync-hint');
      syncBtn.disabled = true;
      if (hint) hint.textContent = '正在问微信那边要名字…';
      try {
        const r = await api('/api/wechat-contacts/sync', { method: 'POST' });
        if (hint) {
          hint.textContent = r.ok
            ? `已同步：新增 ${r.added}、改名 ${r.renamed}、没变 ${r.unchanged}（共 ${r.rows} 条）`
            : `没同步成：${r.error || '未知原因'}（旧名字原样保留）`;
        }
        await loadWechatContacts();     // 列表里的名字要跟着变
      } catch (e) {
        if (hint) hint.textContent = `同步失败：${e.message}`;
      } finally {
        syncBtn.disabled = false;
      }
    });
  }
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
  // 🆕 2026-09-26（第二十二对话）：用户要求「微信页也做成和 SnowLuma 页一样居中的、被框起来的样式」。
  // 做法就是把整页包进**同一个**卡片容器（`.snowluma-page-card`）—— 与原型的写法一致
  // （`ui/index.prototype.html:809` 就是 `<div class="snowluma-page-card" style="gap:0">`），
  // 当时只是没落到真 UI。⛔ 不要在这里另写一套"卡片"样式：两个通道页共用同一条规则，
  //    复刻第二份必然与 SnowLuma 页漂移（而漂移的表现就是"两页看着差不多、其实不一样"）。
  // ⚠️ `gap:0`：本页各块**自己带外边距**（页头/分步器/折叠区/日志各有各的间距），
  //    再叠一层卡片 gap 会与 SnowLuma 页的观感不一致（原型也是 gap:0）。
  // ⚠️ 外层 div 只是容器：**里面所有 id 一个都没动**（`#wx-status` / `#wx-log-wrap` / `#wx-autostart`
  //    这几个是 loadWechatPage、LogPanel、SSE 与判据的锚点）。
  return `
    <div class="snowluma-page-card" style="gap:0">
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
      <div id="wx-log-wrap"></div>
    </div>`;
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

/**
 * 一行日志的时间戳：**只在正文没自带同款前缀时**才补一个。
 *
 * ℹ️ 2026-10-03（第三十七对话 · 交接 §3-65 改动点 ①，K3 看截图发现的）：
 *    原来这一行无条件拼 `[HH:MM:SS] ${l.text}`，而桥/中继写进 `l.text` 的正文**本身就带两层**
 *    时间戳（实测原文：`[16:23:48] [Bridge]  [16:23:48] [bridge:info] [OB11] …`）
 *    ⇒ 界面上一行里同一个时刻出现 **3 次**，读日志先被时间戳糊住。
 *    这里消掉的是"**前端又加的那一层**" ⇒ 渲染后是 **2 次**。
 *    ⛔ 正文**中段**那一层是桥自己的格式（`工具-中继\*.py`），不归渲染层管 ——
 *       要只剩 1 次得改桥，**不在本轮范围**（K3 §2 ① 明说）。
 * ⚠️ 抽成纯函数是因为判据要把它抠进沙箱真跑（`测试-现行\test-微信日志时间戳去重.mjs`）。
 */
function dedupeLogTimestamp(at, text) {
  const t = new Date(at).toLocaleTimeString('zh-CN', { hour12: false })
  const tag = `[${t}]`
  const s = String(text == null ? '' : text)
  return s.startsWith(tag) ? s : `${tag} ${s}`
}

/** 把微信通道日志行渲染成 LogPanel 的分级行。 */
function logRowsHtml(logs) {
  if (!logs || !logs.length) {
    return '<div class="logpanel-empty">（还没有日志：通道还没由本应用启动过，或者你是在外面的窗口里跑的）</div>'
  }
  const text = logs.map((l) => dedupeLogTimestamp(l.at, l.text)).join('\n')
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
