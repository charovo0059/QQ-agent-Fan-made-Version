'use strict';
// 第 11/18 段：10-settings-load（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）
async function loadSettings() {
  const [cfg, tplData, provData, visionData, priceData, sysPromptData] = await Promise.all([
    api('/api/config'),
    api('/api/persona-templates').catch(() => ({ templates: [] })),
    api('/api/providers').catch(() => ({ providers: [] })),
    api('/api/vision/results').catch(() => ({ results: {}, scanning: false })),
    api('/api/model-prices').catch(() => ({ prices: [], current: null })),
    api('/api/system-prompt').catch(() => null)
  ]);
  state.config = cfg;
  state.providers = provData.providers || [];
  state.visionResults = visionData.results || {};
  state.visionScanning = !!visionData.scanning;
  state.modelPrices = priceData || { prices: [], current: null };
  state.systemPrompt = sysPromptData && Array.isArray(sysPromptData.segments) ? sysPromptData : null;
  state.personaTemplates = {};
  for (const t of tplData.templates || []) state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
  renderSettings();
}

/** 设置页「远程价格表」状态行：来源（在线/缓存/内置）、时间、条目数、错误。 */
function renderPriceFeedStatus() {
  const el = $('#price-feed-status');
  if (!el) return;
  const r = state.modelPrices?.remote;
  if (!r || !r.enabled) {
    el.textContent = '未配置远程价格表 —— 当前使用内置表。填上 URL 并保存后，启动时与每 24 小时自动拉取。';
    return;
  }
  const when = r.fetchedAt ? fmtTime(r.fetchedAt) : '-';
  const droppedTxt = r.dropped ? `，${r.dropped} 条不合格被丢弃` : '';
  if (r.ok && r.source === 'remote') {
    el.textContent = `远程表生效中：${r.count} 条覆盖内置表 · 上次拉取 ${when}${droppedTxt}`;
  } else if (!r.ok && r.source === 'cache') {
    el.textContent = `服务器暂时拉不到（${r.error || '未知错误'}），正在用上次缓存的远程表（${r.count} 条）· ${when}`;
  } else if (!r.ok) {
    el.textContent = `拉取失败（${r.error || '未知错误'}），暂用内置表 · ${when}`;
  } else {
    el.textContent = `已应用本地缓存（${r.count} 条），正在拉取最新…`;
  }
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * 匹配判断在本地用 state.modelPrices.prices 直接算，
 * 不读 state.modelPrices.current —— 那是后端按「当时请求的模型」算的，
 * 切换模型后若不重新请求就会拿到旧值。
 */
/**
 * 在内置价格表里匹配模型（前端版）。
 *
 * 前端是无模块单文件，拿不到 src/model-prices.js 的导出，所以这里实现一份
 * 与后端 matchPriceTable 完全相同的逻辑：精确 → 去前缀 → 最长前缀匹配。
 * 用本地数据算而不是读 state.modelPrices.current —— 后者是后端按
 * 「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function matchPriceTable(modelId, table) {
  const raw = String(modelId || '').trim();
  if (!raw) return null;
  const id = raw.toLowerCase();
  const list = table || [];

  const exact = list.find((x) => String(x.id).toLowerCase() === id);
  if (exact) return exact;

  if (id.includes('/')) {
    const bare = id.split('/').pop();
    const hit = list.find((x) => String(x.id).toLowerCase() === bare);
    if (hit) return hit;
  }

  let best = null;
  for (const x of list) {
    const xid = String(x.id).toLowerCase();
    if (id.startsWith(xid) && (!best || xid.length > String(best.id).length)) best = x;
  }
  return best;
}

/**
 * 刷新「当前模型单价」卡片。
 *
 * ── 规则（只跟开关绑定，绝不依赖保存状态）──
 *   开关开 → 展示内置官方价，输入框**只读**
 *            匹配不到就是 0，提示关掉开关自填
 *   开关关 → 输入框**可编辑**，优先该模型的自定义价，没设则用全局兜底
 *
 * ⚠️ 关键：所有输入都读**界面控件的实时值**，不读 state.config。
 *   否则没点「保存设置」之前，开关/模型名怎么改都是旧值，
 *   看起来就像"按了没反应" —— 这与"可编辑性只跟开关绑定"的意图直接冲突。
 *
 * 匹配判断在本地用 state.modelPrices.prices 算，不读 state.modelPrices.current
 * —— 后者是后端按「当时请求的模型」算的，切换模型后不重新请求就会拿到旧值。
 */
function refreshModelPriceCard() {
  const modelEl = $('#pc-model');
  const noteEl = $('#pc-note');
  const inEl = $('#cfg-price-in');
  const outEl = $('#cfg-price-out');
  const cachedEl = $('#cfg-price-cached');
  if (!modelEl) return;

  const cfg = state.config || {};
  const api = cfg.api || {};

  // 实时值：优先界面控件，退回已保存配置
  const box = $('#cfg-useofficialprice');
  const modelInput = $('#cfg-model');
  const useOfficial = box ? box.checked : (api.useOfficialPrice !== false);
  const model = String((modelInput ? modelInput.value : api.model) || '').trim();

  modelEl.textContent = model || '（未选择模型）';

  if (!model) {
    [inEl, outEl, cachedEl].forEach((el) => { if (el) { el.value = 0; el.disabled = true; } });
    if (noteEl) noteEl.textContent = '先在上方选择一个模型，才能查看/设定它的单价。';
    return;
  }

  let shown, locked, sourceTxt;

  if (useOfficial) {
    locked = true;
    const official = matchPriceTable(model, state.modelPrices?.prices || []);
    if (official) {
      shown = {
        in: official.in ?? 0,
        out: official.out ?? 0,
        cached: official.cached == null ? official.in : official.cached
      };
      const tag = official.src === 'official' ? '厂商官方定价页直取' : '二手折算，仅供参考';
      sourceTxt = `内置官方价格表已匹配到「${official.id}」（${tag}）。开关开启时只读 —— 要自定义请关闭上方开关。`;
      if (official.peak) {
        sourceTxt += `　该模型分时段计价（高峰 ${official.peak.in}/${official.peak.out}/${official.peak.cached}）。`;
      }
      if (official.image) {
        sourceTxt += '　支持图片输入：' + (official.image.mode === 'capped'
          ? `每张封顶 ${official.image.maxTokensPerImage} token`
          : official.image.mode === 'pixel'
            ? `每张 = 宽×高/${official.image.divisor}+${official.image.base} token`
            : '换算规则待补');
      }
    } else {
      shown = { in: 0, out: 0, cached: 0 };
      sourceTxt = '';
    }
  } else {
    locked = false;
    // 自定义价读已保存的配置（那才是用户存的），但模型身份用实时模型名去查
    const custom = (api.modelPrices || {})[model];
    if (custom && (Number(custom.in) || Number(custom.out))) {
      shown = {
        in: Number(custom.in) || 0,
        out: Number(custom.out) || 0,
        cached: custom.cached == null ? Number(custom.in) || 0 : Number(custom.cached) || 0
      };
      sourceTxt = '正在使用你为该模型设定的单价。';
    } else {
      shown = {
        in: Number(api.priceInputPerM) || 0,
        out: Number(api.priceOutputPerM) || 0,
        cached: Number(api.priceCachedPerM) || Number(api.priceInputPerM) || 0
      };
      sourceTxt = '已关闭官方价格表，可在此填写该模型的单价（也可在「批量自定义价格编辑」里为多个模型分别设定）。';
    }
  }

  if (inEl) { inEl.value = shown.in ?? 0; inEl.disabled = locked; }
  if (outEl) { outEl.value = shown.out ?? 0; outEl.disabled = locked; }
  if (cachedEl) { cachedEl.value = shown.cached ?? 0; cachedEl.disabled = locked; }
  const card = $('#model-price-card');
  if (card) card.classList.toggle('locked', locked);
  if (noteEl) noteEl.textContent = sourceTxt;
}

/**
 * 批量自定义价格编辑：左列选供应商 → 右列该供应商的模型 →
 * 官方表（输入/输出/缓存命中）参考列 + 自定义单价输入列。
 *
 * 曾经的候选列表是"当前模型 + 已自定义 + 用量统计里出现过的" ——
 * 没调用过的模型根本进不了名单，想提前给没用过的新模型定价都做不到。
 * 现在按供应商目录浏览，全量模型都可设定。
 *
 * 两个细节：
 *   1. 编辑暂存在 edits 里（input 事件实时写入），切换供应商不丢未保存的修改
 *   2. 目录之外但已自定义的模型归到虚拟供应商「已自定义（目录外）」，
 *      保证旧条目永远能找到、能清除
 */
function openBatchPriceModal() {
  const cfg = state.config || {};
  const customMap = cfg.api?.modelPrices || {};
  // 编辑暂存：以已保存的自定义价为起点，用户的每一次输入都先落在这里
  const edits = {};
  for (const [k, v] of Object.entries(customMap)) edits[k] = { ...(v || {}) };

  // 左列数据：供应商目录 + 虚拟供应商（目录外已自定义的模型）
  const catalogModels = new Set();
  for (const p of (state.providers || [])) for (const m of (p.models || [])) catalogModels.add(m);
  const orphanCustoms = Object.keys(customMap).filter((k) => !catalogModels.has(k)).sort();
  const lefts = (state.providers || []).map((p) => ({
    id: p.id, name: p.displayName || p.id, models: p.models || [], names: p.modelNames || {}
  }));
  if (orphanCustoms.length) {
    lefts.push({ id: '__custom__', name: `已自定义（目录外 ${orphanCustoms.length}）`, models: orphanCustoms, names: {} });
  }

  if (!lefts.length) {
    modelModalShell({
      head: '批量自定义价格编辑',
      body: '<div class="empty-hint">模型目录为空：请先在「模型 API」页签添加提供商。</div>',
      foot: ''
    });
    return;
  }

  let activePid = lefts[0].id;
  let kw = '';   // 搜索关键词（中转站供应商可能有几百个模型，没搜索没法用）

  const overlay = modelModalShell({
    head: '批量自定义价格编辑',
    body: `
      <div class="ma-toolbar">
        <input type="text" id="bp-search" placeholder="搜索模型…" autocomplete="off" />
        <span class="muted" style="font-size:12px;white-space:nowrap">留空 = 不自定义（走官方表/兜底）</span>
      </div>
      <div class="ma-body dual">
        <div class="model-modal-left" id="bp-left"></div>
        <div class="model-modal-right" id="bp-right"></div>
      </div>
      <div id="bp-hint" class="muted" style="font-size:12px;flex-shrink:0;margin-top:8px">
        输入框占位符与模型名悬停提示均为官方价（元/百万 token）；修改只写入你的配置，不会改动官方价格表。
      </div>`,
    foot: `<button class="btn" id="bp-cancel">取消</button>
           <button class="btn btn-primary" id="bp-save">保存</button>`
  });

  const left = overlay.querySelector('#bp-left');
  const right = overlay.querySelector('#bp-right');
  const hintEl = overlay.querySelector('#bp-hint');

  function renderLeft() {
    left.innerHTML = lefts.map((p) =>
      `<div class="mm-prov ${p.id === activePid ? 'active' : ''}" data-pid="${esc(p.id)}">${esc(p.name)}</div>`).join('');
    left.querySelectorAll('.mm-prov').forEach((el) => {
      el.addEventListener('click', () => { activePid = el.dataset.pid; renderLeft(); renderRight(); });
    });
  }

  function rowHtml(p, m) {
    if (kw && !m.toLowerCase().includes(kw) && !String(p.names[m] || '').toLowerCase().includes(kw)) return '';
    const off = matchPriceTable(m, state.modelPrices?.prices || []);
    const c = edits[m] || {};
    // 官方价不占列（太挤）：placeholder 里有，模型名悬停也有
    const offTitle = off ? `官方价：输入 ${off.in} / 输出 ${off.out} / 缓存 ${off.cached ?? '—'}（元/百万）` : '官方价格表未收录';
    return `
      <tr data-model="${esc(m)}">
        <td title="${esc(offTitle)}">${esc(p.names[m] || m)}<div class="muted" style="font-size:11px">${esc(m)}</div></td>
        <td><input type="number" step="0.01" min="0" class="bp-in" value="${esc(c.in ?? '')}" placeholder="${off ? off.in : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-out" value="${esc(c.out ?? '')}" placeholder="${off ? off.out : 0}" /></td>
        <td><input type="number" step="0.01" min="0" class="bp-cached" value="${esc(c.cached ?? '')}" placeholder="${off ? (off.cached ?? 0) : 0}" /></td>
        <td><button class="bp-del" title="清除该模型的自定义价">清除</button></td>
      </tr>`;
  }

  function renderRight() {
    const p = lefts.find((x) => x.id === activePid);
    const models = p ? p.models : [];
    right.innerHTML = `
      <table class="usage-table">
        <thead><tr>
          <th>模型（悬停看官方价）</th>
          <th>自定义 输入</th><th>自定义 输出</th><th>自定义 缓存命中</th><th></th>
        </tr></thead>
        <tbody id="bp-body">
          ${models.map((m) => rowHtml(p, m)).join('') || '<tr><td colspan="5" class="muted">没有匹配的模型</td></tr>'}
        </tbody>
      </table>`;
    // 输入实时落进 edits：切换供应商/搜索重渲染后不丢未保存的修改
    right.querySelectorAll('#bp-body tr[data-model]').forEach((tr) => {
      const m = tr.dataset.model;
      const sync = () => {
        const num = (sel) => {
          const v = String(tr.querySelector(sel)?.value ?? '').trim();
          return v === '' ? null : (Number(v) || 0);
        };
        const i = num('.bp-in'), o = num('.bp-out'), c = num('.bp-cached');
        if (i === null && o === null && c === null) delete edits[m];
        else edits[m] = { in: i ?? 0, out: o ?? 0, cached: c ?? (i ?? 0) };
      };
      tr.querySelectorAll('input').forEach((inp) => inp.addEventListener('input', sync));
    });
    right.querySelectorAll('#bp-body .bp-del').forEach((el) => {
      el.addEventListener('click', () => {
        const tr = el.closest('tr[data-model]');
        if (!tr) return;
        delete edits[tr.dataset.model];
        tr.querySelectorAll('input').forEach((i) => { i.value = ''; });
      });
    });
  }

  overlay.querySelector('#bp-search')?.addEventListener('input', (e) => {
    kw = String(e.target.value || '').trim().toLowerCase();
    renderRight();
  });

  renderLeft();
  renderRight();

  overlay.querySelector('#bp-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#bp-save').addEventListener('click', async () => {
    // 保存的就是 edits 本身（输入时已实时同步，不用再扫 DOM）
    const next = edits;
    try {
      hintEl.textContent = '保存中…';
      // 用 __replace__ 整体替换：普通深合并传对象是删不掉旧键的，
      // 用户点"清除"某行后保存，旧条目会复活。
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ api: { modelPrices: { __replace__: next } } })
      });
      // 更新本地状态，避免下次打开还是旧值
      state.config = state.config || {};
      state.config.api = state.config.api || {};
      state.config.api.modelPrices = next;
      closeModelModal(overlay);
      refreshModelPriceCard();
      $('#provider-action-hint').textContent = `已保存 ${Object.keys(next).length} 个模型的自定义单价。`;
    } catch (e) {
      hintEl.textContent = `保存失败：${esc(e.message)}`;
    }
  });
}

