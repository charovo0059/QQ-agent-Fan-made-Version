'use strict';
// 第 16/18 段：15-allow-saveconfig（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

// ── 白名单可视化选择器 ──
async function openWhitelistPicker(kind) {
  const isGroups = kind === 'groups';
  $('#pick-result').textContent = '拉取中…';
  let list;
  try {
    const data = await api(`/api/onebot/${kind}`);
    list = isGroups ? data.groups : data.friends;
  } catch (e) {
    $('#pick-result').textContent = `拉取失败：${e.message}（OneBot 未连接？）`;
    return;
  }
  if (!list?.length) {
    $('#pick-result').textContent = isGroups ? '没拉到群列表（检查 SnowLuma）' : '没拉到好友列表';
    return;
  }
  // ⚠️ 条目 6：名单不再是"逗号文本框"，而是芯片盒子 ⇒
  //    候选项的"已选"状态从**芯片**读、确定时把选中的**写回芯片**。
  const kindKey = isGroups ? 'groups' : 'private';
  const selected = new Set(readAllowChips(kindKey));
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-head">选择${isGroups ? '群' : '好友'}（已选 ${selected.size} 个）</div>
      <div class="modal-list">
        ${list.map((g) => `
          <label class="pick-item">
            <input type="checkbox" value="${esc(g.id)}" ${selected.has(g.id) ? 'checked' : ''} />
            <span>${esc(g.name)}</span>
            <span class="muted">${esc(g.id)}</span>
          </label>`).join('')}
      </div>
      <div class="modal-foot">
        <button class="btn btn-primary" id="pick-apply">确定</button>
        <button class="btn" id="pick-cancel">取消</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#pick-cancel', overlay).addEventListener('click', () => overlay.remove());
  $('#pick-apply', overlay).addEventListener('click', () => {
    const picked = $$('input[type=checkbox]:checked', overlay).map((el) => el.value);
    // 写回芯片（先清空再重建 —— 用户可能在弹窗里取消了原来勾着的）
    setAllowChips(kindKey, picked);
    $('#pick-result').textContent = `已选 ${picked.length} 个${isGroups ? '群' : '好友'}，记得点"保存设置"`;
    overlay.remove();
  });
}

/** 读一个芯片盒子里的名单（**唯一来源是 DOM**，因为用户可能刚点 × 删过）。 */
function readAllowChips(kind) {
  return Array.from(document.querySelectorAll(`.chipbox[data-chipbox="${kind}"] .wchip`))
    .map((el) => String(el.textContent).replace(/^[^ ]+\s*/, '').replace(/×$/, '').trim())
    .filter(Boolean);
}

/** 把名单写回芯片盒子（先清空再重建）。 */
function setAllowChips(kind, ids) {
  const box = document.querySelector(`.chipbox[data-chipbox="${kind}"]`);
  if (!box) return;
  for (const el of Array.from(box.querySelectorAll('.wchip'))) el.remove();
  const input = box.querySelector(`[data-chipinput="${kind}"]`);
  const label = kind === 'groups' ? '群' : '好友';
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;   // 去重：同一个号加两次会变成两个芯片，删一个还剩一个
    seen.add(id);
    const el = document.createElement('span');
    el.className = `wchip ${kind === 'groups' ? 'grp' : 'frd'}`;
    el.innerHTML = `${label} ${esc(id)}<span class="wchip-x" data-rm="${kind}" data-id="${esc(id)}" role="button" tabindex="0" title="移除">×</span>`;
    box.insertBefore(el, input);
  }
  bindAllowChips();
}

/** 芯片的删除/添加接线。⚠️ 用事件委托挂在**设置表单容器**上，只绑一次 ——
 *  芯片是动态增删的，逐个绑会在每次增删后丢监听（芯片变死件）。
 *
 *  🔴 踩坑记录：第一版挂到了 `#settings-page` —— **那个 id 在这个应用里根本不存在**
 *     （真实容器是 `#settings-form`）。`getElementById` 返回 null ⇒ 整个函数早退 ⇒
 *     芯片的添加/删除**从来没被接线**，而界面上看不出任何异常（点了没反应、也不报错）。
 *     这正是本项目最忌讳的静默失效。
 *  ⇒ 现在的做法：容器找不到就**大声报错**，而不是悄悄 return。
 */
