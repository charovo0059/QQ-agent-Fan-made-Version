// 部署环境自查（提案 17a954dc）—— **只读**审计：报运行时 + 依赖 + 外部程序的版本。
//
// 为什么要有它：用户换一台机器部署、或别人报"我这边不行"的时候，第一件事永远是问
// "你那边是什么环境"。以前的做法是让人自己开控制台敲 node -v / python --version，
// 来回五六轮。这里把答案一次收齐，形状照抄 app.js 的 /api/wechat/channel/selfcheck
// （items:[{key, ok, title, detail}] 三态口径），界面与模型都能直接念出来。
//
// 三条硬纪律（都是本机踩过的坑，钉在文件头上）：
//   ① **只读**：只跑 "--version" / "reg query" / 读 application.ini。
//      ⛔ 绝不启动浏览器 —— "chrome --version" 在 Windows 上会真的拉起窗口（用户正在用电脑），
//      读注册表就够拿到版本号。
//   ② **永不抛**：任何一段炸了都进 warnings，返回体仍然完整；缺什么就写 ok:false + 一句人话。
//      ⛔ 尤其不许把"读不到"伪装成"没装"（本项目反复栽在假绿/假红上）。
//   ③ **只取版本号 + 脱敏**：中文路径下外部 exe 的输出会乱码（本机坑 287），
//      所以不把整段输出塞进 detail，只用正则抠版本号（版本号是 ASCII，乱码不影响它）；
//      返回前再把绝对路径 / 凭据样式的东西统一剥掉（思路同 app.js 的 sanitizeForDiagnostics，
//      但这里是"剥路径"而不是"删密钥字段"，所以是另一个最小实现，不共用）。
//
// ⚠️ 本文件只用双引号字符串 + 拼接（不用模板串），不是风格洁癖：这个模块要被
//    "人人可读的纯文本"反复搬运，少一层转义就少一次搬坏的机会。
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"

/** 单个外部程序最多等多久（秒级，够 java -version 冷启动）。 */
const PROBE_TIMEOUT_MS = 3000

/** 每一条都带上的如实口径：依据是本地探测，没有联网。 */
const BASIS = "本地探测、未联网"

// ⚠️ 这几句是**产品口径**，不是注释：用户会照着它判断"这结果能不能信"。
//    测试里对它做断言（notes 必须写明"没有联网""没有启动任何浏览器窗口"），别随手动。
const NOTES = [
  "依据 = 本地探测、未联网：只跑 --version / reg query / 读安装目录里的 application.ini。",
  "名单是本地维护的，没有联网查 CVE —— 这里只回答\"装了什么版本\"，不判断\"有没有已知漏洞\"。",
  "探测全程只读：没有启动任何浏览器窗口、没有改注册表、没有写任何文件。",
  "读不到 ≠ 没装：装在别的用户下、装在别的盘、绿色版、或在 WSL 里、或没进 PATH 的，这里都会报\"没读到\"。"
]

// ── 小工具（全部不抛）────────────────────────────────────────────────────

/** 把任何东西压成一行短文本（错误消息用；⛔ 不许把多行 stdout 塞进去）。 */
function oneLine(value, max) {
  const cap = Number(max) > 0 ? Number(max) : 160
  let s = ""
  try {
    s = String(value && value.message !== undefined ? value.message : value === undefined || value === null ? "" : value)
  } catch {
    s = ""
  }
  s = s.replace(/\s+/g, " ").trim()
  return s.length > cap ? s.slice(0, cap) + "…" : s
}

/** 从任意输出里抠**一个**版本号；前一位是 v 就保留（node 的 "v24.19.0" 要原样）。 */
const VERSION_RE = /(v?)(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]{1,24})?)/
function pickVersion(text) {
  const m = String(text === undefined || text === null ? "" : text).match(VERSION_RE)
  if (!m) return ""
  return (m[1] ? "v" : "") + m[2]
}

/** 路径的最后一段（只留文件名/目录名，绝不带上级目录）。 */
function lastSegment(text) {
  return String(text === undefined || text === null ? "" : text).split(/[\\/]+/).filter(Boolean).pop() || ""
}

/** 字节 → GB，一位小数。 */
function toGB(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round((n / 1024 / 1024 / 1024) * 10) / 10
}

