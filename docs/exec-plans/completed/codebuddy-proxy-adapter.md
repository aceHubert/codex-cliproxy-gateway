# CodeBuddy/WorkBuddy 协议转换代理层

## 目标

照 `src/zcode/` 的协议转换适配器模式新增 CodeBuddy/WorkBuddy 入口：读取本机已登录客户端的 `.info` 凭据，按 profile 路由到腾讯官方 `/v2/chat/completions`，用 llm-bridge 完成 Codex Responses ↔ OpenAI Chat 双向转换，以 `codebuddy/`、`workbuddy/` 前缀族分流，`codebuddy:boolean` 开关启用，默认关闭。

## 范围

- 包含：
  - `src/codebuddy/` 新模块：credentials（`.info` 读取 + profile 判定 + 热更新）、catalog（`/v3/config` 拉取 + 指纹缓存）、request（Responses → OpenAI Chat）、response（OpenAI SSE → Responses SSE）、request-context（CLI/WorkBuddy 身份头）、index（门面 `catalog() + forward()`）。
  - `gateway.ts` 挂载：`codebuddyModelFamily` 前缀识别、`/v1/responses` 与 `/v1/responses/compact` 拦截分流、目录合并进 `/v1/models`、`validateCodebuddyConfig` 环回约束与保留前缀校验；`codebuddyEnabled(config) === (config.codebuddy === true && config.upstreamOnly !== true)`，语义与 `zcodeEnabled` 一致。
  - `types.ts` 新增 `codebuddy?: boolean`；`schemas/gateway-config.schema.json` 同步字段；`config-update.ts` 支持 `config --codebuddy on|off`（`SUPPORTED_PATCH_FIELDS` 增补 `codebuddy`、布尔校验），复用现有配置写入/状态/审计链路。
  - Web UI 开关：`src/ui/ConfigPage.tsx` 增加 codebuddy 复选框（对齐 zcode 开关的 `field-keyname` 展示模式；`upstreamOnly === true` 时开关禁用只读并显示不生效提示，照 `zcodeDisabledHint` 模式新增中英文案）、`src/ui/api.ts` 补 `ConfigState.codebuddy` 与补丁类型、`src/webui.ts` live 状态暴露 `codebuddy: live.codebuddy === true`；UI 每请求重读 config.json，开关保存后无需重启 UI 进程；改动 UI 后须重跑 `bun run build:ui`。
  - `test/` 新增专项测试：profile 判定、凭据热更新、协议转换、前缀路由、错误码、脱敏。
- 不包含：
  - 不做 OAuth 浏览器登录流程（只消费本机已登录凭据；登录入口留作后续）。
  - 不做网关侧 token 主动刷新（见「决策记录」；刷新冲突问题先规避而非解决）。
  - 不做多账号池、积分查询、签到、Buddy 任务等 codebuddy2api 的运营功能；本网关只做协议转换。
  - 不做动态端点重映射（4 个 profile 端点固定，无 `proxyEndpoint.mapping` 机制）。
  - 不改 `mountPath` 白名单语义、不重启网关、不提交或发布；Web UI 仅新增开关本身，不做 CodeBuddy 模型目录管理或凭据管理页面。

## 背景

- 相关文档：`README.md`（ZCode 章节为行文范例）、`AGENTS.md`（安全与边界约束）、`docs/exec-plans/completed/zcode-responses.md`（前序同类计划，模式参照）。
- 参考项目：`maiphucgiang/codebuddy2api`（Python 实现，已分析其站点路由、OAuth、刷新、身份头与目录接口）。
- 相关代码路径：
  - `src/zcode/` — 完整适配器模式（config 缓存、目录、端点路由、请求上下文、翻译、门面）。
  - `src/gateway.ts:740-768` — ZCode 拦截分流挂载点；`:693-734` mountPath 白名单与边界。
  - `src/keychain.ts` + `src/credentials-store.ts` — 凭据后端平台分派（darwin → Keychain，其余 → 0600 原子写文件）。
  - `schemas/gateway-config.schema.json:103` — `zcode` 字段范例。
