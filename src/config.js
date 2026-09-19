// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向一个自托管的 JSON（格式见 scripts/export-prices.mjs 产物）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // ── 看图（视觉）的体积上限 ──
  // 以前这四个数字是写死在 tools.js 里的常量，只能改代码；现在挂到配置里，设置页可调。
  //
  // 为什么可以调大：代码注释里记着实测结果 —— 网关 **32MB 能过、48MB 才 413**，
  // 而单张默认只给 700KB，离墙还有 45 倍。当初保守是为了防 413。
  // ⚠️ 但**真正卡住成本的不是网关，是图片 token**：调得越大，它就越会真的去看大图，
  //    每次看图都按输入 token 计费。要调之前先想清楚这一点。
  //
  // ⚠️ maxPerView 会出现在 get_message_images 的工具描述里，改它 = 换一次提示词前缀
  //    （前缀缓存要重新热身一次，一次性成本）。
  imageLimits: {
    maxPerView: 6,        // 一次最多看几张（图多时靠 start 翻页）
    maxKB: 700,           // 单张**原图**字节上限（KB）；GIF 会先截成第一帧再比
    maxRunMB: 3,          // 一轮对话累计注入的上限（MB，按 base64 后的长度算）
    maxDownloadMB: 12     // 下载阶段上限（MB，要留够原图才能截 GIF 第一帧）
  },
  // ── 本子查询（JM 禁漫直连 + NH 离线库兜底）──
  // 给 doujin-lookup__lookup 工具用（2026-09-18 起该工具由 `skills/doujin-lookup/` 提供，
  // 不再是 src/tools.js 里的原生工具；名字带 `skillId__` 前缀是上游 plugin-loader 强制的）：
  // 群友说个类型/关键词，查本子码 + 名字。
  //
  // 为什么 JM 走"常驻 Python 子进程"：JM 的搜索接口虽然是 JSON，但**要签名头**，
  // 而且它的内置域名经常失效（jmcomic 会自动把域名换成当前可用的）。这些都在
  // jmcomic 里实现好了，自己用 Node 重写不划算。子进程由 src/jm-bridge.js 管理。
  //
  // ⚠️ 默认关闭 —— 这类内容相关，明确打开才用。
  doujinLookup: {
    enabled: false,
    // 下面四项留空就用默认：<dsh qq>/JM工具/ 下的 .venv\Scripts\python.exe、jm_server.py、nh.db
    toolDir: '',
    pythonPath: '',
    serverScript: '',
    nhDbPath: '',
    timeoutMs: 30000,     // 单次查询超时（首次查询含域名探测，约 3 秒）
    maxResults: 10,       // 一次最多返回几本
    allowInGroup: true    // 关掉则只在私聊里可用（群聊里发本子名容易被盯）
  },
  // 以图搜图（免 API Key，直抓 trace.moe / SauceNAO / iqdb / soutubot.moe；
  // ascii2d 只在 auto 的降级链里用、不给模型选；Yandex 与 3d.iqdb 已于 2026-09-17 移除，
  // 理由见 image-search.js 里那段注释。关掉本项则移除 search_image_source 工具）
  imageSearch: {
    enabled: true,
    // 触发策略：这个工具本来是给"群里发图求出处"用的，但模型很容易看到图就搜
    // （实测 135 次调用里 100 次根本没人问出处），所以默认收紧：
    //   'asked' = 只在**有人明确问出处**时才允许（默认，代码层判定，见 tools.js）
    //   'free'  = 交给模型自己判断（旧行为）
    policy: 'asked',
    // 单次运行最多真搜几次。实测一次运行能把 tracemoe/saucenao/iqdb
    // 挨个试一遍（同一张图搜 5 次），既慢又白耗 SauceNAO 的免费额度（约 200 次/天）。
    maxPerRun: 2,
    // 可选：SauceNAO 官方 API Key（注册 saucenao.com 账号免费获取）。
    // 填了走官方 JSON API（稳定、免费额度约 200 次/天）；留空走匿名网页抓取兜底。
    saucenaoApiKey: '',
    // Cloudflare 自动绕过：被弹人机验证时，先用内置 Chromium 网络栈重试，
    // 仍被拦则开隐藏窗口自动完成 JS 验证（仅限搜图引擎域名白名单）。
    cfBypass: true
  },
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      // ⚠️ 模型名必须是**账号里真实存在、且支持 web_search 工具**的那个。
      // 实测（2026-09-12）api.deepseek.com 上：
      //   deepseek-v4-pro  → 真的执行 web_search（返回值里带 web_search_call）
      //   deepseek-flash   → 忽略 web_search 工具，直接回"我无法联网搜索"
      //   deepseek-v4-flash→ 账号里**不存在**，API 会静默回退到 deepseek-flash
      // 所以模型名写错时不会报错，只会让"联网搜索"悄悄变成不联网 —— 这里是
      // 唯一能拦住它的地方。换模型前先确认它支持 web_search 工具。
      model: 'deepseek-v4-pro',
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false           // true 时图片下载允许内网地址（仅本地测试/自建图床）
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000',
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：原版"小鲸鱼"角色卡（适配版）
    participation: 'medium',                // low | medium | high —— 参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // ── 系统提示覆盖（管理端「设置 → 人设 → 系统提示自定义」可编辑）──
    // 内置系统提示的段落硬编码在 src/prompt.js；这两个字段让它可改：
    //   systemPrompt 非空            → 整份替换内置系统提示
    //   systemPromptSegments[key] 非空 → 只替换该段，其余仍用内置
    // 覆盖文本支持 {botName} / {participation} 占位符。
    // 段落 key 见 prompt.js 的 SYSTEM_SEGMENT_LABELS。
    systemPrompt: '',
    systemPromptSegments: {}
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000       // QQ 硬限制切分（0 = 不限制）
  },
  // 主动开话题（可选）
  //
  // ⚠️ 2026-09-19 加了三道闸（调研报告 M2 / §10）：
  //   原来只有 enabled / 两个间隔 / idleThreshold / probability ——
  //   **没有安静时段、没有连发上限** ⇒ 凌晨 3 点也可能主动开口；没人搭理也会一直开口。
  //   对标 lingxi 的注释记着真实事故："没有这个上限的话，用户静默 24 小时、冷却 3 小时
  //   = 8 条主动消息 —— 像跟踪狂。"
  //
  // ⚠️ 默认值刻意保守：改的是"多话"那一侧，不是"沉默"那一侧。
  //    宁可少说，也不要做出一个半夜吵人、或追着人说话的东西。
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25,
    // ① 安静时段：这段时间内绝不主动开口（默认 23 点 → 次日 8 点）。
    //    跨零点由 start > end 表达，见 orchestrator 的 #quietHours()。
    quietHoursStart: 23,
    quietHoursEnd: 8,
    // ② 连发上限：连续主动开口这么多条、对方一条都没回 ⇒ 收手，老实等对方先说话。
    //    ⚠️ "开口"不等于"被回应"：只有对方真的回话才清零（在 store.appendIncoming 里清）。
    maxConsecutive: 2,
    // ③ 退避：被晾久了允许"再戳一次"，但之后每多一条没回应，等待就翻倍，且有上限。
    //    14h → 28h → 2.3天 → 4.7天 …… 封顶 14 天（像"淡了的朋友"，不是定时器）。
    reengageAfterHours: 14,
    reengageBackoff: 2,
    reengageMaxHours: 336
  },
  // 表情包
  sticker: {
    enabled: true,
    promptMaxStickers: 10,
    collectEnabled: true,
    // 一小时最多新增几条 AI 收藏（限频，改备注不算）。
    // 原为 10 —— 但一条合并转发经常带 30 张表情包，用户明确说"都存上"时 10 条根本不够。
    // 提到 60：够收完一次转发，又不至于让机器人无限囤货。界面入口在「表情包」页。
    maxCollectPerHour: 60,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按会话单独设置
    // { ["group:群号" | "private:QQ号"]: 0~100 } 仅 unifiedTier=false 时生效；
    // 没单独设置过的会话跟随全局滑条。
    // 键用**完整 chatKey**，群聊私聊同一套；私聊以前没法单独设，是这次补上的。
    // 旧版的 groupSliderPos（{ [群号]: 位置 }，只有群）在 loadConfig 里自动迁移过来。
    chatSliderPos: {},
    keepSessionFiles: 0         // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃——不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）
    // 记忆页里手动隐藏掉的"空记忆"会话。
    // 背景：记忆页会把**白名单里的每个会话**都列出来，包括一个记忆文件都还没有的
    // （从没用过记忆工具，或记忆被清空后剩下的空壳）。那种条目**不是文件**，
    // 所以"删不掉"——删了下次渲染又根据白名单长出来。这里记下用户主动隐藏的 key，
    // 渲染时不再显示；想找回来在记忆页打开「显示没有记忆的会话」即可。
    hiddenEmptyChats: [],
    // ── 跨会话记忆互通 ──
    // 记忆文件是按「会话 + 群友」切的（data/memory/<chatKey>/<QQ>.json），
    // 所以同一个人在私聊和各个群里本来是**互不相通**的几份印象。
    // 这里逐个 QQ 号指定方向，让这个人在别处的印象也进当前会话的提示词。
    //   { "<QQ号>": "both" | "toPrivate" | "toGroup" }
    //     both      = 私聊和所有群互相可见（到哪儿都认得这个人）
    //     toPrivate = 只有私聊能看到别处的记忆；群里只看本群（私事不会漏进群）
    //     toGroup   = 只有群聊能看到别处的记忆；私聊只看私聊
    // 没设的 QQ 号 = 各聊各的（默认行为）。
    // 读的时候才合并（带「（私聊）」「（群 123）」来源标记），**写入仍然只写当前会话**，
    // 所以每一条印象都能追溯到它是哪个场合记下的。
    share: {}
  },
  // ── 空闲「梦」：夜里没人说话时，把当天的事整理成一条笔记 ──
  // **只读**：这次模型调用一个工具都不给，所以它改不了记忆、碰不了人设卡、发不了消息
  // （为什么坚持只读，见 src/dream.js 开头）。笔记存在 data/dreams.json，在「笔记」页看。
  // 默认关：它每天要花几分钱，而且是个有性格的功能，该由你决定开不开。
  dream: {
    enabled: false,
    startHour: 2,          // 时段起点（含）
    endHour: 6,            // 时段终点（不含）；start > end 表示跨零点
    minIdleMinutes: 60     // 要求"安静了多久"才做 —— 免得趁人说话时插进来自言自语
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000          // 界面轮询间隔
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/**
 * 旧配置迁移：groupSliderPos（{ 群号: 0~100 }，只支持群聊）
 *            → chatSliderPos（{ "group:群号" | "private:QQ号": 0~100 }）。
 *
 * 迁移完就把旧字段**删掉**：两个字段并存的话，改一处漏一处，
 * 而且哪天旧字段被谁读到了又是一个"设置不生效"的悬案。
 * 已有的 chatSliderPos 优先，旧值只补空缺（不会覆盖新格式里已设的值）。
 */
function migrateSliderPos(cfg) {
  const store = cfg?.store;
  if (!store || !store.groupSliderPos || typeof store.groupSliderPos !== 'object') return cfg;
  const next = { ...(store.chatSliderPos || {}) };
  let moved = 0;
  for (const [id, pos] of Object.entries(store.groupSliderPos)) {
    if (pos === undefined || pos === null || pos === '') continue;
    // 旧的键是裸群号；万一有人已经手写过完整 chatKey，就原样保留
    const key = /^\d+$/.test(String(id)) ? `group:${id}` : String(id);
    if (next[key] === undefined) { next[key] = pos; moved += 1; }
  }
  store.chatSliderPos = next;
  delete store.groupSliderPos;
  if (moved) console.log(`[config] 已把 ${moved} 条按群档位设置迁移到 chatSliderPos（现在群聊私聊都支持）`);
  return cfg;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return migrateSliderPos(deepMerge(DEFAULT_CONFIG, parsed));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 按完整 chatKey 查 chatSliderPos，有单独设置就换算出该会话的
 * tier/randomPercent，其余字段（各档读取条数、关键词表）沿用全局值。
 * 群聊（group:xxx）与私聊（private:xxx）走的是同一套逻辑。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  if (store.unifiedTier !== false) return store;
  const key = String(chatKey || '');
  if (!/^(group|private):\d+$/.test(key)) return store;
  const table = store.chatSliderPos || {};
  // 兜底：万一有人手写成裸群号（旧格式残留），群聊也认一下
  let pos = table[key];
  if (pos === undefined && key.startsWith('group:')) pos = table[key.slice(6)];
  if (pos === undefined || pos === null) return store;
  const { tier, randomPercent } = sliderToTier(Number(pos));
  return { ...store, contextTier: tier, randomPercent };
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}
