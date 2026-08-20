## [2026-08-18 10:57] | Task: 修复 CLIProxy 模型请求版本

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> `/models` 请求应发送真实 Codex App runtime 版本；install 与 `models --sync` 只探测一次 native catalog 并复用，缺失版本回退 `0.0.0`。本轮不修改 Live/Realtime。

### 🛠 Changes Overview
**Scope:** catalog discovery and CLIProxy model sync

**Key Actions:**
- **真实版本**: `fetchCliProxyCatalog()` 接收 `clientVersion`，不再固定发送 `codex-cliproxy`。
- **单次探测**: install 与 `models --sync` 提前解析 native catalog，并在请求和构建阶段复用同一结果。
- **保守回退**: runtime 版本缺失时发送 `0.0.0`。
- **回归测试**: 覆盖 fake Codex App 版本贯穿请求 URL，以及缺失版本回退。

### 🧠 Design Intent (Why)
CLIProxy 根据 `client_version` 返回 Codex catalog。复用同一份 resolved native catalog，既保证请求版本与最终 native rows 一致，也避免重复探测 Codex App。

### 📊 Change Stats
> 当前工作区在相关文件中已有大量未提交改动；以下统计是相关文件相对 Git 索引的完整差异，包含这些既有改动和一个既有未跟踪测试文件。

- **Files changed:** 4
- **Insertions:** +1051
- **Deletions:** -71

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/catalog.ts` | +297 | -5 |
| `src/cli.ts` | +319 | -55 |
| `test/gateway.test.ts` | +236 | -11 |
| `test/model-catalog-dynamic.test.ts` | +199 | -0 |

### 📁 Files Modified
- `src/catalog.ts`
- `src/cli.ts`
- `test/gateway.test.ts`
- `test/model-catalog-dynamic.test.ts`
