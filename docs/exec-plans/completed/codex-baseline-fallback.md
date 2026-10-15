# Codex 目录合成基底回退（gpt-5.5 下线兼容，对齐 CLIProxyAPI e240bd8）

状态：已完成并归档（2026-10-15 执行；`bun run check` 996 pass / 0 fail，见 [历史记录](../../histories/2026-10/20261015-0954-codex-baseline-fallback.md)）。执行时用户追加指令：连同快照刷新一并完成（原「不现在刷新快照」的非目标被推翻，见决策记录）。

## 目标

目录合成对 gpt-5.5 的五处硬依赖（缺失即 throw）改为统一软回退：**优先 `gpt-5.5`，缺失时回退快照首条**（与 CLIProxyAPI 2026-10-12 提交 `e240bd8`「fix(codex): fallback default model template when gpt-5.5 is missing」一致），逻辑收敛到 `@agent-proxy/models` 的一个共享函数；今天快照仍含 gpt-5.5，所有链路行为零变化，但下次用新版 Codex CLI 刷新快照（`codex debug models --bundled`）时 gpt-5.5 消失不再导致 agy/qoder/opencode-zen/codebuddy 目录合成与 newapi 兜底启动报错。

## 范围

- 包含：
  - `packages/models/src/index.ts`：新增唯一新 API——
    - `export const CODEX_BASELINE_SLUG = "gpt-5.5";`
    - 纯函数 `codexBaselineEntry(models, preferredSlug = CODEX_BASELINE_SLUG)`：`find(preferredSlug) ?? models[0]`，空数组 throw 带期望 slug 的明确错误；
    - 包装函数 `getCodexBaselineEntry()`：对 `getCodexModelSnapshot().models` 应用纯函数。纯函数供网关（快照是注入参数）复用，包装供插件（直接消费静态快照）使用。
  - 四个插件目录合成替换 find+throw（均改为 `getCodexBaselineEntry()`，同步更新旁注注释）：
    - `packages/agy/src/catalog.ts` L208-209（含 L203 注释）；
    - `packages/qoder/src/catalog.ts` L149-150；
    - `packages/opencode-zen/src/catalog.ts` L93-94（L25/L84/L128/L140/L325 注释中「gpt-5.5 快照基底」改为「基底（优先 gpt-5.5，缺失回退快照首条）」表述）；
    - `packages/codebuddy/src/catalog.ts` L237-238（`cloneCodexBase`；删除不再使用的 `BASE_SLUG` 常量，L246 prefer_websockets 注释相应调整）。
  - `apps/gateway/src/catalog.ts`：`synthesizeModelEntry` 第四级兜底（L286-289）改为 `codexBaselineEntry(snapshot.models, baseSlug)`——调用方显式 `baseSlug` 仍优先，仅其缺失时回退首条；快照为空仍 throw（错误信息更新）。`NEWAPI_FALLBACK_BASE_SLUG` 常量与 plugin-api 宿主服务签名不变，仅更新 L199-203、L254-262 JSDoc 说明回退行为。
  - 测试（`test/`，node:test 描述性句子命名）：
    - `model-presets.test.ts`：L13 `some(slug === "gpt-5.5")` 改为 `getCodexBaselineEntry()` 返回快照成员条目；新增纯函数三例——优先命中 preferred、preferred 缺失回退首条、空数组 throw；
    - `gateway.test.ts` L3676-3681：原「缺 gpt-5.5 即 throw」改写为「preferred 基底缺失时回退克隆首条」（mock 快照仅含 gpt-6-astra，断言克隆来源字段与标识字段替换）；补空快照 throw 断言（新错误信息）；
    - `opencode-zen-catalog.test.ts` L392-397、`opencode-zen-gateway.test.ts` L796-803：手写 `find(slug === "gpt-5.5")` 基底查找改为 `getCodexBaselineEntry()`，断言逻辑不变——快照将来刷新后提示词继承断言自动跟随新基底；
    - 其余引用 gpt-5.5 的测试（codebuddy-catalog/upstream-visibility/webui/model-exclude/opencode-zen 前缀识别）均为 mock 占位或与基底无关，不动。
  - 文档：新增历史记录 `docs/histories/2026-10/`（含 `git diff --shortstat/--numstat` 统计）；`docs/exec-plans/tech-debt-tracker.md` 追加快照刷新债务行；本计划完成后移至 `completed/`。
- 不包含：
  - 不现在刷新 `packages/models/codex_client_models.json` 快照（不引入 gpt-6.1-sol/gpt-reserve/codex-auto-review 等新条目，避免混入与本目标无关的行为变化；登记为技术债）。
  - 不仿照 CLIProxyAPI 在快照中注入手维护的 gpt-5.5 条目（其 "Legacy coding model" 方式会让 opencode-zen 继承的非官方提示词漂移；回退到真实条目更符合「官方字段集」本意）。
  - 不改配置 schema、Web UI、plugin-api 契约（`baseSlug` 可选参数语义保持）。
  - 不动 zcode 插件（经宿主服务间接走 `synthesizeModelEntry`，传空快照 + vendor 规则，正常路径不触达兜底；空快照仍 throw 属预期防线）。