/** 取非空字符串，空了就给一句人话（⛔ 不留空串，空字段会被当成"读取失败"）。 */
function text(value, fallback) {
  const s = value === undefined || value === null ? "" : String(value).trim()
  return s || fallback
}

// ── ① 运行时常量（同步、纯本地，绝不抛）────────────────────────────────

/**
 * 运行时常量。**同步**，只读 process / os，不起任何子进程。
 *
 * ⚠️ electron / chrome 只有跑在 Electron 里才有值；直接用 node 跑的时候
 *    process.versions.electron 是 undefined。这里**不留空串**，而是写一句人话，
 *    并另给 isElectron 布尔 —— 调用方看到的是"没在 Electron 里跑"，
 *    而不是一个空字段（空字段会被当成"读取失败"，那是另一种骗人）。
 */
export function auditRuntime() {
  const v = process.versions || {}
  let osRelease = "（读不到）"
  let totalGB = 0
  let freeGB = 0
  let uptimeSec = 0
  try { osRelease = text(os.release(), "（读不到）") } catch { /* 保持占位 */ }
  try { totalGB = toGB(os.totalmem()) } catch { /* 0 */ }
  try { freeGB = toGB(os.freemem()) } catch { /* 0 */ }
  try { uptimeSec = Math.round(Number(os.uptime()) || 0) } catch { /* 0 */ }
  // ⚠️ 只给**目录名**（如 nodejs / QQ Agent），不给全路径 —— 全路径会带出用户名。
  let execDir = ""
  try { execDir = path.basename(path.dirname(String(process.execPath || ""))) } catch { execDir = "" }

  return {
    node: text(v.node, "（读不到）"),
    electron: text(v.electron, "（未在 Electron 中运行）"),
    chrome: text(v.chrome, "（未在 Electron 中运行）"),
    v8: text(v.v8, "（读不到）"),
    isElectron: Boolean(text(v.electron, "")),
    platform: text(process.platform, "（读不到）"),
    arch: text(process.arch, "（读不到）"),
    osRelease,
    totalMemGB: totalGB,
    freeMemGB: freeGB,
    uptimeSec,
    execDir: execDir || "（读不到）"
  }
}

// ── ② 依赖（读 <app>/package.json）──────────────────────────────────────

async function readDeps() {
  const notes = []
  try {
    // ⛔ 不写死绝对路径：模块就住在 <app>/src 下，../package.json 永远是对的。
    const url = new URL("../package.json", import.meta.url)
    const pkg = JSON.parse(fs.readFileSync(url, "utf8"))
    const table = pkg && typeof pkg.dependencies === "object" && pkg.dependencies ? pkg.dependencies : {}
    const deps = Object.entries(table).map(function (entry) {
      return { name: String(entry[0]), version: String(entry[1] === undefined ? "" : entry[1]), ok: true }
    })
    const app = {
      name: String(pkg && pkg.name ? pkg.name : ""),
      version: String(pkg && pkg.version ? pkg.version : "")
    }
    if (!deps.length) notes.push("package.json 里没有 dependencies 段（或它是空的）—— 依赖清单为空是真的空，不是读失败")
    return { deps, app, notes }
  } catch (error) {
    // 读不到是**一条结果**，不是异常：写成 deps 里的一条 ok:false，调用方照常渲染。
    return {
      deps: [{ name: "(package.json)", version: "", ok: false, detail: "读不到 package.json：" + oneLine(error, 80) }],
      app: { name: "", version: "" },
      notes: []
    }
  }
}

// ── ③ 起子进程（只跑 --version 一类，超时可杀，绝不抛）─────────────────

function runFile(command, args, timeoutMs) {
  return new Promise(function (resolve) {
    const startedAt = Date.now()
    let settled = false
    const done = function (out) {
      if (settled) return
      settled = true
      resolve(out)
    }
    const opts = {
      windowsHide: true,          // ⛔ 别闪黑框（用户正在用这台机器）
      encoding: "utf8",           // 统一 utf8：中文路径下的乱码不影响正则抠版本号
      timeout: Math.max(200, Number(timeoutMs) || PROBE_TIMEOUT_MS),
      maxBuffer: 256 * 1024
    }
    try {
      execFile(String(command), (Array.isArray(args) ? args : []).map(String), opts, function (error, stdout, stderr) {
        done({
          ok: !error,
          ms: Date.now() - startedAt,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          code: error ? error.code : 0,
          timedOut: Boolean(error && (error.killed || /timed out/i.test(String(error.message || "")))),
          error: error ? oneLine(error) : ""
        })
      })
    } catch (error) {
      done({ ok: false, ms: Date.now() - startedAt, stdout: "", stderr: "", code: -1, timedOut: false, error: oneLine(error) })
    }
  })
}

