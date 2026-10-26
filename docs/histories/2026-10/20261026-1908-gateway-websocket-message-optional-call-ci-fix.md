## [2026-10-26 19:08] | Task: 修复 CI 类型错误（websocket message 可选调用）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/agent-system-prompt-conversion-layer`

### 📥 User Query
> PR #29 的 CI 报错：`apps/gateway/src/gateway.ts(1666,12): error TS2722: Cannot invoke an object which is possibly 'undefined'.`

### 🛠 Changes Overview
**Scope:** apps/gateway

**Key Actions:**
- **[类型修复]**: `gateway.ts:1666` 的 `realtimeWebSocketHandler.message(socket, data)` 改为 `message?.(socket, data)`，与同组 `open?.` / `drain?.` / `close?.` 调用形态一致。

### 🧠 Design Intent (Why)
`bun.lock` 锁定的 `@types/bun@1.4.4` 中 `Bun.WebSocketHandler.message` 为可选方法，本地 `node_modules` 停留在 1.4.3（message 非可选）且 Nx 类型检查缓存 100% 命中，双重掩盖了该错误；CI 全新安装按 lockfile 取 1.4.4 后 tsc 报 TS2722。修复后本地 `bun install` 同步至 1.4.4 并以 `lerna run typecheck --skip-nx-cache` 复现验证通过。

### 📊 Change Stats
> 数据来自 `git diff HEAD~1..HEAD`。

- **Files changed:** 1
- **Insertions:** +1
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/gateway.ts` | +1 | -1 |

### 📁 Files Modified
- `apps/gateway/src/gateway.ts`
