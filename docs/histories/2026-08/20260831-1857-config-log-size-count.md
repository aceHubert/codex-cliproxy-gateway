# [2026-08-31 18:57] | Task: 为 config 命令新增日志大小与数量上限

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 添加 config --max-log-size 和 --max-log-count 的设置，工作目录中的修改可以直接覆盖，写的有问题。

工作目录里遗留了一版未完成的 `maxRequestLogBytes` 实现：只改了运行时与 schema，`config` 命令没有接入任何新选项，且日志文件名被无条件改成 `-000.log` 后缀，破坏既有命名契约。按要求直接覆盖重写（`models.json` 的无关改动保留）。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（CLI `config` 命令 + 网关请求日志保留策略）

**Key Actions:**
- **[CLI]**: `config --max-log-size N`（字节数或 k/m/g 后缀，1024 进制，0=不限）与 `config --max-log-count N`（分组保留文件数，0=不限）落地；可与 `--log` 任意组合，任一变更都会写盘、审计并自动重启网关；无参数打印时输出 `maxLogSize`/`maxLogCount`。
- **[日志滚动]**: 重写大小限制逻辑：首段保持旧命名 `prefix+key.log`，写满后滚动到 `prefix+key.partNNN.log`；未启用限制时文件名与历史版本完全一致。定位末段改为一次 `readdirSync`，替代逐段 `existsSync` 递增探测。
- **[配置链路]**: `maxRequestLogBytes` 进入 `DEFAULTS`（缺省 0）、`AUDITED_FIELDS` 审计、`resolveLogSink` 与 CLI 侧 `configAuditSink`，错误摘要与配置审计同样受上限约束；schema 同步更新。

### 🧠 Design Intent (Why)
- 大小上限主要约束 WebSocket 会话日志（整会话单文件，可能无限增长）；HTTP 日志按秒滚动本来就很碎。滚动只在整条记录边界进行，单条超限时独占一段——内容永不截断，与“日志保留完整请求体用于排查”的既有测试语义一致。
- 分段命名用 `.partNNN` 而非统一 `-NNN` 后缀：`.part` 使分段在字典序上排在首段之后且随段号递增，`pruneGroup` 按文件名排序裁剪的语义（先删最旧）不被破坏；首段不改名，则未启用限制的用户与磁盘上的既有日志零感知。
- CLI 选项映射到既有字段：`--max-log-count` → `maxRequestLogs`（原已存在），`--max-log-size` → `maxRequestLogBytes`（本次新增），避免另起一套配置键。

### 📊 Change Stats
> 数据来自 `git diff --shortstat HEAD`（工作目录未提交改动，仅统计本次任务相关文件）。

- **Files changed:** 6
- **Insertions:** +250
- **Deletions:** -14

| File | +Added | -Removed |
| --- | ---: | ---: |
| `schemas/gateway-config.schema.json` | +5 | -0 |
| `src/cli.ts` | +64 | -7 |
| `src/gateway.ts` | +1 | -0 |
| `src/request-log.ts` | +60 | -6 |
| `src/types.ts` | +2 | -0 |
| `test/gateway.test.ts` | +118 | -1 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `src/types.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`

### ✅ Verification
- `bun run check`：类型检查、100 个测试（含新增 4 个：分段滚动不截断、单条超限独占一段、选项解析与非法输入拒绝、`runCli` 端到端持久化+审计+打印）、单文件构建全部通过。
