## [2026-10-20 18:28] | Task: 帮助旗标不再对子命令生效

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> agent-proxy status -h 这个可以不要吧

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 帮助短路范围）

**Key Actions:**
- **[帮助短路收窄]**: `runCli` 的 usage 短路条件从 `!command || command === "help" || options.help` 改为 `!command || command === "help"`。带命令时 `-h`/`--help` 不再打印整页 usage，而是落入选项白名单报 `Unknown option --help for command "..."`，与拼写错误同等对待。
- **[测试同步]**: `test/cli-flags.test.ts` 的 `-h` 用例移除 `status -h`，新增子命令携带 `-h`/`--help` 被白名单拒绝的断言。

### 🧠 Design Intent (Why)
帮助输出是全局 usage，没有任何子命令专属内容；`status -h` 打印整页文本只掩盖了拼写错误，与仓库「白名单外的旗标一律报错」的既有原则相悖。收窄后全局入口（`agent-proxy`、`agent-proxy -h`、`agent-proxy help`）行为不变，`scripts/pack-check.ts` 校验的 `agent-proxy --help` 亦不受影响。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，含本系列前序任务未提交文件）。

- **Files changed:** 3
- **Insertions:** +52
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts` | +15 | -2 |
| `test/cli-flags.test.ts` | +37 | -1 |
| `apps/gateway/README.md` | +2 | -0 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`
- `test/cli-flags.test.ts`
- `apps/gateway/README.md`
