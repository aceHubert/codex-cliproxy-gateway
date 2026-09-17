## [2026-09-08 17:52] | Task: --cpa-only 重命名 --upstream-only（含 config 字段迁移）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> --cpa-only 修改成 --upstream-only

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/、schemas/、test/、README.md）

**Key Actions:**
- **[flag 更名]**: `--cpa-only` → `--upstream-only`（旧名保留为已废弃别名，两值等价）；parseArgs 布尔列表、install/models 选项白名单、runCli 守卫（消息注明别名）、usage 文案全部更新；新增 `upstreamOnlyOption(options)` 统一解析两 flag。
- **[config 字段更名]**: `GatewayConfig.cpaOnly` → `upstreamOnly`（types/schema/审计白名单/healthz 与 status JSON 键/gateway 全部读取点）；旧键读取归一化（`migrateUpstreamOnly`，布尔值才迁移）+ 命令前置同步文件级迁移（删除旧键、审计 `cpaOnly -> upstreamOnly`）；schema 旧键标注 `deprecated: true`。
- **[文案]**: console 消息与 README 的 "CPA-only"/`--cpa-only` → "upstream-only"/`--upstream-only`；保留描述上游侧路由的 "CPA rows/catalog" 术语（对应 `cliproxy/` 前缀与 `cliproxy-catalog.json` 文件名）。
- **[测试]**: 4 个测试文件 fixture/flag/文案替换；`cpaOnly` 迁移断言并入 legacy 迁移测试（新键补齐、旧键移除、审计落盘）；app-server 守卫消息正则放宽（消息含别名说明）；122 用例全过。

### 🧠 Design Intent (Why)
`cpaOnly` 是"CLIProxy-only"概念的残留命名，与已泛化的 `upstream_type`/`upstreamBaseUrl` 不一致；本轮把 flag 与 config 字段一并归一为 `upstream*`，同时沿用本轮既有兼容策略（旧名可读、读取自动迁移、schema deprecated、文件级迁移 + 审计），保证存量配置与脚本零破坏。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动，含同日 new-api 系列任务累计）。

- **Files changed:** 累计 16+；本轮净改动 8 文件
- **Insertions:** 累计约 +1150；**Deletions:** 累计约 -190

### 📁 Files Modified（本轮净改动）
- `src/types.ts`、`src/config.ts`、`src/cli.ts`、`src/gateway.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`、`test/model-catalog-dynamic.test.ts`、`test/app-server.test.ts`、`test/realtime.test.ts`
- `README.md`
