# [2026-09-13 22:48] | Task: 安装回滚强制重载旧 LaunchAgent 定义

## 🤖 Execution Context

* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query

> [P2] 安装回滚未重新加载旧 LaunchAgent 定义 — src/cli.ts:827、src/launchd.ts:101。
> 新任务 bootstrap 成功、kickstart 失败后，回滚虽然恢复磁盘上的旧 plist，但随后只对已加载的新任务再次执行 kickstart。隔离 mock 确认旧服务仍可能无法恢复。需要重新加载旧 plist，而不只是重启当前任务。

## 🛠 Changes Overview

**Scope:** codex-cliproxy-gateway（src/launchd.ts、src/cli.ts）

**Key Actions:**

- **[launchd.ts]** 新增 `reloadLaunchAgent(plistPath)`：`bootout`（忽略错误）→ `bootstrap` → `kickstart`，强制丢弃 launchd 已加载的定义、按磁盘 plist 重新加载；`restartLaunchAgent` 的全局语义（已加载时仅 `kickstart -k`）保持不变。
- **[cli.ts]** 安装前额外记录 `previousServiceLoaded`（`launchAgentStatus() !== null`）；两个回滚分支在回写旧 plist 后按加载态分派——旧任务曾加载 → `reloadLaunchAgent` 按旧定义拉回；本就未加载 → `stopLaunchAgent` 卸载新任务、回到安装前状态（不凭空拉起服务）。

## 🧠 Design Intent (Why)

`restartLaunchAgent` 在任务已加载时只做 `kickstart -k`，按 launchd **已加载**的定义重启进程；安装失败场景里已加载的是刚 bootstrap 的新任务，回滚回写到磁盘的旧 plist 不会重新生效——旧服务因此可能无法恢复。回滚需要“磁盘定义重新生效”，故用专属的 `reloadLaunchAgent` 而非改动常规重启语义；`previousServiceLoaded` 保证未加载的残留 plist 只恢复文件、不凭空启动服务。

## 📊 Change Stats

> `git diff --numstat`，本任务增量部分（`src/cli.ts` 的统计含上一任务 F6 基线改动）。

- **Files changed:** 2
- **Insertions:** +30（launchd.ts +12；cli.ts 增量约 +18/-1）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/launchd.ts` | +12 | -0 |
| `src/cli.ts` | +18（增量） | -1（增量） |

## 📁 Files Modified

- `src/launchd.ts`
- `src/cli.ts`
- `docs/exec-plans/completed/codex-review-fixes.md`（F6 补充说明与决策记录）
- `docs/exec-plans/tech-debt-tracker.md`（F6 行更新）

## 验证

- `bun run typecheck` 通过；`bun run check` 全绿（typecheck + 304 tests + build）。
- launchctl 真实副作用无法注入 stub，重载路径与上一轮 F6 同样以代码审查验收，自动化缺口已在 `docs/exec-plans/tech-debt-tracker.md` 登记。
