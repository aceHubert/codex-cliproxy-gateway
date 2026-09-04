## [2026-09-04 15:28] | Task: 调整 Action 发布检查

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-action-release-checks`

### 📥 User Query
> deploy Action 不运行依赖本机环境的测试；Action `uses` 直接使用版本标签，不使用提交 ID。

### 🛠 Changes Overview
**Scope:** GitHub Actions 与发布生命周期

**Key Actions:**
- **[发布检查]**: deploy 使用专用环境变量让 `preversion` 和 `prepack` 仅执行类型检查与构建，本地发布仍运行完整检查。
- **[Action 版本]**: checkout、setup-node、setup-bun 和 PR 标题检查改用精确版本标签。

### 🧠 Design Intent (Why)
*Actions 环境无法满足依赖本机状态的测试，因此只跳过 deploy 发布链路中的测试，不改变本地质量检查。*

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`，排除已有的 `models.json` 改动和本历史文件。

- **Files changed:** 4
- **Insertions:** +12
- **Deletions:** -9

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.github/workflows/check-pr-title.yml` | +1 | -1 |
| `.github/workflows/commitlint.yml` | +3 | -3 |
| `.github/workflows/deploy.yml` | +5 | -3 |
| `package.json` | +3 | -2 |

### 📁 Files Modified
- `.github/workflows/check-pr-title.yml`
- `.github/workflows/commitlint.yml`
- `.github/workflows/deploy.yml`
- `package.json`

### ✅ Verification
- 模拟 deploy 环境运行 `CODEX_CLIPROXY_SKIP_TESTS=1 bun run release:check`：只执行类型检查和构建，未运行测试。
- 本地运行 `bun run release:check`：108 项测试、类型检查和构建全部通过。
- 三个工作流 YAML 均可解析，且 `uses` 不再包含 40 位提交 SHA。
