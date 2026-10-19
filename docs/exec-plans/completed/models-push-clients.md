# models --push：把网关模型清单推送到客户端工具（ZCode 与 DSH/DeepSeek Harness）执行计划

## 目标

在 `models` 命令上新增 `--push [TARGETS]` 能力：把网关本地 agent 插件的模型清单（上游 cliproxy/newapi 与官方模型不推送——授权原因；应用排除规则；推送到 ZCode 时额外剔除 ZCode 插件自身的模型）以按 ID 全量替换的语义写入目标客户端工具的本地配置——推送前做目标安装预检，修改前自动备份。首期交付两个目标：**ZCode**（`~/.zcode/v2` 的受管 `agent-proxy` provider）与 **DSH（DeepSeek Harness）**（`~/.dsh` 各 profile 的 `cordis.patch.yml`）；多目标注册表架构便于后续扩展。

## 范围

- **包含**：
  - CLI：`models --push [TARGETS]`（无值 = 全部内置目标，`zcode,dsh`；有值 = 逗号分隔子集）；可与 `--sync`、`--exclude`、`--select` 组合，`--push` 一律在其他操作成功落盘后最后执行；usage 与守卫更新。
  - 推送数据源管道：复用 `collectAdapterModels`（只本地 agent 插件落盘目录、零网络）+ `filterExcludedModels`；目标侧各自附加剔除（ZCode 剔除 zcode 插件模型防回环；DSH 无对应网关插件、不附加剔除）；目录来源失败降级为警告后继续（与 models 无参视图口径一致），清单为空时中止。
  - 目标安装预检：推送前检查目标本机是否安装（配置文件是否存在）。未安装 → 报「目标未安装」并跳过该目标，整体非零退出；「已安装但未配置 provider」→ 报可执行指引，二者错误明确区分；预检是 `ModelPushTarget` 契约的一部分，多目标时逐目标独立执行、互不阻断。
  - ZCode 目标写入（新模块 `apps/gateway/src/zcode-client-sync.ts`）：管理专属受管 provider `agent-proxy`（与 DSH 同构：rule 的 `providerName: "agent-proxy"`、`api.type: anthropic-messages`、config.json 条目 `kind: "anthropic"`、apiKey 占位、`providerOrder` 追加；缺失时自动创建），按 ID 全量替换其 `modelOrder`/`personalModelIds`/`providerModelRules` 与 `config.json` 的 `models` 映射（手动添加的模型不保留）；新模型定义按网关元数据合成；`ZCODE_HOME` 环境变量覆盖路径（默认 `~/.zcode`）。
  - DSH 目标写入（新模块 `apps/gateway/src/dsh-client-sync.ts`）：管理**专属受管 provider**——`id: agent-proxy`、`displayName: AgentProxy`、`api: anthropic-messages`（缺失时自动创建），按 ID 全量替换其 `models[]`；用户自建的 `cliproxy*` 等 provider 一律不动（详见关键设计）；路径复用 dsh 原生 `DSH_HOME`（默认 `~/.dsh`）。
  - 两目标统一写入规范：写前备份 + 原子写 + 失败回滚（详见关键设计）。
  - 测试（`test/models-push{,-zcode,-dsh}.test.ts`）与文档（`apps/gateway/README.md`）。
- **不包含**：
  - 两目标的受管 `agent-proxy` provider 缺失时**会**自动创建（apiKey 为占位，连接字段创建后永不回写）；用户自建的 `cliproxy` 等 provider 属用户管理（apiKey/baseURL 用户自持），一概不自动创建、不触碰（见关键设计）。
  - 不触碰 DSH 的 `settings.yaml`（legacy，dsh 启动时会重命名为 `.imported` 并迁移）与 `.credentials.yaml`（明文密钥仅存在于此；本命令不读其值、不写该文件，provider 里只落 apiKey 占位的 ref 键名）。
  - 不管理 DSH 中用户自建的 provider（`cliproxy`/`cliproxy-responses`/`cliproxy-anthropic`/`opencode-go`/`zai` 等）。
  - 不修改 `~/.agent-proxy-gateway/config.json` 字段与 `apps/gateway/config.schema.json`（无新持久化配置）。
  - 不写 `~/.codex/config.toml`（不加入 `writesClient` 集合），不改各适配器内部逻辑，也不扩展网关 `/v1/messages` 的模型覆盖面（anthropic 协议支持现状原样消费，见风险）。

## 背景

- **现状调研（2026-10-16）**：
  - `models` 是纯 flag 驱动命令（无子命令），选项白名单在 `apps/gateway/src/cli.ts:2307`（`COMMAND_OPTIONS`），现有 `--sync/--select/--exclude/--restart-codex/--model-merge-json`；值可选 flag 的解析先例是 `--exclude`（cli.ts:278-287）；组合守卫集中在 runCli 前置检查区（cli.ts:2339-2344）；`writesClient`（cli.ts:2372-2374）只服务于写 codex 配置的命令。
  - 仓库既有"写外部工具配置"范式：`install` 写 `~/.codex/config.toml`（受管字段守卫 → 备份 → 幂等改写 → `atomicWrite` → 失败恢复，见 `docs/exec-plans/completed/manual-codex-config-install-flag.md`）；`withModelFileRollback`（cli.ts:1434-1447）提供多文件快照回滚；`atomicWrite`（`apps/gateway/src/toml.ts:142-147`）、`backupConfig`/`timestamp`（cli.ts:506-517）为公共原语。
- **ZCode 侧结构**：已存在手工维护的 `cliproxy` provider（providerId `8c62c948-…`，指向 `https://cliproxy.acehubert.top/v1`），模型清单分散在两处且已漂移（`models` 映射 23 条 vs `modelOrder` 26 条，互有缺失）：
  - `~/.zcode/v2/provider_config.json`：`config.providerConfigRules.providerRules[]` 中该 provider 的 `config.modelOrder` 与 `config.personalModelIds`（应保持一致），以及 `config.modelConfigRules.providerModelRules[]` 中该 providerId 的 `{modelId, providerId, config:{properties:{contextWindow}}}` 规则集；
  - `~/.zcode/v2/config.json`：`provider[providerId].models` 映射（定义含 `reasoning`（enabled/variants/defaultVariant）、`limit.context`/`limit.output`、`modalities.input/output`、`zcode` 标记字段），及 `zcode.deletedModels`（ZCode UI 手动删除记录，应尊重、不重加）。
  - 该 provider 的模型 ID 与网关 slug 同一命名空间（upstream-only 裸 slug + 插件渠道前缀如 `oc-go/`、`free/`），历史上由用户手工维护（`docs/histories/2026-10/20261016-0841-agy-catalog-drop-disabled-suffix.md` 曾手工清理其中条目）。
