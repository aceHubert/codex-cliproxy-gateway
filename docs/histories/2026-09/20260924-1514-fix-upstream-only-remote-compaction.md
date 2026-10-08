## [2026-09-24 15:14] | Task: 修复 cliproxy WebSocket 绕过远程上下文压缩重写

### 🤖 Execution Context
* **Agent ID**: `ZCode`（初次实现：`codex`）
* **Base Model**: `space-bunny-alpha`（初次实现：`gpt-5`）
* **Runtime**: `ZCode Desktop`（初次实现：`Codex Desktop`）
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> `cliproxy/` 下的模型之前已经兼容远程压缩 v2，现在再次出现
> `expected exactly one compaction output item, got 0 from 2 output items`。
>
> 初次修复部署后反馈：`压缩还是有问题`。随后要求：`直接看日志分析`。

### 📊 Runtime Evidence
- 2026-09-24 16:18:52 至 16:22:29 连续 9 次 `POST /v1/responses` 返回 502，错误均为 `Upstream compaction returned no summary text`。
- 本地代码只有在 sidecar 响应为 `status=completed` 后才提取摘要；旧提取器仅接受 `output[].type=message` 与 `content[].type=output_text`，与真实非 GPT 上游返回形态可能不兼容。
- 16:22:57 的最后一次失败耗时 18.943 秒，错误为 `The connection was closed.`，属于独立的上游连接中断，不是摘要解析失败。
- 配套 WebSocket 日志记录客户端 1006、上游 1000；launchd 网关进程持续运行，不是网关崩溃。

### 🛠 Changes Overview
**Scope:** `src/gateway.ts`、`src/realtime.ts`、`test/gateway.test.ts`、`test/realtime.test.ts`

**Key Actions:**
- **[WebSocket v2 sidecar]**: `cliproxy` WebSocket 收到含 `compaction_trigger` 的 `response.create` 帧时，不把原帧转发给上游；网关复用 HTTP 压缩请求构造逻辑，经同一上游的 HTTP `/responses` 获取摘要。
- **[WebSocket 响应合成]**: 摘要成功后沿原 WebSocket 返回 `response.created`、`response.output_item.done`、`response.completed`，最终只包含一个 `type=compaction` 条目。
- **[WebSocket 历史回放]**: 下一帧包含 `compaction` 历史时改写为可读文本后继续通过 WebSocket 转发，不降级 SSE。
- **[HTTP 兜底]**: upstream-only 的 HTTP Responses 请求也不再提前裸直通，保留 `ocx1` 摘要回放能力；这是同一类旁路的补强。
- **[摘要提取兼容]**: 标准 Responses 形态保持优先，同时兼容字符串 content、`text` 内容块、顶层 `output_text`/`text` 与 Chat Completions 消息；reasoning summary 不会被误当作持久化摘要。
- **[安全结构诊断]**: 仍无法提取摘要时只报告顶层字段名、输出条目类型及 content/summary/choices 结构，不记录响应正文、摘要文本或凭据。
- **[回归测试]**: 使用真实的 `cliproxy/free/space-bunny-alpha` 路由验证顶层 `output_text`、文本块、Chat Completions、WebSocket sidecar、摘要回放和诊断防泄露。
- **[构建产物]**: 执行 `bun run build`，刷新 CLI 使用的 `dist/index.js`。

### 🧠 Design Intent (Why)
HTTP 路径原本已经有 `compaction_trigger` 检测、摘要请求构造和单个
`compaction` 输出合成；首次回归来自 Responses WebSocket 桥接把客户端帧原样
转发到上游，无法经过这套逻辑。运行时日志进一步证明，初次修复后的 HTTP
sidecar 仍可能收到非标准文本结构，而旧提取器会把它误判成“无摘要”。

因此本轮保留 cliproxy WebSocket 和单 compaction 合成边界，统一扩展摘要提取，
并在无法识别时输出不含正文的结构指纹。上游主动关闭连接不伪装成解析修复，也不
在网关内自动重试模型请求，避免重复计费或重复执行。

### 🔧 Follow-up 修订
- 压缩 sidecar 不再转发 `include`、`reasoning`、`text`、`store`、`background`、
  `previous_response_id`、`conversation`、`prompt_cache_key` 等响应/会话元字段，
  避免 CLIProxy 对非 GPT 模型返回 `status=completed` 但没有 `output` 的空响应。
- v2 压缩 sidecar 改用 `stream:true`，聚合 Responses SSE 的文本增量、终态和
  `response.output_item.done/added`；合成响应补齐 `created → added → done → completed`
  事件序列，上游已经生成的 opaque compaction item 原样保留。
- 压缩历史只解码本地 `ocx1:` 摘要，其他上游 opaque 载荷继续回放给同一模型。
- WebSocket sidecar 对包含 `error` 的上游响应直接失败，并在压缩请求异常时关闭桥接，
  不把空结果伪装成成功的 compaction 条目。
- 新增字段清理、SSE 摘要、opaque compaction、空完成响应、WebSocket 关闭行为的回归测试。

### 📊 Change Stats
> 数据来自本次工作树 `git diff --shortstat` 与 `git diff --numstat`。

- **Files changed:** 4
- **Insertions:** +834
- **Deletions:** -47

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +328 | -45 |
| `src/realtime.ts` | +53 | -0 |
| `test/gateway.test.ts` | +293 | -2 |
| `test/realtime.test.ts` | +160 | -0 |

### 📁 Files Modified
- `src/gateway.ts`
- `src/realtime.ts`
- `test/gateway.test.ts`
- `test/realtime.test.ts`

### ✅ Verification
- `bun test test/gateway.test.ts test/realtime.test.ts`：127 pass，0 fail
- `bun run check`：489 pass，0 fail；TypeScript 类型检查与构建通过
- `git diff --check`：通过
