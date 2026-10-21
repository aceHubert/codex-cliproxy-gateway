## [2026-10-20 18:16] | Task: 添加 --version(-v) 版本命令

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 添加一个 --version(-v) 的命令查看版本

### 🛠 Changes Overview
**Scope:** apps/gateway（CLI 参数解析与帮助文案）

**Key Actions:**
- **[parseArgs 支持 --version/-v]**: `-v` 作为 `--version` 的唯一短别名在取值前短路；`--version` 加入布尔旗标列表，避免被「requires a value」误伤；其余单杠写法仍按位置参数由未知命令报错兜底。
- **[runCli 版本短路]**: 在命令、帮助与路径快照之前检查 `options.version`，直接打印 `GATEWAY_CONFIG_VERSION`（与 configVersion、Web UI 版本口径一致）并返回，不触碰安装状态与环境。
- **[usage/README 同步]**: usage 顶部与服务管理命令表补充 `-v | --version` 说明。
- **[新增测试]**: `test/cli-version.test.ts` 覆盖四种旗标位置的正常输出，以及 `-v` 作为选项值时不触发版本短路。

### 🧠 Design Intent (Why)
CLI 此前没有查看自身版本的入口，用户只能查包管理器或 config。复用 `GATEWAY_CONFIG_VERSION`（`apps/gateway/package.json` 的版本，dev 与 dist 下均相对 `import.meta.dir` 解析）保证与配置/Web UI 展示的版本一致；短路放在路径快照之前，使版本查询零副作用、无需安装状态即可执行。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动）。

- **Files changed:** 3
- **Insertions:** +45
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts` | +12 | -1 |
| `test/cli-version.test.ts` | +32 | -0 |
| `apps/gateway/README.md` | +1 | -0 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`
- `test/cli-version.test.ts`
- `apps/gateway/README.md`
