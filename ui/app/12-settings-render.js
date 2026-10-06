'use strict';
// 第 13/18 段：12-settings-render（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

function renderSettingsSection(c) {
  const sec = state.settingsSection || 'api';
  const sections = {
    api: () => renderApiSection(c),
    search: () => renderSearchSection(c),
    memory: () => renderMemorySettingsSection(c),
    persona: () => renderPersonaSection(c),
    allow: () => renderAllowSection(c),
    // 🆕 2026-10-04（第四十对话 · 批 3）：新小节「她的能力」—— 见 renderAbilitiesSection 的注释
    abilities: () => renderAbilitiesSection(c),
    // 🆕 2026-10-04（第四十一对话 · 内置代理批 A，回执 V7）：新小节「网络」
    network: () => renderNetworkSection(c),
    wechat: () => renderWechatContactsSection(c),
    chat: () => renderChatSection(c),
    security: () => renderSecuritySection(c),
    desktop: () => renderDesktopSection(c),
    onebot: () => renderOnebotSection(c)
  };
  const render = sections[sec] || sections.api;
  // 🔴 保存条**移到滚动区之外**（2026-10-01 调整方案 · 用户拍板方案 B）—— ⚠️ **方向与上一版相反**，别照旧的改。
  //    用户原话：「能给保存条像之前一样一直置顶吗，现在外观的样式很好，但是固定在下还会浮在文字上有的不美观」
  //    ⇒ 三条要求：① 一直置顶 ② 样式不变 ③ **不浮在文字上**（这条是选型依据）。
  //    ⚠️ **为什么不是把 `sticky` 的 `bottom` 改成 `top`**（那个方案 A 已否掉、别再论证）：
  //       sticky 元素**在原地占位**，无论钉在顶还是底，滚动时内容都从它**底下**穿过 ⇒ 改 top 只是把遮挡
  //       从"还没读的下方内容"挪到"已读的上方内容"，**遮挡本身没消失**。要零重叠只能**结构上分开**。
  //    ⇒ 结构变成：`#settings-form`（= `.settings-pane`，flex 列 + overflow:hidden）
  //         ├── `.save-bar`        （`position: static` + `flex: none` —— 恒定在顶部，不参与滚动）
  //         └── `.settings-scroll` （`flex: 1` + `min-height: 0` + `overflow-y: auto` —— 内容在这里滚）
  //    ⚠️ **`${render()}` 那一层包裹不能省**：直接把 `.settings-pane` 改成 flex 而不包，所有内容都会
  //       变成 flex 项 ⇒ **相邻兄弟的 margin 不再折叠**（`.form-panel` 的 14px 与 `h3` 的 22px 会从
  //       "折叠成 22px"变成"相加 36px"）⇒ 10 个分区的间距会整体变松。包起来后内部仍是块级流。
  //    ⚠️ 挪动顺序**不影响任何绑定**：`13-settings-events.js` 走 `$('#save-cfg-btn')` / `$('#cfg-save-result')`
  //       的 **id 查找**（document 级查询），与子元素顺序无关 ⇒ 这两个 id 一个都不能改。
  return `
    <div class="save-bar">
      <button class="btn btn-primary" id="save-cfg-btn">保存设置</button>
      <span id="cfg-save-result" class="muted"></span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="page-help-btn" title="把这一页里折起来的说明一次摊开（Esc 关闭）">？ 本页说明</button>
    </div>
    <div class="settings-scroll">
      ${render()}
    </div>`;
}

/**
 * 备选模型数组 → 文本域里的"一行一个"。与 `parseFallbackModels` **互为逆运算**
 * （判据：`测试-现行\test-专用模型输入框.mjs` 里有往返断言）。
 * 格式：`模型id` 或 `模型id @ 提供商id`。
 */
