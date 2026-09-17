## [2026-09-13 19:27] | Task: 密钥存储跨平台兼容（非 macOS 走 credentials.json）

### 🤖 Execution Context
* **Agent ID**: `ZCode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 需要使用 credentials.json 来兼容非macos 的key存储问题，先写一个docs 执行文件；随后确认"实施，暂时没有windows设置，写好单元测试验收即可"。

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关（密钥存取层 + 路径/类型 + 测试 + 文档）

**Key Actions:**
- **[执行计划]**: 先落 `docs/exec-plans/` 计划并核对现状——`serve` 本就不设 `requireMacOS()` 门槛，非 darwin 的实际断点在 `gateway.ts` 启动时 `readApiKey()` shell `/usr/bin/security`；install 的 macOS 限制源于 launchd，属独立工作，不混入本次范围。
- **[平台分派]**: `keychain.ts` 重构为 `createApiKeyStore(platform, credentialsFile)` 工厂：darwin 后端逐字保留原 `security` 调用参数，其余平台路由到文件后端；`saveApiKey`/`readApiKey`/`deleteApiKey` 三个便捷包装签名不变，`cli.ts`/`gateway.ts` 调用点零改动。
- **[文件后端]**: 新增 `src/credentials-store.ts`——`saveUpstreamApiKey`/`readUpstreamApiKey`/`deleteUpstreamApiKey` 接受路径的纯函数，形状 `{"version":1,"upstream_api_key":"…"}`，经 `atomicWrite`（0600 + 临时文件 rename）落盘，`~/.codex-cliproxy-gateway/credentials.json`；删除幂等，与 Keychain 卸载语义一致。
- **[损坏报错]**: `readApiKey` 的 `optional`（loopback 豁免）只覆盖「文件缺失 / 空 key」；JSON parse 失败、形状或版本不符一律抛带绝对路径与重建指引的错误，不静默当缺失。
- **[路径接入]**: `paths.ts`/`types.ts` 增加 `credentialsFile`，与 config.json / ui-token 同从 `HOME` 派生，不引入独立覆盖变量。
- **[测试]**: `test/credentials-store.test.ts` 8 个用例：往返与 0600 权限、覆盖写单槽位、幂等删除、缺失/空 key 的 optional 语义、损坏 JSON 双路径报错、6 种非法形状、linux 分派路由、install 回滚链路（save 恢复旧 key / previous 为空走 delete）。
- **[评审修复]**: 读取失败的缺失豁免收窄到 ENOENT——凭据路径被目录占用（EISDIR，评审已复现）或权限不可读（EACCES）时，任何 optional 取值都抛带 errno 原因、路径与 `cause` 的错误，不再静默返回空 key（原行为会让 loopback 网关带着空 Authorization 启动、把鉴权失败推迟到上游暴露）；补 EISDIR/EACCES 两个测试。
- **[文档]**: README 新增 "API key storage" 小节与文件清单条目；AGENTS.md 更新模块描述与安全约束（必须走 `keychain.ts` 分派、损坏报错不静默）；tech-debt-tracker 登记 Linux serve 全链路真机验证与 Windows 适配两项后续债务。

### 🧠 Design Intent (Why)
密钥存取原本硬编码 macOS Keychain（`/usr/bin/security`），非 darwin 上 `serve` 直接启动失败。选择在 `keychain.ts` 内部按 `process.platform` 分派而非让调用方各自适配：调用点（install 保存/回滚/卸载、gateway 启动读取、realtime target）零改动即获得跨平台能力，且 macOS 行为逐字保留、回归面最小。文件后端做成接受路径的纯函数 + 可注入 platform 的工厂，绕开 `process.platform` 不可 mock 的限制，让 macOS 开发机能覆盖 linux 分支的全部行为——按用户确认，本次验收即以这些单元测试为准。明文落盘弱于 Keychain，以 0600 权限 + 严格遮蔽边界（key 绝不进日志/UI/API 响应）缓解，并在文档中明示。

### 📊 Change Stats
> 基线为任务开始时的暂存区快照；统计仅含本次任务的未暂存增量与新增文件（README/AGENTS/webui.test 的未暂存 diff 含此前会话遗留行，按本次实际足迹折算）。

- **Files changed:** 10（新增 3）
- **Insertions:** +403
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/credentials-store.ts`（新增） | +70 | -0 |
| `test/credentials-store.test.ts`（新增） | +153 | -0 |
| `docs/exec-plans/completed/credentials-json-key-store.md`（新增） | +75 | -0 |
| `src/keychain.ts` | +47 | -3 |
| `README.md` | +15 | -1 |
| `AGENTS.md` | +2 | -2 |
| `src/paths.ts` | +2 | -0 |
| `src/types.ts` | +2 | -0 |
| `test/webui.test.ts` | +1 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +2 | -0 |

### 📁 Files Modified
- `src/keychain.ts`
- `src/credentials-store.ts`（新增）
- `src/paths.ts`
- `src/types.ts`
- `test/credentials-store.test.ts`（新增）
- `test/webui.test.ts`
- `README.md`
- `AGENTS.md`
- `docs/exec-plans/completed/credentials-json-key-store.md`（新增，自 active/ 归档）
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿：typecheck + 298 tests（含新增 10 例：8 例后端行为 + 2 例评审修复的 EISDIR/EACCES）+ 单文件构建（index.js 1.34 MB）。
- darwin 回归依赖现有全量测试与逐字保留的 `security` 调用参数；Linux 全链路（serve + 转发带 Authorization）按用户确认推迟为债务，见 tech-debt-tracker 2026-09-13 两行。
