// JM（禁漫）查询桥 —— Node 侧。
//
// 为什么是"常驻 Python 子进程"而不是纯 Node 直连：
//   实测 JM 的搜索端点是 JSON（/search?...），**但需要签名头**（jmcomic 里的
//   decide_headers_and_ts / client_key 就是干这个的），而且它的内置域名经常失效 ——
//   库会自动把域名换成当前可用的（实测更新成 www.cdnhjk.net 等）。
//   自己用 Node 重实现签名 + 域名探测，等于把人家踩过的坑再踩一遍，
//   而且站点一改就得跟着改。所以这里只做一层薄桥：spawn 一次，按行收发 JSON。
//
// 协议：往子进程 stdin 写一行 JSON，从 stdout 读一行 JSON。
//       子进程保证 stdout 上**只有 JSON**（库日志全被它赶去 stderr）。
//
// 健壮性：串行化请求（一次一个）、单请求超时、进程挂了下次自动重启、
//         stderr 留最近若干行供界面排障。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getConfig } from './config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))   // .../resources/app/src
const APP_DIR = path.resolve(HERE, '..')                    // .../resources/app

/**
 * "工具目录"（放着 `jm_server.py` / `nh.db` / Python 运行时）的候选位置，按优先级找：
 *
 *   ① `<程序目录>/JM工具`            —— **随包发布**时的布局（打包脚本把东西放进 `resources\app\JM工具`）
 *   ② `<程序目录>/../../../JM工具`   —— 开发机布局（本机就是这种：`dsh qq\JM工具`）
 *
 * 两个都找不到时返回 ①，让报错信息指向"本该在哪"，而不是指向一个随机位置。
 *
 * 为什么要留两个候选：① 是给别人用的、② 是这台机器用的。**写死任何一个，另一种部署都会静默失效**
 * —— 开关开着、接口不报错、就是查不到东西。那种最难查，所以宁可在两处都试一下。
 */
const TOOL_DIR_CANDIDATES = [
  path.join(APP_DIR, 'JM工具'),
  path.resolve(APP_DIR, '..', '..', '..', 'JM工具')
]

function pickToolDir() {
  for (const dir of TOOL_DIR_CANDIDATES) {
    try { if (fs.existsSync(dir)) return dir } catch { /* 权限之类，继续试下一个 */ }
  }
  return TOOL_DIR_CANDIDATES[0]
}

/** `pythonPath` 可能是 `py` / `python3` 这种 PATH 上的启动器，不是文件路径 —— 别拿 existsSync 判它。 */
function pythonIsLauncher(p) {
  const s = String(p || '')
  return !!s && !s.includes('/') && !s.includes('\\')
}

let child = null
let stdoutBuf = ''
let pending = null        // { resolve, reject, timer } —— 串行化：同时只有一个在飞
let queue = Promise.resolve()
let stderrTail = []
let lastError = ''
let spawnCount = 0
let idleTimer = null
let spawnedSig = ''       // 当前子进程是用哪套参数起来的（配置变了要重起，见 ensureChild）

/** 空闲多久就把子进程收掉（下次查询重新拉起，代价约 3 秒）。
 *  加这个是因为：子进程的 stdio 管道会**挂住宿主的 Node 事件循环** ——
 *  应用里无所谓，但任何 import 了本模块又调过查询的脚本会退不出去（实测踩到）。 */
const IDLE_MS = 10 * 60 * 1000

function conf() {
  const c = (getConfig().doujinLookup) || {}
  const configured = String(c.toolDir || '').trim()
  // ⚠️ 每次现算，不在模块加载时定死：用户后来才把目录放进去 / 改了路径，不用重启就生效
  const toolDir = configured || pickToolDir()
  const serverScript = String(c.serverScript || '').trim() || path.join(toolDir, 'jm_server.py')
  const nhDbPath = String(c.nhDbPath || '').trim() || path.join(toolDir, 'nh.db')

  // ── 两条启动路线 ──────────────────────────────────────────────────────
  //   ① 直接跑 `jm_server.exe`（PyInstaller 打的单文件）—— **随包发布用这条**：
  //      目标机不需要装 Python，一个 24.8MB 的 exe 就够（比 .venv 的 54.7MB 还小）
  //   ② 用 Python 跑 `jm_server.py` —— 开发机用这条（改脚本立刻生效，不用重新编译）
  //
  // 选择规则：**有 exe 且没显式配 pythonPath 就走 exe**。
  // 显式配了 pythonPath 说明用户想走脚本路线（比如正在改 jm_server.py），尊重它。
  const exeName = process.platform === 'win32' ? 'jm_server.exe' : 'jm_server'
  const serverExe = String(c.serverExe || '').trim() || path.join(toolDir, exeName)
  const explicitPython = String(c.pythonPath || '').trim()
  const useExe = !!explicitPython ? false : fs.existsSync(serverExe)

  // Python 解释器：配置 > 工具目录里的 venv > py 启动器（只走脚本路线时才用得到）
  let pythonPath = explicitPython
  if (!pythonPath) {
    const venvPy = process.platform === 'win32'
      ? path.join(toolDir, '.venv', 'Scripts', 'python.exe')
      : path.join(toolDir, '.venv', 'bin', 'python')
    pythonPath = fs.existsSync(venvPy) ? venvPy : (process.platform === 'win32' ? 'py' : 'python3')
  }
  return {
    toolDir, serverScript, nhDbPath, pythonPath,
    serverExe, useExe,
    // 这份目录是配置里指定的，还是自动找到的（诊断用：别人机器上"找不到"时最容易看出问题）
    toolDirFromConfig: !!configured,
    timeoutMs: Math.max(3000, Number(c.timeoutMs) || 30000),
    maxResults: Math.min(50, Math.max(1, Number(c.maxResults) || 10))
  }
}

