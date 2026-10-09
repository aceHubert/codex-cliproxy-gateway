## [2026-10-09 11:20] | Task: OpenCode Zen reasoning effort 档位声明与映射

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> reasoning level是不是没有添加
> https://github.com/xiaozhe7772222/dsh-opencode-zen 看看这个里面怎么处理的

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/{catalog,fingerprint,convert}.ts`、`src/opencode-zen/free-models.json`、`test/opencode-zen-{catalog,fingerprint}.test.ts`、`docs/`

**Key Actions:**
- **[预置元数据扩充]**: `free-models.json` 重新自 opencode2 二进制模型库提取，新增 `effortLevels` 字段（5 个 effort 型免费模型：deepseek-v4-flash `low/high/max`、ling-3.0-flash 与 laguna-s-2.1 与 hy3 `low/medium/high`、north-mini-code `none/high`）；toggle/budget_tokens 型模型不产出该字段。
- **[目录声明]**: `catalog.ts` 新增 `zenEffortLevels` / `zenDefaultEffort`；`buildZenCatalog` 按模型发射 `supported_reasoning_levels`（effort 型模型暴露真实值域，默认档位取 high 或末项；无声明模型维持空档位 + medium 占位）。
- **[effort 归一化]**: `fingerprint.ts` 新增 `normalizeZenEffort`：chat 形状 `reasoning_effort` 与 Responses 形状 `reasoning.effort` 两路识别；`off`/空值省略；有声明的模型按值域裁剪（越界省略，避免上游 400——实测非法 effort 必拒）；无声明模型透传（nemotron 实测 high/low 均 200）。`injectZenFingerprintBody` 剥除原始 `reasoning` 对象与原始 `reasoning_effort`，仅写回裁决后的值。
- **[Responses 入口贯通]**: `convert.ts` 的 `responsesToChatBody` 把 `reasoning.effort` 转成 chat 形状 `reasoning_effort`（此前该字段被丢弃，Responses 入口的 effort 到不了上游）。
- **[测试]**: catalog 补「档位按模型声明」用例（含 5 个模型的真实值域与默认档位）；fingerprint 补「effort 归一化」与「注入请求体 effort 处理」两组用例；全量 `bun run check` 723 用例全绿。

### 🧠 Design Intent (Why)
用户发现目录没有 reasoning level 声明，并提供了社区实现 dsh-opencode-zen 作参考。调研结论：该仓库（2026-08-21）的传输层配方（极简标头、无会话头、旧式 UA）在当前门禁下已全部失效（实测 nemotron 403、deepseek 已轮换下线 401），但其档位设计（向选择器暴露档位 + 映射 `reasoning_effort` + off 省略）被采纳。与 dsh 的「全模型一刀切 off/low/high/max」不同，本实现按 opencode2 二进制元数据逐模型声明真实值域——上游实测非法 effort 值直接 400，一刀切声明会让客户端选出上游不接受的档位。同时补齐了 Responses 入口的 effort 丢失问题（此前 responsesToChatBody 丢弃 reasoning 条目）。

### 📊 Change Stats
> 数据来自本次任务工作区改动（`git diff --numstat` 未暂存部分 + 新增文件行数）。

- **Files changed:** 6（修改 4 + 新增测试用例在既有文件内）
- **Insertions:** +156
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/catalog.ts` | +46 | -3 |
| `src/opencode-zen/fingerprint.ts` | +48 | -4 |
| `src/opencode-zen/convert.ts` | +9 | 0 |
| `src/opencode-zen/free-models.json` | +33 | -0（重生成，结构升级） |
| `test/opencode-zen-catalog.test.ts` | +26 | -1 |
| `test/opencode-zen-fingerprint.test.ts` | +52 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 行（2026-10-09 条目） | — |
| `docs/histories/2026-10/20261009-1120-opencode-zen-reasoning-effort.md` | 新增 | — |

### 📁 Files Modified
- `src/opencode-zen/catalog.ts`、`src/opencode-zen/fingerprint.ts`、`src/opencode-zen/convert.ts`、`src/opencode-zen/free-models.json`
- `test/opencode-zen-catalog.test.ts`、`test/opencode-zen-fingerprint.test.ts`
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿（tsc + 723 测试 + 构建）。
- 真实上游端到端（临时网关 8399）：
  - 目录两种形状正常，effort 型模型当前已被官方 metadata 标记 deprecated 全部轮换下线（声明机制由单测覆盖，实网待模型回归后补验）；
  - 透传路径实网通过：`/v1/chat/completions` 带 `reasoning_effort: "high"` 请求 nemotron → 200，返回 reasoning 676 字符 + usage；
  - Responses 入口实网通过：`/v1/responses` 带 `reasoning: {effort: "low"}` 请求 nemotron → completed，内容正确（effort 不再被丢弃）。

### 📌 Notes
- dsh-opencode-zen 的参考价值仅限档位交互设计；其传输配方已过时，门禁三层校验见执行计划决策记录 #3。
- 遗留项（档位值域漂移、`reasoning_content` 拼写未折叠、透传策略未穷举）已记入 `tech-debt-tracker.md` 2026-10-09 行。
