'use strict';
// 第 19/19 段：18-core-memory（2026-10-03 第三十五对话；加载顺序见 ui/index.html）
//
// 「核心记忆」页 —— 她自己挑的那几段聊天**原文**（存 `data/core-memories.json`，独立于会话存档）。
//
// ── 它从哪儿来 ──────────────────────────────────────────────────────────
//   原来是**印象页底部的一个折叠块**（2026-09-26 第二十五对话加的）。用户 2026-10-03 拍板：
//   「核心记忆系统，和印象系统一样**单开一页**」⇒ 那四块（拉取 / 渲染 / 看 / 删）整体搬到这里。
//   ⛔ 印象页里**不许**再留一份（两处各自拉一次 `/api/core-memories` 就是两个真相）。
//
// ── 这一页的边界（从原处照搬，别改）─────────────────────────────────────
//   **只读 + 删**：存是她自己的工具（`save_core_memory`）干的。
//   管理端**不提供"替她挑一段存进去"的入口** —— 那正是她提案里明确不要的
//   （原话："由我自己选择存哪一段，不用别人替我挑"）。
//
// ── 三个控件（2026-10-03 用户拍板；第三个是第三十六对话加的）──────────────
//   · 「每轮注入」开关 → `config.coreMemory.inject`
//   · 「字数上限」→ `config.coreMemory.injectMaxChars`（**0 = 不设限**）
//   · 🆕 「跨会话按人召回」→ `config.coreMemory.crossChat`（交接 §3-57，默认开）
//   三者都**立刻存**（与微信联系人页那种"勾一下就存"同一写法）。
//   🔴 存完**必须重新拉一次**：顶部那句"本次注入约 N 字"是**后端现算的**
//      （`/api/core-memories` 的 `inject` 字段，与提示词共用 `coreMemoryPromptBlocks()`）——
//      不重拉就会显示旧数，那正是"仪表在骗人"。
//
// ── 为什么顶部要显示注入字数（用户选了"不设限"，这是个看得见的护栏）─────────
//   不设限 ⇒ 相册装满后每轮提示词会**悄悄变长**。这里如实显示"现在会注入多少字"，
//   超过 20000 字给一条黄字提示 ⇒ 涨上去了他自己能看见，而不是等账单来告诉他。

/** 按**归属**分组 —— 用的是后端给的 `sourceLabel`（与注入提示词里那份**逐字同源**）。 */
function groupCoreMemories(items) {
  const groups = new Map();
  for (const x of (Array.isArray(items) ? items : [])) {
    const label = String(x?.sourceLabel || x?.chatKey || '（未知来源）');
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(x);
  }
  return groups;
}

