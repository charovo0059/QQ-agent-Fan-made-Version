'use strict';
// 第 10/18 段：09-memory-dreams（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

// ── 印象视图 ──
/**
 * 待审提案区（渲染进「印象」页顶部）。
 *
 * 设计边界：**只展示与打标记，不执行**。理由见 src/proposals.js 顶部（注入通道 + 无审核点）。
 * 位置选在印象页顶部而不是新开页签：提案里最多的就是"想改记忆与印象的方式"，
 * 放在印象旁边最容易被看到；也不必再写一个页面的骨架。
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
      + '提案里最多的就是"想改记忆与印象的方式"，所以放在印象页而不是新开页签。')}
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
    await loadProposals();   // 待审提案（印象页顶部那块）
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
    console.error('加载印象视图失败:', e);
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

  // 「显示空印象」开关 —— 2026-09-23（第十二对话，用户点名）**归位左栏列表头**。
  // ⚠️ 它现在是**常驻元素**（在 index.html 的 .list-head--row 里，`renderMemoryList` 只重绘
  //    `#memory-items`，碰不到它）⇒ 监听器**只能绑一次**，用 `__bound` 守住。
  //    它以前住在**每轮重建的详情区**里，那里必须每次重绑，还专门为此写过一段注释；
  //    迁回列表头之后那个坑自然消失了 —— 但守卫必须留着：本函数每 15 秒被调一次。
  const showEmptyBox = $('#mem-show-empty');
  if (showEmptyBox) {
    showEmptyBox.checked = state.showEmptyMemory === true;   // 同步状态（幂等，每次都可以做）
    if (!showEmptyBox.__bound) {
      showEmptyBox.__bound = true;
      showEmptyBox.addEventListener('change', () => {
        state.showEmptyMemory = showEmptyBox.checked;
        try { localStorage.setItem('dsh-mem-show-empty', showEmptyBox.checked ? '1' : '0'); } catch { /* ignore */ }
        renderMemoryList();
      });
    }
  }

  // 空印象（白名单里还没有印象的会话）默认不显示；手动隐藏过的同理。
  // 它们**不是文件**，删不掉 —— 印象页是按白名单生成的，删了下次渲染又长出来。
  const showEmpty = state.showEmptyMemory === true;
  const visible = files.filter((f) => {
    if (f.hidden) return showEmpty;          // 手动隐藏的：只在打开开关时出现
    if (f.empty && !showEmpty) return false; // 白名单里的空壳：默认折叠
    return true;
  });

  if (!files.length) {
    box.innerHTML = '<div class="list-head muted">还没有任何印象（等机器人记下之后才会出现）</div>';
    return;
  }
  if (!visible.length) {
    box.innerHTML = '<div class="list-head muted">这里没有任何有印象的会话。勾选上面的「显示空印象」可以看到白名单里那些还没有印象的。</div>';
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
      ? '正在整理本群印象'
      : (f.memberCount
        ? `${f.memberCount} 位群友 · ${f.impressionCount} 条印象`
        : (f.hidden ? '还没有印象（已隐藏）' : '还没有印象（空壳，删不掉）'));
    // 有印象 → 清空；空壳 → 隐藏 / 恢复隐藏
    const action = !f.empty
      ? `<button class="btn btn-small btn-danger mem-list-del" data-key="${esc(key)}" data-act="wipe" title="清空这个会话的印象">删除</button>`
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
 * 印象列表行上的操作。
 *   wipe   —— 有印象：清空（等价于详情页的「清空本群印象」）
 *   hide   —— 空壳：记进 config.memory.hiddenEmptyChats，列表里不再显示
 *   unhide —— 把隐藏的空壳放出来
 */
async function memoryListAction(act, chatKey) {
  if (!chatKey) return;
  const name = formatChatTitle(chatKey, chatNameOf(chatKey));
  const f = (state.memoryFiles || []).find((x) => x.chatKey === chatKey) || {};

  if (act === 'wipe') {
    confirmDanger({
      head: '清空本会话印象',
      okText: '清空',
      text: `<b>${esc(name)}</b> 的 <b>${f.memberCount || 0}</b> 位群友、<b>${f.impressionCount || 0}</b> 条印象将全部删除：
        <code>data/memory/${esc(chatKey.replace(':', '_'))}/</code> 整个目录连同整理备份一起删掉。<br><br>
        ⚠️ 聊天记录存档不受影响（那是另一个文件）。<br>此操作不可撤销。`,
      onOk: async () => {
        await api(`/api/memory-files/${chatKey.replace(':', '_')}`, { method: 'DELETE', body: '{}' });
        if (state.currentMemoryChatKey === chatKey) {
          state.currentMemoryChatKey = null;
          const detail = $('#memory-detail');
          if (detail) detail.innerHTML = '<div class="empty-hint">← 选择会话查看印象</div>';
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
      showNoticeModal('已隐藏这个空壳', `「${name}」本来就没有任何印象 —— 它出现在列表里，是因为它在白名单里（这是为了让你从列表点进去手动添加印象）。\n\n现在它不再占用列表位置。想找回来：勾选列表上方的「显示空印象」。\n\n注意：这不影响机器人在这个会话里工作；如果你是不想让它在这个群/私聊里干活，请去「白名单」页把它移除。`);
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
      // 只能走"清空本群印象"，这里把按钮禁掉并说明原因，别让用户点了没反应。
      const canDel = /^\d{1,15}$/.test(String(m.userId || ''));
      const delTitle = canDel
        ? '删除这个人的全部印象'
        : '这条印象没有 QQ 号（旧数据），请用右上角「清空本群印象」删除';
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
      //
      // 🔴 N3+N4（2026-09-24 第十三对话）：这里原来只写「✓ 已关联」，**不说是谁** ——
      //    用户原话"不知道关联了哪些群聊的哪些人"。现在把关联到的**每个人都印出来**
      //    （`某群友（微信 1000000001）`），并且每个自带一个 ✕ ⇒ **单条解除**。
      //    原来只有两条路：进弹窗取消勾选（可那次 bug 恰恰是看不到钩）、或「解除全部关联」（一刀切）。
      const chatPlat = state.chatPlatforms?.[chatKey] || 'qq';
      const myKey = `${chatPlat}:${m.userId}`;
      const linkedKeys = identityLinkedKeys(identMap, myKey);
      const chips = linkedKeys.map((k) => {
        const info = identityLabelOf(k);
        const where = info.chats.map((ck) => formatChatTitle(ck, chatNameOf(ck))).join('、');
        return `<span class="mem-link-chip" title="已关联：${esc(info.text)}${where ? `（出现在 ${esc(where)}）` : ''}">${esc(info.text)}`
          + `<button class="mem-link-x" data-key="${esc(k)}" title="只解除与这一个人的关联">✕</button></span>`;
      }).join('');
      const identLabel = canDel
        ? `${linkedKeys.length ? `<span class="muted" style="font-size:11px;margin-left:6px">已关联</span>${chips}` : ''}
           <button class="btn btn-small mem-ident-btn" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px"
             title="把这个人与别的会话里的某人标成「同一个人」，跨平台/跨会话认人才成立">${linkedKeys.length ? '改关联…' : '同一个人…'}</button>`
        : '';
      return `<div class="collapsible" open>
        <summary>${esc(who)}${qq}（${m.impressions.length} 条）
          <button class="btn btn-small mem-edit-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:8px">编辑</button>
          <button class="btn btn-small mem-refresh-imp" data-qq="${esc(m.userId)}" data-name="${esc(m.name)}" style="margin-left:6px" title="让模型重新分析这个人：有印象则整理合并，没印象则从聊天记录里提炼">更新印象</button>
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
        <h2>${esc(formatChatTitle(chatKey, chatNameOf(chatKey)))} 的印象</h2>
        <div class="sub">
          <span>每个群友一个文件：data/memory/${esc(chatKey.replace(':', '_'))}/&lt;QQ&gt;.json</span>
          <button class="btn btn-small" id="mem-add-imp-btn">＋ 添加印象</button>
          <button class="btn btn-small" id="mem-consolidate-btn" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理本群印象'}</button>
          <button class="btn btn-small btn-danger" id="mem-clear-btn" ${members.length ? '' : 'disabled title="这个会话还没有印象（它出现在列表里是因为在白名单里），没什么可清的"'}>清空本群印象</button>
          <span id="mem-share-status" class="muted"></span>
          ${consolidateStatusHtml}
        </div>
      </div>
      ${memInteropHtml(chatKey)}
      <!-- 「显示空印象」开关**已挪到左栏列表头**（2026-09-23 第十二对话，用户点名）。
           ⚠️ 这里不要再放第二个：全页只能有一个 #mem-show-empty —— 同名 id 会让
              $('#mem-show-empty') 静默只拿到第一个，第二个变成点不动的死件。 -->
      <div class="pt-sec">印象 <span class="muted" style="font-weight:400">这个会话记住的每个人</span></div>
      ${membersHtml}
      ${rows || '<div class="muted" style="padding:10px">还没有任何群友印象（可点右上角「＋ 添加印象」手动记，或点「整理本群印象」让模型从聊天记录里提炼）。</div>'}
    `;
    // 「印象互通」这一节：三个开关都**默认关**，改完立刻写 config（见 saveMemoryInterop）
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
    // N4 单条解除：成员行上每个关联对象自带 ✕，点它只解除那一个（不动同组其它人）
    $$('.mem-link-x', detail).forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();   // 点在 <summary> 里 ⇒ 不拦就会顺手把折叠面板收起来
        unlinkOneIdentity(String(el.dataset.key || ''), chatKey);
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
    // 针对单个群友更新印象：有印象→整理合并；无印象→从聊天记录提炼
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
          alert(`更新印象失败：${err.message}`);
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
          if (btn) { btn.disabled = false; btn.textContent = '整理本群印象'; }
          renderMemoryList();
        }
        // 成功时保持"整理中"，等 SSE 的 consolidate-done 事件来收尾
      } catch (e) {
        delete state.consolidating[chatKey];
        state.consolidateResult[chatKey] = { note: `失败：${e.message}`, at: Date.now(), failed: true };
        if (status) status.textContent = `失败：${e.message}`;
        if (btn) { btn.disabled = false; btn.textContent = '整理本群印象'; }
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
 * 「印象互通」设置区（印象页里那个折叠块）—— 2026-09-20 第九对话加。
 *
 * 三个开关的语义（都**默认关**，见 config.js 的 memory 段注释）：
 *   · 全互通          `memory.unified`        —— 忽略分组，所有会话一个池子（含 QQ↔微信）
 *   · 同一个人的印象   `memory.unifiedMembers` —— off / samePlatform / all
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
 *    （`工具-会话诊断\验-印象互通界面.mjs` / `验-新建互通组弹窗.mjs` / `验-印象互通会改配置的动作.mjs`）：
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
  // 方案要求："默认折叠为单行（▸ 印象互通 · 跨会话共享印象），**折叠态显示配置摘要**
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
    <summary>🔗 印象互通 <span class="mi-sum">${summaryText}</span></summary>
    <div class="mem-interop-body">
      <label class="mem-interop-row">
        <input type="checkbox" id="mem-unified" ${unified ? 'checked' : ''}>
        <b>全互通</b>
        <span class="mem-interop-note">所有会话一个池子（含 QQ ↔ 微信）；开了它就忽略下面的分组</span>
      </label>
      <label class="mem-interop-row">
        <b>同一个人的印象</b>
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
    //    印象页的状态行里）。这里先关再保存的话，失败时用户看不到任何提示 —— 与"按了没反应"同类。
    const okSaved = await saveMemoryInterop({ groups }, detail);
    if (!okSaved) { if (err) err.textContent = '保存失败，看印象页右上角的状态提示'; return }
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
 * 身份表里"和 myKey 是同一个人"的其它键（**不含** myKey 自己）。
 *
 * 抽成纯函数有两个理由：① 详情区与弹窗必须用**同一份判据**（两处各写一份必然漂移）；
 * ② 「关联了谁」这件事要能单测 —— 它就是 §51.4 那个 bug 的正中心。
 */
function identityLinkedKeys(identMap, myKey) {
  const person = String((identMap || {})[myKey] || '');
  if (!person) return [];
  return Object.keys(identMap).filter((k) => String(identMap[k]) === person && k !== myKey);
}

/**
 * 清掉"只剩一个人"的 person 组。
 *
 * 🔴 不变式：**身份表里不留单人组**。单人组等于没关联 —— 而线上那个 bug 的症状正是
 * "存下来了、重开却没有钩"（勾了同平台同号的项 ⇒ `next[myKey]` 与 `next[k]` 是同一个键
 * ⇒ 落盘只有一个键 ⇒ `linked` 必空，见 §51.4）。留着单个键只会让人以为关联成功。
 */
function pruneIdentitySingletons(identMap) {
  const count = {};
  for (const v of Object.values(identMap || {})) count[v] = (count[v] || 0) + 1;
  const out = {};
  for (const [k, v] of Object.entries(identMap || {})) if (count[v] >= 2) out[k] = v;
  return out;
}

/**
 * 算出"保存之后"的身份表（纯函数）：先解掉本人与**原本同一组**的所有键，再按 picked 重新成组。
 *
 * 为什么必须先整组解掉再重写（而不是逐个 delete 勾掉的）：用户取消一个勾时，
 * 我们要的是"这一组从现在起就是 picked 这些人"，而不是"在旧组上做增量"——
 * 增量会让旧组里没勾的人偷偷留着（正是"看不到钩"那类静默偏差）。
 *
 * @param newPersonId 原本没有 person 时用的新组号（由调用方生成 ⇒ 本函数保持纯、可测）
 */
function nextIdentityMap(identMap, myKey, picked, newPersonId) {
  const next = { ...(identMap || {}) };
  const person = String(next[myKey] || '');
  const group = person ? Object.keys(next).filter((k) => String(next[k]) === person) : [];
  delete next[myKey];
  for (const k of group) delete next[k];
  // 同键不算候选：`平台:id` 与本人都一样时它就是本人，写进去是空操作（§51.4 的根因）
  const picks = (picked || []).filter((k) => k && k !== myKey);
  if (picks.length) {
    const id = person || newPersonId;
    next[myKey] = id;
    for (const k of picks) next[k] = id;
  }
  return pruneIdentitySingletons(next);
}

/** 单条解除：只摘掉这一个键（同组其他人不动），同样不留单人组。 */
function removeIdentityKey(identMap, key) {
  const next = { ...(identMap || {}) };
  delete next[key];
  return pruneIdentitySingletons(next);
}

/**
 * 身份键 → 人话。用户要的是"关联了哪个群聊的哪个人"，所以名字与 id 都要给出。
 * 名字可能查不到（那个会话还没印象、或者人没昵称）⇒ 退回 id，绝不留空白。
 */
function identityLabelOf(key) {
  const raw = String(key || '');
  const m = /^([a-z]+):(.+)$/.exec(raw);
  const platform = m ? m[1] : 'qq';
  const userId = m ? m[2] : raw;
  let name = '';
  const chats = [];
  for (const c of (state.identityChats || [])) {
    for (const mm of (c.members || [])) {
      if (`${c.platform}:${mm.userId}` !== raw) continue;
      if (!name && mm.name) name = String(mm.name);
      if (!chats.includes(c.chatKey)) chats.push(c.chatKey);
    }
  }
  const platName = platform === 'wechat' ? '微信' : 'QQ';
  const who = name || userId;
  return { platform, userId, name: who, chats, text: `${who}（${platName} ${userId}）` };
}

/**
 * 从候选会话里剔掉"与 myKey 同键"的项（纯函数）。
 *
 * 🔴 N2（2026-09-24 第十三对话）：身份键是 `平台:id`、**不含会话** ⇒
 *    同一个平台同一个号**本来就是同一个人**。而候选原来把"同一个号在别的群里出现"
 *    也列成可勾选项 —— 它们的键与本人**一模一样** ⇒ 勾上等于把 myKey 又写一遍
 *    ⇒ 落盘只有一个键 ⇒ 重开弹窗 `linked` 必空 ⇒ **看不到钩，而且是静默的**
 *    （线上实证见 待办与决策记录 §51.4）。
 *    ⇒ 这类项不是"要不要关联"的问题，是**压根不该出现在候选里**；
 *      但**不能悄悄消失** —— 返回 `hiddenSameKey` 让界面把"为什么看不见它们"说清楚。
 *
 * @returns {{chats: Array, hiddenSameKey: number}}
 */
function identityCandidateChats(chats, chatKey, myKey) {
  let hiddenSameKey = 0;
  const out = (chats || [])
    .filter((c) => c.chatKey !== chatKey)
    .map((c) => ({
      ...c,
      members: (c.members || []).filter((mm) => {
        if (`${c.platform}:${mm.userId}` === myKey) { hiddenSameKey++; return false }
        return true
      })
    }))
    .filter((c) => c.members.length);
  return { chats: out, hiddenSameKey };
}

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
  const identMap = (state.config?.memory?.identity) || {};
  const myPlat = state.chatPlatforms?.[chatKey] || 'qq';
  const myKey = `${myPlat}:${uid}`;

  // 当前已关联到哪些（同一 person 值的其它键）
  const linked = identityLinkedKeys(identMap, myKey);

  // 🔴 N2（2026-09-24 第十三对话）：**把"与自己同键"的项从候选里剔掉**，并说明理由。
  //    判据与理由见 identityCandidateChats() 的注释（线上那个"看不到钩"的 bug 就在那里）。
  const { chats, hiddenSameKey } = identityCandidateChats(state.identityChats || [], chatKey, myKey);

  const rows = chats.length
    ? chats.map((c) => {
      const opts = c.members.map((mm) => {
        const k = `${c.platform}:${mm.userId}`;
        const on = linked.includes(k);
        // 「还没有印象」与"0 条"必须分开说：前者是"从没整理过这个人"
        // （候选来自白名单/微信联系人表，见 /api/memory-identity），后者是真的 0 条。
        const meta = mm.noImpression
          ? '<span class="muted" style="font-size:11px;white-space:nowrap">还没有印象</span>'
          : `<span class="muted" style="font-size:11px;white-space:nowrap">${mm.count} 条</span>`;
        return `<label style="display:flex;align-items:center;gap:8px;padding:3px 0">
          <input type="checkbox" class="id-pick" value="${esc(k)}" ${on ? 'checked' : ''}>
          <span>${esc(mm.name || mm.userId)}</span>
          <span class="muted" style="font-size:11px;white-space:nowrap">${esc(k)}</span>
          ${meta}
        </label>`;
      }).join('');
      return `<details style="margin:4px 0">
        <summary style="cursor:pointer">${esc(formatChatTitle(c.chatKey, chatNameOf(c.chatKey)))} <span class="muted">（${esc(c.platform)}，${c.members.length} 人）</span></summary>
        <div style="padding:4px 0 4px 16px">${opts}</div>
      </details>`;
    }).join('')
    : '<div class="muted">别的会话里还没有可以关联的人。<br>候选来自：有印象的成员 · 白名单里的私聊 · 微信联系人表（没印象的人也在）。</div>';

  const overlay = modelModalShell({
    head: `同一个人：${member?.name || uid}`,
    body: `
      <div class="hint">本会话这个人：<b>${esc(member?.name || uid)}</b>
        <span class="muted">${esc(myKey)}</span></div>
      <div class="hint" style="margin-top:6px">
        勾上<b>别的会话里属于同一个真人</b>的条目。勾选后，两边的印象会互相看见（受「印象互通」里的
        「同一个人的印象」开关控制）。<br>
        ⚠️ <b>只勾真的是同一个人的</b> —— QQ 与微信的数字 id 会撞号，勾错等于把两个人合并。
      </div>
      ${hiddenSameKey ? `<div class="hint" style="margin-top:6px" id="id-hidden-note">
        已自动隐藏 <b>${hiddenSameKey}</b> 个「同一个平台 + 同一个号」的条目 ——
        它们与本人是<b>同一个身份键</b>（身份键只到"平台:号"，不含会话），列出来勾了也是空操作。
      </div>` : ''}
      <div style="max-height:300px;overflow:auto;margin-top:8px;border:1px solid var(--line,#333);border-radius:6px;padding:6px">
        ${rows}
      </div>
      <div class="hint" id="id-err" style="color:var(--orange)"></div>`,
    foot: `${linked.length ? '<button class="btn btn-danger" id="id-unlink">解除全部关联</button>' : ''}
           <button class="btn" id="id-cancel">取消</button>
           <button class="btn btn-primary" id="id-save">保存</button>`
  });

  overlay.querySelector('#id-cancel').addEventListener('click', () => closeModelModal(overlay));

  /** 把"本会话这个人 + 勾选的其它 id"写成身份表（幂等：先清掉这一组再重写）。 */
  const applyIdentity = async (picked) => {
    const fresh = await api('/api/config');
    const cur = (fresh.memory && fresh.memory.identity) || {};
    // 分组逻辑抽在 nextIdentityMap 里（纯函数、可单测）—— 它保证"不留单人组"，
    // 而"单人组"正是那个静默空操作 bug 的产物。
    const next = nextIdentityMap(cur, myKey, picked, `p_${Date.now().toString(36)}`);
    await writeIdentity(next);
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
 * 把整张身份表写回去。
 *
 * ⚠️ 必须用 `__replace__` 整体替换：普通深合并**删不掉已有键** ⇒「解除关联」会静默无效。
 * ⚠️ **空表也要能写**（`{ __replace__: {} }`）—— 解到最后一对时必须真的清干净，
 *    留一个单人组就是本文件要根除的那种"看着成功其实没关联"。
 */
async function writeIdentity(next) {
  await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ memory: { identity: { __replace__: next || {} } } })
  });
}

/**
 * 单条解除：只把这个身份键从身份表里摘掉，同组其它人不动。
 *
 * 🔴 N4（2026-09-24 第十三对话）：用户已选"要单条解除"。
 *    原来只有两条路 —— ① 进弹窗把某个勾取消（但那次 bug 恰恰是"看不到钩"，无从取消）、
 *    ② 「解除全部关联」（一刀切，误伤太大）。现在成员行上每个关联对象自带 ✕。
 */
async function unlinkOneIdentity(key, chatKey) {
  const k = String(key || '').trim();
  if (!k) return;
  try {
    // 现取现用：身份表是整体替换，拿缓存里的旧表算 next 会把别处刚加的关联抹掉
    const fresh = await api('/api/config');
    const cur = (fresh.memory && fresh.memory.identity) || {};
    await writeIdentity(removeIdentityKey(cur, k));
    state.config = await api('/api/config');
    await loadMemoryDetail(chatKey);
    await loadMemoryView();
  } catch (e) {
    alert(`解除关联失败：${e.message}`);
  }
}

/**
 * 保存某个 QQ 号的「跨会话印象互通」方向。
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
    showNoticeModal('无法删除', '这条印象没有 QQ 号（早期按名字落文件的旧数据），只能用右上角的「清空本群印象」删除。');
    return;
  }
  const cfg = state.config || {};
  const who = (cfg.memberNotes || {})[userId] || name || userId;
  confirmDanger({
    head: '删除群友印象',
    okText: '删除',
    text: `将删除 <b>${esc(who)}</b>（QQ ${esc(userId)}）在本群的<b>全部印象</b>。<br><br>
      机器人之后不会再记得这些印象 —— 除非以后重新整理印象又把它总结出来。<br><br>
      此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, { method: 'DELETE', body: '{}' });
      await loadMemoryView();
    }
  });
}

/**
 * 清空某个会话的全部印象。
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
    head: '清空本群印象',
    okText: '清空',
    text: `<b>${esc(name)}</b> 的 <b>${n}</b> 位群友、<b>${imps}</b> 条印象将全部删除。<br><br>
      磁盘上这些都会被删掉：<br>
      · <code>data/memory/${dir}/</code>（每个群友一个文件）<br>
      · <code>data/memory/backups/${dir}/</code>（整理前的自动备份）<br><br>
      ⚠️ 聊天记录存档是另一个文件，不受影响 —— 要清去「存档」页。<br>
      ${state.consolidating[chatKey] ? '<b style="color:var(--red)">本群正在整理印象：建议等整理结束再清空，否则整理结果可能又写回来。</b><br><br>' : ''}
      此操作不可撤销。`,
    onOk: async () => {
      await api(`/api/memory-files/${chatKey.replace(':', '_')}`, { method: 'DELETE', body: '{}' });
      state.currentMemoryChatKey = null;
      delete state.consolidating[chatKey];
      delete state.consolidateResult[chatKey];
      const detail = $('#memory-detail');
      if (detail) detail.innerHTML = '<div class="empty-hint">← 选择会话查看印象</div>';
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
      <div class="hint">保存后，聊天记录、印象、群成员列表都会优先显示这个备注；留空则显示原群名片/昵称。</div>`,
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
