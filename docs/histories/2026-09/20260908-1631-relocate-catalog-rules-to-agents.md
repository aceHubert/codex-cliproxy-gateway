## [2026-09-08 16:31] | Task: 模型目录合成说明改为 Agent 维护规则并迁入 AGENTS.md

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `deepseek-v4-flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 把 README「Using a new-api upstream」里 274-287 行的目录合成说明移到 AGENTS.md 中——这些是 Agent 需要了解的规则，不是给工具使用者阅读的。（前一问：codex_client_models.json 的获取说明改为“升级最新 Codex 后执行 codex debug models --bundled”）

### 🛠 Changes Overview
**Scope:** README.md、AGENTS.md（仅文档，无代码/测试变化）

**Key Actions:**
- **[获取说明替换]**: 删除 router-for-me/models 来源描述，改为“升级 Codex CLI 到最新版后，将 `codex debug models --bundled` 输出保存为 `models/codex_client_models.json`”。
- **[规则段落迁移]**: README 保留面向用户的精简句 + models.json 自定义示例；4 条合成优先级（vendor 预设 → Codex 快照精确命中 → models.json 覆盖 → gpt-5.5 克隆兜底）、快照刷新规程、覆盖规则匹配语义（vendor/model 与裸 ID 双匹配、组级 `*` 仅限本组前缀）整体迁入 AGENTS.md 新节「模型目录合成与匹配规则」。
- **[示例随迁]**: 按“models.json 覆盖规则是开发者配置、非终端用户配置”的口径，README 中剩余的覆盖规则 JSON 示例与作用域句一并删除，AGENTS.md 补充示例与分发/缓存说明（`--model-merge-json` GitHub URL → `releases/latest/download/models.json`）。
- **[并发改写说明]**: 编辑期间 README 该节被并发任务改写为编号列表（新增 models/vendor_models.json 维度），迁移按改写后的最新内容执行。

### 🧠 Design Intent (Why)
目录合成优先级、快照刷新与匹配语义是维护 Agent 修改 `catalog.ts`/重建 `models/` 资产时必须遵守的规则，读者是仓库协作者而非 CLI 使用者；README 的 new-api 章节只保留用户需要的“条目如何产生 + 如何自定义”即可。

### 📊 Change Stats
> README.md 工作区累计包含并发任务的未提交改动；AGENTS.md 为 HEAD 基线精确值，README 为本次任务删除段落的净变化（原 18 行引导段 + 示例 + 作用域句已全部移除，无新增行）。

- **Files changed:** 2
- **Insertions:** +21（AGENTS.md 新增整节，含规则与示例）
- **Deletions:** -18（README.md 段落删除）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +21 | -0 |
| `README.md` | +0（段内） | -18（段内，不含并发改动） |

### 📁 Files Modified
- `AGENTS.md`
- `README.md`
