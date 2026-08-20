## [2026-08-20 09:55] | Task: 验收 Responses WebSocket 放行，修复日期依赖测试与头白名单

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-opus-5[1m]`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 这个功能修改完了，不用做了，你做一下验收。
> 追加：一起修了吧，为什么不把所有 headers 都透传呢，如果 openai 更新加个什么头不就挂了。

### 🛠 Changes Overview
**Scope:** 网关 WebSocket 转发与测试（realtime / gateway 测试）

放行功能本身（`responsesWebSocketTarget`、`bridgeUpstreamWebSocket`、`dialUpstreamWebSocket`、`config.websocket`）由用户实现，本次任务是验收并修复发现的两个问题。

**Key Actions:**
- **[头转发改黑名单]**: `forwardedHeaders` 从白名单（`REALTIME_HEADER_NAMES`）改为黑名单，仅剥离 hop-by-hop 头（`HOP_BY_HOP_UPSTREAM_HEADERS`）与 WebSocket 握手头（`WEBSOCKET_HANDSHAKE_HEADERS`），其余一律透传。
- **[修复日期依赖测试]**: 新增 `waitForNewLogFile`，按"新出现的文件"而非当天日期正则等待日志落盘。
- **[补测试]**: 新增用例断言真实 Codex 试探请求的全部元数据头透传、握手头被剥离，并包含一个虚构的未来头以固化"默认透传"语义。
- **[更新 cookie 断言]**: sideband 头断言改为包含 `cookie`，并注释说明与 HTTP 路径一致的理由。

### 🧠 Design Intent (Why)
**头白名单是重复踩坑的根源。** 白名单默认拒绝，而代理应当默认透明，导致每次上游或客户端新增头都要追着补：先是 `version`（Codex Desktop 用来协商 quicksilver 能力）、然后 `openai-safety-identifier`，这次验收又发现 `x-codex-turn-metadata`、`x-codex-beta-features`、`x-client-request-id`、`x-codex-window-id` 四个头被丢。更严重的是它造成同一个 `/v1/responses` 走 HTTP 与走 WebSocket 时上游看到的元数据不同——HTTP 路径的 `copyRequestHeaders` 本就是黑名单式。改为黑名单后两条链路语义对齐，且上游将来新增的头会自动透传。

`cookie` 随之从"被拦截"变为"透传"。这是有意的：它是 end-to-end 头，HTTP 路径本来就转发，两条链路应当一致；日志侧由 `SENSITIVE_HEADERS` 遮蔽，不会落盘。

**日期依赖测试是上一轮引入的缺陷。** `maxRequestLogs` 用例为区分"新写入文件"与预置的 `20260101000004`，把正则写成 `2026081\d{7}`，只覆盖 8 月 10–19 日，跨到 8 月 20 日即失配，`bun run check` 变红。改用集合差集判断，彻底去掉时间假设。

### 📊 Change Stats
> 口径：`git diff --numstat`（未暂存部分）。其中放行实现由用户完成，本次任务的改动集中在 `src/realtime.ts` 的头转发与两个测试文件。

- **Files changed:** 9
- **Insertions:** +882
- **Deletions:** -146

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/gateway.test.ts` | +283 | -15 |
| `test/realtime.test.ts` | +255 | -3 |
| `src/gateway.ts` | +155 | -45 |
| `src/realtime.ts` | +100 | -54 |
| `src/request-log.ts` | +52 | -26 |
| `src/cli.ts` | +19 | -2 |
| `src/index.ts` | +11 | -0 |
| `schemas/gateway-config.schema.json` | +5 | -1 |
| `src/types.ts` | +2 | -0 |

### ✅ Verification
- `bun run check` 全部通过：81 测试、类型检查、构建。
- 新增断言覆盖：全部 Codex 元数据头透传、握手头（`upgrade`/`connection`/`host`/`sec-websocket-*`）被剥离、未知的未来头同样透传。

### 📋 验收结论（放行实现本身）
通过的部分：
- **时序正确** —— 先 `await dialUpstreamWebSocket()` 成功后才 `server.upgrade()`；拨号失败返回真实 HTTP 错误而非 upgrade；upgrade 失败时关闭上游，无连接泄漏。这修正了此前 sideband "101 后静默断开"的问题。
- **拨号防护完整** —— 有超时、`settle()` 清理事件处理器、失败关闭 socket。
- **路由与认证正确** —— 用 `modelFromRoutingHint` + `decideRoute` 选上游；cliproxy 分支剥离官方 OAuth 并注入 Keychain key；`isReservedOfficialRealtimePath` 避免抢占 realtime 路径。
- **配置合规** —— `websocket` 字段在 `types.ts` / `cli.ts` / JSON Schema 三处同步。
- **端到端测试** 验证了双向回显、握手 URL 与头透传、日志落盘，并顺带证明 `server.upgrade()` 可在 `await` 之后调用——这是该方案成立的前提。

### ⚠️ Notes
- Bun 的 WebSocket 客户端不暴露上游握手响应状态码（无 `unexpected-response` 事件），因此拨号失败只能归为 502，无法透传上游的 401/404 原始状态。若日后需要精确状态码，需改用能拿到握手响应的客户端实现。
