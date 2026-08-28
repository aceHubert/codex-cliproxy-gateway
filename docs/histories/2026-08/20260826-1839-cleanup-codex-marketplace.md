## [2026-08-26 18:39] | Task: 清理 Codex marketplace 插件入口

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 当前项目的 Codex skills 配置里是否有残留；只处理当前项目，不处理其他位置。

### 🛠 Changes Overview
**Scope:** `.agents/plugins/marketplace.json`

**Key Actions:**
- **[清理]**: 移除 `run-task-with-model` 与 `vision-reader` 两个插件入口，使 Codex 不再从当前项目 marketplace 暴露这两个安装项。

### 🧠 Design Intent
当前项目的 Codex Skills 界面出现了这两个未安装插件入口，用户确认只需清理当前项目。保留插件源码目录与全局 marketplace 配置，只清空项目侧 Codex marketplace 的暴露入口，改动最小且可逆。

### 📊 Change Stats
> 数据来自 `git diff --shortstat / --numstat`（工作区未提交改动，仅统计本任务文件）。

- **Files changed:** 1
- **Insertions:** +1
- **Deletions:** -26

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.agents/plugins/marketplace.json` | +1 | -26 |

### 📁 Files Modified
- `.agents/plugins/marketplace.json`
