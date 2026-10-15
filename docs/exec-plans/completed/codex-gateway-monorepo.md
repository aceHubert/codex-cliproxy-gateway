# Agent Proxy monorepo、插件化与安装配置迁移

## 目标

从 main 的 a20587d（v0.10.0）建立独立 monorepo，提供 gateway 插件注册与装配，将 ZCode、CodeBuddy/WorkBuddy、Qoder、AGY、Zen 迁入独立包，并完成安装默认目录与配置缺省值迁移。本计划负责包结构、plugin-api、路由/生命周期、业务装配与安装配置；转换封装与实现由独立的 [转换封装与兼容计划](../completed/llm-bridge-conversion-compatibility.md) 在 monorepo 验收后负责。后续转换目标边界为：`@agent-proxy/llm-bridge` 只封装标准 Responses、Chat Completions、Anthropic、Gemini 协议，ZCode、CodeBuddy、Qoder、Zen 通过其 `convertRequest` 接入；AGY 的 CloudCodeAssist 私有请求/响应转换由 `@agent-proxy/agy` 独立封装，不调用或依赖 `@agent-proxy/llm-bridge`，也不直接依赖外部 npm 转换库。

状态：已完成并归档（按 2026-10-11 最新确认的本轮范围）；现有协议转换保持不变。
目录边界：@agent-proxy/gateway 放在 apps/gateway，属于业务层；packages/* 放可复用转换层、契约与 agent 插件。
工作分支：codex/gateway-monorepo。
主需求：[codex-gateway-monorepo.md](../../requirements/codex-gateway-monorepo.md)。

## 本轮实施边界（2026-10-11 最新确认）

用户在实施期间明确：本轮只做 monorepo 与插件化，现有协议转换保持不变；验收 Responses endpoint 到各 agent 的转换行为与迁移前一致，确保 Codex 仍可正常调用。独立转换计划由另一个会话推进。

- S3 在 monorepo 阶段只迁移基线 agent 的请求、响应、流式、compaction 和厂商差异实现；保留现有转换实现、调用语义与依赖，不切换 `convertRequest`，也不调整转换依赖或算法。
- monorepo 验收后，由独立转换计划调整转换依赖并实施标准协议接入：`@agent-proxy/llm-bridge` 只封装 Responses、Chat Completions、Anthropic、Gemini；ZCode、CodeBuddy、Qoder、Zen 使用公共 `convertRequest`。AGY 的 CloudCodeAssist 私有请求/响应转换由 `@agent-proxy/agy` 独立封装，不调用或依赖该转换包，也不直接依赖外部 npm 转换库。
- 公开协议标识使用 `chat-completions`；现有源码中的 `from: "chat"` 仅是迁移基线。协议名规范化及其类型、插件上下文和 route 接线由 monorepo 验收后的独立转换计划统一完成，本轮不借拆包改转换算法；HTTP 路径 `/v1/chat/completions` 保持不变。
- 文中原有“等待独立转换接口/fixture 后才能迁包”“所有 agent 请求必须改走 convertRequest”及新增 Chat Completions 适配的前置门槛，以本节为准；转换依赖调整和实现属于 monorepo 验收后的独立转换交付，不阻塞本轮结构迁移。
- 本轮验收以 main `a20587d` 的 Responses 回归与本地模拟上游为基线，补充插件派发、生命周期和打包后调用验证。保留现有 Zen Chat Completions 能力，不宣称五家新增 Chat Completions 转换已经交付。
- 安装配置迁移、CLI 更名、Web UI 查询与包交付仍按本计划实施。真实发布、全局安装和真实用户配置改写不在本轮范围。

## 范围

- 包含：Bun workspace、Lerna 包发现/依赖构建、包 exports/类型/资源与发布验证。
- 包含：CLI 命令由 `codex-cliproxy` 更名为 `agent-proxy`，同步业务包 bin、帮助/错误文案、受管启动入口、UI 命令提示与使用文档；现有子命令和参数语义保留。
- 包含：@agent-proxy/llm-bridge、各 agent 包、@agent-proxy/gateway，以及已确认的独立 @agent-proxy/plugin-api 最小契约包，避免循环依赖。
- 包含：插件注册与 HTTP/WS/default、agent 包迁移与业务接线、目录/日志/配置 reload 生命周期。
- 包含：install 默认运行目录改为 `~/.agent-proxy-gateway`、旧默认安装的受管 JSON 路径迁移、五类 agent 的缺省值合并为 true；用户已有字段值不覆盖。
- 不包含：本轮调整转换依赖或实现 llm-bridge 算法、通用工具/历史 fix、Chat Completions 字段适配与协议转换 fixture；这些由独立转换计划在 monorepo 验收后实施。该计划仅封装标准 Responses、Chat Completions、Anthropic、Gemini 协议，四个标准接入 agent 使用 `convertRequest`；AGY 的 CloudCodeAssist 私有转换留在 `@agent-proxy/agy`。
- 包含：现有 CLI/Web UI、配置/身份/认证/静态文件语义的迁移回归；本轮保留现有 config 字段布局、CLI 参数、校验体系及 UI 页面与特殊交互；默认目录、agent 缺省值和对应静态 JSON Schema 按 S4 迁移，不将配置或 UI 插件化（见文末备注）。
- 不包含：沿用旧重构分支的自写完整转换器、第三方市场/自动下载、全局安装、立即发布或真实上游高频验证。

## 背景

- main 已包含 upstream-only/模型热加载；不能重新实施或回退这些行为。
- 当前是单包 codex-cliproxy-gateway；Lerna 的 packages 仅包含根目录，没有真正的 workspace 包图。
- main 的 CodeBuddy/AGY/ZCode 各有手写转换，Zen/ZCode 存在外部 llm-bridge 直接调用。后续统一接入仅覆盖 ZCode、CodeBuddy、Qoder、Zen；AGY 的 CloudCodeAssist 私有转换独立留在 AGY 包。
- 旧独立协议抽离计划已撤下；必要通用能力和回归要求并入 llm-bridge 计划，插件注册与网关生命周期由本计划承接。停止沿其手写内核/直接组合原语路线推进，不能用旧 M1–M3 完成状态证明本任务完成。
- 相关源码：src/gateway.ts、src/model-state.ts、src/model-reload.ts、src/cli.ts、src/webui.ts、各 src/agent 目录、package.json、lerna.json、构建与发布脚本。

## 关键契约

1. `@agent-proxy/llm-bridge` 是唯一直接依赖外部 llm-bridge npm 库的包，只封装标准 Responses、Chat Completions、Anthropic、Gemini 协议；ZCode、CodeBuddy、Qoder、Zen 的请求走统一 `convertRequest`，流式和解析也在封装包收口。AGY 的 CloudCodeAssist 私有请求/响应转换由 `@agent-proxy/agy` 独立封装，不调用或依赖 `@agent-proxy/llm-bridge`，也不直接依赖该外部 npm 库。
2. 转换层只识别协议，不认识 agent、客户端产品、凭据、目录、网关或 ZCode server tool。
3. 通用损失修复由桥接包负责；agent 保留显式前/后处理的服务差异，不向桥接层注入厂商 hooks。
4. 网关的路由/模型/日志核心仅消费插件契约；具体 agent 工厂由组合入口装配。Web UI 业务层可显式引用 agent 包的只读账号/来源查询导出，边界见 S4 的只读查询要求。
5. main/default 不依赖或调用 llm-bridge 转换包；CLIProxy/NewAPI 已兼容，按原协议转发并保留官方路由语义。upstreamOnly 仅属于 default，agent 开关独立。
6. 网络刷新、纯磁盘 reload、就绪和 close 分别表达，热加载不中断在途连接，保留静态/manual TOML 所有权。
7. default 与 agent 是独立出站链路，派发后固定归属：前者直接到 CLIProxy/NewAPI，后者经本地转换到 agent 服务端；失败/重试不能互相回退，npm llm-bridge 不作为网络终点。
8. 网关统一注册客户端 HTTP 入口；按注册的 `modelPatterns` 确定 agent 插件归属，再识别输入协议 `from: "chat-completions" | "responses"` 和操作 `operation: "generate" | "compact"`，交给插件的 HTTP handler。上游协议 `to` 由插件按自身服务决定；除 AGY 的 CloudCodeAssist 私有转换外，标准接入 agent 调用公共 `convertRequest(from, to, ...)`。该公开标识规范化由 monorepo 验收后的独立转换计划完成，HTTP 路径 `/v1/chat/completions` 不变。
9. HTTP（SSE 与非流式）是插件必需的基础能力，不列入能力数组。插件注册使用 `websocket` 布尔字段，默认 `false`；不使用 `capabilities.protocols` 或 `capabilities.transports` 数组。
10. WebSocket 请求匹配到 `websocket: false` 的 agent 插件时，网关在握手阶段本地返回 426，不调用插件 handler、不连接上游，也不转到 default。客户端自行决定是否回落 HTTP/SSE；Codex 的回落请求按同一模型归属到同一插件，其他客户端的自动回落取决于客户端实现。
11. `websocket: true` 必须同时提供实际 WebSocket 处理入口，不能只用布尔值宣称支持；具体入口字段和签名在 S0 定义。Realtime 仍按现有独立路由处理，并保留帧内模型路由约束。
12. `modelPatterns` 支持精确模型、固定前缀和前缀段通配，例如 `model-x`、`zcode/*`、`zcode-*/*`。前缀段中的 `*` 匹配零个或多个非 `/` 字符，不能跨段；末尾 `/*` 要求非空模型后缀，后缀作为不透明字符串保留并可含 `/`。匹配大小写敏感，不自动归一化。
13. 插件上下文保留完整 `model`，并返回声明的 `matchedPattern` 与实际 `matchedPrefix`；例如 `zcode-*/*` 命中 `zcode-team-coding-plan/model-a` 时，二者分别为 `zcode-*/*` 和 `zcode-team-coding-plan/`。`matchedPrefix` 包含实际前缀及 `/`，不能使用模式通配符之前的字面量 `zcode-`。provider/服务名等语义合法性由命中的插件校验；插件已接管后的校验错误不得回退 default。
14. 跨插件的路由优先级为精确模型 > 固定前缀模式 > 含前缀段通配模式。重复模式，以及优先级无法确定归属的跨插件重叠模式，注册时报错。

包与装配关系见需求文档的 [包依赖图](../../requirements/codex-gateway-monorepo.md#包依赖图)，default 转发与 agent 转换两条链路见 [请求处理流程](../../requirements/codex-gateway-monorepo.md#请求处理流程)。实现和验收均按这两张图的边界检查，不增加 main/default → bridge 依赖。

## 里程碑与完成门槛

### S0：main 基线与公共接口

- 固定 main a20587d，不 cherry-pick feature/protocol-conversion-m1，不拷贝其自写转换核心。
- 盘点各 agent 的注册、模型目录、启用开关与生命周期基线；协议字段和厂商转换 fixture 由独立转换计划建立，双方共同使用稳定边界契约。
- 定义已确认的 @agent-proxy/plugin-api 包契约与 HostServices，并记录转换计划的公共协议类型、`convertRequest` 返回值及流式/解析接口；这些是 monorepo 验收后的标准协议接入契约，不要求本轮切换转换调用。定下插件 `modelPatterns` 注册与匹配返回值、必需的 HTTP handler、`from` / `operation` 上下文，以及 `websocket` 默认值和实际 WS 入口签名；AGY 私有转换保持在 AGY 包内。
- 固定模型模式语法和边界：注册示例 `modelPatterns: ["zcode/*", "zcode-*/*"]`；前缀段 `*` 不跨 `/`，末尾 `/*` 要求非空且可含 `/` 的不透明后缀；明确 `matchedPattern`、完整 `model`、实际 `matchedPrefix` 的值及精确模型 > 固定前缀 > 前缀段通配的优先级。定义重复/歧义重叠注册的错误条件。
- 明确 `/v1/chat/completions`、`/v1/responses` 与 `/v1/responses/compact` 的协议/操作识别；公开输入协议名分别为 `chat-completions`、`responses`。HTTP-only 插件收到 WS 请求时的本地 426 和客户端回落归属保持不变。
- 验证依赖图无 main/agent 循环；明确 root private、包目录/版本/资源与 CLI 组合策略。
- 门槛：接口和行为矩阵可审查，基线测试可重复，不以原分支的手写实现作为新核心。

