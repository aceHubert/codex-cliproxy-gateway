# 插件接口与行为交接

本文记录 monorepo 本轮实际接口，供 S0 审查、插件迁移及独立转换计划交接。
契约来源为 `packages/plugin-api/src/types.ts`、`patterns.ts`、`registry.ts`、
`host.ts`，业务接线位于 `apps/gateway/src/gateway-composition.ts`、
`gateway.ts`、`host-services.ts`。本文描述已实现边界，不代表后续通用转换、
新增 Chat 适配、插件市场或热安装已经交付。

## 注册与装配

`GatewayPlugin` 必须提供：

- `id` 与非空 `modelPatterns`。
- `handleHttp(context)`，返回 `Response` 或 `Promise<Response>`。
- `getCatalog()`、`refreshCatalog()`、`reloadCatalog()`。
- `ready()` 与 `close()`。

`websocket` 缺省为不支持，值必须是布尔类型。
声明 `websocket: true` 时必须提供实际 `handleWebSocket(context)`。
注册表拒绝空/重复 ID、缺失 HTTP handler、空模式列表、重复模式与跨插件歧义重叠。
类型接口同时要求目录与生命周期方法；注册时的运行时检查不替代 TypeScript 契约。

业务组合入口按有效配置显式调用以下工厂，五类开关缺省 true、显式 false 保留：

| 插件 ID | 工厂 | 当前模型模式 |
| --- | --- | --- |
| `zcode` | `createZcodePlugin` | `zcode/*`、`zcode-*/*` |
| `codebuddy` | `createCodebuddyPlugin` | `codebuddy/*`、`workbuddy/*`、`codebuddy-cn/*`、`codebuddy-intl/*`、`workbuddy-cn/*`、`workbuddy-intl/*` |
| `qoder` | `createQoderPlugin` | `qoder/*`、`qoder-intl/*`、`qoder-cn/*` |
| `agy` | `createAgyPlugin` | `agy/*` |
| `opencode-zen` | `createOpencodeZenPlugin` | `opencode-zen/*` |

五家当前均声明 `websocket: false`。
注册后冻结插件列表与模式表，不探测 npm、不下载或热安装，也不在运行期重新注册。
构造后续插件失败时，组合入口会尽力关闭已创建插件并保留原始构造错误。
结构配置变更沿用既有重启流程；模型 refresh/reload 不表示插件代码热加载。

## 模型模式与归属

支持精确模型、固定前缀与前缀段通配。
精确模式不含 `*`；含通配符的模式必须以 `/*` 结尾。
模式不得为空、带首尾空白或包含空前缀段。
前缀段中的 `*` 匹配零个或多个非 `/` 字符，不能跨段；
末尾 `/*` 要求至少一个后缀字符，后缀视为不透明模型名，可以包含 `/`。
匹配大小写敏感，不归一化模型 ID。

优先级为精确模型 > 固定前缀 > 含前缀段通配。
跨插件同优先级且匹配集合有交集的模式在注册时拒绝，
例如分别注册 `zcode-*/*` 与 `zcode-team*/*`。
跨优先级重叠允许，由优先级确定归属；即使固定前缀长度不同，
它们仍属于同一优先级，跨插件存在交集也会拒绝。
同插件内重复字符串仍拒绝；同插件的非重复重叠允许，
同优先级按注册次序选择首个匹配模式。

| 模式 | 模型 | 结果 |
| --- | --- | --- |
| `model-x` | `model-x` | 匹配；`matchedPrefix` 为 `""` |
| `zcode/*` | `zcode/model-a` | 匹配；真实前缀为 `zcode/` |
| `zcode-*/*` | `zcode-team-coding-plan/model-a` | 匹配；真实前缀为 `zcode-team-coding-plan/` |
| `zcode-*/*` | `zcode-provider/vendor/model-a` | 匹配；后缀 `vendor/model-a` 原样保留 |
| `zcode-*/*` | `zcode-/model-a` | 模式匹配；空 provider 的语义合法性由插件判断 |
| `zcode/*` | `zcode/` | 不匹配，后缀为空 |
| `zcode/*` | `ZCode/model-a` | 不匹配，大小写不同 |
| `zcode-*/*` | `zcode-team` | 不匹配，缺少分隔符与模型后缀 |

匹配结果携带完整 `model`、声明的 `matchedPattern` 与实际 `matchedPrefix`。
例如通配模式命中套餐模型时，不得把字面量 `zcode-` 当作实际前缀。
当前工厂保留既有 adapter 对模型、套餐、地域和凭据的进一步校验。
插件接管后的错误、异常及上游失败不回退 default。

