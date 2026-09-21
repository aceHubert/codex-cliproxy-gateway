## [2026-09-21 17:09] | Task: 关闭 CodeBuddy 目录的 WebSocket 偏好

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/zcode-signing`

### 📥 User Query
> 排查一下日志为什么 codex 总是降级到 sse；查这一部分的日志，调用 gpt 模型的。

### 🛠 Changes Overview
**Scope:** codebuddy / catalog

**Key Actions:**
- **[目录合成]**: `cloneCodexBase` 在克隆 gpt-5.5 基底后显式写入 `prefer_websockets: false`，不再继承基底的 `true`。
- **[回归测试]**: 在 `synthesizeCodebuddyEntry` 映射测试中断言 `prefer_websockets === false`，锁定该字段不会被基底回带。

### 🧠 Design Intent (Why)
*请求日志显示 37 次 426 中有 34 次是 `codebuddy-*/deepseek-v4.1-flash`，标记统一为 `codebuddy-http-only`。CodeBuddy 上游只有 HTTP 接口，网关对它的 Responses WebSocket 升级一律本地回 426，但目录条目从 gpt-5.5 基底继承了 `prefer_websockets: true`，导致 Codex 每次会话都先试探 WS、被拒后再降级到 SSE，固定多一轮往返。ZCode 与 CLIProxy 条目均为 `false`，CodeBuddy 属遗漏。*

### 📊 Change Stats
> 数据来自本次任务相关工作区变更。

- **Files changed:** 2
- **Insertions:** +6
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +3 | -0 |
| `test/codebuddy-catalog.test.ts` | +3 | -0 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `test/codebuddy-catalog.test.ts`
