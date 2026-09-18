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
