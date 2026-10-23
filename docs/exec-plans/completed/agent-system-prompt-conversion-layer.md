# 提示词注入从 catalog 合成期迁移到请求转换层

## 目标

四家插件（zcode / qoder / agy / codebuddy）的官方 agent 系统提示词注入点从 catalog 合成期（`withAgentSystemPrompt` 改写 `base_instructions` / `model_messages.instructions_template`，依赖 Codex 客户端读目录渲染后发回）下移到各插件的请求转换层：无论客户端以哪种协议（responses / chat-completions / anthropic / gemini）进入，上游请求的系统提示词槽一律**整体替换**为该插件的官方 agent 提示词；网关生成的旁白（dropped 工具通告、zcode 视觉适配说明）仍拼在其后。由此消除「读目录的 Codex 客户端有注入、自带提示词的非 catalog 客户端（Claude Code 等）无注入」的双路径不一致（tech-debt-tracker 第 17 条①），并让注入能力成为转换层可复用原语，供后续 agent 插件接入。opencode-zen 维持现状不注入（2026-10-14 决策：其门禁不检查 system 内容，客户端指令原样透传）。

## 范围

- 包含：
  - llm-bridge 新增客户端系统提示词剥离助手（`stripClientSystemPrompt(protocol, body)`）及单测。
  - 四插件请求转换层接线：zcode / qoder / codebuddy 调用共享助手，agy 在自有转换内联实现（agy 不依赖 llm-bridge，维持独立转换）。
  - catalog 去注入：删除四处 `withAgentSystemPrompt` 调用与相关注释，目录条目回归各自来源基底。
  - plugin-api 契约收缩：移除 `CatalogServices.withAgentSystemPrompt`、`host.ts` 转发导出与网关侧实现。
  - 测试更新：四个 gateway 测试的目录断言翻转；各插件新增请求级注入断言；`zcode-request.test.ts` 现有 system 断言按新语义改写。
  - 文档：`docs/fingerprint-data.md` 接线章节改写、tech-debt-tracker 第 17 条状态更新、llm-bridge README 补导出。
- 不包含：
  - opencode-zen 的任何行为变更。
  - 配置项与 `config.schema.json` 变更（注入为指纹必需，无条件生效，不加开关）。
  - qoder/agy/codebuddy 目录条目提示词清空（`base_instructions: ""` + 剥 `model_messages` 的 vendor 预设式做法）——列为可选后续优化，见决策记录。
  - 响应方向转换、compaction 改写路径（`withCodexCompaction` 的 COMPACTION_PROMPT 是 user 消息，与系统槽替换互不影响）。

## 背景

- 相关文档：
  - `docs/exec-plans/tech-debt-tracker.md` 第 17 条：双路径不一致与「接非 catalog 客户端时在转发路补同一份提示词注入」的缓解指引；③记录的全量替换错位风险（官方指令与调用端工具不匹配的幻觉）维持已知状态。
  - `docs/histories/2026-10/20261009-1655-agent-system-prompt-synthesis-time-replacement.md`：注入点从 serve 期下移到合成期的历史；其中「Codex 请求 body 无 instructions 字段，系统提示词是 input 数组首条 developer 消息」的实测结论是本次语义定义的依据。
  - `docs/fingerprint-data.md`：各插件官方提示词的提取方法与 `base_instructions 接线`章节（本次改写）。
  - `docs/exec-plans/completed/zen-gate-fingerprint-reduction.md`：zen 回落官方 Codex 提示词的先例。
- 相关代码路径：
  - 注入原语：`apps/gateway/src/catalog.ts:410`（`withAgentSystemPrompt`，同时替换 `base_instructions` 与 `model_messages.instructions_template`——只改前者对 Codex 客户端无效）。
  - 契约：`packages/plugin-api/src/types.ts:130`（`CatalogServices.withAgentSystemPrompt`）、`packages/plugin-api/src/host.ts:38`（转发导出）、`apps/gateway/src/host-services.ts`（整体传 catalog 模块对象，删函数即同步收缩）。
  - 四处 catalog 注入调用：`packages/zcode/src/index.ts:104`（`publishServedCatalog`）、`packages/qoder/src/catalog.ts:201`（`buildQoderCatalog`）、`packages/agy/src/catalog.ts:276`（`buildAgyCatalog`）、`packages/codebuddy/src/catalog.ts:249`（`cloneCodexBase`）。
  - 官方提示词常量：zcode `packages/zcode/src/request-context.ts`（`ZCODE_AGENT_SYSTEM_PROMPT`）、qoder `packages/qoder/src/transport.ts`（`QODER_AGENT_SYSTEM_PROMPT`）、agy `packages/agy/src/transport.ts`（`AGY_AGENT_SYSTEM_PROMPT`）、codebuddy `packages/codebuddy/src/request-context.ts`（`CODEBUDDY_AGENT_SYSTEM_PROMPT`）；均源自各包 `fingerprint-data.json`。
  - 转换层落点：zcode `packages/zcode/src/request.ts:278`（instructions 入 system）、`:295`（converted.system 入 system）；qoder `packages/qoder/src/request.ts:83-85`（首条 system 兜底）、`:110-115`（旁白 + 信封 `system`）；codebuddy `packages/codebuddy/src/request.ts:283-297`（system 基底与旁白拼装）；agy `packages/agy/src/request.ts:559-561`（system/developer 收集）、`:672-674`（`systemInstruction` parts 组装）。
  - 桥接：`packages/llm-bridge/src/request.ts`（`convertRequest` 四源归一，`to === from` 时结构化克隆直通；本任务不动其协议矩阵，只加剥离助手）。
  - 测试：`test/zcode-gateway.test.ts:393-398`、`test/qoder-gateway.test.ts:305-309`、`test/agy-gateway.test.ts:272-274`、`test/codebuddy-gateway.test.ts:1049-1067`（目录断言）；`test/zcode-request.test.ts:27/:38-44`（system 透传断言）。
