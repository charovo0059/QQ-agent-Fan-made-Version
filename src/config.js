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
    // ── 图片 / 视频专用模型（2026-09-25 第十七对话补：这两个字段以前"读了但不存在"）──
    // 用途：允许用一个便宜的纯文本模型聊天，只在**真的**要看图/看视频时才切到贵的多模态模型。
    // 留空 = 不切换（一律走 api.model）⇒ 行为与补之前**一字不差**。
    //
    // 🔴 为什么必须补上（这是个"静默失效"的真 bug）：`video-reader.js:154/193` 一直在读
    //    `cfg.api?.videoModel` 来判定视频走哪条路线，而 `config.js` 里**根本没有这个键**
    //    ⇒ 恒为空 ⇒ `resolveVideoRoute()` 里"已配置全模态模型 ⇒ 走原生视频输入"
    //    那条分支**永远走不到**，而且不报错、界面上也看不出来。
    //    `gif-to-video.js:9` 那条注释（"llm.js 的 specializedModelFor 会自动切到 videoModel"）
    //    同样是**死注释** —— 我们的 llm.js 没有这个函数。两处都由这次补齐 + 换 llm.js 变真。
    // ⚠️ 已知边界：设置页**还没有**填这两个字段的输入框 ⇒ 目前只能手改 config.json
    //    （要不要加输入框是另一件待办，见 `待办与决策记录.md`）。
    visionModel: '',                        // 图片输入专用模型（留空 = 用 api.model）
    videoModel: '',                         // 视频输入专用模型（留空 = 用 api.model）
    // ── 视频走哪条路（2026-09-25 补：`video-reader.js` 有两个调用点在读它）──────
    // 'auto'（默认）= 配了 videoModel 就按原生视频输入发，否则抽帧，都不行只读元信息
    // 'native'      = 只按原生视频输入发送（需要视频有 http(s) 地址）
    // 'frames'      = 只把视频抽帧成图片（需要 ffmpeg 或 frames 技能可用）
    // 'off'         = 只读元信息，**不喂画面**
    // ⚠️ 以前这个键**不存在** ⇒ `cfg.api?.videoMode` 恒为 undefined ⇒ resolveVideoRoute
    //    一律落到 'auto'。补上键本身不改行为（'auto' 就是原来的兜底），只是让旋钮真的存在。
    // ⚠️ 设置页目前**只有前三个字段的输入框**，本键仍只能手改 config.json（见 §69）。
    videoMode: 'auto',
    // ── 备选模型降级链（同上，2026-09-25 补）──────────────────────────────
    // 主模型"重试后仍失败"时，按这个数组的顺序逐个换模型再试。
    // 每项形如 `{ model: 'xxx', provider: 'provId' }`：
    //   · 写了 provider → 用那个提供商的 baseUrl + Key（跨提供商降级）
    //   · 不写 provider → 沿用主模型的 baseUrl + Key，只换模型 id
    // 留空 = 不降级（行为与补之前一字不差）。
    fallbackModels: [],
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
    // 触发策略：**这一个开关同时管两条搜图路**（2026-09-25 第十八对话合并）：
    //   · `search_image_source` —— 给一张图、问出处
    //   · `search_images`       —— 给一句话、找一批图（配 send_image 发出去）
    //   'asked' = 只在**有人明确要求**时才允许（默认，代码层判定，见 tools.js）
    //   'free'  = 交给模型自己判断（旧行为）
    //
    // 🔴 为什么合并（当天就改了一次，如实记）：第一版给"找图"单独立了一个 `keywordPolicy`，
    //    理由是"两条路的触发措辞完全不同，共用一个键会互相污染"。
    //    但界面上就成了**两个名字几乎一样**的下拉框（「搜图触发策略」/「找图触发策略」），
    //    用户当场就设错了那个（把「搜图触发策略」设成 free，然后困惑"为什么还被拦"）。
    //    ⇒ 措辞不同这件事**在代码里分两个词表就够了**，不需要变成两个开关让用户去分辨。
    //    一个"要不要让她自己判断"的开关，才是用户脑子里的模型。
    //    ⚠️ 老配置里可能残留 `keywordPolicy` —— **已不再读取**，IGNORED。
    policy: 'asked',
    // 单次运行最多真搜几次。实测一次运行能把 tracemoe/saucenao/iqdb
    // 挨个试一遍（同一张图搜 5 次），既慢又白耗 SauceNAO 的免费额度（约 200 次/天）。
    maxPerRun: 2,
    // 🆕 找图（`search_images`）单次运行的上限，与上面 maxPerRun **各算各的**：
    //    一次运行里"查出处的图"和"找新图"是两件事，两个都做是合理的。
    keywordMaxPerRun: 2,
    // ── 🆕 2026-10-05（第四十四对话 · **她自己的提案 f3bebcf7**）：单次返回张数上限可配 ──────
    //   她的原话："单次返回张数上限（默认 6，上限 12）只写在提示词和内核默认值里，
    //   管理端 GUI 上看不到也改不了，只能靠改代码或重发提示词。"
    //   ⇒ 原来这个数是**写死**在 `tools.js` 的 `Math.min(12, args.limit || 6)` 里 ⇒ 挪到配置。
    //   ⚠️ `limitMax` 是**硬上限**（她传再大也会被钳）：它是防止"一次拉 200 张"的护栏，
    //      不是建议值。想放宽就改这个键，⛔ 别去改 `tools.js` 里的钳制（那会让护栏形同虚设）。
    resultLimit: 6,
    resultLimitMax: 12,
    // ── 🆕 2026-10-05（第四十四对话 · 同一条提案）：单次运行最多**发**几张图 ──────────────
    //   0 = 不限（默认）。注意它与"找图次数上限"**不是一回事**：那个限制的是**搜**几次，
    //   这个限制的是**发**几张（一次搜索能返回多张，她可能把 limit 张全发出去）。
    //   ⚠️ 图片体积另有两道闸（`imageLimits.maxKB` / `runBytes`），不受这个键影响。
    sendMaxPerRun: 0,
    // 🆕 2026-10-04（第四十对话 · 批 1，用户拍板 Q3）：插画路**默认允许 questionable**。
    //    判定一律写 `=== false` —— 这是"默认开"的开关（写反的症状是"界面上没动过它却变成 safe"）。
    //    ⚠️ 它只是**数据层的旋钮**：群聊 safe / 私聊随你这条**政策留在提示词里**（与 get_my_usage
    //       那条"完全走提示词、代码不写死限制"同一取向）。关掉它的后果：rating 默认退回 safe。
    allowQuestionable: true,
    // ── 🆕 2026-10-05（第四十三对话）：**群聊里也允许她搜/发擦边与 R-18** ──────────────
    //   起因（真机 + 会话存档）：用户在群里说「@她 来张铃兰的色图」，她**自己把 `rating` 传成了 `safe`**，
    //   她的思考原文是："group chat rule: 群里请用 safe rating… Also '别把 questionable 的图发到群里'"
    //   ⇒ **代码一个字都没拦**，是**提示词里那两句话**让她自己退了。而用户的人设卡里明写着
    //   "用搜图工具搜 r18 图片擦边图片是允许的" ⇒ **人设卡与系统提示打架，系统提示赢了**。
    //
    //   用户 2026-10-05 拍板：做成开关（就是这个键），**默认开**（与 `allowQuestionable` 同一条口径 ——
    //   他要的就是"能发"，默认保守会让他每次装完都得先来翻一遍）。
    //   🔴 它会**同时**改**四处**给模型看的文案（⛔ 只由 `illustrationGroupR18Hint()` 一处产出）：
    //      `search_images` 的 rating 参数说明 / 返回里的 tip / 提示词的【插画的分级】与【插画搜到之后】。
    //   ⚠️ 开着 ≠ 一定发得出去：QQ 侧对露骨图有拦截，**有概率被吞或对方看不到** ⇒
    //      提示词要求她**如实说、别保证**（这一条与开关无关，永远在）。
    allowR18InGroup: true,
    // 🆕 2026-10-04（第四十对话 · 批 1，用户拍板 Q4）：中文 → booru tag 的**配置扩展**。
    //    映射型（`{"我的角色":"my_tag"}`），键**覆盖**内置种子的同名键 —— 与 `api.modelPrices`
    //    的既有形状一致。⛔ 本轮不做界面（用户拍板"配置项越少越好"）：直接在 config.json 里加。
    //    内置种子在 `src/web-search.js` 的 ILLUSTRATION_TAG_SEED（约 80 条常见角色/作品）。
    extraTags: {},
    // 可选：SauceNAO 官方 API Key（注册 saucenao.com 账号免费获取）。
    // 填了走官方 JSON API（稳定、免费额度约 200 次/天）；留空走匿名网页抓取兜底。
    saucenaoApiKey: '',
    // ── 🆕 2026-10-05（第四十三对话 · 交接 §3-113）：pixiv **登录态的会话 cookie** ──────
    //   为什么要它：匿名访问 pixiv 时 `mode=r18` 会被**静默忽略**（2026-10-04 真机实测
    //   `xRestrict` 恒为 0）⇒ 想搜到 R-18 **必须**带登录态。用户已拍板"用备用号，封了无所谓"。
    //
    //   🔴 怎么给：**你自己在「设置 → 搜索服务」里粘**（界面上那一格），别写进源码或交接文档。
    //      格式就是浏览器里那串（至少要有 `PHPSESSID=…`；要完整的话把 Cookie 头整串粘进来）。
    //      ⛔ 它**不会**出现在 `GET /api/config` 的返回里 —— `cookie` 命中 app.js 的
    //      SECRET_KEY_PATTERN ⇒ 服务端删字段、只回一个 `hasPixivCookie` 布尔（与 API Key 同一套）。
    //
    //   🔴 它**只发给 `*.pixiv.net` / `*.pximg.net`**（`safe-fetch.js` 的 `isPixivHost()` 按 host 注入）：
    //      `cookie` **不在** `ALLOWED_OVERRIDE_HEADERS` 里 ⇒ 调用方**永远**没法自己指定它，
    //      也就不可能把这份凭据带到别的站（防 SSRF / 串站，那条纪律一个字没动）。
    //
    //   ⚠️ 维护成本（如实写在这儿）：登录态是 **cookie 会话**，会过期；pixiv 登录流带
    //      reCAPTCHA（可能还有 2FA）⇒ **自动重登基本不可行，掉线只能你本人手动重贴一次**。
    //      ⛔ 别把它做成"看起来会自动续期"的样子 —— 那正是本项目最忌的静默失效。
    pixivCookie: '',
    // Cloudflare 自动绕过：被弹人机验证时，先用内置 Chromium 网络栈重试，
    // 仍被拦则开隐藏窗口自动完成 JS 验证（仅限搜图引擎域名白名单）。
    cfBypass: true
  },
  // ── 「别处的我」：她能不能看自己在别的会话里什么样（2026-10-04 第四十对话 · 批 3）──────
  //   提案 789584d1 的后半条 + 用户 2026-10-03 定的边界（**只在私聊能调、别处的事不许带过来**）。
  //   边界本身在 `src/tools.js` 里做死（chatKey 都不给），这里只管三件事：
  //   **给不给这个能力 / 给谁 / 看几天**。
  //   🔴 `enabled` 是**默认开**的开关 ⇒ 判定一律写 `=== false`（写反成 `!== false` 会变成
  //      "没这个键就不给"，本项目把这类记为"接线正确 ≠ 行为改变"）。
  selfElsewhere: {
    enabled: true,
    // 'private'   = 任何私聊（= 这个能力上线时的行为）
    // 'ownerOnly' = 只认 ownerIds 里的号
    whoCanAsk: 'private',
    // 默认看几天。工具入参 `days` 覆盖它；**两边都钳 1~30**（界面/工具/配置三道都不互相信任）。
    days: 7,
    // 🆕 2026-10-04（第四十二对话 · 调研 §3）：界面**已给输入框**（设置 → 她的能力 →
    //    「管理员 QQ 号」，与白名单同一套芯片控件；用户撤销了第四十对话 Q6 的「先不填号」）。
    //    ⛔ 默认值**永远是空数组** —— 别把任何人的号写死在这里
    //       （那等于源码里带一份身份信息，换个人用就成了别人的号）。
    //    填了号**还要** `whoCanAsk='ownerOnly'` 才真的收紧；
    //    而 `whoCanAsk='ownerOnly'` + 这里是空数组时 ⇒ 行为**如实退回 `private`**
    //    （⛔ 不许静默变成"谁都调不到"），设置页那一节会写明这件事。
    ownerIds: []
  },
  // ── 她自己的「用量 / 花费」自检（2026-09-26 第二十四对话，提案 f789b40e）──────────
  // 提案原话：「给我加一个只读的『余额/用量自检』能力，被问到的时候能当场报出来。」
  // 起因：2026-09-25 02:20 群里有人问「api 余额还有多少能看见吗」，她只能答"看不见"。
  //
  // 定位：**只读**。她只能"看"，不涉及任何写权限（与提案队列同一取向）。
  //
  // ⚠️ 行为边界（用户 2026-09-26 拍板）：**完全走提示词，代码里不写死任何限制** ——
  //    "想不想看、想不想在群里说，全凭她自己的判断和心情，你拥有完全的自主权"
  //    （那句原话写在 `src/tools.js` 里 get_my_usage 的 description 里）。
  //    代码只守三件不可逆的事（用户原话："这不叫限制她，叫保护她"）：
  //      ① 只返回数字，⛔ 绝不返回 Key / 账号等敏感信息（出口白名单，见 tools.js）；
  //      ② 缓存 + 单轮限频，别让她被群友刷屏架在火上烤；
  //      ③ 查不到就说"读不到"，⛔ 绝不打成 0。
  //
  // ⚠️ 默认关：用户要求"手动开关"，开关在控制台「用量与成本」页上（勾了立即生效）。
  // 🔴 判定必须用 `=== true`（`!== false` 是"默认开"那套的写法）。写反的症状是
  //    "界面上关了它还在跑"——本项目把这类毛病记作"接线正确 ≠ 行为改变"。
  usage: {
    enabled: false,
    // B 档：允许她查**余额**。只支持 'off' | 'deepseek'（默认 off）。
    // 为什么只有一个渠道：DeepSeek 有公开的 GET /user/balance；stepfun / sensenova /
    // tokenrhythm / xiaomimimo 各家接口与口径都不同 ⇒ 一律如实说"查不到"，不猜。
    // ⚠️ 请求 URL **只从 `api.baseUrl` 同源派生**，⛔ 不接受任何"可配置的余额查询 URL"
    //    （那等于把 API Key 送到任意地址）。
    balance: 'off',
    balanceCacheSeconds: 60,   // 余额结果缓存（秒）。本机口径（token/花费）**不缓存**，见 tools.js
    maxPerRun: 1,              // 单次运行最多查几次（挂在 ctx 上，只属于本次运行，不落盘）
    lowThreshold: 0            // 0 = 不提示；>0 时只在工具返回值里多一句，⛔ 不进系统提示
  },
  // 「核心记忆」（2026-09-26 第二十五对话，提案 c7486672）：她自己挑一段舍不得删的聊天记录，
  // **原样**存下来（不压缩、不改写），独立于会话存档 —— 上下文记忆被删掉时它还在。
  // 数据在 `data/core-memories.json`（与会话存档 `messages/` 无关，这是它存在的唯一理由）。
  // 🔴 2026-10-06（第四十七对话 · 用户拍板 B2）：**这里原来有一个 `enabled` 总开关，已废弃**。
  //    用户原话："记忆系统没必要做阻拦" ⇒ 核心记忆**常开**。
  //    ⚠️ 那道闸原来还是"半硬"的：关掉只是把四个工具撤了，**相册照旧每轮注入**、
  //       系统提示照旧教她调 `save_core_memory`（等于教她调一个不存在的工具）。
  //       ——用户拍板的是"**把开关删掉**"，⛔ 不是"把它修成硬开关"。
  //    ⚠️ 老 `config.json` 里残留的 `coreMemory.enabled:false` **一律视为开**（全仓已无读取点）；
  //       `deepMerge` 不会把那个键从盘里抹掉 ⇒ ⛔ 别写成"会自动清掉"。
  //    ⚠️ `.inject` / `.injectMaxChars` / `.crossChat` 三个键**照旧有效**（它们管的是"注入什么"，
  //       不是"允不允许"）—— 别顺手一起删。
  coreMemory: {
    // 🆕 2026-10-03（第三十五对话，用户拍板）：**每轮唤醒把「目录」注入提示词**。
    //    为什么必须有它：实测她**一次都没调用过**那四个工具（交接 §3-43 / §107）——
    //    光有工具没有注入，等于"相册存在、但她自己不知道里面有什么"。
    //    关掉它 ⇒ 工具照旧能用，只是一个字都不注入（与 openerHint/anchorHint 同一个理由：
    //    归因实验要能单独隔离这一股力）。
    inject: true,
    // 🆕 注入块的**字符预算**。**0 = 不设限**（用户 2026-10-03 的选择）。
    //    >0 时的优先级是"**先保目录**"—— 目录是索引，砍成半张索引等于没有索引；
    //    装不下的"当前会话原文"逐段丢掉，并**如实写明丢了几段**（⛔ 不静默截断）。
    //    ⚠️ 单位是**字符数**，不是 token；相册页顶部会如实显示"本次注入约 N 字"。
    //    ⚠️ 只有这一个键同时管提示词与页面上的那个数字（⛔ 别在页面里另算一份）。
    injectMaxChars: 0,
    // 🆕 2026-10-03（第三十六对话，用户拍板）：**跨会话按人召回**。
    //    开（默认）⇒ 除了"当前会话的原文"，还会把**别的会话里、和这一轮在场的人有关**
    //    的那几段也注入（单开一块，跟在【记忆】之后），并自带"别主动拿到这里提"的引导语。
    //    关 ⇒ 只注入当前会话的原文（= 2026-10-03 之前的行为）。
    //    ⚠️ 按人召回**只认带平台的身份键**（`qq:<id>` / `wechat:<id>`）——
    //       QQ 与微信的数字 id 会撞号，只比数字会把两个不同的人当成一个（那是硬纪律，见 core-memory.js）。
    //    ⚠️ 与 `inject` 的分工：`inject=false` 是"一个字都不注入"，这个只管"要不要跨会话那半"。
    crossChat: true
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
  // ── 代理（2026-10-04 第四十一对话 · 内置代理批 A/批 B）────────────────────
  // 拍板依据：`回执-内置代理拍板结果与执行须知-20261004.md`（V1 只做 (A)：
  // **只让 QQ Agent 自己的出网请求走代理**；(B) 整机 VPN 不做）。
  //
  // 🔴 **分流白名单制**（回执 §四 须知 4）：`mode:'off'`（默认）⇒ 一切照旧；
  //    `byRule` ⇒ **只有命中 `rules` 名单的目标**走代理，其余一律直连。
  //    ⛔ 刻意**不做**"全局代理 + 排除名单"：那会把 DeepSeek API、本机 SearXNG、
  //    OneBot（3000/3001）、微信中继（11230）一起塞进代理 —— 而它们走代理不仅没必要，
  //    还会把"机器人连不上自己的网关"变成一个看不出原因的故障。
  //
  // ⚠️ 默认 `mode:'off'` + 空规则 ⇒ **本段的存在不改变任何现有行为**
  //    （判据钉住"没配代理时逐字节等价于现在"，见 `测试-现行\test-代理分流与隧道.mjs`）。
  // ⚠️ `http` 这一格里**不许**写用户名密码（URL 里带凭据会被 parseProxyEndpoint 拒掉）——
  //    凭据走 `user`/`password` 两格，其中 `password` 命中 app.js 的 SECRET_KEY_PATTERN
  //    ⇒ GET /api/config 会把它删掉只留 `hasPassword` 布尔（与各家 API Key 同一套保护）。
  proxy: {
    mode: 'off',                       // 'off' = 不启用（默认）| 'byRule' = 按 rules 名单走代理
    http: '',                          // 形如 http://127.0.0.1:3067（karing 混合端口默认填这个）
    user: '',                          // 代理认证用户名；留空 = 无认证
    password: '',                      // 代理认证密码（GET /api/config 不返回，只回 hasPassword）
    rules: [
      // 默认都是"本机直连不通、必须走代理"的站。`*.x` 与 `x` 等价（支持子域，见 hostMatchesRules）
      '*.pixiv.net', '*.pximg.net', '*.dlsite.com',
      'trace.moe', 'saucenao.com', 'ascii2d.net', 'iqdb.org', 'soutubot.moe'
    ]
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    // ── 浏览锁定：把"她能浏览哪些域名"收成显式白名单（吸收自上游 0.4，2026-09-20）──
    // 默认 **不启用**（enabled !== true ⇒ 一律放行），所以加了它不改变现有行为。
    // 启用后：hostAllowed 支持子域（白名单有 example.com 时 img.example.com 也放行，
    // 否则一个图床的 CDN 域名就把正常使用挡死）；但反向不成立。
    // ⚠️ 开了锁定但 hosts 为空 = **全部拒绝**（比"全部放行"安全）。
    // 生效点在 safe-fetch 的三个入口：safeFetch / safeFetchBinary / safeFetchBinaryToFile，
    // 且**逐跳校验**重定向目标（否则白名单形同虚设）。
    browseLock: {
      enabled: false,
      hosts: [],
      siteSearchUrl: ''
    }
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
  // 微信接入（2026-09-20 第八对话加）—— 走"中继"这条 OneBot v11 通道。
  //
  // 链路（详见 工具-中继/README.md 与 事件映射实测结论.md）：
  //   微信 ⇄ WeFlow(读) + AstrWeChat Bridge(读+UIA 发送) ──反向 WS──→ 中继 ──→ 本应用
  // 本应用只是**再连一个 OneBot 客户端**到中继：WS 收事件、HTTP 调 API。
  // 为什么能这么接：Bridge 推的就是标准 OneBot v11（实测事件形状见上面那份文档），
  //   所以事件顺着现成的 handleOneBotEvent 流进同一套 store / 编排器，不用改架构。
  //
  // ⚠️ 默认关闭。开启前必须先把中继与 Bridge 跑起来，否则会不断重连（有退避，无害但刷日志）。
  wechat: {
    enabled: false,                        // 总开关
    wsUrl: 'ws://127.0.0.1:11230/ws',      // 中继给 agent 的事件口
    httpUrl: 'http://127.0.0.1:11230',     // 中继给 agent 的 API 口
    accessToken: '',                       // 中继不校验（本机回环）；留作将来收紧
    autoLaunchRelay: false,                // 🆕 已接线（2026-09-20）：true = app 启动时自动拉起整条微信通道
    // 🆕 自动拉起通道时，要不要顺手把 WeFlow 也点着（默认 true）。
    //    默认 true 的理由：WeFlow 没开时，通道会**起来得完全正常**（中继在跑、Bridge 也连上），
    //    只是永远收不到消息 —— 这是本项目最忌的"看着成功其实是空的"。
    //    想自己手动管 WeFlow 的，把它设成 false。
    autoLaunchWeFlow: true,
    // 🆕 「微信」页签用：通道启动脚本（跑微信通道.mjs）的路径。
    //    留空 = 自动找（开发布局在工作区「工具-中继」里；打包布局应随 app 分发）。
    //    为什么要可配：开发机与别人机器上的目录结构不一样，写死必然有一边找不到。
    channelScript: '',
    // 🆕 WeFlow 的可执行文件路径（第三方 GUI 应用）。只用于"没跑就替用户点一下火"，
    //    我们**不打包分发它**（见 分析-微信接入插件化与分发评估.md）。
    weflowExe: ''
  },
  // 控制台界面的偏好（纯显示层，不影响任何后端行为）
  //
  // 🆕 2026-10-06（第四十六对话 · 第三方报告复核）：这里原来是**两个** `ui:` 顶层键 ——
  //   本处（只写 `mode`）会被下面第 75x 行那个（写 theme/showVision/refreshMs）**整块覆盖**
  //   （对象字面量后写赢），于是 `ui.mode` 的默认值**实际不存在**：`DEFAULT_CONFIG.ui.mode`
  //   是 `undefined`，只靠消费方自己回落 `'qq'` 才没出事。
  //   ⇒ 现在两块**合并到一处**（保留下面的定义，`mode` 搬过去），默认值是真的存在了。
  //   ⚠️ 别再新增第二个 `ui:` —— 后写覆盖是静默的，而 `ui.mode` 这种"只影响显示"的键
  //      正缺判据，坏了也看不出来。
  // ── 人设与行为 ──────────────────────────────────────────────────────────
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
  // ⚠️ UI 改造第二阶段 条目 6：新增**可选**字段 `allow.mode`（三选一）。
  //
  // 🔴 **默认值里故意不给 mode** —— 这一点踩过坑，别"顺手补上"：
  //    用户的 config.json 是被 `deepMerge(DEFAULT_CONFIG, 用户配置)` 合并出来的。
  //    只要默认值里有 `mode: 'denyAll'`，**所有没有这个键的老配置都会凭空获得它**
  //    ⇒ 老配置从"列表+allowAllWhenEmpty 推导"变成"绝对禁止所有"，
  //    "把一个新人加进白名单"这件事直接失效（denyAll 是绝对的）。
  //    实测：test-微信联系人可见.mjs 的「放行后微信消息进了 store」就是这么红的
  //    （它给的正是 `allow:{private:[],group:[]}` 这种"还没配"的老形态）。
  //
  //    没有 mode ⇒ `allowed()` 落回旧推导语义 ⇒ 与升级前一字不差。
  //    mode 只在用户在界面上**显式选三选一并保存**时才写进配置。
  //    判定见 src/app.js 的 `allowed()`；为什么不自动迁移见 `migrateAllowMode()` 的注释。
  //
  //    mode 的三个取值：
  //      'allowAll'  全部允许（但 deny 名单仍然优先 —— 黑名单是独立否决权）
  //      'denyAll'   谁都不许
  //      'whitelist' 只运行在白名单（名单为空 = 谁都不许，这是"白名单"的自然含义）
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
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    // ── 发**图片**那一档的超时（2026-10-05 第四十三对话 · 交接 §3-111）────────
    //
    // 🔴 为什么必须单独一档，而不是把全局的 15 秒调大：
    //   文字那条路（`send_message`）只把一串文本 POST 给协议端，15 秒绰绰有余；
    //   而**图片**那条路是"协议端把图收下 → 上传到 QQ" —— 实测（交接 §3-111 的证据链）
    //   1.9MB 的原图 / Safebooru 的 2~5MB 图**必然**超过 15 秒，报的就是
    //   `The operation was aborted due to timeout`；同一条路发 **Safebooru 的图也超时**
    //   ⇒ 与"是不是 p 站"无关，是这条路本身太紧。
    //
    // ⚠️ 但它**不能**直接把全局默认改成 60 秒：`get_status` / `get_friend_list` /
    //   `get_msg` 这些探测类调用也吃那个默认值，一改就会从"卡住立刻报错"变成
    //   "静默白等 60 秒"（本项目最忌的一类：把报错变成变慢）。而一轮对话有总时长预算。
    //   ⇒ 按"**图片单独一档**"改：只有图片（含表情包 —— 它走的就是同一个报文）走这个值。
    //
    // ⚠️ 表情包**一并**走这一档是有意的：`sendSticker` 在 `onebot.js` 里就是转发到
    //   `sendImage`（同一个 `{type:'image',data:{file}}` 报文），而它上传的本地缓存 GIF
    //   实测有 2~8MB ⇒ 同样会被 15 秒咬到（§3-92 那个 63% 失败率里很可能就有它）。
    //   分两档反而会让"同一种物理动作"出现两种行为（同一族坑：默认值有两个真相源）。
    imageTimeoutMs: 60000,
    // ── 发送去重窗口（2026-09-25 第十八对话加，移植上游 0.4 的同名键）──────────
    // 同一会话、同一段**发出去的纯文本**在这么多毫秒内重复出现时，只发第一条。
    // 防的是：模型重复调用 send_message、或 OneBot 超时看似失败而上层重试 ⇒ 用户看到两条一样的。
    //
    // ⚠️ 语义边界（写清楚，免得下一棒误用）：
    //   · 只拦**完全相同**的文本（mdToPlain 之后、按 hardSplitAt 切分之后的每一段）；
    //   · **只有真正发成功后**才记指纹 ⇒ 合法重试（上次真失败了）不会被误杀；
    //   · 窗口是"每条会话各自一份"，不跨会话；
    //   · 不作用于表情包 / 拍一拍（那两条各有自己的通道与限频）。
    // 想关掉就设 0（**0 是明确的关闭值**，不会回落默认 —— 见 sender.js 的 #dedupeWindow）。
    dedupeWindowMs: 8000,
    // ── 拍一拍限频（2026-09-21 第十对话加）──────────────────────────────
    //
    // 起因：原来**完全没有代码级限频** —— 只靠人设里"别频繁"这句定性约束，
    //      而 `send_poke` 工具里一个计数都没有 ⇒ 理论上可以连拍骚扰。
    //      （这条在待办表里挂了很久，一直写着"属行为取舍，要问用户"。）
    //
    // ⚠️ 阈值刻意**放松**，理由：人设里"像真人手贱一下反而更拟真"是**有意保留**的气质，
    //    限频是防骚扰的兜底、不是把她的皮劲儿掐掉。所以宁可宽，不要把她管成机器人。
    //    10 分钟 3 次 / 同一人 10 分钟 2 次，正常拟人交互根本碰不到。
    //
    // ⚠️ 触顶时的行为：**抛错并把原因回给模型**，不是静默丢弃。
    //    静默丢弃正是本项目最忌的"看着做了其实没做"（她会以为自己拍过了）。
    //    错误话术由 `sender.js` 的 describePokeLimit 生成，是对她说的、不是给用户看的。
    //
    // 想完全不要这个限制：把两个数都设成 0 即可（0 = 不限）。
    poke: {
      maxPerChatPer10Min: 3,     // 同一个会话 10 分钟内最多拍几次（0 = 不限）
      maxPerTargetPer10Min: 2    // 同一个人 10 分钟内最多被拍几次（0 = 不限）
    }
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
    // 🆕 2026-10-06（第四十七对话 · 用户拍板 B3①）：**这里原来有一个 `enabled` 总开关，已废弃**。
    //    用户原话："表情属于聊天系统，随便她发" ⇒ 表情包**常开**，不再有这道闸。
    //    ⚠️ 老 `config.json` 里残留的 `sticker.enabled:false` **一律视为开**（全仓已无读取点），
    //       而 `deepMerge` **不会**把那个键从盘里抹掉 —— ⛔ 别在文档里写成"会自动清掉"。
    //    ⚠️ 要限制她能发什么/收什么，走 `collectEnabled`（收藏）或**平台判断**，⛔ 别把这个键加回来。
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
  // 机器人提交的「改进提案」队列（2026-09-19 第七对话新增）。
  //
  // ⚠️ **这是提案，不是配置，更不是能自动执行的东西。**
  //    设计边界（用户 2026-09-19 拍板）：**她可以提议任何事**（记忆 / 人设 / 功能 / 底层），
  //    **但没有任何东西会自动生效** —— 提案只是写进 `data/proposals.json`，
  //    由管理员在「记忆」页顶部的待审区里看，人工决定怎么做。
  //    为什么坚持不自动执行：她的上下文里**混着群友说的话**，
  //    而"待审条目本身"就是一条注入通道（有人可以诱导她提交一条看起来无害的改动）。
  //    要开自动执行，必须逐类设计白名单 + 限路径 + 备份，见 待办与决策记录.md。
  proposals: {
    enabled: true,      // 关掉后 submit_proposal 工具会拒绝（并说明原因）
    maxPending: 50      // 队列上限：满了就拒收，防她刷屏把待审区塞爆
  },
  // 扩展（skills/ 与 plugins/）的全局设置。
  // ⚠️ 这个键**原先不在 DEFAULT_CONFIG 里** —— 手写 config.skills 曾被"内存态陈旧"的
  //    一次 updateConfig 覆盖掉，看起来就像"新键被吃掉了"（项目记忆 §0 铁律 13）。
  //    现在把它显式登记在这里：既让默认值有来源，也让"扩展有哪些全局开关"一眼可见。
  //    ⚠️ 新增全局开关时**必须加进这里**，否则页面读不到、也没法在设置页展示。
  skills: {
    // 热重载：放进 skills/ 或 plugins/ 的扩展会被自动 import 执行（500ms 防抖）。
    // 2026-09-19 用户明确批准默认开启；设成 false 则只能靠技能页的「刷新」按钮。
    hotReload: true,
    // 「换个开头」注入（prompt.js 的 recentSelfOpeners）：
    // 检测到它自己最近反复用某几个开口词时，在【此刻状态】里把那几个词摆给它看、要求换一个。
    // ⚠️ 为什么要有这个开关：**归因实验需要单独隔离它**。
    //    2026-09-19 实测过——人设卡与这个注入同时生效时，两股力分不开，
    //    上一棒就是因为"按小窗口切数据"得出了 p=0.006 的假显著（全量复核 p=0.090）。
    //    要判断到底是卡的作用还是注入的作用，必须能单独关掉一个。
    // 默认 true（保持现状行为）。
    openerHint: true,
    // 「反锚点」注入（prompt.js 的 contextAnchors）：
    // 检测到**这一轮的上下文**里某几个词被短时间反复提到时，在【此刻状态】里提一句
    // "这几个词已经被说很多遍了，别被它们带着走"（提案 a5fbf828，她的原话"软降权或提醒"）。
    // ⚠️ 与 openerHint 同一个理由要有这个开关：**归因实验需要单独隔离它**。
    //    「她的话变单一」有两个可能的来源（自己的口癖 / 被上下文的锚点带着走），
    //    要判断到底是哪一个，必须能单独关掉一个。
    // 默认 true。⛔ 这个开关**只关提醒**，从来不是"禁用某些词"的开关（代码里没有任何禁词逻辑）。
    anchorHint: true
  },
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
    share: {},

    // ══ 按会话自由成组的「记忆互通」（2026-09-20 第九对话加，用户要求）══
    //
    // 与上面的 `share`（按 QQ 号 = 按人）是**两条独立的轴**，可以并存：
    //   · `share`  = "**这个人**在别处的印象也并进当前会话"
    //   · `groups` = "**这几个会话之间**的记忆互通"
    //
    // 用户 2026-09-20 的原话要点：
    //   "全互通，可以自由选择组合…… qq 可以通微信，微信可以通 qq，
    //    同一个人在不同的群也能通，但是要让她知道记忆印象来自哪里以及属于谁，
    //    不以名字而是以 id 为准，名字为辅，微信侧则是以名字为主，
    //    因为微信通常是固定备注不会变"。
    //
    // 数据形态：`groups` 是**组名 → 会话列表**的映射，每组是若干 chatKey
    // （`group:123` / `private:456`；微信侧同样是 `private:<派生数字id>`）。
    //   { "家人": ["private:1000000002", "group:1098345913"], "同事": [...] }
    // 一个会话可以同时属于多个组（并集生效）。
    //   ⚠️ 用对象而不是数组：组名要能显示在 UI 上，且改名不该打乱已有成员关系。
    groups: {},

    // 全互通开关：true 时**忽略 `groups`**，所有会话合成一个池子（跨平台、跨类型）。
    //   ⚠️ 默认 **false**：全互通意味着 A 私聊里的事可能出现在 B 私聊里 ——
    //      这是用户明确要的能力，但"默认打开"会让没配置过的人凭空跨人泄露，
    //      所以默认关，由用户在「记忆」页显式打开。
    //   （原来这里还设计过一个 `"__all__"` 哨兵键，已去掉 —— 与这个开关重复，
    //     两个入口做同一件事只会让"到底哪个在生效"变难查。）
    unified: false,

    // 同一个人的印象跨会话可见的范围（只在**没有**把它放进任何组时才起作用）：
    //   'off'          = 各聊各的（**默认** —— 三个新开关全部默认关，装完不会凭空改变任何人的可见范围）
    //   'samePlatform' = 同平台内，同一个人的印象互通（QQ 自己通、微信自己通，不跨平台）
    //   'all'          = 同一个人的印象**全平台**互通（QQ 私聊里认识的他，微信里也认得）
    //   ⚠️ 只管**同一个人**（按 id 认），不会把别人的印象带过来 —— 那是 `groups`/`unified` 的事。
    //   ⚠️ 为什么不默认 'samePlatform'：那等于"同一个人在所有群里的印象并进他的私聊"，
    //      实测会把私聊专属的内容（例如"走前说爸爸爱你"）带进群聊语境 —— 是真实的泄露，
    //      而它只该发生在用户明确打开之后。默认关 = 与改动前行为逐字一致（回归可证）。
    unifiedMembers: 'off',

    // ══ 「同一个人」身份表（2026-09-20 第九对话加，用户要求）══
    //
    // 解决什么问题：`unifiedMembers` 原来是**按 id 字面相等**合并的，
    //   而 QQ 号与微信派生 id **在同一个数值空间里**（微信 id 是桥派生的 31 位数字：
    //   AstrWeChat `state.py` 的 `blake2s(wxid) % (2**31-1) + 1`）
    //   ⇒ ① 同一个真人两边 id 不同，**永远合不上**
    //        （实测线上就是这个状态：跨平台一对都没合上，只帮到了"同一个 QQ 号在多个群"）；
    //      ② 哪天微信 id 撞上一个真 QQ 号，就会把**两个毫不相干的人认成同一个**。
    //
    // 所以改成**人工声明**：这张表说"这两个 id 是同一个人"。
    //
    // 🔴 键**必须带平台**：`"<platform>:<userId>"`（`"qq:1000000002"` / `"wechat:1000000001"`）。
    //    为什么不能只用数字：QQ 与微信的 id 会撞号（上面 ②），
    //    不带平台的键会把两个平台的同名数字当成一个人 —— 那正是要修的 bug。
    //
    // 值是**人身份 id**（任意稳定字符串；多人共用一个值即表示同一人）：
    //   { "qq:1000000002": "p_1", "wechat:1000000001": "p_1" }   ← 这两个 id 是同一个人
    // 为什么用"值"而不是"把人分成若干组"：改名/换备注不影响它（id 稳定）；
    // 解除关联就是删掉对应键。
    // 刻意**不做自动推断**：空值 / 非法值一律当"没声明"，宁可退回"各聊各的"，也不要猜错人。
    identity: {}
  },
  // ── 空闲「梦」：夜里没人说话时，把当天的事整理成一条笔记 ──
  // **只读**：这次模型调用一个工具都不给，所以它改不了记忆、碰不了人设卡、发不了消息
  // （为什么坚持只读，见 src/dream.js 开头）。笔记存在 data/dreams.json，在「笔记」页看。
  // 默认关：它每天要花几分钱，而且是个有性格的功能，该由你决定开不开。
  dream: {
    enabled: false,
    startHour: 2,          // 时段起点（含）
    endHour: 6,            // 时段终点（不含）；start > end 表示跨零点
    minIdleMinutes: 60,    // 要求"安静了多久"才做 —— 免得趁人说话时插进来自言自语
    // ── 取材配额（2026-09-19 第七对话新增，治"赢者通吃"）──────────────────
    // 起因（实测）：原来只有一个全局 8000 字预算，谁在目录顺序里靠前谁吃光，
    // 实测 11 个会话里只有 2 个进了提示词、其余 9 个（含 5 个私聊）一条都没有；
    // 而且进的那两个取的是"当天最早那一段"（recent(400) 再筛今天 ⇒ 当天前半截会丢）。
    // ⇒ 现在每个会话有自己的配额，并且会话内部**在全天范围里均匀取样**，不再是"取尾再筛今天"。
    perChatMinChars: 150,  // 每个会话至少给它这么多字（只要它有当天消息）—— 防小会话被饿死
    perChatMaxChars: 1500, // 每个会话最多这么多字 —— 防一个话痨群吃光全局预算
    maxInputChars: 20000   // 全局上限（原 dream.js 里的常量，挪进来以便调节）
                           // ⚠️ 2026-09-19 用户拍板从 8000 提到 20000：实测改后每次只用 4658 字，
                           //    离上限很远；提到 20000 是为了让"话特别多的日子"不被截断。
                           //    代价：一天一次、多花几分钱。真嫌贵就调回 8000，改完立刻生效。
  },
  // 桌面端/控制台
  server: {
    port: 3210,
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 当前看哪个平台：'qq' | 'wechat'。**只影响显示** —— 两个平台的后端都照常跑。
    // 为什么要有它：接入微信后同一个控制台要同时管两边，而"切过去看"与"停掉另一边"
    // 是两件事，用户明确要的是前者（2026-09-20 拍板）。
    // ⚠️ 这个键**曾经**因为"两个 ui: 顶层键、后写覆盖"而实际不存在（见上面那段注释）；
    //    2026-10-06 合并之后它才真正有了默认值。
    mode: 'qq',
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
  } catch (error) {
    // ⚠️ 这里绝不能"静默回退默认值"：配置坏了 → 返回默认值 → 任何一个
    // updateConfig/scheduleConfigSave 都会把**整份默认配置**原子写回
    // （tmp + rename），用户真实的 API key、触发词、机器人别名、人设改动
    // 就被永久覆盖，而且没有任何报错。所以先把坏文件改名留档，再回退。
    // 只在"读到了文件、但解析不出来"时留档：文件不存在是首次运行；
    // 而 EACCES/EBUSY 这类**读都读不到**的情况，说明我们既没读到内容、
    // 多半也重命名不动它（真重命名成功反而更糟），交给用户自己处理。
    const parseFailed = error instanceof SyntaxError;
    let backup = '';
    if (parseFailed && fs.existsSync(CONFIG_FILE)) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      try {
        backup = `${CONFIG_FILE}.corrupt-${stamp}`;
        fs.renameSync(CONFIG_FILE, backup);
      } catch (moveError) {
        backup = '';
        console.error('[config] 配置损坏且留档失败:', moveError?.message ?? moveError);
      }
    }
    console.error(
      `[config] 配置读不出来，已按默认值启动：${error?.message ?? error}` +
      (backup ? `；原文件已留档 ${backup}（改好它再重启，别让后台任务把默认值覆盖回去）` : '')
    );
    return structuredClone(DEFAULT_CONFIG);
  }
}