/** 失败原因翻成一句人话（不带路径、不带整段输出）。 */
function whyFailed(r) {
  if (r && r.timedOut) return "超过 " + PROBE_TIMEOUT_MS + " 毫秒没返回"
  if (r && r.code === "ENOENT") return "没装 / 不在 PATH"
  // ⚠️ 本机实测：Windows 上 "python" 命中的是 Microsoft Store 的空壳别名，
  //    起得来但**自己退出码 9009**（= 命令不存在），stderr 还是空的。
  //    这种必须当成"没装"，⛔ 不能报成"跑起来了但没版本号"（那是另一种骗人）。
  if (r && (r.code === 9009 || r.code === "9009")) return "没装 / 不在 PATH"
  if (r && r.code === "EACCES") return "找到了但没权限跑"
  // 其它非零退出码：带上码值，别只说一句"失败了"（用户要靠码去搜）
  if (r && r.code !== undefined && r.code !== null && r.code !== 0 && r.code !== "") return "退出码 " + r.code
  return "命令没跑起来"
}

// ── ④ 外部程序：命令行类（--version）────────────────────────────────────

// ⚠️ 每项是"按顺序取第一个能跑的"：Windows 上 python 常常是 Microsoft Store 的空壳，
//    真正能跑的是 py 启动器；所以 python 这条要试三条。
const EXEC_PROBES = [
  { key: "python", title: "Python", tries: [["python", ["--version"]], ["py", ["--version"]], ["python3", ["--version"]]] },
  { key: "node", title: "Node.js", tries: [["node", ["--version"]]] },
  { key: "go", title: "Go", tries: [["go", ["version"]]] },
  { key: "php", title: "PHP", tries: [["php", ["--version"]]] },
  // Java 与 nginx 把版本写在 **stderr**（实测：java ⇒ stderr "openjdk version ..."；
  // nginx ⇒ stderr "nginx version: nginx/1.27.0"），所以两个流一起看。
  { key: "java", title: "Java", tries: [["java", ["-version"]]], stderrOnly: true },
  { key: "nginx", title: "nginx", tries: [["nginx", ["-v"]]], stderrOnly: true }
]

async function probeExec(spec, deadline) {
  const title = String(spec && spec.title ? spec.title : spec && spec.key ? spec.key : "（未命名）")
  const key = String(spec && spec.key ? spec.key : "unknown")
  const tries = (Array.isArray(spec && spec.tries) ? spec.tries : []).filter(function (t) { return Array.isArray(t) && t.length >= 2 })
  const tried = []
  // 最后一次尝试的失败原因，用来把"没装 / 没权限 / 超时没返回"分开说
  let lastFailure = ""
  const fail = function (detail) {
    return { key, ok: false, title, detail, version: "", basis: BASIS }
  }

  if (!tries.length) return fail("清单是空的（没有候选命令）—— 这不是\"没装\"，是我们没配候选")

  for (const pair of tries) {
    const command = String(pair[0])
    const args = Array.isArray(pair[1]) ? pair[1].map(String) : []
    const left = deadline - Date.now()
    if (left <= 200) return fail("没来得及探：总预算已用完（试过 " + (tried.join("、") || "(还没开始)") + "）—— 这不是\"没装\"")
    const r = await runFile(command, args, Math.min(PROBE_TIMEOUT_MS, left))
    tried.push(command)
    if (!r.ok) { lastFailure = whyFailed(r); continue }
    // 两个流都看一眼（java/nginx 在 stderr），**只抠版本号**。
    const version = pickVersion(r.stdout) || pickVersion(r.stderr)
    if (!version) {
      return fail(command + " " + args.join(" ") + " 能跑，但没从输出里认出版本号（依据=" + BASIS + "）")
    }
    return {
      key,
      ok: true,
      title,
      detail: "用 " + command + " " + args.join(" ") + " 探到（只取版本号；原始输出可能因中文路径乱码）",
      version,
      via: command + " " + args.join(" "),
      basis: BASIS
    }
  }
  const why = lastFailure || "命令没跑起来"
  // ⚠️ "没装 / 不在 PATH" 是**最可能**的结论，但不能否定其它可能（没权限、超时、被拦）。
  //    所以先给结论，再把实测到的原因原话带一句 —— 用户靠这句判断要不要继续查。
  const headline = /ENOENT|9009|没装|不在 PATH/.test(why)
    ? "没装 / 不在 PATH"
    : (why === "超过 " + PROBE_TIMEOUT_MS + " 毫秒没返回" ? "没跑起来（超时没返回）" : "没跑起来（" + why + "）")
  return fail(headline + "（试过：" + tried.join("、") + "；依据=" + BASIS + "）")
}