- 已知约束：
  - 凭据不得出现在日志、Web UI 或任何 API 响应中；错误正文脱敏需覆盖 accessToken 与 refreshToken 两种 token 的多种 JSON 转义形式（照搬 `zcode/index.ts` 的 `redact` 实现）。
  - 凭据存取走 `credentials-store.ts` 的文件后端范式（`.info` 本身即文件后端，不进 Keychain），0600、原子写。
  - `webui.ts` 的依赖树不得反向引用 `cli.ts`；共享逻辑独立成模块。
  - 改 config 字段必须同步 schema 与测试。
  - CodeBuddy/WorkBuddy 上游端点固定白名单：`copilot.tencent.com`、`www.codebuddy.cn`、`www.codebuddy.ai`、`www.workbuddy.cn`、`www.workbuddy.ai`，全部 https，不接受任意 URL（防 SSRF）。
- 本机现状（已核实）：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info` 为国际版 CodeBuddy（`domain: www.codebuddy.ai`，Keycloak issuer `https://www.codebuddy.ai/auth/realms/copilot`，个人账号），accessToken/refreshToken 有效期至 2027-02-26（2026-09-18 复核：JWT iat 2026-09-17T10:18Z、exp 2027-02-26T03:16Z，单次签发约 162 天、剩余 161 天，`auth.expiresAt` 与 JWT `exp` 一致）；CLI `@tencent-ai/codebuddy-code` v2.151.0 与桌面扩展共用该文件且在活跃刷新。

## 风险

- 风险：**刷新冲突** —— 本机 CLI 持续刷新同一 `.info`，若网关也刷新会互相使 refreshToken 失效，导致 CLI 登录态或网关凭据静默过期。
  缓解：首期网关侧**只读不刷**（凭据有效期 161 天，足够覆盖验证期）；请求前按 `expiresAt` 判定，临近过期返回带修复指引的 503 而非静默失败；刷新策略留作后续债务。
- 风险：**凭据泄露** —— accessToken/refreshToken 进入请求日志、错误正文或 `/v1/models` 响应。
  缓解：照搬 ZCode 的 `redact`/`redactValue` 双 token 脱敏；目录与响应只携带模型元数据；测试专门覆盖错误正文转义形式。
- 风险：**profile 误判** —— `domain` 与 JWT `iss` 冲突，或未知域名导致路由到错误站点。
  缓解：`profileForAuth` 双源校验、冲突拒绝、未知域名拒绝（照搬 codebuddy2api 的 `site_routing.py` 语义）；错误信息给出可执行修复方式。
- 风险：**协议转换不完整** —— OpenAI Chat 的 `reasoning_content`、`tool_calls`、`refusal` 与 Codex Responses 的 output items 不是一一对应。
  缓解：llm-bridge 的 `universalToOpenAI`/`parseOpenAIStream`/`emitOpenAIResponsesStream` 已覆盖主路径；用真实响应回放构造测试夹具；不支持的块显式降级并在日志标注，不静默丢弃。
- 风险：**版本漂移** —— 伪装的 CLI 版本（2.149.0）与本机实际（2.151.0）不一致，影响目录缓存键或上游鉴权。
  缓解：版本号集中为常量并从 `package.json`/探测获取，单一来源；缓存键带版本但变更不影响已有凭据。

## 里程碑

1. 范围与接口收敛：确认前缀族、开关语义、profile 枚举、凭据只读策略。
2. `src/codebuddy/credentials.ts`：`.info` 读取、profile 判定、mtime/inode 热更新、过期判定；损坏与符号链接不回退。
3. `src/codebuddy/catalog.ts`：`/v3/config` 拉取（`catalog_headers`，CLI profile 加 `x-client-platform: cli`，WorkBuddy profile 严禁加）、serves scope 交集、双指纹缓存（source_hash + content_hash）、前缀目录投影、倍率并入 display_name（`Auto (x0.79)`、x0 显示 `(free)`）。
4. `src/codebuddy/request.ts` + `response.ts` + `request-context.ts`：llm-bridge 双向转换、身份头、会话上下文。
5. `src/codebuddy/index.ts` 门面 + `gateway.ts` 挂载 + `types.ts`/schema/`config-update.ts` 开关。
6. 测试、`bun run check`、README 与 history 收尾。

## 验证方式