let currentConfig = null;
let saveTimers = new Map();

/**
 * 🆕 2026-09-25（第二十一对话，交接 §3 待办 7）：**上一次配置写入是谁发起的**。
 *
 * 为什么需要（回归里那条警报一直分不清真信号还是噪声）：
 *   跑回归时，"线上配置保护"报过一次「线上配置被测试改动了：`memory`」——
 *   而它很可能是**应用自己**写的（那"还原"就是把一次合法写入退了回去）。
 *   原来没有任何字段能回答"这次写入是谁干的" ⇒ 只能当噪声，或者反过来冤枉测试。
 *
 * 怎么做的：`updateConfig()` 每次写入时把调用点记在这里，并**顺手打一行日志**。
 *   ① `source` 显式传入 ⇒ 用它（调用方最清楚自己在干什么）；
 *   ② 没传 ⇒ 取**第一个不在本文件里的栈帧**（= 真正发起写入的那个模块:行号）。
 *   ⛔ 刻意**不做栈遍历之外的任何猜测** —— 也不去猜"是测试还是应用"
 *      （那要靠调用点自己说，工具只负责如实记录）。
 *
 * 怎么用：`import { configWriteSource } from './src/config.js'` 读它；
 *   或看日志里那行 `[config] 写入来源 …`。
 */
