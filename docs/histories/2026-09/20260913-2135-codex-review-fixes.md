# [2026-09-13 21:35] | Task: 修复 codex review 提出的 9 项问题

## 🤖 Execution Context

* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

## 📥 User Query

> 读取 codex 的 review 结论，确认问题并制定修复方案；随后「实施修改」。
> review 来源：codex session `01a09a60-2604-7bd3-94c8-6ab86774e0a4`（2026-09-13），共 9 条（3×P1、6×P2）。

## 🛠 Changes Overview

**Scope:** codex-cliproxy-gateway（src/、test/、.gitignore、docs/exec-plans/）

**Key Actions:**

- **[F1 P1]** `.gitignore` 的 `dist/` 锚定为 `/dist/` 并以 `src/ui/dist/*` + 反转规则提交 `html.generated.ts`（497KB），消除干净检出 typecheck TS2307。
- **[F2 P1]** `zcode.ts` 的 analyze_image execute 钩子对降级错误先 `redact` 再重抛，上游错误正文回显的 API key 不再进入 completed 响应的旁白。
- **[F3 P1]** `resolvePaths(env, runtimeHome?)` 新增覆盖参数；`serve --config` 临时实例的 Web UI 按配置文件所在目录派生管理上下文，不再读写/重启默认安装。
- **[F4 P2]** `startGateway` 的 `fetch()` 最前部拦截 `/ui` 命名空间，带 Upgrade 头的 UI 请求不再被 `responsesWebSocketTarget` 桥接外发。
- **[F5 P2]** `applyWebUiConfigPatch` 与 CLI `config` 命令写盘前执行 `validateZcodeConfig`，保留前缀冲突等组合在保存时即被拒绝，原配置与运行服务不动。
- **[F6 P2]** install 以 `launchTouched` + 旧 plist 留底登记恢复责任：部分失败时回写原 plist 并重启/卸载，不再留下“配置回滚但服务停止”。
- **[F7 P2]** `retainLogFile` 改 `Map` 引用计数，共享 session-id 的多连接日志在最后一个连接释放前不被裁剪。
- **[F8 P2]** ConfigPage 保存按钮允许 `failed` 态重试；`build:ui` 重建并提交生成物。
- **[F9 P2]** `readUpstreamApiKey` 仅对 ENOENT 应用 optional 豁免（用户在任务中途自行实现，含 EISDIR/EACCES 用例，原样保留）。
- **[修复]** 恢复 `gateway.test.ts` 末尾期望值的外部误改（`20260904090000` → `20260101000003`，该文件不在用例种子中）。

## 🧠 Design Intent (Why)

codex review 隔离复现了发布阻断（干净检出缺生成模块）、凭据泄漏（降级旁白携带 key）与跨实例越权写（临时实例操纵生产状态）三类问题；其余为边界加固（WS 绕过 /ui、保存后无法启动、部分安装失败、共享日志误删、失败不可重试、optional 吞故障）。修复原则：复用现有机制（`redact`、`validateZcodeConfig`、`resolvePaths`）做最小侵入改动，每项配结果导向回归测试；F1 选择提交生成物与 `.gitignore` 既有注释意图一致。详见 [执行计划](../../exec-plans/completed/codex-review-fixes.md)。

## 📊 Change Stats

> `git diff --numstat`（工作区 vs 暂存区，已排除用户并行任务 credentials-json-key-store 的文档改动）+ 本任务新增文件。

- **Files changed:** 17（14 修改 + 3 新增）
- **Insertions:** +265（不含新增生成物 `html.generated.ts` 497KB / `test/paths.test.ts` 26 行 / 执行计划 123 行）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +22 | -7 |
| `src/zcode.ts` | +16 | -9 |
| `test/webui.test.ts` | +51 | -1 |
| `test/credentials-store.test.ts` | +35 | -0 |
| `test/gateway.test.ts` | +29 | -0 |
| `test/zcode-cli.test.ts` | +27 | -0 |
| `test/zcode-gateway.test.ts` | +26 | -0 |
| `src/credentials-store.ts` | +14 | -6 |
| `src/request-log.ts` | +14 | -5 |
| `src/paths.ts` | +9 | -3 |
| `src/config-update.ts` | +4 | -0 |
| `src/gateway.ts` | +6 | -0 |
| `.gitignore` | +5 | -2 |
| `src/ui/ConfigPage.tsx` | +1 | -1 |
| `test/paths.test.ts`（新增） | +26 | -0 |
| `src/ui/dist/html.generated.ts`（新增，生成物） | — | — |
| `docs/exec-plans/completed/codex-review-fixes.md`（新增） | +123 | -0 |

## 📁 Files Modified

- `.gitignore`
- `src/cli.ts`、`src/config-update.ts`、`src/credentials-store.ts`、`src/gateway.ts`、`src/paths.ts`、`src/request-log.ts`、`src/zcode.ts`、`src/ui/ConfigPage.tsx`
- `src/ui/dist/html.generated.ts`（新增，`build:ui` 生成）
- `test/paths.test.ts`（新增）、`test/credentials-store.test.ts`、`test/gateway.test.ts`、`test/webui.test.ts`、`test/zcode-cli.test.ts`、`test/zcode-gateway.test.ts`
- `docs/exec-plans/completed/codex-review-fixes.md`（新增）、`docs/exec-plans/tech-debt-tracker.md`

## 验证

- `bun run check`：typecheck + 304 tests 全过 + 构建（1.34MB `dist/index.js`）成功。
- 干净检出模拟：`git stash create` + `git archive` 到全新目录 → `bun install` → `bun run typecheck` 无 TS2307 → `bun test` 304 全过。
- F6（launchctl 副作用）与 F8（浏览器行为）无自动化用例，已登记 `docs/exec-plans/tech-debt-tracker.md`。
