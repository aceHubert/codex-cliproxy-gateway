## [2026-11-03 12:13] | Task: 降级 Codex Desktop 注入的无 call_id function_call_output

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: GLM-5.3 (account:zai-individual-coding-plan)
* **Runtime**: ZCode CLI
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: fix/zcode-startplan-catalog

### 🛥 User Query
> codex://threads/01a19c5f-31a5-7f72-9129-ecdf7a308605
> function_call_output.call_id 必须是非空字符串

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、packages/agy、test

**Key Actions:**
- **[llm-bridge 降级回放]**: Responses 源 history 中无 call_id 的 `function_call_output` / `custom_tool_call_output`（Codex Desktop 跨线程 delegation 注入通知）不再 400，原位降级为带标签的 user 通知并写入 notes；call_id 非空但配不上调用仍显式拒绝。
- **[agy 同合同放宽]**: agy 自有 Gemini 形状转换对同一反例按原位 user 文本通知降级（Gemini 无法表达无调用的 functionResponse）。
- **[回归测试]**: llm-bridge 两例（降级回放 + 孤立 call_id 仍拒绝）、agy 一例（降级文本通知）。

### 🧠 Design Intent (Why)
2026-11-03 11:23 实测（gateway.log + `logs/codebuddy-v1-responses-http-20261103112318.log`）：Codex Desktop 0.166 的跨线程消息功能把 delegation 通知以 `function_call_output` 形状注入 input history（带 `namespace: codex_app`、`name: send_message_to_thread` 与 output，却无 call_id、无对应调用）。该请求经 `x-codex-routing-hint` 路由到 codebuddy-cn 通道后，桥接的 `requiredString(item.call_id, ...)` 直接 400「function_call_output.call_id 必须是非空字符串」，整回合中断。这是 harness→模型的通知而非工具结果，跨协议没有可配对的调用可回放，因此沿用仓库既有「降级 + 显式记录」政策（与 `narrateServerCalls`、reasoning 信封剥离同款）：保内容、保位置、notes 可观测，而不是把官方客户端的新形状当作协议损坏拒绝。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（本次任务未提交的工作区改动，仅统计四个相关文件；同分支另有 zcode-catalog 无关改动未计入）。

- **Files changed:** 4
- **Insertions:** +91
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/request.ts` | +22 | -1 |
| `packages/agy/src/request.ts` | +12 | -1 |
| `test/llm-bridge-convert.test.ts` | +39 | -0 |
| `test/agy-request.test.ts` | +18 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/request.ts`
- `packages/agy/src/request.ts`
- `test/llm-bridge-convert.test.ts`
- `test/agy-request.test.ts`
