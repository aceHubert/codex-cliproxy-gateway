# [2026-09-18 23:55] | Task: `--select` 支持 glob 通配并允许零命中

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> --select 有没支持匹配，例如 gpt-*
>
> 没有命中时返回空

### 🛠 Changes Overview
**Scope:** codex-cliproxy（模型选择解析 + CLI/README 文案 + 测试）

**Key Actions:**
- **[models]**: 新增 `globToRegExp` 轻量通配转换，`*` 匹配任意字符（含空串），`?` 匹配单个字符，其余字符按字面量转义。
- **[models]**: `parseModelSelection` 在编号、区间、精确 ID 之外支持 glob 选择器；含通配符且零命中时返回空集，精确 ID 未命中仍报 `Unknown model ID`。
- **[cli/README]**: `--select` 帮助文案由“exact IDs”改为“IDs/globs”，README 补充通配符语义与 `gpt-*` 示例。
- **[测试]**: `gateway.test.ts` 扩展模型选择用例，覆盖 `*`、`?`、混合精确 ID、零命中返回空以及精确 ID 未命中仍报错。

### 🧠 Design Intent (Why)
- **不引入新依赖**：模型 ID 的匹配只需要 `*` 与 `?`，项目内没有现成 glob 依赖，自实现 3 行转换比引入 picomatch/minimatch 更符合“避免仅服务单一调用点的抽象/依赖”。
- **零命中是空集而非错误**：通配符本就是“可能命中 0 个”的声明式筛选，报错会强迫用户预知上游目录；而精确 ID 未命中通常是拼写错误，保留报错。
- **保持既有优先级**：编号与数字区间先于 glob 判断，避免 `1-2` 被当成模式；匹配结果仍按上游目录顺序返回，保证选择顺序稳定。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`（工作区增量，基线为任务开始前的未提交状态）。

- **Files changed:** 4
- **Insertions:** +29
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/models.ts` | +19 | -0 |
| `src/cli.ts` | +2 | -2 |
| `test/gateway.test.ts` | +6 | -1 |
| `README.md` | +2 | -0 |

### 📁 Files Modified
- `src/models.ts`
- `src/cli.ts`
- `test/gateway.test.ts`
- `README.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/gateway.test.ts` 通过：84 项 0 失败。
- `bun test` 全量通过（沙箱外）：427 项 0 失败。
- 手工验证：`gpt-*` 命中 `gpt-5.5`、`gpt-5.6-luna`、`gpt-`，不命中 `xgpt-1`；无任何命中时返回 `[]`。
