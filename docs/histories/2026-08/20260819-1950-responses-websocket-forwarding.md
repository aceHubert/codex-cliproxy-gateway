## [2026-08-19 19:50] | Task: Responses over WebSocket 放行与 Upgrade 时序修复

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 会话住了，重新获取claude 的会话，继续没有完成的工作做计划（随后批准计划：放行 Responses over WebSocket、修 upgrade 时序、加 `websocket` 开关，字段名从 responsesWebSocketProxy 简化为 `websocket`）

### 🛠 Changes Overview
**Scope:** src/realtime.ts、src/gateway.ts、src/types.ts、src/cli.ts、schemas

**Key Actions:**
- **[拨号]**: 新增 `dialUpstreamWebSocket`（5s 握手超时，settle 后清理回调），sideband 与 responses-WS 共用。
- **[时序]**: `realtimeWebSocketHandler.open` 不再拨号，直接使用预拨通的上游（缺失时 1011 防御性关闭并冲刷队列）；`startGateway.fetch` 经 `bridgeUpstreamWebSocket` 先拨上游、成功后才 `server.upgrade`——上游 401/404/超时以真实状态返回，不再退化成 101 后静默断开。
- **[放行]**: 新增 `responsesWebSocketTarget` 纯函数：按 `x-codex-routing-hint` 选上游（无 hint 回落 official），`forwardedHeaders` 白名单转发，cliproxy 路由剥 `authorization`/`chatgpt-account-id` 并注入 CLIProxy Bearer key；realtime 保留路径与开关关闭时维持 426。
- **[失败语义]**: responses-WS 拨号失败回 426（marker `websocket-upstream-unavailable`，客户端降级 HTTPS/SSE，不进错误摘要）；sideband 拨号失败回 502 并写错误摘要。
- **[配置]**: `websocket: true` 进 DEFAULTS/types/JSON Schema，`mergeMissingConfig` 自动迁移。
- **[测试]**: 新增 6 个测试（80 全过）：spike（await 后 upgrade）、目标构建单测、open 队列/防御单测、转发 e2e（含 v1-responses 日志断言）、426 回退 e2e（裸 socket 断言状态行与 marker）、sideband 502 e2e（含错误摘要断言）。

### 🧠 Design Intent
Codex 每次会话都试探 Responses over WebSocket，上游（ChatGPT backend 与 CLIProxy 握手均实测 101）支持而网关一律 426，白白损失 WS 相对 SSE 的延迟优势。试探是 GET 无 body，但带 `x-codex-routing-hint`，路由依据现成。放行前必须先修 upgrade 时序（CLIProxy 同款 upstream-first），否则上游拒绝会退化成静默断开。Bun #8986（await 后 upgrade 破坏握手）仅影响子协议请求且已修复，以 spike 测试验证本机运行时后采用。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交）。注意：同工作区叠加上一轮（routing hint/日志分组，见 20260819-1843）与一组并发的外部改动（`formatErrorLog` 增强 + `index.ts` uncaughtException 处理，非本任务），精确拆分不可行；本任务核心新增约 +330/−90。

- **Files changed:** 7（本任务范围）

| File | 说明 |
| --- | --- |
| `src/realtime.ts` | dialUpstreamWebSocket、open 重构、forwardedHeaders/websocketUrl 导出 |
| `src/gateway.ts` | bridgeUpstreamWebSocket、responsesWebSocketTarget、fetch 重写、426 工厂 |
| `src/types.ts` / `src/cli.ts` | `websocket` 字段与默认值 |
| `schemas/gateway-config.schema.json` | websocket 布尔定义（顺带修正 maxRequestLogs 过时描述） |
| `test/realtime.test.ts` / `test/gateway.test.ts` | 6 个新测试 + 迁移/schema 断言扩展 |

### 📁 Files Modified
- `src/realtime.ts`
- `src/gateway.ts`
- `src/types.ts`
- `src/cli.ts`
- `schemas/gateway-config.schema.json`
- `test/realtime.test.ts`
- `test/gateway.test.ts`
- `docs/exec-plans/completed/responses-websocket-forwarding.md`（执行计划）
- `docs/exec-plans/tech-debt-tracker.md`（挂账 2 项）
