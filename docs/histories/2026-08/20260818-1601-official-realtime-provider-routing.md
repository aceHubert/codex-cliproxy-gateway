## [2026-08-18 16:01] | Task: 固化官方 Realtime Provider 路由

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 第一阶段在本地处理官方 Live：启动时缓存 Codex provider，支持 ChatGPT 账号态与官方 API Key，拒绝第三方 provider；第二阶段 CLIProxy 转发仅记录实施路径。

### 🛠 Changes Overview
**Scope:** Realtime、CLI 配置、launchd、测试与实施文档

**Key Actions:**
- **Provider 快照**: 启动时扫描根配置、命名 profile 和外部 profile，显式 provider 或解析失败时失败关闭。
- **认证分流**: HTTP 逐请求、WebSocket 逐握手转发认证；账号态走 ChatGPT backend，官方 API Key 走 OpenAI API。
- **配置接入**: 托管 WebRTC call base，并将自定义 `CODEX_HOME` 传给 launchd。
- **后续路径**: 仅记录 CLIProxy Realtime 第二阶段方案和技术债，不增加运行时配置。

### 🧠 Design Intent (Why)
避免每次 Live 请求读取配置，同时确保第三方 provider Token 不会被误发给官方上游；官方凭据继续由 Codex 管理，网关不读取 `auth.json` 或缓存 Token。

### 📊 Change Stats
> 数据来自本任务文件相对任务开始时索引状态的 `git diff --numstat`；不含本 history 文件。

- **Files changed:** 10
- **Insertions:** +460
- **Deletions:** -53

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +1 | -1 |
| `docs/cliproxy-realtime-forwarding-plan.md` | +47 | -0 |
| `docs/exec-plans/completed/official-realtime-provider-routing.md` | +47 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |
| `docs/official-realtime-proxy-plan.md` | +65 | -29 |
| `src/cli.ts` | +10 | -1 |
| `src/gateway.ts` | +12 | -4 |
| `src/launchd.ts` | +7 | -1 |
| `src/realtime.ts` | +92 | -10 |
| `test/realtime.test.ts` | +178 | -7 |

### 📁 Files Modified
- `src/realtime.ts`
- `src/gateway.ts`
- `src/cli.ts`
- `src/launchd.ts`
- `test/realtime.test.ts`
- `README.md`
- `docs/official-realtime-proxy-plan.md`
- `docs/cliproxy-realtime-forwarding-plan.md`
- `docs/exec-plans/completed/official-realtime-provider-routing.md`
- `docs/exec-plans/tech-debt-tracker.md`
