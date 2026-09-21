// Electron 桌面壳：启动核心服务器（同一进程），打开会话式控制台窗口。
// 傻瓜式：托盘常驻、关窗不退出、可选开机自启。
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell } from 'electron';
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
// 用法：设了环境变量才开，**默认不影响任何行为**：
//     $env:QQ_AGENT_DEBUG_PORT=9222; & "QQ Agent.exe"
//   然后 node "工具-设计改造\探页面.mjs" --url=http://127.0.0.1:3210/ --port=9222 …
// ⚠️ 不要无条件打开：远程调试端口等于把渲染进程的完全控制权暴露在本机端口上。
if (process.env.QQ_AGENT_DEBUG_PORT) {
  const p = Number(process.env.QQ_AGENT_DEBUG_PORT);
  if (Number.isFinite(p) && p > 0) {
    app.commandLine.appendSwitch('remote-debugging-port', String(p));
    console.log(`[debug] 已按 QQ_AGENT_DEBUG_PORT 打开远程调试端口 ${p}`);
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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'QQ Agent',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: ICON_PATH,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
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
  } catch (error) {
    console.error('[electron] 启动失败:', error);
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  try { core?.stop(); } catch { /* ignore */ }
});
