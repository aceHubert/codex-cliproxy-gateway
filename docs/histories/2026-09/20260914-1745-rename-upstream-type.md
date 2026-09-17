## [2026-09-14 17:45] | Task: config 字段 upstream_type 重命名为 upstreamType

### 🤖 Execution Context
* **Agent ID**: `mimocode`
* **Base Model**: `mimo`
* **Runtime**: `MiMo Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> upstream_type config 中只有这个命名不一样，修改成一样的

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/、schemas/、test/、README.md、dist/ui/）

**Key Actions:**
- **[config 字段更名]**: `GatewayConfig.upstream_type` → `upstreamType`（types/schema/DEFAULTS/审计白名单/status 输出/Web UI 只读字段全部同步）；CLI flag `--upstream-type` 保持 kebab-case 不变。
- **[兼容迁移]**: 在 `LEGACY_FIELD_MIGRATIONS` 登记 `upstream_type -> upstreamType`（字符串值才迁移）；读取归一化自动补齐新键，命令前置 `syncGatewayConfigFile` 删除旧键并审计 `upstream_type -> upstreamType`；schema 旧键标注 `deprecated: true`。
- **[文案]**: README 的 config 示例与重命名说明同步；UI 配置页只读行 keyname 与字段访问改为 `upstreamType`。
- **[测试]**: legacy 迁移测试覆盖 `upstream_type` 迁移与审计；invalid 值告警测试改断言 `$.upstreamType`；类型检查与 320 用例全过；`bun run build:ui` 重建产物。

### 🧠 Design Intent (Why)
配置字段几乎全是 camelCase（`upstreamBaseUrl`、`upstreamOnly`、`selectedModels` 等），只有 `upstream_type` 是 snake_case。本轮按既有 `cpaOnly`→`upstreamOnly` 迁移策略归一命名，保证存量配置零破坏。

### 📊 Change Stats
> 工作区在本任务进行时还带有其它未提交的在途改动，下表是 `git diff --numstat` 的文件级结果，包含那些不属于本任务的行。本轮净改动见 Files Modified。

- **Files changed:** 工作区累计 22；本轮净改动 10
- **Insertions:** 工作区累计约 +2959；**Deletions:** 工作区累计约 -666

### 📁 Files Modified（本轮净改动）
- `src/types.ts`、`src/config.ts`、`src/cli.ts`、`src/webui.ts`
- `src/ui/api.ts`、`src/ui/ConfigPage.tsx`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `README.md`
- `dist/ui/index.html`（build 产物）
