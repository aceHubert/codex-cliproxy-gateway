## [2026-10-03 12:36] | Task: 修复代码审核发现的四项边界问题

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6（宿主未暴露具体型号）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 修复“审查代码变更”聊天中的审核问题。项目只读消费登录凭据，不负责刷新令牌。

### 🛠 Changes Overview
**Scope:** 网关压缩响应、Qoder 流交接与桌面凭据、Web UI 配置指引。

**Key Actions:**
- **压缩成功判定**：SSE 必须收到 Responses 成功终态或 Chat Completions 的正常停止原因；截断、失败、不完整及错误帧返回结构化 502，不生成历史替换条目。失败状态不会被后续成功帧覆盖。
- **UTF-8 字节交接**：Qoder 窥探流使用原始字节缓冲，只解码完整行；首内容帧之后的原始余量直接交给下游，保留跨块中文与 emoji。
- **缓存到期校验**：桌面缓存保存原始毫秒到期时间，命中时再次校验；同地域不同认证目录不共用缓存。过期提示重新登录，不刷新或写回凭据。
- **URL 脱敏**：手动模式静态目录指引的 `model_catalog_json.current` 统一调用 `sanitizeUrlValue`，本地路径显示和原始值匹配判断保持不变。
- **回归覆盖**：新增六项测试，包含错误流顺序、成功终态、UTF-8 内部全部切分点、缓存精确到期边界、认证目录隔离和 API 响应脱敏。

### 🧠 Design Intent (Why)
摘要完整性决定客户端是否能安全替换会话历史，因此不能把已有文本等同于推理完成。
流交接必须保留字节边界；凭据缓存只能减少解密开销，不能绕过时间有效性校验。
配置指引遵循既有 URL 脱敏规则，避免查询参数中的令牌进入 API 响应。

### 📊 Change Stats
> 当前工作区已有其他未提交改动。以下使用 `git diff --no-index --shortstat` 与
> `git diff --no-index --numstat` 比对任务开始时的文件快照与最终文件，仅统计本次
> 八个源码/测试文件的增量；不计本历史记录及构建产物。

- **Files changed:** 8
- **Insertions:** +231
- **Deletions:** -14

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/gateway.ts` | +14 | -2 |
| `src/qoder/queue.ts` | +15 | -8 |
| `src/qoder/credentials.ts` | +7 | -3 |
| `src/webui.ts` | +1 | -1 |
| `test/gateway.test.ts` | +70 | -0 |
| `test/qoder-queue.test.ts` | +30 | -0 |
| `test/qoder-credentials.test.ts` | +56 | -0 |
| `test/webui.test.ts` | +38 | -0 |

### 📁 Files Modified
- `src/gateway.ts`、`test/gateway.test.ts`
- `src/qoder/queue.ts`、`test/qoder-queue.test.ts`
- `src/qoder/credentials.ts`、`test/qoder-credentials.test.ts`
- `src/webui.ts`、`test/webui.test.ts`

### ✅ Validation
- 新增压缩与 UTF-8 回归测试在修复前复现失败，修复后通过。
- `timeout 60s bun run check`：类型检查通过，597 项测试通过、0 失败，UI 和 CLI 构建通过。
- 完整检查在允许本地端口监听的环境运行，解决沙箱内 Web UI 测试的 `EPERM` 限制。
- `git diff --check`：通过。
- 独立只读复核：四项任务增量未发现新增可行动缺陷。
