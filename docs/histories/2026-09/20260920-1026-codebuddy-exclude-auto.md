## [2026-09-20 10:26] | Task: 过滤 CodeBuddy auto 档位模型

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-terra`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> codebuddy 把 auto 也排除掉

### 🛠 Changes Overview
**Scope:** codebuddy

**Key Actions:**
- **[目录过滤]**: 将裸模型 ID `auto` 加入服务端档位模型排除集合。
- **[回归测试]**: 在档位过滤测试中覆盖 `default-model` 与 `auto` 两种 Auto 形态。

### 🧠 Design Intent (Why)
*CodeBuddy 上游存在 ID 为 `auto` 的服务端档位条目；它与 `default-model` 一样由服务端解析，不适合作为具体模型进入网关目录。*

### 📊 Change Stats
> 数据来自本次任务相关工作区变更。

- **Files changed:** 2
- **Insertions:** +4
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/catalog.ts` | +2 | -2 |
| `test/codebuddy-catalog.test.ts` | +2 | -1 |

### 📁 Files Modified
- `src/codebuddy/catalog.ts`
- `test/codebuddy-catalog.test.ts`