注册表提供可选 `CandidateSelector`，在派发前筛选候选插件。
一次否决针对整个插件，后续不因该插件的低优先级模式重新派发。
没有候选时，通用注册表可以调用调用方传入的 default handler；
业务 HTTP 路由对已归属插件传入禁止回退的 handler。

相比旧识别函数，本轮新的注册归属边界明确采用大小写敏感及非空后缀：
旧 adapter 中仍保留大小写不敏感或宽松前缀识别函数，
这些函数不再决定外部请求是否归属插件。
例如 `AGY/model-a`、`zcode/` 不由新模式表接管。
这是路由契约边界变化，不是请求/响应转换算法变化；
正常目录输出的规范前缀与非空模型 ID 保持原有转换路径。

## HTTP、Responses 与 compaction

`identifyClientEndpoint(pathname, mountPath)` 精确识别受管入口；
默认 mountPath 为 `/v1`，其他 mountPath 按相同相对路径识别：

| HTTP 入口 | `from` | `operation` |
| --- | --- | --- |
| `/v1/chat/completions` | `chat` | `generate` |
| `/v1/responses` | `responses` | `generate` |
| `/v1/responses/compact` | `responses` | `compact` |

UI、Realtime 和 mountPath 外路径由宿主独立处理，保留本地 404 和鉴权边界。
HTTP 插件上下文包含原始 Request、URL、完整 model、协议、操作、
AbortSignal、匹配结果与 `body.bytes()/json()`。
宿主读取正文并支持可重复访问；模型正文存在字符串 model 时优先于路由提示。
插件拒绝非 JSON 对象正文，返回本地 400。

| 插件 | Responses generate | Responses compact | Chat generate |
| --- | --- | --- | --- |
| ZCode | 原 adapter 转换 | 业务压缩包装与原 adapter | 本地 400 |
| CodeBuddy/WorkBuddy | 原 adapter 转换 | 业务压缩包装与原 adapter | 本地 400 |
| Qoder | 原 adapter 转换 | 业务压缩包装与原 adapter | 本地 400 |
| AGY | 原 adapter 转换 | 业务压缩包装与原 adapter | 本地 400 |
| OpenCode Zen | 原 `forwardResponses` | 本地 400，不支持 | 原 `forward` |

HTTP 同时承载 SSE 与非流式响应，不使用协议/传输能力数组。
业务 `withCodexCompaction` 包装保留既有压缩逻辑：
显式 compact 或输入压缩触发项通过原 adapter 请求摘要，
校验完成状态与非空摘要，再返回 compact 输出或合成 Responses；
普通 Responses 输入继续整理压缩历史。Zen 保留原专用分支。

本轮按迁移前 Responses 请求、响应、流式与厂商差异验收，
不将五家调用改造为新的 `convertRequest`，不新增四家 Chat 转换。
现有外部 llm-bridge 调用通过等价导出迁移，
CodeBuddy/Qoder 原有转换复用继续以显式包依赖表达。
default 的 CLIProxy/new-api 与官方模型路由保持独立出站链路，
不调用 agent 转换包，也不以 agent 失败作为转发到 default 的理由。

## WebSocket 与 HTTP 回落

同一模式表用于 HTTP 与 WS 归属。
已匹配的 HTTP-only 插件在握手阶段返回 426，
含 `x-agent-proxy-websocket: unsupported`，
不调用 HTTP/WS handler、不升级、不连接上游、不调用 default。
客户端选择回落 HTTP/SSE 时，以相同模型重新请求并归属同一插件。
注册表不主动发送回落请求；客户端是否自动回落取决于客户端实现。

支持 WS 的模拟或后续插件必须通过上下文 `upgrade(session, options)`
完成宿主的实际升级。session 表达 open、message、drain、close、error 事件，
不依赖 Bun 服务器类型。升级成功只能返回 undefined；
未升级必须返回 HTTP 拒绝响应，重复成功升级会报错。
Realtime 继续走既有独立路由及帧内模型约束。

## HostServices 与实例隔离

