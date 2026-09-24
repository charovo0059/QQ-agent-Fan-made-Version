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


// 「我已保存」的记忆：**按密码值记**，不按时间戳。
// 为什么：如果只记一个时间点，下次安装又生成一个新密码时会被旧的记录吞掉，
// 用户就再也看不到提示了。按值记 = 每个不同的密码各提示一次。
const CRED_ACK_KEY = 'qqagent.credAckd';
function credAckd(value) {
  try {
    const seen = JSON.parse(localStorage.getItem(CRED_ACK_KEY) || '[]');
    return Array.isArray(seen) && seen.includes(String(value));
  } catch { return false; }
}
function setCredAckd(value) {
  try {
    const seen = JSON.parse(localStorage.getItem(CRED_ACK_KEY) || '[]');
    const next = Array.isArray(seen) ? seen : [];
    if (!next.includes(String(value))) next.push(String(value));
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