let lastWriteSource = null;

/** 取第一个不在 config.js 里的调用栈帧，形如 `src/app.js:1703`。 */
function callerFrame() {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  let lines = [];
  try {
    lines = String(new Error().stack || '').split('\n');
  } catch { /* 拿不到就算了 */ } finally {
    Error.stackTraceLimit = prev;
  }
  // frames[0..1] 是 "Error" 与本函数自身
  for (let i = 2; i < lines.length; i++) {
    const m = lines[i].match(/\((.*?):(\d+):\d+\)\s*$/) || lines[i].match(/at\s+(.*?):(\d+):\d+\s*$/);
    if (!m) continue;
    let file = m[1];
    // 🔴 ESM 的栈帧给的是 `file:///E:/dsh%E5%B7%A5...`（**百分号编码**）。
    //    直接记下来会得到一串看不懂的百分号 —— 而这条日志存在的唯一目的就是**给人看**。
    //    项目坑 §4-9/§57.1：中文路径的 file URL 必须解回来。
    if (file.startsWith('file://')) {
      try {
        file = fileURLToPath(file);
      } catch {
        try { file = decodeURIComponent(file.replace(/^file:\/\/\/?/, '')); } catch { /* 保留原样 */ }
      }
    }
    file = file.replace(/\\/g, '/');
    if (/(^|\/)config\.js$/.test(file)) continue;      // 跳过本文件自己的帧
    const short = file.split('/app/').pop() || file.split('/').slice(-2).join('/');
    return `${short}:${m[2]}`;
  }
  return '未知（拿不到调用栈）';
}

