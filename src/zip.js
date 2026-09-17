// 最小 ZIP 打包器 —— 只用 Node 内置的 zlib，**不引入任何第三方依赖**。
//
// 为什么要自己写：诊断包要能在任何一台机器上生成（别人装完出问题时，
// 让他点一下就能导出给我们看）。为这个功能加一个 zip 库不值当：
// 运行期依赖目前只有 3 个包（js-yaml / undici / ws），别为了导日志破这个数。
//
// 实现范围刻意很小：只支持 store（不压缩）和 deflate，文件名一律 UTF-8。
// 不写时间戳（DOS 时间字段填 1980-01-01）—— 同一个包重复导出应得到同样的字节，
// 便于比对；要时间看包里的 信息.txt。
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 把一个文件列表打成 zip。
 *
 * @param {Array<{name: string, data: string|Buffer}>} entries
 * @returns {Buffer} 完整的 zip 文件内容
 */
export function createZip(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of list) {
    const nameBuf = Buffer.from(String(entry?.name ?? 'untitled.txt'), 'utf8');
    const raw = Buffer.isBuffer(entry?.data)
      ? entry.data
      : Buffer.from(String(entry?.data ?? ''), 'utf8');

    // 压缩后反而变大（小文件、已压缩内容）就退回 store，别做无用功
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    // ── 本地文件头（30 字节定长 + 文件名 + 内容）──
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);   // 签名
    local.writeUInt16LE(20, 4);           // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6);       // 通用标志：文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);           // 修改时间（固定 0）
    local.writeUInt16LE(0x21, 12);        // 修改日期（1980-01-01）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); // 压缩后大小
    local.writeUInt32LE(raw.length, 22);  // 原始大小
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 扩展字段长度
    localParts.push(local, nameBuf, body);

    // ── 中央目录项（46 字节定长 + 文件名）──
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // 签名
    central.writeUInt16LE(20, 4);         // 生成程序版本
    central.writeUInt16LE(20, 6);         // 解压所需版本
    central.writeUInt16LE(0x0800, 8);     // 同样是 UTF-8 标志
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // 扩展字段长度
    central.writeUInt16LE(0, 32);         // 注释长度
    central.writeUInt16LE(0, 34);         // 起始磁盘号
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(0, 38);         // 外部属性
    central.writeUInt32LE(offset, 42);    // 本地头偏移
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centralParts);

  // ── 中央目录结束记录 ──
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                  // 本磁盘号
  end.writeUInt16LE(0, 6);                  // 中央目录起始磁盘号
  end.writeUInt16LE(list.length, 8);        // 本磁盘条目数
  end.writeUInt16LE(list.length, 10);       // 总条目数
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);            // 中央目录偏移
  end.writeUInt16LE(0, 20);                 // 注释长度

  return Buffer.concat([...localParts, centralBuf, end]);
}
