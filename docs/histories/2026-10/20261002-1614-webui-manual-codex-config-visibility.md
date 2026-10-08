# [2026-10-02 16:14] | Task: Web UI 展示 config.toml 管理模式与手动配置指引

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 「Web UI 手动模式可见性」这条技术债去掉，改为直接实现：Web UI 显示托管/手动状态；手动模式时把设置方法展开显示出来（含各键在 config.toml 里的当前状态）。

### 🛠 Changes Overview
**Scope:** codex-cliproxy Web UI（`src/webui.ts`、`src/ui/`、`test/webui.test.ts`）

**Key Actions:**
- **[API]**: `GET /ui/api/config` 的 `readonly` 新增 `codexConfigManaged`（读 `state.json`，缺省/缺失/解析失败一律按托管，`instanceOnly` 临时实例固定托管）；手动模式额外返回 `manualCodexConfig` 指引块——`gatewayBaseUrl`（经 sanitizeUrlValue）、`staticCatalogActive`（upstreamOnly 且有已选模型）、`removeModelCatalogJson`（非 static 但用户 toml 残留该键）与逐键 `keys`（3 个服务键 = 网关地址，static 时追加 `model_catalog_json = catalogPath`；每键含 expected / current / matches，URL 类 current 过 sanitize）。只读 4 个受管键，不回显 toml 其他内容。
- **[前端]**: `ConfigPage` card2「安装配置」顶部新增「Codex 配置 / config.toml」行：托管 = 绿色 pill + 命令维护说明，手动 = 琥珀 pill + 模式说明；手动模式下直接展开「手动配置方法」块（不折叠）——逐键期望值（等宽 + 复制按钮，复制整行 `key = "value"`）与状态徽标（✓ 已配置 / ✗ 未配置 / ⚠ 不一致附当前值）、static 缺键警示、残留键删除提示、改后需重开 Codex 与 uninstall 不动文件的脚注。`i18n` 补 16 组中英文案；`styles.css` 新增 `pill-amber`/`pill-red` 与手动块样式。
- **[类型]**: `src/ui/api.ts` 同步 `codexConfigManaged`、`ManualCodexConfig`/`ManualCodexKeyRow` 类型。
- **[测试]**: `test/webui.test.ts` 增 3 例（共 43 pass）：托管三态（无 state/缺省/显式 true）不返回指引块；手动模式逐键三态（匹配/不一致含 query 脱敏/未配置）且不外发 toml 其他内容；static 激活追加 `model_catalog_json`（expected = catalogPath）与切回 split 后残留键提示删除。

### 🧠 Design Intent (Why)
上一任务交付了 CLI 侧 `--manual-codex-config`（warning + 设置方法打印），但 Web UI 完全看不到安装处于哪种 config.toml 管理模式，手动模式用户每次都要回终端翻输出。按用户决定撤销「留作技术债」的原计划，直接实现只读展示：状态徽标回答「谁在管 config.toml」，展开块把 CLI 打印过的设置方法搬到 UI 并实时比对用户 toml 当前值（✓/✗/⚠），形成「照着改 → 刷新即见绿勾」的闭环。展示保持纯只读（不提供 UI 写 config.toml 的路径），`current` 只取 4 个受管键且 URL 过 sanitizeUrlValue，遵守 webui 不反向依赖 cli.ts、不外发 query token 的既有边界。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（相对任务开始时）；tech-debt-tracker 的债务条目删除与计划文档归档不计入下表。

- **Files changed:** 6（含 1 个新增计划文档归档）
- **Insertions:** +484
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +81 | -5 |
| `test/webui.test.ts` | +195 | -1 |
| `src/ui/ConfigPage.tsx` | +52 | -0 |
| `src/ui/styles.css` | +56 | -0 |
| `src/ui/i18n.tsx` | +28 | -0 |
| `src/ui/api.ts` | +20 | -0 |

### 📁 Files Modified
- `src/webui.ts`
- `test/webui.test.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/styles.css`
- `src/ui/i18n.tsx`
- `src/ui/api.ts`
- `docs/exec-plans/completed/webui-manual-codex-config-visibility.md`（新增，自 active/ 归档）
- `docs/exec-plans/tech-debt-tracker.md`（删除「Web UI 手动模式可见性」条目）

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test` 全量 499 pass / 0 fail（31 个文件；webui 43 例含新增 3 例）。
- `bun run check`（typecheck + tests + `build:ui` + bundle）完整通过；UI HTML 已重建（292.90 kB），前端改动刷新页面即生效，无需重启 web 服务；API 改动需重启 web 服务（daemon 模式 `codex-cliproxy web --restart`）。
