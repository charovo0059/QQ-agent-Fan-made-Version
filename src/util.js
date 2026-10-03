// 通用小工具：无业务逻辑。

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 带抖动的均匀随机区间。 */
export function randRange([min, max]) {
  return randInt(min, max);
}

export function nowMs() {
  return Date.now();
}

// ── 时间格式化（全部走本地时区，给模型/界面看） ─────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 2026-08-30 21:33:05（周六） */
export function formatFullTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}（${WEEKDAYS[d.getDay()]}）`;
}

/** 08-30 21:33 */
export function formatShortTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 21:33:05 */
export function formatClockTime(ts = Date.now()) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 人类可读的体积（B / KB / MB / GB）。
 *
 * 为什么从 `src/tools.js` 搬到这里（2026-10-03 第三十八对话）：
 *   磁力链接里的 `xl`（总字节数）要显示给模型看，而它**常常是 GB 级** ——
 *   tools.js 原来那份只到 MB（12GB 会写成 `12288.0MB`，读起来费劲）。
 *   所以补一档 GB 并**搬到共用处**，两边共用一个函数（⛔ 不复制一份，复制迟早漂移）。
 *   ⚠️ 不到 1GB 的部分**逐字符与搬之前相同**（图片那些调用点一个字都不会变）。
 */
export function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1024 * 1024 * 1024) return `${(v / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)}MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${v}B`;
}

// ── 文本处理 ─────────────────────────────────────────────────────────────

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 防提示注入/泄露：把用户昵称、消息文本里的“指令式方括号标记”弱化，
 * 避免群友伪装成系统段（如【本次唤醒】）骗模型。只处理外观，不改变语义。
 */
export function sanitizeUserText(text) {
  let s = String(text ?? '');
  // 全角化方括号包裹的疑似系统标记：【xxx】→【xxx】保留，但 [xxx] 中含中文关键词的换成（xxx）
  s = s.replace(/\[(本次唤醒|系统|管理员|owner| Owner|OWNER|角色扮演|会话令牌|当前时间)[^\]]*\]/gi, '($1)');
  return s;
}

/** 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/**
 * 把弱模型常见的"对象形态"消息解包回纯文本：
 *   {"text":"..."} / {"content":"..."} / {"message":"..."} → 取第一个字符串值
 *   content-parts（OpenAI 视觉格式 [{type:'text',text:...}]）→ 取 text 段拼接
 *   嵌套数组 → 拍平拼接
 * 返回 null = 解不出来（调用方应报错回模型，而不是把 "[object Object]" 发出去）。
 */
function unwrapMessage(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(unwrapMessage).filter((x) => x !== null).join('\n');
  if (typeof m === 'object') {
    // content-parts：{type:'text', text:'...'} 或 {content:[{type:'text',...}]}
    if (m.type === 'text' && typeof m.text === 'string') return m.text;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    }
    const v = m.text ?? m.content ?? m.message;
    if (typeof v === 'string') return v;
    return null;
  }
  return String(m);
}

/**
 * 把 messages 参数统一成字符串数组。兼容：
 *  - 字符串 / 字符串数组（正常路径）
 *  - JSON 字符串形态的数组、带引号的字符串（老兼容）
 *  - 双重编码的 JSON 对象字符串 "{\"text\":\"...\"}"（弱模型高发）
 *  - 对象 / 对象数组（弱模型高发，逐一解包）
 *  salvage 规则：能解出文本的条目照发；一条都解不出来才抛错 ——
 *  错误会作为工具结果回给模型，它在同一会话里可以自我纠正重发。
 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) value = parsed;
      } catch { /* 保持字符串 */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === 'string') value = unquoted;
    }
  }
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const bad = [];
  for (const m of arr) {
    const unwrapped = unwrapMessage(m);
    if (unwrapped === null) { bad.push(m); continue; }
    const s = String(unwrapped).trim();
    if (s) out.push(s);
  }
  if (!out.length && bad.length) {
    throw new Error(`messages 必须是字符串或字符串数组，收到的是对象形态：${JSON.stringify(bad[0])?.slice(0, 120)}——请把消息文本直接作为字符串传入`);
  }
  return out;
}

/** 简单串行队列：保证发送按顺序、带间隔执行。 */
export function createSendChain() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    const next = chain.then(task, task);
    // 防止单次失败中断整条链
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/** 简易事件总线。 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (error) { console.error(`[bus] ${type} 监听器出错:`, error); }
      }
    }
  };
}

/** 截断长文本（日志/会话记录展示用）。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…(共${s.length}字)`;
}

/**
 * 本地路径 → OneBot 能识别的 file URI。
 *
 * 为什么要转换而不是直接传路径：裸 Windows 路径（反斜杠 + 盘符）在 OneBot
 * 各实现里支持不一致，而 `file:///C:/a/b.png` 是规范里明确的形式。
 * 空格/中文要编码（协议端会 decodeURIComponent），`#` `?` 在 URI 里是分隔符，
 * 必须手动转义 —— `encodeURI` 不处理它们。
 *
 * ⚠️ 为什么单独抽成一个共用件、而不是各处自己拼一行：这个转换有四个容易写错的点
 *    （反斜杠、幂等、UNC 前导斜杠、`#`/`?`），而**写错的表现全都是"不报错、行为却坏掉"**
 *    （协议端读不到 → 上层静默回退 base64，一切"看起来正常"）。
 *    ⇒ 2026-09-25 第十七对话从上游 0.4 的 `src/sender.js` 移植过来（那份自带 108 行单测，
 *      一并移植成 `测试-现行\test-文件URI.mjs`），同时把 `onebot.js:496` 那处**手写拼接**换掉
 *      —— 原来那处**没做任何编码**，路径含 `#`/`?`/空格就会坏。
 *
 * @param {string} input 本地路径（正反斜杠都行），或已经是 file:// URI
 * @returns {string} file URI；空输入返回空串（**不产出** `file:///`）
 */
