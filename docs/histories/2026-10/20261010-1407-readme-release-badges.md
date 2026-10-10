## [2026-10-10 14:07] | Task: 添加 README 发布徽章

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 在 README 中增加 Deploy 和 npm version 的 badge。

### 🛠 Changes Overview
**Scope:** 项目 README

**Key Actions:**
- 标题下添加 main 分支的 Deploy 工作流状态徽章，点击进入工作流页面。
- 添加 npm 当前发布版本徽章，点击进入 npm 包页面。

### 🧠 Design Intent (Why)
让读者在项目首页直接查看发布状态与最新 npm 版本，版本由徽章服务自动更新。

### ✅ Validation
- 核对仓库、工作流路径、分支和 npm 包名，git diff --check 通过。
- 仅修改 README 与历史文档，符合 Deploy 的 paths-ignore，不触发版本发布。

### 📊 Change Stats
> 来自 git diff --shortstat 与 git diff --numstat；统计 README 改动，不包含本记录。

- **Files changed:** 1
- **Insertions:** +3
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +3 | -0 |

### 📁 Files Modified
- `README.md`
- `docs/histories/2026-10/20261010-1407-readme-release-badges.md`
