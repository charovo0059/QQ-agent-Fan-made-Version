'use strict';
// 第 20/20 段：19-proposals（2026-10-03 第三十五对话；加载顺序见 ui/index.html）
//
// 「改进提议」页 —— 她用 `submit_proposal` 提的改进想法（记忆 / 人设 / 功能 / 底层都能提）。
//
// ── 它从哪儿来 ──────────────────────────────────────────────────────────
//   原来固定挂在**印象页左栏顶部**（`#proposal-review`，2026-09-19 第七对话加的）。
//   用户 2026-10-03 拍板「bot 的提案也单开一页」⇒ 那两块（`renderProposalReview` / `loadProposals`）
//   整体搬到这里。⛔ 印象页里**不许**再渲染一份：两个家 = 两个真相，而且两处会各拉一次
//   `/api/proposals`（那种漂在界面上看不出来）。
//
// ── 边界（一个字都没改，别动）──────────────────────────────────────────
//   这一页**只展示 + 打标记，不执行任何提案内容**。
//   为什么坚持不自动执行（完整版见 `src/proposals.js` 顶部）：她的上下文里**混着群友说的话**，
//   而"待审条目本身"就是一条注入通道 —— 有人可以诱导她提一条看起来无害的改动，
//   再"管理员瞟一眼点同意"就能被利用。所以「采纳」只是打个标记、列进待办，真正动手由人来做。
//
// ── 与旧位置的一处结构差别（有意）──────────────────────────────────────
//   标题与「刷新」按钮从**块内**提到了页头（`.pagehead`）：页签已经叫「改进提议」，
//   块里再写一遍就是 UI 改造第二阶段条目 5 点名要删的那种"重复标签「改进提议（5）」"。
//   🔴 顺带避开一个坑：按钮提到**常驻的页头**之后，监听器**只能绑一次**（见 `loadProposalPage`）——
//      它原来住在每次 `innerHTML` 重建的块里，天然不会重复；搬出来不守就会"点一下刷新好几次"。

/** 已采纳那一栏的开合状态。
 *  成因（2026-09-26 第二十四对话，用户截图反馈）：「展开已采纳 → 点标记已实现 → 区块又自动折叠，
 *  想连着标几条得反复展开」。因为每次渲染都用 innerHTML 重建 `<details>`，不写 `open` 就回到默认折叠。
 *  ⚠️ 别改成"每次渲染都强制 open" —— 那样用户手动收起也无从保持。 */
let proposalAcceptedOpen = false;

/**
 * 拉提案（待审 + 已采纳）。
 * ⚠️ 2026-09-19 修：原来只拉 `status=pending` ⇒ **一采纳就从列表里消失**，用户问"采纳之后在哪看"
 *    时才暴露出这个洞。已实现(done)与不采纳(rejected)刻意不进列表：它们已归档，留着只会越来越长。
 */
async function loadProposals() {
  try {
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

/** 渲染提案块（只写 `#proposal-review`；页头与刷新按钮由 `loadProposalPage()` 建）。 */
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
      <span class="segchips"><span class="chip">待审<span class="n">0</span></span></span>
    </div>
    ${hintLine('她可以在聊天里提议改自己（记忆/人设/功能/底层都行），提议不会自动生效。',
      '她用 submit_proposal 提交，提议只会出现在这里，任何一项都不会自动执行；'
      + '「采纳」只是打个标记、列进待办，真正动手由人来做（见 src/proposals.js 顶部）。')}`;
    return;
  }

  // 已采纳那一栏默认折叠：这是"工单存档"，平时不占地方，但要能查得到。
  const acceptedHtml = accepted.length
    ? `<details class="proposal-accepted"${proposalAcceptedOpen ? ' open' : ''}><summary>已采纳（${accepted.length}）—— 列在待办里，改动由人来做</summary>
         ${accepted.map((p) => card(p, true)).join('')}
       </details>`
    : '';

  box.innerHTML = `<div class="proposal-head">
      <span class="segchips">
        <span class="chip${pending ? ' on' : ''}" title="还没处理的条数">待审<span class="n">${pending}</span></span>
        ${accepted.length ? `<span class="chip" title="已采纳、还没做完的条数">已采纳<span class="n">${accepted.length}</span></span>` : ''}
      </span>
    </div>
    ${hintLine('只记录想法，不会自动执行。',
      '采纳只是打个标记、列进待办，真正动手由人来做（见 src/proposals.js 顶部）。')}
    ${items.map((p) => card(p, false)).join('')}
    ${acceptedHtml}`;

  // 记住用户手动开合的状态（下一个 renderProposalReview 会照着它写 open）。
  // ⚠️ 只监听 `toggle` 这一个事件、只写变量：这里**不许**再调 renderProposalReview（会自激）。
  const accDetails = $('#proposal-review details.proposal-accepted');
  if (accDetails) accDetails.addEventListener('toggle', () => { proposalAcceptedOpen = accDetails.open; });
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

/** 切到「改进提议」页时调：建页头（**只一次**）+ 拉数据 + 渲染。 */
function loadProposalPage() {
  const page = $('#proposal-page');
  if (!page) return;
  if (!$('#proposal-review')) {
    page.innerHTML = `
      <div class="pagehead">
        <h3>改进提议</h3>
        <span class="muted" style="font-size:12px">她自己提的 · 只记录，不会自动执行</span>
        <span class="ph-spacer"></span>
        <button class="btn btn-small" id="proposal-refresh" title="重新拉一次（待审 + 已采纳）">刷新</button>
      </div>
      <div id="proposal-review" class="proposal-review"></div>`;
    // 🔴 监听器**只绑一次**：这个按钮住在常驻页头里，不像块内那些每轮重建的元素。
    //    不守的话每切一次页签就多一个监听 ⇒ "点一下刷新"发好几次请求（本项目踩过同族）。
    $('#proposal-refresh')?.addEventListener('click', () => {
      void loadProposals().then(() => renderProposalReview());
    });
  }
  void loadProposals().then(() => renderProposalReview());
}
