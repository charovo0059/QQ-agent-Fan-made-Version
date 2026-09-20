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
//   ② 通道        我们的中继（11229 等 Bridge / 11230 给 agent）+ 真 Bridge。
//                 这一段的生命周期由本模块负责。
//   ③ 我的链路    app 自己的第二个 OneBot 客户端有没有连上中继 ——
//                 这个状态在 app 里（`/api/status.wechat`），不在这里重复实现。
//
// ⚠️ **不提权、不静默**：起不来就把原因原样报出来（找不到脚本/端口被占/进程立刻退出），
//    绝不"点了没反应"。本项目的头号病就是静默失败。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 日志环形缓冲上限（够排障，又不会把内存吃光）。 */
const LOG_LIMIT = 300

export class WechatChannel {
  /**
   * @param {object} o
   * @param {(host:string,port:number,timeout?:number)=>Promise<boolean>} o.isPortOpen 注入（app 里已有）
   * @param {string} o.relayStatusUrl 中继状态口，如 http://127.0.0.1:11230
   * @param {string[]} o.scriptCandidates 通道启动脚本的候选路径（按序找第一个存在的）
   * @param {string} o.weflowExe WeFlow 可执行文件路径（可选；用于"替用户拉起来"）
   * @param {string} o.nodeExe 用哪个 node 跑脚本（默认 process.execPath + ELECTRON_RUN_AS_NODE）
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ isPortOpen, relayStatusUrl, scriptCandidates = [], weflowExe = '', nodeExe = '', log = () => {} }) {
    this.isPortOpen = isPortOpen
    this.relayStatusUrl = String(relayStatusUrl || 'http://127.0.0.1:11230').replace(/\/$/, '')
    // 候选路径可以是**数组**，也可以是**函数**（每次现算）。
    // 为什么允许函数：用户可能在设置里改 `wechat.channelScript`，而本对象是 app 启动时建好的
    // —— 存成快照的话"改了要重启才生效"，而那句注释会变成谎话。
    this.#candidatesFn = typeof scriptCandidates === 'function' ? scriptCandidates : () => scriptCandidates
    this.weflowExe = weflowExe
    this.nodeExe = nodeExe || process.execPath
    this.log = log
    this.proc = null
    this.startedAt = 0
    this.logs = []          // [{ at, text }]
  }

  #candidatesFn = () => []

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
    return {
      weflow: { running: weflowUp, port: 5031 },
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
   */
  async start() {
    if (await this.isPortOpen('127.0.0.1', 11230).catch(() => false)) {
      this.#push('中继已经在跑（11230 已就绪），不重复启动')
      return { ok: true, alreadyRunning: true, pid: this.proc?.pid ?? null }
    }
    const script = this.findScript()
    if (!script) {
      return {
        ok: false,
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
      return { ok: true, pid: child.pid, script }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }

  /** 停掉**本模块拉起的**那个通道进程。外面的窗口自己跑的不归它管（如实说明）。 */
  stop() {
    const proc = this.proc
    if (!proc) return { ok: true, stopped: false, note: '当前没有由本应用拉起的通道进程（可能是在外面自己跑的）' }
    try {
      proc.kill()
      this.#push('已请求停止通道')
      this.proc = null
      return { ok: true, stopped: true }
    } catch (e) {
      this.#push(`停止通道失败：${e?.message ?? e}`)
      return { ok: false, error: String(e?.message ?? e) }
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
   */
  launchWeFlow() {
    if (!this.weflowExe) return { ok: false, error: '没配置 WeFlow 的路径（设置里填 wechat.weflowExe）' }
    if (!fs.existsSync(this.weflowExe)) return { ok: false, error: `找不到 WeFlow：${this.weflowExe}` }
    try {
      spawn(this.weflowExe, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
      this.#push('已请求启动 WeFlow（它自己的窗口会弹出来）')
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) }
    }
  }
}
