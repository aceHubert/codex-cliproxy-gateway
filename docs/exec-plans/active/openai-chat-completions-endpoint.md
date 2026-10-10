# 入口协议插件化：支持 OpenAI Chat Completions 端点

状态：进行中（方案已收敛，待实现）
创建日期：2026-10-08

## 目标

网关在现有 Codex Responses 入口（`POST {mountPath}/responses`）之外，新增对 `POST {mountPath}/chat/completions`（OpenAI Chat Completions，流式与非流式）的支持：让任意 OpenAI 兼容客户端（非 Codex 系）也能使用 `zcode/`、`zcode-<plan>/`、`codebuddy-*/`、`workbuddy-*/`、`qoder-intl/`、`qoder-cn/`、`agy/` 等 adapter 模型与官方原生模型（无前缀）。核心原则：**协议转换永远单跳，发生在「客户端协议 ≠ 上游协议」处**——codebuddy/qoder 上游是 chat 方言，原生直通；zcode 上游是 Anthropic Messages，chat↔Anthropic 直转；agy 上游是 Gemini，chat↔Gemini 直转；官方上游只有 Responses 端点，chat↔Responses 直转；`cliproxy/` 前缀（第三方 OpenAI 兼容上游）原样直通零转换。入口层参考 Magpie 的分层以仓内 in-process TS 插件模块落地，既有 Responses 数据面（各 adapter 的 `forward` 与官方转发管线）零改动。

## 范围

- 包含：
  - `POST {mountPath}/chat/completions` 的流式（SSE `chat.completion.chunk` + `[DONE]`）与非流式（`chat.completion`）两种响应形态。
  - 入口协议插件层（`src/protocols/`）：路径匹配、chat 选项解析、官方路由的 chat↔Responses 兜底转换，及后续入口协议（Anthropic Messages、Gemini）的扩展位。
  - codebuddy/qoder 的原生 chat 直通：chat 请求不经任何 Responses 中转，由适配器以 chat 方言直接构造上游请求并回传 chat 响应（保留各自传输层处理：codebuddy 凭据与头构造、qoder envelope 打包/解包与排队恢复）。
  - zcode 的 chat↔Anthropic 直转、agy 的 chat↔Gemini 直转（在各自模块内新增 chat 方言转换，复用既有助手）。
  - 官方原生模型（无前缀）的 chat↔Responses 转换：重写为 `{mountPath}/responses` 的内部请求后复用既有官方管线（OAuth 透传、upstreamOnly 语义）。
  - `cliproxy/` 前缀模型维持现有 catch-all 原样直通行为不变。
  - README 端点说明、测试（各家转换单测 + 网关集成测试）。
- 不包含：
  - Anthropic Messages（`/v1/messages`）、Gemini（`:generateContent`）等其他入口协议（后续各加一个插件）。
  - Codex 专用能力在 chat 端点的等价物：`/responses/compact` 压缩、`x-codex-routing-hint`、thread 粘性头对 chat 客户端无意义，不实现。
  - `n > 1` 多候选、`stop` 停止序列（上游各方言无一致对应语义，见决策记录）。
  - Magpie 式外部 JS 插件运行时与插件市场（见决策记录）。
  - zcode 服务器工具（web_search 的 `server_tool_use`）在 chat 路径的暴露：chat 工具声明不含该类型，首版不暴露。
  - 配置项变更：不新增 GatewayConfig 字段，`schemas/gateway-config.schema.json` 不动。

## 背景

