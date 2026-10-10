# 协议转换抽离：共享原语与事件内核，适配器保留特性

状态：待执行（无转换 hooks；agent 前缀插件与 CLIProxy / NewAPI / 官方 default 路由，M0 金样本先行）
创建日期：2026-10-09

## 目标

把 zcode / codebuddy / qoder / agy / opencode-zen 的重复转换原语和 Responses 事件合成机构抽离到 `src/protocols/`。各适配器保留工具声明决策、历史遍历、上游帧消费（feed）及特性执行，通过显式调用共享函数和 sink 复用机制，不向通用转换器注册特性 hooks。以金样本证明现有请求、响应和错误行为不变；为 [OpenAI Chat Completions 端点计划](openai-chat-completions-endpoint.md)提供纯转换原语、事件内核和单跳方向注册表。通用方向转换器仅组合协议规则，不承诺完整表达各适配器特性。

补充目标（2026-10-10）：仅将各 agent 兼容 adapter 作为内建路由插件，使用 register(prefix, fn) 统一派发；gateway 主函数保留公共入口边界与派发，不再逐家硬编码转换分支。CLIProxy、NewAPI 与官方链路不注册前缀，作为 default 提供；default 内部保留代理前缀判定、线程粘性及传输协商，详见 §6。本次仅补充方案，未启动源码迁移。

## 范围

- 包含：
  - `src/protocols/`（与 chat 计划的入口插件层共居同一目录轴，均与 adapter 轴正交）：
    - `types.ts`：`Protocol` 联合类型、`ConvertedRequest` 结果类型、方向注册表签名；
    - `kernel/`：JSON 守卫（错误标签参数化）、严格 SSE 解析与帧写出、`safeToolName`/`toolIdentity`/`ToolMap`/`CUSTOM_TOOL_PARAMETERS`、usage 映射（chat/anthropic/gemini → Responses 形状）、Responses 事件流合成器（含流式外壳：pull 流、cancel、非流式聚合、502/取消语义）；
    - `convert/`：Chat / Anthropic / Google 的内容块、普通工具声明/结果、消息构造等纯转换函数，以及组合这些函数的三个单跳请求向转换器与 `convertRequest(from, to, body, options)` 分发入口。适配器可以直接调用原语，不强制经过完整转换器。
  - 五个代理逐家切换（每家独立 commit）：codebuddy → qoder → zcode → agy → opencode-zen。
  - M0 金样本固化测试先行；全程以「金样本不变」为验收标准。
  - 删除确实由共享原语和事件内核取代的代码；保留必要的各家遍历分支。原有净删除行数估算作废，M0 按实际可共享边界重新统计，不以删除行数作为验收目标。
  - 内建路由插件试验（P0–P2）：前缀注册、adapter 工厂组合、CLIProxy/官方默认路由与 compaction/Responses WebSocket 兼容逻辑迁移；与协议原语抽离分阶段验证。
- 不包含：
  - chat→各方言的新方向转换器与 Responses SSE→chat 的入口 `encode`——[chat-completions 计划](openai-chat-completions-endpoint.md) M1/M3 基于本内核新增。
  - opencode-zen 的 llm-bridge 流式路径（`handleUniversalStreamRequest`）替换——实测完整，待 chat 计划 M3 产出共享流式转换器覆盖 anthropic/google→chat 后退役（见决策记录）。
  - 新增 Chat 入口协议 encode/decode 与 forwardChat 能力——chat 计划范围；§6 只插件化现有路由，不提前实现新协议支持。
  - 各代理传输层与凭据：qoder envelope/COSY 签名/排队恢复、agy CloudCodeAssist wrapper、codebuddy 头构造、zcode client-signing 与凭据槽位——布局与传输留在 adapter。
  - 配置项与 `schemas/gateway-config.schema.json` 变更（零配置面变化）。
  - 第三方插件下载、动态代码加载、插件市场、独立沙箱或插件配置格式；本轮插件仅为仓库内模块。

## 背景

- 相关文档：
  - [openai-chat-completions-endpoint.md](openai-chat-completions-endpoint.md)：后续消费者；其「转换永远单跳」决策（2026-10-08）是本计划注册表形态的依据，其 M1/M3 将基于本内核实现。
  - `docs/histories/2026-09/20260917-2010-codebuddy-proxy-adapter.md`：llm-bridge 双向转换实测有损被否决、手写严格转换的先例（本计划沿用其结论，不引入 llm-bridge 做请求向）。
  - `docs/histories/2026-10/20261009-0036-opencode-zen-multi-protocol.md`：opencode-zen 多协议 hub 与 llm-bridge 仅限实测完整方向的结论。
  - `src/opencode-zen/convert.ts` 头注：responses→chat 严格手写、其余方向经 llm-bridge 的现分工。
- 相关代码路径与重复面清单（约 3355 行转换面，10 个文件）：
  - 请求向三份同构手写（`src/codebuddy/request.ts:222`、`src/zcode/request.ts:301`、`src/agy/request.ts:270`，仅通道名/输出形状/怪癖不同）：
    - 校验前言（`previous_response_id`/`conversation`/`background`/结构化输出拒绝/`instructions`/`parallel_tool_calls`）：三份逐字级相同；
    - `safeToolName` + `toolIdentity`：三份逐字级相同；
    - `translateTools` 访问器骨架（namespace 展开、custom→`CUSTOM_TOOL_PARAMETERS`、map/dropped 构建）：结构相近，工具声明输出形状与特性分支不同（chat function 包裹 / anthropic 平铺与原生搜索 / gemini 平铺与本地 schema 清洗）；
    - input 迭代状态机（system/developer 收集、`function_call`↔output 配对与 callId 去重校验、reasoning 处理、服务器调用降级旁白、dropped 工具系统提示）：三份同构；
    - `tool_choice` 映射骨架（auto/none/required/named/服务器工具省略）：三份同构。
  - 响应向三份同构合成器（`src/codebuddy/response.ts` 463 行、`src/zcode/response.ts` 626 行、`src/agy/response.ts` 420 行；codebuddy 头注明言「结构对齐 zcode/response.ts」）：
    - `readFrames` 严格 SSE 解析：4 份（上述三家 + `src/qoder/sse.ts` 变体）；
    - Responses 事件流合成机构（blocks 表、`snapshot`/`event`/sequence 递增、`response.created`/`in_progress`、`closeBlocks`、`finish` 三态、abort/cancel、非流式聚合、SSE pull 外壳、onChunk/onComplete/sanitizeError）：三份同构；options 契约（model/tools/stream/signal/abort/onComplete/onChunk/sanitizeError）也是三份重复的接口定义；
    - usage 映射 chat→Responses：2 份（`src/codebuddy/response.ts:102`、`src/agy/response.ts:96`）。
  - 既有跨代理复用先例（证明共享层可行）：qoder 请求向复用 `translateCodebuddyRequest`（`src/qoder/request.ts:25`），响应向复用 `createCodebuddyResponse`（`src/qoder/response.ts:133`），仅叠加自家信封重排与档位白名单。
  - opencode-zen：`convertZenRequest`（`src/opencode-zen/convert.ts:146`）hub 模式，responses→chat 段为宽松策略的自有实现。
