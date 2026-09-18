// 本子查询 Skill（K 任务：把原 src/tools.js 的 doujin_lookup 工具 + src/prompt.js 的
// 提示词片段原样搬进 skills/doujin-lookup/，行为与文案一个字未改）。
//
// 加载后模型看到的工具名是 **doujin-lookup__lookup**：上游 plugin-loader 的
// createSkillApi.registerTool 会把工具 id 强制加上 `skillId__` 前缀（OpenAI 函数名
// 只允许 [a-zA-Z0-9_-]，不许用 ':' / '.'）。所以提示词、测试里提到工具时都用新名。
//
// ── ⚠️ 开关口径（改动前必读）──────────────────────────────────────────────
//
// 本项目按决策 ② 继续用 **config.doujinLookup.*** 当开关（设置页 ui/app.js、
// src/config.js 的默认值、既有文档与既有测试全都读这个键，零破坏优先）。
// 但上游 SkillManager 的判定顺序是 isLoaded → **isEnabled** → isAvailable：
//   isEnabled() 只读 config.skills['doujin-lookup'].enabled，且**在 available() 之前短路**
//   —— 只要那个键不存在（或 enabledByDefault 为 false），isActive() 立刻返回
//   skill-disabled，本文件的 available() 根本没有机会跑。
// 于是"开关留在 doujinLookup、又不写 config.skills 影子开关（避免两个开关打架）"
// 这两件事要同时成立，只能这么配：
//   · skill.json 的 enabledByDefault = true  → 让 isEnabled 不短路（它不再表达"默认开"）
//   · 下面的 available() 读 doujinLookup.enabled → **真正的开关**，默认关
// 行为上"默认关"完全不变：配置缺失 / enabled 不是 true → 不可用 + 提示词零片段
// （见 测试-现行\test-skills基础设施.mjs 的三条可用性断言）。代价是这里没有遵守
// 上游"启用状态只存在 config.skills[id].enabled"的唯一开关约定 —— 这是明知的偏离。
// 将来若把开关迁进 config.skills，就把 enabledByDefault 改回 false 并删掉下面的判断。
import { getConfig } from '../../src/config.js';
import { jmRequest } from '../../src/jm-bridge.js';

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/**
 * 取本子查询配置：优先用**本次运行传进来的** cfg（tools.js 的 gateToolDefs 会把
 * 当前配置挂在 runtimeContext.config 上），没有就退回实时配置。
 * 两者都是同一个 doujinLookup 段，所以口径只有一份。
 */
function doujinCfg(context) {
  const fromCtx = context?.config?.doujinLookup;
  if (fromCtx && typeof fromCtx === 'object') return fromCtx;
  return getConfig().doujinLookup || {};
}

/**
 * 依赖自检：开关没打开就判定为不可用。
 * 上游把"缺 Key / 缺二进制 / 模型不支持"这类都放这里，返回 {ok:false, reason}，
 * 于是 UI/日志能给出**准确原因**（skill-unavailable）而不是笼统的"工具关闭"。
 */
export function available(context = {}) {
  const cfg = doujinCfg(context);
  if (cfg.enabled !== true) {
    return { ok: false, reason: '本子查询开关未打开（config.doujinLookup.enabled 不是 true，默认关）' };
  }
  return { ok: true };
}