// ── ⑤ 外部程序：浏览器（⛔ 不启动，只读注册表 / application.ini）────────

const EDGE_CLIENT_ROOTS = [
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients",
  "HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients",
  "HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients"
]
const CHROME_CLIENT_ROOTS = [
  "HKLM\\SOFTWARE\\Google\\Update\\Clients",
  "HKLM\\SOFTWARE\\WOW6432Node\\Google\\Update\\Clients",
  "HKCU\\Software\\Google\\Update\\Clients"
]

/** reg query：自带预算与"读不到"（退出码 1）处理，绝不抛。 */
async function runReg(argsTail, deadline) {
  const left = Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())
  if (left <= 200) return { ok: false, stdout: "", stderr: "", code: "BUDGET", timedOut: false, error: "总预算已用完" }
  return runFile("reg", argsTail, left)
}

/** 从 reg query 输出里取某个值的字符串（形如 "    pv    REG_SZ    155.0.4283.62"）。 */
function regValue(out, name) {
  const safe = String(name).replace(/[.*+?^$()|[\]\\]/g, "\\$&")
  const re = new RegExp("^\\s*" + safe + "\\s+REG_[A-Za-z_]+\\s+(.+?)\\s*$", "mi")
  const m = String(out === undefined || out === null ? "" : out).match(re)
  return m ? m[1].trim() : ""
}

/** 从 "reg query <Clients>" 输出里取子键 GUID 列表。 */
function regSubKeys(out) {
  const found = []
  const lines = String(out === undefined || out === null ? "" : out).split(/\r?\n/)
  for (const line of lines) {
    const m = line.trim().match(/(\{[0-9A-Fa-f-]{36}\})$/)
    if (m) found.push(m[1])
  }
  return Array.from(new Set(found))
}

/**
 * 在 Google/Edge 更新器的 Clients 里找 "name === 想要的那个" 的客户端，读它的 pv。
 *
 * 🔴 用户给的 Edge GUID 是错的（本机实测：HKCU 下那个 GUID 只有 Commands 子键、没有 pv；
 *    真正的 Edge 在 HKLM\...\WOW6432Node 下）。⇒ 不猜 GUID，**先列 Clients 再看 name**。
 * 🔴 也不能只看"有一个客户端"：本机 Google 那两个客户端是 **GoogleUpdater**，
 *    它的版本号（150.0.7863.0）根本不是 Chrome 的版本 ⇒ 必须按 name 精确匹配，
 *    否则报出来的是假绿（本项目大忌）。
 */
async function probeUpdateClient(options) {
  const roots = Array.isArray(options && options.roots) ? options.roots : []
  const nameRe = options && options.nameRe instanceof RegExp ? options.nameRe : null
  const excludeRe = options && options.excludeRe instanceof RegExp ? options.excludeRe : null
  const deadline = Number(options && options.deadline ? options.deadline : Date.now())
  const maxKeys = Number(options && options.maxKeys) > 0 ? Number(options.maxKeys) : 8
  if (!nameRe) return { version: "", budgetOut: false }

  for (const root of roots) {
    if (deadline - Date.now() <= 200) return { version: "", budgetOut: true }
    const list = await runReg(["query", root], deadline)
    if (!list.ok) continue
    const guids = regSubKeys(list.stdout).slice(0, maxKeys)
    for (const guid of guids) {
      if (deadline - Date.now() <= 200) return { version: "", budgetOut: true }
      const one = await runReg(["query", root + "\\" + guid], deadline)
      if (!one.ok) continue
      const name = regValue(one.stdout, "name")
      if (!name) continue
      if (excludeRe && excludeRe.test(name)) continue
      if (!nameRe.test(name)) continue
      const version = pickVersion(regValue(one.stdout, "pv"))
      if (version) return { version, budgetOut: false, name }
    }
  }
  return { version: "", budgetOut: false }
}

