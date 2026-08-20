## [2026-08-19 18:43] | Task: routing hint 优先路由与按路径分组的本地时区日志

> 补记：本任务由 Claude 会话完成，会话在补测试后中断，历史记录当时未及落盘；由后续 ZCode 会话按仓库规范代为补录。

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 1, 获取模型方式修改一下 x-codex-routing-hint > request payload -> fallback
> 2, 日志文件名修改一下,不要用 officel 和cliproxy 有可能会被fallback 搞混, 取请求路由的前两段, 例如 /v1/live/xxx -> v1-live
> 3, 时间戳的时区不正确, 使用当前时区

### 🛠 Changes Overview
**Scope:** src/gateway.ts、src/request-log.ts、src/realtime.ts

**Key Actions:**
- **[路由]**: 新增 `modelFromRoutingHint` 解析 `x-codex-routing-hint` 头；hint 能定路由且为 official 时惰性跳过 body 解码（不解压几十 KB zstd、解码失败不误拒透传请求）；`readJsonBody` 拆分为 `readBodyBytes` + `decodeJsonBody`。
- **[日志]**: `LogRoute` 上游命名（cliproxy/official/live）改为 `logGroupFromPath` 按请求路径前两段分组（`/v1/live/xxx` → `cliproxy-v1-live-*`），段内字符白名单清洗防路径逃逸；realtime 各事件带 `logGroup`；错误摘要去掉误导性的上游标签。
- **[时区]**: 文件名 `fileStamp` 与正文 `localTime` 改用本地时区（不再带 Z 后缀），同格式下字典序即时间序，裁剪逻辑不受影响。

### 🧠 Design Intent
日志按上游命名时，缺模型信息的请求会 fallback 到 official，用它做文件名会误导排查（同一会话的主线程与子代理流量会被拆进两堆"错"的文件）；按请求路径分组天然聚合同一路径的流量。hint 优先则消除了"official 请求为判路由而解压 body"的无谓开销。错误摘要中的 `[official]` 标签同理可由 URL 推导，删除以免 fallback 时指错方向。

### 📊 Change Stats
> 数据来自任务完成时抓取的 `git diff --stat`（+/- 合并计数；该轮改动与后续 WebSocket 放行轮次叠加在同一未提交工作区，精确拆分不可行）。

- **Files changed:** 5（另有 plugins/run-task-with-model 属于另一任务）
- **Combined line changes:** 约 320

| File | +/- 合计 |
| --- | ---: |
| `src/gateway.ts` | 85 |
| `src/request-log.ts` | 78 |
| `test/gateway.test.ts` | 131 |
| `src/realtime.ts` | 23 |
| `test/realtime.test.ts` | 3 |

### 📁 Files Modified
- `src/gateway.ts`
- `src/request-log.ts`
- `src/realtime.ts`
- `test/gateway.test.ts`
- `test/realtime.test.ts`
