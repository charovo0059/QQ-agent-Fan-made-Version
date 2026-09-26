// 「记忆召回预览」的**唯一**实现 —— 这一轮她到底会想起哪几条？
//
// ── 为什么有这个文件（2026-09-25 第十九对话 → 2026-09-26 第二十二对话）──────────
// 用户 2026-09-25 在微信侧连着两轮问"对我的印象是什么"，她一条 QQ 侧的事都没提
// ⇒ 用户判成"跨平台记忆没做好"。而离线查实（待办与决策记录 §74）真相是：
// **关联那套机器是通的**，空的原因是「中文自然句在 `extractKeywords` 的 4 字块下几乎必然 0 命中」。
// 🔴 在那之前**没有任何地方能预先看到"这一轮她会想起哪几条"** —— 只能靠"问她一句"来试，
//    而那样拿到的只是"她说了什么"，拿不到"她本来会看到什么"
//    ⇒ 机制问题看起来就跟能力问题一模一样。
// 第十九对话为此写了只读工具 `工具-会话诊断\看-记忆召回预览.mjs`（命令行）。
// 第二十二对话（交接 §3 待办 2）要把它搬进界面 ⇒ **逻辑必须只有一份**，
// 否则界面那份会慢慢与工具/真函数分家，而分家的表现是"看着完全正常"。
// ⇒ 本文件就是那一份：命令行工具与界面**都调它**。
//
// ⚠️ 判据（为什么"预览的"不可能和"实际的"不一样）：
//   第①段就是 `store.formatForPrompt(chatKey, opts)` 的**返回值本身**，
//   第②段的分数也是**同一个** `scoreImpression`；`opts` 只算一次、两处共用。
//   ⇒ `测试-现行\test-记忆召回预览.mjs` 断言 `preview.promptBlock === store.formatForPrompt(同 opts)` 逐字相同；
//     `测试-现行\test-记忆召回预览界面.mjs` 再断言**界面走的那条 HTTP 路由**给出同一份东西。
//   ⛔ 所以本文件**不许**自己重写门槛/打分/装桶逻辑 —— 那正是"仪表会自己漂移"的来源。
//
// ⚠️ **本文件刻意不在顶层 import `./memory.js`**：命令行工具必须在**设好
//    `QQ_AGENT_DATA_DIR` 之后**才能加载 memory.js（config.js 在模块加载时就把数据目录求值了）。
//    顶层 import 会把这个顺序悄悄破坏掉（读错一份 data，而看起来一切正常）。
//    需要 memory 模块的场合（界面路由）请调 `previewApi()`，它是**动态** import。

/**
 * 算出"这一轮会想起哪几条"。
 *
 * ⚠️ `api` 只要提供四样东西（= `memory.js` 的模块命名空间 + 两个说明字段）：
 *    `extractKeywords` / `scoreImpression` / `IMPRESSION_THRESHOLD` / `dataDir` / `dataDirSource`。
 *    命令行工具与界面路由各自按自己的方式凑出它，**但取的都是真 memory.js 的那几个函数**。
 *
 * @param {object} store 真 MemoryStore 实例
 * @param {object} api   memory.js 的导出（含 dataDir / dataDirSource 说明字段）
 * @param {string} chatKey
 * @param {{userIds?: string[]|null, queryText?: string, platform?: string, now?: number, top?: number, all?: boolean}} o
 * @returns {{opts, promptBlock, keywords, threshold, rows, shown, admittedCount, total, chatCounts, platform, dataDir, dataDirSource, queryText}}
 */
export function buildPreview(store, api, chatKey, {
  userIds = null, queryText = '', platform = '', now = Date.now(), top = 15, all = false
} = {}) {
  // ⚠️ opts **只算一次**，两处（真函数 + 解释）共用同一个对象 —— 这是"不会漂移"的保证。
  const opts = { userIds, queryText, now, platform }
  const promptBlock = store.formatForPrompt(chatKey, opts)      // ← 唯一权威：真的会进提示词的那段
  const keywords = api.extractKeywords(queryText)

  const rows = []
  for (const ck of store.listChats()) {
    for (const m of store.members(ck)) {
      for (const e of m.impressions || []) {
        const content = String(e?.content ?? '').trim()
        if (!content) continue
        // 🔴 打分参数的形状**必须与 formatForPrompt 内部那一次逐字一致**（memory.js:937）：
        //    它只传 `{ content, createdAt }` —— **没传 reinforcedAt**（也没用 isSpeaking）。
        //    ⇒ 这里多传一个字段，"解释"就会和"实际"给出不同的分数，
        //      而那种不一致**看起来完全正常**（正是本项目最怕的"仪表在骗人"）。
        const score = api.scoreImpression(
          { content, createdAt: e.createdAt },
          { keywords, now }
        )
        rows.push({
          chatKey: ck,
          userId: String(m.userId || ''),
          name: String(m.name || ''),
          content,
          createdAt: Number(e.createdAt) || 0,
          reinforcedAt: Number(e.reinforcedAt) || 0,
          score,
          // "进没进"以**真输出**为准（不是以分数为准）：分数只是必要条件，
          // 还要看它在不在本轮可见范围里、有没有被跨会话额度挤掉、内容有没有重复。
          admitted: promptBlock.includes(content)
        })
      }
    }
  }
  rows.sort((a, b) => b.score - a.score || String(a.chatKey).localeCompare(String(b.chatKey)))

  const admitted = rows.filter((r) => r.admitted)
  let shown = rows
  if (!all) {
    const keep = new Set(rows.slice(0, top))     // 分数最高的 top 条
    for (const r of admitted) keep.add(r)        // ⚠️ 进了的**一定**要显示（否则解释不了"这条哪来的"）
    shown = rows.filter((r) => keep.has(r))
  }

  const chatCounts = store.listChats().map((ck) => {
    const ms = store.members(ck)
    return {
      chatKey: ck,
      members: ms.length,
      impressions: ms.reduce((n, m) => n + (m.impressions?.length || 0), 0)
    }
  }).sort((a, b) => b.impressions - a.impressions)

  return {
    chatKey,
    platform: platform || store.platformOf(chatKey) || 'qq',
    // 数据目录跟着 api 走（= 调用方实际读到的那一份），不从模块级缓存读 ——
    // 免得"没传就渲染"时打出一个问号（那种输出会让人以为工具坏了）。
    dataDir: api.dataDir ?? '',
    dataDirSource: api.dataDirSource ?? '',
    queryText,
    opts,
    promptBlock,
    keywords,
    threshold: api.IMPRESSION_THRESHOLD,
    rows,
    shown,
    admittedCount: admitted.length,
    total: rows.length,
    chatCounts
  }
}