- **DSH（DeepSeek Harness）侧结构**（npm 全局 `@deepseek-ai/dsh@0.2.0-rc.2`，github.com/deepseek-ai/deepseek-harness，MIT，developer preview；另有桌面 app，其数据目录无模型配置）：
  - 配置根 `~/.dsh`，**dsh 原生支持 `DSH_HOME` 环境变量覆盖**（代码常量 `DSH_HOME_DIR_NAME = ".dsh"`）；
  - `settings.yaml` 已是 **legacy**：dsh 0.2.x 启动时若发现 profile 根的 `settings.yaml` 会重命名为 `settings.yaml.imported` 并逐 section 迁移到新的 settings 存储——**绝不能写它**；
  - 当前生效的模型/provider 配置是**每个 profile 的 patch 层**：`~/.dsh/profiles/{desktop,web,tui,headless,open-design}/cordis.patch.yml`，顶层数组、按 `id` 定位的 patch entries（`cordis.yml` 是基底文件，注释明示 "Edit cordis.patch.yml, not this file"）；本机 desktop 与 web 已配置 `id: llm-pi-ai` 条目（`config.providers.<name>`，含 `displayName`/`apiKeyEnv`/`api`（`openai-completions` | `openai-responses` | `anthropic-messages` + `baseURL`）/`headers`/`models[]`），tui/headless/open-design 为空层 `[]`；
  - 网关相关 provider 共三个（baseURL 均指向用户网关域名）：`cliproxy`（openai-completions）、`cliproxy-responses`（openai-responses）、`cliproxy-anthropic`（anthropic-messages）；`models[]` 条目形态 `{id, name, contextWindow, maxTokens, input: [text, image], reasoningEfforts: {low: low, …}}`；
  - 凭据：patch 里的 `apiKeyEnv` 只是 `~/.dsh/.credentials.yaml`（0600）`refs` 的键名引用，明文密钥只在该文件——同步只改模型清单，不触碰凭据文件。
- **网关 anthropic 端点（`/v1/messages`）支持面（2026-10-16 代码核实）**：网关模型端口在挂载路径 `/v1`（`MOUNT_PATH`，`apps/gateway/src/types.ts:25`）下识别 `${mount}/messages` 为 anthropic 协议（`packages/plugin-api/src/registry.ts:28` `identifyClientEndpoint`）。但插件层目前**仅 opencode-zen 实现了 `to === "anthropic"`**（`packages/opencode-zen/src/index.ts` 的 `forwardMessages`：anthropic 协议模型直通上游，chat/responses/google 协议模型单跳转换后渲染回 Anthropic Messages）；zcode/codebuddy/qoder/agy 四家插件的 `handleHttp` 不处理 anthropic 协议，上游/官方模型也不在 `/v1/messages` 的受管转换面内（upstream-only 直通分支按原样转发、由上游决定，未验证）。用户现有 `cliproxy-anthropic` provider 里全部是 zen 模型，与该支持面吻合。
- **命名过程**：用户最初写作 "dah"（本机 `~/.config`、`~/Library/Application Support`、`/Applications`、Spotlight、zsh history 与仓库全量检索均无果），后确认为 **dsh（DeepSeek Harness）**。
- **相关代码路径**：
  - `apps/gateway/src/cli.ts`（flag 注册、守卫、usage、`models()` 接线、`collectCompatibleModels` cli.ts:1301-1318）
  - `apps/gateway/src/catalog.ts:464-506`（`filterExcludedModels`）
  - `packages/zcode/src/catalog.ts:26-28`（`isZcodeModel`，`/^zcode(?:\/|-)/i`，覆盖 `zcode/*` 与 `zcode-<plan>/*`、`zcode-<providerId>/*`）
  - `apps/gateway/src/paths.ts`（新增 `ZCODE_HOME` 解析，先例：`CODEX_HOME`；DSH 直接复用其原生 `DSH_HOME`）
  - `packages/plugin-api/src/registry.ts:28`（`identifyClientEndpoint`：`${mount}/messages` → anthropic 协议）、`packages/opencode-zen/src/index.ts`（`forwardMessages`，唯一实现 anthropic 协议的插件）
- **已知约束（红线）**：
  - 不读取、不打印任何 apiKey/token；ZCode 的连接字段与其他 provider 的 `manualProviderModelRules`，DSH 的用户自建 provider（`cliproxy*`/`opencode-go`/`zai` 等）与已创建 `agent-proxy` provider 的 `baseURL`/`apiKeyEnv`/`headers`/`displayName`，以及 `.credentials.yaml` 一律不触碰。ZCode 受管 provider 的模型规则与手动覆盖随本次清单全量重建（2026-10-16 用户明确要求模型定义不合并）；其分组和显示顺序继续由推送维护。
  - 只修改受管字段；写前备份、原子写、失败回滚；值未变跳过写盘。

## 关键设计

1. **命令形态**：`agent-proxy models --push [TARGETS]`。无值推送全部内置目标（`zcode,dsh`）；`--push zcode` / `--push dsh,zcode` 选择子集；未知目标名报错列出可选值。解析参照 `--exclude` 的值可选特判。组合语义：`--push` 不与任何现有 flag 互斥，一律在其余操作全部成功并落盘后**最后执行**——`--exclude --push` 以新排除规则推送（`excludeModels` 原地更新同进程的 config 对象，推送过滤直接用新值）；`--sync [--select] --push` 读取刚落盘的新目录文件推送；`--push` 单独使用即可（数据源为落盘目录与插件缓存，不需要先 `--sync`）。`--select` 单独使用仍无效果（现状依赖 `--sync`，本次不扩展）；前置的 `--sync`/`--exclude` 失败时不推送；推送失败不影响已成功落盘的前置操作，二者分别报告。多目标时逐目标执行并汇总报告（某目标失败不影响其余目标，任一失败整体非零退出）。
2. **推送数据源**：只推本地 agent 插件模型——`runModelsPush` 直调 `collectAdapterModels(config, {}, { refresh: false })`（纯本地目录缓存、零网络、与 upstreamOnly 无关；上游 cliproxy/newapi 与官方模型一律不推——授权原因）→ `filterExcludedModels` 以 `isInstalledPluginModel` 为作用域应用 `excludedModels` → 目标侧附加剔除（仅 ZCode：`isZcodeModel` 命中的 zcode 插件模型，避免 ZCode → 网关 → zcode 插件回环）。安全阀：目录来源读取失败（failures 非空）降级为 WARNING 后继续（推送镜像「网关当前实际可用」，与 models 无参视图口径一致）；结果为空 → 中止推送。
3. **ZCode 目标写入（受管 provider `agent-proxy`，按 ID 全量替换；用户裁决「和 dsh 一样使用 agentproxy 作为供应商」，初版「定位并管理用户 cliproxy provider」的设计作废）**：定位 `provider_config.json` 的 providerRules 中 `providerName === "agent-proxy"`（大小写不敏感）的受管 rule，经 providerId 关联 `config.json` 条目；缺失时自动创建（本命令的受管条目），此后只同步模型清单，连接字段永不回写。新清单即权威，顺序取插件目录顺序，不保留旧顺序；受管 provider 内手动添加的模型被直接移除，不做合并保留（用户裁决：忽略手动添加情况）；仍尊重 `zcode.deletedModels`（ZCode UI 的删除意图，不重加）；ZCode 插件自身模型由目标侧剔除（`isZcodeModel`，ZCode 直连自家上游）。`config.json` 与 `provider_config.json` 每次实际修改前各备份 `<file>.bak-agent-proxy-<YYYYMMDDhhmmss>`（与 DSH 同命名模式），再 `atomicWrite`；跨文件写入中途失败时把本目标已写入的文件从写前备份恢复（`writeAllOrRollback`）。
   - 创建时形态（与 DSH 同构，apiKey 为占位）：rule 带 `access: {type: "api-key", apiKey: placeholder}` 与 `api: {type: "anthropic-messages", baseUrl: 网关本地根地址}`，`providerOrder` 追加；`config.json` 条目 `name: "agent-proxy"`、`kind: "anthropic"`、`options.apiKey/baseURL` 占位、`source: "custom"`。
   - `provider_config.json`：该 rule 的 `modelOrder` 与 `personalModelIds` 同步替换为新清单；`providerModelRules` 中该 providerId 的规则按当前目录完整重建，与新清单一一对应。每条带 `contextWindow`（取 ModelEntry 的 `context_window`/`max_context_window`，窗口未知则省略该字段）与 `properties.inputFormat.supportsImage`（`input_modalities` 包含 `image` 时为 true，其余为 false），供新版 ZCode 的视觉标签与请求校验读取；受管 provider 的旧规则属性及 `manualProviderModelRules` 覆盖清除，其他 provider 的规则不动。
   - `config.json`：`provider[providerId].models` 映射按当前网关 ModelEntry 完整重建，不合并任何旧模型定义：`name` ← display_name（缺失用 slug）、`limit.context` ← context_window/max_context_window（缺失省略）、`modalities.input` ← input_modalities（默认 `["text"]`）、`output` 固定 `["text"]`、`reasoning` ← `supported_reasoning_levels` + `default_reasoning_level`（`defaultVariant` 不在档位列表内时回退最后一档，无档位则整个省略）；元数据缺失的字段一律省略，不臆造，旧定义中多余的字段直接清除；清单外的 key（含手动添加的模型）移除；`zcode.deletedModels` 中的模型跳过（不新增、不写回 modelOrder，该数组本身不动）。
