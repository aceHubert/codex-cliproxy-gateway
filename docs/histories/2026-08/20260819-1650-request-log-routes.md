## [2026-08-19 16:50] | Task: 按路由拆分请求日志并补齐 live 链路与错误细节

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-opus-5[1m]`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 重新设计一下日志的显示，根据路由来显示日志名 `cliproxy-{route}-{时间戳}.log`，把 live 的路由给补充进去，再把网关的错误日志补充得更详细一点。
> 追加：再补充一个最大 request log 条数，超过就先删除，默认 0 为不限制。

### 🛠 Changes Overview
**Scope:** 网关请求日志（gateway / realtime / config schema）

**Key Actions:**
- **[新增 request-log 模块]**: 抽出 `src/request-log.ts`。`gateway.ts` 已 import `realtime.ts`，日志函数留在 gateway 内无法给 realtime 复用，必须提到第三个模块。迁入 `truncate`/`headerLines`/`SENSITIVE_HEADERS`，新增 `LogRoute` 与按路由的文件名、错误汇总、realtime 事件记录。
- **[按路由分文件]**: 文件名改为 `cliproxy-{route}-{时间戳}.log`，route 取 `cliproxy` / `official` / `live`；`models` 与 `healthz` 不转发上游且被 launchd 高频探活，明确排除。
- **[live 链路接入]**: call-create 记录实际上游 URL、状态码与耗时；WebSocket 记录 dial / upstream-open / recv / send / upstream-error / upstream-close / client-close，文本帧截断 2000 字符、二进制帧只记字节数。
- **[错误双写]**: `status >= 400` 时同时写入所属路由日志与 `cliproxy-error-{时间戳}.log`，含 route、状态码、message、耗时。新增 `errorMessageFromBody` 兼容 `{error:{message}}`、`{error:"..."}`、`{detail:"..."}` 与纯文本四种上游错误体形态。
- **[修复流式失效]**: 原实现 `await response.clone().text()` 后才 `return response`，会读完整个响应流，令 SSE 退化为一次性返回。改为 `void clone.text().then(...)` 异步落盘。
- **[新增 maxRequestLogs]**: 每个日志分组独立按文件名时间戳升序裁剪，只保留最新 N 个；0 表示不限制。同步 `types.ts`、`cli.ts` 的 `DEFAULTS` 与 `schemas/gateway-config.schema.json`。
- **[补齐凭据遮蔽]**: `SENSITIVE_HEADERS` 增加 `x-oai-attestation`——Codex Realtime 请求携带约 4 KB attestation，属于凭据，一旦开始记 live 日志就会明文落盘。

### 🧠 Design Intent (Why)
排查 Codex Live 的 "Voice chat took too long to start" 时，网关侧完全没有可观测性：`gateway.ts` 里 `if (!isCliproxy) return response` 让 official 路由与整个 realtime 链路一条日志都不写，只能临时搭抓包代理才看清链路，而那次 8 秒耗时具体落在哪一段至今无从归因。本次改动让三类上游流量各自留痕，并把 realtime 的实际上游去向（ChatGPT backend 还是 OpenAI API）与耗时记进 live 日志——这正是当时最缺、且 wrapper 层看不到的信息。

流式失效是顺带发现的既有缺陷：它此前只影响 cliproxy 路由，但按需求加上 official 后每次对话都会退化成"等待后一次性吐出"，因此必须在同一次改动里修掉。

### 📊 Change Stats
> `git diff --shortstat` 统计已跟踪文件；`src/request-log.ts` 为新增未跟踪文件，单独列出。

- **Files changed:** 8（含 1 个新增文件）
- **Insertions:** +522
- **Deletions:** -84

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts`（新增） | +164 | -0 |
| `test/gateway.test.ts` | +185 | -2 |
| `src/gateway.ts` | +66 | -80 |
| `src/realtime.ts` | +66 | -2 |
| `test/realtime.test.ts` | +33 | -0 |
| `schemas/gateway-config.schema.json` | +5 | -0 |
| `src/types.ts` | +2 | -0 |
| `src/cli.ts` | +1 | -0 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/gateway.ts`
- `src/realtime.ts`
- `src/types.ts`
- `src/cli.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `test/realtime.test.ts`

### ✅ Verification
- `bun run check` 全部通过：69 测试、类型检查、构建。
- 新增测试：三类路由分文件、catalog/healthz 被排除、错误双写、attestation 遮蔽、`maxRequestLogs` 按分组裁剪且不影响其它分组、**流式响应不被日志阻塞**（用 1 秒超时的 `Promise.race` 断言 handler 不等流结束）、WebSocket 生命周期事件落盘（含 1006 关闭码）。
- 真实进程端到端验证（临时端口与目录，未触碰生产配置）：四类日志文件正确生成；live 日志含 `[realtime] call-create https://api.openai.com/v1/live {"status":400,"durationMs":737}`；`authorization: ***` 遮蔽生效；`/v1/models` 与 `/healthz` 不产生日志。
- 配置迁移已验证：`Config synced to 0.2.2. Added: $schema, requestLogging, maxRequestLogs, logDir.`

### ⚠️ Notes
- `cliproxy` 路由的文件名会呈现为 `cliproxy-cliproxy-<时间戳>.log`（前缀是产品名、中段是路由名）。已向用户说明，按其指定格式保留。
- 日志落盘改为异步，测试需轮询等待文件出现，已提供 `waitForLogFile` 辅助函数。
