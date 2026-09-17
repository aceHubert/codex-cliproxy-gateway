## [2026-09-08 15:33] | Task: Keychain 按上游 URL 分槽 + cliproxyBaseUrl 更名 upstreamBaseUrl

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> KEYCHAIN 能不能通过 upstream url 来进行存取
> cliproxyBaseUrl 改成 upstreamBaseUrl, 并兼容旧的，schemas 标记过时

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/、schemas/、test/、README.md）

**Key Actions:**
- **[Keychain 按 URL 分槽]**: `keychainAccount(url)` 以规范化上游 URL（去尾部斜杠、host 小写）作 Keychain account，不同上游（cliproxy/newapi、不同实例）密钥互不覆盖；`saveApiKey/readApiKey/deleteApiKey` 接受 upstreamUrl；读取与删除保留旧用户名槽位兜底/清理（旧安装升级后 `models --sync` 免重装仍能取到密钥）；install/rollback/uninstall/models/gateway 全部调用点传入上游 URL（卸载优先取已迁移的 config.json，其次兼容旧 state 快照的旧键）。
- **[字段更名]**: `GatewayConfig.cliproxyBaseUrl` → `upstreamBaseUrl`（types/schema/审计白名单/usage/DEFAULTS）；CLI flag `--cliproxy-url` 保留为 `--upstream-url` 的别名；读取归一化（`migrateUpstreamBaseUrl`，loadGatewayConfig 就地补齐新键）+ 命令前置同步文件级迁移（删除旧键、审计记录 `cliproxyBaseUrl -> upstreamBaseUrl`）；`schemas/gateway-config.schema.json` 新键进 required，旧键保留声明并标记 `deprecated: true`；`upstreamBaseUrlOf` 兼容 state.json 旧快照。
- **[测试]**: 4 个测试文件 fixture 全部改新键；新增 "legacy cliproxyBaseUrl is normalized at load and migrated on preflight sync"（旧键值迁入新键、旧键移除、审计落盘）；122 用例全过。

### 🧠 Design Intent (Why)
切换上游不应覆盖另一上游的本地凭据/配置（与目录文件按上游分文件同一原则）：Keychain 用 URL 作 account 实现天然隔离，旧槽位只读兜底保证免重装升级；`upstreamBaseUrl` 命名与已泛化的上游类型一致，逐步退出 cliproxy 专属命名，schema 的 `deprecated` 标注让编辑器的旧键提示与迁移路径文档化。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动，含全部同日 new-api 系列任务累计；根目录 models.json 为用户既有改动）。

- **Files changed:** 15（累计）
- **Insertions:** +1026（累计）；**Deletions:** -153（累计）

### 📁 Files Modified（本轮净改动）
- `src/keychain.ts`（URL 分槽）
- `src/types.ts`、`src/config.ts`、`src/cli.ts`、`src/gateway.ts`（字段更名 + 迁移）
- `schemas/gateway-config.schema.json`（deprecated 标注）
- `test/gateway.test.ts`、`test/model-catalog-dynamic.test.ts`、`test/app-server.test.ts`、`test/realtime.test.ts`
- `README.md`（安装示例、config 示例、Keychain 说明）
