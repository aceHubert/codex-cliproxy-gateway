# z.ai 服务端内置工具调研（2026-09-13 实测）

调研动机：网关已适配 `web_search_prime`（搜索）与 `analyze_image`（图片识别），需摸清 GLM Anthropic 兼容端点还有哪些服务端工具可复用。所有结论来自对 `https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages`（由 `agent/configs` 把 `https://api.z.ai/api/anthropic` 映射而来）的直接探测，凭据为 zai coding-plan 业务 Key；官方文档（docs.z.ai）未记载任何内置工具，以下均为无文档的私有实现。

## 服务端工具清单（会代执行的只有 3 个）

| 上游工具名 | 声明方式（Anthropic 形状） | 实测行为 | 实测入参 | 网关适配状态 |
| --- | --- | --- | --- | --- |
| `web_search_prime` | `{"type":"web_search_20250305","name":"web_search"}` | `server_tool_use` + `tool_result` 同流完成 | `search_query`、`location:"cn"`、`content_size:"medium"`、`search_recency_filter:"oneMonth"` | 已适配（`web_search` 双向折叠） |
| `webReader` | `{"type":"web_fetch_20250910","name":"web_fetch"}` | `server_tool_use`(名 webReader) + `tool_result` 同流完成 | `url`；失败重试时模型自动带 `no_cache:true` | 未适配（Codex 0.154 无 fetch 内置工具，暂无触发场景） |
| `analyze_image` | 无法作为服务端工具声明；图片内容 + Claude Code 指纹时由服务端注入 | 图片改写 CDN URL 后注入执行 | `imageSource`、`prompt` | 已适配（网关代执行 + 旁白卡片，见 `src/zcode/vision.ts`） |

两者可同请求声明并用；`webReader` 与 `web_search_prime` 语义互补（读指定 URL vs 搜索引擎查询）。ZCode 客户端的 WebFetch 底层即走 webReader；Claude Code 的 `WebFetch` 是客户端本地实现，不经它。

## 不被服务端执行的类型（声明被接受但降级为普通 tool_use）

`code_execution_20250522`、`bash_20250124`、`text_editor_20250124`、`computer_20250124`、`memory_20250818`、`mcp_connector_20250422`、`image_generation_20250826`、`code_interpreter_20250822`、原生 `webReader` 类型。端点对未知工具类型宽容（不报 400），一律按 function 工具处理交客户端执行。

## 注入面

仅图片触发注入（analyze_image）。用完整 CC 指纹信封（system + 81 工具模板）不声明任何服务端工具、分别诱导搜网页/读网页/跑代码时，模型只调用 CC 客户端工具（`WebSearch`/`WebFetch`/`Bash` 普通调用），不注入服务端工具。

## 配额

`web_search_prime` 与 `webReader` 共用同一周/月配额池（账号级，网关无法分开计量）。耗尽时协议层不报错（HTTP 200），`tool_result` 内容变为错误文本：

```
MCP error -429: {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at <时间>"}}
```

实测该池于 2026-09-28 10:05:54 重置。**analyze_image 不在此配额池**：网页工具配额耗尽期间（09-12 起），09-13 的图片识别代执行信封仍正常完成，视觉执行为独立额度。

网关现状：对配额耗尽无感知——折叠机制把 429 文本当正常搜索结果上抛，每轮白烧 1–3 次搜索往返，模型向用户转述重置时间。已调研的适配方案（未实施）：响应侧识别 429 + 重置时间并缓存 TTL，有效期内剥离 `web_search_20250305` 声明、system 注入降级说明（复用 `image_generation` 剥离模式），到期自动恢复；详见 [tech-debt-tracker](exec-plans/tech-debt-tracker.md)。

## 复测方式

配额重置后如需验证 webReader 的成功返回形状，用网关同款凭据直连端点声明 `web_fetch_20250910` 抓取任一公开页面即可；工具形状常量见 `src/zcode/response.ts`（web_search_prime 折叠）与本文件。
