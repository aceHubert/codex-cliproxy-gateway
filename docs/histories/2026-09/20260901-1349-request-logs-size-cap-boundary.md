## [2026-09-01 13:49] | Task: 钉住请求日志不受 --max-log-size 控制的边界

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> request 不受 max-size 控制，只控制数据就好了。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（仅测试）

**Key Actions:**
- **[测试]**: 新增 `request logs are unaffected by the gateway log size cap`：`maxGatewayLogBytes = 1` 的极小上限下走一次完整请求，断言请求日志（headers、payload、response body）完整写入、不被截断或滚动。`test/gateway.test.ts` 导入 `GatewayConfig` 类型以给 `logTestConfig` 结果标注。

### 🧠 Design Intent (Why)
* 用户明确要求 `--max-log-size` 只约束 gateway.log（进程日志与审计数据），请求日志完全不参与大小控制。核查确认现实现已满足：`maxGatewayLogBytes`/`capGatewayLog` 的全部调用点只指向 `paths.stdoutLog`，请求日志链路（`resolveLogSink`/`logExchange`/`logGatewayError`）只消费 `maxRequestLogs` 的按组文件数。本任务不改运行时代码，只补一条边界测试防止将来被误接回（2026-08-31 的旧版 `--max-log-size` 曾作用于请求日志并因分段滚动问题被整体回退，见 [20260831-1857](../2026-08/20260831-1857-config-log-size-count.md)、[20260901-0956](20260901-0956-config-max-request-logs.md)）。
- 首版断言误按完整 URL 匹配，实际请求日志记录的是路径（`=== POST /v1/responses ===`），修正后通过；失败输出同时印证了日志内容在极小上限下完整无缺。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
> 数据来自 `git diff --numstat`。`test/gateway.test.ts` 的 +236/-5 为工作区累计（含前序未提交任务的重叠），本任务净增约 +25（1 条用例与 1 行类型导入）。

### 📁 Files Modified
- `test/gateway.test.ts`

### ✅ Verification
- `bun run check`：类型检查、103 个测试（+1）、单文件构建全部通过。
