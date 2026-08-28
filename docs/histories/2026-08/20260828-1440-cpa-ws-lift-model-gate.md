## [2026-08-28 14:40] | Task: 移除 CPA WebSocket 的模型门控

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 调用非 gpt-* 模型会报错（未混用模型）。先临时放开网关对非 gpt-/codex-* 模型走
> WebSocket 的限制做真机验证；确认 codex → ws → 网关 → wss → CPA → SSE → 上游链路
> 正常后，将这次改动正式化。

### 🛠 Changes Overview
**Scope:** src/gateway、测试、README、技术债追踪

**Key Actions:**
* **`responsesWebSocketTarget()`**：删除 `^(?:gpt-|codex-)` 模型门控，开启
  `websocket` 后所有 CPA 模型都桥接到 CLIProxyAPI，由 CPA 按请求决定上游走 ws 还是
  静默退回 HTTP/SSE；`websocket: false` 与 official 路由行为不变。
* **测试**：原"不兼容模型回 426"两处断言改为"同样放行桥接"；顺带删除引用已删脚本
  `scripts/deepseek_reasoning_content.js` 的遗留测试（补全 d546729 的意图）。
* **文档**：README 描述改为"every CPA model is bridged"；tech-debt 记录残余风险。

### 🧠 Design Intent (Why)
真机日志（`cliproxy-v1-responses-ws-*.log`）证实：非 gpt 模型经 ws 桥接后，CPA 对
每个请求自行退回 SSE 上游，端到端正常（`weixin/deepseek-v4-flash` 会话 36 请求 35
完成、无错误帧，唯一未完成轮为客户端主动中断）。原先网关层预判并 426 的价值有限：
混用导致的 CPA 426 `upstream_http_replay_required` 只发生在已建立连接内部的增量轮，
握手期门控本就防不住；而预判失败路径（客户端对试探 426 不降级）反而制造过报错。
门控移除后行为与直连 CPA 一致，残余风险与缓解方式记入 tech-debt-tracker。

### 📊 Change Stats
> 含补漏删除的遗留测试文件；`bun run check`（类型检查、90 测试、构建）全绿。

**`git diff --shortstat`：** 5 files changed, 14 insertions(+), 72 deletions(-)

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +2 | -8 |
| `test/gateway.test.ts` | +10 | -6 |
| `test/deepseek-reasoning-handler.test.ts` | +0 | -57 |
| `README.md` | +1 | -1 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |

### 📁 Files Modified
* `src/gateway.ts`
* `test/gateway.test.ts`
* `test/deepseek-reasoning-handler.test.ts`（删除）
* `README.md`
* `docs/exec-plans/tech-debt-tracker.md`
