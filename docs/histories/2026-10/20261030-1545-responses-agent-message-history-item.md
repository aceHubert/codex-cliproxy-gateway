## [2026-10-30 15:45] | Task: Responses 历史新增 agent_message 项类型转换支持

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-api)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 不支持的 Responses history 项类型 agent_message —— 看下这个问题，以 codex 中调用 codebuddy

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、packages/agy、test

**Key Actions:**
- **[llm-bridge 支持 agent_message]**: `responsesSourceToPrepared` 的历史项循环新增 `agent_message` 分支：Codex 多智能体历史中 agent 产出的消息（`author`/`recipient` 为内部路由元数据，跨上游无意义）按 assistant 回放文本与图片（复用 `describeResponsesContent` + `contentPartsFromImages`）；`encrypted_content` 内容块是上游私有的加密载荷，跨厂商不可解，剥离并经 `registry.note` 显式记录（与 reasoning 信封同款处理）。
- **[agy 独立副本同步]**: `translateAgyRequest` 的历史项循环新增同款分支，按 model 角色回放文本/图片，`encrypted_content` 直接剥离。
- **[回归测试]**: llm-bridge 语义用例（数组与字符串两种 content、encrypted_content 不外发且记 note、相邻纯文本轮不合并）；agy 用例（model 角色回放）；codebuddy 端到端用例（按 2026-10-30 抓包复现 `agent_message` + `additional_tools` 信封 + 信封内 custom 工具调用/输出对，断言 200、文本回放、加密载荷不外发、信封声明并入本轮工具）。

### 🧠 Design Intent (Why)
Codex 新版多智能体会话把 `agent_message`（agent 间消息）写入 Responses input 历史；`additional_tools` 信封此前已由 `normalizeResponsesToolDeclarations`（`convertRequest` 在 `to === "responses"` 时统一调用，agy 自有等价实现）提升合并，但 `agent_message` 不在任何转换器的已知类型表里，经 codebuddy 等通道直接 400「不支持的 Responses history 项类型 agent_message」（真实反例：`~/.agent-proxy-gateway/logs/codebuddy-v1-responses-http-20261030145649.log`）。修复保持该文件「未知类型显式拒绝」的策略不变：只把实测存在的 `agent_message` 纳入已知类型，文本语义按 assistant 回放，私有加密载荷剥离并留痕，不静默丢弃。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交改动，仅统计本次任务文件）。

- **Files changed:** 5
- **Insertions:** +133
- **Deletions:** -0

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/request.ts` | +18 | -0 |
| `packages/agy/src/request.ts` | +29 | -0 |
| `test/llm-bridge-convert.test.ts` | +30 | -0 |
| `test/agy-request.test.ts` | +20 | -0 |
| `test/codebuddy-gateway.test.ts` | +36 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/request.ts`
- `packages/agy/src/request.ts`
- `test/llm-bridge-convert.test.ts`
- `test/agy-request.test.ts`
- `test/codebuddy-gateway.test.ts`

### 📌 Known Boundaries
- `agent_message` 的 `encrypted_content` 只能剥离（OpenAI 后端加密，其他上游不可解）；剥离经 notes 可观测。
- 未观测到的新历史项类型仍显式 400 拒绝，不做兜底猜测；后续 Codex 再新增类型时按实测形状补充。
- zcode/qoder/opencode-zen 通道经 `convertRequest` 共享本次修复；agy 的独立转换副本已同步。
