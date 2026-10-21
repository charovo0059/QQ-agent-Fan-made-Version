// JM 本子**下载**（2026-10-21 第五十一对话 · 交接 §3-174 需求①）
//
// 为什么要单独一个模块，而不是塞进 `jm-bridge.js`：
//   `jm-bridge.js` 只管"**一条请求一条响应**"的短查询（search / detail / nh），
//   它的 `jmRequest()` 是**串行化**的（同一时刻只有一个在飞）、单请求 30 秒超时、
//   超时直接 killChild。而下载一本几十页的本子要**几分钟** —— 塞进那条队列会把
//   search / detail 全部堵死，宿主看起来就是"JM 整个卡住"。
//   ⇒ Python 侧做成**异步任务**（`download_start` 立刻返回 job id，工作线程后台跑），
//     本模块负责"发起 + 轮询 + 打包 + 清理"这一层编排。
//
// ⚠️ 任务状态**只活在内存里**（本模块的 map + Python 进程里的 dict），不落盘。
//   理由：宿主的 `jm-bridge.js` 本来就有空闲回收（10 分钟）与超时强杀，落盘恢复
//   要多出一整套状态机；而我们真正需要的是"下完就把 zip 发出去"，**重下比恢复便宜**。
//   代价：进程重启后 `jm_download_status` 会明确说"没有这个任务"，不会假装还在跑。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { getConfig, DATA_DIR } from './config.js'
import { jmRequest, jmPaths } from './jm-bridge.js'
import { createZip } from './zip.js'

/** 下载落盘的根目录：`<数据目录>/downloads/jm/`。 */
export function jmDownloadRoot() {
  return path.join(DATA_DIR, 'downloads', 'jm')
}

/** 打好包的 zip 放这里（发完就删）。 */
export function jmZipRoot() {
  return path.join(DATA_DIR, 'downloads', 'out')
}

const IMG_SUFFIX = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'])

/** 读 `config.jmDownload`（每次现算，用户改完不用重启）。 */
export function jmDownloadConf() {
  const c = (getConfig() && getConfig().jmDownload) || {}
  const n = (v, d, min, max) => {
    const x = Number(v)
    if (!Number.isFinite(x)) return d
    return Math.min(max, Math.max(min, x))
  }
  return {
    enabled: c.enabled === true,
    maxImages: n(c.maxImages, 300, 1, 2000),
    maxZipMb: n(c.maxZipMb, 64, 1, 500),
    imageThreads: n(c.imageThreads, 8, 1, 16),
    allowInGroup: c.allowInGroup === true,
    keepImages: c.keepImages === true,
    // 单次工具调用最多等多久（秒）。工具层硬上限是 120 秒，这里留 10 秒余量。
    maxWaitSeconds: n(c.maxWaitSeconds, 90, 5, 110),
    // 单次运行最多发几个文件（0 = 不限）
    sendMaxPerRun: n(c.sendMaxPerRun, 0, 0, 100),
    // 图片质量：normal(q80) / high(q95) / lossless(无损 WebP)。
    // ⚠️ 非法值收敛成 normal 而不是报错 —— 这个值来自前端下拉框，
    //    但它也会被手改 config.json 的人写坏，写坏了不该让整个下载功能罢工。
    imageQuality: ['normal', 'high', 'lossless'].includes(String(c.imageQuality || '').trim().toLowerCase())
      ? String(c.imageQuality).trim().toLowerCase()
      : 'normal'
  }
}

// ── 任务表（内存）────────────────────────────────────────────────────────
/** job id -> { jobId, albumId, baseDir, startedAt, title, zipPath, ... } */
const jobs = new Map()