function renderPersonaPicker(c) {
  const currentId = Object.entries(state.personaTemplates || {}).find(([, p]) => p.text === (c.persona?.roleText || ''))?.[0] || '';
  const currentName = state.personaTemplates[currentId]?.name || '';
  return `
    <div class="field-row" style="align-items:flex-end">
      <div class="field">
        <label>选择人设</label>
        <div style="display:flex;gap:8px">
          <input type="text" id="cfg-persona-pick" readonly placeholder="点击选择人设" value="${esc(currentName)}" style="flex:1;cursor:pointer" />
          <button class="btn btn-small" id="new-persona-btn">＋ 添加人设</button>
          <button class="btn btn-small btn-danger hidden" id="del-persona-btn">删除当前自定义人设</button>
        </div>
        <span id="persona-pick-hint" class="muted" style="font-size:12px"></span>
      </div>
    </div>`;
}

function renderPersonaSaveBar() {
  return `
    <div class="persona-save-row">
      <button class="btn btn-primary" id="save-persona-btn">保存人设修改</button>
      <span id="persona-save-result" class="muted"></span>
    </div>`;
}


// 人设模板数据：state.personaTemplates（由 loadSettings 从后端填充）


// 目录的"点击外部 / Esc 收起"监听器只在全局注册一次（renderSettings 每次重渲染都会
// 重建 DOM，若在这里注册会随渲染次数无限叠加、并引用已脱离文档的旧节点）。
// 事件触发时按 id 现查当前元素，天然跟随最新 DOM。
let modelDdDismissBound = false;


