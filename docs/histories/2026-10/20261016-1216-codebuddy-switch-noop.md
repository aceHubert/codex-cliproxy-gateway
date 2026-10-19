## [2026-10-16 12:16] | Task: 跳过未变更的 CodeBuddy 账号切换

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> --switch 如果没有变更不应该更新并重启网关。

### 🛠 Changes Overview
**Scope:** 网关 CLI 的 `codebuddy --switch`。

**Key Actions:**
- **无变更提前返回**：选择值等于当前配置值时打印 `CodeBuddy account unchanged; nothing to save.`，跳过配置写入、state 同步、审计、模型缓存失效和服务重启。
- **缺省 Auto**：未配置账号时按 `auto` 比较，再选 Auto 不补写字段。
- **回归测试**：覆盖显式 Auto、缺省 Auto 及已锁定账号重选，检查配置、state、审计日志和模型缓存的内容与 inode 均不变。

### 🧠 Design Intent (Why)
账号选择没有变化时，写盘、清缓存和重启没有必要。比较所选配置值，保留 Auto 与锁定账号的区别：
即使 Auto 此刻命中相同账号，从锁定切换为 Auto 仍是真实的选择模式变更，继续走原有保存管线。

### ✅ Validation
- 定向回归测试：3 项通过，0 失败；使用临时实例路径和模拟登录，不访问真实 launchd 或网络。
- 严格类型检查通过。
- 本机源码命令实测重复选择当前 Auto：配置、state、模型缓存的内容、inode、修改时间均不变，网关 PID 不变，没有重启。
- 全量 `bun run check` 通过：1175 项测试，0 失败，包含构建、UI 构建、边界检查及严格类型检查。

### 📊 Change Stats
> 通过 `git diff --shortstat` 与 `git diff --numstat` 核对变更；`cli.ts` 已有其他任务的未提交修改，
> 本任务仅计无变更判断及契约注释的增量（+6/-1）。新测试用 `git diff --no-index --numstat /dev/null test/codebuddy-switch.test.ts` 统计。
> 不含本历史记录。

- **Files changed:** 2
- **Insertions:** +102
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/cli.ts`（仅本任务） | +6 | -1 |
| `test/codebuddy-switch.test.ts` | +96 | -0 |

### 📁 Files Modified
- `apps/gateway/src/cli.ts`
- `test/codebuddy-switch.test.ts`
