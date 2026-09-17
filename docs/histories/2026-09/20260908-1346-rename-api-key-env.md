## [2026-09-08 13:46] | Task: 安装密钥环境变量更名为 API_KEY

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> CLIPROXY_API_KEY 兼容成 API_KEY / 直接修改，不需要兼容

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/cli.ts、README.md）

**Key Actions:**
- **[env 更名]**: `getInstallApiKey` 的默认环境变量从 `CLIPROXY_API_KEY` 直接改为 `API_KEY`（按用户要求不做旧名回退）；`--key-env` 显式指定行为不变。
- **[文档]**: usage 增加 `(default: API_KEY)` 说明；README 两处安装示例改为 `API_KEY='…'`，并补充"从 `API_KEY` 或 `--key-env` 指定的变量读取，未设置时回退终端隐藏输入"说明。

### 🧠 Design Intent (Why)
上游类型已泛化（cliproxy / newapi），密钥环境变量名不再绑定 CLIProxy 品牌；`API_KEY` 更中性且更短，直接更名避免两套名字长期并存。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动的累计值，含同日 new-api 任务部分；本条任务的净增量约 README +4、src/cli.ts +3）。

- **Files changed:** 2
- **Insertions:** +90（累计）
- **Deletions:** -11（累计）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +43 | -9（累计） |
| `README.md` | +47 | -2（累计） |

### 📁 Files Modified
- `src/cli.ts`
- `README.md`
