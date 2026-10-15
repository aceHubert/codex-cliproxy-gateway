## [2026-10-15 19:21] | Task: GitHub Release 自动化（tag 事件 + 手动补充）与 $schema 版本锁定

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/opencode-zen-refresh-on-startup`（HEAD 已含 v0.12.3 发布提交）

### 📥 User Query
> action 还没创建呢。（承接本轮讨论定稿：PAT 推 tag 触发 Release workflow，附 `models.json` 与 `config.schema.json` 资产，支持手动输入 tag 补充；`$schema` 按安装版本指向对应 Release 资产。）

### 🛠 Changes Overview
**Scope:** CI workflow、发布输入判定、规范地址常量、测试。

**Key Actions:**
- 新增 `.github/workflows/github-release.yml`：`on: push: tags ["v*"]` 自动触发 + `workflow_dispatch` 手动输入 tag；检出目标 tag 提交，Release 已存在则 `gh release upload --clobber` 补充 `apps/gateway/models.json` 与 `apps/gateway/config.schema.json`，不存在则 `gh release create`（body 优先取 CHANGELOG 对应版本段落，为空回退 `--generate-notes`）；tag 经 `env` 传入脚本防注入，`git ls-remote` 先校验远端 tag 存在，同一 tag 的并发触发用 concurrency 组去重。
- `deploy.yml` checkout 换用 `${{ secrets.RELEASE_PAT || github.token }}`：配置 PAT 时 tag 以 PAT 推送、能触发下游 workflow；secret 缺失回退 GITHUB_TOKEN，发布主链路不受影响，并新增显式 `::warning::` 提示 Release 需手动 dispatch 补建。
- `apps/gateway/src/config.ts`：`GATEWAY_CONFIG_SCHEMA_URL` 由 raw main 固定地址改为 `releases/latest/download/config.schema.json`（曾评估按 `GATEWAY_CONFIG_VERSION` 锁定版本资产以严格匹配已安装版本，因存量版本与发布窗口期 404 隐患放弃）；schema `$id` 保持 raw main 仓内规范位置。`GATEWAY_CONFIG_VERSION` 的兜底由 `"unknown"` 改为校验失败回落 `"latest"`（版本缺失时引用方至少解析到最新口径，且不再有永久 "unknown" 的 configVersion 比较基准）。
- `scripts/release-version.ts` 的 `SHARED_PRODUCT_FILES` 纳入 `github-release.yml`，发布编排输入变更时强制八包同步发版；`test/release-version.test.ts` 正例 fixture 同步覆盖。
- `test/zcode-config.test.ts` 的 schema 地址断言改为「常量 = 最新 Release 资产 URL，`$id` = raw main 规范位置」双断言。

### 🧠 Design Intent (Why)
GitHub 对 `GITHUB_TOKEN` 推送的 tag 不触发下游 workflow，故 tag 必须以 PAT 推送才能事件驱动建 Release；手动 dispatch 触发点同时承担存量 tag（v0.12.1–v0.12.3）回填与资产补传。`$schema` 指向最新 Release 的 schema 资产，替代会随 main 漂移的 raw 地址；地址恒定可解析（回填一次存量 tag 的 Release 即生效），编辑器始终拿到已发布口径的 schema。按安装版本锁定 URL 的方案经评估后放弃：自动化上线前的存量版本无对应资产、每次发布后存在短暂 404 窗口。

### 📊 Change Stats
> 数据来自工作树未提交改动；与同日 schema 重命名批次（20261015-1913）叠加后累计 15 files、+34/-22。本任务独立增量如下。

- **Files changed:** 6（另有 3 个文件与重命名批次叠加为第二批 1–2 行改动）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.github/workflows/github-release.yml`（新增） | +50 | -0 |
| `.github/workflows/deploy.yml` | +10 | -0 |
| `apps/gateway/src/config.ts`（第二批增量） | +2 | -1 |
| `scripts/release-version.ts` | +1 | -1 |
| `test/release-version.test.ts`（第二批增量） | +1 | -1 |
| `test/zcode-config.test.ts`（第二批增量） | +2 | -2 |

### 📁 Files Modified
- `.github/workflows/github-release.yml`（新增）
- `.github/workflows/deploy.yml`
- `apps/gateway/src/config.ts`
- `scripts/release-version.ts`
- `test/release-version.test.ts`、`test/zcode-config.test.ts`

### ✅ Validation
- `bun run check` 全绿：边界检查、完整构建、严格类型检查与全部 1137 项测试通过（80 个文件，26.11s）。
- 手动核对 workflow 语法与既有 `deploy.yml`/`release-check.yml` 风格一致（action 版本、concurrency、permissions）。
- ⚠️ 上线前置条件（代码外）：仓库 Settings → Secrets 需新增 `RELEASE_PAT`（fine-grained PAT，仅本仓库，Contents: Read and write）；缺失时 Deploy 会打 warning 并回退 GITHUB_TOKEN，自动建 Release 失效但发布不受阻。