function bindAllowChips() {
  const root = document.getElementById('settings-form')
  if (!root) {
    // 宁可吵一点：这条路径出错的表现是"芯片点不动"，比一条控制台报错难查得多
    console.error('[allow] 找不到 #settings-form，白名单芯片的增删不会工作（芯片会变成死件）')
    return
  }
  if (root.__allowChipsBound) return
  root.__allowChipsBound = true
  const addFrom = (input) => {
    const kind = input.dataset.chipinput;
    const v = String(input.value || '').trim().replace(/[,，\s]+/g, '');
    if (!v) return;
    const ids = readAllowChips(kind);
    if (!ids.includes(v)) setAllowChips(kind, [...ids, v]);
    input.value = '';
    input.focus();
  };
  root.addEventListener('click', (e) => {
    const x = e.target.closest('.wchip-x');
    if (x) {
      const kind = x.dataset.rm;
      const id = x.dataset.id;
      setAllowChips(kind, readAllowChips(kind).filter((v) => v !== id));
      return;
    }
    // 点盒子空白处 = 聚焦到输入框（不然点了没反应，像坏了）
    const box = e.target.closest('.chipbox');
    if (box) box.querySelector('input')?.focus();
  });
  root.addEventListener('keydown', (e) => {
    const input = e.target.closest('[data-chipinput]');
    if (!input) return;
    if (e.key === 'Enter') { e.preventDefault(); addFrom(input); return; }
    // 退格键在空输入框上 = 删掉最后一个芯片（常见的标签输入习惯，
    // 用键盘就能删，不必去够那个 ×）
    if (e.key === 'Backspace' && !input.value) {
      const kind = input.dataset.chipinput;
      const ids = readAllowChips(kind);
      if (ids.length) { e.preventDefault(); setAllowChips(kind, ids.slice(0, -1)); }
    }
  });
}

/** ⚠️ 2026-09-22（条目 6）：`parseList()` 已删除。
 *  它做的是"把逗号文本框的内容切成数组"，而白名单现在用**芯片输入**（`.chipbox`），
 *  名单的权威来源是 DOM 里的芯片（`readAllowChips`）。
 *  ⇒ 留着一个没人调的旧函数比删掉更危险：下次有人改名单格式时不知道要改两处。 */

