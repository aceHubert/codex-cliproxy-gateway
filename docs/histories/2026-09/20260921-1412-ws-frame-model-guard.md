## [2026-09-21 14:12] | Task: WS 桥逐帧拒绝 HTTP-only 模型族

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/config-restart-codex`（按用户要求改动不提交，留在工作区）

### 📥 User Query
> The 'codebuddy-cn/hy4-preview-f' model is not supported when using Codex with a ChatGPT account. 在切换 region 后，怎么会直接走到上游去了？→ 确认只处理了 cliproxy/ 前缀后，判定为 bug，要求设计处理方案文档并实施。

（事故背景：2026-09-21 11:51，region 切换后 Codex picker 仍持旧地域模型；`response.create`（model=`codebuddy-cn/hy4-preview-f`）复用在按 hint `model=gpt-5.6-sol` 钉定 official 的预热 WS 桥上，逐帧守卫只认 `cliproxy/` 前缀，帧被原样透传到 `wss://chatgpt.com/backend-api/codex/responses`，官方后端回 400。完整排查证据见会话日志 `cliproxy-v1-responses-ws-01a0c18a-1948….log`。）

### 🛠 Changes Overview
**Scope:** codex-cliproxy 网关（`src/realtime.ts`、`test/realtime.test.ts`、README、执行计划）

**Key Actions:**
- **[判别联合]**: `checkFrameRouting` 返回值从 `string | null` 改为 `FrameRouting`（`forward`/`reconnect`/`reject`），保持单次 JSON 解析；cliproxy 族既有 1012 重连语义不变。
- **[家族识别]**: 新增 `httpOnlyModelFamily`，复用 `isZcodeModel`/`isCodebuddyModel` 纯前缀判定（覆盖 `zcode/`、`zcode-`、`codebuddy-{cn,intl}/`、`workbuddy-{cn,intl}/` 与旧无地域前缀），刻意不依赖 enabled 配置——族被禁用时帧级守卫是唯一防线。
- **[本地拒绝]**: message 处理器新增 `reject` 分支——不转发、关闭上游并以 1012 断开客户端，让 Codex 重新握手进入既有 426/HTTPS-SSE 降级链路；`ws-route-mismatch` 日志带 family/model；gateway.log 写错误摘要行（事故当时只能翻 ws 会话日志才能发现）。
- **[测试与验证]**: guard 单测改为判别联合断言并补全全部家族 × 双向桥用例；handler 级用例断言不转发、连接保持、官方帧恢复透传、gateway.log surfaced；`/tmp/verify-ws-frame-guard.ts` 完整桥接路径实机验证（假官方上游 + 网关 + WS 客户端）6 项断言全过；`bun run check` 通过。
- **[文档]**: README CodeBuddy 章节补逐帧保护说明；执行计划 `docs/exec-plans/active/responses-ws-frame-guard.md` 完成后归档至 `completed/`。

### 🧠 Design Intent (Why)
HTTP-only 族（zcode/codebuddy/workbuddy）的上游不是 Responses WebSocket 端点，只能走 HTTP 适配器；但 Codex Desktop 会跨模型复用预热连接，握手 hint 与帧模型失配时它们会漏到错误上游。处理方式在 2026-09-21 复核后改为「不转发 + 1012 断开 + 上游关闭」：cliproxy 是路由变化需重连，而这些族是网关已确认不支持 WS，必须进入重握手后的 426/HTTPS-SSE 降级链路。完整方案见 `docs/exec-plans/completed/responses-ws-frame-guard.md`。

### 📊 Change Stats
> 数据来自工作区 `git diff --numstat`（未提交）；README 的暂存区差异属本分支此前任务，仅计本任务新增段落。

- **Files changed:** 4
- **Insertions:** +286
- **Deletions:** -26

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/realtime.ts` | +60 | -12 |
| `test/realtime.test.ts` | +113 | -14 |
| `README.md` | +6 | -0 |
| `docs/exec-plans/completed/responses-ws-frame-guard.md` | +107 | -0 |

### 📁 Files Modified
- `src/realtime.ts`
- `test/realtime.test.ts`
- `README.md`
- `docs/exec-plans/completed/responses-ws-frame-guard.md`（自 `active/` 移入）