- 命令：`bun run check`（类型检查 + 全部测试 + 构建）必须通过；新增测试以临时目录、虚构凭据与模拟上游编写，不触碰真实 `.info`、不发起真实外网请求（fetch 仅允许环回，照 ZCode 测试约束）。
- 手工检查：`codex-cliproxy config --codebuddy on` 后 `GET /v1/models` 出现 `codebuddy/` 前缀模型；以 `codebuddy/<model>` 走 `--profile` 请求 `/v1/responses`，确认路由到 `www.codebuddy.ai/v2/chat/completions` 且 SSE 正常；`config --codebuddy off` 后入口关闭。
- 验收调用（Responses API → `gpt-5.6-luna`）：启用开关后直接向网关发一次非流式 Responses 请求，模型用 `codebuddy/gpt-5.6-luna`（本机 intl-cli 账号 serves 目录内、倍率 x0.14 最低、CLI 当前默认模型，验收成本最小）：

  ```bash
  curl -s http://127.0.0.1:<port>/v1/responses \
    -H "authorization: Bearer <网关 API key>" \
    -H "content-type: application/json" \
    -d '{"model":"codebuddy/gpt-5.6-luna","input":"用一句话介绍你自己","stream":false}'
  ```

  通过标准：响应为合法 Responses JSON（`status:"completed"`，`output` 含 message/text 条目）；请求日志显示上游 `https://www.codebuddy.ai/v2/chat/completions`、`model` 透传为裸 `gpt-5.6-luna`（前缀剥离、无档位展开）；日志无 accessToken/refreshToken 明文。随后以 `stream:true` 复验一次 SSE 事件序列（`response.created` → 增量 → `response.completed`）。此调用消耗真实积分（x0.14 倍率的一次请求），不在自动化测试中执行。
- 观测检查：请求日志中不得出现 accessToken/refreshToken 明文（含转义形式）；错误正文经脱敏；未启用时不建缓存、不拦截请求；`upstream-only` 模式下整体禁用（不建凭据/目录缓存、不拦截请求，Web UI 开关禁用并显示不生效提示，`config` 查询报告生效值 false、与配置值不一致时附带 `codebuddyConfigured`）。

## 进度记录

- [x] 确认范围、前缀族与凭据只读策略。
- [x] 完成 credentials 层（读取、profile 判定、热更新、过期判定）。
- [x] 完成 catalog 层（`/v3/config` 拉取与指纹缓存）。
- [x] 完成协议双向转换与身份头。
- [x] 完成门面、网关挂载、开关与 schema。
- [x] 完成测试、`bun run check` 与文档收尾。
- [x] 验收调用通过：Responses API 以 `codebuddy/gpt-5.6-luna` 完成非流式与流式各一次。

## 实施补充（2026-09-17 执行时确认）

- **上游要求首条消息为 system prompt**（空字符串即可通过，错误码 11128）：请求翻译层在无任何系统内容时注入空 system 消息，不改变模型行为。
- **上游不支持非流式 chat 请求**（错误码 11101）：网关对上游恒为 `stream: true`（原设计即如此），客户端非流式由响应层聚合。
- **真实 SSE 形状**：`object:"response"`、未结束帧 `finish_reason:""`（空串而非 null）、每帧携带全零 usage、终帧带真实 usage——`finish_reason` 空串按未结束处理，usage 取最后非空值。
- **llm-bridge 不适用于请求方向**：实测 `openaiResponsesToUniversal` 丢弃 `instructions`、`parallel_tool_calls`、`function_call` 历史与 custom 工具，改为照 `zcode/request.ts` 风格手写全量转换；响应方向亦手写严格解析（llm-bridge 的 `emitOpenAIResponsesStream` 丢弃 `reasoning_content` 且事件缺 `sequence_number`）。
- **本机实测档位模型无 `reasoning.supportedEfforts`**（intl-cli 账号）：`supported_reasoning_levels` 映射为空数组但仍必填，与 Codex ≥0.154 的必填要求一致。
- **2026-09-18（验收后调整）：档位模型从目录中过滤**。用户验收后要求 Codex 选择框不再展示 Auto/Fast/Balanced/Primary/Deep：`buildCodebuddyCatalog` 按 ID 集合（`default-model`/`fast-model`/`balanced-model`/`primary-model`/`deep-model`）过滤档位条目；目录缓存键加入 `CATALOG_SCHEMA_VERSION`（v2），旧缓存整体失效重建。原「档位原样透传」的请求翻译语义不变（档位 ID 若被直接请求且不在目录内返回 404）。

