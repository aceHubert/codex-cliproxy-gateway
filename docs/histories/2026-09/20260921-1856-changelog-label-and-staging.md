## [2026-09-21 18:56] | Task: 修复发布 changelog 标签映射与提交遗漏

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/changelog-release`

### 📥 User Query
> 排查为什么打包 0.7.1、0.6.1 这类 fix 版本会报错，而 0.7.0 不报错；确认原因后把 lerna 标签改成 `feature`，并让 changelog 被一起提交。

### 🛠 Changes Overview
**Scope:** release / changelog

**Key Actions:**
- **[标签映射]**: `lerna.json` 的 `changelog.labels` 键由 `feat` 改为仓库实际标签名 `feature`，避免 `feature` 标签的 PR 被静默丢弃。
- **[提交遗漏]**: `scripts/changelog.ts` 新增 `stageChangelog`，在写回 `CHANGELOG.md` 后显式 `git add`，使文件进入 lerna 的 release commit。
- **[回归测试]**: 新增用例在临时仓库中验证 `stageChangelog` 确实把 `CHANGELOG.md` 放入暂存区。

### 🧠 Design Intent (Why)
*发布失败并非 fix 版本号导致。lerna 只提交它自己记录的变更文件，而 `changelog: false` 使其不包含 `CHANGELOG.md`；该文件由 `version` 生命周期脚本改写后残留为脏文件，导致 `lerna publish from-git` 报 `EUNCOMMIT`。同时 `lerna-changelog` 按 PR 的 GitHub 标签过滤条目，配置键 `feat` 与仓库标签 `feature` 不匹配，使 0.7.0 区间输出为空、文件内容未变化，才侥幸通过。标签键对齐负责让条目真正生成，显式暂存负责让内容进入发布提交。*

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`，只统计本次任务相关改动。

- **Files changed:** 3
- **Insertions:** +58
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `lerna.json` | +2 | -2 |
| `scripts/changelog.ts` | +14 | -0 |
| `test/changelog.test.ts` | +42 | -1 |

### 📁 Files Modified
- `lerna.json`
- `scripts/changelog.ts`
- `test/changelog.test.ts`
