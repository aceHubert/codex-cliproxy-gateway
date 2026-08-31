## [2026-08-30 21:18] | Task: 剥离 CPA routing hint 模型前缀

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-sol`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> CPA 请求转发到上游时，需要同步剥离 `X-Codex-Routing-Hint` 中的模型前缀。

### 🛠 Changes Overview
**Scope:** CPA HTTP 与 Responses WebSocket 请求转发

**Key Actions:**
- **[统一值改写]**: CPA 路由将 routing hint 的 `model=cliproxy/...` 改为无前缀模型，同时保留 `tier` 等其他参数。
- **[双传输覆盖]**: HTTP 与 Responses WebSocket 共用同一值级改写函数，官方路由保持原样。
- **[回归测试]**: 分别断言 HTTP 和 WebSocket 上游收到无前缀 hint，且 `tier=ultrafast` 未丢失。

### 🧠 Design Intent (Why)
请求体和 WebSocket 帧此前已剥离模型前缀，但 routing hint 仍原样透传，导致 CPA 上游看到网关私有的 `cliproxy/` 前缀。修复限定在 CPA 转发边界，避免改变官方请求语义。

### 📊 Change Stats
> 数据来自本次任务开始前后的工作区文件差异。

- **Files changed:** 3
- **Insertions:** +63
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +13 | -4 |
| `test/gateway.test.ts` | +10 | -2 |
| `docs/histories/2026-08/20260830-2118-strip-cpa-routing-hint-prefix.md` | +40 | -0 |

### 📁 Files Modified
- `src/gateway.ts`
- `test/gateway.test.ts`
- `docs/histories/2026-08/20260830-2118-strip-cpa-routing-hint-prefix.md`
