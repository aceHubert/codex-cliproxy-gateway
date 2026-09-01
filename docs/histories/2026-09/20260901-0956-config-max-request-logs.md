# [2026-09-01 09:56] | Task: 移除日志大小上限并将日志数量选项改名为 --max-request-logs

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `claude-fable-5`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把 max-log-count 修改为 max-request-logs, 去掉 max-log-size

承接上一轮对工作区改动的代码审查。审查实测出分段滚动实现的三个问题（见下），用户据此判断不应该限制单个 request 日志的大小，改为只保留按分组的文件数上限，并要求 CLI 选项名与配置字段对齐。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（CLI `config` 命令 + 网关请求日志保留策略）

**Key Actions:**
- **[回退]**: `src/request-log.ts`、`src/gateway.ts`、`src/types.ts`、`schemas/gateway-config.schema.json` 整文件回退到 HEAD。这四个文件的改动全部依附于 `maxRequestLogBytes`，随分段滚动一起移除；日志文件命名回到 `prefix+key.log` 单文件语义。
- **[CLI]**: 删除 `--max-log-size`、`LOG_SIZE_UNITS` 与 `parseLogSize`；`--max-log-count` 改名为 `--max-request-logs`，解析函数相应改名为 `parseMaxRequestLogs`，错误信息与 help 文本同步。无参数打印的字段由 `maxLogSize`/`maxLogCount` 收敛为单个 `maxRequestLogs`，与配置字段同名。
- **[配置链路]**: `maxRequestLogBytes` 从 `DEFAULTS`、`AUDITED_FIELDS`、`configAuditSink` 中移除。本次净增量只剩“给已有配置字段 `maxRequestLogs` 加一个 CLI 开关”。

### 🧠 Design Intent (Why)
- 移除大小上限的直接依据是审查阶段实测复现的三个问题：定位末段需要在每次写日志时 `readdirSync` 整个日志目录，而 realtime 是逐帧写日志，目录累积到 8000 个文件时 300 帧耗时从 41ms 涨到 3461ms（83 倍）；分段会占用 `maxRequestLogs` 的文件名额，实测 `maxLogs=3` 下一条滚了 5 段的会话把同组其他三条会话日志全部挤掉；`pad(part, 3)` 在段号 ≥1000 后字典序失效，`pruneGroup` 会先删最新的段。三者都源于分段本身，移除后一并消失。
- 选项改名为 `--max-request-logs` 是为了让 CLI 选项、配置字段 `maxRequestLogs` 与打印输出三者同名，避免 `count`/`logs` 两套词汇。旧名 `--max-log-count` 会被 `COMMAND_OPTIONS` 校验拒绝并给出 `Unknown option` 提示，不会被静默忽略。
- 未给 `--max-request-logs` 增加下限检查：`parseMaxRequestLogs` 现有的 `/^\d+$/` 加 `Number.isSafeInteger` 已拒绝负数、小数、非数字与溢出值，而 `0`（不限制）和 `1`（只保留最近一条会话日志）都是合法语义，硬性下限会挡住正当用法。

### ⚠️ 已知未决问题
- 配置审计日志被 `maxRequestLogs` 连坐裁剪：`configAuditSink` 把 `config.maxRequestLogs` 原样传给审计 sink，而 `cliproxy-config-*.log` 按秒滚动。实测 `maxRequestLogs=3` 加 5 次配置变更后，最早 2 条审计记录被永久删除，与 `logConfigChange` 注释声明的“关闭请求日志后仍能追溯配置变更”相冲突。该问题在 HEAD 已存在，本次开放 CLI 开关后更易触发，用户未要求在本次一并修复。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`（工作目录未提交改动，仅统计本次任务相关文件；`models.json` 为无关的遗留改动，不计入）。

- **Files changed:** 2
- **Insertions:** +90
- **Deletions:** -7

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +30 | -7 |
| `test/gateway.test.ts` | +60 | -0 |

### 📁 Files Modified
- `src/cli.ts`
- `test/gateway.test.ts`
- `src/request-log.ts`（回退至 HEAD，最终无净改动）
- `src/gateway.ts`（回退至 HEAD，最终无净改动）
- `src/types.ts`（回退至 HEAD，最终无净改动）
- `schemas/gateway-config.schema.json`（回退至 HEAD，最终无净改动）

### ✅ Verification
- `bun run check`：类型检查、98 个测试、单文件构建全部通过。测试数由 100 降至 98——删除两条分段滚动用例，`parseLogSize`/`parseLogCount` 两组解析断言合并为一条 `--max-request-logs` 用例，端到端用例收敛为只测 `--max-request-logs` 的持久化、审计与写盘前校验。
- `bun run dev --help`：Config 段落只列出 `--max-request-logs`。
- `bun run dev config --max-log-count 20`：报 `Unknown option --max-log-count for command "config"`。
- `bun run dev config --max-request-logs 1.5`：报 `--max-request-logs expects a non-negative integer, got "1.5"`，且本机 `~/.codex-cliproxy-gateway/config.json` 未被改动。
