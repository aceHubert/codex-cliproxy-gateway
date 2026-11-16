## [2026-11-09 10:48] | Task: 修复插件流式日志和 AGY 未声明工具处理

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-stream-logging-and-agy-tool-tolerance`

### 📥 User Query
> 创建一个 fix 分支，开始实施插件流式日志和 AGY 工具容错计划。

### 🛠 Changes Overview
**Scope:** CodeBuddy、Qoder、AGY 插件，回归测试与执行文档。

**Key Actions:**
- **恢复流式日志**：用完整适配器复现两家插件的宿主作用域外日志缺失。请求收尾回到所属宿主写日志，保留开关和脱敏；Responses 主动取消记录一次 499，Qoder 超时保留 504 并清理计时器。
- **容忍未声明工具**：AGY 精确匹配优先，工具名骨架唯一匹配时恢复声明身份；其余调用忽略并提示，保留有效正文和合法调用。回归验证 Responses 签名回放和四种客户端协议的流式及非流式输出。
- **隔离验证**：为 AGY 声明桥接依赖并更新锁文件，限制其仅复用工具名匹配函数。健康检查用例注入空密钥，避免访问本机 Keychain。`bun run check` 的 1340 项测试及 `bun run pack:check` 的八个公开包冒烟均通过。

### 🧠 Design Intent (Why)
*流由客户端在不同异步作用域消费，收尾回调必须使用发起请求时的宿主。AGY 在发出工具条目及签名前判断名称，只允许已声明且身份明确的工具进入客户端输出。*

### 📊 Change Stats
> 工作区与分支基线的 `git diff --shortstat`、`git diff --numstat`，加上用 `--no-index` 统计的新增计划，排除本历史记录自身。

- **Files changed:** 15
- **Insertions:** +600
- **Deletions:** -64

| File | +Added | -Removed |
| --- | ---: | ---: |
| `bun.lock` | 1 | 0 |
| `docs/exec-plans/completed/plugin-stream-logging-and-agy-tool-tolerance.md` | 153 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | 0 | 1 |
| `docs/plugin-contract.md` | 3 | 0 |
| `docs/requirements/codex-gateway-monorepo.md` | 4 | 0 |
| `packages/agy/package.json` | 1 | 0 |
| `packages/agy/src/response.ts` | 16 | 11 |
| `packages/codebuddy/src/index.ts` | 31 | 21 |
| `packages/qoder/src/index.ts` | 39 | 22 |
| `test/agy-protocol.test.ts` | 69 | 0 |
| `test/agy-response.test.ts` | 152 | 0 |
| `test/codebuddy-gateway.test.ts` | 72 | 0 |
| `test/gateway.test.ts` | 1 | 1 |
| `test/llm-bridge-boundaries.test.ts` | 19 | 6 |
| `test/qoder-gateway.test.ts` | 39 | 2 |

### 📁 Files Modified
- `packages/codebuddy/src/index.ts`
- `packages/qoder/src/index.ts`
- `packages/agy/src/response.ts`
- [已归档的执行计划](../../exec-plans/completed/plugin-stream-logging-and-agy-tool-tolerance.md)