async function saveConfig({ quiet = false } = {}) {
  const c = state.config;
  // 只在当前区块的元素存在时才读取，避免“每个区块保存时读取其他区块元素”导致的 null 报错。
  const el = (sel) => document.querySelector(sel);
  const val = (sel, fallback = '') => {
    const node = el(sel);
    return node ? node.value : fallback;
  };
  const chk = (sel, fallback = false) => {
    const node = el(sel);
    return node ? node.checked : fallback;
  };
  const sec = state.settingsSection || 'api';

  const patch = {};

  if (sec === 'memory') {
    patch.memory = {
      ...(c.memory || {}),
      consolidateEnabled: chk('#cfg-mem-consolidate', c.memory?.consolidateEnabled !== false),
      useChatModel: chk('#cfg-mem-usechat', c.memory?.useChatModel !== false),
      provider: val('#cfg-mem-provider', c.memory?.provider || '').trim(),
      model: val('#cfg-mem-model', c.memory?.model || '').trim(),
      consolidateMinIntervalMs: Number(val('#cfg-mem-interval', c.memory?.consolidateMinIntervalMs ?? 21600000)) || 21600000
    };
  }

  if (sec === 'api') {
    patch.api = {
      vision: chk('#cfg-vision', c.api.vision !== false),
      temperature: Number(val('#cfg-temperature', c.api.temperature)) || 0.8,
      maxRounds: Number(val('#cfg-maxrounds', c.api.maxRounds)) || 12,
      // ── 图片/视频专用模型 + 备选模型降级链（2026-09-25 · 第十七对话）──────────
      // 三者都**照实写、含空值**：把输入框清空 = 真的取消切换 / 取消降级。
      // ⚠️ 这里刻意在**每个分支都写**（而不是"为空就不写"）：不写的话清除操作会失效
      //    （深合并保留旧值），用户会遇到"删掉了却还在用" —— 那是本页最忌讳的一类错觉。
      visionModel: val('#cfg-vision-model', c.api.visionModel || '').trim(),
      videoModel: val('#cfg-video-model', c.api.videoModel || '').trim(),
      // `videoMode` 是**枚举**（auto/native/frames/off），不是自由文本 ⇒ 走校验，非法值回落 auto。
      // 同一条纪律：照实写、含空值（读不到就回落 auto），不能"为空就不写"。
      videoMode: normalizeVideoMode(val('#cfg-video-mode', c.api.videoMode || 'auto')),
      fallbackModels: parseFallbackModels(val('#cfg-fallback-models', '')),
      // 成本核算：官方价开关（走中转站时通常要关掉开关自己填）
      useOfficialPrice: chk('#cfg-useofficialprice', c.api.useOfficialPrice !== false),
      // 远程价格表 URL：留空 = 只用内置表
      priceRemoteUrl: val('#cfg-price-remote-url', c.api.priceRemoteUrl || '').trim(),
      // 全局兜底单价：仅当没有模型级价格时生效
      priceInputPerM: Number(val('#cfg-price-in', c.api.priceInputPerM ?? 0)) || 0,
      priceOutputPerM: Number(val('#cfg-price-out', c.api.priceOutputPerM ?? 0)) || 0,
      priceCachedPerM: Number(val('#cfg-price-cached', c.api.priceCachedPerM ?? 0)) || 0
    };
    // 把当前模型的单价存进 modelPrices[模型]（只影响这一个模型，不动内置官方表）。
    // 若开关是打开的，则不应写入 —— 那时输入框是禁用的，读到的值就是官方价，
    // 写进去会凭空产生一条自定义价。
    //
    // ⚠️ 模型名与开关状态都必须读**界面实时值**（c.api 是上次保存的旧值）：
    // 用户可能改了模型/开关但还没保存过，用旧值会把价格存到错误的模型名下。
    const curModel = String(($('#cfg-model')?.value ?? c.api?.model) || '').trim();
    const officialOn = ($('#cfg-useofficialprice')?.checked) ?? (c.api?.useOfficialPrice !== false);
    if (curModel) {
      const isLocked = officialOn;   // 锁定只跟开关绑定
      if (!isLocked) {
        const nextMap = { ...(c.api?.modelPrices || {}) };
        const i = Number(val('#cfg-price-in', 0)) || 0;
        const o = Number(val('#cfg-price-out', 0)) || 0;
        const ca = Number(val('#cfg-price-cached', 0)) || 0;
        if (i || o || ca) {
          nextMap[curModel] = { in: i, out: o, cached: ca || i };
        } else {
          delete nextMap[curModel];   // 全 0 = 清除自定义，回落到官方表
        }
        // 同样需要整体替换，否则 delete 掉的那一项会在合并时复活
        patch.api.modelPrices = { __replace__: nextMap };
      }
    }
    // 当前 API Key：只有用户在框里输入了非掩码的新值才走 /api/providers/set-key；
    // 掩码/留空都表示不改。
    const apiKeyInput = $('#cfg-apikey');
    const enteredApiKey = (apiKeyInput?.value || '').trim();
    if (enteredApiKey && enteredApiKey !== '******') {
      const pid = c.api?.provider;
      if (pid) {
        // 目录提供商的 Key 单独存（不能覆盖别的提供商的 Key）
        await api('/api/providers/set-key', {
          method: 'POST',
          body: JSON.stringify({ providerId: pid, apiKey: enteredApiKey })
        });
      } else {
        patch.api.apiKey = enteredApiKey;
      }
    }
  }

  if (sec === 'search') {
    // 搜索 API Key：****** = 保持原 Key 不变；明文或新输入才更新
    const enteredDsKey = val('#cfg-ds-searchkey', '').trim();
    const enteredZhipuKey = val('#cfg-zhipu-key', '').trim();
    const enteredBochaKey = val('#cfg-bocha-key', '').trim();
    const enteredBaiduKey = val('#cfg-baidu-key', '').trim();
    const enteredMetasoKey = val('#cfg-metaso-key', '').trim();
    patch.webSearch = {
      ...c.webSearch,
      enabled: chk('#cfg-websearch', c.webSearch?.enabled !== false),
      provider: val('#cfg-searchprovider', c.webSearch?.provider || 'bing'),
      searchUrl: val('#cfg-searchurl', c.webSearch?.searchUrl || 'https://cn.bing.com/search').trim() || 'https://cn.bing.com/search',
      deepseek: {
        ...(c.webSearch?.deepseek || {}),
        ...(enteredDsKey && enteredDsKey !== '******' ? { apiKey: enteredDsKey } : {}),
        model: val('#cfg-ds-searchmodel', c.webSearch?.deepseek?.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash'
      },
      zhipu: {
        ...(c.webSearch?.zhipu || {}),
        ...(enteredZhipuKey && enteredZhipuKey !== '******' ? { apiKey: enteredZhipuKey } : {}),
        engine: val('#cfg-zhipu-engine', c.webSearch?.zhipu?.engine || 'search_std')
      },
      bocha: {
        ...(c.webSearch?.bocha || {}),
        ...(enteredBochaKey && enteredBochaKey !== '******' ? { apiKey: enteredBochaKey } : {})
      },
      baidu: {
        ...(c.webSearch?.baidu || {}),
        ...(enteredBaiduKey && enteredBaiduKey !== '******' ? { apiKey: enteredBaiduKey } : {})
      },
      metaso: {
        ...(c.webSearch?.metaso || {}),
        ...(enteredMetasoKey && enteredMetasoKey !== '******' ? { apiKey: enteredMetasoKey } : {})
      },
      // 自定义搜索服务走 webSearch.providers 数组（由「添加自定义搜索服务」按钮维护），
      // 不在这里随表单提交 —— 避免每次保存都把动态列表覆盖掉。
      providers: c.webSearch?.providers || []
    };
    // 以图搜图开关（引擎均免 Key，只有开/关 + 可选 SauceNAO Key）
    const enteredSaucenaoKey = val('#cfg-saucenao-key', '').trim();
    patch.imageSearch = {
      ...(c.imageSearch || {}),
      enabled: chk('#cfg-imagesearch', c.imageSearch?.enabled !== false),
      // 触发策略 + 单次运行上限（见 src/tools.js 的 search_image_source）
      policy: val('#cfg-imagesearch-policy', c.imageSearch?.policy || 'asked'),
      maxPerRun: Math.max(1, Math.min(10, Number(val('#cfg-imagesearch-max', c.imageSearch?.maxPerRun ?? 2)) || 2)),
      // 🆕 2026-09-25（第十八对话）：**关键词找图**（search_images / send_image）的策略与上限。
      //    与上面那条**各算各的**：触发措辞完全不同（一个是"求出处"，一个是"要图"），
      //    共用一个 policy 会互相污染。见 src/tools.js 的 imageWantWasAsked。 
      keywordPolicy: String(val('#cfg-imagesearch-keyword-policy', c.imageSearch?.keywordPolicy || 'asked')).toLowerCase() === 'free' ? 'free' : 'asked',
      keywordMaxPerRun: Math.max(1, Math.min(10, Number(val('#cfg-imagesearch-keyword-max', c.imageSearch?.keywordMaxPerRun ?? 2)) || 2)),
      cfBypass: chk('#cfg-cfbypass', c.imageSearch?.cfBypass !== false),
      // ****** = 保持原 Key 不变；明文或新输入才更新
      ...(enteredSaucenaoKey && enteredSaucenaoKey !== '******' ? { saucenaoApiKey: enteredSaucenaoKey } : {})
    };
    // 看图（视觉）的体积上限：四个数字一起收。
    // 界面侧先钳一道，后端 imageLimits() 还会再兜一道（非法值回落默认），两道都不信任对方。
    const intIn = (sel, def, lo, hi) => {
      const n = Math.round(Number(val(sel, def)));
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
    };
    patch.imageLimits = {
      maxKB: intIn('#cfg-img-maxkb', c.imageLimits?.maxKB ?? 700, 1, 32768),
      maxRunMB: intIn('#cfg-img-maxrun', c.imageLimits?.maxRunMB ?? 3, 1, 64),
      maxPerView: intIn('#cfg-img-perview', c.imageLimits?.maxPerView ?? 6, 1, 50),
      maxDownloadMB: intIn('#cfg-img-maxdl', c.imageLimits?.maxDownloadMB ?? 12, 1, 128)
    };
    // ⛔ 本子查询（doujinLookup）**不再随设置页保存提交**（2026-09-23 第十二对话）：
    //    它整段搬到了技能页 → 本子查询 → 「配置」，由通用技能表单写
    //    `POST /api/skills/doujin-lookup { settings }`，后端再落到 config.doujinLookup
    //    （见 src/app.js 的 CONFIG_BY_PATH）。
    //    ⚠️ 千万别在这里顺手把 `patch.doujinLookup = {...}` 加回来：设置页里已经没有
    //       `#cfg-doujin*` 这些元素了，`chk()`/`val()` 会**静默取到默认值**，
    //       于是"打开设置页点一下保存"就把用户的本子查询配置**重置成默认**
    //       —— 典型的"界面看着没事、数据被改掉"。
  }

  if (sec === 'persona') {
    patch.persona = {
      botName: val('#cfg-botname', c.persona.botName).trim() || '小鲸鱼',
      selfNickname: val('#cfg-selfnick', c.persona.selfNickname || '').trim(),
      participation: val('#cfg-participation', c.persona.participation),
      roleText: val('#cfg-roletext', c.persona.roleText || ''),
      customRules: val('#cfg-customrules', c.persona.customRules || ''),
      // 整份替换：留空 = 用内置系统提示
      systemPrompt: val('#cfg-sysprompt', c.persona.systemPrompt || '')
    };
    // 逐段替换：只有输入框真的渲染出来了才动这个字段 —— 万一 /api/system-prompt
    // 没拉到，就保持原值，绝不把已有覆盖静默清空。
    const segEls = $$('.sysprompt-seg');
    if (segEls.length) {
      const loaded = {};
      for (const s of (state.systemPrompt?.segments || [])) loaded[s.key] = String(s.default ?? '');
      const segs = {};
      for (const node of segEls) {
        const key = node.getAttribute('data-seg-key');
        const value = String(node.value ?? '').trim();
        // 与"加载时的内置默认"一致 → 不写覆盖；于是把某段改回原样就等于取消该段覆盖。
        if (value && value !== String(loaded[key] ?? '').trim()) segs[key] = value;
      }
      // __replace__：整体替换，这样"清空某段"才会真的删掉该段的覆盖（深合并删不掉键）。
      patch.persona.systemPromptSegments = { __replace__: segs };
    }
  }

  if (sec === 'allow') {
    // ── 条目 6：三选一模式 + 芯片输入 ────────────────────────────────────
    // ⚠️ 名单的**权威来源是 DOM 里的芯片**（用户可能刚点 × 删过），
    //    不是 state.config 里的旧数组 —— 用旧数组会把"刚删掉的"又存回去。
    const picked = (kind) => Array.from(document.querySelectorAll(`.chipbox[data-chipbox="${kind}"] .wchip`))
      .map((el) => String(el.textContent).replace(/^[^ ]+\s*/, '').replace(/×$/, '').trim())
      .filter(Boolean);
    // 🔴 2026-09-25（第十七对话）：**"DOM 里没有这个芯片盒" ≠ "名单是空的"**。
    //    两种情况 `picked()` 都返回 `[]`，含义却正好相反：
    //      · 盒子在、里面空  → 用户**故意**删光了 ⇒ 照实写 `[]`（他就是要"谁都不放行"）
    //      · 盒子**根本不在 DOM 里** → 这一节没渲染/没挂上 ⇒ 写 `[]` 等于**静默清空白名单**
    //    ⚠️ 后者是安全事故级：whitelist 模式下名单空 = 谁都不放行 ⇒ **机器人直接不吭声**，
    //       而且界面上完全看不出来（与上面那条 deny 的旧账同一族）。
    //    ⇒ 盒子不在时**不写这个键**（updateConfig 是深合并 ⇒ 原样保留）+ 出声。
    //    📌 起因：交接 §68.6 记过一次"盘上白名单短暂变成 1/1、复现不出来"的观测；
    //       这条守卫治的是同一族（"权威值来自 DOM，而 DOM 可能缺"）里最危险的那一格。
    const chipBox = (kind) => document.querySelector(`.chipbox[data-chipbox="${kind}"]`);
    const pickedOrKeep = (kind) => {
      if (chipBox(kind)) return picked(kind);
      console.warn(`[allow] 界面上没有 ${kind} 的芯片盒 ⇒ 本次**不改**这一份名单（避免静默清空）`);
      return undefined;                                 // undefined ⇒ 下面不写这个键
    };
    patch.allow = {
      // 模式：从单选读；读不到就保持原值（不回退成默认值 —— 那会悄悄改用户的选择）
      mode: (document.querySelector('input[name="allow-mode"]:checked') || {}).value
        || (ALLOW_MODES_UI.includes(c.allow?.mode) ? c.allow.mode : deriveAllowModeUi(c)),
    };
    const pickedGroups = pickedOrKeep('groups');
    const pickedPrivates = pickedOrKeep('private');
    if (pickedGroups !== undefined) patch.allow.groups = pickedGroups;
    if (pickedPrivates !== undefined) patch.allow.private = pickedPrivates;
    // 🔴 2026-09-22（第十一对话复核）：这里**原来有一行无条件清空 deny**
    //    （`patch.deny = { groups: [], private: [] };`，自 09-18 基线就在）。
    //    而整个界面**没有任何地方能编辑 deny** —— 它只能手改 config.json。
    //    ⇒ 只要用户手配过黑名单，之后随便保存一次「聊天白名单」就会把它**静默清空**
    //      （下一次判断就放行了那个人，且界面上完全看不出来）。
    //    这与本页自己的判据直接冲突：`allowed()` 把 deny 当"独立否决权、永远优先"，
    //    注释里还专门写了"把用户的黑名单静默失效是安全事故级"。
    //    ⇒ 现在**不写这个键**：`updateConfig` 是深合并，缺这个键就等于原样保留。
    //      （没有 deny 输入框时不写它，比"写一个空对象"安全。）
    // ⚠️ 旧字段**继续写**，而且要与 mode 保持一致：
    //    旧版本读的是它们，回滚后行为才不会变。写成"与 mode 等价的旧形态"：
    //      allowAll      ⇒ allowAllWhenEmpty=true（名单空时靠它兜底放行）
    //      denyAll       ⇒ allowAllWhenEmpty=false + 名单**清空**（名单非空会盖过复选框！）
    //      whitelist     ⇒ allowAllWhenEmpty 保持用户原来的值（不影响判定），名单照实写
    //    🔴 denyAll 那一支必须清空名单：旧判定是"名单非空 ⇒ 只看名单"，不清空的话
    //       回滚后会变成"只放行名单里的人"，而用户选的是"谁都不许" —— 方向正好相反。
    if (patch.allow.mode === 'allowAll') {
      patch.allowAllWhenEmpty = true;
    } else if (patch.allow.mode === 'denyAll') {
      patch.allowAllWhenEmpty = false;
      patch.allow.groups = [];
      patch.allow.private = [];
    } else {
      patch.allowAllWhenEmpty = c.allowAllWhenEmpty === true;
    }
  }

  // ── 安全与浏览（2026-09-25 第十八对话加）────────────────────────────────
  // ⚠️ 这一节的两个键**本来就在 config.js 里**（`security.browseLock` 是 2026-09-20
  //    吸收上游时接进 web_fetch 的），但**从来没有界面** ⇒ 用户明确说"在界面上找不到"。
  if (sec === 'security') {
    const hosts = String(val('#cfg-browselock-hosts', '') || '')
      .split('\n')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      // 容错：用户可能连协议一起粘进来（`https://example.com/x`）⇒ 只留主机名。
      // 也顺手去掉通配前缀 `*.`（hostAllowed 本来就按子域匹配，写 `*.` 反而不匹配）。
      .map((s) => {
        let h = s.replace(/^[a-z]+:\/\//i, '').replace(/^[*.]+/, '');
        h = h.split('/')[0].split('?')[0].split('#')[0].trim();
        return h.replace(/:\d+$/, '');   // 去掉端口（锁定按主机名比，不按端口）
      })
      .filter(Boolean);
    patch.security = {
      allowPrivateImageHosts: chk('#cfg-allow-private-image-hosts', c.security?.allowPrivateImageHosts === true),
      browseLock: {
        enabled: chk('#cfg-browselock-enabled', c.security?.browseLock?.enabled === true),
        hosts: [...new Set(hosts)],
        siteSearchUrl: String(val('#cfg-browselock-sitesearch', c.security?.browseLock?.siteSearchUrl || '') || '').trim()
      }
    };
  }

  if (sec === 'chat') {
    patch.wakeDelayMs = Number(val('#cfg-wakedelay', c.wakeDelayMs)) || 2000;
    patch.drainDelayMs = Number(val('#cfg-draindelay', c.drainDelayMs)) || 1200;
    patch.maxConcurrentRuns = Number(val('#cfg-maxruns', c.maxConcurrentRuns)) || 2;
    patch.send = {
      ...c.send,
      minGapMs: Number(val('#cfg-mingap', c.send?.minGapMs)) || 1000,
      maxGapMs: Number(val('#cfg-maxgap', c.send?.maxGapMs)) || 3000,
      // 回退值必须与 config.js 的 DEFAULT_CONFIG.send.maxPerMinute 一致（80）
      maxPerMinute: Number(val('#cfg-maxpermin', c.send?.maxPerMinute)) || 80,
      maxPerHour: Number(val('#cfg-maxperhour', c.send?.maxPerHour)) || 500,
      byLengthMs: Number(val('#cfg-bylength', c.send?.byLengthMs)) || 20,
      hardSplitAt: Number(val('#cfg-hardsplit', c.send?.hardSplitAt)) || 0
    };
    patch.proactive = {
      ...c.proactive,
      enabled: chk('#cfg-proactive', !!c.proactive?.enabled),
      // 界面是分钟 ⇒ 存盘前 ×60000 换回毫秒（键名带 Ms，见上面 HTML 里的注释）
      checkIntervalMinMs: minToMs(val('#cfg-pro-min', msToMin(c.proactive?.checkIntervalMinMs, 30)), 1800000),
      checkIntervalMaxMs: minToMs(val('#cfg-pro-max', msToMin(c.proactive?.checkIntervalMaxMs, 90)), 5400000),
      probability: Number(val('#cfg-pro-prob', c.proactive?.probability)) || 0.25,
      // 新增到界面上的四个（原来它们只在 config 里，看不见也调不了）
      idleThresholdMs: minToMs(val('#cfg-pro-idle', msToMin(c.proactive?.idleThresholdMs, 30)), 1800000),
      quietHoursStart: clampInt(val('#cfg-pro-quiet-start', c.proactive?.quietHoursStart ?? 23), 0, 23, 23),
      quietHoursEnd: clampInt(val('#cfg-pro-quiet-end', c.proactive?.quietHoursEnd ?? 8), 0, 24, 8),
      maxConsecutive: clampInt(val('#cfg-pro-maxconsec', c.proactive?.maxConsecutive ?? 2), 1, 10, 2)
      // ⚠️ reengageAfterHours / Backoff / MaxHours 三个**故意不做输入框**：
      //    它们是"没人理就慢慢收手"的退避参数，逻辑绕；而 proactive.enabled 目前是关着的，
      //    为一个没开的功能够造三个输入框不划算。面板上只**只读显示**当前值。
    };
    patch.sticker = {
      ...c.sticker,
      enabled: chk('#cfg-sticker', c.sticker?.enabled !== false),
      // 先取界面实时值（没这个控件时才退回已保存配置），再钳到 0~3
      encourage: Math.min(3, Math.max(0, Number(
        $('#cfg-sticker-encourage') ? $('#cfg-sticker-encourage').value : (c.sticker?.encourage ?? 1)
      ) || 0))
    };
    // 读取历史档位（替代原来的「最多条数 + 字符预算」两个固定值）
    patch.store = {
      ...(c.store || {}),
      // 档位 = 滑条位置换算（唯一真相是滑条的实时 value）。
      // 后端 updateConfig 还会用 tier-slider.js 再权威换算一次，双保险。
      contextTier: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).tier;
      })(),
      // 滑条位置存下来，重开设置页能还原到用户拖动的位置
      contextSliderPos: (() => {
        const sl = $('#ctx-tier-slider');
        return sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
      })(),
      // 3 档概率由滑条位置线性决定（不再让用户单独填数字）
      randomPercent: (() => {
        const sl = $('#ctx-tier-slider');
        const pos = sl ? Number(sl.value) : (c.store?.contextSliderPos ?? 100);
        return sliderToTierUI(pos).randomPercent;
      })(),
      atCount: clampInt(val('#cfg-atcount', c.store?.atCount), 1, 500, 20),
      keywordCount: clampInt(val('#cfg-kwcount', c.store?.keywordCount), 1, 500, 15),
      keywords: String($('#cfg-keywords')?.value || '')
        .split('\n').map((x) => x.trim()).filter(Boolean),
      randomPercent: clampInt(val('#cfg-randpct', c.store?.randomPercent), 0, 100, 10),
      randomCount: clampInt(val('#cfg-randcount', c.store?.randomCount), 1, 500, 8),
      allCount: clampInt(val('#cfg-allcount', c.store?.allCount), 1, 500, 80),
      // 统一开关 + 分会话滑条表（群聊私聊同一套，键是完整 chatKey）
      // __replace__：整体替换，这样"清除某会话的单独设置"才会真的删掉那个键（深合并删不掉）
      unifiedTier: chk('#cfg-unifiedtier', c.store?.unifiedTier !== false),
      chatSliderPos: {
        __replace__: (() => { try { return JSON.parse($('#tier-chat-json')?.value || '{}'); } catch { return {}; } })()
      }
    };
    // 清掉已废弃的字段，避免残留配置误导后来读代码的人
    delete patch.store.pastStateLimit;
    delete patch.store.pastStateMaxChars;
    // groupSliderPos 是被 chatSliderPos 取代的旧字段（只有群聊）：
    // 后端 loadConfig 已经迁移过了，这里再删一次，防止它被 ...c.store 展开重新写回文件
    delete patch.store.groupSliderPos;
  }

  if (sec === 'desktop') {
    patch.server = {
      ...c.server,
      autoStart: chk('#cfg-autostart', !!c.server?.autoStart),
      closeToTray: chk('#cfg-closetray', c.server?.closeToTray !== false)
    };
    patch.ui = {
      ...(c.ui || {}),
      // 主题在点选项时就已应用并写入 localStorage，这里把它一并存到后端以便跨设备保留
      theme: getThemePref(),
      showVision: chk('#cfg-showvision', c.ui?.showVision !== false),
      refreshMs: Number(val('#cfg-refreshms', c.ui?.refreshMs ?? 15000)) || 15000
    };
    patch.memberNotes = {
      ...(c.memberNotes || {})
    };
  }

  if (sec === 'onebot') {
    patch.snowluma = {
      dir: val('#cfg-snowlumadir', c.snowluma?.dir || '').trim(),
      autoLaunch: chk('#cfg-snowlumalaunch', !!c.snowluma?.autoLaunch),
      wsUrl: val('#cfg-wsurl', c.snowluma?.wsUrl || '').trim(),
      httpUrl: val('#cfg-httpurl', c.snowluma?.httpUrl || '').trim(),
      accessToken: val('#cfg-obtoken', c.snowluma?.accessToken || '').trim(),
      httpAccessToken: val('#cfg-obhttptoken', c.snowluma?.httpAccessToken || '').trim()
    };
  }

  const data = await api('/api/config', { method: 'POST', body: JSON.stringify(patch) });
  state.config = data.config;
  if (!quiet) $('#model-label').textContent = `模型：${state.config.api.model || '未设置'}`;
  return data;
}
