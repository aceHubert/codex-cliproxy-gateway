## [2026-10-09 00:36] | Task: OpenCode Zen 多协议端点支持（目录策略收敛 + llm-bridge 转换 + responses 入口）

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Claude Fable 5.1 (claude-fable-5-1)`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> muse-spark是不是reaponses endpoint，这种不需要转换的支持
> 地区限制不剔除，和本地网络有关
> anthropic应该也支持，直接llm-lite转就好了，现在有过时筛选了，所有格式都改为支持，按npm的格式使用llm-lite转换
> jev剔除

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/`（catalog / convert / index）、`src/gateway.ts`、`test/opencode-zen-*`、执行计划与文档

**Key Actions:**
- **[目录策略]**: 移除"非 chat 协议"过滤，协议改为路由依据；deprecated 仍剔除；地区限制（RegionError）不再剔除（与本地网络相关）；元数据缺失模型改多端点探针阶梯（chat → responses → anthropic → google），首个"被服务"信号确定协议，401/404 直接 drop，第一阶梯 FreeTierError 视为指纹全局异常保守保留为 chat，全阶梯无信号才 drop（systemone 的 jev 按此剔除）。
- **[转换层]**: 新增 `src/opencode-zen/convert.ts`——responses → chat 严格手写（llm-bridge 2.0.1 实测丢弃 instructions、parallel_tool_calls、function_call 历史与 custom 工具，工具轮会断裂）；其余跨协议方向以 chat 为规范中间层经 llm-bridge（用户所称"llm-lite"，实为仓库既有依赖）转换；流式经 `handleUniversalStreamRequest`（实测工具事件两方向完整）；新增 responses SSE 聚合器（item_id/output_index 双键索引，兼容真实上游与 llm-bridge 重发射两种形状）。
- **[转发层]**: `forward()` 按模型协议路由（chat 原生；responses/anthropic/google 请求转换 + 响应流反向转换）；新增 `forwardResponses()`（responses 协议直通；chat 目标转换后仍注入官方模板；非流式聚合为完整 response JSON）。
- **[网关接线]**: `/v1/responses` 对 zen 模型从 400 拒绝改为分发；`/v1/responses/compact` 保持拒绝。
- **[测试]**: 新增 convert 用例 4 个、网关 responses 用例 3 个、目录协议用例 1 个；更新过滤/探针语义断言；`bun run check` 718 用例全绿。

### 🧠 Design Intent (Why)
按官方元数据 `provider.npm` 把四种端点协议全部纳入：协议决定路由而非过滤，避免误删可用模型；responses 入口对 responses 协议模型直通免转换（用户指出的 muse-spark 场景）；llm-bridge 在 responses→chat 的实测缺口（工具轮断裂）用严格手写对齐 codebuddy/request.ts 先例；地区限制属本地网络环境，探针只做协议判定不做可用性剔除。

### 📊 Change Stats
> 工作区未提交（延续本会话 OpenCode Zen 系列改动）；下列为本次任务涉及文件，工作区另有此前特性改动未计入行数。

- **Files changed:** 7（另：执行计划新增并归档、技术债追加、本记录）

| File | 说明 |
| --- | --- |
| `src/opencode-zen/convert.ts` | 新增：转换层 + responses 聚合器 |
| `src/opencode-zen/catalog.ts` | 协议类型与映射、过滤策略、探针裁决结构、store.protocol |
| `src/opencode-zen/index.ts` | 探针阶梯、协议路由、forwardResponses |
| `src/gateway.ts` | responses 入口分发接线 |
| `test/opencode-zen-catalog.test.ts` | 语义更新 + 协议暴露测试 |
| `test/opencode-zen-gateway.test.ts` | responses 多协议测试 |
| `test/opencode-zen-convert.test.ts` | 新增：转换与聚合用例 |

### ✅ Verification
- `bun run check` 全绿（718 用例 + 类型检查 + 构建）。
- 真实上游端到端（临时网关 8399）8/8 通过：目录 12 个（muse 保留、jev 剔除）；responses 入口 + nemotron 流式 200（真实事件流，回答 "gateway ok"）；工具往返返回 function_call(lookup_issue)；responses 直通 muse → 地区限制原文透出；chat → responses 转换过门禁（同地区限制原文）；非流式 responses 聚合出完整 response JSON（output 文本 "agg ok"）。
- 流式转换诊断：合成流验证增量输出；真实流首字节延迟约 119s 为模型自身推理时长（keep-alive 期间无事件），转换管道正常终止、事件完整。

### 📌 Notes
- `llm-bridge` 即用户所称"llm-lite"：npm 上的 llm-lite 已下架（2026-08-28 发布后 unpublish），仓库 zcode / codebuddy 已在用 llm-bridge 2.0.1。
- 遗留（已记技术债）：anthropic / google 转换路径无活体免费模型未实网验证（形状由单测覆盖）；response.created 在首个上游数据块前不发射（慢模型首事件延迟）；地区限制模型的探针协议判定在 chat 阶梯可能误判（RegionError 先于协议检查，24h 重探自愈）。
