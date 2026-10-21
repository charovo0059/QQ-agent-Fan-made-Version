// 本子下载（JM）—— LLM 型 Skill：给模型两个工具，下载与查进度。
//
// ⚠️ 这里**只做编排**，真正干活的两层都在 src/ 里：
//   · `src/jm-download.js` —— 任务表、轮询、打 zip、清理、目录白名单
//   · `JM工具/jm_server.py` —— 异步下载（download_start / download_poll），
//     由 `src/jm-bridge.js` 那个常驻 Python 子进程承载
//   这么切的原因见 plugin-loader 的入口扫描规则：入口里写文件/起子进程会被拦，
//   而"下载"天然要写盘 ⇒ 把 IO 放进 src/，入口保持纯编排（permissions 才可以是空的）。
//
// 为什么下载**不能**在一次工具调用里同步做完（这是本文件所有设计的前提）：
//   `src/tools.js` 的 `TOOL_TIMEOUT_MS = 120_000` —— 单工具 120 秒硬上限，
//   而一本几十页的本子常常要几分钟。⇒ 必须"发起 → 立刻返回 → 再查"。
//   超时不是失败：拿到 job 码之后用 download_status 接着查。
import { getConfig } from '../../src/config.js'
import {
  jmDownloadConf, startDownload, waitJob, zipJob, cleanupJob,
  pollDownload, jmDownloadRoot, jmZipRoot
} from '../../src/jm-download.js'

let log = () => {}
function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) }
}
function err(message) {
  return { content: `错误：${message}`, isError: true }
}

/**
 * 「只下了前 N 页」的补充说明。
 *
 * 🔴 为什么要单独说一句（2026-10-21 第五十一对话，实测抓到）：页数上限现在是
 * **事前截断**（下到第 N 页就停，不再全下完才报错）。截断本身是**正常结果** ——
 * 用户设 30 页就是想要 30 页。但如果不吭声，模型会当成"整本都在这了"，
 * 于是回话里说"全本已发"，而实际上后面几十页没下 —— 那是骗人。
 */
function truncNote(snap, zip) {
  if (snap?.truncated !== true) return ''
  const cap = Number(snap.maxImages) || 0
  const total = Number(snap.total) || 0
  const tail = total > zip.entries ? `（这本一共 ${total} 页）` : ''
  return `\n⚠️ 只下了前 ${zip.entries} 页${tail} —— 到了「单个本子页数上限」${cap ? `（${cap} 页）` : ''}。`
    + '要全本就在设置里把这个上限调大，然后重新下一次。'
}

/** 真正的开关：`config.jmDownload.enabled`（默认关）。 */
export function available(context = {}) {
  let cfg
  try {
    cfg = context?.config?.jmDownload ?? getConfig()?.jmDownload ?? {}
  } catch {
    cfg = {}
  }
  if (cfg.enabled !== true) {
    return { ok: false, reason: '本子下载开关没打开（config.jmDownload.enabled 不是 true，默认关）。' }
  }
  return { ok: true }
}

