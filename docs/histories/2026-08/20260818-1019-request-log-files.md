## [2026-08-18 10:19] | Task: 恢复按请求文件日志

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 恢复请求日志按时间戳文件写入，并给 gateway.log、gateway.error.log 增加时间分隔，去除错误日志空行。

### 🛠 Changes Overview
**Scope:** codex-cliproxy gateway

**Key Actions:**
- **请求日志**: 恢复写入 `logs/cliproxy-{timestamp}.log`，不再输出到进程标准输出。
- **进程日志**: 每次网关启动在 `gateway.log` 中输出 `--ISO时间--` 分隔行。
- **错误日志**: 在统一错误出口增加相同时间分隔，并过滤错误文本中的空白行。
- **配置同步**: 恢复 `logDir` 路径、类型、默认值和 JSON Schema 定义。
- **验证**: 恢复按文件读取的回归测试，并完成类型检查、全量测试与构建。

### 🧠 Design Intent (Why)
将请求明细、进程日志和错误日志分离，用统一时间分隔提高诊断可读性，并避免空行拉长错误记录。

### 📊 Change Stats
> 基于本任务补丁统计；重叠文件中的既有未提交改动不计入本任务。

- **Files changed:** 9
- **Insertions:** +119
- **Deletions:** -18

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +7 | -3 |
| `schemas/gateway-config.schema.json` | +5 | -1 |
| `src/cli.ts` | +9 | -1 |
| `src/gateway.ts` | +17 | -4 |
| `src/index.ts` | +2 | -3 |
| `src/paths.ts` | +1 | 0 |
| `src/types.ts` | +2 | 0 |
| `test/gateway.test.ts` | +22 | -6 |
| `docs/histories/2026-08/20260818-1019-request-log-files.md` | +54 | 0 |

### 📁 Files Modified
- `README.md`
- `schemas/gateway-config.schema.json`
- `src/cli.ts`
- `src/gateway.ts`
- `src/index.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/gateway.test.ts`
- `docs/histories/2026-08/20260818-1019-request-log-files.md`
