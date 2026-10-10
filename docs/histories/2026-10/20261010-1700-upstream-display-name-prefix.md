## [2026-10-10 17:00] | Task: 为 cliproxy/newapi 上游模型显示名加渠道前缀

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `未记录（Codex Desktop 会话）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert`
* **Branch**: `fix/upstream-only-config`

### 📥 User Query
> 把 cliproxy/newapi 的模型显示名称添加上前缀分别是 Clirpoxy/, Newapi/
>
> （追加更正）是 Cliproxy/

### 🛠 Changes Overview
**Scope:** 上游目录合成（`src/catalog.ts`）、CLIProxy/newapi 显示名断言（`test/gateway.test.ts`）与 README

**Key Actions:**
- **[统一入口加标签]**: 在 `fetchUpstreamCatalog` 出口新增 `withUpstreamDisplayPrefix`，按上游类型给每个条目的 `display_name` 前置 `CliProxy/` 或 `NewApi/`；缺省显示名回退 slug，保证标签始终可见。
- **[保持底层纯净]**: 前缀只加在统一入口，`fetchCliProxyCatalog` / `fetchNewApiCatalog` 的原始返回值不变，落盘目录（`catalogPath`）仍存原始条目。
- **[测试与文档]**: 更新 cliproxy/newapi 两处显示名断言；README 补充渠道标签说明。

### 🧠 Design Intent (Why)
Codex 模型选择框按 `display_name` 展示，cliproxy 与 newapi 两族在切换上游后可能出现同名模型，无法分辨来源。既有 `AGY/`、`ZCode/`、`CB-INTL/`、`OP-ZEN/` 已确立「渠道标签进显示名、路由 slug 不变」的约定，本次沿用同一模式。选择统一入口而非各 adapter 或展示层：一处即可覆盖 CLI 列表、Web UI（`/ui/api/upstream/models`）、动态合并目录与 upstream-only 静态目录；同时避免改动落盘的原始目录与 `selectedModels` 语义。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`。工作区同时存在其它未提交改动，下表只统计本次任务相关文件的实际改动行数。

- **Files changed:** 3
- **Insertions:** +32
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/catalog.ts` | +22 | -1 |
| `test/gateway.test.ts` | +6 | -5 |
| `README.md` | +4 | -0 |

### 📁 Files Modified
- `src/catalog.ts`
- `test/gateway.test.ts`
- `README.md`