- 已知约束：
  - 各家特性在 adapter 内部直接处理：codebuddy 的 deepseek reasoning 信封与空 system；zcode 的 thinking 信封、档位、搜索回放与图片识别；agy 的 thoughtSignature、schema 清洗与档位；qoder 的白名单与信封。需要参与转换顺序的特性由各家遍历/feed 调用共享原语，不能事后从有损转换结果恢复。
  - opencode-zen 与 codebuddy 的 responses→chat 语义不同，保留各自组合与遍历；只有不含专属语义的固定格式差异适合成为共享函数的值参数（差异矩阵见 §2）。
  - 错误类型与文案是行为面：`CodebuddyRequestError`/`ZcodeRequestError`/`AgyRequestError`/`QoderRequestError` 在各家 `index.ts` 的 catch 分支决定 400 映射（含 qoder 对 codebuddy 文案的 CodeBuddy→Qoder 改写链），测试断言具体文案；共享化后对外文案（含通道名）必须逐字保持。
  - zcode 响应侧有多腿续跑：`reader` 在 message_stop 触发网关代跑 analyze_image 时被换到新腿；原生 web_search 则在上游执行。ZCode feed 自持并更换 reader，整个响应使用同一 sink。
  - 测试安全网：`test/{zcode,codebuddy,qoder,agy,opencode-zen}-{request,response,convert,session}*.test.ts` 共 10 个转换相关测试文件，是行为不变的主要自动验收手段（真实上游按既有低频约束使用，不能作为回归主力）。

## 方案

### 1. 目录与依赖方向

```
src/protocols/                     # 与 adapter 轴（src/<adapter>/）正交；chat 计划的入口插件层后续同住
  types.ts                         # Protocol、ConvertedRequest、方向注册表签名
  kernel/
    json.ts                        # record/string/positiveInteger 守卫（错误标签参数化）
    sse.ts                         # readFrames 严格解析 + SSE 帧 writer
    tools.ts                       # safeToolName/toolIdentity/ToolMap/CUSTOM_TOOL_PARAMETERS
    usage.ts                       # chat/anthropic/gemini usage → Responses usage
    responses-events.ts            # Responses 事件流合成器（sink + 流式/非流式响应外壳）
  convert/
    chat.ts                        # Chat 内容、普通工具与消息纯转换原语
    anthropic.ts                   # Anthropic 内容、普通工具与消息纯转换原语
    google.ts                      # Google 内容、普通工具与消息纯转换原语
    responses-to-chat.ts           # 组合原语的通用单跳转换，不含厂商信封
    responses-to-anthropic.ts      # 通用单跳转换，不含 ZCode 搜索与 vision
    responses-to-google.ts         # 通用单跳转换，不含 AGY 签名与 wrapper
    index.ts                       # convertRequest(from, to, body, options) 单跳分发
```

依赖方向单向：adapter → protocols；`src/protocols/` 不 import 任何 adapter；webui/upstream-catalog 依赖树不受影响。chat 计划后续在此目录追加入口插件（`openai-chat/`）与 chat 方向转换器。

### 2. 请求向：纯原语与适配器组合

统一结果类型（各家已各自重复定义同构形状）：

```ts
export interface ConvertedRequest {
  body: Record<string, unknown>;   // 目标方言规范体（不含 adapter wrapper/envelope）
  tools: ToolMap;                  // 混淆名 → 原始身份，响应向反解用
  dropped: string[];               // 被剥离的服务器内置工具
}
```

CodeBuddy / Qoder 与 Zen 的行为差异（由各家组合保留；不把本表全部转成共享转换器开关）：

| 行为差异 | codebuddy / qoder | opencode-zen |
| --- | --- | --- |
| 未知 history 条目 | fail（400，现行为严格报错） | skip（现行为静默丢弃 reasoning 等） |
| 工具输出中的图片 | hoist（提升为紧随的 user 消息） | drop |
| 空 system 注入 | true（上游要求首条 system） | false |
| 纯文本 content 数组 | 保留数组形态 | 折叠为拼接字符串 |
| 工具名处理 | mangle（namespace+safeToolName+映射表） | passthrough（不混淆） |
| reasoning 回放 | CodeBuddy 内部处理 deepseek 信封 | 无 |

共享函数不解码厂商 reasoning 信封、不决定服务器工具能力、不执行外部请求。ZCode / AGY 在自己的历史遍历中解码信封、生成专属块，再显式调用共享消息构造函数。AGY 在构造普通工具声明前清洗 schema；thinking 档位、wrapper/envelope 和图片注入继续由 adapter 编排。

### 2.1 无 hooks 的调用边界

适配器保留外层遍历，直接调用纯函数。不得以转换后补丁、占位工具、特殊文本标记或隐藏回调重新实现 hooks，也不把所有专属分支放入共享转换器的 channel 判断中。

| 阶段 | 共享层职责 | adapter 内部职责 |
| --- | --- | --- |
| 转换前 | 基础类型守卫 | 模型白名单、请求上下文、通道校验与错误类型 |
| 工具声明遍历 | 工具身份、安全命名、普通声明构造 | namespace 遍历、服务器工具映射/剥离、schema 清洗、dropped |
| 历史遍历 | 文本/图片块、参数与消息片段构造 | 角色顺序、消息合并、调用配对、服务器历史摘要/回放、reasoning 信封 |
| tool_choice | 普通工具选择的格式构造 | 按本轮声明校验、服务器选择省略规则 |
| 转换后 | 返回无传输信封的协议体 | vision 注入、档位、system 补齐、wrapper/envelope |
| 上游帧消费 | SSE 解析、usage、受控 sink 操作 | 信封过滤、协议顺序校验、专属块配对、签名、执行与续跑 |

**必须留在遍历中的处理：**

- 服务器工具声明与历史回放关联：ZCode 在工具声明阶段确定本轮搜索是否可用，历史阶段据此生成原生调用/结果对；Qoder 继承 CodeBuddy 的剥离与摘要逻辑。不能先让通用转换器摘要化，再从文本恢复搜索历史。
- reasoning 与后续调用关联：CodeBuddy 维护 pending reasoning 与 assistant 合并，ZCode 还原 thinking 块，AGY 将 thoughtSignature 附着到正确 functionCall。这些操作发生在各家遍历内，不作为最终请求体补丁。
- 工具结果图片与消息位置：CodeBuddy / Qoder 在处理结果时拆出图片，放入紧随的 user 消息；ZCode 保留 Anthropic tool_result 的图片块。共享函数可返回拆分结果，但插入位置由 adapter 决定。
- 调用 ID 去重、调用/结果类型与配对、未知历史处理：由原遍历维护。共享守卫不能新增验证或改变错误出现顺序；严格通道的拒绝行为与 Zen 的跳过行为分别保留。

