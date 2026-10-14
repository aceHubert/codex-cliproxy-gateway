## [2026-10-14 10:26] | Task: 实施配置目录迁移

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-artifact-boundary`

### 📥 User Query
> 继续实施配置目录迁移计划。先建立「迁移目录」计划，移除受管文件白名单，采用同名目标整体跳过的方案 A；凭据走现有存储接口，符号链接跳过，回滚依据实际变更清单。完成后更新技术债，不提交，等待验收。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/gateway`、迁移测试及仓库文档。

**Key Actions:**
- 移除 `managedEntry`，复制整个旧默认目录的普通文件与目录，包括未知文件与嵌套内容。
- 同名目标文件、目录、链接及类型冲突整体跳过；源普通符号链接静默跳过，配置、状态和凭据保持严格常规文件校验。
- 顶层 `credentials.json` 仅通过 `createApiKeyStore` 分派迁移，保持新配置优先、JSON 受管地址改写、安装归属和服务恢复行为。
- 回滚根据新增文件、目录及修改前快照执行，保留清单外后来生成内容；复制与回滚临时开放只读目录的所有者权限，结束后恢复原权限。
- 同步使用说明、迁移指引和仓库约束，清偿旧目录迁移白名单债务并归档计划。
- 沿用原工作树，保留任务开始时已有的三个暂存文档变更，不提交或改动暂存区。

### 🧠 Design Intent (Why)
文件名白名单让迁移依赖网关对插件产物名的硬编码，也漏掉未知运行文件。整目录复制让迁移与插件清单解耦；整体跳过冲突目标和精确回滚防止覆盖用户已有内容或误删后续产物。保留旧目录作为恢复材料。

### ✅ Validation
- `bun scripts/run-tests.ts test/default-install-migration.test.ts`：21 项通过，0 失败，测试进程上限 60 秒。
- `bun run check`：边界检查、构建、严格类型检查及全部 978 项测试通过，0 失败。
- `git diff --check` 通过；独立审查发现的只读子目录及根目录问题均已修复并补充回归，最终复核无阻断问题。
- 所有迁移验证使用临时目录及虚构凭据，没有运行真实 install 或读取本机凭据。

### 📊 Change Stats
> 本次未提交；各文件为相对 HEAD 的未提交净变化（`git diff --numstat`），技术债表按净 -1 行计入；新增计划以 `git diff --no-index` 单独统计。排除本记录自身与任务开始时已暂存的两份 gateway-plugin-artifact-boundary 文档。

- **Files changed:** 7
- **Insertions:** +338
- **Deletions:** -47

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | 1 | 1 |
| `apps/gateway/README.md` | 1 | 2 |
| `apps/gateway/src/default-install-migration.ts` | 38 | 32 |
| `docs/exec-plans/tech-debt-tracker.md` | 0 | 1 |
| `docs/monorepo-migration.md` | 11 | 6 |
| `test/default-install-migration.test.ts` | 234 | 5 |
| `docs/exec-plans/completed/migration-directory.md` | 53 | 0 |

### 📁 Files Modified
- `apps/gateway/src/default-install-migration.ts`
- `test/default-install-migration.test.ts`
- `AGENTS.md`
- `apps/gateway/README.md`
- `docs/monorepo-migration.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/exec-plans/completed/migration-directory.md`
