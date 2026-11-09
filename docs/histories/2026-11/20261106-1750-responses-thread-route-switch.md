## [2026-11-06 17:50] | Task: 实现主会话与 side 双向切换及子线程路由继承

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `cliproxy/gpt-6-astra`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/responses-thread-route-switch`

### 📥 User Query
> 创建分支实施已确认计划：主线程与可独立选模型的 side 支持官方/CLIProxy 双向切换，
> subagent、guardian 跟随所属主会话。独立标题不在本次范围内。

### 🛠 Changes Overview
**Scope:** `apps/gateway`、路由与插件集成测试、执行计划。

- **路由状态**：新增 `ThreadRoutingState`，保存可更新根路由和直接父关系；子孙动态
  跟随，省略 parent 后关系仍有效。fork 来源不建立路由继承。
- **双向 WS**：按最终上游检查真实请求帧，冲突帧不发送，1012 关闭并要求客户端重连。
  关闭标志阻止异步排队帧再次发送；拨号完成后重新检查路由，避免异步竞态。
- **HTTP 一致性**：可解析正文模型优先于 hint，预热不覆盖已知路由；握手只初始化
  未知根，清除与当前上游冲突的旧 hint。父路由未就绪/父链无效返回可重试503。
- **边界**：图片继承触发 turn 的历史上游；保持认证隔离、upstream-only、插件及
  Realtime 边界。已有测试参数迁移到新状态类型。
- **说明**：手册新增切换语义；执行计划和技术债保留真实客户端验收事项。

### 🧠 Design Intent (Why)

单向 CPA 集合把初始预热模型永久固定为上游，同时将子线程继承复制成独立绑定。
仅增加裸模型断连会误切 subagent；仅解除主线程标记又不能更新已有子线程。
因此将独立选模型的会话与继承线程分开建模，在每个新请求上读取最终路由。
已经执行的请求不主动取消；后续请求才跟随切换。

### 📊 Change Stats
> 本次代码、测试和使用手册：`git diff --shortstat` / `git diff --numstat` 的17个已跟踪
> 文件，加 `git diff --no-index --numstat /dev/null <file>` 的2个新源码/测试文件。
> 不计本记录、执行计划、技术债及用户已有调研文档，避免把既有工作算入本次实现。

- **Files changed:** 19
- **Insertions:** +623
- **Deletions:** -111

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/README.md` | 18 | 0 |
| `apps/gateway/src/gateway-composition.ts` | 3 | 2 |
| `apps/gateway/src/gateway.ts` | 80 | 50 |
| `apps/gateway/src/realtime.ts` | 41 | 14 |
| `apps/gateway/src/thread-routing.ts` | 65 | 0 |
| `test/agy-gateway.test.ts` | 2 | 1 |
| `test/codebuddy-gateway.test.ts` | 4 | 3 |
| `test/default-agent-readiness.test.ts` | 3 | 2 |
| `test/gateway-model-reload.test.ts` | 6 | 5 |
| `test/gateway-plugin-integration.test.ts` | 3 | 2 |
| `test/gateway.test.ts` | 19 | 15 |
| `test/model-catalog-dynamic.test.ts` | 3 | 2 |
| `test/model-exclude-gateway.test.ts` | 4 | 3 |
| `test/opencode-zen-gateway.test.ts` | 2 | 1 |
| `test/qoder-gateway.test.ts` | 2 | 1 |
| `test/realtime.test.ts` | 187 | 7 |
| `test/thread-routing.test.ts` | 176 | 0 |
| `test/zcode-gateway.test.ts` | 3 | 2 |
| `test/zcode-signing.test.ts` | 2 | 1 |

### 📁 Files Modified

文件见上表；另更新 `docs/exec-plans/active/responses-thread-tree-route-switch.md`
和 `docs/exec-plans/tech-debt-tracker.md`。

### ✅ Verification

- `bun run check`：构建、边界及类型检查通过，1326 tests / 0 fail。
- 定向 gateway/realtime/thread-routing：154 pass；后补全新根无 hint 握手回归后，
  realtime 定向40项通过。测试通过仓库60秒超时编排执行。
- 真实本地双上游 WS：根双向切换、动态子线程、旧 hint、无子ID有parent、
  无hint新根握手、认证隔离、冲突帧零发送与显式重放均通过；不请求真实推理上游。
- `git diff --check` 通过。最初沙箱内端口权限失败，提升测试运行权限后回归通过。
- 未提交。17:53 按用户要求重启本机 launchd 网关，直接加载当前工作区源码，
  PID 从98508变为68975，健康检查 `ok=true`、`upstreamOnly=false`。
  启动后观察到一次父会话路由未就绪503，需继续观察客户端恢复。
- 测试客户端主动执行重连，当前 TUI/Desktop 的自动重试、完整上下文恢复以及
  guardian 503 重试仍需真机验收，计划暂不归档。

### TUI 真机补验（2026-11-06 17:56）

用户提供的会话日志显示：17:55:29 CLIProxy预热；17:56:12路由失配并1012关闭；
17:56:13同线程自动重连官方，发送 `gpt-6.1-terra`，首请求包含8个input项且不携带
旧响应ID。之后两次工具结果请求使用各自前一次官方响应ID，三个响应均completed，
最终返回message。旧CLIProxy桥未收到官方模型推理帧，该样本没有重连循环或错误事件。
当前TUI反向切换与工具续接得到真机确认；其余方向、Desktop/side、子线程仍待验收。

### 场景1补验（2026-11-06 18:09）

同一会话从官方切到 `cliproxy/gpt-6.1-terra`：18:08:58 一次1012断开官方桥，
18:08:59 自动重连CLIProxy并重放19个input项，不携带旧响应ID；首响应和随后工具
结果续接均completed，最终返回message。官方旧连接未收到切换请求，无重连循环。
CLI官方 → CLIProxy场景通过，其他验收项继续保留。
