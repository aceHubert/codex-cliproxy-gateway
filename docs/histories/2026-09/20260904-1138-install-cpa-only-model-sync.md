## [2026-09-04 11:38] | Task: 安装时同步模型模式与选择

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> install 应该和 models --sync 保持一致，这样初始化就能使用。

### 🛠 Changes Overview
**Scope:** codex-cliproxy CLI 安装、参数校验、测试、README 与 npm patch 发布

**Key Actions:**
- **[安装模式]**: `install` 支持 `--cpa-only`，与 `models --sync` 共用路由模式和模型选择规则；split 允许空选择，CPA-only 仍要求至少选择一个模型。
- **[目录配置]**: 安装流程复用现有 `applyModelCatalogToml`，CPA-only 初始化写入静态 `model_catalog_json`，split 初始化移除受管值，并拒绝覆盖非受管目录。
- **[缓存与输出]**: CPA-only 初始化不失效动态模型缓存，安装输出和重启提示按当前模式显示。
- **[测试与文档]**: 覆盖 `install --cpa-only` 参数入口，更新参数错误契约、帮助文本和首次 CPA-only 安装示例。
- **[发布]**: patch 版本提升为 `0.2.4`，重新生成发布包并发布到 npm `latest`。

### 🧠 Design Intent (Why)
*首次安装应直接建立与后续 `models --sync [--cpa-only]` 相同的模型目录、选择约束和路由模式。实现直接复用现有模式与 TOML 处理函数，保留 install 独有的 Keychain、LaunchAgent、健康检查和失败回滚职责。*

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`（工作区相对 HEAD），仅统计本任务文件；已有的 `models.json` 改动未计入。

- **Files changed:** 4
- **Insertions:** +36
- **Deletions:** -17

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +17 | -10 |
| `test/app-server.test.ts` | +9 | -3 |
| `README.md` | +9 | -3 |
| `package.json` | +1 | -1 |

### 📁 Files Modified
- `src/cli.ts`
- `test/app-server.test.ts`
- `README.md`
- `package.json`

### ✅ Verification
- `bun run check`：类型检查、106 个测试和 `dist/index.js` 构建全部通过。
- `bun run dev help`：确认 `install --cpa-only` 已出现在帮助文本中。
- `npm pack --dry-run --ignore-scripts`：确认 `0.2.4` tarball 仅包含 6 个预期文件。
- `npm publish --access public`：成功发布 `codex-cliproxy-gateway@0.2.4` 到 `latest`。
