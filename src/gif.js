// GIF 字节级手术：只保留第一帧 / 数帧数。**不做 LZW 解码**，纯结构解析。
//
// 为什么需要它（2026-09-12 实测）：QQ 的"动画表情"就是 GIF，而且是原图尺寸的多帧动画。
// 用户转发 50 条表情包，30 张图合计 **79MB**，base64 之后 106MB，
// 塞进模型请求直接撞网关的 413（api.deepseek.com 的 openresty 上限在 32~48MB 之间）。
//
// 但同一个 GIF 只留第一帧就只剩 15~50KB —— 实测 30 张合计 79.3MB → 1.25MB，省 98.4%。
// 而"只取第一帧"本来就是 Chromium 解码动画 GIF 时给出的东西（canvas.drawImage 也只画第一帧），
// 所以这不是偷工减料，是这类图能拿到的极限。
//
// ⚠️ 已知代价：少数动画的第一帧几乎空白（角色还没滑进画面）。
// 实测 30 张里有 1 张属于这种。所以拿到图后如果看不出内容，别硬认，照实说。
//
// GIF 结构（本文件只走这一条路，遇到不认识的块就放弃，绝不猜）：
//   "GIF87a"/"GIF89a"(6)
//   Logical Screen Descriptor(7)：宽2 高2 packed1 背景色1 像素比1
//     若 packed & 0x80：全局颜色表，长度 3 * 2^((packed & 7) + 1)
//   然后是一串块：
//     0x21 扩展块：标签(1) + 子块序列（每块：长度字节 + 数据，遇到长度 0 结束）
//     0x2C 图像描述符：左2 上2 宽2 高2 packed1 [+ 局部颜色表] + LZW 最小码长(1) + 子块序列
//     0x3B 文件结束
//
// 全局颜色表 / 局部颜色表 / LZW 数据全部原样保留，只把"第一帧之后"的部分砍掉，
// 所以输出一定是合法 GIF，不需要重新编码。

/** 跳过一段子块序列，返回结束后的偏移；解析不下去返回 -1。 */
function skipSubBlocks(buffer, start) {
  let p = start;
  while (p < buffer.length) {
    const size = buffer[p];
    p += 1;
    if (size === 0) return p;
    p += size;
  }
  return -1;
}

/** 全局颜色表之后的第一个块偏移；结构不对返回 -1。 */
function firstBlockOffset(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return -1;
  const sig = buffer.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return -1;
  const packed = buffer[10];
  let pos = 13;
  if (packed & 0x80) pos += 3 * (1 << ((packed & 7) + 1));
  return pos < buffer.length ? pos : -1;
}

/**
 * 截成只有第一帧的 GIF。
 * @returns {Buffer|null} 成功返回新 buffer；不是 GIF / 本来就只有一帧 / 结构不认识 → null
 */
export function firstFrameOnly(buffer) {
  // 先数帧：只有一帧（或结构不认识）就没什么可截的，直接放弃，避免"越截越小"的无意义拷贝
  if (countFrames(buffer) <= 1) return null;
  const start = firstBlockOffset(buffer);
  if (start < 0) return null;
  let pos = start;
  while (pos < buffer.length) {
    const block = buffer[pos];
    if (block === 0x3b) return null;                 // 直接到文件尾 = 本来就只有一帧，不必截
    if (block === 0x21) {                            // 扩展块：GCE / 注释 / NETSCAPE 循环，原样保留
      pos = skipSubBlocks(buffer, pos + 2);
      if (pos < 0) return null;
      continue;
    }
    if (block === 0x2c) {                            // 第一个图像描述符 = 第一帧
      const ipacked = buffer[pos + 9];
      let p = pos + 10;
      if (p >= buffer.length) return null;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));  // 局部颜色表
      p += 1;                                        // LZW 最小码长
      p = skipSubBlocks(buffer, p);
      if (p < 0 || p > buffer.length) return null;
      return Buffer.concat([buffer.subarray(0, p), Buffer.from([0x3b])]);
    }
    return null;                                     // 不认识的块：不猜
  }
  return null;
}

/** 数 GIF 有几帧（用来在日志/工具输出里说清"原图是 N 帧动画"）；结构不对返回 -1。 */
export function countFrames(buffer) {
  const start = firstBlockOffset(buffer);
  if (start < 0) return -1;
  let pos = start;
  let frames = 0;
  while (pos < buffer.length) {
    const block = buffer[pos];
    if (block === 0x3b) return frames;
    if (block === 0x21) {
      pos = skipSubBlocks(buffer, pos + 2);
      if (pos < 0) return -1;
      continue;
    }
    if (block === 0x2c) {
      const ipacked = buffer[pos + 9];
      let p = pos + 10;
      if (p >= buffer.length) return -1;
      if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));
      p += 1;
      p = skipSubBlocks(buffer, p);
      if (p < 0 || p > buffer.length) return -1;
      frames += 1;
      pos = p;
      continue;
    }
    return -1;
  }
  return frames;
}
