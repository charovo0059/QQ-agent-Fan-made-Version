// 模型响应速度扫描（speed scan）——「一键统一响应测试」的后端。
//
// ── 为什么需要它（2026-10-16 第四十九对话 · 用户原话）────────────────────────
// 用户的某个供应商「有200多个模型可选，只是我还没给那个api配上」；手动排序的理由是
// 「模型降级的时候那个api链接不稳定，有的模型也会没反应」；「一个一个手填还是太麻烦了」。
// ⇒ 界面上要能"勾一批模型 → 一键全测 → 按实测响应速度给一个建议顺序"。
//
// ── 与 vision-scan.js 的关系 ────────────────────────────────────────────────
// 这个文件是**照着** src/vision-scan.js 的形状写的（同一套：扁平化任务 → 并发池 →
// 内存累积 → 每满 5 条 / 每 2 秒批量落盘 → emit 报进度 → 收尾 flush）。
// 两者的差别只有"探测什么"：vision-scan 发一张 1×1 图片看网关接不接受，
// 本文件发一句最小文本请求、量的是**延迟**（底座是 providers.js 的 testModelChat）。
//
// ── 🔴 硬约束：本模块**只测、只存、只给建议**，绝不改用户的降级链 ──────────────
// 用户拍板（m02270–m02281）："先给建议顺序，我看了再点应用"。
// ⇒ 这里唯一会写盘的键是 config.modelSpeeds（实测结果），
//   而 api.fallbackModels 只在界面按钮被显式点击时才由 UI 写。
import { getConfig, updateConfig } from './config.js';
import { testModelChat } from './providers.js';

/** 读取已保存的测速结果（键 = providerId|||modelId）。 */
export function speedResults() {
  return getConfig().modelSpeeds || {};
}

/** 查询单个模型（providerId|||modelId）的测速记录：{ ok, latencyMs, note, checkedAt } | undefined。 */
export function modelSpeed(providerId, modelId) {
  const key = `${providerId || ''}|||${modelId || ''}`;
  return speedResults()[key];
}

/**
 * 测速目标 → 配置里的键。
 * ⚠️ 约定与 vision-scan 完全一致：`providerId|||modelId`。
 *    **不带 provider 的降级项**（只换模型 id、沿用主模型端点那一种）用**主模型的
 *    提供商 id** 作键 —— 因为它跑的就是主提供商的端点，与 llm.js:buildCandidateApis
 *    里"不写 @ 则沿用主模型 baseUrl/Key"那条规则同源。
 */
export function speedKey(providerId, modelId) {
  return `${providerId || ''}|||${modelId || ''}`;
}

/**
 * 默认测速范围（用户拍板 ④：「可勾选，默认勾上主模型 + 降级链里的」）。
 * 返回 [{ providerId, model, label, fallbackIndex }]，去重、跳过空模型。
 *   · fallbackIndex = 该项在 api.fallbackModels 里的下标（主模型是 -1）
 *     —— UI 用它把"测速结果"映射回降级链的哪一行。
 */
export function speedScanTargets(cfg = getConfig()) {
  const mainProvider = String(cfg?.api?.provider || '').trim();
  const mainModel = String(cfg?.api?.model || '').trim();
  const out = [];
  const seen = new Set();
  /**
   * @param providerId 端点归属（空串 = 主模型端点）
   * @param fallbackIndex 该项在 api.fallbackModels 里的下标；null = 只是"目录里有"、不在链里
   * @param isDefault 是否属于**默认勾选范围**（用户拍板 ④：主模型 + 现有降级链）
   */
  const push = (providerId, model, fallbackIndex, isDefault, label) => {
    const m = String(model || '').trim();
    if (!m) return;
    const pid = String(providerId || '').trim();
    const key = speedKey(pid, m);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ providerId: pid, model: m, key, label, fallbackIndex, isDefault: !!isDefault });
  };
  if (mainModel) {
    push(mainProvider, mainModel, -1, true, `${mainModel}${mainProvider ? ` @ ${mainProvider}` : ''}（主模型）`);
  }
  const fbs = Array.isArray(cfg?.api?.fallbackModels) ? cfg.api.fallbackModels : [];
  fbs.forEach((f, i) => {
    const pid = String(f?.provider || '').trim() || mainProvider;
    const m = String(f?.model || '').trim();
    if (!m) return;
    push(pid, m, i, true, `${m}${f?.provider ? ` @ ${f.provider}` : ''}`);
  });
  // 供应商目录里的**全部**模型：默认**不勾**，但用户能自己扩大范围
  // （他要的就是"我那个 API 下有 200 多个模型，一个个手填太麻烦"）。
  for (const p of (Array.isArray(cfg?.providers) ? cfg.providers : [])) {
    const pid = String(p?.id || '').trim();
    for (const m of (Array.isArray(p?.models) ? p.models : [])) {
      push(pid, m, null, false, `${String(m)} @ ${pid}`);
    }
  }
  return out;
}

/**
 * 按实测延迟算一个**建议顺序**（只针对降级链，主模型不动）。
 *
 * 排序规则（确定性，可解释）：
 *   ① 测过且成功 → 按延迟**升序**排在最前
 *   ② 从没测过   → 保持原相对顺序，排在中间
 *   ③ 测过但失败 → 排最后（无反应的端点不该排在能用的前面）
 * 返回 { order, changed, rows }：
 *   order   = 建议的降级链（形如 [{ model, provider }]，与 api.fallbackModels 同形状）
 *   changed = order 与当前降级链是否**逐项相同**（相同 ⇒ 界面把"应用"按钮置灰）
 *   rows    = 逐项明细，给界面显示"实测 320ms / 未测 / 失败：连接超时"
 */