/**
 * 把人话版的"哪儿不对"拼出来 —— 界面直接显示这句，而不是只给一条英文报错。
 *
 * 本子查询最容易的坏法就是**静默失效**（开关开着、接口 200、就是查不到东西），
 * 所以这里必须能分清：是目录没找到、还是入口（exe/脚本）没找到、还是 Python / NH 库没找到。
 * 全都没问题时返回空串。
 */
function diagnose(c) {
  if (!fs.existsSync(c.toolDir)) {
    return `工具目录不存在：${c.toolDir}`
      + `　找过这些位置，都没有：${TOOL_DIR_CANDIDATES.join('  |  ')}`
      + `　随包安装时它应该在「程序目录\\JM工具」；开发机上是「<dsh qq>\\JM工具」。也可以在设置里手动填路径。`
  }
  if (c.useExe) {
    if (!fs.existsSync(c.serverExe)) return `工具目录在，但没有可执行入口：${c.serverExe}`
  } else {
    if (!fs.existsSync(c.serverScript)) {
      // 走脚本路线却没脚本时，顺手提一句"也可以放个 exe" —— 那是不用装 Python 的路线
      return `工具目录在，但里面既没有 jm_server.exe、也没有 jm_server.py（找的是 ${c.serverScript}）`
    }
    if (!pythonIsLauncher(c.pythonPath) && !fs.existsSync(c.pythonPath)) {
      return `找不到 Python 解释器：${c.pythonPath}（工具目录里的 .venv 可能没装好；或者放一个 jm_server.exe 就不用 Python 了）`
    }
  }
  if (!fs.existsSync(c.nhDbPath)) return `找不到 NH 离线库：${c.nhDbPath}（JM 直连还能用，NH 兜底用不了）`
  return ''
}

/** 给界面看的"当前会用什么"（不改任何状态）。 */
export function jmPaths() {
  const c = conf()
  return {
    ...c,
    serverExists: c.useExe ? fs.existsSync(c.serverExe) : fs.existsSync(c.serverScript),
    nhDbExists: fs.existsSync(c.nhDbPath),
    running: !!child,
    spawnCount,
    lastError,
    // 一句人话说明"现在缺什么"；空串 = 没发现问题
    hint: diagnose(c),
    stderrTail: stderrTail.slice(-8)
  }
}

/**
 * 清理被我们**强杀**掉的 PyInstaller onefile 留下的解包残留。
 *
 * 为什么要（2026-09-21 第十对话）：exe 路线跑的是 PyInstaller onefile（24.8MB），
 * 它启动时把自身解包到 `%TEMP%\_MEIxxxxxx`，**正常退出会自己删**；但 `killChild()`
 * 走的是 `child.kill()`（Windows 上是强杀）⇒ 那个清理来不及跑 ⇒ 每次强杀留一个
 * 约 16.7MB 的目录。本棒实测：09-20 密集重跑那两小时留了 6 个；全机累计清出
 * **260 个 / 9.08 GB**（C 盘因此只剩 5.9%）。而残留越多、exe 冷启动越慢，
 * 越容易撞 jmPing 超时被强杀 —— 是个正反馈环。
 *
 * ⚠️ 安全性（**别把这条改成"删所有 _MEI"**）：
 *   ① 只在 **exe 路线** 才可能由我们产生，脚本路线（Python）不产生 `_MEI`；
 *   ② 名字必须是十六进制后缀 `/^_MEI[0-9a-f]+$/i` —— 注意 `\d+` 是**错的**，
 *      PyInstaller 的后缀含 a-f（实测 `_MEI000004f42`；用 `\d+` 会漏 242/262 个**且安静少报**）；
 *   ③ 只删 **≥ GRACE_MS 之前**创建的 ⇒ 绝不碰"此刻刚起来的那个"（它的解包时间就是它自己的寿命）；
 *   ④ 只扫 `os.tmpdir()` 与 `%TMP%`，**不动别的目录**。
 *   代价：若同机还有别的 PyInstaller 程序恰好在 GRACE_MS 前启动，会被误删 —— 这个风险
 *   与"每次强杀稳定泄漏 16.7MB、累积 9GB"相比是可接受的，且注释与经验库都记了这条边界。
 */
