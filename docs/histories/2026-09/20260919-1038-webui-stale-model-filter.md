# [2026-09-19 10:38] | Task: 修复 Web UI 保存已下线模型失败

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 保存失败: Unknown model ID: gpt-6-astra
>
> web 有个逻辑错误，如果已选值，在列表中没有，保存失败，而命令 model --sync
> 会直接过滤掉没有的，所以在从上游拉取时同步排除掉没有的模型

### 🛠 Changes Overview
**Scope:** codex-cliproxy（Web UI 模型保存接口 + 回归测试）

**Key Actions:**
- **[保存语义]**: `POST /ui/api/upstream/models` 不再因 `selectedModels` 含上游已不存在的 ID 而返回 400；按最新上游目录过滤后，只保留仍存在的模型。
- **[upstream-only 边界]**: 过滤后选择为空且 `upstreamOnly=true` 时继续拒绝保存，避免写出空目录导致网关无法启动。
- **[拉取即收敛]**: `ModelPicker` 拉取成功后立即从表单移除上游已不存在的旧选择，保存按钮随之变为可提交，不再需要用户手动删除失效项。
- **[测试]**: 将未知 ID 用例改为覆盖「有效 ID + 已下线 ID + hide ID」的静默过滤，并补充 upstream-only 全部失效时拒绝、不写目录与配置，以及前端收敛函数的断言。

### 🧠 Design Intent (Why)
Web 保存提交的是表单里的完整当前选择，而 `models --sync` 对当前选择做的是与上游目录求交集。
两边语义不一致时，上游模型改名或下线会让用户在 Web 上无论如何保存都失败；对齐为“以最新上游目录为准收敛选择”，既符合 CLI 行为，也让 UI 在保存后自然清掉失效项。

### 📊 Change Stats
> 数据来自本次任务相关文件的 `git diff --numstat`（工作区增量，基线为任务开始前的未提交状态）。

- **Files changed:** 5
- **Insertions:** +56
- **Deletions:** -19

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +8 | -1 |
| `src/webui.ts` | +5 | -2 |
| `src/ui/ModelPicker.tsx` | +10 | -1 |
| `test/webui.test.ts` | +21 | -14 |
| `test/model-picker.test.ts` | +12 | -1 |

### 📁 Files Modified
- `AGENTS.md`
- `src/webui.ts`
- `src/ui/ModelPicker.tsx`
- `test/webui.test.ts`
- `test/model-picker.test.ts`

### ✅ Verification
- `bun run typecheck`：通过。
- `bun test test/model-picker.test.ts test/webui.test.ts`（沙箱外，假上游需要回环监听）：42 项全部通过。
- `bun run check`：通过（428 项测试、类型检查、UI/CLI 构建）。
