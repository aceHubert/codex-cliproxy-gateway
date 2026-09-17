## [2026-09-08 12:10] | Task: 支持 new-api 上游并本地合成模型目录

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 根据会话 sess_ab67a653-1abd-4bc7-b64a-9bc777557ddb 探索，设计一个连接 newapi 的配置，重点就是 model catalog 的生成。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/、schemas/、test/、docs/）

**Key Actions:**
- **[配置]**: `GatewayConfig` 新增 `upstream_type: "cliproxy" | "newapi"`（默认 cliproxy，`mergeMissingConfig` 自动回填旧配置），同步 `schemas/gateway-config.schema.json` 并为 `src/config.ts` 内置校验器补 enum 支持；`install --upstream-type` 进选项白名单与 runCli 取值守卫，`upstream_type` 进配置审计白名单与 `status` 输出。
- **[目录合成]**: `src/catalog.ts` 新增 `fetchUpstreamCatalog` 统一入口、`fetchNewApiCatalog`（GET `/models` 解析 OpenAI `{"data":[{id}]}`，大小写不敏感去重、排序）与 `synthesizeModelEntry`（字段集对齐 bundled models.json 的 deepseek/z.ai 条目，`context_window` 保守默认 128000）；`install`/`models --sync` 拉取切换到统一入口，运行时 `/v1/models` 服务路径零改动。
- **[覆盖匹配]**: `ModelOverrideRule.pattern` 改为 `patterns[]`，非 openai 组规则额外编译裸模型名模式，使 models.json 的 z.ai/deepseek 元数据能命中 new-api 的裸 ID（如 `glm-5.3`）；组级 `*` 通配规则不加裸别名，保持组前缀作用域。
- **[测试与文档]**: 新增 8 个用例（合成/异常响应/裸名匹配/通配作用域/取值校验/schema 告警/回填），README 增加 "Using a new-api upstream" 小节。

### 🧠 Design Intent (Why)
调研会话确认 new-api 不支持 Codex CLI 的 `/v1/models?client_version=` 目录端点（仅返回 OpenAI 列表格式），Codex 目录解码失败后静默回退内置 preset，`/model` picker 看不到 new-api 模型。本网关数据面（前缀路由、剥 OAuth、注入 Bearer key）对 OpenAI 兼容上游天然适用，唯一断点在目录同步链路，因此在 sync 时本地合成目录；显式 `upstream_type` 配置而非按响应自动检测，保证行为可预期、可进 schema 与审计。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动；`models.json` 的修改是任务开始前已存在的用户改动，未计入）。

- **Files changed:** 8（另新增执行计划与本文档）
- **Insertions:** +355
- **Deletions:** -14

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/gateway.test.ts` | +165 | -0 |
| `src/catalog.ts` | +90 | -5 |
| `README.md` | +43 | -0 |
| `src/cli.ts` | +41 | -8 |
| `schemas/gateway-config.schema.json` | +5 | -0 |
| `src/config.ts` | +5 | -0 |
| `src/types.ts` | +5 | -0 |
| `src/keychain.ts` | +1 | -1 |

### 📁 Files Modified
- `src/types.ts`
- `src/config.ts`
- `src/catalog.ts`
- `src/cli.ts`
- `src/keychain.ts`
- `schemas/gateway-config.schema.json`
- `test/gateway.test.ts`
- `README.md`
- `docs/exec-plans/completed/newapi-upstream-catalog.md`（由 active/ 移入）
