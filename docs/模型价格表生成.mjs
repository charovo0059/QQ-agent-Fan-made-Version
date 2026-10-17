// 从 src/model-prices.js 的 OFFICIAL_PRICES 生成 docs/model-prices.md。
// 用法：node docs/模型价格表生成.mjs
// ⚠️ 生成物是给人看的文档 —— 价格真值只有 src/model-prices.js 一处，别手改 md。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFICIAL_PRICES } from '../src/model-prices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const B = String.fromCharCode(96);   // markdown 的行内代码定界符

// 分组口径：模型 id 前缀 → 章节名。数组顺序即章节顺序。
const GROUPS = [
  ['deepseek-', 'DeepSeek'],
  ['glm-', '智谱 GLM'],
  ['kimi-', '月之暗面 Kimi'],
  ['minimax-', 'MiniMax'],
  ['mimo-', '小米 MiMo'],
  ['qwen', '通义千问 Qwen'],
  ['hunyuan-', '腾讯混元'],
  ['hunyuan', '腾讯混元'],
  ['hy4-preview', '腾讯混元'],
  ['hy3', '腾讯混元'],
  ['doubao-', '字节豆包'],
  ['ernie-', '百度文心'],
  ['gpt-', 'OpenAI'],
  ['claude-', 'Anthropic Claude'],
  ['gemini-', 'Google Gemini'],
  ['grok-', 'xAI Grok'],
];
const OTHER = '其它厂商';

function vendorOf(id) {
  for (const pair of GROUPS) if (id.startsWith(pair[0])) return pair[1];
  return OTHER;
}

const fmt = (v) => (v === null || v === undefined ? '—' : String(v));
function row(id, p) {
  const peak = p.peak ? '高峰 ' + fmt(p.peak.in) + '/' + fmt(p.peak.out) + '/' + fmt(p.peak.cached) : '';
  const img = p.image
    ? (p.image.mode === 'capped' ? p.image.maxTokensPerImage + ' token/张封顶'
      : p.image.mode === 'pixel' ? '按像素换算' : '规则待补')
    : '';
  const note = String(p.note || '').replace(/\|/g, '\\|');
  return ['| ' + B + id + B, fmt(p.in), fmt(p.out), fmt(p.cached), peak || '—', img || '—', p.src || '—', note + ' |'].join(' | ');
}

const ids = Object.keys(OFFICIAL_PRICES);
const buckets = new Map();
for (const id of ids) {
  const v = vendorOf(id);
  if (!buckets.has(v)) buckets.set(v, []);
  buckets.get(v).push(id);
}
const order = [...new Set(GROUPS.map((g) => g[1]))].filter((v) => v !== OTHER);
const names = order.filter((v) => buckets.has(v));
if (buckets.has(OTHER)) names.push(OTHER);

const out = [];
out.push('# 内置模型价格表');
out.push('');
out.push('收录 **' + ids.length + '** 个模型，按厂商分组列出**输入 / 输出 / 缓存命中**单价（元 / 百万 token）、峰谷价与图片计费规则。');
out.push('');
out.push('> ⚠️ 这份表由 ' + B + 'docs/模型价格表生成.mjs' + B + ' 从 ' + B + 'src/model-prices.js' + B + ' 的 ' + B + 'OFFICIAL_PRICES' + B + ' **自动生成**，');
out.push('> ⛔ 别手改本文 —— 要改价格请改 ' + B + 'src/model-prices.js' + B + '，然后重跑一次生成脚本。');
out.push('');
out.push('价格口径：');
out.push('');
out.push('- ' + B + 'src' + B + ' 列：' + B + 'official' + B + ' = 厂商官方定价页直取；' + B + 'derived' + B + ' = 二手折算（仅供参考）。带阶梯价的取**最低档**（通常是 ≤32K 输入）。');
out.push('- **峰谷**列：只对分时段计价的厂商（如 DeepSeek，工作日 9-12 / 14-18 为高峰）有意义 —— 空闲段按前三列算，高峰段翻倍。');
out.push('- **图片**列：视觉模型的图片换算规则差异极大（DeepSeek 按张封顶 384 token，千问按像素 宽×高/1024+2），单独列出来避免误判图片开销。');
out.push('- 走中转站时实际单价通常与官方不一样 —— 在「设置 → 模型 API → 成本核算」里关掉「使用官方价格」后手填单价。');
out.push('');
out.push('---');
out.push('');
for (const v of names) {
  out.push('## ' + v);
  out.push('');
  out.push('| 模型 id | 输入 | 输出 | 缓存命中 | 峰谷价 | 图片 | 来源 | 备注 |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const id of buckets.get(v)) out.push(row(id, OFFICIAL_PRICES[id]));
  out.push('');
}
const outPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'model-prices.md');
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8');
console.log('已生成 ' + ids.length + ' 条 → ' + outPath + '（' + names.length + ' 个厂商分组）');