4. **DSH 目标写入（专属受管 provider，按 ID 全量替换其 models）**：
   - provider 契约（用户指定）：`config.providers["agent-proxy"]`——`displayName: "AgentProxy"`、`api: "anthropic-messages"`；**缺失时自动创建**（本命令的受管条目），已存在时只同步 `models[]`，不回写 `displayName`/`api`/`baseURL`/`apiKeyEnv`/`headers`（创建后用户可自行改指公网域名，不被覆盖）。
   - 创建时字段：`baseURL` ← 网关本地根地址 `http://<host>:<port>`（取 config 的 host/port，与 install 写 codex 同源；dsh 客户端在其后拼接 `/v1/messages`）；apiKey 随便设置占位值——**网关模型端口忽略客户端提供的 key，各 agent 插件用自有凭据自处理上游授权**，该字段实际不参与鉴权（优先按 dsh provider 惯用形态写 `apiKeyEnv: AGENT_PROXY_API_KEY`，**独立 ref，与用户既有 `CLIPROXY_API_KEY` 等互不相干**；仅写键名，不读 `.credentials.yaml` 的值、不写该文件，不做存在性校验、不打印凭据指引；若实现时发现 dsh 支持字面 `apiKey` 字段则直接写占位字符串）。
   - 与用户既有 provider 完全无关：`cliproxy`/`cliproxy-responses`/`cliproxy-anthropic`/`opencode-go`/`zai` 等条目是用户自建自管，本命令不读取其归属、不迁移其模型、不做任何修改；`agent-proxy` 是本命令唯一的受管 provider，二者互不影响。
   - 定位：`DSH_HOME`（默认 `~/.dsh`）下 `profiles/*/cordis.patch.yml`；**只管理已含 `id: llm-pi-ai` 条目的 profile**（本机 desktop 与 web；空层 profile 不注入——`agent-proxy` 创建也仅发生在这些 profile 内）。
   - 替换语义：`agent-proxy` provider 的 `models[]` 按当前目录完整重建（顺序 = 网关目录顺序），每个条目均重新合成，不复用旧节点或合并旧字段：`{id, name ← display_name, contextWindow ← context_window/max_context_window（缺失省略）, input ← input_modalities（默认 `[text]`）, reasoningEfforts ← supported_reasoning_levels（none 键映射 off，其余合法档位同名映射）, maxTokens 网关元数据缺失则省略}`；缺啥省啥，不臆造。旧模型的名称、能力、窗口、档位及过时字段均被本次定义替换；用户自建的 `cliproxy*` 等 provider 一律不动。
   - YAML 写入：`YAML.parseDocument` 文档级往返——仅改写 `llm-pi-ai` 条目的 `agent-proxy` provider，未触及的条目、`!!js` 表达式、注释与格式原样保留（初版纯值往返会把 `trustedHosts` 的 `!!js` 标签降级为普通字符串，真机首推后已废弃并补回归测试；解析告警留在 `doc.warnings` 不外抛，语法错误经 `doc.errors` 显式报错）；引入 `yaml` 包（仓库首个配置写 YAML 依赖）。每个实际修改的 patch 文件写前备份 `<file>.bak-agent-proxy-<YYYYMMDDhhmmss>` 后 `atomicWrite`；序列化前后对比实现格式无关幂等；任一步失败时回滚本目标已写入的文件（`writeAllOrRollback`）。
   - 输出附注：推送完成消息中注明「网关 `/v1/messages` 当前仅 OpenCode Zen 模型经完整转换支持，其余来源模型经该端点调用会失败或未验证」，避免误用。
5. **写入安全（两目标通用）**：每次实际修改前自动备份（值未变跳过写盘时也不产生备份），再 `atomicWrite`；修改前后序列化对比幂等；任一步失败按 `withModelFileRollback` 模式恢复本目标触及的文件。CLI 输出仅含目标/provider 名、增/删/未变计数与备份路径，提示重启对应工具生效（ZCode / dsh 的 desktop/web 进程）。
6. **多目标注册表**：`ModelPushTarget` 契约（`id`、安装预检、定位与收集变更、应用写入），`zcode` 与 `dsh` 为首批实现；后续新目标按同一契约扩展。

输出示例（真机推送实态，备份路径实际为绝对路径）：

```
zcode: 35 models pushed to provider "agent-proxy" (+35 added, -0 removed, 0 unchanged)
  backup: ~/.zcode/v2/provider_config.json.bak-agent-proxy-20261016…
  backup: ~/.zcode/v2/config.json.bak-agent-proxy-20261016…
  note: the gateway /v1/messages endpoint currently converts only OpenCode Zen models end-to-end; models from other sources may fail over this provider
  restart ZCode to refresh its model list
dsh: 40 models pushed to provider "agent-proxy" (AgentProxy, anthropic-messages; profiles: desktop, web)
  provider "agent-proxy" created in: desktop, web (apiKey is a placeholder; the gateway ignores client keys — its plugins authorize upstreams themselves)
  backup: ~/.dsh/profiles/desktop/cordis.patch.yml.bak-agent-proxy-20261016…
  backup: ~/.dsh/profiles/web/cordis.patch.yml.bak-agent-proxy-20261016…
  note: the gateway /v1/messages endpoint currently converts only OpenCode Zen models end-to-end; models from other sources may fail over this provider
  restart DeepSeek Harness (dsh) to refresh its model list
```

## 风险与缓解