function fallbackModelsText(list) {
  if (!Array.isArray(list)) return '';
  return list
    .map((f) => {
      const model = String(f?.model || '').trim();
      if (!model) return '';
      const provider = String(f?.provider || '').trim();
      return provider ? `${model} @ ${provider}` : model;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * 文本域 → 备选模型数组（保存时用）。
 * 每行 `模型id` 或 `模型id @ 提供商id`；空行忽略；没有模型 id 的行忽略。
 * ⚠️ 取**第一个** `@` 切分：模型 id 里通常没有 `@`，而提供商 id 更不可能有。
 */
function parseFallbackModels(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('@');
      if (i < 0) return { model: line };
      const model = line.slice(0, i).trim();
      const provider = line.slice(i + 1).trim();
      return provider ? { model, provider } : { model };
    })
    .filter((f) => f.model);
}

/**
 * `api.videoMode` 的合法值。
 * ⚠️ 这里是**第二份**（第一份是 `src/video-reader.js:25` 的 `export const VIDEO_MODES`）——
 *    前端是经典 script、后端是 ESM，没法共用一个常量。两份的一致性由
 *    `测试-现行\test-专用模型输入框.mjs` 逐字比对钉住（漂移就会红）。
 */
const VIDEO_MODES = ['auto', 'native', 'frames', 'off'];

/**
 * 界面上的视频发送方式 → 配置值。
 * ⚠️ 不认识的值一律回落 `auto`，**不照抄写盘**：这个键决定"给不给模型看画面"，
 *    写进一个 `resolveVideoRoute` 不认的值，表现会是"路由静默变成 meta（等于不看画面）"
 *    —— 界面选的、和真跑的，绝不能是两回事。
 */
function normalizeVideoMode(v) {
  const s = String(v || '').trim().toLowerCase();
  return VIDEO_MODES.includes(s) ? s : 'auto';
}

function renderApiSection(c) {
  const currentProvider = (state.providers || []).find((p) => p.id === c.api.provider);
  const currentModelDisplay = (currentProvider?.modelNames || {})[c.api.model] || c.api.model;
  // 视频发送方式：**先归一再渲染**。配置里若是个非法值（手改过 config.json），
  // 页面必须显示"实际会生效的那个"（auto），而不是一个都不选中 ——
  // 后者是"界面在说谎"：她看到的空选择与真跑的路由不是一回事。
  const videoMode = normalizeVideoMode(c.api?.videoMode);
  return `
    <h3 id="settings-api">模型 API</h3>
    <div class="field"><label>模型目录</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-model-pick" readonly placeholder="点击选择模型" value="${esc(currentModelDisplay || '')}" style="flex:1;cursor:pointer" />
        <button class="btn btn-small" id="test-provider-btn">测试连通性</button>
        <span id="provider-test-result" class="muted" style="align-self:center"></span>
      </div>
      <div class="hint status" id="provider-hint">${currentProvider ? `当前：${esc(currentProvider.displayName)} · ${esc(c.api.model || '未选模型')} @ ${esc(currentProvider.baseURL)}${currentProvider.hasKey ? ' · 已保存 API Key（不显示）' : ' · 未保存 API Key'}` : '尚未选择模型'}</div>
      <div class="hint status" id="model-vision-hint" style="margin-top:6px"></div>
      <input type="hidden" id="cfg-provider" value="${esc(c.api.provider || '')}" />
      <input type="hidden" id="cfg-model" value="${esc(c.api.model || '')}" />
    </div>
    <div class="field-row">
      <div class="field"><label>当前 Base URL</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-baseurl" readonly value="${esc(c.api.baseUrl)}" style="flex:1" />
          <button class="btn btn-small" id="fetch-current-models-btn">获取列表</button>
        </div></div>
      <div class="field"><label>当前 API Key</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-apikey" value="${esc((currentProvider?.hasKey || c.api.apiKey) ? '******' : '')}" placeholder="输入新 Key 可替换；留空保存则保持原 Key" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-apikey-toggle" type="button">显示</button>
        </div></div>
    </div>
    <div class="field-row">
      <div class="field"><label>温度</label><input type="number" id="cfg-temperature" step="0.1" min="0" max="2" value="${esc(c.api.temperature)}" /></div>
      <div class="field"><label>单次运行最大工具轮数</label><input type="number" id="cfg-maxrounds" min="1" max="40" value="${esc(c.api.maxRounds)}" /></div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-vision" ${c.api.vision !== false ? 'checked' : ''} />
      <label for="cfg-vision">图片输入</label>
      <span id="vision-switch-hint" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div class="hint" style="margin-top:6px">关闭则移除看图工具，模型只会看到 [图片] 占位符。</div>

    <!-- ── 图片 / 视频专用模型 + 备选模型降级链（2026-09-25 · 第十七对话加）────────────
         这三个键**本来就在 config.js 里**（第十七对话补进 DEFAULT_CONFIG），但一直没有界面
         ⇒ 只能手改 config.json，等于用户摸不到。这里补上界面。
         语义：**留空 = 不切换 / 不降级**，行为与没有这些字段时一字不差。 -->
    <div class="field-row">
      <div class="field"><label>图片输入专用模型（留空 = 用主模型）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-vision-model" value="${esc(c.api.visionModel || '')}" placeholder="只在消息里真有图片时才切" style="flex:1" />
          <button class="btn btn-small" id="pick-vision-model-btn" type="button">选择</button>
        </div></div>
      <div class="field"><label>视频输入专用模型（留空 = 用主模型）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-video-model" value="${esc(c.api.videoModel || '')}" placeholder="视频优先于图片" style="flex:1" />
          <button class="btn btn-small" id="pick-video-model-btn" type="button">选择</button>
        </div></div>
    </div>
    <!-- 视频发送方式：与 api.videoModel 配合决定走哪条路线（video-reader.js 的 resolveVideoRoute）。
         ⚠️ 这个键**不是本轮新加的** —— config.js 里一直有 videoMode 的默认值，但直到 2026-09-25
         才发现：界面没有它 ⇒ 想改只能手改 config.json。这里补上（交接 §3 待办 4）。 -->
    <div class="field-row">
      <div class="field"><label>视频发送方式</label>
        <select id="cfg-video-mode">
          <option value="auto" ${videoMode === 'auto' ? 'selected' : ''}>auto —— 有专用模型就按原生视频发，否则抽帧（默认）</option>
          <option value="native" ${videoMode === 'native' ? 'selected' : ''}>native —— 总是按原生视频输入发送</option>
          <option value="frames" ${videoMode === 'frames' ? 'selected' : ''}>frames —— 总是抽帧成图片</option>
          <option value="off" ${videoMode === 'off' ? 'selected' : ''}>off —— 只读元信息，不看画面</option>
        </select></div>
    </div>
    <details class="hint-more"><summary>这几种方式有什么区别？</summary>
      <div class="hint-more-body">只在<b>消息里真的出现了</b>图片 / 视频部件时才切过去，纯文本对话一律用主模型（不会白花贵模型的额度）。视频优先于图片。视频那一路还要 <code>api.videoMode</code> 决定"原生发送 / 抽帧 / 只看元信息"：<code>auto</code> 看上面「视频输入专用模型」填没填，<code>native</code> / <code>frames</code> 强行指定，<code>off</code> 完全不喂画面。</div>
    </details>
    <div class="field"><label>备选模型降级链（一行一个；主模型重试后仍失败时按顺序换）</label>
      <textarea id="cfg-fallback-models" rows="3" placeholder="每行一个：模型id　或　模型id @ 提供商id" style="width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${esc(fallbackModelsText(c.api.fallbackModels))}</textarea>
      <details class="hint-more"><summary>降级链怎么写、降级会发生什么？</summary>
        <div class="hint-more-body">一行一个。写 <code>模型id @ 提供商id</code> = 换到<b>那个提供商</b>的端点（跨提供商降级，用它的 baseUrl 与 Key）；不写 <code>@ 提供商</code> 则沿用主模型端点、只换模型 id。留空 = 不降级。⚠️ 降级发生时，本轮实际用的渠道会写进会话的 <code>vendor</code>（成本看板按它聚合）。</div>
      </details>
    </div>
    <div class="settings-divider"></div>

    <h3>成本核算</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-useofficialprice" ${c.api.useOfficialPrice !== false ? 'checked' : ''} />
      <label for="cfg-useofficialprice">用内置官方价格表估算（按模型 id 自动匹配；走中转站请关掉）</label></div>

    <div class="field" style="margin-bottom:12px"><label>远程价格表 URL</label>
      <div class="field-row-inline">
        <input type="text" id="cfg-price-remote-url" placeholder="例如 https://你的服务器/prices.json" value="${esc(c.api.priceRemoteUrl || '')}" />
        <button class="btn btn-small" id="price-feed-refresh-btn" title="不等定时，立即拉一次">立即拉取</button>
      </div>
      <div class="hint" id="price-feed-status" style="margin-top:4px"></div>
    </div>

    <!-- 当前模型的价格卡片：切换模型时内容跟着变 -->
    <div class="price-card" id="model-price-card">
      <div class="pc-head">
        <span class="pc-title">当前模型单价</span>
        <span class="pc-model" id="pc-model">${esc(c.api.model || '（未选择模型）')}</span>
      </div>
      <div class="pc-rows">
        <div class="pc-row"><span class="pc-label">输入</span>
          <input type="number" id="cfg-price-in" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">输出</span>
          <input type="number" id="cfg-price-out" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
        <div class="pc-row"><span class="pc-label">缓存命中</span>
          <input type="number" id="cfg-price-cached" step="0.01" min="0" value="0" /><span class="pc-unit">元/百万</span></div>
      </div>
      <div class="pc-note" id="pc-note"></div>
    </div>

    <div style="display:flex;gap:8px;margin:8px 0">
      <button class="btn btn-small" id="batch-price-btn">批量自定义价格编辑</button>
      <span class="muted" style="font-size:12px;align-self:center">为多个模型分别设定单价</span>
    </div>

    <div class="settings-divider"></div>

    <h3>手动添加提供商</h3>
    <div class="form-panel">
      <div class="panel-head">
        <span class="panel-title">接入信息</span>
        <span class="panel-note">填地址与 Key，再添加模型</span>
      </div>

      <div class="field"><label>Base URL</label>
        <div class="field-row-inline">
          <input type="text" id="new-baseurl" placeholder="https://api.deepseek.com/v1" />
          <button class="btn btn-small" id="fetch-models-btn" title="从上面的地址拉取可用模型，弹窗里勾选加入">获取列表</button>
        </div>
        <details class="hint-more"><summary>支持哪些接口格式？</summary>
          <div class="hint-more-body">支持 OpenAI 兼容接口，例如 <code>https://api.deepseek.com/v1</code>、<code>https://open.bigmodel.cn/api/paas/v4</code>。</div>
        </details>
      </div>

      <div class="field"><label>API Key</label>
        <div class="field-row-inline">
          <input type="password" id="new-apikey" placeholder="sk-…" autocomplete="new-password" />
          <button class="btn btn-small" id="new-apikey-toggle" type="button">显示</button>
        </div>
        <div class="hint">只保存在本机 <code>data/config.json</code>，不会随诊断包导出。</div>
      </div>

      <div class="field"><label>模型</label>
        <div id="model-rows"></div>
        <div class="field-row-inline" style="margin-top:6px">
          <button class="btn btn-small" id="add-model-row-btn">＋ 添加一行</button>
          <span class="hint" style="margin-top:0">左列是模型 ID（发给接口的那个），右列只是目录里的显示名</span>
        </div>
      </div>
    </div>

    <div class="form-actions">
      <button class="btn btn-primary" id="confirm-add-provider-btn">确认添加</button>
      <button class="btn btn-danger" id="delete-model-btn">删除模型…</button>
    </div>
    <div class="hint" id="provider-action-hint"></div>`;
}



/**
 * 本子查询的「动作区」HTML —— 检测连通 / 试查一次 / 离线库状态 + 导入。
 *
 * 🆕 2026-09-23（第十二对话）：从**设置页**搬到这里（用户点名："skill 和插件是为了方便
 * 安装卸载新增才开发的，加到设置页有点不合理"）。
 * 字段（返回几本 / 超时 / 群里允许 / 工具目录 / Python 解释器）**不在这里**：
 * 它们由 skills/doujin-lookup/skill.json 的 configSchema 声明，走通用技能表单渲染 ——
 * 所以这个函数只负责"通用表单渲染不了的东西"（按钮与状态行）。
 */
function doujinToolsHtml() {
  return `
      <div class="dj-tools">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-small" id="doujin-check-btn">检测连通</button>
          <button class="btn btn-small" id="doujin-search-btn">试查"校园"</button>
          <span id="doujin-check-hint" class="muted" style="font-size:12px"></span>
        </div>
        <div style="margin-top:10px">
          <div id="doujin-db-line" class="muted" style="font-size:12px">离线库：读取中…</div>
          <div id="doujin-db-note" class="muted" style="font-size:12px"></div>
          <div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
            <!-- 原生 <input type=file> 的按钮是系统样式，与 UI 割裂：隐藏本体，用统一的 .btn 触发 -->
            <input type="file" id="doujin-import-file" accept=".db,.sqlite,.csv" style="display:none" />
            <button class="btn btn-small" id="doujin-import-btn">导入离线库（.db / .csv）</button>
            <span id="doujin-import-hint" class="muted" style="font-size:12px"></span>
          </div>
          <!-- file.path 拿不到时的退路（较新的 Electron 只给 File 对象、不给真实路径）：
               让用户直接把路径粘进来。默认隐藏，只有真拿不到才显示。 -->
          <div id="doujin-import-manual" style="display:none;margin-top:6px">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input type="text" id="doujin-import-path" placeholder="把离线库/CSV 的完整路径粘到这里，例如 D:\\data\\nh.db"
                style="flex:1;min-width:320px" />
              <button class="btn btn-small" id="doujin-import-go">用这个路径导入</button>
            </div>
          </div>
          <div class="hint">
            导入 <code>.csv</code> 会本地转成 <code>nh.db</code>（约几秒，期间别关窗口）；
            导入 <code>.db</code>/<code>.sqlite</code> 是直接换库，旧库自动改名备份。
            ⚠️ 只校验文件头/表头，表结构不对要到<b>下一次真实查询</b>才会暴露。
          </div>
          <details class="hint-more">
            <summary>说明：表头要求、备份与回滚、耗时</summary>
            <div class="hint-more-body">
              表头要能对上 <code>id,title,upload_date,tags</code>；Excel 的 <code>.xlsx</code> 不行，
              先在 Excel 里「另存为 → CSV UTF-8」。<br>
              实测 52 万行 / 89.4MB 的表约 <b>2~3 秒</b>（本机 2.3 秒）；转换期间 JM 查询会排队等它跑完。<br>
              旧库会改名成 <code>nh.db.bak-日期-时间</code> 留在原地；想回滚就把备份改回 <code>nh.db</code>。<br>
              库文件在<b>你选的路径上就地生效</b>（即配置里的这个路径；改路径要保存才生效）。
            </div>
          </details>
        </div>
        <div class="hint">
          JM 搜索是<b>真直连</b>（本机 Python 子进程，不需要代理）。<b>首次查询约 3 秒</b>，之后同一进程内就快了。
          ⚠️ 兜底的 NH 离线库标题<b>几乎全是英文</b>，中文/日文关键词基本查不到 —— 模型会自己先翻成英文再查。
        </div>
      </div>`;
}

/**
 * 少数扩展的**动作区**声明（不是配置字段，通用表单渲染不了）。
 *
 * 现状只有本子查询：「检测连通 / 试查一次 / 离线库导入」。
 * ⚠️ 为什么用一张声明表，而不是给 configSchema 加一种新字段类型：
 *    动作要绑事件、要读写 DOM、要发请求 —— 塞进 `renderSkillSettingsModal` 那套
 *    "按 type 渲染一个输入框"的通用逻辑里，会把那份逻辑弄脏（那段代码顶部专门写了
 *    "不重写表单"的理由）。与后端 `ENABLED_BY_PATH` / `CONFIG_BY_PATH` 同一取向：
 *    **特例声明在明处**，不藏在通用路径里。
 */
const SKILL_ACTION_PANELS = {
  'doujin-lookup': { html: () => doujinToolsHtml(), bind: () => bindDoujinTools() },
};

/** 给当前 DOM 里的本子查询动作区接线。 */
function bindDoujinTools() {
    // ── 本子查询：检测连通 / 试查一次 ──
    const djHint = $('#doujin-check-hint');
    const djSay = (t, color) => { if (djHint) { djHint.textContent = t; djHint.style.color = color || ''; } };

    // 进设置页就顺手看一眼"工具目录 / 脚本 / 解释器 / NH 库"在不在。
    // ⚠️ 不带 ping：那条会拉起 Python 子进程，进个设置页不该有这种副作用。
    // 为什么要**主动**查：本子查询最容易的坏法是静默失效（开关开着、接口 200、就是查不到东西），
    // 与其等模型查空了再回来猜，不如在这里直接说清"缺什么、本该在哪"。
    (async () => {
      if (!djHint) return;
      try {
        const r = await api('/api/doujin/status');
        const p = r.paths || {};
        if (p.hint) djSay(`⚠️ ${p.hint}`, 'var(--orange)');
        else if (p.toolDir) djSay(`工具目录：${p.toolDir}　${p.toolDirFromConfig ? '（设置里指定的）' : '（自动找到的）'}`, 'var(--muted)');
      } catch { /* 后端没起来就不显示 —— 设置页不该因为这一条显示不出来而报错 */ }
    })();

    $('#doujin-check-btn')?.addEventListener('click', async () => {
      const btn = $('#doujin-check-btn');
      btn.disabled = true; djSay('检测中…首次要 3 秒左右（拉子进程 + 探域名）');
      try {
        const r = await api('/api/doujin/status?ping=1');
        const p = r.paths || {};
        const okAll = p.serverExists && r.ping?.ok;
        const detail = `脚本 ${p.serverExists ? '✓' : '✗'} · NH库 ${p.nhDbExists ? '✓' : '✗'} · ping ${r.ping?.ok ? '✓' : '✗ ' + (r.ping?.error || '')}`
          + ` — 解释器：${p.pythonPath}`;
        // 有 hint 就优先显示它 —— 那是一句人话（"工具目录不存在：… 找过这些位置都没有：…"），
        // 比一串 ✓/✗ 更能直接告诉人该去干什么
        djSay(p.hint ? `⚠️ ${p.hint}　〔${detail}〕` : detail, okAll ? 'var(--green)' : 'var(--orange)');
      } catch (e) { djSay(`检测失败：${e.message}`, 'var(--orange)'); }
      btn.disabled = false;
    });
    $('#doujin-search-btn')?.addEventListener('click', async () => {
      const btn = $('#doujin-search-btn');
      btn.disabled = true; djSay('查「校园」中…');
      try {
        const r = await api('/api/doujin/test', { method: 'POST', body: JSON.stringify({ keyword: '校园' }) });
        const res = r.result || {};
        if (!res.ok) djSay(`查询失败：${res.error}`, 'var(--orange)');
        else {
          const items = res.items || [];
          const one = items[0];
          djSay(`查到 ${res.total} 条（取前 ${items.length}）：${one ? `码 ${one.code}、标题 ${String(one.title).length} 字` : '（空）'}`
            + `  用时 ${res.ms}ms`, 'var(--green)');
        }
      } catch (e) { djSay(`查询失败：${e.message}`, 'var(--orange)'); }
      btn.disabled = false;
    });

    // ── 本子查询：离线库（nh.db）状态 + 导入 ──
    const djDbLine = $('#doujin-db-line');
    const djDbSay = (t, color) => { if (djDbLine) { djDbLine.textContent = t; djDbLine.style.color = color || ''; } };
    const djiHint = $('#doujin-import-hint');
    const djiSay = (t, color) => { if (djiHint) { djiHint.textContent = t; djiHint.style.color = color || ''; } };
    const djNote = $('#doujin-db-note');
    const djNoteSay = (t, color) => { if (djNote) { djNote.textContent = t; djNote.style.color = color || ''; } };

    /** MB 显示：小文件别显示成 0.00 MB。 */
    const fmtMB = (n) => {
      const b = Number(n) || 0;
      if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
      return `${(b / 1024 / 1024).toFixed(1)} MB`;
    };
    /** 行数：几十万也带千分位，一眼能看出量级。 */
    const fmtNum = (n) => {
      const v = Number(n);
      return Number.isFinite(v) ? v.toLocaleString('en-US') : String(n ?? '');
    };

    // 刷新「离线库：<路径> — <状态>」那一行（数据来自 /api/doujin/db-info，只读、不拉子进程）
    const refreshDoujinDbInfo = async () => {
      if (!djDbLine) return;
      try {
        const r = await api('/api/doujin/db-info');
        const d = r.db || {};
        if (!d.exists) {
          djDbSay(`离线库：${d.path || '(未配置路径)'} — 未导入（用下面的按钮导入 .db 或 .csv）`, 'var(--orange)');
          return;
        }
        // rows 只有小库才给（大库数一遍太贵，后端会省略）—— 有就带上，没有就不编
        const extra = [
          d.rows !== undefined ? `${fmtNum(d.rows)} 行` : '',
          d.hasIndex === true ? '带标题索引' : (d.hasIndex === false ? '⚠️ 缺 idx_nh_title 索引' : ''),
          d.valid === false ? '⚠️ 不是 SQLite 文件' : ''
        ].filter(Boolean).join(' · ');
        djDbSay(`离线库：${d.path} — 已导入 ${fmtMB(d.bytes)}${extra ? `（${extra}）` : ''}`,
          d.valid === false ? 'var(--orange)' : 'var(--muted)');
      } catch (e) {
        djDbSay(`离线库信息读取失败：${e.message}`, 'var(--orange)');
      }
    };
    void refreshDoujinDbInfo();

    /**
     * 取 File 对象的真实路径。
     * Electron < 32 上 `File.path` 直接可用；较新版本改成 `webUtils.getPathForFile()`
     * （只能在有 preload 的渲染进程里拿到）。这个应用**没有 preload**、渲染进程也没有 Node，
     * 所以两条都试一遍，拿不到就返回空串 —— 由调用方走"手填路径"那条路，绝不猜。
     */
    const pathOfFile = (f) => {
      if (!f) return '';
      try {
        if (typeof f.path === 'string' && f.path) return f.path;
      } catch { /* 某些版本上访问它会抛 */ }
      try {
        const wu = globalThis.webUtils || globalThis.require?.('electron')?.webUtils;
        if (wu?.getPathForFile) return String(wu.getPathForFile(f) || '');
      } catch { /* 拿不到就走手填 */ }
      return '';
    };

    const djImportFile = $('#doujin-import-file');
    const djImportBtn = $('#doujin-import-btn');
    const djImportManual = $('#doujin-import-manual');

    /** 真正发请求那一步：两条路（选文件 / 手填路径）最后都汇到这里。 */
    const runDoujinImport = async (p) => {
      const btn = djImportBtn;
      const isCsv = /\.csv$/i.test(p);
      if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
      djNoteSay('');
      djiSay(isCsv
        ? `正在转库（本地跑，52 万行实测约 2~3 秒）…期间 JM 查询会排队等它`
        : `正在安装数据库…`, 'var(--muted)');
      try {
        const r = await api('/api/doujin/import-db', { method: 'POST', body: JSON.stringify({ path: p }) });
        // 后端 ok:false 也走不到这里（api() 会把非 2xx 抛出来），但 .csv 转库失败是 200 + error，
        // 所以两种都要判 —— 而且 **error 原文照显示**，那是给用户看的一句话，不能吃掉换成泛化文案
        if (!r.ok) {
          djiSay(`导入失败：${r.error || '未知原因'}`, 'var(--orange)');
          return;
        }
        const size = r.bytes != null ? `，${fmtMB(r.bytes)}` : '';
        if (r.kind === 'csv') {
          djiSay(`导入成功：${fmtNum(r.rows)} 行${size}（用了 ${r.ms != null ? Math.round(r.ms / 1000) + ' 秒' : '—'}）`, 'var(--green)');
        } else {
          djiSay(`导入成功：已换上 ${fmtMB(r.bytes)} 的库`
            + (r.backup ? `，旧库备份在 ${r.backup}` : '（原本没有旧库，未产生备份）'), 'var(--green)');
        }
        // 后端如实说明了"只校验文件头、表结构要靠下一次真实查询暴露" —— 单独一行显示，不跟成功文案揉一起
        if (r.note) djNoteSay(r.note, 'var(--muted)');
      } catch (e) {
        // 502/500 也带着后端那句人话（api() 已经把它塞进 e.message 了）
        djiSay(`导入失败：${e.message}`, 'var(--orange)');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '导入离线库（.db / .csv）'; }
        // 导入完刷新那一行（成败都刷：失败的 .csv 也可能已经留下半成品别的东西）
        void refreshDoujinDbInfo();
      }
    };

    djImportBtn?.addEventListener('click', () => {
      if (!djImportFile) {
        // 连 file input 都没有（老页面/被裁过）→ 直接给手填那条路
        if (djImportManual) djImportManual.style.display = '';
        djiSay('把文件路径填到下面的输入框里再点「用这个路径导入」', 'var(--orange)');
        return;
      }
      djImportFile.value = '';   // 清空：选同一个文件第二次也要能触发 change
      djImportFile.click();
    });

    djImportFile?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const p = pathOfFile(f);
      if (p) {
        if (djImportManual) djImportManual.style.display = 'none';
        djiSay(`已选中：${f.name}`, 'var(--muted)');
        void runDoujinImport(p);
        return;
      }
      // 拿不到真实路径：明确告诉用户该怎么办，并把输入框亮出来
      if (djImportManual) djImportManual.style.display = '';
      djiSay('这个 Electron 版本拿不到文件真实路径 —— 请把完整路径填到下面的输入框，再点「用这个路径导入」', 'var(--orange)');
      const box = $('#doujin-import-path');
      if (box) { box.focus(); if (!box.value) box.placeholder = `例如：D:\\data\\${f.name}`; }
    });

    $('#doujin-import-go')?.addEventListener('click', () => {
      const p = String($('#doujin-import-path')?.value || '').trim().replace(/^"(.*)"$/, '$1');
      if (!p) { djiSay('先填一个路径再点它', 'var(--orange)'); return; }
      void runDoujinImport(p);
    });

}

