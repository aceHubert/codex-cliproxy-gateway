## [2026-09-18 14:34] | Task: 修复 CodeBuddy DeepSeek 多轮思考回放

### 🤖 Execution Context
* **Agent ID**: codex
* **Base Model**: gpt-5.6-sol
* **Runtime**: Codex Desktop
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: feature/codebuddy

### 📥 User Query
> 根据既有「分析 CodeBuddy 图片不支持原因」会话继续修改，适配 DeepSeek thinking + tools 对历史 reasoning_content 的完整回传要求。

### 🛠 Changes Overview
**Scope:** src/codebuddy（Responses ↔ Chat 协议转换）

**Key Actions:**
- **[原文保留]**: 把上游流式 `reasoning_content` 写入模型绑定的本地不透明 `encrypted_content`，下一轮可精确恢复。
- **[历史回放]**: Responses reasoning 条目恢复为 Chat assistant 的 `reasoning_content`；兼容升级前由本适配器写入完整原文的 summary。
- **[同轮合并]**: assistant 文本与连续并行 function/custom tool calls 合并为同一条 Chat assistant 消息，保持 DeepSeek 原始轮次结构。
- **[空值语义]**: 保留空字符串 reasoning_content 的字段存在性，不再以 truthy 判断丢弃。
- **[回归测试]**: 覆盖模型绑定、跨模型拒绝、并行工具合并、空 reasoning 与网关两腿回放。

### 🧠 Design Intent (Why)
DeepSeek 在 thinking 请求携带 tools 时要求后续请求完整回传历史 assistant 的 reasoning_content。旧实现直接丢弃 Responses reasoning 条目，导致第二腿工具请求返回 400。适配采用与 ZCode 一致的本地模型绑定信封，避免依赖 reasoning/response id，也不使用空格伪造字段。

### 📊 Change Stats
- **Files changed:** 6
- **Insertions:** +278
- **Deletions:** -19

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/wire.ts` | +22 | 0 |
| `src/codebuddy/request.ts` | +73 | -11 |
| `src/codebuddy/response.ts` | +21 | -6 |
| `test/codebuddy-request.test.ts` | +64 | 0 |
| `test/codebuddy-response.test.ts` | +57 | -2 |
| `test/codebuddy-gateway.test.ts` | +41 | 0 |

### 📁 Files Modified
- `src/codebuddy/wire.ts`
- `src/codebuddy/request.ts`
- `src/codebuddy/response.ts`
- `test/codebuddy-request.test.ts`
- `test/codebuddy-response.test.ts`
- `test/codebuddy-gateway.test.ts`

### ✅ Verification
- `bun run typecheck` 通过。
- CodeBuddy 定向测试：37 pass / 0 fail。
- `bun run build` 通过。
- `bun run check` 在全量测试阶段被既有环境问题阻断：Bun port 0 监听失败、凭据 mtime 热更新用例失败，随后触发 node:test 嵌套执行错误；本次相关测试均已通过。
