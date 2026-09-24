'use strict';
// 第 6/18 段：05-status-sse（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）


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
