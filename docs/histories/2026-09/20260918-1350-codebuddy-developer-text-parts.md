## [2026-09-18 13:50] | Task: 修复 codebuddy 通道误报「developer 消息不支持图片」

### 🤖 Execution Context
* **Agent ID**: codex
* **Base Model**: gpt-5.6-sol
* **Runtime**: Codex Desktop
* **Git User**: hubert <hubert@lejian.com>
* **Branch**: feature/codebuddy

### 📥 User Query
> 分析一下为什么提示不支持图片？（附件日志 codebuddy-v1-responses-http-20260918134724.log）

### 🛠 Changes Overview
**Scope:** src/codebuddy（Responses → Chat 请求转换）

**Key Actions:**
- **定位根因**：`translateCodebuddyRequest` 对 system/developer 消息只接受字符串 content，内容为数组时一律 `fail("developer 消息不支持图片")`；而 Codex Desktop 0.155 把 developer 上下文发成 5 个 `input_text` 块的数组（纯文本），于是网关本地抛 400 并回写 `{"error":{"message":"developer 消息不支持图片"}}`，52ms 即返回且日志无 upstream 段——请求根本没到上游。
- **修复转换**：新增 `systemContent`，数组内容中文本块用 `\n\n` 拼接进 system 文本，仅当真正出现图片等非文本块时才拒绝。
- **补测试**：文本数组 developer 消息拼接进 system；含 `input_image` 的 developer 消息仍显式拒绝。

### 🧠 Design Intent (Why)
* 旧逻辑默认「数组内容 = 多模态」，但 Responses 格式下纯文本也常按内容块数组发送；错误文案与实际不符（无图片却说图片不支持），且导致 codebuddy 通道对 Codex Desktop 完全不可用。保留对真实图片的拒绝，因为 Chat 的 system 角色只支持文本。

### 📊 Change Stats
- **Files changed:** 2
- **Insertions:** +46
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/request.ts` | +15 | -3 |
| `test/codebuddy-request.test.ts` | +31 | 0 |

### 📁 Files Modified
- `src/codebuddy/request.ts`
- `test/codebuddy-request.test.ts`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/codebuddy-request.test.ts test/codebuddy-gateway.test.ts test/zcode-request.test.ts`：45 pass / 0 fail。
- 全量 `bun test` 剩余失败项均为 WebSocket 桥接与凭据热更新测试，与本次改动无关（未触及 realtime/credentials 路径）。

### 📎 后续补充（同日 18:40）：工具输出图片提升为 user 消息

**问题**：`function_call_output` 的 output 含 `input_image` 块时，`toolResult` 直接 `fail("function_call_output 包含不支持的内容块")`，视觉工具（view_image / 截图）的输出无法发给模型。

**根因**：OpenAI Chat 格式的 `role: "tool"` 消息 content 只支持字符串，放不了多模态数组——协议形状限制，不是模型能力问题（zcode 走 Anthropic 格式，tool_result 原生支持图片块，所以不报错）。

**修复**：`toolResult` 拆成 `{ text, images }`，文本进 tool 消息，图片经 `imagePart` 转成 `image_url` 块后插入紧随其后的 user 消息上传，与 zcode 通道语义一致。未知块类型仍显式拒绝（错误信息补充了具体类型）。

**验证**：`bun run typecheck` 通过；codebuddy/zcode 相关 62 个测试全部通过。
