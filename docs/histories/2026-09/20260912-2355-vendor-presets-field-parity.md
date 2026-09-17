## [2026-09-12 23:55] | Task: 补齐厂商预设缺失字段

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 对比一下 z.ai 的配置和 kimi 差多少字段配置，input_modalities 也没有。只有没有的互相补齐（glm-5-turbo 只支持 text）。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（模型目录资产）

**Key Actions:**
- **[z.ai 补 input_modalities]**: glm-5.3 / glm-5-turbo 补 `["text"]`，glm-5.3-flash 按其"首个原生多模态"描述补 `["text", "image"]`。
- **[moonshotai 补 supports_search_tool / apply_patch_tool_type]**: k3、k3-256k 补 `supports_search_tool: true` 与 `apply_patch_tool_type: "freeform"`，字段顺序对齐 z.ai 预设。

### 🧠 Design Intent (Why)
对比发现 z.ai 与 moonshotai 预设字段集互缺 3 个字段：合成基底（`minimalModelEntry`）不提供 `input_modalities` 与 `supports_search_tool`，缺失即产生实际行为差异（Codex 按纯文本模型处理 GLM、k3 无搜索工具）；`apply_patch_tool_type` 虽由基底兜底，显式声明可保持预设自洽。只补缺失字段，不动已有值（`default_reasoning_level` 等差异保留）。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交改动）。

- **Files changed:** 1
- **Insertions:** +10
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `models/vendor_models.json` | +10 | -3 |

### 📁 Files Modified
- `models/vendor_models.json`
