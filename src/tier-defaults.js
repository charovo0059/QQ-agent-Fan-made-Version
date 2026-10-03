// 「新加进白名单的会话」默认响应档位（2026-10-03 第三十五对话，用户拍板）。
//
// 起因（用户原话）：
//   「响应档位在关闭全局设置的情况下，由于全局设置存在数值，新添加的白名单私聊好友
//     会被影响，导致其单独响应档位默认为全局响应系数的已有的数值。我希望新增的私聊好友
//     ……默认为全响应，除非我单独设置。新增的群聊响应系数同样也是。」
//
// ── 为什么是"加进白名单时写一条条目"，而不是"读配置时猜一个默认值" ─────────────
//   `storeConfigForChat()` 的兜底**就是**"跟随全局滑条"，而用户拍的是
//   「只对**新加进白名单**的人生效，老的不动」。
//   ⇒ 不能在读的时候改兜底语义 —— 那会把"早就加进白名单、只是没单独设过"的那几个会话
//     （实测 2026-10-03：`private:1000000010` / `private:1000000011`）一起变成全响应，
//     而用户明确说了不动它们。
//   ⇒ 只能**在"加人"那一刻**把默认值写进去：老的天然没有条目 ⇒ 照旧跟随全局；
//     新的有条目 ⇒ 拿默认档。判据里专门钉着"兜底没变"这一条。
//
// ── 两个入口，一套实现 ─────────────────────────────────────────────────
//   私聊进白名单有两条路（写的是**同一份** `allow.private`）：
//     ① 设置页 →「聊天白名单」的芯片输入 → `POST /api/config`
//     ② 设置页 →「微信联系人」勾选放行   → `POST /api/wechat-contacts/allow`
//   两边都在 `src/app.js` 里调本模块。⛔ 别在某一处另写一份（那就是"两个口径各自演化"的开端，
//   而且只在一条路上生效的那种坏法，界面上看不出来 —— 用户 2026-10-03 明确"算"。）
//
// ── 默认值 ─────────────────────────────────────────────────────────────
//   私聊 = 100（滑条顶端 = 4 档全响应；与用户自己那批私聊条目一致，它们都是 100）
//   群聊 = `tierToSlider(1)`（= 5 = 1 档"仅艾特"；用户 2026-10-03 拍板：
//          「群聊也别静默跟随全局，但默认给 1 档」）
//   ⚠️ 群聊那个值**复用 tier-slider.js 的换算**，⛔ 不写死 5 —— 滑条分段哪天改了，
//      这里跟着走，不会与后端权威换算漂开。
//
// 边界：本模块**只算不写盘**（与 `stickers.js` 的纯函数同一取向）：调用方把返回的 patch
//      交给 `updateConfig()`，由它一次性落盘。
import { tierToSlider } from './tier-slider.js';

/**
 * 一类会话的默认滑条位置。
 * @param {'private'|'group'|string} kind 完整 chatKey 的前半段
 * @returns {number} 0~100
 */
export function newChatTierDefault(kind) {
  return String(kind) === 'group' ? tierToSlider(1) : 100;
}

/**
 * 给 patch 里"这次新进白名单"的会话补一条默认档位。
 *
 * @param {object} patch  即将交给 `updateConfig()` 的那一小块（只读，不原地改）
 * @param {object} before 改动前的配置（`getConfig()` 的返回值）
 * @returns {object} 原 patch，或补过 `store.chatSliderPos` 的**新** patch
 */
export function applyNewChatDefaults(patch, before) {
  const nextAllow = patch?.allow;
  if (!nextAllow || typeof nextAllow !== 'object') return patch;

  const beforeAllow = before?.allow || {};
  const added = [];
  for (const [field, kind] of [['groups', 'group'], ['private', 'private']]) {
    // 🔴 「这一次没写这份名单」≠「名单是空的」：设置页在芯片盒不在 DOM 时**故意不写**这个键
    //    （见 `ui/app/15-allow-saveconfig.js` 的 `pickedOrKeep`，那是防"静默清空白名单"的守卫）。
    //    只有**真的给了数组**才算"这次动了这份名单"；否则从"没写"里推出"整份都是新增"，
    //    会一次性把全部白名单会话都写成默认档。
    if (!Array.isArray(nextAllow[field])) continue;
    const prev = new Set((Array.isArray(beforeAllow[field]) ? beforeAllow[field] : []).map(String));
    for (const id of nextAllow[field]) {
      const s = String(id ?? '').trim();
      if (s && !prev.has(s)) added.push(`${kind}:${s}`);
    }
  }
  if (!added.length) return patch;

  // 已经有条目的（改前的配置里有、或这次 patch 自己带）一律**不覆盖** ——
  // 「除非我单独设置」：他之前给这个人设过档位，把这个会话移出白名单再加回来时要保住那个值。
  const known = { ...(before?.store?.chatSliderPos || {}), ...(patch.store?.chatSliderPos || {}) };
  const map = { ...(patch.store?.chatSliderPos || {}) };
  let touched = false;
  for (const key of added) {
    if (known[key] !== undefined && known[key] !== null) continue;
    map[key] = newChatTierDefault(key.split(':')[0]);
    touched = true;
  }
  if (!touched) return patch;
  return { ...patch, store: { ...(patch.store || {}), chatSliderPos: map } };
}