/**
 * 与 Python 子进程通信的那一步。默认就是 `jmRequest`（`jm-bridge.js` 的串行请求）。
 *
 * 🔴 为什么留这个缝：本模块的每一条判据（起任务 / 轮询 / 超时如实返回 / 打 zip /
 *   发完清理）都建立在"`jmRequest` 会回什么"之上，而真跑它要 **Python + jmcomic + 外网**。
 *   没有这个缝，这一整层就只能靠"上线后看看"，而它恰恰是最容易静默错的地方
 *   （比如把 running 当成 done ⇒ 打一个空 zip；或者超时后把任务当成失败 ⇒ 重复下载）。
 *   做法与 `sender.js` 的 `__setOutboundImageStagerForTest` 一致：传非函数 = 还原真实现。
 */
let jmRequestImpl = jmRequest
export function __setJmRequestForTest(fn) {
  jmRequestImpl = typeof fn === 'function' ? fn : jmRequest
}

/** 只给判据用：清掉内存任务表（测试之间互不串味）。 */
export function __resetJobsForTest() {
  jobs.clear()
}

/** 把 Windows 非法字符与路径分隔符换掉；空串回落一个固定名。 */
export function safeName(raw, fallback = 'jm') {
  const s = String(raw ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')   // Windows 非法字符 + 控制字符
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')                        // 开头点会让资源管理器困惑
    .replace(/[.\s]+$/, '')
    .trim()
  if (!s) return fallback
  // 4096 的路径上限里文件名别占太多；中文一个字按 1 算，80 已经够表达标题了
  return s.length > 80 ? s.slice(0, 80).trim() : s
}

function stamp() {
  const d = new Date()
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 只读：把磁盘上已下到的图片列出来（按文件名排序，保证页序稳定）。 */
export function listImages(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && IMG_SUFFIX.has(path.extname(e.name).toLowerCase()))
      .map((e) => e.name)
  } catch { return [] }
  // 文件名是 00001.webp 这种定宽编号 ⇒ 字典序 = 页序（不要用 localeCompare，它会按语言规则排）
  names.sort()
  return names.map((n) => path.join(dir, n))
}

/**
 * 发起一次下载。**立刻返回**（不等待），真正的等待在 `waitJob()` 里做。
 *
 * @returns {Promise<{jobId, albumId, dir}>}
 */
export async function startDownload({ albumId, maxImages = null, imageThreads = null } = {}) {
  const c = jmDownloadConf()
  const code = String(albumId ?? '').replace(/^jm/i, '').replace(/[^0-9]/g, '')
  if (!code) throw new Error('本子码为空或格式不对（要纯数字，例如 1460209）')
  const baseDir = path.join(jmDownloadRoot(), `${code}-${stamp()}`)
  // ⚠️ 先把目录建出来：Python 侧也会建，但这里建是为了"目录权限/磁盘满"这类问题
  //    在我们自己的错误信息里暴露，而不是埋在子进程的一行 JSON 里。
  try {
    fs.mkdirSync(baseDir, { recursive: true })
  } catch (e) {
    throw new Error(`建不了下载目录 ${baseDir}：${e?.message ?? e}`)
  }
  const res = await jmRequestImpl({
    cmd: 'download_start',
    albumId: code,
    baseDir,
    maxImages: Number(maxImages) || c.maxImages,
    imageThreads: Number(imageThreads) || c.imageThreads,
    // 图片质量（normal/high/lossless）。⚠️ 这是**进程级全局**设置 ——
    // Python 侧是给 Pillow 的 save_image 打补丁，改一次影响之后所有存图。
    // 下载是串行的（jm-bridge 的 queue），所以不会出现两本用不同质量互相踩。
    imageQuality: c.imageQuality
  })
  if (!res || res.ok !== true) {
    throw new Error(`JM 下载没能启动：${res?.error || '未知原因'}`)
  }
  const jobId = String(res.job || '')
  if (!jobId) throw new Error('JM 服务没给 job id（协议不对）')
  jobs.set(jobId, {
    jobId, albumId: code, baseDir, startedAt: Date.now(),
    title: '', zipPath: null, sent: false
  })
  armSweep()
  return { jobId, albumId: code, dir: baseDir }
}