## 决策记录

- 2026-09-18（刷新冲突复核）：**维持只读不刷新；「换刷新端点」不构成缓解，未来网关侧刷新必须以网关专用凭据为前提**。逐项复核：① 本机 CLI（v2.151.0 `dist-server/codebuddy.js`）的 `refreshSession` 调 `POST /v2${prefixPath}/auth/token/refresh`，`prefixPath` 取自服务端下发的 `authentication.attributes.prefixPath`（插件端为 `/plugin`，即 `/v2/plugin/auth/token/refresh`），包内另有裸 `/v2/auth/token/refresh` 调用点；两种形态一律带 `X-Refresh-Token` + `X-Auth-Refresh-Source: "plugin"`——刷新 API 是同一族，「CLI 用裸端点、第三方用 plugin 端点」不构成隔离，第二个刷新方仍会使先刷新方的 rotation token 静默失效。② codebuddy2api 的规避手段是**独立凭据副本**（`.info` 导入到它自己的 `auth/` 数据目录）+ `credential_file_lock`（POSIX flock / Windows msvcrt 锁文件）串行刷新 + `atomic_write_credential`（0600 临时文件 + `os.replace` 原子写回）+ 全局 housekeeping 锁；其文档对共享同一登录的告诫为 "Independent desktop/gateway refreshes may invalidate each other; prefer separate browser login or stop using the other client"——正解是网关专用登录，而非共享凭据加锁。其 `_refresh_locked` 内的具体刷新端点本次逐文件复核未定位（已排查 auth_oauth/credential_actions/credential_io/buddy/client_profiles/inference_auth/upstream_io/gateway_management/checkin/credits 十个文件），不影响结论。③ 本机凭据复核：accessToken JWT iat 2026-09-17T10:18:38Z、exp 2027-02-26T03:16:14Z，**单次签发约 162 天**、当前剩余 161 天；`auth.expiresAt` 与 JWT `exp` 一致，`lastRefreshTime` 2026-09-17T10:18:39Z 印证 CLI 前一日刚刷新过。结论：共享 `.info` 上加锁无法与不配合的 CLI 达成串行化，网关若要刷新必须先持有专用登录（独立凭据副本），刷新端点与头沿用 CLI 同族实现。
- 2026-09-18（第二轮迭代）：**前缀决定产品接口，凭据只贡献 token 与地域**。`codebuddy/` 恒走 CLI 产品上游（`copilot.tencent.com` / `www.codebuddy.ai`）+ CLI 身份头；`workbuddy/` 恒走 IDE 产品上游（`www.workbuddy.cn` / `www.workbuddy.ai`）+ WorkBuddy 身份头（严禁 `x-client-platform: cli`）。修订首期「凭据 profile 决定端点与前缀族」的语义——首期实现里前缀只是名字，`workbuddy/x` 在 cli 凭据下会被 serves 校验挡成 404。
- 2026-09-18（第二轮迭代）：**凭据按目录扫描 + 产品×地域分组，同地域任选**。凭据层从单固定文件（`Tencent-Cloud.coding-copilot.info`）改为扫描认证目录下全部 `*.info`（不同产品/客户端的 `authentication.id` 生成不同文件名，WorkBuddy 桌面登录此前对网关不可见）；同地域内 CodeBuddy 与 WorkBuddy 同账号额度共享（CLI `product.json` 的 `internalDomain` 同时覆盖 `www.codebuddy.cn` 与 `www.workbuddy.cn`），因此凭据选择 = 前缀产品优先、缺失时同地域另一产品回退，无需刷新时间偏好；混合地域（一份 cn + 一份 intl）以最近刷新的凭据决定地域。
- 2026-09-18（第二轮迭代）：**目录按产品接口各拉一份**。存在的每个产品接口（cli/work）各自经其端点 `/v3/config` 拉取目录并投影自己的前缀族，两族都合并进 `/v1/models`；serves 校验仍按各自前缀族的已知集合判定。
- 2026-09-17：**凭据只读不刷新**。本机 CLI 在活跃刷新同一 `.info`，网关侧刷新会与 CLI 互相失效 refreshToken（codebuddy2api 文档亦警告 "independent refreshes may invalidate each other"）。首期只读 + 临近过期报带指引的 503，把刷新冲突从「必须解决」降级为「后续债务」。
- 2026-09-17：**前缀族采用 `codebuddy/` 与 `workbuddy/`**，对应 ZCode 的 `z.ai/`/`bigmodel/`；两者都在 `validateCodebuddyConfig` 中保留，第三方 `prefix` 不得与之冲突。模型族识别按前缀，profile（cn-cli/cn-work/intl-cli/intl-work）由凭据 domain + JWT issuer 决定，不由模型名决定。
- 2026-09-17：**上游端点硬编码白名单**，不做动态端点重映射（ZCode 的 `endpoint-routing.ts` 在此场景无对应机制）；profile 端点固定为 4 个官方 https 域名，防 SSRF 与协议降级。
- 2026-09-17：**不做 OAuth 登录与运营功能**。本计划只做「协议转换 + 消费已登录凭据」，多账号池、积分、签到、Buddy 任务一律排除，避免范围蔓延。
- 2026-09-17（侧聊补充）：**档位模型原样透传，不做本地展开**。Auto/Fast/Balanced/Primary/Deep 档位与具体模型走同一 `/v2/chat/completions`，档位→真实后端由服务端解析（CLI `product.json` 无映射表，codebuddy2api 亦只做 `auto → default-model`（intl）归一化后透传）。代理层不得实现档位映射表；档位自带 `reasoning.effort` 默认值（Fast→medium、Primary→high），请求翻译层不得把 effort 固定死；配额计量以上游返回的 usage 为准，倍率仅作展示近似。
- 2026-09-17（侧聊补充）：**目录字段映射分四类**：① 改名直用：`id→slug`、`name→display_name`、`descriptionEn/Zh→description`、`maxInputTokens→context_window` 且同填 `max_context_window`、`supportsReasoning→supports_reasoning_summaries`、`reasoning.summary→default_reasoning_summary`、`reasoning.defaultEffort/effort→default_reasoning_level`；② 结构 reshape：`reasoning.supportedEfforts: string[] → supported_reasoning_levels: [{effort, description?}]`、`supportsImages → input_modalities`、`supportsToolCall → supports_parallel_tool_calls`（有损，仅 true 时映射，请求层不做并行假设）、`canDisableThinking` 只在请求翻译层生效；③ Codex 行为字段（tool_mode、multi_agent_*、use_responses_lite、model_messages、comp_hash 等 30+）从 `codex_client_models.json` 克隆基底再覆盖，**必须 delete `minimal_client_version`**（对齐 `synthesizeModelEntry` 的 newapi 兜底行为）；④ CB 特有字段存 `ModelEntry` index signature 供适配器私有使用：`credits`（零倍率检测）、`maxOutputTokens`、`maxAllowedSize`、`temperature/top_p`、`relatedModels`；`vendor`（混淆单字母）与 `tags` 丢弃。
- 2026-09-17（侧聊补充）：**倍率并入 display_name**。格式 `Auto (x0.79)`、`GPT-5.6-Luna (x0.14)`；x0 显示 `(free)`；credits 缺失或格式异常时不加后缀、绝不阻断目录构建。解析正则 `/^x\s*([0-9]+(?:\.[0-9]+)?)\s*credits?$/i` 与免费检测/倍率解析共用同一常量（防显示与路由判定不一致）；回填 `match[1]` 原始字符串避免浮点尾迹；倍率取自 serves scope（账号实际费率）而非 picker 展示价；description 不重复倍率；档位与具体模型一视同仁。
- 2026-09-17（侧聊补充）：**目录以 serves scope 为准、per-profile 缓存**。`/v3/config` 的 picker 仅展示、serves 是账号实际可服务清单，合并进 Codex 目录必须取 serves 交集，避免请求期 404；缓存 key 带 profile + 版本修订 + 账号身份（对齐 codebuddy2api `catalog_cache_key`），intl 两 profile 可共享、cn/intl 账号体系独立；双指纹缓存任一不符即重建，缓存文件不含任何凭据。
- 2026-09-17（侧聊更新）：**upstream-only 下禁用，语义完全对齐 zcode**。`codebuddyEnabled = config.codebuddy === true && config.upstreamOnly !== true`：纯转发模式下不建凭据缓存、不写目录缓存、不拦截请求、不施加环回监听与前缀保留约束；`codebuddy` 开关在该模式下仍可写入并保留审计（对齐 zcode 的「可写、留审计、不生效」行为），`config` 查询报告生效值、与配置值不一致时附带 `codebuddyConfigured`；Web UI 开关禁用只读并显示不生效提示。
- 2026-09-17（侧聊更新）：**Web UI 增加 CodeBuddy/WorkBuddy 开关**。单开关控制整个入口（`codebuddy/` 与 `workbuddy/` 两前缀族、cli 与 work 全部 profile），不按产品拆分；走 `config-update.ts` 补丁白名单与既有审计链路，UI 侧每请求重读 config.json、保存后无需重启 UI 进程；UI 范围仅限开关本身，不做 CodeBuddy 模型目录或凭据管理页面。