- 已知约束：
  - 注入语义（用户已确认，见决策记录）：**整体替换**——客户端系统级内容全部丢弃，官方提示词为上游系统提示词唯一基底；旁白保留其后。
  - 四协议的「客户端系统级内容」定义：responses 为 `instructions` 字段 + `input` 中的 system/developer 消息项；chat-completions 为 `messages` 中 system/developer 消息；anthropic 为顶层 `system`（字符串或块数组）；gemini 为 `systemInstruction`。
  - 插件边界：`packages/plugin-api` 保持最小契约；agy 不引入 llm-bridge 依赖（repo 规则：避免仅服务单一调用点的依赖）。
  - 「官方提示词 + 后缀旁白」形态对四家上游门禁已有生产先例（dropped 旁白现状即如此），纯替换后的上游请求体与今日 Codex 经 catalog 注入后的实际到达形状一致。

## 风险

- 风险：非 Codex 客户端（Claude Code 等）自带的系统提示词被丢弃，调用方自定义指令不再到达模型；全量替换的错位风险（官方指令与调用端工具不匹配）已由 tech-debt 17-③ 记录。
  - 缓解方式：这是与今日 Codex 路径完全一致的有意行为（指纹保真优先）；错位风险维持 tech-debt 已知状态，若后续要缓解可评估「官方在前 + 客户端在后」拼接（见决策记录）。
- 风险：去注入后 qoder/agy/codebuddy 目录条目携带 gpt 基线快照的官方 Codex 模板（约 1.9 万字符），Codex 客户端会渲染并上行到网关后被丢弃，client→gateway 请求体变大。
  - 缓解方式：网关→上游形状不变；基线保留是 zen 已验证的目录形态（快照基底可用）。若在意流量可做可选后续：vendor 预设式清空两字段。
- 风险：旧落盘目录缓存（qoder-{cn,intl}-catalog.json 等「落盘即终态」）仍带注入提示词，与新版代码并存。
  - 缓解方式：整体替换是幂等的——旧缓存提示词与转换层注入为同一份文本，替换后上游等价；缓存自然刷新后行为一致，不强制失效。
- 风险：plugin-api 移除 `withAgentSystemPrompt` 是公开包破坏性变更。
  - 缓解方式：仓库处于 0.x，minor 版本允许破坏；发布说明注明；仓内消费方全部随本次迁移。
- 风险：zcode 切段路径中 `converted.body.system` 的收集（`request.ts:295`）与桥接四源归一合并行为叠加，可能残留客户端系统内容。
  - 缓解方式：在客户端体进入桥接前完成剥离（pre-step），桥接不再产出客户端系统内容；请求级测试逐协议断言客户端提示词不出现。

## 里程碑

1. **llm-bridge 剥离助手**：新增 `packages/llm-bridge/src/system-prompt.ts` 导出 `stripClientSystemPrompt(protocol, body)`（尽力剥离、形状非法不报错交由后续校验），`src/index.ts` 补导出；新增四协议剥离单测。
2. **四插件转换层接线**：
   - zcode：`translateZcodeRequest` 在 instructions 校验后、切段前对客户端体剥离；`:278` 改为 `system.push(ZCODE_AGENT_SYSTEM_PROMPT)`；切段处 `instructions: undefined` 维持。
   - qoder：入口剥离；`:83-85` 首条 system 兜底改为官方提示词；旁白追加与信封 `system` 组装不变。
   - codebuddy：`convertRequest` 前剥离（确认 preProcess 不依赖系统槽）；`:290-297` system 基底改为官方提示词、旁白接续其后。
   - agy：内联不再收集 `body.instructions` 与 system/developer 项，`systemInstruction.parts` 首位固定官方提示词，旁白随后；`normalizeSourceItems` 对 chat/anthropic/gemini 源同样不产出系统内容。
   - 各插件请求级测试：至少 responses 源 + 一种非 responses 源，断言上游系统槽以官方提示词为基底、客户端提示词不出现、旁白在后；改写 `zcode-request.test.ts:27/:44`。
