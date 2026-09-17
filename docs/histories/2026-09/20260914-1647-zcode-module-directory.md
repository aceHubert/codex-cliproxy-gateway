## [2026-09-14 16:47] | Task: 将 ZCode 模块收拢到独立目录

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 把 ZCode 相关文件封装到独立的 `zcode/` 文件夹。

### 🛠 Changes Overview
**Scope:** `src/zcode/` 模块边界、测试导入与当前文档路径

**Key Actions:**
- **[目录封装]**: 将 10 个 ZCode 源码/资产文件迁入 `src/zcode/`，使用 `index.ts`、`catalog.ts`、`request.ts` 等去前缀名称。
- **[依赖更新]**: 更新 ZCode 内部相对路径、根模块导入、测试导入和 JSON 静态资产路径。
- **[文档同步]**: 在项目结构规范中记录 `src/zcode/` 责任，更新当前调研与技术债路径，保留已归档历史的原路径。
- **[行为保持]**: 测试文件仍在 `test/`；运行时缓存名、协议字段、模型路由和公开导出行为不变。

### 🧠 Design Intent (Why)
`zcode-*` 文件已组成明确的功能域，继续平铺在 `src/` 根目录会稀释网关主干的结构边界。独立目录让路径表达功能归属，去掉目录内重复的 `zcode-` 前缀，同时用 `index.ts` 作为网关适配门面。

### 📊 Change Stats
> 工作区已有其他未提交改动，以本任务独立补丁并按 Git rename 语义统计。

- **Files changed:** 26
- **Insertions:** +157
- **Deletions:** -56

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/*` 及原 `src/zcode*.ts/json` | +31 | -31 |
| `src/cli.ts`, `src/config-update.ts`, `src/gateway.ts` | +5 | -5 |
| `test/zcode-*.test.ts` | +15 | -15 |
| `AGENTS.md`, `docs/zai-server-tools-research.md`, `docs/exec-plans/tech-debt-tracker.md` | +5 | -5 |
| `docs/exec-plans/completed/zcode-module-directory.md` | +45 | -0 |
| `docs/histories/2026-09/20260914-1647-zcode-module-directory.md` | +56 | -0 |

### 🧪 Validation
- `bun run typecheck`：通过。
- `bun test test/zcode-*.test.ts`：136 通过，1 跳过（宿主 `fs.watch` 返回 EMFILE）。
- `bun run check`：在允许回环端口监听的环境中 315 项测试全部通过，类型检查和构建成功。
- `git diff --check`：通过。

### 📁 Files Modified
- `src/zcode/`
- `src/cli.ts`
- `src/config-update.ts`
- `src/gateway.ts`
- `test/zcode-*.test.ts`
- `AGENTS.md`
- `docs/zai-server-tools-research.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/exec-plans/completed/zcode-module-directory.md`
