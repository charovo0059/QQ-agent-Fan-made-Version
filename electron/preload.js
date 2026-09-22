// 无边框窗口：渲染进程与主进程之间的**最小**窗口控制桥（2026-09-22）。
//
// 为什么需要它：渲染进程是 `contextIsolation: true` + `nodeIntegration: false`，
//   拿不到任何 Electron API。自绘标题栏的按钮要能最小化/最大化/关闭窗口，
//   就必须有一条受控通道。
//
// 设计原则（照本项目既有的"最小暴露"习惯）：
//   · 只暴露 4 个动作 + 1 个状态订阅，**不暴露 ipcRenderer 本体** ——
//     一旦把 ipcRenderer 交出去，页面里任何一段脚本都能往任意频道发消息。
//   · 不接受渲染进程传参（没有"给个窗口句柄"这种事），因此不存在越权面。
//   · 关闭动作在主进程里走 `mainWindow.close()`，会经过既有的"缩到托盘"策略
//     （`server.closeToTray`），**不会**把常驻的后台 Agent 杀掉。
//
// 用法（渲染进程）：
//   window.qqaWin?.minimize() / toggleMaximize() / close() / isMaximized()
//   window.qqaWin?.onState(({ maximized }) => { … })
// ⚠️ 在**普通浏览器**里打开控制台时 `window.qqaWin` 是 undefined —— 这不是 bug，
//   是无边框外壳只在 Electron 里存在。调用方必须用可选链，别直接点。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('qqaWin', {
  /** 最小化窗口 */
  minimize: () => ipcRenderer.invoke('win:minimize'),
  /** 最大化 ⇄ 还原（主进程按当前真实状态决定方向，渲染端不必自己判断） */
  toggleMaximize: () => ipcRenderer.invoke('win:toggle-maximize'),
  /** 关闭窗口。⚠️ 主进程会走"缩到托盘"策略，不是退出应用 */
  close: () => ipcRenderer.invoke('win:close'),
  /** 查当前是否最大化（首帧同步图标用） */
  isMaximized: () => ipcRenderer.invoke('win:is-maximized'),
  /**
   * 订阅窗口状态变化。主进程在 maximize / unmaximize / 全屏切换 / resize 时推送，
   * 所以用 Win+↑↓、双击标题栏、任务栏、Aero Snap 改变状态时**图标也会跟着变**
   * （方案 4.4 点名的"只监听按钮点击会导致图标不同步"）。
   * @param {(s: {maximized: boolean}) => void} cb
   * @returns {() => void} 取消订阅
   */
  onState: (cb) => {
    const h = (_e, s) => { try { cb(s || {}) } catch { /* 回调里抛错不该影响主进程 */ } }
    ipcRenderer.on('win:state', h)
    return () => ipcRenderer.removeListener('win:state', h)
  }
})