- **风险 1：全量替换移除用户手动添加/调校的内容**（ZCode 侧手动添加的模型 ID、保留模型上手工调校的 reasoning 档位；DSH 侧 `agent-proxy` provider 内手动添加的模型）。
  *缓解*：受管范围内手动添加的模型及模型字段被当前目录完整替换是用户明确要求的行为，不保留旧定义；用户自建 provider（cliproxy* 等）不在受管范围、绝不触碰；每次实际修改前自动备份，可整体恢复。
- **风险 2：不完整数据导致误删**（插件目录读取失败时清单缺一整族模型）。
  *缓解*：目录来源失败降级为警告后继续（该插件模型本就调不通，从客户端移除反而准确）；清单为空直接中止，不执行任何写入。
- **风险 3：目标工具正在运行时并发写配置**。
  *缓解*：读取-改写-原子替换窗口极小；输出提示重启对应工具；ZCode 与 dsh 自身都在配置目录维护 bak 文件，命名模式兼容。
- **风险 4：合成定义不符合目标 schema**（两者均无公开配置文档；dsh 处于 developer preview，格式可能随版本变化）。
  *缓解*：严格模仿现有条目字段形态，缺啥省啥；新条目问题只影响单个模型展示，不影响已有条目；异常形态随实现记入观察项。
- **风险 5：YAML 往返丢失注释/格式漂移**（DSH 的 cordis.patch.yml）。
  *缓解*：已由 `YAML.parseDocument` 文档级往返解决（未触及内容含 `!!js` 标签、注释与格式原样保留，真机 diff 确认 0 删除行）；写前备份可整体恢复；`yaml` 包 round-trip 行为在测试中固化。
- **风险 6：测试触碰真实 `~/.zcode` / `~/.dsh`**。
  *缓解*：`ZCODE_HOME`（新增）与 `DSH_HOME`（dsh 原生）指临时目录，测试全部使用临时目录并在 `finally` 清理。

## 里程碑

1. **里程碑 1：CLI flag 与推送管道**
   - `COMMAND_OPTIONS`/`parseArgs` 值可选解析/usage/组合守卫；`ModelPushTarget` 注册表（含安装预检契约）与数据源管道（含剔除规则与安全阀）。
2. **里程碑 2：ZCode 目标实现**
   - `apps/gateway/src/zcode-client-sync.ts`：安装预检、provider 定位、按 ID 全量替换、元数据合成、备份/原子写/回滚；`paths.ts` 增加 `ZCODE_HOME` 解析。
3. **里程碑 3：DSH 目标实现**
   - `apps/gateway/src/dsh-client-sync.ts`：安装预检（`DSH_HOME`/profile patch 存在性）、profile 定位（含 `llm-pi-ai` 的层）、`agent-proxy` provider 定位/自动创建、其 `models[]` 按 ID 全量替换、新模型条目合成、YAML 解析/序列化、备份/原子写/回滚。
4. **里程碑 4：测试、文档与收尾**
   - `test/models-push-zcode.test.ts`、`test/models-push-dsh.test.ts` 全量用例；`apps/gateway/README.md` models 手册补 `--push`；`bun run check` 全绿；补历史记录。

## 验证方式

- **命令**：`bun run check`（构建 + 严格 typecheck + 全部 node:test）。
- **ZCode 单元/集成测试**（临时 `ZCODE_HOME`）：
  - 按 ID 全量替换（modelOrder/personalModelIds 一致性、providerModelRules 对齐、models 映射增删、手动添加的额外模型被移除、顺序 = 网关目录顺序）；同 ID 的模型定义按当前目录重建，能力更新、过时字段及受管手动覆盖清除；
  - `deletedModels` 跳过；`excludedModels` 过滤；`zcode/*`、`zcode-individual-coding-plan/*`、`zcode-<providerId>/*` 剔除；
  - 安装预检：`ZCODE_HOME` 下无 `v2/config.json`/`v2/provider_config.json` → 报目标未安装、跳过该目标且非零退出；受管 provider 缺失时自动创建（不再有 provider 缺失指引错误）；
  - 清单为空/全部被 deletedModels 隐藏时中止；目录来源失败降级为警告（不中止）；值未变不写盘（也不产生备份）；备份生成与失败回滚；用户 provider 的 `options`/`access`/`providerOrder` 等字段字节不变。
- **DSH 单元/集成测试**（临时 `DSH_HOME`）：
  - `agent-proxy` provider 缺失时自动创建（`displayName: AgentProxy`、`api: anthropic-messages`、`baseURL` 取网关 host/port、`apiKeyEnv: AGENT_PROXY_API_KEY`）；已存在时仅替换 `models[]`，`displayName`/`api`/`baseURL`/`apiKeyEnv`/`headers` 不被回写；
  - `models[]` 按当前目录完整重建（包括同 ID 的模型定义、能力、名称与档位；provider 内手动添加的模型及字段被移除；顺序 = 网关目录顺序）；
  - 用户自建 provider（`cliproxy`/`cliproxy-responses`/`cliproxy-anthropic`/`opencode-go`/`zai`）字节不变；`settings.yaml` 与 `.credentials.yaml` 不被触碰；
  - 只管理含 `llm-pi-ai` 的 profile，空层 profile 不被写入（`agent-proxy` 也不在其中创建）；
  - 安装预检：无 `DSH_HOME` 目录 → 未安装错误；有目录但无任何 profile 含 `llm-pi-ai` → 指引错误；
  - YAML round-trip（解析 → 改写 → 序列化）数据保真；值未变不写盘；备份生成与失败回滚。
- **组合顺序**：`--exclude --push` 以落盘后的新排除规则推送；`--sync --select --push` 先同步后推送；前置操作失败不推送；推送失败不影响已成功的前置结果（分别报告）；多目标汇总与非零退出语义。
- **手工检查**：真实 `~/.zcode`、`~/.dsh` 上先确认备份文件生成、diff 仅限受管字段；重启 ZCode 与 dsh（desktop/web）后模型列表与 `agent-proxy models` 视图一致（ZCode 侧无 zcode 插件模型）。

## 进度记录

- [x] 调研与方案收敛（models 命令形态、ZCode 与 DSH 配置结构、写入范式；目标名确认 dah → dsh/DeepSeek Harness）。
- [x] 里程碑 1：CLI flag、守卫与推送管道（`--push` 值可选解析、`COMMAND_OPTIONS`/usage、`pushDeferred` 最后执行、`pushModelsToTargets` 管道）。
- [x] 里程碑 2：ZCode 目标写入实现（`apps/gateway/src/zcode-client-sync.ts`；`ZCODE_HOME` 解析位于该模块内而非 paths.ts，避免扩展 ResolvedPaths 波及面）。
- [x] 里程碑 3：DSH 目标写入实现（`apps/gateway/src/dsh-client-sync.ts`；YAML 头部注释保留、序列化前后对比实现格式无关幂等）。
- [x] 里程碑 4：测试、文档与 `bun run check` 收尾（`test/models-push{,-zcode,-dsh}.test.ts` 共 17 例全绿；全量 check 1161 例通过；README 补 `--push` 手册；`yaml` 依赖加入 gateway deps 与根 devDependencies）。
- [x] 真机验证（dsh 先行；修订 2 后 zcode 亦验证）：dsh 推送（备份生成 ✓、desktop/web 均 0 删除行纯新增 agent-proxy 块 ✓、`!!js` 表达式原样保留 ✓、幂等第二次推送无写盘无新备份 ✓、其余 profile patch 与 `.credentials.yaml`/`settings.yaml` 未动 ✓）；zcode 推送（受管 agent-proxy 自动创建、35 个插件模型、无上游/zcode 插件模型混入、用户 cliproxy provider 字节不动、幂等重推 +0/-0）。
- [x] 验收复核（2026-10-16）：补齐「失败回滚」缺口——跨文件写入中途失败时把本目标已写入文件从写前备份恢复（`writeAllOrRollback`），补回归测试（push 测试共 18 例）；正文按最终实现校正（数据源、ZCode 受管 provider、来源失败语义、输出示例与验证方式）。

