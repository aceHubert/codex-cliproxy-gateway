## [2026-09-14 15:49] | Task: WebSocket 会话关闭时写入 gateway.log 请求摘要

### 🤖 Execution Context
* **Agent ID**: `mimo`
* **Base Model**: `mimo`
* **Runtime**: `MiMo Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 🥛 User Query
> 排查一个问题，gateway.log 中的请求日志也不写了，web更新重启后
>
> （确认根因后）按这个方案修改：在 WS 会话关闭时补一行 gateway.log 摘要

### 🛠 Changes Overview
**Scope:** process log / WebSocket bridge

**Key Actions:**
- **[诊断]** HTTP 请求摘要链路正常（processLog 已注入）；Codex 主流量改为 Responses-over-WebSocket 后，`bridgeUpstreamWebSocket` 在 `startGateway` fetch 层完成 upgrade，绕过 HTTP 日志包装层，成功会话从不调用 `logRequestSummary`，`gateway.log` 因此看似停写。
- **[realtime.ts]**：`RealtimeSocketData` 新增 `clientUrl` / `startedAt` / `requestTime`；`close` 在释放日志登记前写一行 `status 101` 请求摘要（方法、客户端路径、会话时长、上游 URL），与 HTTP 摘要同格式、同一 `maxGatewayLogBytes` 约束。
- **[gateway.ts]**：`bridgeUpstreamWebSocket` 构造 socket 时填入客户端路径、localTime 与拨号开始时刻。
- **[process-log.ts]**：注释标明 WS 关闭时以 101 写摘要。
- **[test/realtime.test.ts]**：新增用例——Responses WS 握手成功并关闭后，`gateway.log` 出现 `GET /v1/responses -> 101 (Nms) upstream: …`。

### 🧠 Design Intent (Why)
* 进程日志的定位是可扫描的请求流水：HTTP/ZCode 路径已有摘要，WS 是当前主流量，缺摘要会让「日志停写」成为误判入口。
* 摘要写在 `close` 而非 `open`：能带上真实会话时长；拨号失败路径已有 `logGatewayError`，不重复。
* 状态用 101：与 HTTP 完成态摘要同格式，又可一眼区分升级连接。

### 📊 Change Stats
> 工作区本身带有大量未提交 WIP；下表为本任务三个文件的增量（相对本任务开始时的工作区）。

- **Files changed:** 3
- **Insertions:** +81
- **Deletions:** -17

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/realtime.ts` | +21 | -1 |
| `src/gateway.ts` | +7 | -6 |
| `test/realtime.test.ts` | +59 | -0 |

（`src/process-log.ts` 仅注释一行。）

### 📁 Files Modified
- `src/realtime.ts`
- `src/gateway.ts`
- `src/process-log.ts`
- `test/realtime.test.ts`

### ✅ Verification
- `bun run typecheck` 通过
- `bun test test/realtime.test.ts`：29 pass / 0 fail（含新增用例）