/* ══════════════════════════════════════════════════════════════
   表情包页
   ──────────────────────────────────────────────────────────────
   数据源：data/stickers.json（由 /api/stickers 读出）。
   注意：这里**不存图片**——每条只有一个 QQ CDN 地址，图片由浏览器直接去
   p.qpic.cn 取，所以断网时图会裂，但备注/标签照常可读可改。
   可改的只有"机器人认知层"三个字段（localNote / tags / usage）；
   desc 是你在 QQ 里写的备注，url/md5 来自 QQ，界面不给改。
   ══════════════════════════════════════════════════════════════ */

async function loadStickerPage({ force = false, quiet = false } = {}) {
  const page = $('#stickers-page');
  if (!page) return;
  if (!quiet && !state.stickers) page.innerHTML = '<div class="empty-hint">加载中…</div>';
  try {
    // 收藏上限要在这一页上直接改，所以每次进页面都重新拿一份配置。
    // ⚠️ 不能用 if (!state.config) 缓存 —— 别处（或上次打开）拿到的可能是旧值：
    //    实测过"服务器上已经是 60、输入框还显示 10"。
    try { state.config = await api('/api/config'); } catch { /* 拿不到就沿用旧的，不影响表情列表 */ }
    // force=true 会让后端真的去调 OneBot 重新拉一次 QQ 收藏表情
    const data = await api(`/api/stickers${force ? '?refresh=1' : ''}`);
    state.stickers = data;
    renderStickerPage();
    if (force) {
      const tip = $('#sticker-sync-tip');
      if (tip) {
        tip.textContent = data.syncError
          ? `同步失败，仍在用本地缓存：${data.syncError}`
          : `已从 QQ 重新同步 ✓ 共 ${(data.stickers || []).length} 个表情`;
      }
    }
  } catch (e) {
    page.innerHTML = `<div class="empty-hint">加载失败：${esc(e.message)}</div>`;
  }
}

