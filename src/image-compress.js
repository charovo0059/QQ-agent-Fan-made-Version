// 图片压缩：把过大的图片缩到模型可接受的尺寸/体积，降低 token 成本与传输开销。
//
// 背景：QQ 图床的原图可能几 MB 甚至十几 MB，直接 base64 给模型既贵又慢，
// 很多视觉模型对超大图还会拒收或报错。这里在下载后、给模型前做一道压缩。
//
// 实现：项目没有图像处理库（无 sharp/jimp），用 ffmpeg（video-reader 已探测）做缩放。
//   - 有 ffmpeg：按最长边缩到 maxDim，并重编码为 JPEG（质量可调）
//   - 无 ffmpeg：原样返回（不压缩，保持旧行为）
// 判断"是否过大"：优先按像素（需 ffprobe/ffmpeg 读尺寸），读不到尺寸时按字节数兜底。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { detectImageType, mimeToExt } from './image-type.js';
import { spawn } from 'node:child_process';
import { ffmpegCandidates, ffprobeCandidates } from './ffmpeg-path.js';

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(null); }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); finish(null); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 ? true : null); });
  });
}

let _ffmpeg = null;
let _ffprobe = null;
let _checked = false;
let _lastProbeAt = 0;
let _probeCount = 0;   // 探测**轮**数（供 ffProbeStats 诊断/回归用）

/**
 * 探测一次 ffmpeg / ffprobe 的位置，结果缓存。
 *
 * ⚠️ 缓存**必须有有效期**（上游 audit-round1 的 L-8）：原来的 `_checked`
 *    是一次性的 —— 本机没装 ffmpeg 时，这里把"找不到"钉死到进程结束，
 *    用户按提示装完 ffmpeg 仍然不生效，只能重启应用，看起来像"装了没用"。
 *    现在的规矩：
 *      · 找到了 → 永久缓存（真的不会变，没必要反复 spawn）；
 *      · 只找到一半 → 1 分钟后重探（补齐另一半）；
 *      · 一个都没找到 → 1 分钟后重探（给刚装完的人机会）。
 *   重探代价：一次 spawn + `-version`，且 60 秒内最多一次，不构成负担。
 *   探到仍失败时**只打一次**日志（`_warnedMissing`），免得刷屏。
 *
 *   有效期可用环境变量 `QQA_FF_PROBE_TTL_MS` 覆盖 —— **只为测试存在**
 *   （回归要验"过期之后会重探"，否则得真等 60 秒）。生产环境不要设它。
 *   ⚠️ 注意判据是"环境变量有没有被设置"，**不是"值 > 0"**：测试要用 `0`
 *      表示"立刻过期"，写成 `Number(v) > 0 ? v : 60000` 会把 0 悄悄还原成
 *      60 秒，于是"过期后重探"这条路**永远测不到**（我第一版就踩了这个，
 *      表现是测试报"1 → 1 没重探"，看起来像实现没修好，其实旋钮没生效）。
 */
/**
 * 当前生效的探测缓存有效期。
 *
 * ⚠️ 必须**每次调用时读**，不能在模块加载时固化成常量：我们的验证套件
 *    （如 `test-群禁言识别.mjs`）习惯在**同一进程**里先 setRuntimeConfig、
 *    再 import 被测模块；若在这里就把 env 读死，届时改 env 将完全无效 ——
 *    那正是"测试看着过了、其实旋钮没接上"的典型。函数调用代价可忽略。
 */
function ffProbeTtlMs() {
  const raw = process.env.QQA_FF_PROBE_TTL_MS;
  if (raw === undefined || raw === '') return 60 * 1000;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : 60 * 1000;
}
let _warnedMissing = false;

/**
 * 探测诊断（**给排障与回归用**，不参与压缩逻辑）。
 *
 * 为什么要导出这个：验证 L-8 的修法只能靠"探测发生了几次"，而模块**内部**
 * 的 spawn 计数从外面观测不到（在子进程里包 `child_process.spawn` 是没用的 ——
 * `import { spawn }` 绑的是内置模块的内部槽，改命名空间属性它看不见）。
 * 与其为了测试去动 `run()` 的实现，不如让模块自己把这件事说出来。
 *
 * @returns {{probes:number, found:boolean, ffmpeg:string|null, ffprobe:string|null, lastProbeAt:number}}
 */
export function ffProbeStats() {
  return {
    probes: _probeCount,
    found: Boolean(_ffmpeg && _ffprobe),
    ffmpeg: _ffmpeg,
    ffprobe: _ffprobe,
    lastProbeAt: _lastProbeAt,
  };
}

