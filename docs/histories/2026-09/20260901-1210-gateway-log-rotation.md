## [2026-09-01 12:10] | Task: 网关日志超限改为时间戳备份滚动

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (builtin:zai-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 当超过限时，把 gateway-<时间戳>.log 备份，并写到新建的 gateway.log 内。

（承接上一任务：`config --max-log-size` 已落地，本任务把超限处理从"原地保尾截断"改为"滚动备份 + 新建文件"。）

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/request-log.ts、src/cli.ts、src/types.ts、schemas、test、README）

**Key Actions:**
- **[滚动]**: `capGatewayLog` 重写为滚动语义：`当前大小 + 即将写入字节 > maxBytes` 时，先把 `gateway.log` 原样 `rename` 为 `gateway-<秒级时间戳>.log`（复用 `fileStamp`，内容不截断），新内容写进新建的 `gateway.log`；新增 `incomingBytes` 参数让触发判定发生在写入之前，保证触发滚动的条目落在新文件里。删除原保尾截断实现（Buffer 切片 + 分隔符对齐）。
- **[备份保留]**: 新增 `pruneGatewayLogBackups`，按 `/^gateway-\d{14}\.log$/` 严格匹配（不误伤 `gateway.error.log`），字典序最旧先删，保留最新 `GATEWAY_LOG_BACKUPS = 5` 个；磁盘占用上限约为 6 × maxBytes。
- **[CLI/语义同步]**: `logConfigChange` 改为"先 `capGatewayLog` 再 append"；types.ts 注释、schema 描述、CLI help、README 同步改为滚动语义。
- **[测试]**: 单元用例重写为"超限滚动进时间戳备份、未超限不动、备份只留 5 个"；`--max-log-size` 端到端用例改为断言旧内容完整进入备份、新 gateway.log 只含审计条目。

### 🧠 Design Intent (Why)
* 用户明确要求超限时备份到 `gateway-<时间戳>.log` 并写新建文件，取代上一任务实现的保尾截断（截断会丢弃旧审计记录，滚动则完整保留）。
* 滚动触发改为写入前判定（`currentSize + incomingBytes > maxBytes`）：触发滚动的写入进入新文件，符合"写到新建的 gateway.log 内"的语义，也避免条目刚写入就被移进备份。
* 备份保留个数（5，常量）是本任务自行补充的必要约束：无上限的滚动只是把"单文件无限增长"换成"文件数无限增长"，大小上限失去意义；未做成配置项是避免为一个低频场景增加字段，如需调整再开放。
* 已知边界（代码注释记录）：滚动是 `rename`，运行中网关进程的 stdout 句柄仍指向旧 inode。`serve()` 的启动滚动发生在横幅写入之后、且网关运行期不再有 stdout 输出，故无实际影响；launchd 下次启动会重新打开新路径。
* 同秒内两次滚动会命中同一备份名（`rename` 覆盖），沿用 `fileStamp` 秒级精度的既有约定，滚动频率远低于每秒一次。

### ⚠️ 已知未决问题
- 无新增。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区相对 HEAD，含本会话前序未提交任务 20260901-0956/1049/1156 的重叠）。本任务相对上一任务（1156 后状态）的增量约为：`src/request-log.ts` 保尾实现替换为滚动（+30/-15）、`src/cli.ts` help 注释微调、schema/types 描述改写、两条测试重写（约 +45/-25）。`models.json` 为无关遗留改动，未计入。

- **Files changed:** 8（不含 models.json，含本任务新增的 package.json/bun.lock 依赖变更）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts` | +55 | -10 |
| `src/cli.ts` | +68 | -24 |
| `src/types.ts` | +2 | -0 |
| `schemas/gateway-config.schema.json` | +6 | -1 |
| `test/gateway.test.ts` | +209 | -5 |
| `README.md` | +4 | -3 |
| `package.json` / `bun.lock` | +12 | -0 |

### 📁 Files Modified
- `src/request-log.ts`
- `src/cli.ts`
- `src/types.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `README.md`
- `package.json`、`bun.lock`（bytes 依赖，上一任务引入，本任务沿用）

### ✅ Verification
- `bun run check`：类型检查、102 个测试、单文件构建全部通过。
- `python3 -m json.tool schemas/gateway-config.schema.json`：schema JSON 合法。
- 单元用例覆盖：超限滚动（旧内容完整入备份、gateway.log 移走待重建）、未超限含预留字节不滚动、7 个旧备份裁剪至 5 个且保留最新；端到端用例覆盖：`--max-log-size 1KB` 持久化、审计条目写入新文件、旧内容进备份、打印与非法输入拒绝。
