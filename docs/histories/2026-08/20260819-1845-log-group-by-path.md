## [2026-08-19 18:45] | Task: 日志分组改按请求路径、模型来源统一、时间戳改本地时区

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-opus-5[1m]`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 1. 获取模型方式修改一下 `x-codex-routing-hint` > request payload -> fallback
> 2. 日志文件名修改一下，不要用 official 和 cliproxy，有可能会被 fallback 搞混，取请求路由的前两段，例如 `/v1/live/xxx` -> `v1-live`
> 3. 时间戳的时区不正确，使用当前时区
>
> 评审补充：`routingModel(request, body)` 这样会造成 body 必须 decode 一次，造成不必要的解密还容易解出问题。

### 🛠 Changes Overview
**Scope:** 网关请求日志与路由判定（gateway / realtime / request-log）

**Key Actions:**
- **[模型来源统一]**: 新增 `modelFromRoutingHint`，从 `x-codex-routing-hint: model=…` 取完整模型名（含 `cliproxy/` 前缀），payload 仅作兜底，`decideRoute(undefined)` 保持回落官方。转发与日志共用同一来源。
- **[惰性解码 body]**: 将 `readJsonBody` 拆为 `readBodyBytes` 与 `decodeJsonBody`。只有"拿不到 hint"或"路由是 cliproxy（需改写 body）"两种情况才解码，official + hint 的请求零解码透传。
- **[日志分组改按路径]**: 新增 `logGroupFromPath`，取 pathname 前两段作为分组键（`/v1/live/rtc_x` → `v1-live`），段内只保留 `[A-Za-z0-9_-]`、其余替换为 `_`，空路径回落 `root`。文件名变为 `cliproxy-{group}-{时间戳}.log`。
- **[时间戳改本地时区]**: 文件名 `20260819184517`，正文 `2026-08-19 18:45:17.128`，均为本地时间不带偏移。`models-cache` 的 `fetched_at` 是数据字段，未改动。
- **[去掉上游标记]**: 错误行由 `!!! [cliproxy] POST … !!!` 简化为 `!!! POST … !!!`；`logExchange` / `logGatewayError` / `logRealtimeEvent` 的 route 参数改为分组键，只决定写入哪个文件。
- **[realtime 分组]**: `RealtimeSocketData` 增加 `logGroup`，在 `startGateway` 的 `server.upgrade` 处按**本地请求路径**注入（`ws.data.url` 是上游地址，不能用于分组）；`proxyRealtimeCall` 从 `request.url` 自行推导。

### 🧠 Design Intent (Why)
上一轮按上游（`cliproxy` / `official` / `live`）给日志分文件，实跑后发现会误导：WebSocket 试探是 GET 没有 body，`decideRoute(undefined)` 回落到 `official`，于是一条 `cliproxy/gpt-5.6-luna` 会话的试探被记进了 `cliproxy-official-*.log`。排查时据此判断上游归属会得出错误结论——本次诊断就差点据此断定"cliproxy 会话不触发 WebSocket 试探"。改用请求路径分组后，文件名只陈述事实，不再承载会被 fallback 污染的推断。

惰性解码是评审时发现的：原设计把 body 作为参数传给模型来源函数，等于强制先解码。而 official 路由压根用不到 `json`（改写 `model`、`rewriteCompactionHistory`、compaction 分支全都带 `route.kind === "cliproxy"` 条件），却要为它解压几十 KB 的 zstd，并承担 `Unsupported content encoding` / `Invalid JSON request body` 抛错误拒请求的风险。改为按需解码后，这条路径既省掉解压，也消除了故障面——端到端验证中，`hint=official` + 无法解压的 body 现在返回上游的 401，而非网关自己的 400。

### 📊 Change Stats
> 口径：`git diff --numstat`（未暂存部分即本次任务增量；此前会话与上一轮改动已在暂存区）。

- **Files changed:** 5
- **Insertions:** +233
- **Deletions:** -87

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/gateway.test.ts` | +117 | -14 |
| `src/request-log.ts` | +52 | -26 |
| `src/gateway.ts` | +49 | -36 |
| `src/realtime.ts` | +13 | -10 |
| `test/realtime.test.ts` | +2 | -1 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/gateway.ts`
- `src/realtime.ts`
- `test/gateway.test.ts`
- `test/realtime.test.ts`

### ✅ Verification
- `bun run check` 全部通过：72 测试、类型检查、构建。
- 新增测试：hint 决定转发上游（含 hint 与 payload 不一致时以 hint 为准）、**official + hint 时坏 body 仍透传而非 400**、无 hint 回落 payload、两者皆无归官方、同一路径下不同上游落进同一分组文件、路径中的 `..%2F` 不产生不安全文件名、正文时间戳为本地格式。
- 真实进程端到端（临时端口与目录，未触碰生产配置）：
  - `hint=official` + 无法解压的 body → **401**（旧行为 400），证实未解码直接透传
  - 生成 `cliproxy-v1-responses-*` / `cliproxy-v1-live-*` / `cliproxy-error-*`
  - 文件名 `20260819184517`、正文 `--2026-08-19 18:45:17.128--`、系统时间 `2026-08-19 18:45:19`，三者一致
  - live 事件写入 `cliproxy-v1-live-*.log`：`[realtime] call-create https://api.openai.com/v1/live {"status":400,"durationMs":900}`

### ⚠️ Notes
- hint 与 payload 不一致时以 hint 为准。cliproxy 路由本就会把 `json.model` 改写成去前缀的模型名，因此等价于 hint 覆盖 payload。实测两者始终一致（`model=cliproxy/gpt-5.6-luna` ↔ `{"model":"cliproxy/gpt-5.6-luna"}`），已有测试固化该行为。
- 配置字段无变化，`schemas/gateway-config.schema.json` 未改动。
