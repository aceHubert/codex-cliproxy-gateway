## [2026-10-20 18:33] | Task: 版本旗标收窄为仅根命令可用

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> agent-proxy status --version 这个也去掉，--version 只在根命令上有就可以了

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 版本短路范围）

**Key Actions:**
- **[版本短路收窄]**: `runCli` 的版本短路条件追加 `&& !command`，与上一任务的帮助旗标口径对齐——`--version`/`-v` 仅在无命令的根调用生效；子命令携带时落入选项白名单，报 `Unknown option --version for command "..."`。
- **[测试同步]**: `test/cli-flags.test.ts` 的版本用例移除 `status --version` 的正常输出断言，新增 `status -v`、`models --version` 被白名单拒绝的断言。

### 🧠 Design Intent (Why)
版本与帮助同为全局信息，不应被子命令吞掉或掩盖拼写错误；收窄后两个旗标行为对称——根命令（`agent-proxy -v`、`agent-proxy -h`）短路输出，子命令上一律按未知选项报错，延续仓库「白名单外的旗标一律报错」的原则。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，含本系列前序任务未提交文件）。

- **Files changed:** 3
- **Insertions:** +54
- **Deletions:** -4

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts` | +16 | -3 |
| `test/cli-flags.test.ts` | +39 | -2 |
| `apps/gateway/README.md` | +2 | -0 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`
- `test/cli-flags.test.ts`
- `apps/gateway/README.md`