HostServices 实现由业务应用 `createGatewayHostServices` 提供：
运行目录、只读有效配置、实例路径、fetch、上游 Key 分派结果、
原子写入、目录工具、请求日志和进程日志。
模型快照与厂商预设由私有 workspace 包 `@agent-proxy/models` 独立提供，原始数据只存于 `packages/models/`。网关和插件直接导入该包的 `getCodexModelSnapshot()`、`getVendorModelPresets()`，每次返回独立副本，不依赖主机上下文。模型包只声明为构建依赖，构建时内联到使用方产物，不单独发布，也不进入公开包的运行时依赖。HostServices 的目录服务只保留目录转换、合并与缓存工具。
`apps/gateway/models.json` 是网关内部的上游覆盖规则，不对插件导出。ZCode 厂商元数据仅来自模型包的 z.ai 预设；不读取网关或运行目录的覆盖规则。账号和套餐刷新重新筛选当前授权模型集合，仍发布 `zcode-catalog.json` 并维护客户端缓存。
插件依赖契约包，不反向导入应用实现；包的相对源码和 JSON 资源导入均限制在自身目录内。
`catalogChanged` 在类型中是可选能力，当前应用实现未提供该通知回调。

异步上下文机制位于 `plugin-api/src/host.ts`：
`withHostServices` 使用 AsyncLocalStorage 绑定一次调用及其异步资源；
工厂在此上下文创建 adapter，再通过 `bindHostMethods`
把公开方法重新绑定到创建实例的 host。不同并发实例不覆盖彼此的路径、
配置或日志服务，后台回调继承所属实例。
未初始化上下文的访问显式报错，不静默读取全局 HOME。
`enterHostServices` 作为可用入口导出，当前工厂采用作用域绑定方式。

应用负责注入当前实例配置和路径；ALS 位于契约包不意味着契约包承担
凭据存储、业务配置解析或日志写入实现。
上游 Key 必须经应用 keychain 分派，敏感内容不通过查询或日志暴露。

## 目录与生命周期矩阵

| 方法 | 当前行为与使用边界 |
| --- | --- |
| `ready()` | 注册表并发等待各插件；当前五家工厂均返回已完成的空异步方法 |
| `getCatalog()` | 读取 adapter 当前可服务目录；沿用 startup 等待、缓存与现有按需读取行为 |
| `refreshCatalog()` | 显式网络刷新，按现有 adapter 的错误/last-good 策略返回目录 |
| `reloadCatalog()` | 重新读磁盘缓存及请求元数据，不主动发起新网络刷新；可能等待已有 startup/refresh |
| `close()` | 释放 adapter 的 watcher、计时器、会话与取消资源，具体释放沿用原 adapter |

`getCatalog` 不等于严格离线接口：构造期启动或原 store 按需加载可能涉及网络。
实际启动就绪由宿主先等待 registry.ready，再按模式读取目录：
upstream-only 调用 refreshCatalog，混合模式调用 getCatalog。
不能仅凭当前空 ready 方法宣称目录网络初始化已完成。

注册表并发调用目录方法并合并 models；CodeBuddy 的 getCatalog
额外保留已有去重步骤。一家的目录方法拒绝会使该聚合调用拒绝，
各 adapter 内已有容错保持，不在契约层统一吞错。
纯磁盘模型 reload 在同一组实例上完成后发布规则与目录，
不重建插件、不打断在途连接。
注册表重复或并发 close 共用一次回执，通过 allSettled 尽力关闭全部插件；
存在失败时抛出 AggregateError，不阻断其余插件清理。

## Web UI 零参数只读查询

CodeBuddy 包导出 `getActiveAccount()`，Qoder 包导出 `getActiveSources()`。
现有 `GET /ui/api/config` 每次请求零参数调用各一次，返回字段仍为
`detected.codebuddyAccountLabel` 与 `detected.qoderSources`。

应用先读取本次有效配置，再通过包内 `withInstanceContext` 绑定当前实例：
CodeBuddy 绑定配置读取方法及实例 home，Qoder 绑定实例 home 与来源路径。
测试/独立宿主可以通过该上下文提供认证/来源目录；
公开查询本身不接受路径、账号或来源参数。
包内上下文也使用 AsyncLocalStorage；没有该查询上下文时，
查询使用已绑定 HostServices，不永久缓存启动时展示值。

CodeBuddy 按当前账号选择读取 .info 展示标签，授权文件不存在时保持 auto 回退；
Qoder 只检查来源文件存在性，保留 CLI 优先于桌面来源的规则。
查询不启动 adapter/server/heartbeat，不发模型请求或刷新凭据，
不返回 token。切换账号或更新本机来源后，下次 UI 查询读取最新状态。

## 审查与后续交接

行为验证入口为 `test/plugin-registry.test.ts`、
`test/gateway-plugin-integration.test.ts` 与各家 Responses 回归测试。
本文不把文档核对视作测试通过证据，最终通过结果记录在执行计划与历史中。
转换计划交接时应保留本契约的模型归属、HTTP/WS、实例与生命周期边界，
同一 agent 包的转换适配与结构迁移须顺序交接，避免同时写入同一文件。
