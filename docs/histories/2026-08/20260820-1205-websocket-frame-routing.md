## [2026-08-20 12:05] | Task: 三轮 WebSocket 验证与修复：连接复用串话、前缀剥离、握手头留痕

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-opus-5[1m]`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 现在做一轮测试，分别是官方 websocket 探测、cliproxy websocket 探测、和 live 问题。
> 追加：第三轮写到 exec-plans 中去，这个不急，前面 2 点需要立即修复使用。
> 方案选择：官方模型完全开启，websocket 只控制 cliproxy 的转发，默认设置为 false。

### 🛠 Changes Overview
**Scope:** 网关 WebSocket 路由与转发（gateway / realtime / request-log / 配置）

**Key Actions:**
- **[逐帧路由校验]**: 新增 `checkFrameRouting`，对 responses WebSocket 的每个文本帧校验 `model` 与连接路由是否一致；不一致时记 `ws-route-mismatch` 并以 1012 关闭双向连接，让客户端重连后按当时的 routing hint 重新选上游。
- **[帧内前缀剥离]**: 同一函数在 cliproxy 路由下把 `model` 的 `cliproxy/` 前缀剥掉再转发，与 HTTP 路径的 `json.model = route.upstreamModel` 对齐。非 JSON 帧、无 `model` 的控制帧原样透传。
- **[配置语义变更]**: `websocket` 由"是否放行 Responses WebSocket"改为"是否放行 **cliproxy** 的 Responses WebSocket"，默认值 `true` → `false`；官方模型不受该开关控制，始终放行。同步 `types.ts`、`cli.ts` DEFAULTS、JSON Schema 描述。
- **[连接携带路由信息]**: `RealtimeSocketData` 增加 `routeKind` 与 `prefix`，由 `responsesWebSocketTarget` 返回、`bridgeUpstreamWebSocket` 注入；realtime 的 live/sideband 连接不设这两个字段，保持原有透传。
- **[握手头留痕]**: 新增 `maskedHeaders`，把实际转发的握手头记入 `ws-dial` / `ws-dial-failed` 事件，凭据复用 `SENSITIVE_HEADERS` 遮蔽。

### 🧠 Design Intent (Why)
**连接复用是放行方案的固有缺陷，不是实现 bug。** 三轮验证的第二轮实测到：`11:08:58` 建立的一条通往 ChatGPT backend 的 WebSocket（当时 hint 为 `gpt-5.6-luna`），在 **88 秒后**被用来发送 `cliproxy/gpt-5.6-luna`，backend 返回 `The 'cliproxy/gpt-5.6-luna' model is not supported when using Codex with a ChatGPT account`。根因是 WebSocket 只在握手时按 hint 路由一次，而 Codex 会跨 turn 复用连接、期间模型会变；HTTP 路径没有这个问题，因为每个请求独立路由。用户的实际用法（主线程 CLIProxy + 子代理官方交替）必然频繁触发。

因此仅靠"关闭 cliproxy 放行"并不足够——官方连接上照样可能出现 cliproxy 帧，逐帧校验是必需的兜底。选择"断开让客户端重连"而非"多路复用"，是因为前者改动小且语义确定；代价是模型切换时多一次重连，而在默认配置下 cliproxy 根本不走 WebSocket，这个代价基本不会发生。

**前缀剥离是独立的第二道坎。** WebSocket 路径不解码 body，帧里始终是网关加过前缀的模型名，而 CLIProxy 模型表里只有原名。第二轮没暴露它，是因为那次到 CLIProxy 的拨号超时失败、未走到帧交换。

**默认关闭 cliproxy 放行**：CLIProxy 侧同时存在拨号偏慢（实测基线 1.5–3s，5s 超时余量小）与前缀问题，收益不确定；官方模型那条路已完整验证可用，无理由一并关掉。

### 📊 Change Stats
> 口径：`git diff --numstat`（未暂存部分），含本轮验证前的头透传改动。

- **Files changed:** 9
- **Insertions:** +1019
- **Deletions:** -147

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/gateway.test.ts` | +298 | -15 |
| `test/realtime.test.ts` | +295 | -3 |
| `src/gateway.ts` | +176 | -45 |
| `src/realtime.ts` | +149 | -55 |
| `src/request-log.ts` | +61 | -26 |
| `src/cli.ts` | +19 | -2 |
| `src/index.ts` | +11 | -0 |
| `schemas/gateway-config.schema.json` | +5 | -1 |
| `src/types.ts` | +5 | -0 |

### ✅ Verification
- `bun run check` 全部通过：82 测试、类型检查、构建。
- 新增测试覆盖：官方帧在官方连接上透传、cliproxy 帧在官方连接上被拒（不发往 backend）、官方帧在 cliproxy 连接上被拒、cliproxy 路由剥离前缀、无 `model` 的控制帧与非 JSON 帧原样透传、cliproxy 默认不放行需显式开启、官方模型不受开关影响。

### 📋 三轮验证结论
**第一轮（官方 WebSocket）：通过。** 无 426；上游 `wss://chatgpt.com/backend-api/codex/responses`；握手头剥离正确；`response.output_text.delta` 流式完好；2 次 `ws-dial` 承载 4 次 `response.create`，连接复用生效。

**第二轮（cliproxy WebSocket）：发现三个问题。** 连接复用串话（本次修复）、帧内前缀未剥离（本次修复）、CLIProxy 拨号超时 6077ms（见下）。

**第三轮（Live）：未执行**，已按要求写入 `docs/exec-plans/active/codex-live-verification.md`。

### ⚠️ Notes
- **CLIProxy 拨号耗时实测**：最小头集（164B）1564–2127ms，全量头集（5005B）2275–2971ms，全量透传多约 700–800ms（+40%），但两者均握手成功。那次 6077ms 超时是网络抖动叠加头开销所致，非改动单独引起。未加长 `UPSTREAM_DIAL_TIMEOUT_MS`：拨号等得越久，降级到 HTTP 越晚，而失败即降级的机制已验证正常。
- 逐帧校验只作用于文本帧；二进制帧不解析，直接按原路径转发。
- `websocket` 默认值变更会通过 `mergeMissingConfig` 补进既有配置文件，已开启过该开关的用户不受影响（显式值优先）。
