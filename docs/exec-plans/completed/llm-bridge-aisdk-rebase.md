# llm-bridge 底座迁移：以 AI SDK 为协议引擎并 fork aio-proxy 薄转换层

状态：已完成并归档（2026-10-14 二轮验收通过：bun run check 真实退出码 0 / 1119 项测试 / pack:check 通过；@ai-sdk/* 按 `~` 大版本范围管理）。工作区改动尚未提交。
创建日期：2026-10-14。
前置计划：[llm-bridge-conversion-compatibility.md](./llm-bridge-conversion-compatibility.md)（2026-10-12 验收归档；本计划继承其公开契约、边界与测试矩阵，只更换转换底座）。
实施基线：worktree `llm-bridge-conversion` 分支 `codex/llm-bridge-conversion` 当前 HEAD；开始实施时记录实际提交。

## 目标

将 `@agent-proxy/llm-bridge` 的转换底座从 npm `llm-bridge@2.0.1`（已停更半年）迁移为「`ai` + `@ai-sdk/*` 协议引擎 + fork aio-proxy 的薄转换层 + 自有解析/渲染层」三层架构：出站请求体拼装交由持续维护的 Vercel AI SDK 承担，客户端协议 ↔ ModelMessage 的薄转换以 MIT 的 aio-proxy `transform/` 模块为起点 fork，自有 `events.ts`/`output.ts`/工具身份表/同协议直通原样保留。公开 API（`convertRequest`、`parseUpstreamEvents`、输出外壳与错误合同）、插件调用面、AGY 独立边界与全部既有测试矩阵不变；同时移除 npm `llm-bridge` 依赖及 `openai`/`@anthropic-ai/sdk`/`@google/generative-ai` 三个纯类型死重依赖。

## 范围

- 包含：`packages/llm-bridge` 内的底座替换——引擎接入（`ai`、`@ai-sdk/openai`、`@ai-sdk/anthropic`、`@ai-sdk/google`、`@ai-sdk/provider`）、aio-proxy `transform/` 模块的 fork 与裁剪、`request.ts` 入站规范化出口从 Universal 改为 ModelMessage、依赖清单调整与版本锁定。
- 包含：引擎规格隔离层（收口 `LanguageModelV2/V3/V4` 等版本差异到一个适配模块）、离线 fetch 拦截器（捕获 `(url, headers, body)`，不发真实网络请求）、fork 代码的 MIT 来源标注与来源 commit 记录。
- 包含：既有 L1–L6、C1/C2 失败反例 fixtures 转为底座无关的回归合同；全量测试矩阵（三来源 × 四目标、流式/JSON/错误/取消、agent fake-fetch）在迁移后保持通过或差异有成文的合同解释。
- 包含：边界静态检查更新——只有 `packages/llm-bridge` 依赖 `@ai-sdk/*`；四类标准桥接 agent 与 AGY 的依赖面不变。
- 包含（追加 R4）：四类标准桥接插件统一请求调用与结果消费，删除重复标准转换和插件自行跳过同协议的分支，保留既有厂商政策。
- 不包含：AGY——其请求/响应转换继续在 `@agent-proxy/agy` 内独立实现，对桥接与任何外部转换库的调用保持为零，不因本计划引入 `@ai-sdk` 依赖。
- 不包含：网关路由、端点识别、插件政策（ZCode server tool/多腿、Qoder 排队、Zen 宽松策略等）的任何改动；`convertRequest` 签名与返回结构不变，插件无需感知底座变化。
- 不包含：vendor npm `llm-bridge@2.0.1` 源码的备选路线（已评估并拒绝，见决策记录）；真实上游验证、发布。
- 不包含：回程上游 SSE 解析切换为 `doStream` 委托——本期保留自有 `events.ts`，是否委托作为后续独立决策。

## 背景

- 前置计划以 npm `llm-bridge@2.0.1` 为底座完成了 B0–B4 封装并通过验收（1038 项测试全绿）。验收后的封装现实是：`events.ts`（四协议严格流解析）与 `output.ts`（客户端协议渲染）已完全自有、零库依赖；`request.ts` 仅调用库 7 个转换函数，且多数结果被立即重建（Responses 源/目标的 messages、input 序列整体重建，chat/anthropic/gemini 腿叠加输出消毒补丁）。库的剩余价值已收缩为「中间对象壳」。
- 2026-10-14 维护状态审计（npm registry 与 GitHub 实测，非二手调研）：`llm-bridge` 最后发布 2026-04-17（半年前，仓库最后代码提交同期）；`token.js` 2025-04-21、`@musistudio/llms` 2026-01-07、`@amux.ai/llm-bridge` 2026-02-04、`@portkey-ai/gateway` 2026-01-12 均停滞。外部 AI 调研中的 `@lobehub/model-runtime` 在 npm 不存在、`headroom-ai` 实为上下文压缩工具，均为错误信息，已剔除。
- 活跃候选核查：`@hebo-ai/gateway` 高频发版但许可证 FSL-1.1-ALv2（Fair Source，非 OSI），不能 vendor 进 MIT 包；`claude-code-router` 活跃（37.6k stars）但核心已平台化，转换引擎转依赖 Fastify 网关 `@the-next-ai/ai-gateway`，纯函数抽取成本高；`aio-proxy`（MIT、Bun 原生、持续发版）不维护 N×N 矩阵，以 Vercel AI SDK 的 `ModelMessage` 为中间层，`packages/core/src/transform/` 按协议配对组织薄转换模块；`ai` + `@ai-sdk/*` 近乎每日发版（Apache-2.0）。
- 依赖现状：`packages/llm-bridge/package.json` 挂有 `openai`（约 22MB unpacked）、`@anthropic-ai/sdk`（约 13MB）、`@google/generative-ai`，三者仅被 npm 库的 `index.d.ts` 类型引用，封装源码零 import，属发布面死重；替换为 `@ai-sdk/*` 全家约 16MB 且真实运行时使用。
- 相关代码路径：`packages/llm-bridge/src/{request,events,output,types,errors,sse,index}.ts`；`test/llm-bridge-{convert,events,response,boundaries}.test.ts`；aio-proxy 源 `github.com/aio-proxy/aio-proxy` 的 `packages/core/src/transform/{anthropic-messages,openai-completions,openai-responses,gemini-generate-content,gemini-interactions}/`。

## 三层架构

```
入站:  客户端协议体 → [fork 的 to-model 薄层] → ModelMessage → [@ai-sdk provider + 离线 fetch 拦截] → 厂商请求体 → 插件自有传输
回程:  上游 SSE/JSON → [自有 events.ts 解析] → 统一事件 → [自有 output.ts] → 客户端协议 SSE/JSON
```

1. **引擎层（依赖，不 fork）**：`ai` + `@ai-sdk/{openai,anthropic,google}` + `@ai-sdk/provider`（类型）。职责限于把 ModelMessage 拼装为各厂商出站请求体——thinking signature、encrypted reasoning、thinkingConfig 等易过期字段的演进由 Vercel 发版兜底。桥接包通过注入离线 stub `fetch` 调用引擎的请求拼装路径：stub 捕获 `(url, headers, body)` 后返回合成响应，不执行任何网络 I/O；真实发送仍由插件完成。「封装不发上游请求」的边界不变，本计划将其细化为「不执行网络 I/O」的可检查口径。
2. **薄转换层（fork，不依赖）**：从 aio-proxy `transform/` 拷入各协议配对的 `to-model.ts`（客户端协议 → ModelMessage）、`from-model*.ts`、`input-content.ts`、`compat.ts`、`tools.ts` 及配套测试，裁掉 `@aio-proxy/logger`、`@aio-proxy/shared` 等 workspace 耦合只留纯转换逻辑，保留 MIT 来源标注并记录 fork 时的源 commit。其 `gemini-interactions` 实现一并纳入，作为 Zen 的 Gemini 方向前瞻储备。
3. **自有层（保留现有资产）**：`events.ts` 四协议严格解析、`output.ts` 客户端协议渲染、工具身份注册表（custom/namespace 安全名映射）、同协议直通（`from === to` 结构化克隆直通，不经引擎）、入站校验与 notes 合同全部保留；`request.ts` 的三来源规范化逻辑保留，仅把中间类型从库的 Universal 改写为 ModelMessage，三明治式输出消毒补丁随引擎替换一并收敛进 fork 层。

## 契约承接与变更点

- 不变：`convertRequest(from, to, body, options?)` 签名与 `ConvertRequestResult`（body/tools 身份表/notes）结构；`parseUpstreamEvents` 与输出外壳 API；协议标识 `chat-completions`/`responses`/`anthropic`/`gemini`；同协议直通与单跳转换合同；AGY 独立、插件持有传输/工具执行/排队/多腿的全部边界；default 零转换。
- 不变（转为底座无关回归）：L1–L6、C1/C2 从「库失败反例 + 封装修复」改记为「封装行为合同」——迁移后同样的 fixtures 必须继续通过，证明引擎替换不回退已修复语义。
- 变更：「外部库为真实底座，不能名义调用库后丢弃结果」的验收口径废止，由「引擎承担出站拼装、fork 层承担薄转换、其余自有」的分层验收取代；版本升级重跑 fixtures 的要求改为 `@ai-sdk/*` 按 `~` 范围锁定大版本（防 breaking change，允许补丁/小版本自动跟进），安装或升级后重跑全量矩阵。
- 变更：桥接包允许依赖 `@ai-sdk/*`（原先只允许依赖 npm `llm-bridge`）；静态边界检查相应更新为「只有 `packages/llm-bridge` 依赖 `@ai-sdk/*`，agent 包与 AGY 不新增该依赖」。

## 插件请求调用收敛的执行逻辑（追加 R4）

1. **确定协议方向**：`from` 使用网关识别的真实客户端协议；`to` 由已选模型的上游协议确定。ZCode 的目标固定为 Anthropic，CodeBuddy/WorkBuddy 与 Qoder 的标准目标固定为 Chat Completions，Zen 从模型目录读取目标协议；不按客户端 `from` 重新选择 `to`。
2. **保留必要前处理**：只在桥接前提取或剥离无法交给标准转换器处理的厂商私有内容，并保存后续所需上下文；不先手写完整标准目标体。工具执行、多腿与排队继续由插件负责；每条需要转换的执行腿使用自己的真实源体和目标协议。
3. **统一调用桥接**：插件统一执行 `await convertRequest(from, to, prepared, options)`，不自行判断同协议并返回。桥接层内部在 `from === to` 时保留请求字段、构造所需工具身份并按 options 回填模型，不进入 AI SDK 引擎；跨协议才执行源规范化和目标拼装。同协议工具身份应与实际未改名的工具一致，不生成请求体未使用的映射名。
4. **基于结果做厂商后处理**：以返回的 `body` 作为标准请求体，继续传递 `tools` 给响应层，并消费需要记录或告知模型的 `notes`。再添加服务字段、私有信封、指纹及模型限制；不能调用桥接后丢弃结果，转而从原始请求重复重建标准消息、工具与参数。前处理保存的私有上下文可在此恢复；所有适配不得修改调用方的原始请求。
5. **实施与验证**：先核对桥接层同协议 body/tools/model/notes 合同，再分别收敛 ZCode、CodeBuddy/WorkBuddy、Qoder、Zen 的请求路径，最后汇总验证。覆盖各插件同协议和跨协议请求、工具完整轮、厂商限制、模型替换、原始请求不变，以及同协议不进入引擎；复用 agent fake-fetch 与协议矩阵补充结果断言，运行 `bun run check`。AGY 不接入桥接，default 保持零转换。

统一调用顺序示意（厂商适配仍在各插件内部实现）：

```ts
// to 已由选定模型确定；前处理只整理必要的厂商私有内容。
const prepared = prepareVendorInput(body);
const converted = await convertRequest(from, to, prepared, options);
const upstreamBody = adaptVendorRequest(converted.body);
// converted.tools 继续交给响应层；converted.notes 按既有服务合同消费。
```

## 风险与缓解

- 风险：AI SDK 大版本节奏快（当前 `ai` 7.x，`LanguageModelV2/V3/V4` 并存），规格漂移可能破坏引擎调用。缓解：依赖按 `~` 范围锁定大版本（patch/minor 自动跟进，breaking change 被 major 挡住）；所有规格类型收口到单一适配模块（参照 aio-proxy `ai-sdk-bridge` 的多版本兼容做法）；升级作为显式任务并全量重跑矩阵。
- 风险：离线 fetch 拦截是务实 hack，引擎内部调用路径变化可能导致捕获失败或浪费的合成响应解析。缓解：拦截器独立成模块并以「捕获体 == 期望厂商体」的 golden 断言覆盖；R0 评估引擎是否暴露更底层的请求拼装入口，有则优先。
- 风险：ModelMessage 中间层对部分语义的表达能力不足（如 Anthropic `cache_control`、跨协议 thinking signature 回传）。缓解：沿用前置计划的失败反例方法论——R0 先用现有矩阵 fixtures 对 ModelMessage 往返做能力审计，缺口记入「fork 层补齐 / 自有层绕行 / 明确拒绝」清单，不静默丢失。
- 风险：aio-proxy 单人维护、项目仅三个月历史。缓解：只 fork 不依赖，fork 后即为本仓库资产；记录来源 commit 便于对照上游后续修复。
- 风险：`~` 范围内的小版本升级仍可能调整请求体形状（非 breaking 但行为漂移）。缓解：升级后重跑全量 fixtures，差异按合同归因。
- 风险：迁移引发既有 1038 项测试回归。缓解：全量矩阵在替换前后各跑一次，差异逐项归因（引擎语义差异 / fork 层裁剪 / 预期内的合同变化），不接受无解释的 fixture 修改。

## 里程碑

1. **R0 引擎能力审计与契约固化**：锁定 `@ai-sdk/*` 精确版本（后放宽为 `~` 大版本范围，见决策记录）；用现有 L1–L6 与三来源 × 四目标 fixtures 审计 ModelMessage 往返能力，产出缺口清单；记录 aio-proxy fork 来源 commit 与裁剪清单；确定引擎规格适配模块与离线拦截器的接口；确认回程保留自有 `events.ts`。门槛：每项语义有保留/补齐/拒绝的成文合同。
2. **R1 fork 接入与底座替换**：拷入并裁剪 transform 模块；实现引擎适配与拦截器；`request.ts` 出口改写为 ModelMessage；删除 npm `llm-bridge` 与三个 SDK 死重依赖。门槛：`convertRequest` 公开行为对现有调用方不变，包内无 agent 类型/依赖。
3. **R2 回归与边界验证**：全量矩阵 + agent fake-fetch 通过；边界静态检查更新并通过；依赖树确认 agent/AGY 无 `@ai-sdk/*`。门槛：`bun run check` 全绿，差异均有合同解释。
4. **R3 收尾**：README 依赖与架构说明、tech-debt 更新、历史记录。门槛：文档与实际状态一致，不发布；本计划归档延后至追加 R4 验收完成。
5. **R4 插件请求调用收敛（追加）**：按上方执行逻辑收敛四类标准桥接插件，模型确定 `to`，统一调用 `convertRequest(from, to, …)` 并消费结果，再做厂商适配；同协议跳过转换由桥接层负责。门槛：对应 agent fake-fetch 与协议矩阵通过，`bun run check` 全绿，更新文档与历史记录后验收并归档本计划。

## 验证方式

- 命令：`bun run check`；分包测试沿用 60 秒上限（`perl -e 'alarm 60; exec @ARGV' bun test <文件>`）。
- 手工检查：`packages/llm-bridge` 是唯一 `@ai-sdk/*` 依赖方；拦截器无网络 I/O（stub fetch 断言）；fork 文件带 MIT 标注。
- 观测检查：迁移前后全量 fixtures 输出 diff 归零或仅有成文合同允许的差异；L1–L6、C1/C2 反例全部保持通过。
- 不使用真实凭据或真实上游验收。

## 进度记录

- [x] 2026-10-14 底座调研与决策：候选库维护状态审计（npm/GitHub 实测）、三层架构确定、备选路线排除（见决策记录）。
- [x] R0 引擎能力审计与契约固化（探针验证 doGenerate + result.request.body 离线捕获四目标可行且形状与合同吻合；发现并记录引擎模型名策略与 Gemini URL 下载两个边界行为）。
- [x] R1 引擎接入与底座替换（engine.ts 离线捕获 + 盐化 modelId；request.ts 三来源规范化 → V4 prompt → 引擎捕获 → 目标后合并；convertRequest 异步化并适配四家 agent；删除 npm llm-bridge 与三个 SDK 死重）。
- [x] R2 回归与边界验证（bun run check 1095 pass / 0 fail；pack:check 八产物冒烟通过；L1–L6、C1/C2 失败反例全部保持；边界静态检查更新为 @ai-sdk/* 版本）。
- [x] R3 收尾（README×2、tech-debt 条目与历史记录三件交付物经二轮验收确认；归档延后条件「R4 验收完成」已满足，本计划随验收收口一并归档）。
- [x] 2026-10-14（追加，gemini 客户端协议全链路）：gemini 成为第四种客户端入口协议——llm-bridge 源规范化 + createGeminiClientOutput 渲染器 + Google 错误形状；plugin-api ClientProtocol 扩展与 URL 路径识别（pathModel/pathStream）；网关模型提取接入；zcode/codebuddy/qoder/zen 各加 gemini 分支；AGY 独立 normalize 与自产 renderGeminiClient（零桥接）。测试矩阵新增 convert 6 项、渲染 3 项、路由 3 项、agent 4 项与 zen 端到端 2 项；bun run check 1109 项全绿、pack:check 通过。
- [x] 2026-10-14（追加，协议类型单一来源）：BridgeProtocol/ClientBridgeProtocol/EngineTarget/OpencodeZenModelProtocol 重复定义全部移除，统一引用 plugin-api 的 ClientProtocol；zen 映射表与镜像断言删除；boundaries 检查允许 llm-bridge 依赖 plugin-api 契约包（仅类型）。
- [x] 2026-10-14（追加，存量缺陷修复）：codebuddy getActiveAccount 在实例上下文存在但无 codebuddyAccount 字段时落到 host! 必然崩溃（webui /ui/api/config 404 的根因，dist 重建暴露的存量防御缺失），修为缺省回退；host-services 的 PluginLogEvent 参数显式类型化；测试文件中直接传 ConfigView 的对象字面量 excess-property 修正。
- [x] R4 插件请求调用收敛（2026-10-14，形态对齐 codex 讨论结论）：插件请求路径统一为「桥接转换 → 查表厂商适配 → fetch」线性三步，不按协议写 if/else。具体：桥接层同协议直通身份表改为原名注册（key 与 body 实际工具名一致，不生成未使用映射名）；zen 的 convert 层删除同协议浅拷贝，四个入口（forward/forwardResponses/forwardMessages/forwardGemini）的请求组装全部替换为 `convertOpencodeZenRequest(from, protocol, input, zenConvertModelOptions(...))` + `adaptOpencodeZenUpstreamRequest(...)`——协议差异收进按「同协议保真补丁 / 跨协议服务化改写」两张注册表（chat 指纹注入共用一个适配器；responses 缓存键、anthropic 上限缺省与版本头、gemini URL 端点分流各归其位），gemini 目标不传 options.model（其请求体无 model 字段）；zcode anthropic 分支改为消费转换结果（消息/工具/choice/stop 全取自桥接体，删手工重建），gemini 分支移除对调用方请求的 mutation；codebuddy/qoder 核对通过（to 恒定、调用点本就线性，前处理为服务策略）。新增 R4 合同测试 4 项（同协议原名身份、原始请求不变、gemini 直通无 model 回填、zcode anthropic 消费结果）；bun run check 1113 项全绿、pack:check 通过、插件侧无残留同协议跳过与协议 if/else 组装分支。
- [x] 2026-10-14（R4 终形修订，用户复核）：zcode 请求主路径重构为「前处理切段 → 唯一一次 convertRequest(to, "anthropic", …)」——segmentZcodeRequestLegs 前处理函数按私有项切段（私有段就地转换、标准段交给桥接），gemini/chat-completions/anthropic 三个逐行重复的 from 字面量分支全部删除；translateZcodeRequest / createZcodeClientResponse / forward 的协议参数按用户确认改名为 to（路由端点协议，响应方向 anthropic → to 的视角命名；请求方向 to 即桥接 convertRequest(from, to) 的源协议位，调用处有注释说明）。zen 四个入口方法增加 from 形参并由 handleHttp 传 context.from，方法体内不再出现协议字面量调用。bun run test 1113 项全绿；check:boundaries 因并行会话在 apps/gateway/src/types.ts 引入的 @agent-proxy/codebuddy 类型导入未放行而失败（非本计划改动，待该会话收尾）。
- [x] 2026-10-14（R4 终形修订二，用户复核）：convertRequest 参数命名统一为响应方向锚点——签名为 convertRequest(to, from, body)：to 为客户端端点协议（响应的终点、请求的源），from 为上游目标协议（响应的源头、桥接拼装的目标），与 translateZcodeRequest 的 to 命名结论一致。codebuddy/qoder/agy 的 translate/forward/响应函数参数同步 from→to；zen 的 convertOpencodeZenRequest/adaptOpencodeZenUpstreamRequest 形参同步（上游协议在方法体内以 protocol 变量表达）；zcode 主调用点 convertRequest(to, "anthropic", …) 语义自然成立。plugin-api 的 RequestContext.from（网关 HTTP 入口字段）保留 HTTP 层语义，是否统一待后续确认。互换过程中修复两处 replace 错位（emit 分派与 gemini URL 守卫）；bun run test 1115 项全绿。
- [x] 2026-10-14（R4 终形修订三，用户定案）：全仓协议语义彻底统一为「上游 endpoint (from) → 调用方 route (to)」——convertRequest 签名定为 convertRequest(from, to, body)（from 为上游 endpoint 协议在前，to 为调用方 route 协议在后；请求数据流 to → from）；plugin-api 的 RequestContext.from 字段更名为 to（identifyClientEndpoint 返回 { to } 并随 dispatchHttp 透传），gateway/gateway-composition/五家插件/路由测试全链路同步；zen 的 convertOpencodeZenRequest/adaptOpencodeZenUpstreamRequest 形参顺序对调为 (from, to)（renderOpencodeZenClientOutput(from, to) 天然对齐），zcode 主调用点为 convertRequest("anthropic", to, …)；translate 系列函数的客户端协议参数（to）与各自固定上游（zcode=anthropic、codebuddy/qoder=chat-completions）不变。测试位置参数全部对调；bun run test 1115/1116（唯一失败为并行会话在 apps/gateway/types 的配置收敛半成品）。
- [x] 2026-10-14（验收收口，依据 Claude 验收结论）：① ConvertRequestResult 新增 strippedTools 结构化字段，codebuddy/qoder 不再解析 notes 中文文案前缀反解被剥离工具；② qoder 非数组 messages 分支由 unshift 隐性 TypeError 改为 QoderRequestError 可读错误；③ packages/llm-bridge/README 与根 README 的底座描述更新（AI SDK 引擎 + ClientProtocol 单一来源）；④ tech-debt-tracker 补 @ai-sdk 版本锁定条目；⑤ 代配置线收尾：AgentConfig 补任意字段扩展索引签名（其计划承诺）、webui.ts 改用 MOUNT_PATH/OFFICIAL_BASE_URL 常量（产品残留）、zcode-gateway/plugin-routing-fixture 对已删字段的读取修正、20261014-1720 历史记录失实的「check 全绿」表述修正。bun run check 真实退出码 0（1117 项全绿）、pack:check 通过。

## 决策记录

- 2026-10-14：底座从 npm `llm-bridge@2.0.1` 迁往 `ai` + `@ai-sdk/*`，以 fork aio-proxy `transform/` 模块为薄层起点。依据：库停更半年且缺口（L1–L6）永远等不到上游修复；封装对库的实际使用已收缩为可替换的薄面（流式与输出侧早已自有）；替换同时消除三个纯类型 SDK 死重。此决策废止前置计划「外部库为真实底座」的验收口径，公开契约与插件边界不变。
- 2026-10-14：排除备选路线并记录依据——`@hebo-ai/gateway`（FSL-1.1-ALv2，不能 vendor 进 MIT 包，仅可作协议细节参考）；`claude-code-router`/`@the-next-ai/ai-gateway`（平台与 Fastify 耦合，纯函数抽取成本高）；vendor `llm-bridge@2.0.1` 源码（技术上最省事，但协议知识冻结于 2026-04，fork 之日起全部协议演进自付，仅在 AI SDK 路线被证伪时作为退路）；`token.js`、`@musistudio/llms`、`@amux.ai/llm-bridge`、`@portkey-ai/gateway`（停滞 ≥ 8 个月）。外部 AI 调研中的 `@lobehub/model-runtime`（npm 不存在）与 `headroom-ai`（上下文压缩工具）为错误信息，不作为候选。
- 2026-10-14：回程解析本期保留自有 `events.ts`（严格、可控、已验证），不切换 `doStream` 委托；请求侧三明治是当前全部痛点所在，一次只换一个半场。若后续上游流式新字段跟进成本升高，再评估委托 `@ai-sdk` 解析。
- 2026-10-14：aio-proxy 只 fork 不依赖——其单人维护/小体量不构成本仓库风险；fork 时记录来源 commit，MIT 标注随文件保留。
- 2026-10-14（实施偏差）：R1 未 fork aio-proxy transform 模块。R0 探针证明 @ai-sdk/* 引擎直接产出的请求体已满足既有合同（chat 目标逐字段吻合，anthropic/responses 仅需小幅后合并），薄转换层的增量价值为零，改为纯引擎路线。三层架构中「薄转换层」由 request.ts 的源规范化承担。
- 2026-10-14（实施发现）：@ai-sdk/openai 按模型名正则自动启用 OpenAI 专属策略（system→developer、剥 temperature、max_tokens→max_completion_tokens），内部模型名会误触发；engine 层以 `__agent_proxy__` 前缀盐化 modelId 使探测失效，输出后回填真实模型名。@ai-sdk/google 不接受 supportedUrls 且会下载 URL 文件，gemini 目标遇 URL 图片显式能力错误（zen 当前 gemini 方向无图片，零影响）。convertRequest 公开签名因引擎调用变为 async，属破坏性 API 变更，仅影响仓库内四家 agent 调用点，已全部适配。
- 2026-10-14（归档前终调整）：版本策略放宽——`@ai-sdk/*` 从精确锁定改为 `~` 大版本范围（用户确认：只需 major 锁挡住 breaking change，patch/minor 自动跟进即可，无需精确版本）。风险节、tech-debt 条目与 engine.ts 注释已同步为 `~` 口径。
