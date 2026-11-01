## [2026-11-01 15:54] | Task: 重新启用 ZCode Start Plan（体验套餐）路由

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3（account:zai-individual-coding-plan）`
* **Runtime**: `ZCode Desktop 3.17.1`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> Magpie 有对zcode startup套餐的调用，分析一下逻辑，把停掉的体验套餐兼容一下

### 🛠 Changes Overview
**Scope:** packages/zcode、test

**Key Actions:**
- **[分析 Magpie]**: 调研 magpie-community/plugins zcode 插件 v0.1.40（相对本仓 2026-10-07 调研的 v0.1.12）的 start-plan 调用逻辑：三段 system 块伪装、`-Trial` 无回落语义、配额错误（1113/1005）60 秒 blocked、3012 已演化为账号级封禁（官方 App 同样中招）。
- **[真实根因定位]**: 本机对照实验证明 405/3012 的三层根因——① 中继按**当前客户端版本**的 system 前缀文本校验（3.17.1 已改写 cli_prefix 为 "You are ZCode, an interactive agent" 并重排段落，magpie 沿用的 3.14.3 文本实测被拒）；② 官方 `assembleSystemMessages` 第一段 cli_prefix **不带 cache_control**；③ 中继按 HTTP 协议画像拒绝 Bun fetch 的 h2 流量（同头同正文：HTTP/1.1 200、h2 405），官方客户端跑 Node 运行时恒 h1。
- **[路由启用]**: `index.ts` planRoutes 注册 `start-plan`，目录暴露 `zcode-start-plan/*`（本机镜像有活的 ZCODE WEEKEND BUILD 桶：GLM-5.3-Flash 5 亿 token，2026-11-02 09:00 到期）。
- **[请求形态]**: 新增 `start-plan-request.ts` 与 `start-plan-prompt.json`（3.17.1 官方文本，程序化提取自 zcode.cjs，各段 SHA-256 校验进测试）：system 三段重组（网关旁白并入第三段末尾）、首条 user turn 为官方 meta_user 环境段（# Environment + powered-by + 当日日期）、`metadata.user_id` 补设备 ID（telemetry-state.json 的 deviceMid）、URL 剥 query、剥离 anthropic-beta、头集合对齐官方（补 `x-zcode-query-source`、UA 加 `ai-sdk/anthropic/3.0.81` 后缀、不发 accept/x-query-id）。
- **[HTTP/1.1 传输]**: `createStartPlanFetch()` 用 node:https 恒走 h1；测试注入 fetch 时自动复用 mock 保持隔离。
- **[错误语义]**: 405/3012 原样透传 status 并附中文归因（区分账号封禁与阿里云边缘 IP 封锁）；凭据按路由隔离，gift 失败不烧个人/团队 Coding Plan。
- **[验证]**: 端到端实测网关全链路 200（Responses→协议转换→三段形态→h1→zcode-plan 中继），模型正常回复且 `cached_tokens: 1024`（system 前缀缓存命中，形态与官方缓存键兼容）。

### 🧠 Design Intent (Why)
Start Plan 路由自 2026-09-19 因 3012 风控关闭。本次 Magpie v0.1.40 源码分析 + 本机对照实验证明：3012 对「完整伪装官方形态的请求」不再一票否决（billing/balance 200 证明账号未封），真正的门槛是官方 3.17.1 的请求形态（prompt 文本重排 + h1 传输）。网关已有套餐槽位前缀结构（`zcode-start-plan/`，等价 magpie 的 `-Trial`）天然保证无回落，重新暴露的风险敞口只是「请求失败返回错误」，不会误烧付费额度。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（本次任务的工作区改动）。

- **Files changed:** 6
- **Insertions:** +576
- **Deletions:** -26

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/zcode/src/start-plan-request.ts` | +220 | -0 |
| `packages/zcode/src/start-plan-prompt.json` | +21 | -0 |
| `packages/zcode/src/index.ts` | +41 | -16 |
| `packages/zcode/src/request-context.ts` | +35 | -6 |
| `test/zcode-start-plan-request.test.ts` | +171 | -0 |
| `test/zcode-gateway.test.ts` | +58 | -4 |

### 📁 Files Modified
- `packages/zcode/src/start-plan-request.ts`（新增）
- `packages/zcode/src/start-plan-prompt.json`（新增）
- `packages/zcode/src/index.ts`
- `packages/zcode/src/request-context.ts`
- `test/zcode-start-plan-request.test.ts`（新增）
- `test/zcode-gateway.test.ts`

### ✅ Verification
- `bun run check`：1272 pass / 0 fail（build + typecheck + test）。
- 端到端实测（本机真实凭据与 ZCODE WEEKEND BUILD 桶）：`zcode-start-plan/glm-5.3-flash` 经网关返回 200，回复 "ok"，usage `cached_tokens: 1024`。
- 对照实验记录见 `docs/zcode-start-plan-research.md` 2026-11-01 章节。

### ⚠️ 附：测试污染事件与修复（同日 16:00-16:10）

用户报告「Codex 里的 catalog 都没有了，只剩 apikey 的」。定位：`test/zcode-signing.test.ts`
注入 `planCaches`（zai-test 快照）但未传 `cacheDirectory`，把测试目录
`zcode-zai-test/glm-5.3` 写进真实的 `~/.agent-proxy-gateway/zcode-catalog.json`
（既有缺陷，非本次改动引入；实验确证：修复前该测试单跑即改写真实文件，
补 `cacheDirectory: directory` 后 mtime 不变）。其他 agent 的 gateway 测试存在
同类落盘缺口（`codebuddy/agy/zen/qoder-catalog.json` 的 mtime 落在测试运行
窗口），已记 tech-debt。

恢复：`launchctl kickstart -k gui/$UID/codex-cliproxy-gateway` 重启网关——
全部 `*-catalog.json` 重建（16:07），新代码随源码服务上线（目录含
`zcode-start-plan/glm-5.3-flash`），经真实端口 8320 请求 start-plan 模型
返回 completed（回复 "ok"）。

### 🔧 附二：anthropic 端点（/v1/messages）验证与三处修复（同日 16:10-16:40）

用户要求验证 anthropic 端点，暴露三个缺陷（均为既有问题，非 start-plan 改动引入）：

1. **非流式 502「响应已取消」**：`zcode/response.ts` 的 `finish()` 在正常完成
   （completed/incomplete）时也调 `cancelUpstream() → options.abort()`（forward
   级 `abort.abort()`），把仍在聚合输出的 anthropic/chat/gemini 出口 signal
   打断，llm-bridge 出口 shell 误判为客户端取消。修复：正常完成只释放上游
   reader，异常与取消终态仍传播 abort。流式出口因帧已发出而掩盖了尾部竞态。
2. **字符串 content 400「convertRequest 返回了无效消息」**：Anthropic Messages
   API 合法的 `"content": "string"` 形态被 `anthropicMessagesOf` 的数组断言拒绝。
   修复：字符串归一化为 text 块数组。
3. **工具调用 stop_reason 误报 end_turn**：llm-bridge 对 Responses **整包 JSON**
   的重放路径（`events.ts`）未感知 function_call 输出（SSE 路径有 `sawToolCall`
   修正，JSON 路径漏了），completed 一律给 `stop`，anthropic 出口呈现
   end_turn，客户端工具循环可能不触发。修复：`responsesStopReason` 增加
   `sawToolCall` 参数，JSON 重放路径与 SSE 一致。

验证：`bun run check` 1274 pass（新增 anthropic 出口非流式/流式/字符串
content/工具调用四组断言）；真实端口 8320 四场景实测全部通过（非流式数组、
非流式字符串、流式完整事件序列到 message_stop、工具调用
`stop_reason: tool_use` + `get_weather {"city":"北京"}`）。

### 🧹 附三：指纹数据收敛到 fingerprint-data.json（用户裁决，同日 16:40-17:00）

用户指出 start-plan 的指纹数据不应在代码硬编码、`start-plan-prompt.json`
不应独立维护（其他套餐的提示词都在 fingerprint-data.json 一起更新）：

- **UA 统一**：删除代码硬编码的 ` ai-sdk/anthropic/3.0.81` 后缀与临时的
  `startPlanUserAgentTemplate` 双模板——3.17.1 拆包确认 AI SDK 客户端工厂
  （`pD`）对**所有** anthropic 请求统一追加后缀（coding plan 与 start-plan
  同一路径，非端点差异；3.14.5 无后缀为版本演进）。`userAgentTemplate`
  统一为 `ZCode/{version} ai-sdk/anthropic/3.0.81`，双端点实测 200。
- **提示词并入**：删除 `packages/zcode/src/start-plan-prompt.json`，官方段落
  文本并入 `fingerprint-data.json` 的 `startPlanPrompt`（identity/
  desktopContext/dynamicBehavior/contextManagement/environment）；cli_prefix
  与 `agentSystemPrompt` 是同一官方文本，单一来源复用。
- **快照升级**：`appVersion` 3.14.5 → 3.17.1；`agentSystemPrompt` 更新为新
  开场句 "You are ZCode, an interactive agent"（`buildCliPrefixSection`）。
- 测试同步：UA 断言统一模板形态、SHA 校验改指 fingerprint-data.json 字段；
  `bun run check` 1274 pass。