- 相关文档：
  - [protocol-conversion-extraction.md](protocol-conversion-extraction.md)（先决重构：共享转换内核与单跳方向转换器注册表，统一 zcode/codebuddy/qoder/agy/opencode-zen 的既有转换；本计划 M1/M3 的转换器基于其 `src/protocols/` 内核与注册表实现，不另起炉灶）。
  - `docs/magpie-zcode-start-plan-research.md`（Magpie 插件仓库的既有静态调研）。
  - Magpie 参考实现：[yetone/magpie](https://github.com/yetone/magpie) 及其 `docs/reference.md`——网关同时受理 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、Gemini 端点；「上游讲客户端的协议则直通，否则翻译」，翻译按 (客户端协议, 上游协议) 组合进行；middleware 插件以 `onRequest` / `onEvent` / `onResponse` 钩子在「客户端自己的 API 形状」上工作；目录条目携带 `native_endpoints` 声明哪些端点可免翻译直通。
  - `docs/exec-plans/completed/newapi-upstream-catalog.md`（new-api 上游对 OpenAI 兼容路径的直通前提）。
  - `docs/histories/2026-09/20260917-2010-codebuddy-proxy-adapter.md`（llm-bridge 双向转换被否决的先例：手写转换）。
- 相关代码路径：
  - 路由与拦截：`src/gateway.ts` `createGatewayHandler` / `handleCore`——`{mountPath}/models`、`{mountPath}/responses(+/compact)` 之后的其余 mountPath 子树路径全部走 catch-all 透传（`joinUpstreamUrl` 剥掉 mountPath 后原样转发）。
  - adapter 契约（鸭子类型，无共享接口文件）：`createZcodeAdapter`（`src/zcode/index.ts`）、`createCodebuddyAdapter`（`src/codebuddy/index.ts`）、`createQoderAdapter`（`src/qoder/index.ts`）、`createAgyAdapter`（`src/agy/index.ts`），均为 `{ catalog(), forward(request, input, mapResult?), close() }`，`input` 是 Responses 形状请求体，返回 Responses SSE/JSON。
  - 既有 Responses↔Chat 双向转换先例：`src/codebuddy/request.ts` `translateCodebuddyRequest`（Responses→Chat）、`src/codebuddy/response.ts` `createCodebuddyResponse` / `replayCompletionAsSSE`（Chat SSE→Responses，非流式回放为 SSE 的单一合成路径先例）。
  - 可复用转换助手：zcode `safeToolName`/`toolIdentity`/`THINKING_BUDGETS`/`zcode-thinking-v1:` envelope/endpoint-routing（`src/zcode/`）；agy `sanitizeToolSchema`/`THINKING_LEVELS`/`agn1:` envelope（`src/agy/request.ts`）；usage 映射先例 `src/codebuddy/response.ts` `usageFromUpstream`。
- 已知约束：
  - 现状下 `POST /v1/chat/completions` 对 `cliproxy/` 前缀模型已经可用（catch-all 原样直通到 `${upstreamBaseUrl}/chat/completions`，new-api/CLIProxyAPI 均为 OpenAI 兼容）；对其余模型均不可用——adapter 前缀模型被 `decideRoute` 判为 official 路由，官方（无前缀）模型经 catch-all 原样转发到官方上游的 `/chat/completions`。而官方上游 `officialBaseUrl`（默认 `https://chatgpt.com/backend-api/codex`，`src/cli.ts` DEFAULTS）**只支持 `/responses` 端点**（2026-10-08 确认），直通必然失败。
  - 各上游方言：codebuddy 直连 `/v2/chat/completions`（chat）；qoder envelope 内层是 chat chunks（`translateQoderResponse` 产出标准 chat-completions SSE）；zcode 是 Anthropic Messages（`/v1/messages`，SSE）；agy 是 Gemini（`v1internal:streamGenerateContent?alt=sse`，protojson）；官方是 Responses。除 `cliproxy/` 外都需要一层转换，但都只需一跳。

## 方案：插件层与逐家转换清单

### 1. 入口协议插件层与派发（Magpie 式，in-process TS）

新增 `src/protocols/`，与上游 adapter 轴（`src/<adapter>/`）正交。插件负责入口关注点（路径匹配、chat 选项解析）与无原生处理器的兜底转换（官方路由）：

```ts
// src/protocols/types.ts
export interface ChatFormatOptions {
  stream: boolean;         // chat 请求原始 stream 标志
  includeUsage: boolean;   // stream_options.include_usage
  requestedModel: string;  // 原始 model（回填到响应的 model 字段）
}

export interface DecodedInboundRequest {
  responsesBody: Record<string, unknown>; // 仅官方兜底使用
  options: ChatFormatOptions;
}

export interface InboundProtocol {
  id: string; // "openai-chat"
  // 路由匹配：POST ${mountPath}/chat/completions
  match(pathname: string, method: string, mountPath: string): boolean;
  // 从 chat body 提取选项（原生路径与兜底路径共用）
  optionsOf(body: Record<string, unknown>): ChatFormatOptions;
  // 兜底中转（无原生处理器的路由，即官方）：chat body → Responses 规范形
  decode(request: Request, body: Record<string, unknown>): DecodedInboundRequest;
  // 兜底中转返回向：Responses 结果 → chat 响应
  encode(responsesResponse: Response, options: ChatFormatOptions): Promise<Response>;
}
```

adapter 鸭子类型新增可选方法（对齐 Magpie 目录 `native_endpoints` 的「按端点声明原生能力」思路）：

```ts
forwardChat?(request: Request, chatBody: Record<string, unknown>, options: ChatFormatOptions): Promise<Response>;
// 后续入口协议如需原生路径，同样以可选方法扩展：forwardMessages? 等
```

网关接线（`handleCore` 内，位于 mountPath 守卫之后、`/responses` 拦截块之前），按模型四类派发：

1. `protocols` 数组由 `createGatewayHandler` 注入，默认 `[openaiChatProtocol]`。
2. adapter 模型（四家前缀任一命中）→ 对应 adapter 的 `forwardChat` 原生路径：codebuddy/qoder 直通自家 chat 上游，zcode/agy 直转各自方言（§4–§6），不经过 decode/encode。
3. 无前缀官方模型（兜底中转）：`decode` 得到 Responses 规范形 → 构造内部 `POST {mountPath}/responses` 请求（原 headers 与 signal 保留、重建 body）→ 重新进入既有管线 → 结果交给 `encode` 包装返回。内部重写让官方转发（OAuth 透传、`copyRequestHeaders` 官方分支）、`upstreamOnly` 语义零复制复用（`upstreamOnly=true` 时重写后的请求按既有规则发往上游 `/responses`）。
4. `cliproxy/` 前缀模型 → 不拦截，落入现有 catch-all 原样直通——即 Magpie 的「上游同协议直通，否则翻译」语义。

审计与请求日志需保留 chat 原始入口路径的标注（第 3 类重写后的内部请求在日志中表现为 `/responses`，拦截点负责记录真实入口）。

对齐 Magpie 语义的取舍：Magpie 的翻译按 (客户端协议, 上游协议) 组合进行且同协议直通；本计划同样不做全局规范形中转——每家 adapter 的 chat 路径直通或直转自己的上游方言，插件层只承担入口关注点与官方兜底。与 Magpie 的差异：插件是仓内 in-process TS 模块（类型检查 + 同仓测试），不做它的外部 JS 运行时与插件市场。

### 2. 官方路由：chat ↔ Responses 转换清单（唯一的中转路径）

请求向（Chat → Responses）：

| Chat Completions 字段 | Responses 目标 | 规则 |
| --- | --- | --- |
| `model` | `model` | 无前缀直传（官方路由）；`cliproxy/` 已在派发层排除 |
| `messages[role=system/developer]` | `instructions` | 多条按出现序以 `\n\n` 拼接 |
| `messages[role=user]` | `input[]` `type:"message"`(role=user) | content 字符串 → 单条 `input_text`；`content[]` parts 中 `text`→`input_text`、`image_url`→`input_image`（data: URL 支持） |
| `messages[role=assistant].content` | `input[]` `type:"message"`(role=assistant) | 文本直传 |
| `messages[role=assistant].tool_calls[]` | `input[]` `type:"function_call"` | `id`→`call_id`、`function.name`/`function.arguments` 直传 |
| `messages[role=assistant].reasoning_content` | `input[]` `type:"reasoning"`（summary） | 官方链路无 envelope 需求，以 summary 回放（GPT 系 reasoning 不跨客户端续传） |
| `messages[role=tool]` | `input[]` `type:"function_call_output"` | 以 `tool_call_id` 关联；content 取字符串 |
| `tools[].function` | `tools[]` `type:"function"` | `name`/`description`/`parameters` 直传 |
| `tool_choice` | `tool_choice` | `"auto"`/`"none"`/`"required"` 直传；`{type:"function",function:{name}}` → `{type:"function",name}` |
| `max_tokens` / `max_completion_tokens` | `max_output_tokens` | 取先出现者 |
| `temperature` / `top_p` / `parallel_tool_calls` | 同名 | 直传 |
| `reasoning_effort` | `reasoning.effort` | `minimal`→`low`，其余直传 |
| `response_format` | `text.format` | `json_object`→`{type:"json_object"}`；`json_schema`→`{type:"json_schema", name, schema}` |
| `stream` / `stream_options.include_usage` | `options` | `responsesBody.stream` 恒置 `true`（见决策），原始标志进 options |
| `stop` | — | 不支持：忽略并写审计日志 |
| `n` | — | `n > 1` 返回 400（OpenAI 风格 error JSON） |
| 其余未识别字段 | — | 丢弃 |

响应向（Responses → Chat）：`encode` 解析官方上游的 Responses SSE（新写严格解析器，形状对齐 `parseSseFrames`），逐事件映射：

| Responses 事件 | chat 输出 |
| --- | --- |
| `response.created` | 首块 `chat.completion.chunk`：`id`、`model`（回填 `options.requestedModel`）、`choices:[{index:0, delta:{role:"assistant",content:""}, finish_reason:null}]` |
| `response.output_text.delta` | `choices[0].delta.content` 追加 |
| `response.reasoning_summary_text.delta` | `choices[0].delta.reasoning_content` 追加 |
| `response.output_item.added`(function_call) | `delta.tool_calls=[{index:i, id, type:"function", function:{name, arguments:""}}]` |
| `response.function_call_arguments.delta` | `delta.tool_calls[i].function.arguments` 追加 |
| `response.completed` / `response.incomplete` | 末块 `finish_reason` +（`includeUsage` 时）空 `choices` + `usage` 块，随后 `data: [DONE]` |

- `finish_reason` 映射：`completed` → 有 `function_call` 输出时 `"tool_calls"`，否则 `"stop"`；`incomplete` + `max_output_tokens` → `"length"`；`incomplete` + `content_filter` → `"content_filter"`。
- `usage` 映射：`input_tokens`→`prompt_tokens`、`output_tokens`→`completion_tokens`、和→`total_tokens`、`input_tokens_details.cached_tokens`→`prompt_tokens_details.cached_tokens`、`output_tokens_details.reasoning_tokens`→`completion_tokens_details.reasoning_tokens`。
- 非流式：同一条事件流在 `encode` 内聚合为单个 `chat.completion` JSON；错误：上游非 2xx → OpenAI 风格 `{error:{message, type, code}}`，status 透传。

### 3. codebuddy / qoder：原生 chat 直通（零协议转换）

两家上游本就讲 chat 方言（codebuddy 直连 `${endpoint}/v2/chat/completions`；qoder envelope 内层是 chat chunks，且 `translateQoderResponse` 产出的就是标准 chat-completions SSE）：

- 请求侧（`forwardChat`）：
  - codebuddy：按现有凭据/地区路由解析 profile → 复用 `buildCodebuddyChatHeaders` 构造头 → chat body 做最小规整（model slug → 上游模型名、强制 `stream: true` + `stream_options.include_usage`（对齐 `translateCodebuddyRequest` 的既有约定））→ 发上游。`messages`/`tools`/`tool_choice`/`max_tokens`/`temperature`/`top_p`/`response_format` 等 chat 字段原样透传，不做语义映射；`reasoning_content` 回放按原样直传——chat 进 chat 出，envelope（`codebuddy-reasoning-v1:`）天然无损。
  - qoder：chat body 跳过 `translateCodebuddyRequest`，直接进入 envelope 打包（`translateQoderRequest` 的 repack 部分 + `inferBody` 注入 business/ids/`model_config.key`）与 COSY 签名；排队恢复（`createQueueAwareInfer`）照常生效。
- 响应侧：
  - 流式：上游 chat SSE（qoder 为解包后的标准 chat SSE）按帧透传，仅重写每帧 `model` 回请求的 slug；`data: [DONE]` 原样。
  - 非流式：上游恒为流式，网关内聚合为单个 `chat.completion` JSON。
  - 错误：上游非 2xx → OpenAI 风格 error JSON，status 透传。

### 4. zcode：chat ↔ Anthropic 直转

在 `src/zcode/` 内新增 chat 方言转换模块（如 `chat-request.ts` / `chat-response.ts`），复用 `safeToolName`/`toolIdentity`、`THINKING_BUDGETS`、`zcode-thinking-v1:` envelope、endpoint-routing、client-signing 与凭据/套餐槽位解析等既有助手，传输层（`/v1/messages`、Anthropic 头）与 `forward` 一致。

请求向（Chat → Anthropic Messages）：

| Chat 字段 | Anthropic 目标 | 规则 |
| --- | --- | --- |
| `messages[role=system/developer]` | `system` | 按出现序拼接为 system 块 |
| `messages[role=user]` | `messages[]`(role=user) | content 字符串 → `text` block；`content[]` 中 `text`→`text`、`image_url`→`image` block（base64/URL source，复用现有映射） |
| `messages[role=assistant].content` | `messages[]`(role=assistant) `text` block | |
| `messages[role=assistant].tool_calls[]` | assistant `tool_use` block | `id`→`id`、name→`safeToolName` + `toolIdentity` 映射、`arguments` → `input`（JSON.parse） |
| `messages[role=assistant].reasoning_content` | `thinking` block | 带 `zcode-thinking-v1:` envelope 则解包回放（无损续传）；否则按 summary 文本回放 |
| `messages[role=tool]` | user `tool_result` block | `tool_call_id`→`tool_use_id`；content 取字符串 |
| `tools[].function` | `tools[]` | `{name: safeToolName, description, input_schema: parameters}` + 工具名映射表（沿用 `ZcodeToolMap`） |
| `tool_choice` | `tool_choice` | `"auto"`/`"none"` 直传；`"required"`→`{type:"any"}`；named → `{type:"tool", name}` |
| `max_tokens` / `max_completion_tokens` | `max_tokens` | 取先出现者（Anthropic 必填，缺省用现网关同款默认） |
| `temperature` / `top_p` | 同名 | 直传 |
| `reasoning_effort` | `thinking.budget_tokens` | `THINKING_BUDGETS`；`minimal`→`low` 档 |
| `stream` | `stream: true` | 上游恒流式，非流式网关内聚合 |
| `response_format` | — | 不支持：忽略并审计日志 |

响应向（Anthropic SSE → chat chunk）：

| Anthropic 事件 | chat 输出 |
| --- | --- |
| `message_start` | 首块 `delta:{role:"assistant"}` |
| `content_block_delta`(text_delta) | `delta.content` |
| `content_block_delta`(thinking_delta) | `delta.reasoning_content`（重新封 `zcode-thinking-v1:` envelope，chat 进 chat 出可续传） |
| `content_block_start`(tool_use) | `delta.tool_calls=[{index, id, function:{name(反解映射), arguments:""}}]` |
| `content_block_delta`(input_json_delta) | `delta.tool_calls[i].function.arguments` |
| `message_delta`(stop_reason) | `finish_reason`：`end_turn`→有工具输出 `"tool_calls"` 否则 `"stop"`；`max_tokens`→`"length"` |
| usage（`message_start`/`message_delta`） | `input_tokens`→`prompt_tokens`、`output_tokens`→`completion_tokens`、`cache_read_input_tokens`→`prompt_tokens_details.cached_tokens` |
| `message_stop` | `data: [DONE]` |

限制：zcode 服务器工具（web_search）与 vision 的 `analyze_image` 网关注入目前挂在 Responses 路径上，chat 路径首版不暴露/按上游原生能力直发，差异在 README 标注（见风险）。

### 5. agy：chat ↔ Gemini 直转

在 `src/agy/` 内新增 chat 方言转换模块，复用 `sanitizeToolSchema`、`THINKING_LEVELS`、`agn1:` envelope / thoughtSignature 回放、Cloud Code Assist 包装（`{project, requestId, model, requestType:"checkpoint", request:{contents, systemInstruction?, tools, generationConfig, toolConfig?, sessionId}}`）与 `streamInfer` 传输。

请求向（Chat → Gemini）：

| Chat 字段 | Gemini 目标 | 规则 |
| --- | --- | --- |
| `messages[role=system/developer]` | `systemInstruction.parts[].text` | 按出现序拼接 |
| `messages[role=user/assistant]` | `contents[]`（role `user`/`model`） | text part / image（`inlineData`/`fileData`，复用现有映射） |
| `messages[role=assistant].tool_calls[]` | model part `functionCall` | `{name, args: JSON.parse(arguments)}`；`agn1:` envelope 回放 thoughtSignature（复用现有逻辑） |
| `messages[role=tool]` | user part `functionResponse` | `{name, response:{output: content}}`；Gemini 无调用 id，按工具名关联（与现有 Responses 路径同一限制） |
| `messages[role=assistant].reasoning_content` | —（thinking 由上游自管） | 不回放，忽略 |
| `tools[].function` | `tools[].functionDeclarations` | `sanitizeToolSchema` 处理 parameters |
| `tool_choice` | `toolConfig.functionCallingConfig` | auto/none/named 映射（复用现有 tool_choice 翻译） |
| `max_tokens` / `max_completion_tokens` | `generationConfig.maxOutputTokens` | |
| `reasoning_effort` | `generationConfig.thinkingConfig.thinkingLevel` | `THINKING_LEVELS`；`minimal`→`low` 档 |
| `temperature` / `top_p` | `generationConfig.temperature` / `topP` | |
| `stream` | `?alt=sse` | 上游恒流式，非流式网关内聚合 |
| `response_format` | `generationConfig.responseMimeType`/`responseSchema` | json_object/json_schema 映射 |

响应向（Gemini SSE → chat chunk）：

| Gemini 事件 | chat 输出 |
| --- | --- |
| `thought:true` parts | `delta.reasoning_content` |
| text parts | `delta.content` |
| `functionCall` part | `delta.tool_calls=[{id: 合成确定性 id（如 `call_<n>`）, function:{name, arguments}}]` |
| `usageMetadata` | `promptTokenCount`→`prompt_tokens`、`candidatesTokenCount`→`completion_tokens`、`thoughtsTokenCount`→`completion_tokens_details.reasoning_tokens` |
| `finishReason` | `STOP`→有工具输出 `"tool_calls"` 否则 `"stop"`；`MAX_TOKENS`→`"length"`；安全类→`"content_filter"`（对齐 `finishDisposition` 语义） |
| 流终止 | `data: [DONE]` |

### 6. 各家共用约定

- 上游恒流式 + 网关内聚合非流式（单一合成路径，对齐 `replayCompletionAsSSE` 先例）。
- 流式响应每帧 `model` 字段回填请求的 slug；错误统一转 OpenAI 风格 `{error:{message, type, code}}` 并透传 status。
- `GET {mountPath}/models` 已合并全部 adapter 目录，chat 客户端开箱即用。

## 风险

- 风险：新增两套直转器（chat↔Anthropic、chat↔Gemini）与两家原生直通的正确性及长期维护成本。
  缓解：字段矩阵单测 + 复用各家 `test/*-request.test.ts`/`*-response.test.ts` 的 fixture 与既有助手（safeToolName/sanitizeToolSchema/envelope/预算表）；每家至少一条 fake-fetch 集成测试断言上游收到正确方言体。
- 风险：Gemini functionCall 无调用 id，chat 的 `tool_call_id` 关联依赖工具名/顺序，并行同名工具调用可能歧义。
  缓解：合成确定性 id + 按名关联（与现有 Responses 路径同一限制）；测试并行工具调用往返；歧义场景审计日志标注。
- 风险：zcode 服务器工具（web_search）与 vision `analyze_image` 注入挂在 Responses 路径，chat 路径存在能力差异。
  缓解：README 明确标注；必要时后续把注入逻辑提取为方言无关助手（记 tech-debt）。
- 风险：官方模型的鉴权与 token 生命周期——chat 客户端须自带有效 ChatGPT OAuth Bearer（网关沿用官方分支透传语义，不做刷新；Codex 客户端自己刷新 token，第三方 chat 客户端没有这层）。
  缓解：README 标注官方模型用法与限制；token 失效时上游 401 经 `encode` 转为 OpenAI 风格错误透传。
- 风险：codebuddy/qoder 原生路径与既有 Responses 路径形成两套上游请求构造，长期漂移。
  缓解：原生路径复用 `buildCodebuddyChatHeaders`、qoder repack/`inferBody`、排队恢复等既有助手；补「同一语义请求分别走两条路径，断言上游体形状一致」的对比测试。
- 风险：chat 客户端回放的 `reasoning_content` 跨厂商不可迁移（envelope 是各 adapter 私有）。
  缓解：各家原生路径识别自家 envelope 直接回放（无损）；跨厂商回放按各家降级规则处理并在 README 标注。
- 风险：破坏现有行为——`cliproxy/` 在 `/chat/completions` 上的直通、各模型在 `/responses` 上的既有链路。
  缓解：回归测试分别锁定（直通含 OAuth 剥除与 key 注入；`/responses` 链路不经过重写，天然不受影响，仍加冒烟）。
- 风险：入口安全边界——chat 客户端可带任意 `Authorization`。
  缓解：`cliproxy/` 直通沿用现有 catch-all 语义（剥除并注入上游 key）；官方路由沿用 OAuth 透传语义；adapter 原生路径由各 adapter 重建自家鉴权头；mountPath 404 边界与 `/ui` 隔离不动。
- 风险：工具名特殊字符触碰 `safeToolName` 的重命名映射。
  缓解：转换测试覆盖含 `:`/空格/超长名的工具往返。

## 里程碑

1. 调研与方案收敛：本计划 + 决策记录定稿。（已完成）
2. 分阶段实现：
   - M1 插件层与官方兜底：`src/protocols/types.ts` + `src/protocols/openai-chat/`（`match`/`optionsOf`/`decode`/`encode`：chat↔Responses 转换、SSE 重编码、非流式聚合、错误透传）+ `test/openai-chat-{request,response}.test.ts`。转换器基于[共享转换内核](protocol-conversion-extraction.md)（先决计划）实现，本里程碑待其 M1–M3 完成后动工。
   - M2 codebuddy/qoder 原生 chat 路径：adapter 新增可选 `forwardChat`（codebuddy chat 规整直发；qoder 跳过 Responses 翻译直接 repack envelope），流式透传 + 非流式聚合 + 双路径上游体一致性对比测试。
   - M3 zcode chat↔Anthropic、agy chat↔Gemini 直转器及单测（工具/图像/reasoning envelope/usage/finish_reason 矩阵）；方向转换器注册进共享内核的 `convertRequest` 注册表（见[先决计划](protocol-conversion-extraction.md)），各家怪癖仍以钩子留在自家模块。
   - M4 网关接线：`createGatewayHandler` 注入 `protocols`，`handleCore` 四类派发（adapter 原生 / 官方兜底重写 / cliproxy 直通）+ 回归 + `test/chat-endpoint-gateway.test.ts`（fake fetch：四家 adapter 各一条——codebuddy/qoder 断言上游收到 chat 体、zcode 断言 Anthropic 体、agy 断言 Gemini 体——+ 官方模型转换与 401 透传 + `upstreamOnly` 模式 + cliproxy 直通回归 + 非流式）。
3. 验证、交付与收尾：README 端点说明与能力差异标注、tech-debt 登记（vision/web_search 差异、Gemini 工具 id 限制）、`bun run check` 全绿、归档计划并写历史记录。

## 验证方式

- 命令：`bun run typecheck`；`bun test test/openai-chat-request.test.ts test/openai-chat-response.test.ts test/chat-endpoint-gateway.test.ts`；提交前 `bun run check`。
- 手工检查：网关运行后 `curl -N http://127.0.0.1:8320/v1/chat/completions` 分别以流式/非流式打 `zcode/`（直转 Anthropic）、`agy/`（直转 Gemini）、`codebuddy-cn/` 与 `qoder-intl/`（原生直通）前缀模型；带 ChatGPT OAuth Bearer 打无前缀官方模型验证转换与 401 透传；同请求打 `cliproxy/` 前缀模型对比直通行为不变。
- 观测检查：request log 中 chat 路径审计记录正常、原始入口路径标注生效、无凭据/原始 URL 泄漏（脱敏规则沿用）。

## 进度记录

- [x] 方案收敛：单跳直转原则、逐家转换清单、插件层契约、Magpie 分层对齐（本计划）。
- [ ] M1：插件层 + 官方 chat↔Responses 兜底转换及单测。
- [ ] M2：codebuddy/qoder 原生 chat 直通及双路径一致性测试。
- [ ] M3：zcode chat↔Anthropic、agy chat↔Gemini 直转器及单测。
- [ ] M4：网关四类派发接线与集成回归测试。
- [ ] M5：README、tech-debt 登记、`bun run check`、归档与历史记录。

## 决策记录

- 2026-10-08：**转换永远单跳，不做全局 Responses 规范形中转**。每家 adapter 的 chat 路径直通或直转自己的上游方言（codebuddy/qoder chat 原生、zcode chat↔Anthropic、agy chat↔Gemini），仅官方路由（上游本就是 Responses）走 chat↔Responses 兜底。理由：chat 语义（`role:"tool"`、并行 `tool_calls`、`reasoning_content`）经 Responses 中转会多一次形状体操与往返损耗；与 codebuddy/qoder 的原生直通决策保持对称；每家转换自包含、可独立测试。影响：zcode/agy 各新增一套 chat 方言转换（复用既有助手），codebuddy 的 Responses→Chat 翻译不复用于 zcode/agy 路径。
- 2026-10-08：入口保留 Magpie 式插件层（`src/protocols/`）：承担路径匹配、chat 选项解析、官方兜底转换与后续入口协议扩展位；插件为仓内 in-process TS 模块（类型检查 + 同仓测试），不做 Magpie 的外部 JS 运行时与插件市场（本网关是单体 Bun 应用，外部 JS 沙箱收益不存在）。adapter 鸭子类型新增可选 `forwardChat`，对齐 Magpie 目录 `native_endpoints` 的「按端点声明原生能力」思路。
- 2026-10-08：官方（无前缀）模型拦截并转换，不做直通。依据：官方上游 `https://chatgpt.com/backend-api/codex` 只支持 `/responses`（本日确认），`/chat/completions` 直通必然失败。实现采用「重写为 `/responses` 的内部请求再走既有管线」而非旁路自写官方转发，避免复制 OAuth 透传/错误映射/日志管线。影响：`upstreamOnly` 模式下无前缀模型经重写发往上游 `/responses`（正确性优先，上游本就要求支持该端点）；官方模型的 chat 客户端须自带有效 ChatGPT OAuth token。
- 2026-10-08：仅 `cliproxy/` 前缀模型在 `/chat/completions` 上不拦截、维持 catch-all 现状直通（对齐 Magpie「上游同协议直通」）。理由：new-api/CLIProxyAPI 均为 OpenAI 兼容，直通已可用且零损耗。
- 2026-10-08：上游恒流式 + 网关内聚合非流式（各家原生路径与官方 `encode` 统一约定）。理由：单一合成路径，沿用 `replayCompletionAsSSE` 先例，避免维护「上游非流式 JSON 形状」这条不稳定契约。
- 2026-10-08：不支持 `n>1`（400 拒绝）与 `stop`（忽略+审计日志）；`reasoning_effort: "minimal"` 统一映射为 `low` 档。理由：各上游方言无一致对应语义，显式拒绝/降级优于静默错行为。
- 2026-10-08：Codex 专用能力（compaction、routing-hint、thread 粘性）不进 chat 端点。理由：这些是 Codex 客户端协议行为，chat 客户端没有对应概念。