export function toFileUri(input) {
  // ⚠️ 本函数刻意不使用任何正则转义（用 String.fromCharCode(92) 取反斜杠、
  // 用 split/join 代替路径分隔符替换）。原因（上游原注，是踩出来的）：
  // 这段代码最初是用脚本批量写入的，多层转义把 `\/` 吃成了 `/`，写出了一个非法的
  // 正则字面量，而 `node --check` 的结果被 shell 的 `&&` 链掩盖成"通过" ——
  // 结果整个 sender.js 加载即崩，比原本要修的 bug 严重得多。
  // 零反斜杠写法让"写错字符"这件事根本不可能发生。
  const BS = String.fromCharCode(92);                    // 反斜杠字符本身
  let s = String(input || '').trim().split(BS).join('/');
  if (!s) return '';
  if (s.slice(0, 7).toLowerCase() === 'file://') return s;   // 已是 URI → 幂等
  const unc = s.startsWith('//');                        // UNC：\\server\share
  // 去掉前导斜杠（逐个 split 掉，避免再用正则转义）
  const body = unc ? s.slice(2) : s.split('/').filter(Boolean).join('/');
  if (!body) return '';
  // encodeURI 会处理空格/中文，但不转义 `#` `?` —— 它们在 URI 里是分隔符，必须手动转
  const encoded = encodeURI(body).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return unc ? 'file://' + encoded : 'file:///' + encoded;
}

// ── 「一键重启」的**续启**标记（2026-10-03 第三十三对话）────────────────────
//
// 要解决什么：托盘上点一下重启之后，`snowluma` 与微信**中继**都不会自己回来 ——
//   线上 `snowluma.autoLaunch=false`、`wechat.autoLaunchRelay=false`，而微信中继还是
//   本应用的**子进程**（应用一退就跟着没）。症状是"界面一切正常、消息永远不来"，
//   正是本项目最忌的那类静默失败（`src/app.js` 里那段注释记的就是它）。
// 做法：**重启之前**先把"现在到底哪些在跑"读出来，写进**新实例的命令行参数**；
//   新实例起来时照着把它拉回来。
//
// ⚠️ 为什么用命令行、而不是落盘一个标记文件：
//   · 这是一次**一次性**意图。落盘文件的话，进程若在"写完标记、还没重启"之间被杀
//     （或用户直接关掉窗口不重启了），下次**冷启动**就会莫名其妙自己去拉 SnowLuma /
//     微信通道 —— 那是"我们替用户做了一个他没要求的动作"，本项目最忌这个。
//   · 命令行参数天然一次性：新进程读一次就没了，旧进程死了就当没发生过。
//   · 还有个附带好处：命令行**看得见**（进程列表里就能核"这次到底带了什么"）。
//
// ⚠️ 为什么必须**原样带上旧的 argv**（见 buildResumeArgv）：
//   `--qq-agent-debug-port=…` 就在里面。项目为"某次重启把调试口悄悄关掉"栽过一次
//   （第十一/十三对话为此专门改过 `工具-运维\重启五步.mjs`）⇒ 这条有测试钉住。
export const RESUME_ARG_PREFIX = '--qq-agent-resume=';

/** 允许续启的东西的**白名单**。⛔ 只认这里的名字 —— 参数是外部输入，别让它变成万能开关。 */
const RESUME_TARGETS = ['snowluma', 'wechat'];

/**
 * 从 argv 里读出"这次启动要不要续启、续启哪些"。
 * 不认识的名字静默丢掉（当没看见），重复的只留一份。
 * @param {string[]} argv
 * @returns {string[]} 例如 `['snowluma','wechat']`；没有/不合法就返回 `[]`
 */
export function parseResumeArgv(argv = []) {
  const list = Array.isArray(argv) ? argv : [];
  const hit = list.find((a) => String(a).startsWith(RESUME_ARG_PREFIX));
  if (!hit) return [];
  const out = [];
  for (const piece of String(hit).slice(RESUME_ARG_PREFIX.length).split(',')) {
    const name = piece.trim().toLowerCase();
    if (RESUME_TARGETS.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 造"重启后那个新实例"要用的 argv。
 *
 * 三条性质（判据逐条钉）：
 *  ① **原样保留**传进来的 argv（`--qq-agent-debug-port=…` 在里面，丢了就是那个老坑）；
 *  ② **先清掉已有的续启参数**再加 ⇒ 幂等，连点两次不会叠成两串；
 *  ③ 什么都没在跑时不加参数（保持"干净启动"这个默认行为不变）。
 *
 * @param {string[]} baseArgv 通常是 `process.argv.slice(1)`
 * @param {{snowluma?:boolean, wechat?:boolean}} state 重启前实测的状态
 * @returns {string[]}
 */
export function buildResumeArgv(baseArgv = [], state = {}) {
  const base = (Array.isArray(baseArgv) ? baseArgv : [])
    .map((a) => String(a))
    .filter((a) => !a.startsWith(RESUME_ARG_PREFIX));
  const keep = RESUME_TARGETS.filter((t) => state?.[t] === true);
  if (!keep.length) return base;
  return [...base, RESUME_ARG_PREFIX + keep.join(',')];
}
