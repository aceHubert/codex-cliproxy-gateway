## [2026-10-30 16:50] | Task: custom 工具响应侧 input 归一为字符串保住回合

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-api)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> stream disconnected before completion: custom tool input 必须是字符串（codex://threads/01a18b99-3466-7ed2-8beb-fde687858758，codex 调 codebuddy）——还有这个问题

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、test

**Key Actions:**
- **[custom input 归一]**: `ResponsesOutputShell.closeBlock` 不再对「custom 工具回参 input 非字符串」抛 `custom tool input 必须是字符串`（该异常经 `response.failed` 终止整回合，Codex 显示 stream disconnected before completion）。改为归一为字符串：字符串原样；对象/数字/布尔 JSON 序列化；缺失或 null 保留完整参数对象（`JSON.stringify(parsed)`），内容不静默丢失。
- **[边界测试口径更新]**（经用户确认选择「归一继续」）：原「custom 无效参数产生 failed，禁止发布包装或可执行正文」边界收窄为「参数为非对象 JSON（截断/数组/null/纯文本）时仍整回合 failed」；对象形状（`{}`、`{"input":42}`、`{"input":null}`、`{"foo":1}`、`{"input":{...}}`）改为断言归一后 completed 且内容保留。`test/opencode-zen-convert.test.ts` 的镜像用例同步收窄并补归一断言。

### 🧠 Design Intent (Why)
custom 工具以 `{input: string}` 信封声明给上游，但非 OpenAI 系模型（实测 deepseek via codebuddy，thread 01a18b99）可能不严格遵循 schema，把 input 写成对象或整段省略。旧实现按「禁止发布包装或可执行正文」整回合 failed，一次形状偏差即断流，回合不可恢复。经用户决策改为：对象形状归一为字符串（exec 执行异常 JS 会报工具错误，模型下一轮自行修正，优于断流）；无法无损归一的非对象 JSON（截断、数组）维持 failed，不放行残缺可执行内容。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交改动，仅统计本次任务文件）。

- **Files changed:** 3
- **Insertions:** +86
- **Deletions:** -16

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/output.ts` | +7 | -3 |
| `test/llm-bridge-response.test.ts` | +44 | -5 |
| `test/opencode-zen-convert.test.ts` | +35 | -8 |

### 📁 Files Modified
- `packages/llm-bridge/src/output.ts`
- `test/llm-bridge-response.test.ts`
- `test/opencode-zen-convert.test.ts`

### 📌 Known Boundaries
- 触发该修复的原始上游回参日志已被 maxRequestLogs 轮转，形状按错误路径与 deepseek 行为推断；归一覆盖全部对象形状。
- 截断 JSON 与非对象 JSON（数组/null/纯文本）仍整回合 failed——无法无损归一，维持不放行残缺可执行内容的边界。
- 该会话 16:26 后的连续 500（invoke model error / provider unavailable）与 429 是 codebuddy 上游容量问题，与本次修复无关。
