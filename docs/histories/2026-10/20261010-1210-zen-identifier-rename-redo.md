## [2026-10-10 12:10] | Task: zen 简写标识符补全为 opencodeZen 前缀（撤销重做版）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3-flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/opencode-zen`

### 📥 User Query
> 把变量命名补充完整，不能只叫zen, 要改成opencode zen
> （澄清 1）AGY/、CB-、WB-、OP-ZEN/ 这些简写没有问题，问题是代码命名直接使用zen，会导致后期扩展命名冲突风险
> （澄清 2）修改得不对，简写可以，但不能省略。还原所有非opencode 的修改。opencode zen 可以简写成 op zen, 但不能省略成 zen。例如 isZenModel(), 这个zen是哪家的请问？
> （指令）撤销这一次的修改，全部重新修改

### 🛠 Changes Overview
**Scope:** 仅 TypeScript 标识符（opencode 模块及其消费方）；字符串/显示前缀零改动

**Key Actions:**
- **[首轮撤销]**: 第一轮把错误消息（`zen upstream…`）、错误类型码（`zen_free_tier_error` 等）、合成响应 id 一并改名，且中途误改显示前缀（AGY/、CB-、WB-、OP-ZEN/），churn 混入非 opencode 文件。按指令 `git checkout` 全部还原（保留用户自己的 protocol-conversion-extraction.md 编辑），回到改名前基线。
- **[重做（最终态）]**: 严格限定「只改标识符」——24 个符号族由裸 `zen`/`Zen`/`ZEN_` 补全为 `opencodeZen`/`OpencodeZen`/`OPENCODE_ZEN_`：`isZenModel`→`isOpencodeZenModel`、`zenEnabled`→`opencodeZenEnabled`、`createZenAdapter`→`createOpencodeZenAdapter`、`handleZen`→`handleOpencodeZen`、`ZenDependencies`→`OpencodeZenDependencies`、`ZEN_*` 常量→`OPENCODE_ZEN_*`、依赖注入字段 `zen:`→`opencodeZen:`（保持可选 `?`）及类型索引 `["zen"]`→`["opencodeZen"]`；docs/fingerprint-data.md 的符号引用同步。标识符与配置字段 `opencodeZen`、目录前缀 `opencode-zen/` 对齐，消除后续扩展的命名冲突面。
- **[明确不动]**: 显示前缀 `OP-ZEN/`、`AGY/`、`CB-`/`WB-`（用户确认简写无问题）；错误类型码 `zen_*`、错误消息、响应 id 等字符串（本轮范围仅变量命名）。

### 🧠 Design Intent (Why)
裸 `zen` 标识符（如 `isZenModel()`）丢失产品归属——后续任何 zen 前缀的扩展都会与之冲突。补全为 `opencodeZen` 后命名携带完整产品身份（用户认可 "opencode zen" 全称或 "op zen" 简写，禁止省略成裸 zen）。首轮把字符串与显示前缀卷进来属于范围失控，撤销后以「diff 中每一行都必须因 zen 标识符而变」为验收线重做。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未暂存部分，即重做轮）。

- **Files changed:** 19
- **Insertions:** +456
- **Deletions:** -456

| File | +Added | -Removed |
| --- | ---: | ---: |
| `test/opencode-zen-catalog.test.ts` | +73 | -73 |
| `src/opencode/index.ts` | +69 | -69 |
| `test/opencode-zen-fingerprint.test.ts` | +56 | -56 |
| `src/opencode/catalog.ts` | +46 | -46 |
| `src/gateway.ts` | +39 | -39 |
| `test/opencode-zen-gateway.test.ts` | +35 | -35 |
| `test/opencode-zen-user-agent.test.ts` | +31 | -31 |
| 其余 12 个文件（cli/config-update/realtime/convert/response/user-agent/fingerprint.ts/ConfigPage 注释/model-exclude 测试×2/convert 测试/fingerprint-data.md） | +107 | -107 |

### 📁 Files Modified
- `src/opencode/{index,catalog,convert,response,fingerprint,user-agent}.ts`
- `src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/realtime.ts`、`src/ui/ConfigPage.tsx`（仅引用注释）
- `docs/fingerprint-data.md`
- `test/opencode-zen-*.test.ts`（6 个）、`test/model-exclude*.test.ts`（2 个）

### 🧪 Verification
- `bun run check` 全绿：typecheck 0 错误，827 tests / 0 fail。
- `grep -rE '\b(zen[A-Z]|Zen[A-Z]|ZEN_)'`（排除 OpencodeZen/opencodeZen/OPENCODE_ZEN）无残留裸 zen 标识符。
- 范围审计：`git diff | grep -v zen` 为空——每行改动都由 zen 标识符改名产生；`zen_free_tier_error`、`zen upstream`、`OP-ZEN/` 等字符串确认原样。
