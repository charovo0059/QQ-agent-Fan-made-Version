// BT 只读清单 —— bencode 编解码（decode / encode / topLevelSpans）
//
// 为什么需要 topLevelSpans：算 infohash 必须对 **info 字典的原始字节** 做 SHA-1。
// 拿 `buf.indexOf('4:info') + 6` 找起点，在「注释/文件名里恰好出现 4:info 字样」的种子上
// 会定位到错的地方；而且它给不出 info 的**终点**（`4:infod` 紧邻形态下更看不出来）。
// 只能按 bencode 结构走一遍，记下每个顶层 key 的原始区间。
//
// 与原型 `_bt/bencode.mjs` 的唯一差别：原型对**截断输入会死循环**
// （`while (buf[i] !== 0x3a) i++` 越界后 buf[i] === undefined，永远不等于 0x3a），
// 所以这里每一步都做越界检查并抛「bencode 截断」。截断样本必须报错，不许被当成成功。

export function decode(buf, start = 0) {
  let i = start;
  function val() {
    if (i >= buf.length) throw new Error('bencode 截断：在 ' + i + ' 处意外结束');
    const ch = buf[i];
    if (ch === 0x69) { // i
      i++;
      const s = i;
      while (i < buf.length && buf[i] !== 0x65) i++;
      if (i >= buf.length) throw new Error('bencode 截断：整数未闭合');
      const str = buf.toString('latin1', s, i);
      if (!/^-?\d+$/.test(str)) throw new Error('bencode 非法整数: ' + str);
      i++;
      return Number(str);
    }
    if (ch === 0x6c) { // l
      i++;
      const a = [];
      for (;;) {
        if (i >= buf.length) throw new Error('bencode 截断：列表未闭合');
        if (buf[i] === 0x65) break;
        a.push(val());
      }
      i++;
      return a;
    }
    if (ch === 0x64) { // d
      i++;
      const o = {};
      for (;;) {
        if (i >= buf.length) throw new Error('bencode 截断：字典未闭合');
        if (buf[i] === 0x65) break;
        const k = val();
        const v = val();
        o[Buffer.isBuffer(k) ? k.toString('utf8') : String(k)] = v;
      }
      i++;
      return o;
    }
    if (ch >= 0x30 && ch <= 0x39) { // 字符串 <len>:<bytes>
      const s = i;
      while (i < buf.length && buf[i] !== 0x3a) i++;
      if (i >= buf.length) throw new Error('bencode 截断：字符串长度未闭合');
      const lenStr = buf.toString('latin1', s, i);
      if (!/^\d+$/.test(lenStr)) throw new Error('bencode 非法字符串长度: ' + lenStr);
      const len = Number(lenStr);
      i++;
      if (i + len > buf.length) throw new Error('bencode 截断：字符串体缺 ' + (i + len - buf.length) + ' 字节');
      const b = buf.subarray(i, i + len);
      i += len;
      return b;
    }
    throw new Error('bad bencode at ' + i + ' byte ' + ch);
  }
  const v = val();
  return { value: v, end: i };
}

export function encode(v) {
  if (typeof v === 'number') return Buffer.from('i' + v + 'e');
  if (typeof v === 'string') v = Buffer.from(v, 'utf8');
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(v.length + ':'), v]);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(encode), Buffer.from('e')]);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return Buffer.concat([Buffer.from('d'), ...keys.flatMap(k => [encode(k), encode(v[k])]), Buffer.from('e')]);
  }
  throw new Error('cannot encode ' + typeof v);
}

// 解码并记录顶层 dict 里每个 key 的原始字节区间（算 infohash 必须用原始字节）
export function topLevelSpans(buf) {
  const spans = new Map();
  let i = 0;
  function val() {
    if (i >= buf.length) throw new Error('bencode 截断：值在 ' + i + ' 处意外结束');
    const ch = buf[i];
    if (ch === 0x69) { i++; while (i < buf.length && buf[i] !== 0x65) i++; if (i >= buf.length) throw new Error('bencode 截断：整数未闭合'); i++; return; }
    if (ch === 0x6c) { i++; for (;;) { if (i >= buf.length) throw new Error('bencode 截断：列表未闭合'); if (buf[i] === 0x65) break; val(); } i++; return; }
    if (ch === 0x64) { i++; for (;;) { if (i >= buf.length) throw new Error('bencode 截断：字典未闭合'); if (buf[i] === 0x65) break; val(); val(); } i++; return; }
    if (!(ch >= 0x30 && ch <= 0x39)) throw new Error('bad bencode at ' + i + ' byte ' + ch);
    const s = i;
    while (i < buf.length && buf[i] !== 0x3a) i++;
    if (i >= buf.length) throw new Error('bencode 截断：字符串长度未闭合');
    const len = Number(buf.toString('latin1', s, i));
    i++;
    if (i + len > buf.length) throw new Error('bencode 截断：字符串体缺 ' + (i + len - buf.length) + ' 字节');
    i += len;
  }
  if (buf.length === 0 || buf[0] !== 0x64) throw new Error('not a dict');
  i = 1;
  for (;;) {
    if (i >= buf.length) throw new Error('bencode 截断：顶层字典未闭合');
    if (buf[i] === 0x65) break;
    const s = i;
    while (i < buf.length && buf[i] !== 0x3a) i++;
    if (i >= buf.length) throw new Error('bencode 截断：key 长度未闭合');
    const len = Number(buf.toString('latin1', s, i));
    i++;
    if (i + len > buf.length) throw new Error('bencode 截断：key 体缺字节');
    const key = buf.toString('utf8', i, i + len);
    i += len;
    const vs = i;
    val();
    spans.set(key, { start: vs, end: i });
  }
  return spans;
}