/** 按搜索词与筛选档过滤（搜索覆盖备注/标签/用途/id）。 */
function stickerFiltered() {
  const list = (state.stickers && state.stickers.stickers) || [];
  const q = String(state.stickerQuery || '').trim().toLowerCase();
  const f = state.stickerFilter || 'all';
  return list.filter((s) => {
    if (q) {
      const hay = [s.desc, s.localNote, s.usage, s.id, s.resId, ...(s.tags || [])].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (f === 'nonote') return !String(s.localNote || '').trim();
    if (f === 'note') return !!String(s.localNote || '').trim();
    if (f === 'used') return Number(s.useCount) > 0;
    if (f === 'unused') return !(Number(s.useCount) > 0);
    if (f === 'ai') return s.source === 'ai';
    if (f === 'qq') return s.source !== 'ai';
    return true;
  });
}

function stickerCardHtml(s) {
  const note = String(s.localNote || '');
  const tags = (s.tags || []).map((t) => `<span class="sticker-tag">${esc(t)}</span>`).join('');
  // 走本地缓存接口（服务端优先读 data/stickers/<id>.bin，没有才换新链下载并缓存）。
  // 不再直接把存档里的 QQ 链接塞进 src —— 那链里的 rkey 十几小时就过期，实测 36 条**全部**已失效；
  // 旧写法会让缩略图变成一块没有解释的黑（.thumb 的底色是 #0b0d11），连"是不是坏了"都看不出来。
  const img = s.url
    ? `<img src="/api/stickers/${encodeURIComponent(s.id)}/image?thumb=1" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.parentNode.classList.add('failed')" />`
    : '<span class="muted" style="font-size:12px">没有图片地址</span>';
  const srcLabel = s.source === 'qq' ? 'QQ收藏' : (s.source === 'ai' ? 'AI收藏' : '手动');
  return `
    <div class="sticker-card" data-id="${esc(s.id)}">
      <div class="thumb">${img}</div>
      <div class="sbody">
        <div class="sticker-srow">
          <span class="sticker-src ${esc(s.source)}">${srcLabel}</span>
          <span style="margin-left:auto">用过 ${Number(s.useCount) || 0} 次</span>
        </div>
        ${note
          ? `<div class="sticker-note">${esc(note)}</div>`
          : '<div class="sticker-note empty">（还没写备注 —— 机器人只能看图和 QQ 备注来猜）</div>'}
        ${s.desc && s.desc !== note ? `<div class="sticker-sub">QQ 备注：${esc(s.desc)}</div>` : ''}
        ${s.usage ? `<div class="sticker-sub">什么时候用：${esc(s.usage)}</div>` : ''}
        ${tags ? `<div class="sticker-tags">${tags}</div>` : ''}
        ${s.lastUsedAt ? `<div class="sticker-sub">最后使用 ${fmtTime(s.lastUsedAt)}</div>` : ''}
        <div class="sticker-id">${esc(s.id)}</div>
        <div class="sticker-edit-row">
          <button class="btn btn-small sticker-edit" data-id="${esc(s.id)}">编辑备注 / 标签</button>
          ${s.source !== 'qq'
            ? `<button class="btn btn-small btn-danger sticker-del" data-id="${esc(s.id)}" title="从本地表情库删掉这一条（QQ 收藏的表情要回 QQ 里取消收藏）">删除</button>`
            : ''}
        </div>
      </div>
    </div>`;
}

/**
 * 表情包页「每小时收藏上限」输入框：改完 POST 一小块配置，然后重新 GET 一份配置。
 *
 * 只 POST `{ sticker: { maxCollectPerHour } }` 这一个字段，**绝不把整份配置回传**：
 * GET /api/config 是脱敏过的（所有 Key 都被清空），拿它整体回传会把真实 Key 抹掉。
 * 服务端 updateConfig 是浅合并，传一小块正好。
 */
function bindStickerCollectCap() {
  const input = $('#sticker-collect-cap');
  if (!input) return;
  const tip = $('#sticker-cap-tip');
  const say = (text, color) => {
    if (!tip) return;
    tip.textContent = text;
    tip.style.color = color || '';
  };
  input.addEventListener('change', async () => {
    const n = Math.max(1, Math.min(500, Math.floor(Number(input.value)) || 1));
    input.value = n;
    input.disabled = true;
    say('保存中…');
    try {
      // ⚠️ body 必须自己 JSON.stringify —— api() 不会替你序列化，
      // 传裸对象的话 fetch 会把它变成字符串 "[object Object]"，后端报 is not valid JSON。
      await api('/api/config', { method: 'POST', body: JSON.stringify({ sticker: { maxCollectPerHour: n } }) });
      // 重新拉一份（脱敏的）配置当本地真相，别用 POST 返回的那份带 Key 的
      state.config = await api('/api/config');
      say(`已保存：一小时最多收 ${n} 条`, 'var(--green)');
    } catch (e) {
      say(`保存失败：${e.message}`, 'var(--orange)');
    }
    input.disabled = false;
  });
}

function renderStickerPage() {
  const page = $('#stickers-page');
  if (!page) return;
  const data = state.stickers || {};
  const all = data.stickers || [];

  const syncedTxt = data.syncedAt ? fmtTime(data.syncedAt) : '本次读出';
  const disabled = data.disabled
    ? '<span style="color:var(--orange)">表情包功能已在「设置 → 表情包」里关闭</span>'
    : '';
  // 每小时收藏上限（改的是配置里的 sticker.maxCollectPerHour，见 src/sticker-manager.js 的 collect）
  const collectCap = Math.max(1, Math.floor(Number(state.config?.sticker?.maxCollectPerHour)) || 60);
  const chips = [
    ['all', '全部'],
    ['note', '有备注的'],
    ['nonote', '没备注的'],
    ['used', '用过的'],
    ['unused', '没用过的'],
    ['ai', 'AI 收藏的']
  ].map(([k, label]) => `<span class="chip ${state.stickerFilter === k ? 'on' : ''}" data-sf="${k}">${label}</span>`).join('');

  // 一次性把全部卡片渲染出来，筛选只切 .hidden —— 不重建 DOM。
  // 重建的代价是浏览器会把 QQ CDN 上的图全部重新请求一遍（边打字边闪图），
  // 而且隐藏的卡片带 loading="lazy"，display:none 时根本不会去下载。
  page.innerHTML = `
    <div class="sticker-toolbar">
      <input type="search" id="sticker-search" placeholder="搜备注 / 标签 / 用途 / id…" value="${esc(state.stickerQuery)}" />
      <button class="btn btn-small" id="sticker-refresh-btn">刷新</button>
      <button class="btn btn-small" id="sticker-sync-btn" title="调 OneBot 重新拉一次 QQ 收藏表情（新收藏的表情要同步才会出现）">从 QQ 同步</button>
      <span id="sticker-sync-tip" class="muted" style="font-size:12px">${disabled}</span>
    </div>
    <div class="sticker-toolbar">
      <label class="sticker-cap" title="一小时最多让机器人新增几条收藏（改备注不算）。默认 60 —— 一条合并转发常带 30 张表情包，太小就收不完。">
        每小时收藏上限
        <input type="number" id="sticker-collect-cap" min="1" max="500" step="1" value="${esc(collectCap)}" />
      </label>
      <span id="sticker-cap-tip" class="muted" style="font-size:12px">改完立刻生效，不用重启</span>
    </div>
    <div class="sticker-toolbar" id="sticker-chips">${chips}</div>
    <div class="sticker-count">
      共 <b>${all.length}</b> 个表情，显示 <b id="sticker-shown">${all.length}</b> 个 ·
      库文件 <code>data/stickers.json</code> · 上次同步 ${esc(syncedTxt)} ·
      有备注 ${all.filter((s) => String(s.localNote || '').trim()).length} 个
      ${data.fromCache ? '（本次用缓存）' : '（本次已同步）'}
      ${data.syncError ? `<br><span style="color:var(--orange)">同步失败：${esc(data.syncError)}</span>` : ''}
    </div>
    ${all.length
      ? `<div class="sticker-grid" id="sticker-grid">${all.map(stickerCardHtml).join('')}</div>
         <div class="empty-hint" id="sticker-noresult" style="display:none">没有符合条件的表情。</div>`
      : '<div class="empty-hint">还没有任何表情。点「从 QQ 同步」把 QQ 收藏的表情拉过来。</div>'}`;

  $('#sticker-search')?.addEventListener('input', (e) => {
    state.stickerQuery = e.target.value;
    applyStickerFilter();
  });
  $$('#sticker-chips .chip').forEach((c) => c.addEventListener('click', () => {
    state.stickerFilter = c.dataset.sf;
    $$('#sticker-chips .chip').forEach((x) => x.classList.toggle('on', x === c));
    applyStickerFilter();
  }));
  $('#sticker-refresh-btn')?.addEventListener('click', () => loadStickerPage({ quiet: true }));
  bindStickerCollectCap();
  $('#sticker-sync-btn')?.addEventListener('click', async () => {
    const btn = $('#sticker-sync-btn');
    if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
    await loadStickerPage({ force: true, quiet: true });
    const b2 = $('#sticker-sync-btn');
    if (b2) { b2.disabled = false; b2.textContent = '从 QQ 同步'; }
  });
  bindStickerEditButtons();
  applyStickerFilter();
}

/**
 * 按当前搜索词 + 筛选档切换卡片的显示，并刷新"显示 N 个"。
 *
 * 筛选条件本身只由纯函数 stickerFiltered() 决定（唯一真相），这里只负责
 * 把结果映射成 .hidden —— 故意不重建 DOM：重建会让浏览器把 QQ CDN 上的图
 * 全部重新请求一遍（边打字边闪图），而隐藏卡片带 loading="lazy"，
 * display:none 时根本不会去下载。
 */
function applyStickerFilter() {
  const grid = $('#sticker-grid');
  if (!grid) return;
  const shownIds = new Set(stickerFiltered().map((s) => s.id));
  let shown = 0;
  for (const el of grid.children) {
    const on = shownIds.has(el.dataset.id);
    el.classList.toggle('hidden', !on);
    if (on) shown += 1;
  }
  const shownEl = $('#sticker-shown');
  if (shownEl) shownEl.textContent = String(shown);
  const nr = $('#sticker-noresult');
  if (nr) nr.style.display = shown === 0 ? '' : 'none';
}

function bindStickerEditButtons() {
  $$('.sticker-edit').forEach((el) => {
    if (el.__bound) return;
    el.__bound = true;
    el.addEventListener('click', () => openStickerEditModal(el.dataset.id));
  });
  // 删除按钮只渲染在非 QQ 收藏的卡片上（QQ 收藏要回 QQ 里取消，见后端 removeSticker）
  $$('.sticker-del').forEach((el) => {
    if (el.__bound) return;
    el.__bound = true;
    el.addEventListener('click', () => deleteSticker(el.dataset.id));
  });
}

/** 编辑一个表情的备注/标签/用途。保存后只改本地这条 + 重渲染，不再整页重拉。 */
function openStickerEditModal(id) {
  const s = ((state.stickers && state.stickers.stickers) || []).find((x) => x.id === id);
  if (!s) return;
  const overlay = modelModalShell({
    head: `编辑表情：${s.desc || s.localNote || s.id}`,
    body: `
      ${s.url ? `<div class="sticker-preview"><img src="/api/stickers/${encodeURIComponent(s.id)}/image" alt="" referrerpolicy="no-referrer" onerror="this.onerror=null;this.parentNode.classList.add('failed')" /></div>` : ''}
      <div class="field"><label>机器人自己的备注（它会照这句判断什么时候用）</label>
        <textarea id="st-note" style="min-height:90px" placeholder="例如：笨蛋女仆馋到流口水，别人发来看鲸鱼犯傻">${esc(s.localNote || '')}</textarea></div>
      <div class="field"><label>标签（逗号或空格分隔，最多 20 个）</label>
        <input type="text" id="st-tags" value="${esc((s.tags || []).join(', '))}" placeholder="吃, 馋, 自黑" /></div>
      <div class="field"><label>什么时候用（可选）</label>
        <input type="text" id="st-usage" value="${esc(s.usage || '')}" placeholder="别人喊馋 / 喊饿的时候回一张" /></div>
      <div class="hint">这里改的是<b>机器人自己的认知</b>；「QQ 备注」是你在 QQ 里写的，改不了。</div>
      <details class="hint-more">
        <summary>说明：这些值写在哪、图片从哪来</summary>
        <div class="hint-more-body">
          写进 <code>data/stickers.json</code> 的 <code>localNote</code> / <code>tags</code> / <code>usage</code>。
          当前 QQ 备注：<code>${esc(s.desc || '无')}</code>；图片地址来自 QQ。
        </div>
      </details>`,
    foot: `<button class="btn" id="st-cancel">取消</button>
           <button class="btn btn-primary" id="st-save">保存</button>`
  });
  overlay.querySelector('#st-cancel').addEventListener('click', () => closeModelModal(overlay));
  overlay.querySelector('#st-save').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    const oldText = btn.textContent;
    btn.textContent = '保存中…';
    try {
      const r = await api(`/api/stickers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          note: $('#st-note')?.value ?? '',
          tags: $('#st-tags')?.value ?? '',
          usage: $('#st-usage')?.value ?? ''
        })
      });
      // 用后端返回的规范化结果覆盖本地那条（trim / 截断 / 去空标签都以服务端为准）
      if (r && r.sticker && state.stickers) {
        const i = state.stickers.stickers.findIndex((x) => x.id === id);
        if (i >= 0) state.stickers.stickers[i] = r.sticker;
      }
      closeModelModal(overlay);
      renderStickerPage();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = oldText;
      alert(`保存失败：${err.message}`);
    }
  });
}

/**
 * 删除一个"机器人自己收藏的"表情（QQ 收藏的卡片上不渲染删除按钮）。
 * 后端也会再拦一道：QQ 收藏是同步来的源，删了下次 sync 又回来。
 */
function deleteSticker(id) {
  const s = ((state.stickers && state.stickers.stickers) || []).find((x) => x.id === id);
  if (!s) return;
  const label = String(s.localNote || s.desc || id);
  confirmDanger({
    head: '删除表情',
    okText: '删除',
    text: `<b>${esc(label.slice(0, 120))}</b><br><br>
      这是机器人自己收藏的表情，会从本地表情库 <code>data/stickers.json</code> 里删掉。<br>
      删掉后它不再出现在提示词的【可用表情包】里，<code>send_sticker</code> 也用不了它了。<br><br>
      被删的条目会在 <code>data/stickers-removed.json</code> 留一份记录（备注/标签都在），需要时能捞回来。<br>
      <b>QQ 收藏的表情没有这个按钮</b> —— 那种要回 QQ 里取消收藏，同步一次它就没了。`,
    onOk: async () => {
      await api(`/api/stickers/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
      // 本地同步删掉，省一次全量重拉（图片不会重新加载）
      if (state.stickers) {
        state.stickers.stickers = (state.stickers.stickers || []).filter((x) => x.id !== id);
      }
      renderStickerPage();
    }
  });
}