/** 查一次进度（一次 jmRequest，毫秒级）。 */
export async function pollDownload(jobId) {
  const local = jobs.get(jobId)
  const res = await jmRequestImpl({ cmd: 'download_poll', job: String(jobId) })
  if (!res || res.ok !== true) {
    // `gone:true` = 服务进程重启过，任务真没了；这时要把本地登记也清掉，
    // 否则界面/工具会一直显示一个永远查不到进度的任务。
    if (res?.gone && local) jobs.delete(jobId)
    return {
      state: 'lost',
      error: res?.error || '查不到这个任务（JM 服务可能重启过，任务状态不落盘）'
    }
  }
  const j = res.job || {}
  if (local && j.title) local.title = String(j.title)
  return {
    state: String(j.state || 'running'),
    albumId: String(j.albumId || local?.albumId || ''),
    title: String(j.title || ''),
    done: Number(j.done) || 0,
    total: Number(j.total) || 0,
    images: Number(j.images) || 0,
    bytes: Number(j.bytes) || 0,
    dir: String(j.dir || local?.baseDir || ''),
    subdir: String(j.subdir || ''),
    error: String(j.error || ''),
    partial: j.partial === true,
    // 「按页数上限截断了」—— 这不是失败：拿到前 N 页就是这次要的结果。
    // 单独给一个字段，好让工具层把它写进回话里（不然用户会以为整本都下全了）。
    truncated: j.truncated === true || j.overLimit === true,
    elapsed: Number(j.elapsed) || 0,
    maxImages: Number(j.maxImages) || 0
  }
}

/**
 * 睡一会儿（不引 util.js 的 sleep，那个会带上整包 import）。
 *
 * 🔴 这里**故意不 unref**（2026-10-21 第五十一对话，判据当场抓到）：
 *   一开始写成 `t.unref?.()`，结果在"没有别的 handle 在跑"的环境里（判据脚本就是），
 *   Node 认为事件循环空了就直接退出 —— 而 `waitJob()` 正 await 在这个 timer 上，
 *   于是变成一个**永远不 settle 的 top-level await**，进程 exit 13、一行错误都不打。
 *   换到真宿主里，server/ws/心跳一堆 handle 撑着，这个坑不会显形，只会偶发成
 *   "下载查着查着没下文了" —— 属于本项目最贵的"静默失败"那一类。
 *   `waitJob()` 的语义就是"我在等结果"，这期间进程**不该**静默退出；
 *   后台清扫那个 `setInterval`（`armSweep`）才该 unref，那是维护任务，不该吊住宿主。
 */
const nap = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 等任务出结果，最多等 `maxWaitMs`。到了时限还没完就**如实**返回 running ——
 * ⛔ 绝不假装成功、也绝不无限等（工具层 120 秒硬上限会把它砍成一句"超时"）。
 */
export async function waitJob(jobId, { maxWaitMs = 90_000, onProgress = null, pollMs = 1500 } = {}) {
  const deadline = Date.now() + Math.max(1000, Number(maxWaitMs) || 90_000)
  let last = null
  for (;;) {
    last = await pollDownload(jobId)
    onProgress?.(last)
    if (last.state !== 'running') return last
    if (Date.now() >= deadline) return last
    await nap(Math.min(pollMs, Math.max(200, deadline - Date.now())))
  }
}

/**
 * 把一个下载目录打成 zip。返回 `{ zipPath, name, entries, bytes, sourceBytes, imagesDir }`。
 *
 * ⚠️ 超限就**明确拒绝**，不静默截断：`createZip()` 是把所有条目读进内存再拼的
 *   （`src/zip.js` 的 store/deflate 自实现），几百 MB 会直接把返程内存吃掉。
 *
 * 🔴 为什么从 `zipJob()` 里抽出来（2026-10-21 第五十一对话）：`zipJob()` 要从任务表里
 *   取 `baseDir` / `title`，而任务表只有 `startDownload()`（要真 Python 子进程）能填 ⇒
 *   **打 zip 这段逻辑以前一行都测不到**。抽成"只认目录"的函数之后，判据可以直接造一个
 *   假目录喂进来验（超限拒绝 / 挑图最多的那层 / 页序稳定 / zip 真能解开），
 *   而 `zipJob()` 只剩"取登记 + 记 zipPath"这两句。
 */
