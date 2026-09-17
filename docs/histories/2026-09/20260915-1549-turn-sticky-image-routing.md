## [2026-09-15 15:49] | Task: 图片请求按 turn 级粘性继承 cliproxy 路由

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> Codex Desktop 会话（cliproxy 线程 `01a0a3a2-…`）里触发图片生成，`POST /v1/images/generations` 返回 403 `{"detail":"Forbidden"}`。排查确认：网关把图片请求路由到了官方（gateway.log 记录 upstream 为 `https://chatgpt.com/backend-api/codex/images/generations`），用本地 OAuth 调官方无 gpt-image-2 权限被拒；粘性会话未命中是因为图片请求不带 `thread-id`，只有 `x-codex-image-turn-id`。日志分析证实该 id 等于触发图片的 turn 的 `turn_id`，且携带该 turn_id 的请求（HTTP 头 `x-codex-turn-metadata` / WS `response.create` 帧 `client_metadata`）必然先于图片请求到达网关。要求按 turn 级粘性实现。

### 🛠 Changes Overview
**Scope:** `src/gateway.ts`、`src/realtime.ts`、`test/`

**Key Actions:**
- **turn 记录与继承（HTTP 路径）**: `decideThreadRoute` 新增 `cpaTurns` 集合——cliproxy 路由的请求解析 `x-codex-turn-metadata` 头并记录 `turn_id`；官方路由的请求若带 `x-codex-image-turn-id` 且命中 `cpaTurns` 则继承 cliproxy 路由（剥 OAuth、注 CPA key、改写 model）。`cpaTurns` 上限 4096 条、按插入序淘汰。
- **turn 记录（WS 路径）**: `realtime.ts` 新增 `turnIdFromResponseCreate`（解析 `response.create` 帧的 `client_metadata.turn_id` 与双重编码的 `x-codex-turn-metadata` 字符串）；`RealtimeSocketData` 新增 `noteTurnId` 钩子，`message()` 逐帧提取并在 cliproxy 连接上记录（official 连接不记：官方会话的图片本就该走官方；迁移到 cliproxy 时新连接会重发 turn 帧并被记录）。
- **签名接线**: `createGatewayHandler`/`responsesWebSocketTarget` 新增 `cpaTurns` 参数，`startGateway` 创建并贯通两个集合到 WS 桥接的 `noteTurnId`。
- **测试**: gateway.test.ts 端到端用例（CPA turn → 图片继承 cliproxy + 换 key；官方 turn → 图片走官方不污染；未知 turn → 回落默认路由）；realtime.test.ts 三例（双处元数据提取、无元数据容错、桥接 socket 逐帧记录且不改变帧内容）。受签名影响的 6 处既有调用点同步补参。

### 🧠 Design Intent (Why)
Codex Desktop 的图片生成模型 `gpt-image-2` 是硬编码裸模型名，不带 `cliproxy/` 前缀，默认路由归官方；图片请求又不带 `thread-id`，现有 thread 粘性接不住——在 cliproxy 会话里触发图片必然漏到官方，被本地 OAuth 的 403 拒绝。`x-codex-image-turn-id` 是唯一可用的关联键，它等于触发 turn 的 `turn_id`，而 turn 元数据在 responses 请求上必然先行到达，因此 turn 级粘性可以把图片请求精确归位到所属会话的路由：cliproxy 会话的图片走 CLIProxy，官方会话的图片不受影响——比"images 一律走 cliproxy"更精确，也不需要 `upstreamOnly`（会连带禁用 ZCode）。查不到 turn（网关重启丢内存表、其他客户端）时回落默认路由，与现有粘性 miss 语义一致。

### 📊 Change Stats
> 数据来自 `git diff HEAD --numstat`。注：工作区在本次任务前已有未提交改动，gateway.ts / gateway.test.ts 等文件的数字含此前未提交内容；本次任务实际新增约 +210 行（gateway.ts 路由与解析 ~+55、realtime.ts 提取与钩子 ~+70、测试 ~+85）。

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +352 | -100 |
| `src/realtime.ts` | +74 | -1 |
| `test/gateway.test.ts` | +838 | -64 |
| `test/realtime.test.ts` | +171 | -8 |
| `test/model-catalog-dynamic.test.ts` | +83 | -31 |
| `test/zcode-gateway.test.ts` | +732 | -0 |

### 📁 Files Modified
- `src/gateway.ts`
- `src/realtime.ts`
- `test/gateway.test.ts`
- `test/realtime.test.ts`
- `test/model-catalog-dynamic.test.ts`（调用点补参）
- `test/zcode-gateway.test.ts`（调用点补参）
- `docs/histories/2026-09/20260915-1549-turn-sticky-image-routing.md`

### ✅ Verification
- `bun run check`：类型检查通过，326 个测试全过（含新增 4 例），UI/CLI 构建成功。
- 端到端用例断言：图片请求上游为 `https://proxy.example/v1/images/generations` 且 `authorization` 为 `Bearer proxy-key`；官方 turn 与未知 turn 的图片仍走官方。