## 第二轮迭代（2026-09-18）：前缀→产品路由与多凭据目录扫描

首期落地后用户裁决的两项语义修正，本轮实施：

### 范围

- `credentials.ts`：单固定文件 → 目录扫描 `*.info`；每份解析出 profile 后按「产品 × 地域」分组；新增按目标产品选取凭据的接口（同产品优先、同地域另一产品回退、按最近刷新决定地域）；mtime/inode 监听挂目录级；`codebuddyCredentialsPresent` 改为目录级存在性探测。
- `index.ts`：`forward()` 前缀 → 产品绑定（`workbuddy/` 走 work 端点 + work 头，`codebuddy/` 走 cli 端点 + cli 头）；凭据按上述规则选取；日志 `family` 由请求前缀决定（不再由凭据 profile 推导）。
- `catalog.ts`：每个可用的产品接口各自经端点 `/v3/config` 拉取目录并投影自己的前缀族；两族合并进 `/v1/models`；serves 校验按前缀族的已知集合判定。磁盘缓存按产品×地域拆分文件：`codebuddy-cn-catalog.json` / `codebuddy-intl-catalog.json` / `workbuddy-cn-catalog.json` / `workbuddy-intl-catalog.json`（旧单文件 `codebuddy-catalog.json` 弃用，文件名不含 profile 即不再读取）；单文件内仍是 cache_key + 双指纹 + models 的既有格式。
- 测试：双文件目录、前缀×凭据矩阵（同产品/回退/混合地域）、404 校验、目录级探测、按 profile 命名的缓存文件互不串扰。