function renderSearchSection(c) {
  // 每个提供方区块的初始显隐都要跟当前 provider 一致
  const prov = String(c.webSearch?.provider || 'bing');
  // 自定义搜索提供商列表（可多个），用于动态生成下拉框选项
  const customProvs = Array.isArray(c.webSearch?.providers) ? c.webSearch.providers : [];
  return `
    <!-- ⛔ 本子查询的设置**已整段搬到技能页**（2026-09-23 第十二对话，用户点名：
         "skill 和插件是为了方便安装卸载新增才开发的，加到设置页有点不合理"）。
         字段本身由 skills/doujin-lookup/skill.json 的 configSchema 声明（通用表单渲染），
         「检测连通 / 试查一次 / 导入离线库」那几个动作也在技能页的「配置」里
         （见 ui/app.js 的 SKILL_ACTION_PANELS）。
         ⇒ **不要再把表单加回来**：两处都能改必然漂移。
         🆕 2026-10-05（第四十三对话 · 用户要求）：**原来这里还有一行 .hint 指路，已删** ——
            用户原话"这句说明可以去掉了…说明还带了一个滑条，有点占地方"。
            ⚠️ 那个滑条的真正来源是**紧跟在 .hint 后面那两个多余的 &lt;/div&gt;**（没有配对的开始标签，
            浏览器只能自己造一个容器 ⇒ 那一块变成可滚动的）。**两个都删了**，这一节的层级恢复正常。
            ⇒ 想给她指路就写进「本页说明」（save-bar 的 ？，见 SETTINGS_PAGE_HELP），
            ⛔ 别再把常显说明加回这一节（.hint 有"只减不增"的棘轮，见 test-设置页说明小字分层.mjs）。
            🔴 本段在**模板字符串里面** ⇒ ⛔ 一个字反引号都不许有（写标签用 &lt;/div&gt; 这种转义）。 -->
    <h3 id="settings-search">搜索服务</h3>
    <!-- 🆕 2026-10-05（第四十三对话 · 交接 §3-105 / 调研-能力开关归位）：两个**能力开关**
         （联网搜索、以图搜图）**已搬去「她的能力」那一节** —— 用户拍板"都搬"，
         理由是"她能不能用某个能力"散在各页时，用户要给她开关得先猜它在哪一页。
         ⛔ 别把它们加回来：新位置与旧位置同时渲染 ⇒ 两个真相源。
         （⛔ 也别在这里写 id="cfg-websearch" 之类的字样 —— 判据是**按 id 在不在这个函数里**判的。）
         ⚠️ 留在这里的是"基础设施"一档：搜索提供方 / API Key / 图片体积上限 / CF 绕过 / 看图配额。 -->
    <h3>看图与图片</h3>
    <div class="field">
      <label>看图（视觉）的体积上限</label>
      <div class="field-row">
        <div class="field"><label>单张原图（KB）</label>
          <input type="number" id="cfg-img-maxkb" min="1" max="32768" value="${esc(c.imageLimits?.maxKB ?? 700)}" /></div>
        <div class="field"><label>一轮累计（MB）</label>
          <input type="number" id="cfg-img-maxrun" min="1" max="64" value="${esc(c.imageLimits?.maxRunMB ?? 3)}" /></div>
        <div class="field"><label>一次最多看几张</label>
          <input type="number" id="cfg-img-perview" min="1" max="50" value="${esc(c.imageLimits?.maxPerView ?? 6)}" /></div>
        <div class="field"><label>下载阶段上限（MB）</label>
          <input type="number" id="cfg-img-maxdl" min="1" max="128" value="${esc(c.imageLimits?.maxDownloadMB ?? 12)}" /></div>
      </div>
      <div class="hint">
        超过「单张原图」的图<b>直接拒绝</b>（只有动画 GIF 会先截首帧再比），模型收到一句"图太大"。改完<b>不用重启</b>。
        <b>真正的代价是图片 token</b>：调得越大，它就越会真去看大图，每次看图都按输入 token 计费。
      </div>
      <details class="hint-more">
        <summary>默认值是怎么定的、调大会怎样？</summary>
        <div class="hint-more-body">
          默认 700KB 是当初为了防网关 413 定的；实测网关 <b>32MB 能过、48MB 才 413</b>，所以往上调是安全的。
          「一次最多看几张」会写进工具描述，<b>改它等于换一次提示词前缀</b>（前缀缓存要重新热身一次，一次性成本）。
        </div>
      </details>
    </div>
    <div class="field-row">
      <div class="field"><label>SauceNAO API Key（可选）</label>
        <input type="password" id="cfg-saucenao-key" value="${esc(c.imageSearch?.hasSaucenaoApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" />
        <details class="hint-more"><summary>这是干嘛的、去哪申请？</summary>
          <div class="hint-more-body">注册 saucenao.com 账号免费获取；填了走官方 JSON API，更稳且不怕网页改版。</div>
        </details></div>
      <!-- 🆕 2026-10-05（第四十三对话 · 交接 §3-113）：pixiv 登录态。**由用户自己粘**（不经过任何人）。
           ⚠️ 它只在**配了代理**时才有意义（直连到不了 p 站）。 -->
      <div class="field"><label>pixiv 会话 cookie（可选）</label>
        <input type="password" id="cfg-pixiv-cookie" value="${esc(c.imageSearch?.hasPixivCookie ? '******' : '')}" placeholder="粘贴 Cookie（至少含 PHPSESSID=…）；留空保持不变" autocomplete="new-password" /></div>
    </div>
    <!-- ⚠️ 这句是"代价如实说"，不是可选美化：掉线**不会自愈**，不说清楚就会变成静默失效。 -->
    <div class="hint" style="font-size:12px;margin:-4px 0 10px">
      ⚠️ <b>pixiv 登录态</b>：填了它，她才搜得到 p 站的 <b>R-18</b>（匿名下 <code>mode=r18</code> 会被静默忽略）。
      这份 cookie <b>只会发给 <code>*.pixiv.net</code> / <code>*.pximg.net</code></b>，别的站一个字都带不出去；
      它也<b>不会</b>出现在任何接口返回里（服务端只回一个"填没填"）。
      <b>它会过期</b>，而 p 站登录带人机验证 ⇒ <b>掉线只能你本人回来重贴一次</b>，不会自愈。
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-cfbypass" ${c.imageSearch?.cfBypass !== false ? 'checked' : ''} />
      <label for="cfg-cfbypass">Cloudflare 验证自动绕过（被拦截时用内置浏览器自动完成验证，仅限搜图引擎域名）</label></div>
    <!-- 🆕 2026-10-05（第四十三对话 · 交接 §3-105）：搜图触发策略 / 两个"单次运行上限"与两个
         能力开关一起搬去了「她的能力」。留在这里的是基础设施（提供方 / Key / 体积配额 / CF 绕过）。 -->
    <div class="hint" style="font-size:12px;margin:-4px 0 10px">
      ⚠️ <b>发出去的图片链接有硬边界</b>：只允许发<b>本轮她自己找回来</b>（search_images）
      或<b>刚看过</b>（get_message_images）的图 —— 自己拼的、别处抄的一律拒绝，
      并强制过公网校验（挡内网地址）。这条是代码层，改不了。
    </div>
    <h3>网页搜索</h3>
    <div class="field"><label>搜索提供方</label>
      <select id="cfg-searchprovider">
        <option value="bing" ${prov === 'bing' ? 'selected' : ''}>Bing 网页解析</option>
        <option value="deepseek" ${prov === 'deepseek' ? 'selected' : ''}>DeepSeek 原生搜索</option>
        <option value="zhipu" ${prov === 'zhipu' ? 'selected' : ''}>智谱 Web Search</option>
        <option value="bocha" ${prov === 'bocha' ? 'selected' : ''}>博查 AI Search</option>
        <option value="baidu" ${prov === 'baidu' ? 'selected' : ''}>百度千帆 AI Search</option>
        <option value="metaso" ${prov === 'metaso' ? 'selected' : ''}>秘塔 AI 搜索</option>
        ${customProvs.map((p) => `<option value="custom:${esc(p.id)}" ${prov === `custom:${p.id}` ? 'selected' : ''}>${esc(p.name || p.baseUrl)}（自定义 · ${p.type === 'bing' ? '网页解析' : 'JSON 接口'}）</option>`).join('')}
      </select></div>
    <div class="field" id="custom-provider-manage" style="${prov.startsWith('custom:') ? '' : 'display:none'}">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="test-search-provider-btn">测试这个搜索服务</button>
        <button class="btn btn-small btn-danger" id="del-search-provider-btn">删除这个搜索服务</button>
        <span id="search-provider-action-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>
    <div class="field" id="bing-search-fields" style="${prov === 'bing' ? '' : 'display:none'}"><label>搜索地址（高级：可替换为兼容 Bing 结果格式的引擎）</label><input type="text" id="cfg-searchurl" value="${esc(c.webSearch?.searchUrl || 'https://cn.bing.com/search')}" /></div>
    <div class="field-row" id="deepseek-search-fields" style="${prov === 'deepseek' ? '' : 'display:none'}">
      <div class="field"><label>DeepSeek 搜索 API Key（留空用环境变量 DEEPSEEK_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-ds-searchkey" value="${esc(c.webSearch?.deepseek?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-ds-searchkey-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>模型</label><input type="text" id="cfg-ds-searchmodel" value="${esc(c.webSearch?.deepseek?.model || 'deepseek-v4-pro')}" />
        <div class="hint">必须是账号里真实存在、<b>且支持 web_search 工具</b>的模型。
          ⚠️ <b>写错模型不会报错，只会让搜索悄悄失效</b>。</div>
        <details class="hint-more">
          <summary>说明：哪些模型名可用、写错会怎样</summary>
          <div class="hint-more-body">
            实测 <code>deepseek-v4-pro</code> 会真的联网；<code>deepseek-flash</code> 会忽略联网工具、
            直接回答"我无法联网搜索"；<code>deepseek-v4-flash</code> 这个模型名不存在，
            API 会静默回退到 flash。
          </div>
        </details></div>
    </div>
    <div class="field-row" id="zhipu-search-fields" style="${prov === 'zhipu' ? '' : 'display:none'}">
      <div class="field"><label>智谱 API Key（留空用环境变量 ZHIPU_API_KEY）</label>
        <div style="display:flex;gap:8px">
          <input type="password" id="cfg-zhipu-key" value="${esc(c.webSearch?.zhipu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
          <button class="btn btn-small" id="cfg-zhipu-key-toggle" type="button">显示</button>
        </div></div>
      <div class="field"><label>搜索引擎</label>
        <select id="cfg-zhipu-engine">
          <option value="search_std" ${c.webSearch?.zhipu?.engine === 'search_std' ? 'selected' : ''}>基础版 ¥0.01/次</option>
          <option value="search_pro" ${c.webSearch?.zhipu?.engine === 'search_pro' ? 'selected' : ''}>高级版 ¥0.03/次</option>
          <option value="search_pro_sogou" ${c.webSearch?.zhipu?.engine === 'search_pro_sogou' ? 'selected' : ''}>搜狗版 ¥0.05/次</option>
          <option value="search_pro_quark" ${c.webSearch?.zhipu?.engine === 'search_pro_quark' ? 'selected' : ''}>夸克版 ¥0.05/次</option>
        </select></div>
    </div>
    <div class="field" id="bocha-search-fields" style="${prov === 'bocha' ? '' : 'display:none'}">
      <label>博查 API Key</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-bocha-key" value="${esc(c.webSearch?.bocha?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-bocha-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="baidu-search-fields" style="${prov === 'baidu' ? '' : 'display:none'}">
      <label>百度千帆 API Key（留空用环境变量 BAIDU_SEARCH_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-baidu-key" value="${esc(c.webSearch?.baidu?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-baidu-key-toggle" type="button">显示</button>
      </div></div>
    <div class="field" id="metaso-search-fields" style="${prov === 'metaso' ? '' : 'display:none'}">
      <label>秘塔 API Key（可选，留空用官方免费额度 / 环境变量 METASO_API_KEY）</label>
      <div style="display:flex;gap:8px">
        <input type="password" id="cfg-metaso-key" value="${esc(c.webSearch?.metaso?.hasApiKey ? '******' : '')}" placeholder="输入新 Key 可替换；留空保持不变" autocomplete="new-password" style="flex:1" />
        <button class="btn btn-small" id="cfg-metaso-key-toggle" type="button">显示</button>
      </div></div>

    <h3>添加自定义搜索服务</h3>
    <div class="field-row">
      <div class="field"><label>名称（自己辨认用）</label>
        <input type="text" id="new-sp-name" placeholder="例如：自建 SearXNG" /></div>
      <div class="field"><label>类型</label>
        <select id="new-sp-type">
          <option value="openai">JSON 搜索接口（POST）</option>
          <option value="bing">网页解析（Bing 结果格式）</option>
        </select></div>
    </div>
    <div class="field"><label>接口地址 / 搜索页地址</label>
      <input type="text" id="new-sp-baseurl" placeholder="JSON 类型：https://your-search.example.com/search；网页类型：https://your-searx.example.com/search" style="width:100%" /></div>
    <div class="field-row">
      <div class="field"><label>API Key（可选）</label>
        <input type="password" id="new-sp-apikey" placeholder="多数自建服务留空即可" autocomplete="new-password" style="width:100%" /></div>
      <div class="field"><label>模型名（可选）</label>
        <input type="text" id="new-sp-model" placeholder="Responses API 风格才需要" /></div>
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin:8px 0">
      <button class="btn btn-small" id="add-search-provider-btn">＋ 添加并选中</button>
      <span id="add-search-provider-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;
}

function renderMemorySettingsSection(c) {
  const mem = c.memory || {};
  const providers = state.providers || [];
  const useChat = mem.useChatModel !== false;
  const selP = providers.find((p) => p.id === mem.provider);
  const currentDisplay = selP ? `${selP.displayName || selP.id} · ${mem.model || '未选模型'}` : (mem.model || '未选模型');
  return `
    <h3 id="settings-memory">印象整理</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-consolidate" ${mem.consolidateEnabled !== false ? 'checked' : ''} />
      <label for="cfg-mem-consolidate">启用印象自动整理</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-mem-usechat" ${useChat ? 'checked' : ''} />
      <label for="cfg-mem-usechat">使用与聊天机器人相同的模型</label></div>
    <div id="mem-model-box" style="${useChat ? 'display:none' : ''}">
      <div class="field"><label>印象整理模型（点击选择）</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-mem-model-pick" readonly placeholder="点击选择模型" value="${esc(currentDisplay)}" style="flex:1;cursor:pointer" />
        </div>
        <div class="hint" id="mem-model-hint">${selP ? `当前：${esc(selP.displayName)} @ ${esc(selP.baseURL)}` : '尚未选择专用模型'}</div>
        <input type="hidden" id="cfg-mem-provider" value="${esc(mem.provider || '')}" />
        <input type="hidden" id="cfg-mem-model" value="${esc(mem.model || '')}" />
      </div>
    </div>
    <div class="field"><label>整理冷却时间（分钟）</label><input type="number" id="cfg-mem-interval" min="30" step="10" value="${esc(msToMin(mem.consolidateMinIntervalMs, 360))}" /></div>
    <div class="hint">两个条件<b>都</b>满足才整理：条数超过阈值，且距上次整理超过这个冷却时间。默认 6 小时。</div>`;
}

/**
 * 「系统提示自定义」区块。
 * 内置系统提示硬编码在 src/prompt.js（安全规则/工具协议/反 AI 味…），原设置页只能
 * 看不能改。这里提供两个入口，写进 persona 的两个字段：
 *   1. 整份替换 —— persona.systemPrompt
 *   2. 逐段替换 —— persona.systemPromptSegments[key]
 * 逐段输入框预填"当前生效文本"（没有覆盖就是内置默认），保存时与加载到的内置默认比较，
 * 一致就不写覆盖 —— 于是"改回默认"等价于自动取消该段覆盖。
 */
function renderSystemPromptEditor(c) {
  const persona = c.persona || {};
  const sp = state.systemPrompt;
  const overrides = persona.systemPromptSegments || {};
  const overrideCount = Object.values(overrides).filter((v) => String(v ?? '').trim()).length;
  const fullText = String(persona.systemPrompt || '');
  const fullOverride = fullText.trim();

  // 生效状态徽标（反映已保存的配置；未保存的改动由 #sysprompt-state 单独提示）
  const badge = fullOverride
    ? '<span class="sp-badge sp-badge-full">整份覆盖</span>'
    : overrideCount
      ? `<span class="sp-badge sp-badge-seg">逐段覆盖 ${overrideCount} 段</span>`
      : '<span class="sp-badge sp-badge-default">内置默认</span>';
  const mode = fullOverride
    ? '当前生效：整份覆盖'
    : (overrideCount ? `当前生效：逐段覆盖 ${overrideCount} 段` : '当前生效：内置系统提示');

  // 这几段的**内置默认按平台不同**（buildDefaultSegments 的四处分叉）⇒ 标题上标出看的是哪一版，
  // 免得出现"标题写 QQ、内容其实是微信"（2026-09-25 用户当场看出来的那个坑）。
  const PLATFORM_VARY = new Set(['intro', 'toolProtocol', 'stickerRules', 'qqSceneRules']);
  const platTag = (sp && sp.platform === 'wechat') ? '微信版' : 'QQ版';
  const segHtml = sp
    ? sp.segments.map((s) => {
      const overridden = String(overrides[s.key] ?? '').trim();
      const cur = overridden || s.default || '';
      const title = PLATFORM_VARY.has(s.key) ? `${s.label}（${platTag}）` : s.label;
      // data-default 存内置默认，供「恢复默认」按钮和实时「已覆盖」标记比对用
      return `<div class="sp-seg">
        <div class="sp-seg-head">
          <span class="sp-seg-title">${esc(title)}</span>
          <span class="sp-badge sp-badge-seg sp-seg-flag${overridden ? '' : ' hidden'}">已覆盖</span>
          <span class="sp-seg-count">${cur.length} 字符</span>
          <button type="button" class="btn btn-small sp-seg-reset" title="恢复为内置默认文本">恢复默认</button>
        </div>
        <textarea class="persona-role-text sysprompt-seg" data-seg-key="${esc(s.key)}" data-default="${esc(s.default || '')}" spellcheck="false">${esc(cur)}</textarea>
      </div>`;
    }).join('')
    : '<div class="hint">未能读取内置段落（后端没有返回 /api/system-prompt）。为安全起见，本次保存不会改动已有的逐段覆盖。</div>';

  return `
    <details class="collapsible sp-editor" id="sysprompt-box">
      <summary>
        <span class="sp-summary-title">系统提示自定义</span>
        <span class="sp-summary-sub">高级 · 修改内置提示词</span>
        ${badge}
      </summary>
      <div class="coll-body">
        <div class="sp-callout">
          <span class="sp-callout-icon">⚠</span>
          <div>整份替换会连工具协议一起覆盖（如「发言必须调用 send_message」），删掉那段机器人就不会再说话。建议先「载入内置默认」再改，或优先用下面的逐段替换。</div>
        </div>
        <div class="hint sp-explain">
          保存后<b>下一条消息</b>即生效，无需重启。优先级：完整系统提示 &gt; 逐段替换 &gt; 内置默认。
          覆盖文本可用 <code>{botName}</code>、<code>{participation}</code> 占位符。
        </div>
        <div class="sp-callout">
          <span class="sp-callout-icon">🆕</span>
          <div><b>逐段替换分 QQ / 微信两套</b>（2026-09-25 起）：下面每个框编辑的是
            <b>当前平台（${platTag === '微信版' ? '微信' : 'QQ'}）</b>那一套 —— 标题里带「（${platTag}）」的段，
            内置默认本来就按平台不同。切到另一个平台页签就能改那一套，两套互不影响。
            <b>留空 = 用内置的平台版</b>。<br>
            当前已覆盖：<b>QQ 侧 ${(sp && sp.overrideCounts && sp.overrideCounts.qq) || 0} 段</b> ·
            <b>微信侧 ${(sp && sp.overrideCounts && sp.overrideCounts.wechat) || 0} 段</b>。
            ⚠️ 别把 QQ 的说法抄进微信那套 —— 微信没有拍一拍/表情包能力，
            那样会<b>诱导她去调一个不存在的能力</b>。</div>
        </div>
        <div class="field"><label>完整系统提示（留空 = 使用内置）</label>
          <textarea id="cfg-sysprompt" class="persona-role-text sp-full-text" placeholder="留空即使用内置系统提示。点下方「载入内置默认」可把内置提示填进来再改。" spellcheck="false">${esc(persona.systemPrompt || '')}</textarea></div>
        <div class="sp-toolbar">
          <button class="btn btn-small" id="sysprompt-load">载入内置默认</button>
          <button class="btn btn-small" id="sysprompt-clear">清空整份覆盖</button>
          <span id="sysprompt-count" class="sp-seg-count">${fullText.length} 字符</span>
          <span id="sysprompt-state" class="sp-state">${esc(mode)}</span>
        </div>
        <details class="sp-segments">
          <summary>逐段替换<span class="sp-summary-sub">只改其中几段，推荐</span></summary>
          <div class="sp-seg-list">${segHtml}</div>
        </details>
      </div>
    </details>`;
}

function renderPersonaSection(c) {
  return `
    <h3>人设</h3>
    ${renderPersonaPicker(c)}
    <div class="field-row">
      <div class="field"><label>机器人名字</label><input type="text" id="cfg-botname" value="${esc(c.persona.botName)}" /></div>
      <div class="field"><label>群内展示名（可选）</label><input type="text" id="cfg-selfnick" value="${esc(c.persona.selfNickname || '')}" /></div>
      <div class="field"><label>参与度</label>
        <select id="cfg-participation">
          <option value="low" ${c.persona.participation === 'low' ? 'selected' : ''}>安静型</option>
          <option value="medium" ${c.persona.participation === 'medium' ? 'selected' : ''}>普通群友</option>
          <option value="high" ${c.persona.participation === 'high' ? 'selected' : ''}>活跃型</option>
        </select></div>
    </div>
    <div class="field"><label>角色设定</label>
      <textarea id="cfg-roletext" class="persona-role-text" placeholder="例如：你是运维群里的老油条……">${esc(c.persona.roleText || '')}</textarea></div>
    <div class="field"><label>管理员附加规则（可选，追加到系统提示）</label>
      <textarea id="cfg-customrules" class="persona-role-text" style="min-height:100px">${esc(c.persona.customRules || '')}</textarea></div>
    ${renderSystemPromptEditor(c)}
    ${renderPersonaSaveBar()}`;
}

/**
 * 聊天白名单（UI 改造第二阶段 条目 6 重写）。
 *
 * 🔴 方案原文：「核心问题是「复选框 × 两个可空列表」交互产生四种语义，两段说明文字是打补丁。
 *   **改三选一模式单选**：允许所有会话 / 禁止所有会话 / 只运行在白名单（默认）——
 *   复选框与说明文字全删，空列表行为由模式自明。逗号文本框改**芯片输入**。
 *   仅存一行「与『微信联系人』勾选共用同一份配置 ⓘ」」
 *
 * ⚠️ 模式值的来源：`allow.mode`。老配置没有这个键时**按旧语义推导**（`deriveAllowModeUi`），
 *    保证"还没迁移/迁移失败"时界面显示的是**真实生效的那个模式**，而不是默认值。
 *    （后端的 allowed() 也是同样的兜底逻辑 —— 两边必须一致，否则界面会说谎。）
 */
/**
 * 允许模式的三个取值（与后端 `allowed()` 里的 ALLOW_MODES 必须一致）。
 * ⚠️ 前端这份只用于"校验读到的值合不合法"，判定权威永远在后端。
 */
const ALLOW_MODES_UI = ['allowAll', 'denyAll', 'whitelist'];

function deriveAllowModeUi(c) {
  const g = (c.allow?.groups || []).filter((x) => String(x).trim() !== '');
  const p = (c.allow?.private || []).filter((x) => String(x).trim() !== '');
  if (g.length || p.length) return 'whitelist';
  return c.allowAllWhenEmpty === true ? 'allowAll' : 'denyAll';
}

/**
 * 名单芯片（`.chipbox` / `.wchip`）标记的**唯一一处**生成 ——
 * 聊天白名单（群 / 好友）与「她的能力」里的管理员号**共用同一套控件**
 * （2026-10-04 第四十二对话 · 调研 §3：⛔ 不新造第二种输入）。
 *
 * 为什么能共用：增删接线是**容器级事件委托**，按 `data-chipinput` / `data-rm` 认盒子
 *   （`bindAllowChips()`，15-allow-saveconfig.js）⇒ 多一种 `data-chipbox` 就自动可用，
 *   不需要为「管理员号」再绑一套监听（再绑一套 = 第二个可能忘记绑的地方）。
 *
 * ⚠️ 三条不许改的细节：
 *   ① 前缀与号码之间**必须留一个空格** —— `readAllowChips()` 靠"去掉第一个词"把号码抠回来
 *      （正则 `^[^ ]+` 后面跟任意空白，见 `readAllowChips`）。前缀里再出现空格、
 *      或者忘了这个空格，号码就会被切坏。
 *      🔴 这条注释里**不许**把那句正则逐字抄进来：它含 `星号 + 斜杠` 这两个字符的相邻组合，
 *        会把这段块注释**提前闭合**（实测 `node --check` 当场报 `Unexpected token ','`，
 *        而页面在浏览器里直接整段坏掉）。
 *   ② 前缀同时写进 `data-chiplabel` —— `setAllowChips()` 重建芯片时从**盒子自己**读标签，
 *      标签只有一个真相源（盒子），不在渲染与保存两处各写一份默认值。
 *   ③ 类名只有 `grp` / `frd` 两种（既有的两种配色）⇒ 管理员号沿用 `frd`，
 *      ⛔ 不为它新加 CSS 类（这一页"长得不一样"的东西越少越好）。
 */
function chipHtml(kind, prefix, id) {
  const cls = kind === 'groups' ? 'grp' : 'frd';
  return `<span class="wchip ${cls}"
      >${esc(prefix)} ${esc(id)}<span class="wchip-x" data-rm="${kind}" data-id="${esc(id)}" role="button" tabindex="0" title="移除">×</span></span>`;
}

/** 一个 `.field` 里的芯片盒（`ids` 是初始名单，可为空数组；`disabled` 只在能力关掉时给）。 */
function chipBoxHtml(kind, prefix, label, placeholder, ids, disabled = false) {
  return `
    <div class="field">
      <label>${esc(label)}</label>
      <div class="chipbox" data-chipbox="${kind}" data-chiplabel="${esc(prefix)}">
        ${(ids || []).map((id) => chipHtml(kind, prefix, id)).join('')}
        <input type="text" inputmode="numeric" data-chipinput="${kind}" ${disabled ? 'disabled' : ''}
               placeholder="${esc(placeholder)}" aria-label="${esc(label)}">
      </div>
    </div>`;
}

function renderAllowSection(c) {
  const mode = ['allowAll', 'denyAll', 'whitelist'].includes(c.allow?.mode)
    ? c.allow.mode
    : deriveAllowModeUi(c);   // 老配置没有 mode ⇒ 按旧语义推导（与后端 allowed() 一致）
  const groups = (c.allow?.groups || []).map(String);
  const privates = (c.allow?.private || []).map(String);

  const MO = [
    ['allowAll', '允许所有会话', '任何群聊和私聊都会响应 —— 黑名单里的人除外'],
    ['denyAll', '禁止所有会话', '谁都不响应（临时停机用；比「暂停」更彻底）'],
    ['whitelist', '只运行在白名单', '只有下面名单里的群和好友会响应（默认）'],
  ];

  // ⚠️ `.mo-body` 那一层块容器**不能省**（2026-10-01 UI 改造第三阶段 条目 3 根因）：
  //    下面两个都是 <span>，没有块级容器时它们**都是行内元素**，`margin-top` 无效
  //    ⇒ "标题"与"说明"首尾相接挤成一句（读起来像"只运行在白名单只有下面名单里的群和好友会响应"）。
  const modeOpt = ([v, title, desc]) => `<label class="modeopt${mode === v ? ' on' : ''}">
      <input type="radio" name="allow-mode" value="${v}" ${mode === v ? 'checked' : ''}>
      <span class="mo-body"><span class="mo-title">${title}</span><span class="mo-desc">${desc}</span></span>
    </label>`;

  // 芯片输入：一个群一个芯片，点 × 删；回车或点「添加」加。
  // ⚠️ 前缀区分群与好友（方案要求）：`群 123456` / `好友 123456` —— 两类 id 都在同一个
  //    数字空间里，不标前缀的话用户分不清这个数字是群还是人。
  // 🆕 2026-10-04：标记生成搬进了 `chipBoxHtml()` —— 「她的能力」那节的管理员号用**同一份**
  //    （原来这里有一份局部 `chip()`/`box()`，两份一模一样的东西迟早会漂）。
  return `
    <h3 id="settings-allow">聊天白名单</h3>
    <div class="modepick" id="allow-mode-pick">${MO.map(modeOpt).join('')}</div>
    <div class="field-row" style="margin-top:12px">
      ${chipBoxHtml('groups', '群', '允许的群', '输入群号后回车', groups)}
      ${chipBoxHtml('private', '好友', '允许的好友', '输入 QQ 号后回车', privates)}
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px">
      <button class="btn btn-small" id="pick-groups-btn">从 QQ 账号选群</button>
      <button class="btn btn-small" id="pick-friends-btn">从 QQ 账号选好友</button>
      <span id="pick-result" class="muted"></span>
      <span id="allow-hint" class="muted" style="font-size:12px"></span>
    </div>
    ${hintLine('与「微信联系人」勾选共用同一份配置。',
      '微信联系人在「设置 → 微信联系人」里勾选，勾上就是把人加进这里的好友名单 —— 两边是同一份 allow.private，'
      + '在哪边改都生效。名单里的数字：群号来自 QQ 群；微信好友的 id 是从收到的微信消息里学到的派生数字，'
      + '所以别手填，去「微信联系人」页点选。')}`;
}

/**
 * 「她的能力」（2026-10-04 第四十对话 · 批 3，方案 §1.2 / 用户拍板 Q5）
 *
 * 为什么单开一节：原来"她能不能用某个只读工具"散落在各处（用量自检在「用量与成本」页、
 * 搜图在「搜索服务」页…），用户要给她开/关一个能力得先猜它在哪一页。
 * ⇒ 这一节是**以后这类开关的统一落点**（第一个住进来的是「别处的我」）。
 *
 * ⚠️ 三条纪律（改这一节之前先读）：
 *   ① 开关样式**复用**现有的 `.checkbox-row` / `.field select` / `.field input`，
 *      ⛔ 不新造样式（这一页里"长得不一样"的东西越少，越不容易显得像两个产品）。
 *   ② 保存走**通用的保存按钮**（`saveConfig()` 里按 `state.settingsSection === 'abilities'`
 *      收这三项），⛔ 不在这里自己 POST —— 与本页其它分区保持同一条路径。
 *   ③ 🆕 2026-10-04（第四十二对话 · 调研 §3）：`ownerIds` **现在有输入框了** —— 用户撤销了
 *      第四十对话的 Q6「先不填号」。控件就是白名单那套芯片（`chipBoxHtml('owners', …)`），
 *      ⛔ 没新造第二种输入。语义仍要**如实写清**：填了号**还要**把「谁能问」选成
 *      「只认管理员本人」才真的收紧；号删光了会如实退回「任何私聊」（那条后端边界没动）。
 */
function renderAbilitiesSection(c) {
  const se = c.selfElsewhere || {};
  const enabled = se.enabled !== false;
  const who = String(se.whoCanAsk || 'private');
  const ownerIds = Array.isArray(se.ownerIds) ? se.ownerIds.filter(Boolean) : [];
  // 🆕 2026-10-05（第四十三对话 · 交接 §3-105 / 调研-能力开关归位）：从「搜索服务」搬来的
  //    那几个能力开关要读的值。⚠️ 默认方向**原样保留**：两个 enabled 都是 `!== false`（默认开），
  //    ⛔ 不许在搬家路上写成 `=== true`（那会把"默认开"静默变成"默认关"）。
  const web = c.webSearch || {};
  const img = c.imageSearch || {};
  // ⚠️ 这一节**一个新 `.hint` 都不许加**：`test-设置页说明小字分层.mjs` 有一条棘轮
  //    （`class="hint"` 计数 ≤ 44，"本轮只减不增"）。所以说明一律走既有的两级载体：
  //      · 一行常显 / 一句要点 ⇒ `hintLine(…)`（= `.ihint-line` + ⓘ）
  //      · 细节 ⇒ 原生 `<details class="hint-more">` + `.hint-more-body`
  //    ⛔ 也别自己写折叠/样式（"折叠长什么样"只有一处定义）。
  return `
    <h3>她的能力</h3>
    ${hintLine('她能用哪些「只能看、不会改」的能力。关掉立刻生效（不用重启）。',
      '关掉一个能力时，提示词里教她怎么用的那句话会一起消失 —— 不会出现"提示词让她调一个不存在的工具"。')}

    <div class="form-panel">
      <h4 style="margin-top:0">搜索与找图</h4>
      <div class="checkbox-row"><input type="checkbox" id="cfg-websearch" ${web.enabled !== false ? 'checked' : ''} />
        <label for="cfg-websearch">联网搜索：启用 web_search / web_fetch 工具</label></div>
      ${hintLine('关掉它，她就没有联网搜索与抓网页这两个能力。',
        '搜索提供方、API Key、搜索地址这些"基础设施"仍留在「搜索服务」页 —— 这里只管"她能不能用这个能力"。')}
      <div class="checkbox-row"><input type="checkbox" id="cfg-imagesearch" ${img.enabled !== false ? 'checked' : ''} />
        <label for="cfg-imagesearch">以图搜图：启用 search_image_source 工具（trace.moe / SauceNAO / iqdb / 搜图 bot，均免 Key）</label></div>
      <div class="field-row">
        <div class="field"><label>搜图触发策略</label>
          <select id="cfg-imagesearch-policy">
            <option value="asked" ${(img.policy || 'asked') === 'asked' ? 'selected' : ''}>只在有人问出处 / 要图时才搜（推荐）</option>
            <option value="free" ${img.policy === 'free' ? 'selected' : ''}>交给模型自己判断（容易看到图就搜）</option>
          </select>
          ${hintLine('「只在被要求时」是代码层拦截，不只靠提示词；这一个开关同时管两条路：按图查出处、按关键词找图（找图后会发出去）。')}
          <details class="hint-more">
            <summary>说明：什么算"被要求"</summary>
            <div class="hint-more-body">
              两条路各有一套判据（"求出处 / 什么番 / 画师"和"来张图 / 发张看看"），
              但都由这里这<b>一个开关</b>控制。判据会看<b>最近几条别人发的消息</b>（15 分钟内），
              不只看触发这一句 —— 所以「来张小猫图片」之后再说「再试试」不会被误拦。<br>
              都没匹配上时，工具会直接拒绝，并提示模型先问一句"要我找张图吗"再搜。
            </div>
          </details>
        </div>
        <div class="field"><label>单次运行最多真搜几次</label>
          <input type="number" id="cfg-imagesearch-max" min="1" max="10" value="${esc(img.maxPerRun ?? 2)}" />
          ${hintLine('上限只统计真正打到引擎的次数，参数写错不占额度。')}
          <details class="hint-more">
            <summary>说明：为什么要设这个上限</summary>
            <div class="hint-more-body">
              实测一次运行会把多个引擎挨个试一遍（同一张图搜 5 次），又慢又费 SauceNAO 额度。
            </div>
          </details>
        </div>
      </div>
      <div class="field"><label>单次运行最多找几次图</label>
        <input type="number" id="cfg-imagesearch-keyword-max" min="1" max="10" value="${esc(img.keywordMaxPerRun ?? 2)}" />
        ${hintLine('与上面「单次运行最多真搜几次」各算各的：一次运行里"查出处的图"和"找新图"是两件事。')}
      </div>
      <!-- 🆕 2026-10-05（第四十四对话 · **她自己的提案 f3bebcf7**）：把这两个数从"写死在代码里"
           挪到界面上。她原话：「单次返回张数上限（默认 6，上限 12）只写在提示词和内核默认值里，
           管理端 GUI 上看不到也改不了」。
           ⚠️ 默认值由 value 现读配置 ⇒ ⛔ 别在这里写死 6/12（那会造成"界面显示的 ≠ 实际生效的"）。
           ⚠️ "上限"是**硬上限**（她传更大也会被钳）⇒ 两个框的关系是"默认 ≤ 上限"。
           🔴 本段在模板字符串里 ⇒ ⛔ 一个字反引号都不许有（坑 186）。 -->
      <div class="field-row">
        <div class="field"><label>单次返回张数（默认要几张）</label>
          <input type="number" id="cfg-img-result-limit" min="1" max="50" value="${esc(img.resultLimit ?? 6)}" /></div>
        <div class="field"><label>单次返回张数上限（硬上限）</label>
          <input type="number" id="cfg-img-result-limit-max" min="1" max="50" value="${esc(img.resultLimitMax ?? 12)}" /></div>
      </div>
      <div class="field"><label>单次运行最多发几张图（0 = 不限）</label>
        <input type="number" id="cfg-img-send-max" min="0" max="50" value="${esc(img.sendMaxPerRun ?? 0)}" />
        ${hintLine('限制的是"发"几张（一次搜索能返回多张）；"搜"几次由上面那两个上限管。0 = 不限。')}
      </div>

      <!-- 🆕 2026-10-05（第四十三对话 · 用户要求）：把"搜/发图片"有关的分级开关也收进这一节。
           起因：用户报"群聊似乎还是不能发色图"，而真机+存档查明**代码没拦** ——
           是提示词里两句话（"群里请用 safe"、"别把 questionable 的图发到群里"）让她自己退了，
           而用户的人设卡里明写着允许。⇒ 做成开关（allowR18InGroup），并把它与既有的
           总开关 allowQuestionable 一起放在这里（后者以前**一个控件都没有**）。
           🔴 本段在**模板字符串里面** ⇒ ⛔ 一个字反引号都不许有。 -->
      <h4>图片的分级</h4>
      <div class="checkbox-row"><input type="checkbox" id="cfg-allowquestionable" ${img.allowQuestionable !== false ? 'checked' : ''} />
        <label for="cfg-allowquestionable">允许她找擦边 / R-18 的图（关掉 ⇒ 私聊群聊都拿不到）</label></div>
      ${hintLine('关掉它就是硬拦：不管她要 safe / questionable / any，插画结果里只会剩全年龄；'
        + '被拦掉的图也进不了"本轮可发"名单。',
        '🔴 这条以前只管"她不给 rating 时用哪一档"，而她每次要这类图都会明确指定档位 ⇒ 关掉看着像没生效（2026-10-05 已改成硬拦）。'
        + '她自己会在提示词里看到"管理端关掉了"，被拦时会如实告诉你原因，不会拿全年龄的图顶上去充数。')}
      <div class="checkbox-row"><input type="checkbox" id="cfg-allowr18ingroup" ${img.allowR18InGroup !== false ? 'checked' : ''} />
        <label for="cfg-allowr18ingroup">群聊里也允许她搜 / 发擦边与 R-18</label></div>
      ${hintLine('⚠️ 开着时，群里有人要图她也会去搜 R-18 —— 但 QQ 侧有概率把这类图拦掉、或让对方看不到（她会如实说，不会保证发得出去）。',
        '关掉它，群里她只用全年龄档、也不会把擦边图发出去；私聊完全不受影响。'
        + '这两个开关的口径都会进她的提示词，而且被拦时她会说清是哪一个开关拦的（总开关关着时不会赖到群聊上）。')}
    </div>

    <div class="form-panel">
      <h4 style="margin-top:0">改进提议</h4>
      <!-- 🆕 2026-10-05（第四十四对话 · 用户拍板 B1 / 交接 §3-121）：改进提议的总开关
           （配置键名 proposals.enabled）。
           ⚠️ **这不是"搬家"，是"顺手新做界面"** —— 那个键一直存在且后端一直在判
           （src/proposals.js 里 enabled === false 就直接拒并如实说原因），但界面上**从来没有控件**，
           想关只能手改 config.json。用户拍板「只搬这一个」；其余三组
           （usage / dream.enabled / coreMemory）**维持现状、一个像素都不动**。
           🔴 本段在**模板字符串里面** ⇒ ⛔ 一个字反引号都不许有（坑 186）。 -->
      <div class="checkbox-row"><input type="checkbox" id="cfg-improvement" ${c.proposals?.enabled !== false ? 'checked' : ''} />
        <label for="cfg-improvement">改进提议：允许她提改进建议（记录在「改进提议」页）</label></div>
      ${hintLine('关掉它，她就不能提改进建议了（提了会被直接拒，并如实告诉她为什么）。',
        '提议只会被记录下来、等你自己去看，不会自己改任何东西。'
        + '这一项默认开着；已经提过的那些仍然留在「改进提议」页，关掉它不会删掉任何条目。')}
    </div>

    <div class="form-panel">
      <h4 style="margin-top:0">看自己在别的会话里什么样</h4>
      <div class="checkbox-row"><input type="checkbox" id="cfg-selfelsewhere" ${enabled ? 'checked' : ''} />
        <label for="cfg-selfelsewhere">启用 get_my_self_elsewhere（只读）</label></div>
      ${hintLine('给她的是"别处还有几个会话活着、活不活跃、你最近开过几次口、最后一次是几号几点"这类大概印象。',
        '刻意不给会话名、不给任何人的话、也不给聊天内容 —— 这条边界在代码层做死（返回里连 chatKey 都没有），不是靠提示词求她自觉。'
        + '只在私聊里能用：群里连调都调不到 —— 在群里报出别处的事，正是这个项目最忌讳的那一类。')}

      <div class="field-row">
        <div class="field"><label>谁能问</label>
          <select id="cfg-selfelsewhere-who" ${enabled ? '' : 'disabled'}>
            <option value="private" ${who !== 'ownerOnly' ? 'selected' : ''}>任何私聊（默认）</option>
            <option value="ownerOnly" ${who === 'ownerOnly' ? 'selected' : ''}>只认管理员本人（要在下面填号）</option>
          </select>
          ${ownerIds.length
            ? hintLine(`已填 ${ownerIds.length} 个管理员号（号删光了会如实退回「任何私聊」）。`,
              '它们只用来比对私聊的 QQ 号；要真的收紧，还得把「谁能问」选成「只认管理员本人」。')
            : hintLine('⚠️ 还没填号 ⇒ 现在等于任何私聊；选了「只认管理员本人」也不会真的收紧。',
              '把号填在下面那个框里（回车添加），再选「只认管理员本人」，才真的收紧。')}</div>
        <div class="field"><label>默认看最近几天</label>
          <input type="number" id="cfg-selfelsewhere-days" min="1" max="30" value="${esc(se.days ?? 7)}" ${enabled ? '' : 'disabled'} />
          ${hintLine('1~30 天。她自己调用时传的天数优先。',
            '配置里写了超范围的值也会被钳回 1~30（界面、工具、后端三道都不互相信任）。')}</div>
      </div>
      ${chipBoxHtml('owners', '管理员', '管理员 QQ 号（「谁能问」选了「只认管理员本人」时才生效）',
        '输入 QQ 号后回车', ownerIds, !enabled)}
      <details class="hint-more">
        <summary>这一节是给谁用的、以后还会住什么</summary>
        <div class="hint-more-body">
          这一节的定位是<b>「她能不能用某个只读工具」的统一落点</b> —— 以后这类开关都住这里，
          不必再去「用量与成本」或「搜索服务」页里找。<br>
          「别处的我」是她自己的提案（<code>789584d1</code>）后半条：她想确认"我在别的会话里也是我"，
          但<b>不该</b>因此把别处的事拿到这里说 —— 所以能力给到"大概印象"就停手。
        </div>
      </details>
    </div>`;
}

/**
 * 微信联系人（2026-09-20 第八对话新增）
 *
 * 为什么需要这一节：微信侧的会话 id 是桥**派生出来的数字**（实测某群友 = 1000000001），
 * 而白名单装的就是这个数字；用户在微信里看到的是**昵称** ⇒
 * 不放这个清单出来，想放行某人只能猜数字，而且配错了**没有任何报错**
 * （消息就是静静地不回 —— 本项目最忌讳的那种静默失效）。
 *
 * 数据来源：/api/wechat-contacts（从**收到的微信消息**里学来的）。
 * ⚠️ 第一次放行有"先有鸡还是先有蛋"：没放行 ⇒ 消息进不来 ⇒ 学不到 ⇒ 看不到。
 *    界面必须把这句话说出来，否则用户会以为功能坏了。
 */
function renderWechatContactsSection(c) {
  const list = state.wechatContacts;
  // 🔴 「有人发过消息、但没放行」的提示（2026-09-20 补，并**改成由联系人表派生**）。
  //    为什么必须有：实测里用户在没放行时连发消息，界面上**一点反馈都没有**
  //    ⇒ 只会以为"接微信坏了"，而它其实正常工作、只是没放行。
  //    为什么**派生**而不是另存一份：第一版我在后端内存里记了"最近收到的未放行消息"，
  //    结果 03:07 真收到一条、03:08 一重启就抹掉了 ⇒ 用户什么都看不到。
  //    而联系人表（`wechat-contacts.json`）本来就落盘着 count / lastSeen / allowed ——
  //    **提示要的东西它全有**；再从别处记一份，两份状态必然漂移。
  //    ⚠️ 判据：`count > 0 && !allowed` = 有人敲过门、而且现在还没放行。
  const pending = (Array.isArray(list) ? list : []).filter((x) => (x.count || 0) > 0 && !x.allowed);
  const ago = (ts) => {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return '';
    const m = Math.floor(d / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    return `${Math.floor(m / 60)} 小时前`;
  };
  const blockedHint = pending.length
    ? `<div class="hint" style="margin-bottom:10px;padding-left:8px;border-left:3px solid #e0a030">
         ⚠️ <b>收到过微信消息，但下面这些还没放行 ⇒ 机器人不会回它们。</b><br>
         ${pending.map((x) => `${esc(x.name || x.id)}（${x.count} 条${x.lastSeen ? '，最后一条 ' + ago(x.lastSeen) : ''}）`).join('、')}
         —— 在下面<b>勾选</b>即可开始回话。
       </div>`
    : '';
  const rows = (() => {
    if (list === null || list === undefined) {
      return '<div class="hint">正在读取…（如果一直这样，说明 /api/wechat-contacts 没通）</div>';
    }
    if (!list.length) {
      // 🆕 2026-10-03（第三十六对话 · 交接 §3-36 = 第三阶段方案 §4.7 附的 **E**）：
      //    这一段原来是 **161 字符 / 123 汉字**、三句铺开全常显。按原型已定稿的**四级规范**
      //    （`index.prototype.html:1180-1185`）拆成 **1 行结论 + 二级折叠**。
      //
      //    ⚠️ 拆的时候**一个字都没删**（那是这套规范的关键：体积是**搬走**、不是删掉）——
      //       "先有鸡还是先有蛋"那句是必需的（不说用户会以为功能坏了），现在它在折叠里，
      //       而**原生 `<details>` 的正文 Ctrl+F 仍能搜到**（这正是原型当初选原生 details 的理由）。
      //    ⚠️ 判据：`test-微信联系人设置页.mjs` 明确钉着"空态说清了先有鸡还是先有蛋
      //       （这条文案是有意写长的，别当冗余删掉）" ⇒ 它按 `includes` 找，折叠不影响它。
      //    ⚠️ 结论那行必须留住「让别人给这个小号发一条消息」这几个字 —— 那条判据也钉着它。
      return `<div class="hint">还没有学到任何微信联系人 —— <b>这是正常的"第一次"状态</b>：
        让别人给这个小号发一条消息，或点上面的<b>「↻ 同步名字」</b>。</div>
        <details class="hint-more" style="margin:4px 0 8px">
          <summary>为什么是空的？怎么让它有？</summary>
          <div class="hint-more-body">
            条目来自<b>收到的微信消息</b>，以及<b>点上面的「↻ 同步名字」</b>从微信那边主动问一次。<br>
            而白名单没放行时消息不会进来 ⇒ 第一次放行可以：<b>让别人给这个小号发一条消息</b>
            （那条消息会被挡下，但联系人会被记下来），<b>或者直接点「↻ 同步名字」</b>，然后回到这里勾选放行。
          </div>
        </details>`;
    }
    return list.map((x) => `
      <div class="checkbox-row" style="align-items:center">
        <input type="checkbox" class="wx-contact-cb" data-id="${esc(x.id)}" data-kind="${esc(x.kind)}" ${x.allowed ? 'checked' : ''} />
        <label style="flex:1">
          <b>${esc(x.name || '(没拿到昵称)')}（${esc(x.id)}）（微信）</b>
          <span class="muted">· ${x.kind === 'group' ? '群' : '私聊'}${x.count ? ` · 收到过 ${x.count} 条` : ''}</span>
        </label>
      </div>`).join('');
  })();
  // ── 说明小字分层（2026-10-01 UI 改造第三阶段 条目 2，位置 A/B1/B2）────────────
  // 载体按原型已定稿的四级规范（`index.prototype.html:1180-1185`）摊：**结论留外层 1 行、细节进二级折叠**。
  // 折叠用**原生 `<details class="hint-more">`**（既有件，`style.css:1397-1428`）：
  //   无 JS、天然可访问、**Ctrl+F 仍能搜到折起来的文字** —— 这就是原型选原生 details 的理由。
  // ⚠️ 原来外层那句"与「聊天白名单」是<b>同一份</b>配置……"按 **P6「一句话只准出现一次」删掉了** ——
  //    它与聊天白名单页底部那句是**跨页双向重复**；那个关系现在只在**聊天白名单页**说一次
  //    （那是配置语义的发生处，且那里带 `allow.private` / `allow.groups` 的 key 名，更完整）。
  // ⚠️ "排障：微信通道通没通，看顶栏状态点"原来要移进「？本页说明」（四级里的"汇总"层），
  //    而**上一轮没做那一级**（用户 2026-10-01 拍板先不做）⇒ 上一轮暂放在本折叠里。
  //    🆕 **2026-10-03（第三十四对话）汇总层落地了 ⇒ 它已经搬走**，见
  //    `SETTINGS_PAGE_HELP_EXTRA.wechat`（本页说明面板里那一节）。
  //    ⛔ 别再搬回折叠里：那句是"教用户看已经看得见的东西"（顶栏本来就有状态点），
  //      按 P7 它连二级都不该占，只配待在汇总层。
  return `
    <h3 id="settings-wechat">微信联系人</h3>
    <div class="hint">勾选 = 放行。这里的 id 是微信侧派生出来的<b>数字</b>，别手填。</div>
    <details class="hint-more" style="margin-bottom:10px">
      <summary>名字从哪来的？</summary>
      <div class="hint-more-body">
        名字有两个来源：<b>收到的微信消息</b>（记下 id↔名字）与<b>「↻ 同步名字」</b>（去微信那边现问一次）。
        <br><b>同步只改显示</b> —— 不动白名单、也不动发送对象。
      </div>
    </details>
    ${blockedHint}
    <div class="field"><label>已知的微信联系人 / 群（勾选即放行）</label>
      <div id="wx-contact-list" style="max-height:320px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:8px">
        ${rows}
      </div></div>
    <div class="field" style="display:flex;align-items:center;gap:10px;margin-top:8px">
      <button class="btn btn-small" id="wx-contacts-sync"
        title="去微信那边现问一次名字表（备注/昵称改了之后点它，不用等对方再发消息）">↻ 同步名字</button>
      <span class="muted" id="wx-contacts-sync-hint">改了备注点一下</span>
    </div>`;
}

// 表情包积极程度档位：[值, 显示名]
const STICKER_LEVELS = [
  [0, '0 · 不鼓励（只在很贴切时偶尔用）'],
  [1, '1 · 偶尔（合适时配一张）'],
  [2, '2 · 较积极（优先考虑配图）'],
  [3, '3 · 很积极（表情包爱好者）']
];

// 读取历史档位：名称与说明（档位制，累积生效）
/** 把输入钳制到 [min,max]，非法值退回 fallback。 */
/**
 * 取会话的群名（群聊才有）。
 * 群名由后端 /api/chats 附带（走 OneBot get_group_info，带缓存与超时保护），
 * 拿不到就返回空串 —— 调用方会自动退回只显示群号。
 */
function chatNameOf(chatKey) {
  const c = (state.chats || []).find((x) => x.key === chatKey);
  return String(c?.chatName || '').trim();
}

/**
 * 某个 QQ 号在界面上的名字（2026-09-29 第三十对话加）。
 *
 * 守的是什么（交接 §3-7 缺口②）：记忆页原来一律 `memberNotes[userId] || ... || userId`
 * —— 而线上 `memberNotes` 是**空的**（实测 `{}`）⇒ 白名单里没印象的人、以及"同一个人"
 * 候选清单里的人都只剩一串数字，用户认不出要关联谁。
 *
 * 优先级（**与后端 /api/memory-identity 的合并口径一致**）：
 *   ① `config.memberNotes` —— 用户在界面里手填的备注，**永远是它赢**
 *      （那是用户明确表达的意图，不能被自动学到的名字盖掉）；
 *   ② `/api/memory-identity` 回给这个会话的成员名 —— 后端已经把
 *      「OneBot 好友表（nickname/remark） ∪ 存档里见过的 senderName」并进去了；
 *   ③ 传进来的兜底名（调用方手上现成的，比如记忆文件里的 `m.name`）；
 *   ④ 最后才是数字 id —— UI 本来就这么兜的，**绝不显示空白**。
 *
 * ⚠️ 为什么这里要"再兜一层"而不是只信后端：`/api/memory-identity` 的成员名是按
 *    `平台:id` 去重后的**一条**，而同一个 QQ 号在不同群里可能只有其中一个会话有名字；
 *    而群成员表（`openMemberImpressModal`）是**现拉 OneBot** 的另一条路。两处各兜各的，
 *    任一条断了都还有名字可显示（这正是本条待办当初说"现问 OneBot 就能做"的意思）。
 */
function userNameOf(userId, fallback = '') {
  const id = String(userId ?? '').trim();
  if (!id) return String(fallback || '') || '某人';
  const note = (state.config?.memberNotes || {})[id];
  if (note) return String(note);
  for (const c of (state.identityChats || [])) {
    const hit = (c.members || []).find((m) => String(m.userId) === id);
    if (hit && hit.name) return String(hit.name);
  }
  return String(fallback || '') || id;
}

/**
 * 会话标题：群名（群号） / 群 群号 / 私聊 号  —— 微信来源的末尾再加「（微信）」
 *
 * 拿到群名时显示"群名（群号）"，既好认又能确认身份；拿不到就退回原来的"群 群号"。
 * ⚠️ **QQ 侧的显示必须逐字不变**（"不许为了微信把 QQ 改坏"是硬要求）⇒ 只有微信加后缀。
 */
function formatChatTitle(chatKey, name = '') {
  const m = /^group:(\d+)$/.exec(String(chatKey || ''));
  if (m) return (name ? `${name}（${m[1]}）` : `群 ${m[1]}`) + platformSuffix(chatKey);
  const p = /^private:(\d+)$/.exec(String(chatKey || ''));
  if (p) return (name ? `${name}（${p[1]}）` : `私聊 ${p[1]}`) + platformSuffix(chatKey);
  return String(chatKey || '');
}

/**
 * 平台后缀：**只有微信**才加「（微信）」，QQ 不加。
 * 为什么要单独一个函数：这段判断有三处要用（会话标题 / "已发送到"徽标 / 联系人列表），
 * 各写一份必然漂移；而"QQ 不加"这条是硬要求，集中在一处才好守住。
 * 数据来自 refreshSourceMap 那张 chatKey→source 表（`/api/sessions` 不带 source，只能查表）。
 */
function platformSuffix(chatKey) {
  return sessionPlatform({ chatKey }) === 'wechat' ? '（微信）' : '';
}

function clampInt(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/*
 * 滑条换算（前端显示用）。
 *
 * ⚠️ 必须与 src/tier-slider.js 保持完全一致 —— 后端保存配置时会用它
 *    **重新权威换算**档位与概率，所以前端即使算错也不会影响实际行为；
 *    但两边不一致会让"界面显示的档位"和"实际生效的档位"对不上，造成困惑。
 *    ui/app.js 是普通 script（非 ES module），无法 import，只能镜像一份。
 */
const TIER_SLIDER_BANDS = { tier1End: 10, tier2End: 20, tier3End: 90 };

/*
 * 「新加进白名单的会话」默认档位（2026-10-03 第三十五对话，用户拍板）：
 * 私聊 = 全响应、群聊 = 仅艾特。
 *
 * ⚠️ 与后端 `src/tier-defaults.js` 的 `newChatTierDefault()` **必须一致** ——
 *    ui/app.js 是普通 script（非 ES module），import 不了，只能镜像一份。
 *    判据 `test-响应档位新会话默认.mjs` 会**逐值比对**这两处，漂了当场红。
 * ⚠️ 群聊那个值**从 TIER_SLIDER_BANDS 推**，⛔ 不写死 5 —— 与后端同一条纪律：
 *    滑条分段哪天改了，两边都要跟着走，不能只改一处（那正是"两个口径各自演化"）。
 */
const NEW_CHAT_TIER_DEFAULT_UI = { private: 100, group: TIER_SLIDER_BANDS.tier1End / 2 };

function sliderToTierUI(pos) {
  const b = TIER_SLIDER_BANDS;
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return { tier: 4, randomPercent: 100 };
  const p = Math.min(100, Math.max(0, raw));
  if (p <= b.tier1End) return { tier: 1, randomPercent: 0 };
  if (p <= b.tier2End) return { tier: 2, randomPercent: 0 };
  if (p <= b.tier3End) {
    const pct = ((p - b.tier2End) / (b.tier3End - b.tier2End)) * 100;
    return { tier: 3, randomPercent: Math.round(pct * 10) / 10 };
  }
  return { tier: 4, randomPercent: 100 };
}

/** 已保存配置 → 滑条位置（优先用存下来的位置，老配置没有就从 tier/概率反推）。 */
function sliderToTierUI_tierToSlider(st) {
  const b = TIER_SLIDER_BANDS;
  const saved = Number(st?.contextSliderPos);
  if (Number.isFinite(saved)) return Math.min(100, Math.max(0, saved));
  const t = Math.min(4, Math.max(1, Number(st?.contextTier) || 4));
  const pct = Math.min(100, Math.max(0, Number(st?.randomPercent) || 0));
  if (t === 1) return b.tier1End / 2;
  if (t === 2) return (b.tier1End + b.tier2End) / 2;
  if (t === 3) return b.tier2End + (pct / 100) * (b.tier3End - b.tier2End);
  return (b.tier3End + 100) / 2;
}

/** 滑条位置 → 一句话说明（给用户的即时反馈）。 */
function sliderDesc(pos) {
  const { tier, randomPercent } = sliderToTierUI(pos);
  if (tier === 1) return '<b>1 档 · 仅艾特</b>：只有被 @ 时才响应，其余消息标记已读、不调模型（最省）';
  if (tier === 2) return '<b>2 档 · +关键词</b>：被 @ 或命中关键词时响应';
  if (tier === 3) return `<b>3 档 · +随机</b>：被 @ / 关键词必响应；此外每批普通消息有 <b>${randomPercent}%</b> 概率响应`;
  return '<b>4 档 · 全响应</b>：任何消息都响应，且艾特/关键词/随机的判定全部失效';
}

const TIER_NAME = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
const TIER_HINT = {
  1: '只有被 @ 时才响应，其余消息标记已读、不调模型（最省 token）',
  2: '在 1 档基础上，命中关键词也响应',
  3: '在 2 档基础上，再按概率随机响应一些消息',
  4: '任何消息都响应（改造前的行为，最费 token）'
};

function renderChatSection(c) {
    const st = c.store || {};
  // 滑条位置是唯一真相；档位与概率都由它派生（与后端 tier-slider.js 同一套规则）
  const sliderPos = sliderToTierUI_tierToSlider(st);
  const { tier: curTier, randomPercent: curPct } = sliderToTierUI(sliderPos);
  // 模板里要按各段占比画刻度条，这里简写成 B 供下方 ${B.xxx} 使用。
  // ⚠️ 这个别名不能删 —— 曾经漏掉它，导致模板里 B 未定义，
  //    整个 renderChatSection 抛 ReferenceError，聊天设置页直接打不开。
  const B = TIER_SLIDER_BANDS;
return `
    <h3>运行节奏</h3>
    <div class="field-row">
      <div class="field"><label>防抖聚批窗口（毫秒）</label><input type="number" id="cfg-wakedelay" min="0" value="${esc(c.wakeDelayMs)}" /></div>
      <div class="field"><label>批次间隔（毫秒）</label><input type="number" id="cfg-draindelay" min="0" value="${esc(c.drainDelayMs)}" /></div>
      <div class="field"><label>同时处理几个会话</label><input type="number" id="cfg-maxruns" min="1" max="8" value="${esc(c.maxConcurrentRuns)}" /></div>
    </div>
    <details class="hint-more"><summary>运行节奏这些参数都什么意思？</summary>
      <div class="hint-more-body"><b>防抖聚批窗口</b>：等连发消息聚成一批再开运行。<br><b>批次间隔</b>：上轮结束到下轮处理的间隔。</div>
    </details>

    <h3>发送保护</h3>
    <div class="field-row">
      <div class="field"><label>相邻消息最小间隔（毫秒）</label><input type="number" id="cfg-mingap" min="200" value="${esc(c.send.minGapMs)}" /></div>
      <div class="field"><label>最大间隔（毫秒）</label><input type="number" id="cfg-maxgap" min="500" value="${esc(c.send.maxGapMs)}" /></div>
      <div class="field"><label>每分钟最多发送</label><input type="number" id="cfg-maxpermin" min="1" value="${esc(c.send.maxPerMinute)}" /></div>
    </div>
    <div class="field-row">
      <div class="field"><label>每小时最多发送</label><input type="number" id="cfg-maxperhour" min="1" value="${esc(c.send.maxPerHour ?? 500)}" /></div>
      <div class="field"><label>按字数附加间隔（毫秒/字）</label><input type="number" id="cfg-bylength" min="0" value="${esc(c.send.byLengthMs ?? 20)}" /></div>
      <div class="field"><label>QQ 硬限制切分长度（0 = 不切）</label><input type="number" id="cfg-hardsplit" min="0" value="${esc(c.send.hardSplitAt ?? 4000)}" /></div>
    </div>
    <!-- 🆕 2026-09-25（第二十一对话，交接 §3 待办 4）：send.dedupeWindowMs 的界面。
         这个键 2026-09-25 第十八对话就加进 config 了（默认 8000），但**一直只在配置文件里**
         ⇒ 想改只能手改 config.json。与补 api.videoMode、浏览锁定那两次是同一类坑：
         **键是真的、默认也在跑、就是界面没有。**
         ⚠️ 0 是**明确的关闭值**（不是"回落默认"）—— 这条语义在 sender.js 里是有断言的，
            所以界面上必须写明，否则用户填 0 会以为自己填错了。
         ⚠️ 本注释里**不许出现反引号**：这是模板字符串，一个反引号就把整串截断
            （项目坑 §4-27，本轮又踩了一次，node --check 当场报 Unexpected identifier）。 -->
    <div class="field-row">
      <div class="field"><label>发送去重窗口（毫秒，0 = 关闭）</label><input type="number" id="cfg-dedupewindow" min="0" step="500" value="${esc(c.send.dedupeWindowMs ?? 8000)}" /></div>
      <!-- 🆕 2026-10-05（第四十三对话 · 交接 §3-111）：send.imageTimeoutMs 的界面。
           它加进 config 的同一天就接了这条输入框 —— 上一轮的反面教材正是"键是真的、默认也在跑、
           就是界面没有"（dedupeWindowMs 挂了 7 天才补上界面，见上面那段注释）。
           ⚠️ 只给**图片**那一档：文字/查询类仍是 onebot.js 里的 15000（那个值刻意不做界面，
              因为把探测类调用也拖慢是这个项目明确不要的行为）。 -->
      <div class="field"><label>发图超时（毫秒）</label><input type="number" id="cfg-imgtimeout" min="1000" step="1000" value="${esc(c.send.imageTimeoutMs ?? 60000)}" /></div>
    </div>
    <details class="hint-more"><summary>发送去重与发图超时都怎么算？</summary>
      <div class="hint-more-body">同一会话里、<b>发出去的纯文本完全一样</b>的两条，在这个窗口内只发第一条。防的是模型重复调用发送、或超时看起来失败而上层重试 —— 用户会看到两条一模一样的。默认 <b>8000</b>（8 秒），填 <b>0</b> 关掉。<br>⚠️ 只拦<b>完全相同</b>的文本（<b>粗体</b>与 粗体 视为相同）；<b>发失败不记账</b>（合法重试不会被误杀）；窗口按会话各算各的；不管表情包与拍一拍（那两条各有自己的限频）。<br>发图超时：图片要协议端收下再上传，比发文字慢得多。</div>
    </details>

    <h3>主动开话题</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-proactive" ${c.proactive.enabled ? 'checked' : ''} />
      <label for="cfg-proactive">冷场时按概率主动开话题</label></div>
    <!-- 实时状态：把六道闸摊开，回答"现在会不会开口、为什么"。数据来自 GET /api/proactive（只读） -->
    <div id="proactive-status" class="hint status" style="margin:-2px 0 10px">（正在读当前状态…）</div>
    <!-- ⚠️ 界面用**分钟**，存储仍是**毫秒**（proactive.checkIntervalMinMs/MaxMs）。
           为什么不改存储单位：那几个键的名字里就带 Ms、值也一直是毫秒；改成分钟会让键名与值不符，
           而且已有配置文件里存的是毫秒，会被按"分钟"读成天文数字（1800000 分钟 ≈ 3.4 年）—— 静默出错。
           ⚠️ 注意：本段注释在**模板字符串里面**，所以**不能出现反引号**（会提前结束字符串）。
           ⇒ 只在渲染与保存两处 ×/÷ 60000，见 msToMin / minToMs。 -->
    <div class="field-row">
      <div class="field"><label>检查间隔下限（分钟）</label><input type="number" id="cfg-pro-min" min="1" step="1" value="${esc(msToMin(c.proactive.checkIntervalMinMs, 30))}" /></div>
      <div class="field"><label>检查间隔上限（分钟）</label><input type="number" id="cfg-pro-max" min="1" step="1" value="${esc(msToMin(c.proactive.checkIntervalMaxMs, 90))}" /></div>
      <div class="field"><label>触发概率 0~1</label><input type="number" id="cfg-pro-prob" step="0.05" min="0" max="1" value="${esc(c.proactive.probability)}" /></div>
    </div>
    <div class="field-row">
      <!-- 群里安静多久才算"冷场"（原来这个键界面上没有 ⇒ 看不见也调不了） -->
      <div class="field"><label>群里安静多久才算冷场（分钟）</label><input type="number" id="cfg-pro-idle" min="5" step="5" value="${esc(msToMin(c.proactive.idleThresholdMs, 30))}" /></div>
      <!-- 安静时段：默认 23 → 8（跨零点）；这两键原来界面上也没有 -->
      <div class="field"><label>安静时段（点，含起点）</label><input type="number" id="cfg-pro-quiet-start" min="0" max="23" step="1" value="${esc(Number(c.proactive.quietHoursStart ?? 23))}" /></div>
      <div class="field"><label>到（点，不含终点）</label><input type="number" id="cfg-pro-quiet-end" min="0" max="24" step="1" value="${esc(Number(c.proactive.quietHoursEnd ?? 8))}" /></div>
      <!-- 连发上限：没人理最多连开几次。⚠️ 超过它之后的"退避"见下面只读那一行 -->
      <div class="field"><label>没人理最多连开（次）</label><input type="number" id="cfg-pro-maxconsec" min="1" max="10" step="1" value="${esc(Number(c.proactive.maxConsecutive ?? 2))}" /></div>
    </div>
    <details class="hint-more"><summary>冷场判定规则详解</summary>
      <div class="hint-more-body">间隔是"隔多久检查一次冷场"，不是"多久必说一次" —— 每次检查还要过安静时段、并发、掷骰子、冷场阈值、连发上限/退避。超过连发上限后不再无限开口，只在等够退避时间后允许"再戳一次"。</div>
    </details>
    <div class="hint status" style="margin:6px 0 10px">退避状态：<span id="proactive-reengage">…</span></div>

    <h3>表情包</h3>
    <!-- 🆕 2026-10-06（第四十七对话 · 用户拍板 B3①）：原来这里有一个「启用表情包」总开关
         （控件 id 是 cfg-sticker），**已撤**。用户原话："表情属于聊天系统，随便她发" ⇒ 表情包常开。
         ⛔ 别把它加回来当闸门；要限制她发什么，走平台判断或「表情包」页里的收藏开关。
         ⚠️ 下面「积极程度」那个 select **必须留着** —— 它是 test-微信联系人设置页.mjs
         的源码切片锚点（同一个容器里那块注释也是），删了那条判据会直接抽不出来。
         ⚠️ 本文件是**模板字符串**，注释里⛔ 一个反引号都不许有（坑 205，本轮又踩了一次 —— node --check 逮住）。 -->

    <div class="field">
      <label>发表情包的积极程度</label>
      <select id="cfg-sticker-encourage">
        ${STICKER_LEVELS.map(([v, label], i) =>
          `<option value="${v}" ${Number(c.sticker?.encourage ?? 1) === v ? 'selected' : ''}>${esc(label)}</option>`
        ).join('')}
      </select>
      <div class="hint">
        这是"引导"不是"强制"，模型仍会自行判断什么时机合适。
      </div>
    </div>

    <h3>响应档位</h3>

    <div class="checkbox-row"><input type="checkbox" id="cfg-unifiedtier" ${st.unifiedTier !== false ? 'checked' : ''} />
      <label for="cfg-unifiedtier">统一设置全部响应档位</label></div>
    <div class="hint" style="margin:-4px 0 10px">关掉就能给白名单里的每个群聊 / 私聊单独拖档位。</div>

    <!-- 统一模式：一个滑条管所有会话（原行为） -->
    <div id="tier-unified-wrap"${st.unifiedTier === false ? ' style="display:none"' : ''}>
    <div class="tier-slider-wrap">
      <input type="range" id="ctx-tier-slider" class="tier-slider"
             min="0" max="100" step="0.5" value="${esc(sliderPos)}"
             aria-label="响应档位滑条" />
      <div class="tier-scale" id="tier-scale">
        <span class="tier-seg seg1${curTier === 1 ? ' on' : ''}" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
        <span class="tier-seg seg2${curTier === 2 ? ' on' : ''}" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
        <span class="tier-seg seg3${curTier === 3 ? ' on' : ''}" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
        <span class="tier-seg seg4${curTier === 4 ? ' on' : ''}" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
      </div>
    </div>

    <div class="hint" id="ctx-tier-note" style="margin-top:8px">${sliderDesc(sliderPos)}</div>
    </div>

    <!-- 分会话模式：下拉选会话（群聊 + 私聊），各拖各的。
         滑条实时值是 DOM，切换会话时先收进隐藏 JSON 再换 -->
    <div id="tier-perchat-wrap"${st.unifiedTier === false ? '' : ' style="display:none"'}>
      <div class="field"><label>选择要单独设置的会话（白名单里的群聊 + 私聊）</label>
        <select id="tier-chat-select"></select>
      </div>
      <input type="hidden" id="tier-chat-json" value="${esc(JSON.stringify(st.chatSliderPos || {}))}" />
      <div class="tier-slider-wrap">
        <input type="range" id="ctx-tier-slider-g" class="tier-slider"
               min="0" max="100" step="0.5" value="${esc(sliderPos)}"
               aria-label="该会话响应档位滑条" />
        <div class="tier-scale" id="tier-scale-g">
          <span class="tier-seg seg1" data-seg="1" style="flex:${B.tier1End}">仅艾特</span>
          <span class="tier-seg seg2" data-seg="2" style="flex:${B.tier2End - B.tier1End}">+关键词</span>
          <span class="tier-seg seg3" data-seg="3" style="flex:${B.tier3End - B.tier2End}">+随机（概率递增）</span>
          <span class="tier-seg seg4" data-seg="4" style="flex:${100 - B.tier3End}">全响应</span>
        </div>
      </div>
      <div class="hint" id="ctx-tier-note-g" style="margin-top:8px"></div>
      <div style="margin-top:8px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-small" id="tier-chat-clear-btn" title="把这个会话恢复成刚加进白名单时的默认档：私聊=全响应、群聊=仅艾特">恢复默认档</button>
        <span class="hint" style="margin:0">没单独设置过的会话跟随上方统一档位的滑条位置（新加进白名单的会自动记为：私聊全响应、群聊仅艾特）。</span>
      </div>
    </div>

    <div class="tier-params">
      <div class="tier-param${curTier === 1 ? '' : ' dim'}">
        <label>① 被艾特时：发未读 + <input type="number" id="cfg-atcount" min="0" max="500" value="${esc(st.atCount ?? 20)}" /> 条已读</label>
        <div class="hint">有人 @机器人时才响应。<b>任何档位下被艾特都会响应</b>。</div>
      </div>
      <div class="tier-param${curTier === 2 ? '' : ' dim'}">
        <label>② 命中关键词时：发未读 + <input type="number" id="cfg-kwcount" min="0" max="500" value="${esc(st.keywordCount ?? 15)}" /> 条已读</label>
        <div class="hint">关键词（每行一个，不区分大小写）：</div>
        <textarea id="cfg-keywords" rows="3" placeholder="小鲸鱼&#10;bot">${esc((st.keywords || []).join('\n'))}</textarea>
      </div>
      <div class="tier-param${curTier === 3 ? '' : ' dim'}">
        <label>③ 随机命中时：发未读 + <input type="number" id="cfg-randcount" min="0" max="500" value="${esc(st.randomCount ?? 8)}" /> 条已读</label>
      </div>
      <div class="tier-param${curTier >= 4 ? '' : ' dim'}">
        <label>④ 其余情况也响应：发未读 + <input type="number" id="cfg-allcount" min="0" max="500" value="${esc(st.allCount ?? 80)}" /> 条已读</label>
        <div class="hint"><b>任何消息都响应</b>。</div>
      </div>
    </div>

    <h3>屏蔽名单</h3>
    <div class="field">
      <button class="btn btn-small" id="blocklist-btn">管理屏蔽名单</button>
      <div class="hint" style="margin-top:6px">被屏蔽群员的消息不会存档、不会触发回复，也不会作为聊天背景发给模型。机器人自己的发言不受影响。</div>
    </div>`;
}

/**
 * 「安全与浏览」设置节（2026-09-25 第十八对话新增）。
 *
 * 为什么要有这一节：这两个设置**一直存在、却从来没有任何界面** ——
 *   · `security.browseLock`（浏览锁定）：2026-09-20 吸收上游 0.4 时接进了 `web_fetch`，
 *     但只有配置文件里有；用户 2026-09-25 明确反馈"在界面上找不到"（确实找不到）。
 *   · `security.allowPrivateImageHosts`（允许内网图床）：同样只在 config.json 里。
 * 与上一轮补 `api.videoMode` 输入框是同一类坑：**键是真的、界面没有 ⇒ 用户摸不到**。
 */
/**
 * 「网络」（2026-10-04 第四十一对话 · 内置代理批 A，回执 V4+V7）
 *
 * 为什么**单开一节**而不是并进「她的能力」（回执 V7 的原文理由）：
 *   「她的能力」是**她**的能力，代理是**所有者**的基础设施 —— 混在一起就会回到
 *   "开关散落各处、要开一个功能得先猜它在哪一页"那个老问题。
 *
 * 三条纪律（与「她的能力」同款，改这一节之前先读）：
 *   ① 控件**复用**既有样式：`.checkbox-row` / `.field select` / `.field input`，
 *      ⛔ 不新造样式；
 *   ② 保存走**通用保存按钮**（`saveConfig()` 里按 `sec === 'network'` 收）；
 *   ③ 🔴 **一个新 `.hint` 都不许加** —— `test-设置页说明小字分层.mjs` 有一条棘轮
 *      （`class="hint"` 计数 ≤ 44、"只减不增"）。说明一律走既有的两级载体：
 *      一行常显 ⇒ `hintLine(…)`；细节 ⇒ `<details class="hint-more">`。
 *
 * 🔴 这一节**刻意不做**的事（回执 V4/V5/V6，⛔ 别顺手加回来）：
 *   · 不做订阅解析 / 节点 URI（`vmess://` 之类）；
 *   · 不做内核管理（起停/配置生成）—— 那是 L1，本轮拍板不做；
 *   · 不做 TUN（L3）；不碰 karing 的任何设置（**并存**：它继续由用户手动管）。
 */
function renderNetworkSection(c) {
  const p = c.proxy || {};
  const byRule = String(p.mode || 'off') === 'byRule';
  const raw = String(p.http || '').trim();
  // 把已存的 `http://127.0.0.1:3067` 拆进"地址 / 端口"两格（用户可能手改过 config.json，
  // 所以这里要能解析任意合法形态，而不是只认默认值）。
  let addr = '127.0.0.1', port = '3067';
  if (raw) {
    try {
      const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
      addr = u.hostname || addr;
      port = u.port || (u.protocol === 'https:' ? '443' : '80');
    } catch { addr = raw; }
  }
  const rules = Array.isArray(p.rules) ? p.rules.filter(Boolean).join('\n') : '';
  const hasPassword = p.hasPassword === true || Boolean(p.password);
  return `
    <h3>代理</h3>
    ${hintLine('只让本应用自己的出网请求走代理；不影响系统、不影响别的软件。',
      '这是"路线 C"的前置：pixiv / dlsite 这类站本机直连不通，走代理之后插画路才能拿到'
      + '真 R-18 与"最新/热门"排序。它<b>不是</b>整机 VPN —— 浏览器和别的软件照旧走直连。')}

    <div class="form-panel">
      <div class="field"><label>模式</label>
        <select id="cfg-proxy-mode">
          <option value="off" ${byRule ? '' : 'selected'}>不启用（默认）</option>
          <option value="byRule" ${byRule ? 'selected' : ''}>按规则走代理（只代理下面名单里的站）</option>
        </select>
        ${hintLine('默认「不启用」—— 这一页不动的话，联网行为与以前一模一样。',
          '按规则走代理是<b>白名单制</b>：只有命中「代理哪些站」名单的目标才走代理，'
          + '其余一律直连。⛔ 刻意<b>不做</b>"全局代理 + 排除名单" —— 那会把模型 API、'
          + '本机搜索服务、QQ/微信通道一起塞进代理，故障起来看不出原因。')}</div>

      <div class="field-row">
        <div class="field"><label>代理地址</label>
          <input type="text" id="cfg-proxy-addr" value="${esc(addr)}" placeholder="127.0.0.1" />
          ${hintLine('一般是本机（127.0.0.1）—— 也就是 karing 那种本地代理客户端。',
            '这里<b>不要</b>写用户名密码（会被拒掉）：认证走右边那两格。')}</div>
        <div class="field"><label>端口</label>
          <input type="number" id="cfg-proxy-port" min="1" max="65535" value="${esc(port)}" />
          ${hintLine('karing 默认：基于规则 3067 · 全代理 3066 · 全直连 3065。',
            '先用 3067（让 karing 自己决定哪些流量出国）。若"测试连接"报不通，'
            + '多半是 karing 的规则把 pixiv 判成直连了 ⇒ 换 3066（全代理）再测一次。')}</div>
      </div>

      <div class="field-row">
        <div class="field"><label>用户名（多数本地代理不需要）</label>
          <input type="text" id="cfg-proxy-user" value="${esc(p.user || '')}" placeholder="留空 = 不要认证" /></div>
        <div class="field"><label>密码</label>
          <input type="password" id="cfg-proxy-pass" value="${hasPassword ? '******' : ''}" placeholder="留空 = 不要认证" />
          ${hintLine(hasPassword ? '已保存密码（输入框里显示的是占位符）。想改就直接覆盖输入，留空并保存 = 取消认证。' : '留空即可（本机代理一般不校验）。',
            '密码<b>不会</b>被下发到界面：读取配置时它只回一个"有没有填"的布尔值，'
            + '所以这里显示的是占位符而不是真密码。')}</div>
      </div>

      <div class="field"><label>代理哪些站（一行一个；填 example.com 时它的子域也走代理）</label>
        <textarea id="cfg-proxy-rules" rows="6" placeholder="每行一个域名，例如&#10;www.pixiv.net&#10;i.pximg.net" style="width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${esc(rules)}</textarea>
        ${hintLine('名单空 = 谁都不走代理（改了模式也等于没开）。',
          '支持子域：写 <code>pixiv.net</code> 时 <code>www.pixiv.net</code>、<code>i.pximg.net</code>… 都算命中；'
          + '但 <code>pixiv.net.evil.com</code> 这种"把名单域名当前缀"的<b>不算</b>。'
          + '写法 <code>*.pixiv.net</code> 与 <code>pixiv.net</code> 等价。')}</div>

      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-small" id="proxy-test-btn" type="button">测试连接</button>
        <span id="proxy-test-result" class="muted"></span>
      </div>
      ${hintLine('「测试连接」打的是我们真正的联网层（不是浏览器那套），所以它报通就是真的通。',
        '测的是 pixiv 首页。⚠️ 它按<b>当前界面上填的</b>值测（不用先保存），'
        + '所以可以边改端口边试；测通之后再点上面的「保存设置」。'
        + '⚠️ 前提是 <b>karing 得开着</b> —— 本应用不会去启动它，也不会改它的任何设置。'
        + '⚠️ 代理<b>密码</b>这一项：测试用的始终是<b>已保存</b>的那份 —— 改了密码要先点「保存设置」再测。')}

      <details class="hint-more">
        <summary>它到底管哪几条路、不管哪几条</summary>
        <div class="hint-more-body">
          管的是<b>我们自己的三种出网方式</b>：① 手写的 https 客户端（搜索、抓网页、插画路）·
          ② 以图搜图那几个套 Cloudflare 的站 · ③ 零散的普通请求。<br>
          <b>不管</b>：浏览器的流量、别的软件、系统路由 —— 那些仍然直连。<br>
          🔴 一条<b>如实说明</b>（别指望它做到做不到的事）：走代理之后，目标域名是<b>代理端</b>解析的，
          所以「解析出内网地址就拒绝」那一层只对<b>直连</b>生效，对代理连接是<b>有意识地交给代理端</b>；
          而<b>域名级</b>的校验（协议、禁止的域名形态、逐跳重定向重校验）<b>一个字都没松</b>。
        </div>
      </details>
    </div>`;
}

function renderSecuritySection(c) {
  const lock = c.security?.browseLock || {};
  const hosts = Array.isArray(lock.hosts) ? lock.hosts.join('\n') : '';
  // ── 说明小字分层（位置 D1/D2）──────────────────────────────────────────
  // D1 按 **P7「代价不能藏」**：会导致"静默失效 / 直接不可用"的信息必须**常显**、不进折叠 ——
  //   所以外层只留那句 ⚠️ 代价；"它还管什么、不管什么"属于细节（勾选框 label 已经把结论说了）⇒ 进折叠。
  // D2 压到 1 行；顺带**去掉了原来那两个 Markdown 星号**（`**自建图床 / 本地测试**` 在 HTML 里
  //   不会变粗体，只会把 `**` 当字面字符显示出来）。
  return `
    <h3>浏览锁定</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-browselock-enabled" ${lock.enabled === true ? 'checked' : ''} />
      <label for="cfg-browselock-enabled">开启浏览锁定（她上网只能访问下面清单里的域名）</label></div>
    <div class="hint" style="font-size:12px;margin:-4px 0 2px">
      ⚠️ <b>开了但清单为空 = 什么都看不了</b>（比全放行安全，但等于把上网能力关死）。
    </div>
    <details class="hint-more" style="margin-bottom:10px">
      <summary>它还管什么、不管什么</summary>
      <div class="hint-more-body">
        管控的是她<b>上网看网页 / 搜索取页面</b>这条路（含跳转目标逐跳校验）。
        <br>⚠️ <b>按关键词找图不受它管</b> —— 与既有的「以图搜图」保持一致（那条走内置浏览器，本来就绕开锁定）。
      </div>
    </details>
    <div class="field"><label>允许访问的域名（一行一个；填 example.com 时它的子域也放行）</label>
      <textarea id="cfg-browselock-hosts" rows="5" placeholder="每行一个域名，例如&#10;zh.wikipedia.org&#10;example.com" style="width:100%;box-sizing:border-box;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px">${esc(hosts)}</textarea></div>
    <div class="field"><label>站内搜索模板（可选）</label>
      <input type="text" id="cfg-browselock-sitesearch" value="${esc(lock.siteSearchUrl || '')}" placeholder="https://example.com/search?q={query}" />
      <div class="hint" style="font-size:12px">配合锁定用：锁定几个站 + 站内搜索模板 = 「只能在这几个站里搜」。没有 <code>{query}</code> 占位符时按 <code>?q=</code> 兜底。</div>
    </div>
    <div class="settings-divider"></div>
    <h3>图片下载</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-allow-private-image-hosts" ${c.security?.allowPrivateImageHosts === true ? 'checked' : ''} />
      <label for="cfg-allow-private-image-hosts">允许从内网/本机地址下载图片</label></div>
    <div class="hint" style="font-size:12px;margin:-4px 0 10px">
      ⚠️ 默认关闭。只有自建图床 / 本地测试时才该打开 —— 打开等于允许程序访问内网地址。
    </div>`;
}

function renderDesktopSection(c) {
  return `
    <h3>桌面端</h3>
    <div class="checkbox-row"><input type="checkbox" id="cfg-autostart" ${c.server?.autoStart ? 'checked' : ''} />
      <label for="cfg-autostart">开机自启</label></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-closetray" ${c.server?.closeToTray !== false ? 'checked' : ''} />
      <label for="cfg-closetray">点关闭时最小化到托盘</label></div>
    <h3>界面</h3>
    <div class="field"><label>主题</label>
      <div class="theme-picker" id="theme-picker">
        ${THEME_VALUES.map((t) => `
          <div class="theme-option${getThemePref() === t ? ' on' : ''}" data-theme-opt="${t}" role="button" tabindex="0">
            <span class="t-ico">${THEME_ICON[t]}</span>
            <span>${THEME_LABEL[t]}</span>
          </div>`).join('')}
      </div>
    </div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-showvision" ${c.ui?.showVision !== false ? 'checked' : ''} />
      <label for="cfg-showvision">模型目录显示“支持图片输入/不支持图片输入”徽标</label></div>
    <div class="field"><label>界面刷新间隔（秒）</label><input type="number" id="cfg-refreshms" min="1" step="1" value="${esc(Math.round((c.ui?.refreshMs ?? 15000) / 1000))}" /></div>
    <h3>版本</h3>
    <div class="field"><label>当前版本 <b id="update-current">…</b></label></div>`;
}

function renderOnebotSection(c) {
  return `
    <h3 id="settings-onebot">OneBot（SnowLuma）</h3>
    <div class="hint" style="margin-bottom:10px">SnowLuma 的启动、关闭与日志已移动到顶部「SnowLuma」页签。此处只保留连接配置。</div>
    <div class="field"><label>SnowLuma 程序目录（留空 = 自动使用项目内 snowluma/ 文件夹）</label>
      <div style="display:flex;gap:8px">
        <input type="text" id="cfg-snowlumadir" value="${esc(c.snowluma.dir || '')}" style="flex:1" />
        <button class="btn btn-small" id="open-snowluma-btn">打开文件夹</button>
      </div>
      <div class="hint" id="snowluma-hint"></div></div>
    <div class="checkbox-row"><input type="checkbox" id="cfg-snowlumalaunch" ${c.snowluma.autoLaunch ? 'checked' : ''} />
      <label for="cfg-snowlumalaunch">QQ Agent 启动时自动拉起 SnowLuma（未运行时）</label></div>
    <div class="field-row">
      <div class="field"><label>WebSocket 地址（收消息）</label><input type="text" id="cfg-wsurl" value="${esc(c.snowluma.wsUrl)}" /></div>
      <div class="field"><label>HTTP 地址（发消息）</label><input type="text" id="cfg-httpurl" value="${esc(c.snowluma.httpUrl)}" /></div>
      <!-- 🔴 凭据类字段：界面只放星号占位符，**服务端根本不下发真值**
           （sanitizeConfig 会把 accessToken / httpAccessToken 删掉，只留 hasAccessToken）。
           🆕 2026-10-06（第四十六对话）：原来写的是 esc(c.snowluma.accessToken || '') ——
           而那个字段在客户端**永远是 undefined** ⇒ 输入框恒为空、用户以为"没设令牌"；
           更糟的是保存侧原来无条件把输入框的值写回去 ⇒ **一次保存就把真令牌写成空串**
           （只是被 app.js 的 applyTokens 从 SnowLuma 自己的 runtime.json 重新学回来，才没曝出来）。
           ⇒ 改法与项目里其它 Key 完全一致（坑 178）：占位符 + 保存侧"没填新值就一个键都不写"。
           ⚠️ 本段在**模板字符串**里：注释与文案里一个反引号都不许有 —— 本注释第一版在星号
              外面套了反引号，node --check 当场报 Unexpected token（坑 186 的又一次，已改）。 -->
      <div class="field"><label>WebSocket 令牌</label><input type="password" id="cfg-obtoken" value="${esc(c.snowluma?.hasAccessToken ? '******' : '')}" placeholder="留空保持不变" autocomplete="new-password" /></div>
      <div class="field"><label>HTTP 令牌（与 WS 不同时填；SnowLuma 默认分开）</label><input type="password" id="cfg-obhttptoken" value="${esc(c.snowluma?.hasHttpAccessToken ? '******' : '')}" placeholder="留空保持不变" autocomplete="new-password" /></div>
    </div>
    <div class="hint">改完 OneBot 地址需要重启应用生效；模型/人设/白名单即时生效。</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 「？ 本页说明」—— 原型四级规范里的**汇总层**
//
// 规范原文在 `ui/index.prototype.html:1180-1185`（四级：一级结论 `.hint` 常显 / 二级细节
// `details.hint-more` / 三级术语 `.ihint` ⓘ / **汇总帮助 = save-bar 的「？ 本页说明」**）。
// 前三级的构件早就有了，**只有第四级一直没落地**（`？本页说明` 在 `app/*.js` 里零命中）。
// 这里补的就是它：2026-10-03（第三十四对话）· UI 改造第三阶段 改动点 5。
//
// 🔴 **为什么内容从 DOM 上现读，而不是抄成一张大表**（这是个设计决策，别改回去）：
//   方案 §4.5 给的方向是"数据结构化"。但抄一份表 = 同一句话在源码里出现两次，
//   而**改动点 4 的硬判据就是"重复度 = 0"**（同一句话在 `ui/app/*.js` 里只许出现一次，
//   见 `测试-现行\test-设置页说明小字分层.mjs`）；更要命的是**以后每加一处折叠都要记得同步这张表**，
//   漏一次就变成"面板里说的和页面上写的不一样"，而那种漂**看不出来**（正是本项目最忌的一族）。
//   ⇒ 改成**读页面上真实存在的那几个载体**（`details.hint-more` 与 `.ihint`）：
//     单一来源、永不重复、新加折叠自动出现，判据也能钉"面板里就是页面上那些"。
//   ⛔ 因此这张表**只装"刻意不常显、也不进折叠"的那几句**（它们没有别的载体可读）。
// ═══════════════════════════════════════════════════════════════════════════

/** 汇总层**专有**的补充文案（分区 id → [[标题, 正文], …]）。正文是纯文本，渲染时会 esc。
 *  ⚠️ 这里的字**是给用户看的** —— 别把"按 P7 降到这一层"这类内部理由写进正文（那是注释的活）。 */
const SETTINGS_PAGE_HELP_EXTRA = {
  // 「排障」那句原来常显在「微信联系人」页底部，上一轮暂放进二级折叠；汇总层落地后搬到这里。
  // 为什么它连二级都不该占：顶栏本来就有微信通道的状态点 ⇒ 这句等于"教用户看已经看得见的东西"。
  wechat: [['排障：通道通没通怎么看？', '微信通道通没通，看顶栏那个状态点（切到「微信」模式）。']]
};

/** 分区 id → 侧栏上的显示名（**从侧栏 DOM 现读**，不另存一份标签表 —— 那就是第二个来源了）。 */
function settingsSectionLabel(sec) {
  const el = document.querySelector(`.settings-menu-item[data-section="${sec}"]`);
  const label = el ? String(el.textContent || '').trim() : '';
  return label || sec;
}

/**
 * 收集"当前这一页"的二级 / 三级文案 + 汇总层专有文案。
 * @returns {Array<{head:string, body:string}>} head/body 都是**可直接塞进 innerHTML 的片段**
 *   （折叠正文本身就是 HTML，原样带出来才能保住加粗与 `<code>`）。
 */
function collectSettingsPageHelp(sec) {
  const items = [];
  // 二级：原生折叠（正文取 `.hint-more-body` 的 innerHTML）
  document.querySelectorAll('#settings-form details.hint-more').forEach((d) => {
    const head = String(d.querySelector('summary')?.innerHTML || '').trim();
    const body = String(d.querySelector('.hint-more-body')?.innerHTML || '').trim();
    if (head || body) items.push({ head, body });
  });
  // 三级：术语 ⓘ（`hintLine(line, detail)` 渲染出的那颗 `i`）：`title` 是解释，前面那行文字是标签
  document.querySelectorAll('#settings-form .ihint').forEach((el) => {
    const detail = String(el.getAttribute('title') || '').trim();
    if (!detail) return;
    const line = String(el.parentElement?.firstChild?.textContent || '').trim();
    items.push({ head: line, body: esc(detail) });
  });
  // 汇总层专有
  for (const [head, body] of (SETTINGS_PAGE_HELP_EXTRA[sec] || [])) items.push({ head, body: esc(body) });
  return items;
}

/**
 * 打开「？ 本页说明」面板。
 *
 * ⚠️ 复用**已有的**弹窗外壳 `modelModalShell` + `closeModelModal`（⛔ 不另写一套 overlay）；
 *    内容区复用既有的 `.modal-list`（`style.css:1785`，可滚动）—— 因为
 *    `.model-modal-body` 是 `overflow: hidden`，长内容不自己滚就会被**裁掉**（看着像"面板是空的"）。
 * ⚠️ **Esc 关闭是本函数自己挂的**，没有加进 `modelModalShell`：那个外壳有 25 个调用点，
 *    给它加全局行为等于同时改 25 个弹窗；本次只有这一处需要。
 *    ⚠️ 正因为是"自己挂的"，**三条关闭路径都要摘监听**（Esc / × / 点遮罩），
 *       否则每开一次面板就多留一个 document 级监听（久了就是"按一下 Esc 关掉好几个"）。
 */
function openSettingsPageHelp(sectionKey) {
  const sec = sectionKey || state.settingsSection || 'api';
  const items = collectSettingsPageHelp(sec);
  const body = items.length
    ? `<div class="modal-list">${items.map((it) => `
        <div style="margin-bottom:14px">
          <b>${it.head}</b>
          <div class="hint" style="margin-top:4px">${it.body}</div>
        </div>`).join('')}</div>`
    // 没有折叠内容的页要**如实说**，⛔ 不能给一个点了什么都不发生的空面板
    : '<div class="empty-hint">这一页的说明都直接写在页面上，没有折起来的部分。</div>';
  const overlay = modelModalShell({
    head: `${settingsSectionLabel(sec)} · 本页说明`,
    body,
    foot: '<button class="btn btn-primary" id="page-help-close">知道了</button>'
  });
  const close = () => {
    document.removeEventListener('keydown', onKey);
    closeModelModal(overlay);
  };
  function onKey(e) {
    if (e?.key === 'Escape') close();
  }
  document.addEventListener('keydown', onKey);
  overlay.querySelector('#page-help-close')?.addEventListener('click', close);
  // ⚠️ 外壳自己已经挂了"点遮罩 / 点 ×"两条关闭路径（先注册、先执行）⇒ 这里**再挂一遍**只为摘监听；
  //    `overlay.remove()` 对已摘下的节点是空操作，重复调用无害。
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.model-modal-close')?.addEventListener('click', close);
  return overlay;
}
