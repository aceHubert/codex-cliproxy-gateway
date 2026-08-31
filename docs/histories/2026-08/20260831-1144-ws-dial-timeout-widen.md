## [2026-08-31 11:44] | Task: 放宽上游 WS 拨号超时至 10s

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 全部回退到 SSE 的排查结论是：Cloudflare（橙云代理）对空闲 WS 有 ~2 分钟回收；同时当天 09:35 一次拨号在 5771ms 超过 5s 上限，网关回 426 后 Codex 退避约 10 分钟纯 SSE。要求消除这个级联放大器：拨号超时 5s→10s。

### 🛠 Changes Overview
**Scope:** src/realtime.ts、test/realtime.test.ts

**Key Actions:**
- **[timeout]**: `UPSTREAM_DIAL_TIMEOUT_MS` 5s → 10s。经 CF 的上游握手实测 1.2–5.8s，5s 截断会把"慢但能成功"的握手变成 426，触发 Codex 长时间 SSE 退避。
- **[test]**: 新增回归测试：上游握手延迟 5.8s（卡在旧 5s 与新 10s 之间）时仍应完成桥接（101 + echo）而不是 426。

### 🧠 Design Intent (Why)
426 的语义是让客户端降级 HTTPS/SSE，Codex 对此有约 10 分钟的 WS 退避。单次边缘慢握手（实测 5771ms）就足以让整段会话退回纯 SSE，代价远高于拨号多等几秒；10s 约为实测最慢成功值的 1.7 倍。超时和 426 都在本仓库网关侧，Codex 行为不可改，因此修网关。

### 📊 Change Stats
> 数据来自 `git diff --numstat -- src/realtime.ts test/realtime.test.ts`（工作区含其他任务的未提交改动，此处只统计本任务两处文件）。

- **Files changed:** 2
- **Insertions:** +56
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/realtime.ts` | +3 | -1 |
| `test/realtime.test.ts` | +53 | -0 |

### 📁 Files Modified
- `src/realtime.ts`
- `test/realtime.test.ts`

### ✅ Verification
- `bun run typecheck` 通过
- `bun test test/realtime.test.ts` 27 pass（含新增慢握手桥接测试，~6s）
- `bun run check` 95 pass / 0 fail，`dist/index.js` 构建成功

### 📎 Related
- 排查记录见本次会话；根因（CF 空闲 WS 回收）修复方案为网关机器 `/etc/hosts` 直连源站，独立于本次改动。
