## [2026-09-14 16:29] | Task: 更新跨平台项目定位

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 项目不再定位为仅面向 macOS：API key 存储已兼容其他平台，其余 Bun 网关能力也是跨平台的。

### 🛠 Changes Overview
**Scope:** 项目定位、发布元数据与支持边界文档

**Key Actions:**
- **[项目定位]**: 将 AGENTS.md、README 和 npm 包描述更新为跨平台 Bun 网关。
- **[发布限制]**: 删除 `package.json` 的 `darwin` 安装白名单，允许其他 Bun 平台安装包。
- **[能力边界]**: 保留 launchd/LaunchAgent 自动安装和服务管理仅限 macOS 的准确说明。

### 🧠 Design Intent (Why)
核心网关、前台 Web UI 与非 darwin 的 `credentials.json` 密钥后端不应被 npm 元数据或项目文案误限定为 macOS。同时，未实现的 Linux/Windows 后台服务管理不应被宣称为已支持，因此将平台限制精确收窄到 launchd 相关命令。

### 📊 Change Stats
> 工作区已有其他未提交改动，以本任务独立补丁统计。

- **Files changed:** 5
- **Insertions:** +52
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +1 | -1 |
| `README.md` | +5 | -2 |
| `package.json` | +1 | -4 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -1 |
| `docs/histories/2026-09/20260914-1629-cross-platform-positioning.md` | +44 | -0 |

### 📁 Files Modified
- `AGENTS.md`
- `README.md`
- `package.json`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/histories/2026-09/20260914-1629-cross-platform-positioning.md`
