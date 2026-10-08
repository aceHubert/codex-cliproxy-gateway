## [2026-10-02 21:40] | Task: Web UI 展示 Qoder 登录来源只读矩阵

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 在web 中的qoder 后面也加一个button复选框表示当前是 CLI/DESKTOP CN/INTL 的启用为只读

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/qoder、src/webui.ts、src/ui、README、docs）

**Key Actions:**
- **[检测拆分]**: 新增 `qoderCliCredentialsPresent` 与 `qoderDesktopCredentialsPresent`，
  把原先合一的 `qoderRegionCredentialsPresent` 拆成 CLI/桌面两个独立存在性检查，
  原函数改为二者逻辑或，网关与旧调用行为不变。
- **[只读响应]**: `/ui/api/config` 新增 `detected.qoderSources` 标签数组，按网关
  真实加载顺序（CLI 优先、缺失回退桌面版）逐地域计算当前生效来源；只做文件
  存在性探测，不返回认证目录、机器标识或任何凭据内容。
- **[UI 展示]**: Qoder 开关后仅渲染实际生效来源的只读复选框（可能为
  `CLI-INTL`、`CLI-CN`、`DESKTOP-INTL`、`DESKTOP-CN` 的子集），全部为
  `checked + disabled + readOnly`，不参与保存表单，也不进入 `UiConfigChanges`。
- **[文案与布局]**: 中英文补充「登录来源」说明；来源区在窄屏自动换行，
  避免与 Qoder 开关挤压。
- **[测试]**: 新增 CLI/桌面检测互不干扰、CLI 优先于桌面、强制桌面跳过的用例；
  Web UI 用例断言无登录、仅 CLI、仅桌面三种状态下只返回生效来源，并继续
  验证不泄露凭据。

### 🧠 Design Intent (Why)
- 用户需要一眼看出 Qoder 当前由 CLI 还是桌面版、国际版还是国内版提供登录，
  但网关对 Qoder 凭据始终只读，Web UI 不能提供任何可写入口。
- 单开关只表达「Qoder 适配是否启用」，无法表达实际使用的登录来源；
  新增只读来源展示可在不改变配置 schema 与保存语义的前提下补齐可观测性。
- 初版把四个可用来源全部标为已启用，用户本机 CLI 与桌面版同时登录时
  出现四个勾且无法区分实际使用项；改为按加载顺序只显示真正生效的来源。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`；`src/qoder/credentials.ts`、
> `test/qoder-credentials.test.ts`、`test/qoder-webui.test.ts` 仍为 untracked
> Qoder 特性文件，下列统计按本任务增量整理。

- **Files changed:** 10
- **Insertions:** +150（本任务增量，不含 untracked 文件既有内容）
- **Deletions:** -12

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/qoder/credentials.ts` | +34 | -8 |
| `src/webui.ts` | +14 | -2 |
| `src/ui/api.ts` | +12 | 0 |
| `src/ui/ConfigPage.tsx` | +44 | -1 |
| `src/ui/i18n.tsx` | +4 | 0 |
| `src/ui/styles.css` | +40 | 0 |
| `test/qoder-credentials.test.ts` | +39 | 0 |
| `test/qoder-webui.test.ts` | +9 | -5 |
| `README.md` | +12 | -3 |
| `docs/exec-plans/active/qoder-international-flash-proxy-integration.md` | +6 | -2 |

### 📁 Files Modified
- `src/qoder/credentials.ts`、`src/webui.ts`、`src/ui/api.ts`
- `src/ui/ConfigPage.tsx`、`src/ui/i18n.tsx`、`src/ui/styles.css`
- `test/qoder-credentials.test.ts`、`test/qoder-webui.test.ts`
- `README.md`、`docs/exec-plans/active/qoder-international-flash-proxy-integration.md`

### ✅ Verification
- `bun test test/qoder-credentials.test.ts test/qoder-webui.test.ts`：15 项全通过。
- `bun run typecheck`：通过。
- `bun run build`：UI 与 CLI 构建通过，产物已包含四个来源标签。
- `git diff --check`：通过。
- `bun test` 全量运行受当前环境限制失败：本机 Bun 1.3.5 在沙箱内对任意端口
  `Bun.serve` 均报 `EADDRINUSE`（`port: 0` 与固定端口同样失败），导致
  realtime/webui 等依赖监听端口的用例失败；与本次 Qoder 来源矩阵改动无关。
- 重启 `codex-cliproxy-webui` 后实际接口返回
  `qoderSources: ["CLI-INTL", "CLI-CN"]`，与加载器 CLI 优先行为一致。
