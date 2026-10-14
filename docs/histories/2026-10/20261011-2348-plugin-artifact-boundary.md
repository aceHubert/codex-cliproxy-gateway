## [2026-10-11 23:48] | Task: 收口插件落盘产物清单，卸载清理与目录守卫去硬编码

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `account:zai-individual-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-artifact-boundary`

### 📥 User Query
> models --exclude 的模型来源排查确认走插件契约（非网关直接读文件）后，用户指出网关不应持有子包产物知识（`paths.ts` 硬编码插件目录缓存文件名且清单不全），要求在独立 worktree 创建修复执行计划并实施。

### 🛠 Changes Overview
**Scope:** apps/gateway、packages/{plugin 边界相关五包}、test

**Key Actions:**
- **[插件自声明]**: 五个插件包各导出 `*_RUNTIME_ARTIFACTS` 产物清单常量（文件名与落盘点同源；codebuddy 并入 4 个旧版产品×地域命名残留），qoder/agy/opencode-zen 的落盘点改用同源常量。
- **[组合层聚合]**: `gateway-composition.ts` 新增 `installedPluginArtifactFiles`（聚合五家产物并拼接运行主目录）与 `managedRuntimeCatalogFiles`（网关自有 + 插件产物全集）；`paths.ts` 的 `managedCatalogFiles` 收窄为仅网关自有目录文件（cliproxy/newapi/codex-catalog.json）。
- **[消费点改造]**: `removeManagedRuntimeFiles` 与 `applyModelCatalogToml` 守卫改用聚合清单；`applyModelCatalogToml` 的 `managedFiles` 改为必传参数，`model-composition` 转发层统一注入（webui/models --sync 自动生效），`model-state` 保持叶子模块。
- **[测试补齐]**: 聚合清单结构断言（五家 12 文件、直系无穿越、与自有清单不重叠）、守卫测试扩展为全部插件产物均识别为受管值、卸载清理测试覆盖全部插件产物与 codebuddy legacy 残留。

### 🧠 Design Intent (Why)
网关业务源码不得持有子包落盘产物的文件名知识（AGENTS.md 的插件边界：插件只由业务组合入口显式装配）。清单走「插件包静态导出 + 组合入口聚合」而非运行时注册，因为卸载与守卫路径不能依赖插件实例化（构造有凭据读取副作用）；同时补齐原清单缺失的 agy、qoder、opencode-zen 产物（共 12 文件），修复卸载残留。

### 📊 Change Stats
> 数据来自 `git diff --numstat 18c8215..6f7a573`。

- **Files changed:** 17
- **Insertions:** +139
- **Deletions:** -55

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/gateway-composition.ts` | +20 | -6 |
| `apps/gateway/src/model-state.ts` | +13 | -4 |
| `apps/gateway/src/cli.ts` | +7 | -5 |
| `apps/gateway/src/model-composition.ts` | +6 | -2 |
| `apps/gateway/src/paths.ts` | +5 | -4 |
| `packages/codebuddy/src/catalog.ts` | +8 | -0 |
| `packages/opencode-zen/src/catalog.ts` | +10 | -2 |
| `packages/qoder/src/catalog.ts` | +5 | -1 |
| `packages/zcode/src/index.ts` | +5 | -1 |
| `packages/agy/src/catalog.ts` | +5 | -1 |
| `packages/*/src/index.ts`（4 个 re-export） | +4 | -0 |
| `test/paths.test.ts` | +33 | -4 |
| `test/gateway.test.ts` | +15 | -22 |
| `test/model-state.test.ts` | +3 | -3 |

### 📁 Files Modified
- `packages/{zcode,codebuddy,qoder,agy,opencode-zen}/src/{index,catalog}.ts`
- `apps/gateway/src/{gateway-composition,paths,model-state,model-composition,cli}.ts`
- `test/{paths,gateway,model-state}.test.ts`

### ✅ Verification
- `bun run check`：构建 + 严格类型检查 + 971 个测试全通过（72 个文件）。
- `bun run pack:check`：八个公开产物、workspace 版本转换与五家目录/Responses 冒烟通过。
- 手工卸载演练（临时 HOME）：16 个受管文件（3 网关自有 + 12 插件产物 + catalog-metadata）卸载后仅剩用户自建 `notes.txt`。
- grep 复核：除 `default-install-migration.ts` 迁移白名单的既有模式匹配（本次未改造，见 tech-debt-tracker）外，`apps/gateway/src` 已无任何插件产物文件名字面量（聚合经包导出常量）。