## 决策记录

- 2026-10-16：同步语义采用**按 ID 全量替换**（后经用户裁决再次确认并简化：不保留旧顺序、忽略手动添加模型）；`zcode.deletedModels` 视为用户在 ZCode UI 的显式删除意图，尊重且不重加。
- 2026-10-16：推送 ZCode 前剔除 ZCode 插件自身模型（`isZcodeModel`：`zcode/*`、`zcode-*/*`），防止 ZCode → 网关 → zcode 插件的请求回环；其余插件模型（`oc-go/`、`free/` 等渠道前缀）保留，与现有手工维护的清单口径一致；DSH 无对应网关插件，不做附加剔除。
- 2026-10-16：ZCode 的 cliproxy provider 不自动创建——它使用用户自有的外网域名与 apiKey，网关无从得知；缺失时报可执行指引（对齐 `--manual-codex-config` 的"只读 + 打印设置方法"先例）。（DSH 侧后来改为受管 `agent-proxy` provider、缺失自动创建，见 dsh 补充条目。）
- 2026-10-16：新模型定义按网关元数据合成（context window / reasoning 档位 / 输入模态），缺啥省啥、不臆造；已有定义/归属一律不动。
- 2026-10-16："dah"（后经用户确认为 **dsh，DeepSeek Harness**）初次检索无法定位，先只落 zcode；多目标注册表预留扩展位。该项原作为未完成里程碑在 active 计划内跟踪、**不预登记 tech-debt**（用户指出过早登记；债务登记只发生在计划归档时若仍悬置）——同日确认 dsh 后目标转正，无需登记。
- 2026-10-16（用户裁决修订）：`--push` 与 `--exclude`/`--select` **不做互斥**，组合时 `--push` 一律在其他操作成功落盘后最后执行（初稿曾设计为互斥报错）；`--restart-codex` 的前置要求（需 `--sync` 或 `--exclude`）不因 `--push` 扩展，推送不触碰 Codex 配置。
- 2026-10-16（用户裁决修订 2）：镜像语义简化为**按 ID 全量替换**——清单顺序取网关目录顺序、不再保留旧顺序，目标侧手动添加的模型直接移除、不做合并（忽略手动添加情况）。每个目标推送前增加**安装预检**（本机配置文件存在性）：未安装 → 跳过该目标并非零退出，与「已安装但未配置 provider」的指引错误区分。修改前自动备份（值未变跳过写盘时也不产生备份）。
- 2026-10-16（dsh 目标确认后补充，随用户裁决演进）：
  - DSH 写入点为其 profile 的 `cordis.patch.yml` 的 `llm-pi-ai` 条目（settings 存储的 patch 层），不写 legacy `settings.yaml`（dsh 启动时会改名迁移、合并行为不可控），不触碰 `.credentials.yaml`（明文密钥仅存在于此，patch 里只有 refs 键名引用）。
  - ~~初版设计为「按 ID 全量替换 `cliproxy*` provider 并集 + 保留协议归属」~~ 已被下一条用户裁决取代。
  - 用户裁决：本命令在 DSH 管理**专属 provider `agent-proxy`（displayName `AgentProxy`，api `anthropic-messages`）**，缺失时自动创建、只同步其 `models[]`；它与用户既有 `cliproxy*` 等 provider **完全无关**（cliproxy 是 cliproxy、agentproxy 是 agentproxy）——不迁移、不引用、不修改用户自建条目。apiKey 随便占位：网关模型端口忽略客户端 key、各 agent 插件自处理上游授权，该字段不参与鉴权；独立 ref 名 `AGENT_PROXY_API_KEY`，不复用 `CLIPROXY_API_KEY`，无校验与指引。附注：网关 `/v1/messages` 当前仅 OpenCode Zen 模型经完整转换支持，其余来源模型经该端点会失败或未验证，推送输出中如实提示（不因此过滤清单，遵循用户指令全量写入）。
  - 只管理已含 `llm-pi-ai` 的 profile（本机 desktop/web），`agent-proxy` 的创建也仅发生在这些 profile，不向空层 profile 注入；安装预检与测试复用 dsh 原生 `DSH_HOME` env，ZCode 侧则新增 `ZCODE_HOME`（对齐 `CODEX_HOME` 先例）。
  - YAML 序列化评估引入 `yaml` 包（仓库首个配置写 YAML 依赖；替代方案为手写 patch 子集解析/发射器，复杂度不值）；解析-改写-重序列化整文件，接受注释丢失（程序生成文件，写前备份兜底）。
- 2026-10-16（实施修订——真机验证暴露 `!!js` 往返缺陷）：初版用 `YAML.parse → YAML.stringify` 纯值往返，dsh 真机首推后实测发现 web profile 的 `trustedHosts: !!js "…"` 标签被降级为普通字符串（该表达式 dsh 运行时不再求值）——头部注释声明的 `!!js` 表达式是 patch 层的一等公民，纯值往返不可接受。已当场从备份恢复两 profile，并改为 **`YAML.parseDocument` 文档级往返**（未触及的条目、`!!js` 标签、注释与格式原样保留，解析告警留在 `doc.warnings` 不外抛，语法错误经 `doc.errors` 显式报错）；补 `!!js` 保留回归测试。修订后真机重推验证：desktop/web 均 **0 删除行、纯新增 agent-proxy 块**，「接受注释丢失」的初版决策作废。另：用户 PATH 中的 OpenHarmony SDK `diff` 对不同文件误报相同，验证时须用 `/usr/bin/diff`。
- 2026-10-16（实施修订 2——用户裁决：数据源与 ZCode 目标双双收敛）：
  - **数据源只推本地 agent 插件模型**：上游 cliproxy/newapi 与官方模型一律不推（授权问题）；push 与 upstreamOnly 完全无关（插件任何模式都启用），且恒走 `reloadCatalog`（纯本地目录缓存、零网络，`runModelsPush` 直调 `collectAdapterModels`），目录内容更新由网关运行时刷新与 `models --sync` 负责。zcode 插件模型的剔除由 zcode 目标自己做（ZCode 直连自家上游），管道不做目标特判。
  - **ZCode 目标改为受管 provider `agent-proxy`**（用户裁决「和 dsh 一样使用 agentproxy 作为供应商」）：自动创建（rule 的 `providerName: "agent-proxy"`、`api.type: anthropic-messages`、config.json 条目 `kind: "anthropic"`、apiKey 占位、providerOrder 追加），此后只同步模型清单，连接字段永不回写；与用户既有 cliproxy provider 完全无关、绝不触碰。初版「定位并管理用户 cliproxy provider」的设计作废。
  - **目录来源失败降级为警告后继续**（不再中止）：推送镜像"网关当前实际可用"，插件凭据缺失时其模型本就调不通，从客户端移除反而准确；与 models 无参视图口径一致。清单为空仍中止。
  - **agy 凭据钥匙串回退**（用户重登录后实测发现新版 agy CLI 把凭据存 macOS 钥匙串 `gemini/antigravity`，值为 `go-keyring-base64:` + base64 的同一份 JSON）：`loadAgyCredentials` 文件缺失时（darwin）回退钥匙串，`agyCredentialsPresent` 同步探测（Web UI 开关显隐随之恢复）；测试经注入与本机真实条目隔离。
  - **（修订）读取优先级对齐终端 CLI**（用户依据 daemon 行为裁决）：钥匙串条目有**合法（未过期）令牌**即采用、凭据文件被完全屏蔽（哪怕内容是对的）；钥匙串无合法令牌（缺失/损坏/过期）才回落文件——remote-control daemon 只刷新文件，钥匙串令牌过期后由文件兜底；两边都无凭据才报未登录，仅有过期钥匙串凭据时原样返回交由请求层 401 指引。初版「文件优先、缺失才读钥匙串」作废。
  - 真机验证（修订后）：zcode 35 个插件模型（含恢复后的 agy 3 个）、dsh 40 个（dsh 侧不剔除 zcode 插件模型），幂等重跑 +0/-0；zcode 目标无上游/zcode 插件模型混入。
