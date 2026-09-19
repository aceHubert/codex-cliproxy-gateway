## [2026-09-18 17:14] | Task: 将 README 整理为用户使用手册

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 在 AGENTS.md 中明令禁止将代码解读写进 README.md；新增命令只补充简单使用简介。重新整理 README.md，明确它是用户使用手册。

### 🛠 Changes Overview
**Scope:** 仓库文档。

**Key Actions:**
- **文档边界**：在 AGENTS.md 中明确 README 面向用户，禁止追加源码结构、协议转换、缓存机制等实现解读；新增命令只需用途、必要参数和最小示例。
- **用户手册**：用简体中文按安装、选模、Web 界面、配置、服务管理、手动运行和常见问题重新组织 README，移除开发发布流程和内部实现说明。
- **操作提醒**：保留平台限制、仅上游模式、登录要求、重启影响及日志限制等用户实际需要的信息，补充 serve 的简短用法。

### 🧠 Design Intent (Why)
让用户能直接找到操作步骤，避免使用手册随每次实现变更不断堆积技术细节。开发约束、设计和变更记录分别留在 AGENTS.md 与 docs 中维护。

### 📊 Change Stats
> 基线为任务开始时的暂存区；已有业务改动均已暂存。以下来自 `git diff --shortstat -- AGENTS.md README.md` 与 `git diff --numstat -- AGENTS.md README.md`，仅统计本任务正文修改，不含本历史记录。

- **Files changed:** 2
- **Insertions:** +196
- **Deletions:** -522

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +7 | -0 |
| `README.md` | +189 | -522 |

### 📁 Files Modified
- `AGENTS.md`
- `README.md`
- `docs/histories/2026-09/20260918-1714-readme-user-manual.md`

### ✅ Validation
- 对照 CLI 命令帮助核对 README 的命令和参数，并进行独立只读复核。
- `git diff --check` 通过。
- README 中 Bash 示例经 `bash -n` 语法检查通过，未执行安装、配置或卸载操作。
- Markdown 代码块闭合及本地配置格式链接检查通过。
- 本次仅修改文档，未运行业务测试或构建。
