## [2026-10-11 15:39] | Task: 拆分项目说明与网关手册并统一配置规范来源

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6（当前会话未提供具体变体）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/gateway-monorepo`

### 📥 User Query
> 根 README 改为项目结构说明；gateway README 去掉 badge，作为 CLI 发布手册。
> Schema 只保留 gateway 下的一份，配置中的 $schema 指向新位置。
> install 使用当前程序提供的规范地址更新 $schema，不继承用户设置。

### 🛠 Changes Overview
**Scope:** 根项目文档、网关配置规范、构建与发布工具、安装集成测试。

**Key Actions:**
- 根 README 保留 badge，说明 workspace 结构、依赖边界与开发验证入口；网关 README 独立维护安装使用手册，去掉 badge，修复仓库文档链接。
- `apps/gateway/schemas/` 成为唯一维护来源；删除根 Schema 副本，更新规范 `$id` 和程序提供的配置 `$schema` 地址。规范自身的 `$schema` 继续使用 JSON Schema 标准元规范。
- 移除 README/Schema 的 Git 忽略规则，删除资源复制脚本及全部调用；Nx 只缓存构建产物，避免缓存覆盖受管文档与配置规范。
- Lerna 只忽略根目录 Markdown 和独立文档目录，网关发布手册参与包版本判定；包内 Schema 由 Lerna 原生包变更检测处理。
- install 在配置合并后强制更新 `$schema`，成功写入配置和安装状态；沿用原有原子写入和失败回滚。补充旧地址、自定义地址、缺失地址及安装失败恢复的隔离集成测试。
- 更新当前维护指南和迁移说明；保留工作树中的既有改动及并行模型资源迁移。

### 🧠 Design Intent (Why)
项目说明与 CLI 发布手册服务不同读者，应分别维护。配置规范属于网关的运行时和发布资源，直接在业务包维护即可。`$schema` 由程序管理，安装后应使用当前程序提供的规范地址，不能被存量用户配置覆盖。

### ✅ 验证结果
- 相关 Schema、发布判定与 install 集成测试：12 项通过，0 项失败；测试进程上限 60 秒。
- 网关应用 TypeScript 类型检查通过。
- `bun run pack:check` 通过：八个发布包、workspace 版本转换、CLI/default 与五家 Responses 的隔离产物验证；发布包包含独立 README 和 Schema。
- Git 差异空白检查、README 本地链接与 badge 核对通过。
- `bun run check` 的边界检查及构建通过；根 TypeScript 检查受既有测试的 `GatewayConfig` 可选字段与 `AgentConfig` 不匹配阻断，因此完整检查未通过。本任务未扩大范围修复这些迁移问题。
- 未提交、未发布，未访问真实用户凭据或运行真实 install。

### 📊 Change Stats
> 使用任务开始前的文件快照与本次补丁快照执行 `git diff --no-index --shortstat` 和 `--numstat`。共享文件排除并行模型迁移的独立变更段；不包含既有迁移改动及本记录自身。原先被忽略的生成文件也纳入物理文件快照，根 Schema 删除统计为删除副本。

- **Files changed:** 21
- **Insertions:** +298
- **Deletions:** -538

| File | +Added | -Removed |
| --- | ---: | ---: |
| `.gitignore` | 0 | 2 |
| `AGENTS.md` | 5 | 4 |
| `README.md` | 83 | 296 |
| `apps/gateway/README.md` | 9 | 28 |
| `apps/gateway/schemas/gateway-config.schema.json` | 1 | 1 |
| `apps/gateway/src/cli.ts` | 2 | 0 |
| `apps/gateway/src/config.ts` | 1 | 1 |
| `docs/monorepo-migration.md` | 4 | 2 |
| `lerna.json` | 1 | 1 |
| `nx.json` | 2 | 6 |
| `package.json` | 4 | 4 |
| `schemas/gateway-config.schema.json` | 0 | 173 |
| `scripts/build-gateway.ts` | 0 | 1 |
| `scripts/prepare-resources.ts` | 0 | 9 |
| `scripts/release-version.ts` | 2 | 2 |
| `test/agy-config.test.ts` | 1 | 1 |
| `test/gateway.test.ts` | 1 | 1 |
| `test/install-schema.test.ts` | 167 | 0 |
| `test/qoder-config.test.ts` | 1 | 1 |
| `test/release-version.test.ts` | 2 | 2 |
| `test/zcode-config.test.ts` | 12 | 3 |

### 📁 Files Modified
- 文档与维护规则：`README.md`、`apps/gateway/README.md`、`AGENTS.md`、`docs/monorepo-migration.md`。
- 配置资源与安装：`apps/gateway/schemas/gateway-config.schema.json`、`apps/gateway/src/config.ts`、`apps/gateway/src/cli.ts`；删除根 `schemas/gateway-config.schema.json`。
- 工具配置：`.gitignore`、`package.json`、`lerna.json`、`nx.json`、`scripts/build-gateway.ts`、`scripts/release-version.ts`；删除 `scripts/prepare-resources.ts`。
- 测试：`test/install-schema.test.ts`、`test/zcode-config.test.ts`、`test/agy-config.test.ts`、`test/qoder-config.test.ts`、`test/gateway.test.ts`、`test/release-version.test.ts`。
