## [2026-11-09 09:57] | Task: 建立导入顺序检查

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/responses-thread-route-switch`

### 📥 User Query
> 处理代码中的 import 顺序，并确认是否配置了 ESLint。

### 🛠 Changes Overview
**Scope:** 根工作区工具链

**Key Actions:**
- 增加 ESLint、TypeScript 解析器和导入排序、重复导入合并插件。
- 增加导入顺序检查及自动修复命令，并接入完整检查流程。
- 通过 Yorkie 和 lint-staged 在提交前自动整理暂存文件中的导入。
- 保留类型导入及同一导入语句中类型名称的原有顺序，避免打乱人工分类。
- 自动清除导入分组之间的空行。
- 修正端点路由文件中因注释阻止自动合并的重复导入。

### 🧠 Design Intent (Why)
通过统一规则发现导入顺序问题，同时保留现有的副作用导入顺序。

### 📊 Change Stats
> 已跟踪工具链变更以 `git diff --numstat` 为依据；另有新增配置及本记录。工作区其他改动不计入。

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| `package.json` | 23 | 12 |
| `bun.lock` | 294 | 11 |
| `eslint.config.js` | 31 | 0 |
| `README.md` | 6 | 2 |

### 📁 Files Modified
- `package.json`
- `bun.lock`
- `eslint.config.js`
- `README.md`
- `packages/zcode/src/endpoint-routing.ts`
