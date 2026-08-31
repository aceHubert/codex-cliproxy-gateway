## [2026-08-28 11:33] | Task: 放开 split 模式 CPA Responses WebSocket 并按路由重连

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `cliproxy/z.ai/glm-5.3-flash`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `HEAD (detached, base a7c69c02573f933e555c603a79281f09e0bb0c11)`

### 📥 User Query
> 完整执行 split 模式 Responses WebSocket 路由切换重连计划：非 CPA-only 的 split 模式
> 下允许显式启用兼容 CPA 模型的 Responses WebSocket；official/CLIProxy 路由变化时复用
> 逐帧检查，以 1012 关闭旧桥接并让 Codex 重新握手；错误帧不得进入旧上游，认证不串线，
> 默认关闭仍 426 降级 HTTP/SSE；同步配置、CLI、Schema、状态、文档和自动化测试。

### 🛠 Changes Overview
**Scope:** src/gateway、src/cli、配置契约与测试

**Key Actions:**
* `responsesWebSocketTarget()`：split 模式下按 `websocket` 配置放行 CPA WebSocket；
  网关不按模型 ID 门控，由 CPA 按请求选择 WebSocket 或 HTTP/SSE。
* `applyRoutingMode()`：split 与 CPA-only 都按显式 `--websocket` 写入配置，未传回写
  `false`；CLI 校验允许 `models --sync --websocket`，`/healthz` 与 `status` 同步语义。
* `types.ts`、JSON Schema、README、tech-debt 记录同步新语义；路由切换仍复用
  `checkFrameRouting()` 的 1012 关闭与重连路径。
* 测试覆盖 split 开关矩阵、前缀剥离、认证域、mismatch 1012、CLI 参数矩阵与模式回写。

### 🧠 Design Intent (Why)
CPA WebSocket 之前只在 CPA-only 模式放行，split 模式永远 426。最小改动是复用现有
开关、认证替换与 1012 重连路径，不引入同连接内热换上游或连接池；模型的实际传输能力
由 CPA 判断，网关只负责 official/CPA 边界。

### 📊 Change Stats
> 工作区包含本任务之前既有的未提交改动；以下为相对 base 的完整工作区 diff 统计，
> 非仅本任务增量。

**`git diff --shortstat`：** 16 files changed, 663 insertions(+), 302 deletions(-)

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +12 | -8 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -2 |
| `schemas/gateway-config.schema.json` | +5 | -1 |
| `src/cli.ts` | +91 | -92 |
| `src/gateway.ts` | +119 | -60 |
| `src/types.ts` | +4 | -4 |
| `test/app-server.test.ts` | +23 | -2 |
| `test/gateway.test.ts` | +169 | -17 |
| `test/model-catalog-dynamic.test.ts` | +130 | -51 |
| `test/realtime.test.ts` | +37 | -0 |

> 注：`src/cli.ts`、`src/gateway.ts`、`test/*` 的行数包含启动状态中同文件的既有未提交
> 改动；本任务只触碰上述文件中的 WebSocket 路由、配置语义与对应测试区域。

### 📁 Files Modified
* `src/types.ts`
* `src/gateway.ts`
* `src/cli.ts`
* `schemas/gateway-config.schema.json`
* `README.md`
* `docs/exec-plans/tech-debt-tracker.md`
* `docs/exec-plans/completed/split-websocket-route-reconnect.md`
* `test/gateway.test.ts`
* `test/realtime.test.ts`
* `test/app-server.test.ts`
* `test/model-catalog-dynamic.test.ts`
* `docs/histories/2026-08/20260828-1133-split-ws-route-reconnect.md`

### 🔁 2026-08-30 续作：按 thread 固定 CPA（旧版同 thread 标题语义）

- 首次明确的 `cliproxy/` 请求按 `thread-id` 写入进程内 CPA 粘性；HTTP、SSE、WS 握手
  与重连共用该状态。
