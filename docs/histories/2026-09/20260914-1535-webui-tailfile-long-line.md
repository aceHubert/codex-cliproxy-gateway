## [2026-09-14 15:35] | Task: 修复 Web UI 请求日志预览在末行超长时显示为空

### 🤖 Execution Context
* **Agent ID**: `mimo`
* **Base Model**: `mimo`
* **Runtime**: `MiMo Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/webui-tailfile-long-line`（WIP 同步自主工作区）

### 📥 User Query
> 分析一下为什么 cliproxy-v1-responses-ws-01a09e75-c906-7c73-afc9-3c52659d49c3.log 日志是空的
> （跟进：补充上修复）

### 🛠 Changes Overview
**Scope:** webui / request log preview

**Key Actions:**
- **[诊断]** 真机日志并非空文件（约 15MB / 11927 行）；Web UI 预览空是因为 `tailFile` 只读末尾 64KB，而末行约 161KB，窗口内唯一 `\n` 是文件末尾换行，`slice(firstNewline+1)` 得到空串。
- **[tailFile]** 末行超过 tail 窗口时翻倍扩窗（上限 1MB），直到拿到至少一条完整行；仍超限则退回半行而不是空文本。
- **[测试]** 新增用例：末行 160KB、文件整体 >1MB 时预览非空且含完整事件头。

### 🧠 Design Intent (Why)
* `REQUEST_LOG_TAIL_BYTES`（64KB）按「多条短行」设计；Responses-over-WebSocket 会把完整 JSON 帧写入日志，单条 `response.completed` 可达 150–780KB。
* 空预览会让人误以为日志没写；扩窗优先返回完整行，病态超长行在 1MB 硬顶后退回半行，兼顾可用性与内存。

### 📊 Change Stats
> 本修复相对主工作区 WIP 的增量（两个文件）。

- **Files changed:** 2
- **Insertions:** +54
- **Deletions:** -12

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/webui.ts` | +32 | -10 |
| `test/webui.test.ts` | +22 | -2 |

### 📁 Files Modified
- `src/webui.ts`
- `test/webui.test.ts`

### ✅ Verification
- `bun run typecheck` 通过
- `bun test test/webui.test.ts`：26 pass / 0 fail
- 真机 `cliproxy-v1-responses-ws-01a09e75-….log`：预览 `text.length=227277`，含完整 `--timestamp-- [realtime]` 行与 `response.completed`
