## [2026-10-09 22:27] | Task: 提交当前成果并合并模型排除分支

### 🤖 Execution Context

- **Agent ID**: `codex`
- **Base Model**: `GPT-6（主代理，协作执行按宿主角色配置）`
- **Runtime**: `Codex Desktop`
- **Git User**: `hubert <hubert@lejian.com>`
- **Branch**: `feature/opencode-zen`

### 📥 User Query

> commit 提交，然后把 feature/model-exclude 合并过来，有冲突需要解决。

### 🛠 Changes Overview

**Scope:** 当前已验证成果的提交、模型排除功能合并、冲突处理与兼容回归。

- 将此前 Zen、目录指纹、产品缓存与实例隔离成果提交为 `707759c`，提交前完整检查为 790 项通过。
- 合并本地 `feature/model-exclude` 的 `2459842`（三个提交），保持其独立工作树不变。
- 按语义解决 cli.ts、config-update.ts、gateway.ts、ConfigPage.tsx 和 tech-debt-tracker.md 五处冲突，保留两边配置、UI、流量和审计逻辑。
- 保留五产品排除范围，Zen 不新增排除组；目录在 Zen 合并之后执行排除过滤，普通模型列表继续列出已启用的 Zen。
- 排除命令复用调用级实例上下文，并纳入客户端目录归属检查，保留 debug 与 Zen 的 CLI 选项。
- 补齐合并分支测试的实例字段，新增 Zen 共存及排除命令实例隔离回归。

### 🧠 Design Intent (Why)

整文件选择任一侧会丢失功能。按配置入口、完整目录合并、转发前过滤与 UI 控件分别整合，沿用模型排除分支原有作用域，保持现有 Zen 和实例绑定行为。

### ✅ 验证

- 对应的模型排除、Zen、实例隔离回归：63 项通过。
- `bun run check`：825 项测试全部通过，类型检查、UI 构建与 CLI 打包成功。
- `git diff --check` 通过，源文件无冲突标记。

### 📊 Change Stats

本合并相对提交 `707759c` 的完整差异，统计包含新功能、冲突解决、回归和文档，来自 `git diff --cached --shortstat` 与 `--numstat`。

- **Files changed:** 25
- **Insertions:** +2263
- **Deletions:** -25

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | 67 | 2 |
| `docs/exec-plans/completed/excluded-models-filter.md` | 129 | 0 |
| `docs/exec-plans/completed/merge-model-exclude.md` | 50 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | 2 | 0 |
| `docs/histories/2026-10/20261008-2025-excluded-models-filter.md` | 133 | 0 |
| `docs/histories/2026-10/20261009-2227-merge-model-exclude.md` | 70 | 0 |
| `schemas/gateway-config.schema.json` | 10 | 0 |
| `src/catalog.ts` | 56 | 0 |
| `src/cli.ts` | 250 | 14 |
| `src/codebuddy/catalog.ts` | 5 | 0 |
| `src/config-update.ts` | 266 | 2 |
| `src/gateway.ts` | 35 | 1 |
| `src/models.ts` | 10 | 4 |
| `src/types.ts` | 7 | 0 |
| `src/ui/ConfigPage.tsx` | 108 | 2 |
| `src/ui/api.ts` | 14 | 0 |
| `src/ui/excluded-models-field.ts` | 11 | 0 |
| `src/ui/i18n.tsx` | 16 | 0 |
| `src/ui/styles.css` | 49 | 0 |
| `src/webui.ts` | 19 | 0 |
| `src/zcode/catalog.ts` | 8 | 0 |
| `test/instance-regressions.test.ts` | 11 | 0 |
| `test/model-exclude-gateway.test.ts` | 292 | 0 |
| `test/model-exclude.test.ts` | 612 | 0 |
| `test/opencode-zen-gateway.test.ts` | 33 | 0 |
