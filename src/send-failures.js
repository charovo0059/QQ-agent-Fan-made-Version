// 「没发出去的消息」登记表（2026-09-26 第二十四对话，提案 26bb79c2 的剩余部分）。
//
// 为什么需要它：`sender` **只在发送成功之后**才 `store.appendSelf()`（那条注释写得很清楚：
// 绝不在发送前记账，否则失败的消息会被去重窗口误判成重复、静默丢掉）。后果是
// **失败的那条在存档里根本没有记录** —— 管理端看不到"刚才有一条没发出去"，
// 而微信侧"读不回"这种失败恰恰是**她以为发出去了、对面没收到**的那一类。
//
// 边界（与提案当年的决定一致）：
//   · 这里**只记事、不自动重发**。微信侧"读不回"有可能是落库慢造成的假阴性，
//     自动重发会把同一条话发两遍 ⇒ 重发必须是**人在控制台点的那一下**。
//   · 读不到 / 写不进 ⇒ 只 console.warn，**绝不影响发送本身**（登记表坏了不该让消息发不出去）。
//   · 只留最近 MAX 条（默认 50），文件在 `data/send-failures.json`。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'send-failures.json');
const MAX = 50;
const TEXT_MAX = 500;      // 存原文但截断：登记表不是存档，别把整个聊天记录抄一份
const ERR_MAX = 300;

let cache = null;          // [{ id, chatKey, text, error, at }]，最新在前

function load() {
  if (cache) return cache;
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    cache = Array.isArray(data?.items) ? data.items.filter((x) => x && x.id && x.chatKey) : [];
  } catch {
    cache = [];            // 文件不存在/坏了都从空开始（**不猜**、也不动别的数据）
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: load() }, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (error) {
    // 写不进去只出声：登记表是"给人看的旁路"，不该把发送链路拖下水
    console.warn(`[send-failures] 落盘失败（不影响发送）：${error?.message ?? error}`);
  }
}

/**
 * 记一条发送失败。返回登记项（含 id）；参数不合法返回 null。
 * ⚠️ 同一个会话里**同样的文本 + 同样的错**在 30 秒内只记一次：OneBot 侧一次失败常常
 *    会被上层重试（同一轮里模型重发、或"部分失败"逐条上报），否则登记表会被同一条刷满。
 */
export function recordFailure({ chatKey, text, error, at = Date.now() } = {}) {
  const key = String(chatKey || '').trim();
  if (!key) return null;
  const body = String(text ?? '').slice(0, TEXT_MAX);
  const why = String(error ?? '').slice(0, ERR_MAX);
  const items = load();
  const dup = items.find((x) => x.chatKey === key && x.text === body && x.error === why && at - x.at < 30000);
  if (dup) return dup;
  const item = { id: crypto.randomUUID().slice(0, 8), chatKey: key, text: body, error: why, at: Number(at) || Date.now() };
  items.unshift(item);
  if (items.length > MAX) items.length = MAX;
  save();
  return item;
}

/** 列出失败记录（可按会话过滤）。最新在前。 */
export function listFailures(chatKey = '') {
  const key = String(chatKey || '').trim();
  const items = load();
  return key ? items.filter((x) => x.chatKey === key) : [...items];
}

export function getFailure(id) {
  const want = String(id || '');
  return load().find((x) => x.id === want) || null;
}

/** 删掉一条（人工重发成功 / 点"忽略"时用）。返回是否真的删了。 */
export function removeFailure(id) {
  const want = String(id || '');
  const items = load();
  const i = items.findIndex((x) => x.id === want);
  if (i < 0) return false;
  items.splice(i, 1);
  save();
  return true;
}

/** 清掉某个会话（或全部）的失败记录。返回删了几条。 */
export function clearFailures(chatKey = '') {
  const key = String(chatKey || '').trim();
  const items = load();
  const keep = key ? items.filter((x) => x.chatKey !== key) : [];
  const removed = items.length - keep.length;
  if (!removed) return 0;
  cache = keep;
  save();
  return removed;
}
