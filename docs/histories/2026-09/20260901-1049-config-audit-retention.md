## [2026-09-01 10:49] | Task: 修复配置审计日志被 maxRequestLogs 连坐裁剪

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 配置审计日志仍然被 maxRequestLogs 连坐裁剪——configAuditSink 把它原样传给了审计 sink，而 cliproxy-config-*.log 按秒滚动，我实测 maxRequestLogs=3 加 5 次配置变更后最早 2 条审计记录被永久删除。这跟 logConfigChange 注释声明的"关闭请求日志后仍能追溯配置变更"是冲突的。……改法很小：src/cli.ts:369 的 configAuditSink 里把 maxLogs 固定成 0。这个问题给我一个解决方案。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/cli.ts、src/request-log.ts、schemas、test）

**Key Actions:**
- **[CLI]**: `configAuditSink` 的 `maxLogs` 固定为 `0`，不再透传 `config.maxRequestLogs`；注释改为说明审计不参与裁剪的原因。
- **[注释/Schema]**: 同步修正两处与实现相悖的声明——`logConfigChange` 的 doc 注释去掉"同保留策略"，`gateway-config.schema.json` 中 `maxRequestLogs` 的描述明确"不影响配置审计日志"。
- **[测试]**: 新增回归用例 `config audit survives maxRequestLogs pruning and disabled request logging`：`requestLogging: false` + `maxRequestLogs: 2` 下预置 3 条历史审计文件，执行 `config --log on` 后断言 3 条全部存活且新审计含 `requestLogging: false -> true`。

### 🧠 Design Intent (Why)
* 审计日志每条配置变更一个文件、单条只有几行，增长量级可忽略，设为不限制（`maxLogs: 0` 即 `pruneGroup` 的免裁剪语义）没有磁盘风险；而沿用 `maxRequestLogs` 会让 `cliproxy-config-` 组与请求日志组同样被裁剪，违背 `logConfigChange` "关闭请求日志后仍能追溯配置变更"的承诺。上一任务（[20260901-0956](20260901-0956-config-max-request-logs.md)）已将该问题记为已知未决，本次按用户要求修复。
* 回归用例特意用 `--log on`（而非再改 `--max-request-logs`）触发审计：`recordConfigAudit` 用的是改后的配置，若把 `maxRequestLogs` 改大，bug 版本的裁剪阈值也随之变大，用例将无法暴露问题；固定改 `requestLogging` 才能保证 sink 的 `maxLogs` 恒为 2。
* 验证方式：先在修复后代码上跑通用例，再临时还原 `maxLogs` 透传确认用例失败（断言历史审计文件被删），最后恢复修复——测试确实钉住了该回归。

### ⚠️ 已知未决问题
- 无新增。上一任务记录的"审计被连坐裁剪"已由本次关闭。

### 📊 Change Stats
> 数据来自 `git diff --numstat`。工作树同时叠加上一任务（[20260901-0956](20260901-0956-config-max-request-logs.md)）的未提交改动，下表按本次任务的 hunk 归属拆分：`src/request-log.ts` 与 schema 会话开始时为干净文件，全部计入本次；`src/cli.ts`、`test/gateway.test.ts` 的文件级 numstat（+35/-9、+109/-0）含上一任务改动，表内只计本次 hunk。

- **Files changed:** 4
- **Insertions:** +57
- **Deletions:** -5

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +5 | -2 |
| `src/request-log.ts` | +2 | -2 |
| `schemas/gateway-config.schema.json` | +1 | -1 |
| `test/gateway.test.ts` | +49 | -0 |

### 📁 Files Modified
- `src/cli.ts`
- `src/request-log.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`

### ✅ Verification
- `bun run check`：类型检查、99 个测试（原 98 + 新增 1）、单文件构建全部通过。
- 临时还原 bug 验证：`bun test test/gateway.test.ts -t "config audit survives"` 在透传版本下失败（历史审计文件被删），修复版通过。
- `python3 -m json.tool schemas/gateway-config.schema.json`：schema JSON 合法（修正过一次替换块的缩进错位）。
