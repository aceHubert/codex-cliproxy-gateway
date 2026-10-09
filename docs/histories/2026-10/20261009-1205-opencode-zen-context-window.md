## [2026-10-09 12:05] | Task: OpenCode Zen 上下文窗口声明

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 再确认一下contextwindow 是怎么设置的

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/{catalog,free-models.json}`、`test/opencode-zen-catalog.test.ts`、`docs/`

**Key Actions:**
- **[问题确认]**: 核查发现目录此前对上下文窗口是「直接删除字段、完全不声明」（`buildZenCatalog` 里 `delete model.context_window` 三连）——Codex 客户端只能按自身缺省（gpt-5.5 基底的 272k）估计窗口，与上游真实能力（128k ~ 1M 各模型不同）脱节。
- **[双数据源]**: ① 动态源：models.opencode.ai 元数据（网关已在按 6h TTL 拉取）实测 38/38 免费模型带 `limit.context`，`parseZenMetadataResponse` 新增提取并随目录缓存落盘；② 静态兜底：`free-models.json` 重新自 opencode2 二进制提取 `limit.context`/`limit.output`（27/27 覆盖）。
- **[目录声明]**: `buildZenCatalog(ids, contextWindows?)` 按「元数据 limit 优先 → 预置 limit 兜底 → 都缺则删字段」写 `context_window`/`max_context_window`/`effective_context_window_percent = 95`（沿用 agy 的 95% 约定）；未知模型仍删字段，避免基底 272k 误导。
- **[测试]**: 补「元数据 limit 提取（含 0/负数/字符串/null 畸形值判缺失）」与「窗口声明优先级」两组用例；`bun run check` 全绿。

### 🧠 Design Intent (Why)
窗口缺失比「填错」更糟：客户端按 272k 基底拼长上下文，上游按真实窗口（如 mimo 200k、exo 1M）截断或报错，故障形态是难查的上下文超限。元数据优先于二进制静态提取，因为它是网关已在拉的活数据、覆盖动态列表独有的模型（如 exo-free 不在预置清单也拿到 1M 窗口）；预置兜底保证元数据拉挂时离线路径仍有窗口。95% 的 effective percent 与 agy 适配器一致，给 Codex 留输出余量。

### 📊 Change Stats
> 数据来自本次任务工作区改动。

- **Files changed:** 4
- **Insertions:** +128
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/catalog.ts` | +62 | -6 |
| `src/opencode-zen/free-models.json` | +55 | -0（重生成，新增 contextWindow/maxOutputTokens） |
| `test/opencode-zen-catalog.test.ts` | +39 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | 更新 2026-10-09 行 | — |
| `docs/histories/2026-10/20261009-1205-opencode-zen-context-window.md` | 新增 | — |

### 📁 Files Modified
- `src/opencode-zen/catalog.ts`、`src/opencode-zen/free-models.json`
- `test/opencode-zen-catalog.test.ts`
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿（tsc + 724 测试 + 构建）。
- 真实网关实测（临时实例 8399）：11/11 可见免费模型均有 `context_window`/`max_context_window`/`pct=95`；动态列表独有模型（exo-free 1048576、mimo-v2.6-flash-free 200000）证明元数据源生效；预置模型（nemotron-3.5-lightning 262144、nemotron-3-ultra 1000000）与二进制提取值一致。
- 磁盘缓存兼容：旧缓存文件无 contextWindow 字段时按缺失处理，回退预置 limit。

### 📌 Notes
- `limit.output`（最大输出 token）已提取进预置数据但尚未映射到目录字段（Codex 目录形状无直接对应项），按需再接。
- 元数据窗口与上游实际接受长度的一致性未逐模型验证（需长上下文实弹，成本高）；不一致时按真实报错回调数据源。
