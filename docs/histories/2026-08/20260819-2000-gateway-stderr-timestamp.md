## [2026-08-19 20:00] | Task: 网关 stderr 错误日志补时间戳并接管进程级错误

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan/GLM-5.3)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 网关错误日志里全是 `1 | (function (controller, error) {"use strict"; TypeError: null is not an object`，怎么没有加时间，不好排查问题。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/index.ts、src/cli.ts、test/gateway.test.ts）

**Key Actions:**
- **[入口注册进程级错误处理器]**: `src/index.ts` 注册 `uncaughtException` / `unhandledRejection` 处理器，统一用 `formatErrorLog` 带时间戳输出到 stderr，并选择"记录后继续运行"而非退出。
- **[扩展 formatErrorLog]**: `src/cli.ts` 的 `formatErrorLog` 新增可选 `options: { label?: string; stack?: boolean }`；输出保留错误类名（如 `TypeError:`），`stack: true` 时附加调用位置并去重首行；默认行为与旧格式完全兼容。
- **[补充测试]**: `test/gateway.test.ts` 新增用例覆盖 label、错误类名、stack 去重与非 Error 输入。

### 🧠 Design Intent (Why)

`gateway.error.log` 由 launchd `StandardErrorPath` 直接重定向生成。此前的裸错误（`(function (controller, error)` + `TypeError: null is not an object`）并非应用层输出，而是 Bun 1.3.5 在客户端中断 SSE 流后、清理 `response.clone().tee()` 内部 ReadableStream 时触发的运行时 bug（参见 oven-sh/bun#26378 一族），以 unhandledRejection 形式裸打 stderr：无时间戳，且 **Bun 默认将其视为致命错误直接退出进程**，导致 launchd 频繁拉起网关（gateway.log 中 11:43–11:47 每几十秒重启一次）。

因此修复分两层：
1. 时间戳：所有进程级错误经 `formatErrorLog` 统一为 `--ISO--\n<label>: <Name>: <message>\n<stack>` 格式。
2. 存活策略：这类错误是中断后的清理噪音，退出反而会打断所有在途请求；接管后记录并继续服务。真正无法捕获的致命故障（OOM、段错误）仍由 launchd `KeepAlive` 兜底。

端到端验证：用独立脚本复现「上游 SSE + `response.clone().text()` 日志克隆 + 客户端 abort」，注册处理器后错误被拦截为带时间戳的一行，进程存活（exit=0）；未注册时即为线上看到的裸错误形态。`bun run check`（typecheck + 73 tests + build）全部通过。

遗留建议：根因在 Bun 1.3.5 运行时，后续版本已修复 controller 判空问题，条件允许时 `bun upgrade`（注意 launchd 使用的 bun 路径来自 nvm node_modules）。

### 📊 Change Stats
> 仅统计本任务改动；`test/gateway.test.ts` 工作树中另有此前未提交的日志分组/本地时间格式改动，未计入。

- **Files changed:** 3
- **Insertions:** +46
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/index.ts` | +11 | -0 |
| `src/cli.ts` | +18 | -2 |
| `test/gateway.test.ts` | +17 | -0 |

### 📁 Files Modified
- `src/index.ts`
- `src/cli.ts`
- `test/gateway.test.ts`

### ✅ Verification
- `bun run check`：typecheck、73 个测试、构建全部通过。
- 复现脚本：客户端中断后 `[intercepted rejection] TypeError: null is not an object` 带时间戳输出，网关存活。
- `bun run dev restart` 后 `curl /healthz` 返回 200，新代码已生效。
