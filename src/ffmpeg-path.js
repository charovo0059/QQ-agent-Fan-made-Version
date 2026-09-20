// 外部 ffmpeg 的**候选路径**（共享探测清单）。
//
// 为什么单独抽一个模块：有两个以上模块要用 ffmpeg（上游那边 `gif-to-video` /
// `image-compress` / `video-reader` 各有一份探测），而**本机 PATH 上没有 ffmpeg** ——
// 只探 PATH 的实现会全部退化成"功能不可用"。所以这里把"可能在哪"集中一处，
// 各模块仍保留**自己的探测缓存与超时**（上游特意说明不共享那些，见下面 ⚠️）。
//
// ⚠️ 刻意**只提供候选路径，不做探测、不做缓存**。
//    上游的注释写得很清楚：各处传参方式不同（有的要 stdout、有的只看退出码），
//    共享探测结果会让"改一处超时、另一处悄悄跟着变"发生。⇒ 重复一点探测样板，
//    换来互相独立 —— 这里照同一个取舍办。
//
// ⚠️ 候选里**含第三方安装位置**（WeFlow 自带的 ffmpeg-static）：
//    它是"别人装的"应用，升级/卸载后路径会消失 ⇒ 所以它只是**候选之一**，
//    找不到就继续往下试，最终找不到时各模块**优雅降级**（返回 null / 回退按图片发），
//    不会抛错、也不会让主流程失败。
//
// 想手动指定：设环境变量 `QQ_AGENT_FFMPEG` 指向 exe 即可（优先级最高）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))       // <app>/src
const APP = path.resolve(HERE, '..')                            // <app>（= …/QQ Agent/resources/app）

/**
 * 从 <app> 逐级向上取祖先目录。
 *
 * ⚠️ 为什么不用 `path.resolve(APP, '..', '..')` 写死层数：**会算错**。
 *    `<app>` = `…\dsh qq\QQ Agent\resources\app`，往上是 `resources` → `QQ Agent` →
 *    `dsh qq` —— 要 **3** 层才到工作区，而开发机装的正式版还会把深度改掉
 *    （安装目录布局不同）。我第一版写死 2 层，结果候选里少了一层、`weflow` 那条直接找不到。
 *    ⇒ 逐级向上试，深度不写死。
 */
function ancestors(n = 5) {
  const out = []
  let p = APP
  for (let i = 0; i < n; i++) { p = path.resolve(p, '..'); out.push(p) }
  return out
}

/** 候选 ffmpeg 路径（按优先级；含裸命令名，交给 PATH 解析）。每次现算，不缓存路径本身。 */
export function ffmpegCandidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const out = [
    String(process.env.QQ_AGENT_FFMPEG || '').trim(),          // ① 显式指定
    'ffmpeg', 'ffmpeg.exe',                                    // ② PATH（上游原本只探这两个）
    path.join(APP, 'vendor', exe),                             // ③ 随应用放的
    path.join(APP, 'node_modules', 'ffmpeg-static', exe)       // ④ 若装了 ffmpeg-static
  ]
  // ⑤ 逐级向上的祖先里找：<祖先>/vendor/ffmpeg.exe 与
  //    <祖先>/weflow/resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe
  //    （开发机那个 WeFlow 自带一份可用的 ffmpeg；第三方应用，路径会随它升级/卸载消失 —— 只是候选）
  for (const a of ancestors()) {
    out.push(path.join(a, 'vendor', exe))
    out.push(path.join(a, 'weflow', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exe))
  }
  // ⑥ 常见安装位置
  out.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WeFlow', 'resources', 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', exe))
  // 去空、去重，保持顺序
  return [...new Set(out.filter(Boolean))]
}

/**
 * 候选 **ffprobe** 路径。
 *
 * ⚠️ 实测：`ffmpeg-static` 这个包**只带 ffmpeg，不带 ffprobe**（本机那份目录里
 *    只有 `ffmpeg.exe` 与它的 LICENSE/README，没有 `ffprobe.exe`）。
 *    ⇒ ffprobe 的候选**比 ffmpeg 少**：只能靠 PATH、显式指定、或与 ffmpeg 同目录时顺带找。
 *    ⇒ 依赖 ffprobe 的功能（探测视频时长/分辨率）在本机**会不可用** ——
 *      这是**如实的能力缺口，不是 bug**：那些模块找不到 ffprobe 时走降级路径。
 *    想补上：装一个带 ffprobe 的发行版，或设 `QQ_AGENT_FFPROBE` 指定。
 */
export function ffprobeCandidates() {
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'
  const out = [
    String(process.env.QQ_AGENT_FFPROBE || '').trim(),
    'ffprobe', 'ffprobe.exe',
    path.join(APP, 'vendor', exe),
    path.join(APP, 'node_modules', 'ffprobe-static', exe)
  ]
  // 与 ffmpeg 同目录时顺带找一下（有些发行版把两个 exe 放一起）
  for (const c of ffmpegCandidates()) {
    if (!/[\\/]/.test(c)) continue
    out.push(path.join(path.dirname(c), exe))
  }
  for (const a of ancestors()) out.push(path.join(a, 'vendor', exe))
  out.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'WeFlow', 'resources', 'app.asar.unpacked', 'node_modules', 'ffprobe-static', exe))
  return [...new Set(out.filter(Boolean))]
}

/**
 * 候选里**第一个真实存在**的路径；都不存在返回 ''。
 * ⚠️ 只做"存在性"判断，**不执行** —— 能不能跑由各模块自己的探测决定
 *    （有的要看 `-version` 输出，有的只看退出码）。
 */
export function firstExistingFfmpeg() {
  for (const c of ffmpegCandidates()) {
    // 裸命令名交给 PATH，这里判不了
    if (!/[\\/]/.test(c)) continue
    try { if (fs.existsSync(c)) return c } catch { /* 下一个 */ }
  }
  return ''
}

/** 同 `firstExistingFfmpeg`，但找 ffprobe。 */
export function firstExistingFfprobe() {
  for (const c of ffprobeCandidates()) {
    if (!/[\\/]/.test(c)) continue
    try { if (fs.existsSync(c)) return c } catch { /* 下一个 */ }
  }
  return ''
}