### 不包含

- 不做按账号 uid 的合并排序偏好（同地域任选，见决策记录）。
- 不做混合地域的显式配置（以最近刷新凭据决定地域，出错回 503/401 既有指引）。
- 不改协议转换、身份头构造、开关链路与既有缓存格式（缓存键已含 profile，天然多凭据隔离）。

### 进度记录

- [x] 更新本计划与决策记录。
- [x] credentials 目录扫描与选择规则（`forProduct(product)` 接口：同产品优先、同地域回退、最近刷新决定活动地域；单文件损坏只跳过；每次选取前重扫，正确性不依赖 fs.watch 事件时机）。
- [x] index 前缀→产品绑定（`codebuddyModelProduct` 决定接口与身份头，日志 family 由请求前缀决定；适配器凭据清单按 cli/work 两产品各选一份）。
- [x] catalog 双产品目录（每产品×地域接口独立缓存/拉取/last-good，两前缀族合并；缓存文件按 `{codebuddy|workbuddy}-{cn|intl}-catalog.json` 命名；display_name 加地域前缀并去掉 `OBC/`，第四轮迭代起改为产品×地域标签）。
- [x] webui 目录级探测（`codebuddyCredentialsPresent(dir)` 扫 `.info` 存在性；`codebuddyAuthDir` 注入）。
- [x] 测试与 `bun run check`（417 项全绿，六连跑稳定）、历史记录 `docs/histories/2026-09/20260918-1631-codebuddy-prefix-product-routing.md`。

## 第三轮迭代（2026-09-18）：目录刷新策略

