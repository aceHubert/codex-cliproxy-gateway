# [2026-11-05 10:35] | Task: 修复未声明工具调用断流与 analyze_image 执行腿可观测性

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 恢复两个失败的 Codex 会话（catchup）后确认修复：① `01a1a62c`（glm-5.3 经 zcode 腿）analyze_image 服务端 400/1210「图片输入格式/解析错误」；② `01a1a62f` 后续回合（deepseek 经 codebuddy 腿）「上游返回了未声明的工具：tool_functions__.exec_command__1c9f81b6a094」整条断流。原任务为排查「Herdr 桌面端停止 Agent 仍显示」（截图已由 image-reader 代读确认：持久终端 + 状态点无区分的 UX 问题，非本仓库缺陷）。

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、packages/zcode、test/

**Key Actions:**
- **[llm-bridge 容错]**: `output.ts` 新增 `tolerateUndeclaredToolCalls` 事件预处理（四个客户端输出接线）：上游回吐名先按「剥哈希后缀 + 分隔符归一」的骨架唯一匹配映射回声明名；无法对应则忽略该调用并注入客户端可见提示文本；全部调用被忽略时把 `stop_reason: tool_calls` 降级为 `stop`。导出 `remapUndeclaredToolName`。
- **[zcode 转换器软化]**: `response.ts` 未声明 tool_use 名同款处理（骨架映射或按未知块忽略），不再抛「ZCode 返回了未声明的工具」。
- **[vision 重试与观测]**: `vision.ts` 识别服务端把 MCP 错误当正常结果流回的形态（摘要片段开头 200 字符内 `MCP error <code>`）并计入重试；`onAttempt` 观测回调经 `reportAttempt` 包裹（不致命）。
- **[流内日志主机上下文重入]**: `index.ts` 在 `forward` 入口捕获 host，`log()` 与 `onAttempt` 的落盘调用显式重入——顺带修复插件交换日志从未落盘的隐性缺陷（生产无 `zcode-*`/`zai-*` 转储的根因）。

### 🧠 Design Intent (Why)
两起故障同源不同症：上游/模型会回吐与声明折叠名仅分隔符/哈希不同的调用名（DeepSeek 腿实测），或把嵌套工具名（`exec` isolate 内的 `exec_command`）模仿折叠格式幻觉成调用；严格身份表一次未命中就把整条 SSE 断掉，用户丢失整轮回复。1210 则是 Z.ai 服务端瞬时故障（同图同链路次日复现成功），但执行腿既不重试错误结果、也无任何留痕，故障无法归因。容错策略取「唯一骨架才映射、否则忽略并提示」，映射错工具比丢弃调用更危险；提示文本进入下一轮上下文供模型自纠。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作树未提交变更）。

- **Files changed:** 10（另新增执行计划文档 1 份）
- **Insertions:** +346
- **Deletions:** -39

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/output.ts` | +84 | -4 |
| `packages/zcode/src/index.ts` | +45 | -18 |
| `packages/zcode/src/vision.ts` | +53 | -1 |
| `packages/zcode/src/response.ts` | +12 | -3 |
| `packages/llm-bridge/src/index.ts` | +1 | -0 |
| `test/zcode-vision.test.ts` | +62 | -0 |
| `test/codebuddy-response.test.ts` | +43 | -5 |
| `test/zcode-response.test.ts` | +33 | -1 |
| `test/opencode-zen-gateway.test.ts` | +11 | -7 |
| `docs/exec-plans/tech-debt-tracker.md` | +2 | -0 |

### 📁 Files Modified
- `packages/llm-bridge/src/output.ts`
- `packages/llm-bridge/src/index.ts`
- `packages/zcode/src/response.ts`
- `packages/zcode/src/vision.ts`
- `packages/zcode/src/index.ts`
- `test/codebuddy-response.test.ts`
- `test/zcode-response.test.ts`
- `test/zcode-vision.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/exec-plans/tech-debt-tracker.md`（新增 2 条：其余插件流中段日志 ALS 断点、agy 未声明工具容错）
- `docs/exec-plans/completed/undeclared-tool-tolerance-and-vision-observability.md`（新增）

### ✅ Verification
- `bun run check` 全绿（boundaries + build + typecheck + 1298 tests）。
- 新增 9 个结果导向测试；更新 3 处旧断言（codebuddy-response「未声明的工具报错」、zcode-response 失败表移除 unknown tool、opencode-zen-gateway 两个入口用例改为提示收尾）。
- 线上验证（重启 launchd 服务后）：带图请求 `analyze_image` 首次尝试成功（41s），`gateway.log` 出现 `POST /v1/responses [analyze_image 1/3] -> 200` 摘要行，`logs/zcode-v1-responses-http-*.log` 首次真实落盘；codebuddy/deepseek 腿冒烟请求正常完成。
