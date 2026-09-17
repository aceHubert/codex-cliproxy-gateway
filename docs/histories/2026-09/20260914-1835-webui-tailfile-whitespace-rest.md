## [2026-09-14 18:35] | Task: 修复 Web UI 请求日志预览在超长 SSE 行后只返回空白

### 🤖 Execution Context
* **Agent ID**: `mimo`
* **Base Model**: `mimo`
* **Runtime**: `MiMo Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 📥 User Query
> 接口返回的：`{"name":"cliproxy-v1-responses-http-20260914175952.log","text":"\n\n\n\n\n","truncated":true}`

### 🛠 Changes Overview
**Scope:** webui / request log preview

**Key Actions:**
- **[诊断]** 真机日志正文完整（含 `response.completed` 与 assistant `output_text`）；接口 `text` 只有 5 个换行，是因为 `tailFile` 末尾 64KB 窗口落在超长 `data: {response.completed}` 行中段，`firstNewline` 是行尾，`rest` 仅为 SSE/logExchange 尾部空白行。上一轮修复只处理了 `rest.length === 0`，漏掉「非空但纯空白」。
- **[tailFile]** `rest` 改为 `trim() !== ""` 才返回；纯空白则继续扩窗。顶到 1MB 上限仍无正文时，退回超长行本身（`slice(0, firstNewline)`）而不是空白行。
- **[测试]** 新增：超长 SSE 行 + 尾部空白时预览含 `response.completed`；>1MB 封顶路径预览非空白。

### 🧡 Design Intent (Why)
Web UI 预览只展示末尾窗口；Responses HTTP 日志的 `response.completed` 单行可达数百 KB，其后固定跟帧分隔空行。把空行当 tail 会让接口看起来「日志是空的」，排障时误导。扩窗优先返回有实质内容的完整行，1MB 硬顶防读爆内存。

### 📊 Change Stats
> 数据来自 `git diff --numstat -- src/webui.ts test/webui.test.ts`。

- **Files changed:** 2
- **Insertions:** +62
- **Deletions:** -5

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +18 | -5 |
| `test/webui.test.ts` | +44 | -0 |

### 📁 Files Modified
- `src/webui.ts`
- `test/webui.test.ts`

### ✅ Verification
- `bun test test/webui.test.ts`：29 pass / 0 fail
- `bun run typecheck` 通过
- 真机 `cliproxy-v1-responses-http-20260914175952.log`（811KB）：模拟修复后 tail 含 `response.completed`，不再只返回 `\n\n\n\n\n`

### 📎 Related
- 前序：[20260914-1535 Web UI tailFile 末行超长显示为空](20260914-1535-webui-tailfile-long-line.md)
