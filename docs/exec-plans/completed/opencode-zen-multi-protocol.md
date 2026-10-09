# OpenCode Zen 多协议端点支持与目录策略收敛

## 目标

按官方元数据 `provider.npm` 将 Zen 免费模型的端点协议（chat / responses / anthropic / google）全部纳入网关：目录保留所有未下线模型，转发层按协议自动转换，`/v1/chat/completions` 与 `/v1/responses` 两个客户端入口都能消费任意协议的模型；地区限制不再作为剔除依据（与本地网络相关）；已下线（deprecated）与所有已支持协议均不服务的模型（systemone 的 jev）继续剔除。

## 范围

- 包含：
  1. **目录策略**：移除"非 chat 协议"过滤（协议改为路由依据而非过滤依据）；deprecated 仍剔除；元数据缺失模型改多端点探针阶梯（chat → responses → anthropic → google），首个"被服务"信号确定协议，全阶梯无信号才 drop；RegionError 视为"被服务"。
  2. **转换层**（`src/opencode-zen/convert.ts`）：responses → chat 严格手写（llm-bridge 实测丢弃 instructions、parallel_tool_calls、function_call 历史与 custom 工具，工具轮会断裂；对齐 codebuddy/request.ts 先例）；其余跨协议方向以 chat 为规范中间层经 llm-bridge 转换；流式统一经 `handleUniversalStreamRequest`；非流式 responses 客户端由新增聚合器还原完整 response JSON。
  3. **转发层**：chat 入口对非 chat 协议模型做请求转换 + 响应流反向转换；responses 入口对 responses 协议模型直通（无需转换），其余协议自动转换；chat 协议模型在 responses 入口经严格转换后仍需注入官方模板（chat 端点门禁要求）。
  4. **网关接线**：移除 `/v1/responses` 对 zen 模型的 400 拒绝改为分发；`/v1/responses/compact` 保持拒绝。
- 不包含：
  - systemone（Jev）协议支持：结构化判定协议，无法映射为 chat/responses，继续剔除。
  - Google 与 anthropic 协议的实网验证：当前无免费 google 模型、anthropic 免费模型全部 deprecated，仅单测覆盖。

## 背景

- 相关文档：`docs/opencode2-zen-free-models-gateway-research.md`、`docs/exec-plans/completed/opencode-zen-free-models-proxy-integration.md`、`docs/histories/2026-10/20261008-2100-opencode-zen-acceptance-and-log-retention-fix.md`。
- 相关代码：`src/opencode-zen/`、`src/gateway.ts` 的 responses 分发、`llm-bridge` 2.0.1（zcode / codebuddy 已在用）。
- 已知约束（2026-10-08 实测）：
  - 门禁：chat 端点要求首条 system 含官方模板（现有注入）；responses 端点对 responses 模型仅验指纹（无需模板），对 chat 模型回 FreeTierError；messages / google 端点对非本协议模型回 FreeTierError。
  - llm-bridge 2.0.1 缺口：responses→chat 丢 instructions、parallel_tool_calls、function_call 历史、custom 工具；流式转换两方向工具事件完整（实测）。
  - muse-spark-1.3-contributor-free（responses 协议免费模型）在当前网络被地区限制（RegionError），协议正确性只能验证到"过门禁"。
  - Google 端点路径取自官方客户端 AI SDK 的 URL 构造：`models/<id>:generateContent` / `:streamGenerateContent?alt=sse`。

## 风险

- 风险：responses 入口转 chat 后的事件流与 Codex 期望不完全一致（如 response.created 的 model 字段为空）。
- 缓解：以 Codex 形状的真实请求做端到端验证事件序列；不一致处在转换层补事件字段。
- 风险：探针阶梯对地区限制模型可能协议误判（chat 端点 RegionError 先于协议检查，会判成 chat）。
- 缓解：该类模型在地区放行后 24h 内重新探针自愈；作为已知边界记录。
- 风险：anthropic / google 路径无实网验证。
- 缓解：单测覆盖形状；tech-debt 记录待有活体免费模型时复验。

## 里程碑

1. 计划与接口收敛（本文件）。
2. catalog 改造（过滤策略 + 协议暴露 + 探针阶梯）。
3. convert 模块 + 转发路由 + 网关接线。
4. 测试与真实上游验证、文档归档。

## 验证方式

- 命令：`bun run check`。
- 手工检查（临时网关 8399，真实上游）：
  - 目录：12 个模型（含 muse-spark-1.3），jev 经阶梯 drop；
  - `/v1/responses` + nemotron（Codex 形状，含 tools）：200 真实响应事件流；工具往返返回 function_call；
  - `/v1/responses` + muse-spark：RegionError 直通（协议路由证明）；
  - `/v1/chat/completions` + muse-spark：RegionError（chat→responses 转换过门禁）；
  - 非流式 responses 客户端：聚合出完整 response JSON。
- 观测检查：请求日志 `opencode-zen-*` 记录模型与流式标记；缓存文件含协议裁决。

## 进度记录

- [x] 计划与接口收敛。
- [x] catalog 改造。
- [x] convert + 转发 + 接线。
- [x] 测试与真实上游验证（bun run check 718 全绿；真实上游 8/8）。

## 决策记录

- 2026-10-08：地区限制不再剔除（与本地网络相关）；deprecated 与全协议不服务（jev）仍剔除。
- 2026-10-08：responses→chat 因 llm-bridge 实测缺口改为严格手写（对齐 codebuddy request.ts 先例）；其余方向以 chat 为中间层经 llm-bridge。
- 2026-10-08：用户所称"llm-lite"实为仓库既有依赖 llm-bridge（npm 上 llm-lite 已下架）；responses→chat 严格手写、其余经 llm-bridge 的混合策略据此确定。
- 2026-10-08：探针阶梯 chat→responses→anthropic→google；RegionError / 200 / 429 / 5xx 视为"被服务"；FreeTierError 视为该端点不服务该模型（继续阶梯），但第一阶梯（chat）出现 FreeTierError 视为指纹全局异常、保守保留为 chat；全阶梯无信号才 drop。