### S1：workspace 骨架与契约包

- 根 package.json 设为 private，workspaces 覆盖 apps/* 与 packages/*；撤掉 lerna.json 的 packages: ["."]，优先让 Lerna 复用 workspaces。若显式保留 packages，则必须与两个目标目录范围一致，不能遗漏 apps/gateway 或把根包继续当作产品包。
- apps/gateway 是业务应用，仍属于 workspace 包图；应用交付与库发布分别定义，不能根据 apps/packages 目录名称推断 npm 发布资格。若 gateway 通过 npm 提供 agent-proxy CLI，则纳入应用包发布；否则明确设为 private 并定义独立交付流程。仅根工具包确定为 private，其他包按明确交付策略设置 private/publishConfig。
- 建立已确认的七个库/插件包 manifest、exports、类型与资源边界，以及独立 plugin-api；转换包实现由独立计划交付，骨架建立不代表转换已完成。
- 固化转换计划交付的依赖与接口位置，允许 plugin registry/default 使用模拟插件独立验证；不在 workspace 任务中重新实现 convertRequest。
- 门槛：包图无循环，构建/类型/资源路径明确，plugin-api 可供网关与 agent 消费；转换算法与 Chat Completions fixture 仅在独立计划维护。

#### Lerna 配置与任务编排

- 核对原声明为 Lerna ^10.0.1，锁文件实际解析为 10.1.0，迁移保留实际版本，npmClient: "bun" 保留；当前 packages: ["."] 的只读 list 结果仅有原根产品包。迁移后 lerna list --all --json 必须发现七个库/插件包和 apps/gateway，不包含根工具包。
- 现 version: "0.10.0" 表示 fixed 模式，monorepo 不要求改为 independent；版本策略仍在 S0 收敛，未确认前保留现模式，不因改目录而擅自切换标签或版本体系。allowBranch: "main"、conventionalCommits 等既有发布约束可以保留。
- 根脚本改为 workspace 任务入口，各包定义自己的 build/typecheck 和必要 pack 钩子；移除 src/index.ts → 根 dist/index.js 的单包构建假设。依赖包先构建，再构建消费者；使用 Lerna/Nx 编排时显式配置 build 的 ^build 依赖及正确输出/共享输入，不把 Nx 缓存配置当成协议重构范围。
- 安装与 workspace 链接由 bun install/bun ci 管理，Lerna 负责包图、任务与版本发布编排，不恢复已移除的 bootstrap/link 命令。
- S1 验收：包发现清单与声明一致，根工具包不作为产品发布，跨包依赖/任务顺序和 Bun workspace 版本链接可验证。配置依据：[Lerna 配置](https://lerna.js.org/docs/api-reference/configuration)、[Bun 与 Lerna](https://lerna.js.org/docs/recipes/using-bun-with-lerna)。

### S2：网关插件接口与 default

- 实现插件工厂注入和 `modelPatterns` 注册，支持精确模型、固定前缀与前缀段通配；注册示例为 `modelPatterns: ["zcode/*", "zcode-*/*"]`。模式内前缀段的 `*` 只匹配零个或多个非 `/` 字符；末尾 `/*` 要求非空后缀且把后缀作为不透明字符串处理（可含 `/`）。网关返回声明模式 `matchedPattern`、完整原始 `model` 和实际完整命中前缀 `matchedPrefix`（含 `/`）；通配符不能被其前方的部分字面量替代为匹配前缀。匹配大小写敏感。
- 按精确模型 > 固定前缀模式 > 含前缀段通配模式确定派发；重复模式以及优先级不能唯一决定归属的跨插件重叠注册时报错。网关统一接收 HTTP 请求并将识别出的 `from`（chat-completions/responses）与 `operation`（generate/compact）传入插件 HTTP handler。插件按服务决定 `to`；标准协议转换接入在 monorepo 验收后的独立计划中调用公共 `convertRequest`，AGY 的 CloudCodeAssist 私有转换留在 AGY 包。候选可在派发前跳过，实际进入插件后的处理结果不得回退 default。
- 统一请求上下文、惰性正文/原字节、错误与日志归属；两条出站链路不汇合，插件的错误/重试不转入 default，default 不调用 agent 上游。
- default 内置 CLIProxy/NewAPI，按原协议转发，不调用桥接请求/流式转换；保留官方分流、OAuth 隔离、模型前缀、compaction 和 HTTP/WS 共享粘性。目录获取/合成差异不改变该转发边界。
- HTTP 是所有插件的必需入口，支持 SSE 和非流式请求；注册不使用 `capabilities.protocols` / `capabilities.transports` 数组，以 `websocket` 布尔字段表示额外的 WS 能力，默认 `false`。
- WS 请求归属 HTTP-only agent 插件时，在握手阶段本地返回 426；不得调用 HTTP handler、拨号上游或转入 default。由客户端重新发起 HTTP/SSE 请求；Codex 回落时仍由 `modelPatterns` 命中同一插件，其他客户端的自动回落行为由客户端实现决定。
- `websocket: true` 时校验实际 WS 处理入口存在；入口字段和签名由 S0 契约决定。Realtime 保持独立路由，并保留现有帧内模型路由约束。
- 保留模型刷新/reload/readiness、通知队列与快照，main 核心不导入具体 agent。
- 门槛：不装配 agent 的 default 独立可运行，测试确认转发不调用桥接包；一个模拟插件覆盖请求/目录/热加载/日志/关闭与权限矩阵，接口稳定后才迁移真实 agent。

