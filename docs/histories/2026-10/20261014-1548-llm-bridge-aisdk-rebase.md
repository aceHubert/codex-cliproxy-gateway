# [2026-10-14 15:48] | Task: llm-bridge 底座迁移至 AI SDK 引擎

### 🤖 Execution Context
* **Agent ID**: zcode
* **Base Model**: zai-api/GLM-5.3
* **Runtime**: ZCode CLI
* **Git User**: hubert
* **Branch**: codex/llm-bridge-conversion（worktree ~/.codex/worktrees/llm-bridge-conversion/codex-cliproxy）

### 📥 User Query
> npm llm-bridge 已停更半年（最后发布 2026-04-17），基于哪个库修改合适？确认采用「ai + @ai-sdk/* 引擎 + fork aio-proxy 薄转换层」架构后开始实施。

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、packages/{zcode,codebuddy,qoder,opencode-zen}、test/、scripts/pack-check.ts

**Key Actions:**
- **[引擎适配层]**: 新增 `packages/llm-bridge/src/engine.ts`——包内唯一直接接触 `@ai-sdk/*` 的模块；通过离线 stub fetch 调用各厂商 provider 的 doGenerate，从 `result.request.body` 捕获引擎拼装的目标协议请求体，全程零网络 I/O。
- **[请求转换重写]**: `request.ts` 从「npm llm-bridge Universal 三明治封装」改为「源规范化 → V4 prompt → 引擎捕获 → 目标后合并」；三来源（responses/chat-completions/anthropic）的校验、notes、工具身份注册表、同协议直通合同全部保留。
- **[convertRequest 异步化]**: 引擎调用使 `convertRequest` 及四家 agent 的翻译函数（translateZcode/Codebuddy/QoderRequest、convertOpencodeZenRequest）变为 async，调用点与测试同步适配。
- **[依赖替换]**: 移除 npm `llm-bridge@2.0.1` 与三个纯类型死重（`openai` 22MB、`@anthropic-ai/sdk` 13MB、`@google/generative-ai`）；新增锁定精确版本的 `ai@7.0.140`、`@ai-sdk/{openai,anthropic,google,provider}`（`@types/json-schema` 仅 devDependencies）。
- **[边界检查更新]**: `test/llm-bridge-boundaries.test.ts` 改为「任何包不依赖 npm llm-bridge；只有 llm-bridge 包允许依赖 @ai-sdk/*」。

### 🧠 Design Intent (Why)

调研确认（npm/GitHub 实测）：所有「纯协议转换小包」均已停滞（llm-bridge 半年、token.js 18 个月、@musistudio/llms 8 个月），活跃方案全部收敛到「AI SDK 协议引擎 + 薄转换层」架构。原封装对 npm 库的实际使用已收缩为可替换薄面（流式/输出侧早已自有，request.ts 以重建为主，L1–L6 缺口永远等不到上游修复）。新架构把最易过期的「出站请求体拼装」交给每日发版的 Vercel AI SDK，协议保鲜问题被结构性解决。

实施中发现并处理的关键引擎行为：
1. **模型名策略污染**：`@ai-sdk/openai` 按模型名正则（gpt-5*/o*）自动启用 OpenAI 专属策略（system→developer、剥 temperature、max_tokens→max_completion_tokens），对内部模型名（如 gpt-5.6-luna）误触发。解法：engine 层传盐化 modelId（`__agent_proxy__` 前缀）使全部探测正则失效，输出后回填真实模型名。
2. **Gemini URL 下载**：`@ai-sdk/google` 的 provider 设置不接受 supportedUrls，URL 文件会被下载，违反离线边界；gemini 目标遇 URL 图片显式能力错误（zen 当前 gemini 方向无图片，零影响）。
3. **内容形状保形与非对称合并**：chat 目标按源消息的数组内容标志还原内容块数组；Responses 源的相邻 assistant 合并保持 main 适配器的非对称语义（工具调用无条件并入相邻轮、文本仅并入带调用的轮）。

R0 探针证明了 `doGenerate + result.request.body` 的离线捕获路线可行（四目标全部捕获且形状与合同吻合），未采用 aio-proxy 代码 fork——引擎直接产出的请求体已满足合同，薄层 fork 的增量价值为零，改为纯引擎路线（计划文档已同步此偏差）。

### 📊 Change Stats
> 数据来自 `git diff`（worktree 未提交工作区，含少量上一轮遗留的 zen 协议同构改名）与新增未跟踪文件。