3. **catalog 去注入与契约收缩**：删除四处注入调用（zcode `publishServedCatalog` 的 map、qoder/agy 的合成尾调用、codebuddy `cloneCodexBase` 尾调用）；zcode `index.ts` 中 2026-10-09 双字段替换的知识性注释迁移到转换层代码注释；删 plugin-api `CatalogServices.withAgentSystemPrompt`、`host.ts` 转发、网关 `catalog.ts` 实现；翻转四个 gateway 测试的目录断言（zcode 为 `""`，其余为基线保留 / 不等于 agent 提示词）。
4. **验证、文档与收尾**：`bun run check`、`bun run pack:check`；改写 `docs/fingerprint-data.md` 接线章节（含 zen 差异与原因）；更新 tech-debt-tracker 第 17 条（①已解决、③维持已知）；llm-bridge README 补导出；按规范补历史记录（代码实施任务需要 `docs/histories/` 条目，含 diff 统计）。

## 验证方式

- 命令：`bun run test`（各阶段相关子集）、`bun run typecheck`；完成后 `bun run check` 与 `bun run pack:check`。
- 手工检查：`/v1/models` 返回的四家条目不再携带 agent 提示词（zcode 为空串、qoder/agy/codebuddy 为基线快照文案）；`zcode-catalog.json` 等落盘产物同口径。
- 观测检查：开启请求日志后分别用 responses 客户端与非 catalog 客户端（anthropic/chat）各发一条请求，确认上游请求体系统槽为官方 agent 提示词（+旁白），客户端系统提示词不出现；Codex 旧缓存过渡期上游形状不变。

## 进度记录

- [x] 调研完成：注入链路、转换层落点、契约影响已确认（2026-10-23，本计划）。
- [x] 里程碑 1：llm-bridge 剥离助手与单测（`packages/llm-bridge/src/system-prompt.ts` + `test/llm-bridge-system-prompt.test.ts`，6 用例）。
- [x] 里程碑 2：四插件转换层接线与请求级测试（含非 responses 源用例：zcode/codebuddy anthropic、qoder chat、agy chat）。
- [x] 里程碑 3：catalog 去注入、plugin-api 契约收缩与目录断言翻转（另翻转 agent-protocol-matrix 与 agy-protocol 的 system 投影断言）。
- [x] 里程碑 4：`bun run check`（1254 测试全过）与 `bun run pack:check` 通过；fingerprint-data.md / tech-debt-tracker 第 17 条 / llm-bridge README 已更新；历史记录落盘。

## 决策记录

- 2026-10-23：注入语义采用**整体替换**（客户端系统提示词丢弃，官方提示词为唯一基底）。理由：与今日 Codex 经 catalog 注入后的实际上游行为完全一致，指纹最保真、token 最省；tech-debt 17-③ 的错位风险维持已知状态。备选「官方在前 + 客户端在后」拼接（保留调用方操作性指令，代价是上游 token 增多且两套 persona 并存）经用户决策未采用，留作错位风险显性化时的再评估项。
- 2026-10-23：去注入后目录条目保留各自来源基底（zcode 为 vendor 预设 `base_instructions: ""`，qoder/agy/codebuddy 为 gpt 基线快照官方 Codex 提示词，zen 同款先例），不做 vendor 预设式清空；「清空两字段以省 client→gateway 流量」记为可选后续优化。
- 2026-10-23：agy 内联实现剥离（不新增 llm-bridge 依赖），维持「AGY 保持独立转换」的既有边界；zcode/qoder/codebuddy 复用 llm-bridge 共享助手，注入原语沉淀在转换层供后续 agent 插件接入。
- 2026-10-23：plugin-api 契约随迁移收缩（移除 `CatalogServices.withAgentSystemPrompt`），0.x minor 允许破坏，仓内无残留消费方。
- 2026-10-23（实施追加）：`stripClientSystemPrompt` 定为**非变更式**（返回剥离后的新对象、调用方原始请求保持不变）——实施中 agent-protocol-matrix 的「不修改源请求」契约测试暴露了原地变异问题；qoder/codebuddy 在剥离前保留 instructions 类型显式校验（显式拒绝语义不因剥离而丢失）；codebuddy「developer 含图片显式拒绝」随整体替换改为静默剥离（内容不再进入上游，无需校验）。
