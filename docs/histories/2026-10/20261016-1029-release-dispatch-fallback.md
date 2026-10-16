## [2026-10-16 10:29] | Task: 未配置发布 PAT 时自动触发 GitHub Release

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6（宿主未提供具体型号）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/catalog-update`

### 📥 User Query
> 根据是否配置 secrets.RELEASE_PAT，决定 Deploy 是否主动触发 GitHub Release，并可靠判断本次是否生成了新标签。

### 🛠 Changes Overview
**Scope:** GitHub Actions 发布流程。

**Key Actions:**
- 为 Deploy 增加 `actions: write` 权限，以非敏感布尔环境变量记录 PAT 是否存在，替换原有缺少 PAT 时需手动补建的警告。
- 在 `release:version` 前后比较 HEAD，没有新版本提交时不输出标签；有新提交时读取 fixed version，并校验对应 `v*` 标签确实指向本次提交，兼容带注释标签。
- npm 发布成功后，仅在 PAT 缺失且本次生成有效标签时，用内置 `github.token` 调用 `github-release.yml` 的 `workflow_dispatch`，传入本次标签。

### 🧠 Design Intent (Why)
`GITHUB_TOKEN` 推送标签不会触发另一个工作流的 push 监听，但允许显式触发 workflow_dispatch。PAT 存在时保留标签事件触发；缺失时自动补发 dispatch。标签由 `release:version` 创建，`release` 仅发布已有标签对应的包，因此不能仅凭发布命令成功或上次版本号判断有新标签。

### 📊 Change Stats
> 来自 `git diff --shortstat -- .github/workflows/deploy.yml` 与 `git diff --numstat -- .github/workflows/deploy.yml`；仅统计本次工作流变更，不含本历史记录与原有未跟踪计划。

- **Files changed:** 1
- **Insertions:** +22
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.github/workflows/deploy.yml` | +22 | -8 |

### 📁 Files Modified
- `.github/workflows/deploy.yml`
- `docs/histories/2026-10/20261016-1029-release-dispatch-fallback.md`

### ✅ Validation
- `bun run check` 通过：边界检查、构建、类型检查及全部 1144 项测试（80 个文件，测试耗时 26.20 秒）。
- 解析实际 YAML 并提取版本步骤，在临时 Git 仓库中验证：无新版本、新版本带注释标签、缺少标签、标签指向旧提交、版本命令失败。
- 核对 PAT 条件、权限、npm 发布与 dispatch 的步骤顺序，并以模拟 gh 验证命令参数；独立只读复核未发现阻断问题。
- `git diff --check` 通过；未调用真实发布或远端工作流，远端触发需在改动进入 main 后验证。
