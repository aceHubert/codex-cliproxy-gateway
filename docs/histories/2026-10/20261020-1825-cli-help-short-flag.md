## [2026-10-20 18:25] | Task: 补齐 --help 的 -h 短别名

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 有 --help(-h) 吗

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 参数解析、usage 与 README）

**Key Actions:**
- **[-h 短别名]**: 确认 `--help` 与 `help` 命令原本就存在，但 `-h` 会报 `Unknown command: -h`。在 `parseArgs` 将 `-v` 短路分支扩展为 `-v`/`-h` 双别名，映射到 `version`/`help`；其余单杠写法行为不变。
- **[usage/README 同步]**: usage 顶部新增 `agent-proxy -h | --help` 一行；README 服务管理命令表补充 `-h` 说明。
- **[测试重组]**: 未提交的 `test/cli-version.test.ts` 更名为 `test/cli-flags.test.ts`，统一覆盖版本与帮助旗标——新增 `-h`/`--help`/`help`/`status -h` 输出 usage、`-h -v` 组合时版本优先、`-h` 作为选项值不触发帮助短路共 3 个用例。

### 🧠 Design Intent (Why)
上一个任务为 `--version` 增加了 `-v` 短别名后，`-h` 成为明显的对称缺口（用户输入 `-h` 得到的是未知命令报错）。复用同一短路分支保持解析逻辑单点维护；版本检查先于帮助的组合优先级与既有 runCli 顺序一致。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，含上一任务未提交文件）。

- **Files changed:** 3
- **Insertions:** +50
- **Deletions:** -2

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts` | +14 | -2 |
| `test/cli-flags.test.ts` | +37 | -0 |
| `apps/gateway/README.md` | +2 | -0 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`
- `test/cli-flags.test.ts`（由上一任务未提交的 `test/cli-version.test.ts` 更名并扩展）
- `apps/gateway/README.md`