/** 顶部：注入开关 + 跨会话开关 + 字数上限 + 现在会注入多少字。 */
function coreMemoryInjectHtml(inj, itemCount) {
  const i = inj || {};
  const on = i.enabled !== false;
  const cross = i.crossChat !== false;
  const cap = Math.max(0, Math.floor(Number(i.maxChars) || 0));
  const dirChars = Math.max(0, Number(i.directoryChars) || 0);
  // 🔴 2026-10-03（第三十六对话）修：这个数原来叫 `relatedAllChars`，而它**永远是 0**
  //    （后端不带 chatKey 调那个函数 ⇒ 恒回空表）。见 app.js 那一段注释。
  const allChars = Math.max(0, Number(i.allOriginalsChars) || 0);
  const total = dirChars + allChars;

  const nowLine = !itemCount
    ? '相册还是空的 —— 存了第一段之后，这里会显示每轮大概注入多少字。'
    : (on
      ? `现在每轮注入：目录 <b>${dirChars}</b> 字（每轮都在）；原文**最多**再 <b>${allChars}</b> 字`
        + `（相册全部原文的合计 = 上限；实际只注入当前这个会话那几段`
        + (cross ? '，**加上**别的会话里和在场的人有关的那几段' : '，跨会话召回已关') + '）。'
        + (cap > 0 ? ` 已设上限 ${cap} 字：超了**先保目录 → 再保当前会话原文**，装不下的逐组丢掉并写明丢了几段。` : ' 上限 0 = 不设限。')
      : '⏸ 已关闭：**一个字都不注入**（她那四个工具照旧能用，只是她看不到相册里有什么）。');

  // 🔴 看得见的护栏：不设限时涨到两万字以上就明说（⛔ 不截断他的话，只让他看见）
  const warn = (on && cap === 0 && total > 20000)
    ? `<div class="hint" style="color:var(--color-text-warning)">⚠️ 相册的注入量已经不小（约 ${total} 字）——`
      + ' 想压一压就在下面填一个上限（超了会先保目录、并如实写明丢了几段）。</div>'
    : '';

  // 🔴 下面那一行**故意不用 `.field`**：`.field label { display:block }`（特异性 0,1,1）
  //    会压掉 `.toggle { display:inline-flex }`（0,1,0）⇒ 开关的 label 变成 block，
  //    而里面的 `.tg-track` 又**自己没有** display（它一直靠"`.toggle` 是 flex ⇒ 子元素被
  //    块级化"才成立的）⇒ 轨道塌成 1px、滑块压在文字上。
  //    ⚠️ 2026-10-03 真机**截图**当场抓到过一次：探针只问"元素在不在"、纯 HTML 字符串判据
  //       只看文本，**两种都看不出来**（量计算样式才看得见）。
  //    ⚠️ 解释写在**这里**而不是模板里的 HTML 注释：HTML 注释会进 DOM（`innerHTML` 里能看到），
  //       而它里面的 `⚠️` 会把"没超阈值就不报警"那条判据喂成假红（当场踩到过）。
  //    ⚠️ 这段注释里**不许出现反引号**（本项目模板字符串里踩过：反引号把字符串当场截断，
  //       而门禁 seal 只算哈希不查语法 ⇒ 门禁照样"通过"，只有 node --check 会红）。
  //    另外那个 label for=cm-maxchars 不靠 .field 也有样式（本来就自己写了 class 与字号）。
  return `
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:10px 0 4px">
      <label class="toggle" title="开：每轮唤醒都把「核心记忆」的目录注入提示词（当前会话的原文另附在后面）；关：一个字都不注入，她那四个工具照旧能用">
        <input type="checkbox" id="cm-inject" ${on ? 'checked' : ''}>
        <span class="tg-track"><span class="tg-knob"></span></span>
        <span class="tg-text">每轮注入</span>
      </label>
      <label class="toggle" title="开：除了当前会话的原文，还注入**别的会话里和这一轮在场的人有关**的那几段（单开一块，自带「别主动拿到这里提」的引导）；关：只注入当前会话那几段">
        <input type="checkbox" id="cm-crosschat" ${cross ? 'checked' : ''}>
        <span class="tg-track"><span class="tg-knob"></span></span>
        <span class="tg-text">跨会话按人召回</span>
      </label>
      <label for="cm-maxchars" class="muted" style="font-size:12px">字数上限</label>
      <input type="number" id="cm-maxchars" min="0" step="100" value="${esc(cap)}"
             style="width:110px" title="0 = 不设限。填正数时超了**先保目录**（目录是索引），再保当前会话原文，装不下的逐组丢掉并写明丢了几段">
      <span class="muted" style="font-size:12px">0 = 不设限</span>
    </div>
    <div class="hint" style="margin-top:2px">${nowLine}</div>
    ${warn}`;
}

/** 一段一行；点「看」就地展开逐字原文（原文用 textContent 填 ⇒ 不会被当成 HTML）。 */
function coreMemoryRowsHtml(items) {
  const groups = groupCoreMemories(items);
  const out = [];
  for (const [label, list] of groups) {
    out.push(`<div class="list-head">${esc(label)}<span class="muted"> · ${list.length} 段</span></div>`);
    for (const x of list) {
      out.push(`
      <div class="chat-item mm-core-row" data-id="${esc(x.id)}">
        <div class="chat-item-title"><span class="session-chat">${esc(x.name || x.id)}</span></div>
        <div class="chat-item-sub">${x.count} 条 · ${fmtTime(x.at)}</div>
        ${x.note ? `<div class="chat-item-sub">${esc(x.note)}</div>` : ''}
        <div class="session-meta">
          <span>${esc(String(x.head || '').slice(0, 40))}</span>
          <span style="margin-left:auto">
            <button class="btn btn-small mm-core-read">看</button>
            <button class="btn btn-small btn-danger mm-core-del">删除</button>
          </span>
        </div>
        <pre class="mm-core-body" hidden style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0;max-height:420px;overflow:auto"></pre>
      </div>`);
    }
  }
  return out.join('');
}

function coreMemoryPageHtml(data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  const warn = data?.loadError
    ? `<div class="hint" style="color:var(--color-text-warning)">核心记忆文件有问题：${esc(data.loadError)}</div>`
    : '';
  const body = items.length
    ? coreMemoryRowsHtml(items)
    : '<div class="empty-hint">她还没存过核心记忆。她看到舍不得删的一段，会自己用 save_core_memory 留下来。</div>';
  return `
    <div class="pagehead">
      <h3>核心记忆</h3>
      <span class="muted" style="font-size:12px">她自己挑的原文 · 删掉聊天存档也还在</span>
      <span class="ph-spacer"></span>
      <button class="btn btn-small" id="cm-refresh" title="重新拉一次（也会重算上面的注入字数）">刷新</button>
    </div>
    ${coreMemoryInjectHtml(data?.inject, items.length)}
    ${warn}
    <div style="margin-top:12px">${body}</div>`;
}

