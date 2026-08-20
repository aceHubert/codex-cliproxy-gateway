## [2026-08-18 16:38] | Task: 修复中文系统下 app-server 漏检

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 执行模型同步后提示：`No matching current-user Codex app-server process was found.`

### 🛠 Changes Overview
**Scope:** macOS process discovery

**Key Actions:**
- **稳定进程输出**: 调用 `/bin/ps` 时强制 `LC_ALL=C`，避免中文 locale 下的启动时间格式破坏解析。

### 🧠 Design Intent (Why)
macOS 会按 locale 输出 `lstart`；中文格式无法匹配原有英文日期正则，导致真实 Codex app-server 被过滤为空。`LC_ALL=C` 固定解析格式，不改变进程匹配范围。

### 📊 Change Stats
> 相对 Git 索引的本次修正统计；`dist/index.js` 已本地重建但不由 Git 跟踪。

- **Files changed:** 1
- **Insertions:** +1
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/app-server.ts` | +1 | -0 |

### 📁 Files Modified
- `src/app-server.ts`
