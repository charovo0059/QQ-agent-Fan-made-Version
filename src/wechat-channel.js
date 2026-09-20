// 微信通道（中继 + Bridge）的生命周期管理：状态探测 / 启动 / 停止 / 日志。
//
// ── 为什么要有它（2026-09-20，用户要求）────────────────────────────────────
// 用户原话：「能不能做成和之前 snowluma 一样的操作逻辑，不方便的话类似也行，
//            统一类似的界面更有助于用户操作」。
// 而在此之前，微信通道**只能靠人在命令行开两个窗口**（`中继.mjs` + `跑Bridge.mjs`，
// 后来合成 `跑微信通道.mjs`）—— 用户看不到状态、也没法在界面里开或关。
// SnowLuma 早就有 `launchSnowluma/stopSnowluma/snowlumaStatus/logs` 那一套，
// 这里就照它的形状做一份，**两个页签的操作逻辑保持一致**。
//
// ── 三段，缺一不可（界面要能一眼看出断在哪一段）──────────────────────────
//   ① WeFlow      读微信本地库 + 推新消息的第三方应用（端口 5031）。**它不归我们管**，
//                 只能"检测在不在跑"，必要时替用户把它拉起来。
//                 🔴 2026-09-20 用户拍板：**就停在"检测 + 拉起"这一步**。
//                 我曾按用户早先那句「逆向 weflow，只保留我们需要的功能，逆向出来加进 app 里」
//                 一路走到 wx_key.dll 的授权门（`AUTH_FAILED:auth_env_missing`，
//                 它要 WEFLOW_XKEY_AUTH_* 四个环境变量并连回本机端口换授权），
//                 再往前就是**伪造授权、破第三方商业软件的校验** —— 那超出委托范围，
//                 我停手并把三条路线交给用户；用户选了本条（A：只做生命周期管理）。
//                 事实与取舍见 `待办与决策记录.md` §12.27，**别从头再撞一遍**。
//   ② 通道        我们的中继（11229 等 Bridge / 11230 给 agent）+ 真 Bridge。
//                 这一段的生命周期由本模块负责。
//   ③ 我的链路    app 自己的第二个 OneBot 客户端有没有连上中继 ——
//                 这个状态在 app 里（`/api/status.wechat`），不在这里重复实现。
//
// ⚠️ **不提权、不静默**：起不来就把原因原样报出来（找不到脚本/端口被占/进程立刻退出），
//    绝不"点了没反应"。本项目的头号病就是静默失败。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

/** 日志环形缓冲上限（够排障，又不会把内存吃光）。 */
const LOG_LIMIT = 300

export class WechatChannel {
  /**
   * @param {object} o
   * @param {(host:string,port:number,timeout?:number)=>Promise<boolean>} o.isPortOpen 注入（app 里已有）
   * @param {string} o.relayStatusUrl 中继状态口，如 http://127.0.0.1:11230
   * @param {string[]|(()=>string[])} o.scriptCandidates 通道启动脚本的候选路径（按序找第一个存在的）
   * @param {string|(()=>string[])} o.weflowExe WeFlow 可执行文件候选（字符串=单个路径；函数=现算一串）
   * @param {string} o.nodeExe 用哪个 node 跑脚本（默认 process.execPath + ELECTRON_RUN_AS_NODE）
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ isPortOpen, relayStatusUrl, scriptCandidates = [], weflowExe = '', nodeExe = '', findPids = null, findChannelProcs = null, log = () => {} }) {
    this.isPortOpen = isPortOpen
    this.relayStatusUrl = String(relayStatusUrl || 'http://127.0.0.1:11230').replace(/\/$/, '')
    // 候选路径可以是**数组**，也可以是**函数**（每次现算）。
    // 为什么允许函数：用户可能在设置里改 `wechat.channelScript`，而本对象是 app 启动时建好的
    // —— 存成快照的话"改了要重启才生效"，而那句注释会变成谎话。
    this.#candidatesFn = typeof scriptCandidates === 'function' ? scriptCandidates : () => scriptCandidates
    // WeFlow 那条同理，而且是同一个坑：第一版我把 weflowExe 存成构造时的**快照**，
    // 于是"用户在设置里填了路径"要重启才认 —— 和 channelScript 犯的是同一个错。
    this.#weflowFn = typeof weflowExe === 'function' ? weflowExe : () => (weflowExe ? [weflowExe] : [])
    this.nodeExe = nodeExe || process.execPath
    // ⚠️ 进程探测**可注入**：它读的是"这台机器上真有没有 WeFlow 在跑"，
    //    测试里必须能固定住，否则断言会随测试机的状态飘（本机恰好一直开着 WeFlow）。
    this.#findPids = typeof findPids === 'function' ? findPids : () => this.#tasklistPids()
    // 通道进程探测同理可注入：它读的是"这台机器上真有没有通道在跑"，
    // 不固定住的话，**同一条断言会随测试机状态飘**（本机恰好一直开着通道 —— 已经栽过一次）。
    this.#findChannels = typeof findChannelProcs === 'function' ? findChannelProcs : () => this.#scanChannelProcesses()
    this.log = log
    this.proc = null
    this.startedAt = 0
    this.logs = []          // [{ at, text }]
  }

  #candidatesFn = () => []
  #weflowFn = () => []
  #findPids = () => []
  #findChannels = () => []

  /** 当前的候选路径（现算，见构造函数的说明）。 */
  candidates() {
    try {
      const v = this.#candidatesFn()
      return (Array.isArray(v) ? v : []).filter(Boolean)
    } catch { return [] }
  }