export function buildSpeedSuggestions(cfg = getConfig()) {
  const mainProvider = String(cfg?.api?.provider || '').trim();
  const fbs = (Array.isArray(cfg?.api?.fallbackModels) ? cfg.api.fallbackModels : [])
    .map((f) => ({ model: String(f?.model || '').trim(), provider: String(f?.provider || '').trim() }))
    .filter((f) => f.model);
  const saved = speedResults();

  const rows = fbs.map((f, i) => {
    const pid = f.provider || mainProvider;
    const rec = saved[speedKey(pid, f.model)];
    const tested = !!rec;
    const ok = tested && rec.ok === true;
    const latencyMs = ok && Number.isFinite(rec.latencyMs) ? rec.latencyMs : null;
    // 排序权重：0 = 测过且成功（按延迟升序）；1 = 从没测过（保持原序）；2 = 测过但失败。
    const rank = ok ? 0 : (tested ? 2 : 1);
    return {
      model: f.model,
      provider: f.provider,
      key: speedKey(pid, f.model),
      tested,
      ok,
      latencyMs,
      note: String(rec?.note ?? ''),
      checkedAt: rec?.checkedAt ?? null,
      index: i,
      rank
    };
  });

  const order = [...rows]
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.rank === 0 && a.latencyMs !== b.latencyMs) return a.latencyMs - b.latencyMs;
      return a.index - b.index;
    })
    .map((r) => (r.provider ? { model: r.model, provider: r.provider } : { model: r.model }));

  const same = order.length === fbs.length && order.every((o, i) =>
    o.model === fbs[i].model && String(o.provider || '') === String(fbs[i].provider || ''));

  // ⚠️ 这里**只算建议**，一步都不写配置。真正改动只发生在 UI 点「应用建议顺序」时
  //    （POST /api/speeds/apply），而那一条路由会**重新算一次**本函数 —— 见 app.js 的注释：
  //    客户端传上来的 order 一律不采信（否则界面/脚本可以拿它当"随便改降级链"的后门）。
  return { order, changed: !same, rows };
}

/**
 * 扫描一批模型（body.targets 可选；不传就用默认范围）。
 * 返回 { total, results }；进度逐条 emit('speed-scan', { key, model, providerId, ok, latencyMs, done, total })。
 */
export async function scanModelSpeeds({ providers, targets = null, emit = null, limit = 3 } = {}) {
  const cfg = getConfig();
  const list = Array.isArray(targets) && targets.length ? targets.map((t) => ({
    providerId: String(t?.providerId ?? '').trim(),
    model: String(t?.model ?? '').trim()
  })).filter((t) => t.model)
    // 不传 targets（理论上只有直接调 API 的人）⇒ 只测**默认范围**：主模型 + 降级链。
    // ⛔ 绝不能退化成"测目录里全部模型" —— 某家供应商有 200+ 个，一按就是几百次请求。
    : speedScanTargets(cfg).filter((t) => t.isDefault).map((t) => ({ providerId: t.providerId, model: t.model }));

  // 扁平化成可直接发请求的任务（缺端点/密钥的提供商跳过 —— 与 vision-scan 同口径）
  const byId = new Map((providers || []).map((p) => [String(p.id), p]));
  const tasks = [];
  for (const t of list) {
    const pid = t.providerId || String(cfg?.api?.provider || '').trim();
    const p = byId.get(pid);
    if (!p || !p.baseURL || !p.apiKey) continue;
    tasks.push({ providerId: pid, model: t.model, baseURL: p.baseURL, apiKey: p.apiKey });
  }
  const total = tasks.length;
  let done = 0;

  // 结果先在内存累积，扫描结束（或每满 5 条 / 每 2 秒）统一写一次盘 —— 与 vision-scan 同因：
  // 每个模型都调一次 updateConfig = 每次 deepMerge + structuredClone 全量配置 + 同步写盘，
  // 勾 20 个就卡主线程（vision-scan 的注释里有实测说明）。
  const pending = new Map();
  const flushPending = () => {
    if (!pending.size) return;
    const patch = {};
    for (const [key, v] of pending) patch[key] = v;
    pending.clear();
    updateConfig({ modelSpeeds: patch });
  };
  const flushTimer = setInterval(flushPending, 2000);

  const runTask = async (task) => {
    const key = speedKey(task.providerId, task.model);
    const r = await testModelChat({ baseUrl: task.baseURL, apiKey: task.apiKey, model: task.model });
    pending.set(key, {
      providerId: task.providerId,
      model: task.model,
      ok: r.ok === true,
      latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      httpStatus: r.httpStatus ?? null,
      note: String(r.note ?? '').slice(0, 200),
      checkedAt: Date.now()
    });
    if (pending.size >= 5) flushPending();
    done += 1;
    emit?.('speed-scan', {
      key,
      providerId: task.providerId,
      model: task.model,
      ok: r.ok === true,
      latencyMs: Number.isFinite(r.latencyMs) ? r.latencyMs : null,
      note: String(r.note ?? '').slice(0, 80),
      done,
      total
    });
  };

  // 简单并发池（与 vision-scan 逐字同款）
  let index = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, tasks.length || 1)) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++];
      await runTask(task).catch((error) => {
        done += 1;
        emit?.('speed-scan', {
          key: speedKey(task.providerId, task.model),
          providerId: task.providerId,
          model: task.model,
          ok: false,
          latencyMs: null,
          note: String(error?.message ?? error).slice(0, 80),
          done,
          total,
          error: String(error?.message ?? error)
        });
      });
    }
  });
  await Promise.all(workers);
  clearInterval(flushTimer);
  flushPending();   // 收尾：剩余结果一次写盘，确保不丢
  return { total, results: speedResults() };
}
