'use strict';
// 第 14/18 段：13-settings-events（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

function bindSettingsEvents(c) {
  // 保存当前区块设置（通用保存按钮）。只有当前区块的字段才会被读取，不会 null 报错。
  const saveCfgBtn = $('#save-cfg-btn');
  if (saveCfgBtn) saveCfgBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      const res = $('#cfg-save-result');
      res.textContent = '已保存 ✓';
      res.classList.remove('saved-flash');
      void res.offsetWidth;
      res.classList.add('saved-flash');
      refreshStatus();
      startListPoller();   // 刷新间隔可能刚被改过，用新值重启轮询
    } catch (e) {
      $('#cfg-save-result').textContent = `保存失败：${e.message}`;
    }
  });

  // 系统提示自定义：把当前生效的提示词填进"整份覆盖"框 / 清空覆盖
  const syncFullCount = () => {
    const box = $('#cfg-sysprompt');
    const cnt = $('#sysprompt-count');
    if (box && cnt) cnt.textContent = `${box.value.length} 字符`;
  };
  $('#cfg-sysprompt')?.addEventListener('input', syncFullCount);
  $('#sysprompt-load')?.addEventListener('click', () => {
    const box = $('#cfg-sysprompt');
    if (!box) return;
    box.value = state.systemPrompt?.effective || '';
    syncFullCount();
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已载入当前生效的系统提示 —— 改完记得点下面「保存人设修改」';
  });
  $('#sysprompt-clear')?.addEventListener('click', () => {
    const box = $('#cfg-sysprompt');
    if (box) box.value = '';
    syncFullCount();
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已清空整份覆盖 —— 记得点下面「保存人设修改」';
  });

  // 逐段替换：实时字数 + 「已覆盖」标记 + 一键恢复默认。
  // 判定逻辑与保存时一致：非空且与内置默认不同才算覆盖。
  const syncSegUi = (ta) => {
    const seg = ta.closest('.sp-seg');
    if (!seg) return;
    const flag = seg.querySelector('.sp-seg-flag');
    const count = seg.querySelector('.sp-seg-count');
    const isOverridden = ta.value.trim() !== '' && ta.value.trim() !== String(ta.dataset.default ?? '').trim();
    if (flag) flag.classList.toggle('hidden', !isOverridden);
    if (count) count.textContent = `${ta.value.length} 字符`;
  };
  $$('.sysprompt-seg').forEach((ta) => ta.addEventListener('input', () => syncSegUi(ta)));
  $$('.sp-seg-reset').forEach((btn) => btn.addEventListener('click', () => {
    const ta = btn.closest('.sp-seg')?.querySelector('.sysprompt-seg');
    if (!ta) return;
    ta.value = String(ta.dataset.default ?? '');
    syncSegUi(ta);
    const st = $('#sysprompt-state');
    if (st) st.textContent = '已恢复该段为内置默认 —— 保存后生效';
  }));

  // 搜索提供方切换
  const searchProviderSel = $('#cfg-searchprovider');
  if (searchProviderSel) searchProviderSel.addEventListener('change', () => {
    const v = searchProviderSel.value;
    const fields = {
      bing: '#bing-search-fields',
      deepseek: '#deepseek-search-fields',
      zhipu: '#zhipu-search-fields',
      bocha: '#bocha-search-fields',
      baidu: '#baidu-search-fields',
      metaso: '#metaso-search-fields'
    };
    for (const [provider, sel] of Object.entries(fields)) {
      const el = $(sel);
      // 自定义项形如 'custom:<id>'，统一按 custom 前缀匹配
      if (el) el.style.display = provider === v ? '' : 'none';
    }
    const manage = $('#custom-provider-manage');
    if (manage) manage.style.display = v.startsWith('custom:') ? '' : 'none';
  });

  // ── 自定义搜索服务：添加 / 测试 / 删除 ──
  $('#add-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#add-search-provider-hint');
    const baseUrl = ($('#new-sp-baseurl')?.value || '').trim();
    if (!baseUrl) { if (hint) hint.textContent = '请先填接口地址'; return; }
    if (hint) hint.textContent = '添加中…';
    try {
      const r = await api('/api/search-providers', {
        method: 'POST',
        body: JSON.stringify({
          name: ($('#new-sp-name')?.value || '').trim(),
          type: $('#new-sp-type')?.value || 'openai',
          baseUrl,
          apiKey: ($('#new-sp-apikey')?.value || '').trim(),
          model: ($('#new-sp-model')?.value || '').trim()
        })
      });
      // 添加后直接选中它（省一次手动切换）
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ webSearch: { provider: `custom:${r.provider.id}` } })
      });
      if (hint) hint.textContent = '已添加并选中 ✓';
      for (const id of ['#new-sp-name', '#new-sp-baseurl', '#new-sp-apikey', '#new-sp-model']) {
        const el = $(id);
        if (el) el.value = '';
      }
      await loadSettings();
    } catch (e) {
      if (hint) hint.textContent = `添加失败：${e.message}`;
    }
  });

  $('#test-search-provider-btn')?.addEventListener('click', async () => {
    const hint = $('#search-provider-action-hint');
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) { if (hint) hint.textContent = '请先选择一个自定义搜索服务'; return; }
    if (hint) hint.textContent = '测试中…';
    try {
      const r = await api('/api/search-providers/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: v })
      });
      const res = r.result || {};
      if (hint) {
        hint.textContent = res.ok
          ? `✓ 可用（${res.count} 条结果，${res.latencyMs}ms）${res.sample ? `：${res.sample.slice(0, 30)}` : ''}`
          : `✗ ${res.note || '不可用'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `测试失败：${e.message}`;
    }
  });

  $('#del-search-provider-btn')?.addEventListener('click', async () => {
    const sel = $('#cfg-searchprovider');
    const v = sel?.value || '';
    if (!v.startsWith('custom:')) return;
    const id = v.slice('custom:'.length);
    const opt = sel.querySelector(`option[value="${v}"]`);
    const name = opt ? opt.textContent : id;
    if (!confirm(`确定删除搜索服务「${name}」？`)) return;
    try {
      await api('/api/search-providers', { method: 'DELETE', body: JSON.stringify({ id }) });
      await loadSettings();
    } catch (e) {
      alert(`删除失败：${e.message}`);
    }
  });

  // ── 响应档位滑条：拖动时即时反馈（档位 + 概率 + 参数高亮）──
  // ⚠️ 档位的唯一真相是滑条的 value（DOM 实时值），不用全局变量记录 ——
  //   曾经用过 window.__ctxTier，结果每次重渲染重新绑定事件时被"未保存的旧配置"
  //   无条件覆盖（选了 2 档，切走再切回就变回 4 档），还踩了 `|| 4` 的 falsy 陷阱。
  // ── 参数区高亮：只点亮"当前真正会用到的那一档" ──
  //
  // ⚠️ 这里最容易错的一点：**两种模式的高亮来源不是同一个**。
  //    统一模式 → 上面那根全局滑条；分会话模式 → 下拉里选中的那个会话的滑条。
  //    原来两处各算各的：渲染时用**全局**位置定初始 dim，而全局滑条有监听会实时改、
  //    分会话滑条却只更新自己的提示行 —— 于是把「统一设置」关掉之后，
  //    全局滑条被 display:none 藏起来、四行高亮却还跟着它走，
  //    看起来就变成"莫名其妙只有③亮着"（而当前会话其实是 2 档）。
  //    现在两条路径都调这一个函数，谁显示就听谁的。
  const highlightTierParams = (tier) => {
    document.querySelectorAll('.tier-param').forEach((el, idx) => {
      el.classList.toggle('dim', idx + 1 !== tier);
    });
  };
  // 分会话那条路径的"重新同步"入口（下面 if (chatSel) 里挂上）。
  // 切换统一/分会话开关时要用它把高亮拨到刚显示出来的那根滑条上。
  let resyncPerChatTier = null;

  const tierSlider = $('#ctx-tier-slider');
  if (tierSlider) {
    const sync = () => {
      const pos = Number(tierSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      // 提示行：显示当前档位与概率
      const note = $('#ctx-tier-note');
      if (note) note.innerHTML = sliderDesc(pos);
      // 参数区高亮：1档→只亮①；2档→亮②；3档→亮③；4档→亮④（且①②③失效）
      highlightTierParams(t);
      // 刻度段高亮：滑到哪一档，那一档的标签 + 上边线一起变色。
      // ⚠️ 之前这段完全没做，颜色全靠 CSS 写死（.s1 永远亮、.s4 永远橙），
      //    所以拖动滑条时刻度毫无反应 —— 看起来就像"没生效"。
      const segs = document.querySelectorAll('#tier-scale .tier-seg');
      segs.forEach((el) => {
        el.classList.toggle('on', Number(el.dataset.seg) === t);
      });
      // 滑条填充色（用 CSS 变量告诉样式当前百分比）
      tierSlider.style.setProperty('--pos', pos + '%');
    };
    tierSlider.addEventListener('input', sync);
    sync();   // 初始同步一次
  }

  // ── 统一/分会话开关：切换两块 UI 的显隐 ──
  const unifiedChk = $('#cfg-unifiedtier');
  if (unifiedChk) unifiedChk.addEventListener('change', () => {
    const on = unifiedChk.checked;
    const uw = $('#tier-unified-wrap'); if (uw) uw.style.display = on ? '' : 'none';
    const pw = $('#tier-perchat-wrap'); if (pw) pw.style.display = on ? 'none' : '';
    // 换了一根滑条，参数区高亮必须跟着换 —— 否则又回到"高亮跟当前滑条不是同一根"
    if (on) {
      const g = $('#ctx-tier-slider');
      highlightTierParams(sliderToTierUI(Number(g?.value ?? 100)).tier);
    } else if (resyncPerChatTier) {
      resyncPerChatTier();
    }
  });

  // ── 分会话档位：下拉选会话（群聊 + 私聊）+ 一条滑条 ──
  // ⚠️ 唯一真相是隐藏 input 里的 JSON（tier-chat-json），滑条每次 input 都即时写回 ——
  //    不用全局变量（这个文件里"全局变量被重渲染覆盖"的坑已经踩过两次了）。
  //    键是完整 chatKey（group:123 / private:456），与后端 storeConfigForChat 一致。
  const chatSel = $('#tier-chat-select');
  if (chatSel) {
    const jsonEl = $('#tier-chat-json');
    const gSlider = $('#ctx-tier-slider-g');
    const gNote = $('#ctx-tier-note-g');
    const readMap = () => { try { return JSON.parse(jsonEl.value || '{}'); } catch { return {}; } };
    const writeMap = (m) => { jsonEl.value = JSON.stringify(m); };

    const map0 = readMap();
    const allowGroups = (c.allow?.groups || []).map(String).map((id) => ({ key: `group:${id}`, kind: 'group', id }));
    const allowPrivates = (c.allow?.private || []).map(String).map((id) => ({ key: `private:${id}`, kind: 'private', id }));
    const knownKeys = new Set([...allowGroups, ...allowPrivates].map((e) => e.key));
    // 已单独设置过、但已经不在白名单里的会话：留在列表里让用户能清理掉
    const extras = Object.keys(map0).filter((k) => !knownKeys.has(k)).map((k) => {
      const [kind, id] = String(k).split(':');
      return { key: k, kind, id: id || '' };
    });
    const optHtml = (e, extra) =>
      `<option value="${esc(e.key)}" data-kind="${esc(e.kind)}" data-id="${esc(e.id)}" data-extra="${extra ? '1' : '0'}">${esc(e.id)}${extra ? ' · 已不在白名单' : ''}</option>`;
    const optGroup = (label, list, extra) =>
      list.length ? `<optgroup label="${label}">${list.map((e) => optHtml(e, extra)).join('')}</optgroup>` : '';
    chatSel.innerHTML = [
      optGroup('群聊', allowGroups, false),
      optGroup('私聊', allowPrivates, false),
      optGroup('已不在白名单（可在这里清理）', extras, true)
    ].join('') || '<option value="">（白名单为空，先去「白名单」页签加群或好友）</option>';

    // 异步补名字：群名 / 好友备注名（协议端不在线就保持纯号码，不影响使用）
    Promise.all([
      api('/api/onebot/groups').catch(() => ({ groups: [] })),
      api('/api/onebot/friends').catch(() => ({ friends: [] }))
    ]).then(([gd, fd]) => {
      const names = new Map();
      for (const g of (gd.groups || [])) names.set(`group:${String(g.id)}`, g.name);
      for (const f of (fd.friends || [])) names.set(`private:${String(f.id)}`, f.name);
      chatSel.querySelectorAll('option').forEach((o) => {
        if (!o.value) return;
        const n = names.get(o.value);
        if (n) o.textContent = `${n}（${o.dataset.id}）${o.dataset.extra === '1' ? ' · 已不在白名单' : ''}`;
      });
    }).catch(() => {});

    const syncG = () => {
      const pos = Number(gSlider.value);
      const { tier: t } = sliderToTierUI(pos);
      if (gNote) gNote.innerHTML = sliderDesc(pos);
      document.querySelectorAll('#tier-scale-g .tier-seg')
        .forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === t));
      gSlider.style.setProperty('--pos', pos + '%');
      // ⚠️ 参数区高亮也必须跟着这根滑条走 —— 这一句原来漏了，
      //    结果分会话模式下四行高亮还停在"渲染时算出来的全局档位"上。
      //    只在分会话这块真的显示时才改，免得在统一模式下把它覆盖掉。
      const pw = $('#tier-perchat-wrap');
      if (!pw || pw.style.display !== 'none') highlightTierParams(t);
    };
    const loadChat = () => {
      const key = chatSel.value;
      const m = readMap();
      // 没单独设置过的会话：从全局滑条当前值起步，所见即所得
      gSlider.value = key && m[key] !== undefined ? m[key] : (Number($('#ctx-tier-slider')?.value) || 100);
      syncG();
    };
    chatSel.addEventListener('change', loadChat);
    resyncPerChatTier = loadChat;   // 供「统一/分会话」开关切换时重新点亮
    gSlider.addEventListener('input', () => {
      syncG();
      const key = chatSel.value;
      if (!key) return;
      const m = readMap(); m[key] = Number(gSlider.value); writeMap(m);
    });
    $('#tier-chat-clear-btn')?.addEventListener('click', () => {
      const key = chatSel.value;
      if (!key) return;
      const m = readMap(); delete m[key]; writeMap(m); loadChat();
    });
    loadChat();
  }

  // ── 屏蔽名单 ──
  $('#blocklist-btn')?.addEventListener('click', () => openBlocklistModal());

  // ── 主题选择器（设置页「界面」区）──
  const themePicker = $('#theme-picker');
  if (themePicker) {
    themePicker.querySelectorAll('[data-theme-opt]').forEach((el) => {
      const pick = () => {
        applyTheme(el.dataset.themeOpt);
        themePicker.querySelectorAll('[data-theme-opt]').forEach((x) => x.classList.toggle('on', x === el));
      };
      el.addEventListener('click', pick);
      // 键盘可达：Enter / Space 等价点击
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
      });
    });
  }

  // ── 成本核算：价格卡片随模型/开关变化 ──
  const useOfficialBox = $('#cfg-useofficialprice');
  if (useOfficialBox) useOfficialBox.addEventListener('change', () => {
    // 开关一变，当前模型的可用单价来源就变了，重刷卡片
    refreshModelPriceCard();
  });
  // 直接在模型输入框里改模型时也要刷新 —— 只有从目录里选才会走另一条路径。
  // 用 input 而非 change：边打字边更新，避免"点了别处才变"的迟滞感。
  const modelInput = $('#cfg-model');
  if (modelInput) modelInput.addEventListener('input', () => refreshModelPriceCard());
  refreshModelPriceCard();

  // 批量自定义价格编辑
  $('#batch-price-btn')?.addEventListener('click', () => openBatchPriceModal());

  // ── 远程价格表：状态展示 + 立即拉取 ──
  renderPriceFeedStatus();
  $('#price-feed-refresh-btn')?.addEventListener('click', async () => {
    const statusEl = $('#price-feed-status');
    // URL 改了还没保存就先拉会拉到旧地址 —— 先顺手保存配置再拉
    try { await saveConfig({ quiet: true }); } catch { /* 保存失败也继续尝试拉取 */ }
    if (statusEl) statusEl.textContent = '正在拉取…';
    try {
      const r = await api('/api/model-prices/refresh', { method: 'POST', body: '{}' });
      state.modelPrices = { prices: r.prices, current: r.current, remote: r.remote };
      renderPriceFeedStatus();
      refreshModelPriceCard();   // 价格可能变了，当前模型卡片跟着刷
    } catch (e) {
      if (statusEl) statusEl.textContent = `拉取失败：${e.message}`;
    }
  });

  // ── 记忆整理区块事件 ──
  const memUseChat = $('#cfg-mem-usechat');
  if (memUseChat) memUseChat.addEventListener('change', () => {
    const box = $('#mem-model-box');
    if (box) box.style.display = memUseChat.checked ? 'none' : '';
  });
  const memModelPick = $('#cfg-mem-model-pick');
  if (memModelPick) memModelPick.addEventListener('click', () => openMemoryModelPicker());

  // ── 模型 API 区块事件 ──
  // 密码框显示/隐藏切换（点击按钮切换对应输入框的 type）
  // 已保存 Key 的输入框初始值统一为掩码 "******"；
  // 点「显示」→ 显示真实 Key 明文；点「隐藏」→ 重新变回掩码 "******"。
  //
  // ⚠️ 2026-09-17 修 bug：原来「显示」分支无条件写 `input.value = real`。
  //    对于**还没保存过**的 Key（典型：新 provider 的 API Key 框），后端返回空串，
  //    于是用户刚敲进去的内容被清成空 —— 就是他截图里那个现象。
  //    现在只在这两种情况下才用后端的值覆盖：
  //      ① 框里是掩码 "******"（我们放的占位符，需要换成真值）；
  //      ② 框里是空的（没有用户输入可保护，能填就填）。
  //    其余一律保留用户正在输入的内容。
  const MASK = '******';
  const pwdToggles = [
    ['cfg-apikey-toggle', 'cfg-apikey'],
    ['new-apikey-toggle', 'new-apikey'],
    ['cfg-ds-searchkey-toggle', 'cfg-ds-searchkey'],
    ['cfg-zhipu-key-toggle', 'cfg-zhipu-key'],
    ['cfg-bocha-key-toggle', 'cfg-bocha-key'],
    ['cfg-baidu-key-toggle', 'cfg-baidu-key'],
    ['cfg-metaso-key-toggle', 'cfg-metaso-key']
  ];
  for (const [btnId, inputId] of pwdToggles) {
    const btn = $(`#${btnId}`);
    const input = $(`#${inputId}`);
    if (btn && input) {
      btn.addEventListener('click', async () => {
        const show = input.type === 'password';
        // 所有 Key 统一走 fetchRealKey：/api/config 里的密钥都是脱敏的，
        // 明文只能向后端专用端点取（服务端会校验请求来源）。
        const real = await fetchRealKey(inputId);
        if (show) {
          // 切到明文：只有在"没有用户输入可保护"时才用后端明文覆盖
          const cur = input.value || '';
          input.type = 'text';
          if (real && (cur === '' || cur === MASK)) input.value = real;
          btn.textContent = '隐藏';
        } else {
          // 切回密码态：如果框里是真实 Key（用户没改过），用掩码盖住；用户改了的新 Key 也盖住
          const current = input.value || '';
          input.type = 'password';
          if (real && (current === real || current === '' || current === MASK)) {
            input.value = MASK;
          } else if (!real && current === '') {
            input.value = '';
          } else if (current) {
            // 用户输入了新 Key：保持新值（密码态下浏览器会显示圆点）
          }
          btn.textContent = '显示';
        }
      });
    }
  }

  // 输入框 id -> 搜索服务字段名（/api/config 里的搜索 Key 是脱敏的，
  // 所以“显示”必须向后端专用端点要明文，不能直接读 state.config）
  const SEARCH_KEY_FIELDS = {
    'cfg-ds-searchkey': 'deepseek',
    'cfg-zhipu-key': 'zhipu',
    'cfg-bocha-key': 'bocha',
    'cfg-baidu-key': 'baidu',
    'cfg-metaso-key': 'metaso'
  };

  // 前端点“显示”时向后端要真实 Key。
  // 说明：三个端点都只放行本机控制台请求（服务端校验来源），本地单机使用不受影响。
  async function fetchRealKey(inputId) {
    if (inputId === 'cfg-apikey') {
      const pid = state.config?.api?.provider;
      if (pid) {
        const r = await api(`/api/providers/key?providerId=${encodeURIComponent(pid)}`);
        return String(r.apiKey || '');
      }
      const r = await api('/api/api-key');
      return String(r.apiKey || '');
    }
    const field = SEARCH_KEY_FIELDS[inputId];
    if (field) {
      const r = await api(`/api/search-key?field=${encodeURIComponent(field)}`);
      return String(r.apiKey || '');
    }
    return '';
  }
  // 点击文本框弹出选择模态框（无“选择”按钮）
  const modelPickInput = $('#cfg-model-pick');
  if (modelPickInput) modelPickInput.addEventListener('click', () => openModelPicker());

  // ── 图片 / 视频专用模型的两个「选择」按钮（2026-09-25 · 第十七对话）──────────
  // 复用**同一个**模型选择器（`openModelPicker` 的回调模式），且**不写配置**：
  //   只把模型 id 填进输入框，由页面底部的「保存」统一落盘 —— 与这一页其它字段同一套口径。
  // ⚠️ 这里只是**注册**监听；回调真正执行时 `openModelPicker`（定义在 14-modals.js，
  //    在本段之后加载）早已就位 —— 经典 script 共享作用域，且点击远晚于全部脚本执行完。
  for (const [btnId, inputId] of [['#pick-vision-model-btn', '#cfg-vision-model'], ['#pick-video-model-btn', '#cfg-video-model']]) {
    const btn = $(btnId);
    if (btn) btn.addEventListener('click', () => openModelPicker({ onPick: ({ model }) => { $(inputId).value = model; } }));
  }
  // 拿当前 API Key 的真实值：如果输入框里是用户刚输入的新 Key（非掩码非空），优先用；否则向后端取
  async function currentApiKey() {
    const input = $('#cfg-apikey');
    const raw = (input?.value || '').trim();
    if (raw && raw !== '******') return raw;          // 用户明文输入的新 Key / 刚点过“显示”的明文
    return await fetchRealKey('cfg-apikey');          // 掩码/空 → 用后端真实 Key
  }

  // 连通性测试：抽成公共逻辑，两个入口共用
  // （健康卡片的 test-api-btn 与模型区块的 test-provider-btn 做的是同一件事）
  async function runConnectivityTest(btn, out, idleLabel) {
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = '测试中…';
    if (out) out.textContent = '';
    try {
      const baseUrl = $('#cfg-baseurl')?.value.trim() || '';
      const model = $('#cfg-model')?.value.trim() || '';
      // 只把"用户新输入的明文 Key"传给服务端；若是掩码/空则不传，
      // 让服务端用自己保存的 Key —— 不依赖明文读取端点，未设 token 时也能测试。
      const input = $('#cfg-apikey');
      const raw = (input?.value || '').trim();
      const apiKey = (raw && raw !== '******') ? raw : '';
      const r = await api('/api/providers/test-chat', {
        method: 'POST',
        body: JSON.stringify({ baseUrl, apiKey, model })
      });
      const res = r.result || {};
      if (out) out.textContent = res.ok
        ? `✓ 测试通过（${res.latencyMs}ms）：${res.note || '请求成功'}`
        : `✗ 测试失败：${res.note || '未知错误'}`;
    } catch (e) {
      if (out) out.textContent = `测试失败：${e.message}`;
    }
    btn.disabled = false;
    btn.textContent = idleLabel;
  }

  const testProviderBtn = $('#test-provider-btn');
  if (testProviderBtn) testProviderBtn.addEventListener('click', () => runConnectivityTest(testProviderBtn, $('#provider-test-result'), '测试连通性'));

  // ⚠️ 2026-09-22（第十一对话 · 代码洁净日）这里删掉了「健康卡片上的『测试一下』」那段绑定：
  //    它绑的是 `#test-api-btn`，而那个按钮**只由 renderHealthCard() 产出** —— 那个函数
  //    自 09-18 基线起就没人调用（体检卡被顶部 banner + 首启跳设置取代），所以这个
  //    `if (testApiBtn)` 永远为 null、静默跳过：**一段永远不会执行的绑定，被 null 守卫掩盖着**。
  //    现随 renderHealthCard / assessReadiness 一并删除（体检卡整片休眠死码）。

  // 当前 Base URL 右侧的“获取列表”
  const fetchCurrentBtn = $('#fetch-current-models-btn');
  if (fetchCurrentBtn) fetchCurrentBtn.addEventListener('click', async () => {
    const btn = fetchCurrentBtn;
    const base = $('#cfg-baseurl')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '当前 Base URL 为空'; return; }
    btn.textContent = '拉取中…';
    try {
      const key = await currentApiKey();
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  const fetchModelsBtn = $('#fetch-models-btn');
  if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
    const btn = fetchModelsBtn;
    const base = $('#new-baseurl')?.value.trim() || '';
    const key = $('#new-apikey')?.value.trim() || '';
    if (!base) { $('#provider-action-hint').textContent = '请先填写 Base URL'; return; }
    btn.textContent = '拉取中…';
    try {
      const r = await api('/api/providers/fetch-models', {
        method: 'POST',
        body: JSON.stringify({ baseUrl: base, apiKey: key })
      });
      openModelAddModal(base, key, r.models || []);
      btn.textContent = '获取列表';
    } catch (e) {
      btn.textContent = '获取列表';
      $('#provider-action-hint').textContent = `拉取失败：${e.message}`;
    }
  });

  // 模型列表行：ID + 显示名
  let modelRows = [{ id: '', name: '' }];
  function renderModelRows() {
    const box = $('#model-rows');
    if (!box) return;
    box.innerHTML = `
      <table class="model-rows-table">
        <tr><th>模型 ID</th><th>目录显示名</th><th class="mr-ops"></th></tr>
        ${modelRows.map((row, i) => `
          <tr>
            <td><input type="text" class="mr-id" data-i="${i}" placeholder="glm-5.3-flash" value="${esc(row.id)}" /></td>
            <td><input type="text" class="mr-name" data-i="${i}" placeholder="智谱 GLM 5.3 Flash" value="${esc(row.name)}" /></td>
            <td class="mr-ops"><button class="btn btn-small btn-danger mr-del" data-i="${i}" ${modelRows.length <= 1 ? 'disabled' : ''} title="${modelRows.length <= 1 ? '至少保留一行' : '删掉这一行'}">删除</button></td>
          </tr>`).join('')}
      </table>`;
    box.querySelectorAll('.mr-id').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].id = el.value; });
    });
    box.querySelectorAll('.mr-name').forEach((el) => {
      el.addEventListener('input', () => { modelRows[Number(el.dataset.i)].name = el.value; });
    });
    box.querySelectorAll('.mr-del').forEach((el) => {
      el.addEventListener('click', () => {
        if (modelRows.length <= 1) return;
        modelRows.splice(Number(el.dataset.i), 1);
        renderModelRows();
      });
    });
  }
  renderModelRows();
  const addModelRowBtn = $('#add-model-row-btn');
  if (addModelRowBtn) addModelRowBtn.addEventListener('click', () => {
    modelRows.push({ id: '', name: '' });
    renderModelRows();
  });

  const confirmAddProviderBtn = $('#confirm-add-provider-btn');
  if (confirmAddProviderBtn) confirmAddProviderBtn.addEventListener('click', async () => {
    const baseUrl = $('#new-baseurl').value.trim();
    const apiKey = $('#new-apikey').value.trim();
    const models = modelRows.map((r) => ({ id: r.id.trim(), name: (r.name || r.id).trim() })).filter((m) => m.id);
    if (!baseUrl) { $('#provider-action-hint').textContent = '请填写 Base URL'; return; }
    if (!apiKey) { $('#provider-action-hint').textContent = '请填写 API Key（提供商必须带密钥才能测试连通性/在线探测图片能力）'; return; }
    if (!models.length) { $('#provider-action-hint').textContent = '请至少添加一个模型（先点「获取列表」勾选，或手动填一行）'; return; }
    try {
      const r = await api('/api/providers', { method: 'POST', body: JSON.stringify({ baseUrl, apiKey, models }) });
      $('#provider-action-hint').textContent = r.created ? '已添加新提供商，并自动切换为当前模型。' : '该 Base URL 已存在，模型已合并进该提供商。';
      modelRows = [{ id: '', name: '' }];
      renderModelRows();
      $('#new-baseurl').value = '';
      $('#new-apikey').value = '';
      setTimeout(() => loadSettings(), 500);
    } catch (e) {
      $('#provider-action-hint').textContent = `添加失败：${e.message}`;
    }
  });

  const deleteModelBtn = $('#delete-model-btn');
  if (deleteModelBtn) deleteModelBtn.addEventListener('click', () => openModelDeleteModal());

  // 图片输入开关联动（视觉扫描结果）
  function syncVisionSwitch(pid, model) {
    const box = $('#cfg-vision');
    const hint = $('#vision-switch-hint');
    const vhint = $('#model-vision-hint');
    if (box) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && r.verdict === 'no-vision') {
        box.checked = false;
        box.disabled = true;
        hint.textContent = '此模型不支持图片输入';
      } else {
        box.disabled = false;
        box.checked = state.config.api.vision !== false;
        hint.textContent = r && r.verdict === 'vision' ? '检测结果：支持图片输入' : '';
      }
    }
    if (vhint) {
      const r = (state.visionResults || {})[`${pid || ''}|||${model || ''}`];
      if (r && (r.verdict === 'vision' || r.verdict === 'no-vision')) {
        vhint.textContent = r.verdict === 'vision' ? '✅ 当前模型支持图片输入' : '🚫 当前模型不支持图片输入';
      } else {
        vhint.textContent = '';
      }
    }
  }
  syncVisionSwitch(c.api.provider, c.api.model);

  // 模型目录“支持图片输入/不支持图片输入”徽标开关
  function applyShowVision() {
    const show = state.config?.ui?.showVision !== false;
    $$('.vbadge').forEach((el) => { el.style.display = show ? '' : 'none'; });
  }
  applyShowVision();

  // ── 人设区块事件 ──
  // ⚠️ `currentPersonaId()` / `syncPersonaButtons()` **已提到模块作用域**（本文件上方、
  //    `openPersonaPicker` 前面）—— 原来它们定义在这里，导致弹窗那边跨作用域调用时报
  //    `ReferenceError: syncPersonaButtons is not defined`。改回去会重新引入那个 bug。
  const personaPick = $('#cfg-persona-pick');
  if (personaPick) {
    personaPick.addEventListener('click', () => openPersonaPicker());
  }
  const newPersonaBtn = $('#new-persona-btn');
  if (newPersonaBtn) newPersonaBtn.addEventListener('click', () => openPersonaCreateModal());
  const delPersonaBtn = $('#del-persona-btn');
  if (delPersonaBtn) delPersonaBtn.addEventListener('click', async () => {
    const id = currentPersonaId();
    if (!id.startsWith('custom_')) return;
    const tpl = state.personaTemplates[id];
    if (!tpl) return;
    if (!confirm(`确定删除自定义人设「${tpl.name}」？`)) return;
    try {
      await api(`/api/persona-templates/${id}`, { method: 'DELETE', body: '{}' });
      $('#cfg-roletext').value = state.personaTemplates.xiaojingyu?.text || '';
      $('#cfg-customrules').value = '';
      await loadSettings();
    } catch (e) {
      $('#persona-pick-hint').textContent = `删除失败：${e.message}`;
    }
  });
  const savePersonaBtn = $('#save-persona-btn');
  if (savePersonaBtn) savePersonaBtn.addEventListener('click', async () => {
    try {
      await saveConfig();
      $('#persona-save-result').textContent = '人设已保存 ✓';
      setTimeout(() => { $('#persona-save-result').textContent = ''; }, 3000);
    } catch (e) {
      $('#persona-save-result').textContent = `保存失败：${e.message}`;
    }
  });
  syncPersonaButtons();

  // ── 白名单区块事件 ──
  const pickGroupsBtn = $('#pick-groups-btn');
  if (pickGroupsBtn) pickGroupsBtn.addEventListener('click', () => openWhitelistPicker('groups'));
  const pickFriendsBtn = $('#pick-friends-btn');
  if (pickFriendsBtn) pickFriendsBtn.addEventListener('click', () => openWhitelistPicker('friends'));

  // ── 检查更新（桌面端区块） ──
  const curVerEl = $('#update-current');
  if (curVerEl) {
    api('/api/version').then((d) => { curVerEl.textContent = `v${d.version || '?'}`; })
      .catch(() => { curVerEl.textContent = ''; });
  }
  const checkUpdateBtn = $('#check-update-btn');
  if (checkUpdateBtn) checkUpdateBtn.addEventListener('click', async () => {
    const hint = $('#update-hint');
    checkUpdateBtn.disabled = true;
    if (hint) hint.textContent = '检查中…';
    const data = await runUpdateCheck({ manual: true });   // 手动：即使关过浮窗也再弹一次
    if (!data) {
      if (hint) hint.textContent = '检查失败：网络不可达';
    } else if (!data.ok) {
      if (hint) hint.textContent = `检查失败：${data.error || '未知错误'}`;
    } else if (data.hasUpdate) {
      // 有新版：给下载链接。Electron 里 target=_blank 会被 main.js 转给系统浏览器。
      if (hint) hint.innerHTML = `发现新版本 <b>v${esc(data.latest)}</b>（当前 v${esc(data.current)}） <a href="${esc(data.url)}" target="_blank" rel="noopener">去下载</a>`;
    } else if (hint) hint.textContent = `已是最新（v${data.current}）`;
    checkUpdateBtn.disabled = false;
  });

  // ── OneBot 区块事件 ──
  const openSnowlumaBtn = $('#open-snowluma-btn');
  if (openSnowlumaBtn) openSnowlumaBtn.addEventListener('click', async () => {
    await saveConfig({ quiet: true });
    try { await api('/api/snowluma/open-folder', { method: 'POST', body: '{}' }); }
    catch (e) { $('#snowluma-hint').textContent = `失败：${e.message}`; }
  });
}
