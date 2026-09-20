## [2026-09-19 17:13] | Task: 修复 ZCode Start Plan 目录与凭据

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 继续排查，现在使用的是 start plan，只有 glm-5.3-flash，但是 catalog 现在都没有更新。

### 🛠 Changes Overview
**Scope:** ZCode Start Plan 配置快照、目录注入与回归测试。

**Key Actions:**
- **停用镜像放行**: Start Plan 不再受 `config.json` 中旧个人 Coding Plan 的
  `enabled:false` / `coding_plan_not_entitled` 镜像门控，目录恢复为当前权益模型。
- **凭据来源修正**: Start Plan 改用 `oauth:<family>:access_token` 作为请求鉴权，
  不再采用可能冻结数周的镜像 JWT；凭据缺失或损坏时直接失效，不回退旧镜像。
- **回归测试**: 覆盖旧停用镜像放行、OAuth 凭据采用及镜像 JWT 忽略，并同步调整
  Start Plan 的既有缓存测试预期。
- **旧模型即时清理**: 套餐选择变化或当前配置不可解析时，从 Codex 的
  `models_cache.json` 中移除已不在当前套餐集合的 `zcode/*` 条目，避免 Coding Plan
  的旧模型在 Start Plan 异常期间继续可选。

### 🧠 Design Intent (Why)
ZCode 3.12.3 的账号型 Start Plan 由 `billing/balance` 动态判定权益，并在每次模型
请求前注入当前账号凭据。`config.json` 中的 `enabled`、`systemDisabledReason` 与
`apiKey` 都是旧个人 Coding Plan 遗留镜像，继续消费会让网关把有效套餐判为空目录，
并可能向模型 API 发送过期 JWT。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`，仅统计本任务 2 个文件。

- **Files changed:** 2
- **Insertions:** +52
- **Deletions:** -7

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/catalog.ts` | +30 | -0 |
| `src/zcode/config.ts` | +59 | -5 |
| `src/zcode/index.ts` | +27 | -3 |
| `test/model-catalog-dynamic.test.ts` | +28 | -0 |
| `test/zcode-cache.test.ts` | +28 | -5 |
| `test/zcode-gateway.test.ts` | +29 | -0 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/catalog.ts`
- `src/zcode/index.ts`
- `test/zcode-cache.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/zcode-gateway.test.ts`
- `docs/histories/2026-09/20260919-1713-zcode-start-plan-catalog.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun run check`：443 pass / 0 fail，UI 与 CLI 构建通过。
- 真实 `~/.zcode` 离线快照验证：provider 为 `builtin:zai-start-plan`，
  模型为 `GLM-5.3-Flash`，目录输出 `zcode/glm-5.3-flash`，且使用当前 OAuth 而非旧镜像 JWT。
