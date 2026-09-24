// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

const state = {
  tab: 'sessions',
  // 当前看哪个平台（'qq' | 'wechat'）。初始化时以后端 config.ui.mode 为准。
  // ⚠️ 只影响显示 —— 两个平台的后端都照常跑（见 applyPlatformMode 那段说明）。
  platformMode: 'qq',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  // 阶段 C2：侧栏本地过滤（搜索关键词 + 状态档位）。纯前端状态，不落盘、不发给后端。
  // status: 'all' | 'active' | 'ended' | 'noreply'（口径见 matchSessionFilter）
  sessionFilter: { query: '', status: 'all' },
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  // 系统提示：{ fullOverride, segments:[{key,label,default,override}], effective }
  // 由 loadSettings 从 /api/system-prompt 拉取；null = 没拉到（保存时不动逐段覆盖）
  systemPrompt: null,
  // 表情包页：{ stickers:[...], syncedAt, fromCache, syncError } + 搜索/筛选状态
  // （搜索词存 state 而不是只存 DOM，重渲染后不会把用户正在敲的字吞掉）
  stickers: null,
  stickerQuery: '',
  stickerFilter: 'all',
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}   // chatKey -> { note, at, failed? }
};

// 记忆页的「显示空记忆」是纯界面偏好，存 localStorage（不进配置，省得每次保存设置都带上它）
try { state.showEmptyMemory = localStorage.getItem('dsh-mem-show-empty') === '1'; } catch { state.showEmptyMemory = false; }
