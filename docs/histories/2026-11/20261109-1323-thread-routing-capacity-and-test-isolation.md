## [2026-11-09 13:23] | Task: 线程路由容量与测试目录隔离

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6 / cliproxy/gpt-6-astra`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/fix-plugin-stream-logging-and-agy-tool-tolerance`

### 📥 User Query
> 一起制定线程路由容量治理和测试落盘污染的方案，并开始实施。

### 🛠 Changes Overview
**Scope:** 网关线程状态、HTTP/WS 日志、网关启动依赖及测试夹具。

- 线程路由限制为 65,536 个去重节点，已有关系可以更新和继承。超限请求在转发前返回 503，已建 WS 使用 1012，计量按实例限频输出。
- HTTP 和 WS 日志固定实例路径，启动只剪裁自己的日志。五家插件与共享网关测试显式固定路径，注入假凭据、模拟上游和服务替身。
- 用默认目录、继承目录与 Codex 缓存哨兵验证实际写盘边界。修复 CodeBuddy CLI 用例继承外部运行目录的遗漏。
- `bun run check` 通过，94 个文件共 1351 项测试。真实本地 WS 回归修复了关闭顺序竞态，下游先收到 1012。定向测试和补丁格式检查通过。

### 🧠 Design Intent (Why)
省略 parent 的历史子线程依赖进程内关联。保留关联并限制新增状态，使内存有界。
预热线程在无法登记父关系时保留拒绝标记，避免省略 parent 后错误回落。
已确认根及其后代保留现有归属。满额新线程的可用性与真正回收仍需后续契约支持。

### 📊 Change Stats
> 基于本轮开始时已暂存的上一任务，使用工作区 `git diff --shortstat`、`git diff --numstat`。
> 新文件按 `git diff --no-index` 计量。技术债仅计本任务两行变更，排除同时进行的其他技术债复核及本历史记录自身。

- **Files changed:** 25
- **Insertions:** +1025
- **Deletions:** -490

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/gateway-composition.ts` | 6 | 3 |
| `apps/gateway/src/gateway.ts` | 52 | 25 |
| `apps/gateway/src/realtime.ts` | 10 | 8 |
| `apps/gateway/src/thread-routing.ts` | 149 | 34 |
| `test/agy-gateway.test.ts` | 24 | 31 |
| `test/codebuddy-gateway.test.ts` | 44 | 30 |
| `test/gateway-model-reload.test.ts` | 11 | 8 |
| `test/gateway-plugin-integration.test.ts` | 3 | 2 |
| `test/gateway.test.ts` | 37 | 189 |
| `test/instance-regressions.test.ts` | 24 | 1 |
| `test/model-exclude-gateway.test.ts` | 15 | 20 |
| `test/opencode-zen-gateway.test.ts` | 20 | 15 |
| `test/qoder-gateway.test.ts` | 14 | 13 |
| `test/realtime.test.ts` | 63 | 70 |
| `test/thread-routing.test.ts` | 127 | 1 |
| `test/webui.test.ts` | 14 | 2 |
| `test/zcode-gateway.test.ts` | 29 | 33 |
| `test/zcode-signing.test.ts` | 5 | 3 |
| `test/gateway-fixture-isolation.test.ts` | 64 | 0 |
| `test/gateway-fixture-paths.ts` | 14 | 0 |
| `test/gateway-log-isolation.test.ts` | 80 | 0 |
| `test/gateway-start-fixture.ts` | 15 | 0 |
| `test/thread-routing-capacity-ws.test.ts` | 118 | 0 |
| `docs/exec-plans/completed/thread-routing-capacity-and-gateway-test-isolation.md` | 86 | 0 |
| `docs/exec-plans/tech-debt-tracker.md`（本任务） | 1 | 2 |

### 📁 Files Modified
- 关键实现见 `apps/gateway/src/thread-routing.ts`、`gateway.ts`、`realtime.ts`。
- [已归档执行计划与测量结果](../../exec-plans/completed/thread-routing-capacity-and-gateway-test-isolation.md)。