/** Firefox：读安装目录里的 application.ini 的 "Version="（⛔ 不启动它）。 */
function firefoxIniCandidates() {
  const bases = []
  const push = function (base) {
    const b = String(base || "").trim()
    if (b) bases.push(path.join(b, "Mozilla Firefox", "application.ini"))
  }
  // 常见安装位置：系统级两处 + 每用户安装一处（%LOCALAPPDATA%\Mozilla Firefox）
  push(process.env.PROGRAMFILES || (process.platform === "win32" ? "C:\\Program Files" : ""))
  push(process.env["PROGRAMFILES(X86)"] || (process.platform === "win32" ? "C:\\Program Files (x86)" : ""))
  push(process.env.LOCALAPPDATA || "")
  return Array.from(new Set(bases))
}

function probeFirefoxIni() {
  const candidates = firefoxIniCandidates()
  for (const ini of candidates) {
    try {
      if (!fs.existsSync(ini)) continue
      const body = fs.readFileSync(ini, "utf8")
      const m = body.match(/^\s*Version\s*=\s*(.+?)\s*$/mi)
      const version = m ? pickVersion(m[1]) : ""
      if (version) return { version, via: "application.ini" }
    } catch { /* 下一个候选 */ }
  }
  return { version: "", via: "" }
}

const BROWSER_SPECS = [
  { key: "chrome", title: "Chrome（只读注册表，未启动）" },
  { key: "edge", title: "Edge（只读注册表，未启动）" },
  { key: "firefox", title: "Firefox（读 application.ini，未启动）" }
]

async function probeBrowser(spec, deadline) {
  const key = spec.key
  const title = spec.title
  const notRead = function (why) {
    return {
      key,
      ok: false,
      title,
      detail: "本地没读到版本（" + why + "）—— 可能没装，也可能装在别的用户/别的盘（依据=" + BASIS + "）",
      version: "",
      basis: BASIS
    }
  }
  try {
    if (key === "chrome") {
      // ① 首选 BLBeacon（Chrome 自己写的"我是哪个版本"）
      const beacons = [
        "HKCU\\Software\\Google\\Chrome\\BLBeacon",
        "HKLM\\SOFTWARE\\Google\\Chrome\\BLBeacon",
        "HKLM\\SOFTWARE\\WOW6432Node\\Google\\Chrome\\BLBeacon"
      ]
      for (const beacon of beacons) {
        if (deadline - Date.now() <= 200) break
        const r = await runReg(["query", beacon, "/v", "version"], deadline)
        if (!r.ok) continue
        const version = pickVersion(regValue(r.stdout, "version"))
        if (version) {
          return { key, ok: true, title, detail: "从注册表 BLBeacon 读到（依据=" + BASIS + "）", version, via: "reg query BLBeacon", basis: BASIS }
        }
      }
      // ② 退一步：Google 更新器的 Clients 里找 name 就是 "Google Chrome" 的那个
      const found = await probeUpdateClient({
        roots: CHROME_CLIENT_ROOTS,
        nameRe: /^google chrome$/i,
        excludeRe: /updater|update service|webview/i,
        deadline
      })
      if (found.version) {
        return { key, ok: true, title, detail: "从 Google Update 的 Clients 按 name=Google Chrome 读到（依据=" + BASIS + "）", version: found.version, via: "reg query Google Update Clients", basis: BASIS }
      }
      return notRead(found.budgetOut ? "总预算用完，没探完" : "BLBeacon 与 Google Update Clients 都没有它")
    }

    if (key === "edge") {
      const found = await probeUpdateClient({
        roots: EDGE_CLIENT_ROOTS,
        nameRe: /(^|\s)edge$/i,
        excludeRe: /webview|updater|update service|mspc/i,
        deadline
      })
      if (found.version) {
        return { key, ok: true, title, detail: "从 EdgeUpdate 的 Clients 按 name=Microsoft Edge 读到（依据=" + BASIS + "）", version: found.version, via: "reg query EdgeUpdate Clients", basis: BASIS }
      }
      return notRead(found.budgetOut ? "总预算用完，没探完" : "EdgeUpdate\\Clients 里没有 name=Microsoft Edge 的项")
    }

    if (key === "firefox") {
      const found = probeFirefoxIni()
      if (found.version) {
        return { key, ok: true, title, detail: "读安装目录的 application.ini 得到（没有启动它；依据=" + BASIS + "）", version: found.version, via: "application.ini", basis: BASIS }
      }
      return notRead("常见安装目录里没有 application.ini")
    }

    return notRead("未知的浏览器探测项")
  } catch (error) {
    return { key, ok: false, title, detail: "探测时出错：" + oneLine(error, 80) + "（依据=" + BASIS + "）", version: "", basis: BASIS }
  }
}

