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
- **[历史回放增强]**: `narrateServerCalls` 对带结果的 `web_search_call` 按 AGY 模式回放为「[已执行网页搜索（查询：…）] + 来源列表（标题/净化 URL/摘要，至多 20 条）」，URL 剥离查询参数与片段、仅保留公开 HTTP(S) 形态；空结果标注"本轮未记录可回放的来源"，无结果条目维持省略旁白。
- **[注释漂移修正]**: 各插件目录注释中"优先 gpt-5.5"的过时基底描述统一更正为 gpt-6-luna（基底实际已于 2026-10-15 由 `CODEX_BASELINE_SLUG` 切换）。
- **[测试补充]**: `synthesizeCodebuddyEntry` 测试断言常规条目与档位条目的 `supports_search_tool` 均为 false；新增 `web_search_call` 来源回放用例（覆盖 token 剥离、hostname 回退、非法协议丢弃）。

### 🧠 Design Intent (Why)
CodeBuddy 通道在请求层剥离 `web_search` 内置工具声明并拼接"无法执行"旁白（`narrateServerCalls` 同款处理历史项），`/alpha/search` 无 `handleSearch` 实现返回 501——通道确实无法执行联网搜索。但目录条目漏改 `supports_search_tool`，Codex 据此默认给 CodeBuddy 模型武装联网工具，模型每次尝试 `web__run` 都会失败再绕路，用户体验为"搜索开关开着但必然失败"。目录声明必须与通道真实能力一致：不承诺兑现不了的搜索。历史项增强让跨供应商续会话（此前经 zcode/agy 等真正执行过搜索的回合）不丢失搜索证据：降级旁白从"已省略"升级为带净化来源列表的"已执行"记录，模型能继续引用既有结论而不凭空断档。注释漂移顺手修正，避免后续分析再被"基底还是 gpt-5.5"误导（本次分析即被 qoder 注释带偏一次）。

### 📊 Change Stats
> 数据来自 `git diff --stat`，只统计本次任务相关改动。

- **Files changed:** 7
- **Insertions:** +74
- **Deletions:** -12

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/codebuddy/src/request.ts` | +30 | -4 |
| `test/codebuddy-request.test.ts` | +31 | -2 |
| `test/codebuddy-catalog.test.ts` | +5 | -1 |
| `packages/codebuddy/src/catalog.ts` | +4 | -1 |
| `packages/opencode-zen/src/catalog.ts` | +2 | -2 |
| `packages/agy/src/catalog.ts` | +1 | -1 |
| `packages/qoder/src/catalog.ts` | +1 | -1 |

### 📁 Files Modified
- `packages/codebuddy/src/catalog.ts`
- `packages/codebuddy/src/request.ts`
- `packages/qoder/src/catalog.ts`
- `packages/agy/src/catalog.ts`
- `packages/opencode-zen/src/catalog.ts`
- `test/codebuddy-catalog.test.ts`
- `test/codebuddy-request.test.ts`

### ✅ Verification
- `bun run check`：构建 + 类型检查 + 1382 个测试全部通过（0 fail）。
