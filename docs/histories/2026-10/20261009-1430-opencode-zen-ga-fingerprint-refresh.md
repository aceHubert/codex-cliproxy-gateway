## [2026-10-09 14:30] | Task: 同步 OpenCode Zen 指纹到官方 opencode2 GA 2.0.26

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Fable 5.1`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> opencode2 发布了正式版本的,更新一下获取最新的 fingerprint-data.json, 特别是 UA

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/fingerprint-data.json`、`src/opencode-zen/user-agent.ts`、`src/opencode-zen/fingerprint.ts`、`test/opencode-zen-*.test.ts`

**Key Actions:**
- **[UA 三段]**: `fingerprint-data.json` 的 `clientVersion`/`channel` 由 `0.0.0-beta-19086`/`beta` 改为 `2.0.26`/`latest`（`clientName` 仍为 `cli`），即 GA 客户端的 `opencode/latest/2.0.26/cli`。
- **[模板]**: `agentSystemPrompt` 换成 GA 的 `session/runner/prompt/system.txt` 渲染结果（`${OPENCODE_TOOL_GUIDANCE}` 已按 shell/write/edit 三段指引替换），17717 → 1474 字符；`titleSystemPrompt` 与快照逐字节相同，未改。
- **[版本获取]**: `user-agent.ts` 的包与标签从 `@opencode-ai/cli` 的 `beta` 切到 `@opencode/cli` 的 `latest`；渠道段规则改为「有预发布段取预发布段，否则取标签名」（GA 正式版无预发布段），跨渠道仍拒绝采信。
- **[测试]**: UA 断言、解析用例、存储用例与新渠道规则对齐；缓存模板自检改为断言 GA 提示词开头与已渲染的工具指引，并断言占位符无残留。

### 🧠 Design Intent (Why)
GA 换了发布线：正式版在 `@opencode/cli`（`latest` = 2.0.26），旧 beta 线 `@opencode-ai/cli` 停在 0.0.0-beta-19271，所以只改版本号会长期停在 beta 构建上。UA 形状未变（仍是四段式 `opencode/<channel>/<version>/<clientName>`），变化在取值：GA 的 channel 是 `latest`、无预发布段——原解析器「无预发布段即拒绝」会让动态获取对 GA 失效，因此把渠道段规则改成「预发布段优先、否则取标签名」。版本号取自二进制内嵌的 UA 字面量（`--user-agent=opencode/latest/2.0.26/cli`）并经真实上游验证，未依赖抓包。

### 📊 Change Stats
> `src/opencode-zen/` 整体未纳入版本控制，无法用 `git diff` 取数；下表为本次触碰行的手工计数。

- **Files changed:** 6
- **Insertions:** +150
- **Deletions:** -130

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/fingerprint-data.json` | 改 3 个字段（38.1KB → 21.6KB） | — |
| `src/opencode-zen/user-agent.ts` | +9 | -8 |
| `src/opencode-zen/fingerprint.ts` | +1 | -1 |
| `test/opencode-zen-user-agent.test.ts` | +120 | 重写 |
| `test/opencode-zen-fingerprint.test.ts` | +3 | -2 |
| `test/opencode-zen-gateway.test.ts` | +2 | -2 |
| `docs/`（本记录） | 若干 | — |

### 📁 Files Modified
- `src/opencode-zen/fingerprint-data.json`、`src/opencode-zen/user-agent.ts`、`src/opencode-zen/fingerprint.ts`
- `test/opencode-zen-user-agent.test.ts`、`test/opencode-zen-fingerprint.test.ts`、`test/opencode-zen-gateway.test.ts`
- `docs/histories/2026-10/20261009-1430-opencode-zen-ga-fingerprint-refresh.md`

### ✅ Verification
- **真实上游门禁探针 5/5 HTTP 200**（model `nemotron-3.5-lightning-free`）：GA UA + GA 标题模板（带/不带 traceparent·b3）、GA UA + GA agent 模板 + 现有 12 工具、GA UA + 旧 beta 标题模板、旧 beta UA + GA 标题模板。旧指纹今天仍可用，本次是防漂移同步而非救火；追踪头当前非必需（去掉仍 200），保留不影响。
- **网关端到端**（临时 handler + 真实上游）：转发头 `user-agent` = `opencode/latest/2.0.26/cli`，`x-opencode-client: cli`，project 40 hex，会话三回填一致；带工具请求注入 GA agent 模板并并入 13 个工具（客户端 1 + 官方 12）→ 200 且回答正常；无工具请求注入标题模板 → 200；目录 11 个 zen 条目。
- `bun run check` 全绿：类型检查 + 738 测试 + UI/CLI 构建，退出码 0。

### 📌 Notes
- **工具定义未重取**：GA 的 `edit` 描述与快照逐字节相同，门禁只看官方工具名在场，故沿用原 12 个 JSON 定义（已实测通过）。若后续需要严格对齐 GA 的 schema（Effect schema 运行时转 JSON Schema，未随包发布），需再抓一次真实请求体。
- **GA 标头集有新增**（`x-opencode-session-id`、`X-Session-Id`、`x-opencode-parent-session-id`），本次未跟随：现有标头集实测仍过门禁，跟随需先确认门禁是否校验，避免无谓改动。
- mitm 抓包路线本次未走通（GA 客户端内部 server 在隔离 HOME 下起不来），UA 取自二进制内嵌字面量并经真实上游验证。
- GA 的 agent 模板比 beta 短一个数量级（1.47KB vs 17.7KB）：GA 把工具相关指引移到了 system.txt 的渲染插槽与工具自身描述里。
