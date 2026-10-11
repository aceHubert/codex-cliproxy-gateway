## [2026-10-11 15:40] | Task: 提取不发布的模型预设包

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/gateway-monorepo`

### 📥 User Query
> 参考 CLIProxyAPI 的做法，把 models 作为 packages 提供，但不发布。

### 🛠 Changes Overview
**Scope:** `packages/models`、五家 agent、gateway、plugin-api、构建与发布检查。

**Key Actions:**
- 新增私有 `@agent-proxy/models` workspace；两个 JSON 从应用目录迁入包根目录，内容逐字节不变。
- 网关和五家插件直接从模型包获取预设副本，不再通过 HostServices；移除契约包的预设接口及转发函数。
- 模型包只声明为开发依赖。插件构建仅内联模型模块，保留公共包及主机上下文的模块实例；网关同样内联模型包。
- 边界检查识别九个 workspace、八个公开产品包；打包与预发布拒绝私包运行时依赖或未内联引用。
- 模型包变更参与共享版本判定和 Nx 输入；独立消费者不安装模型包，仍验证五家真实模型目录合成。
- 同步项目说明、插件契约、AGENTS 与已完成执行计划。

### 🧠 Design Intent (Why)
模型预设是共享静态资源，不需要绑定网关主机上下文。独立包直接提供查询接口，保留返回深拷贝的隔离行为；构建时内联使模型资源无需独立 npm 发布，公开插件仍可在仓库之外运行。

参考 [CLIProxyAPI 模型定义](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/registry/model_definitions.go) 的独立资源及副本查询接口。

### ✅ Validation
- 九个 workspace 构建、依赖边界及各包严格类型检查通过。
- 预设、副本隔离、五家目录、主机上下文与版本编排定向测试：100 通过、0 失败；移除过时资源路径后版本编排再次 3/3 通过。
- 八个公开包打包及隔离安装通过；消费者未安装私有模型包，五家目录合成、Responses 转换与 CLI/default 冒烟通过。
- 两个 JSON 迁移前后逐字节相同；独立代码审查未发现本次迁移缺陷。
- 首轮全仓检查遇到 30 项旧配置字段可选性相关错误和 23 项配置清理测试失败。本任务保留并行任务变更，没有修订它的业务行为；后续工作树收敛后最终完整验证通过，见下方后续记录。

### 📊 Change Stats
> 以下为首轮私有模型包提取的统计。工作树存在此前未提交的迁移，因此用 `git diff --no-index --find-renames --shortstat` 与 `--numstat` 比较任务前后快照，仅纳入本次文件范围。共享文件中并行产生的配置字段、schema 文档改动已从统计基线排除。两个 JSON 为内容不变的迁移；统计不含本 history 自身。后续收敛增量另列于下方。

- **Files changed:** 40
- **Insertions:** +298
- **Deletions:** -58

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | 2 | 2 |
| `README.md` | 5 | 4 |
| `apps/gateway/package.json` | 3 | 0 |
| `apps/gateway/src/host-services.ts` | 1 | 2 |
| `apps/gateway/src/model-presets.ts` | 0 | 16 |
| `apps/gateway/src/upstream-catalog.ts` | 1 | 1 |
| `bun.lock` | 28 | 0 |
| `docs/exec-plans/completed/private-models-package.md` | 50 | 0 |
| `docs/monorepo-migration.md` | 1 | 1 |
| `docs/plugin-contract.md` | 1 | 1 |
| `nx.json` | 1 | 1 |
| `package.json` | 1 | 0 |
| `packages/agy/package.json` | 3 | 0 |
| `packages/agy/src/catalog.ts` | 2 | 1 |
| `packages/codebuddy/package.json` | 3 | 0 |
| `packages/codebuddy/src/catalog.ts` | 2 | 1 |
| `apps/gateway/models/codex_client_models.json → packages/models/codex_client_models.json` | 0 | 0 |
| `packages/models/package.json` | 23 | 0 |
| `packages/models/src/index.ts` | 17 | 0 |
| `packages/models/tsconfig.build.json` | 10 | 0 |
| `packages/models/tsconfig.json` | 4 | 0 |
| `apps/gateway/models/vendor_models.json → packages/models/vendor_models.json` | 0 | 0 |
| `packages/opencode-zen/package.json` | 3 | 0 |
| `packages/opencode-zen/src/catalog.ts` | 2 | 1 |
| `packages/plugin-api/src/host.ts` | 0 | 2 |
| `packages/plugin-api/src/types.ts` | 0 | 5 |
| `packages/qoder/package.json` | 3 | 0 |
| `packages/qoder/src/catalog.ts` | 2 | 1 |
| `packages/zcode/package.json` | 3 | 0 |
| `packages/zcode/src/catalog.ts` | 2 | 1 |
| `scripts/build-gateway.ts` | 4 | 1 |
| `scripts/build-library.ts` | 19 | 1 |
| `scripts/check-boundaries.ts` | 13 | 6 |
| `scripts/pack-check.ts` | 57 | 3 |
| `scripts/release-version.ts` | 1 | 1 |
| `scripts/verify-package.ts` | 9 | 0 |
| `test/gateway.test.ts` | 1 | 1 |
| `test/model-presets.test.ts` | 13 | 2 |
| `test/release-version.test.ts` | 7 | 2 |
| `test/zcode-catalog.test.ts` | 1 | 1 |

### 📁 Files Modified
- `packages/models/`、六个使用方目录模块与 manifests。
- `packages/plugin-api/src/host.ts`、`types.ts`、应用 `host-services.ts`。
- 构建、边界、产物和发布版本脚本、Nx、锁文件及目录回归测试。
- [执行计划](../../exec-plans/completed/private-models-package.md)、[插件契约](../../plugin-contract.md)、[迁移指引](../../monorepo-migration.md)。

### [2026-10-11 15:58] 后续收敛：ZCode 预设与网关覆盖规则归属

**用户补充：** ZCode 无需使用根目录 override；根目录 `models.json` 应迁到 gateway，且只允许网关内部使用。

**变更：**
- ZCode 移除根覆盖规则导入、运行目录覆盖文件读取、可选覆盖参数及二次 merge；静态厂商目录在初始化时构建，账号和套餐的刷新、重载、并发去重及内容哈希保留。
- `models.json` 原样迁入 `apps/gateway/models.json`，仅 `upstream-catalog.ts` 生产引用；网关包不公开资源导出，构建内联，运行目录覆盖缓存及远程 URL 行为保持。
- 网关覆盖文件移出 Nx 与发布版本脚本的全包共享输入，由网关项目自身的输入和包内变更追踪。
- 所有 workspace 相对源码和资源导入均限制在自身目录内，涵盖 JSON 资源，阻止插件再引用网关资产。
- 更新目录与运行路径测试，以及 README、AGENTS、契约、迁移指引和原执行计划。

**验证：**
- 新回归测试先在旧实现复现覆盖污染（上下文窗口 123 而非预设 1048576）；新实现覆盖启动、刷新和重载，并验证损坏覆盖文件被忽略且不改写。
- ZCode、模型预设、主机上下文及网关覆盖规则定向测试 69 项通过；独立审查确认账号/套餐刷新及副本隔离保留。
- 最终 `bun run check` 全部通过，964 项测试通过、0 失败，包含严格类型、九包构建和依赖边界检查。
- 最终八个公开包隔离打包检查通过，五家目录与 Responses 合成及 CLI/default 冒烟通过。
- 网关覆盖文件迁移前后逐字节相同；生产源码无插件对该文件的引用。

**后续增量统计：** 使用相同的 `git diff --no-index --find-renames --shortstat` 和 `--numstat` 对比两次补充前后的文件快照；本 history 自身不计入。

- **Files changed:** 18
- **Insertions:** +82
- **Deletions:** -71

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | 1 | 1 |
| `README.md` | 4 | 1 |
| `models.json → apps/gateway/models.json` | 0 | 0 |
| `apps/gateway/src/catalog.ts` | 6 | 7 |
| `apps/gateway/src/upstream-catalog.ts` | 3 | 3 |
| `docs/exec-plans/completed/private-models-package.md` | 5 | 1 |
| `docs/monorepo-migration.md` | 2 | 2 |
| `docs/plugin-contract.md` | 2 | 1 |
| `nx.json` | 1 | 2 |
| `packages/zcode/src/catalog.ts` | 4 | 13 |
| `packages/zcode/src/index.ts` | 4 | 5 |
| `scripts/check-boundaries.ts` | 2 | 2 |
| `scripts/release-version.ts` | 1 | 1 |
| `test/bundled-model-overrides.test.ts` | 1 | 1 |
| `test/gateway.test.ts` | 2 | 2 |
| `test/release-version.test.ts` | 2 | 2 |
| `test/zcode-catalog.test.ts` | 15 | 27 |
| `test/zcode-gateway.test.ts` | 27 | 0 |
