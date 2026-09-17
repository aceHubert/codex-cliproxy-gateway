## [2026-09-12 18:49] | Task: 请求日志保留改为全局按时间，并保护正在写入的会话文件

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `deepseek-v4.1-flash`
* **Runtime**: `ZCode Desktop (darwin)`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> "maxRequestLogs": 100 没有生效
>
> 改成不需要分组，就按时间排，但要排除正在写入的日志，例如ws是持续写入的

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/request-log.ts`、`src/gateway.ts`、`src/realtime.ts`、测试、schema、README）

**Key Actions:**
- **[request-log.ts]**: 保留策略由"按路由分组、每组各自 N 个"改成"整个日志目录按修改时间保留最新 N 个"。`LogFileRef.prefix`、`pruneGroup`、`logPrefixOf` 一并删除——分组概念不再存在。
- **[request-log.ts]**: 新增 `isRequestLogName(name)` 作为唯一的文件名判定，只用来回答"这个文件是不是请求日志"，同时挡住 `gateway.log`/`gateway.error.log` 与历史 `cliproxy-config-*.log`。
- **[request-log.ts]**: 新增进程内登记 `retainLogFile(dir, file) -> release`，`activeLogFiles` 中的文件（未结束的 WebSocket 会话）不参与裁剪。
- **[request-log.ts]**: `pruneLogDir(dir, maxLogs)` 改为按 `mtimeMs` 降序排序后删除多余项；写入路径上用 `sweepAfterWrite` 补偿扫描：上限 < 32 时每次写入都扫，≥ 32 时每 32 次写入扫一次。
- **[gateway.ts]**: 桥接 WebSocket 时登记会话文件，拨号失败、upgrade 失败、连接关闭三条路径都释放；`createGatewayHandler` 启动时仍补扫一次。
- **[realtime.ts]**: `RealtimeSocketData.releaseLog`，在 `close()` 里释放。
- **[schema/README]**: `maxRequestLogs` 描述与 README 保留策略段落同步为新的全局语义。

### 🧠 Design Intent (Why)
* 起因是用户看到 `logs/cliproxy-v1-alpha-http-*` 有 328 个文件、`maxRequestLogs` 明明写着 100。根因是旧实现只在"该分组再次被写入"时才裁剪，上限调小后不再有请求的分组永远不会被清理——同一个目录里仍在写入的 error / responses 分组都精确停在 100，说明裁剪逻辑本身没坏，坏的是触发时机与"分组"这个维度本身。
* 按用户要求去掉分组：保留计数按修改时间全局生效。代价是明确的——繁忙路由可以把安静路由的日志挤掉，这正是 [20260820-1410](../2026-08/20260820-1410-log-transport-and-session.md) 当初引入分组的理由。替代它的是"正在写入的文件不参与裁剪"：WebSocket 会把整条会话持续追加到同一个文件，旧实现靠分组隔离来保护它，新实现直接按"会话是否还开着"保护，比按前缀隔离更准确（同一个分组里既可能有活跃会话也可能有历史会话）。
* 必须排除正在写入的文件，不只是为了"别删掉有用的日志"：会话文件被删后进程仍握着原 inode 继续写，日志从目录里消失但磁盘不释放，排查时表现为会话中途凭空断档。
* 不在每次 `append` 全量扫描：realtime 逐帧写日志，历史上"每次写入 readdirSync 八千个文件"让 300 帧从 41ms 涨到 3461ms 并导致整块设计回退。新方案让目录本身被上限约束住，扫描成本随之上界化，再对 ≥ 32 的上限摊薄到每 32 次写入一次。
* 启动补扫保留下来：它让"改小上限 → 重启"立刻生效，正是用户最初的诉求场景。
* 保留 `isRequestLogName` 这道过滤（而不是把所有 `.log` 都当候选）有两个安全原因：`logDir` 被指向网关根目录时 `gateway.log` 由 launchd 持有句柄、被删会让运行中的进程写进已 unlink 的 inode；历史审计文件只有一份，删掉就无法追溯。

### 📊 Change Stats
> 工作区在本任务进行时还带有其它未提交的在途改动（同一批文件里的 `LogNamespace`/`upstreamRequestBody`/`upstream_type` 等），下表是 `git diff --numstat` 的文件级结果，包含那些不属于本任务的行。

- **Files changed:** 7
- **Insertions:** +1118
- **Deletions:** -189

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts` | +111 | -24 |
| `src/gateway.ts` | +220 | -84 |
| `src/realtime.ts` | +4 | -0 |
| `test/gateway.test.ts` | +536 | -52 |
| `test/realtime.test.ts` | +26 | -2 |
| `schemas/gateway-config.schema.json` | +27 | -5 |
| `README.md` | +194 | -22 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/gateway.ts`
- `src/realtime.ts`
- `test/gateway.test.ts`
- `test/realtime.test.ts`
- `schemas/gateway-config.schema.json`
- `README.md`

### ✅ Verification
- `bun run check`：typecheck + 240 个测试 + 构建通过。
- 新增/重写的用例：`maxRequestLogs keeps the newest files across the whole directory`（跨分组全局裁剪）、`maxRequestLogs is applied at startup without waiting for new writes`（启动即生效、进程日志与审计文件除外）、`maxRequestLogs never deletes a log file that is still being written`（登记期间豁免、释放后重新参与计数）、`isRequestLogName recognizes request logs and spares process logs`、`closing a WebSocket session releases its log file for retention`。
- 对真实 `~/.codex-cliproxy-gateway/logs` 只读 dry-run（`maxRequestLogs=100`）：638 个文件中 637 个是候选，保留最新 100、删除 537；`cliproxy-config-20260831153711.log` 不在候选内。
- **注意**：新代码生效后首次重启网关会真实删除上述 537 个历史文件（这正是新的全局上限语义，删除不可恢复）。重启瞬间登记表是空的，因此那一刻没有文件被豁免。
