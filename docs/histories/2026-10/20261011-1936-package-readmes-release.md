## [2026-10-11 19:36] | Task: 补齐公开包介绍与发布状态徽章

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-package-readmes`

### 📥 User Query
> 从 main 创建 fix 分支，为七个公开 packages 包补充简短 README，并为八个公开包添加 Deploy 与 npm 版本徽章。Lerna 保留 Markdown 忽略规则，仅让 README.md 参与版本判定；下一轮发布用来验收 npm Pending validation。

### 🛠 Changes Overview
**Scope:** 八个公开产品包及共享发布检查。

**Key Actions:**
- 新增七个公开库与插件的中文包介绍、安装命令和宿主使用说明，网关手册补充 Deploy 与 npm 版本徽章。
- 七个包的发布文件白名单显式包含 README.md，修正 llm-bridge 仍称包骨架的旧描述。
- Lerna 使用 `**/!(README).md` 忽略其他 Markdown，保留 README.md 的版本触发作用；保留 docs 与 test 忽略规则。
- prepack 要求包介绍非空，隔离打包检查要求每个 tarball 中 README 与源码逐字一致。
- 本次共享发布检查与 Lerna 配置修改纳入现有八包统一版本编排，版本由合并后的 Deploy 生成。

### 🧠 Design Intent (Why)
让 npm 包页面和安装产物直接提供准确的使用介绍与发布状态，并避免 README-only 更新被 Lerna 忽略而无法发布。
Lerna 按每个忽略规则逐项过滤，追加 `!README.md` 无法恢复已过滤的文件，因此使用扩展通配表达式排除 README。

### ✅ Validation
- `bun run release:check` 通过：970 个测试通过、0 失败；构建、类型检查、八包 README 打包一致性与隔离消费者冒烟通过。
- 使用 Lerna 10.1.0 的实际匹配参数确认包内 README 保留、其他 Markdown 与 docs/test 过滤。
- 尚未生成新版本或触发 Deploy；新版本的 npm Pending validation 状态须在实际发布后验收。

### 📊 Change Stats
> 数据来自本任务暂存差异，包含本记录。

- **Files changed:** 19
- **Insertions:** +231
- **Deletions:** -10

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/README.md` | +3 | -0 |
| `docs/histories/2026-10/20261011-1936-package-readmes-release.md` | +67 | -0 |
| `lerna.json` | +2 | -2 |
| `packages/agy/README.md` | +20 | -0 |
| `packages/agy/package.json` | +2 | -1 |
| `packages/codebuddy/README.md` | +20 | -0 |
| `packages/codebuddy/package.json` | +2 | -1 |
| `packages/llm-bridge/README.md` | +20 | -0 |
| `packages/llm-bridge/package.json` | +3 | -2 |
| `packages/opencode-zen/README.md` | +20 | -0 |
| `packages/opencode-zen/package.json` | +2 | -1 |
| `packages/plugin-api/README.md` | +20 | -0 |
| `packages/plugin-api/package.json` | +2 | -1 |
| `packages/qoder/README.md` | +20 | -0 |
| `packages/qoder/package.json` | +2 | -1 |
| `packages/zcode/README.md` | +20 | -0 |
| `packages/zcode/package.json` | +2 | -1 |
| `scripts/pack-check.ts` | +3 | -0 |
| `scripts/verify-package.ts` | +1 | -0 |

### 📁 Files Modified
- `apps/gateway/README.md`
- `packages/{plugin-api,llm-bridge,zcode,codebuddy,qoder,agy,opencode-zen}/{README.md,package.json}`
- `lerna.json`
- `scripts/verify-package.ts`
- `scripts/pack-check.ts`
- `docs/histories/2026-10/20261011-1936-package-readmes-release.md`
