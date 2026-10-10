## [2026-10-09 10:59] | Task: 补齐 OpenCode Zen 的 Responses WebSocket 传输拦截

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Fable 5.1`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 不是你的集成做错了，是集成漏了最后一块：WS 传输的拦截器。补上就是之前说的三处——在 isQoderResponsesWebSocket 旁加 isZenResponsesWebSocket()，注册进 server 预路由（1582）和 handler 拒绝列表（1110）返回 426。Qoder 已经用 production 流量证明了这条降级路径在这个客户端上是通的。没有处理 ws

### 🛠 Changes Overview
**Scope:** `src/gateway.ts`、`src/realtime.ts`、`test/opencode-zen-gateway.test.ts`、`test/realtime.test.ts`

**Key Actions:**
- **[WS 握手拦截]**: 新增 `isZenResponsesWebSocket()`（与 `isQoderResponsesWebSocket` 同形：`zenEnabled` + `mountPath/responses` 路径 + `upgrade: websocket` + `x-codex-routing-hint` 里的 `opencode-zen/` 模型），在 handler 拒绝列表返回 426 `opencode-zen-http-only`，并在 `Bun.serve` 预路由中把 zen 升级请求交回 handler，避免落入通用上游桥。
- **[帧族兜底]**: `realtime.ts` 的 `httpOnlyModelFamily` 加入 `opencode-zen` 族——已建立的桥（official/CLIProxy）上出现 zen 帧一律本地 reject 断连重握手，与 zcode/codebuddy/qoder/agy 一致。
- **[测试]**: zen 网关测试新增握手 426 用例（含大小写前缀、非 zen 模型、非 responses 路径、开关关闭、无升级头五种反例）；`test/realtime.test.ts` 的 HTTP-only 族用例补两条 zen 帧断言。

### 🧠 Design Intent (Why)
多协议改造只覆盖了 HTTP 面：`/v1/responses` 的 POST 已按协议分发，但 Codex 会先做 WebSocket 试探（GET + `Upgrade: websocket` + `x-codex-routing-hint`），zen 模型当时没有对应拦截器，升级请求会落到通用 `responsesWebSocketTarget` 被当作可桥接目标拨向 CLIProxy——上游没有 zen 模型路由，客户端拿到的是上游错误而不是「换 HTTPS/SSE 重试」的协商信号。Qoder 的 production 流量已证明该客户端在收到 426 后会正确降级到 HTTP/SSE，因此按同一条已验证路径补齐 zen，不引入新机制。三层（预路由 + handler + 帧族）与既有 HTTP-only 适配器完全对齐，帧族那层覆盖「连接已建立后中途切到 zen 模型」的场景。

### 📊 Change Stats
> 工作区含上一任务（多协议改造）未提交改动，故本次行数按实际插入块与 `git diff --numstat` 中本任务独有文件统计。

- **Files changed:** 4
- **Insertions:** +47
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +10 | 0 |
| `src/realtime.ts` | +4 | -2 |
| `test/opencode-zen-gateway.test.ts` | +23 | 0 |
| `test/realtime.test.ts` | +10 | 0 |
| `docs/`（本记录） | 若干 | — |

### 📁 Files Modified
- `src/gateway.ts`（`isZenResponsesWebSocket`、handler 拒绝列表、`Bun.serve` 预路由）
- `src/realtime.ts`（`httpOnlyModelFamily` 加入 `opencode-zen`）
- `test/opencode-zen-gateway.test.ts`、`test/realtime.test.ts`
- `docs/histories/2026-10/20261009-1059-opencode-zen-websocket-downgrade.md`

### ✅ Verification
- `bun run check` 全绿（tsc 严格模式 + 720 测试 + UI/CLI 构建）。
- 单测断言：`opencode-zen/*` 与 `OPENCODE-ZEN/*` 的 WS 升级在启用时被本地拒绝为 426 且带 `opencode-zen-http-only` 标记、不产生任何上游调用；非 zen 模型、非 responses 路径、开关关闭、无升级头四种情形均不拦截；桥上的 zen 帧被判为 `reject`（family `opencode-zen`）。
- 未做真机流量验证：与 Qoder 不同，本次仅单测覆盖，降级路径复用 Qoder 已验证的客户端行为。

### 📌 Notes
- 真机出现 zen 模型 WS 相关异常时，先确认客户端是否带 `x-codex-routing-hint`；无提示头的升级请求与 Qoder 同构，会落到通用桥（既有边界，非本次引入）。
