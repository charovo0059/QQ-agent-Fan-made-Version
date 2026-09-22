// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Windows 上部分显卡驱动会导致渲染进程黑屏；禁用硬件加速是最稳妥的修复
app.disableHardwareAcceleration();

// ── 真机调试端口（2026-09-22 第十对话加）──────────────────────────────────
// 为什么需要：本项目所有"界面快不快"的测量**一直是在 Edge 里做的**，而 Edge 有 GPU 加速、
//   这个应用没有（上一行就关掉了）⇒ 量出来的数字与用户实际感受**不是一个程序**。
//   实测差距：同一页面同一尺寸，浏览器里 69 层毛玻璃只花 ~11ms/帧，
//   而软件合成下同样这些东西是实打实的 CPU 像素运算（还是 1.5 倍缩放）。
//   ⇒ 要判断"卡不卡"，必须能连进真机窗口量。
//
// 两种开法，**参数优先**：
//   ① 命令行：  & "QQ Agent.exe" --qq-agent-debug-port=9222
//   ② 环境变量：$env:QQ_AGENT_DEBUG_PORT=9222; & "QQ Agent.exe"
//   ⚠️ 为什么要两种：环境变量在"由另一个 node 进程 spawn 出来"这条路上**实测不可靠**
//      （本轮踩到：同一个脚本第一次带起来了、重启那次就没带起来，且现象是静默的
//       —— 端口不监听而已，应用一切正常）。命令行参数没有这个问题。
//
// 用法：设了才开，**默认不影响任何行为**：
//   然后 node "工具-设计改造\探页面.mjs" --url=http://127.0.0.1:3210/ --port=9222 --real …
// ⚠️ 不要无条件打开：远程调试端口等于把渲染进程的完全控制权暴露在本机端口上。
{
  const fromArg = (process.argv.find((a) => a.startsWith('--qq-agent-debug-port=')) || '').split('=')[1]
  const fromEnv = process.env.QQ_AGENT_DEBUG_PORT
  const p = Number(fromArg || fromEnv)
  if (Number.isFinite(p) && p > 0) {
    app.commandLine.appendSwitch('remote-debugging-port', String(p));
    console.log(`[debug] 远程调试端口已开：${p}（来源：${fromArg ? '命令行参数' : '环境变量'}）`);
  }
}

// ── 数据目录解析（2026-09-18 重做：**默认移到安装目录之外**）──
//
// 🔴 为什么必须移出安装目录（三轮实测的结论，别再改回去）：
//   electron-builder 的**旧卸载器**在覆盖安装时先跑，并且**无条件** `RMDir /r $INSTDIR`
//   （uninstaller.nsh:187），而升级时文件内容一致会让它短路 —— 也就是说
//   "会不会删"取决于版本差异，行为不可预测。我们试过在安装器钩子里抢时间：
//     · `.onInit`（customInit）阶段 `$INSTDIR` **还是默认值**，拿不到真实安装目录
//     · `customInstall` 太晚（数据已被删）
//     · `customHeader` 插在顶层，**不能放命令**（构建直接失败）
//   ⇒ 结论：**不要跟卸载器抢时间，把数据放到它够不着的地方。**
//   （用户实测丢过两次配置/人设卡；详见 项目记忆.md §23.13 / §23.14）
//
// 解析顺序（**已有数据优先** —— 这一条最重要，任何情况下都不能让用户数据"看起来消失"）：
//   0) $QQ_AGENT_DATA_DIR 显式指定（测试/高级用法）→ 最高优先
//   1) 开发模式：项目内 data/
//   2) exe 旁边的 data/        ← 老版本（含压缩包版）的数据就在这
//   3) %LOCALAPPDATA%\QQ Agent\data  ← **新默认**，在安装目录之外
//   4) 都没有 → 用 (3)，并尝试从旧位置迁移
function resolveDataDir() {
  if (process.env.QQ_AGENT_DATA_DIR) return process.env.QQ_AGENT_DATA_DIR;
  // 开发模式（.bat 直起 node_modules 里的 electron.exe + 项目目录）：项目内 data/
  if (!app.isPackaged) return path.resolve(fileURLToPath(import.meta.url), '..', '..', 'data');

  const besideExe = path.join(path.dirname(app.getPath('exe')), 'data');
  // 外部默认位置：**不要**用 app.getPath('userData')，因为它的位置受 productName 影响，
  // 上游改名就会换目录；这里写死一个稳定路径。
  const external = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'QQ Agent', 'data');

  const hasData = (dir) => {
    try {
      if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
      return true;
    } catch { return false }
  };

  // ② 老位置有数据 → **先试着一次性搬到外部位置**（搬成功就用外部；失败就继续用老的）
  //
  // 为什么值得主动搬：留在安装目录里的数据，随时可能被"下一次覆盖安装"删掉
  // （旧卸载器 `RMDir /r $INSTDIR`）。搬出安装目录是**唯一**不依赖安装器时机的保命手段。
  //
  // 为什么搬失败要退回老位置：绝不能因为"搬家"让用户**看不到自己的数据** ——
  // 那比数据被删还难排查（界面上一切正常，就是配置全空）。
  if (hasData(besideExe)) {
    if (hasData(external)) {
      // 两边都有 → 不猜谁是"对"的，留在原处并明确告知（用户可自行取舍）
      console.warn('[data] ⚠️ 安装目录与外部位置**都有**数据，继续使用安装目录内的那份：', besideExe);
      console.warn('[data]    外部那份未被使用：', external);
      return besideExe;
    }
    try {
      fs.mkdirSync(path.dirname(external), { recursive: true });
      fs.cpSync(besideExe, external, { recursive: true });
      if (hasData(external)) {
        console.log('[data] ✅ 已把数据搬到安装目录之外（以后覆盖安装不会再丢）:', external);
        console.log('[data]    原位置保留未删，确认一切正常后可自行删除：', besideExe);
        return external;
      }
      console.warn('[data] 搬家后校验未通过，继续使用安装目录内的数据:', besideExe);
      return besideExe;
    } catch (error) {
      console.error('[data] 搬到外部位置失败，继续使用安装目录内的数据:', error?.message ?? error);
      return besideExe;
    }
  }
  // ③ 外部位置已有数据 → 用它
  if (hasData(external)) return external;

  // ④ 都没有 → 用外部位置（新默认）；顺手接管两种旧遗留
  try {
    fs.mkdirSync(external, { recursive: true });
    const legacy = path.join(app.getPath('userData'), 'data');   // 2026-09-06 外置期的旧位置
    for (const src of [legacy]) {
      if (fs.existsSync(src) && fs.readdirSync(src).length > 0) {
        fs.cpSync(src, external, { recursive: true });
        console.log('[data] 已迁移旧数据到外部位置:', src, '→', external);
        break;
      }
    }
  } catch (error) {
    console.error('[data] 外部数据目录创建/迁移失败（不影响启动）:', error?.message ?? error);
  }
  console.log('[data] 数据目录（安装目录之外）:', external);
  return external;
}
process.env.QQ_AGENT_DATA_DIR = resolveDataDir();

