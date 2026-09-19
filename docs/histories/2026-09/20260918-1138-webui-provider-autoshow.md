## [2026-09-18 11:38] | Task: Web 设置按本机配置自动显隐 zcode/codebuddy 开关

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `a14d47f3-204c-4979-be58-fd77ef7f8b68/Atria-Dawn-Preview`
* **Runtime**: ZCode CLI
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 查一下 web 设置中，zcode 和 codebuddy 如果本机没有检测到配置是否也显示，这个应该根据本地配置自动显示

### 🛠 Changes Overview
**Scope:** codex-cliproxy（Web UI 后端 `webui.ts`、前端 `src/ui/`、zcode/codebuddy 检测层）

**Key Actions:**
- **[排查结论]**: `ConfigPage` 此前无条件渲染 zcode/codebuddy 两个开关，只读 config.json 里保存的布尔值，与本机是否真有 `~/.zcode` 配置或 CodeBuddy `.info` 凭据无关。
- **[检测函数]**: `zcode/config.ts` 新增 `zcodeConfigPresent(home)`——`setting.json`（渠道/provider 选择）与 `config.json`（provider 路由）齐备才算就绪，home/v2 布局按 `readPreferred` 的回退顺序逐文件判定；`codebuddy/credentials.ts` 新增 `codebuddyCredentialsPresent(infoFile?)`——只探测平台默认 `.info` 是否存在。
- **[API]**: `GET /ui/api/config` 新增 `detected: { zcode, codebuddy }` 分组；`WebUiContext.providerDeps` 供测试注入探测路径，缺省按 `paths.home` 解析 `~/.zcode`、按平台默认位置解析 `.info`。
- **[前端]**: `UiConfig` 加 `detected` 类型；`ConfigPage` 用 `detected || editable` 决定显隐——未检测到且未开启时整行隐藏，已开启但本机配置消失时仍显示（便于在 UI 里关回）并给「未检测到本机配置」提示；`i18n` 补 `zcodeMissingHint` / `codebuddyMissingHint` 中英文案。

### 🧠 Design Intent (Why)
开关存在的前提是本机有可用配置：没有 `~/.zcode` 或 `.info` 时，zcode/codebuddy 入口即使开启也必然在缓存取快照时报错。对这类机器展示开关是误导。探测刻意只做存在性判断（`fs.existsSync`），不打开、不解析凭据，响应里只有布尔值——延续 webui 的安全边界：UI 进程不经手任何凭据内容（测试显式断言带伪造 token 的 `.info` 不会泄漏进响应）。zcode 要求两个文件齐备而非「任一存在」，是为了对齐 `createZcodeConfigCache` 的真实依赖（`readSelection` + `readRoute`），避免配置只写了一半却显示可用。

### 📊 Change Stats
> 只统计本次任务相关文件（分支上已有的 codebuddy 适配器改动不计）。

- **Files changed:** 10
- **Insertions:** +195
- **Deletions:** -47

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +1 | -1 |
| `src/codebuddy/credentials.ts` | +8 | 0 |
| `src/ui/ConfigPage.tsx` | +58 | -44 |
| `src/ui/api.ts` | +5 | 0 |
| `src/ui/i18n.tsx` | +4 | 0 |
| `src/webui.ts` | +22 | -2 |
| `src/zcode/config.ts` | +11 | 0 |
| `test/codebuddy-credentials.test.ts` | +14 | 0 |
| `test/webui.test.ts` | +39 | 0 |
| `test/zcode-config.test.ts` | +33 | 0 |

另重建 `dist/ui/index.html`（`bun run build:ui` 产物，非手工编辑）。

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/codebuddy/credentials.ts`
- `src/webui.ts`
- `src/ui/api.ts`
- `src/ui/ConfigPage.tsx`
- `src/ui/i18n.tsx`
- `AGENTS.md`
- `test/zcode-config.test.ts`
- `test/codebuddy-credentials.test.ts`
- `test/webui.test.ts`

### ✅ Verification
- `bun run typecheck`：通过（严格模式）。
- `bun test`：404 pass / 0 fail（28 个文件）。
- `bun run build:ui`：成功，`dist/ui/index.html` 已重建。
- 新增测试覆盖：`zcodeConfigPresent` 的空目录/单文件/齐备/v2 布局/混合布局；`codebuddyCredentialsPresent` 的缺失/存在；webui 集成测试断言探测结果随文件变化且不回显 `.info` 凭据内容。
