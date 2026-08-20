## [2026-08-18 17:53] | Task: 明确立即刷新模型的恢复要求

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 明确 `--restart-codex` 的帮助文案；保留现有周期刷新提示。

### 🛠 Changes Overview
**Scope:** CLI 帮助文本

**Key Actions:**
- **说明用途**: 明确该选项通过停止 app-server 让模型立即刷新。
- **说明副作用**: 提示活动任务可能报错，需要恢复或重新打开。

### 🧠 Design Intent (Why)
默认同步会等待 Codex 周期刷新；该选项仅用于立即生效，并可能中断当前任务。

### 📊 Change Stats
> 相对修改前工作区的本次任务统计。

- **Files changed:** 1
- **Insertions:** +2
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +2 | -1 |

### 📁 Files Modified
- `src/cli.ts`
