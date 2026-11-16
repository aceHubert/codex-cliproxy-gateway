## [2026-11-16 10:48] | Task: 修复 upstream-only 静态目录乱序并参数化 model_catalog_json

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-individual-coding-plan)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-stream-logging-and-agy-tool-tolerance`

### 📥 User Query
> upstream-only 之后，怎么乱乱序了，而且 CLIProxy/ 前缀也没去掉（只是加载的 catalog 上）。upstreamOnly 不应该设置 model_catalog_json，会导致插件的模型列表也无法更新了。
>
> （迭代）第 2 点把 CliProxy/ 显示前缀保留；第 3点 applyModelCatalogToml 新增一个参数去配置。
>
> （验收）经 Herdr 终端 t2f（Antigravity）按 a–d 逐项验收：a/c/d 通过；b 发现 `config --codex-static-catalog on` 被 `COMMAND_OPTIONS.config` 选项白名单拦截（cli.ts:2498 漏配），已补白名单并新增回归测试 `config --codex-static-catalog passes the option whitelist`，隔离 HOME 实测 CLI 已放行到安装检查。

### 🛠 Changes Overview
**Scope:** apps/gateway（catalog、model-state、cli、webui、types、schema、ui）

**Key Actions:**
- **[静态目录排序]**: `writeStaticCatalog` 合并上游与各插件目录时统一重排为连续 `priority`（上游在前、插件按组合顺序递增在后）。此前上游条目带 CLIProxyAPI 的大数值 priority（1/2/3/5/1043/2443/2543），各插件目录又各自从 0 计数，Codex 按 priority 排序时各渠道同优先级条目互相穿插（已用本机 `codex-catalog.json` 复现截图中的交错顺序）。
- **[显示名前缀保留]**: `CliProxy/`、`NewApi/` 渠道显示名标签在静态目录中原样保留（维持 2026-10-10 确立的渠道标签约定），未做剥离。
- **[静态指向参数化]**: `applyModelCatalogToml` 新增 `staticCatalog` 参数：true 时受管写入 `model_catalog_json` 指向 `codex-catalog.json`，false 时移除历史受管值（自管值守卫与不可解析拒绝语义不变）。新增配置项 `codexStaticCatalog`（默认 false，仅 upstream-only 下生效；动态模式忽略），`config --codex-static-catalog on|off` 可切换；缺省 Codex 经网关 `/models` 实时拉取目录，插件热更新即时生效。
- **[提示与文档同步]**: 手动模式 CLI/Web UI 指引按当前开关打印添加或删除 `model_catalog_json` 的指引；`apps/gateway/README.md`、`config.schema.json` 同步。

### 🧠 Design Intent (Why)
- Codex 模型选择框按 `display_name` 展示、按 `priority` 排序；动态模式的两个合并点（`catalogModelsResponse.respond`、`mergeCatalog`）都有 priority 重排，唯独 upstream-only 静态路径漏掉，导致多渠道目录乱序。
- `model_catalog_json` 静态指向使 Codex 只在重启时读一次文件，插件模型热更新无法反映，因此缺省改为 `/models` 实时拉取；但保留参数化开关，供需要静态文件加载的场景显式启用。
- upstream-only 的路由语义不变：全部走上流、模型不带 `cliproxy/` 前缀、无粘性判断；本次只收敛目录加载链路。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`（工作区，含本任务文件）。注意：工作区同时存在本分支先前未提交的其它任务改动，`test/gateway.test.ts` 与 `test/webui.test.ts` 的数字混入先前编辑。

- **Files changed:** 17
- **Insertions:** +240
- **Deletions:** -340

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/model-state.ts` | +22 | -10 |
| `apps/gateway/src/cli.ts` | +31 | -20 |
| `apps/gateway/src/webui.ts` | +7 | -13 |
| `apps/gateway/src/types.ts` | +6 | -0 |
| `apps/gateway/config.schema.json` | +5 | -0 |
| `apps/gateway/src/ui/ConfigPage.tsx` | +0 | -6 |
| `apps/gateway/src/ui/api.ts` | +0 | -1 |
| `apps/gateway/src/ui/i18n/locales/zh/config.ts` | +1 | -2 |
| `apps/gateway/src/ui/i18n/locales/en/config.ts` | +1 | -2 |
| `apps/gateway/README.md` | +8 | -2 |
| `test/model-state.test.ts` | +59 | -15 |
| `test/model-catalog-dynamic.test.ts` | +5 | -6 |
| `test/manual-codex-config.test.ts` | +5 | -5 |
| `test/model-exclude.test.ts` | +4 | -2 |
| `test/gateway.test.ts`（含先前改动） | +48 | -199 |
| `test/webui.test.ts`（含先前改动） | +32 | -57 |
| `test/cli-flags.test.ts` | +6 | -0 |

### 📁 Files Modified
- `apps/gateway/src/model-state.ts`
- `apps/gateway/src/cli.ts`
- `apps/gateway/src/webui.ts`
- `apps/gateway/src/types.ts`
- `apps/gateway/config.schema.json`
- `apps/gateway/src/ui/api.ts`
- `apps/gateway/src/ui/ConfigPage.tsx`
- `apps/gateway/src/ui/i18n/locales/zh/config.ts`
- `apps/gateway/src/ui/i18n/locales/en/config.ts`
- `apps/gateway/README.md`
- `test/model-state.test.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/manual-codex-config.test.ts`
- `test/model-exclude.test.ts`
- `test/gateway.test.ts`
- `test/webui.test.ts`
- `test/cli-flags.test.ts`

### ✅ Verification
- `bun run check`：lint、包边界、构建（含 UI）、typecheck、1381 项测试全部通过。
- 用本机 `~/.agent-proxy-gateway/codex-catalog.json` 按 priority 排序复现了选择框交错顺序，确认根因。
- Herdr t2f（Antigravity）按 a–d 逐项验收：a（默认移除指向）/c（动态模式忽略开关）/d（前缀保留 + priority 连续）通过；b 的 CLI 入路经白名单修复后通过（单测 `codexStaticCatalog 开启时受管写入静态指向，动态模式忽略该开关`、`model catalog toml writes or removes the managed pointer by staticCatalog flag` 覆盖写入与幂等）。