/** 上一次配置写入的来源（`{ at, source, keys, explicit }`），从没写过则为 null。 */
export function configWriteSource() {
  return lastWriteSource;
}

/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。
 *
 * @param {object} patch    要写进去的那一小块
 * @param {string} [source] 🆕 **谁在写**（交接 §3 待办 7）。不传则从调用栈取。
 *                          调用点知道自己在干什么时应该显式传，例如 `'api:/api/allow'`、
 *                          `'boot:sliderToTier'`。显式值会原样记进日志与 `configWriteSource()`。
 */
export function updateConfig(patch, source) {
  // 🔴 记录"谁在写"必须放在**最前面**：哪怕后面写盘抛错，也留下了"是谁发起的"。
  const keys = Object.keys(patch || {});
  const explicit = typeof source === 'string' && source.length > 0;
  const from = explicit ? source : callerFrame();
  lastWriteSource = {
    at: new Date().toISOString(),
    source: from,
    keys,
    explicit,
  };
  // 🔴 必须走 **stderr**：本项目有测试是**跑一个进程、把它的 stdout 当 JSON 解析**的
  //    （`test-配置损坏留档.mjs` 就这么干）⇒ 往 stdout 打一行日志会把那类判据打成
  //    `Unexpected token '['` 这种假红。本文件里其它诊断（配置损坏等）本来也走 stderr，保持一致。
  console.error(`[config] 写入来源 ${from}${explicit ? '（调用方显式声明）' : ''}；patch 顶层键=[${keys.join(', ')}]`);

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
  if (!/^(group|private):\w+$/.test(key)) return store;
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