async function ensureFf() {
  const now = Date.now();
  if (_checked && _ffmpeg && _ffprobe) return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
  if (_checked && (now - _lastProbeAt) < ffProbeTtlMs()) return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
  _checked = true;
  _lastProbeAt = now;
  _probeCount += 1;   // 记"轮"数，不记候选个数（候选列表长度会变）
  // 重探前先清空，避免"上次半成功"的残留被当成这次的结果
  _ffmpeg = null;
  _ffprobe = null;
  for (const name of ffmpegCandidates()) {
    if (await run(name, ['-version'], 5000)) { _ffmpeg = name; break; }
  }
  for (const name of ffprobeCandidates()) {
    if (await run(name, ['-version'], 5000)) { _ffprobe = name; break; }
  }
  if (!_ffmpeg && !_warnedMissing) {
    _warnedMissing = true;
    console.warn('[image-compress] 没找到 ffmpeg —— 过大的图片只能按字节数粗判，装好后 1 分钟内会自动重试');
  }
  return { ffmpeg: _ffmpeg, ffprobe: _ffprobe };
}

/** 用 ffprobe 读图片尺寸。 */
async function imageSize(ffprobe, filePath) {
  const out = await new Promise((resolve) => {
    let txt = '';
    let child;
    try {
      child = spawn(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_streams', filePath], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(null); }, 10000);
    child.stdout.on('data', (d) => { txt += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(txt);
        const s = (j.streams || []).find((x) => x.codec_type === 'video' || x.width);
        resolve(s && s.width ? { width: Number(s.width), height: Number(s.height) } : null);
      } catch {
        resolve(null);
      }
    });
  });
  return out;
}

/**
 * 压缩一张图片（如需要）。
 * @param {Buffer} buffer 原始图片字节
 * @param {object} [opts]
 * @param {number} [opts.maxDim=1568] 最长边上限（像素），超过则等比缩小
 * @param {number} [opts.maxBytes=4*1024*1024] 字节上限，超过则尝试压缩
 * @param {number} [opts.quality=4] JPEG 质量（ffmpeg -q:v，2 最好 31 最差，4 是不错的平衡）
 * @returns {Promise<{buffer: Buffer, mime: string, compressed: boolean}>}
 */
export async function compressImage(buffer, { maxDim = 1568, maxBytes = 4 * 1024 * 1024, quality = 4 } = {}) {
  const mime = detectMime(buffer) || 'image/jpeg';
  // 小图直接过（字节数就很小，没必要压缩）
  if (buffer.length <= Math.min(maxBytes, 512 * 1024)) {
    return { buffer, mime, compressed: false };
  }
  const { ffmpeg, ffprobe } = await ensureFf();
  if (!ffmpeg) {
    // 无 ffmpeg：无法压缩，原样返回（保持旧行为）
    return { buffer, mime, compressed: false };
  }
  // 写到临时文件 → ffmpeg 缩放 → 读回
  const tmpIn = path.join(os.tmpdir(), `qqa_img_in_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}${extOf(mime)}`);
  const tmpOut = path.join(os.tmpdir(), `qqa_img_out_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    // 判断是否超过最长边（有 ffprobe 才读得到；读不到就按字节数决定压不压）
    let needResize = buffer.length > maxBytes;
    if (ffprobe) {
      const size = await imageSize(ffprobe, tmpIn);
      if (size && (size.width > maxDim || size.height > maxDim)) needResize = true;
    }
    if (!needResize) return { buffer, mime, compressed: false };
    // ffmpeg：等比缩放到最长边 maxDim，重编码 JPEG
    const okRun = await run(ffmpeg, [
      '-y', '-i', tmpIn,
      '-vf', `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', String(quality),
      tmpOut
    ], 25000);
    if (okRun && fs.existsSync(tmpOut)) {
      const compressed = fs.readFileSync(tmpOut);
      // 只有真的变小了才用压缩结果（否则保留原图）
      if (compressed.length && compressed.length < buffer.length) {
        return { buffer: compressed, mime: 'image/jpeg', compressed: true };
      }
    }
    return { buffer, mime, compressed: false };
  } catch {
    return { buffer, mime, compressed: false };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

// 类型嗅探与 MIME→扩展名统一放在 image-type.js（曾经这里/tools.js/sticker-manager.js
// 各有一份实现，容易各自演化出不一致的行为）。
function detectMime(buf) {
  return detectImageType(buf)?.mime ?? null;
}

function extOf(mime) {
  return mimeToExt(mime);
}
