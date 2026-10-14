## [2026-10-14 11:30] | Task: 合并前补齐旧迁移根目录链接边界

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-artifact-boundary`

### 📥 User Query
> 先把 codex/fix-plugin-artifact-boundary 提 PR 合并到 main，之后重新统计检查合并问题。

### 🛠 Changes Overview
**Scope:** 默认目录迁移实现、迁移回归测试及已归档计划。

**Key Actions:**
- **[准备检查]**: 在读取旧配置、状态前用 lstat 检查旧目录根，缺失或符号链接跳过，非目录明确报错。
- **[应用检查]**: 写入新目录前重新检查旧根为真实目录，拒绝准备后被替换成符号链接的情况。
- **[测试]**: 补充有效外部目录链接、损坏配置/状态的链接根、悬空根链接，以及准备后替换根链接的回归，验证不创建目标、不复制外部文件且保留原内容。
- **[文档]**: 在迁移计划中明确根目录链接检查边界。

### 🧠 Design Intent (Why)
整目录迁移已跳过树内源链接，但原实现使用 stat/readdir 处理源根，会跟随根链接读取配置并复制链接目标。把根检查提前至准备阶段，并在应用前复查，可使根路径遵守相同的源符号链接跳过合同。

### ✅ Validation
- 原分支 `bun run check`：990 项测试通过。
- 补充修复后的迁移专项：24 项测试通过，0 失败；测试进程上限 60 秒。
- 独立审查发现根链接边界并在修复后复核通过。
- 补充修复后的 `bun run check` 通过：边界检查、构建、严格类型检查及 72 个测试文件的 993 项测试全部通过，0 失败。
- `git diff --check` 通过；未运行真实安装或读取本机凭据。

### 📊 Change Stats
> 来自本次修复相对分支 HEAD 的 `git diff --shortstat` 和 `git diff --numstat`，不包含本历史记录自身。

- **Files changed:** 3
- **Insertions:** +68
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/default-install-migration.ts` | +8 | -1 |
| `docs/exec-plans/completed/migration-directory.md` | +1 | -0 |
| `test/default-install-migration.test.ts` | +59 | -0 |

### 📁 Files Modified
- `apps/gateway/src/default-install-migration.ts`
- `docs/exec-plans/completed/migration-directory.md`
- `test/default-install-migration.test.ts`
- `docs/histories/2026-10/20261014-1130-migration-root-link-guard.md`
