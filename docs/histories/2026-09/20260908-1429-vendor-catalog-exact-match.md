## [2026-09-08 14:29] | Task: 厂商官方目录完全匹配优先于 gpt-5.5 兜底

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 是不是也应该维护一个常规的models.json 呢？做完全匹配，而不是非gpt模型 fallback 到 gpt-5.5
> 目前应该是glm, kimi, deepseek 是官方支持codex, 可以预设这3家（附 Kimi 官方文档链接，DeepSeek 需要找）
> 不是改根目录下的models.json 哦 / 这个是用于 cliproxy api 替换配置的，放在models/

### 🛠 Changes Overview
**Scope:** codex-cliproxy（models/、src/、test/、README.md）

**Key Actions:**
- **[厂商目录]**: 新增 `models/vendor_models.json`（Codex 目录格式，构建期随 dist 内联）：GLM（glm-5.3/glm-5.3-flash/glm-5-turbo）、Kimi（k3 1M / k3-256k，条目取自 kimi.com 官方 Codex 指南）、DeepSeek（deepseek-v4-flash/pro/flash-vision-exp，条目取自 api-docs.deepseek.com 官方 Codex 指南：1M 窗口、low/high/max 推理档、tokens 截断策略）。根目录 models.json 保持纯覆盖表不动（中途曾误改 deepseek 组，已完整还原）。
- **[四级合成优先级]**: `synthesizeModelEntry` 改为 vendor_models.json 精确命中（大小写不敏感）→ codex_client_models.json 快照精确命中 → models.json 覆盖规则命中（新增 `minimalModelEntry` 极简基底 + 规则字段，零 GPT 专属残留）→ gpt-5.5 克隆兜底；priority 一律按序重排。
- **[解析泛化]**: `parseCodexClientModels` 更名 `parseCodexCatalog`，同时校验两份内联目录；`fetchNewApiCatalog`/`fetchUpstreamCatalog` 以 options 对象接收 `{snapshot, vendors, overrides}`；cli 的 install/models --sync 提前解析 models.json 规则传入合成（`loadModelOverrideRules`），`rebuildCatalog` 改收已解析文件避免二次下载。
- **[测试与文档]**: 合成测试覆盖四级阶梯（vendor 完整条目/快照条目/干净基底/gpt-5.5 兜底，断言无 model_messages、prefer_websockets 等 GPT 残留），README 改为四级优先级说明。

### 🧠 Design Intent (Why)
gpt-5.5 兜底克隆会携带 GPT 专属字段（model_messages 系统提示词、low/medium/high/xhigh 推理档、prefer_websockets 等），对 GLM/Kimi/DeepSeek 这类官方支持 Codex 的厂商完全错误；这三家官方文档各自提供完整的 Codex catalog 条目，以内联厂商目录做完全匹配即可获得与官方直连一致的元数据，gpt-5.5 仅作为真正未知模型的最后兜底（CLIProxyAPI 同款行为）。

### 📊 Change Stats
> 数据来自 `git diff --numstat` 与新增文件（工作区未提交改动，含同日 new-api 系列任务累计；根目录 models.json 的剩余改动为任务开始前的用户既有修改）。

- **Files changed:** 11 + 新增 models/vendor_models.json（8 条官方条目）
- **Insertions:** 累计约 +700（含新增 vendor_models.json 约 230 行）
- **Deletions:** 累计约 -34

### 📁 Files Modified
- `models/vendor_models.json`（新增）
- `src/catalog.ts`、`src/cli.ts`
- `test/gateway.test.ts`（120 用例全过）
- `README.md`