- **Files changed:** 28（tracked 25 个 + 新增 3 个：engine.ts、active 计划、本历史记录）
- **Insertions:** +1238（tracked +1019，新增 +219）
- **Deletions:** -805

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/engine.ts` | +135 | 新增 |
| `packages/llm-bridge/src/request.ts` | +652 | -512 |
| `packages/llm-bridge/package.json` | +8 | -4 |
| `packages/opencode-zen/src/convert.ts` | +12 | -9 |
| `packages/opencode-zen/src/index.ts` | +17 | -17 |
| `packages/opencode-zen/src/catalog.ts` | +12 | -9 |
| `packages/zcode/src/request.ts` | +7 | -7 |
| `packages/codebuddy/src/request.ts` | +3 | -3 |
| `packages/qoder/src/request.ts` | +3 | -3 |
| `scripts/pack-check.ts` | +4 | -4 |
| `test/llm-bridge-convert.test.ts` | +60 | -60 |
| `test/zcode-request.test.ts` | +56 | -56 |
| `test/codebuddy-request.test.ts` | +39 | -39 |
| `test/opencode-zen-convert.test.ts` | +25 | -25 |
| 其余测试与文档 | +81 | -53 |

### 📁 Files Modified
- `packages/llm-bridge/src/engine.ts`（新增）、`src/request.ts`、`src/index.ts`、`package.json`
- `packages/zcode/src/{request,index}.ts`、`packages/codebuddy/src/{request,index}.ts`、`packages/qoder/src/{request,index}.ts`、`packages/opencode-zen/src/{convert,index}.ts`
- `test/llm-bridge-{convert,boundaries}.test.ts`、`test/{zcode,codebuddy,qoder,opencode-zen}-*.test.ts`、`test/agent-protocol-matrix.test.ts`
- `scripts/pack-check.ts`、`bun.lock`
- `docs/exec-plans/active/llm-bridge-aisdk-rebase.md`（新增）、`docs/exec-plans/completed/llm-bridge-conversion-compatibility.md`（后续指针）

### 🔁 同日追加：gemini 客户端协议全链路与协议类型单一来源

用户同日追加两项决策并继续实施：

1. **gemini 升级为第四种客户端入口协议**：plugin-api `ClientProtocol` 增加 `"gemini"`，`identifyClientEndpoint` 识别 `{mount}/models/{model}:generateContent | :streamGenerateContent`（model 与流式由 URL 路径携带），llm-bridge 新增 gemini 源规范化（contents/parts、functionCall/functionResponse 按 id 或最近同名未应答配对、thought 思考块显式剥离记录、systemInstruction、functionDeclarations、toolConfig、generationConfig）与 `createGeminiClientOutput` 渲染器（增量 parts SSE 帧 + 终态 finishReason/usageMetadata、非流式完整 JSON、Google API 规范错误形状）；zcode/codebuddy/qoder/zen 各自接入 gemini 来源分支（zen 加 forwardGemini 端到端含直通与单跳两路）；AGY 在自身包内独立 normalize 与自产 renderGeminiClient，零桥接边界保持。
2. **协议类型单一来源**：应用户要求移除全部同构重复定义——`BridgeProtocol` / `ClientBridgeProtocol` / `EngineTarget`（llm-bridge）与 `OpencodeZenModelProtocol`（zen）一律改为直接引用 plugin-api 的 `ClientProtocol`；zen 的 CLIENT_BRIDGE_PROTOCOL 映射表与 MODEL_PROTOCOL_MIRROR 镜像断言删除；llm-bridge 对 plugin-api 建立 workspace 类型依赖，boundaries 静态检查相应放宽为「仅允许该契约包」。
3. **顺带修复存量缺陷**：codebuddy `getActiveAccount` 在实例上下文存在但无 `codebuddyAccount` 字段时落到 `host!` 必然崩溃（全量 dist 重建后暴露为 webui `/ui/api/config` 404，波及 44 个测试文件加载），修为缺省回退；`host-services` 的 log 回调参数显式 `PluginLogEvent` 类型；若干测试对象字面量的 excess-property 修正；boundaries 检查的 packages 目录遍历增加目录过滤（`.DS_Store` 防御）。

### 🔁 同日追加：R4 插件请求调用收敛

按计划追加的 R4 执行逻辑（形态对齐 codex 线程讨论结论：全部统一 `convertRequest(from, to, body)` 转换后再做个性化，而不是 if/else）完成四类标准桥接插件的请求调用收敛：

1. **桥接层同协议合同**：直通身份表改用原名注册（`registerIdentity`）——body 不经改名时身份表 key 与实际工具名一致，不生成请求体未使用的映射名；responses/chat/anthropic/gemini 四种来源的原名收集各就位。
2. **zen 收敛为线性三步**：`convertOpencodeZenRequest` 删除同协议浅拷贝分支，统一 `await convertRequest(from, to, input, options?)`；四个入口（forward / forwardResponses / forwardMessages / forwardGemini）的请求组装全部替换为「桥接转换 → `adaptOpencodeZenUpstreamRequest` 查表适配 → fetch」——协议差异收进两张注册表：`ZEN_SAME_PROTOCOL_ADAPTATIONS`（同协议保真补丁：responses 缓存键缺省、anthropic 上限缺省与版本头、gemini URL 端点按客户端流式分流、chat 指纹注入）与 `ZEN_CROSS_PROTOCOL_ADAPTATIONS`（跨协议服务化：真实模型 + 恒定 SSE + 协议头）；chat 指纹注入在两表共用同一适配器；gemini 目标经 `zenConvertModelOptions` 不传 model（其请求体无 model 字段）。主流程不再有任何按协议的 if/else。响应侧原样透传逻辑保留（属响应处理，不在请求收敛范围）。
3. **zcode 收敛**：anthropic 源分支从「调用桥接只取 system、消息与工具手工从原始请求重建」改为完整消费转换结果（messages 经 `anthropicMessagesOf`、tools/choice/stop 取自桥接体），身份同步块覆盖 anthropic；gemini 分支移除对调用方 `body.temperature/top_p` 的就地 mutation（违反「不得修改原始请求」），改为组装 `translated` 时按源回退 generationConfig。
4. **codebuddy/qoder 核对**：两者 to 恒定、调用点本就是「转换 → 顺序后处理」线性形态，前处理（图片提升、reasoning 信封、effort 校验）属服务策略，无丢弃重建路径，零改动通过。
5. **R4 终形修订（用户复核后）**：zcode 主路径重构为「前处理切段（segmentZcodeRequestLegs，私有段就地转换）→ 唯一一次 `convertRequest(to, "anthropic", …)`」，删除 gemini/chat-completions/anthropic 三个逐行重复的 from 字面量分支；translateZcodeRequest / createZcodeClientResponse / forward 的协议参数经用户确认改名为 **to**（路由端点协议，响应方向 anthropic → to 视角；请求方向 to 即桥接源协议位，调用处注释说明）；zen 四个入口方法增加 from 形参（handleHttp 传 context.from），方法体内无协议字面量调用。
6. **R4 终形修订二（用户复核后）**：convertRequest 参数命名按响应方向结论统一为 (to, from, body)——to 为客户端端点协议（响应终点），from 为上游目标协议（响应源头）；codebuddy/qoder/agy 的 translate/forward/响应函数参数同步 from→to，zen 的 convertOpencodeZenRequest / adaptOpencodeZenUpstreamRequest 形参同步；plugin-api 的 RequestContext.from 保留 HTTP 层语义待后续确认。互换中修复两处字符串替换错位（emit 分派与 gemini URL 守卫，曾导致 stream/parallel_tool_calls 丢失与 gemini 守卫失效，全量测试捕获）。
7. **R4 终形修订三（用户定案）**：全仓协议语义彻底统一为「上游 endpoint (from) → 调用方 route (to)」——convertRequest 签名定为 (from, to, body)（from=上游在前）；plugin-api 的 RequestContext.from 字段更名 to（identifyClientEndpoint/dispatchHttp/gateway/五家插件/路由测试全链路同步）；zen 的 convertOpencodeZenRequest/adaptOpencodeZenUpstreamRequest 形参对调为 (from, to)；zcode 主调用点 convertRequest("anthropic", to, …)；测试位置参数全部对调（过程中修正一次双重对调与一次循环变量混名）。
8. **验收收口（依据 Claude 验收结论的五项清单）**：① ConvertRequestResult 增 strippedTools 结构化字段，codebuddy/qoder 改消费结构化值（消除跨包中文文案耦合）；② qoder 非数组 messages 分支改抛 QoderRequestError；③ 两份 README 底座描述与 tech-debt-tracker 条目补齐；④ 代配置线收尾：AgentConfig 索引签名、webui.ts 常量替换（产品残留修复）、zcode-gateway/plugin-routing-fixture 已删字段读取修正、20261014-1720 历史记录失实表述修正。
9. **验收收尾（二轮验收后的最终小项）**：补 strippedTools 桥接直接单测 2 项（跨协议剥离内容断言 + 同协议空数组）；清理 gateway-model-reload fixture 的三个死配置字段与一行 officialBaseUrl 死赋值；plugin-config-ownership 计划补验收修正条目（与 1720 历史记录同口径）；计划状态行与 R3 勾选更新为二轮验收后事实；`@ai-sdk/*` 依赖按用户确认从精确锁定放宽为 `~` 大版本范围（允许 patch/minor，major 锁挡 breaking change）；计划归档至 completed/。
10. **验证**：`bun run check` 真实退出码 0（1119 pass / 0 fail，79 文件）、pack:check 八产物冒烟通过；静态确认插件侧无 `from === to` 自行跳过残留、zcode/zen 转发主流程无协议 if/else 组装分支。check:boundaries 因并行会话在 apps/gateway/src/types.ts 引入的 @agent-proxy/codebuddy 类型导入未放行而失败（非本任务改动，待该会话收尾）。

### ✅ Verification（最终）
- `bun run typecheck` 通过（严格模式，全 workspace）。
- `bun run check`（最终状态）：1119 pass / 0 fail（79 文件；L1–L6、C1/C2 全部失败反例保持通过；gemini 新增 convert 6 项、渲染 3 项、路由 3 项、agent 矩阵 4 项、zen 端到端 2 项；R4 收敛新增合同 4 项；验收收口补 strippedTools 直接单测 2 项）。
- `bun run pack:check`：八个公开产物打包、隔离项目依赖/导出/CLI 冒烟全部通过。
- 未执行真实上游请求（引擎捕获全程离线 stub）。
