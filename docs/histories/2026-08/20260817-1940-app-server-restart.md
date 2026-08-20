## [2026-08-17 19:40] | Task: 实现 app-server restart 逻辑

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 根据重启策略文档，实现 app-server restart 逻辑；真实停止验收由用户手动执行。

### 🛠 Changes Overview
**Scope:** CLI 模型目录同步与 Codex app-server 进程控制

**Key Actions:**
- **安全停止**: 精确识别当前用户的 Codex app-server，停止前复核 PID、启动时间、可执行文件和 argv。
- **显式接入**: 新增 `models --sync --restart-codex`，未显式传参时只提示，不发送信号。
- **结果与测试**: 仅报告 `stopped`、`surviving`、`failed`，覆盖身份变化、枚举失败和共享等待期。

### 🧠 Design Intent (Why)
模型目录在 app-server 启动时载入。实现只负责在明确同意后停止旧进程，不主动拉起新进程，也不将停止结果描述为重启完成。

### 📊 Change Stats
> 统计实现、测试、README 和执行计划，不包含本历史文件。

- **Files changed:** 5
- **Insertions:** +550
- **Deletions:** -4

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/app-server.ts` | +366 | -0 |
| `src/cli.ts` | +30 | -3 |
| `test/app-server.test.ts` | +106 | -0 |
| `README.md` | +2 | -1 |
| `docs/exec-plans/completed/app-server-restart.md` | +46 | -0 |

### 📁 Files Modified
- `src/app-server.ts`
- `src/cli.ts`
- `test/app-server.test.ts`
- `README.md`
- `docs/exec-plans/completed/app-server-restart.md`
