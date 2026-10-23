## [2026-10-23 10:58] | Task: 提示词注入迁移到请求转换层

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `feat/agent-system-prompt-conversion-layer`

### 📥 User Query
> 计划一下把 plugin 的提示词注入从 codex 的 catalog 修改到转换层支持其他 agent 调用
> （计划写到 docs/ 下；创建一个新分支开始执行；注入语义确认采用「整体替换」）

### 🛠 Changes Overview
**Scope:** packages/llm-bridge、packages/zcode、packages/qoder、packages/agy、packages/codebuddy、packages/plugin-api、apps/gateway、test/、docs/

**Key Actions:**
- **[转换层助手]**: llm-bridge 新增 `stripClientSystemPrompt(protocol, body)`（`packages/llm-bridge/src/system-prompt.ts`）：按客户端入口协议返回剥离全部系统级内容的新请求体（responses 的 instructions 与 input 中 system/developer 消息、chat 的 system/developer 消息、anthropic 顶层 system、gemini systemInstruction），非变更式、尽力剥离不抛错。
- **[四插件接线]**: zcode/qoder/codebuddy 在请求入口剥离客户端系统内容并把各自官方 `agentSystemPrompt` 种入上游系统槽唯一基底（zcode anthropic `system`、codebuddy chat 首条 system、qoder 信封 `system`），网关旁白（dropped 通告、视觉适配说明）接续其后；agy 内联实现（不收集 instructions 与 system/developer 项，`systemInstruction.parts[0]` 固定官方提示词）。任何客户端协议进入均生效。
- **[catalog 去注入]**: 删除四处 `withAgentSystemPrompt` 合成期调用（zcode `publishServedCatalog`、qoder `buildQoderCatalog`、agy `buildAgyCatalog`、codebuddy `cloneCodexBase`）；条目回归各自基底（zcode 为 vendor 预设空串，其余三家为 gpt 基线快照官方 Codex 模板，zen 同款先例）；旧缓存注入值与转换层注入同一文本，整体替换幂等，无需强制失效。
- **[契约收缩]**: plugin-api 移除 `CatalogServices.withAgentSystemPrompt`（types.ts、host.ts 转发、gateway `catalog.ts` 实现随删，host-services 整体传模块对象自动同步）；0.x minor 允许破坏，仓内无残留消费方。
- **[测试]**: 新增 `test/llm-bridge-system-prompt.test.ts`（四协议剥离 + 非变更语义，6 用例）；四插件请求级注入断言（responses 源 + 各一家非 responses 源，断言上游系统槽为官方提示词、客户端系统内容不出现、旁白在后）；翻转四个 gateway 测试的目录断言与 agent-protocol-matrix / agy-protocol 的 system 投影断言。
- **[文档]**: `docs/fingerprint-data.md` 接线章节改写（转换层整体替换 + 历史真因留存 + 缓存时序简化）并补更新记录行；tech-debt-tracker 第 17 条标注①已解决；llm-bridge README 补新导出；执行计划归档至 `docs/exec-plans/completed/agent-system-prompt-conversion-layer.md`。

### 🧠 Design Intent (Why)
catalog 注入只惠及读目录的 Codex 客户端：`base_instructions`/`instructions_template` 经 `/v1/models` 下发后由 Codex 渲染发回，Claude Code 等自带提示词、不读 catalog 的客户端调用同一模型时上游收不到官方提示词，指纹伪装断链（tech-debt 17-①）。下移到转换层后注入与客户端形态解耦：整体替换语义（用户确认）使上游请求体与官方客户端实发形状一致且与今日 Codex 路径行为等价；agy 不引入 llm-bridge 依赖维持独立转换边界；zen 维持 2026-10-14 的不注入决策（门禁不检查 system）。

### 📊 Change Stats
> 数据来自 `git diff --stat main..HEAD`（提交 3b9ee86）。

- **Files changed:** 31
- **Insertions:** +459
- **Deletions:** -170

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/llm-bridge/src/system-prompt.ts` | +53 | -0 |
| `test/llm-bridge-system-prompt.test.ts` | +82 | -0 |
| `docs/exec-plans/completed/agent-system-prompt-conversion-layer.md` | +88 | -0 |
| `docs/fingerprint-data.md` | +46 | -35 |
| `packages/zcode/src/request.ts` | +8 | -4 |
| `packages/qoder/src/request.ts` | +12 | -5 |
| `packages/codebuddy/src/request.ts` | +10 | -11 |
| `packages/agy/src/request.ts` | +6 | -20 |
| `packages/zcode/src/index.ts` | +6 | -6 |
| `packages/qoder/src/catalog.ts` | +3 | -4 |
| `packages/agy/src/catalog.ts` | +3 | -3 |
| `packages/codebuddy/src/catalog.ts` | +5 | -4 |
| `packages/plugin-api/src/types.ts` | +0 | -1 |
| `packages/plugin-api/src/host.ts` | +0 | -1 |
| `apps/gateway/src/catalog.ts` | +0 | -17 |
| `test/zcode-request.test.ts` | +18 | -3 |
| `test/qoder-request.test.ts` | +22 | -5 |
| `test/codebuddy-request.test.ts` | +29 | -11 |
| `test/agy-request.test.ts` | +21 | -5 |
| `test/agent-protocol-matrix.test.ts` | +8 | -5 |
| `test/agy-protocol.test.ts` | +5 | -3 |
| 其余（各 gateway 目录断言、index 注释、README、tech-debt） | +31 | -32 |

### 📁 Files Modified
- `packages/llm-bridge/src/system-prompt.ts`（新增）、`packages/llm-bridge/src/index.ts`、`packages/llm-bridge/README.md`
- `packages/zcode/src/request.ts`、`packages/zcode/src/index.ts`
- `packages/qoder/src/request.ts`、`packages/qoder/src/catalog.ts`、`packages/qoder/src/index.ts`
- `packages/codebuddy/src/request.ts`、`packages/codebuddy/src/catalog.ts`、`packages/codebuddy/src/index.ts`
- `packages/agy/src/request.ts`、`packages/agy/src/catalog.ts`、`packages/agy/src/index.ts`
- `packages/plugin-api/src/types.ts`、`packages/plugin-api/src/host.ts`、`apps/gateway/src/catalog.ts`
- `test/llm-bridge-system-prompt.test.ts`（新增）、`test/zcode-request.test.ts`、`test/qoder-request.test.ts`、`test/codebuddy-request.test.ts`、`test/agy-request.test.ts`、`test/agent-protocol-matrix.test.ts`、`test/agy-protocol.test.ts`、`test/zcode-gateway.test.ts`、`test/qoder-gateway.test.ts`、`test/codebuddy-gateway.test.ts`、`test/agy-gateway.test.ts`
- `docs/fingerprint-data.md`、`docs/exec-plans/tech-debt-tracker.md`、`docs/exec-plans/completed/agent-system-prompt-conversion-layer.md`（新增）