- official 预热连接收到 `cliproxy/*` 帧时先固定 thread，再关闭旧连接；旧版本中与主
  thread 共用 ID 的无前缀 Luna 标题请求仍拨号 CPA。
- CPA 连接接受无前缀模型帧并原样转发，只对显式 `cliproxy/` 帧剥一次前缀；不再设计
  CPA → official 反向建连。
- 粘性使用 `thread-id` 而非 `session-id`，避免共享同一 session 的主线程/subagent 串线。
- 子智能体使用独立 WebSocket；若 `x-codex-parent-thread-id` 已固定 CPA，则子 `thread-id`
  单向继承 CPA 并写入同一进程内集合，后续请求无需重复依赖父头。
- 真实日志抽样中，标题生成均使用无前缀 Luna、`thread_source=system`，晚于首个 turn
  约 1.5–5 秒，且二者 `thread-id` 相同。
- 边界：若后续 Codex 版本让标题请求真正早于任何 `cliproxy/` 信号，网关没有可信字段可
  推断未来选择；OpenAI 配置参考也未提供独立标题路由设置，必须由客户端补显式信号或
  使用独立 CPA-only profile。
- 验证：`bun test test/gateway.test.ts` 通过（51 个测试）；沙箱内完整检查因 Bun 无法监听
  临时端口失败，按审批在沙箱外重跑 `bun run check` 全绿（92 个测试、类型检查和构建通过）。

### ✅ 2026-08-30 最终真机验收与归档

- 当前 Desktop 已将自动标题改为 `thread_source=thread_title` 的独立 session 根线程；
  它无前缀、无自身 pin、无 parent，按安全默认走官方。这是客户端信号边界，不是
  CPA 主线程的反向切换，已接受并记录到技术债。
- 主线程、两个子智能体及 guardian 共 7 次拨号全部走 CPA；标题线程 1 次走官方，
  全程零 `ws-route-mismatch`、零 `ws-dial-failed`，父 thread 单向继承真机成立。
- 标题路由决策发生在主线程首帧前 0.75 秒；标题上游拨号完成时间更晚，文档已修正
  此前将“路由决策”写成“拨号完成”的时间口径。
- 2026-08-28 跨路由样本确认 1012 后完整重放 30 个 input 项（包含既有工具调用上下文）、
  无顶层 `previous_response_id`、无重复执行或重连循环；认证隔离与 426 回退均有真机证据。
- `bun run check` 最终通过：94 个测试、类型检查和构建全绿；执行计划移入 `completed/`。

### 🔁 2026-08-31 续作：记录 guardian prewarm 路由竞态

- 复盘真机会话中的主线程、guardian、工作子智能体与独立标题线程路由，确认
  WS→HTTP/SSE fallback 保持 CPA；错误体中的官方域名来自 CPA 内部上游，不是网关直连。
- 首个 guardian prewarm 比父线程 CPA pin 早约 438ms 完成目标选择，因父 pin 尚不存在而
  尝试官方；握手失败且未出现 official `ws-send`，该 WS 没有推理帧发往错误上游。
- 该 guardian 没有被 mismatch 拉回或重连；后续 guardian 是不同 thread，在创建时直接
  继承已固定的父路由。共核对 12 个后续 guardian、19 条 `codex-auto-review`，全部走 CPA。
- 独立、无 parent 的 Luna `thread_title` 走官方属于既定行为，与 guardian 的 parent-pin
  并发竞态分开记录。
- README 已修正旧版“无前缀标题沿用 CPA”的描述；归档计划新增 guardian 并发时序，
  技术债追踪新增修复方向和确定性并发测试要求。本轮只改文档，不改变运行时行为。

#### 📊 本轮文档增量

> 数据来自本轮相对既有暂存基线的 `git diff --numstat`，不包含工作区其他既有改动。

- **Files changed:** 4
- **Insertions:** +79
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +1 | -1 |
| `docs/exec-plans/completed/split-websocket-route-reconnect.md` | +49 | -2 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |
| `docs/histories/2026-08/20260828-1133-split-ws-route-reconnect.md` | +28 | -0 |