本轮只落结论到文档，尚未实施代码。首期与第二轮迭代的目录刷新完全由 Codex 的 `/v1/models` 请求驱动：进程内 `cached` 一旦填充就常驻，`readDisk` 只在 `cached` 为空时执行一次，`fresh()` 以 6 小时 TTL 判定是否重建。由此产生两个问题——重启后最长可能继续复用 6 小时内的陈旧目录；上游新增模型后本地要等 TTL 到期才可见（实测 CodeBuddy CLI 自身的刷新节奏约为 16 分钟一次，见下）。

### 决策

- **网关启动/重启时强制刷新一次 catalog**。覆盖 `start`、`restart`、install 后的首次拉起与 LaunchAgent 的 KeepAlive 重启：新进程立刻按上游重建目录，不再信任可能过期的磁盘缓存。要求 fire-and-forget，不阻塞 `serve` 的启动路径（启动横幅与 `clearPendingRestart` 不等它）；拉取失败沿用既有 last-good 回退，不影响可用性。
- **新增定时任务，每 16 分钟刷新一次 catalog**。16 分钟取自本机 CodeBuddy CLI 的实测节奏：`CloudProductManagerImpl.memCache` 的 `expireAt` 为 8 分钟（`eS = 48e4`），`ProductManagerImpl` 的 `PRODUCT_CONFIGURATION_CACHE_TIMEOUT` 同为 8 分钟（`48e4`），两者错相叠加后真实网络请求约每 16 分钟一次（本机 pid 46374 日志实测 27 次拉取、绝大多数间隔 16 分钟）。
- **zcode 不存在启动刷新缺口，不计技术债**。`createZcodeAdapter` 构造时会调用 `loadZcodeCatalogCache`，后者以源码内 `vendor_models.json`、`models.json` 覆盖规则与版本常量计算指纹，并与 `zcode-catalog.json` 比对；代码更新后重启会因指纹不符自动重建，因此启动时已能保证目录与当前代码一致。该机制与 CodeBuddy 固定 `CATALOG_SCHEMA_VERSION` 的缓存键不同，后者才需要由本轮启动刷新覆盖。

### 实施前必须解决的设计点

- **TTL 与定时器冲突**：现 `CATALOG_TTL_MS` 为 6 小时，`fresh()` 决定是否重建。若定时器只是周期调用 `catalog()`，6 小时内会被 `fresh()` 判为新鲜而空转。要么把 TTL 降到 16 分钟量级，要么给定时器与启动刷新一条绕过 TTL 的强制刷新入口（后者语义更明确：定时器表达的是「必须重新校验」，TTL 表达的是「请求驱动时的容忍窗口」）。
- **失败退避**：现 catch 分支只回退 last-good，不更新 `fetchedAt`，因此上游故障时每次触发都会重打。请求驱动下这个开销被 Codex 约 5 分钟的 `/models` 轮询天然限流，但定时器会变成稳定的周期性失败请求。建议照 `zcode/endpoint-routing.ts` 的「成功 TTL / 失败冷却」语义加一层（成功 5 分钟、失败 30 秒）。
- **定时器生命周期**：`src/` 目前没有任何用于目录的 `setInterval`。新增定时器必须 `unref()`，否则进程无法退出；并必须在适配器 `close()` 中 `clearInterval`——`server.stop`、SIGTERM/SIGINT 与 `handler.close()` 都汇入该路径，遗漏会泄漏定时器。
- **刷新后的下游联动**：`writeDisk` 在内容变化时会 `invalidateModelsCache` 过期 Codex 自己的 `~/.codex/models_cache.json`，Codex 约 5 分钟内重新拉取 `/v1/models`。定时器拉到新目录后选择框会自动跟上，无需额外机制。

### 进度记录

- [x] 结论写入本计划；zcode 部分经复核修正为「启动时按文件指纹校验，不属于目录刷新技术债」。
- [x] 启动/重启强制刷新：适配器构造时 fire-and-forget 调用 `catalogStore.refresh()`，绕过 TTL 但复用单飞，失败回退 last-good。
- [x] 每 16 分钟定时刷新：`setInterval` + `unref()`，`close()` 中 `clearInterval`；`refreshCatalogOnStart`/`catalogRefreshIntervalMs` 可注入，测试不依赖真实时间。
- [x] 失败冷却 30 秒：请求驱动刷新在冷却窗口内复用 last-good，启动/定时强制刷新不受冷却限制。

