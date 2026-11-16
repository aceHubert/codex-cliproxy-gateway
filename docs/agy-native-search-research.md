# AGY 原生搜索与 Codex 搜索路由核查

核查日期：2026-11-16。最初为静态检查与已有日志分析；用户要求实现后，追加受控公共查询及官方 CLI 协议取证，记录的结构不含认证头或令牌，未修改生产配置。

## 两条不同的搜索链路

- Codex 联网工具：模型调用客户端 `functions.exec`，执行 `tools.web__run`，Codex 再向网关发起 `/v1/alpha/search`。该接口不是 Google AGY API。
- AGY 原生工具：官方工具为 `search_web(query, domain?)`，由 AGY 工具运行时执行；SDK 的 `BuiltinTools.SEARCH_WEB` 默认启用。

官方资料：[工具与技能](https://antigravity.google/docs/sdk/tools)、[工具参数](https://antigravity.google/docs/hooks)、[CLI 更新记录](https://antigravity.google/docs/changelog?tab=cli)。

2026-11-16 14:28 的“查询杭州明天天气”中，Orchestrator 推理返回 200，并生成 `functions.exec` 调用；之后 Codex 发出的五次 alpha/search 均携带本地 `agy/gemini-pro-orchestrator-g1-pro` 模型名，被转到 CLIProxy，返回 `auth_not_found: no auth available`。不能把这五次失败当成 AGY 原生搜索失败。

## 本机官方 CLI 1.5.9 的静态证据

- 工具转换和执行：`SearchWebToolConverter.GetToolDefinition`、`ToolCallToCortexStep`、`SearchWebHandler.Handle`。
- 工具步骤消息 `SearchWeb` 的字段包括 query、domain、webDocuments、summary。
- 存在 `CodeAssistClient.GetWebSearchResults` 与 `ApiServerService/GetWebSearchResults` RPC。请求字段包括 metadata、query、model、customModelInfoOverride、limit、domain、thirdPartyConfig、imageSearch；响应包括 results、webSearchUrl、summary。
- 存在 CCPA 搜索组件 `websearch.NewCCPARequest`、`FormatMasterResponse`、`citationSources`、`summaryWithCitations` 和引用偏移处理函数。
- 存在另一后端的 `geminiapi.Client.GetWebSearchResults`、`webSearchModelName`。
- 模型目录 `FetchAvailableModelsResponse` 含独立 `webSearchModelIds` 字段。不能假定搜索使用当前会话的 Orchestrator ID。
- CLI 官方更新记录明确修复过 search_web 在 GenerateContent 摘要模型输出前置思考片段时无法取回摘要的问题，支持搜索包含摘要生成阶段这一判断。

初始静态边界：函数名和协议描述符本身不能还原完整调用链；不能仅凭 `googleSearch` 字符串认定当前 CCPA 通道可用。下面的受控取证已经确认 consumer 搜索的真实协议。`searchSnippets` 未证实是公网搜索，本实现不使用它。

## 受控取证与实现结果

官方 CLI 1.5.9 的公开查询成功调用：

```jsonc
{
  "project": "aicode-consumers",
  "model": "gemini-3.5-flash-lite", // 来自本账号 webSearchModelIds，不硬编码
  "userAgent": "antigravity",
  "requestType": "web_search",
  "request": {
    "contents": [{ "role": "user", "parts": [{ "text": "公开查询" }] }],
    "systemInstruction": { "role": "user", "parts": [{ "text": "网页检索指导" }] },
    "tools": [{ "googleSearch": { "enhancedContent": { "imageSearch": { "maxResultCount": 5 } } } }],
    "generationConfig": { "candidateCount": 1 }
  }
}
```

端点是 `daily-cloudcode-pa.googleapis.com/v1internal:generateContent`，不使用流式推理路径。
HTTP 200 响应的 response.candidates 含正文和 groundingMetadata；其 groundingChunks.web
提供来源，groundingSupports 提供段落与来源索引。引用偏移按 UTF-8 字节处理，并跳过思考 parts。

Codex 开源 [SearchResponse](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/search.rs)
将 encrypted_output 定义为可选字段。本实现返回 null、output 摘要和 results，引用 ID 与摘要一致。
新适配器真实 `/alpha/search` 验收返回 200、七条来源；出网记录只有 Google 模型目录与搜索调用。
Responses 原生闭环用 Hydrogen 实测 completed，生成 web_search_call 和最终 message，没有泄漏为客户端函数调用。
Orchestrator 的独立搜索入口已验证；一次额外的主模型续轮验收失败及一次主模型超时如实保留为验证过程，不把它们计为成功证据。

模型请求内的 web_search 被转换为网关保留函数；网关执行专用搜索后，把带签名的 functionCall 和
对应 functionResponse 回填给同一主模型。该工具闭环使用官方 CLI 的 agent 请求类型，搜索子请求
使用 web_search；续轮更新 requestId，保留 sessionId。独立签名帧挂回调用部件，不造签名。

## 目前网关缺少什么

适配前 AGY 只构造低层模型请求，未接入搜索执行器或引用处理。现已实现原生 web_search 与独立 alpha/search。
其他未适配插件的内置工具声明仍按各自规则处理；目录能力提示与客户端 web__run 仍是两套接口。

以下是修复前的公共路由行为；现已在普通生成入口前独立分发搜索：

- upstreamOnly=true：直接发往配置上游，原样保留本地模型名，移除客户端 OAuth 并使用上游 key。
- upstreamOnly=false：先采用请求 model（缺失才读取 hint），再结合请求头中的会话路由记录；带上游前缀的模型走配置上游，其余通常走 ChatGPT 官方接口。已有会话记录可能改变目标。当前并未为本地插件模型的搜索单独分发。
- 动态模式官方目标为 `https://chatgpt.com/backend-api/codex/alpha/search`，客户端 OAuth 保留；本地 agy/... 名称不会因此变成有效的官方搜索模型。

代码位置：`packages/plugin-api/src/registry.ts` 的入口识别，以及 `apps/gateway/src/gateway.ts` 的 upstream-only 直通、`decideThreadRoute` 和动态转发分支。

## 其他插件

- ZCode：已有 Responses web_search → z.ai web_search_20250305 原生映射与结果回放；该路径不需要 alpha/search。
- CodeBuddy、Qoder：未接入原生 web_search 映射，会剥离或提示无法执行。
- OpenCode Zen：Responses 原生声明按具体上游能力透传，兼容清理由模型协议决定。
- 所有插件若另行触发 Codex 客户端 web__run，仍会碰到同一个 alpha/search 公共路由缺口。开启 supports_search_tool 不会自动创建搜索接口归属。

## 已实现边界与后续范围

1. 公共契约新增可选 handleSearch；两种模式按本地模型分发。未实现或禁用的插件返回明确 501，不静默转发其他供应商；普通上游模型保持原路由。入站 OAuth/API key/Cookie 在插件边界移除。
2. AGY 使用目录 searchModels，缓存修订为 13；无专用模型时返回 503，过期凭据返回 401。没有硬编码搜索模型或借用会话模型。
3. 独立入口支持 search_query 和 weather。天气明确标为网页检索，不伪造 weather_result；open/click/find 等命令当前返回 501，引用暂不能用这些命令打开。
4. 地区、上下文和长度以模型搜索提示传递；域名和时效通过查询表达式表达，不宣称底层精确过滤。禁止联网、仅缓存模式会拒绝执行；不识别的访问策略类型返回 400。
5. 单次最多四次搜索并遵守更小 max_uses；取消向搜索和模型续轮传播。混合服务器搜索与客户端函数时，先缓冲客户端调用，确认不混合才外发；混合时明确失败。
6. 后续可按独立工具协议扩展 URL 阅读、引用打开和其他命令；不把不支持的命令当成已实现的完整 Alpha Search 协议。
