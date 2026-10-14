## [2026-10-14 10:54] | Task: 还原 Zen Responses custom 工具调用

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 先修复问题1：Zen 链路将 custom 工具包装成 function 后，响应没有还原。
> 额外 OpenCode 工具是客户端校验所需指纹，本次保留。

### 🛠 Changes Overview
**Scope:** `packages/opencode-zen`、转换与网关回归测试。

**Key Actions:**
- **[响应还原]**: Responses 转发把客户端原始工具声明传给流转换器；按名称区分 custom 与 function，不依赖 apply_patch 特判。
- **[参数解包]**: 按调用索引缓冲 JSON 参数，完成后校验字符串 input，再生成 custom input delta/done 和对应条目；同步 completed.output、调用标识与事件序号。
- **[非流式]**: 聚合器支持 custom input 增量、完成事件与条目完成事件，生成 custom_tool_call JSON，并保留失败或未完成的响应状态。
- **[边界]**: 损坏参数、缺失或非字符串 input、调用提前断开明确失败；工具条目完成但缺少响应完成事件时也判失败。原生 Responses 直通、普通 function、OpenCode 模板与工具指纹保持原行为。
- **[回归]**: 覆盖混合并行调用、任意 custom 名称、空输入、中文/换行/转义分片、Anthropic/Google 转换与下一轮历史回放，以及网关流式/非流式入口。

### 🧠 Design Intent (Why)
请求侧使用 JSON function 模拟 custom 工具是现有上游兼容方案，客户端仍按 Responses custom 协议执行工具。响应侧必须使用原始客户端声明恢复类型及正文，不能把包装 JSON 当作补丁正文发送。先收齐并校验参数可避免将不完整 JSON 或未解码的转义字符交给工具执行。

### ✅ Validation
- 新回归对旧构建的红基线：两个测试文件 28 项通过、6 项失败，复现 custom 类型错误、正文丢失及缺少参数校验。
- 初次构建后两个定向测试文件 34 项全部通过；补充转换回归后转换文件 12 项全部通过。
- 独立审查发现工具条目完成但缺少响应终态的断流缺口，补充终态校验及真实 Anthropic 截断回归；同时覆盖失败/未完成响应状态的保留。
- 最终 `bun run check` 通过：源码边界、完整构建、严格类型检查，以及 72 个测试文件的 982 项测试全部通过。
- 测试由仓库运行脚本限制在 60 秒内；`git diff --check` 通过。
- 使用模拟上游验证，无真实生产调用；尚未更新运行中的本机服务或进行 Codex 真机验收。

### 📊 Change Stats
> 数据来自本任务工作区的 `git diff --shortstat` 与 `git diff --numstat`，不包含本历史记录自身。

- **Files changed:** 4
- **Insertions:** +488
- **Deletions:** -10

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/convert.ts` | +147 | -3 |
| `packages/opencode-zen/src/index.ts` | +1 | -1 |
| `test/opencode-zen-convert.test.ts` | +249 | -0 |
| `test/opencode-zen-gateway.test.ts` | +91 | -6 |

### 📁 Files Modified
- `packages/opencode-zen/src/convert.ts`
- `packages/opencode-zen/src/index.ts`
- `test/opencode-zen-convert.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/histories/2026-10/20261014-1054-zen-custom-tool-response-restore.md`
