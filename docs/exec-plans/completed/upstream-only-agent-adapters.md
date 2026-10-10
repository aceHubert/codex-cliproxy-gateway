# upstream-only 与 agent 插件的请求路由边界

## 目标

沿用 `protocol-conversion-extraction.md` §6 的 agent 插件与 default 分层，让 upstream-only 模式保留所有显式启用的 agent 请求通道。`upstreamOnly` 是已保存配置中的只读路由输入，仅由 default 解释；agent 插件不因该标记改变注册、启用、转换或认证行为。

状态：已完成并归档，bun run check 通过（类型检查、885 项测试、UI/CLI 构建）。本轮沿现有分派顺序落实插件/default 的语义边界，未实现新注册器。命令、模型热加载与 Codex 配置由 [独立执行计划](model-config-reload-and-cli-ownership.md) 承担。

## 范围

- 包含：ZCode、CodeBuddy/WorkBuddy、Qoder、AGY、OpenCode Zen 的请求启用判定、插件/default 分派以及 HTTP/WS 路由边界。
- 包含：保留已有认证、保留前缀、环回监听、模型排除、入口能力与错误归属。
- 不包含：CLI 参数迁移、配置写入、reloadConfig、模型目录刷新/定时器、静态目录合成、Codex TOML 与进程重载；这些由独立执行计划负责。
- 不包含：新增 agent WebSocket 协议、外部插件加载器、凭据刷新或新增厂商转换逻辑。

## 背景（实施前）

- 各适配器的 `*Enabled()` 当前要求 `upstreamOnly !== true`，导致开启 upstream-only 时 agent 通道整体禁用，并跳过对应安全校验。
- `protocol-conversion-extraction.md` §6 已定义 agent 前缀注册表与 default：agent 优先匹配，default 内部选择第三方代理或官方。
- 当前 upstream-only 通用分支可直接转发第三方上游。解除 agent 启用限制后，必须确保插件先处理自己的入口，错误和拒绝不能再次落入 default。
- 相关代码：`src/gateway.ts`、各 agent 的 `src/*/index.ts` 与对应请求路由测试。
- 相关计划：[协议转换与插件拆分](../active/protocol-conversion-extraction.md)、[命令职责与配置热加载](model-config-reload-and-cli-ownership.md)、[Chat Completions 入口](../active/openai-chat-completions-endpoint.md)。

## 行为约定

### 配置消费与职责

- 请求处理只消费已加载的配置，不负责更改模式或配置管理流程。
- `upstreamOnly` 不再参与 agent 启用判定；每个 agent 仍由自身开关控制，不默认开启全部 agent。
- 仅 default 根据 `upstreamOnly` 判断目标：为 true 时交给第三方上游；为 false 时沿用配置前缀、hint 与粘性选择第三方代理或官方。
- 第三方代理由 `upstreamType` 选择 CLIProxy 或 NewAPI；CLIProxy、NewAPI 与 official 都是 default 的内部处理器，不加入 agent 前缀注册表。
- agent 始终保留自身模型前缀；upstream-only 下 default 的上游模型使用裸 ID。
- 模型配置如何更新和生效由独立计划的 reloadConfig/重启流程提供；本计划不另建配置读取、文件监听或控制接口。

### 请求分派

```text
请求 → 公共安全与传输边界 → agent 插件匹配
                           ├─ 已处理 → 返回插件结果
                           └─ 未处理 → default
                                      ├─ upstreamOnly=true → 第三方上游
                                      └─ upstreamOnly=false → 现有代理/官方选择
```

- 本轮沿既有 agent 分派顺序落实相同的插件/default 语义，不建立另一套 upstream-only 分派器。`register(prefix, fn)` 与 `setDefault()` 的注册器提取由协议拆分计划后续实现，不能将本轮分派变更描述为新注册器已完成。
- 保留 body model 与 routing hint 的既有优先级、大小写行为、别名结果、动态 ZCode 前缀和重叠前缀优先级。
- 插件成功、转换失败、凭据错误、排除与入口拒绝都是已处理结果，直接返回；仅保留协议拆分计划明确允许的 decline。
- 不因为 upstream-only 将插件失败重试到第三方上游，不重复消费正文，不改变插件错误归属。
- 不能只依据目录是否列出模型决定请求归属，目录外模型继续按既有通道规则处理。

### 安全与传输边界