const MEI_RE = /^_MEI[0-9a-f]+$/i
const MEI_GRACE_MS = 5 * 60 * 1000
function sweepMeiResidue() {
  try {
    const dirs = [...new Set([os.tmpdir(), process.env.TMP, process.env.TEMP].filter(Boolean))]
    const cutoff = Date.now() - MEI_GRACE_MS
    let removed = 0
    let bytes = 0
    for (const dir of dirs) {
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (!e.isDirectory() || !MEI_RE.test(e.name)) continue
        const fp = path.join(dir, e.name)
        let st = null
        try { st = fs.statSync(fp) } catch { continue }
        if (st.mtimeMs > cutoff) continue          // 太新 ⇒ 可能正在用，放过
        try {
          fs.rmSync(fp, { recursive: true, force: true, maxRetries: 2 })
          if (fs.existsSync(fp)) continue
          removed++
        } catch { /* 被占用就跳过，不是错误 */ }
      }
    }
    if (removed) console.log(`[jm-bridge] 清掉 ${removed} 个 PyInstaller _MEI 残留（强杀 exe 留下的）`)
  } catch { /* 清理失败绝不能影响主流程 */ }
}

function killChild(reason) {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  if (!child) return
  const wasExe = spawnedSig.startsWith('exe|')
  try { child.stdin.end() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  child = null
  // ⚠️ 必须**先**清 child 再清残留：见上面 sweepMeiResidue 的注释。
  //    只对 exe 路线做（脚本路线不产生 _MEI），且是纯尽力而为。
  if (wasExe) sweepMeiResidue()
  if (pending) {
    clearTimeout(pending.timer)
    pending.reject(new Error(`JM 服务已停止（${reason}）`))
    pending = null
  }
}

/** 每次有请求就重置空闲计时；闲太久就收掉（见 IDLE_MS 的注释）。 */
function armIdle() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => killChild('idle'), IDLE_MS)
  if (idleTimer.unref) idleTimer.unref()
}

