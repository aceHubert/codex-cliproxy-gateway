# [2026-10-02 18:24] | Task: Web UI 增加 CodeBuddy 地域选择

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> Web 中增加一个按钮式选择控件，在 CodeBuddy 开关同一行显示，并放到最右侧；随后要求停止自动验证，改由人工验证。

### 🛠 Changes Overview
**Scope:** codex-cliproxy Web UI（`src/webui.ts`、`src/config-update.ts`、`src/ui/`、`test/webui.test.ts`）

**Key Actions:**
- **[API]**: `GET /ui/api/config` 的 `editable` 新增 `codebuddyRegion`，缺省回显 `auto`。
- **[配置写入]**: Web UI 补丁白名单加入 `codebuddyRegion`，只接受 `auto`、`cn`、`intl`，并沿用现有配置校验、状态同步、审计与网关重启链路。
- **[前端]**: CodeBuddy 开关行改为两端布局，左侧保留原 switch，右侧新增 `AUTO / CN / INTL` 三段按钮组；选中态接入脏检测与保存，`upstream-only` 下与开关同步禁用。
- **[文案与样式]**: 补中英文地域说明与 `region-segmented` 紧凑按钮样式。
- **[测试]**: 更新 `test/webui.test.ts`，覆盖默认回显、region 写入与非法值拒绝。

### 🧠 Design Intent (Why)
`codebuddyRegion` 原先只有 CLI 与配置 schema 支持，Web UI 无法查看或修改。地域包含 `auto` 三态，直接用二元复选框会丢失“按最近登录自动选择”的语义，因此在 CodeBuddy 开关行最右侧使用三段按钮组，既满足行内放置，也完整保留 `auto / cn / intl`。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`；用户要求跳过自动验证，统计只覆盖代码改动。

- **Files changed:** 7
- **Insertions:** +189
- **Deletions:** -13

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/config-update.ts` | +29 | -2 |
| `src/webui.ts` | +8 | -2 |
| `src/ui/ConfigPage.tsx` | +61 | -6 |
| `src/ui/api.ts` | +5 | -0 |
| `src/ui/i18n.tsx` | +12 | -0 |
| `src/ui/styles.css` | +56 | -0 |
| `test/webui.test.ts` | +18 | -3 |

### 📁 Files Modified
- `src/config-update.ts`
- `src/webui.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/api.ts`
- `src/ui/i18n.tsx`
- `src/ui/styles.css`
- `test/webui.test.ts`

### ✅ Verification
- 用户明确要求停止自动验证，改由人工验证；本次未在最终状态下重新运行测试、类型检查或页面截图。
- 此前 `bun run typecheck`、完整 `bun test` 与 `bun run build:ui` 已通过，但用户要求停止验证后未再复跑。
