# [2026-10-02 15:30] | Task: install 新增 --manual-codex-config 手动管理 Codex config.toml

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 在 install 里添加一个参数：不修改 codex 的配置，手动配置，默认 false。与 static（--upstream-only）同用时提示 warning 并确认「是否修改」：YES 直接配置好（本次按托管处理），NO 装完后提示如何手动配置。--manual-codex-config 为 true 时，后续所有需要修改 codex 配置的地方都以 warning + 设置方法打印（含 models --sync 的 static 切换）。

### 🛠 Changes Overview
**Scope:** codex-cliproxy CLI（`src/cli.ts`、`test/`、README、docs）

**Key Actions:**
- **[install 参数]**: 新增 `--manual-codex-config`（默认 false，仅 install 可用）；与 `--upstream-only` 冲突时经 `resolveCodexConfigConflict` 以 warning + `Modify ~/.codex/config.toml directly? [N/y]` 询问，y 转托管写入（本次参数不生效），默认 N（含非 TTY 与 `--yes`）走手动模式。
- **[install 手动模式]**: config.toml 全程只读——跳过 `model_catalog_json` 守卫/写入、`managedCodexServiceToml` 补写与纯净备份；托管→手动原地更新先经共享的 `restoreManagedCodexToml` 还原受管键再交还用户；手动→托管重装时重新起算备份与 hash；成功输出以 WARNING 打印需手动配置的键与确切值（split：3 个服务键；static：追加 `model_catalog_json` 及「不添加静态目录不生效」说明；static→split：提示删除该键）。
- **[models --sync]**: 手动模式下 static 切换照常完成（路由、目录、选择、重启），但 config.toml 逐字节不动；切入 static 且用户 toml 缺失/指向别处时打印 `model_catalog_json = "<catalogFile>"` 指引，切回 split 且键仍存在时提示手动删除；不清理 legacy 目录文件、不推进 hash、不产生 config.toml 审计条目。
- **[restart/uninstall/status]**: restart 跳过受管键补写，改为漂移检查（服务键与网关地址不一致时 WARNING + 期望键值）；uninstall 完全跳过 config.toml 还原与 legacy 清理，完成提示区分手动模式并列出可自行移除的受管键；status JSON 新增 `codexConfigManaged`（未安装为 null）。
- **[state]**: `InstallState` 新增 `codexConfigManaged?: boolean`（缺省视为托管，旧 state 零迁移），`configBackup`/`installedConfigHash` 放宽为可选；不动 gateway `config.json` 与其 schema。
- **[测试]**: 新增 `test/manual-codex-config.test.ts` 6 例：冲突解决四分支（y/N/非 TTY/--yes，注入提问桩）、其他命令拒绝该参数、`restoreManagedCodexToml` 三分支（未手改整文件还原/手改仅还原受管键/缺备份报可执行错误）、手动模式 static 同步（config.toml 不变 + 打印键值 + `upstreamOnly: true`）、加键后切回 split（提示删除）、uninstall（config.toml 不变 + 提示区分）与 status 字段；Keychain 用 `process.env.USER` 哨兵隔离，避免测试误删本机真实上游 Key。

### 🧠 Design Intent (Why)
用户希望在特定场景（如自定义 profiles、非默认 `~/.codex` 布局）下完全掌握 `~/.codex/config.toml` 的变更权。托管模式对 config.toml 的四次写入（install/uninstall/restart/models --sync）与受管键整文件备份语义是既有行为，默认路径必须零变化；因此手动模式做成平行分支：代码永不写 config.toml，把「本应代写」的内容以 warning + 确切键值的形式交给用户，static 目录的硬约束（`model_catalog_json` 必须存在于 config.toml）通过三层提示（冲突确认、install 收尾、sync 收尾）+ `status` 字段兜底，而非硬报错阻断。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（相对任务开始时），含新增文件；同工作区内用户既有的 gateway/realtime 等未提交改动不属于本任务，未计入。

- **Files changed:** 5（含 2 个新增文件；执行计划完成后从 active/ 移至 completed/）
- **Insertions:** +642
- **Deletions:** -54

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +246 | -54 |
| `test/manual-codex-config.test.ts`（新增） | +244 | -0 |
| `README.md` | +5 | -0 |
| `docs/exec-plans/completed/manual-codex-config-install-flag.md`（新增，自 active/ 移入） | +147 | -0 |
| `docs/exec-plans/tech-debt-tracker.md`（追加 1 行，文件内其余改动属用户既有工作区改动） | +1 | -0 |

### 📁 Files Modified
- `src/cli.ts`
- `test/manual-codex-config.test.ts`（新增）
- `README.md`
- `docs/exec-plans/completed/manual-codex-config-install-flag.md`（新增）
- `docs/exec-plans/tech-debt-tracker.md`（追加 Web UI 手动模式开关遗留项）

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test` 全量 495 pass / 0 fail（31 个文件，含本任务新增 6 例）。
- `bun run check`（typecheck + tests + build:ui + bundle）完整通过。
