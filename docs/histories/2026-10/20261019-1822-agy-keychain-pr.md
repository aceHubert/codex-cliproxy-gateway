## [2026-10-19 18:22] | Task: 补交 agy 钥匙串凭据修复

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-agy-keychain`

### 📥 User Query
> 核验 agy 授权为何再次失败，定位未合入主线的钥匙串修复，并创建独立 PR。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/agy`、网关 Web UI 存在性探测与回归测试。

**Key Actions:**
- 移植原提交 `848ffdd`：macOS 先读 `gemini/antigravity`，解码 `go-keyring-base64:` 包装的 JSON；可用 token 完全屏蔽文件，缺失、损坏或过期才回落文件。
- 两处 `security` 调用设置 5 秒超时；读取异常使用固定文案，避免携带子进程输出。
- 保持只读消费，不刷新、不写回凭据；过期判定保留 10 秒余量，未知过期时间交由上游校验。
- Web UI 支持仅有钥匙串条目时显示 agy 开关，并增加探测注入以隔离真实钥匙串。
- 目录测试固定文件读取路径；新增读取次数、账号变化、未知有效期、错误遮蔽及跨平台回归。

### 🧠 Design Intent (Why)
原修复留在本地功能分支，模型推送 PR 没有包含它。凭据仅存钥匙串时，主线仍只读文件而误报未登录。本次只补交认证修复及其必要测试，不携带原分支其他功能。

### ✅ Verification
- agy 凭据、目录、转发和 Web UI 定向测试：101 例通过。
- `bun run check`：边界检查、构建、类型检查通过；全量测试 1186 例通过、2 例失败。
- 两个失败为 DSH 模型图片能力断言与 CodeBuddy 菜单文案断言，已在干净 `origin/main` 副本复现（32 例通过、相同 2 例失败），与本次修复无关。
- 独立只读审查通过；所有新增凭据测试使用合成数据。

### 📊 Change Stats
> 数据来自相对 `origin/main` 的 `git diff --shortstat` 与 `git diff --numstat`。

- **Files changed:** 6
- **Insertions:** +407
- **Deletions:** -56

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/webui.ts` | 6 | 1 |
| `packages/agy/src/credentials.ts` | 135 | 40 |
| `test/agy-catalog.test.ts` | 2 | 2 |
| `test/agy-credentials.test.ts` | 195 | 10 |
| `test/webui.test.ts` | 15 | 3 |
| 本历史记录 | 54 | 0 |

### 📁 Files Modified
- `apps/gateway/src/webui.ts`
- `packages/agy/src/credentials.ts`
- `test/agy-catalog.test.ts`
- `test/agy-credentials.test.ts`
- `test/webui.test.ts`
- `docs/histories/2026-10/20261019-1822-agy-keychain-pr.md`