- 2026-10-16（验收复核修订）：关键设计承诺的「失败回滚」在初版实现中缺失（只有写前备份 + 原子写，跨文件中途失败会留下半更新状态），已补齐 `writeAllOrRollback`（任一步失败时从各自写前备份恢复本批已写入的文件）并补回归测试；正文同步为最终实现（数据源只推插件模型、ZCode 受管 provider 自动创建、来源失败降级警告、输出示例）。

## 后续追加：推送前勾选模型（2026-10-16，待实现）

### 目标与范围

模型数量较多，用户不需要全部设置到客户端。为 `agent-proxy models --push [TARGETS]` 增加选择确认：候选模型默认全部打勾，↑/↓ 移动、空格取消或恢复勾选，Enter 确认后仅推送所选模型。

本轮按用户要求直接追加到本计划，功能实现与测试尚未开始；前述已完成记录仅代表原有推送能力，不代表本追加需求已经交付。

- `--push` 无值、指定单目标或多目标时均经过模型选择；多目标共用一次选择结果。
- 选择只影响本次推送，不持久化，不修改 `excludedModels`。
- 复用现有模型选择器，不新增依赖、配置字段、推送目标或非交互筛选参数。
- 保留目标受管范围、备份、原子写入、失败回滚及原有组合命令顺序。

### 实现方案

1. **准备候选**：`runModelsPush()` 继续只读本地插件目录缓存、保持零网络，上游及官方模型不参与推送。`pushModelsToTargets()` 应用 `excludedModels` 后再进入选择；无候选模型沿用现有报错，来源失败继续警告。
2. **校验目标**：先解析并校验 `--push [TARGETS]`，未知目标直接报错，不进入模型选择。
3. **默认全选**：复用 `apps/gateway/src/models.ts` 的 `chooseModels()`，将全部候选 ID 传入 `currentSelection`。展示模型名称、完整 ID、选中数量，沿用长列表滚动窗口。
4. **键盘确认**：↑/↓ 只移动光标，空格切换当前项；Enter 即最终推送确认，不另加重复确认。设置 `requireNonEmpty: true`，全部取消勾选后按 Enter 提示至少选择一个模型并停留在菜单，不能用空列表清空目标。
5. **取消退出**：Ctrl+C 取消本次推送并恢复终端状态。选择失败或取消时不调用任何目标写入方法，不创建 provider、备份或改写配置。
6. **非交互终端**：明确报错并提示在交互终端运行，不静默全量推送、不等待键盘。错误信息不得提示用现有 `--select` 筛选推送模型；该参数仍属于上游模型同步。
7. **传递子集**：在公共过滤之后、目标写入之前注入可测试的选择回调，CLI 路径必须经过选择。按所选 ID 提取完整模型条目，保留元数据与原候选顺序，避免展示排序影响既有写入顺序。
8. **目标落地**：所有目标消费同一选中子集，再各自应用原有过滤。ZCode 继续剔除自身插件模型、尊重 `deletedModels`；目标过滤后为空继续中止该目标，不清空配置。菜单提示目标可能进一步过滤模型，实际数量以逐目标汇总为准。
9. **组合命令**：保留 `--exclude ... --push`、`--sync ... --push` 先完成前置操作、最后推送的顺序；取消推送不撤销已成功落盘的前置操作，输出须说明结果。

### 风险与缓解

- **确认前写入导致取消仍有副作用**：全部目标写入置于选择成功之后，测试检查目标调用、文件内容及备份。
- **非交互环境全推或挂起**：明确拒绝非 TTY；测试注入选择结果或模拟终端，全部使用隔离目录。
- **误解取消勾选的替换语义**：交互提示及手册明确“所选模型替换受管 provider 的模型清单”，目标已有但本次未选的模型会被移除；继续保留写前备份。
- **实际推送数量少于勾选数量**：保留目标安全过滤，交互提示过滤语义，并逐目标输出实际结果。
- **共享选择器改动影响其他命令**：优先复用现有选项，交互注入局限于推送编排，保留安装、同步和排除功能的原有行为。

### 验证与交付

- 实现后运行 `bun run check`，单元测试进程超时上限 60 秒。
- 补充 `test/models-push.test.ts` 及必要的选择器、目标测试：
  - 初始全部勾选，直接 Enter 推送全部候选。
  - ↑/↓ 不改变勾选，空格取消后该模型不传给目标，再次空格可恢复。
  - 多目标仅选择一次，接收相同子集，完整元数据与原候选顺序保留。
  - 全不选不能提交；Ctrl+C 取消、非 TTY 报错均不写目标配置或产生备份。
  - 无候选、未知目标不进入选择器；来源警告、逐目标失败汇总保持有效。
  - 排除规则在选择前生效；ZCode 自身模型与 `deletedModels` 过滤继续有效，过滤后为空不写入；DSH 仅写所选子集。
  - 前置同步或排除成功后才选择；取消推送不撤销前置结果。
- 在隔离 `ZCODE_HOME`、`DSH_HOME` 中手工检查长列表滚动、选中计数、终端恢复、确认前零写入及确认后仅修改受管字段。
- 同步更新 `apps/gateway/src/cli.ts` 帮助、`apps/gateway/README.md`，明确替换语义与非交互行为；实现完成后补充历史记录。

### 追加进度与决策

- [x] 调研现有推送入口与 `chooseModels()`，明确默认全选、方向键定位、空格切换、Enter 确认。
- [x] 按用户要求直接追加到 `models-push-clients.md`，不单独维护新计划。
- [x] 接入交互，落实取消、空选、非 TTY 和多目标行为。
- [x] 补充测试、CLI 帮助与使用手册。
- [x] 完成 `bun run check`、历史记录并更新本节状态。

