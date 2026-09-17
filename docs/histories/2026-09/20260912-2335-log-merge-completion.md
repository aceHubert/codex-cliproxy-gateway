# [2026-09-12 23:35] | Task: 日志合并与 maxRequestLogs 修复（接手收尾与联合验收）

## 🤖 Execution Context
* **Agent ID**: `ZCode`（原任务由并行会话 `sess_5de96141-003f-4523-aec1-0144b1d79ede` 执行，本会话经交接胶囊接手未竟部分并联合验收）
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query
> maxRequestLogs 配置未生效（原始 bug）。要求拆分请求日志与进程日志关注点、stderr 并入单一 `gateway.log`。原会话完成核心重构后在文档更新前中断；用户指示「继续完成日志合并未完成的工作然后一起验收，有没有影响到当前任务中的文件修改」。

## 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（日志子系统）

**Key Actions（原会话，已收敛全绿）:**
- **[模块拆分]**: 新建 `src/process-log.ts`（`capGatewayLog`、`appendProcessLog`、`logConfigChange`、`logGatewayError`、`logRequestSummary`、`GATEWAY_LOG_BACKUPS=5`）；`request-log.ts` 仅保留请求分组日志。
- **[滚动]**: copy-truncate 保 inode（launchd 持有 stdout/stderr 句柄）；写入前按 maxBytes（含本次字节）滚动。
- **[每请求一行摘要]**: 成功 `-> <status> (Nms)` 指明上游；失败 `!!!` 摘要进 `gateway.log` + 完整 exchange 进 route log；426 只算摘要。
- **[maxRequestLogs]**: 全目录按 mtime 保留最新 N 个，`isRequestLogName` 豁免进程日志与配置日志，跳过正在写入的文件（原始 bug 的修复）。
- **[stderr 合并]**: launchd stdout/stderr 同指 `gateway.log`；旧 `gateway.error.log` 仅作 `LEGACY_STDERR_LOG` 供卸载清理。
- **[processLog 注入]**: `serve` 构造 `{ file, maxBytes }` 作为 `startGateway`/`createGatewayHandler` 独立末位参数；zcode 经 `ZcodeDependencies.processLog` 注入。

**Key Actions（本会话接手）:**
- **[残留文案]**: `cli.ts` 的 `--max-request-logs`/`--max-log-size` 帮助文案更新为新语义（移除 `gateway.error.log`）；README 目录树移除 `gateway.error.log` 并标注 `gateway.log` 单一进程日志职责；README 日志段落重写（stdout+stderr 同文件、每请求一行摘要、错误摘要、单文件封顶、legacy 文件仅卸载清理）。
- **[冒烟确认]**: 预置 gateway.log/备份/配置日志与旧请求日志后连写 6 条，断言只剩最新 3 条、豁免文件全保留（SMOKE PASS）。
- **[清理]**: 删除原会话遗留的 `/tmp/audit-probe.ts`。

## 🧠 Design Intent (Why)
请求日志（排障用的完整 exchange）与进程日志（运维扫读的线性流水）是两类读者；stderr 独立文件在 copy-truncate 下曾有句柄失效史。合并为单一 `gateway.log`（stdout/stderr/配置审计/请求摘要）+ 独立 route logs 后，「哪里出错」一处可见且只受一个大小上限约束；maxRequestLogs 的原始 bug（分组语义下裁剪不生效）随全目录 mtime 语义一并修复。

## 📊 Change Stats
> 基线为本日晚些时候的暂存快照；下表为日志合并任务文件的本轮未暂存增量。`src/zcode.ts`、`README.md`、`test/zcode-gateway.test.ts` 与并行执行的「端点动态重映射」任务共享，已在 [该任务历史](20260912-2215-zcode-endpoint-routing.md) 计入，不重复统计。

- **Files changed:** 10（含新文件 `src/process-log.ts`）
- **Insertions:** +378
- **Deletions:** -235

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/process-log.ts`（新增，178 行；未暂存增量 +159） | +159 | -11* |
| `src/request-log.ts` | +5 | -160 |
| `src/gateway.ts` | +38 | -14 |
| `src/cli.ts` | +24 | -23 |
| `test/gateway.test.ts` | +113 | -11 |
| `test/realtime.test.ts` | +10 | -6 |
| `src/types.ts` | +14 | -4 |
| `src/launchd.ts` | +5 | -5 |
| `src/paths.ts` | +7 | -1 |
| `src/realtime.ts` | +3 | -0 |

*`process-log.ts` 为新文件，"-11" 来自其在快照基线后的追加修改轮次。

## 📁 Files Modified
- `src/process-log.ts`、`src/request-log.ts`、`src/gateway.ts`、`src/cli.ts`、`src/types.ts`、`src/launchd.ts`、`src/paths.ts`、`src/realtime.ts`
- `test/gateway.test.ts`、`test/realtime.test.ts`、`README.md`（目录树与日志段落）

## 🧪 Validation
- 原会话收敛态：`bun run check` 257 项测试 0 失败（含新增的进程日志/摘要/封顶用例）。
- 本会话联合验收：残留文案修正后全量复跑通过；maxRequestLogs 冒烟 SMOKE PASS（6 写留 3、豁免文件全保留）；`/tmp/audit-probe.ts` 已清理。
- 影响核对：并行「端点动态重映射」任务的文件（`zcode-endpoint-routing.ts` 及其测试、`zcode.ts` 重映射接线、`test/zcode-gateway.test.ts` 集成用例、README ZCode 段落）全部完好，详见该任务历史。