/** 拉一次并整页重绘。切到这一页、点刷新、存完开关、删完一段都走它。 */
async function loadCoreMemoryPage() {
  const page = $('#core-memory-page');
  if (!page) return;
  let data;
  try {
    data = await api('/api/core-memories');
  } catch (error) {
    page.innerHTML = `<div class="empty-hint">读不到核心记忆：${esc(error?.message || error)}</div>`;
    return;
  }
  page.innerHTML = coreMemoryPageHtml(data);
  bindCoreMemoryPage(page);
}

/** 存一个 `config.coreMemory` 的小补丁；**存完重拉**（顶部字数必须跟着变）。 */
async function saveCoreMemoryConfig(patch, el, revert) {
  if (el) el.disabled = true;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify({ coreMemory: patch }) });
  } catch (error) {
    alert(`没存上：${error?.message || error}`);
    if (typeof revert === 'function') revert();      // 存不上就把界面回滚，别让它显示成"已经关了"
  } finally {
    if (el) el.disabled = false;
  }
  await loadCoreMemoryPage();
}

function bindCoreMemoryPage(page) {
  $('#cm-refresh', page)?.addEventListener('click', () => { void loadCoreMemoryPage(); });

  const injectBox = $('#cm-inject', page);
  if (injectBox) {
    injectBox.addEventListener('change', () => {
      const next = injectBox.checked;
      void saveCoreMemoryConfig({ inject: next }, injectBox, () => { injectBox.checked = !next; });
    });
  }
  // 🆕 2026-10-03（第三十六对话 · 交接 §3-57）：跨会话按人召回。
  //    ⚠️ 与「每轮注入」同一个写法（勾一下就存 + 存完重拉）—— ⛔ 别另立一套。
  const crossBox = $('#cm-crosschat', page);
  if (crossBox) {
    crossBox.addEventListener('change', () => {
      const next = crossBox.checked;
      void saveCoreMemoryConfig({ crossChat: next }, crossBox, () => { crossBox.checked = !next; });
    });
  }
  const capInput = $('#cm-maxchars', page);
  if (capInput) {
    // 用 change（失焦/回车才提交）而不是 input：`input` 会在每敲一个数字就写一次配置。
    capInput.addEventListener('change', () => {
      const n = Math.max(0, Math.floor(Number(capInput.value) || 0));
      capInput.value = String(n);
      void saveCoreMemoryConfig({ injectMaxChars: n }, capInput, null);
    });
  }

  $$('.mm-core-read', page).forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); void toggleCoreMemory(btn); });
  });
  $$('.mm-core-del', page).forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = btn.closest('.mm-core-row')?.dataset.id;
      if (!id) return;
      if (!confirm('删掉这一段核心记忆？删了就真没了（这是她自己攒下来的）。')) return;
      try {
        await api('/api/core-memories/delete', { method: 'POST', body: JSON.stringify({ id }) });
        await loadCoreMemoryPage();
      } catch (error) {
        alert(`删除失败：${error?.message || error}`);
      }
    });
  });
}

/** 就地把某一段的逐字原文展开/收起（正文按需拉，别一次传几百 KB）。 */
async function toggleCoreMemory(btn) {
  const row = btn.closest('.mm-core-row');
  const body = row?.querySelector('.mm-core-body');
  const id = row?.dataset.id;
  if (!body || !id) return;
  if (!body.hidden) { body.hidden = true; btn.textContent = '看'; return }
  if (!body.dataset.loaded) {
    btn.disabled = true;
    try {
      const r = await api(`/api/core-memories?id=${encodeURIComponent(id)}`);
      // 逐字还原当时存下来的文本（textContent ⇒ 不会被当成 HTML）
      body.textContent = (r.item?.messages || [])
        .map((m) => {
          // 号码是"id 为准、名字为辅"里的那个 id；老条目没有它 ⇒ 只显示名字（⛔ 不补假值）
          const who = m.self ? '我' : (String(m.uid || '') ? `${m.who}（${m.uid}）` : String(m.who || ''));
          return `[${fmtTime(m.ts)}] ${who}：${m.text}`;
        }).join('\n') || '（这一段是空的）';
      body.dataset.loaded = '1';
    } catch (error) {
      body.textContent = `读不到：${error?.message || error}`;
    } finally {
      btn.disabled = false;
    }
  }
  body.hidden = false;
  btn.textContent = '收起';
}