function renderSettingsSidebar() {
  const s = state.status;
  const sidebar = $('#settings-sidebar');
  if (!sidebar) return;
  const menu = [
    ['api', '模型 API'],
    ['search', '搜索服务'],
    ['memory', '记忆'],
    ['persona', '人设'],
    ['allow', '聊天白名单'],
    ['wechat', '微信联系人'],
    ['chat', '聊天设置'],
    ['security', '安全与浏览'],
    ['desktop', '桌面端'],
    ['onebot', 'OneBot（SnowLuma）']
  ];
  sidebar.innerHTML = `
    <div class="settings-runstate">
      <div class="rs-title">机器人运行状态</div>
      <div class="rs-row"><span class="dot ${s?.onebot?.connected ? 'dot-on' : 'dot-off'}"></span><span>${s?.onebot?.connected ? '运行中' : '未就绪'}</span></div>
      <div class="rs-row muted">${state.paused ? '⏸ 已暂停' : (s?.orchestrator?.model ? `模型：${s.orchestrator.model}` : '模型：未设置')}</div>
    </div>
    <div class="settings-menu">
      ${menu.map(([id, label]) => `<button class="settings-menu-item ${state.settingsSection === id ? 'active' : ''}" data-section="${id}">${label}${id === 'desktop' && updateAvailable ? '<span class="update-dot" title="发现新版本"></span>' : ''}</button>`).join('')}
      <button class="settings-menu-item egg-hot" id="qrcode-egg-btn">！？群群？！</button>
    </div>`;
  // 群二维码彩蛋：点一下弹出，再点屏幕任意位置关闭
  sidebar.querySelector('#qrcode-egg-btn')?.addEventListener('click', () => {
    const ov = document.createElement('div');
    ov.className = 'qrcode-egg-overlay';
    ov.innerHTML = '<img src="group-qrcode.jpg" alt="群二维码" />';
    ov.addEventListener('click', () => ov.remove());
    document.body.appendChild(ov);
  });
  sidebar.querySelectorAll('.settings-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.settingsSection = el.dataset.section;
      renderSettingsSidebar();
      renderSettings();
    });
  });
}

