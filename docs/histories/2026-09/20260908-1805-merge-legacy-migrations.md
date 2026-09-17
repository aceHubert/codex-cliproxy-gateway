## [2026-09-08 18:05] | Task: 配置兼容迁移合并为可扩展迁移表

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> migrateUpstreamBaseUrl migrateUpstreamOnly 合并成一个，后续可能还会有配置兼容的

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/config.ts、src/cli.ts）

**Key Actions:**
- **[迁移表]**: `config.ts` 新增 `LEGACY_FIELD_MIGRATIONS` 注册表（`{old, next, valid}` 三元组，现有 `cliproxyBaseUrl→upstreamBaseUrl`、`cpaOnly→upstreamOnly` 两条）+ `migrateLegacyConfig(config)` 单入口：遍历表、仅在新键缺失且旧值类型合法时补齐，绝不覆盖用户新值。
- **[同步复用]**: `syncGatewayConfigFile` 的文件级迁移（删旧键 + 审计 `old -> new`）改为遍历同一张表，替代原先两段硬编码 if 块；`loadGatewayConfig` 归一化改调 `migrateLegacyConfig`。
- 未来新增配置兼容只需在表中登记一行，读取归一化与文件迁移自动生效。

### 🧠 Design Intent (Why)
配置字段更名会持续发生，两个独立迁移函数逐字段硬编码不可扩展；集中到一张迁移表后，读取时补齐与同步时删旧键/审计共享同一事实来源，避免新增兼容时漏改其中一处。

### 📊 Change Stats
> 净改动：config.ts 约 -30/+35，cli.ts 约 -25/+15；122 用例全过（legacy 迁移测试断言不变，行为等价）。

### 📁 Files Modified
- `src/config.ts`
- `src/cli.ts`
