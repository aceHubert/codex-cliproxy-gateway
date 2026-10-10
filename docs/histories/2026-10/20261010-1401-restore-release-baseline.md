## [2026-10-10 14:01] | Task: 恢复 0.8.0 发布基线

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-release-baseline`

### 📥 User Query
> tag 与 npm 已是 0.8.0，确认发布失败原因并修复后续发布。

### 🛠 Changes Overview
**Scope:** 根包版本管理与发布历史

**Key Actions:**
- 恢复 package.json 与 lerna.json 的 0.8.0 版本，以及已发布的 CHANGELOG。
- 通过保留当前树的合并，将 v0.8.0 发布提交重新纳入祖先链，避免旧业务代码与当前功能发生冲突。
- 启用 includeMergedTags，让 Lerna 的变更检测识别从合并历史恢复的发布 tag。

### 🧠 Design Intent (Why)
已有 v0.8.0 发布提交与 tag，但当前主分支历史未包含该提交，版本仍为 0.7.1。
自动发布再次计算出 0.8.0，因同名 tag 已存在而失败。
保留已发布的 tag 与 npm 包，恢复发布基线及祖先关系，让后续版本按新增提交递增。
保留当前业务代码、依赖锁文件和文档内容；不重新发布 0.8.0。

### ✅ Validation
- bun run check 通过：类型检查、831 项测试和构建成功，测试耗时 19.55 秒。
- CHANGELOG 与 v0.8.0 tag 中的内容一致，git diff --check 通过。
- 提交后核验 v0.8.0 是 HEAD 的祖先，且发布变更范围仅涉及版本、发布配置及 changelog。

### 📊 Change Stats
> 来自 git diff --shortstat 与 git diff --numstat；统计功能变更，不包含本历史记录。

- **Files changed:** 3
- **Insertions:** +11
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `CHANGELOG.md` | +8 | -0 |
| `lerna.json` | +2 | -1 |
| `package.json` | +1 | -1 |

### 📁 Files Modified
- `CHANGELOG.md`
- `lerna.json`
- `package.json`
- `docs/histories/2026-10/20261010-1401-restore-release-baseline.md`
