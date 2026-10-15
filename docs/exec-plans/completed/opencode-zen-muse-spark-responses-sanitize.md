# opencode-zen muse-spark 系列的 /responses 请求净化

## 目标

Codex 0.162（Desktop 0.162.0-alpha.17.2 / CLI 0.162.1）经网关使用 muse-spark-* 模型时，
`/v1/responses` 请求不再被上游 400 拒绝（`` `input[0]` did not match any supported type ``），
且工具声明能力保留；同时剥离上游不接受的 `web_search.search_content_types` 参数。

## 范围

- 包含：
  - `packages/opencode-zen/src/index.ts`：厂商适配层新增 muse-spark 前缀判断与请求体净化。
  - `test/opencode-zen-gateway.test.ts`：新增行为测试。
- 不包含：
  - 不改 `packages/llm-bridge`（同协议直通的 `structuredClone` 语义保持；跨协议路径已自行剥离）。
  - 不改网关自身 Codex→ChatGPT 路径（`gateway.ts` 已过滤 `additional_tools`）。
  - 不处理 `/v1/chat/completions`、`/v1/messages` 客户端方向（chat 端点已实测
    `ModelProtocolUnsupported`，muse-spark 仅 responses 可服务；其余客户端方向的
    responses 目标转换体不含这些字段，净化函数按存在性防御处理）。

## 背景

- 2026-10-15 实测诊断（会话 01a13e88-499d，网关请求日志
  `logs/opencode-zen-v1-responses-http-20261015154814.log`）：Codex 0.162 新线格式把全部
  工具声明改为 `input[0]` 的 `additional_tools` 项（namespace 分组），顶层 `tools` 消失；
  zen 上游 `/inference/v1/responses` 不识别该 input 项类型，直接 400。
  A/B 复现确认：原样转发必现 400，仅移除 `additional_tools` 即 200。
- 同日上游能力探针（muse-spark-1.3-contributor-free）：
  - `/chat/completions` → 400 `ModelProtocolUnsupported`（排除改路由到 chat 的方案）；
  - `/responses` + 顶层 `{"type":"namespace",...}` 工具 → 200（提升时可原样保留，工具名零改写）；
  - `/responses` + `{"type":"web_search","search_content_types":[...]}` → 400
    （上游：该参数仅 `web_search_preview` 支持）；剥离后 → 200。与 cliproxy 时代
    对 muse-spark-* 的 `search_content_types` 过滤经验一致。
- 相关代码路径：
  - 同协议直通适配：`packages/opencode-zen/src/index.ts`
    `ZEN_SAME_PROTOCOL_ADAPTATIONS.responses` / `adaptOpencodeZenUpstreamRequest`；
  - 同协议直通实现：`packages/llm-bridge/src/request.ts` `convertRequest`（`to === from` 分支）；
  - 网关自身的同类先例：`apps/gateway/src/gateway.ts` 的 input 过滤（additional_tools /
    compaction_trigger 剥离）。
- 已知约束：muse-spark 元数据 npm 为 `@ai-sdk/openai`（responses 协议），是当前目录唯一
  responses 协议家族；净化只按模型前缀 `muse-spark-` 生效，不影响其他模型。

## 风险

- 风险：`additional_tools` 提升到顶层后与客户端已有同名工具声明冲突，或上游对混合
  namespace + 扁平工具形态收紧。
- 缓解：提升时同名跳过（先到先得）；提升形态不做任何改名 / 展平（探针已验证原样
  namespace 可过）；净化严格限定 muse-spark 前缀，其他模型零行为变化。
- 风险：Codex 后续版本继续演化线格式（新 input 项类型 / 新参数）。
- 缓解：错误分类已透传上游原文（`zen_upstream_error`），配合
  `scripts/zen-gate-probe.ts` 思路可快速归因；不在本次扩大通用过滤机制。

## 里程碑

1. 上游能力探针与方案收敛（已完成：responses-only、namespace 可过、web_search 参数确认）。
2. 实现净化函数与适配层接入。
3. 测试、`bun run check`、端到端 codex exec 验证与收尾。

## 验证方式

- 命令：`bun run check`（构建 + 类型 + 全量测试）。
- 手工检查：`codex exec` 经网关（127.0.0.1:8320）用 muse-spark 模型发起含工具调用的
  请求（如让它执行 `echo`），确认不再 400 且模型能发起工具调用。
- 观测检查：`~/.agent-proxy-gateway/logs/opencode-zen-v1-responses-http-*.log` 出现 200
  交换；`gateway.log` 无新增 `zen upstream 4xx`。

## 进度记录

- [x] 上游能力探针：chat 端点不可用；namespace 顶层可过；web_search 参数确认。
- [x] 编写本执行计划。
- [x] 实现 muse-spark 请求净化（additional_tools 剥离与提升、web_search 参数过滤、
      description 占位、custom 工具丢弃）。
- [x] 补充测试并通过 `bun run check`（1132 测试全过）。
- [x] 端到端 codex exec 验证：请求不再 400；模型可经提升后的 namespace 发起函数
      调用（实测 `clock.sleep` 调用往返）；custom 工具按预期不可用（模型自述）。
- [x] 历史记录文档并移动本计划至 completed/。

## 决策记录

- 2026-10-15：选择「同协议 responses 直通上做模型前缀限定的请求净化」，而非把
  muse-spark 改路由到 chat 端点（实测 `ModelProtocolUnsupported`）或改 llm-bridge
  同协议直通语义（影响所有插件路径，超出本次范围）。
- 2026-10-15：`search_content_types` 仅从 `web_search` 剥离，`web_search_preview`
  保留（上游错误信息明确该参数在 `web_search_preview` 上合法；cliproxy 时代的
  双参数过滤按当时上游行为制定，以当前上游为准）。
- 2026-10-15：提升 `additional_tools` 的工具声明时原样搬运（不展平 namespace、不改名），
  依据为顶层 namespace 形态探针通过，且零改写可保证工具调用历史与声明名一致。
- 2026-10-15（端到端新发现）：上游对工具 description 要求非空（Codex `functions`
  namespace 实发空串 description，400 `tools[1].description`）→ 提升与既有工具中
  function/custom/namespace 的空缺 description 以工具名占位；web_search 等内置
  工具无此要求（探针实测无 description 也 200），不占位。
- 2026-10-15（端到端新发现）：上游不支持 `custom` 工具（400 "`custom` tools are
  not supported on this endpoint"）→ 净化时丢弃 custom 声明（含 namespace 内层、
  清空的 namespace）。不转换成 function：custom 依赖 custom_tool_call 响应形状，
  直通链路不改写响应事件，转换会造成客户端拿到无法对应的 function_call。代价：
  muse-spark 上 Codex 的 custom 工具（node REPL 的 `exec` 等）不可用，模型会明确
  说明这一点；经典顶层 function 工具（如 `exec_command`）不受影响。