**排除规则继续分类保存：** 不支持的声明进入去重且有序的 dropped 并产生既有能力提示；服务器工具历史摘要化；普通未知历史按各家既有规则拒绝或跳过；reasoning 按模型/签名规则处理；Qoder 排队、元数据、空信封与内部 DONE 只在信封规整中过滤。不得用统一 skip 规则覆盖这些行为。

**ZCode 图片适配在请求后处理与响应 feed 内分别完成：** 请求后处理采集 base64 图片并注入识别工具；远程 URL 不触发现有兜底，客户端同名工具优先，单图兜底与多图匹配均保持。`vision`、`images` 与网关工具标记保留在 ZCode 自有结果/映射中，公共 ConvertedRequest 只保留普通身份字段；将普通工具映射与网关标记分开时必须同步迁移所有读取点。响应 feed 依据本请求网关标记吸收调用，不能仅凭 analyze_image 名称吸收客户端工具。

适配器调用顺序为：前置校验 → 本地声明与历史遍历（显式调用共享原语）→ 本地后处理 → 传输。请求内状态独立，不修改原始客户端输入，不共享跨请求的可变状态。

`convertRequest(from, to, body, options)` 只分发通用单跳方向，options 限于通道错误标签与已验证的固定格式参数，不接收厂商转换回调。M1 必须单独定义其服务器工具/未知历史支持范围和测试；未注册方向显式报错。该入口不负责选择适配器、不替代各家的完整 translate*Request，也不推定相同协议具有相同服务器能力。

### 3. 响应向：合成器 sink 与协议 feed

`kernel/responses-events.ts` 暴露：

- **sink**（事件合成机构，单份实现）：`ensureMessage`/`appendText`/`appendRefusal`/`ensureReasoning`/`appendReasoningSummary`/`openToolCall`/`appendToolArguments`/`closeBlocks`/`finish`/`snapshot`/`fail`，管理 blocks 表、output_index、sequence_number、`response.created`/`in_progress` 起始事件对与三态收尾；
- **响应外壳**（单份实现）：消费 adapter 提供的事件迭代器，负责 SSE pull 流（highWaterMark 0、cancel→abort→iterator.return 链）、非流式聚合及 502/取消语义。既有 onChunk/onComplete/sanitizeError 属于观测、结果通知与脱敏边界，保留契约，不用来注入协议特性；新增厂商转换 hooks 不在范围内。

feed 保留在各 adapter 内，按上游协议直接调用 sink，自持上游 reader，不注册共享 feed 的扩展处理器：

- **CodeBuddy chat feed**（Qoder 继续复用）：`choices[].delta.{content,reasoning_content,refusal,tool_calls}`、finish_reason、usage、`[DONE]`、错误帧、整包 JSON 回放；直接调用本地 deepseek 信封编码，再通过 sink 保存 reasoning 输出。纯整包 JSON→SSE 重放函数可共享，实际是否进入此路径由 adapter 决定；
- **anthropic feed**（zcode）：`message_start`/`content_block_*`/`message_delta`/`message_stop`，含多腿续跑（feed 自持并更换 reader）与 web_search 折叠、工具名反解映射；
- **gemini feed**（agy）：thought/functionCall parts、usageMetadata、finishReason→`finishDisposition`。

各 adapter 的 `create*Response` 负责创建本地 feed 与共享 sink，将产生的事件迭代器交响应外壳；对外 options 契约与错误类型不变。共享 sink 接受适配器已处理的内容/信封结果，不了解 ZCode、DeepSeek 或 AGY 的专属编码。

### 3.1 本地 feed 必须额外保留的状态与操作

- ZCode feed 自己处理 server_tool_use / 搜索结果块 / delta / stop，保存 tool_use_id 配对与未知块忽略状态；索引冲突、事件顺序和重复结束仍按现有规则校验。sink 提供类型受限的输出项创建、更新与完成操作，至少覆盖 web_search_call，不包含 web_search_prime 名称或 query 归一化规则。
- sink 管理 output_index、sequence_number、快照和事件写出；adapter 不直接修改内部 output/blocks，不自行分配序号。对尚未完成的 reasoning 信封，adapter 在正常/异常收尾前显式提交最终字段，sink 不调用厂商编码回调。
- ZCode 搜索结果缺失时的正常闭合，以及异常时只更新快照不补事件，由本地 feed 在 finish 前显式调用不同 sink 操作。不要把搜索项与普通函数工具项共用一套无条件 close 规则。
- ZCode feed 在输出普通工具事件前依据网关标记吸收 analyze_image，直接执行本地识别编排，再通过 sink 输出既有旁白。调用参数不完整时不能提前执行或泄漏为客户端 function_call。
- 多腿续跑完全留在 ZCode：stop_reason / 上限判断、执行、回填、签名、旧 reader 释放、新腿局部状态重置由原驱动/feed 负责；整个响应复用同一 sink，不因 message_stop 提前 finish。起始事件对与终态均只生成一次，执行和换腿传播同一取消信号。
- Qoder 保留信封解包与 CodeBuddy feed 复用关系：queue / 内部 DONE 过滤、独立 finish、错误信封、工具索引修复继续在本地。非零 choice 的过滤现位于索引修正循环，不得扩大为删掉整个 choice；缺 finish / EOF / 显式错误 / 取消结果由金样本约束。
- Qoder 计费字段与错误标签增补保留现有 augment、回调包装和后置流处理，不新增 decorateSnapshot hook。本阶段不强制消除这层包装；保留字段出现时机、流式/非流式/onComplete 内容及取消时失败终态。以后若共享外壳支持先取得事件对象、由 adapter 显式处理后再序列化，可另行迁移，不能作为本阶段额外重构。

共享响应外壳管理消费与取消机制，各 adapter 管理协议何时结束及收尾前的专属状态。M0 必须固化取消、失败与提前 EOF 的结果，M1 确定显式 sink 操作的边界；不得为了统一外壳顺手改变各家的终态规则。

### 4. 逐家切换顺序与验收锚点

