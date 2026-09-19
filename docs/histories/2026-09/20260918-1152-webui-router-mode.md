## [2026-09-18 11:52] | Task: Web 设置「路由模式」改用 routerMode 显示模式名

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `a14d47f3-204c-4979-be58-fd77ef7f8b68/Atria-Dawn-Preview`
* **Runtime**: ZCode CLI
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 路由模式需要更新一下，false 容易混淆，应该根据 upstreamOnly 的值来取反，路由模式写成 routerMode

### 🛠 Changes Overview
**Scope:** codex-cliproxy（Web UI 后端 `webui.ts`、前端 `src/ui/`）

**Key Actions:**
- **[后端]**: `GET /ui/api/config` 的 `readonly` 分组新增 `routerMode: "dynamic" | "upstream-only"`，由 `upstreamOnly` 取反导出（`false -> dynamic`、`true -> upstream-only`）；`upstreamOnly` 布尔值保留供前端逻辑判断（开关禁用、保存弹窗分支）。
- **[前端]**: `UiConfig.readonly` 加 `routerMode` 类型；只读行 keyname 从 `upstreamOnly` 改为 `routerMode`，主值显示本地化的模式名（动态路由 / 纯上游转发），旁边小标签显示机器值并保留绿/紫状态色；i18n 键 `labelUpstreamOnly` 重命名为 `labelRouterMode`（文案不变）。
- **[文案]**: `descUpstreamOnly` 的「cliproxy/* 转发第三方」改为「转发上游」，与字段命名一致。

### 🧠 Design Intent (Why)
原只读行直接 `String(upstreamOnly)` 贴出 `true/false`：`false` 看不出是什么模式，只能靠旁边 badge 推断。`routerMode` 把「取反」语义固化在后端，前端展示的就是模式名本身；机器值降为小标签（与 upstreamType 行的 `cliproxy` + `active` badge 同构）。`upstreamOnly` 不从响应移除——前端开关禁用与保存分支仍在用，且 status 端点也暴露同名字段。

### 📊 Change Stats
> 只统计本次任务相关文件。

- **Files changed:** 5
- **Insertions:** +159
- **Deletions:** -55

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +24 | -2 |
| `src/ui/api.ts` | +7 | 0 |
| `src/ui/ConfigPage.tsx` | +65 | -49 |
| `src/ui/i18n.tsx` | +7 | -3 |
| `test/webui.test.ts` | +56 | -1 |

另重建 `dist/ui/index.html`（`bun run build:ui` 产物，非手工编辑）。

### 📁 Files Modified
- `src/webui.ts`
- `src/ui/api.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/i18n.tsx`
- `test/webui.test.ts`

### ✅ Verification
- `bun run typecheck`：通过。
- `bun test`：405 pass / 0 fail（28 个文件）。
- `bun run build:ui`：成功，`dist/ui/index.html` 已重建。
- 新增/补充测试：既有配置响应测试断言 `upstreamOnly=false` 时 `routerMode === "dynamic"`；新增 `upstreamOnly=true` 时 `routerMode === "upstream-only"` 的取反用例。
