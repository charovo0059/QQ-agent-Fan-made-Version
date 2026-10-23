// 微信通道的生命周期管理：状态探测 / 启动（拉起微信 + 注入 hook + 起中继）/ 停止 / 日志。
//
// ── 链路（2026-10-22 重做，见 relay-wechat/docs/契约-微信页改造后状态.md）────────
//   微信 4.1.10.27 (Weixin.exe) + version.dll 注入  → 进程内 HTTP API :30001
//        ↓ WinHTTP POST（新消息推送）
//   relay-wechat（Node，relay-wechat/index.js）: 18999 收推送，11230 给本应用
//        ↓ OneBot v11
//   QQ Agent（本应用，第二个 OneBot 客户端）
//
// ── 三段，缺一不可（界面要能一眼看出断在哪一段）──────────────────────────
//   ① 微信        微信进程在不在跑、hook 注入通不通（30001）、登录了没。
//                 这一段 2026-10-22 之前是 WeFlow（读库那套），用户拍板整套下线 ——
//                 WeFlow 只能读、发送还得靠另一个 Bridge 用 UIA 点输入框，
//                 而 WeFlow 的数据组件常年 -101 读不到库。hook 注入两头都管，只留它。
//   ② 中继        本机 Node 进程。它的生命周期由本模块负责（拉起 / 停止）。
//   ③ 我的链路    app 自己的第二个 OneBot 客户端有没有连上中继 ——
//                 这个状态在 app 里（`/api/status.wechat`），不在这里重复实现。
//
// ⚠️ **不提权、不静默**：起不来就把原因原样报出来（找不到脚本/端口被占/进程立刻退出），
//    绝不"点了没反应"。本项目的头号病就是静默失败。
//
// ⚠️ 三态纪律（本项目反复栽的坑）：拿不到读数 ⇒ 报 **null 并说"问不到"**，
//    绝不折成 false 假装"确定没有"，也绝不折成 true 假装"确定好了"。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

/** 日志环形缓冲上限（够排障，又不会把内存吃光）。 */
const LOG_LIMIT = 300

/** 微信进程名（4.1.x 是 Weixin.exe；3.x 叫 WeChat.exe，不认它 —— 3.x 已被服务端硬封）。 */
const WX_PROC_NAME = 'Weixin.exe'

/** hook 登录态探测的缓存时长：`/api/status` 每 15 秒轮询一次，不必每次都问微信。 */
const WX_LOGIN_PROBE_TTL_MS = 10 * 1000

/**
 * 「这个中继是我拉起来的」的归属标记（环境变量名）。
 *
 * 🔴 为什么需要它（2026-10-23 第五十六对话，线上事故）：
 *   app 退出时 stop({force:true}) 按**命令行**扫 relay-wechat 进程并 taskkill。
 *   而回归测试的 bootApp 在进程内 createApp()，teardown 照样走这条路 ⇒
 *   它扫到的是**线上那个真中继**，把生产通道杀了。实测：跑一次
 *   test-端口预检.mjs ⇒ 生产中继 pid 当场消失；跑纯磁盘判据 ⇒ 纹丝不动。
 *   每次全量回归都在偷偷杀线上通道，然后自动重启 3 次用满就永久停手。
 * ⇒ 现在每一代中继都带这个环境变量（值是拉它的那个进程 pid），
 *   扫描时用它判归属：**标记是自己 pid 的才是"我的"**。
 *   没有标记 / 标记是别人 pid 的一律算"外面的"（默认不碰）。
 */
const OWNER_ENV = 'DSH_WXCHANNEL_OWNER'

/**
 * 同一个归属标记的**命令行**形式（`--wxchannel-owner=<pid>`）。
 * 为什么两处都要：WMI 的 `Win32_Process` 能读 CommandLine 但读不到环境变量，
 * 而"这进程是不是我拉的那一代"必须在扫描时判得出来。
 */
const OWNER_ARG = '--wxchannel-owner='

/**
 * 从命令行里解出归属 pid（解析不出来回 **0**，表示"不是我拉的那一代"）。
 * 单独抽成函数是为了能被判据直接调：脏输入（null / 空串 / 乱码 / 多个标记）
 * 必须一律当"不是我的"，⛔ 绝不因为解析失败就当成自己的然后去杀它。
 */