// ── ⑥ 脱敏（最小版）────────────────────────────────────────────────────
//
// 思路抄 app.js 的 sanitizeForDiagnostics：**在结果出门前统一处理一遍**，而不是指望
// 每个探测函数自己记得脱敏（漏一个就漏出去）。不同的是那边删的是密钥字段，
// 这边剥的是"绝对路径 + 凭据样式"：
//   ① 家目录 / APPDATA / TEMP 换成 <用户目录>（这些最容易带出用户名）；
//   ② 盘符路径与 UNC 路径只留最后一段（…\node.exe）；
//   ③ posix 绝对路径同样只留最后一段；
//   ④ "token=xxx / api_key: yyy" 这种按值抹掉。
// ⚠️ 只在结果对象上跑一次；输入是我们自己造的一行短文本，所以不需要做得更聪明。
const SECRET_KEY_RE = /^(api[_-]?key|apikey|access[_-]?token|refreshtoken|token|secret|password|passwd|pwd|cookie|cookies|authorization|auth|session|signature|sig)$/i

function redactText(input) {
  let s = String(input === undefined || input === null ? "" : input)
  const roots = []
  try { roots.push(os.homedir()) } catch { /* ignore */ }
  const envKeys = ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "ProgramFiles", "ProgramFiles(x86)"]
  for (const k of envKeys) {
    const value = String(process.env[k] || "").trim()
    if (value) roots.push(value)
  }
  for (const root of roots) {
    const r = String(root || "").trim()
    if (r.length > 3) s = s.split(r).join("<用户目录>")
  }
  // 盘符 / UNC 路径 → 只留最后一段
  s = s.replace(/(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'<>|]*/g, function (m) {
    return "…\\" + lastSegment(m)
  })
  // posix 绝对路径（≥2 段）→ 只留最后一段
  s = s.replace(/(^|[\s("'=:,])((?:\/[^\s"'<>|]+){2,})/g, function (m, pre, p) {
    return pre + "…/" + lastSegment(p)
  })
  // 凭据样式：token=xxx / api_key: yyy
  s = s.replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|cookie|authorization)\b\s*[:=]\s*\S+/gi, "$1=<已隐去>")
  return s
}

function sanitizeDeep(node, seen) {
  const guard = seen instanceof WeakSet ? seen : new WeakSet()
  if (typeof node === "string") return redactText(node)
  if (node === null || node === undefined) return node
  if (typeof node === "number" || typeof node === "boolean") return node
  if (typeof node !== "object") return String(node)
  if (guard.has(node)) return "[循环引用已打码]"
  guard.add(node)
  if (Array.isArray(node)) {
    const out = []
    for (const item of node) out.push(sanitizeDeep(item, guard))
    return out
  }
  const out = {}
  for (const key of Object.keys(node)) {
    if (SECRET_KEY_RE.test(key)) { out[key] = "<已隐去>"; continue }
    out[key] = sanitizeDeep(node[key], guard)
  }
  return out
}

// ── ⑦ 主入口 ────────────────────────────────────────────────────────────

/**
 * 部署环境自查（只读，永不抛）。
 *
 * @param {object} [options]
 * @param {boolean} [options.probeExternal=true] false ⇒ **完全不起子进程**，externals 全是
 *        ok:false + "没探"（测试与"只要清单不要结果"的场景用这个，证明开关真的短路了）。
 * @param {number} [options.timeoutMs=8000] 整次自查的总预算；每个外部程序另有 3 秒上限。
 * @param {Array} [options.extraProbes] 额外要探的命令行程序（给测试与将来扩展用），
 *        形状 [{ key, title, tries: [[cmd, [args...]]] }]，会排在清单最前面。
 * @returns {Promise<{ok: boolean, generatedAt: string, runtime: object, deps: Array,
 *          externals: Array, warnings: string[], notes: string[]}>}
 */
