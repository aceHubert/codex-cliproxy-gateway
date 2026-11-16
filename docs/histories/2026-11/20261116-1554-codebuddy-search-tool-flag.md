## [2026-11-16 15:54] | Task: 关闭 CodeBuddy 目录的 web_search 能力声明

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/codebuddy-search-tool-flag`

### 📥 User Query
> 分析一下 qoder 的 web_search 兼容问题（延伸到 codebuddy）：qoder/opencode 目录都显式 `supports_search_tool = false`，codebuddy 却从 Codex 基底继承了 `true`，导致 Codex 默认武装联网工具后每次尝试都在网关被剥离或 501 拒绝。要求基于 main 建 worktree 修复，分支不绑定 main 上游。

### 🛠 Changes Overview
**Scope:** packages/codebuddy、packages/qoder、packages/agy、packages/opencode-zen、test

**Key Actions:**
- **[能力声明修复]**: `cloneCodexBase` 显式 `supports_search_tool = false`，阻止从 Codex 基底（gpt-6-luna，`supports_search_tool=true`）继承不可兑现的搜索能力；与 qoder/opencode 目录的既有做法对齐。
- **[注释漂移修正]**: 各插件目录注释中"优先 gpt-5.5"的过时基底描述统一更正为 gpt-6-luna（基底实际已于 2026-10-15 由 `CODEX_BASELINE_SLUG` 切换）。
- **[测试补充]**: `synthesizeCodebuddyEntry` 测试断言常规条目与档位条目的 `supports_search_tool` 均为 false。

### 🧠 Design Intent (Why)
CodeBuddy 通道在请求层剥离 `web_search` 内置工具声明并拼接"无法执行"旁白（`narrateServerCalls` 同款处理历史项），`/alpha/search` 无 `handleSearch` 实现返回 501——通道确实无法执行联网搜索。但目录条目漏改 `supports_search_tool`，Codex 据此默认给 CodeBuddy 模型武装联网工具，模型每次尝试 `web__run` 都会失败再绕路，用户体验为"搜索开关开着但必然失败"。目录声明必须与通道真实能力一致：不承诺兑现不了的搜索。注释漂移顺手修正，避免后续分析再被"基底还是 gpt-5.5"误导（本次分析即被 qoder 注释带偏一次）。

### 📊 Change Stats
> 数据来自 `git diff --stat`，只统计本次任务相关改动。

- **Files changed:** 5
- **Insertions:** +13
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/codebuddy/src/catalog.ts` | +4 | -1 |
| `test/codebuddy-catalog.test.ts` | +5 | -1 |
| `packages/opencode-zen/src/catalog.ts` | +2 | -2 |
| `packages/agy/src/catalog.ts` | +1 | -1 |
| `packages/qoder/src/catalog.ts` | +1 | -1 |

### 📁 Files Modified
- `packages/codebuddy/src/catalog.ts`
- `packages/qoder/src/catalog.ts`
- `packages/agy/src/catalog.ts`
- `packages/opencode-zen/src/catalog.ts`
- `test/codebuddy-catalog.test.ts`

### ✅ Verification
- `bun run check`：构建 + 类型检查 + 1381 个测试全部通过（0 fail）。