/** 把 buildPreview 的结果渲染成人看的文本。 */
export function renderPreview(p, { all = false, top = 15 } = {}) {
  const L = []
  L.push('══ 记忆召回预览（只读）══')
  L.push(`数据目录：${p.dataDir || '?'}`)
  L.push(`           （怎么找出来的：${p.dataDirSource || '?'}）`)
  L.push(`会话：${p.chatKey}（平台 ${p.platform}）`)
  L.push(`这一轮说的话（queryText）：${p.queryText ? `「${p.queryText}」` : '（没给）'}`)
  L.push(`抽出的关键词（${p.keywords.length} 个）：${p.keywords.length ? p.keywords.join(' · ') : '（无）'}`)
  L.push(`门槛：${p.threshold}（判定是 s <= ${p.threshold} 就丢 —— "错的不如空着"）`)
  if (!String(p.queryText).trim()) {
    L.push('')
    L.push('⚠️ 没给 --query ⇒ **记忆段必然是空的**（关键词一项恒 0，新写的印象正好等于门槛、不算过线）。')
    L.push('   这是设计行为，不是故障。要预览真实效果，请把"这一轮别人说的那句话"当 --query 传进来。')
  }

  L.push('')
  L.push('── ① 会写进提示词的那一段（逐字来自真 formatForPrompt）──')
  if (p.promptBlock) {
    for (const line of String(p.promptBlock).split('\n')) L.push(`  ${line}`)
  } else {
    L.push('  （空 —— 这一轮一条印象都没过线）')
    L.push('  ⇒ 两种可能，看 ② 分辨：')
    L.push('     · 没有一条印象命中上面那些关键词（最常见）—— 关键词是被切成 2 字块的，中文长句很难命中；')
    L.push('     · 命中了，但分数没过门槛（太旧 / 命中数不够）。')
  }

  L.push('')
  L.push(`── ② 为什么（全库 ${p.total} 条印象，按分数排${all ? '，全部列出' : `，只列前 ${top} + 所有进了的`}）──`)
  if (!p.total) {
    L.push('  （这个 data 目录里一条印象都没有）')
  } else {
    for (const r of p.shown) {
      const mark = r.admitted ? '✅' : '✗ '
      L.push(`  ${r.score.toFixed(3)} ${mark} ${r.chatKey} · ${r.userId}  ${oneLine(r.content)}`)
    }
    L.push(`  说明：✅ = 真的出现在上面那一段里（${p.admittedCount} 条）；✗ = 没进。`)
    L.push('        分数 ≥ 门槛却 ✗ 的，是"没被装进桶 / 跨会话额度被挤掉 / 内容与别人重复"，')
    L.push('        不是打分算错 —— 打分只看关键词命中和写下时间，不看是谁。')
    L.push('        ⚠️ 当前实现里「被用过 +0.05」这一项**实际从未生效**（formatForPrompt 没把 reinforcedAt 传下去），')
    L.push('           所以本表列的分数不带那 0.05，与真实路径一致。')
  }

  L.push('')
  L.push('── ③ 每个会话的印象条数（换 chat 时用）──')
  if (!p.chatCounts.length) L.push('  （没有）')
  for (const c of p.chatCounts) L.push(`  ${c.chatKey}  ${c.impressions} 条 / ${c.members} 人`)
  return L.join('\n')
}

/** 一行化 + 截断（印象正文里可能有换行/多余空白，打印时要压平）。 */
export function oneLine(s, n = 46) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 给**界面**用的 `api` 参数：真 memory.js 的导出 + 数据目录说明。
 *
 * ⚠️ 动态 import（见文件头）：本模块顶层不许碰 memory.js。
 * ⚠️ `dataDir` 取的是 config.js 的 `DATA_DIR` —— 与 memory.js 落盘用的是同一个值，
 *    所以界面上写出来的路径就是真实路径（不是猜的）。
 */
export async function previewApi() {
  const [mod, cfg] = await Promise.all([
    import('./memory.js'),
    import('./config.js'),
  ])
  return {
    ...mod,
    dataDir: cfg.DATA_DIR,
    dataDirSource: '应用的 DATA_DIR（config.js，与 memory.js 落盘同一个值）',
  }
}