  /** 记一行日志（同时进环形缓冲与调用方的 log）。 */
  #push(text) {
    const line = String(text ?? '').replace(/\s+$/, '')
    if (!line) return
    this.logs.push({ at: Date.now(), text: line })
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT)
    this.log('[wechat-channel] ' + line)
  }

  /** 找到要跑的脚本（找不到返回 ''，调用方据此给出"去设置里指定"的提示）。 */
  findScript() {
    for (const p of this.candidates()) {
      try { if (p && fs.existsSync(p)) return p } catch { /* ignore */ }
    }
    return ''
  }

  /** WeFlow 可执行文件的候选（现算，见构造函数的说明）。 */
  weflowCandidates() {
    try {
      const v = this.#weflowFn()
      const list = Array.isArray(v) ? v : [v]
      return [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))]
    } catch { return [] }
  }

  /**
   * 解析出"到底该点哪个 WeFlow"。
   *
   * ⚠️ 为什么不能只判断端口就够了：用户点「启动 WeFlow」时端口**必然**是通的判断为假，
   *    我们要的是"哪个 exe 存在、来自哪条候选" —— 找不到时必须说清**找过哪些**，
   *    否则就是本项目最忌的"点了没反应"。
   * @returns {{path:string, source:string, candidates:string[], missing:boolean}}
   */
  resolveWeFlowExe() {
    const candidates = this.weflowCandidates()
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { path: p, source: 'candidate', candidates, missing: false } } catch { /* ignore */ }
    }
    return { path: '', source: candidates.length ? 'none-exists' : 'unconfigured', candidates, missing: true }
  }

  /** 按进程名找 WeFlow（端口还没开、但进程已经在加载时，这个能看出"它其实起来了"）。 */
  findWeFlowPids() {
    try { return (this.#findPids() || []).map(Number).filter((n) => Number.isInteger(n) && n > 0) } catch { return [] }
  }

  /** 默认实现：问一次 tasklist。失败就当"没找到"（不要让它把状态接口带崩）。 */
  #tasklistPids() {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq WeFlow.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const pids = []
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.trim().match(/^"([^"]+)","(\d+)"/)
        if (m) pids.push(Number(m[2]))
      }
      return pids
    } catch { return [] }
  }

  /** 三段的实时状态。②段的细节从**中继自己**的状态口取（不猜）。 */
  async status() {
    const weflowUp = await this.isPortOpen('127.0.0.1', 5031).catch(() => false)
    const relayUp = await this.isPortOpen('127.0.0.1', 11230).catch(() => false)
    let relay = null
    if (relayUp) {
      try {
        const r = await fetch(`${this.relayStatusUrl}/__status`, { signal: AbortSignal.timeout(1500) })
        relay = await r.json()
      } catch { relay = null }
    }
    const exe = this.resolveWeFlowExe()
    // WeFlow 有两种"在"：端口通了（真的能读库）与进程在（可能还在启动/在登录界面）。
    // 分开报，是因为"点了启动没反应"和"启动了但还没就绪"要给用户不同的话。
    const pids = weflowUp ? [] : this.findWeFlowPids()
    return {
      weflow: {
        running: weflowUp,
        port: 5031,
        pids,
        starting: !weflowUp && pids.length > 0,
        exe: exe.path,
        exeSource: exe.source,
        exeCandidates: exe.candidates
      },
      // 中继起来了但 akasha 没连 = **Bridge 没跑**（这正是最容易"看着正常其实收不到"的状态）
      channel: {
        running: relayUp,
        bridgeConnected: !!(relay && relay.akasha && relay.akasha.connected),
        login: relay?.login?.user_id ? { userId: relay.login.user_id, nickname: relay.login.nickname || '' } : null,
        eventsIn: relay?.stats?.eventsIn ?? null
      },
      // 本模块自己拉起的那个进程（用户也可能在外面的窗口里自己跑 ⇒ 这里为 null 是正常的）
      managed: { pid: this.proc?.pid ?? null, startedAt: this.startedAt || null },
      script: { path: this.findScript(), candidates: this.candidates() }
    }
  }

  /**
   * 拉起通道（中继 + Bridge 的启动器）。
   * 已经通了就直接返回 alreadyRunning —— **不重复起**（重复起会因为端口被占而报一堆错）。
   *
   * @param {{launchWeFlowFirst?:boolean, waitMs?:number}} [o]
   *   launchWeFlowFirst=true 时，若 WeFlow 没在跑就先替用户点一下火、并**等它的端口起来**
   *   （最多 waitMs 毫秒，默认 45 秒）。这是「一条命令开起来」的关键：
   *   少了这一步，用户会遇到"通道起来了但一直读不到消息"，而原因是 WeFlow 没开。
   */
  async start({ launchWeFlowFirst = false, waitMs = 45000 } = {}) {
    if (await this.isPortOpen('127.0.0.1', 11230).catch(() => false)) {
      this.#push('中继已经在跑（11230 已就绪），不重复启动')
      return { ok: true, alreadyRunning: true, pid: this.proc?.pid ?? null }
    }
    let weflow = null
    if (launchWeFlowFirst) weflow = await this.ensureWeFlow(waitMs)
    const script = this.findScript()
    if (!script) {
      return {
        ok: false,
        weflow,
        error: '找不到通道启动脚本（跑微信通道.mjs）。开发布局下它应在「工具-中继」里；'
          + '打包布局下应随 app 一起分发。可在设置里指定路径。',
        candidates: this.candidates()   // ⚠️ 用 candidates() 现算的方法，别再用构造时的快照字段（它已经不存在了）
      }
    }
    try {
      // 🔴 用 Electron 自带的 node 跑（`ELECTRON_RUN_AS_NODE=1`）：
      //    这样**不需要额外装 node**，打包环境里也成立（SnowLuma 是自带 node.exe，
      //    我们没有那个条件，但 Electron 本身就是个 node 运行时）。
      const child = spawn(this.nodeExe, [script], {
        cwd: path.dirname(script),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.proc = child
      this.startedAt = Date.now()
      this.#push(`通道启动中（pid=${child.pid}，脚本 ${path.basename(script)}）…`)
      for (const [stream, tag] of [['stdout', ''], ['stderr', '!']]) {
        child[stream].on('data', (d) => {
          for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.#push(tag + line)
        })
      }
      child.on('exit', (code, sig) => {
        this.#push(`通道进程结束（code=${code} signal=${sig ?? ''}）`)
        if (this.proc === child) this.proc = null
      })
      child.on('error', (e) => this.#push(`通道进程启动失败：${e?.message ?? e}`))
      return { ok: true, pid: child.pid, script, weflow }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), weflow }
    }
  }

  /**
   * 保证 WeFlow 在跑（不在就点一下火，然后等它的 5031 端口起来）。
   * ⚠️ 只**启动**、不**停止** —— 见 stopWeFlow 的说明（它是第三方通用应用，用户可能同时在用它）。
   * @returns {Promise<{ok:boolean, alreadyRunning?:boolean, launched?:boolean, waitedMs?:number, error?:string, exe?:string}>}
   */
  async ensureWeFlow(waitMs = 45000) {
    if (await this.weflowRunning()) return { ok: true, alreadyRunning: true, exe: this.resolveWeFlowExe().path }
    const r = this.launchWeFlow()
    if (!r.ok) return r
    const step = 1000
    for (let waited = 0; waited < Math.max(0, waitMs); waited += step) {
      await new Promise((res) => setTimeout(res, step))
      if (await this.weflowRunning()) {
        this.#push(`WeFlow 已就绪（等了 ${waited + step}ms，端口 5031 通了）`)
        return { ok: true, launched: true, waitedMs: waited + step, exe: r.exe }
      }
    }
    this.#push(`⚠️ WeFlow 已拉起但 ${waitMs}ms 内端口 5031 还没通 —— 可能停在了登录/选择数据的界面`)
    return { ok: false, launched: true, error: `WeFlow 已启动，但 ${Math.round(waitMs / 1000)} 秒内端口 5031 没通（请到它的窗口里看一眼）`, exe: r.exe }
  }

  /**
   * 找到**正在跑的通道进程**（不管是谁拉起的）。
   *
   * ── 为什么必须有它（2026-09-20 补，这是"启停通道"缺的那一半）─────────────
   * `stop()` 原来只看 `this.proc`（本模块 spawn 出来的那个），而本机真实的通道
   * （pid 28740，`D:\node\node.exe …\跑微信通道.mjs`）是**在外面窗口里跑的**
   * ⇒ 用户点「停止通道」什么也没发生，界面还说"当前没有由本应用拉起的通道进程"。
   * 那句话不算撒谎，但**按钮没干它写着的事** —— 与静默失败是同一类毛病。
   *
   * ⚠️ 用 `Get-CimInstance`（要 CommandLine）而不是 `tasklist`：tasklist 不给命令行，
   *    而"哪个 node 进程是通道"只能靠命令行认。**贵**（PowerShell 启动几百毫秒），
   *    所以**只在真正要停的时候调**，绝不放进会被轮询的 status()。
   */
  findChannelProcesses() {
    try {
      const raw = this.#findChannels() || []
      return (Array.isArray(raw) ? raw : [])
        .map((r) => ({ pid: Number(r?.pid ?? r?.ProcessId), parentPid: Number(r?.parentPid ?? r?.ParentProcessId), name: String(r?.name ?? r?.Name ?? '') }))
        // 排除自己：本进程的命令行里也可能出现同一个脚本名（比如测试里）
        .filter((r) => Number.isInteger(r.pid) && r.pid > 0 && r.pid !== process.pid)
    } catch (e) {
      this.#push(`查通道进程失败：${e?.message ?? e}`)
      return []
    }
  }

  /** 默认实现：问一次 WMI 拿命令行。**贵**，只在真要停的时候调。 */
  #scanChannelProcesses() {
    const script = this.findScript()
    const needle = script ? path.basename(script) : '跑微信通道.mjs'
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | `
      + `Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    const txt = String(out || '').trim()
    if (!txt) return []
    const arr = JSON.parse(txt)
    return Array.isArray(arr) ? arr : [arr]
  }

  /** 结束一个进程**连同它的子进程**。通道是"启动器 + 中继 + Bridge"三层，只杀头会留下占端口的孤儿。 */
  #killTree(pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' })
      return true
    } catch (e) {
      // taskkill 有时在"进程已经没了"时也返回非 0；不把它当成失败理由，交给调用方核对
      this.#push(`taskkill ${pid} 返回非 0（可能已经退出）：${String(e?.message ?? e).slice(0, 80)}`)
      return false
    }
  }

  /**
   * 停掉通道。
   * @param {{force?:boolean}} [o] force=true 时**连外面窗口跑的那个也停**
   *   （先关本模块拉起的；没有则找外面的）。默认 false = 只关自己拉起的那个。
   *
   * ⚠️ 语义刻意写清楚：默认保守（不碰别人的窗口），用户点「停止通道」时 UI 传 force=true
   *    —— 因为那个按钮**写的就是停止通道**，点了却不动才是不对。
   */
  stop({ force = false } = {}) {
    const proc = this.proc
    if (proc) {
      try {
        const pid = proc.pid
        proc.kill()
        this.#push(`已请求停止通道（本应用拉起的 pid=${pid}）`)
        this.proc = null
        return { ok: true, stopped: true, killed: [pid], ours: true }
      } catch (e) {
        this.#push(`停止通道失败：${e?.message ?? e}`)
        return { ok: false, error: String(e?.message ?? e) }
      }
    }
    const external = this.findChannelProcesses()
    if (!external.length) {
      return { ok: true, stopped: false, note: '没找到正在跑的通道进程（11230 可能是别的程序占着，或者已经停了）' }
    }
    if (!force) {
      return {
        ok: true, stopped: false, external,
        note: `通道不是本应用拉起的（pid ${external.map((p) => p.pid).join(',')}，外面窗口里跑的）。`
          + '要停就再点一次「停止通道」。'
      }
    }
    const killed = []
    for (const p of external) if (this.#killTree(p.pid)) killed.push(p.pid)
    this.#push(`已结束外面窗口跑的通道：pid ${external.map((p) => p.pid).join(', ')}`)
    return {
      ok: true, stopped: true, killed, ours: false,
      external,
      note: `通道原本是在外面的窗口里跑的（pid ${external.map((p) => p.pid).join(',')}），已连同子进程一起结束。`
        + '（那个窗口本身不会自己关，会停在报错/退出的画面上，属正常。）'
    }
  }

  /** 最近的日志（给页签那个日志框）。 */
  tail(limit = 120) {
    return this.logs.slice(-Math.max(1, Math.min(LOG_LIMIT, limit)))
  }

  /** WeFlow 在不在跑（它不归我们管，只能看端口）。 */
  async weflowRunning() {
    return await this.isPortOpen('127.0.0.1', 5031).catch(() => false)
  }

  /**
   * 替用户把 WeFlow 拉起来。
   * ⚠️ 它是**第三方 GUI 应用**：我们只负责"没跑就点一下火"，它的窗口会自己弹出来，
   *    我们既改不了它的界面，也不该把它的二进制打进我们的安装包。
   * ⚠️ 找不到 exe 时**必须把找过哪些路径报出来** —— "点了没反应"是本项目的头号病。
   */
  launchWeFlow() {
    if (this.findWeFlowPids().length > 0) {
      this.#push('WeFlow 进程已经在跑（端口还没通，可能还在加载）')
      return { ok: true, alreadyRunning: true }
    }
    const exe = this.resolveWeFlowExe()
    if (!exe.path) {
      return {
        ok: false,
        error: exe.candidates.length
          ? `WeFlow 没在跑，而这几个路径都不存在：\n  ${exe.candidates.join('\n  ')}\n可在设置里填 wechat.weflowExe 指定。`
          : '没配置 WeFlow 的路径（设置里填 wechat.weflowExe），也没找到默认位置。',
        candidates: exe.candidates
      }
    }
    try {
      const child = spawn(exe.path, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      this.#push(`已请求启动 WeFlow（${exe.path}）—— 它自己的窗口会弹出来`)
      return { ok: true, launched: true, exe: exe.path, pid: child.pid ?? null }
    } catch (e) {
      this.#push(`启动 WeFlow 失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e), exe: exe.path }
    }
  }

  /**
   * ⚠️ **刻意不做**「停止 WeFlow」。
   *
   * 理由：SnowLuma 是我们通道的专用组件，停掉它只影响我们；而 WeFlow 是**通用的微信数据应用**，
   * 用户可能同时在用它看别的东西 —— 我们在界面上放一个"停止"，等于给了用户一个
   * "顺手把别人正在用的程序关掉"的按钮。
   * ⇒ 界面上的按钮只有「启动 WeFlow」，**没有停止**。要停请用户自己关它的窗口。
   */
  stopWeFlow() {
    return { ok: false, error: '本应用不提供停止 WeFlow（它是通用第三方应用，用户可能正在用它；请直接关它的窗口）' }
  }
}
