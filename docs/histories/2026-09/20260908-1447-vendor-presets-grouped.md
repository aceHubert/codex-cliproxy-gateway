## [2026-09-08 14:47] | Task: vendor 预设改为分组覆盖表格式

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 分个组，写成 z.ai/deepseek/moonshotai, 和根目录的models 格式一样

### 🛠 Changes Overview
**Scope:** codex-cliproxy（models/、src/、test/、README.md）

**Key Actions:**
- **[格式统一]**: `models/vendor_models.json` 从 Codex 目录扁平格式（`{"models":[{slug,…}]}`）改为与根目录 models.json 相同的分组覆盖表格式，组名 `z.ai`（glm-5.3/glm-5.3-flash/glm-5-turbo）、`moonshotai`（k3/k3-256k）、`deepseek`（deepseek-v4-flash/pro/flash-vision-exp），条目去掉 slug/priority（加载器禁止）改由 `name` + 字段表达。
- **[解析复用]**: `loadModelOverrides` 拆出值编译入口 `compileModelOverrides(value, source)`，内联 import 的 vendor 文件直接编译；vendor 规则自动获得双模式匹配（`z.ai/glm-5.3` 与裸 `glm-5.3`）；`synthesizeModelEntry`/`fetchNewApiCatalog`/`fetchUpstreamCatalog` 的 vendors 参数由 ModelCatalog 改为 `ModelOverrideRule[]`，合成优先级不变（vendor 规则 → 快照精确 → 根 rules → gpt-5.5 兜底）。
- **[测试]**: 新增 "bundled vendor presets fully define z.ai, moonshotai, and deepseek models" 守卫用例（编译真实 vendor 文件并断言 glm/k3/deepseek 的窗口、推理档、截断策略及零 GPT 残留），阶梯测试的 vendors 改用规则编译；121 用例全过。

### 🧠 Design Intent (Why)
同一份分组覆盖表格式被 `loadModelOverrides` 直接消费，vendor 预设与用户可编辑的根目录覆盖表同构，学习与维护成本最低；双模式匹配（vendor/name + 裸 name）对 CLIProxy 路径与 new-api 裸 ID 路径同时适用，无需为厂商预设另设一套解析。

### 📊 Change Stats
> 工作区未提交改动（含同日 new-api 系列任务累计）；`models/vendor_models.json` 净收益为格式重写（约 230 行）。

- **Files changed:** 4（本轮净改动）+ 历史累计
- **Insertions:** 累计约 +750；**Deletions:** 累计约 -40

### 📁 Files Modified
- `models/vendor_models.json`（分组格式重写）
- `src/catalog.ts`（compileModelOverrides、vendors 规则化）
- `src/cli.ts`（vendor 编译接线）
- `test/gateway.test.ts`（新增 bundled 预设守卫，121 pass）
- `README.md`