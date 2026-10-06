'use strict';
// 第 3/18 段：02-boot（拆自 ui/app.js，2026-09-25 第十七对话；加载顺序见 ui/index.html）

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];

function setLoadingStatus(text) {
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`);
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = bootLogs.slice(-12).join('\n');
}

function hideLoading() {
  appReady = true;
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

async function pollUntilReady() {
  const startedAt = Date.now();
  try {
    const status = await api('/api/status');
    if (!status.onebot?.connected) setLoadingStatus('SnowLuma 已就绪，正在连接 OneBot…');
    else setLoadingStatus(`OneBot 已连接${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return true;
  } catch (e) {
    if (Date.now() - startedAt > 45000) {
      setLoadingStatus('启动超时。请确认项目内 snowluma 文件夹完整，或到设置页手动启动 SnowLuma。');
      return false;
    }
    return false;
  }
}

async function bootLoop() {
  for (let i = 0; i < 90; i++) {
    if (await pollUntilReady()) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  hideLoading();
  refreshStatus();
  if (state.tab === 'sessions') loadSessions();
  if (state.tab === 'memory') loadMemoryView();
}


// 「我已保存」的记忆：**按密码的指纹记** —— ⛔ 不按密码本身、也不按时间戳。
//  · 为什么不能按时间戳：`initialPassword.at` 是**进程内的捕获时刻**（`src/app.js:422`），
//    每次重启都会重新捕获、时间就变 ⇒ 记时间戳等于每次重启都再提示一遍（用户明明点过"我已保存"）。
//  · 为什么不再按密码明文（2026-10-06 之前就是这么写的）：这个键**只做相等比较**，
//    没有任何理由把一条凭据明文长期留在 localStorage 里（第四十七对话 · 用户拍板改成指纹）。
//  · 为什么用同步哈希、不用 `crypto.subtle.digest`：后者返回 Promise，而两个调用点
//    （`renderBanner` 的同步判断、点击回调）都在同步路径上 —— 为一个"只做相等比较"的键
//    把开机渲染改成异步不值当。FNV-1a/64 够用：初始密码是 `randomBytes(8)` 的 16 位十六进制
//    （≈64 位熵），拿 64 位指纹反查要 2^64 次；这里要的只是"别留明文"。
//  ⚠️ `v1-` 前缀是有意的：老版本存进去的**明文**永远不会与指纹相等 ⇒ 升级后已确认过的用户
//     会**再看到一次**提示条（多提示一次是安全方向；⛔ 别为了省这一次去掉前缀）。
//     同时它给以后的算法变更留了版本位（换算法时改前缀，不与人比对旧格式）。
const CRED_ACK_KEY = 'qqagent.credAckd';
function credFingerprint(value) {
  const s = String(value);
  let h = 0xcbf29ce484222325n;                 // FNV-1a 64 位：偏移基准
  const prime = 0x100000001b3n;                //             质数
  for (let i = 0; i < s.length; i += 1) {
    h = BigInt.asUintN(64, (h ^ BigInt(s.charCodeAt(i))) * prime);
  }
  return 'v1-' + h.toString(16).padStart(16, '0');
}
/**
 * 读出"已确认过的密码指纹"表。**任何异常都当成空表**，⛔ 不抛。
 * ⚠️ 为什么把它单独拎出来：`setCredAckd` 也必须走这条读法 —— 否则存量 JSON 坏了时
 *    `JSON.parse` 抛错、被 catch 吞掉，于是**永远写不进新的**（表现是"我已保存"点了没反应、
 *    提示条永远点不掉，而且完全静默）。第一版就是这样，是配套判据逼出来的（第四十七对话）。
 */
function credAcks() {
  try {
    const seen = JSON.parse(localStorage.getItem(CRED_ACK_KEY) || '[]');
    return Array.isArray(seen) ? seen : [];
  } catch { return []; }
}
function credAckd(value) {
  return credAcks().includes(credFingerprint(value));
}
function setCredAckd(value) {
  try {
    const next = credAcks();
    const fp = credFingerprint(value);
    if (!next.includes(fp)) next.push(fp);
    localStorage.setItem(CRED_ACK_KEY, JSON.stringify(next.slice(-10)));
  } catch { /* 存不了就下次再提示，不影响使用 */ }
}

function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  // 首次安装的 WebUI 初始密码 —— 优先级最高，且**不随"暂停/未连接"被挤掉**。
  // 为什么它最重要：这串密码只打印一次、关闭后无法找回；拿不到它，用户就进不去 WebUI，
  // 也就走不完「登录 → 注入 QQ 进程」这套流程，整个应用对他就是废的。
  const cred = s?.snowluma?.initialPassword;
  if (cred?.value && !credAckd(cred.value)) {
    show = true;
    html = `<div class="cred-banner">
      <div style="margin-bottom:4px">🔑 <b>SnowLuma 首次登录密码</b>（只出现这一次，关闭后无法找回）：</div>
      <div class="cred-value"><code id="cred-pw">${esc(cred.value)}</code>
        <button class="btn btn-small" id="cred-copy-btn">复制</button>
        <button class="btn btn-small" id="cred-ack-btn" title="确认已保存，不再显示这条提示">我已保存</button>
        <span class="muted" id="cred-hint" style="font-size:12px"></span></div>
      <div class="muted" style="font-size:12px;margin-top:4px">
        接下来：用它在 <b>SnowLuma → WebUI</b> 登录，电脑上的 <b>QQ 先登录好</b>，
        再到 WebUI 的「<b>进程</b>」页选中那个 QQ 进程点「<b>注入</b>」。
      </div>
    </div>`;
    banner.classList.remove('hidden');
    banner.innerHTML = html;
    const hint = $('#cred-hint');
    const copyBtn = $('#cred-copy-btn');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      const pw = cred.value;
      try {
        await navigator.clipboard.writeText(pw);
        if (hint) hint.textContent = '已复制到剪贴板';
      } catch {
        // 剪贴板被拒时不要让用户以为复制成功了 —— 直接把文本选中，让他自己按 Ctrl+C
        const el = $('#cred-pw');
        if (el) {
          const r = document.createRange();
          r.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges(); sel.addRange(r);
          if (hint) hint.textContent = '已选中，请按 Ctrl+C 复制';
        }
      }
    });
    const ackBtn = $('#cred-ack-btn');
    if (ackBtn) ackBtn.addEventListener('click', () => { setCredAckd(cred.value); renderBanner(); });
    return;
  }
  // 预算保险丝已移除：原先这里有一个 pauseReason === 'budget' 的分支
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    html = '🔌 OneBot（SnowLuma）还没连上：请到「SnowLuma」页签，按顺序做三步 —— 启动网关 → 用访问密码登录 WebUI → 在「进程」页注入已登录的 QQ。';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn">恢复并全部标为已读</button>`;
    }
    banner.innerHTML = html;
    const link = $('#banner-goto-settings');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); switchTab('settings'); });
    const resumeBtn = $('#banner-resume-btn');
    if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
    const resumeReadBtn = $('#banner-resume-read-btn');
    if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    console.error('恢复失败:', e);
  }
}