| 顺序 | 家 | 请求向 | 响应向 | 怪癖留存 | 金样本锚点 |
| --- | --- | --- | --- | --- | --- |
| 1 | codebuddy | 保留严格遍历，替换纯内容/工具构造原语 | 保留 Chat feed，替换 sink / 响应外壳 | deepseek 信封、空 system、图片提升与排除 | `test/codebuddy-{request,response}.test.ts` |
| 2 | qoder | 继续复用 CodeBuddy；校验与信封保留 | 继续复用 CodeBuddy；解包与计费包装保留 | 档位白名单、envelope、排队恢复与取消终态 | `test/qoder-*.test.ts` |
| 3 | zcode | 保留声明/历史遍历，调用 Anthropic 原语 | 保留 Anthropic feed 与续跑，替换 sink / 外壳 | thinking、web_search、analyze_image | `test/zcode-{request,response,vision,gateway}.test.ts` |
| 4 | agy | 保留 schema 清洗/签名遍历，调用 Google 原语 | 保留 Gemini feed，替换 sink / 外壳 | agn1 签名、THINKING_LEVELS、wrapper | `test/agy-{request,response}.test.ts` |
| 5 | opencode-zen | 保留宽松遍历，仅复用语义相同原语；协议类型收编 | 不动（llm-bridge 与本地聚合器保留） | hub 组合、llm-bridge 分工 | `test/opencode-zen-convert.test.ts` |

### 4.1 各执行 agent 的额外工作与交付边界

此处是后续实现任务的分工要求，本次文档更新不启动源码实现。每家负责人除替换重复原语外，必须完成下列检查与对应金样本；不能将特性处理一律移动到转换前后。

**共享内核负责人**（先于各家迁移）：

- 划分纯原语、通用方向组合、adapter 自有遍历三层；共享层不引用 adapter、不注册厂商 hooks、不使用通道名判断特性。不要为了通用方向转换器复制第三份厂商历史状态机。
- 明确纯函数输入/输出与错误映射；共享普通工具身份不含网关执行标记。共享函数不修改客户端输入，消息合并和 schema 变换不能暗中丢失字段。
- sink 提供文本、reasoning、普通工具和服务器输出项的受控操作；支持显式提交信封字段、正常闭合与仅快照状态更新。取消/终态操作幂等，不暴露内部数组和计数器。
- 响应外壳消费各家事件迭代器，保留背压、迭代器清理、非流式聚合与观测通知；不得把上游腿结束等同整个响应结束。
- M0 重新统计能共享的代码；M1 固化 API 与代表性样本后各家再消费。任何新增共享 API 先由内核负责人修改，避免多个 agent 同时编辑共享文件。

**CodeBuddy 负责人**：

- 保留声明剥离、namespace 遍历、dropped 提示顺序与文案、服务器历史摘要、未知历史拒绝、工具选择校验。
- 在历史遍历中保留 DeepSeek 模型判断、reasoning 信封回放与 pending reasoning/assistant 合并；结果图片在原位置提升为 user 消息，不走最终请求补丁。
- Chat feed 保留工具索引/参数完整性、function/custom 反解、refusal、finish_reason、DONE/EOF、整包 JSON 重放及 usage 行为；信封编码后显式提交 sink。
- 验收覆盖消息顺序、错误类型/400 文案、重复/孤立结果、图片提升、reasoning 附着、工具增量、异常和取消；同步验证 Qoder 消费该实现不受影响。

**Qoder 负责人**（依赖 CodeBuddy）：

- 不另写一份 Responses 历史遍历；继续消费 CodeBuddy 的原语化实现。工具剥离+提示、服务器历史摘要、普通未知历史拒绝必须分别验收。
- 保留转换前的 effort 白名单、转换后的 system 补齐和 parameters 字段白名单，保持 CodeBuddy→Qoder 错误类型/文案映射。
- 保留私有信封规整、排队等待、独立 finish、嵌套错误解包与 id 驱动的并行调用索引修复；内部 DONE 与非零 choice 不得扩大过滤范围。
- 保留计费 augment、流式后置包装、非流式返回、onComplete、脱敏与 abort 链。覆盖缺 finish、显式错误、取消补失败终态和计费字段出现时机；迁移 CodeBuddy 不能只跑 Qoder 请求测试。

**ZCode 负责人**：

- 原生搜索声明和历史回放留在同一本地转换流程：禁外网/namespace 剥离、本轮能力判断、web_search_prime/search_query 形状、调用 ID 与结果消息均保持。
- thinking 信封在历史遍历中还原；图片块在工具结果内保留。请求后处理负责采集/去重、同名避让、识别声明和提示，转换公共 ToolMap 时同步保留网关调用识别所需的本地标记。
- feed 在事件流出前区分客户端工具、网关工具与服务器搜索，保留搜索结果配对、参数增量、未知块忽略及缺结果/异常闭合差异。
- 本地执行/续跑保留模板、图片匹配、重试、上限、脱敏、回填、重新签名与 reader 清理；跨腿复用 sink。验收单图/多图/远程 URL、客户端同名工具、识别失败、执行/换腿取消、跨腿序号和唯一终态。

**AGY 负责人**：

- 先区分 Gemini 通用协议规则与 AGY 具体兼容策略：thoughtSignature 属于 Gemini Part 级元数据，其与原调用关联及回放不是 AGY 独有；agn1 信封、从 Responses 历史恢复签名的约定、CloudCodeAssist wrapper 则属于当前适配路径。可无损复用的 Part 构造/签名保留原语允许进入共享 Google 层，agn1 编解码与历史顺序决策继续留在 AGY。
- schema 清洗在普通声明构造前本地调用；当前使用 parameters 的 Gemini Schema/protojson 路径，包含白名单、本地 $ref 内联、联合 type、const、元组和 enum 字符串化。不能把这套有损兼容策略定义成所有 Gemini 端点的统一规则。保留 namespace、工具结果文本折叠、服务器历史摘要和 systemInstruction 合并。
- 历史 thought 与 thoughtSignature 区分处理；agn1 解码、签名与后续 functionCall 的附着关系在本地遍历中保持，不能只在最后一个 Part 上统一补签名，也不能向所有并行调用复制同一签名。
- effort→thinkingConfig 与 CloudCodeAssist wrapper 留在 adapter。Gemini feed 保留候选/parts 消费、thought 与签名、函数调用、usageMetadata 和 finishReason 映射；本地编码信封后提交 sink。
- 验收签名单独/附着 Part、正确工具关联、多 parts、thought 文本、usage、三种终态、wrapper、错误与取消；不把 ZCode 的服务器能力引入 Google 转换。

核对基线（2026-10-09）：仓库依赖 llm-bridge 2.0.1，未依赖 Vercel 的 @ai-sdk/google。llm-bridge 的 stripUnsupportedSchemaFields 递归删除不支持字段，不能等价替代上述 schema 变换；Google 跨协议转换与流式路径未显式映射 thoughtSignature，也不识别 Responses encrypted_content 中的 agn1。Google 原样重建路径可能保留原始字段，不能据此推定跨协议往返无损。已用本地转换样本验证 $ref/const 被删为空 schema，以及 agn1 签名未进入 Google 输出。