export function register(api) {
  api.registerTool({
    id: 'lookup',                 // → 注册进注册表的 id 是 'doujin-lookup__lookup'
    name: '本子查询',
    category: 'knowledge',
    icon: '📚',
    // 下面这段 description 与 parameters 逐字来自改造前的 src/tools.js（原 doujin_lookup）。
    description: '按关键词/类型查本子。返回【本子码 + 名字 + 作者】，直接把名字和码发给对方即可（可写成"JM<码>"）。'
      + '适合"有没有 XX 类型的本子""帮我找 XX 的本子""XX 作者的本子"这类请求。'
      + '关键词用对方说的词**原样**传进来就行 —— 中文、日文、英文、任何语言都可以，不用先翻译。'
      + '两个来源：JM（禁漫，实时直连，名字多为中文或日文原名）和本地 NH 库（那批名字是英文）；'
      + 'source=auto（默认）会先查 JM，JM 没结果才落到 NH。'
      + '**不要挑语言、也不要翻译或改写查到的名字** —— 查到什么语言就原样发什么。'
      + '想看某一本的具体信息（作者/标签/页数/中英别名）就带 detail=true。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索关键词（类型/题材/作者/作品名，任意语言都行，按对方原话传）' },
        source: { type: 'string', enum: ['auto', 'jm', 'nh'], description: 'auto=先 JM 再 NH 兜底（默认）；jm=只查 JM；nh=只查本地 NH 库' },
        limit: { type: 'integer', description: '最多返回几本（默认取配置，上限 50）' },
        detail: { type: 'boolean', description: 'true 时对第一条补查详情（作者/标签/页数/别名），会让这次调用慢一点' }
      },
      required: ['keyword']
    },
    async execute(ctx, args) {
      const kw = String(args.keyword ?? '').trim();
      if (!kw) return err('keyword 不能为空。');
      const cfg = getConfig().doujinLookup || {};
      if (cfg.allowInGroup === false && ctx.kind === 'group') {
        return err('这个功能只在私聊里可用（设置里关掉了群聊）。');
      }
      const limit = Math.min(50, Math.max(1, Number(args.limit) || Number(cfg.maxResults) || 10));
      const source = String(args.source || 'auto').toLowerCase();
      const wantDetail = args.detail === true || String(args.detail) === 'true';
      try {
        let items = [];
        let used = '';
        if (source === 'auto' || source === 'jm') {
          const r = await jmRequest({ cmd: 'search', kw, limit });
          if (r.ok) {
            items = (r.items || []).map((x) => ({ code: x.code, title: x.title, source: 'JM' }));
            used = 'JM';
          } else if (source === 'jm') {
            return err(`JM 查询失败：${r.error}`);
          }
        }
        if (!items.length && (source === 'auto' || source === 'nh')) {
          const r = await jmRequest({ cmd: 'nh', kw, limit });
          if (r.ok) {
            items = (r.items || []).map((x) => ({ code: x.id, title: x.title, source: 'NH', tags: x.tags }));
            used = used ? 'JM(无结果)→NH' : 'NH';
          } else if (source === 'nh') {
            return err(`NH 兜底查询失败：${r.error}`);
          }
        }
        if (!items.length) {
          return ok({
            keyword: kw, source: used || source, results: [],
            tip: used.startsWith('JM')
              ? 'JM 没搜到这个关键词，本地 NH 库也没有。换个更宽的说法再试（JM 是中文站，但任何语言的关键词都能传）。'
              : '本地 NH 库没有匹配（那批入库的名字是英文，换成英文关键词命中率更高 —— 但这不是必须的）。'
          });
        }
        const out = {
          keyword: kw,
          source: used,
          count: items.length,
          results: items.map((x) => ({
            code: x.code,
            title: x.title,
            链接: x.source === 'JM' ? `https://18comic.vip/album/${x.code}` : `https://nhentai.net/g/${x.code}`,
            ...(x.tags ? { tags: x.tags } : {})
          })),
          tip: '把名字和本子码直接发给对方（可以写成"JM<码>"的形式）。别把这里的链接原样贴出去，除非对方要。'
        };
        if (wantDetail && used.startsWith('JM') && items[0]?.code) {
          const d = await jmRequest({ cmd: 'detail', code: items[0].code });
          if (d.ok) out.firstDetail = d.album;
        }
        return ok(out);
      } catch (error) {
        return err(`本子查询失败：${error?.message ?? error}`);
      }
    }
  });
}

/**
 * 提示词片段（原来硬编码在 src/prompt.js 的 qqSceneRules() 里，条件同样是开关）。
 *
 * 为什么片段跟着开关走：工具被 gateToolDefs 拿掉之后，提示词里若还写着"用 XX 查"，
 * 模型就会去调一个不存在的工具、拿到"未知工具"的错误 —— 提示词与工具集必须同开关。
 * 工具名已按上游前缀约定改成 doujin-lookup__lookup。
 */
export function promptSections() {
  const cfg = getConfig().doujinLookup || {};
  if (cfg.enabled !== true) return [];        // 关着就一个字都不给
  const djGroup = cfg.allowInGroup !== false;
  return [{
    id: 'doujin-lookup-hint',
    title: '本子查询',
    priority: 40,
    content: [
      '- 群友想看某个类型的本子（"有没有 XX 类型的本子""帮我找 XX 的本子""XX 作者的本子"）时，用 doujin-lookup__lookup 查：'
      + '它返回【本子码 + 名字】，把名字和码直接报给对方就行（可写成"JM<码>"）。'
      + '关键词用对方说的词**原样**传进去即可 —— 中文、日文、英文、任何语言都行，不用先翻译。',
      '- doujin-lookup__lookup 有两个来源，默认 auto：先查 JM（中文站，名字多为中文或日文原名），JM 没结果才落到本地 NH 库（那批名字是英文）。'
      + '**不要挑语言、也不要为了"统一"去翻译或改写名字**：查到什么语言就原样发什么 —— '
      + '不同语言的群友用自己习惯的词去查，名字原样发出来反而方便对照着学。',
      '- doujin-lookup__lookup 查不到就如实说没搜到，换个更宽的关键词可以再试一次；不要连查好几次，也不要编造本子码。'
      + (djGroup ? '' : '（这个工具只在私聊里可用，群里不要提。）')
    ].join('\n')
  }];
}