export function register(api) {
  log = (...a) => api.log?.(...a)

  // ── 工具 1：下载 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'download',
    name: '下载本子',
    category: 'media',
    icon: '📥',
    description: '把一本 JM 本子整本下载到本地，**打成 zip 之后自动发出去**。'
      + '需要本子的数字码（就是搜索/详情结果里的那个号，例如 1460209，前面带不带 JM 都行）。'
      + '⚠️ 一本常常要几分钟，而单次工具调用最多等 90 秒 ⇒ 大概率会先返回一个**任务号**，'
      + '那时你要用 download_status 接着查（把任务号传进去），不要重新发起下载。'
      + '⚠️ 默认只在私聊可用。',
    parameters: {
      type: 'object',
      properties: {
        albumId: { type: 'string', description: '本子数字码，例如 "1460209"（带 JM 前缀也行）' },
        maxImages: { type: 'number', description: '可选：本次最多下多少页（默认跟设置里的一致）' },
        autoSend: { type: 'boolean', description: '可选：下完是否自动发 zip 给对方（默认 true；false 则只落盘并把路径回给你）' }
      },
      required: ['albumId']
    },
    async execute(ctx, args) {
      const cfg = jmDownloadConf()
      if (cfg.allowInGroup === false && ctx.kind === 'group') {
        return err('本子下载只在私聊里可用（设置里关掉了群聊）。')
      }
      const albumId = String(args.albumId ?? '').trim()
      if (!albumId) return err('要下哪一本？`albumId` 是那个数字码，例如 1460209。')
      const autoSend = args.autoSend !== false

      let job
      try {
        job = await startDownload({
          albumId,
          maxImages: args.maxImages ? Number(args.maxImages) : null,
          imageThreads: cfg.imageThreads
        })
      } catch (error) {
        return err(error?.message ?? error)
      }
      log(`[jm-download] 起任务 ${job.jobId} album=${job.albumId} dir=${job.dir}`)

      // 等一小会儿 —— 常见的短本子（十几页）在这段时间里就能下完，
      // 那样用户拿到的就是"已经发好了"而不是"给你个码自己查"。
      const budget = Math.max(5000, Math.min(110_000, cfg.maxWaitSeconds * 1000))
      const snap = await waitJob(job.jobId, { maxWaitMs: budget })

      if (snap.state === 'running') {
        // 还在下：如实回任务号。⛔ 不假装成功。
        return ok({
          state: 'running',
          jobId: job.jobId,
          albumId: job.albumId,
          done: snap.done,
          total: snap.total,
          dir: snap.dir || job.dir,
          hint: `还在下载（已下 ${snap.done}/${snap.total || '?'} 页，等了 ${cfg.maxWaitSeconds} 秒）。`
            + `**不要重新发起**，用 download_status 传 jobId="${job.jobId}" 接着查。`
        })
      }
      if (snap.state === 'failed' || snap.state === 'lost') {
        return err(snap.error || '下载失败了（原因没给出来，看日志 data/logs 里的 jm 相关行）。')
      }
      if (snap.state === 'cancelled') {
        return err('这次下载被取消了。')
      }

      // ── 下完了：打包 ──
      let zip
      try {
        zip = zipJob(job.jobId)
      } catch (error) {
        return err(error?.message ?? error)
      }
      log(`[jm-download] 打包完成 ${zip.zipPath} ${zip.entries} 页 ${zip.bytes} 字节`)

      if (!autoSend) {
        return ok({
          state: 'done',
          jobId: job.jobId,
          albumId: job.albumId,
          title: snap.title || '',
          images: snap.images,
          pages: zip.entries,
          zip: zip.zipPath,
          sizeMb: Math.round(zip.bytes / 1024 / 1024 * 10) / 10,
          truncated: snap.truncated === true,
          note: `下好了，没发（autoSend=false）。要发就用 send_file 传 path="${zip.zipPath}"。`
            + truncNote(snap, zip)
        })
      }

      // ── 发出去 ──
      // ⚠️ 走 `ctx.sender.sendFile`（与 send_file 工具同一条路），不用 send_image：
      //    一本本子几十页，一张张发是刷屏；zip 是群里最合适的形态。
      let sent
      try {
        sent = await ctx.sender.sendFile(ctx.chatKey, zip.zipPath, { name: zip.name, note: '本子' })
        ctx.session.sent.push({ type: 'file', text: `[文件:${zip.name}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
        ctx.emit?.('session-update', ctx.session.id)
      } catch (error) {
        // 发失败**不能**把已经下好的东西删掉 —— 让用户/模型能重试发送。
        return err(`下好了（${zip.entries} 页）但发送失败：${error?.message ?? error}\n`
          + `zip 还在：${zip.zipPath} —— 可以稍后用 send_file 重发。`)
      }

      // 发成功之后按配置清理（keepImages 默认 false ⇒ 图与 zip 一起删）
      const cl = cleanupJob(job.jobId)
      return ok({
        state: 'done',
        jobId: job.jobId,
        albumId: job.albumId,
        title: snap.title || '',
        pages: zip.entries,
        sizeMb: Math.round(zip.bytes / 1024 / 1024 * 10) / 10,
        sent: true,
        messageId: sent?.message_id ?? null,
        kept: cl.kept === true,
        truncated: snap.truncated === true,
        note: `下好了，共 ${zip.entries} 页，已打包成 ${zip.name} 发出去了。`
          + truncNote(snap, zip)
          + (cl.kept ? '（图片按设置留着，6 小时后自动清理）' : '')
      })
    }
  })

  // ── 工具 2：查进度 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'download_status',
    name: '查下载进度',
    category: 'media',
    icon: '⏳',
    description: '查一个已经在跑的下载任务。下载工具返回 `state:"running"` 时会给你 jobId，'
      + '把它原样传进来即可。下完（state=done）时**这个工具也会自动打包并发出去**，'
      + '所以你只要查到 done 就等于发好了，不用再调别的。'
      + '⚠️ 任务状态只在内存里：宿主重启过就查不到了，那种情况只能重新下。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '下载工具返回的那个任务号（形如 "1792575141833-1"）' },
        autoSend: { type: 'boolean', description: '可选：下完是否自动发（默认 true）' }
      },
      required: ['jobId']
    },
    async execute(ctx, args) {
      const cfg = jmDownloadConf()
      if (cfg.allowInGroup === false && ctx.kind === 'group') {
        return err('本子下载只在私聊里可用（设置里关掉了群聊）。')
      }
      const jobId = String(args.jobId ?? '').trim()
      if (!jobId) return err('要查哪个任务？`jobId` 不能为空。')
      const autoSend = args.autoSend !== false

      let snap
      try {
        snap = await pollDownload(jobId)
      } catch (error) {
        return err(error?.message ?? error)
      }
      if (snap.state === 'lost') return err(snap.error || '查不到这个任务了（宿主可能重启过）。')

      if (snap.state === 'running') {
        const pct = snap.total > 0 ? Math.round(snap.done / snap.total * 100) : null
        return ok({
          state: 'running',
          jobId,
          done: snap.done,
          total: snap.total,
          percent: pct,
          seconds: snap.elapsed,
          hint: `还在下（${snap.done}/${snap.total || '?'} 页${pct == null ? '' : `，${pct}%`}，已跑 ${snap.elapsed} 秒）。过一会儿再查一次。`
        })
      }
      if (snap.state === 'failed') return err(snap.error || '下载失败了。')
      if (snap.state === 'cancelled') return err('这个任务被取消了。')

      // done —— 打包（可能已经打过了，zipJob 是幂等的：每次都重扫盘重打，
      // 但同一个 job 重复调用只会覆盖同一个 zipPath 里的内容，不会堆垃圾）
      let zip
      try {
        zip = zipJob(jobId)
      } catch (error) {
        return err(error?.message ?? error)
      }
      if (!autoSend) {
        return ok({
          state: 'done', jobId, title: snap.title || '', pages: zip.entries,
          zip: zip.zipPath, truncated: snap.truncated === true,
          note: `下好了，没发。要发就 send_file 传 path="${zip.zipPath}"。` + truncNote(snap, zip)
        })
      }
      let sent
      try {
        sent = await ctx.sender.sendFile(ctx.chatKey, zip.zipPath, { name: zip.name, note: '本子' })
        ctx.session.sent.push({ type: 'file', text: `[文件:${zip.name}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) })
        ctx.emit?.('session-update', ctx.session.id)
      } catch (error) {
        return err(`下好了但发送失败：${error?.message ?? error}\nzip 还在：${zip.zipPath}`)
      }
      const cl = cleanupJob(jobId)
      return ok({
        state: 'done', jobId, title: snap.title || '', pages: zip.entries,
        sizeMb: Math.round(zip.bytes / 1024 / 1024 * 10) / 10,
        sent: true, messageId: sent?.message_id ?? null, kept: cl.kept === true,
        truncated: snap.truncated === true,
        note: `下好了，共 ${zip.entries} 页，已打包成 ${zip.name} 发出去了。` + truncNote(snap, zip)
      })
    }
  })
}

/** 提示词片段：开关关着时一个字都不注入（与 doujin-lookup 同一取向）。 */
export function promptSections() {
  let cfg
  try {
    cfg = getConfig()?.jmDownload || {}
  } catch {
    cfg = {}
  }
  if (cfg.enabled !== true) return []
  const lines = [
    '你能把整本 JM 本子下下来发给对方（工具 jm-download__download，参数是数字码）。',
    '用法：先在搜索结果里拿到码 → 调 download → 如果它回 state:"running"，**不要重新发起**，',
    '拿它给的 jobId 调 jm-download__download_status 接着查；查到 done 就说明已经打包发好了。',
    '发出去的是 zip（一本几十页，别一张张发图刷屏）。',
    `落盘位置：${jmDownloadRoot()}（打包好的在 ${jmZipRoot()}）。`
  ]
  if (cfg.allowInGroup !== true) lines.push('这个功能只在私聊里可用，群里别试。')
  return [{ id: 'jm-download-hint', title: '本子下载', priority: 42, content: lines.join('\n') }]
}