export function packDirToZip({ baseDir, title = '', albumId = '', maxZipMb = null } = {}) {
  const dir = String(baseDir ?? '').trim()
  if (!dir) throw new Error('没有给下载目录，打不了包')
  const c = jmDownloadConf()
  const capMb = Number(maxZipMb) || c.maxZipMb
  const capBytes = Math.round(capMb * 1024 * 1024)

  // ⚠️ 图片实际落在 `<baseDir>/<专辑标题>/` 里（python 的 dir_rule = 'Bd_Pname'）。
  //    这里再扫一遍而不是依赖 poll 的 subdir：poll 那边可能还没更新到最后一轮，
  //    而 `listImages()` 是直接读盘，永远是最新的。
  const candidates = [dir]
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) candidates.push(path.join(dir, e.name))
    }
  } catch { /* 目录没了就让下面的 listImages 返回空 */ }

  let imgDir = null
  let files = []
  for (const d of candidates) {
    const f = listImages(d)
    if (f.length > files.length) { files = f; imgDir = d }
  }
  if (!files.length) throw new Error('下载目录里一张图片都没有，打不了包')

  let total = 0
  const entries = []
  for (const fp of files) {
    const stat = fs.statSync(fp)
    total += stat.size
    if (total > capBytes) {
      throw new Error(`本子太大（超过 ${capMb} MB，上限见「设置 → 本子下载 → 单个压缩包上限」）：`
        + `已下到第 ${entries.length + 1}/${files.length} 页就超了。可以少下几页，或者把上限调大。`)
    }
    entries.push({ name: path.basename(fp), data: fs.readFileSync(fp) })
  }

  const code = String(albumId || '').replace(/[^0-9]/g, '') || '0'
  const name = safeName(title || 'JM' + code, 'JM' + code)
  const zipName = safeName(`${name} [JM${code}]`, `JM${code}`) + '.zip'
  fs.mkdirSync(jmZipRoot(), { recursive: true })
  // ⚠️ 磁盘上的名字前面加了 `<码>-<时间戳>-` 前缀：同一个本子下两次不会互相覆盖
  //    （用户可能就是想留两份），而**发出去时用的名字**（zipName）不带这个前缀。
  const zipPath = path.join(jmZipRoot(), `${code}-${Date.now()}-${safeName(zipName, 'jm.zip')}`)
  const buf = createZip(entries)
  fs.writeFileSync(zipPath, buf)
  return {
    zipPath, name: zipName, entries: entries.length,
    bytes: buf.length, sourceBytes: total, imagesDir: imgDir
  }
}

/** 把某个任务已下到的图打成 zip，并在任务表里记下 zipPath。 */
export function zipJob(jobId, { maxZipMb = null } = {}) {
  const local = jobs.get(jobId)
  if (!local) throw new Error('没有这个下载任务的登记（进程重启过？）')
  const out = packDirToZip({
    baseDir: local.baseDir, title: local.title, albumId: local.albumId, maxZipMb
  })
  local.zipPath = out.zipPath
  return out
}

/** 发完之后按需清理（`keepImages:true` 就留着给用户自己看）。 */
export function cleanupJob(jobId, { force = false } = {}) {
  const local = jobs.get(jobId)
  if (!local) return { removed: false, reason: '没有这个任务' }
  const keep = !force && jmDownloadConf().keepImages
  if (local.zipPath) { try { fs.rmSync(local.zipPath, { force: true }) } catch { /* 删不掉不是错误 */ } }
  if (!keep) {
    try { fs.rmSync(local.baseDir, { recursive: true, force: true, maxRetries: 2 }) } catch { /* 同上 */ }
  }
  jobs.delete(jobId)
  return { removed: !keep, kept: keep }
}

