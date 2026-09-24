'use strict';
// 第 18/18 段：17-init（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

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