### S3：逐包 agent 的插件契约迁移

- 各 agent 包实现统一注册、handler、catalog/refresh/reload/close 与主机服务契约，凭据和自有传输保留在各自包。
- monorepo 阶段保留各包现有转换实现、调用语义与依赖，不消费尚未交付的 `convertRequest`，也不调整转换依赖。monorepo 验收后，独立转换计划再将 ZCode、CodeBuddy、Qoder、Zen 接入标准转换包；AGY 的 CloudCodeAssist 私有请求/响应转换独立封装在 AGY 包，不接入该公共转换调用。
- 转换计划在 monorepo 验收后再修改转换依赖与调用实现；若届时需要改动同一个 agent 包，按文件串行交接，禁止两计划负责人同时修改同一文件。
- 本计划验证插件归属、模型目录、启用开关、生命周期，以及迁移前后现有转换行为不变；标准工具轮、上游方言体、私有事件与 Chat Completions/Responses 的新转换兼容由 monorepo 验收后的独立计划负责。
- 门槛：五类 agent 均由插件契约接入；包与生命周期迁移完成，现有转换回归通过，不保留旧逐厂商网关分支。后续转换计划单独验收四个标准接入 agent 与 AGY 私有转换边界。

### S4：apps/gateway 业务装配与完整迁移