- 2026-10-16（用户要求）：推送前允许取消不需要的模型，默认全部打勾；先记录到现有执行计划。
- 2026-10-16（方案选择）：选择仅影响本次推送，多目标共享一次选择，目标原有过滤继续生效；空选停留菜单，取消及非 TTY 不推送，不新增绕过交互的参数。
- 2026-10-16（实施落定）：交互接入点在 `runModelsPush`（cli.ts）——先做目标名校验与空清单守卫（未知目标/无候选不进选择器），再以 `chooseModels` 勾选（全预选、`requireNonEmpty: true` 空选停留菜单），确认后按勾选子集走原 `pushModelsToTargets`；zcode 目标内的插件剔除/`deletedModels` 过滤在目标层继续生效。非 TTY 报"requires an interactive terminal"且零写入（真机已验证：报错且 `~/.zcode`、`~/.dsh` 校验和不变）。`PushModelsDependencies` 注入输入输出供 fake TTY 测试；新增 5 例（默认回车全量、取消个别、空选停留、非 TTY 报错、组合语义沿用）。usage 与 README 已同步；`bun run check` 1179 例全绿。

### 追加：reasoningEfforts `none` 档位事故修复（2026-10-16 下午）

- **事故**：`models --push` 把 zen 目录的 `none`（无推理）档位原样写入 dsh
  `reasoningEfforts` 的键，而 dsh schema 只认 `off/minimal/low/medium/high/xhigh/max`——
  校验失败导致整个 `llm-pi-ai` 插件激活失败、dsh 全部自定义模型消失
  （证据：`~/.dsh/logs/startup-2026-10-16T06-17-41…log` 的 ValidationError，
  模型 `opencode-zen/nemotron-3.5-super-vl-free`）。
- **修复（用户裁决「none 换成 off 就可以了」）**：dsh 侧 `dshReasoningEfforts`
  归一——`none` 映射为 `off` 键（值保留原档位名发给上游，zen 上游本就接受
  `none` 作为 effort 值）、白名单外键丢弃（全滤空则省略 `reasoningEfforts`）；
  补 3 组回归断言。本机两份 patch 已急救（`none: none` → `off: none`，desktop
  手工修复 + 备份 `bak-reasonoff-*`；web 由并行会话先修）。
- **zcode 侧**：用户裁决**先不修改、验收后再处理**——`synthesizeZcodeModelDefinition`
  的 variants 暂不做 `none` 过滤/映射（本机 ZCode 侧 `none` 未见报错证据），
  待 dsh 修复验收后再评估是否同样处理。
- `bun run check` 1180 例全绿；最新 dsh 启动日志（修复后重启）零 ValidationError。

### 追加：dsh 受管 provider 的 credential 机制定案（2026-10-16 傍晚）

- **机制**（dsh 源码核实）：`apiKeyEnv` 的值按优先级取自 继承的进程环境变量 >
  `~/.dsh/.credentials.yaml` refs 段（credentials service，web Models 页写入）>
  `<cwd>/.env` > `$DSH_HOME/.env`；声明了 ref 而全层无值 → `MISSING_CREDENTIAL`
  拒绝调用。**完全不写 `apiKeyEnv` 也不行**——pi-ai 的 OpenAI 兼容实现在协议层
  坚持要 key 或 Authorization 头（"keyless 路由"会报 Provider is not configured）。
- **定案**：受管 provider 写 `apiKeyEnv: AGENT_PROXY_API_KEY`（独立 ref，与
  CLIPROXY_API_KEY 互不相干；值由用户经 dsh Models 页面存进 credentials service，
  本机已存）。网关忽略客户端 key、各插件自处理上游授权，该值仅用于通过 dsh 的
  调用前置校验。「设为 EMPTY 字面值」与「省略字段」两条路均已实测/源码证伪并回退。
- zcode 侧保持字面 `apiKey: "EMPTY"`（zcode schema 只要求字符串占位，无 credential
  解析链，无调用前置校验问题）。
- 2026-10-16（追加定案：credential ref 的幂等补充）：推送时检查
  `~/.dsh/.credentials.yaml` 的 refs——**已有 `AGENT_PROXY_API_KEY`（无论值是什么）
  一律不动；缺失则补 `AGENT_PROXY_API_KEY: EMPTY`**（用户裁决），文件不存在时创建
  仅含该 ref 的最小文件（atomicWrite、0600，无备份源不产生备份）；文档级往返只动
  这一个键，其余 refs/records 原样。回答用户疑问留痕：`AGENT_PROXY_API_KEY` 这个
  名字由本工具定义（provider 的 `apiKeyEnv` 声明），dsh Models 页面按声明名把值写
  入 credentials service——名字不是 dsh 自动生成的。本机该 ref 已存在，按规则未
  修改。`bun run check` 1181 例全绿。
- 2026-10-16（最终定案，覆盖上一条「幂等补充」）：用户裁决**保持现状，工具不写
  `~/.dsh/.credentials.yaml`**——`ensureDshApiKeyRef` 已移除（曾实现「有 ref 不动、
  缺失补 EMPTY」，随后按裁决整体回退）；ref 缺失时由**人工**在 dsh Models 页面把
  AgentProxy 的 API 密钥设为 `EMPTY`（一次性，README 已补充说明）。zcode 侧不受
  影响（字面 `apiKey: "EMPTY"`）。`bun run check` 1180 例全绿。
- 2026-10-16（追加：--push 直达选择器）：`models --push` 单独使用时不再先打印
  `models` 只读视图的三段清单（Selected CLIProxy models / Active compatible
  models / Excluded models）——勾选列表本身就是当前可用目录过滤一次后的
  可选项，直接进入选择（用户裁决）；`--sync --push` 与 `--exclude --push`
  组合时的操作反馈不受影响。补输出断言；`bun run check` 1181 例全绿。
- 2026-10-16（追加：zcode 供应商不显示的根因修复）：真机推送成功但 ZCode UI 不显示
  AgentProxy。逐字段对照真实显示条目定位两处缺失——① rule 的 `config.group`（全部
  显示条目均为 `standard-personal`，缺失该字段的供应商不进列表）；②
  `model-provider-display-order.json` 名单不含受管 id（UI 按名单渲染）。修复：创建
  rule 时写 `group: standard-personal`，存量受管 rule 缺失时补齐；推送时名单存在且
  缺受管 id 则追加尾部（其余顺序不动，损坏时跳过不阻塞）。本机两处已手工急救
  （备份 `bak-group-*`）；`bun run check` 1181 例全绿。
- 2026-10-16（追加：显示名 AgentProxy）：zcode 受管条目 `config.json` 的 `name` 从
  `agent-proxy` 改为 `AgentProxy`（与 dsh 侧 displayName 对称；仅显示名，定位仍按
  rule.providerName（"agent-proxy"）→ providerId（UUID）链，name 不参与查找）；
  每次推送统一该显示名。本机已改（备份 bak-name-*）。
