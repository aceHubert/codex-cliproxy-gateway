# [2026-09-13 23:06] | Task: 临时实例保留完整配置路径并禁止管理默认服务

## 🤖 Execution Context

* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query

> [P1] 临时实例仍可能修改、重启默认实例 — src/cli.ts:1066、src/paths.ts:39。管理路径仅保留目录，丢失实际配置文件名。使用默认运行目录中的 test.json 启动后，UI 保存仍修改默认 config.json；使用 $HOME/config.json 时，派生的 LaunchAgent 路径又命中默认服务。需要保留完整配置路径，并明确禁止临时实例管理默认服务。
> （用户另问：这是不是开发测试实例的影响？——答复：不是运行实例互相干扰，是 F3 目录级派生逻辑自身的两个漏洞，review 隔离复现发现。）

## 🛠 Changes Overview

**Scope:** codex-cliproxy-gateway（src/webui.ts、src/config-update.ts、src/paths.ts、src/cli.ts）

**Key Actions:**

- **[webui.ts]** 新增 `webUiContextForInstance(configPath, defaultPaths)`：生产实例返回全量管理上下文；临时实例**保留完整配置文件路径**（`gatewayConfig = 实际 --config 路径`，不再回落目录下的 config.json）并置 `instanceOnly: true`。
- **[webui.ts]** `WebUiContext.instanceOnly`：POST 配置时显式禁止临时实例 `markPendingRestart`/调度重启——即使派生路径下真实存在 plist 也拒绝管理。
- **[config-update.ts]** `applyWebUiConfigPatch` 增加 `syncState` 参数（默认 true）：临时实例不回写 state.json，杜绝默认运行目录内的 test.json 把临时配置同步进生产 state。
- **[paths.ts]** `resolvePaths` 覆盖模式下 LaunchAgent 改用 `codex-cliproxy-gateway-temp.plist` 占位名：`$HOME/config.json` 的 home 几何派生曾恰好等于默认服务路径，占位名保证结构上永不相同（与 instanceOnly 构成双保险）。
- **[cli.ts]** `serve()` 改用 `webUiContextForInstance(configPath, paths)` 构造 Web UI 上下文。

## 🧠 Design Intent (Why)

F3 首版按 `dirname(configPath)` 派生管理路径，丢失文件名且"生产实例"判定只认精确路径相等：默认运行目录里的其他配置文件名（test.json）派生出与生产完全相同的管理路径；配置放 `$HOME` 时派生 LaunchAgent 命中默认服务真实路径。按 review 要求改为保留完整配置路径 + 显式禁止（instanceOnly）而非依赖"派生路径不存在"的隐式前提，占位 plist 名作为结构防线。

## 📊 Change Stats

> `git diff --numstat`（`src/cli.ts`/`test/webui.test.ts` 统计含前序任务基线，本任务增量见 Key Actions）。

- **Files changed:** 6
- **Insertions:** 约 +95（本任务增量）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +25 | -2 |
| `src/config-update.ts` | +9 | -3 |
| `src/paths.ts` | +12 | -3 |
| `src/cli.ts` | +5（增量） | -4（增量） |
| `test/webui.test.ts` | +62（增量） | -1（增量） |
| `test/paths.test.ts` | +9 | -3 |

## 📁 Files Modified

- `src/webui.ts`、`src/config-update.ts`、`src/paths.ts`、`src/cli.ts`
- `test/webui.test.ts`、`test/paths.test.ts`
- `docs/exec-plans/completed/codex-review-fixes.md`（F3 补充说明）

## 验证

- `bun run typecheck` 通过；`bun run check` 全绿（typecheck + 306 tests + build）。
- 新增回归：`webUiContextForInstance` 三个场景（默认配置→生产上下文、运行目录内 test.json→保留完整文件名、$HOME 配置→派生 LaunchAgent 不等于默认路径）；instanceOnly 行为用例（默认目录内 test.json + 两份 plist 均真实存在 → 只改 test.json，config.json/state.json 逐字节不变、不调度重启）。