function renderSettings() {
  const c = state.config;
  const box = $('#settings-form');
  renderSettingsSidebar();
  box.innerHTML = `
    ${renderSettingsSection(c)}`;
  bindSettingsEvents(c);
  // 白名单芯片的增删接线（事件委托，只绑一次）—— 条目 6。
  // ⚠️ 必须在 innerHTML **之后**调：事件委托要挂到 **#settings-form**（真实容器）上，
  //    元素得先在 DOM 里。别写 #settings-page —— 那个 id 不存在（踩过，见 bindAllowChips）。
  bindAllowChips();
  // ⚠️ 必须在 innerHTML **之后**再读状态 —— loadProactiveStatus 是去查 DOM 元素再填内容的，
  //    放在 renderSettingsSection 里面（模板字符串求值阶段）时元素还没进 DOM，
  //    于是它查不到 #proactive-status、静默什么都不做（界面上就永远停在"正在读当前状态…"）。
  //    第一版就是这么写错的。
  if ((state.settingsSection || 'api') === 'chat') loadProactiveStatus();
  // 微信联系人同理：必须在 innerHTML 之后再去拉，拉到后再填进 #wx-contact-list。
  // （第一版想直接在模板里同步渲染，但那是异步数据 —— 会永远停在"正在读取…"）
  if ((state.settingsSection || 'api') === 'wechat') loadWechatContacts();
}