function ensureChild() {
  const c = conf()
  // 配置里的启动参数变了（改了工具目录 / 入口 / 解释器 / 脚本 / NH 库）→ 把旧进程收掉重起。
  // 不做这一步的话：用户改了路径，界面显示新路径、实际还在用旧进程 —— 排查起来极其费解。
  // 签名里带上"走 exe 还是走脚本"：从脚本切到 exe（或反过来）必须重起，否则换了入口还在跑旧进程。
  const entry = c.useExe ? c.serverExe : c.pythonPath
  const sig = [c.useExe ? 'exe' : 'py', entry, c.serverScript, c.toolDir, c.nhDbPath].join('|')
  if (child && child.exitCode === null && !child.killed && spawnedSig && spawnedSig !== sig) {
    killChild('config changed')
  }
  if (child && child.exitCode === null && !child.killed) return child
  if (c.useExe) {
    if (!fs.existsSync(c.serverExe)) throw new Error(`找不到 JM 服务入口：${c.serverExe}（可在设置里改路径）`)
  } else if (!fs.existsSync(c.serverScript)) {
    throw new Error(`找不到 JM 服务脚本：${c.serverScript}（可在设置里改路径，或放一个 jm_server.exe 就不用 Python）`)
  }
  stderrTail = []
  // exe 自带解释器，直接跑、不带参数；脚本路线才需要 python + 脚本路径
  const cmd = c.useExe ? c.serverExe : c.pythonPath
  const argv = c.useExe ? [] : [c.serverScript]
  child = spawn(cmd, argv, {
    cwd: c.toolDir,
    windowsHide: true,
    env: { ...process.env, JM_NH_DB: c.nhDbPath, PYTHONIOENCODING: 'utf-8' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  spawnCount += 1
  spawnedSig = sig
  // 别让它挡住宿主退出（应用里本来就有 HTTP 服务撑着；脚本里靠这个才能正常结束）
  child.unref?.()
  // ── 这一组回调必须都先确认"我还是当前那个子进程" ──────────────────────
  //
  // 为什么（2026-09-16 被 A4 的路由测试逼出来的真 bug）：
  // 旧进程被 killChild 收掉（改配置 / 超时 / 切 exe 入口）时，它的 exit 事件是**异步**到的 ——
  // 那一刻 pending 和 child 可能已经属于**新起的**那个进程了。不判这一下就会：
  //   ① 新请求被旧进程的退出事件 reject → 报「JM 服务退出（code=null）」，看着莫名其妙；
  //   ② child 被清成 null → 下次请求又 spawn 一个，**留下真正的孤儿进程**。
  const thisChild = child
  const isCurrent = () => thisChild === child
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    if (!isCurrent()) return
    stdoutBuf += chunk
    let i
    while ((i = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, i).trim()
      stdoutBuf = stdoutBuf.slice(i + 1)
      if (!line) continue
      let msg = null
      try { msg = JSON.parse(line) } catch { continue }   // 非 JSON 一律忽略，别让协议被污染
      if (pending) {
        clearTimeout(pending.timer)
        const p = pending
        pending = null
        p.resolve(msg)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    if (!isCurrent()) return
    for (const l of String(chunk).split('\n')) {
      if (l.trim()) stderrTail.push(l.trim())
    }
    if (stderrTail.length > 40) stderrTail = stderrTail.slice(-40)
  })
  child.on('error', (err) => {
    if (!isCurrent()) return
    lastError = `启动失败：${err.message}`
    killChild('spawn error')
  })
  child.on('exit', (code) => {
    if (!isCurrent()) return
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(`JM 服务退出（code=${code}）${stderrTail.slice(-2).join(' | ')}`))
      pending = null
    }
    lastError = `进程退出 code=${code}`
    child = null
  })
  return child
}

/** 发一条请求给 JM 服务，拿回一条响应。串行执行（一次只有一个在飞）。 */
export function jmRequest(req, { timeoutMs = null } = {}) {
  const run = () => new Promise((resolve, reject) => {
    let c
    try { c = ensureChild() } catch (e) { reject(e); return }
    const ms = timeoutMs || conf().timeoutMs
    const timer = setTimeout(() => {
      if (pending) {
        pending = null
        // 超时说明它卡住了（网络卡/站点慢）——杀掉，下次请求会重新拉起
        killChild('timeout')
        reject(new Error(`JM 服务超时（${ms}ms）${stderrTail.slice(-2).join(' | ')}`))
      }
    }, ms)
    pending = { resolve, reject, timer }
    armIdle()
    try {
      c.stdin.write(JSON.stringify(req) + '\n')
    } catch (e) {
      clearTimeout(timer)
      pending = null
      reject(e)
    }
  })
  const next = queue.then(run, run)
  queue = next.catch(() => { })
  return next
}

/**
 * 健康检查（ping）该等多久 —— **单独抽成导出函数，就为了能被测试钉住**。
 *
 * ⚠️ 2026-09-21（第十对话）修：原来 jmPing 里写死 `{ timeoutMs: 15000 }`，**不吃配置**。
 *    后果实测：走到 exe 路线（PyInstaller onefile）时，第一次 ping 要等它把自身解包，
 *    空载冷启动实测约 1000ms，但密集重跑回归（73 个子进程抢磁盘）时会涨过 15 秒 ⇒
 *    `test-jm-routes.mjs` 第 2 节「exe 路线 ping 通了」反复假红（单跑 1.2s 全过，22:11 /
 *    22:14 / 22:36 / 23:08 共 4 次），而超时会 killChild 强杀 exe，PyInstaller 来不及
 *    自清理 ⇒ 每次失败在 %TEMP% 留一个 _MEI*（约 16.7MB），残留又让下次冷启动更慢 ——
 *    典型的反馈环。
 *
 * 取「配置值与 30000 的较大者」：
 *   · **不能只读配置**：配置允许小到 3000（见 conf()），那对"首次冷启动"这种一次性开销太小；
 *   · 下限只作用于**这一条健康检查**，正式查询仍严格按 conf().timeoutMs 走（见 jmRequest）。
 *
 * 为什么必须是函数而不是常量：常量会被下一次重构无声地写死回去，而**任何行为测试都测不出来**
 * （真实 ping 是毫秒级，30 秒的上限永远碰不到）—— 当初的 15000 就是这么躲过全部 73 个测试的。
 * 抽成纯函数后，`test-jmPing超时不吃写死值.mjs` 可以在毫秒内断言这个值随配置走。
 */
export const JM_PING_TIMEOUT_FLOOR_MS = 30000
export function jmPingTimeoutMs() {
  return Math.max(JM_PING_TIMEOUT_FLOOR_MS, conf().timeoutMs || 0)
}

/** 健康检查：给界面"测试"按钮和工具首次调用用。 */
export async function jmPing() {
  const r = await jmRequest({ cmd: 'ping' }, { timeoutMs: jmPingTimeoutMs() })
  return r
}

export function stopJm() {
  killChild('stop')
}

/** 进程退出时别留孤儿（Electron 主进程退出会走这里）。 */
export function installJmCleanup(app) {
  try {
    app?.on?.('before-quit', () => stopJm())
    process.on('exit', () => stopJm())
  } catch { /* ignore */ }
}