// ── 自动清扫 ────────────────────────────────────────────────────────────
//
// 为什么必须有：皮肤/本子图一张几十 KB、一本几十页，一天下十本就是一个 G。
// 而这些图**唯一的用途**是"打成 zip 发出去"，发完就该消失。
// ⚠️ 只扫 `downloads/` 下面 —— ⛔ 绝不碰 `DATA_DIR` 的其它东西（那里有记忆、消息存档）。
const SWEEP_KEEP_MS = 6 * 3600 * 1000      // 6 小时前的目录一律清
const SWEEP_MAX_BYTES = 2 * 1024 * 1024 * 1024   // 或者总量超 2GB 就从最老的清
let sweepTimer = null

function dirSize(dir) {
  let n = 0
  const walk = (d) => {
    let entries = []
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) walk(fp)
      else { try { n += fs.statSync(fp).size } catch { /* 读不到就跳过 */ } }
    }
  }
  walk(dir)
  return n
}

/** 清掉过期的下载目录。纯尽力而为，永不抛。 */
export function sweepDownloads({ now = Date.now() } = {}) {
  const out = { removed: 0, bytes: 0, kept: 0 }
  try {
    const root = jmDownloadRoot()
    if (!fs.existsSync(root)) return out
    const items = []
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const fp = path.join(root, e.name)
      let st = null
      try { st = fs.statSync(fp) } catch { continue }
      items.push({ fp, name: e.name, mtime: st.mtimeMs, size: dirSize(fp) })
    }
    items.sort((a, b) => a.mtime - b.mtime)   // 最老的在前
    let total = items.reduce((s, x) => s + x.size, 0)
    // 正在跑的任务的目录不许清
    const busy = new Set([...jobs.values()].filter((j) => !j.zipPath).map((j) => j.baseDir))
    for (const it of items) {
      if (busy.has(it.fp)) { out.kept++; continue }
      const tooOld = now - it.mtime > SWEEP_KEEP_MS
      const tooBig = total > SWEEP_MAX_BYTES
      if (!tooOld && !tooBig) { out.kept++; continue }
      try {
        fs.rmSync(it.fp, { recursive: true, force: true, maxRetries: 2 })
        if (fs.existsSync(it.fp)) { out.kept++; continue }
        total -= it.size
        out.removed++
        out.bytes += it.size
      } catch { out.kept++ }
    }
    // 打出来的 zip 也一起清（它们更该短命：发出去就没用了）
    const zroot = jmZipRoot()
    if (fs.existsSync(zroot)) {
      for (const e of fs.readdirSync(zroot, { withFileTypes: true })) {
        if (!e.isFile()) continue
        const fp = path.join(zroot, e.name)
        let st = null
        try { st = fs.statSync(fp) } catch { continue }
        if (now - st.mtimeMs <= SWEEP_KEEP_MS) continue
        try { fs.rmSync(fp, { force: true }); out.removed++; out.bytes += st.size } catch { /* ignore */ }
      }
    }
  } catch { /* 清扫失败绝不能影响主流程 */ }
  return out
}

/** 第一次用到下载时才装定时器（不在 import 时装，免得脚本退不出去）。 */
function armSweep() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => { try { sweepDownloads() } catch { /* ignore */ } }, 30 * 60 * 1000)
  sweepTimer.unref?.()      // 别挡住宿主退出
}

/** 诊断用：当前有哪些任务、目录在哪。 */
export function jmDownloadState() {
  let paths = null
  try { paths = jmPaths() } catch { paths = null }
  return {
    conf: jmDownloadConf(),
    root: jmDownloadRoot(),
    zipRoot: jmZipRoot(),
    jobs: [...jobs.values()].map((j) => ({
      jobId: j.jobId, albumId: j.albumId,
      elapsed: Math.round((Date.now() - j.startedAt) / 1000),
      zipped: !!j.zipPath, sent: j.sent === true
    })),
    bridge: paths ? { running: paths.running, hint: paths.hint } : null,
    tmpDir: os.tmpdir()
  }
}
