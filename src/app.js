// 总装：OneBot 事件接入 → 存储 → 编排器；HTTP API + SSE 给 UI。
// Electron 主进程与 headless 服务器都从这里启动。
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig, ROOT, DATA_DIR } from './config.js';
import { customSearch } from './web-search.js';
import { OneBotClient, segmentsToText, extractMediaFromSegments, expandForwardNodes, fetchForward, forwardIdFromData } from './onebot.js';
import { ensureStickerImage, buildToolDefs } from './tools.js';
import { ChatStore } from './store.js';
import { MemoryStore } from './memory.js';
import { StickerManager } from './sticker-manager.js';
import { SendQueue } from './sender.js';
import { SessionRegistry } from './sessions.js';
import { Orchestrator } from './orchestrator.js';
import { listModels, chatCompletion, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { jmRequest, jmPaths, jmPing, stopJm } from './jm-bridge.js';
import { createZip } from './zip.js';
import { Dreamer } from './dream.js';
import { resolveOfficialPrice, listOfficialPrices, isPeakHour, priceAt, resolveModelPrice, modelLabel, splitModelLabel, UNKNOWN_VENDOR } from './model-prices.js';
import { initPriceFeed, refreshPriceFeed, priceFeedStatus } from './price-feed.js';
import { startTelemetryLoop } from './telemetry.js';
// Skills 基础设施（上游 0.3.1）：启动时扫 skills/ 与 plugins/ 两个目录。
// 位置锚点用的是本文件自己的路径（plugin-loader.js 里 APP_ROOT = src/..），不是 cwd。
import { loadPlugins } from './plugin-loader.js';
import { skillManager } from './skills/manager.js';
import { importFromDsh, currentProviders, setProviderKey, testAllProviders, testOneProvider, testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider } from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { createEventBus, todayKey } from './util.js';
// 系统提示：管理端「人设 → 系统提示自定义」用它读取内置段落与当前生效文本。
import { buildSystemPrompt, buildDefaultSegments, SYSTEM_SEGMENT_LABELS } from './prompt.js';

// 全局 fetch（undici）默认连接建立超时只有 10 秒，openrouter.ai 这类海外端点
// 握手慢时会直接报 "Connect Timeout Error ... timeout: 10000ms"（注意这不是
// 请求超时——那是 llm.js 里 180 秒的 AbortSignal）。这里放宽到 30 秒。
// 动态导入 + 容错：undici 与 Electron 内置 Node 不兼容时只退回默认超时，绝不崩主进程。
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ connect: { timeout: 30_000 } }));
} catch (error) {
  console.warn('[net] 全局连接超时设置失败（使用 undici 默认值 10s）:', error?.message ?? error);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.resolve(__dirname, '..', 'ui');

// ── 白名单判断（移植自原版 allowed()） ───────────────────────────────────
function allowed(kind, id, cfg) {
  const s = String(id);
  const denyList = cfg.deny?.[kind] ?? cfg.deny?.[`${kind}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[kind] ?? cfg.allow?.[`${kind}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

// ── 版本更新检查 ─────────────────────────────────────────────────────
// 线上版本信息只有一份：kondius.cn/qq-agent/version.json（发版时手动改）。
// 由后端代取而不是前端直连：绕过 CORS，且失败信息能统一回给 UI。
const UPDATE_INFO_URL = 'https://kondius.cn/qq-agent/version.json';

function localVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch { return '0.0.0'; }
}

/** x.y.z 三段数字比较；返回 1 / 0 / -1。非数字段按 0 处理，够用。 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

export function createApp({ log = console.log } = {}) {
  const cfg = getConfig();
  const bus = createEventBus();
  const sseClients = new Set();

  // ── 应用日志环形缓冲（给「一键导出诊断包」用）──────────────────────────
  // 别人遇到问题只会说"打不开"，没有可读的东西就查不下去。这里把主进程
  // 最近的 console 输出留一份。
  //
  // ⚠️ 只包 console，**刻意不接管 uncaughtException / unhandledRejection**：
  //    加那两个监听器会让本该崩掉的异常被吞掉（Node 默认是打印后退出），
  //    等于拿稳定性换日志 —— 宁可少记一条，也不要一个看起来还活着、
  //    实际状态已经坏掉的进程。
  //
  // 缓冲挂在 globalThis 上：万一 createApp 被调用多次（测试、多实例），
  // 大家共用同一个数组，不会出现"第二个实例的诊断包是空的"。
  const appLogs = (globalThis.__qqaAppLogs ||= []);
  const APP_LOG_MAX = 1500;
  const formatLogArg = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack ? `${v.message}\n${v.stack}` : v.message;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  // 守卫：已经包过就不再套娃（套两层会让每行日志被记两遍）
  if (!globalThis.__qqaConsoleHooked) {
    globalThis.__qqaConsoleHooked = true;
    for (const level of ['log', 'warn', 'error']) {
      const original = console[level].bind(console);
      console[level] = (...args) => {
        try {
          appLogs.push(`${new Date().toISOString()} [${level}] ${args.map(formatLogArg).join(' ')}`);
          if (appLogs.length > APP_LOG_MAX) appLogs.splice(0, appLogs.length - APP_LOG_MAX);
        } catch { /* 记日志失败绝不影响主流程 */ }
        original(...args);
      };
    }
  }

  // ── SnowLuma 程序目录与进程管理 ──
  function snowlumaDir() {
    const configured = String(getConfig().snowluma?.dir || '').trim();
    if (configured) return configured;
    const bundled = path.join(ROOT, 'snowluma');
    if (fs.existsSync(bundled)) return bundled;
    // 安装版：asar 里的文件不可执行，electron-builder 会把 snowluma/ 解包到
    // resources/app.asar.unpacked/snowluma（见 package.json asarUnpack）
    const unpacked = bundled.replace('app.asar', 'app.asar.unpacked');
    if (unpacked !== bundled && fs.existsSync(unpacked)) return unpacked;
    return '';
  }

  function snowlumaWsPort() {
    try {
      const wsUrl = String(getConfig().snowluma?.wsUrl || 'ws://127.0.0.1:3001');
      const u = new URL(wsUrl);
      if (u.port) return Number(u.port);
    } catch { /* ignore */ }
    return 3001;
  }

  /** 从 SnowLuma 的 runtime.json 读取 WebUI 地址（http(s)://host:port/）。拿不到就返回空串。 */
  function snowlumaWebuiUrl() {
    try {
      const dir = snowlumaDir();
      if (!dir) return '';
      const rtPath = path.join(dir, 'config', 'runtime.json');
      if (!fs.existsSync(rtPath)) return '';
      const rt = JSON.parse(fs.readFileSync(rtPath, 'utf8'));
      const host = String(rt.webuiHost || '127.0.0.1');
      const port = Number(rt.webuiPort) || 5099;
      const tls = !!(rt.webuiTls && rt.webuiTls.enabled);
      return `${tls ? 'https' : 'http'}://${host}:${port}/`;
    } catch {
      // 配置读不到时，从最近日志里找 "listening http(s)://…" 兜底
      for (const line of [...snowlumaLogs].reverse()) {
        const m = /listening\s+(https?:\/\/[\w.:-]+)/i.exec(line.text || '');
        if (m) return m[1];
      }
      return '';
    }
  }

  function isPortOpen(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const done = (result) => { try { socket.destroy(); } catch { /* ignore */ } resolve(result); };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('timeout', () => done(false));
      socket.once('error', () => done(false));
      socket.connect(port, host);
    });
  }

  // SnowLuma 内置控制台日志（环形缓冲，最近 500 行）
  // 内置 SnowLuma 状态与日志。未采用多进程方案：由 Electron 主进程提供 IPC 控制与日志转发，
  // 确保 SnowLuma 随 QQ Agent 退出、无需单独管理窗口。
  const snowlumaLogs = [];
  let snowlumaProc = null;
  let snowlumaStopping = false;

  // ── 首次安装的 WebUI 初始访问密码：主动抓出来，别让它随日志被刷掉 ──────────
  //
  // 为什么要有这段：SnowLuma 首次启动会打印一行
  //   ★ WebUI 初始登录凭据 / Initial WebUI Credentials ★
  // 密码是 randomBytes(8).toString('hex')（16 位十六进制）随机生成的，
  // **只打印这一次，关闭后无法找回**（它自己写的："关闭程序后此密码无法找回"）。
  // 而我们的日志面板只留最近 500 行 —— 群消息一刷，这行就没了，用户就进不去 WebUI，
  // 也就没法完成"登录 WebUI → 注入 QQ 进程"这套流程。**日志能滚掉，这条不能。**
  //
  // 抓法对格式不敏感：先认标记行，再在**它附近**找 16 位十六进制串（前后各看几行，
  // 因为密码可能印在标记行的下一行，也可能被包在框里）。抓不到就不报，不编。
  let webuiInitialPassword = null;   // { password, at, from }；只存内存，不落盘
  let credMarkerSeenAt = 0;

  /**
   * 返回"此刻还值得提示"的初始密码，或 null。
   *
   * 为什么要这一步：提示条不能永远挂着。SnowLuma 的初始密码带 `mustChangePassword: true`，
   * 用户一改密就等于这条提示作废了；而 `webui.json` 的 `updatedAt` 会在改密时变。
   * 所以一旦发现 `updatedAt` 晚于我们抓到密码的时刻，就认为密码已失效，清掉并返回 null。
   * 读不到文件（还没生成）时保守放行 —— 宁可多提示一次，也别让用户拿不到密码。
   */
  function liveInitialPassword() {
    if (!webuiInitialPassword) return null;
    try {
      const dir = snowlumaDir();
      if (dir) {
        const raw = fs.readFileSync(path.join(dir, 'config', 'webui.json'), 'utf8');
        const updatedAt = Date.parse(JSON.parse(raw).updatedAt || '');
        if (Number.isFinite(updatedAt) && updatedAt > webuiInitialPassword.at + 1000) {
          webuiInitialPassword = null;     // 已经改过密码了，这条提示不该再出现
          return null;
        }
      }
    } catch { /* 读不到就保守放行 */ }
    return { value: webuiInitialPassword.password, at: webuiInitialPassword.at, from: webuiInitialPassword.from };
  }

  const CRED_MARKER = /WebUI\s*初始登录凭据|Initial WebUI Credentials/i;
  const HEX16 = /\b[0-9a-f]{16}\b/i;

  function captureWebuiCredentialFrom(text) {
    if (webuiInitialPassword) return false;    // 只认第一次；改密后不该再提示旧密码
    const t = String(text ?? '');
    const isMarker = CRED_MARKER.test(t);
    // 两种情况都覆盖：密码印在同一行，或印在标记行之后的几行里（框起来的那种）
    const nearMarker = isMarker || (credMarkerSeenAt > 0 && Date.now() - credMarkerSeenAt < 5000);
    if (nearMarker) {
      const m = t.match(HEX16);
      if (m) {
        webuiInitialPassword = { password: m[0], at: Date.now(), from: isMarker ? 'marker-line' : 'after-marker' };
        // 密码本身绝不写进日志流（日志可能被打包进诊断包导出），只报"抓到了"
        pushSnowlumaLogSilent('[QQ Agent] 已捕获 WebUI 初始登录密码 —— 请在顶部提示条里查看并保存');
        emit('snowluma-credential', { found: true, at: webuiInitialPassword.at });
        return true;                           // 调用方据此**丢弃原文**
      }
    }
    if (isMarker) credMarkerSeenAt = Date.now();
    return false;
  }

  /** 只入内存、不广播的日志（避免"抓到密码"这句话本身触发一次重新解析） */
  function pushSnowlumaLogSilent(text, stream = 'stdout') {
    const line = { at: Date.now(), stream, text: String(text ?? '').replace(/\r?\n$/, '') };
    if (!line.text) return;
    snowlumaLogs.push(line);
    if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
  }

  function pushSnowlumaLog(text, stream = 'stdout') {
    const raw = String(text ?? '').replace(/\r?\n$/, '');
    if (!raw) return;
    // ⚠️ 顺序很重要：**先尝试抓凭据，再决定要不要把原文放进日志流**。
    //    否则当密码与标记印在同一行时（SnowLuma 有可能这么做），原文里就带着密码，
    //    而日志是会被打包进诊断包导出的 —— 等于把用户唯一的入场券写进了要外发的文件。
    let captured = false;
    try { captured = captureWebuiCredentialFrom(raw) === true; } catch { /* 抓不到不影响日志 */ }
    if (!captured) {
      const line = { at: Date.now(), stream, text: raw };
      snowlumaLogs.push(line);
      if (snowlumaLogs.length > 500) snowlumaLogs.splice(0, snowlumaLogs.length - 500);
      emit('snowluma-log', line);
    }
  }

  function snowlumaStatus() {
    return { embedded: !!snowlumaProc, pid: snowlumaProc?.pid ?? null };
  }

  /** 关闭内置启动的 SnowLuma。返回是否执行了关闭动作。 */
  function stopSnowluma() {
    const proc = snowlumaProc;
    if (!proc) return false;
    try {
      proc.kill();
      pushSnowlumaLog('已请求关闭 SnowLuma。', 'stdout');
    } catch (error) {
      pushSnowlumaLog(`关闭 SnowLuma 失败：${error?.message ?? error}`, 'stderr');
      throw error;
    }
    return true;
  }

  /** 拉起 SnowLuma。优先用项目内置 node.exe 直接运行（日志进内置控制台）；失败再回退到独立窗口 launcher.bat。 */
  async function launchSnowluma() {
    const dir = snowlumaDir();
    if (!dir) return { ok: false, error: '找不到 SnowLuma 目录：请确认项目内 snowluma/ 文件夹存在，或在设置里填写 SnowLuma 目录' };
    const wsPort = snowlumaWsPort();
    if (await isPortOpen('127.0.0.1', wsPort)) {
      pushSnowlumaLog(`SnowLuma 已在运行（端口 ${wsPort} 已就绪），无需重复启动`, 'stdout');
      return { ok: true, alreadyRunning: true };
    }
    const indexMjs = path.join(dir, 'index.mjs');
    const nodeExe = path.join(dir, 'node.exe');
    if (fs.existsSync(indexMjs) && fs.existsSync(nodeExe)) {
      try {
        // 用 Windows 的 CREATE_NEW_PROCESS_GROUP + 独立进程方式启动，
        // 让 SnowLuma 真正独立于 Electron 主进程（Electron 退出时不会拖垮它）。
        const child = spawn(nodeExe, [indexMjs], {
          cwd: dir,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: false
        });
        snowlumaProc = child;
        child.unref();
        pushSnowlumaLog(`SnowLuma 启动中（内置模式，pid=${child.pid}）…`, 'stdout');
        child.stdout.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stdout');
          }
        });
        child.stderr.on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) {
            if (line.trim()) pushSnowlumaLog(line, 'stderr');
          }
        });
        child.on('exit', (code, signal) => {
          snowlumaProc = null;
          pushSnowlumaLog(`SnowLuma 进程已退出（code=${code ?? ''} signal=${signal ?? ''}）`, 'stderr');
          emit('snowluma-status', { running: false, embedded: false, pid: null });
        });
        child.on('error', (error) => {
          pushSnowlumaLog(`SnowLuma 启动失败：${error?.message ?? error}`, 'stderr');
        });
        emit('snowluma-status', { running: true, embedded: true, pid: child.pid });
        return { ok: true, launched: true, embedded: true, pid: child.pid };
      } catch (error) {
        pushSnowlumaLog(`内置模式启动失败，尝试回退独立窗口：${error?.message ?? error}`, 'stderr');
        snowlumaProc = null;
      }
    }
    // 回退：launcher.bat 独立控制台窗口（老行为，日志无法内置）
    const launcher = path.join(dir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, error: `目录里没有 index.mjs / node.exe，也没有 launcher.bat：${dir}` };
    const child = spawn('cmd.exe', ['/c', launcher], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      windowsHide: false // 保留 SnowLuma 自己的控制台窗口
    });
    child.unref();
    pushSnowlumaLog('SnowLuma 已用独立控制台窗口启动（此模式下日志不进内置控制台）', 'stdout');
    return { ok: true, launched: true, embedded: false };
  }

  const emit = (type, payload) => {
    bus.emit(type, payload);
    let line = null;
    if (type === 'session-update' && payload?.sessionId) {
      try {
        // peek：只序列化、不修改，不需要 get() 那份全量 structuredClone
        // （运行中的会话每次更新都广播，克隆大会话会拖慢事件投递）
        const s = sessions?.peek(payload.sessionId);
        if (s) {
          line = `event: ${type}\ndata: ${JSON.stringify({
            sessionId: s.id,
            chatKey: s.chatKey,
            startedAt: s.startedAt,
            status: s.status,
            waitUntil: s.waitUntil ?? null,
            activity: s.activity ?? '',
            webSearchCount: s.webSearchCount ?? 0,
            rounds: s.rounds ?? 0,
            usage: s.usage ?? null,
            trigger: s.triggerSummary ?? '',
            triggerSummary: s.triggerSummary ?? '',
            messages: s.messages ?? [],
            // sent/finishReason/error/endedAt 必须随 SSE 推下去：
            // 曾经载荷里没有它们，"已发送到 QQ"徽标只能等 HTTP 轮询带回来；
            // 而会话一结束轮询就不再拉详情（只刷 running/waiting），
            // 用户只能手动刷新才看得到最终发言 —— 这就是"详情更新不及时"。
            sent: s.sent ?? [],
            finishReason: s.finishReason ?? null,
            error: s.error ?? null,
            endedAt: s.endedAt ?? null
          })}\n\n`;
        }
      } catch { /* 失败就退回原 payload */ }
    }
    if (!line) line = `event: ${type}\ndata: ${JSON.stringify(payload ?? {})}\n\n`;
    for (const res of sseClients) {
      try { res.write(line); } catch { /* 客户端断开会由 close 清理 */ }
    }
  };

  // ── 组件 ──
  const visionScan = { running: false };   // 模型图片输入能力扫描的运行状态
  const store = new ChatStore(cfg.store?.maxMessagesPerChat ?? 0);   // 0 = 不限
  const memory = new MemoryStore();
  const sessions = new SessionRegistry(cfg.store?.keepSessionFiles ?? 0);   // 0 = 不限
  const onebot = new OneBotClient({
    wsUrl: cfg.snowluma?.wsUrl,
    httpUrl: cfg.snowluma?.httpUrl,
    accessToken: cfg.snowluma?.accessToken,
    httpToken: cfg.snowluma?.httpAccessToken || cfg.snowluma?.accessToken,
    onEvent: (event) => handleOneBotEvent(event).catch((error) => log('[ingest] 处理事件出错:', error?.message ?? error))
  });
  const stickers = new StickerManager(onebot);
  const sender = new SendQueue({
    onebot, store,
    onSent: ({ chatKey, text }) => log(`[发送 -> ${chatKey}] ${String(text).slice(0, 60)}`)
  });
  const orchestrator = new Orchestrator({ store, memory, stickers, sender, sessions, onebot, emit });
  // 空闲「梦」：夜里没人说话时把当天的事整理成一条笔记。
  // 只读 —— 那次模型调用一个工具都不给（见 src/dream.js 开头）。
  const dreamer = new Dreamer({ store, sessions, emit });

  // 远程价格表：启动即初始化（内部幂等；URL 为空则完全不动）
  initPriceFeed(cfg.api?.priceRemoteUrl || '');

  // OneBot 连接状态推送
  onebot.onStatus((status) => emit('onebot-status', status));

  // ── 从 SnowLuma 配置自动同步 OneBot 令牌 ──
  // SnowLuma 给每个登录过的账号生成独立随机 token（config/onebot_<uin>.json），
  // 且**永久保留**——不表示"当前在线"。多账号场景下"取第一个文件"会拿错 token
  // （WS 401 无限重试）。策略改为：收集所有 per-uin 文件的 token 作为候选，
  // 401 时轮换下一个重连，连上后记住生效的那个（天然支持 SnowLuma 里切账号）。
  let lastSyncTokenSig = '';

  /** 从单个配置对象里提取 ws/http token（找不到网络段时返回 null）。 */
  function extractTokens(data) {
    const http = (data?.networks?.httpServers || []).find((s) => (s.port === 3000) || (s.name === 'http-default')) || (data?.networks?.httpServers || [])[0];
    const ws = (data?.networks?.wsServers || []).find((s) => (s.port === 3001) || (s.name === 'ws-default')) || (data?.networks?.wsServers || [])[0];
    return { wsToken: String(ws?.accessToken ?? ''), httpToken: String(http?.accessToken ?? '') };
  }

  /** 收集所有候选 token（含 onebot_0.json 的空令牌兜底），按"当前配置优先"排序。 */
  function readSnowlumaTokenCandidates() {
    const out = [];
    try {
      const dir = snowlumaDir();
      if (!dir) return out;
      const cfgDir = path.join(dir, 'config');
      let files = [];
      try {
        files = fs.readdirSync(cfgDir).filter((f) => /^onebot_\d+\.json$/.test(f) && !/^onebot_0\.json$/.test(f)).sort();
      } catch { /* ignore */ }
      for (const f of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(cfgDir, f), 'utf8'));
          out.push(extractTokens(data));
        } catch { /* 单个文件坏了跳过，不影响其他候选 */ }
      }
      // 空令牌兜底：SnowLuma 允许无 token 连接（onebot_0.json 模板就是空）
      out.push({ wsToken: '', httpToken: '' });
    } catch (error) {
      log('[onebot] 读取 SnowLuma OneBot 配置失败:', error?.message ?? error);
    }
    return out;
  }

  /** 候选游标：401 时递增轮换。连上后会钉住当前生效下标。 */
  let tokenCandidateIndex = 0;

  function applyTokens({ wsToken, httpToken }) {
    onebot.accessToken = wsToken;
    onebot.httpToken = httpToken || wsToken;
    const cur = getConfig();
    if (cur.snowluma?.accessToken !== wsToken || cur.snowluma?.httpAccessToken !== (httpToken || wsToken)) {
      updateConfig({ snowluma: { ...cur.snowluma, accessToken: wsToken, httpAccessToken: httpToken || wsToken } });
      log(`[onebot] 应用 OneBot 访问令牌（WS ${wsToken ? '有' : '无'} / HTTP ${httpToken ? '有' : '无'}）`);
    }
  }

  // ── 全新安装的第一道坎：令牌文件晚于应用启动才出现 ──────────────────────
  //
  // 我们打包时 `snowluma/config/` 是**空目录**，而带真令牌的 `onebot_<uin>.json`
  // 要等用户在 WebUI 里登录、并在「进程」页**把已登录的 QQ 进程注入**之后才生成。
  // 新装的人双击应用时这个文件还不存在 → 拿到空令牌 → SnowLuma 回 401。
  //
  // 原来只有一个补救点：**出 401 的那一刻**去读文件（maybeRecoverOnebot）。可登录是
  // 人手动做的、要花几十秒，那一刻文件往往还没出现；之后再没有别的触发点 ——
  // 于是表现成"必须重启应用才会好"（2026-09-17 一位收到安装包的朋友实测：
  // "重启了一下报错就解决了"）。让人靠重启解决，是设计漏了触发点，不是他在瞎折腾。
  //
  // 补法：断线期间每 5 秒检查一次令牌文件，**签名一变**（新账号登录 / 换账号）就重连。
  // 代价是每 5 秒一次 readdir + 读一个小 JSON —— 只在"没连上"时才跑，连上即停。
  const TOKEN_WATCH_MS = 5000;
  let tokenWatchTimer = null;
  let tokenWatchTries = 0;

  function stopTokenWatch() {
    if (tokenWatchTimer) { clearInterval(tokenWatchTimer); tokenWatchTimer = null; }
  }

  function startTokenWatch(reason) {
    if (tokenWatchTimer) return;              // 已在盯，不重复起
    tokenWatchTimer = setInterval(() => {
      if (onebot.connected) { stopTokenWatch(); return; }

      // ⚠️ 关键：**不能只在"文件变了"时才重连**。
      // 实测（工具-会话诊断\probe-snowluma-token-check.mjs）：
      //   · SnowLuma 只要求令牌**非空** —— 传"WRONG-TOKEN-FOR-TEST"照样握手成功（OPEN）；
      //   · 不传令牌 = HTTP 401；连它自己配置文件里那把令牌，此刻也是 401。
      //   ⇒ 401 的成因是"**令牌为空**"，而登录改变的是 **SnowLuma 的运行时状态，不是磁盘文件**。
      //     所以"文件签名没变"完全不代表"还是连不上" —— 必须无条件重试。
      //   这正是"新装的人重启一下就好了"的机制：重启时 SnowLuma 已经登录好了，
      //   同一把（或空的）令牌这次就被接受了。
      const changed = syncSnowlumaTokens();
      if (changed) {
        log(`[onebot] 检测到 SnowLuma 令牌已就绪（${reason}），重连`);
      } else if (++tokenWatchTries % 12 === 0) {
        // 每分钟报一次，避免刷屏；也让"到底在等什么"在日志里看得见
        log(`[onebot] 仍未连上（已重试 ${tokenWatchTries} 次）：等 SnowLuma 就绪 / 等 WebUI 登录并注入 QQ 进程`);
      }
      onebot.reconnect();
    }, TOKEN_WATCH_MS);
    if (tokenWatchTimer.unref) tokenWatchTimer.unref();
    log(`[onebot] 未连接：开始盯 SnowLuma（每 ${TOKEN_WATCH_MS / 1000} 秒重试一次；${reason}）`);
  }

  /** 把候选列表同步进配置 + 挂到 onebot 实例（不立即连接）。返回是否有变化。 */
  function syncSnowlumaTokens() {
    try {
      const candidates = readSnowlumaTokenCandidates();
      if (!candidates.length) return false;
      const sig = candidates.map((c) => `${c.wsToken}|${c.httpToken}`).join(';');
      if (sig === lastSyncTokenSig) return false;
      // 游标重置：候选集变化了，从头开始试
      tokenCandidateIndex = 0;
      applyTokens(candidates[0]);
      onebot.tokenCandidates = candidates;   // 401 轮换用
      lastSyncTokenSig = sig;
      log(`[onebot] 已收集 ${candidates.length} 个 OneBot 令牌候选（SnowLuma 多账号场景 401 时自动轮换）`);
      return true;
    } catch (error) {
      log('[onebot] 同步 SnowLuma 令牌失败:', error?.message ?? error);
      return false;
    }
  }

  // 401 / 未连接时：轮换下一个候选 token 重连（3 秒重连循环已有，轮换成本为零）
  let tokenSyncRetryAt = 0;
  function maybeRecoverOnebot() {
    const now = Date.now();
    if (now - tokenSyncRetryAt < 5000) return;   // 限频
    tokenSyncRetryAt = now;
    const candidates = onebot.tokenCandidates || [];
    if (!candidates.length) {
      if (syncSnowlumaTokens()) onebot.reconnect();
      return;
    }
    // 指向下一个候选（首次触发也从 0→1 开始换：刚被 401 拒的就是当前这个）
    tokenCandidateIndex = (tokenCandidateIndex + 1) % candidates.length;
    const c = candidates[tokenCandidateIndex];
    applyTokens(c);
    onebot.reconnect();
  }
  onebot.onStatus((status) => {
    if (status.connected) {
      stopTokenWatch();   // 连上了就不用再盯令牌文件
      // 连上了：钉住当前候选。下次 401（比如 SnowLuma 里切了账号）再从下一个开始轮
      const cands = onebot.tokenCandidates || [];
      if (cands.length > 1) log('[onebot] 连接成功，当前令牌候选已生效');
      return;
    }
    const err = String(status.error || '');
    if (err.includes('401')) {
      maybeRecoverOnebot();
      // 401 = 令牌不对或还没有令牌。**开盯**：用户此刻很可能正在 WebUI 里登录 / 注入 QQ 进程，
      // 登录一完成文件就出现，这里下一次轮询就能自己接上（不必重启应用）。
      startTokenWatch('401');
      return;
    }
    // 连不上（SnowLuma 还没起来 / 端口不通）：也开盯 —— 等它起来并生成令牌。
    // 之前这种情形完全没有补救点，只能靠用户重启。
    if (err) startTokenWatch('未连接：' + err.slice(0, 60));
  });

  // ── 入站事件处理 ──
  let atNameCache = new Map(); // groupId:userId -> name
  async function resolveAtName(groupId, userId) {
    const key = `${groupId}:${userId}`;
    if (atNameCache.has(key)) return atNameCache.get(key);
    try {
      const info = await onebot.getGroupMemberInfo(groupId, userId);
      const name = info?.card || info?.nickname || null;
      if (name) {
        atNameCache.set(key, String(name));
        if (atNameCache.size > 500) atNameCache.clear(); // 简单防膨胀
        return String(name);
      }
    } catch { /* ignore */ }
    return null;
  }

  async function resolveReply(messageId) {
    try {
      const msg = await onebot.getMsg(messageId);
      const senderName = msg?.sender?.card || msg?.sender?.nickname || '';
      let text = '';
      if (Array.isArray(msg?.message)) {
        text = msg.message.map((s) => (s.type === 'text' ? s.data?.text ?? '' : `[${s.type}]`)).join('').trim();
      } else if (typeof msg?.message === 'string') {
        text = msg.message;
      }
      return { sender: String(senderName), text: String(text).slice(0, 120) };
    } catch {
      return null;
    }
  }

  async function ingestMessage(kind, id, event) {
    const cfgNow = getConfig();
    if (!allowed(kind, id, cfgNow)) return; // 白名单外的聊天完全不记录

    const segments = Array.isArray(event.message) ? event.message : null;
    const senderId = String(event.sender?.user_id ?? event.user_id ?? '');
    const senderName = String(event.sender?.card || event.sender?.nickname || senderId || '');

    // 屏蔽名单：被屏蔽群员的消息直接丢弃 —— 不存档、不触发会话、不进提示词背景。
    // 放在最前面：连合并转发展开这种网络请求都不值得为它做。
    if (kind === 'group' && senderId && (cfgNow.blocklist?.[id] || []).map(String).includes(senderId)) return;
    const media = segments ? extractMediaFromSegments(segments) : [];

    let text;
    if (segments) {
      text = await segmentsToText(segments, {
        resolveReply: (mid) => resolveReply(mid),
        resolveAtName: (qq) => kind === 'group' ? resolveAtName(id, qq) : null
      });
    } else {
      text = String(event.raw_message ?? event.message ?? '').trim();
    }

    // 合并转发：占位符 → 展开真实内容（模型要读懂、看懂转发的聊天记录）
    //
    // ⚠️ res_id 必须在这里抠出来并**存进条目**（fwdId）—— 它只在入站事件里出现这一次，
    //    事后拿不回来，而它恰恰是取转发内容最可靠的抓手：
    //    实测（2026-09-12）message_id 是随机 32 位整数、**可为负**，负数时
    //    get_forward_msg 一律 "download forward message payload is empty"（7/7 相关），
    //    同一条改用 res_id 就能取到。详见 onebot.js 的 fetchForward。
    let fwdId = null;
    if (segments) {
      for (const s of segments) {
        if (s?.type !== 'forward') continue;
        const id = forwardIdFromData(s.data);
        if (id) { fwdId = id; break; }
      }
    }
    // 展开失败时占位符留在存档里，模型可用 read_forward 工具稍后重试（条目里带着 fwdId）。
    if (segments && (text.includes('[合并转发') || text.includes('[转发消息'))) {
      const ex = await fetchForward(onebot, { messageId: event.message_id, resId: fwdId });
      if (ex.text) {
        text = ex.text;
        if (ex.media?.length) media.push(...ex.media);
      } else {
        log(`[ingest] 展开合并转发失败（保留占位符，read_forward 可重试）: ${ex.error}`);
      }
    }

    if (!text && !media.length) return;
    store.appendIncoming(`${kind}:${id}`, {
      mid: event.message_id,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId,
      senderName,
      text: text || '[图片]' ,
      media,
      fwdId
    });
    emit('chat-update', `${kind}:${id}`);
    orchestrator.onIncoming(`${kind}:${id}`);
  }

  async function ingestPoke(event) {
    // OneBot v11: notice_type=notify, sub_type=poke；群拍 target_id，私聊拍自己
    const isGroup = event.group_id != null;
    const id = isGroup ? String(event.group_id) : String(event.user_id);
    const cfgNow = getConfig();
    if (!allowed(isGroup ? 'group' : 'private', id, cfgNow)) return;

    const operatorId = String(event.user_id ?? '');
    // 自己拍的拍（send_poke 的 OneBot 回显）不触发处理——与 message_sent 同理，发送时已留档
    if (operatorId && operatorId === onebot.selfId) return;
    // 屏蔽名单对拍一拍同样生效（操作者是被屏蔽群员则丢弃）
    if (isGroup && operatorId && (cfgNow.blocklist?.[id] || []).map(String).includes(operatorId)) return;
    const targetId = String(event.target_id ?? event.user_id ?? '');
    const selfId = onebot.selfId;
    // 拍一拍也要记下真实群名片：原先这里硬编码"（拍一拍事件）"，
    // 会覆盖同一 QQ 在普通消息里的真实昵称 —— 记忆整理时取名字会拿到这个占位符，
    // 导致"317183522 的名字叫（拍一拍事件）"这种脏数据。
    const chatKeyNow = `${isGroup ? 'group' : 'private'}:${id}`;
    let operatorName = isGroup ? ((await resolveAtName(id, operatorId)) || '') : '';
    if (!operatorName) {
      const prior = (store.recent(chatKeyNow, { limit: 500 }) || [])
        .find((m) => !m.self && String(m.senderId) === operatorId
          && String(m.senderName || '') && String(m.senderName) !== '（拍一拍事件）');
      operatorName = prior ? String(prior.senderName) : operatorId;
    }
    let text;
    if (String(targetId) === String(selfId)) {
      text = `[拍一拍] 你拍了拍${isGroup ? '' : '你'}（来自 ${operatorName}）`;
    } else {
      const targetName = isGroup ? (await resolveAtName(id, targetId)) || targetId : targetId;
      text = operatorId === targetId ? `[拍一拍] ${operatorName} 拍了拍自己` : `[拍一拍] ${operatorName} 拍了拍 ${targetName}`;
    }
    store.appendIncoming(chatKeyNow, {
      mid: null,
      ts: event.time ? Math.round(Number(event.time) * 1000) : Date.now(),
      senderId: operatorId,
      senderName: operatorName,
      text,
      media: []
    });
    emit('chat-update', `${isGroup ? 'group' : 'private'}:${id}`);
    orchestrator.onIncoming(`${isGroup ? 'group' : 'private'}:${id}`);
  }

  async function handleOneBotEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.post_type === 'message' || event.post_type === 'message_sent') {
      // 自己发的消息（message_sent / self_id 相同）不触发处理（发送时已自行记录）
      if (String(event.user_id ?? event.sender?.user_id ?? '') === onebot.selfId) return;
      if (event.message_type === 'group' && event.group_id != null) return ingestMessage('group', String(event.group_id), event);
      if (event.message_type === 'private' && event.user_id != null) return ingestMessage('private', String(event.user_id), event);
      return;
    }
    if (event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
      return ingestPoke(event);
    }
    // meta/心跳等事件忽略
  }

  // ── HTTP API ──
  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((error) => {
      log('[http] 处理出错:', error?.message ?? error);
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error?.message ?? error) }));
      } catch { /* ignore */ }
    });
  });

  function json(res, code, data) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  function authorize(req) {
    const token = String(getConfig().server?.token ?? '');
    if (!token) return true;
    const url = new URL(req.url, 'http://127.0.0.1');
    return req.headers['x-console-token'] === token || url.searchParams.get('token') === token;
  }

  // ── 配置脱敏 ────────────────────────────────────────────────────────────
  // 凡是字段名命中这些模式的，值一律替换为空串（保留"有/无"的 hasXxx 标记）。
  // 覆盖：apiKey / api_key / accessToken / httpAccessToken / token / secret / password …
  const SECRET_KEY_PATTERN = /(apikey|api_key|accesstoken|access_token|secret|password|privatekey|private_key)/i;
  // 形如 apiKeyFrom 的字段存的是"密钥来源标识"（如 manual），不是密钥本身，不要脱敏
  const SECRET_KEY_EXCLUDE = /from$/i;

  function sanitizeConfig(cfg) {
    const out = JSON.parse(JSON.stringify(cfg ?? {}));
    const seen = new WeakSet();

    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (SECRET_KEY_EXCLUDE.test(key)) continue;
        // 已生成的 hasXxx 布尔标记本身也会被 apikey 模式匹配到，
        // 不排除就会连锁生成 hasHasXxx
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        if (SECRET_KEY_PATTERN.test(key)) {
          // ⚠️ 必须"删除字段"而不是"置为空串"。
          // 前端保存设置时会把整个 config 展开成 patch 回传（...c.webSearch?.deepseek），
          // 若这里留一个空串，deepMerge 会拿空串覆盖掉服务端保存的真 Key ——
          // 表现为：用户点一次"保存设置"，所有搜索 Key 就被静默清空。
          // 删掉字段则展开时不会带上该键，服务端原值得以保留。
          delete node[key];
          const flagName = `has${key.charAt(0).toUpperCase()}${key.slice(1)}`;
          node[flagName] = Boolean(String(value ?? '').trim());
        }
      }
    };
    walk(out);

    // 密钥集合整体清空（不逐 key 暴露存在性）
    if (out.dshProviderKeys && typeof out.dshProviderKeys === 'object') {
      const has = {};
      for (const [k, v] of Object.entries(out.dshProviderKeys)) has[k] = Boolean(String(v ?? '').trim());
      out.dshProviderKeys = {};
      out.dshProviderKeyPresence = has;
    }

    // 提供商列表：删掉 key 字段（同样不能置空串，否则回传时覆盖真实 Key），补 hasKey
    if (Array.isArray(out.providers)) {
      for (const p of out.providers) {
        const real = (cfg?.dshProviderKeys || {})[p.id] || p.apiKey;
        delete p.apiKey;
        p.hasKey = Boolean(String(real ?? '').trim());
      }
    }
    // 顶层 api：walk 已生成 hasApiKey，这里补一个简写的 hasKey 供旧代码读取
    if (out.api) out.api.hasKey = out.api.hasApiKey ?? Boolean(String(cfg?.api?.apiKey ?? '').trim());

    return out;
  }

  // ── 明文密钥端点守卫 ────────────────────────────────────────────────────
  /**
   * 这是本地单机程序，控制台就在本机浏览器打开，「显示密钥」是用户自己的操作，
   * 不该被禁用。真正的风险来自**外部网页**冒用浏览器读 127.0.0.1（CSRF /
   * DNS rebinding）—— 所以防线应当是「校验请求来源」，而不是砍掉本地功能。
   *
   * 放行条件（任一）：
   *   1. 配置了 server.token 且请求带上了它（远程/多用户场景）
   *   2. 请求来自本机控制台：Origin/Referer 指向本服务，或带 x-console-token 头
   */
  function keyEndpointAllowed(req) {
    const token = String(getConfig().server?.token ?? '');
    if (token) {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.headers['x-console-token'] === token || url.searchParams.get('token') === token) return true;
    }
    // 带自定义头 → 不可能是简单跨站请求（需 CORS 预检通过才能发出），放行
    if (req.headers['x-console-token']) return true;

    const host = String(req.headers.host ?? '');
    const origin = String(req.headers.origin ?? '');
    const referer = String(req.headers.referer ?? '');
    const isLoopbackHost = /^127\.0\.0\.1:\d+$/.test(host) || /^localhost:\d+$/.test(host);
    if (!isLoopbackHost) return false;
    if (origin) return origin === `http://${host}`;
    if (referer) return referer.startsWith(`http://${host}/`);
    return true;   // 地址栏直连等无来源请求，无法进一步区分
  }

  /**
   * 提供商对象脱敏：去掉明文 apiKey，只留 hasKey。
   * upsertProvider / addModelsToProvider / removeModelFromProvider 的返回值都带
   * 明文 key（来自 withResolvedKey），不能直接 json 给前端。
   */
  function sanitizeProvider(p) {
    if (!p || typeof p !== 'object') return p;
    const { apiKey, ...rest } = p;
    return { ...rest, apiKey: '', hasKey: Boolean(String(apiKey ?? '').trim()) };
  }

  // ── 「关于」页 / 诊断包 共用的信息收集 ────────────────────────────────

  /** 读 package.json —— 版本号/许可证/上游地址都从这里来，不写死在代码里。 */
  function readPkg() {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return {}; }
  }

  // 本机在上游基础上**自己加的**改动。放在这里有三个用处：
  //   ①「关于」页如实显示这台机器跟上游的差异；
  //   ② 诊断包里带上它 —— 别人帮你看问题时，不会把自加功能当成上游的 bug；
  //   ③ 升级时对着它核对"哪些要重新合并"。
  const LOCAL_PATCHES = [
    '提示词块顺序改为缓存友好序（角色设定/表情包/记忆在前，时间与历史在后）',
    '看图上限可调（单张 KB / 一次几张 / 一轮累计 MB）',
    '群发通知：自定义文本 + 范围（白名单群 / 私聊）',
    '手动唤醒如实回报原因（无未读 / 档位不命中 / 排不上队）',
    '本子查询（JM 直连，需本机 Python 环境，默认关闭）已搬进 skills/doujin-lookup/，工具名 doujin-lookup__lookup',
    'Skills 基础设施：上游 0.3.1 的 tool-registry + plugin-loader + src/skills，可从 skills/ 目录插拔加载（不启用热重载）',
    '工具调用遗漏追问：正文写了但没调 send_message 时追问一轮',
    '「我替你收着了」：门控静默扫成已读的消息量会告知模型',
    '跨会话记忆互通 + 公平性修复（轮流取，不被"最近整理过的会话"挤掉）',
    '会话采集字段（轮次 / 是否有工具结果 / 草稿未发）'
  ];

  function aboutPayload() {
    const pkg = readPkg();
    return {
      name: pkg.name || 'qq-agent',
      version: pkg.version || '',
      license: pkg.license || '',
      author: typeof pkg.author === 'string' ? pkg.author : (pkg.author?.name || ''),
      repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url || ''),
      homepage: pkg.homepage || '',
      localPatches: [...LOCAL_PATCHES],
      runtime: {
        electron: process.versions.electron || '',
        chrome: process.versions.chrome || '',
        node: process.versions.node || '',
        v8: process.versions.v8 || '',
        platform: process.platform,
        arch: process.arch,
        os: `${os.type()} ${os.release()}`,
        cpus: os.cpus()?.length ?? 0,
        memoryGB: Math.round((os.totalmem() / 1073741824) * 10) / 10
      },
      paths: { app: ROOT, data: DATA_DIR },
      uptimeSeconds: Math.round(process.uptime())
    };
  }

  /** 数据规模统计。**只给条数，不给任何消息正文。** */
  function dataStats() {
    let chats = 0, messages = 0, biggestChat = 0;
    try {
      const keys = store.listChats();
      chats = keys.length;
      for (const key of keys) {
        const n = store.getChatMeta(key).total || 0;
        messages += n;
        if (n > biggestChat) biggestChat = n;
      }
    } catch { /* 存档目录读不了就不报数，别让诊断包本身报错 */ }
    let memoryFiles = 0;
    try {
      memoryFiles = fs.readdirSync(path.join(DATA_DIR, 'memory')).filter((f) => f.endsWith('.json')).length;
    } catch { /* 目录不存在 */ }
    // 表情数：拿不到就写"未知"，不为了一个数字去触发 sync（那会走网络）
    let stickerCount = null;
    try { stickerCount = Array.isArray(stickers.entries) ? stickers.entries.length : null; } catch { stickerCount = null; }
    return { chats, messages, biggestChat, memoryFiles, stickerCount };
  }

  /** 把「关于」信息拍成纯文本 —— 诊断包里给人看的那一份。 */
  function aboutText(about, stats) {
    return [
      'QQ Agent 诊断信息',
      `导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '── 版本 ──',
      `程序：${about.name} ${about.version}`,
      `许可证：${about.license}`,
      `上游项目：${about.repository || about.homepage}`,
      `作者：${about.author}`,
      '',
      '── 运行环境 ──',
      `系统：${about.runtime.os}（${about.runtime.platform} ${about.runtime.arch}）`,
      `CPU：${about.runtime.cpus} 核    内存：${about.runtime.memoryGB} GB`,
      `Electron：${about.runtime.electron}    Chrome：${about.runtime.chrome}    Node：${about.runtime.node}`,
      `已运行：${Math.floor(about.uptimeSeconds / 60)} 分钟`,
      '',
      '── 路径 ──',
      `程序目录：${about.paths.app}`,
      `数据目录：${about.paths.data}`,
      '',
      '── 数据规模（只有条数，不含内容）──',
      `会话：${stats.chats}    存档消息：${stats.messages}    最大会话：${stats.biggestChat} 条`,
      `记忆文件：${stats.memoryFiles}    表情：${stats.stickerCount ?? '未知'}`,
      '',
      '── 本机自加改动（不是上游自带的）──',
      ...about.localPatches.map((p, i) => `${i + 1}. ${p}`),
      ''
    ].join('\n');
  }

  const DIAG_README = [
    'QQ Agent 诊断包',
    '',
    '包含什么：',
    '  信息.txt            版本、运行环境、路径、数据规模、本机自加改动清单',
    '  config.json         配置（**密钥已脱敏**：apiKey/token/secret 一类字段被整个删除，只留 hasXxx 布尔值）',
    '  状态.json           连接状态、今日用量、数据规模（机器可读）',
    '  日志-应用.txt        主进程最近的 console 输出（最多 1500 行）',
    '  日志-SnowLuma.txt    SnowLuma 最近的输出（最多 500 行）',
    '',
    '不包含什么：',
    '  x  API Key / 访问令牌 / 任何密钥',
    '  x  聊天消息正文（只统计条数，不含内容）',
    '  x  记忆内容本身',
    '',
    '给别人看之前，建议自己先解压翻一遍。',
    ''
  ].join('\n');

  /**
   * 诊断包专用的二次脱敏。
   *
   * `sanitizeConfig` 的密钥模式里**不含单独的 token**（只有 accesstoken / access_token），
   * 所以 `server.token`（控制台访问令牌）会被原样带出去 —— 那是能直接控制这台机器的凭据。
   * 这里在它的结果上再删一遍 token / jwt / cookie / authorization 类字段。
   *
   * 为什么不直接改 sanitizeConfig：那个函数的结果会被前端整包回传保存
   * （见它内部那段"必须删除字段而不是置为空串"的注释），动它会牵连设置页的保存逻辑。
   * 诊断包是只读的一次性导出，单独再删一遍最省事，也最不容易牵连别处。
   */
  function sanitizeForDiagnostics(cfg) {
    const out = sanitizeConfig(cfg);
    const EXTRA_SECRET = /token$|jwt$|cookie$|authorization$/i;
    const seen = new WeakSet();
    const walk = (node) => {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (value && typeof value === 'object') { walk(value); continue; }
        if (!EXTRA_SECRET.test(key)) continue;
        // 已经生成的 hasXxx 布尔值别再套一层（会变成 hasHasToken）
        if (/^has/i.test(key) && typeof value === 'boolean') continue;
        delete node[key];
        node[`has${key.charAt(0).toUpperCase()}${key.slice(1)}`] = Boolean(String(value ?? '').trim());
      }
    };
    walk(out);
    return out;
  }

  async function handleHttp(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    // SSE
    if (pathname === '/api/events' && req.method === 'GET') {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write(`event: hello\ndata: {}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname.startsWith('/api/')) {
      if (!authorize(req)) return json(res, 401, { error: '未授权' });
      const method = req.method;
      const cfgNow = getConfig();

      if (pathname === '/api/status' && method === 'GET') {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        // 成本估算：命中官方价走官方价，否则用手填单价
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: await isPortOpen('127.0.0.1', snowlumaWsPort()),
            webuiUrl: snowlumaWebuiUrl(),
            // 首次安装的初始访问密码：只在本进程真的抓到过、且用户还没改密时才有值
            initialPassword: liveInitialPassword(),
            ...snowlumaStatus()
          },
          orchestrator: orchestrator.statusSummary(),
          // 本子查询的"资源到位了没"—— 给体检卡用，**只做 existsSync，不拉子进程**
          // （spawnCount 那类统计要真起进程，不该出现在每次轮询的 /api/status 里）。
          // 为什么必须有这个：离线库 nh.db **不随包分发**（151MB，用户决定改成设置页导入），
          // 所以"开关开着 + JM 直连能用 + NH 兜底静默失效"是一个很可能的真实状态 ——
          // 正是 §7 那条"静默失效：开关开着、接口 200、就是查不到东西"。
          doujin: (() => {
            try {
              const p = jmPaths();
              return {
                enabled: cfgNow.doujinLookup?.enabled === true,
                toolDir: p.toolDir || '',
                toolDirFromConfig: p.toolDirFromConfig === true,
                useExe: p.useExe === true,
                serverExists: p.serverExists === true,
                nhDbPath: p.nhDbPath || '',
                nhDbExists: p.nhDbExists === true
              };
            } catch (error) {
              return { enabled: cfgNow.doujinLookup?.enabled === true, error: String(error?.message ?? error) };
            }
          })(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null
        });
      }

      // ── 「关于」页数据 ──
      if (pathname === '/api/about' && method === 'GET') {
        return json(res, 200, aboutPayload());
      }

      // ── 一键导出诊断包 ──
      // 目的：别人遇到问题只会说"打不开"，没有可读的东西就查不下去。
      // 包里不含密钥（复用设置页那套 sanitizeConfig），也不含消息正文 ——
      // 只给条数不给内容，导出前用户自己也能先翻一遍。
      if (pathname === '/api/diagnostics' && method === 'GET') {
        const about = aboutPayload();
        const stats = dataStats();
        const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
        let buf;
        try {
          buf = createZip([
            { name: '说明.txt', data: DIAG_README },
            { name: '信息.txt', data: aboutText(about, stats) },
            { name: 'config.json', data: JSON.stringify(sanitizeForDiagnostics(getConfig()), null, 2) },
            {
              name: '状态.json',
              data: JSON.stringify({
                about,
                stats,
                onebot: { connected: onebot.connected, everConnected: onebot.everConnected, error: onebot.lastConnectError },
                usage: sessions.todayUsage(todayKey()),
                paused: orchestrator.paused,
                pauseReason: orchestrator.pauseReason ?? null
              }, null, 2)
            },
            { name: '日志-应用.txt', data: appLogs.join('\n') || '(还没有日志)' },
            {
              name: '日志-SnowLuma.txt',
              data: snowlumaLogs.map((l) => `[${new Date(l.at).toISOString()}] [${l.stream}] ${l.text}`).join('\n') || '(还没有日志)'
            }
          ]);
        } catch (error) {
          return json(res, 500, { error: `打包失败：${error?.message ?? error}` });
        }
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="qq-agent-diag-${stamp}.zip"`,
          'content-length': buf.length
        });
        return res.end(buf);
      }

      // ── 空闲「梦」（笔记）──
      // 只读功能：见 src/dream.js。这里只负责读列表、手动做一次、清空。
      if (pathname === '/api/dreams' && method === 'GET') {
        return json(res, 200, dreamer.list());
      }
      if (pathname === '/api/dreams' && method === 'DELETE') {
        return json(res, 200, { ok: true, removed: dreamer.clear() });
      }
      if (pathname === '/api/dream' && method === 'POST') {
        // 手动"现在做一次"：跳过开关/时段/"今天做过了"，但仍然要有模型、要有人说过话。
        // 同步等结果 —— 这是用户主动点的按钮，等出确定答案比"回头再看"好。
        const body = await readBody(req).catch(() => ({}));
        const force = body?.force !== false;
        const result = await dreamer.runNow({ force });
        return json(res, result.ok ? 200 : 409, result);
      }

      // ── 成本看板：按天 / 按会话 / 按模型统计 ──
      // range: 'today'=今天0点起 | '24h'=最近24小时 | '3'|'7'|'14'|'30'=最近N天
      if (pathname === '/api/usage/stats' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 某个维度下的明细（点表格行时弹窗用）
      // dim: 'chat' | 'model' | 'day'  key: 对应值  by: 'day' | 'model' | 'chat'
      if (pathname === '/api/usage/breakdown' && method === 'GET') {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/model-prices' && method === 'GET') {
        const model = String(url.searchParams.get('model') || getConfig().api?.model || '');
        return json(res, 200, {
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(model),
          remote: priceFeedStatus()   // 远程价格表状态（设置页展示：来源/时间/条目数/错误）
        });
      }

      // 手动触发一次远程价格表拉取（设置页「立即拉取」按钮）
      if (pathname === '/api/model-prices/refresh' && method === 'POST') {
        const st = await refreshPriceFeed(getConfig().api?.priceRemoteUrl || '');
        return json(res, 200, {
          ok: st.ok,
          remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }

      // ── SnowLuma 进程管理 ──
      if (pathname === '/api/snowluma/launch' && method === 'POST') {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/logs' && method === 'GET') {
        return json(res, 200, { logs: snowlumaLogs.slice(-200) });
      }

      if (pathname === '/api/snowluma/stop' && method === 'POST') {
        try {
          const stopped = stopSnowluma();
          return json(res, 200, { ok: true, stopped, embedded: snowlumaStatus().embedded, pid: snowlumaStatus().pid });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/snowluma/open-folder' && method === 'POST') {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/snowluma/open-webui' && method === 'POST') {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }

      // ── 体检/引导相关 ──
      if (pathname === '/api/onebot/groups' && method === 'GET') {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/onebot/friends' && method === 'GET') {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // ── 手动群发（给「开机 / 关机」通知用）────────────────────────────
      // 只发**群聊**、只发**白名单里的群**（allow.groups）。白名单为空且勾了
      // allowAllWhenEmpty 时才退化成"机器人真实加过的所有群"。
      //
      // GET  = 空跑，只回报"会发给几个群"，让界面在确认框里显示真实数字（而不是拿前端缓存的配置猜）
      // POST = 真发。body: { text }，一次一句话，最长 200 字。
      // 走的是和机器人自己发言同一条 SendQueue（限频、留档、SSE 广播都一致），
      // 所以这条通知会作为"我"记进存档 —— 下次运行模型能看到自己刚喊过开机。
      const SCOPE_LABEL = { groups: '白名单群聊', privates: '白名单私聊', both: '白名单群聊 + 私聊' };
      const normalizeScope = (v) => {
        const s = String(v ?? '').trim().toLowerCase();
        return (s === 'privates' || s === 'both') ? s : 'groups';
      };
      const broadcastTargets = async (scope = 'groups') => {
        const allow = getConfig().allow || {};
        const clean = (arr) => (Array.isArray(arr) ? arr : []).map((x) => String(x).trim()).filter(Boolean);
        const wantGroup = scope === 'groups' || scope === 'both';
        const wantPrivate = scope === 'privates' || scope === 'both';
        const keys = [];
        let note = '';
        if (wantGroup) {
          let ids = clean(allow.groups);
          if (!ids.length && allow.allowAllWhenEmpty) {
            const list = await onebot.call('get_group_list');
            ids = (Array.isArray(list) ? list : (list?.data ?? []))
              .map((g) => String(g.group_id)).filter(Boolean);
            note = '（白名单为空 + 已勾选"全部放行" → 用了全部群聊）';
          }
          keys.push(...ids.map((id) => `group:${id}`));
        }
        if (wantPrivate) keys.push(...clean(allow.private).map((id) => `private:${id}`));
        // 去重（白名单里手滑填两次不该发两条）
        return { keys: [...new Set(keys)], scope: SCOPE_LABEL[scope] + note };
      };

      if (pathname === '/api/broadcast' && method === 'GET') {
        try {
          const scope = normalizeScope(url.searchParams.get('scope'));
          const { keys, scope: label } = await broadcastTargets(scope);
          const counts = {
            groups: keys.filter((k) => k.startsWith('group:')).length,
            privates: keys.filter((k) => k.startsWith('private:')).length
          };
          return json(res, 200, { ok: true, scope, scopeLabel: label, total: keys.length, counts, targets: keys });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/broadcast' && method === 'POST') {
        try {
          const body = await readBody(req);
          const text = String(body?.text ?? '').trim();
          const scope = normalizeScope(body?.scope);
          if (!text) return json(res, 400, { ok: false, error: '要发的内容是空的' });
          if (text.length > 200) return json(res, 400, { ok: false, error: `内容太长了（${text.length} 字，上限 200）` });
          const { keys, scope: label } = await broadcastTargets(scope);
          if (!keys.length) {
            return json(res, 200, { ok: false, scope, scopeLabel: label, total: 0, sent: [], failed: [], error: '白名单里没有可发的会话，没发出去' });
          }
          // 每个会话各自的发送链是独立的，所以并行发；会话内仍然是串行 + 真人化间隔
          const results = await Promise.all(keys.map(async (chatKey) => {
            try {
              const r = await sender.sendTextBatch(chatKey, text);
              return { chatKey, ok: true, messageId: r?.sent?.[0]?.messageId ?? null };
            } catch (error) {
              return { chatKey, ok: false, error: String(error?.message ?? error) };
            }
          }));
          const sent = results.filter((x) => x.ok);
          const failed = results.filter((x) => !x.ok);
          return json(res, 200, {
            ok: failed.length === 0,
            scope,
            scopeLabel: label,
            total: keys.length,
            sent: sent.map((x) => ({ chatKey: x.chatKey, messageId: x.messageId })),
            failed: failed.map((x) => ({ chatKey: x.chatKey, error: x.error }))
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/persona-templates' && method === 'GET') {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`,
          name: p.name,
          text: p.text,
          customRules: p.customRules || '',
          builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }

      // 用户自定义人设：新增 / 删除
      if (pathname === '/api/persona-templates' && method === 'POST') {
        const body = await readBody(req).catch(() => ({}));
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        // customRules 允许为空
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }

      const personaDeleteMatch = /^\/api\/persona-templates\/(custom_\d+)$/.exec(pathname);
      if (personaDeleteMatch && method === 'DELETE') {
        const idx = Number(personaDeleteMatch[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }

      // ── 多提供商模型目录 ──
      if (pathname === '/api/providers' && method === 'GET') {
        const providers = currentProviders().map((p) => ({
          id: p.id,
          displayName: p.displayName,
          baseURL: p.baseURL,
          apiKey: '',              // 不把真实 Key 暴露给 UI；有 Key 用 hasKey 表示
          apiKeyFrom: p.apiKeyFrom || '',
          needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey,
          anthropicOrigin: p.anthropicOrigin === true,
          models: p.models,
          modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }

      // 显示目录提供商的真实 Key（本地 UI 点击“显示”用）
      // 明文密钥端点：仅放行本机控制台请求，挡住外部网页冒用（见 keyEndpointAllowed）。
      if (pathname === '/api/providers/key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }

      // 显示顶层 api.apiKey（手动模式、未选目录提供商时用）
      if (pathname === '/api/api-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }

      // 显示某个搜索服务的真实 Key（本地 UI 点击“显示”用）。
      // /api/config 里的搜索 Key 是脱敏的，所以“显示”必须走这里。
      if (pathname === '/api/search-key' && method === 'GET') {
        if (!keyEndpointAllowed(req)) {
          return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        }
        const field = String(url.searchParams.get('field') || '');
        // 自定义搜索服务的 Key 不走这里（它们存在 webSearch.providers 数组里，
        // 由 /api/search-providers 管理，且添加时是一次性输入，不提供明文回读）。
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        if (!allowed.includes(field)) {
          return json(res, 400, { error: `未知搜索服务：${field}` });
        }
        return json(res, 200, { apiKey: String(getConfig().webSearch?.[field]?.apiKey || '') });
      }

      // 用当前 api 配置拉取模型列表（前端“获取列表”）
      if (pathname === '/api/providers/fetch-models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          const apiKey = body.apiKey !== undefined ? String(body.apiKey ?? '') : String(cfgNow.api.apiKey || '');
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试单个提供商（测试连通性）
      if (pathname === '/api/providers/test-one' && method === 'POST') {
        try {
          const body = await readBody(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 用 baseUrl + apiKey + model 发送一次最小 chat 测试请求。
      // apiKey 可省略：省略时由服务端自己解析真实 Key 使用（不外发给客户端），
      // 这样未配置 server.token 时"测试连通性"依然可用。
      if (pathname === '/api/providers/test-chat' && method === 'POST') {
        try {
          const body = await readBody(req);
          const submitted = String(body.apiKey ?? '').trim();
          // 掩码 / 空 → 说明客户端没有新 Key，用服务端已保存的
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const result = await testModelChat({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey,
            model: String(body.model ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 新增提供商（同 baseURL 自动合并）
      if (pathname === '/api/providers' && method === 'POST') {
        try {
          const body = await readBody(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? ''),
            models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 给已有提供商追加模型
      if (pathname === '/api/providers/models' && method === 'POST') {
        try {
          const body = await readBody(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除某提供商下的一个模型
      if (pathname === '/api/providers/models' && method === 'DELETE') {
        try {
          const body = await readBody(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/providers/set-key' && method === 'POST') {
        const body = await readBody(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }

      if (pathname === '/api/providers/test-all' && method === 'POST') {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }

      if (pathname === '/api/vision/results' && method === 'GET') {
        return json(res, 200, { results: { ...builtinVisionResults(currentProviders()), ...visionResults() }, scanning: visionScan.running });
      }

      if (pathname === '/api/vision/scan' && method === 'POST') {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await readBody(req).catch(() => ({}));
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({
          providers: currentProviders(),
          emit,
          onlyProviderIds,
          timeoutMs: 25000,
          limit: 3
        })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }

      // ── 自定义搜索提供商（可添加多个，交互沿用模型提供商那套）──
      if (pathname === '/api/search-providers' && method === 'GET') {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type,
          baseUrl: p.baseUrl,
          model: p.model,
          count: p.count,
          timeoutMs: p.timeoutMs,
          hasApiKey: Boolean(String(p.apiKey || '').trim())   // 不返回明文
        }));
        return json(res, 200, { providers: list });
      }

      // 新增/更新：同 baseUrl + type 视为同一项，覆盖其配置
      if (pathname === '/api/search-providers' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // 掩码/空 = 保持原 Key 不变
            const submitted = String(body.apiKey ?? '').trim();
            if (submitted && submitted !== '******') existing.apiKey = submitted;
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type,
              baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, {
            ok: true,
            provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) }
          });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 删除一个自定义搜索提供商
      if (pathname === '/api/search-providers' && method === 'DELETE') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          // 若当前正选中被删的那项，回落 bing，避免搜索直接报错
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) {
            updateConfig({ webSearch: { provider: 'bing' } });
          }
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 测试搜索是否可用
      //
      // ⚠️ 2026-09-17 修：原来这里**无条件**调 customSearch()，而 customSearch 只认
      //    `webSearch.providers[]` 里那些「自定义搜索提供商」。可实际配置常用的是
      //    `webSearch.provider = 'deepseek' | 'bing' | ...`，走的是另一条路 webSearch()。
      //    ⇒ providers[] 为空时，无论传什么 providerId（连 'bing' 也一样）都返回同一句
      //      「自定义搜索未配置接口地址」，latencyMs 0~2ms（根本没发请求）——
      //      用户点「测试」会以为自己的搜索坏了，其实配置是好的。
      //    现在：显式给了 providerId 就按它测（前端自定义列表沿用）；没给就按**配置的**
      //    provider 测，并把实际用的是哪一个报回去（原来不报，所以根本看不出测错了对象）。
      if (pathname === '/api/search-providers/test' && method === 'POST') {
        const startedAt = Date.now();
        // body 必须在 try 外面读一次：请求体是流，**只能消费一次**，
        // 放到 catch 里再读一次会拿到空对象（错误分支就报不出正确的 provider 了）。
        const testBody = await readBody(req).catch(() => ({}));
        const provId = String(testBody?.providerId ?? '').trim();
        const configured = String(getConfig().webSearch?.provider || 'bing').toLowerCase();
        const explicit = Boolean(provId) && provId !== 'current';
        const used = explicit ? provId : configured;
        try {
          // 不传 providerId 时 customSearch 会回落到**当前配置的**提供方
          // （见 web-search.js 里那处 fallback）
          const r = await customSearch('qq agent 测试', explicit ? provId : null);
          return json(res, 200, {
            ok: true,
            result: {
              ok: true,
              provider: used,
              scope: explicit ? 'custom' : 'configured',
              count: r.results.length,
              sample: r.results[0]?.title || '',
              latencyMs: Date.now() - startedAt
            }
          });
        } catch (error) {
          return json(res, 200, {
            ok: true,
            result: {
              ok: false,
              provider: used,
              scope: explicit ? 'custom' : 'configured',
              note: String(error?.message ?? error),
              latencyMs: Date.now() - startedAt
            }
          });
        }
      }

      if (pathname === '/api/test/api' && method === 'POST') {
        const startedAt = Date.now();
        try {
          const r = await chatCompletion({
            messages: [{ role: 'user', content: '请只回复两个字符：pong' }],
            tools: null,
            temperature: 0
          });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }

      // 系统提示自定义：给管理端「设置 → 人设 → 系统提示自定义」用。
      // 返回内置段落原文 + 当前覆盖 + 最终生效文本，UI 据此展示"内置默认"、
      // 支持整份替换与逐段替换（内置提示原本硬编码在 src/prompt.js，界面上改不了）。
      if (pathname === '/api/system-prompt' && method === 'GET') {
        const persona = getConfig().persona || {};
        const defaults = buildDefaultSegments(persona);
        const overrides = persona.systemPromptSegments && typeof persona.systemPromptSegments === 'object'
          ? persona.systemPromptSegments
          : {};
        return json(res, 200, {
          ok: true,
          fullOverride: String(persona.systemPrompt ?? ''),
          segments: Object.keys(defaults).map((key) => ({
            key,
            label: SYSTEM_SEGMENT_LABELS[key] || key,
            default: defaults[key],
            override: String(overrides[key] ?? '')
          })),
          effective: buildSystemPrompt()
        });
      }

      // ── 表情包（管理端「表情包」页签）──
      // 内置表情库原本只有给模型用的工具（list_stickers / sticker_note），
      // 管理端连看都看不到；这两个接口把"看"和"改机器人备注/标签"补上。
      //
      //   GET /api/stickers             读本地表情库（60s 内用缓存）
      //   GET /api/stickers?refresh=1   强制从 QQ 重新拉一次收藏表情
      //   PUT /api/stickers/<id>        改 localNote / tags / usage
      if (pathname === '/api/stickers' && method === 'GET') {
        const force = url.searchParams.get('refresh') === '1';
        const synced = await stickers.sync(force);
        return json(res, 200, {
          ok: true,
          fromCache: !!synced.fromCache,
          disabled: !!synced.disabled,
          syncError: synced.error || '',
          syncedAt: Number(stickers.syncedAt) || 0,
          stickers: (synced.entries || []).map((e) => ({ ...e }))
        });
      }

      //   GET /api/stickers/<id>/image   表情缩略图（2026-09-17）
      //
      // 为什么要有这个接口：表情库只存 QQ 的远程链接，而链接里的 rkey 十几小时就过期
      // （实测 36 条**全部**返回 retcode -5503007 "download url has expired"）。
      // 原来界面直接把旧链塞进 <img src>，链一过期缩略图就是一块没有任何解释的黑。
      // 这里改成走服务端：**本地缓存优先**（data/stickers/<id>.bin），没有才换新链下载并缓存。
      // 缓存命中时带上 immutable 的强缓存头 —— 内容寻址、永不变化，浏览器可以一直留着。
      const stickerImgMatch = /^\/api\/stickers\/([^/]+)\/image$/.exec(pathname);
      if (stickerImgMatch && method === 'GET') {
        const wantedId = decodeURIComponent(stickerImgMatch[1]);
        const all = (await stickers.sync(false)).entries || [];
        const entry = all.find((e) => e.id === wantedId) || null;
        if (!entry) return json(res, 404, { ok: false, error: '没有这张表情' });
        try {
          // ?thumb=1：网格缩略图只要第一帧 —— 36 张动画 GIF 缓存下来合计 80MB，整页全发太重
          const img = await ensureStickerImage(onebot, entry, { thumb: url.searchParams.get('thumb') === '1' });
          res.writeHead(200, {
            'content-type': img.mime,
            'content-length': img.bytes.length,
            'cache-control': 'public, max-age=31536000, immutable'
          });
          return res.end(img.bytes);
        } catch (error) {
          return json(res, 404, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // 只允许改"机器人认知层"的三个字段：url / md5 / desc 都来自 QQ，不让界面改。
      const stickerEditMatch = /^\/api\/stickers\/([^/]+)$/.exec(pathname);
      if (stickerEditMatch && (method === 'PUT' || method === 'POST')) {
        let stickerId = stickerEditMatch[1];
        try { stickerId = decodeURIComponent(stickerId); } catch { /* 用原样 */ }
        const body = await readBody(req).catch(() => ({}));
        const patch = {};
        if (body.note !== undefined) patch.note = String(body.note ?? '');
        if (body.usage !== undefined) patch.usage = String(body.usage ?? '');
        // tags 允许传数组或"逗号/空格分隔"的字符串；传空 = 清空标签
        if (body.tags !== undefined) {
          patch.tags = Array.isArray(body.tags)
            ? body.tags
            : String(body.tags ?? '').split(/[,，\s]+/).filter(Boolean);
        }
        const entry = stickers.note(stickerId, patch);
        if (!entry) return json(res, 404, { ok: false, error: '找不到这个表情（可能已从 QQ 收藏里移除，刷新一下再试）' });
        emit('sticker-update', { id: entry.id });
        return json(res, 200, { ok: true, sticker: { ...entry } });
      }

      // 删除表情：**只允许删非 QQ 收藏的**（AI 收藏 / 手动加的）。
      // QQ 收藏是同步来的源，删了下次 sync 又回来，所以在 stickers.remove() 里直接拒绝。
      if (stickerEditMatch && method === 'DELETE') {
        let stickerId = stickerEditMatch[1];
        try { stickerId = decodeURIComponent(stickerId); } catch { /* 用原样 */ }
        const r = stickers.remove(stickerId);
        if (!r.removed) return json(res, r.entry ? 400 : 404, { ok: false, error: r.reason || '删除失败' });
        emit('sticker-update', { id: stickerId, removed: true });
        return json(res, 200, { ok: true, removed: { ...r.entry } });
      }

      if (pathname === '/api/config' && method === 'GET') {
        // 不把任何真实 Key 暴露给前端：递归清空所有密钥类字段，用 hasKey 表示"有密钥"。
        // 注意：不要用手工逐字段列举——之前漏了 5 个搜索 Key 和 2 个 SnowLuma 令牌，
        // 加新 provider 时还会继续漏。这里按字段名模式统一处理。
        return json(res, 200, sanitizeConfig(cfgNow));
      }

      if (pathname === '/api/config' && method === 'POST') {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(next.api?.priceRemoteUrl || '');   // 远程价格表 URL 可能改了（内部幂等）
        emit('status', { configUpdated: true });
        return json(res, 200, { ok: true, config: next });
      }

      if (pathname === '/api/version' && method === 'GET') {
        // 纯本地读取，无网络依赖：设置页"当前版本"展示用
        return json(res, 200, { version: localVersion() });
      }

      if (pathname === '/api/update-check' && method === 'GET') {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/models' && method === 'GET') {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      if (pathname === '/api/sessions' && method === 'GET') {
        // 上限 2^20（Kondius 钦定 1048576）：约等于不限，但拦得住真正的失控请求。
        // 前端靠分页（一次渲染 50 条）避免卡顿，后端不截断。
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }

      const sessionMatch = /^\/api\/sessions\/([\w-]+)$/.exec(pathname);
      if (sessionMatch && method === 'GET') {
        const s = sessions.get(sessionMatch[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }

      // 删除单条会话留档（管理端「会话」页的 × 按钮）。
      // 运行中的会话会被拒绝：编排器还在往那个文件里写，删了会边写边复活。
      if (sessionMatch && method === 'DELETE') {
        const r = sessions.remove(sessionMatch[1]);
        if (!r.ok) return json(res, 400, r);
        emit('sessions-changed', { deleted: sessionMatch[1] });
        return json(res, 200, r);
      }

      // 清空全部会话留档（运行中的保留，并在返回里告知跳过了几个）。
      if (pathname === '/api/sessions' && method === 'DELETE') {
        const r = sessions.clearAll();
        emit('sessions-changed', { cleared: true, ...r });
        return json(res, 200, { ok: true, ...r });
      }

      if (pathname === '/api/chats' && method === 'GET') {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        // 附带群名，让 UI 能显示"群名（群号）"。
        // 群名要调 OneBot 拿，可能慢或失败 —— 用 allSettled 保证绝不影响主流程：
        // 拿不到的 chatName 为空，UI 自动退回只显示群号。
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))   // 3s 超时保护
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }

      // 记忆文件列表（记忆页签）：白名单里的每个群都显示，含无记忆的
      if (pathname === '/api/memory-files' && method === 'GET') {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey,
            impressionCount,
            memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        // 白名单里的群没有记忆也要显示
        const seen = new Set(files.map((f) => f.chatKey));
        // 补上白名单里还没有记忆的会话（缺字段也要有默认值，前端统一处理）
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) {
            files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
          }
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) {
            files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
          }
        }
        // 带上"正在整理"状态：切页签后前端靠它恢复提示，
        // 否则用户切走再切回，完全看不出整理是在跑还是已经中断。
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        // 空记忆标记：白名单里的会话，一个记忆文件都还没有（从没用过记忆工具，
        // 或者记忆被清空/整理后剩下的空壳）。这种条目**不是文件**，删不掉 ——
        // 前端据此把它们默认折叠起来，并提供"隐藏"。
        const hiddenEmpty = new Set((getConfig().memory?.hiddenEmptyChats || []).map(String));
        for (const f of files) {
          f.empty = !f.memberCount && !f.impressionCount;
          f.hidden = hiddenEmpty.has(f.chatKey);
        }
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy], hiddenEmpty: [...hiddenEmpty] });
      }

      const memoryFileMatch = /^\/api\/memory-files\/(group|private)_(\d+)$/.exec(pathname);
      if (memoryFileMatch && method === 'GET') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        return json(res, 200, {
          ...memory.query(chatKey),
          members: memory.members(chatKey)
        });
      }

      // 清空整个会话的记忆：成员文件 + 会话目录 + 整理备份一起删（管理端「记忆」页）
      if (memoryFileMatch && method === 'DELETE') {
        const chatKey = `${memoryFileMatch[1]}:${memoryFileMatch[2]}`;
        const removed = memory.removeChat(chatKey);
        emit('memory-update', { chatKey, phase: 'cleared' });
        return json(res, 200, { ok: true, chatKey, removed });
      }

      // 手动编辑某个群友的印象（PUT 编辑：QQ号必填，备注可同步保存 / DELETE 删除成员文件）
      const memoryMemberMatch = /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/.exec(pathname);
      if (memoryMemberMatch && method === 'PUT') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        const body = await readBody(req).catch(() => ({}));
        try {
          const member = memory.editMemberImpression(chatKey, {
            userId: memoryMemberMatch[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
      if (memoryMemberMatch && method === 'DELETE') {
        const chatKey = `${memoryMemberMatch[1]}:${memoryMemberMatch[2]}`;
        memory.removeMember(chatKey, memoryMemberMatch[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: true });
      }

      // 手动整理某个群的记忆：遍历聊天记录中出现的成员，逐人整理直到收敛
      if (pathname === '/api/memory-files/consolidate' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });

          // 可选：只整理指定的群友（QQ 号数组）。不传 = 整理全群。
          // 传了但记忆里还没有此人时，会从聊天记录里新建印象。
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          // 手动触发：跳过门槛/冷却检查，且对零印象的人启用"新建印象"模式
          const force = body.force !== false;

          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => {
              emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) });
            })
            .catch((error) => {
              emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) });
            })
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatMsgMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages$/.exec(pathname);
      if (chatMsgMatch && method === 'GET') {
        const chatKey = `${chatMsgMatch[1]}:${chatMsgMatch[2]}`;
        // 单群消息上限 2^20（Kondius 钦定）：约等于不限，存档一口气全给
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply,
          // media 必须带：金句上传要靠它把图片 URL 传给服务器转存
          // （曾经漏了这个字段，前端收到的 media 永远是 undefined → 图片全丢）
          media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }

      // ── 删除存档（管理端「存档」页）──
      // 1) 删单条消息：/api/chats/<group|private>_<id>/messages/<本地消息 id>
      const chatMsgDelMatch = /^\/api\/chats\/(group|private)_(\d+)\/messages\/(\d+)$/.exec(pathname);
      if (chatMsgDelMatch && method === 'DELETE') {
        const chatKey = `${chatMsgDelMatch[1]}:${chatMsgDelMatch[2]}`;
        const okDel = store.deleteMessage(chatKey, chatMsgDelMatch[3]);
        if (!okDel) return json(res, 404, { ok: false, error: '消息不存在（可能已被删除）' });
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, chatKey });
      }

      // 2) 清空某会话的整份存档：删磁盘文件 + 内存态，删完它就从存档列表消失
      const chatDelMatch = /^\/api\/chats\/(group|private)_(\d+)$/.exec(pathname);
      if (chatDelMatch && method === 'DELETE') {
        const chatKey = `${chatDelMatch[1]}:${chatDelMatch[2]}`;
        const removed = store.deleteChat(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, chatKey, removed });
      }

      // ── 金句上传取图：把存档消息里的图片转成 dataURL ──
      // 背景：存档只存图片 URL，而 QQ 图床的 rkey 会过期（失效后全网 400 invalid url，
      // 服务器转存必败、原图也救不回）。NapCat/SnowLuma 收到图时有本地缓存，
      // 走 OneBot get_image 拿缓存文件读出来，彻底不依赖 URL 时效。
      // POST { items: [{ file, url }] } → { results: [{ dataUrl } | null, ...] }
      const mediaDataMatch = pathname === '/api/media-data';
      if (mediaDataMatch && method === 'POST') {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);   // 不存在直接抛
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            // 路径 1：OneBot get_image → NapCat 本地缓存文件
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              // 有的实现返回的是可下载的 url
              if (!dataUrl && ret?.url) {
                const r = await fetch(String(ret.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
                  }
                }
              }
            } catch { /* 缓存没有就走下一条 */ }
            // 路径 2：直接拉存档里的 URL（新消息 URL 还没过期时有效）
            if (!dataUrl && it?.url) {
              try {
                const r = await fetch(String(it.url), { signal: AbortSignal.timeout(10000) });
                if (r.ok && (r.headers.get('content-type') || '').startsWith('image/')) {
                  const buf = Buffer.from(await r.arrayBuffer());
                  if (buf.length && buf.length <= 15 * 1024 * 1024) {
                    dataUrl = `data:${r.headers.get('content-type')};base64,${buf.toString('base64')}`;
                  }
                }
              } catch { /* 过期就放弃，返回 null 让前端保留原 URL */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }

      // 群成员列表（OneBot get_group_member_list），用于备注与记忆页成员展示
      const groupMembersMatch = /^\/api\/groups\/(\d+)\/members$/.exec(pathname);
      if (groupMembersMatch && method === 'GET') {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(groupMembersMatch[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      // ── 本子查询（JM 直连 + NH 离线兜底）：给设置页的"检测连通"用 ──
      // GET /api/doujin/status        只回报路径与是否存在（不拉子进程）
      // GET /api/doujin/status?ping=1 额外真发一次 ping（首次会拉起 Python，约 3 秒）
      if (pathname === '/api/doujin/status' && method === 'GET') {
        try {
          const wantPing = url.searchParams.get('ping') === '1';
          let ping = null;
          if (wantPing) {
            try { ping = await jmPing(); } catch (e) { ping = { ok: false, error: String(e?.message ?? e) }; }
          }
          return json(res, 200, { ok: true, paths: jmPaths(), ping });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // ── 本子查询离线库：只读回报 + 导入 ──────────────────────────────────
      //
      // 路径规则与 jm-bridge.js 的 conf() 是**同一份**：直接读它的 nhDbPath 字段
      // （那是 conf() 现算出来的），不在这里重写一遍 config 解析 —— 复制一份迟早会走岔。
      // ⚠️ 目标路径只认 conf().nhDbPath。**没有**任何"请求里直接指定 db 装到哪"的口子，
      //    否则这就是一条"网页端 POST 一下就能往本机任意路径写文件"的接口。
      const csv2nhTimeoutMs = 30 * 60 * 1000;   // CSV 转库：实测 89.4MB/52.58 万行只要 2.3 秒，30 分钟是留给慢磁盘/超大文件的余量
      const RE_DB_PATH = /\.(db|sqlite)$/i;
      const RE_CSV_PATH = /\.csv$/i;

      /** 把本次导入真正会用的目标路径定下来；解析不出来就抛，交给调用方回 400。 */
      function resolveImportTarget() {
        const p = String(jmPaths().nhDbPath || '').trim();
        if (!p) throw new Error('解析不出 NH 库目标路径（配置里的 doujinLookup.nhDbPath 与工具目录都为空）');
        return path.resolve(p);
      }

      /** "abc.db.bak-20260916-120000"：跟真实库同目录、带回滚用的时间戳。 */
      function backupStamp() {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
      }

      // ── SQLite 头解析（纯字节读取，不引新依赖、不拉 sqlite 进程）──────────
      //
      // ① 魔数：前 16 字节必须是 "SQLite format 3\0"（同名常量在下面两条路由里共用）
      // ② 页大小：头里偏移 16 的 2 字节大端（值 1 表示 65536，是 SQLite 的编码约定）
      // ③ 页数：头里偏移 28 的 4 字节大端
      // ④ 表的实际占用：page 1 是 sqlite_master，里面 btree 页 1 存着 nh 表的根页号，
      //    表数据就是 [根页, 页数] 这一段 —— 比整文件大小诚实得多（文件尾部可能有空闲页）
      // ⑤ 索引在不在：sqlite_master 里有没有名字叫 idx_nh_title 的 index 行
      // 行数**不靠头部猜**：btree 根页里的 header 只数得到"根页自己有几格"，
      // 数不出一张万页表的总行数。要么全扫（151MB 太贵），要么给个假数 —— 两个都不要。
      const SQLITE_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');

      /** 读文件开头 n 字节；失败返回 null（调用方一律按"读不到"处理）。 */
      function readHead(fp, n) {
        let fd = null;
        try {
          fd = fs.openSync(fp, 'r');
          const b = Buffer.alloc(n);
          const got = fs.readSync(fd, b, 0, n, 0);
          return got === n ? b : null;
        } catch { return null; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
      }

      /** 读大端无符号整数（len 字节）；越界返回 null。 */
      function readUIntAt(buf, off, len) {
        if (off < 0 || len < 0 || off + len > buf.length) return null;
        let v = 0;
        for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
        return v;
      }

      /** 读 SQLite varint（1~9 字节，大端 7 位一组）；返回 { v, next }，越界返回 null。 */
      function readVarintAt(buf, off) {
        let v = 0;
        for (let k = 0; k < 9; k++) {
          if (off + k >= buf.length) return null;
          const b = buf[off + k];
          // 第 9 字节是整 8 位，不丢最高位（大库的 rowid/page 号会走到这里）
          v = k === 8 ? v * 256 + b : v * 128 + (b & 0x7f);
          if (!(b & 0x80)) return { v, next: off + k + 1 };
        }
        return null;
      }

      /** 记录体里第 idx 个字段（0 基）的字节长度 —— 决定"下一个字段从哪儿开始"。 */
      function fieldLen(serialType) {
        if (serialType === 0 || serialType === 8 || serialType === 9) return 0;
        if (serialType <= 4) return serialType;               // 整数 1/2/3/4/6/8 字节
        if (serialType === 5) return 6;
        if (serialType === 6 || serialType === 7) return 8;
        if (serialType === 10 || serialType === 11) return 0;
        // ≥12：偶数=BLOB(n=(t-12)/2)、奇数=TEXT(n=(t-13)/2)。
        // ⚠️ 统一写 (t-12)>>1 —— 与 (t-13)/2 对奇数**不等**（13→0 而不是 0.5），
        //    写成 (t-13)/2 会让每个字符串字段少算半字节，后面所有字段的起点全错位。
        return (serialType - 12) >> 1;
      }

      /**
       * 解析 page 1 里的 sqlite_master 叶页，返回 [{ type, name, root }]。
       *
       * sqlite_master 的列是 **(type, name, tbl_name, rootpage, sql)** —— 所以需要的是 0/1/3 三列。
       * 三个容易踩的点：
       *   ① **cell 指针数组从页头 +8 开始**（页头 0..7 是 type/空闲块/格数/内容起点/碎片数，
       *      指针紧跟其后）。写成"页头 +0"会从页头字段里读出垃圾指针，一个 cell 也解不出来。
       *   ② 字段的字节长度由 serial type 决定，**必须逐字段累加**才能定位 name 的起点 ——
       *      name 是长度不定的字符串，按固定偏移取一定读错。
       *   ③ **serial type 本身也是 varint**（不是 1 字节！）。短字符串（<64 字节）的 type 落在
       *      13..127 里正好 1 字节，所以"当字节读"在大多数行上**看起来是对的** ——
       *      一旦某列超过 63 字节（比如 nh 表的 sql 那一列，长 78 字），type 变成 169 = 0x81 0x2B，
       *      两字节，整行字段的起点就全错位。第一版就是栽在这里。
       *   ④ hdr.v 是"**从 rec 数的**头总长"（含它自己那个字节），所以 serial type 一直读到
       *      rec+hdr.v 为止、字段数据从 rec+hdr.v 开始。
       *   ⑤ **type 列不是整数**：SQLite 里 'table'/'index' 这些是**字符串字面量**，行里存的是 TEXT
       *      （真正的整数列是第 3 列的 rootpage）。所以判"这行是不是合法 master 行"要看 types[3]
       *      是不是 1~4 字节整数，而不是看 types[1]（name 也是 TEXT，但它不定长）。
       * buf 给的是文件开头那一整块（够覆盖 page 1 即可），越界一律跳过、不抛。
       */
      function parseSqliteMaster(buf) {
        const out = [];
        const H = 100;                                        // 页头长度（两种页大小都是 100）
        // ⚠️ cell 内容从**页尾往前长**，所以只读 100 字节页头的话，指针指的地方根本不在 buf 里。
        if (buf.length < H + 12) return out;
        if (buf[H] !== 0x0d && buf[H] !== 0x05) return out;   // 不是叶页就放弃，别硬解
        const nCells = buf.readUInt16BE(H + 3);
        if (nCells < 1 || nCells > 8192) return out;
        for (let i = 0; i < nCells; i++) {
          const cellOff = readUIntAt(buf, H + 8 + i * 2, 2);  // ← 指针数组从页头 +8 起
          if (cellOff === null || cellOff + 3 > buf.length) continue;
          const pay = readVarintAt(buf, cellOff);             // 载荷长度
          if (!pay) continue;
          const rowid = readVarintAt(buf, pay.next);          // rowid
          if (!rowid) continue;
          const rec = rowid.next;                             // 记录体起点（hdrLen 变长整数所在处）
          const hdr = readVarintAt(buf, rec);                 // hdr.v = 记录头总长（含它自己）
          if (!hdr || hdr.v < 2) continue;                    // 至少要有一个 serial type
          const hdrEnd = rec + hdr.v;                         // 记录头结束 = 字段数据区起点
          if (hdrEnd > buf.length) continue;
          const types = [];                                   // serial type 逐个 varint 读，别当字节读（见 ③）
          for (let p = hdr.next; p < hdrEnd;) {
            const t = readVarintAt(buf, p);
            if (!t) break;
            types.push(t.v);
            p = t.next;
          }
          if (types.length < 4) continue;                     // 少于 4 列不可能有 rootpage
          const body = hdrEnd;                                // 字段数据区起点
          const nameOff = body + fieldLen(types[0]);          // 跳过 type
          const nameLen = fieldLen(types[1]);
          if (types[1] !== 13 || nameOff + nameLen > buf.length) continue;   // name 必须是 TEXT
          const name = buf.subarray(nameOff, nameOff + nameLen).toString('utf8');
          const rootOff = nameOff + nameLen + fieldLen(types[2]);   // 再跳过 tbl_name
          const rootLen = fieldLen(types[3]);
          if (rootLen < 1 || rootLen > 4) continue;           // rootpage 必须是 1~4 字节整数
          const root = readUIntAt(buf, rootOff, rootLen);
          // type 是 TEXT（'table'/'index'）：读出来当诊断信息用，读不到就 null，不影响 name/root
          const typeLen = fieldLen(types[0]);
          const type = types[0] === 13 && typeLen > 0 && typeLen <= 16
            ? buf.subarray(body, body + typeLen).toString('utf8') : null;
          if (root !== null) out.push({ type, name, root });
        }
        return out;
      }

      /**
       * 数表里到底有多少行 —— 只对**小库**做，调用方按表大小把关。
       *
       * 做法：从表的根页出发，把所有叶页的"页头格数"加起来（页头偏移 3 的 2 字节）。
       * 这是精确值，但代价是**要读遍每一个叶页** —— 151MB 的库要读 151MB，绝不干。
       * 所以调用方只在小库上调用；这里再加一层时间闸（超时就放弃），万一磁盘很慢也不会卡死。
       * 数不出来返回 undefined —— 宁可不给，也不给个错的。
       */
      function countRowsByWalking(fp, rootPage, pageSize, budgetMs = 600) {
        let fd = null;
        try {
          fd = fs.openSync(fp, 'r');
          const page = Buffer.alloc(pageSize);
          const stack = [rootPage];
          const seen = new Set();                             // 防坏库指回自己造成死循环
          const until = Date.now() + budgetMs;
          let total = 0;
          while (stack.length) {
            if (Date.now() > until) return undefined;
            const pg = stack.pop();
            if (!pg || pg < 1 || seen.has(pg) || seen.size > 20000) continue;
            seen.add(pg);
            const got = fs.readSync(fd, page, 0, pageSize, (pg - 1) * pageSize);
            if (got !== pageSize) return undefined;
            const type = page[100];
            const n = page.readUInt16BE(103);
            if (type === 0x05 || type === 0x0d) { total += n; continue; }   // 表叶页：格数就是行数
            if (type !== 0x02) return undefined;                            // 索引页 / 异常页：放弃
            for (let i = 0; i < n; i++) {
              const child = readUIntAt(page, 108 + i * 2, 4);               // 内部页 cell = 4 字节左孩子 + varint(key)
              if (child === null) return undefined;
              stack.push(child);
            }
          }
          return total;
        } catch { return undefined; } finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
      }

      /** 只读回报当前离线库状况；**不拉子进程**（进设置页不该有这种副作用）。读不到的字段一律省略。 */
      function doujinDbInfo() {
        const p = String(jmPaths().nhDbPath || '').trim();
        if (!p) return { path: '', exists: false, error: '解析不出 NH 库路径（配置与工具目录都为空）' };
        const fp = path.resolve(p);
        let st = null;
        try { st = fs.statSync(fp); } catch { /* 不存在就是不存在 */ }
        if (!st || !st.isFile()) return { path: fp, exists: false, bytes: 0 };

        const out = { path: fp, exists: true, bytes: st.size };
        // 要读满**整页**（sqlite_master 的 cell 在页尾）。页大小最大 65536，读文件头时还不知道是多少，
        // 所以固定读 64KB —— 一次读、不占内存、不慢；文件比这还小就按文件大小读。
        const head = readHead(fp, Math.min(st.size, 65536));
        if (!head || head.length < 100 || !head.subarray(0, 16).equals(SQLITE_MAGIC)) {
          out.valid = false;                            // 存在，但不是 SQLite —— 如实说
          return out;
        }
        out.valid = true;
        const pageSize = head.readUInt16BE(16) === 1 ? 65536 : head.readUInt16BE(16);
        if (pageSize >= 512 && (pageSize & (pageSize - 1)) === 0) out.pageSize = pageSize;
        const pageCount = head.readUInt32BE(28);
        if (pageCount > 0) out.pages = pageCount;

        const cells = parseSqliteMaster(head);
        if (cells.length) {
          const nhCell = cells.find((x) => x.name === 'nh');
          if (nhCell) {
            const ps = out.pageSize || 4096;
            const pc = pageCount > 0 ? pageCount : Math.ceil(st.size / ps);
            // 表在文件里的位置：插入顺序建库，nh 的根页之后就是它自己的页。
            // 这是个**上界**（后面可能还有别的表/空闲页），所以只在库确实很小时才拿它决定"值不值得数行"。
            if (nhCell.root >= 1 && nhCell.root <= pc) out.tableBytes = (pc - nhCell.root + 1) * ps;
            if (out.tableBytes !== undefined && out.tableBytes <= 64 * 1024 * 1024) {
              const n = countRowsByWalking(fp, nhCell.root, ps);
              if (n !== undefined) out.rows = n;
            }
          }
          out.hasIndex = cells.some((x) => x.name === 'idx_nh_title');
        } else {
          // 表名没解出来（page 1 结构不认识）→ 不猜 hasIndex，字段直接省掉
          delete out.hasIndex;
        }
        return out;
      }

      // GET /api/doujin/db-info —— 离线库现状（路径 / 在不在 / 多大 / 表占多少 / 有索引）
      if (pathname === '/api/doujin/db-info' && method === 'GET') {
        try {
          return json(res, 200, { ok: true, db: doujinDbInfo() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // POST /api/doujin/import-db { path } —— 把用户选的 .db/.sqlite/.csv 装成离线库
      //   （可选 dst：只给测试用，见下面 rawDst 处的注释；界面永远不带）
      //
      // 按扩展名分派：
      //   .db / .sqlite → 先校验 16 字节 SQLite 魔数，再把旧库改名备份、原子换上新的
      //   .csv          → 交给 Python 的 csv2nh 命令转库（旧库由它自己原子替换）
      //   其它          → 400，明确说清只认哪几种
      //
      // ⚠️ **只校验文件头，不做"这真的是 nh 库吗"的深度校验**：
      //    表结构对不对由**下一次真实查询**暴露（jm_server.py 每次查询都新开只读连接，
      //    不缓存句柄，所以换完库不用重启就生效）。深度校验要开 sqlite、要跑 SQL，
      //    为一次导入引入这些不划算，而且拦错了反而挡住"用户自己的库先装上再说"。
      //    响应里 note 会把这件事如实告诉前端，不假装校验过。
      if (pathname === '/api/doujin/import-db' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const raw = String(body?.path || '').trim();
          if (!raw) return json(res, 400, { ok: false, error: '没给文件路径（path）' });
          // 支持带引号的粘贴（Windows 上从资源管理器"复制路径"就是带引号的）
          const src = path.resolve(raw.replace(/^"(.*)"$/, '$1').trim());
          let dst;
          try { dst = resolveImportTarget(); } catch (e) { return json(res, 400, { ok: false, error: String(e?.message ?? e) }); }

          // 可选 dst：**只给自动化测试/多库并行场景用**，界面永远不带它。
          // 端口只监听 127.0.0.1，威胁模型等同本机用户，所以这不是提权口子；
          // 但照样限定扩展名、拒绝目录，避免一个笔误把库写到奇怪的地方去。
          const rawDst = String(body?.dst || '').trim();
          if (rawDst) {
            const d = path.resolve(rawDst.replace(/^"(.*)"$/, '$1').trim());
            if (!RE_DB_PATH.test(d)) return json(res, 400, { ok: false, error: `dst 必须以 .db / .sqlite 结尾：${d}` });
            if (fs.existsSync(d) && !fs.statSync(d).isFile()) return json(res, 400, { ok: false, error: `dst 是个目录，不是文件：${d}` });
            dst = d;
          }

          let st = null;
          try { st = fs.statSync(src); } catch { /* 下面统一报 */ }
          if (!st || !st.isFile()) return json(res, 400, { ok: false, error: `找不到文件：${src}` });

          // ── .db / .sqlite：直接安装 ──
          if (RE_DB_PATH.test(src)) {
            const head = readHead(src, 16);
            if (!head || !head.equals(SQLITE_MAGIC)) {
              return json(res, 400, {
                ok: false,
                error: `这不是 SQLite 数据库文件（前 16 字节不是 "SQLite format 3"）：${src}`
                  + `　如果是 Excel/CSV 导出的表格，请选 .csv 文件导入。`
              });
            }
            const backup = dst + '.bak-' + backupStamp();
            let backedUp = false;
            try {
              if (fs.existsSync(dst)) {
                // 先把旧库改名成备份，再原子替换。rename 在 Windows 上会被"文件被占用"挡住 ——
                // 退回"复制成备份"，成败如实回报，绝不假装备份过。
                try { fs.renameSync(dst, backup); backedUp = true; } catch {
                  fs.copyFileSync(dst, backup);
                  backedUp = true;
                }
              }
              const tmp = dst + '.importing';
              fs.copyFileSync(src, tmp);
              try { fs.renameSync(tmp, dst); } catch (e) {
                try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
                throw e;
              }
            } catch (error) {
              return json(res, 500, {
                ok: false,
                error: `安装失败：${String(error?.message ?? error)}`
                  + (backedUp ? `　（旧库已备份到 ${backup}）` : ''),
                src, dst, backup: backedUp ? backup : null
              });
            }
            return json(res, 200, {
              ok: true, kind: 'db', src, dst, bytes: st.size,
              backup: backedUp ? backup : null, backedUp,
              note: backedUp
                ? '已把旧库改名备份，新的库已就位。这里只校验了文件头是 SQLite，没校验表结构 —— 能不能用要看下一次真实查询。'
                : '新的库已就位。这里只校验了文件头是 SQLite，没校验表结构 —— 能不能用要看下一次真实查询。'
            });
          }

          // ── .csv：交给 Python 转库（旧库由它自己原子替换，覆盖导入幂等）──
          if (RE_CSV_PATH.test(src)) {
            let r = null;
            try {
              r = await jmRequest({ cmd: 'csv2nh', src, dst }, { timeoutMs: csv2nhTimeoutMs });
            } catch (e) {
              return json(res, 502, {
                ok: false, kind: 'csv', src, dst,
                error: `转库失败：${String(e?.message ?? e)}`
                  + `　（CSV 转库期间 JM 查询会排队等它跑完）`
              });
            }
            // Python 的 error 是写给用户看的一句话，**原样透传**，不改写成泛化文案
            if (!r?.ok) {
              return json(res, 200, { ok: false, kind: 'csv', src, dst, error: String(r?.error || '转库失败（Python 没给原因）') });
            }
            return json(res, 200, {
              ok: true, kind: 'csv', src, dst,
              rows: r.rows ?? null, bytes: r.bytes ?? null,
              header: Array.isArray(r.header) ? r.header : undefined,
              ms: r.ms ?? null
            });
          }

          return json(res, 400, {
            ok: false,
            error: `不支持这种文件：${path.basename(src)}　只认 .db / .sqlite（直接装库）或 .csv（转成离线库，通常几秒）`
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      // POST /api/doujin/test { keyword } —— 真查一次（默认查"校园"），用于排障
      if (pathname === '/api/doujin/test' && method === 'POST') {
        try {
          const body = await readBody(req).catch(() => ({}));
          const keyword = String(body?.keyword || '').trim() || '校园';
          let result = null;
          try {
            result = await jmRequest({ cmd: 'search', kw: keyword, limit: 3 });
          } catch (e) {
            result = { ok: false, error: String(e?.message ?? e) };
          }
          return json(res, 200, { ok: true, keyword, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }

      const chatWakeMatch = /^\/api\/chats\/(group|private)_(\d+)\/wake$/.exec(pathname);
      if (chatWakeMatch && method === 'POST') {
        const chatKey = `${chatWakeMatch[1]}:${chatWakeMatch[2]}`;
        // 如实回报"会发生什么"，让界面区分"已开始处理 / 没有未读 / 正在处理 / 档位没命中"。
        // force=true 才真的把不命中的未读扫成已读（界面先弹确认，再带这个参数回来）。
        let body = {};
        try { body = (await readBody(req)) || {}; } catch { body = {}; }
        const r = orchestrator.forceWake(chatKey, { force: !!body.force });
        return json(res, 200, { ok: true, ...r });
      }

      // 手动发一条测试消息（不走模型，直接经 OneBot 发出，用于配置后验证链路）
      const chatTestSendMatch = /^\/api\/chats\/(group|private)_(\d+)\/test-send$/.exec(pathname);
      if (chatTestSendMatch && method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        try {
          const chatKey = `${chatTestSendMatch[1]}:${chatTestSendMatch[2]}`;
          const data = await onebot.sendText(chatTestSendMatch[1], chatTestSendMatch[2], text);
          store.appendSelf(chatKey, { text, ts: Date.now() });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }

      const chatReadMatch = /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/.exec(pathname);
      if (chatReadMatch && method === 'POST') {
        const chatKey = `${chatReadMatch[1]}:${chatReadMatch[2]}`;
        const drained = store.drainUnread(chatKey);
        return json(res, 200, { ok: true, marked: drained.length });
      }

      if (pathname === '/api/pause' && method === 'POST') {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) {
          // 恢复时自动补处理暂停期间积压的未读消息
          orchestrator.drainBacklogAfterResume();
        }
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }

      // 恢复运行，并把所有会话当前未读一次性标记为已读（用户明确选择丢弃积压）
      if (pathname === '/api/pause' && method === 'DELETE') {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = store.drainUnread(chatKey).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }

      return json(res, 404, { error: `未知 API：${method} ${pathname}` });
    }

    // 静态 UI
    if (req.method === 'GET') {
      // 路径穿越防护：
      // 旧实现 file.replace(/\.\./g,'') 只删字面 ".." —— "/....//" 删完仍还原出 ".."，
      // 且 startsWith 校验在 path.join 之后做（顺序颠倒），形同虚设。
      // 正确做法：先 URL 解码 → 规范化 → 拼接 → 用 path.relative 判断跳出界。
      let decoded;
      try {
        decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Bad Request');
        return;
      }
      // 去掉前导斜杠后按 / 与 \ 切段，逐段校验
      const segs = decoded.replace(/^([/\\])+/, '').split(/[/\\]+/);
      // 逐段过滤：拒绝空段、"."、".."、以及任何含控制字符的段
      let blocked = false;
      const clean = [];
      for (const seg of segs) {
        if (seg === '' || seg === '.') continue;      // 空段/当前目录，忽略
        if (seg === '..') { blocked = true; break; }  // 任何 .. 直接拒绝，不做消解
        if (/[\x00-\x1f]/.test(seg)) { blocked = true; break; }
        clean.push(seg);
      }
      if (blocked || clean.length === 0) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      const fullPath = path.join(UI_DIR, ...clean);
      // 二次校验：解析后的路径必须仍在 UI_DIR 内
      const relCheck = path.relative(UI_DIR, fullPath);
      if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
      }
      try {
        const data = fs.readFileSync(fullPath);
        const ext = path.extname(fullPath);
        const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
        res.writeHead(200, { 'content-type': types[ext] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
      }
    }

    res.writeHead(404);
    res.end();
  }

  // ── 启停 ──
  // DSH 自动导入已移除：模型目录改为在设置页手动维护（见 /api/providers 相关接口）。

  // ── 启停 ──
  async function listenOn(port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve(port); // 必须把实际端口传回去，Electron 壳要用它加载页面
      });
    });
  }

  async function start() {
    // 先把 HTTP 服务拉起来，让窗口/浏览器立刻能加载页面（loading 壳）
    const basePort = Number(getConfig().server?.port) || 3210;
    let port = null;
    let lastError = null;
    for (let p = basePort; p < basePort + 10; p++) {
      try {
        port = await listenOn(p);
        break;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') throw error;
      }
    }
    if (port == null) throw lastError ?? new Error('无法监听端口');

    // 匿名用量遥测：启动 90 秒后发第一次，之后每 6 小时一次；失败静默不影响使用
    startTelemetryLoop(log);

    // 加载 Skill（skills/ 与 plugins/）—— 在内置工具注册之后、OneBot 连接之前。
    // 位置照抄上游 0.3.1 的 app.js（第 1296-1321 行），顺序很关键：
    //   buildToolDefs() 是同步的，而技能工具要等 loadPlugins() 之后才进注册表 ——
    //   所以必须"先加载技能、再重建 toolDefs"，否则开关打开了工具却不在列表里。
    //   Orchestrator 构造时那次 buildToolDefs() 抓不到技能工具，这里重赋一次即可
    //   （orchestrator.js 一行都不用改）。
    // 不做热重载（watchPlugins）：那等于"放进目录的 JS 会被自动执行"，是行为变化，
    // 用户没批；要热重载再说。
    try {
      const pluginResult = await loadPlugins({ log });
      log(`[skill] 已加载 ${pluginResult.loaded.length} 个 Skill`
        + (pluginResult.failed.length ? `，失败 ${pluginResult.failed.length}` : ''));
      for (const f of pluginResult.failed) log(`[skill] ❌ ${f.id || '(未知)'}：${f.error}`);
      // 技能状态如实回报：本子查询这类"Skill 加载成功、但开关默认关"的情况，
      // 只有这行能说清它为什么没生效（否则只能靠猜）。
      for (const st of skillManager.list()) {
        log(`[skill] ${st.active ? '✅ 生效' : '⏸️ 未生效'}：${st.name}（${st.id}）${st.active ? '' : ` —— ${st.reason}`}`);
      }
      orchestrator.toolDefs = buildToolDefs();
      log(`[skill] 工具集已刷新：${orchestrator.toolDefs.length} 个工具`);
    } catch (error) {
      log('[skill] 加载失败:', error?.message ?? error);
    }

    // 拉起 SnowLuma（如配置了自动启动）、连 OneBot。
    if (getConfig().snowluma?.autoLaunch) {
      try {
        const wsPort = snowlumaWsPort();
        if (!(await isPortOpen('127.0.0.1', wsPort))) {
          const r = await launchSnowluma();
          if (r.ok && r.launched) {
            for (let i = 0; i < 20 && !(await isPortOpen('127.0.0.1', wsPort)); i++) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        }
      } catch (error) {
        log('[snowluma] 自动启动失败:', error?.message ?? error);
      }
    }
    // OneBot 连接前先尝试从 SnowLuma 配置同步令牌（脱敏副本/首次登录场景尤其重要）
    if (syncSnowlumaTokens()) {
      const c = getConfig();
      onebot.wsUrl = String(c.snowluma?.wsUrl || onebot.wsUrl);
      onebot.httpUrl = String(c.snowluma?.httpUrl || onebot.httpUrl).replace(/\/+$/, '');
      // accessToken/httpToken 已由 applyTokens 直接挂到实例（候选[0]）
    }
    await onebot.connect();
    if (getConfig().proactive?.enabled) orchestrator.startProactiveLoop();
    // 空闲「梦」的定时器（每 5 分钟看一次该不该做；关着的话它自己会跳过）
    dreamer.start();
    log(`控制台已就绪：http://127.0.0.1:${port}`);
    log(`OneBot（SnowLuma）: ws=${getConfig().snowluma?.wsUrl} http=${getConfig().snowluma?.httpUrl}`);
    log(`模型: ${getConfig().api.model || '（未设置，请在设置里选择）'} @ ${getConfig().api.baseUrl}`);
    return port;
  }

  async function stop() {
    await orchestrator.abortAll();
    // 梦的定时器：不留一个还在跑的 interval
    try { dreamer.stop(); } catch { /* ignore */ }
    // 盯令牌文件的轮询同理：退出时必须停掉
    stopTokenWatch();
    onebot.close();
    server.close();
    // 内置启动的 SnowLuma：QQ Agent 退出时一并关掉，避免留一个无窗口的后台进程。
    // 注意：SnowLuma 退出时不一定能立刻把 config 落盘，但我们的 stop 不会再去读它，
    // 下次启动会读到完整文件。
    try { snowlumaProc?.kill(); } catch { /* ignore */ }
    // 本子查询的 Python 子进程同理：不留孤儿
    try { stopJm(); } catch { /* ignore */ }
  }

  return { server, onebot, store, memory, stickers, sender, sessions, orchestrator, start, stop, emit, getConfig, updateConfig, launchSnowluma, stopSnowluma, snowlumaStatus };
}

/**
 * 成本看板数据：按天 / 按会话 / 按群聚合最近 N 天的用量。
 *
 * 数据源是 data/sessions/*.json（会话留档），每个会话对象里已有
 * usage.{promptTokens, completionTokens, cachedTokens} 与 chatKey / model / rounds。
 * 没有历史汇总文件也能算 —— 直接扫留档即可。
 */
/**
 * 解析时间范围参数。
 *   'today' → 今天 00:00 起
 *   '24h'   → 最近 24 小时（滚动窗口，可能跨天）
 *   '3'|'7'|'14'|'30' → 最近 N 个自然日
 */
function resolveRange(raw) {
  const s = String(raw || '7').trim().toLowerCase();
  const now = Date.now();
  if (s === 'today') {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return { mode: 'today', start: d.getTime(), end: now, label: '今天' };
  }
  if (s === '24h') {
    return { mode: '24h', start: now - 24 * 60 * 60 * 1000, end: now, label: '最近 24 小时' };
  }
  const n = Math.min(30, Math.max(1, Number(s) || 7));
  // 按自然日：从 N-1 天前的 0 点算起，保证"7 天"是 7 个完整日历日
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return { mode: 'days', start: d.getTime() - (n - 1) * 24 * 60 * 60 * 1000, end: now, label: `最近 ${n} 天` };
}

/** 本地时区的 YYYY-MM-DD（用于按天分桶）。 */
function dayKeyOf(ts) {
  const d = new Date(Number(ts) || 0);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/**
 * 收集时间窗内的所有"调用行"。
 * 每行是一次真实 API 调用（有 raw 时）或一次会话聚合（无 raw 时），
 * 都带自己的 token、发生时刻、模型、所属会话。
 */
// ── 用量行缓存 ──
// collectUsageRows 要遍历并 JSON.parse 全部会话文件。实测 300 个文件 / 25MB 时
// 单次约 200ms，而前端每 15 秒轮询一次、stats 与 breakdown 还各扫一遍。
// 会话文件是"结束写一次、之后不再改"，所以缓存很安全。
//
// 失效策略（双保险，任一条命中就重算）：
//   1. 目录快照变化：文件数或目录 mtime 变了（新增/删除会话）
//   2. TTL 到期：20 秒。兜住"内容被改写但目录快照不变"这类边缘情况。
//      原来是 5 秒，但轮询间隔 4 秒、用户切页签的时机又很随机，
//      导致切过去时缓存经常刚好过期 → 每次都走 200ms 的冷启动（"黑一下"）。
//      用量统计不是实时数据，20 秒的新鲜度完全够用。
//      另外前端还有一层：切过去先用上次数据立即渲染，不等网络。
const usageRowsCache = { key: '', at: 0, rows: null, win: null };
const USAGE_CACHE_TTL_MS = 20000;

/** 目录快照：文件数 + 目录 mtime。成本低（一次 stat），足以捕捉增删。 */
function sessionsDirSignature() {
  const dir = path.join(DATA_DIR, 'sessions');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const st = fs.statSync(dir);
    return files.length + ':' + st.mtimeMs;
  } catch {
    return '';
  }
}

function collectUsageRows({ range }) {
  const win = resolveRange(range);
  // 命中缓存就直接返回（注意 rows 会被调用方改写字段，所以必须给副本）
  const sig = sessionsDirSignature() + '@' + String(range);
  if (usageRowsCache.rows && usageRowsCache.key === sig
      && (Date.now() - usageRowsCache.at) < USAGE_CACHE_TTL_MS) {
    return {
      rows: usageRowsCache.rows.slice(),
      win: win || usageRowsCache.win,
      searchCount: usageRowsCache.searchCount || 0,
      toolCounts: { ...(usageRowsCache.toolCounts || {}) }
    };
  }

  const dir = path.join(DATA_DIR, 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { rows: [], win, searchCount: 0, toolCounts: {} }; }

  const rows = [];
  // 会话级计数：搜索次数、各工具的调用次数。
  // 与 rows 在同一个循环里统计 —— 不额外多读一次文件。
  // 注意这些是"次数"不是"成本"：搜索通常是资源包或免费的，
  // 所以只列数量、绝不参与成本计算（用户明确要求）。
  let searchCount = 0;
  const toolCounts = Object.create(null);

  for (const f of files) {
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const started = Number(s.startedAt) || 0;
    if (!started) continue;

    // 这个会话是否落在时间窗口内（工具/搜索计数按会话归属，没有独立时间戳）
    if (started >= win.start && started <= win.end) {
      searchCount += Number(s.webSearchCount) || 0;
      for (const m of (s.messages || [])) {
        const name = m && m.toolCall && m.toolCall.name;
        if (name) toolCounts[String(name)] = (toolCounts[String(name)] || 0) + 1;
      }
    }

    // 逐次调用展开：每条 message.raw 有独立的 usage / created / model
    const calls = [];
    for (const m of (s.messages || [])) {
      const raw = m?.raw;
      if (!raw || typeof raw !== 'object') continue;
      const ru = raw.usage || {};
      const rp = Number(ru.prompt_tokens) || 0;
      const rc = Number(ru.completion_tokens) || 0;
      if (!rp && !rc) continue;
      const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
      calls.push({
        promptTokens: rp,
        completionTokens: rc,
        cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
        at,
        model: String(raw.model || s.model || '') || '(未知)'
      });
    }

    if (calls.length) {
      for (const c of calls) {
        if (c.at < win.start || c.at > win.end) continue;
        rows.push({ ...c, vendor: String(s.vendor || ''), chatKey: String(s.chatKey || '(未知)'), sessionId: s.id, exact: true });
      }
    } else {
      const u = s.usage || {};
      const p = Number(u.promptTokens) || 0;
      const c = Number(u.completionTokens) || 0;
      if (!p && !c) continue;
      if (started < win.start || started > win.end) continue;
      rows.push({
        promptTokens: p,
        completionTokens: c,
        cachedTokens: Number(u.cachedTokens) || 0,
        at: started,
        model: String(s.model || '') || '(未知)',
        chatKey: String(s.chatKey || '(未知)'),
        vendor: String(s.vendor || ''),
        sessionId: s.id,
        exact: false
      });
    }
  }
  // 模型身份 = 渠道 + 模型 id。
  // 渠道取**会话自己记录的** vendor（创建会话时由当时的配置派生）。
  // 老会话没这个字段 → 标为「未知渠道」，绝不拿当前配置去倒推历史 ——
  // 用户很可能早就换过渠道了，猜出来的结果是错的。
  for (const r of rows) {
    r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
    r.modelKey = modelLabel(r.vendor, r.model);
  }
  // 写缓存：存的是"清洗完的 rows"，取用时给副本避免调用方污染
  usageRowsCache.key = sig;
  usageRowsCache.at = Date.now();
  usageRowsCache.rows = rows.slice();
  usageRowsCache.win = win;
  usageRowsCache.searchCount = searchCount;
  usageRowsCache.toolCounts = { ...toolCounts };
  return { rows, win, searchCount, toolCounts };
}

/** 用配置解析价格（成本只与实际调用的模型有关，与当前选中模型无关）。 */
/**
 * 取某次调用的单价。
 *
 * 按「渠道：模型 id」优先查 —— 用户可以为某个渠道下的模型单独定价
 * （A6API 的 GLM-5.3-Flash 与 OpenRouter 的可能是两个价）。
 * 查不到再退回裸模型 id（通用价），最后才是全局兜底。
 *
 * ⚠️ 必须与前端展示/批量编辑用的身份一致，否则用户设的渠道价永远不会生效。
 */
function priceOf(model, vendor) {
  const cfg = getConfig();
  if (vendor) {
    const byVendor = resolveModelPrice(modelLabel(vendor, model), cfg);
    // 命中自定义价才算数；否则退回通用价（避免渠道名干扰官方表匹配）
    if (byVendor.source === 'custom') return byVendor;
  }
  return resolveModelPrice(model, cfg);
}

/** 对一批行计价，返回总额与峰谷拆分。 */
function costOfRows(rows) {
  const cfg = getConfig();
  let cost = 0, peakCost = 0, offPeakCost = 0, peakTokens = 0, offPeakTokens = 0;
  let promptTokens = 0, completionTokens = 0, cachedTokens = 0, exactCalls = 0, hasPeakModel = false;
  for (const r of rows) {
    const p = priceOf(r.model, r.vendor);
    if (p.peak) hasPeakModel = true;
    const tier = p.peak ? priceAt({ in: p.in, out: p.out, cached: p.cached, peak: p.peak }, r.at) : p;
    const prompt = Number(r.promptTokens) || 0;
    const completion = Number(r.completionTokens) || 0;
    const cached = Math.min(Number(r.cachedTokens) || 0, prompt);
    const fresh = Math.max(0, prompt - cached);
    const c = (fresh / 1_000_000) * tier.in + (cached / 1_000_000) * tier.cached + (completion / 1_000_000) * tier.out;
    cost += c;
    const tk = prompt + completion;
    if (isPeakHour(r.at)) { peakCost += c; peakTokens += tk; } else { offPeakCost += c; offPeakTokens += tk; }
    promptTokens += prompt;
    completionTokens += completion;
    cachedTokens += cached;
    if (r.exact) exactCalls += 1;
  }
  return {
    cost, peakCost, offPeakCost, peakTokens, offPeakTokens,
    promptTokens, completionTokens, cachedTokens,
    totalTokens: promptTokens + completionTokens,
    cacheHitRate: promptTokens ? Math.min(1, cachedTokens / promptTokens) : 0,
    peakRatio: (peakTokens + offPeakTokens) ? peakTokens / (peakTokens + offPeakTokens) : 0,
    exactCalls, hasPeakModel, runs: rows.length
  };
}

/** 按某个字段分组后各自计价。 */
function groupBy(rows, field, limit = 0) {
  const map = new Map();
  for (const r of rows) {
    const k = String(r[field] ?? '(未知)');
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  let out = [...map.entries()].map(([key, list]) => ({ key, ...costOfRows(list) }));
  out.sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);
  if (limit) out = out.slice(0, limit);
  return out;
}

/** 主统计：按天 / 按会话 / 按模型三个维度。 */
function buildUsageStats({ range = '7' } = {}) {
  const { rows, win, searchCount, toolCounts } = collectUsageRows({ range });
  const totals = costOfRows(rows);
  // 单日/24小时场景下"按天"没有意义（只有一行），由前端决定是否隐藏
  const days = win.mode === 'days' ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })) : [];
  // 按天分桶需要 dayKey 字段
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  const byDay = win.mode === 'days'
    ? groupBy(rows, 'dayKey').map((x) => ({ day: x.key, ...x })).sort((a, b) => a.day.localeCompare(b.day))
    : [];
  const chats = groupBy(rows, 'chatKey', 0);
  // 不截断：截断会让"各行成本之和 ≠ 总成本"，用户核对时会困惑。
  // 行数多时由前端滚动容器处理。
  const models = groupBy(rows, 'modelKey', 0).map((m) => {
    const { vendor, model } = splitModelLabel(m.key);
    return { ...m, vendor, model };
  });
  return {
    range: String(range),
    rangeLabel: win.label,
    mode: win.mode,
    totals,
    // 次数类统计：只看数量，不参与成本计算
    searchCount: searchCount || 0,
    toolCounts: toolCounts || {},
    days: byDay,
    chats,
    models
  };
}

/**
 * 下钻明细：在某个维度取某个值，再按另一个维度展开。
 *   dim/key 定位子集，by 决定展开方式
 * 例：dim=chat&key=group:123&by=model → 该群下各模型的成本
 */
function buildUsageBreakdown({ range = '7', dim = '', key = '', by = '' } = {}) {
  const { rows, win } = collectUsageRows({ range });
  for (const r of rows) r.dayKey = dayKeyOf(r.at);
  // dim/by 为 model 时按复合身份匹配（模型 + 供应商）
  const fieldOf = (d) => (d === 'day' ? 'dayKey' : d === 'model' ? 'modelKey' : 'chatKey');
  const subset = dim ? rows.filter((r) => String(r[fieldOf(dim)] ?? '') === key) : rows;
  // 同样不截断：保证明细各项之和 = 该子集总成本
  const groups = groupBy(subset, fieldOf(by) || 'chatKey', 0);
  const sum = costOfRows(subset);
  // 峰谷信息跟随子集（弹窗外部上方展示用）
  return {
    range: String(range),
    dim, key, by,
    totals: sum,
    showPeak: sum.hasPeakModel && (sum.peakCost > 0 || sum.offPeakCost > 0),
    rows: groups.map((g) => ({
      key: g.key,
      cost: g.cost,
      promptTokens: g.promptTokens,
      completionTokens: g.completionTokens,
      cachedTokens: g.cachedTokens,
      totalTokens: g.totalTokens,
      cacheHitRate: g.cacheHitRate,
      runs: g.runs,
      exactCalls: g.exactCalls
    }))
  };
}
