## [2026-10-09 12:30] | Task: OpenCode Zen 客户端 UA 改为运行时获取版本

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Fable 5.1`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 把 UA 这个使用新方法获取
（前文为用户对另一 OpenCode Zen 第三方插件 dsh 的指纹取法调研：该插件用「动态拉 unpkg 取最新版本号拼 UA + 工具填充」代替静态快照，其实测配方今日已全部 403；其中唯一值得吸收的是 UA 版本运行时获取。）

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/`（user-agent.ts 新增、fingerprint.ts、index.ts）、`test/opencode-zen-user-agent.test.ts`（新增）、`test/opencode-zen-gateway.test.ts`

**Key Actions:**
- **[版本获取]**: 新增 `user-agent.ts`：按 npm dist-tags（`@opencode-ai/cli` 的 `beta` 标签，该包 bin 即 opencode2）在运行时取当前 beta 版本，组装四段式 UA；解析只认版本串自带的渠道段，无预发布段的正式版不猜；默认 6 小时 TTL，失败静默回退 `fingerprint-data.json` 快照。
- **[指纹解耦]**: `fingerprint.ts` 导出 `ZEN_CLIENT_CHANNEL`/`ZEN_CLIENT_VERSION`/`ZEN_CLIENT_NAME`，`buildZenUpstreamHeaders` 增加可选 `userAgent` 参数（缺省仍是快照，调用方与既有测试不受影响）。
- **[适配器接线]**: `index.ts` 引入 `userAgentStore` 依赖与 `zenHeaders(session)` 局部助手，6 处标头构造点（目录、元数据、探针、chat 转发、responses 转发）统一走同一 UA；启动与目录刷新同节奏调用 `userAgent.refresh()`。
- **[测试]**: 新增 8 个用例覆盖版本解析、UA 组装、TTL、四类失败回退、last-good 保留、标头覆盖；网关用例新增 1 条，断言转发标头确实取版本存储的当前 UA。

### 🧠 Design Intent (Why)
门禁按 UA 解析客户端版本，而官方 beta 构建滚动发布（beta-19086 → beta-19271 → …）。静态版本号在上游收紧版本校验时会全体 403，且只能靠人工抓包重发版修复。改为运行时取版本后，UA 漂移类失效能自愈；同时保留快照作为回退，使「拉取失败」的行为与改造前完全一致，不引入新的失败面。转发路径只读内存中的 `current()`，零额外延迟；刷新与目录同节奏（启动 + 10 分钟 tick，内部 6 小时 TTL 闸门），不给 npm 添压力。

### 📊 Change Stats
> 工作区中 `src/opencode-zen/` 整体未纳入版本控制，无法用 `git diff` 取数；新增文件为实测行数，修改文件为本次触碰行的手工计数。

- **Files changed:** 5（新增 2）
- **Insertions:** +282
- **Deletions:** -19

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/user-agent.ts` | +113 | 新增 |
| `test/opencode-zen-user-agent.test.ts` | +117 | 新增 |
| `src/opencode-zen/fingerprint.ts` | +17 | -8 |
| `src/opencode-zen/index.ts` | +20 | -11 |
| `test/opencode-zen-gateway.test.ts` | +12 | 0 |
| `docs/`（本记录） | 若干 | — |

### 📁 Files Modified
- `src/opencode-zen/user-agent.ts`（新增）、`src/opencode-zen/fingerprint.ts`、`src/opencode-zen/index.ts`
- `test/opencode-zen-user-agent.test.ts`（新增）、`test/opencode-zen-gateway.test.ts`
- `docs/histories/2026-10/20261009-1230-opencode-zen-dynamic-client-version.md`

### ✅ Verification
- `bun run check` 全绿（tsc 严格模式 + 734 测试 + UI/CLI 构建）。
- 真实上游实测（`/tmp/zen-ua-probe.ts`，model `nemotron-3.5-lightning-free`）：dist-tags 取到 `beta = 0.0.0-beta-19271`；快照 UA `opencode/beta/0.0.0-beta-19086/cli` 与动态 UA `opencode/beta/0.0.0-beta-19271/cli` **均 HTTP 200**——即新版本确实过门禁，动态路径不会把可用状态换坏。
- 单测：跨渠道（dev/tui）、无预发布正式版、畸形、非 200、网络异常五类响应全部回退快照且 TTL 内不重试；取到动态值后失败保留 last-good；标头覆盖只影响 UA 段。

- 与并行改动（移除 `free-models.json` 静态清单、effort 档位改取实时元数据）合并的端到端验收（真实上游，临时 handler 直调）：
  - 真实转发请求的 `user-agent` = `opencode/beta/0.0.0-beta-19271/cli`——动态版本确实上了真实流量；
  - `/v1/models` 两种形状（OpenAI 形状与 `?client_version=` 触发的 Codex 形状）暴露的 zen 集合与「实时 `/zen/v1/models` ∩ 元数据 cost 零 ∩ 非 deprecated」**完全相等**（11 个）；deprecated 过滤非空转（`muse-spark-1.2-contributor-free` 被剔除），无元数据的 `jev-1.13-free` 经探针 drop 不在列；
  - Codex 形状条目字段全部来自实时元数据：显示名 `OP-ZEN/…`、`supported_reasoning_levels`（如 `muse-spark-1.3` 的 minimal/low/medium/high/xhigh）、`default_reasoning_level`、`context_window`（如 exo-free 1048576）；
  - effort 归一化实测：`step-5-preview-free` 越界 `max` 被省略（上游请求体无该字段，HTTP 200），值域内 `low` 透传（上游 429 免费池限频，网关归一化文案正确）；`space-bunny-free` 的 `max` 在其值域内，透传并 200。

### 📌 Notes
- 与本次并行的 `effortLevels` 重构（catalog/fingerprint/index 同一批文件）由另一会话完成，本记录只覆盖 UA 部分。
- 用户排查 dsh 插件时钉死了门禁第二条通路（≥6 个官方命名工具可无模板过检），本次未改动工具注入逻辑；现有 `mergeZenTools` 已同时满足两条通路，模板轮换时工具路可作备胎。
