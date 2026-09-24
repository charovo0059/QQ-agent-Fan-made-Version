'use strict';
// 第 5/18 段：04-skills（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

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
      <div class="skill-modal__note">共 <b>${keys.length}</b> 项设置 · 保存在 <code>${esc(skill.configPath || `config.skills['${skillId}']`)}</code>，只有这个扩展会读到它们。</div>
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

  // 少数扩展还有「动作区」（不是配置字段，通用表单渲染不了）—— 见 SKILL_ACTION_PANELS
  const panel = SKILL_ACTION_PANELS[skillId];
  const actionsHtml = panel ? panel.html(skill) : '';
  // 这些字段真正落在哪个配置键下：默认 `config.skills[<id>]`；
  // 被后端覆盖的（本子查询）显示**真实的那个键** —— 否则用户照提示去 config.json 里找不到。
  const savePath = skill.configPath || `config.skills['${skillId}']`;

  host.hidden = false;
  host.innerHTML = `<div class="skinline">
    <div class="skinline-head">
      <b>${esc(skill.name)}</b> <span class="muted">配置</span>
      <span class="ph-spacer"></span>
      <span class="muted" style="font-size:12px">改动即时生效，无需重启</span>
    </div>
    ${bodyHtml}
    ${actionsHtml}
    <div class="skinline-foot">
      <span class="muted" style="font-size:12px">保存在 <code>${esc(savePath)}</code></span>
      <span class="ph-spacer"></span>
      <button class="btn btn-small" id="skinline-cancel">取消</button>
      <button class="btn btn-primary" id="skinline-save">保存</button>
    </div>
  </div>`;
  // ⚠️ 动作区的接线必须在**节点已经进 DOM 之后**：它按全局 id 取元素
  //    （全页同时只展开一个配置表单，见上面"收起别的卡片"那段）。
  if (panel) panel.bind(skill);
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
