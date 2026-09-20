## [2026-09-20 11:48] | Task: 强制 CodeBuddy 地域路由

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 为 CodeBuddy 增加地域配置与强制地域模型前缀；模型 slug 指定地域缺失凭据时直接报错，不做跨地域回退。

### 🛠 Changes Overview
**Scope:** codebuddy / gateway config

**Key Actions:**
- **[模型路由]**: 模型 slug 强制携带地域：`codebuddy-cn/`、`codebuddy-intl/`、`workbuddy-cn/`、`workbuddy-intl/`；旧无地域前缀本地返回 400。
- **[凭据选择]**: 请求按 slug 地域硬性选择凭据；对应地域没有 `.info` 直接返回 503，不回退另一地域。
- **[目录刷新]**: `codebuddyRegion` 控制 16 分钟目录刷新的地域偏好；配置地域缺失时目录刷新回退最近登录的 auto 规则。
- **[CLI 配置]**: `config --codebuddy-region auto|cn|intl` 写入配置、输出状态并纳入审计。
- **[配置校验]**: 同步 GatewayConfig 类型、JSON Schema 与非法值校验。
- **[回归测试]**: 覆盖固定地域、缺失回退、配置写入与审计。

### 🧠 Design Intent (Why)
*CodeBuddy CLI 只持续刷新主 `.info`，混合地域副本共存时“最新登录”规则会长期偏向主文件。把地域写入模型 slug 后，请求路由不再受 16 分钟目录刷新滞后影响；目录刷新仍可用配置偏好选择要展示的地域。*

### 📊 Change Stats
> 数据来自本次任务相关工作区变更。

- **Files changed:** 10
- **Insertions:** +283
- **Deletions:** -119

| File | +Added | -Removed |
| --- | ---: | ---: |
| `schemas/gateway-config.schema.json` | +6 | -0 |
| `src/cli.ts` | +17 | -3 |
| `src/codebuddy/catalog.ts` | +37 | -12 |
| `src/codebuddy/credentials.ts` | +32 | -9 |
| `src/codebuddy/index.ts` | +35 | -9 |
| `src/types.ts` | +5 | -0 |
| `test/codebuddy-catalog.test.ts` | +49 | -47 |
| `test/codebuddy-credentials.test.ts` | +30 | -1 |
| `test/codebuddy-gateway.test.ts` | +64 | -30 |
| `test/codebuddy-response.test.ts` | +8 | -8 |

### 📁 Files Modified
- `schemas/gateway-config.schema.json`
- `src/cli.ts`
- `src/codebuddy/catalog.ts`
- `src/codebuddy/credentials.ts`
- `src/codebuddy/index.ts`
- `src/types.ts`
- `test/codebuddy-catalog.test.ts`
- `test/codebuddy-credentials.test.ts`
- `test/codebuddy-gateway.test.ts`
- `test/codebuddy-response.test.ts`

### ✅ Verification
- `bun test test/codebuddy-catalog.test.ts test/codebuddy-credentials.test.ts test/codebuddy-gateway.test.ts test/codebuddy-request.test.ts test/codebuddy-response.test.ts`
- `bun test`
- `bun run typecheck`
- `bun run build`
