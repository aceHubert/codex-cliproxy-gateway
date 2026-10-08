## [2026-10-02 15:55] | Task: 修复 web 命令在 UI 已运行时的报错行为

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 🛥 User Query
> `bun run dev web` 在 Web UI 已于 8321 端口运行时报错 "Web UI is already running on port 8321; stop it first"。这个逻辑不对：服务是否已启动只是前置条件，如果已启动就应该直接打开浏览器，而不是报错。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（CLI `web` 命令）

**Key Actions:**
- **[webCommand 行为调整]**: 前台启动路径探测到 UI 服务已在运行（`isWebUiRunning` 返回 true，即 `/ui` 可正常响应）时，不再抛出「stop it first」错误，改为打印 `Web UI is already running.` 后直接走既有的带 ui-token 打开浏览器路径，幂等地把面板带到用户面前。
- **[测试]**: `test/webui.test.ts` 新增结果导向测试：用一对相邻空闲端口模拟运行中的网关与 UI 服务，以委托式 `mock.module("node:child_process")` 记录 `/usr/bin/open` 调用（避免测试真弹浏览器，其余子进程调用转发真实实现），断言 `web` 命令成功返回且只打开带 token 的 UI 地址。测试带 `skip: process.platform !== "darwin"` 守卫，与仓库既有做法一致。

### 🧠 Design Intent (Why)
`web` 的默认前台路径此前把「端口已被后台服务占用」一律视为错误，要求用户先 `--stop` 再重跑。但用户运行 `web` 的意图是「看到面板」：当已运行的实例就是可用的 UI（探测 `/ui` 返回 ok 才算运行中），报错只是把一步操作变成三步。新行为与 `--daemon` 路径的既有语义（已运行则复用、不重复拉起）对齐：启动只是手段，打开浏览器才是目的。真正的端口冲突（非本 UI 的进程占用、探测不 ok）仍会落入 `runWebUiForeground`，由 `Bun.serve` 报端口占用错误，不受影响。

### 📊 Change Stats
> 数据来自本次任务两个 hunk 的 `git diff`（`src/cli.ts` 工作区总数 +254/-63 还包含此前进行中的 manual-codex-config 任务改动，未计入本表）。

- **Files changed:** 2
- **Insertions:** +100
- **Deletions:** -11

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +9 | -10 |
| `test/webui.test.ts` | +91 | -1 |

### 📁 Files Modified
- `src/cli.ts`
- `test/webui.test.ts`
