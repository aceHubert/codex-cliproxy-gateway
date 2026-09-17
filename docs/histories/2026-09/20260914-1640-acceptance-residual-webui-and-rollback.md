# [2026-09-14 16:40] | Task: 收掉 webui --config 并修正安装回滚可见性

## 🤖 Execution Context

* **Agent ID**: `MiMo`
* **Base Model**: `MiMo`
* **Runtime**: `MiMo Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/acceptance-residual`

## 📥 User Query

> 验收残留：`webui --config` 仍同步默认配置；目录符号链接可绕过实例隔离；回滚健康检查访问候选端口；LaunchAgent 恢复失败被吞掉。
> 澄清：用户面只有 `web` / `web --status` / `web --stop` / `web --restart`；`webui --config` 不是需求。

## 🛠 Changes Overview

**Scope:** codex-cliproxy（src/cli.ts、src/launchd.ts、src/paths.ts、src/webui.ts、docs、tests）

**Key Actions:**

- **[cli.ts]** `webUiCommand` 始终绑定默认安装配置，忽略废弃 `--config`（旧 LaunchAgent 兼容）；usage 去掉调试表述；`serve` 生产判定改 `realPathOrResolve`；新增并导出 `restoredHealthUrl` / `composeInstallFailureMessage`；原地安装回滚健康检查改用恢复后 host/port，LaunchAgent 恢复失败经 `restoreIssues` 并入最终错误。
- **[launchd.ts]** `renderWebUiAgent` ProgramArguments 改为 `webui`（不再传 `--config`）；`startWebUiLaunchAgent` 不再要求 `configPath`。
- **[paths.ts]** 新增 `realPathOrResolve`（穿透文件/目录符号链接）。
- **[webui.ts]** `webUiContextForInstance` 用真实路径判定生产实例。
- **[docs]** README / AGENTS 同步；执行计划 `acceptance-residual-fixes` 完成并移至 completed。

## 🧠 Design Intent (Why)

用户明确只要 `web` 三件套；`webui --config` 是后加调试面，验收 P1 打的是它。删除该面后 P1 主体关闭，软链攻击面随 `--config` 消失，realpath 作为默认路径判定的结构防线保留。回滚时必须探测恢复后的旧端口，并把恢复失败从空 catch 中捞出——主错误仍是原始安装错误。

## 📊 Change Stats

> 已跟踪文件相对 acceptance-residual base 的 `git diff --numstat`；整提交含新增文件共 10 files / +432 / -60。

- **Files changed (tracked):** 7
- **Insertions / deletions (tracked):** +164 / -60

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +55 | -14 |
| `src/paths.ts` | +19 | -0 |
| `src/webui.ts` | +5 | -3 |
| `src/launchd.ts` | +4 | -3 |
| `test/webui.test.ts` | +28 | -1 |
| `README.md` | +52 | -38 |
| `AGENTS.md` | +1 | -1 |

另新增：`test/install-rollback.test.ts`、`docs/exec-plans/completed/acceptance-residual-fixes.md`、本 history。

## 📁 Files Modified

- `src/cli.ts`、`src/launchd.ts`、`src/paths.ts`、`src/webui.ts`
- `test/webui.test.ts`、`test/install-rollback.test.ts`（新增）
- `AGENTS.md`、`README.md`
- `docs/exec-plans/completed/acceptance-residual-fixes.md`

## 验证

- `bun run typecheck` 通过。
- `bun test test/webui.test.ts test/install-rollback.test.ts test/paths.test.ts` 全绿。
- `bun test`（除 `test/zcode-cache.test.ts`「实际 fs.watch 收到原子替换事件后刷新」）305 pass / 0 fail；该用例与本轮无关，单独复现稳定失败。
- `bun run build` 成功（1.35 MB 单文件）。