## 第四轮迭代（2026-09-18）：display_name 产品×地域标签与同名去重

### 背景

第二轮把地域并入 display_name（`INTL/GPT-5.6-Luna (x0.14)`），但标签只含地域。单账号登录时，`forProduct` 的同地域回退会让 cli 与 work 两个目录族同时生成（如 `codebuddy-intl-catalog.json` 与 `workbuddy-intl-catalog.json`），两族 slug 前缀不同（`codebuddy/x`、`workbuddy/x`）而 display_name 完全相同，Codex 选择框因此出现两条无法分辨的重名条目。

### 决策

- **display_name 标签改为 `地域-产品`**：`W` 表示 WorkBuddy（work 产品），`C` 表示 CodeBuddy CLI（cli 产品）；例如 `INTL-C/GPT-5.6-Luna (x0.14)`、`INTL-W/GPT-5.6-Luna (x0.14)`、`CN-C/Auto (x0.79)`、`CN-W/Auto (free)`。
- **标签由 profile 推导**（`displayLabel(profile)`），不再单传 region：产品维度本就存在于 profile，合成时直接取 `credential.profile`，避免调用方各自拼装。
- **两个目录族与两个缓存文件保持不变**：本轮只改展示名，不合并目录、不跳过回退族——work 端点有 `hy4-preview-f`、`deepseek-v4.1-flash-sg` 等独有条目，跳过会丢模型。
- **移除 `CATALOG_SCHEMA_VERSION`**：该常量只为「合成规则变化时令旧缓存失效」而设，但适配器构造时已 `refresh()` 强制刷新（绕过 TTL），代码更新必然伴随进程重启，旧缓存本就会在启动时按新规则重建，常量属冗余。缓存键回归 `{profile, revision, identity}`；键形状变化本身让现有缓存一次性失效，正好覆盖本轮 display_name 格式变更。

### 同名模型去重

两族在回退共用登录时内容高度重合（本机实测 31 条 → 去重后 17 条），`display_name` 虽已带产品标签，Codex 选择框仍会为同一上游模型列出两条。`mergeCodebuddyCatalog` 合并前按裸 ID 去重：

- **优先 cli 族**（`codebuddy/` 优先于 `workbuddy/`）。
- **同族内优先倍率低者**；免费即 `x0`，倍率升序天然排最前，无需单独判定。
- **倍率缺失排最后**：拿不到倍率无法证明更便宜，让已知更便宜的条目胜出。
- **只出现在单侧的模型原样保留**（如 work 独有 `hy4-preview-f`、`deepseek-v4.1-flash-sg`），非本族条目不参与去重。
- **去重只作用于展示层**：适配器 `knownModels` 仍取去重前的完整 slug 集合做 serves 校验，被隐藏的 `workbuddy/` 重名条目仍可正常请求（网关测试覆盖该路径）。

### 进度记录

- [x] `catalog.ts`：`regionDisplayLabel(region)` → `displayLabel(profile)`；`displayNameWithCredits`、`synthesizeCodebuddyEntry`、`buildCodebuddyCatalog` 的 region 参数改为 profile；`fetchUpstreamCatalog` 传 `credential.profile`。
- [x] `catalog.ts`：新增 `dedupeCodebuddyCatalog`（cli 优先 → 倍率升序 → 缺失排最后），接入 `mergeCodebuddyCatalog`；移除 `CATALOG_SCHEMA_VERSION`。
- [x] 测试：`displayNameWithCredits` 四条断言改为 `INTL-C`/`CN-C`/`INTL-W`；合成与双族用例断言产品标签区分；新增两条去重用例（跨族优先、免费与低倍率、倍率缺失、单侧独有保留）；旧缓存键用例改为断言已移除的 version 字段不再命中；workbuddy 路由用例断言去重只影响展示、请求仍可达。
- [x] `bun run typecheck` 通过；`bun test test/codebuddy-catalog.test.ts test/codebuddy-gateway.test.ts` 40 项全绿；真实缓存实测 31 → 17 条，work 独有条目保留。
