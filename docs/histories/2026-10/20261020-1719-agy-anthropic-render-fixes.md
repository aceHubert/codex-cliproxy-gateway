## [2026-10-20 17:19] | Task: 修复 agy Anthropic 渲染四缺陷（空工具名/整体缓冲/签名断裂/流式回调脱上下文）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/agy-anthropic-tool-block-render`（基于 origin/main v0.16.0，改动保留在工作区未提交）

### 📥 User Query
> 排查会话 session_99cc9f1a… 的工具调用错误（`tool name is empty`）；随后追加修复：思考不随流显示、thought_signature 回放被上游 400 拒绝；排查新会话 session_7267951b…「思考最后一秒才出来、体感慢」。基于 main 创建 fix 分支修改，不提交代码。

### 🛠 Changes Overview
**Scope:** packages/agy（响应渲染/请求归一/适配器回调）、test/（回归测试）

**Key Actions:**
- **[空工具名]**: `renderAnthropicClient` 的 `openTool` 改为接收 function_call item，只推送一条带真实 `call_id`/`name` 的 `content_block_start`；非流式聚合的重复 tool_use 块随之消失。
- **[整体缓冲]**: 三个客户端渲染器（anthropic/chat-completions/gemini）经新增 `incrementalSseResponse`（pull 型 ReadableStream，`highWaterMark: 0`）逐帧增量下发；取消沿链路回传；非流式保持全量聚合；删除失去调用方的 `strBytes`。
- **[签名断裂]**: 响应侧把 `agn1:` 信封 reasoning 项渲染为带 `signature_delta` 的独立 thinking 块（非流式聚合保留 `signature`）；请求侧 anthropic 归一化把带 `agn1:` signature 的 thinking 块回放为 reasoning 项，由共用路径挂回下一个 functionCall 的 `thoughtSignature`。
- **[流式回调脱上下文]**: 增量化后流式回调（onChunk/onComplete/sanitizeError/abort）由客户端 pull 驱动、在 forward 返回后触发，脱离 `withHostServices` 的 AsyncLocalStorage 上下文；`logExchange` 经 `getHostServices()` 抛「插件主机上下文未初始化」且被 `safely()` 吞掉，导致流式成功请求的请求日志与摘要自增量版本起静默丢失（线上以 16:52 临时探针实证）。适配器在 forward 入口捕获宿主并以 `withHostServices(host, …)` 包裹四个回调重入上下文。
- **[测试]**: 新增 8 个用例——空工具名（流式/非流式）2、三协议增量下发（门控上游 + 带超时读取）3、签名下发/回挂 2、宿主作用域外消费仍写请求日志 1（模块顶层「作用域外执行器」确定性复现 AsyncLocalStorage 逃逸；无修复时该用例失败，已验证）。

### 🧠 Design Intent (Why)
前三个缺陷同源于 `9840884` 按「批量转换」实现的渲染层（空工具名事件重复推送、全量缓冲、Responses 路径有签名回挂而 Anthropic 路径双向缺失）。第四个缺陷是增量化的直接后果：真实网关中流式响应由客户端 pull 驱动，Bun 的流调度不继承 AsyncLocalStorage，回调里调用宿主服务（日志）必须在适配器层显式重入创建时的宿主上下文——这也解释了 15:53 起流式成功请求没有请求日志的现象（错误路径在 forward 内同步落盘故不受影响）。思考「最后一秒才出现」经逐事件计时实测确认为上游行为：Antigravity 在整个思考阶段不产生任何输出（连 HTTP 响应头都不发），思考摘要在思考结束瞬间整帧下发、正文随后流式跟上，网关侧无法改善。

### 📊 Change Stats
> 数据来自 `git diff --stat origin/main`，只统计本次任务相关改动。

- **Files changed:** 5
- **Insertions:** +477
- **Deletions:** -149

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/agy/src/response.ts` | +202 | -141 |
| `packages/agy/src/index.ts` | +13 | -7 |
| `packages/agy/src/request.ts` | +11 | -1 |
| `test/agy-protocol.test.ts` | +191 | -0 |
| `test/agy-gateway.test.ts` | +60 | -0 |

### 📁 Files Modified
- `packages/agy/src/response.ts`
- `packages/agy/src/index.ts`
- `packages/agy/src/request.ts`
- `test/agy-protocol.test.ts`
- `test/agy-gateway.test.ts`

### ✅ Verification
- `bun run check`：构建 + 严格类型检查 + 1232 个测试全部通过（含新增 8 个）。
- 线上验证（重启 8320 serve 后实测）：流式成功请求恢复写入请求日志（`agy-v1-messages-http-20261020171314.log`，4974B 含完整事件流）与 gateway.log 摘要（`POST /v1/messages -> 200 (6373ms)`）。
- 逐事件计时（3 次实测）：TTFB ≈ 思考耗时（6.0–7.4s）内零字节，思考单帧到达后 70ms 起正文按帧流式——确认「思考整块、正文流式」为上游粒度，网关增量透传正确。
