// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
import { createApp } from './app.js';

// ⚠️ 这两个监听器**必须自己退出**（上游 audit-round1 的 L-7）：
//    Node 的规矩是"一旦装了 uncaughtException 监听器，就不再走默认的打印并退出"。
//    所以原来那种"只 console.error 一句"的写法，等于把致命异常降级成一行日志，
//    进程带着已经坏掉的状态继续跑 —— 运行路径上的未处理异常基本都意味着状态
//    已经不可信。更实际的问题是：这种情况下 `app.stop()` 永远不会被执行，
//    SnowLuma 子进程会被留下变孤儿（项目里已经记过"SnowLuma 残留"这个坑）。
//    这里保持"先记录、后退出"，且用退出码 1，让外面的看护脚本知道是异常退出。
//
//    （`src/app.js` 给 Electron 主进程写的注释里明确说过：**刻意不接管**
//      uncaughtException / unhandledRejection，宁可崩掉也不要一个"看起来还活着、
//      实际已经坏掉"的进程。这里与那条原则保持一致。）
process.on('unhandledRejection', (error) => {
  console.error('[未处理异常]', error);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('[未捕获异常]', error);
  process.exit(1);
});

const app = createApp();
app.start().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('退出中…');
  await app.stop();
  process.exit(0);
});