参考 [Google 签名规则](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)、[AI SDK Google 消息转换](https://github.com/vercel/ai/blob/main/packages/google/src/convert-to-google-messages.ts) 与 [工具声明构造](https://github.com/vercel/ai/blob/main/packages/google/src/google-prepare-tools.ts)：当前 AI SDK 使用自己的 providerOptions 保存/回放签名，工具 schema 使用 parametersJsonSchema；它们不能直接替代当前 AGY 的 parameters/agn1 路径。更换实现前必须锁定版本并比较实际输出与 AGY 金样本，本计划不新增依赖或更换上游 schema 字段。

**OpenCode Zen 负责人**：

- 保留 Responses→Chat 的宽松遍历、相邻工具调用合并、custom 降级、工具名直传、未知条目跳过、内容数组折叠和工具输出图片丢弃；只替换结果完全相同的纯原语，不套用 CodeBuddy 的严格校验。
- 类型收编为 Protocol 时保持 hub 方向矩阵、同协议直通与 BRIDGE_PROTOCOL 对照；不把未注册方向误报为现有 hub 不支持。
- llm-bridge 请求/流式路径与 Responses/Chat 本地非流式聚合器保留，不强制接入本轮手写 feed/sink。退役条件仍由 chat 计划 M3 处理。
- 验收四类协议方向矩阵、直通、宽松历史、工具流事件以及非流式聚合顺序/usage/EOF；发现与共享原语的语义差异时保留本地实现，不新增隐式兼容开关。

**集成负责人**：依赖内核 API 固化后可并行迁移 ZCode / AGY / Zen 的独立文件；CodeBuddy→Qoder 串行，每家合入仍按 §4 顺序验证。各家只修改自身目录和测试，公共类型/注册表/计划由集成负责人统一协调；交付记录已复用原语、仍保留特性、测试结果与剩余问题。禁止同时修改同一共享文件。后台单元测试每次最大超时 60 秒，超时后诊断或拆分测试，不以跳过验证完成任务。

### 5. 与 chat-completions 计划的衔接

本计划完成后，chat 计划 M1 的 chat↔Responses 与 M3 的 chat↔Anthropic/chat↔Gemini 按同一注册表新增通用方向，复用纯转换原语、事件内核、外壳与 usage（并新增反向 chat 事件合成器）。需要服务器工具/reasoning 专属语义的入口仍由 adapter 编排，不能因为注册了协议方向而绕过各家的历史/feed。M4 同步调整 chat 计划的消费边界，不能再承诺整套厂商转换器无需特性处理即可直接复用。

### 6. 内建 agent 路由插件试验：register(prefix, fn)

这是路由注册，不是转换 hooks。插件 handler 拥有本通道的校验、转换、传输和响应生成，内部显式调用共享原语；注册器只选择 handler。协议方向注册表与模型前缀注册表分别维护，不能根据前缀直接推定目标协议。

概念调用如下（名称为拟议 API，不表示仓库已实现）：

```ts
registry.register("agy/", agyPlugin.handle);
registry.register("opencode-zen/", zenPlugin.handle);
registry.setDefault(defaultUpstreamRouter.handle);
```

register 的范围仅为 ZCode、CodeBuddy/WorkBuddy、Qoder、AGY、OpenCode Zen 等 agent 兼容模块。CLIProxy、NewAPI 与 official 均不进入该注册表，不新增 newapi/、official/ 或 offical/ 模型前缀。未命中 agent 处理器的请求进入 defaultUpstreamRouter；它在内部根据代理配置前缀、upstreamOnly、hint 与粘性选择第三方代理或官方处理器。第三方代理由 upstreamType 选择 CLIProxy 或 NewAPI，现有 cliproxy/（或 config.prefix）由 default 解释，不意味着将所有 default 请求强制发给第三方代理。

**NewAPI 与 CLIProxy 共用默认转发逻辑：** 当前 gateway 的普通 HTTP、compaction 与 Responses WS 目标/帧路径不按 upstreamType 分叉；route.kind 名称仍为 cliproxy，实际目标由 upstreamBaseUrl 决定。因此下文 CPA/CLIProxy 转发侧的前缀、认证、粘性、压缩与协商规则同样覆盖 NewAPI，不仅限 CLIProxy 产品。保留现有配置与 route.kind，不为了插件化新增第二份 NewAPI 转发器。WebSocket 是否成功仍由实际上游能力决定，保留拨号失败与降级行为。

派发顺序：公共端点/安全与传输边界 → agent 前缀匹配与入口能力判断 → 已处理则返回，否则按旧规则进入 default → default 选择 CPA/官方并执行对应兼容处理。agent 的错误与拒绝属于已处理结果，不退回 default；Realtime 保留独立端点分流。CPA 与本地 agent 前缀冲突的旧优先级需在 P0 固化，不能用默认注册顺序改变它。

#### 6.1 公共边界、注册契约与模块职责

- gateway：健康检查、mountPath 与 /ui 本地边界、公共请求上下文、模型排除拦截、目录端点与日志外壳、HTTP/升级传输入口。业务转换归 handler；模型排除保持仅针对现有本地兼容族，不扩大到 CPA/官方模型。
- 路由注册器：匹配模型前缀、调用 handler、调用默认处理器，不读取凭据、不生成 compaction、不识别厂商事件。相同匹配前缀重复注册在启动时报错；重叠前缀按最长匹配确定，P0 固化优先级。
- 插件组合模块：仅创建 agent 实例并注册别名/前缀，统一提供其 catalog 与 close 生命周期；gateway 不再维护五组 request WeakSet、close 调用和目录参数。catalog/日志归属元数据由 agent 插件提供，CPA/官方目录由 default 模块提供，两者沿用现有合并规则，不通过模型前缀注册表达目录操作。
- 默认路由模块：内部保留 CPA 配置前缀识别、hint、线程/父线程/image-turn 粘性与 upstreamOnly 的既有判定，并持有 CPA/官方处理器；不借助 register 进行这次选择。CPA 的 HTTP 与 WebSocket 共用该实例的线程/turn 状态及容量限制；不得建立两个状态副本。
- default 内部的 CLIProxy/官方处理器：拥有上游 URL 构造、各自认证边界、body 改写或透传及响应流。共用纯传输辅助函数；不让官方先进入 CPA 改写再恢复。可以拆成独立内部模块，但不将它们包装成 agent 前缀插件。

register(prefix, fn) 的 fn 接收完整路由上下文，不能只有剥前缀后的 model 字符串：至少包含 Request、mountPath 内路径/方法、完整模型名、命中前缀、路由来源及取消信号。需要 JSON 时通过请求级缓存惰性读取，原始字节始终可用于透传；前缀匹配不修改 model/body/headers，由插件自行解析模型。body model 与 routing hint 的优先级按现有入口分别保持，不能为统一接口而改变冲突结果。

插件对支持的入口返回已处理结果；只有尚未消费请求、且旧路由本来允许通用透传的入口才可显式 decline。转换失败、凭据错误、排除/拒绝及已消费的流不得通过 decline 重试到默认上游，避免重复请求和认证跨界。本地适配入口无效 JSON 的通道错误仍依 hint 归属处理，通用解析失败保留原有统一 400，不扩大通道归属规则；已经缓存的正文不得再从 Request 流读取。

前缀注册清单必须包含全部既有 agent 形式：CodeBuddy/WorkBuddy 地域前缀及旧别名；Qoder 地域与无地域形式；ZCode 固定套餐前缀与动态 provider 形式（本地 zcode- 族处理器再验证具体连接）；AGY 与 Zen。agent 注册匹配保持既有大小写行为，CPA 配置前缀当前为精确 startsWith，单独留在 default；不能统一改为小写或改写上游模型 ID。禁用通道、未知动态前缀、旧别名、前缀空模型的结果先纳入 P0，不趁迁移改变当前错误/回退行为。

插件只暴露仓库内既有能力，选择 handler 后仍由插件检查路径、方法与传输；Zen 现有 Chat/Responses 路径及 compact 拒绝，其他本地代理 Responses/compact 路径与 HTTP-only 协商分别保留。当前目录之外的模型请求不能仅因未列入 catalog 就改变旧路由。

旧前缀不全是可用别名：codebuddy/、workbuddy/ 当前用于识别本地族后明确返回 adapter 400；qoder/ 则实际映射国际版。注册这些形式是为了保留各自既有结果，不能统一转换成有效地域前缀。

#### 6.2 CLIProxy / NewAPI 与官方链路：已确认的转换边界

代码核对基线：gateway.ts 的 decideRoute / decideThreadRoute / copyRequestHeaders、HTTP 通用转发和 compaction 分支，以及 Responses WebSocket 帧处理；realtime.ts 的桥接与重连逻辑。它们没有先把官方协议转成 CPA 协议的一套通用双向转换器，而是共用 Responses 入口，包含以下不对称的兼容处理。

| 场景 | 现有行为 | 插件化后的责任 |
| --- | --- | --- |
| CLIProxy / NewAPI 普通 HTTP | 去模型与 hint 前缀、重写 JSON model；非 GPT 且无压缩触发时还原 compaction 历史 | 共用第三方代理 handler |
| CLIProxy / NewAPI 认证 | 移除客户端 Authorization、ChatGPT 账号及其他上游 key 头，注入已配置代理 key；HTTP 与 Responses WS 均覆盖 | 共用代理 HTTP/WS 处理器，key 仍走现有存储分派 |
| 官方普通 HTTP | 按原始正文与官方认证转发；已有可用 hint 时可不解压/解析 JSON | official handler，不调用通用请求转换器 |
| 响应 | 普通 body/status/流透传，共用响应头清理；压缩兼容分支才生成新响应 | 各 handler，保持背压与取消 |
| 无前缀 CPA 请求 | thread、parent-thread 或 image-turn 命中已记忆 CPA 会话，或 upstreamOnly | 默认路由策略调用 CPA handler |
| GPT 与非 GPT | GPT 判定目前为 model.toLowerCase().startsWith("gpt-")；压缩兼容仅应用于非 GPT CPA 模型 | CPA handler 保留判定，不扩展为全部模型 |

官方透传仍有 hop-by-hop/accept-encoding 等传输头清理，不能宣称所有头逐字节不变。CPA 重序列化后移除 content-encoding；upstreamOnly 的非 Responses 路径恢复原 content-encoding 并透传原字节，Responses/compact 仍进入兼容处理。惰性正文缓存须保留这两个分支，不强制所有请求都先 JSON.parse/JSON.stringify。

**目录拉取仍有区别：** upstreamType=cliproxy 消费上游 Codex 目录；upstreamType=newapi 从 OpenAI /models 列表结合内联快照与规则合成本地 Codex 目录。该分支继续留在 upstream-catalog.ts / catalog.ts，default 提供目录时复用它，不因转发逻辑相同而统一成一种拉取方式。配置缺省类型与缓存/合并/覆盖规则均保持。

**compaction 不能遗漏，也不能全局无条件执行：**

- CPA 非 GPT 的 /responses/compact（v1）与 compaction_trigger（v2）会改发上游 /responses，构造摘要请求、消费 JSON/SSE、校验完成状态与摘要，再生成替换历史或合成 compaction 响应；下一轮 ocx1 历史还原为可读文本。
- CPA GPT 与官方链路保持原生请求/响应路径，不注入上述摘要转换。ZCode/Qoder/CodeBuddy/AGY 保留各自压缩包装与错误文案；Zen 保留 compact 拒绝。
- 将现有 build/read/synthetic/rewrite 等纯压缩辅助函数移入独立 compat/compaction 模块；由适用插件显式调用，网关不做转换中间件，不复用厂商 hooks。迁移时保留裁剪字段、图片处理、触发条件、原生 compaction 输出优先级与失败行为。

#### 6.3 WebSocket 与 Realtime 的例外

只提供返回 Response 的 HTTP fn 不足以完成插件化。register 可保留同一入口，但 dispatch 结果需区分普通 HTTP 响应与升级/桥接会话；传输生命周期由类型化契约表达，具体签名由 P0 对现有桥接测试确定。不能把 stream/upgrade 的所有权隐藏在 Response 转换回调里。

- Responses WS 握手先依据 hint/粘性选择 CPA 或官方；连接内帧可能换模型，不能只在握手时匹配一次。官方连接遇 CPA 模型会 pin CPA 会话并触发重连，CPA 帧去前缀；turn 记录与 image-turn 后续 HTTP 路由共享状态。
- CPA 非 GPT 的触发帧可能转为 HTTP/SSE 摘要请求，再把合成事件发回 WS；普通 compaction 历史帧需重写。此逻辑归 CPA 桥接会话，不能因 HTTP handler 迁移而丢失。
- 本地 HTTP-only 插件保留 426/降级协商及 marker，CPA 拨号失败也保留 426 路径；网关外的 bridge 生命周期与握手取消仍保留。P1 仅试验 HTTP，未迁移的 WS 路径明确留在原实现；P2 后才可验收 gateway 无厂商分支。
- HTTP-only 握手目前有外层 startGateway 分流与 handleCore 返回 426 两段边界；responsesWebSocketTarget 自身的排除名单并不覆盖全部本地族。P2 必须先由通用传输入口识别插件传输能力再进入桥接，不能仅移植该函数内的名单，导致 Qoder/Zen 绕过协商。
- Realtime calls、/live、sideband 与保留路径不一定携带模型前缀，继续作为独立端点/传输服务先于普通默认路由处理，不通过 official/ 前缀模拟；认证与 provider mode 保持 realtime.ts 自己的规则，不套用普通 CPA 头替换。现有未实现官方 Realtime 路径的响应保持。

#### 6.4 插件试验分工与验收

- **注册器/集成 agent**：P0 建路由行为矩阵与类型；P1 实现注册/默认路由/请求缓存/插件组合，在 gateway 删除已迁移的 HTTP 厂商分支；P2 迁移升级契约、目录/日志归属与 close，统一验证既有公共边界。公共注册器与 gateway 只由该负责人编辑。
- **default 模块负责人**：提取 CLIProxy/NewAPI 共用代理 handler、官方 handler 与默认路由状态，保留代理前缀判定/认证/字节透传、压缩分支及 WS 会话；三者均不进入 agent 注册表。保留两种 upstreamType 的目录差异，先比较原始上游请求再迁移，不把代理侧跨厂商协议转换能力复制进网关。
- **各 adapter agent**：在各家目录提供实例/handle/catalog/close，收回当前 gateway 内的路径判断、compact 包装与通道错误；复用 §4.1 保留的特性，注册全部前缀/别名。CodeBuddy→Qoder 仍按依赖顺序验证。
- **验收负责人**：固定 hint/body 冲突、禁用/旧别名/动态前缀、重叠前缀、空模型、decline、目录与排除、只读取一次正文、错误归属和 close 清理。HTTP/WS 同时验证 OAuth 不外发 CPA、official 原字节透传、upstreamOnly 两条正文路径、thread/parent/image-turn 粘性，以及 GPT/非 GPT 的 v1/v2/历史/失败/取消。
- P0–P2 不改配置，不引入外部加载器，不改变新 Chat 协议计划范围。每阶段全量回归；P2 验证后才能将试验标记完成。若试验明确推迟，记录剩余事项与原 WS 分支，不将 HTTP 迁移单独宣称整个插件化完成。

## 风险

- 风险：仅按前缀匹配使无前缀粘性请求误去官方，或强制解析破坏官方/压缩正文透传。
  缓解：§6 的默认路由独立于前缀注册，HTTP/WS 共享 CPA 会话状态，惰性读取且保留原字节；P0 固化路由与上游正文矩阵。
- 风险：HTTP 插件迁移遗漏 compact、WS 逐帧切换、Realtime、目录/日志和 close 生命周期。
  缓解：P1/P2 分阶段验证；压缩由插件显式调用纯兼容模块；传输与管理职责单独列验收，不把 register(prefix, fn) 当成全部契约。
- 风险：响应向流式重构（abort/cancel 传播、事件顺序、sequence_number、非流式聚合、zcode 多腿换 reader）引入隐性回归，真实上游不能作为回归主力。
  缓解：M0 金样本固化完整 SSE 逐事件转录（含 sequence_number、取消、错误帧、非流式聚合、多腿换腿点）后才动工；逐家切换、逐家全量测试 + 独立 commit，可按家回滚。
- 风险：错误类型/文案漂移破坏测试断言与客户端诊断（含 qoder 的 CodeBuddy→Qoder 文案改写链）。
  缓解：共享转换器抛参数化的 `ProtocolConvertError`（消息含通道名，逐字对齐现行文案）；各家 index.ts 的 catch 分支与对外错误类型语义不变；金样本断言覆盖错误路径。
- 风险：为追求去重把厂商分支搬进共享层，或用隐藏回调/大量策略开关重新实现 hooks。
  缓解：按 §2.1 / §4.1 保留遍历与 feed，只有至少两个真实调用方或 chat 计划锁定消费的纯机制才共享；单一厂商特性留在本地，不以删除行数推进抽象。
- 风险：共享纯函数改变消息合并、校验时机或字段保留，导致本地特性无法按原顺序组合。
  缓解：纯函数结果与完整请求金样本同时验证；adapter 保持原分支顺序；reasoning/服务器历史/图片提升在遍历内完成，不从有损结果恢复。
- 风险：opencode-zen 宽松规则与 codebuddy 严格规则在共享实现里语义误配。
  缓解：差异矩阵进单测，同一 fixture 分别锁定两家金样本；Zen 保留本地遍历，只消费同义原语。
- 风险：范围蔓延进 chat 计划（顺手实现 chat 方向转换器或入口层）。
  缓解：「不包含」清单为硬边界；注册表对未注册方向显式报错。
- 风险：opencode-zen 现网依赖 llm-bridge 的 chat→anthropic/google 段被误伤。
  缓解：M2 第 5 步只动 responses→chat 段与类型收编；`translateZenStream` 与 llm-bridge 分工平移不重写；`test/opencode-zen-{convert,gateway}.test.ts` 全量回归。

## 里程碑

1. M0 金样本固化（零 src 改动）：审计 10 个转换测试文件的覆盖缺口，补齐边界 fixture 的特征化测试（请求向输出体、响应向含 sequence_number 的完整 SSE 转录、错误路径文案、zen 宽松策略边界、zcode 多腿换腿点）。
2. M1 共享纯原语、事件内核与通用方向组合落地（纯新增）：以现行为为蓝本落实 §2.1 / §3.1 的显式调用契约，定义通用方向支持范围，附 kernel/原语单测；adapter 未切换，全量测试保持绿。
3. M2 请求向逐家复用原语：按 §4 顺序 1→5、§4.1 分工执行，每家独立 commit + 该家与全量测试通过 + 金样本不变；仅删除被原语取代的代码，保留本地特性遍历。
4. M3 响应向逐家复用 sink / 外壳：按 §4 顺序 1→4，每家独立 commit + 全量测试通过 + SSE 转录金样本不变；保留各家 feed、Qoder 包装与 ZCode 续跑，只删除被事件内核取代的机构，不预设净删除行数。
5. M4 协议抽离收尾：死代码清扫、tech-debt 登记（llm-bridge 退役条件、遗留差异）、chat 计划消费边界改写、`bun run check` 全绿并写实现历史记录；插件试验尚未完成时计划保持 active。
6. P0 插件试验基线：审计 §6 特殊情况，补齐 HTTP/WS/默认路由金样本，固化注册、惰性正文与传输契约；可与 M0 调研并行，源码仍保持不变。
7. P1 HTTP 注册派发试验：M1 API 稳定且相关 adapter 已迁移后，先注册一家 HTTP agent adapter，再逐家迁移；通用 CPA/官方流量由独立 default 接管，不注册其前缀。目录/日志生命周期保留桥接，WS 暂用旧路径，逐步全量回归。
8. P2 插件试验收尾：升级/逐帧路由、共享粘性、目录/日志/close 全部对齐，gateway 不再有厂商转换分支；check 全绿、记录历史与明确债务。M0–M4 与 P0–P2 均完成（或插件试验获明确推迟并留痕）后归档。

## 验证方式

- 命令：`bun run typecheck`；逐里程碑 `bun test`（至少覆盖 `test/{zcode,codebuddy,qoder,agy,opencode-zen}-*` 转换面）；提交前 `bun run check`。
- 手工检查：`bun run dev serve` 后对 `zcode/`、`codebuddy-cn/`（或 workbuddy）、`qoder-intl/`、`agy/` 前缀模型各打一条 `POST {mountPath}/responses` 流式 + 非流式冒烟（真实上游按既有低频约束执行一轮）；opencode-zen 免费模型一条 chat 入口请求冒烟。
- 观测检查：request log 中各家 error.code 与错误文案与切换前一致；审计与日志脱敏规则无回归（`sanitizeUrlValue`、敏感头遮蔽沿用）。
- M0 本地特性组合样本：同一服务器工具声明在 Qoder 下剥离并提示、在 ZCode 下原生映射；ZCode 禁外网/namespace 内搜索剥离，历史回放随本轮声明启闭；服务器调用摘要与普通未知历史拒绝分开验证，tool_choice 保持现有省略行为。
- M0 图片与响应样本：base64/远程 URL、工具输出图片、客户端同名工具、多图匹配失败；搜索结果缺失与未知服务器块；识别成功/失败/达到续跑上限，以及执行或换腿期间取消，验证事件序号跨腿连续。
- M0 Qoder 信封样本：排队后正常推理、内部 DONE 后仍有数据、缺独立 finish、显式错误、重复工具 index、非零 choice；流式/非流式/onComplete 计费字段与错误标签一致性、取消失败终态行为。
- M0 CodeBuddy / AGY / Zen 组合样本：CodeBuddy pending reasoning 与工具结果图片位置；AGY 签名单独/附着 Part 及后续调用关联；Zen 同义原语复用前后的宽松历史、协议方向矩阵和聚合边界。纯原语测试通过不能替代各家完整请求/响应金样本。
- P0–P2：test/gateway.test.ts、test/realtime.test.ts、test/model-exclude-gateway.test.ts 及各 adapter gateway 测试；以 §6.4 矩阵补缺口，尤其 CPA 非 GPT compaction 与官方 hint 下压缩原字节透传。仅对文档规划更新不运行源码测试。
- P0–P2 代理类型矩阵：分别以 upstreamType=cliproxy/newapi 验证共用 default 转发、前缀/认证、粘性、upstreamOnly、压缩与 WS 协商；目录测试分别验证 Codex 目录直读与 OpenAI 列表合成，不能只验证 CLIProxy 类型。

## 进度记录

- [ ] M0：金样本覆盖缺口审计与特征化测试补齐。
- [ ] M1：`src/protocols/` 纯原语、事件内核与通用方向组合落地（纯新增，无特性 hooks）。
- [ ] M2：请求向五家复用原语完成，本地遍历保留（codebuddy → qoder → zcode → agy → opencode-zen）。
- [ ] M3：响应向四家复用 sink / 外壳完成，本地 feed 保留（codebuddy → qoder → zcode → agy）。
- [ ] M4：协议抽离死代码清除、tech-debt 登记、chat 计划改写、check 与历史记录。
- [ ] P0：前缀插件、CPA/官方默认路由与传输契约基线固化。
- [ ] P1：HTTP 插件注册派发试验完成，旧 WS 路径明确保留。
- [ ] P2：WS/粘性/目录/日志/close 迁移完成，整体回归与归档。

## 决策记录

- 2026-10-09：保留「通用单跳方向组合 + 内核原语」注册表，不做全局规范形中转（对齐 chat 计划 2026-10-08 单跳决策）；未注册的 (from, to) 组合显式报错。opencode-zen 的 chat-hub 组合（responses→chat→anthropic/google 两跳）保留在其模块内，不改写为规范形。最终无 hooks 方案允许 adapter 直接调用原语，注册表不强制承载厂商转换流程。
- 2026-10-09：`Protocol` 采用字符串字面量联合（`"openai-chat" | "openai-responses" | "anthropic" | "google"`），不引入 `Platform` 枚举。理由：语义是协议方言而非厂商——zcode 上游讲 Anthropic 协议但不是 Anthropic 官方；仓库公共边界惯例为字符串联合。
- 2026-10-09（早期方案，接入方式已被末条决策替代）：adapter 怪癖不下沉，曾规划通过窄钩子或后置步骤接入 reasoning、schema 与服务器工具；最终采用 adapter 显式调用原语，依赖方向仍保持单向。
- 2026-10-09：本计划不替换 opencode-zen 的 llm-bridge 流式与 chat→anthropic/google 请求段（实测完整、有测试覆盖）；待 chat 计划 M3 产出共享流式转换器覆盖对应方向后退役，届时在 tech-debt-tracker 登记与勾销。
- 2026-10-09：响应向以「合成器 sink + 协议 feed」解耦：sink 与响应外壳单份实现，feed 自持上游 reader（含 zcode 多腿换腿）。理由：三份合成器的差异全部在「如何从上游帧驱动」，机构本身（blocks/sequence/收尾/取消）经逐行比对确认同构。
- 2026-10-09：先 M0 金样本后动工。理由：真实上游低频使用约束下，特征化测试是唯一可持续的行为不变验收手段；所有后续「逐字节一致」承诺都以 M0 固化的样本为准绳。
- 2026-10-09（早期方案，已被末条决策替代）：曾规划服务器声明/历史与响应扩展 hooks，以及计费 decorateSnapshot；保留分类排除原则，取消全部新增特性 hooks 和扩展注册机制。
- 2026-10-09：按用户选择采用无转换 hooks 方案。各家保留声明/历史遍历、协议 feed 与内部特性，显式调用共享纯原语与 Responses sink；通用方向注册表不代替完整厂商适配。Qoder 继续复用 CodeBuddy 并保留计费/取消包装，ZCode 在本地处理搜索/图片与多腿续跑，AGY 在本地处理 schema/签名，Zen 仅复用同义原语。新增 §4.1 的逐 agent 工作清单与协作边界，取消旧净删除行数承诺；既有观测/脱敏回调保留，不用作特性注入。
- 2026-10-10：补充内建 agent 前缀插件试验（§6、P0–P2），采用 register(prefix, fn) 与独立默认路由。核对现有 CPA/官方链路：普通响应没有统一双向协议转换，CPA 仍有模型/认证改写及非 GPT compaction 合成，官方保留原字节透传；线程粘性与 WS 逐帧协商使纯前缀路由不足。业务转换迁入插件，跨请求状态与传输协商独立建模，公共入口边界继续保留；不新增 official/ 前缀、转换 hooks 或外部插件加载机制。
- 2026-10-10：按用户补充，register 仅用于 agent 兼容模块；取消 CPA 的前缀注册方案，CPA/官方统一作为 default 提供。cliproxy/ 的既有语义保留在 default 内部，与 hint、upstreamOnly、粘性、压缩及 WS 规则一起判定；agent 错误不回退 default。
- 2026-10-10：补全 NewAPI 范围。CLIProxy/NewAPI 共用 default 的代理转发逻辑，不分别注册、不新增 newapi/ 前缀；保留 upstreamType 在目录拉取/合成中的现有差异，验收覆盖两种类型。文中 CPA 转发侧规则均包括 NewAPI 当前共用路径。