- 环回监听、保留前缀、认证与凭据隔离校验按真实启用状态执行，不能因 upstream-only 跳过。
- 进入第三方代理前移除 ChatGPT OAuth 和其他不属于目标的认证；agent 维持自身凭据消费规则。
- 模型排除保持只作用于本地 agent；消费运行时当前过滤规则，规则发布与热加载归独立计划。
- agent 的 HTTP-only 能力检查先于 default 的 WebSocket 拨号；保留本地 426/降级协商及 marker。
- Responses WS 不仅在握手时检查，还要保留帧内模型变化的通道边界；不能将 agent 模型帧误转到第三方上游。
- mountPath 子树外、本地 /ui、健康检查与 Realtime 独立分流沿用现有公共边界。
- 默认路由保持 HTTP 正文字节处理、OAuth 隔离、compaction、WS 与线程/turn 粘性的现有行为；只改变 upstream-only 与 agent 互斥的判定。

## 风险

- 风险：只放开启用判定，但插件请求仍被 upstream-only 通用分支先转发。
  - 缓解：验证 agent 先于 default 处理，覆盖 Responses、compact、Chat 与 HTTP-only WS 协商。
- 风险：原本保存但不生效的 agent 开关开始生效，而监听地址或前缀不满足要求。
  - 缓解：在启动与配置提交前执行真实启用校验，错误给出明确修复指引。
- 风险：插件迁移改变错误回退、hint/body 冲突或前缀匹配结果。
  - 缓解：复用协议拆分的行为矩阵；插件已处理结果不进入 default。
- 风险：把命令热加载与路由调整捆绑，导致重复配置状态或职责混杂。
  - 缓解：本计划仅消费运行时配置和目录契约，更新与发布由独立执行计划负责。

## 里程碑

1. 对齐协议拆分计划 §6，固化两种 upstreamOnly 状态下的插件/default 行为矩阵。
2. 移除 agent 对 upstreamOnly 的启用依赖，完成安全校验与请求分派。
3. 覆盖 HTTP、WS、认证、错误归属及默认路由回归。
4. 与独立命令计划联调，完成历史记录并归档。

## 验证方式

- 两种 upstreamOnly 状态下，各 agent 的注册、启用、转换、认证与错误结果一致。
- 未命中插件的请求在 upstreamOnly 为 true 时只进入第三方代理；为 false 时维持原前缀/hint/粘性行为。
- 上游模型裸 ID、agent 自身前缀与别名不被额外改写。
- 插件拒绝和凭据错误不重试到 default，正文只读取一次。
- 本地排除规则在目录与推理入口一致生效，上游与官方不被误排除。
- HTTP-only agent 的 WS 握手/帧不进入第三方代理，保留既有协商结果。
- mountPath、/ui、Realtime、OAuth 移除及 compaction/WS 粘性回归。
- 模式配置由命令计划更新；本计划不写 upstreamOnly、不负责启动模型刷新或重载 Codex。
- 单元测试单次执行上限 60 秒；实现提交前运行 `bun run check`。

## 进度记录

- [x] 完成当前启用判定、HTTP/WS 分派和安全边界的只读分析。
- [x] 确认 upstream-only 路由语义仅属于 default，agent 插件独立运行。
- [x] 拆出命令、配置热加载、目录刷新与 Codex 配置计划。
- [x] 保持协议拆分的插件/default 语义，移除 agent 对 upstreamOnly 的启用限制并调整现有路由。
- [x] 保持 HTTP-only agent 的 WS 协商、错误归属、前缀与认证安全边界。
- [x] 完成最终全量验证与独立命令计划联调：bun run check，885 项测试通过。
- [x] 记录实现历史并归档。

## 决策记录

- 2026-10-10：upstream-only 保留显式启用的 agent；其路由含义仅由 default 解释，agent 不因该标记被禁用。
- 2026-10-10：按用户进一步划分，本文件仅负责读取配置后的请求逻辑；此前命令迁移、目录更新及 Codex 重载决策迁入 `model-config-reload-and-cli-ownership.md`，不作为本计划的实现任务。
- 2026-10-10：两份计划分别验收，共享插件/default 配置与目录契约；不要求命令修改依赖请求路由变更才能推进。
- 2026-10-10：实施使用现有路由分派顺序，先处理显式启用 agent，再由 default 读取 upstreamOnly；未提前提取协议计划的 register/setDefault 注册器。