function parseOwnerPid(cmd) {
  const m = String(cmd || '').match(/--wxchannel-owner=(\d{1,12})\b/)
  if (!m) return 0
  const n = Number(m[1])
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

/**
 * 这个 pid 还活着吗（只读探测，绝不抛）。
 * 用途见 `#ownedByOther()`：判断"这个中继是不是另一个**还活着**的进程拉起的"。
 */
function isAliveSync(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
  try { process.kill(n, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/**
 * 这个进程名像不像**另一个应用实例**（桌面版 QQ Agent / Electron 宿主）。
 *
 * 🔴 为什么要认名字（2026-10-23 第五十六对话补）：
 *   光看归属标记只能保护**打了标记之后**才拉起来的中继。事故发生时线上那个中继是
 *   **旧代码拉起的、命令行上没有标记**（ownerPid=0）⇒ 单靠标记它会继续被回归测试杀掉。
 *   而它的父进程是**另一个还活着的 QQ Agent.exe**（真身那份应用）—— 这就是"不是我拉的那一代"
 *   的第二个、也是**当下就能用**的判据。
 *   ⚠️ 只在"父进程是应用宿主"时才算别人的：中继在**外部 cmd/终端窗口**里自己跑时父进程是
 *      cmd.exe / node.exe，那种情况仍然要让 UI 的「停止通道」能停掉它（用户的按钮语义）。
 */
function isAppHostName(name) {
  return /^(QQ Agent|electron)(\.exe)?$/i.test(String(name || '').trim())
}

export class WechatChannel {
  /**
   * @param {object} o
   * @param {(host:string,port:number,timeout?:number)=>Promise<boolean>} o.isPortOpen 注入（app 里已有）
   * @param {string} o.relayStatusUrl 中继状态口，如 http://127.0.0.1:11230
   * @param {string[]|(()=>string[])} o.scriptCandidates 中继启动脚本候选（按序找第一个存在的）
   * @param {string|(()=>string[])} o.weixinExe 微信主程序候选（字符串=单个路径；函数=现算一串）
   * @param {string|(()=>string[])} o.injectExe 注入器（wxinject.exe）候选
   * @param {string|(()=>string[])} o.hookDll 被注入的 version.dll 候选
   * @param {number} o.hookPort 注入后微信进程内 HTTP API 端口（默认 30001）
   * @param {number} o.hookCallbackPort 中继收推送的端口（默认 18999，写进 wxinject 命令行的 CallBackURL）
   * @param {string} o.nodeExe 用哪个 node 跑脚本（默认 process.execPath + ELECTRON_RUN_AS_NODE）
   * @param {(msg:string)=>void} [o.log]
   */
  constructor({ isPortOpen, relayStatusUrl, scriptCandidates = [], weixinExe = '', injectExe = '', hookDll = '',
    hookPort = 30001, hookCallbackPort = 18999, nodeExe = '', findPids = null, findChannelProcs = null, log = () => {},
    // 🆕 2026-10-23（第五十四对话 · 中继稳定性）：中继进程**意外退出后自动拉起**的参数。
    //   ⚠️ 判据是"**连续**快速退出"，不是"退出就重启"：崩溃通常会立刻再崩一次，
    //     无限重启只会把日志刷满、把端口抢得一团糟。所以退避 + 次数上限。
    restartOnExit = true, maxRestarts = 3, restartBaseMs = 2000, restartMaxMs = 30000,
    // 退出后多久内重启算"又一次失败"（超过这个时长就认为跑稳了，计数清零）
    restartStableMs = 60000 } = {}) {
    this.isPortOpen = isPortOpen
    this.relayStatusUrl = String(relayStatusUrl || 'http://127.0.0.1:11230').replace(/\/$/, '')
    // 中继端口从状态口 URL 里派生（写死 11230 的话，配置里改端口就成了谎话）
    this.relayPort = Number(new URL(this.relayStatusUrl).port) || 11230
    // 候选一律允许是**函数**（每次现算）。
    // 为什么：用户可能在设置里改路径，而本对象是 app 启动时建好的 ——
    // 存成快照的话"改了要重启才生效"，而那句注释会变成谎话（这个坑在本文件里犯过两次）。
    this.#candidatesFn = typeof scriptCandidates === 'function' ? scriptCandidates : () => scriptCandidates
    this.#wxExeFn = typeof weixinExe === 'function' ? weixinExe : () => (weixinExe ? [weixinExe] : [])
    this.#injectFn = typeof injectExe === 'function' ? injectExe : () => (injectExe ? [injectExe] : [])
    this.#dllFn = typeof hookDll === 'function' ? hookDll : () => (hookDll ? [hookDll] : [])
    this.hookPort = Number(hookPort) || 30001
    this.hookCallbackPort = Number(hookCallbackPort) || 18999
    this.nodeExe = nodeExe || process.execPath
    // ⚠️ 进程探测**可注入**：它读的是"这台机器上真有没有微信在跑"，
    //    测试里必须能固定住，否则断言会随测试机状态飘。
    this.#findPids = typeof findPids === 'function' ? findPids : () => this.#tasklistWeixinPids()
    this.#findChannels = typeof findChannelProcs === 'function' ? findChannelProcs : () => this.#scanChannelProcesses()
    this.log = log
    this.proc = null
    this.startedAt = 0
    this.logs = []          // [{ at, text }]
    // ── 自动重启（见构造函数里的说明）────────────────────────────────────
    this.restartOnExit = restartOnExit !== false
    this.maxRestarts = Math.max(1, Number(maxRestarts) || 3)
    this.restartBaseMs = Math.max(500, Number(restartBaseMs) || 2000)
    this.restartMaxMs = Math.max(this.restartBaseMs, Number(restartMaxMs) || 30000)
    this.restartStableMs = Math.max(5000, Number(restartStableMs) || 60000)
    /** 用户/应用**主动**停止过 ⇒ 不许再自己爬起来（否则"停止通道"会像没生效）。 */
    this.stopping = false
    /** 连续失败次数（跑稳一段时间后清零）。 */
    this.restartCount = 0
    /** 待执行的自动重启定时器句柄（stop() 必须能真的取消它）。 */
    this.restartTimer = null
    /** 最近一次自动重启的时间戳与原因（给页面/日志看"它为什么又起来了"）。 */
    this.lastRestartAt = 0
    this.lastExit = null
  }

  #candidatesFn = () => []
  #wxExeFn = () => []
  #injectFn = () => []
  #dllFn = () => []
  #findPids = () => []
  #findChannels = () => []
  /** 最近一次登录态探测的结论 `{ at, loginOk, selfWxid, selfName, error }`（10 秒内复用）。 */
  #loginCache = null

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

  /** 把"字符串或函数"的候选统一成去重后的字符串数组。 */
  #resolveList(fn) {
    try {
      const v = fn()
      const list = Array.isArray(v) ? v : [v]
      return [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))]
    } catch { return [] }
  }

  weixinCandidates() { return this.#resolveList(this.#wxExeFn) }
  injectCandidates() { return this.#resolveList(this.#injectFn) }
  dllCandidates() { return this.#resolveList(this.#dllFn) }

  /**
   * 解析出"到底点哪个 Weixin.exe"。
   *
   * ⚠️ 找不到时必须说清**找过哪些**，否则就是本项目最忌的"点了没反应"。
   * @returns {{path:string, source:string, candidates:string[], missing:boolean}}
   */
  resolveWeixinExe() {
    const candidates = this.weixinCandidates()
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { path: p, source: 'candidate', candidates, missing: false } } catch { /* ignore */ }
    }
    return { path: '', source: candidates.length ? 'none-exists' : 'unconfigured', candidates, missing: true }
  }

  /** 解析注入器与 DLL（两个都得在，缺一个就注入不了 —— 分开报，别混成一句）。 */
  resolveInjector() {
    const pick = (candidates) => {
      for (const p of candidates) {
        try { if (fs.existsSync(p)) return p } catch { /* ignore */ }
      }
      return ''
    }
    const injects = this.injectCandidates()
    const dlls = this.dllCandidates()
    const injectExe = pick(injects)
    const dll = pick(dlls)
    return {
      injectExe, dll, injectCandidates: injects, dllCandidates: dlls,
      ok: Boolean(injectExe && dll)
    }
  }

  /** 按进程名找微信（端口还没开、但进程已经在加载时，这个能看出"它其实起来了"）。 */
  findWeixinPids() {
    try { return (this.#findPids() || []).map(Number).filter((n) => Number.isInteger(n) && n > 0) } catch { return [] }
  }

  /** 默认实现：问一次 tasklist。失败就当"没找到"（不要让它把状态接口带崩）。 */
  #tasklistWeixinPids() {
    try {
      const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${WX_PROC_NAME}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const pids = []
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.trim().match(/^"([^"]+)","(\d+)"/)
        if (m) pids.push(Number(m[2]))
      }
      return pids
    } catch (e) {
      // ⚠️ 语义不变（仍返回 `[]`、不让状态接口崩），但**出声**：
      //    `[]` 的语义是"微信没在跑"，而 tasklist 本身失败也走这条路 —— 必须能区分。
      console.error(`[wechat] tasklist 查微信进程失败（本次按"没在跑"处理）：${e?.message ?? e}`)
      return []
    }
  }

  /**
   * 问一次"微信登录了没"（打进程内 hook 的 `POST /GetSelfProfile`），结论**缓存 10 秒**。
   *
   * 口径（三态，⛔ 别把"问不到"折成"没登录"）：
   *    · hook 端口不通        ⇒ `{ loginOk: null, error: 'hook 没通' }`（这一层不归它判）
   *    · 请求失败/非 200      ⇒ `{ loginOk: null, error: '问不到：…' }`
   *    · 回话里 wxid 非空     ⇒ `loginOk: true` + 身份
   *    · 回话里 wxid 为空串   ⇒ `loginOk: false`（**真的没登录**，这是唯一能说"没登录"的证据）
   * @returns {Promise<{loginOk:boolean|null, selfWxid:string, selfName:string, error:string}>}
   */
  async #probeLogin(hookOk) {
    const now = Date.now()
    if (this.#loginCache && now - this.#loginCache.at < WX_LOGIN_PROBE_TTL_MS) {
      return { loginOk: this.#loginCache.loginOk, selfWxid: this.#loginCache.selfWxid, selfName: this.#loginCache.selfName, error: this.#loginCache.error }
    }
    const empty = { loginOk: null, selfWxid: '', selfName: '', error: '' }
    if (!hookOk) {
      const r = { ...empty, error: 'hook 没通，登录状态未知' }
      this.#loginCache = { at: now, ...r }
      return r
    }
    let out = { ...empty };
    try {
      const resp = await fetch(`http://127.0.0.1:${this.hookPort}/GetSelfProfile`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2500) })
      if (!resp || resp.status !== 200) {
        out = { ...empty, error: `问不到：HTTP ${resp ? resp.status : '无响应'}` }
      } else {
        const p = await resp.json().catch(() => ({}));
        const wxid = String(p?.wxid || p?.Wxid || p?.profile_account_id || '').trim();
        const name = String(p?.nickname || p?.profile_nickname || p?.NickName || '').trim();
        // wxid 为空串是 hook 的"未登录"答复（源码 SendTextMsg.cpp 的口径），
        // ⚠️ 但只有当请求本身成功时这句话才算数 —— 所以上面对非 200 单列了一档。
        out = { loginOk: Boolean(wxid), selfWxid: wxid, selfName: name, error: '' };
      }
    } catch (e) {
      out = { ...empty, error: `问不到：${String(e?.message ?? e).slice(0, 60)}` };
    }
    this.#loginCache = { at: now, ...out }
    return out;
  }

  /** 三段的实时状态。②段的细节从**中继自己**的状态口取（不猜）。 */
  async status() {
    const hookOk = await this.isPortOpen('127.0.0.1', this.hookPort).catch(() => false)
    const relayUp = await this.isPortOpen('127.0.0.1', this.relayPort).catch(() => false)
    let relay = null;
    if (relayUp) {
      try {
        const r = await fetch(`${this.relayStatusUrl}/__status`, { signal: AbortSignal.timeout(1500) });
        relay = await r.json();
      } catch { relay = null }
    }
    const exe = this.resolveWeixinExe();
    const pids = hookOk ? [] : this.findWeixinPids();
    const running = hookOk || pids.length > 0;
    const login = await this.#probeLogin(hookOk);
    return {
      // ① 微信：三种"在"分开报，因为**处置完全不同**
      //   running=true                    进程在
      //   hookOk=true                     注入通了（30001 在听）—— 只有这个才能收发
      //   loginOk=true / false / null     登录了 / 确实没登录 / 问不到（不许猜）
      wx: {
        running,
        hookOk,
        loginOk: login.loginOk,
        selfWxid: login.selfWxid,
        selfName: login.selfName,
        error: login.error || '',
        port: this.hookPort,
        pids,
        starting: !hookOk && pids.length > 0,
        exe: exe.path,
        exeSource: exe.source,
        exeCandidates: exe.candidates
      },
      // ② 中继：`bridgeConnected` = 中继说 hook 那头连着（它自己的 akasha.connected）。
      //    中继在跑但这一位 false = **看着通了其实收不到**，正是最容易假绿的状态。
      channel: {
        running: relayUp,
        bridgeConnected: !!(relay && relay.akasha && relay.akasha.connected),
        login: relay?.login?.user_id ? { userId: relay.login.user_id, nickname: relay.login.nickname || '', wxid: relay.login.wxid || '' } : null,
        eventsIn: relay?.stats?.eventsIn ?? null,
        // 推送通不通：中继自己记的"收到过多少次微信推送"。0 = 一次都没收到过
        //   ⇒ 光端口通不算（这正是旧链路"看着通了其实收不到"的同一个坑）。
        pushOk: relay ? Number(relay.stats?.received || 0) > 0 : null,
        received: relay?.stats?.received ?? null
      },
      // 本模块自己拉起的中继进程（用户也可能在外面的窗口里自己跑 ⇒ 这里为 null 是正常的）
      managed: { pid: this.proc?.pid ?? null, startedAt: this.startedAt || null },
      // ③ 自动重启的账（2026-10-23 补）：它**必须能被看见**。
      //    中继自己崩了又自己爬起来，如果界面一个字都不说，用户只会觉得
      //    「刚才那一阵怎么不回消息」—— 那正是本项目最忌的静默失败。
      //    pending=true 表示"已经判定要重启、定时器在跑"，这时端口是不通的。
      restart: {
        onExit: this.restartOnExit,
        pending: !!this.restartTimer,
        count: this.restartCount,
        max: this.maxRestarts,
        lastRestartAt: this.lastRestartAt || null,
        lastExit: this.lastExit ? { ...this.lastExit } : null
      },
      script: { path: this.findScript(), candidates: this.candidates() }
    };
  }

  /**
   * 拉起整条通道：① 微信（没跑/没注入就先注入启动）→ ② 中继。
   *
   * ⚠️ 顺序是**刻意的**：中继必须先起来，因为注入时命令行里的 `CallBackURL` 指向它的 18999；
   *    反过来（先注入微信）会让启动那几十秒里的新消息全部推不出去。
   *
   * @param {{launchWeixinFirst?:boolean, waitMs?:number}} [o]
   *   launchWeixinFirst=true 时，微信没跑或 hook 没注入就先注入启动并**等 30001 起来**。
   */
  async start({ launchWeixinFirst = false, waitMs = 45000 } = {}) {
    const relayUp = await this.isPortOpen('127.0.0.1', this.relayPort).catch(() => false);
    let weixin = null;
    // ① 先确认微信这一头（注入启动要花十几秒，先发起来，中继起来后再等它）
    let wxPromise = null;
    if (launchWeixinFirst && !(await this.isPortOpen('127.0.0.1', this.hookPort).catch(() => false))) {
      wxPromise = this.ensureWeixin(waitMs);
    }
    // ② 中继
    let relayPart;
    if (relayUp) {
      this.#push(`中继已经在跑（${this.relayPort} 已就绪），不重复启动`);
      relayPart = { ok: true, alreadyRunning: true, pid: this.proc?.pid ?? null };
    } else {
      const script = this.findScript();
      if (!script) {
        weixin = wxPromise ? await wxPromise : null;
        return {
          ok: false,
          weixin,
          error: '找不到中继启动脚本（relay-wechat/index.js）。开发布局下它应在工作区的「dsh qq\\relay-wechat」里；'
            + '打包布局下应随 app 一起分发。可在设置里填 wechat.channelScript 指定路径。',
          candidates: this.candidates()
        };
      }
      try {
        const child = this.#spawnRelay(script);
        relayPart = { ok: true, pid: child.pid, script };
      } catch (e) {
        weixin = wxPromise ? await wxPromise : null;
        return { ok: false, error: String(e?.message ?? e), weixin };
      }
    }
    weixin = wxPromise ? await wxPromise : null;
    return { ...relayPart, weixin };
  }

  /**
   * 起一个中继子进程，并把「退出后要不要自己爬起来」挂上去。
   *
   * 🔴 为什么必须单独抽出来（2026-10-23 第五十四对话）：原来 spawn 与 exit 处理
   *    都内联在 start() 里，exit 回调只写一行日志 ⇒ **中继死了没人管**。
   *    而中继是本应用的子进程，微信那边一切正常、只有它没了的表现是
   *    「界面全绿、消息永远不来」—— 用户完全看不出根因（实机日志 22:56:44
   *    ERROR 11230 listen EADDRINUSE 之后进程即死，之后十几分钟无人补救）。
   *    自动重启放进「拉起的那个动作」里，才能保证**每一代**都有兜底。
   */
  #spawnRelay(script) {
    // 🔴 用 Electron 自带的 node 跑（ELECTRON_RUN_AS_NODE=1）：
    //    这样**不需要额外装 node**，打包环境里也成立。
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.stopping = false;
    const gen = (this.procGen = (this.procGen || 0) + 1);
    // 🔴 2026-10-23 第五十六对话：给每一代中继打上**归属标记**（环境变量）。
    //    为什么必须打（这是本文件第三次犯「探测器匹配到自己」的病）：
    //    app 退出时 stop({force:true}) 会去扫「命令行里含 relay-wechat 的进程」并
    //    taskkill /T /F。而**回归测试**里的 bootApp 会在进程内 createApp()，
    //    teardown 时照样调 stop({force:true}) ⇒ 它扫到的是**线上那个真中继**
    //    （命令行确实是 relay-wechat/index.js）并把它杀掉。实测：跑一次
    //    test-端口预检.mjs，生产中继 pid 当场消失；跑纯磁盘判据则纹丝不动。
    //    ⇒ 每次全量回归都在偷偷杀线上通道，然后自动重启 3 次用满就停手，
    //      日志里只剩「code=1、无 signal、relay 自己一行都没留」。
    //    解法：本进程 spawn 出来的中继一律带 DSH_WXCHANNEL_OWNER=<本进程 pid>，
    //    扫描时**只认标记等于自己 pid 的**才当成"我的"；没标记的一律算"外面的"，
    //    默认不碰（force 时也只在真的点了停止按钮那条路上才碰，见 stop 的分支）。
    const ownerTag = String(process.pid);
    // ⚠️ 标记**同时**放进命令行（`--wxchannel-owner=<pid>`）与环境变量：
    //    · 命令行那份是给 WMI 扫描用的（Get-CimInstance 能拿到 CommandLine，拿不到环境变量）；
    //    · 环境变量那份是给万一要自查的子进程用的。
    //    relay-wechat/index.js 不读 process.argv（全仓 grep 无命中）⇒ 多一个参数无害。
    const child = spawn(this.nodeExe, [script, OWNER_ARG + ownerTag], {
      cwd: path.dirname(script),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', [OWNER_ENV]: ownerTag },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.proc = child;
    this.startedAt = Date.now();
    this.#push(`中继启动中（pid=${child.pid}，脚本 ${path.basename(script)}，第 ${gen} 代）…`);
    for (const [stream, tag] of [['stdout', ''], ['stderr', '!']]) {
      child[stream].on('data', (d) => {
        for (const line of String(d).split(/\r?\n/)) if (line.trim()) this.#push(tag + line);
      });
    }
    child.on('exit', (code, sig) => {
      const ranMs = Date.now() - this.startedAt;
      this.lastExit = { code, signal: sig ?? '', at: Date.now(), ranMs, gen };
      this.#push(`中继进程结束（第 ${gen} 代，code=${code} signal=${sig ?? ''}，跑了 ${Math.round(ranMs / 1000)} 秒）`);
      // ⚠️ 只有「当前这一代」退出才清 proc：旧代迟到退出的回调不许把新代指成"没了"
      //    （否则下一次 start() 又会去 spawn 第二个，两个抢 11230）。
      if (this.proc === child) this.proc = null;
      if (this.proc && this.proc !== child) return;
      this.#scheduleRestart({ code, sig, ranMs, script });
    });
    child.on('error', (e) => this.#push(`中继进程启动失败：${e?.message ?? e}`));
    return child;
  }

  /**
   * 决定「要不要把这个已经死掉的中继拉起来」，并把理由写清楚。
   *
   * 三条纪律：
   *  ① **用户主动停的不重启**（stopping）—— 否则点「停止通道」后它自己又回来，
   *    按钮看起来就像没生效（本项目最忌的"看起来做了、其实没做"）。
   *  ② **连续快速崩溃有上限**：只有跑稳过 restartStableMs 才清零计数，否则 +1；
   *    超过 maxRestarts 就**停止自动重启并把原因写进日志**（⛔ 不静默）。
   *  ③ **宁可晚一点也不要抢端口**：退避从 restartBaseMs 起翻倍，封顶 restartMaxMs。
   *     （实测 EADDRINUSE 时立刻重启＝立刻再撞一次，纯刷日志。）
   */
  #scheduleRestart({ code, sig, ranMs, script }) {
    if (!this.restartOnExit || this.stopping) {
      this.#push('中继已退出；本次不自动重启（' + (this.stopping ? '是主动停止的' : '配置里关了 restartOnExit') + '）');
      return;
    }
    const clean = code === 0 && !sig;
    if (ranMs >= this.restartStableMs && this.restartCount > 0) {
      // 跑稳过一段时间 ⇒ 之前那串「连续崩溃」到此为止，重新从头数。
      // ⚠️ 注意不是「清零就完事」：**这一次**崩溃仍然是新一轮的第 1 次
      //    （下面统一 +1）。写成「清零后不计数」会让计数停在 0，日志出现
      //    「第 0/3 次」这种读不懂的话。
      this.#push(`中继稳定运行过 ${Math.round(ranMs / 1000)} 秒，自动重启计数清零（这次崩溃重新算第 1 次）`);
      this.restartCount = 0;
    }
    this.restartCount += 1;
    if (this.restartCount > this.maxRestarts) {
      this.#push(`🔴 中继连续 ${this.restartCount - 1} 次异常退出（本次 code=${code}），已达上限 ${this.maxRestarts} 次 ⇒ **停止自动重启**。`
        + '请到「微信通道」页看日志最后几行（常见原因：11230 被别的程序占着 / relay-wechat 依赖没装 / 端口配置冲突）。');
      return;
    }
    const delay = Math.min(this.restartMaxMs, this.restartBaseMs * Math.pow(2, Math.max(0, this.restartCount - 1)));
    // ⚠️ 毫秒级要说毫秒：配置里可以把退避调到 100ms 级（测试/调试），
    //    写成 Math.round(delay/1000) 会变成「0 秒后自动重启」这种读不懂的话。
    const delayText = delay < 1000 ? `${delay} 毫秒` : `${Math.round(delay / 1000)} 秒`;
    this.#push(`${clean ? '中继正常退出' : '中继异常退出'} ⇒ ${delayText}后自动重启（第 ${this.restartCount}/${this.maxRestarts} 次）`);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      // 端口还开着 ⇒ 已经有别的东西在上面跑了，不要再抢（⛔ 不许出现两个中继）
      //
      // 🔴 2026-10-23 第五十六对话：**必须查两个端口**，不能只查 11230。
      //    事故原文（relay.log 16:32:30）：
      //      [ERROR] [relay:hook] 监听 127.0.0.1:18999 失败：listen EADDRINUSE
      //      → 启动步骤「起推送端口 18999」第 1/3 次失败
      //      → 第 2 次「监听 18999 超时（可能被占用）」→ 启动失败退出
      //    成因：上一代中继只死了 11230、18999 还被别的东西（或上一代的子进程）占着，
      //    于是新起的这一代能过 11230 这道闸，却在 18999 撞车**当场死掉** ——
      //    然后又被自动重启，形成「起来就死」的循环，日志里只剩一串 code=1。
      //    ⇒ 两个端口都得空着才准起（缺一个就不起，并说清是哪个）。
      Promise.all([
        this.isPortOpen('127.0.0.1', this.relayPort).catch(() => false),
        this.isPortOpen('127.0.0.1', this.hookCallbackPort).catch(() => false)
      ]).then(([relayUp, callbackUp]) => {
        if (relayUp || callbackUp) {
          const who = relayUp ? `${this.relayPort}（对外 OneBot 口）` : `${this.hookCallbackPort}（收推送的口）`;
          this.#push(`自动重启跳过：${who} 已经有东西在监听（可能别人已经把它拉起来了，或上一代没退干净）`
            + `；两个端口都得空着才敢起，否则新的一代会当场 EADDRINUSE 死掉`);
          return;
        }
        try {
          const s = this.findScript();
          if (!s) { this.#push('自动重启失败：找不到中继启动脚本（去设置里指定 wechat.channelScript）'); return; }
          this.lastRestartAt = Date.now();
          const child = this.#spawnRelay(s);
          this.#push(`中继已自动重启（pid=${child.pid}）`);
        } catch (e) {
          this.#push(`自动重启失败：${e?.message ?? e}`);
        }
      }).catch((e) => this.#push(`自动重启前探端口失败：${e?.message ?? e}`));
    }, delay);
    // 同 OneBotClient 的重连定时器：别让它吊住事件循环（测试里要能干净退出）。
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }
  /**
   * 保证微信在跑**且 hook 已注入**（不在就注入启动，然后等 30001 端口通）。
   * @returns {Promise<{ok:boolean, alreadyRunning?:boolean, launched?:boolean, waitedMs?:number, error?:string, exe?:string}>}
   */
  async ensureWeixin(waitMs = 45000) {
    if (await this.isPortOpen('127.0.0.1', this.hookPort).catch(() => false)) {
      return { ok: true, alreadyRunning: true, exe: this.resolveWeixinExe().path };
    }
    const r = this.launchWeixin();
    if (!r.ok) return r;
    const step = 1000;
    for (let waited = 0; waited < Math.max(0, waitMs); waited += step) {
      await new Promise((res) => setTimeout(res, step));
      if (await this.isPortOpen('127.0.0.1', this.hookPort).catch(() => false)) {
        this.#push(`微信 hook 已就绪（等了 ${waited + step}ms，端口 ${this.hookPort} 通了）`);
        return { ok: true, launched: true, waitedMs: waited + step, exe: r.exe };
      }
    }
    this.#push(`⚠️ 微信已注入启动但 ${waitMs}ms 内 hook 端口 ${this.hookPort} 还没通 —— 可能注入失败，或停在了登录界面`);
    return {
      ok: false, launched: true, exe: r.exe,
      error: `微信已注入启动，但 ${Math.round(waitMs / 1000)} 秒内 hook 端口 ${this.hookPort} 没通（先退出微信再点一次「启动微信」）`
    };
  }

  /**
   * 注入启动微信（先关掉现有进程，再带 hook 参数重开）。
   *
   * ── 为什么必须先关 ────────────────────────────────────────────────
   *   同一端口不能被注入两次，而且老进程里跑的是**没有 hook** 的版本 ⇒ 不关就会
   *   "点了启动、端口还是不通"，用户看到的就是"点了没反应"。
   * ⚠️ 关进程前**要出声**：微信可能正在被用户自己用着，突然断掉得让他知道为什么。
   *
   * ── 注入命令行（实测唯一可用的形状，2026-10-22）─────────────────────
   *   wxinject.exe <Weixin.exe> <version.dll> StartPort=<port> RecvType=1 CallBackURL=http://127.0.0.1:<hookCallbackPort>/hook
   *   · 输出形如 `pid,<数字>`；DLL 起来后 1 秒内端口 LISTEN
   *   · CallBackURL 必须写：wx.ini 里的 recv_url 只在命令行没给时才读
   *     （源码 src/wx_ini_reader.cpp:9 GetWxRecvUrl）
   */
  launchWeixin() {
    const already = this.findWeixinPids();
    if (already.length > 0) {
      this.#push(`微信已经在跑（pid ${already.join(',')}），但 hook 端口 ${this.hookPort} 没通 ⇒ 先把它关掉再注入启动`);
      for (const pid of already) this.#killTree(pid);
      // 给它两秒真的退出（紧接着启动会和残留进程抢文件锁）
      try { execFileSync(process.env.comspec || 'cmd.exe', ['/c', 'timeout', '/t', '2', '/nobreak'], { windowsHide: true, timeout: 8000, stdio: 'ignore' }) } catch { /* ignore */ }
    }
    const wx = this.resolveWeixinExe();
    const inj = this.resolveInjector();
    if (!wx.path) {
      return {
        ok: false,
        error: wx.candidates.length
          ? `微信没在跑，而这几个路径都不存在：\n  ${wx.candidates.join('\n  ')}\n可在设置里填 wechat.weixinExe 指定。`
          : '没配置微信主程序路径（设置里填 wechat.weixinExe），也没找到默认位置。',
        candidates: wx.candidates
      };
    }
    if (!inj.ok) {
      return {
        ok: false, exe: wx.path,
        error: '找不到注入工具（需要 wxinject.exe 与 version.dll 两个文件都真实存在）。'
          + `找过注入器：${inj.injectCandidates.join(' ｜ ') || '(无候选)'}；`
          + `找过 DLL：${inj.dllCandidates.join(' ｜ ') || '(无候选)'}。`
          + '开发布局下它们应在 relay-wechat\\tools 里；可在设置里填 wechat.injectExe / wechat.hookDll 指定。',
        injectCandidates: inj.injectCandidates,
        dllCandidates: inj.dllCandidates
      };
    }
    const callback = `http://127.0.0.1:${this.hookCallbackPort}/hook`;
    const args = [wx.path, inj.dll, `StartPort=${this.hookPort}`, 'RecvType=1', `CallBackURL=${callback}`];
    try {
      this.#push(`注入启动微信：${path.basename(inj.injectExe)} → ${wx.path}（hook 端口 ${this.hookPort}，回调 ${callback}）`);
      const out = execFileSync(inj.injectExe, args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
      const txt = String(out || '').trim();
      // 注入器输出 `pid,<数字>`；失败时是别的形状（或空）⇒ 原样带回去，别自己编成功。
      const m = txt.match(/^\s*(\d+)\s*,\s*(\d+)\s*$/);
      const pid = m ? Number(m[2]) : null;
      this.#push(`注入器输出：${txt || '(空)'}${pid ? ` ⇒ 微信 pid=${pid}` : ''}`);
      if (!pid) {
        return { ok: false, exe: wx.path, error: `注入器没有回报 pid（原始输出：${txt || '(空)'}）—— 微信可能没起来`, raw: txt };
      }
      return { ok: true, launched: true, exe: wx.path, pid, raw: txt };
    } catch (e) {
      const msg = String(e?.message ?? e);
      this.#push(`注入启动微信失败：${msg.slice(0, 160)}`);
      // ⚠️ execFileSync 抛错时 stdout 在 e.stdout 里，常含注入器自己的报错原话 ⇒ 带出去
      const raw = String(e?.stdout || '').trim();
      return { ok: false, exe: wx.path, error: raw || msg, raw };
    }
  }

  /**
   * 找到**正在跑的中继进程**（不管是谁拉起的）。
   *
   * ── 为什么必须有它（2026-09-20 补，这是"启停通道"缺的那一半）─────────────
   * `stop()` 原来只看 `this.proc`（本模块 spawn 出来的那个），而本机真实的中继
   * 常是**在外面窗口里跑的** ⇒ 用户点「停止通道」什么也没发生，界面还说"没有由本应用拉起的进程"。
   * 那句话不算撒谎，但**按钮没干它写着的事** —— 与静默失败是同一类毛病。
   *
   * ⚠️ 用 `Get-CimInstance`（要 CommandLine）而不是 `tasklist`：tasklist 不给命令行，
   *    而"哪个 node 进程是中继"只能靠命令行认。**贵**（PowerShell 启动几百毫秒），
   *    所以**只在真正要停的时候调**，绝不放进会被轮询的 status()。
   */
  findChannelProcesses() {
    try {
      const raw = this.#findChannels() || [];
      return (Array.isArray(raw) ? raw : [])
        .map((r) => {
          const cmd = String(r?.commandLine ?? r?.CommandLine ?? '');
          return {
            pid: Number(r?.pid ?? r?.ProcessId),
            parentPid: Number(r?.parentPid ?? r?.ParentProcessId),
            name: String(r?.name ?? r?.Name ?? ''),
            commandLine: cmd,
            // 归属：谁是拉起这一代中继的宿主进程（见 OWNER_ENV 的长注释）
            ownerPid: parseOwnerPid(cmd),
            // 父进程名：认"这一代是别的应用实例拉的吗"的第二个判据（见 isAppHostName 的注释）
            parentName: String(r?.parentName ?? r?.ParentName ?? '')
          };
        })
        .filter((r) => Number.isInteger(r.pid) && r.pid > 0 && r.pid !== process.pid)
        .filter((r) => !/^(powershell|pwsh|cmd|conhost)\.exe$/i.test(r.name));
    } catch (e) {
      this.#push(`查通道进程失败：${e?.message ?? e}`);
      return [];
    }
  }

  /** 默认实现：问一次 WMI 拿命令行。**贵**，只在真要停的时候调。 */
  #scanChannelProcesses() {
    const script = this.findScript();
    const needle = script ? path.basename(path.dirname(script)) : 'relay-wechat';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      // 🔴 `-notin` 那一条不是保险，是**必需**：这条查询自己的命令行里就含 `needle`
      //    （`-like '*relay-wechat*'` 这串字面量本身），所以 PowerShell **会匹配到自己**。
      //    本项目"进程残留检测器匹配到自己"这个病犯过一次，这是第二处。
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' -and `
      + `$_.Name -notin @('powershell.exe','pwsh.exe','cmd.exe','conhost.exe') } | `
      // ⚠️ CommandLine **必须一起选**：现在要靠它上面的 `--wxchannel-owner=<pid>`
      //    判"这一代是我拉的吗"（见 OWNER_ENV 的长注释）。少选它 = 归属判不出来 =
      //    退化成"所有 relay-wechat 进程都算外面的"，那就又回到误杀那条老路。
      // ⚠️ ParentName 也是必需的：事故当时那一代中继是**旧代码**拉的、命令行上没有归属标记，
      //    只认标记救不了它；它的父进程是**另一个还活着的 QQ Agent.exe**，
      //    这才是当下就能用的归属判据（见 stop() 里 foreign 的两条判法）。
      + `ForEach-Object { $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" `
      + `-ErrorAction SilentlyContinue; [pscustomobject]@{ ProcessId=$_.ProcessId; ParentProcessId=$_.ParentProcessId; `
      + `Name=$_.Name; CommandLine=$_.CommandLine; ParentName=$pp.Name } } | ConvertTo-Json -Compress`
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const txt = String(out || '').trim();
    if (!txt) return [];
    const arr = JSON.parse(txt);
    return Array.isArray(arr) ? arr : [arr];
  }

  /** 结束一个进程**连同它的子进程**。只杀头会留下占端口的孤儿。 */
  #killTree(pid) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' });
      return true;
    } catch (e) {
      // taskkill 有时在"进程已经没了"时也返回非 0；不把它当成失败理由，交给调用方核对
      this.#push(`taskkill ${pid} 返回非 0（可能已经退出）：${String(e?.message ?? e).slice(0, 80)}`);
      return false;
    }
  }

  /**
   * 停掉中继。
   * @param {{force?:boolean}} [o] force=true 时**连外面窗口跑的那个也停**
   *   （先关本模块拉起的；没有则找外面的）。默认 false = 只关自己拉起的那个。
   *
   * ⚠️ 语义刻意写清楚：默认保守（不碰别人的窗口），用户点「停止通道」时 UI 传 force=true
   *    —— 因为那个按钮**写的就是停止通道**，点了却不动才是不对。
   */
  stop({ force = false } = {}) {
    // 🔴 这两行是自动重启的刹车（2026-10-23 加 restartOnExit 时必须配套）：
    //    stopping=true 让已在排队的那次重启放弃；清掉定时器让还没到点的那次根本不发生。
    //    少这两行，「停止通道」按下去两秒后中继自己又爬起来，用户看到的是这个按钮不管用。
    this.stopping = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null }
    this.restartCount = 0;
    const proc = this.proc;
    if (proc) {
      try {
        const pid = proc.pid;
        proc.kill();
        this.#push(`已请求停止中继（本应用拉起的 pid=${pid}）`);
        this.proc = null;
        return { ok: true, stopped: true, killed: [pid], ours: true };
      } catch (e) {
        this.#push(`停止中继失败：${e?.message ?? e}`);
        return { ok: false, error: String(e?.message ?? e) };
      }
    }
    const found = this.findChannelProcesses();
    // 🔴 2026-10-23 第五十六对话：**别的应用实例拉起来的中继，一律不碰**（线上事故的根治）。
    //    事故长这样：回归测试的 bootApp 在进程内 createApp()，teardown 调 app.stop()
    //    ⇒ stop({force:true}) ⇒ 按命令行扫 relay-wechat ⇒ **扫到线上那个真中继**
    //    ⇒ taskkill /T /F。跑一次带 bootApp 的判据，生产中继当场消失；
    //    跑纯磁盘判据则纹丝不动（A/B 对照过）。每次全量回归都在偷偷杀线上通道，
    //    然后自动重启 3 次用满就永久停手 —— 日志里只剩「code=1、无 signal」。
    //    判据有两条（**任一条命中就算别人的**，两条互补）：
    //      ① 命令行上的归属标记指向**另一个还活着的进程**（标记只对新拉起的代有效）；
    //      ② 父进程是**另一个还在跑的 QQ Agent.exe / electron**（事故当时那一代是旧代码
    //         拉起的、没有标记，靠这条才救得回来 —— 见 isAppHostName 的注释）。
    //    ⇒ 命中任一条就不是我拉的那一代，跟我没关系，⛔ 不杀（连 force 也不杀）。
    const foreign = found.filter((x) => (x.ownerPid > 0 && x.ownerPid !== process.pid && isAliveSync(x.ownerPid))
      || (x.ownerPid === 0 && isAppHostName(x.parentName) && x.parentPid > 0
        && x.parentPid !== process.pid && isAliveSync(x.parentPid)));
    const external = found.filter((x) => !foreign.includes(x));
    if (!external.length) {
      if (foreign.length) {
        const who = foreign.map((x) => `pid ${x.pid}（宿主 pid ${x.ownerPid}）`).join('、');
        this.#push(`停止时跳过了 ${who}：那是**另一个还在运行的应用实例**拉起的中继，不归我管`);
        return {
          ok: true, stopped: false, foreign,
          note: `找到的中继 ${who} 不是本进程拉起的，是另一个还在运行的应用实例在管 ⇒ 没有动它。`
            + '要停它，请在那个实例的「微信通道」页签上点「停止通道」。'
        };
      }
      return { ok: true, stopped: false, note: `没找到正在跑的中继进程（${this.relayPort} 可能是别的程序占着，或者已经停了）` };
    }
    if (!force) {
      return {
        ok: true, stopped: false, external,
        note: `中继不是本应用拉起的（pid ${external.map((x) => x.pid).join(',')}，外面窗口里跑的)。`
          + '要停就再点一次「停止通道」。'
      };
    }
    const killed = [];
    for (const x of external) if (this.#killTree(x.pid)) killed.push(x.pid);
    this.#push(`已结束外面窗口跑的中继：pid ${external.map((x) => x.pid).join(', ')}`);
    return {
      ok: true, stopped: true, killed, ours: false, external,
      note: `中继原本是在外面的窗口里跑的（pid ${external.map((x) => x.pid).join(',')}），已连同子进程一起结束。`
        + '（那个窗口本身不会自己关，会停在报错/退出的画面上，属正常。）'
    };
  }

  /** 最近的日志（给页签那个日志框）。 */
  tail(limit = 120) {
    return this.logs.slice(-Math.max(1, Math.min(LOG_LIMIT, limit)));
  }

  /** 中继在不在跑（只看端口，不看其它）。 */
  async relayRunning() {
    return await this.isPortOpen('127.0.0.1', this.relayPort).catch(() => false);
  }

  /** 微信 hook 端口在不在听（= version.dll 注入成功的最直接证据）。 */
  async hookRunning() {
    return await this.isPortOpen('127.0.0.1', this.hookPort).catch(() => false);
  }
}