// 单实例锁：重复启动（双击 .bat）不产生第二个实例，而是唤出已有窗口。
// 没有锁的话第二个实例会双份连 SnowLuma，群消息会被双重回复。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'icon.png');

let mainWindow = null;
let core = null;
let tray = null;
let quitting = false;

function applyAutoStart() {
  if (!core) return;
  const cfg = core.getConfig();
  app.setLoginItemSettings({ openAtLogin: !!cfg.server?.autoStart });
}

function showWindow() {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow(core?.lastPort ?? 3210);
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('QQ Agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: () => showWindow() },
    { label: '暂停 / 恢复', click: () => core?.orchestrator.setPaused(!core.orchestrator.paused) },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: !!core.getConfig().server?.autoStart,
      click: (item) => {
        core.updateConfig({ server: { autoStart: item.checked } });
        applyAutoStart();
      }
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showWindow());
}

function createWindow(port) {
  // ── 无边框窗口（2026-09-22）──────────────────────────────────────────────
  // 依据《无边框窗口改造实施方案》v1.0。三条一起改，缺一不可：
  //
  //   frame: false                 去掉系统标题栏。窗口控制改由 UI 顶栏自绘
  //                                （见 ui/index.html 的 #win-ctrl 与 app.js 的 initWindowControls）。
  //   transparent: false           必须保持 false。改成 true 会让"整体透明"残留，
  //                                而我们要的是纯色不透明窗口（方案 4.1 明确要求）。
  //   backgroundMaterial: 'none'   ⚠️ 这一条是**实测补的、方案里没写对**：方案说
  //                                "当前启用了 Mica，要清空相关配置"，但全项目搜
  //                                backgroundMaterial / mica / acrylic **零命中** ——
  //                                用户看到的那圈深色磨砂边框，其实是 backgroundColor
  //                                '#0f1115' 这个**纯色**从 #shell 的 18px 外边距里透出来
  //                                （Win11 上 Electron 还会再叠加默认材质）。
  //                                ⇒ 显式写 'none' 钉死，不依赖平台默认值。
  //   backgroundColor: '#FFFFFF'   改浅色纯色（原来是最深的 #0f1115）。深色会在圆角
  //                                外圈形成一道黑边；亮色下它与 UI 底色接近、圆角过渡自然。
  //                                暗色主题下这道边由 CSS 接管（见 style.css 的
  //                                html[data-theme='dark'] body 背景）。
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'QQ Agent',
    frame: false,
    transparent: false,
    backgroundColor: '#FFFFFF',
    backgroundMaterial: 'none',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口控制（最小化 / 最大化切换 / 关闭）必须走 IPC：渲染进程 contextIsolation=true
      // 且 nodeIntegration=false，拿不到 Electron API。preload 只暴露这几个动作，
      // 不暴露 fs / child_process 之类任何能力。
      // ⚠️ 这里可以用 `__dirname`：本文件虽是 ESM（顶层 import），但**文件开头
      //   L125 自己定义过** `const __dirname = path.dirname(fileURLToPath(import.meta.url))`
      //   —— 别照搬"ESM 里没有 __dirname"那条通则去改它（我第一版就这么误判过）。
      preload: path.join(__dirname, 'preload.js')
    }
  });
  Menu.setApplicationMenu(null);
  // 窗口打开先显示 loading 壳，等页面真正加载完成再亮相，避免白屏和用户反复双击
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('[window] 页面加载失败:', code, desc, url);
    setTimeout(() => mainWindow?.loadURL(`http://127.0.0.1:${port}/`).catch(() => {}), 2000);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] 渲染进程崩溃:', JSON.stringify(details));
  });
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}/`).catch((error) => console.error('[window] loadURL 失败:', error));
  // 外部链接（金句墙/意见墙/上传成功提示里的网址等）一律交给系统默认浏览器，不在应用内弹新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 关窗默认缩到托盘（真正退出走托盘菜单），符合"常驻机器人"的使用习惯
  mainWindow.on('close', (event) => {
    if (!quitting && core?.getConfig().server?.closeToTray !== false) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  // ── 无边框窗口：把"最大化状态"推给渲染进程 ────────────────────────────────
  // ⚠️ 必须监听**窗口事件**而不是只监听按钮点击（方案 4.4 点名的中风险项）：
  //    用户还可以用 Win+↑/↓、双击标题栏、任务栏右键、Aero Snap 贴边 等途径改变状态，
  //    只跟按钮走的话，按钮图标会和真实状态不一致。
  //    `maximize` / `unmaximize` 两个事件覆盖全部途径；`resized` 用于兜住
  //    "连续拖拽边缘"这类不触发前两者的变化（幂等推送，渲染端自己比对后忽略重复）。
  const pushWinState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('win:state', { maximized: mainWindow.isMaximized() });
    } catch { /* 窗口正在销毁，忽略 */ }
  };
  mainWindow.on('maximize', pushWinState);
  mainWindow.on('unmaximize', pushWinState);
  mainWindow.on('enter-full-screen', pushWinState);
  mainWindow.on('leave-full-screen', pushWinState);
  mainWindow.on('resize', pushWinState);
}

// ── 无边框窗口：渲染进程请求的窗口动作 ──────────────────────────────────────
// 只注册这 4 个动作，且**不接收渲染进程传来的任何参数**（避免变成"任意窗口操作"的后门）。
// ⚠️ 关闭动作刻意走 `mainWindow.close()` 而**不是** `app.quit()` ——
//    close 事件里已经有"缩到托盘"的策略（见上面 createWindow 里那段），
//    自己调 app.quit() 会绕开它、把常驻的后台 Agent 直接杀掉（方案 4.4 的高风险项）。
function registerWindowIpc() {
  ipcMain.handle('win:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  });
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { maximized: mainWindow.isMaximized() };
  });
  ipcMain.handle('win:close', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();   // 触发上面的 close 策略
  });
  ipcMain.handle('win:is-maximized', () => ({
    maximized: !!(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized())
  }));
}

app.whenReady().then(async () => {
  try {
    // 应用只访问本机回环地址：强制直连，防止系统代理（Clash/加速器等）劫持 127.0.0.1 导致白/黑屏
    await session.defaultSession.setProxy({ mode: 'direct' });
    console.log('[window] 代理模式：direct（绕过系统代理）');
    const { createApp } = await import('../src/app.js');
    core = createApp({ log: (...args) => console.log(...args) });
    // 先启动服务拿到真实端口，再开窗口。
    // 原先是 createWindow(core.lastPort ?? 3210) 在前、core.start() 在后 ——
    // 此时 lastPort 尚未赋值，窗口恒按 3210 加载；若端口被占用顺延到 3211+，
    // 首屏必然加载失败，只能靠 did-fail-load 2 秒重试兜底。
    const port = await core.start();
    core.lastPort = port;
    await createWindow(port);
    applyAutoStart();
    createTray();
    // 无边框窗口：注册渲染进程的窗口控制入口（最小化/最大化切换/关闭/查状态）。
    // ⚠️ 必须在 createWindow **之后**：它要往 mainWindow.webContents 推状态。
    registerWindowIpc();
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  try { core?.stop(); } catch { /* ignore */ }
});
