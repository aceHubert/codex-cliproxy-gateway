## [2026-09-20 15:46] | Task: 修复发布链路 Bun 类型检查失败

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `not disclosed`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-ci-bun-types`

### 📥 User Query
> GitHub Actions 发布任务在 `preversion` 的 `tsc --noEmit` 阶段报 `bun-types` 中 `TextEncoderEncodeIntoResult`、`ConnectionOptions`、`KeyObject`、`TLSSocket` 相关错误。

### 🛠 Changes Overview
**Scope:** 发布依赖与 changelog 工具链

**Key Actions:**
- **[类型依赖]**: 显式固定 `@types/node@26.4.1`，避免 `bun-types@1.4.2` 的 `@types/node: "*"` 在发布环境解析到不兼容的 22.x 类型包。
- **[发布链路]**: `lerna-changelog` 改用 `bunx --no-install` 执行，禁止 changelog 阶段隐式安装或重算依赖，防止发布提交意外漂移 `bun.lock`。
- **[PR 质量门]**: 新增 `Release check` workflow；PR 指向 `main` 时先执行 `bun ci` 与完整 `release:check`，避免类型或构建问题等到 merge 后的 Deploy 才暴露。
- **[回归测试]**: 更新 changelog 参数测试，锁定 `--no-install` 行为。

### 🧠 Design Intent (Why)
*上游 Bun 仓库 PR #42873 已确认 `bun-types@1.4.2` 与 `@types/node@22/24` 的模块声明布局不兼容；此前发布提交把锁文件从 `@types/node@26.4.1` 重算到 `22.20.3`，触发本项目未开启 `skipLibCheck` 时的四个依赖声明错误。固定已知兼容的 Node 类型版本可恢复严格库检查；`--no-install` 则消除发布期锁文件漂移源头。*

### 📊 Change Stats
> 数据来自本次任务相关代码变更，不含本历史记录。

- **Files changed:** 5
- **Insertions:** +42
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `bun.lock` | +7 | -2 |
| `.github/workflows/release-check.yml` | +31 | -0 |
| `package.json` | +1 | -0 |
| `scripts/changelog.ts` | +2 | -1 |
| `test/changelog.test.ts` | +1 | -0 |

### 📁 Files Modified
- `bun.lock`
- `.github/workflows/release-check.yml`
- `package.json`
- `scripts/changelog.ts`
- `test/changelog.test.ts`

### ✅ Verification
- `bun ci`（前后 `bun.lock` 哈希一致）
- `bun run typecheck`
- `bun test test/changelog.test.ts`
- `bun run check`（460 个测试全部通过，并完成 UI / CLI 构建）
- `CODEX_CLIPROXY_SKIP_TESTS=1 bun run release:check`
- `bun run release:check`（PR workflow 的完整检查路径）
- `git diff --check`
