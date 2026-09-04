## [2026-09-04 12:15] | Task: 接入发布版本与签入检查工具

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 参考 aceHubert/ace-util，添加 Lerna、lerna-changelog、commitlint 和 yorkie，用于发布版本控制与签入检查；补充 npm 仓库、主页和自动部署、PR 标题、提交规范 Actions。

### 🛠 Changes Overview
**Scope:** 单包发布版本、PR changelog、Conventional Commits 签入检查、GitHub Actions 与发布文档

**Key Actions:**
- **[版本发布]**: 以 `packages: ["."]` 让 Lerna 管理根包，固定版本与 `package.json` 同步，并限制从 `main` 发版。
- **[变更日志]**: 在 Lerna 的 `version` 生命周期中运行 `lerna-changelog`，于 `lerna.json` 显式配置仓库和 `feat`、`bug`、`breaking` 标签，原子写入并更新同版本记录；首次无可达 tag 时从首个提交开始。
- **[签入检查]**: 使用 yorkie 安装 `commit-msg` hook，通过 commitlint conventional 配置拒绝不规范提交信息；增加 `cz-conventional-changelog-zh` 中文提交向导，并对齐其扩展类型。
- **[持续集成]**: PR 标题和 PR/主分支提交分别执行 Conventional Commit 检查，支持手动重跑，并将第三方 Action 固定到完整提交 SHA。
- **[自动部署]**: `main` 的有效代码推送串行执行检查、Lerna 升版、release commit/tag 和 npm OIDC 可信发布，文档与 CI-only 改动不触发发布。
- **[变更过滤]**: Action 触发器与 Lerna 版本检测同时忽略文档、测试、CI、发布脚本和未发布的工具配置，避免根包因非发布内容误升版。
- **[发布说明]**: 增加版本与 npm 发布命令、仓库和主页元数据、GitHub token 与 PR label 要求，并锁定新增开发依赖。

### 🧠 Design Intent (Why)
*当前仓库只有一个根包，因此不迁移源码、不制造额外 workspace；直接使用 Lerna 已支持的 rooted leaf 模式。发布拆成版本提交/tag 与从 tag 发布两步，npm 发布失败时可安全重试。*

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`（工作区相对 HEAD），仅统计本任务文件；已有的 `models.json` 改动未计入。

- **Files changed:** 12
- **Insertions:** +1739
- **Deletions:** -11

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.gitignore` | +2 | -1 |
| `README.md` | +20 | -6 |
| `bun.lock` | +1380 | -2 |
| `package.json` | +31 | -2 |
| `.github/workflows/check-pr-title.yml` | +33 | -0 |
| `.github/workflows/commitlint.yml` | +47 | -0 |
| `.github/workflows/deploy.yml` | +54 | -0 |
| `CHANGELOG.md` | +1 | -0 |
| `commitlint.config.cjs` | +26 | -0 |
| `lerna.json` | +33 | -0 |
| `scripts/changelog.ts` | +84 | -0 |
| `test/changelog.test.ts` | +28 | -0 |

### 📁 Files Modified
- `.gitignore`
- `README.md`
- `bun.lock`
- `package.json`
- `.github/workflows/check-pr-title.yml`
- `.github/workflows/commitlint.yml`
- `.github/workflows/deploy.yml`
- `CHANGELOG.md`
- `commitlint.config.cjs`
- `lerna.json`
- `scripts/changelog.ts`
- `test/changelog.test.ts`

### ✅ Verification
- `bun run check`：类型检查、108 个测试和 `dist/index.js` 构建全部通过。
- `lerna list --all --json`：识别根包 `codex-cliproxy-gateway@0.2.4`。
- 临时 Git 仓库执行 `lerna version patch --no-git-tag-version --no-push --ignore-scripts --yes`：`package.json` 与 `lerna.json` 均同步为 `0.2.5`。
- yorkie `commit-msg` hook：规范提交通过，非 Conventional Commit 提交被 commitlint 拒绝。
- `bun install --frozen-lockfile`：锁文件与 yorkie 信任配置校验通过。
- GitHub Actions YAML：三个工作流均可解析，且所有外部 Action 均固定为 40 位提交 SHA。
- `lerna list --all --json`：过滤规则生效后仍正确识别根包 `codex-cliproxy-gateway@0.2.4`。
- commitlint CI 等价输入：规范提交通过，非 Conventional Commit 提交被拒绝。
- `bun run commit`：成功加载 `cz-cli@4.3.2` 与 `cz-conventional-changelog-zh@0.0.2`，显示中文类型选择界面后取消，未创建提交。
- commitlint 扩展类型：`conflict`、`delete`、`font`、`stash` 均通过，与中文向导和 PR 标题检查一致。
- deploy 未执行真实 tag、Git push 或 npm publish；发布前需在 npm 配置绑定 `deploy.yml` 与 `production` 环境的 Trusted Publisher。