export async function auditEnvironment(options) {
  const opts = options && typeof options === "object" ? options : {}
  const probeExternal = opts.probeExternal === undefined ? true : Boolean(opts.probeExternal)
  const startedAt = Date.now()
  const budget = Math.max(1000, Number(opts.timeoutMs) || 8000)
  const deadline = startedAt + budget
  const warnings = []
  const notes = NOTES.slice()
  const externals = []
  let runtime = {}
  let deps = []
  let app = { name: "", version: "" }

  // ① 运行时（同步，理论上不会炸；包一层是为了"永不抛"这条纪律真的成立）
  try {
    runtime = auditRuntime()
  } catch (error) {
    runtime = {}
    warnings.push("读运行时版本时出错：" + oneLine(error, 100))
  }

  // ② 依赖
  try {
    const got = await readDeps()
    deps = got.deps
    app = got.app
    for (const note of got.notes) notes.push(note)
    if (deps.some(function (d) { return d.ok === false })) warnings.push("依赖清单不完整（见 deps 里 ok:false 的那条）")
  } catch (error) {
    deps = [{ name: "(package.json)", version: "", ok: false, detail: "读不到 package.json：" + oneLine(error, 80) }]
    warnings.push("读 package.json 时出错（已按\"读不到\"上报，没有抛）")
  }

  // ③ 外部程序
  try {
    const specs = []
    if (Array.isArray(opts.extraProbes)) {
      for (const extra of opts.extraProbes) {
        if (!extra || typeof extra !== "object") continue
        const ek = String(extra.key || "").trim()
        if (!ek) continue
        specs.push({
          key: ek,
          title: String(extra.title || ek),
          tries: Array.isArray(extra.tries) && extra.tries.length ? extra.tries : [[ek, ["--version"]]]
        })
      }
    }
    for (const p of EXEC_PROBES) specs.push(p)

    for (const spec of specs) {
      if (!probeExternal) {
        externals.push({
          key: spec.key,
          ok: false,
          title: spec.title,
          detail: "没探（调用方传了 probeExternal:false —— 只要清单不要结果）",
          version: "",
          basis: BASIS
        })
        continue
      }
      try {
        externals.push(await probeExec(spec, deadline))
      } catch (error) {
        externals.push({
          key: spec.key,
          ok: false,
          title: spec.title,
          detail: "探测时出错：" + oneLine(error, 80),
          version: "",
          basis: BASIS
        })
      }
    }

    for (const spec of BROWSER_SPECS) {
      if (!probeExternal) {
        externals.push({
          key: spec.key,
          ok: false,
          title: spec.title,
          detail: "没探（调用方传了 probeExternal:false —— 只要清单不要结果，也没启动任何浏览器）",
          version: "",
          basis: BASIS
        })
        continue
      }
      externals.push(await probeBrowser(spec, deadline))
    }
  } catch (error) {
    warnings.push("探测外部程序时出错（已跳过，返回体仍然完整）：" + oneLine(error, 100))
  }

  // ④ 汇总口径：ok 说的是"这次自查本身可信"（运行时读到了 + 依赖清单读到了），
  //    ⛔ **不是**"机器上有多少外部程序"——没装 Python 不是故障。
  const runtimeOk = typeof runtime.node === "string" && runtime.node !== "" && runtime.node !== "（读不到）"
  const depsOk = deps.length > 0 && deps.every(function (d) { return d.ok !== false })
  if (!depsOk) warnings.push("依赖清单为空或读失败 ⇒ 自查的依赖段不可信")

  const payload = {
    ok: Boolean(runtimeOk && depsOk),
    generatedAt: new Date().toISOString(),
    basis: BASIS,
    elapsedMs: Date.now() - startedAt,
    app,
    runtime,
    deps,
    externals,
    warnings,
    notes
  }

  // ⑤ 出门前统一脱敏：任何一段漏了脱敏也会在这里被兜住。
  try {
    return sanitizeDeep(payload)
  } catch (error) {
    // 连脱敏都炸了（理论上不会）—— 宁可返回一个缩小但仍完整的对象，也不抛。
    return {
      ok: false,
      generatedAt: payload.generatedAt,
      basis: BASIS,
      elapsedMs: payload.elapsedMs,
      app: { name: "", version: "" },
      runtime: {},
      deps: [],
      externals: [],
      warnings: ["脱敏阶段出错（已降级返回）：" + oneLine(error, 100)],
      notes
    }
  }
}
