## [2026-09-17 11:38] | Task: web 命令改为默认前台启动，--daemon 后台启动

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3-Flash`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> web 的命令也应该修改一下，默认 web === web --start 前台启动， web --daemon 后台启动

### 🛠 Changes Overview
**Scope:** `src/cli.ts`、`test/install-rollback.test.ts`、`README.md`、`AGENTS.md`

**Key Actions:**
- **web 命令语义重构**: `web`（默认，`--start` 同义）前台启动——检查网关（未运行则启动）后前台运行 UI 服务、打印带令牌地址并打开浏览器，Ctrl-C 停止；`web --daemon` 后台启动——经 LaunchAgent 拉起后打开浏览器并返回 shell（即原 `web` 默认行为）。`--status/--stop/--restart` 仍只作用于后台 UI 服务。
- **前台运行助手复用**: 抽出 `runWebUiForeground(paths, config, openBrowser)`，`webui` 命令（LaunchAgent 执行体，不打开浏览器）与 `web`/`web --start`（打开浏览器）共用；SIGTERM/SIGINT 干净退出语义不变。
- **前台端口占用防御**: 后台服务已在跑时前台启动先报「Web UI is already running on port N; stop it first with: codex-cliproxy web --stop」，避免 Bun.serve 抛晦涩的端口冲突。
- **dev:ui 兼容**: `CODEX_CLIPROXY_UI_DEV=1` 复用 web 时强制走后台路径（Vite 需要接管终端），dev 行为不变。
- **参数门禁**: `--start`/`--daemon` 进 parseArgs 布尔 flag 与 web 命令白名单；五个模式 flag 互斥校验前置到平台/安装检查之前，且「只属于 web 命令」的明确报错先于通用未知选项报错。
- **文档**: usage()、README（命令表、LaunchAgent 说明、dev:ui 段落）、AGENTS.md 安全段落的 web 描述同步更新；`--status` 未运行提示指向 `web --daemon`。

### 🧠 Design Intent (Why)
原 `web` 默认经 LaunchAgent 后台拉起，用户看不到进程、Ctrl-C 也停不掉，与「前台跑一个本地面板」的直觉不符。改为默认前台（`web`/`web --start`）后进程归属清晰、Ctrl-C 即停；需要常驻时显式 `--daemon`。`webui` 保持 LaunchAgent 执行体定位（不动浏览器、绑默认配置），只把服务循环抽成共用助手避免两份漂移。互斥校验前置让参数错误的反馈与平台、安装状态无关，测试也因此无需构造安装。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（相对任务起点暂存区的增量，不含 dist 构建产物）。

- **Files changed:** 4
- **Insertions:** +106
- **Deletions:** -56

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +75 | -47 |
| `test/install-rollback.test.ts` | +19 | -0 |
| `README.md` | +11 | -8 |
| `AGENTS.md` | +1 | -1 |

### 📁 Files Modified
- `src/cli.ts`
- `test/install-rollback.test.ts`
- `README.md`
- `AGENTS.md`
- `docs/histories/2026-09/20260917-1138-web-command-foreground-default.md`

### ✅ Verification
- `bun run check`：类型检查通过；333 个测试全过（新增 1 例：模式互斥与错置 flag 门禁，不依赖安装即可验证）；UI/CLI 构建成功。
- `codex-cliproxy help` 的 Web UI 段落已按新语义输出。

### 2026-09-17 后续调整：移除 webui 命令

**执行上下文：** Codex / GPT-6 / Codex desktop；Git User：`hubert <hubert@lejian.com>`；分支：`codex/codex-api`。

**用户诉求：** 继续前序任务，不需要保留 `webui` 命令。

- 删除 `webui` 的帮助、命令分发、配置同步与旧 `--config` 兼容入口。
- LaunchAgent 改为运行 `web`，并通过 `CODEX_CLIPROXY_UI_SERVICE=1` 进入服务模式：只运行默认配置对应的 UI，不检查或启动网关、不打开浏览器，优先于开发模式。
- 保留 `web` / `web --start` 前台行为、`web --daemon` 后台行为，以及后台状态、停止和重启操作。
- 后台服务启动或重启时会重写 plist；已经运行的旧服务无需立即停止，下次 `web --restart` 可切换至新入口。不保留旧命令别名。
- 更新 README、AGENTS 与源码注释；既有历史段落描述的是前次实现，本次调整取代其中保留 `webui` 的决定。
- 新增子进程回归测试：无安装状态、无网关且同时设置开发标记时，UI API 仍可启动；SIGTERM 后正常退出，不生成后台 plist 或输出浏览器令牌地址。

**变更统计：** 相对本次任务起点的暂存区，执行 `git diff --shortstat` / `git diff --numstat`，不含本历史补记：7 个文件，+96 / -41。

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +1 | -1 |
| `README.md` | +4 | -2 |
| `src/cli.ts` | +17 | -28 |
| `src/launchd.ts` | +5 | -3 |
| `src/webui.ts` | +3 | -3 |
| `test/install-rollback.test.ts` | +11 | -2 |
| `test/webui.test.ts` | +55 | -2 |

**验证：** `bun run check` 通过（334 个测试、类型检查、UI/CLI 构建）；`git diff --check` 通过；CLI 帮助仅显示 `web` 相关命令。首次沙箱内运行网络测试因回环监听被拒而失败，获准在沙箱外执行限时 60 秒的完整检查后全部通过。

**开发页实测：** 启动 Vite 后，旧 UI 后台服务的拉取接口返回 404；通过 `web --restart` 加载当前源码并使用新服务入口后恢复正常。启动流程将已有本地令牌带入开发页且不输出令牌，在 Chrome 点击「拉取模型」，先出现禁用的「拉取中…」，随后展开 55 个上游模型，原有 15 个选中状态保留，保存按钮仍为禁用；未提交模型选择或重启模型网关。开发服务与已认证结果页保留供用户继续操作。
