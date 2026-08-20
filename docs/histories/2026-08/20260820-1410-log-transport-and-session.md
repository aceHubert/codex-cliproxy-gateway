## [2026-08-20 14:10] | Task: 日志文件名体现传输方式，WebSocket 按会话聚合

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-opus-5[1m]`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把这个串话的根因记录在 tech-debt-tracker.md 里用于后期补充修复。
> 另外日志加 2 点需求：
> 1. 文件名上体现是 http/websocket
> 2. websocket 会话能不能根据会话 id 记录在同一个文件里面，不要创建这么多的文件

### 🛠 Changes Overview
**Scope:** 请求日志文件定位（request-log / gateway / realtime）与技术债记录

**Key Actions:**
- **[文件名体现传输方式]**: 引入 `LogFileRef { name, prefix }`，把 `logFileName` 拆成 `httpLogFile` 与 `websocketLogFile`。HTTP 为 `cliproxy-{group}-http-{时间戳}.log`（保持按秒滚动），WebSocket 为 `cliproxy-{group}-ws-{sessionId}.log`。
- **[WebSocket 按会话聚合]**: 建连时用 `session-id` 请求头定位文件，整条会话的 dial/open/send/recv/close 全部追加到同一个文件；`session-id` 缺失时回落到建连时刻。`RealtimeSocketData.logGroup`（字符串）改为 `logFile`（`LogFileRef`），在 `bridgeUpstreamWebSocket` 里一次算好。
- **[裁剪分组随之细化]**: `pruneGroup` 改为按 `LogFileRef.prefix` 裁剪，于是 `-http-` 与 `-ws-` 成为彼此独立的分组，HTTP 日志不会把 WebSocket 会话挤掉。
- **[记录串话技术债]**: 在 `tech-debt-tracker.md` 补一条，写明根因出在 Codex 的**预热阶段**而非运行中途切模型。

### 🧠 Design Intent (Why)
**选 `session-id` 而不是 `thread-id` 做聚合键**：实测同一 `session-id` 下会出现多条连接——主线程与 subagent 派生的 thread 各自建连（如 `session=01a01960-3a52…` 同时对应 `thread=01a01d97-59f8…` 与 `thread=01a01960-3a52…`）。按 thread 聚合仍会产生多个文件，按 session 聚合才能把一次用户会话收敛成一个文件，这正是"不要创建这么多文件"的诉求。端到端验证中两条连接（12 条事件）确实合并进了同一文件。

**为什么必须区分 `-http-` 与 `-ws-` 前缀**：`maxRequestLogs` 按前缀分组裁剪。若两者共用前缀，HTTP 那种按秒滚动、数量增长快的文件会迅速把长生命周期的 WebSocket 会话日志挤出保留窗口，而后者恰恰是排查连接复用类问题最需要的。

**串话根因补记**：此前只知道"连接被复用后模型变了"，本轮从握手头的 `x-codex-turn-metadata` 读出全部四条连接都是 `request_kind: prewarm`——Codex 在用户输入前就按 thread 预热连接，预热用的 hint 是无前缀模型，真实请求却可能带 `cliproxy/` 前缀，**连接自建立起就绑错了上游**。这解释了为何问题看似"中途切模型"，实际在预热时已注定。

### 📊 Change Stats
> 口径：`git diff --numstat`（未暂存部分），含本轮之前的头透传与帧路由改动。

- **Files changed:** 10
- **Insertions:** +1086
- **Deletions:** -155

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/gateway.test.ts` | +324 | -15 |
| `test/realtime.test.ts` | +297 | -3 |
| `src/gateway.ts` | +180 | -45 |
| `src/realtime.ts` | +150 | -56 |
| `src/request-log.ts` | +92 | -33 |
| `src/cli.ts` | +19 | -2 |
| `src/index.ts` | +11 | -0 |
| `schemas/gateway-config.schema.json` | +5 | -1 |
| `src/types.ts` | +5 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +3 | -0 |

### ✅ Verification
- `bun run check` 全部通过：83 测试、类型检查、构建。
- 新增测试：HTTP 文件名带 `-http-` 且按秒滚动、同一 session 两次调用返回同一文件名、`-http-`/`-ws-` 裁剪前缀互相独立、`session-id` 缺失回落时间戳、`../../etc/passwd` 之类不可信 session 值不会逃逸出日志目录。
- 真实进程端到端（临时端口与目录）：同一 `session-id` 的两条连接（`thread-A`/`thread-B`）合并进 `cliproxy-v1-responses-ws-01a01960-….log`，共 12 条 realtime 事件；HTTP 请求另落 `cliproxy-v1-responses-http-20260820140735.log`。

### ⚠️ Notes
- WebSocket 日志文件不带时间戳，同一 session 会持续追加。`maxRequestLogs` 只限制文件数、不限制单文件大小；若某个会话极长，该文件会持续增长。
- `session-id` 取自请求头，属不可信输入，已做字符白名单与长度截断（64 字符）。
