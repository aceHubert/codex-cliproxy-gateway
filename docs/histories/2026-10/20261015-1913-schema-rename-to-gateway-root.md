## [2026-10-15 19:13] | Task: 将配置 Schema 重命名为 config.schema.json 并移至网关包根目录

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/opencode-zen-refresh-on-startup`（HEAD 已含 v0.12.3 发布提交，工作树干净）

### 🛥 User Query
> 把 gateway-config.schema.json 重命名为 config.schema.json 放到 gateway 根目录。（承接本轮 GitHub Release 自动化设计：Release 资产名与包内路径统一为 config.schema.json，后续 `$schema` 将按安装版本指向对应 Release 资产。）

### 🛠 Changes Overview
**Scope:** 网关包结构与打包、运行时加载路径、规范地址常量、插件契约注释、测试与项目文档。

**Key Actions:**
- `git mv` 将 `apps/gateway/schemas/gateway-config.schema.json` 迁移为 `apps/gateway/config.schema.json`，删除 `schemas/` 目录，保留文件历史。
- `apps/gateway/package.json` 的 `files` 由 `"schemas"` 目录改为 `"config.schema.json"` 文件；发布包布局由 `<pkg>/schemas/...` 变为 `<pkg>/config.schema.json`。
- `apps/gateway/src/config.ts` 运行时加载路径改为 `../config.schema.json`（源码与 dist 布局均指向包根）；`GATEWAY_CONFIG_SCHEMA_URL` 与 schema `$id` 同步改为 raw main 新路径，地址 host 语义不变，版本锁定改造留给 Release workflow 批次。
- 批量更新六个测试文件的相对读取路径与 `zcode-config.test.ts` 的字面量 URL 断言（该断言要求 `$id` 与常量一致，二者同步后保持通过）。
- `install-schema.test.ts` 新增「schemas 目录时代的规范地址」旧地址 fixture：install 会把线上存量配置里的旧规范地址覆盖为新地址（既有行为回归验证）。
- 同步 `AGENTS.md`（结构说明与红线路径）、根 `README.md` 目录树、`apps/gateway/README.md` 配置格式链接、`packages/plugin-api/src/types.ts` 注释。历史记录与已完成执行计划中的旧路径是历史事实，不改写。

### 🧠 Design Intent (Why)
为「按版本取件的 GitHub Release 资产」方案铺路：资产名 `config.schema.json` 简短且与包内文件路径一致，Release 下载 URL（`releases/download/v<version>/config.schema.json`）即为用户配置 `$schema` 的目标形态；schema 从独立目录下沉到包根后，运行时相对路径与发布包 files 声明也随之简化。本轮仅做路径与命名迁移，不改变校验行为与地址语义，保证可独立发布验证。

### 📊 Change Stats
> 数据来自工作树未提交改动的 `git diff --shortstat` / `--numstat`；不含本记录。

- **Files changed:** 14
- **Insertions:** +19
- **Deletions:** -18

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +2 | -2 |
| `README.md` | +1 | -1 |
| `apps/gateway/README.md` | +1 | -1 |
| `apps/gateway/config.schema.json`（原 `apps/gateway/schemas/gateway-config.schema.json`） | +1 | -1 |
| `apps/gateway/package.json` | +1 | -1 |
| `apps/gateway/src/config.ts` | +2 | -2 |
| `packages/plugin-api/src/types.ts` | +1 | -1 |
| `test/agy-config.test.ts` | +1 | -1 |
| `test/bundled-model-overrides.test.ts` | +1 | -1 |
| `test/gateway.test.ts` | +1 | -1 |
| `test/install-schema.test.ts` | +1 | -0 |
| `test/qoder-config.test.ts` | +1 | -1 |
| `test/release-version.test.ts` | +1 | -1 |
| `test/zcode-config.test.ts` | +4 | -4 |

### 📁 Files Modified
- `apps/gateway/config.schema.json`（git rename）
- `apps/gateway/package.json`
- `apps/gateway/src/config.ts`
- `packages/plugin-api/src/types.ts`
- `AGENTS.md`、`README.md`、`apps/gateway/README.md`
- `test/`：agy-config、bundled-model-overrides、gateway、install-schema、qoder-config、release-version、zcode-config

### ✅ Validation
- `bun run check` 全绿：边界检查、完整构建、严格类型检查与全部 1137 项测试通过（80 个文件，26.68s）。
- 全仓库 grep 验证：非历史文档中已无 `gateway-config.schema` / `gateway/schemas` 残留（`docs/antigravity-cli-upstream-research.md` 为历史调研记录，按惯例保留）。