- 将 CLI/Web UI/配置、受管资源与主机服务迁入 apps/gateway 的 @agent-proxy/gateway 业务应用，组合入口显式提供插件列表；应用依赖 packages，不允许 packages 反向依赖 apps/gateway。
- 保留现有配置字段布局、CLI 参数、校验体系、UI 页面与特殊交互；本阶段仅迁移默认目录/受管路径、合并 agent 新默认值并同步静态 Schema。配置 UI 继续枚举已知 agent，不做 config/UI 插件化（见[文末备注](#后续备注配置与-web-ui-插件化)）。
- 已安装的 monorepo agent 插件由组合入口在启动时显式装配，本轮不支持热安装、卸载或重新注册。模型目录 refresh、纯磁盘 config reload 与现有通知语义继续保留，但不代表插件代码热加载。
- 清除 gateway 中逐家派发、目录聚合、WeakSet 与 close；统一插件元数据和生命周期。
- 覆盖五家 dynamic/upstream-only、模型排除、静态/手动配置、网络 refresh/纯磁盘 reload、并发通知、在途流及 HTTP/WS。
- 门槛：@agent-proxy/gateway 默认能处理 CLIProxy/NewAPI；移除插件不需要编辑网关核心，已有显式 false 的插件仍保持关闭，缺失开关采用已确认的新默认值。两个零参数只读查询方法已导出并接入既有 UI API，命令切换账号后下一次查询读取更新值，作为 S4 完成条件。

#### CLI 命令更名（本轮实施要求）

- `@agent-proxy/gateway` 的 CLI bin 命名为 `agent-proxy`，替换原 `codex-cliproxy` 入口；保持 install、models、config、codebuddy、serve、web、start/stop/restart/status/uninstall 等既有子命令及参数行为。
- 同步帮助、错误与修复指引、Web UI 中账号切换等命令提示、README/使用示例、项目脚本及打包入口，使用户实际执行和展示的命令一致。历史记录中描述过去执行过的旧命令保持原文，不做全仓盲目替换。
- 安装与服务管理生成的受管启动命令/可执行路径适配新业务包与入口；既有服务身份、用户自定义脚本、环境覆盖及配置字段不因 CLI 名称变更而被重写。
- S4 完成条件包括新入口可调用，且 `agent-proxy codebuddy --switch`、`agent-proxy models --sync` 等指引使用新名称；本轮只规划，不执行全局安装或改写真实用户命令入口。

#### Web UI 账号与来源查询（本轮实施要求）

webui 后端直接导入 `@agent-proxy/codebuddy` 的 `getActiveAccount()` 与 `@agent-proxy/qoder` 的 `getActiveSources()`，在既有 `GET /ui/api/config` 路径中每次各调用一次且不传参数；HTTP 路径及 `detected.codebuddyAccountLabel`、`detected.qoderSources` 字段完全不变。导入的是方法引用，不是静态计算值；`--switch` 后下一次 UI 查询必须返回最新展示状态，不需网关重启或插件代码热加载。

方法在各自包内基于当前实例运行上下文读取配置与凭据展示状态，处理路径和账号选择；gateway 不传认证目录、`live.codebuddyAccount`、`sourceOptions`，也不解析登录来源。方法每次读取最新状态，不回退到固定全局 HOME，不永久缓存启动展示值；实例上下文的初始化细节留待实现阶段确定。保留当前账号选择和 CLI 优先于桌面来源的优先级。CodeBuddy 只解析 `.info` 并返回账号标签/地域，不返回 token；Qoder 只检查来源文件存在性，不验证 token 有效性。所有查询保持只读，不启动 adapter/server/heartbeat、不发模型请求、不刷新凭据。

保留 UI 布局、路径注入与 `codebuddyAccount` 选择；前端不直接读文件或导入后端模块。本接线属于本轮业务 UI 的方法引用要求，不新增或重命名 HTTP 接口，不新增通用 status 接口，不扩展路由/转换核心的 agent 依赖，也不做配置 UI 动态插件化。零参数导出示例：

```ts
import { getActiveAccount } from "@agent-proxy/codebuddy";
import { getActiveSources } from "@agent-proxy/qoder";

// 现有配置 API 每次请求时调用，返回字段不变
const detected = {
  codebuddyAccountLabel: getActiveAccount() ?? null,
  qoderSources: getActiveSources(),
};
```

#### 安装目录、受管路径与 agent 缺省值（本轮实施要求）

- 默认运行主目录由 `~/.codex-cliproxy-gateway` 改为 `~/.agent-proxy-gateway`，install 写入新目录的 config.json；其他命令、网关/UI 进程和受管派生文件必须使用同一个新默认目录。
- install 识别旧默认安装，先读取其配置、state、客户端备份和归属信息再合并，不能把新目录不存在当成全新安装并丢失旧用户设置。新目录已有配置优先；旧安装配置仅补新配置缺失的用户字段，最后才应用新默认值。新旧安装归属/state 冲突时保留两端文件并报可修复错误，不盲目覆盖。
- 迁移旧默认实例的受管状态、模型目录/缓存、模型覆盖文件、日志与必要运行文件；保留权限、备份和回滚材料，不自动删除旧目录。凭据文件后端的路径变更通过现有 keychain 分派存储处理，不记录或展示凭据内容。
- JSON 地址迁移使用明确字段与受管默认路径白名单：例如 catalogPath 等于旧默认派生目录文件、logDir 等于旧默认 logs/ 时，改为新默认地址；state.config 镜像同步最终配置。不能对 JSON 任意字符串全局替换，也不改自定义 catalog/log/model_merge_json 路径、远程 URL 或 $schema URL。
- `CODEX_CLIPROXY_HOME`、显式实例目录、自定义 `serve --config` 等覆盖仍优先；用户指定路径不因默认目录迁移而被改写。本轮不附带重命名环境变量或服务身份。
- macOS 的 LaunchAgent plist 仍位于 ~/Library/LaunchAgents，更新受管启动参数/日志路径及客户端 ownership 记录，识别默认实例身份，避免双服务或错误哈希后缀。~/.codex 的配置和缓存不搬入网关目录；托管 TOML 仅迁移明确受管引用，manual-codex-config 保持只读。
- zcode、codebuddy（包含 WorkBuddy）、qoder、agy、opencodeZen 的默认值均为 true；采用缺失字段合并，优先级为已有用户字段 > 新默认值。显式 false 仍为 false，不用 `value || true` 或强制赋值覆盖，不因修改默认值而批量重写存量配置。
- CLI、网关、Web UI 和插件初始化共同消费有效配置；调整安装 DEFAULTS、Schema 默认与说明、类型注释及配置同步中的硬编码 false，防止缺失值在某条读取路径仍被视为关闭。新安装保存合并后的默认值；存量配置按缺失项形成有效默认，已有字段和未知字段保持原样。
- 缺省启用只作用于显式装配的已安装插件，不自动下载、装配未声明插件或创造凭据；无登录、无可用目录时保留既有可诊断行为，不能把默认值变化变成全体服务启动失败。
- 完成门槛：默认目录迁移及失败回滚可重复验证；旧默认地址按白名单更新，自定义地址/用户开关/未知字段保留；所有读取路径的五类缺省值一致为 true。

### S5：包构建、发布模拟与最终验收

- 校验每包 exports、JS、类型与静态资源，以及业务包 `agent-proxy` bin 的目标和可执行入口；禁止跨包源码相对引用或依赖未发布资源。
- 按依赖顺序构建与 pack，在空白临时项目安装本地产物执行 CLI/default 与插件冒烟，不依赖仓库内部路径。
- 按本轮包目录、运行目录和默认值变化同步 README、Schema、配置迁移指引与 release 命令；保留既有用户配置/CLI/UI 行为，不把配置或 UI 插件化作为交付门槛（见[文末备注](#后续备注配置与-web-ui-插件化)）。发布包名迁移另行说明。
- 同步 Deploy/release-check 的 workspace 构建与产物检查入口；审查 paths-ignore 和 Lerna ignoreChanges，当前 .github/**、scripts/**、lerna.json 的忽略不能使影响构建/产物的迁移变更漏检或漏发。文档/纯测试是否触发版本继续按明确策略处理，不把所有文件变更都强制发版。
- 检查根 preversion/version/prepack 与各子包钩子的职责，避免每个子包重复执行全仓 check；打包前明确构建目标和依赖，不依靠包级生命周期自动替其他包构建。现自定义 changelog 固定写入/暂存根 CHANGELOG.md，多包后需明确统一或包级日志，并验证版本钩子不会重复写同一文件。
- 每个拟公开发布的 @agent-proxy/* 包独立设置 publishConfig.access: public、files/exports/bin 和可发布依赖版本；不依赖根 publishConfig 自动继承。验证 workspace: 依赖在打包后转换为可安装版本，应用目录位置不构成发布排除规则；真实发布仍需用户明确要求。
- 通过静态依赖检查、单元/金样本/本地服务/打包检查与总 check；记录真实变更历史后归档。
- 仅用户明确要求发布时才执行发布；本计划中的本地打包检查不是发布授权。

## 并行调度与写入边界

- S0 的插件/安装行为矩阵、包图与交付调研可并行；库能力/转换 fixture 调研属于独立转换计划。
- S1 workspace/构建负责人拥有根工具配置与各包 manifest；独立转换计划负责人拥有转换包实现和协议 fixture。先交付包骨架与边界，再推进转换实现，避免同时改 manifest。
- S2 依赖公共接口确定，由一位集成负责人拥有 plugin-api、registry、default/main 核心；不让多个 agent 同时修改 gateway。
- S3 各 agent 的独立包可在插件接口稳定后并行迁移，按基线保留转换依赖与行为；monorepo 验收后再由转换计划调整依赖和调用，涉及同一包时顺序交接。
- S4/S5 集成与发布验证串行；各家复核测试可以独立运行，任何一轮后台测试最多 60 秒。

## 风险与缓解

- 转换交付未就绪：本轮以基线转换实现接入真实 agent 并验证行为不变；monorepo 验收后再由独立转换计划实施标准协议接入和转换兼容验收。AGY 的 CloudCodeAssist 私有转换始终由 AGY 包独立封装。
- 厂商特性下沉：转换包不得出现 agent 导入/类型/名称选择，不承接 server tool 执行、签名或 wrapper。
- 包依赖循环：采用最小契约包，agent 不依赖 gateway；模型插件工厂只在 bootstrap 装配，业务 Web UI 的只读查询引用按 S4 要求处理，不进入路由/转换核心。
- 安装迁移丢用户配置：先识别旧默认安装和 ownership，白名单迁移受管路径，默认值只补缺失字段，覆盖新旧并存、显式 false、自定义路径及失败回滚。
- 生命周期丢失：重载与刷新分离，覆盖 startup/热加载/取消/close，保证只创建一套会话状态与计时器。
- workspace 假成功：每包 pack 后在空白环境验证 exports、类型与资源，不能只跑 workspace 内源码。
- 分支污染：固定 main 基线与隔离工作区，保留旧分支；新源码与历史不复用旧计划的完成结论。

## 验证方式

- 依赖：本轮保留基线转换依赖与调用；agent 不 import main，main 核心不 import agent 或桥接转换包。monorepo 验收后的依赖目标为仅 `packages/llm-bridge` 直接依赖外部 llm-bridge npm 库；标准协议 `convertRequest` 只由 ZCode、CodeBuddy、Qoder、Zen 使用，AGY 的 CloudCodeAssist 转换留在 `@agent-proxy/agy` 内且不依赖外部转换库。default 仅转发兼容协议。
- 协议交付：本计划验收迁移前后的转换行为不变；独立转换计划在 monorepo 验收后实施并验收标准协议接口、兼容矩阵及 AGY 私有转换边界，不把该后续交付作为本轮通过条件。
- 插件：验证 `modelPatterns: ["zcode/*", "zcode-*/*"]` 的固定/通配前缀、动态 provider 前缀和不透明后缀；`*` 不跨前缀段，`/*` 拒绝空后缀。`othercode/foo` 与没有 `/` 的 `zcode-team` 不匹配；空 provider 等服务语义由命中插件校验，校验失败不得回退 default。断言 `matchedPattern`、完整 `model`、含 `/` 的实际 `matchedPrefix`，并覆盖大小写敏感、精确模型 > 固定前缀 > 通配前缀、重复模式、歧义重叠注册、派发前候选筛选及 HTTP/WS 一致归属。另验证 Chat Completions/Responses 与 generate/compact 上下文、HTTP/SSE/非流式入口、WS 实际处理入口校验、HTTP-only 的握手期本地 426（handler/上游/default 调用次数均为零）及客户端回落后的同插件归属；保留 Realtime 独立路由和帧内模型路由。并覆盖 OAuth/脱敏与本地 404；模拟上游证明两条链路错误/重试不互相调用。
- Web UI config API：验证现有 `GET /ui/api/config` 路径及 `detected.codebuddyAccountLabel`、`detected.qoderSources` 字段不变；每次请求零参数调用 `getActiveAccount()` / `getActiveSources()`，并在 `--switch` 后下一次查询体现最新状态。确认网关不传认证目录、账号选择或来源选项，不做登录来源解析；包内查询使用当前实例上下文、不固定全局 HOME、不缓存启动值，并保留现账号选择和 CLI 优先级。保持 UI 布局、路径注入和 `codebuddyAccount` 选择；无 adapter/server/heartbeat 启动、模型请求、凭据刷新或 token 返回；Qoder 仅检查来源文件存在。确认前端不读文件或导入后端模块，不新增通用 status API。
- agent 装配：注册、启用、目录和生命周期保持基线；本轮转换行为保持迁移前一致。monorepo 验收后，独立转换计划负责四个标准接入 agent 的请求/响应与厂商转换 fixture，并单独验证 AGY 私有转换，包拆分不得静默丢失服务能力。
- 模型与配置：static/dynamic、仅 agent 目录、排除、纯磁盘 reload、就绪、手动 TOML、并发回执与在途连接。
- 安装迁移：全新/旧默认独存/新旧并存/重复 install/失败回滚；受管 JSON 地址与 state 镜像一致、自定义路径及 env/--config 优先级不变、ownership 与服务指向一致。五类 agent 缺失字段合并 true，已有 false/true/账号选择/未知字段保留，CLI/网关/UI/Schema 一致；任何测试只用临时实例，不修改真实用户配置。
- 包：逐包构建/类型、资源、本地产物安装与 CLI 测试；每个阶段相关检查通过后执行总 check。
- Lerna/发布编排：只读 list 验证八个 workspace 包和根工具包排除；在隔离临时仓库验证 fixed/independent 的已选策略、锁文件与包间依赖更新、changelog 和生命周期钩子。CI 覆盖 workspace 构建、受影响构建脚本/发布配置和本地产物检查，本轮审计不执行 version/publish。
- CLI 更名：在空白临时环境验证打包后的 `agent-proxy --help`、非破坏性命令和既有子命令参数解析，确认入口不依赖仓库源码；检查当前帮助、UI 指引及受管启动路径一致，install/服务管理测试使用临时实例。
- 本轮文档：检查包名、交叉引用、需求与计划一致性；不宣称已完成源码重构。

## 进度记录

- [x] 确认用户要求基于 main 建立新方案，保留旧重构分支。
- [x] 创建隔离工作区与 codex/gateway-monorepo 分支，基线 a20587d。
- [x] 建立桥接封装、包职责、插件注入及特殊兼容需求。
- [x] S0 公共 API、包图与完整行为矩阵收敛。
- [x] S1 workspace 骨架与独立 plugin-api 契约包。
- [x] S2 gateway 插件接口与 default。
- [x] S3 各 agent 包的插件契约与生命周期迁移，保留现有转换行为；标准转换接入留待 monorepo 验收后的独立计划。
- [x] S4 apps/gateway 装配、agent-proxy 命令更名、零参数只读查询与安装目录/默认值迁移。
- [x] S5 打包验收、文档、历史与归档。

## 决策记录

- 2026-10-10：用户明确转换层必须基于 llm-bridge 增量修复，agent 只消费公共转换接口；此前手写原语抽离路线不作为新实施目标。（2026-10-11 后续决定对 AGY CloudCodeAssist 私有转换作出例外。）
- 2026-10-10：用户指定 @agent-proxy/llm-bridge、各 agent、@agent-proxy/gateway，agent 兼容以插件注入。
- 2026-10-10：用户要求以 main 为基础；新工作区基于 a20587d，旧分支及未提交改动保持原状。
- 2026-10-10：用户明确 @agent-proxy/gateway 属于业务层，不放 packages；workspace 同时覆盖 apps/* 与 packages/*，应用目录采用 apps/gateway，业务应用交付与可复用库发布分别管理。
- 2026-10-10：用户明确 CLIProxy/NewAPI 已兼容客户端协议，default 不走 llm-bridge；移除 main 核心对转换包的直接依赖，保留原有认证/模型名/传输/compaction 业务兼容。
- 2026-10-10：用户明确两条出站链路最终不重叠；请求流程以 agent 服务端和 CLIProxy/NewAPI 为各自终点，依赖的 npm llm-bridge 仅为本地转换库，派发后不再跨链路回退。（2026-10-11 后续决定对 AGY CloudCodeAssist 私有转换排除该转换依赖。）
- 2026-10-10：确认插件注册由 `modelPatterns` 决定模型归属；网关识别公开输入协议 `from`（`chat-completions`/`responses`；当时源码基线名为 `chat`）与 `operation`（generate/compact）后调用插件必需的 HTTP handler，插件决定上游 `to` 并使用公共 `convertRequest`。（该通用转换调用对 AGY 的例外见 2026-10-11 决策。）HTTP 支持 SSE/非流式；WS 用默认 `false` 的 `websocket` 布尔字段声明，HTTP-only 插件在握手期本地返回 426，由客户端自行回落 HTTP/SSE；`websocket: true` 还必须提供真实 WS 处理入口，具体签名在 S0 定。Realtime 独立路由与帧内模型路由约束保留。
- 2026-10-10：确认 `modelPatterns` 支持 `zcode/*` 与 `zcode-*/*`；前缀段通配符只匹配该段内非 `/` 字符，尾部 `/*` 匹配非空、不透明且可含 `/` 的模型后缀。`matchedPattern` 返回声明模式，`matchedPrefix` 返回包含 `/` 的实际完整前缀，完整 model 原样保留；模式大小写敏感。路由按精确模型、固定前缀、前缀段通配排序，重复及无法确定归属的跨插件重叠注册报错；命中后的 provider/service 校验错误不回退 default。
- 2026-10-10：命名调整为 `@agent-proxy` namespace，业务包名为 `@agent-proxy/gateway`，应用目录确认为 `apps/gateway`。其他 package 目录、执行计划文件名和工作分支名保持不变。
- 2026-10-10：用户确认采用独立的 @agent-proxy/plugin-api 最小契约包，目录为 packages/plugin-api，纳入本轮实施与验收范围，避免网关与 agent 循环依赖；发布/交付策略在 S0 收敛，不再讨论是否采用或最终包名。请求、流式与解析均收口到桥接包，不把 agent 类型传入公共转换核心。

- 2026-10-10：拆出 [llm-bridge 封装、兼容与 Chat Completions 适配计划](../completed/llm-bridge-conversion-compatibility.md)，承接转换算法、agent 转换调用适配和旧 Chat Completions 计划的适配/测试；本计划专注 monorepo、插件与安装配置迁移。（其转换范围由后续决策细化，AGY CloudCodeAssist 转换留在 AGY 包。）
- 2026-10-10：install 默认运行目录确认改为 ~/.agent-proxy-gateway；旧默认 JSON 地址按受管白名单迁移。五类 agent 缺省值合并 true，已有用户字段（含 false）保留，不通过改默认值重写用户选择。
- 2026-10-11：独立协议抽离计划弃用并撤下；转换/解析/流式事件等通用需求转交 llm-bridge 计划，本计划继续负责插件与网关业务生命周期，不新增第三份实施计划。
- 2026-10-11：用户确认 CLI 命令由 codex-cliproxy 改为 agent-proxy；纳入 S4 的业务装配与 S5 打包验收，保留既有子命令/参数语义，同步当前帮助、UI 提示和受管启动入口。
- 2026-10-11：Lerna 审计确认现单根包配置可用，但 monorepo 必须调整 packages/workspaces、根 private、任务编排及发布/CI 钩子；npmClient: bun 可保留，版本模式不擅自改变。业务应用的目录分类与 npm 交付资格分开判断，S1/S5 记录相应验收。
- 2026-10-11：用户确认 monorepo 验收前不调整转换依赖或实现，按基线保留现有转换行为；验收后由独立转换计划推进依赖调整与标准协议接入。`@agent-proxy/llm-bridge` 只封装 Responses、Chat Completions、Anthropic、Gemini；ZCode、CodeBuddy、Qoder、Zen 使用 `convertRequest`。AGY 的 CloudCodeAssist 私有请求/响应转换归 `@agent-proxy/agy` 独立封装，不调用或依赖 `@agent-proxy/llm-bridge`，也不直接依赖外部 npm 转换库。此前适用于所有 agent 的统一转换调用表述已被覆盖。
- 2026-10-11：用户确认公开协议标识使用 `chat-completions`；现有 `from: "chat"` 为源码基线。类型、插件上下文和 route 接线的协议名规范化由 monorepo 验收后的独立转换计划统一完成，monorepo 本轮保留转换算法，HTTP 路径 `/v1/chat/completions` 不变。

## 实施结果与交接（2026-10-11）

- S0/S1：公共契约和行为矩阵见 [插件契约](../../plugin-contract.md)；八个 workspace 全部被 Lerna 发现，根 private，fixed 0.10.0 不变。库公开 JS/类型/资源与 app CLI 均通过空白消费者验证。
- S2/S3：网关、模型状态、Realtime 的传递依赖仅消费 plugin-api；五家工厂在组合入口显式装配。现有请求/响应/流式转换迁包保留，default 不依赖或调用桥接包；新 convertRequest 与新增 Chat Completions 转换仍由独立计划负责。
- S4：CLI 更名、两项零参数只读查询、默认目录/旧安装状态与 ownership/受管 plist 迁移、五类缺省值全部接线。显式 false、自定义路径、手动 TOML、未知字段及原始字节回滚受测试保护；缺省启用但无登录时 default 与其它插件仍可就绪。
- S5：统一检查最初为 936 项测试通过、0 失败；发布检测测试增补后，审核复跑完整测试为 939 项通过、0 失败（67 个文件）。另有发布编排 7 项定向测试通过。根与各包严格类型、八包构建、静态传递依赖检查、空白消费者严格声明类型检查和本地产物 CLI/default/五家转换冒烟通过。
- 隔离 fixed 版本模拟验证包版本、锁文件、根钩子次数、统一 CHANGELOG 版本与共享根构建输入检测；没有在产品仓库执行 version/publish，也没有全局安装或改写真实用户配置。
- [迁移指引](../../monorepo-migration.md) 与 [变更历史](../../histories/2026-10/20261011-1350-gateway-monorepo-migration.md) 记录实际行为、验证及变更统计。请求转换算法未在本轮重新设计，不以此归档宣称独立转换计划完成。

## 后续备注：配置与 Web UI 插件化

本轮保留现有 config 字段布局、CLI 参数、校验体系及 UI 页面和特殊交互；S4 的默认运行目录、受管地址和 agent 缺省值调整属于已确认迁移范围，静态 JSON Schema 随之更新。此前讨论的 `config.schema`、`defaults`、`cli`、`ui` 插件声明，以及迁移到 `plugins.<id>` 的嵌套配置，只是后续候选，不作为本轮实施门槛。UI 特性和特殊交互较多，配置与 UI 插件化需要另行设计；本轮配置 UI 继续枚举已知 agent。

已安装的 monorepo agent 插件在 gateway 启动时由组合入口显式装配。本轮不支持热安装、卸载或重新注册插件。现有模型目录 refresh、纯磁盘 config reload 与 reload 通知语义继续保留，但这些语义不等于插件代码热加载。

本计划重点是 monorepo、插件注册与装配、安装配置迁移，不趁迁移扩展为通用配置/UI 插件化。monorepo 验收后，独立计划封装标准 Responses、Chat Completions、Anthropic、Gemini 协议并接入 ZCode、CodeBuddy、Qoder、Zen；AGY 的 CloudCodeAssist 私有转换留在 `@agent-proxy/agy`。后续若启动配置/UI 插件化，再单独定义声明方式、`plugins.<id>` 迁移、兼容策略和验收门槛。
