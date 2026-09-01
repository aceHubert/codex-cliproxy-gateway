## [2026-09-01 11:56] | Task: 配置审计并入 gateway.log，取消单文件审计日志

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把 cliproxy-config-*.log 日志放在网关日志中，不要有单文件的日志，内容太少，还影响 request logs 的统计。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/request-log.ts、src/cli.ts、schemas、test、README）

**Key Actions:**
- **[request-log]**: `logConfigChange` 签名由 `RequestLogSink` 改为 `logFile: string | undefined`，直接 `appendFileSync` 到目标文件，不再经过带 `pruneGroup` 的 `append`；删除按秒滚动的 `configAuditLogFile()`。条目格式不变（时间分隔符 + 命令 + 字段 diff），与网关启动横幅的时间分隔符约定一致。
- **[CLI]**: 删除 `configAuditSink`（连同上一任务的 `maxLogs: 0` 修复，被本方案取代）；`recordConfigAudit` 新增 `paths` 参数，审计统一写入 `paths.stdoutLog`（`~/.codex-cliproxy-gateway/gateway.log`，launchd StandardOutPath）；五个调用点（install、models --sync、config、config sync ×2）同步传入 `paths`。`cli.ts` 不再导入 `RequestLogSink`。
- **[Schema/README]**: `maxRequestLogs` 描述去掉审计例外说明（审计已不在 `logs/` 目录，恢复纯请求日志语义）；README 的审计落点描述由 `logs/cliproxy-config-*.log` 改为 `gateway.log`，并在进程日志段落注明 gateway.log 同时承载配置审计。
- **[测试]**: 三处读取审计的 helper 改读 `paths.stdoutLog` 单文件（gateway.test.ts 的 config sync prefill 用例、`--max-request-logs` 用例，model-catalog-dynamic.test.ts）；上一任务的裁剪存活用例重写为 `config audit appends to the gateway log without standalone log files`：断言条目落在 gateway.log 且 `logs/` 目录不再出现 `cliproxy-config-*` 文件。

### 🧠 Design Intent (Why)
* 用户指出按秒滚动的审计单文件内容过少、且混在 `logs/` 里影响 request logs 的文件统计。审计条目每次配置变更只有几行，合并进网关进程日志 `gateway.log`（launchd StandardOutPath）单文件追加即可，天然解决两个问题。
* 上一任务（[20260901-1049](20260901-1049-config-audit-retention.md)）的"审计不被 `maxRequestLogs` 裁剪"承诺在新方案下自动成立：审计不再走 `RequestLogSink`，与请求日志目录、分组统计、裁剪逻辑完全解耦，也不依赖 `requestLogging` 开关与 `logDir` 配置。
* CLI 与网关是两个进程但共享同一文件系统，双方对 gateway.log 都是小块 O_APPEND 追加，交错风险可忽略；条目沿用的 `--时间--` 分隔符与网关启动横幅一致，便于在同一文件内扫描。
* 行为变化（已接受）：`removeManagedRuntimeFiles` 在卸载时删除 gateway.log，审计轨迹随卸载清除——旧方案下审计文件在 `logDir` 中可幸存卸载；卸载本就清除 config/state/catalog，审计随之清除语义一致。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区相对 HEAD）。工作区叠加上两次未提交任务的改动（[20260901-0956](20260901-0956-config-max-request-logs.md)、[20260901-1049](20260901-1049-config-audit-retention.md)），`src/cli.ts`、`test/gateway.test.ts` 的数字含其重叠部分；`src/request-log.ts` 的 +11/-10 为本会话审计改造对 HEAD 的累计净效果（1049 的中间态已被本次重写覆盖）；`models.json` 为无关遗留改动，未计入。

- **Files changed:** 6（不含 models.json）
- **Insertions:** +57
- **Deletions:** -44

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts` | +11 | -10 |
| `src/cli.ts` | +39（含 0956/1049 重叠） | -22（含重叠） |
| `schemas/gateway-config.schema.json` | +1 | -1 |
| `test/gateway.test.ts` | +99（含重叠） | -4（含重叠） |
| `test/model-catalog-dynamic.test.ts` | +1 | -5 |
| `README.md` | +2 | -2 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/cli.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `README.md`

### ✅ Verification
- `bun run check`：类型检查、99 个测试、单文件构建全部通过（用例数不变：重写 1 条、适配 3 处 helper）。
- `python3 -m json.tool schemas/gateway-config.schema.json`：schema JSON 合法（修正过一次替换块缩进错位）。
- 回归用例双向验证沿用上一任务的方法论基础：新用例断言 gateway.log 收到 `requestLogging: false -> true` 且 `logs/` 无 `cliproxy-config-*` 残留。