- 2026-10-16（追加：显示名改由 providerName 承载）：用户实测 `config.json` 的
  `name` 改为 AgentProxy 后界面仍显示小写——ZCode 界面渲染的是 rule 的
  **`providerName`**（佐证：OpenRouter/DeepSeek/Local 等条目的 providerName 本就是
  大写形态）。修复：受管 rule 的 providerName 写 `AgentProxy`，定位改为
  `isManagedProviderName`（去连字符小写比较，兼容存量 `agent-proxy` 原位升级、
  providerId 不变）；config.json 的 name 同步 AgentProxy。本机已改（备份
  bak-pname-*）；并行会话的 codebuddy-model-sync 断言一并同步。`bun run check`
  1182 例全绿。
- 2026-10-16（追加：模型显示名 name）：用户实测 AgentProxy 的模型在 UI 只显示 ID——
  ZCode 模型显示名存于 `config.json` models 定义的 **`name`** 字段（真实条目如
  "GLM-5.3"/"MiniMax-M3"），早期合成漏写。修复：合成时写 `display_name`（缺省回退
  slug）；存量受管定义仅在缺失时补 name、已有（含用户改过的）一律不覆盖，其余字段
  不动。本机 58 个模型显示名已全部补齐（备份 bak-modelname-*；codebuddy 目录缓存
  为空时经 collectAdapterModels 采集路径取 display_name）。`bun run check` 1183 例全绿。

### 追加：ZCode 视觉能力写入新版运行时规则（2026-10-16）

- **根因**：`workbuddy-intl/gpt-6-luna` 的目录与 `config.json` 均声明图片输入，
  但新版 ZCode 的视觉标签和请求校验读取模型规则的
  `config.properties.inputFormat.supportsImage`；旧推送仅写 `contextWindow`，
  且不会更新存量规则的能力字段，因此不能根据 `modalities.input` 判断推送已正确。
  此读取路径已对照本机安装包的 UI 与运行时代码核实。
- **修复**：新旧受管模型规则统一从 `input_modalities` 同步 `supportsImage`：
  含 `image` 写 true，纯文本或未声明则写 false；窗口未知也创建规则，仅省略
  `contextWindow`。旧规则的其他属性、输入格式开关、推理配置及用户 provider 保留，
  模型 ID 大小写匹配沿用现有语义；重复推送不写盘、不额外生成备份。
- **验证**：新增 2 例回归测试，覆盖视觉/文本/未知模态、未知上下文、存量规则升级、
  同 ID 用户 provider 隔离和幂等，ZCode 定向共 9 例通过。全量检查的边界、构建、
  类型检查通过；沙箱内测试受本地监听限制失败，在获准的沙箱外重跑
  `bun run test` 后 1185 例通过、0 失败。未改写真实 ZCode 配置，使用修复版本
  再执行 `models --push zcode` 后重启 ZCode 读取新规则。

### 追加：Zen 目录输入模态与模型定义全量替换（2026-10-16）

- **用户裁决**：`--push` 的全量替换包括模型配置，不只是替换 ID 清单；不逐模型
  合并。当前目录或本次勾选结果之外的模型必须移除，保留的模型也按目录完整生成。
  本节覆盖前文历史记录中“保留已有模型定义”的旧行为，正文设计已同步修订。
- **Zen 目录修复**：旧实现将全部 `input_modalities` 固定成 `["text"]`，现在从
  官方 `modalities.input` 提取 text/image 并去重；图片能力只依据明确声明，
  不按模型名或 `attachment` 猜测。缺失、异常、空数组或仅有其他模态时保守按文本。
  原始元数据缓存新增可选 `inputModalities` 并在磁盘读回时保留，成品目录同步生成。
  保持既有 TTL 与显式刷新语义；旧缓存需刷新元数据后才能补齐图片声明。
- **ZCode 全量重建**：每次按有效清单重新生成 `models` 映射和
  `providerModelRules`，同步名称、上下文、推理、多模态及运行时视觉字段；
  清除旧定义的残余属性与仅属于受管 provider 的手动模型覆盖，防止覆盖新规则。
  其他 provider、连接字段及已有 `deletedModels` 过滤不变。
- **DSH 全量重建**：取消按 ID 复用旧节点，整个 `models[]` 都由当前目录合成，
  删除不在清单中的模型、旧名称、旧输入模态、旧窗口、旧档位及多余字段。
  模型条目中的手动修改随定义替换；供应商级连接设置及未触及的 YAML 内容保持。
- **验证**：catalog 与两目标的回归测试均先验证旧实现失败再修复；覆盖图片与文本
  区分、未知声明回退、缓存刷新及离线重载、模型删除、旧属性清除、用户 provider
  隔离、写前备份、回滚和相同目录幂等。`bun run check` 全部通过：1189 例、
  0 失败。未修改真实客户端配置；使用修复版本先 `models --sync` 刷新目录，
  再 `models --push`（或组合 `models --sync --push`）确认模型后重启客户端生效。
- **实际生效补验（16:02）**：用户反馈 DSH 落盘仍只有 text；核对发现网关进程
  自 12:13 启动、仍加载修复前代码，目录虽定时更新，元数据仍为旧缓存且缺模态。
  重启网关后官方元数据刷新成功，Space Bunny、GLM Flash 等条目均生成 text/image。
  随后使用既有目标写入实现，按各客户端当前选择重新推送（ZCode 58、DSH 63），
  未增加模型选择；写前自动备份。实际读回确认 DSH desktop/web 的 Space Bunny
  `input` 都是 `[text, image]`，ZCode 运行时规则 `supportsImage: true`；
  两目标连接字段和其他 provider 经备份对比均未变化。用户确认 Web 已生效，
  桌面端需完全退出后重开以读取更新配置。
- 2026-10-16（追加：模型显示名的真实来源与 /v1/models 增强）：补 `models.name` 后
  重启仍显示裸 ID——对照发现 cliproxy 的 23 个模型**全部没有** name 字段却显示正常，
  证明显示名是 zcode **运行时从 provider 拉取**的（GET {baseURL}/v1/models）。本机
  网关该端点的 OpenAI list 形态只有 `{id, object, owned_by}`，无任何显示名字段——
  这是 AgentProxy 模型显示裸 ID 的根因。修复：`modelCatalogResponse` 的 OpenAI
  形态为带 `display_name` 的条目补非标字段 `display_name` 与 `name`（缺失不臆造）；
  网关已重启实测 63 条全带显示名。`models.name` 的补齐保留（无害且对静态渲染路径
  有益）。更新两处 OpenAI list 期望断言；`bun run check` 1190 例全绿。
- 2026-10-16（追加：zcode 模型显示名定论——UI 无此功能）：经 computer-use 实操 ZCode
  设置页取证：AgentProxy 详情页的「编辑模型配置」与「添加模型」对话框字段完全一致
  （模型 ID / 上下文窗口 / 最大输出 Token / 输入类型 / 模型能力 / 推理等级 / 推理
  参数映射），**均无显示名输入框**——自定义供应商的模型行渲染的就是模型 ID，配置
  无显示名位（`config.json` models[].name 与 UI 均不生效；newapi-chat 等条目里的
  name 是历史遗留不被渲染；Z.ai 内置模型的名称来自内置目录）。结论：AgentProxy
  模型行显示 `codebuddy-cn/hy3` 这类完整 slug 是 ZCode 产品形态，非推送缺陷；ID
  前缀是网关路由键不可省。保留的无害增强：models[].name 写入与网关 /v1/models
  OpenAI 形态的 display_name/name 非标字段（对未来客户端生效）。
