## [2026-10-15 19:36] | Task: 个人模型覆盖规则不再构建内联，完全经 --model-merge-json 消费

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/opencode-zen-refresh-on-startup`（HEAD 已含 v0.12.3 发布提交）

### 📥 User Query
> `../models.json` 这个是个人个性化修改，不应该直接系统给替换掉，而且这是我的个人建议使用方式。（补充：应该完全通过 --model-merge-json 来消费它。）

### 🛠 Changes Overview
**Scope:** 网关目录覆盖链路（upstream-catalog/catalog）、测试、项目文档。

**Key Actions:**
- `apps/gateway/src/upstream-catalog.ts` 移除 `import bundledModelOverrides from "../models.json"`：`loadModelOverrideRules` 无来源时返回空规则、`rebuildCatalog` 无来源分支传 `overrides: []`——个人覆盖规则不再随构建内联为系统默认值，未配置 `modelMergeJson` 的安装拿到的是上游原始目录元数据。
- `apps/gateway/src/catalog.ts` 的 `resolveModelMergeJson` 参数 `bundledFile` 更名 `fallbackFile`（网关侧恒传 undefined，语义改为「无缓存时的返回值」）；`test/gateway.test.ts` 局部变量同步更名。
- `test/bundled-model-overrides.test.ts` 更名重写为 `test/model-merge-json.test.ts`：四个依赖内置规则的用例改为断言「无来源 = 不套用任何覆盖」（cliproxy 重建保留原始字段；newapi 合成只保留快照元数据，`gpt-5.6-sol` 的 `max_context_window` 为快照值 872000 而非个人规则值 372000；隔离编译产物无 models.json 资源且不套规则），缓存优先、下载校验、非法数据不回退等行为用例保持。
- AGENTS.md 与根 README 将 `apps/gateway/models.json` 的角色从「网关自有的上游元数据覆盖规则」改为「维护者个人的覆盖规则源文件，不随构建内联，经 `modelMergeJson`（缓存优先，GitHub 仓库地址解析到最新 Release 资产）消费」。文件本身保留在仓库，作为 Release 资产（github-release.yml 已上传）与个人配置源。

### 🧠 Design Intent (Why)
`resolveModelMergeJson` 早已支持 `--model-merge-json` 指定来源（GitHub 仓库简写自动解析为 `releases/latest/download/models.json`）且缓存优先，内置文件只是历史遗留的默认值；把维护者个人规则作为所有安装的系统默认，既混淆了「产品默认」与「个人定制」，也让个人调优必须走发版。本次彻底切换为：系统不内置任何个人规则，个人使用方式 = 配置 `modelMergeJson` 指向仓库 Release 资产（或任意 HTTP(S) 地址），更新规则只需发 Release/改源文件，与 npm 发版解耦。

### 📊 Change Stats
> 数据来自工作树未提交改动；AGENTS.md / README.md / gateway.test.ts 各含 1–8 行 schema 重命名批次的叠加改动，此处只列本任务增量。

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/upstream-catalog.ts` | +4 | -7 |
| `apps/gateway/src/catalog.ts` | +3 | -3 |
| `test/bundled-model-overrides.test.ts → test/model-merge-json.test.ts`（更名 + 重写） | +16 | -15 |
| `test/gateway.test.ts`（本批增量） | +8 | -8 |
| `AGENTS.md`（本批增量） | +1 | -1 |
| `README.md`（本批增量） | +1 | -1 |

### 📁 Files Modified
- `apps/gateway/src/upstream-catalog.ts`、`apps/gateway/src/catalog.ts`
- `test/model-merge-json.test.ts`（由 `test/bundled-model-overrides.test.ts` 更名重写）
- `test/gateway.test.ts`、`AGENTS.md`、`README.md`

### ✅ Validation
- `bun run check` 全绿：边界检查、完整构建、严格类型检查与全部 1137 项测试通过（80 个文件，27.06s）。
- `bun test test/model-merge-json.test.ts` 单独复跑：8 项全部通过，覆盖无来源、缓存优先、下载刷新、非法数据不回退、newapi 快照-only、隔离编译六类行为。
- ⚠️ 行为变化提示：未配置 `modelMergeJson` 的现有安装，模型目录元数据将不再被个人规则补全（如 `gpt-5.6-*` 的 context window 修正）。维护者自用实例需配置 `modelMergeJson`（推荐 `https://github.com/aceHubert/codex-cliproxy-gateway`，自动解析最新 Release 资产）并执行一次 `models --sync` 刷新缓存。
