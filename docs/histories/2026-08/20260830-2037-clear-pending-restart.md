## [2026-08-30 20:37] | Task: 修复网关重启状态残留

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 修复成功执行 restart 后未清除 pendingRestart 的评审问题。

### 🛠 Changes Overview
**Scope:** CLI 网关进程控制

**Key Actions:**
- **[统一重启路径]**: `controlGateway("restart")` 复用 `restartGatewayOnce`，成功健康检查后清除 `pendingRestart`。
- **[避免重复探活]**: 仅 `start` 分支单独等待健康检查，`restart` 使用共享函数内的检查。

### 🧠 Design Intent (Why)
复用现有重启状态机，避免手工清理标记与共享逻辑漂移。

### 📊 Change Stats
> 数据来自本次任务的工作区差异。

- **Files changed:** 2
- **Insertions:** +39
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +2 | -2 |
| `docs/histories/2026-08/20260830-2037-clear-pending-restart.md` | +37 | -0 |

### 📁 Files Modified
- `src/cli.ts`
- `docs/histories/2026-08/20260830-2037-clear-pending-restart.md`