## 背景

- 相关文档：CLIProxyAPI 提交 [`e240bd8`](https://github.com/router-for-me/CLIProxyAPI/commit/e240bd8)（2026-10-12）、[router-for-me/models 快照](https://github.com/router-for-me/models)、[历史 20260908-1429 vendor-catalog-exact-match](../../histories/2026-09/20260908-1429-vendor-catalog-exact-match.md)（gpt-5.5 兜底定位）、[历史 20260908-1631 relocate-catalog-rules](../../histories/2026-09/20260908-1631-relocate-catalog-rules-to-agents.md)（快照刷新来源 = `codex debug models --bundled`）、[技术债登记](../tech-debt-tracker.md)。
- 相关代码路径：`packages/models/src/index.ts`、`packages/{agy,qoder,opencode-zen,codebuddy}/src/catalog.ts`、`apps/gateway/src/catalog.ts`、`test/{model-presets,gateway,opencode-zen-catalog,opencode-zen-gateway}.test.ts`。
- 已知事实（2026-10-15 调研）：
  - OpenAI 侧 gpt-5.5 已下线：本机 `models-cache.json`（当日 01:17Z，client_version 0.154.0，上游 `https://cliproxy.acehubert.top/v1`）仅剩 6 模型、无 gpt-5.5；GitHub Copilot 侧公告 2026-10-19 移除 GPT-5.5。
  - CLIProxyAPI 的应对（e240bd8）：快照拉取工具 `ensureBaselineModel`（上游无 gpt-5.5 时克隆列表首条注入）、默认模板选择 `defaultTemplate == nil || slug == "gpt-5.5"`（两处）、删除快照必须含 gpt-5.5 的校验、快照重生成（gpt-5.5 改手维护 "Legacy coding model."）。
  - 本仓库快照现状：8 条目，gpt-5.5 在 index 5（首条 gpt-6-astra）；全部条目 `prefer_websockets: true`、除 gpt-5.3-codex-spark（128k）外 context_window 均 272000——首条回退的字段集完整性与 gpt-5.5 同构，各插件本就覆盖/删除 `minimal_client_version`、`prefer_websockets` 等敏感字段。
  - throw 点共 5 处：agy L209、qoder L150、opencode-zen L94、codebuddy L238、gateway L288；测试直接断言 throw/存在性的共 3 处（gateway.test L3676、model-presets.test L13、zen 两文件的基底查找）。
  - opencode-zen 有意继承基底的官方 Codex 提示词（`base_instructions` + `model_messages.instructions_template`，2026-10-14 决策）：回退后继承新基底条目的官方提示词，语义不变（要的就是官方提示词）。

## 风险

- 快照首条顺序由 OpenAI 决定，将来刷新后基底可能换人：各插件对基底的使用面（字段集、reasoning 档位文案 low/medium/high、官方提示词）在 gpt-5.6/gpt-6 家族条目上同构；真实刷新时 zen 提示词继承断言已改为跟随 `getCodexBaselineEntry()`，可即时暴露差异。
- 回退基底含更高 `minimal_client_version`（如 gpt-6-astra 0.153.0）：所有消费方均已删除该字段，无影响；测试有显式断言。
- 网关第四级兜底从「throw」变「克隆首条」：合成条目的 display_name/description/priority 均按既有逻辑重写，仅继承行为字段——与 CLIProxyAPI 行为一致；空快照仍 throw，zcode 空快照 + vendor 失配路径不劣化。
- （2026-10-15 复审补记）快照换代使网关克隆路径继承的**字段集本身**发生变化（旧 gpt-5.5 基底 47 字段 → 新 gpt-6-astra 基底 39 字段；`prefer_websockets`/`supports_parallel_tool_calls`/`supports_reasoning_summaries` 等 11 个行为字段消失、2 个新字段进入合成条目）——「本次不改运行时行为」只对基底选择机制成立，对克隆输出字段集不成立。已修复：克隆分支显式落 `prefer_websockets: false`（newapi 上游仅 HTTP，与四插件的显式覆盖对齐），未来快照刷新不再静默翻转该字段；其余字段集差异方向中性（合成条目本就是未知模型的近似元数据），登记备查。
- `CODEX_BASELINE_SLUG` 未来也要退役（如改用 gpt-5.6 作首选基底）：单点改 `packages/models` 一处即可，五消费方零改动。

## 里程碑

1. M1 `@agent-proxy/models` 基底选择函数 + `model-presets.test.ts` 纯函数测试。
2. M2 四插件 + 网关 `synthesizeModelEntry` 接入回退，替换 5 处 throw，更新注释与 JSDoc。
3. M3 测试改写（gateway 兜底回退、zen 基底查找跟随）与全量验证。
4. 收尾：历史记录、技术债登记、计划归档 `completed/`。

## 验证方式

- 命令：`bun run check`（构建 + 严格类型 + 全量 node:test）全绿。
- 手工检查：`grep -rn "缺少 gpt-5.5 基底条目\|does not contain the \"gpt-5.5\"" apps/ packages/ --include="*.ts"` 仅剩 `packages/models` 空快照防线一处（错误文案更新后为空快照语义）；非测试代码 gpt-5.5 字面量仅剩 `packages/models` 的 `CODEX_BASELINE_SLUG` 一处。
- 观测检查：本次不改运行时行为（快照未刷新、gpt-5.5 仍优先命中），无需真机回归；快照将来刷新时以 `bun run check` + `bun run dev models` 冒烟验证回退生效。

## 进度记录

- [x] M1：`packages/models` 新增 `CODEX_BASELINE_SLUG` / `codexBaselineEntry` / `getCodexBaselineEntry`，纯函数测试三例落地（2026-10-15）。
- [x] M2：agy/qoder/opencode-zen/codebuddy/gateway 五处 throw 替换为共享回退，注释与 JSDoc 更新（2026-10-15）。
- [x] 快照刷新（2026-10-15 追加）：`codex_client_models.json` 按 Codex CLI 0.155.0 `codex debug models --bundled` 重导出，8→9 条目；**bundle 仍含 gpt-5.5**（下线仅在服务端目录层面），但字段集整体换代（移除 prefer_websockets / minimal_client_version 等 14 字段，新增 effective_context_window_percent / supports_experimental_context）——各插件因本就覆盖/删除这些字段，测试零兼容问题。
- [x] M3：gateway 兜底回退测试改写、zen 测试基底查找跟随、model-presets 基底成员断言 + 纯函数三例，`bun run check` 全绿（996 pass / 0 fail，较改动前净增 4 例）。
- [x] 收尾：历史记录（含 diff 统计）、计划归档 `completed/`（tech-debt 无需登记——原计划的「快照刷新债务」已随本任务清偿）。

## 决策记录

- 2026-10-15：回退策略取「优先 gpt-5.5 → 快照首条」而非显式偏好链（如 gpt-5.5 → gpt-5.6-sol → 首条）：对齐 CLIProxyAPI e240bd8 已验证行为，首条确定性由仓库内版本化快照保证，偏好链维护成本无对应收益。
- 2026-10-15：本次不刷新快照、不注入合成 gpt-5.5 条目：当前快照行为零变化是本计划的验证前提；注入手维护条目会让 zen 继承的提示词与官方漂移。
- 2026-10-15：网关第四级保留 `baseSlug` 参数优先级（显式指定 slug 缺失才回退首条）：plugin-api 契约不变，zcode 等 caller 语义不受影响。
- 2026-10-15：zen 两处测试改为 `getCodexBaselineEntry()` 而非保留 gpt-5.5 字面量：测试目的（提示词与基底一致、非 OpenCode 模板）与具体基底解耦，快照刷新后免维护。
- 2026-10-15（执行时）：用户确认 gpt-5.5 已下线并要求立即刷新快照——实测 Codex CLI 0.155.0 bundle 仍含 gpt-5.5 条目（服务端目录已下线、CLI bundle 未同步移除），刷新未触发回退路径但吸收了字段集换代；回退逻辑按计划落地，作为 bundle 后续移除 gpt-5.5 时的前置保障。
- 2026-10-15（执行时）：快照中 gpt-reserve / gpt-5.3-codex-spark 被上游移除、gpt-daybreak-*/gpt-5.4 新增，仓库无任何代码引用被移除条目（grep 证实），无需迁移。
- 2026-10-15（复审）：网关 `synthesizeModelEntry` 克隆分支显式 `prefer_websockets = false`——newapi 上游仅 HTTP，未知模型不应随基底声明 WS 优先（旧 gpt-5.5 基底的 true 会诱导 Codex 先试探 WS 再降级）；与四插件的显式覆盖对齐，快照字段集换代不再影响该行为字段。审核来源：会话 9854c991 的复审发现「未登记的运行时行为变化，出在网关克隆路径」。
- 2026-10-15（复审追改）：删除网关 `NEWAPI_FALLBACK_BASE_SLUG`，默认基底统一引用 `packages/models` 的 `CODEX_BASELINE_SLUG`——非测试代码 gpt-5.5 字面量归零（复审指出的「单点改一处不实」随之成立，本文件「验证方式」中的字面量计数以本条为准）。
- 2026-10-15（复审追改）：快照按本机 Codex CLI 0.162.1 再刷新（9→11 条目：新增 gpt-6.1-sol / gpt-6-sol / gpt-6-luna，移除 gpt-5.4，零引用），`CODEX_BASELINE_SLUG` 由 gpt-5.5 切换为 **gpt-6-luna**（快照实际 slug；同族 gpt-5.6-luna 仍在快照中但非首选）——gpt-5.5 服务端已下线、bundle 兜留只是时间差，主动切到现役条目，回退机制保留给未来任何基底退役。
