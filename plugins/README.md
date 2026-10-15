# plugins/ —— 确定性型插件目录（当前为空）

这个目录和 `skills/` 都由 `src/plugin-loader.js` 在启动时扫描，清单文件写法完全等价
（`plugin.json` / `skill.json` 走同一条 `normalizeManifest`），区别只是**语义**：

| 目录 | 类型 | 什么时候被执行 |
|---|---|---|
| `plugins/` | 确定性型（kind = `plugin`） | 提供**能力**（`providers`）或**钩子**（`hooks`），核心代码按能力名取用，满足条件必然执行，不经过 LLM |
| `skills/` | LLM 型（kind = `skill`） | `registerTool()` 注册工具 + 提供提示词片段，**用不用、什么时候用由模型自己判断** |

⚠️ 想接入模型只有一条路：`registerTool()`。只写 `providers` 的模块放进 `skills/` 对模型
完全隐形（加载器会就此给出明确警告，见 `plugin-loader.js` 的 `lintKindPlacement`）。

目录为空是正常的：上游安装包里默认也空着，插件按需放进来即可。
本目录不启用热重载（`watchPlugins` 未接入）—— 放进来之后要重启应用才生效。

## 🔴 危险能力必须显式声明（2026-10-15 起）

扩展代码是**在主进程内直接执行**的（`plugin-loader.js` 里那句 `await import(entry)`），
没有任何沙箱。所以从 2026-10-15 起，加载器会在 import **之前**扫一遍入口文件的文本：
用到下面这些能力却**没在清单里声明**的，**直接拒绝加载**（技能页会显示原因，不是静默消失）。

| 能力名（写进 `permissions`） | 什么时候会被判为用到 |
|---|---|
| `child_process` | 入口 import / require 了 `child_process`（起子进程） |
| `vm` | import / require 了 `vm`（在当前进程里执行动态代码） |
| `worker_threads` | import / require 了 `worker_threads`（起线程） |
| `fs-write` | 入口里出现 fs 的**写**那一族调用（`writeFile*` / `unlink*` / `rm*` / `mkdir*` / `rename*` / `chmod*` …）；**只读文件不需要声明** |

声明方式（清单文件里）：

```json
{ "id": "my-plugin", "name": "我的插件", "entry": "index.js",
  "permissions": ["web_fetch", "child_process"] }
```

声明了就放行，但启动日志会留一条 warn —— 声明表示**你认可"这段代码在你机器上不受限地跑"**。

⚠️ **这是绊线，不是沙箱**（别把它当隔离）：扫描只看**入口文件本身**的文本，
所以 ① 它 import 进来的本地模块不在范围内（随包的 `skills/doujin-lookup` 就 import 了
`src/jm-bridge.js`，那里面有真正的文件/进程操作）；② 动态拼出来的模块名绕得过。
它的作用是"把随手丢一个文件就获得进程控制权，变成一道要显式签字的关卡"。
