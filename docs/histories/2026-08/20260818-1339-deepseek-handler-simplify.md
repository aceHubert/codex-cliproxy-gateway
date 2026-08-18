## [2026-08-18 13:39] | Task: 精简 DeepSeek JS Handler

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 修改现有 DeepSeek JS Handler，移除 CLIProxy 已兼容的 reasoning 转换，保留仍有必要的兼容处理，供手动上传。

### 🛠 Changes Overview
**Scope:** CPA DeepSeek request handler

**Key Actions:**
- **移除伪造推理项**: 删除与 `on_after_auth_request` 执行阶段不匹配的 `reasoning` / `reasoning_content` 注入。
- **保留 Schema 修复**: DeepSeek 跨格式请求仍会为缺失类型的工具参数补充 `type: "object"`。
- **回归测试**: 验证推理内容不再被改写、Schema 修复仍然生效、其他模型保持原样。

### 🧠 Design Intent (Why)
CLIProxy 已负责 Responses 与 Chat 格式之间的 reasoning 转换；Handler 只保留上游尚未统一处理的最小工具 Schema 兼容逻辑。

### 📊 Change Stats
> 基于本任务相关文件相对 Git 索引的差异统计。

- **Files changed:** 3
- **Insertions:** +99
- **Deletions:** -62

| File | +Added | -Removed |
| --- | ---: | ---: |
| `scripts/deepseek_reasoning_content.js` | +2 | -62 |
| `test/deepseek-reasoning-handler.test.ts` | +57 | -0 |
| `docs/histories/2026-08/20260818-1339-deepseek-handler-simplify.md` | +40 | -0 |

### 📁 Files Modified
- `scripts/deepseek_reasoning_content.js`
- `test/deepseek-reasoning-handler.test.ts`
- `docs/histories/2026-08/20260818-1339-deepseek-handler-simplify.md`
