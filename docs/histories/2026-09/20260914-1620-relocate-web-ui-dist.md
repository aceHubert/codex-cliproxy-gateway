## [2026-09-14 16:20] | Task: 迁移 Web UI 发布产物

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 将 Web UI 构建输出从 `src/ui/dist/` 调整到 `dist/ui/`，确保 npm 安装包可正常携带 UI 产物；随后按最小改动切换为 Vite 构建 React Hash SPA。

### 🛠 Changes Overview
**Scope:** Web UI 构建与 npm 发布

**Key Actions:**
- **[构建目录]**: 自包含 HTML 改为输出到 `dist/ui/index.html`，构建日志同步显示新目录。
- **[发布白名单]**: npm `files` 发布根 `dist/`，避免安装包漏掉 UI 产物。
- **[Vite 构建]**: 增加标准 HTML 入口，通过 Vite 与 `vite-plugin-singlefile` 生成自包含页面。
- **[HMR 开发]**: 增加共享 Vite 配置与 `dev:ui`，默认在 8322 热更新并将 `/ui/api/*` 安全代理到 8321；开发端口与后端端口均可通过环境变量覆盖。
- **[命令边界]**: `dev:ui` 复用 `web` 启动网关和 UI API，通过内部环境变量跳过生产页面，再由 Vite 自动打开 HMR 页面；正式 `web` 行为不变。
- **[移除桥接]**: 删除 `html.generated.ts`，正式 Web UI 按请求读取随包发布的 `dist/ui/index.html`，缺失时返回可执行的修复提示。
- **[文档同步]**: 更新仓库说明、发布说明和 Web UI 执行计划中的产物约束。

### 🧠 Design Intent (Why)
`dist/ui/index.html` 是可发布且运行时必需的最终静态产物，应与 CLI 入口统一位于根 `dist/` 下并明确进入 npm 白名单。Vite 负责标准 SPA 构建和独立 HMR 开发服务，单文件插件保持服务端无需提供 assets 路由；Web UI 直接读取该文件，避免在包中重复保存整份 HTML。开发服务器仅绑定 loopback，在 8322 避开正式 UI/API 的 8321，并在代理时重写 Host/Origin 以复用后端现有安全校验，不改变生产 `web` 生命周期。

### 📊 Change Stats
> 数据按本次任务实际修改统计，不包含工作树中已有的其他未提交改动。

- **Files changed:** 12
- **Insertions:** +283
- **Deletions:** -71

| File | +Added | -Removed |
| --- | ---: | ---: |
| `scripts/build-ui.ts` | +8 | -53 |
| `vite.config.ts` | +47 | -0 |
| `src/ui/index.html` | +12 | -0 |
| `src/ui/dist/html.generated.ts` | +0 | -2 |
| `src/webui.ts` | +23 | -7 |
| `test/webui.test.ts` | +15 | -2 |
| `package.json` | +4 | -1 |
| `bun.lock` | +78 | -0 |
| `AGENTS.md` | +3 | -2 |
| `README.md` | +17 | -1 |
| `docs/exec-plans/completed/web-config-ui.md` | +3 | -3 |
| `docs/histories/2026-09/20260914-1620-relocate-web-ui-dist.md` | +73 | -0 |

### 📁 Files Modified
- `scripts/build-ui.ts`
- `vite.config.ts`
- `src/ui/index.html`
- `src/ui/dist/html.generated.ts`（删除）
- `src/webui.ts`
- `test/webui.test.ts`
- `package.json`
- `bun.lock`
- `AGENTS.md`
- `README.md`
- `docs/exec-plans/completed/web-config-ui.md`
- `docs/histories/2026-09/20260914-1620-relocate-web-ui-dist.md`

### ✅ Validation
- `bun run build:ui`：Vite 成功构建 23 个模块，输出单个自包含 `dist/ui/index.html`。
- `bun run dev:ui`：Vite 在 `127.0.0.1:8322` 启动并注入 HMR 客户端。
- 环境变量：`CODEX_CLIPROXY_UI_DEV_PORT=8323` 生效，开发端口与后端端口相同时明确拒绝启动。
- 开发代理：`/ui/api/status` 经 Vite 到 UI 后端返回预期 401（缺令牌），证明 Host/Origin 校验与代理链路正常。
- `bun test test/webui.test.ts`：27 个测试全部通过。
- 产物检查：发布 HTML 不存在外部 `assets/*` 引用，运行时直接读取该文件。
- 缺失产物：`GET /ui` 返回 500 和 `bun run build:ui` / 重装提示，其他 CLI 导入不受影响。
- `npm pack --dry-run --ignore-scripts`：确认发布清单包含 `dist/ui/index.html`。
- `bun run check`：类型检查、320 个测试和生产构建全部通过；`dist/index.js` 不再重复内联 UI HTML。
