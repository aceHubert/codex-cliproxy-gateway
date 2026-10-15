## [2026-10-15 09:54] | Task: gpt-5.5 下线兼容（基底回退 + 快照刷新）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `fix/codebuddy-web-switch-account`（复审追加时实际所在分支；初记时在 main）

### 📥 User Query
> gpt-5.5 正式下线，查一下 cliproxy api 基于 gpt-5.5 作为 catalog 生成是否有变化（确认 CLIProxyAPI 已在 e240bd8 加回退）；如何修改、方案是什么；生成待执行文件到 docs/ 下；刷新 codex_client_models.json，同步更新一下，因为 gpt-5.5 确认更新下线了。

### 🛠 Changes Overview
**Scope:** packages/models、packages/{agy,qoder,opencode-zen,codebuddy}、apps/gateway、test/

**Key Actions:**
- **[基底回退（执行计划 M1/M2）]**: `packages/models` 新增 `CODEX_BASELINE_SLUG` / 纯函数 `codexBaselineEntry`（优先 gpt-5.5，缺失回退快照首条，对齐 CLIProxyAPI e240bd8）/ 包装 `getCodexBaselineEntry`；agy、qoder、opencode-zen、codebuddy 四插件目录合成与网关 `synthesizeModelEntry` 第四级兜底共五处 find+throw 替换为共享回退（空快照仍 throw，`baseSlug` 参数优先级保留，plugin-api 契约不变）。
- **[快照刷新]**: `codex_client_models.json` 按本机 Codex CLI 0.155.0 `codex debug models --bundled` 重导出（2 空格缩进、保留键序）：8→9 条目，新增 gpt-daybreak-blue-latest / gpt-daybreak-red-latest / gpt-5.4，移除 gpt-reserve / gpt-5.3-codex-spark；**gpt-5.5 仍在 bundle 中**（下线是服务端目录层面，见当日 models-cache 拉取已无 gpt-5.5）。字段集换代：全部条目移除 minimal_client_version / prefer_websockets / supports_parallel_tool_calls / supports_reasoning_summaries(-_parameter) / default_service_tier / available_in_plans / model_specialty / tool_mode / multi_agent_* / auto_* / requires_sandboxed_review 等 14 字段，新增 effective_context_window_percent / supports_experimental_context；gpt-5.5 的 base_instructions(19,737)/instructions_template(19,754) 与 reasoning 档位文案不变，zen 提示词继承不受影响。
- **[测试（M3）]**: gateway.test 的「缺 gpt-5.5 即 throw」改写为「preferred 缺失回退克隆首条」+ 空快照 throw；model-presets.test 的快照存在性断言改为基底成员校验并新增纯函数三例；zen 两处手写 `find(gpt-5.5)` 基底查找改为 `getCodexBaselineEntry()`（快照将来真正去掉 gpt-5.5 时断言自动跟随新基底）。

### 🧠 Design Intent (Why)
CLIProxyAPI 已在 2026-10-12 e240bd8 证明上游 Codex 目录不再返回 gpt-5.5（其 fetch 工具需克隆首条注入）。本仓库五处目录合成硬依赖 gpt-5.5（缺失即 throw），且快照刷新来源是 `codex debug models --bundled`——CLI bundle 仍带 gpt-5.5 只是时间差，回退先行保证下次刷新不炸；本次刷新同时把字段集换代吸收进来（各插件本就覆盖/删除换代涉及的字段，测试证实零兼容问题）。回退收敛到一个共享函数而非五处内联，未来基底退役只改 `packages/models` 一处。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，按本任务文件统计；同工作区另有 webui codebuddy 账号选择任务的未提交改动未计入）。

- **Files changed:** 11
- **Insertions:** +512
- **Deletions:** -669

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/models/codex_client_models.json` | +417 | -629 |
| `packages/models/src/index.ts` | +20 | -1 |
| `apps/gateway/src/catalog.ts` | +5 | -5 |
| `packages/agy/src/catalog.ts` | +3 | -4 |
| `packages/qoder/src/catalog.ts` | +3 | -4 |
| `packages/opencode-zen/src/catalog.ts` | +7 | -8 |
| `packages/codebuddy/src/catalog.ts` | +4 | -5 |
| `test/gateway.test.ts` | +14 | -3 |
| `test/model-presets.test.ts` | +33 | -2 |
| `test/opencode-zen-catalog.test.ts` | +4 | -5 |
| `test/opencode-zen-gateway.test.ts` | +2 | -3 |

### 📁 Files Modified
- `packages/models/codex_client_models.json`
- `packages/models/src/index.ts`
- `apps/gateway/src/catalog.ts`
- `packages/agy/src/catalog.ts`
- `packages/qoder/src/catalog.ts`
- `packages/opencode-zen/src/catalog.ts`
- `packages/codebuddy/src/catalog.ts`
- `test/gateway.test.ts`
- `test/model-presets.test.ts`
- `test/opencode-zen-catalog.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/exec-plans/active/codex-baseline-fallback.md`（执行计划，随本任务完成归档至 completed/）

### 追加（2026-10-15 11:5x，复审整改变段）

**来源**：会话 9854c991 对本计划 + webui-codebuddy-account-select 计划的复审，第 2 项发现「未登记的运行时行为变化，出在网关克隆路径」；用户确认 newapi 上游不支持 WebSocket，直接固化 `prefer_websockets: false`，并追加两项一致性整改。

- **[克隆路径固化]**: 网关 `synthesizeModelEntry` 第四级克隆分支显式 `model.prefer_websockets = false`（newapi 仅 HTTP；旧 gpt-5.5 基底的 true 会诱导 Codex 先试探 WS 再降级；与四插件的显式覆盖对齐），未来快照字段集换代不再静默翻转该行为；gateway.test 兜底用例补断言（合成基底声明 true 仍被覆盖为 false）。
- **[字面量收敛]**: 删除 `NEWAPI_FALLBACK_BASE_SLUG`（apps/gateway），默认基底统一引用 `packages/models` 的 `CODEX_BASELINE_SLUG`——非测试代码 gpt-5.5 字面量从两处归零，复审指出的「单点改一处不实」随之成立。
- **[基底切换 + 快照再刷新]**: 发现本机 Codex CLI 已到 0.162.1（仓库快照停在 0.155.0），按 `codex debug models --bundled` 重新导出：9→11 条目，新增 gpt-6.1-sol / gpt-6-sol / gpt-6-luna，移除 gpt-5.4（仓库零引用，grep 证实）；`CODEX_BASELINE_SLUG` 由 gpt-5.5（服务端已下线，仅 CLI bundle 兜留）切换为 **gpt-6-luna**。注意：快照中 luna 的实际 slug 是 `gpt-6-luna`（同族还有 gpt-5.6-luna，用户口述的「gpt-6-luna」经快照核实存在）。zen 提示词继承断言本就跟随 `getCodexBaselineEntry()`，自动跟随新基底。

**验证**：model-presets / gateway / opencode-zen-catalog / codebuddy-catalog / model-catalog-dynamic / bundled-model-overrides 六文件 178 用例全过；同工作区并行进行的 uid 账号选择改动（另一会话）不在本段验证范围。

**追加改动统计**（相对上一段的未暂存 diff）：

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/models/codex_client_models.json` | +426 | -129 |
| `apps/gateway/src/catalog.ts` | +6 | -11 |
| `packages/models/src/index.ts` | +5 | -4 |
| `test/model-presets.test.ts` | +4 | -4 |
| `test/gateway.test.ts` | +2 | -0 |
