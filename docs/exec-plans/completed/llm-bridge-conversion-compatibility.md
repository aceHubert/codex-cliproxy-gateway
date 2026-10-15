# llm-bridge 封装、Responses / Chat Completions / Anthropic 端点兼容与 agent 适配

状态：已完成并归档（2026-10-12 用户验收）。B0–B4 已实施，通过全量 check（1038 项）与三协议兼容验收（逐家 fake-fetch 矩阵、zen Messages 端到端与 gemini 方向回归）。
后续：2026-10-14 底座迁移决策（npm llm-bridge 停更半年，迁往 ai + @ai-sdk/* 并 fork aio-proxy 薄层）由 [llm-bridge-aisdk-rebase.md](./llm-bridge-aisdk-rebase.md) 承接；本计划的公开契约、边界与测试矩阵整体继承，仅「外部库为真实底座」验收口径被废止。
创建日期：2026-10-10。
协议分析基线：main a20587d（v0.10.0）；外部 npm 依赖 llm-bridge@2.0.1。
实施基线：完成并验收后的 monorepo 重构结果；开始实施时记录其实际提交，不从 main 另建一套目录重构。
分析更新：2026-10-11；协议行为以 main 源码为准，正在执行的 monorepo 迁移不作为协议修复证据。

## 目标

建立 `@agent-proxy/llm-bridge`，只封装规范的 Responses、Chat Completions、Anthropic、Gemini 协议，以 npm llm-bridge 的现有转换能力为底座，补齐标准字段和工具轮的转换损失。ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 的标准请求转换统一调用 `convertRequest(from, to, body, options?)`，通用响应、流式转换和必要解析也通过该包公开方法完成。AGY 的 CloudCodeAssist 请求/响应转换在 `@agent-proxy/agy` 内独立封装，不调用桥接转换包。将原 Chat Completions 计划的字段适配、SSE/JSON 输出与测试合入本计划，不在其他 agent 或网关再建立完整标准转换器。

本轮确认的客户端协议面包括 Responses、Chat Completions、Anthropic Messages，对应 `/responses`、`/chat/completions`、`/messages` 三类 endpoint route。三者的标准请求、响应、SSE/JSON、工具轮和错误形状均纳入兼容验收；规范 Gemini 继续作为 Zen 所需的上游目标与返回源协议。AGY 接受相同客户端协议，但由自身转换模块连接 CloudCodeAssist 私有服务。路由识别、鉴权和派发留在网关，不把 HTTP 服务器或 endpoint 注册放进 llm-bridge。

原协议抽离计划中的通用请求/响应、工具身份、usage、严格 SSE、Responses 事件与输出外壳及回归要求，也由本包统一重构；旧计划文件撤下，不另实施仓库级 `src/protocols/` 共享内核。

本计划负责转换实现、agent 调用适配和转换链路测试；[monorepo 与插件计划](../completed/codex-gateway-monorepo.md)负责目录/包构建、插件契约、入口注册、业务装配和安装配置迁移。两份计划分别记录状态，不能以其中一份完成代替另一份的验收。

实施顺序固定为：monorepo 重构及验收 → 本计划的封装与兼容改造 → 三协议入口联合验收。当前可完成 main 的只读调研和计划收敛；转换源码改动在 monorepo 验收后开展，直接消费已交付的 workspace、plugin-api、agent 包与业务装配，不重新搬迁目录或与正在执行的迁移同时修改相同文件。

## 范围

- 包含：封装库的请求/响应/流式/解析 API，外部 ProviderType 与内部事件类型收口，以及必要的单跳转换和同协议直通契约。
- 包含：Responses ↔ Chat Completions 工具声明/选择/调用历史/输出配对的通用 fix，以及 Chat Completions、Responses、Anthropic、Gemini 中 agent 实际需要的方向。
- 包含：Responses、Chat Completions、Anthropic Messages 的请求字段保真、流式 SSE 与非流式 JSON、usage、结束原因、错误、取消和模型回填；详见后续测试矩阵。
- 包含：ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 接入统一转换方法，保留各自显式前后处理，删除被封装覆盖的重复标准转换。
- 包含：AGY 在自身插件包内独立封装三种客户端协议与 CloudCodeAssist 的请求/响应转换，保持 main 私有服务兼容；不将其转换、信封或特殊策略纳入 llm-bridge。
- 包含：库基线与封装结果的成对 fixtures、各 agent 的 fake-fetch 转换链路测试，以及交接给网关装配计划的测试样例。
- 包含：原协议抽离需求中的通用 JSON/事件解析、工具身份关联、usage 映射、Responses 事件与 SSE/JSON 输出、背压/取消/终态及特征化测试；在 llm-bridge 封装内基于库能力补齐，避免 agent 直接组合旧 kernel 原语。
- 不包含：workspace/Lerna/exports 资源交付、插件注册机制、HTTP/WS 握手、安装目录或配置默认值迁移；这些由 monorepo 与插件计划负责。三协议入口的增量接线作为本计划 B4 的业务交接项，在迁移后的网关中完成，不能以“只做转换方法”为由漏掉 `/messages`。
- 不包含：CLIProxy/NewAPI default 的协议转换；该链路保持原协议直通上游，不依赖或调用 bridge。
- 不包含：沿用旧 `src/protocols/` 完整重写实现，新增 `forwardChat` 或网关 `decode/encode` 兜底层，构造内部 Responses 请求重新进入网关。
- 不包含：厂商 hooks 注入公共转换核心、插件市场、真实凭据修改、真实上游高频验证或发布。

## 背景

- 相关需求：[codex-gateway-monorepo.md](../../requirements/codex-gateway-monorepo.md)。
- Chat Completions 请求字段、响应事件、流式/非流式与测试要求已直接吸收为本计划的封装兼容矩阵；原独立 Chat Completions 端点计划文件撤下，其入口插件和逐家手写转换路线不再实施。
- 2026-10-11：用户确认原协议抽离计划也弃用；必要协议能力和测试并入本计划，原注册/目录/传输生命周期需求由 monorepo 与插件计划承接，不保留第三份独立计划。
- main 的 CodeBuddy/AGY 存在手写标准转换，ZCode/Zen 已部分直接消费 llm-bridge；不能因迁移而退回旧重构分支的自写内核。
- 包目录为 `packages/llm-bridge`，业务层为 `apps/gateway`；消费标准桥接的四类 agent 依赖封装包，AGY 转换由自身包实现。封装包不得依赖 agent、plugin-api 的业务实现或 gateway。
- 调研入口：`node_modules/llm-bridge/dist/index.mjs` 的 `translateBetweenProviders`、`handleUniversalStreamRequest`、`parseAnthropicStream`；main 的 `src/codebuddy/{request,response}.ts`、`src/zcode/{request,response}.ts`、`src/agy/`、`src/qoder/`、`src/opencode/` 与对应测试。
- 已核对 main 指向 `a20587d9da3e375219dca7199c892ddb639d4d64`。下文 `src/` 行号均为该提交的源码定位，实施落点是迁移后的 `packages/*`；只读调研不切换、不重置正在实施的 worktree。

## main 与 npm 库的核实结果

### 三协议方向存在，不等于完整兼容

[llm-bridge 上游仓库](https://github.com/supermemoryai/llm-bridge)提供请求与流式转换。锁定的 2.0.1 类型声明支持 `openai`、`openai-responses`、`anthropic`、`google`；封装内对应 `chat-completions`、`responses`、`anthropic`、`gemini`，外部枚举不泄漏给 agent。

本轮用脱敏内存输入实际调用 2.0.1：三种客户端协议分别转到四种目标协议，普通 user 文本与单个 function 声明均能产生结果。因此不能说库“不支持 Responses/Chat Completions/Anthropic”。下面的完整工具历史、参数、重建及响应能力仍有缺口，README 的完整重建描述不能代替逐字段验收。未执行真实服务请求，也未把这些最小探针当作整个兼容矩阵已通过。

### 已复现的标准转换缺口

| 编号 | 脱敏输入/操作 | llm-bridge 2.0.1 实际结果 | 封装要求 |
| --- | --- | --- | --- |
| L1 | Responses 的 `input` 为字符串，同时有 instructions、tools、max_output_tokens、stream | 转 Chat Completions 后只剩 user 消息和 model；其余上述字段丢失 | 字符串 input 与等价 message 数组具有相同参数和工具语义；在入口规范化并补齐字段 |
| L2 | Responses function_call + function_call_output，含 instructions 与 parallel_tool_calls | call 被当作空 user 消息，output 成为孤立 tool 消息；instructions/parallel 不进入通用体 | 按 call_id 保留 assistant 调用和结果关联、顺序及完整系统提示；不能仅补 tools 声明 |
| L3 | Chat Completions assistant.tool_calls + tool result → Responses | 只剩 function_call_output，没有配套 function_call；max_completion_tokens 未映射 | 修复请求历史投影和 token 上限映射，不能靠响应流式转换已支持工具来证明请求也正确 |
| L4 | Responses named tool_choice → Chat Completions；Chat Completions named tool_choice → Responses | 两边透传源协议对象，没有转换 flat name 与 function.name 的形状 | 声明、历史、named choice 使用同一身份映射，并验证目标协议结构 |
| L5 | Chat Completions 声明 type:custom 工具 → Anthropic | 在访问 tool.function.description 时抛 TypeError | 先校验工具类型；明确可逆降级合同或能力错误，不让库运行时异常成为默认处理 |
| L6 | Chat Completions → Universal 后删除 tools，再转回 Chat Completions | 未改消息数量时直接返回 `_original.raw`，已删除的 tools 重新出现 | 修改/移除必须作用于最终目标体；不让原始重建绕过当前请求的工具政策 |

源码定位：2.0.1 `dist/index.mjs` 的 `openaiToUniversal`/`universalToOpenAI`（约 1097–1340）、`openaiResponsesToUniversal`/`universalToOpenaiResponses`（约 1416–1635）、`translateBetweenProviders`（约 1842）。L2 的 call 丢失、instructions/parallel 未投影同时有源码与最小探针证据；普通数组 input 的 function 声明并非一律被删除，应区分 L1 的字段丢失与 L6 的工具删除失效。

封装实现按缺口增量推进：源协议校验与最小规范化 → 一次源到目标的库转换 → 仅补齐已证明缺失的字段/历史/身份 → 目标结构校验。必要时在封装内部使用库的 Universal API 注入缺失语义；消费桥接的 agent 不接触这些原语，不再手写整套标准消息转换。AGY 独立转换不借用外部库原语。修复需保留库的正常文本、图片、schema 等结果，禁止调用库后丢弃结果重建全体请求。

`from === to` 保留当前输入；厂商前处理已移除的工具或字段不能从旧 `_original.raw` 复活。工具删除、choice 修正及历史可继续回放是三项独立合同：某个工具不再可用，不等于可以删除其已完成历史造成孤立输出。

### CodeBuddy / Qoder 的问题为何仍然存在

main 的两家当前消费 Responses，生成 Chat Completions 风格消息；这不是“已支持 Chat Completions 客户端入口”。`src/gateway.ts:1172–1194` 的 Chat Completions agent 分支仅有 Zen，CodeBuddy/Qoder 分发在 Responses 路径中。新增 Chat Completions/Anthropic 输入要由插件接受真实 `from`，不能把其正文交给只认 Responses `input` 的旧函数，也不能先在网关伪造 Responses 请求。

CodeBuddy 的 `src/codebuddy/request.ts:4–10` 已说明因库丢失标准语义而手写；Qoder 的 `src/qoder/request.ts:1–46` 直接复用它并调整私有参数布局。本轮 main 脱敏探针进一步确认：

- **C1：只有 instructions 时丢提示。** `translateCodebuddyRequest({input:"hello", instructions:"..."}, model)` 不生成 system 消息。源码 `:349–362` 只在 instructions 不存在时补空 system，又只在历史 system 列表非空时输出系统消息。Qoder `request.ts:31–32` 额外补回首条 system，暂时遮住此缺陷；不能保留逐 agent 补丁作为通用修复。
- **C2：strict 丢失。** Responses function 声明 `strict:true` 经 CodeBuddy 转换后没有 `function.strict`；`request.ts:206–215` 重建声明时未消费该字段。Qoder 继承同样结果。是否具体上游接受 strict 由插件能力判断，但公共转换必须先保留其语义，不能静默忽略。
- **C3：已有手写降级不代表标准无损。** custom 被包成 `{input:string}` function；namespace 使用安全名/哈希；工具结果图片提到后续 user 消息；图片 detail 未保留；服务器工具被剥离并生成旁白，针对它的 choice 可能被省略。分别见 `request.ts:56–61,93–121,124–149,194–215,315–339,370–379`。需区分协议可表达性、厂商限制与静默损失，建立逐项合同，不把现有行为照抄成 bridge 的全局政策。
- **C4：Qoder 复用的是厂商实现。** 请求、工具身份类型、异常类型与响应合成器均依赖 CodeBuddy（`src/qoder/request.ts:1`、`src/qoder/response.ts:1–5`）。应把标准转换和响应能力交给 bridge，Qoder 自行保留私有传输/计费/错误，不能只改 import 地址继续携带 CodeBuddy 的 reasoning 信封和错误措辞。

因此当前 llm-bridge 不能直接替换它们，原因有两类：L1–L6 是封装需要补齐的通用缺口；CodeBuddy 的服务限制和 Qoder 的私有推理信封则不属于标准 Chat Completions endpoint。先完成公共缺口，再拆各家前后处理，才能删除现有完整手写转换与跨 agent 耦合。

## 关键契约与交接边界

### 统一请求转换

本节适用于 ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 的规范协议转换；AGY 是已确认的独立转换例外，详见其专节。不能为满足统一调用规则让 AGY 空调用 convertRequest，再丢弃结果。

公开协议标识明确使用 `chat-completions`、`responses`、`anthropic`、`gemini`，名称统一写为 Chat Completions。HTTP 路径仍为 `/chat/completions`，线上对象类型 `chat.completion`/`chat.completion.chunk` 不更名。main 与当前 monorepo 代码的协议短名仅是现状；B0/B3/B4 统一调整公共类型、插件目标协议映射、转换调用及路由上下文，不能只改文档就宣称源码已完成命名迁移。

```ts
import { convertRequest } from "@agent-proxy/llm-bridge";

// 网关识别 from；插件根据自己的上游决定 to
const prepared = adaptIncoming(body);
const converted = convertRequest(from, to, prepared, options);
const upstreamBody = adaptOutgoing(converted);
```

- 公共协议名只表示 Chat Completions、Responses、Anthropic、Gemini 等协议，不出现 ZCode/Zen 或客户端产品名。返回类型、同步/异步和可选元数据在 B0 固化，示例不提前锁死这些细节。
- `from === to` 也是统一入口的明确分支：标准体不先绕到 Responses 或其他协议；保留可表达字段、调用历史和顺序，不因直通而执行厂商政策。
- 跨协议从实际源协议单跳到目标协议，不建立全局 Responses 规范形中转。库的内部实现可使用其 Universal 表达，但调用方不能拼接多次转换代替缺失方向。
- 外部库为真实底座：每个通用 fix 先提供原库失败的反例，再通过最小输入规范化、结果补齐或明确的能力错误解决；不能名义调用库后丢弃结果并全量重写。
- 标准工具声明/历史、custom/namespace 身份等通用转换问题在桥接层解决；服务专属名字限制、schema 降级和工具执行政策留在插件中。
- 未支持方向、非法标准输入、目标协议不可表达的语义有可检查结果或标准错误。不能沿用旧计划的“未知字段一律丢弃”“stop 忽略”“minimal 一律降为 low”等未经实测的全局政策。
- 所有 agent 均不得直接 import npm llm-bridge。ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 的标准请求一律使用封装包 `convertRequest`，通用响应/流式/解析也从同包消费；AGY 请求和响应转换只调用自身包的方法，不依赖或调用桥接转换包。

### 协议转换与插件运行行为的硬边界

- bridge 仅转换标准请求体、响应体和事件流，负责标准解析、字段/身份映射及序列化；可以转换 tool_use/tool_result 等数据结构，但不执行工具、不决定服务工具是否可用。
- ZCode 的 server tool 声明政策、Z.ai 搜索参数与历史回放、搜索结果折叠、analyze_image 执行、换腿/续跑/上限全部封装在 ZCode 插件；Qoder 的排队识别、等待、重发、预算、心跳活性、私有结束标识全部封装在 Qoder 插件。
- 不通过 convertRequest/options、流式转换参数、vendor hooks 或回调向 bridge 注入 executeTool、nextUpstream、retry、queue、签名、凭据或 fetch。外部库的请求执行助手不作为封装公开 API；封装不发上游请求、不创建排队/重试/空闲计时器，也不持有 agent 生命周期。
- 插件持有上游连接与运行状态，处理完私有帧后才把标准流交给 bridge。bridge 的 abort/cancel 只作用于自身转换和传入流的清理；实际 fetch、等待计时器、换腿任务与服务关闭由插件统一取消，不能因公共取消能力而把调度逻辑搬入 bridge。
- 多腿的客户端生命周期、usage 汇总与顺序由插件编排；公共格式化能力只处理明确提供的标准事件/结果，不感知腿次数、工具执行或排队状态。标准桥接单元测试不启动服务、执行工具或等待重试；这些行为在插件 fake-fetch 测试中验收。

### 厂商差异

- ZCode：server tool/web_search 回放与执行、thinking 信封、vision/analyze_image、多腿请求、套餐/凭据/签名，围绕转换入口显式前后处理。
- CodeBuddy/WorkBuddy：凭据/地区/产品头、reasoning 信封和服务要求的 system/工具图片位置；Chat Completions 同协议请求仍进入公共入口，再补服务字段。
- Qoder：Chat Completions 内层经公共入口，COSY、business/ids、模型档位、计费 envelope、排队恢复与解包仍属于插件，不依赖 CodeBuddy 的转换实现。
- AGY：CloudCodeAssist 私有请求/响应、三种客户端协议映射、服务 schema 限制、agn1 回放、thoughtSignature 关联、模型档位与传输均在插件内独立封装。thoughtSignature 本身是 Gemini 标准字段，AGY 独立转换仍需正确保留；规范 Gemini 桥接也单独保留该字段，不为 AGY 加专用分支。
- Zen：目标协议探测、客户端宽松输入政策、指纹与错误归属属于插件，不新增 `OpencodeZenClientProtocol` 等使用方协议类型。
- 消费桥接的插件先解包/补齐私有帧，再交给公共流式能力；返回客户端前恢复厂商身份或信封。AGY 在自身模块完成解包、转换和客户端输出。桥接包不读取厂商配置、不签名、不执行 server tool、不发送凭据请求。

### 原协议抽离需求的承接

- 通用能力由本封装包负责：标准 JSON/事件守卫、严格 SSE 解析与写出、工具身份/调用关联、usage 映射、响应增量与终态、流式输出和非流式聚合。优先复用 npm 库的能力；库缺口有失败反例和最小修复，不照搬旧完整自写内核。
- Responses 输出覆盖起始事件、文本/refusal/reasoning/工具增量、output_index/sequence_number、快照与 completed/incomplete/failed 收尾；同一客户端响应的起始和终态只出现一次。具体事件生成与解析 API 在 B0/B2 按库能力确定，不提前规定必须采用旧 sink/feed 类结构。
- 公共响应转换负责传入标准流的背压、读取清理、SSE/JSON 结果及 abort/cancel 传播；插件负责真实上游连接、空闲计时和换腿取消。两层组合纳入回归，取消先传播到底层，再清理迭代器，不能因等待未结束读取而挂起。
- ZCode 搜索/图片执行与多腿、CodeBuddy reasoning、Qoder 排队/计费信封、Zen 宽松政策继续在各插件显式处理；封装只接收已经适配的公共协议内容，不加入厂商 hooks，也不由这些 agent 绕开 convertRequest 调用一组请求原语。AGY 的全部转换与私有回放留自身模块，不迁入共享 protocols 内核或 bridge。
- 旧计划的前缀注册、HTTP/WS/Realtime、default、目录与 close 等业务需求由 monorepo 计划负责；不把这些网关行为搬入转换包。默认代理 compaction/粘性仍按既定业务边界维护。
- 以 main 的协议行为补齐完整请求和响应转录、错误、usage、取消及厂商组合 fixture，在已验收 monorepo 上实施；允许有已说明的标准字段修复，不用旧分支完成状态证明新封装已完成，不以净删除行数作为验收指标。

### 与 monorepo 及插件计划的依赖

1. 前置门槛为 monorepo S0–S5 完成并验收，记录实际提交及基线检查结果。它交付包目录、manifest、构建边界、handler 上下文、agent 生命周期、业务装配与安装迁移；本计划不重新实施这些内容。
2. B0 在已交付契约上收敛 `from`/转换 API，记录 anthropic 来源类型和 `/messages` 的最小增量；B1/B2 交付封装与标准 fixture 后，B3 可按 agent 包并行接入。
3. 包迁移与转换改造顺序执行，不与当前 monorepo 会话同时改转换源码。main 的 `src/` 路径仅供协议证据和回归语义定位；实施只修改迁移后的 `packages/*`、`apps/gateway` 及其测试，不恢复旧目录。
4. 本计划提供 agent handler 的 Responses/Chat Completions/Anthropic 三种输入、目标请求体和 SSE/JSON 输出测试样例；在已交付业务装配上按 B4 增量接线，验收模型匹配/请求归属/default 隔离。当前 monorepo 会话保持转换行为，不要求它提前实施本计划。
5. `apps/gateway` 核心和 default 无 bridge 依赖。转换成功不代表入口注册完成，入口可派发不代表转换字段保真，两份计划均需自己的完成记录。

### 三协议封装能力与 endpoint route 的边界

Chat Completions ↔ Responses 的标准字段和响应转换属于本计划的公共能力，与 Chat Completions ↔ Anthropic/Gemini 一起直接纳入 convertRequest 和响应封装的兼容矩阵。用户确认撤下独立 Chat Completions 端点计划，因此不继承旧方案的官方内部请求重写、递归进入网关或额外 decode/encode 业务层。

三协议入口的目标接线如下，表格是本计划交付要求，不是 main 已实现清单。main 当前四家只消费 Responses，Zen 消费 Chat Completions/Responses，尚未有统一的 Anthropic agent 入口。

| HTTP 入口（默认 mountPath） | handler 的 from | 操作 | 返回协议 |
| --- | --- | --- | --- |
| `POST /v1/responses` | `responses` | `generate` | Responses SSE 或 Response JSON |
| `POST /v1/chat/completions` | `chat-completions` | `generate` | Chat Completions chunks + `[DONE]` 或完整 completion JSON |
| `POST /v1/messages` | `anthropic` | `generate` | Anthropic Messages 事件或 Message JSON |

- 路由按配置的 mountPath 精确识别；`/responses/compact` 仍是独立 Responses 操作，`/messages/count_tokens`、Gemini 客户端路由、Realtime 不在本轮新增范围。
- `plugin-api` 的公共客户端协议类型增加 `anthropic`，网关端点识别增加 `/messages`。这些是迁移完成后的最小契约/业务接线改动，B0 记录交接，B4 实施和验收；转换包不注册 route，不依赖具体 handler 类型。
- 插件接受三种真实来源 `from`；ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 按模型选规范上游 `to`，请求走一次 `convertRequest`，返回走封装方法。AGY 将相同 `from` 交给插件内的独立转换模块；网关不因 AGY 例外增加厂商分支。不能因为入口叫 `/messages` 就把所有上游固定成 Anthropic。
- 按客户端协议返回正确 Content-Type、JSON 外壳、SSE 事件、错误格式；Anthropic 的 message_start/content_block_start/delta/stop/message_delta/message_stop 与错误事件纳入标准封装。header/版本校验、上游认证头构造属于网关或插件，不能把客户端 `x-api-key`、Authorization 原样传给 agent 服务。
- CLIProxy/NewAPI default 对相应路径和正文仍原协议转发，不走 bridge、不把 agent 错误转过去；main 官方路由保持既定行为。本轮新增的是 agent 的三协议兼容接线，不以库能力宣称额外官方业务端点已交付。

## 各 agent 的转换与个性化处理

各家先保留 main 的语义 fixture。ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 用公共 API 替换标准转换，前后处理只负责服务限制、私有载荷、身份映射与传输；不得先手写全量标准体，再空调用同协议 convertRequest。AGY 在自身包内独立整理和补齐转换，不套用上述替换要求，不复制旧分支的 protocols 内核。

### CodeBuddy / WorkBuddy：标准 Chat Completions 上游与服务要求

**main 调用链：** `src/codebuddy/index.ts:292–324` 调用 `translateCodebuddyRequest`，发到服务 `/v2/chat/completions`，强制上游 SSE；`src/codebuddy/response.ts` 手写 Chat Completions SSE → Responses SSE/JSON。凭据、地域、CodeBuddy/WorkBuddy 产品头由 adapter 管理，WorkBuddy 共用转换，不另建桥接协议。

**目标转换：** `convertRequest(from, "chat-completions", ...)`，其中 from 为 responses/chat-completions/anthropic。Chat Completions 同协议不先变成 Responses；公共封装负责 instructions/system/developer、文本/图片、工具声明/历史/choice/strict、token 参数和标准返回，直接修 C1/C2。服务只允许单个 system 时由 CodeBuddy 显式整理，不能把“Chat Completions 只能有一个 system”写成公共协议限制。

**前后处理：**

1. 前处理解析产品/地域/模型、目录能力和不支持的服务选项；解开 CodeBuddy 的模型绑定 reasoning 信封，仅在相应模型上恢复 reasoning_content。服务器工具剥离、旁白与不可执行的指定 choice 按服务合同显式处理；若移除被强制选中的工具，要明确报错或说明降级，不能静默省略。
2. 公共转换保留 custom/namespace 身份与工具轮；服务只接受 function 时明确选择可逆 `{input:string}` 降级。服务安全名/长度/哈希规则由插件应用，声明、choice、调用/结果和响应必须使用同一映射。工具结果图片移到后续 user 是服务兼容策略，插件需明确其顺序和语义变化，不作为 bridge 对所有 Chat Completions 目标的默认行为。
3. 后处理写真实模型、必需的首条 system（无内容时补空）、服务 token 默认值、`stream:true` 与 include_usage；不能覆盖公共封装已保留的客户端参数。请求强制 SSE 不影响客户端可选非流式，统一聚合返回所请求的协议。
4. 返回的 Chat Completions 标准事件、usage、finish reason、工具参数与 JSON 聚合由 bridge 负责；CodeBuddy 插件处理服务错误脱敏、私有 reasoning 信封及原工具身份回填。不得让其信封格式成为其他 agent 的公共输出默认。

**验收：** 三种入口对应等价 Chat Completions 体；instructions-only、空 instructions、只有 developer、多条 system、strict/choice、并行 custom/namespace 工具往返、图片 detail、服务图片提升、DeepSeek 私有回放与普通模型隔离。沿用 `test/codebuddy-{request,response,gateway}.test.ts`，增加每种来源的 SSE/JSON、错误与 idle abort。

### Qoder：Chat Completions 风格内层与私有 infer 信封

**main 调用链：** `src/qoder/request.ts:14–46` 借 CodeBuddy 转换后把 messages/tools/system 和 parameters 布局成 Qoder 请求；`src/qoder/transport.ts:119–130,173–183` 编码、签名并发到私有 infer SSE 入口。它不是公开 Chat Completions endpoint。`src/qoder/response.ts:18–148` 先解 envelope 为 Chat Completions SSE，再借 CodeBuddy 生成 Responses。

**目标转换：** 由独立 Qoder 插件调用 `convertRequest(from, "chat-completions", ...)` 获得标准 Chat Completions 风格内容，再包装私有信封；不增加 `qoder` 公共协议名，不复用 CodeBuddy 的转换/响应模块、工具类型或异常类型。

**前后处理：**

1. 前处理负责地域/模型选择和目录支持的 effort/context_window；服务能力不接受的参数在此说明，不由 bridge 擅自借用 CodeBuddy 的限制。Qoder 现有 instructions 补丁被公共修复替代。
2. 后处理把公共 messages/tools 放入信封，按服务要求生成首条 system 与顶层 system，参数移入 parameters，并填 context_length、COSY/business/ids 等私有字段。编码、签名、排队等待和恢复仍留 Qoder，bridge 不触碰这些字段。
3. 响应前处理验证信封、跳过 queue/start/heartbeat 元数据、解 body，按真实 call id 修复上游复用 index=0 的问题；独立 finish 是权威结束，内层 `[DONE]` 不能提前关闭。产出的标准 Chat Completions 流交给 bridge 返回三种客户端协议。
4. 提取 credits/original_credits/billable 计费并由插件增补，保留各客户端协议的标准 usage；不得因计费包装再次丢失失败终态、取消或错误状态。
5. `codebuddy-reasoning-v1:` 是现有复用携带的私有格式，不下沉 bridge。main 请求/响应确有 DeepSeek 分支耦合（CodeBuddy request `:243–284`、response `:194–208,350–352`），但未证明 Qoder 生产模型触发；B3 核对目录和既有回放 fixture，确定 Qoder 自身回放合同。需要存量兼容时由 Qoder 插件只读处理，不能继续依赖整套 CodeBuddy adapter。

**排队完全属于 Qoder：** main `src/qoder/queue.ts` 已在插件内部预读私有 SSE 信封，识别内层 403/10605 排队状态；这不是把 HTTP 403 当作可重试排队。只收到排队时取消当前上游流，按 retryAfterSeconds 等待后重新 infer，默认重试预算 120 秒、等待上限 30 秒。排队帧不传给 bridge 或客户端，keepAlive 只重置插件空闲计时，不生成客户端事件；若同块已有推理内容，保留首帧及未解析余量交给后续解包。拿到内容后由 Qoder 逐帧验证 envelope、修复私有 tool index 并输出标准 Chat Completions 流，bridge 随内容到达进行转换；独立 finish 的识别及标准结束标识生成由 Qoder 完成，不提前因内层 DONE 关闭，也不等整个响应结束才开始转换。重试、签名更新、预算耗尽错误与取消全由 Qoder 完成，不向 bridge 传排队配置或重发回调。

**验收：** 三来源转换后私有 envelope 语义一致；effort 不支持、context_length、queue 后恢复、finish 与内层 DONE 区别、计费、并行同名工具和 index 重用、嵌套错误、流中取消/空闲 abort。沿用 `test/qoder-{request,response,transport,gateway}.test.ts`；静态确认 Qoder 无 CodeBuddy 转换依赖。

### ZCode：Anthropic 标准体、server tool 与多腿

**main 调用链：** `src/zcode/request.ts:91–103` 仅普通文本调用库的 Responses → Anthropic；`:105–280,301–352` 手工重建工具和历史。`src/zcode/response.ts:146–183` 用 parseAnthropicStream，但自己生成 Responses 外壳与事件。不能把“文本用过库”视为所有转换已封装。

**目标转换：** `convertRequest(from, "anthropic", ...)` 一次得到 Messages 体；Anthropic 来源同协议直通也经过统一入口。function/tool_result、图片、system、token、标准 thinking 内容的可表达性由封装处理。

**前后处理：**

1. 前处理解析 `zcode/*`、`zcode-*/*` 套餐/provider、凭据和真实模型；解 model-bound thinking 载荷。标准工具调用校验/配对进入 bridge，服务工具名称约束与私有身份仍由插件保持。
2. `web_search` → ZCode 服务支持的 `web_search_20250305` 声明、server_tool_use 与历史回放由插件显式适配；公共转换负责标准协议形状，不能自己决定 ZCode 能执行搜索或把该工具政策推广给其他 Anthropic 上游。
3. reasoning effort 的具体 budget 表、budget 小于 max_tokens、启用阈值、默认 token 和始终 SSE 是 ZCode 服务合同；放在转换前后的服务参数处理，不能全局固定其他 Anthropic 服务的预算。原生 Anthropic thinking 输入也按同一服务能力验证，不静默覆盖。
4. 图片需要 analyze_image 时，插件注入工具/说明、处理客户端同名冲突、执行服务调用、续跑后续腿、设置上限；每个真实上游请求均调用公共入口。bridge 不执行工具、不换腿、不重放副作用。
5. 插件截获内部 server/vision 调用并按既有策略折叠；处理后标准 Anthropic 内容交公共响应能力。客户端全程的起始/终态、跨腿 usage 汇总及事件顺序由 ZCode 持有的运行上下文编排；公共输出仅负责标准协议表达，不负责换腿，私有 thinking 回填也留 ZCode。

**server tool 完全属于 ZCode：** web_search 的允许/禁用、namespace 限制、web_search_20250305 声明参数与 Z.ai 的 web_search_prime/search_query 回放在插件中处理，搜索由上游服务执行。插件关联 server_tool_use 与 tool_result/web_search_tool_result，再按客户端协议表达搜索结果；桥接只转换剩余标准内容，不认识 Z.ai 的工具名字或执行政策。analyze_image 则由 ZCode 插件代执行并续跑，不能通过 bridge 的工具 hook 或 nextUpstream 回调完成。声明/历史与标准转换结果合并时保留顺序和身份关联，不能因剥离服务特性产生孤立工具输出或让被禁用工具从原始重建中复活。

**验收：** 三来源产生等价 Anthropic 工具轮；server search 声明/回放、custom/namespace 安全名、thinking 签名与预算、图像 URL/base64、analyze_image 同名冲突/成功/失败/续跑上限、跨腿连续序号/usage/一次终态、换腿取消。保留 `test/zcode-{request,response,vision,gateway}.test.ts` 的 main 行为断言。

### AGY / Antigravity：独立 CloudCodeAssist 转换模块

**main 调用链：** `src/agy/request.ts:270–469` 完整手写 Responses → Gemini 后构造私有 wrapper，没有调用 llm-bridge；`src/agy/transport.ts:78–113` 请求 v1internal streamGenerateContent；`src/agy/response.ts:55–94,316–419` 解析包装帧并手写 Responses 事件。

**已确认方案：** 请求和响应均由 `@agent-proxy/agy` 自身转换模块封装，不调用 `convertRequest`，不依赖 `@agent-proxy/llm-bridge` 或 npm llm-bridge。模块显式接受公共 `from: responses | chat-completions | anthropic`，负责客户端输入到 CloudCodeAssist 请求体、私有响应到相应客户端 SSE/JSON 的映射；具体内部方法名在 B0 收敛，网关只调用正常插件 handler。

**独立模块职责：**

1. 保留 main 的 Responses 行为并新增 Chat Completions/Anthropic 的直接输入映射；在包内组织消息、system、工具声明、调用/结果、图片、参数与返回外壳，不在网关伪造 Responses 请求或重入路由。完整工具历史按 id/顺序校验，并行同名调用不能只凭名称配对。
2. CloudCodeAssist 的 protojson 白名单、`$ref` 内联及 const/联合/元组降级全部由 AGY 处理（main request `:91–207`）；不可等价的 schema 降级需报告，不能无条件裁掉约束。安全工具名、custom/namespace 身份、choice、参数与结果回填使用同一关联表。
3. 图片 inlineData/fileData、URL/MIME/模型能力校验、thinkingBudget=-1、includeThoughts、effort → thinkingLevel 留独立模块。`thoughtSignature` 是 Gemini 标准 Part 字段，应保留正确关联；`agn1:` 是本插件用于客户端回放的自定义信封，两者不能混称为私有协议字段。
4. 构造 project/requestId/sessionId/userAgent/requestType 等服务包装，完成模型/凭据/认证与传输；解析响应 wrapper、thought/signature、functionCall、usageMetadata、finishReason/promptFeedback 与服务错误，独立生成三种客户端协议的标准 SSE/JSON/错误外壳。
5. 背压、idle abort、下游 cancel、读取清理和一次终态均由 AGY 输出路径负责。可以用相同语义 fixture 验证客户端协议一致，但不调用桥接方法生成输出，不向 bridge 注册 AGY hooks 或协议枚举。

**验收：** 三来源到真实私有 envelope、并行同名调用、schema 引用/循环/白名单/不可等价降级、agn1 与 signature 回放、图片、thought/usage/finishReason/promptFeedback、三种协议 SSE/JSON 一致。保留 `test/agy-{request,response,gateway}.test.ts` 并补 idle abort/cancel/清理；增加依赖和调用检查，AGY 路径对桥接转换及 npm 库的调用次数为零。只在 monorepo 验收后清理 AGY 无用的 bridge 依赖，不改变当前迁移会话的实施范围。

### OpenCode Zen：模型选协议与宽松服务政策

**main 调用链：** `src/opencode/convert.ts:83–176` 手写 Responses → Chat Completions，再以 Chat Completions 中间层转 Anthropic/Gemini；同协议浅拷贝、流式经库转换。`src/opencode/index.ts:392–455,525–594` 处理 Chat Completions/Responses 两入口；`response.ts:55–58,84–131` 宽松跳过坏帧、缺 finish 默认 stop。这些是现状，不是公共协议合同。

**目标转换：** 目录决定 `to: chat-completions | responses | anthropic | gemini`，插件直接调用 `convertRequest(from, to, ...)`；三来源均不得先绕 Chat Completions。删除 Zen 的完整 responsesToChatBody 和 `OpencodeZenClientProtocol`，消费共享公共协议类型。

**前后处理：**

1. 前处理负责目标 endpoint 探测、指纹/模板、服务限制和有证据的宽松输入修正；修正需记录被改内容，不能把未知历史、reasoning 或坏 JSON 的静默丢弃下沉为公共默认。
2. 公共封装解决 instructions/parallel/history/choice、输出文本和 token 映射；现有 `max_tokens` 覆盖库默认 1024 的补丁拆成通用映射与服务缺省，避免覆盖客户端明确上限。
3. 后处理写真实模型和目标 API 的服务字段/认证头，响应由同包处理对应源到客户端协议的 SSE/JSON；Responses 同协议保留标准语义，Chat Completions/Anthropic 同协议也不绕其他协议。
4. 宽松坏帧/缺终态处理如果确为 Zen 服务需求，只在插件的可观测前处理实施；不得将失败或截断流直接当作成功 stop。请求返回流后仍需保持 signal 到 fetch/reader 的取消传播，不因提前 cleanup 移除必要监听。

**验收：** 三来源 × 四目标的请求与返回方向，每个支持组合覆盖同协议/跨协议、工具完整轮、token 上限、真实 JSON/SSE、错误/截断、reasoning 和模型回填；补流返回后的 abort/cancel。沿用 `test/opencode-zen-{convert,gateway}.test.ts`，明确宽松兼容 fixture 与公共严格 fixture 的边界。

## 兼容与测试矩阵

每项先区分标准协议能力、npm 库当前结果和厂商服务限制，再确定映射或错误合同。原 Chat Completions 计划的字段表是测试输入来源，不能照抄其静默丢弃或固定降级结论。

### 请求与工具轮

- 协议方向：Responses/Chat Completions/Anthropic 三者的六个跨协议方向及三个同协议方向；三种来源 → Gemini 的请求及 Gemini → 三种客户端协议的返回。逐方向测试请求和返回，不以“方向注册存在”代替字段断言，也不新增 Gemini 客户端 endpoint。
- 工具声明：`tools`、`tool_choice` 的 auto/none/required/named、函数 `strict`/schema/name/description、无工具请求。覆盖 L1 的声明丢失、L6 的删除被重建覆盖，以及仅删除部分工具/清空工具时的 choice 和历史处理，保证 fix 不改坏正常请求。
- 调用历史：assistant 工具调用、Responses `function_call` 与 `function_call_output`、`call_id`/`tool_call_id`、参数字符串/对象边界、多个并行调用、同名工具、输出与调用成对关系、消息顺序及空文本。孤立输出和歧义关联有明确合同，不能凭名字猜测后静默配错。
- 标准扩展：custom/namespace 的工具声明、身份、调用和输出关联；不可表达时给明确结果，某个服务的命名或降级策略不变成公共默认。
- 内容：system/developer/instructions 的出现顺序和语义、user/assistant 文本、工具结果、文本与图片 parts、URL/base64 图片和 detail。工具结果含结构化内容时不能仅用 `JSON.stringify` 伪装无损。
- 参数：`max_tokens`/`max_completion_tokens`/`max_output_tokens` 的优先级和冲突、temperature/top_p、parallel_tool_calls、response_format/json_object/json_schema/strict、reasoning/reasoning_effort、stream 与 `stream_options.include_usage`。
- Anthropic 输入：system 字符串/内容块、messages 中 text/image/tool_use/tool_result、工具结果 is_error、tool_choice 的 auto/any/tool/none 与 disable_parallel_tool_use、max_tokens/stop_sequences、thinking/redacted_thinking/signature、cache_control。同协议保留可用结构；跨协议无法表达的签名/缓存/原生服务工具必须有能力合同，不伪装为文本或静默丢失。版本和 beta header 属于业务接线，不能用 body 转换代替。
- 能力边界：`n`、stop、未知扩展、目标不可表达字段和 malformed arguments 均建立实测合同；不能沿用旧方案的“n>1 一律 400、stop 忽略、未知全部丢弃”作为跨协议结论。

### 流式、非流式与错误

- Chat Completions SSE 使用 `chat.completion.chunk` 与 `[DONE]`；文本、reasoning 和工具参数的增量切片可正确拼接，JSON 非流式聚合与相同语义的流式结果一致。
- Anthropic SSE 覆盖 message_start、content_block_start/delta/stop、message_delta、message_stop、ping/error，包含 text_delta/input_json_delta/thinking_delta/signature_delta 的分帧和 block index；JSON 的 Message content/stop_reason/usage 与同语义流式一致。三种客户端均按自己的协议返回错误，不把 Anthropic 响应套成 Chat Completions JSON。
- 工具 index、id、name、arguments 分帧、交错并行调用、空首块、结束块和仅有工具输出的结果都可关联；不能因 vendor 结束帧重复而生成重复完成事件。
- finish reason 覆盖 stop/tool_calls/length/content_filter、Responses completed/incomplete、Anthropic stop_reason、Gemini finishReason；无法一一对应时记录公开合同。
- usage 覆盖输入/输出/总量、缓存和 reasoning 明细、缺失/重复 usage；`include_usage` 为 true/false 时 Chat Completions usage 块形状和终止顺序正确，不凭空补估计值。
- 每种返回形态恢复请求的 model 展示名；客户端模型前缀与上游模型名的服务解析属于插件，桥接只消费明确提供的公共上下文。
- SSE 解析覆盖任意字节切片、UTF-8 多字节边界、CRLF、多行 data、注释、终止帧、畸形 JSON 和截断流；设置合理帧限制并按实际字节计数。
- 上游非 2xx、标准错误帧、流中失败、取消、读流异常及 reader cleanup 均明确；Chat Completions 返回标准 error 形状，status/code/message 不被误报成功，日志继续脱敏。
- 取消测试包含上游空闲挂起时的 abort，确认及时触发底层取消，不等待一个永不结束的 iterator 再取消连接；不因非流式聚合丢失 signal。
- Responses 事件转录覆盖 created/in_progress、消息与工具增量、refusal/reasoning、output_index/sequence_number 连续性、成功/不完整/失败终态与快照；JSON 聚合与对应事件流一致，ZCode 多腿的客户端事件序号不重置，私有换腿策略仍由插件决定。
- 不要求所有上游恒流式。沿用各插件既有传输约定，分别验证真实 JSON 和 SSE 输入；需要 SSE 聚合 JSON 时通过同一公共聚合入口，避免逐 agent 再写一套。

### agent fake-fetch 链路

- CodeBuddy/WorkBuddy 与 Qoder：Chat Completions → Chat Completions 无中转；Responses/Anthropic → Chat Completions 保留工具轮；断言 CodeBuddy 服务头、Qoder 包装/签名/排队与解包仍生效，C1/C2 修复不靠 Qoder 局部补丁。
- ZCode：Responses/Chat Completions/Anthropic → Anthropic；断言标准工具和图像转换，以及 server tool、thinking、vision、多腿与工具身份前后处理不被搬入桥接包。
- AGY：三种客户端协议 → 插件独立转换 → CloudCodeAssist 私有服务 → 独立转换返回客户端；断言完整 envelope、工具/图片/schema/signature/usage 与终态语义，及桥接零调用。不能以规范 Gemini 的库测试替代 AGY 验收。
- Zen：按模型决定目标协议，覆盖 Responses/Chat Completions/Anthropic 同协议与跨协议、流式/JSON、宽松输入策略、错误与模型回填，不保留 Chat Completions 中间层。
- 每家每种客户端协议至少覆盖流式、非流式、一个完整工具调用与结果轮、上游错误及取消；比较三种同语义输入对应的上游体，AGY 比较自身私有体，其余比较公共转换结果。不重复建立逐协议网关 forward 管线。厂商不可支持的语义需断言明确的本地能力错误，不能以 blanket 拒绝整种来源协议通过验收。
- fake-fetch 记录目标 URL、调用次数与转换次数，agent 错误/重试不能转入 CLIProxy/NewAPI。default 原样转发和零 bridge 调用的完整入口测试由 monorepo 计划负责，本计划提供可复用样例。

## 风险与缓解

- npm 库本身有损：每个 fix 提供原始库结果和封装结果成对断言；升级版本需要重跑相同 fixtures。
- 公共转换与服务政策混合：厂商输入/输出处理显式分层，静态检查桥接包无 agent 名称、依赖、配置读取和私有 hooks。
- 特性被包装成桥接选项：审查 API 和调用链，bridge 无工具执行/换腿/排队/重发/fetch 回调；标准测试与插件执行测试分开，不能仅靠目录命名证明边界正确。
- AGY 边界被重新合并：其请求/响应转换均在自身包，规范 Gemini 桥接只按协议 fixture 验收；AGY 不调用桥接方法、不增加公共 AGY 协议名。规范 thoughtSignature 字段与 agn1 私有信封分别记录。
- Gemini 工具关联或跨协议 reasoning 不可表达：测试并行同名调用和完整回放，明确拒绝/诊断合同，不以合成 id 掩盖语义丢失。
- 实施基线混淆：main 仅作协议分析，源码改造消费 monorepo 验收提交；先完成迁移，再做转换与三入口接线，不同时覆盖迁移中的文件。
- 转换与入口交付混淆：三协议能力直接纳入封装，不继承撤下的独立端点业务路线；库测试与三类真实 HTTP 入口分别验收，迁移完成不意味着协议适配完成。
- 兼容改造破坏现有 Responses 行为：以 main fixtures 为协议基线，Chat Completions/Anthropic 测试新增而不替换 Responses 回归，厂商兼容变化必须说明原因。

## 里程碑与完成门槛

### B0：库能力、转换合同与测试输入收敛

- 固定 main 协议分析证据与 llm-bridge@2.0.1，盘点请求、响应、流式和解析的真实调用能力，明确必要方向及同协议行为；进入源码实施前记录已验收 monorepo 的实际提交与基线检查结果。
- 将本轮 L1–L6、C1/C2 的脱敏最小探针固化为成对 fixture；逐家根据前述审计建立“公共字段 / 插件前处理 / 插件后处理 / 服务不可表达”清单。完成调研不能替代公开 API 与全部字段合同收敛。
- 收敛 `convertRequest`、响应/流式/解析 API、工具关联元数据、不可表达和错误合同，复用 monorepo 已交付的公共协议类型并记录必要增量。
- 明确纯协议 API 与插件执行边界；禁止工具执行、nextUpstream、queue/retry 或 fetch 注入桥接方法，多腿上下文与重试预算归插件。
- 公开类型、from/to 和文档示例统一为 `chat-completions`；B3 更新插件映射，B4 更新路由上下文，保留 HTTP 路径和标准响应对象类型。
- 明确三种客户端来源、四种上游目标和响应方向；交接 `/messages` 与公共 anthropic 来源类型的最小改动，当前 monorepo 迁移不实施转换。
- 将旧 Chat Completions 字段/事件表转为上述矩阵，建立工具声明/历史丢失反例及各家 main 回归 fixture。
- 合入旧协议抽离的解析、工具身份、usage、Responses 事件/外壳与厂商组合回归要求，明确库已支持与需要补齐的能力，不重建独立 protocols 内核。
- 门槛：每项语义有可审查的保留/映射/拒绝合同；Responses/Chat Completions/Anthropic 字段与测试直接纳入封装范围，各 agent 私有差异与入口装配归属明确。

### B1：基于外部库的请求封装与通用 fix

- 实现统一 `convertRequest`，封装外部 ProviderType 和库调用，完成同协议直通和必要单跳方向。
- 优先修复 Chat Completions/Responses 工具移除、strict/choice、call/output 关联、system/developer/instructions、parallel 和标准扩展损失。
- 删除工具后不被原始重建恢复；修复字符串 input 的参数丢失、Chat Completions → Responses 调用历史丢失、named choice 形状和 max_completion_tokens。Anthropic 的请求/工具历史也纳入同一标准合同，不能只保证 Chat Completions 输出。
- 补齐其他必要方向的标准字段；不可表达能力用明确合同处理，不复制全套独立转换器。
- 门槛：库失败反例在封装后通过，正常库字段不回归；包内无 agent 类型/依赖或服务分支。

### B2：响应、SSE/JSON、错误与取消封装

- 收口库的通用流式与解析入口，实现 Responses/Chat Completions/Anthropic 的 SSE、JSON、错误输出，以及 Gemini 源协议的相应转换；保留库已有解析能力，缺口逐项补齐。
- 完成工具 index、usage、finish reason、模型回填、流中错误与取消矩阵。
- 完成原协议抽离承接的严格解析、Responses 事件序号/快照/终态、背压、提前 EOF 与读取清理，复用库能力并对缺口增量修复。
- 门槛：同语义流式/JSON 可比较，上游 idle abort 可终止，无重复工具/完成事件，无凭据泄漏。

### B3：各 agent 的调用适配与特殊兼容

- 在 monorepo 已迁移的四类标准桥接 agent 包内删除直接依赖 npm 库及被覆盖的标准转换，请求调用公共 `convertRequest`；AGY 在自身包内独立封装请求/响应并清理无用 bridge 依赖。不重新做 S3 目录迁移。
- 厂商差异围绕入口显式前后处理；必要流式私有帧解包交给公共能力后再恢复身份。
- CodeBuddy/Qoder 耦合解除按依赖推进，其余包在 API 稳定后可并行；此时目录迁移已经完成，各包写入边界保持独立。
- 逐家交付前述转换/特殊点清单；Qoder 请求和响应均解除 CodeBuddy 依赖，ZCode 不再仅文本走库，Zen 删除 Chat Completions 中间层。AGY 独立模块保留 main 私有服务兼容并补三来源，不将其现有转换迁入 bridge。
- 门槛：每家 Responses/Chat Completions/Anthropic 与自身特殊行为通过 fake-fetch 测试，无新逐协议 forward、网关 decode/encode 或递归重入。

### B4：联合验证、文档与收尾

- 将转换链路 fixtures 接入 monorepo 已交付的业务装配；分别确认转换正确与派发/部署正确，default 保持零转换。
- 在迁移后的 plugin-api/业务路由增量接入 anthropic 与 `/messages`；三条真实 endpoint route 均按同一模型模式分发，验证 mountPath、鉴权/敏感头隔离、错误外壳、原始正文单次读取和正确返回协议。当前迁移只交付既有行为，新增兼容由本计划负责完成，不倒推为迁移会话已实现。
- 补充公开方法、协议方向和不可表达能力说明，交付结论区分封装能力与网关入口装配。
- 完成相关测试、类型检查和最终 check；实际源码改动记录历史，只有实施与验收完成后才归档本计划。
- 门槛：转换矩阵和 agent 回归通过，边界检查无违规，两个计划的状态分别如实记录；不发布。

## 验证方式

- 本轮纯计划：以 `git show main:...` 审阅协议源码/既有测试，使用锁定库与 main 请求函数运行脱敏内存探针；检查文档交叉引用、范围归属、字段矩阵和空白。不改协议源码，不运行完整测试套件，不访问真实服务或凭据，不宣称修复完成。
- 实施时：按包执行 bridge 请求/响应/流式测试，以及每个 agent 的转换 fake-fetch 和现有兼容测试；命令与新增测试文件名在 B0 确定。
- 静态检查：只有 `packages/llm-bridge` 依赖外部 llm-bridge；四类标准桥接 agent 请求均调用公共 `convertRequest`；AGY 请求/响应转换不依赖或调用 bridge/npm 库；bridge 不依赖 gateway 或 agent，default 无转换调用。
- 运行边界检查：bridge 不持有上游 fetch、凭据、工具执行器、nextUpstream、排队/重试/空闲计时器；ZCode 特性和 Qoder 排队测试在插件层用受控时钟/fake-fetch 验证，bridge 测试仅接收标准体或标准流。
- 联合验证：在 monorepo 迁移结果上证明 Responses/Chat Completions/Anthropic 三入口正确派发；本计划断言真实目标协议体、SSE/JSON 与完整工具轮。default 原样转发和零转换单独断言。
- 每次后台测试设置最多 60 秒，例如 `perl -e 'alarm 60; exec @ARGV' bun test <相关测试文件>`；按相关检查推进，提交前执行 `bun run check`，不靠真实上游或生产凭据验收。

## 进度记录

- [x] 从 monorepo 计划拆出独立转换/兼容计划，合入旧 Chat Completions 适配与测试范围。
- [x] 明确 default 零转换、统一 convertRequest 与厂商前后处理边界。
- [x] 合入原协议抽离的通用能力与回归要求，撤下旧独立协议抽离计划；业务插件部分由 monorepo 计划承接。
- [x] 以 main 核对五家转换链路，复现 L1–L6、C1/C2，补充逐家前后处理与测试要求；确认 Responses/Chat Completions/Anthropic 三类入口目标。
- [x] 按最新决策将 AGY 改为包内独立请求/响应转换；llm-bridge 只处理规范协议，规范 Gemini 能力为 Zen 保留。
- [x] B0 库能力、公开 API、标准字段与错误合同收敛（2026-10-11：L1–L6、C1/C2 以 2.0.1 实测探针固化；公开 API 收敛为 convertRequest / parseUpstreamEvents / ResponsesOutputShell / create*ClientOutput / clientErrorResponse）。
- [x] B1 请求封装与通用 fix（packages/llm-bridge/src/request.ts：三来源单跳转换、同协议直通、custom/namespace 身份表、strict/stop/parallel/token 映射；test/llm-bridge-convert.test.ts 23 项含全部失败反例）。
- [x] B2 响应/流式/聚合/错误/取消（src/events.ts 四协议严格解析 + src/output.ts 三客户端渲染与 Responses 外壳；空 reasoning/未知结束原因/取消唤醒/计费透传有合同；test/llm-bridge-response.test.ts 14 项）。
- [x] B3 各 agent 调用适配与 fake-fetch 测试（zcode/codebuddy/qoder/zen 请求层统一 convertRequest；qoder 解除 codebuddy 依赖；zen 删除 responsesToChatBody 中间层并新增 /messages 入口；agy 三来源归一化 + 自产 Responses SSE 独立渲染 chat/anthropic，零桥接依赖；test/llm-bridge-boundaries.test.ts 静态边界检查）。
- [x] B4 联合验证、说明、历史记录与归档（plugin-api ClientProtocol 统一 chat-completions/responses/anthropic 并新增 /messages 端点识别；gateway-composition 压缩包装仅作用于 Responses；bun run check 全绿 1038 tests；三协议顺序验收为主题分组冒烟（Responses 200 / Chat Completions 119 / Anthropic 68 项），逐家三协议 fake-fetch 由 test/agent-protocol-matrix.test.ts、test/agy-protocol.test.ts 与 zen Messages 端到端补齐）。

## 决策记录

- 2026-10-10：用户要求将 llm-bridge 封装与兼容独立成计划，合入 Chat Completions 适配和测试；原 monorepo 计划聚焦包/插件及新增安装配置迁移。
- 2026-10-10：所有标准请求转换统一进入 `@agent-proxy/llm-bridge.convertRequest`，以 main 与 npm llm-bridge@2.0.1 为底座补通用工具 fix；不沿用旧完整重写或另建逐 agent Chat Completions 转换器。
- 2026-10-10：旧 Chat Completions 的入口插件、forwardChat、官方内部重写/递归进入网关路线被取代；字段和测试来源保留，静默丢弃/降级政策必须实测收敛。
- 2026-10-10：用户确认不再保留独立 Chat Completions 端点计划，字段适配与测试直接成为 llm-bridge 封装的兼容要求；CLIProxy/NewAPI default 继续原协议转发，不恢复旧官方递归重入路线。
- 2026-10-11：用户确认弃用独立协议抽离计划，通用请求/响应、解析、事件/输出外壳与测试统一在 llm-bridge 封装内重构；插件注册与网关生命周期由 monorepo 计划承接，不沿用旧 src/protocols 实现或原语调用路线。
- 2026-10-11：用户要求以 main 分析，不以正在执行的 monorepo 迁移作为协议修复基线；当前会话只更新转换计划。范围确认覆盖 Responses、Chat Completions、Anthropic endpoint route，三来源均由 agent 消费真实 from，经 convertRequest 到自己的目标协议；Gemini 保留为上游方向。
- 2026-10-11：已复现 CodeBuddy instructions-only/strict 丢失及 npm 库的历史/字段/choice/工具重建缺口；Qoder 的局部补丁与 CodeBuddy 复用不保留为公共方案。按五家分别记录标准封装、厂商前后处理和兼容回归，具体实现仍等待 B0–B4。
- 2026-10-11：用户确认本计划在 monorepo 重构基础上继续。main 是协议分析与回归语义基线，已验收 monorepo 提交是源码实施基线；迁移完成后再进行转换改造，不回退 main 目录、不重复搬迁，不与当前迁移会话交叉改源码。
- 2026-10-11：用户确认 AGY 不接入 llm-bridge，在 @agent-proxy/agy 内独立封装 CloudCodeAssist 请求与响应转换；llm-bridge 仅封装规范协议。此决策覆盖此前“所有 agent 必须 convertRequest”及“AGY 经 Gemini bridge”的要求；其他四类 agent 的统一转换要求不变，规范 Gemini 桥接仍用于 Zen。包依赖与源码调整在 monorepo 验收后按 B3 实施，当前只更新文档。
- 2026-10-11：用户要求协议标识明确为 `chat-completions`，不使用含混短名；名称使用 Chat Completions，HTTP `/chat/completions` 和响应 `chat.completion`/`chat.completion.chunk` 保留标准形状。源码命名统一随转换计划实施，不要求当前 monorepo 迁移会话改变协议逻辑。
- 2026-10-11：用户再次确认个性化特性不能封装到 bridge 内部。ZCode server tool/vision/多腿与 Qoder 排队/等待/重发全部归插件，禁止通过 hooks/options/回调变相注入 bridge；标准工具数据转换与工具执行分别验收，公共取消能力不承担实际请求调度。
- 2026-10-11（实施）：实施基线为已验收 monorepo 提交 fafd357（worktree llm-bridge-conversion）。公开协议名落为 chat-completions/responses/anthropic/gemini；anthropic 目标 max_tokens 缺省 1024 占位并在 notes 记录，effort → thinking 预算归插件；Responses 私有 history 项（reasoning/服务器调用）由 zcode/agy 插件切段处理，桥接只转换标准段；取消/超时终态经 shell.terminal + drain 保序输出（Qoder 超时 504 合同保持）。
- 2026-10-11（验收评审修复）：gemini STOP/MAX_TOKENS 结束原因映射补齐（阻断级：正常完成被误判 other 而 502）；responses 目标调用历史统一映射名（L4 三处一致，chat/anthropic 源在源规范化阶段改写）；chat 工具 id/name/arguments 分帧改为待定调用缓存 + 按序补发（不再静默丢弃）；anthropic 源 thinking/signature/cache_control 跨协议丢弃补显式 notes；ZCode 非 Responses 源 token 上限推导修复（max_tokens 参与预算压缩与 anthropic thinking 校验）；AGY anthropic 源 system 并入 systemInstruction、非流式客户端改为内部恒 SSE + 渲染层聚合。逐家三协议 fake-fetch 矩阵补齐（test/agent-protocol-matrix.test.ts、test/agy-protocol.test.ts、zen Messages 入口端到端）。
- 2026-10-12：用户验收通过并要求归档（不提交）。验收复核确认三项遗留已修正——测试调试语句清除、llm-bridge 包描述更新、计划与历史记录测试数字对齐实际（1038 项 / 30 tracked + 12 untracked / +1656 / -1461）；`bun run check` 全绿 1038 pass / 0 fail（77 文件）。本计划移至 `completed/`，并同步更新 monorepo、upstream-only、model-config、requirements 与 monorepo-migration 的交叉引用。
- 2026-10-14（归档后补记，gemini 客户端协议扩展）：用户确认 gemini 升级为第四种客户端入口协议，与 Responses / Chat Completions / Anthropic 对等：plugin-api 的 ClientProtocol 增加 "gemini"，identifyClientEndpoint 识别 {mount}/models/{model}:generateContent | :streamGenerateContent（model 与流式标志由 URL 路径携带，body 不含这两者），llm-bridge 补齐 gemini 源规范化（contents/parts/functionCall/functionResponse 配对、systemInstruction、functionDeclarations、toolConfig、generationConfig）与 Gemini 客户端输出渲染器（SSE data 帧与完整 GenerateContentResponse JSON、Google API 规范错误形状），四类标准桥接 agent 与 AGY 独立转换各自接入 gemini 来源。原「Gemini 仅作为上游目标」「不新增 Gemini 客户端路由」的范围限制由本决策取代；AGY 零桥接边界不变（自产 renderGeminiClient）。
- 2026-10-14（归档后补记，协议类型单一来源）：用户确认协议类型不再多处同构定义——llm-bridge 的 BridgeProtocol / ClientBridgeProtocol / EngineTarget 别名与 zen 的 OpencodeZenModelProtocol 字面量联合全部移除，全仓统一直接引用 plugin-api 的 ClientProtocol；zen 的 CLIENT_BRIDGE_PROTOCOL 映射表与 MODEL_PROTOCOL_MIRROR 镜像断言随之删除（类型同一后无需断言）。llm-bridge 因此对 @agent-proxy/plugin-api 建立 workspace 类型依赖（边界静态检查更新为「仅允许该契约包」）。
- 2026-10-14（归档后补记）：底座迁移决策。经 npm registry 与 GitHub 实测审计，npm llm-bridge 最后发布 2026-04-17（停更半年），且本计划实施后的封装对库的实际使用已收缩为可替换薄面（events.ts/output.ts 自有，request.ts 以重建为主）。用户确认底座迁往 `ai` + `@ai-sdk/*`（引擎层）+ fork aio-proxy `transform/`（薄转换层），本计划的公开契约、插件边界、AGY 独立与全部测试矩阵由新计划 [llm-bridge-aisdk-rebase.md](./llm-bridge-aisdk-rebase.md) 继承并转为底座无关回归合同；「外部库为真实底座」验收口径废止。本条不改变已验收实施内容的历史记录。
