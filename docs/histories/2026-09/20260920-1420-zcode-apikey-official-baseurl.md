## [2026-09-20 14:20] | Task: 修复 ZCode API Key 槽位选择

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> ZCode 现在把 API Key 当成 custom 配置，导致无法主动切到 API Key 使用模式；能否根据 baseURL 判断是否调用官方接口？
> 新加的 API Key 不会再写入 builtin provider，需避免旧 builtin Key 抢占新 custom Key。
> 只有官方 API Key 的 `builtin:zai` 已被 ZCode 完全忽略且不会随 UI 更新；Coding Plan / Start Plan 的 builtin 套餐链路不变。
> 多个 API Key 不能共用 `zcode/`；目录应使用 `zcode-<providerId>/`，显示名为 `（ZCode <providerName|providerId>）`。

### 🛠 Changes Overview
**Scope:** zcode config / model catalog / gateway routing

**Key Actions:**
- **[API Key 选路]**: 固定 `api-key` 槽位只读取 `provider_config.json`；优先识别 `zai-api` / `bigmodel-api` 官方模板，也接受显式官方 Anthropic baseURL 的 custom provider，不读取 `config.json` 的官方 API builtin 镜像。
- **[新选择形态]**: `providerFamilyConnectionSelections[family].kind = "api-key"` 从 provider_config 定位；legacy `builtin:zai` / `builtin:bigmodel` API Key 选择视为陈旧状态并忽略，不做 ID 迁移。
- **[配置监听]**: `provider_config.json` 纳入差分缓存与文件监听；Key、模型或候选 provider 变化会重建 API Key 快照，损坏或多个官方候选时明确失败。
- **[多 Provider]**: 枚举 provider_config 中全部官方 API Key provider，按 `providerOrder` 与 ID 稳定排序；每个 provider 一个独立配置缓存，Key 与模型变化互不影响。
- **[模型目录]**: API Key 模型来自 provider_config 的 `modelOrder` / `personalModelIds`；slug 使用 `zcode-<providerId>/`，显示名使用 `（ZCode <providerName|providerId>）`，不再生成单一 `zcode/` API 前缀。
- **[请求路由]**: `zcode-<providerId>/<model>` 精确选择对应快照与 Key；未知 provider 本地 404，第三方 baseURL 不进入 ZCode 官方 API 路由。
- **[回归测试]**: 覆盖套餐当前选中时仍可解析 API Key、`zai-api` 更新生效、legacy builtin 选择被忽略且 Key 更新不报错、多 provider 独立解析、目录显示名、多 Key 请求鉴权、动态新增 provider、第三方 baseURL 排除与 provider_config 删除失效。

### 🧠 Design Intent (Why)
*ZCode 官方 API Key 的权威来源已迁移到 provider_config，`builtin:zai` 的 API 选择和镜像不会随 UI 更新，作为路由凭据已经失真；Coding Plan / Start Plan 仍继续使用原有 builtin 套餐镜像。多个 API Key 共用单一 `zcode/` 前缀时无法安全选择凭据，因此把 provider ID 放入模型命名空间，并让目录显示 providerName / providerId，保证用户可辨别、网关可精确路由。*

### 📊 Change Stats
> 数据来自本次任务相关工作区变更。

- **Files changed:** 6
- **Insertions:** +616
- **Deletions:** -93

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/catalog.ts` | +45 | -12 |
| `src/zcode/config.ts` | +202 | -29 |
| `src/zcode/index.ts` | +94 | -9 |
| `test/zcode-cache.test.ts` | +164 | -5 |
| `test/zcode-catalog.test.ts` | +38 | -19 |
| `test/zcode-gateway.test.ts` | +73 | -19 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/zcode/catalog.ts`
- `src/zcode/index.ts`
- `test/zcode-cache.test.ts`
- `test/zcode-catalog.test.ts`
- `test/zcode-gateway.test.ts`

### ✅ Verification
- `bun test test/zcode-cache.test.ts`
- `bun test test/zcode-cache.test.ts test/zcode-catalog.test.ts test/zcode-gateway.test.ts test/zcode-request-context.test.ts test/zcode-plans.test.ts`
- `bun run typecheck`
- `bun run check`
