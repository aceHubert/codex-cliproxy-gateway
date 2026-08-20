## [2026-08-17 23:37] | Task: 保护网关配置并支持版本同步

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 网关升级、卸载和重装不能整份替换用户的 `config.json`；配置版本与 `package.json` 保持一致，版本变化时只增加新配置，不删除旧配置，并通过 JSON Schema 告警配置错误。

### 🛠 Changes Overview
**Scope:** codex-cliproxy gateway config

**Key Actions:**
- **只增同步**: 非安装/卸载命令执行前比较包版本，版本不一致时递归补充缺失默认字段并保留全部现有字段。
- **配置保护**: 卸载保留 `config.json`，重装合并已有配置，失败时恢复原文件。
- **Schema 告警**: 写入 `$schema`，增加随包发布的 JSON Schema，并对已知错误输出 warning。
- **维护约束**: 在 `AGENTS.md` 中要求配置变更必须同步更新 Schema 和测试。
- **回归测试**: 覆盖版本同步、未知/废弃字段保留、Schema 告警和卸载保留配置。

### 🧠 Design Intent (Why)
升级不维护旧默认值，也不主动清理废弃字段。包版本是唯一同步标记；旧字段继续保留，由新版本运行时代码自然忽略。

### 📊 Change Stats
> 当前工作区在相关文件中已有未提交改动；以下统计是相关文件相对 Git 索引的完整差异，包含这些既有改动。

- **Files changed:** 8
- **Insertions:** +517
- **Deletions:** -47

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +2 | -0 |
| `README.md` | +32 | -4 |
| `package.json` | +1 | -0 |
| `schemas/gateway-config.schema.json` | +70 | -0 |
| `src/config.ts` | +106 | -0 |
| `src/cli.ts` | +161 | -42 |
| `src/types.ts` | +4 | -0 |
| `test/gateway.test.ts` | +141 | -1 |

### 📁 Files Modified
- `AGENTS.md`
- `README.md`
- `package.json`
- `schemas/gateway-config.schema.json`
- `src/config.ts`
- `src/cli.ts`
- `src/types.ts`
- `test/gateway.test.ts`
