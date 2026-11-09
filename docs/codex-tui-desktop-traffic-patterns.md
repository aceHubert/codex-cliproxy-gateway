# Codex TUI 与 Desktop 的流量建立模式差异（网关视角）

> 2026-11-06 实测调研结论。起因：会话未使用 `cliproxy/*` 模型却被转发到 CLIProxy 上游（会话 `01a1af71-09ce-7f70-96d7-968cb5af1883`）。本文记录两款 codex 客户端在连接建立时序上的差异，以及它们各自如何与网关的粘性路由、连接级桥接交互。背景任务记录见 [histories/2026-11/20261106-1625-prewarm-thread-stickiness.md](histories/2026-11/20261106-1625-prewarm-thread-stickiness.md)。

## 共同机制（两款客户端一致）

1. **全量流量进网关**：install 写入的 `openai_base_url` / `experimental_realtime_ws_base_url` / `experimental_realtime_webrtc_call_base_url` 改写的是内置 `openai` provider 本身，模型名不影响「是否进网关」，只影响网关内部选上游（`cliproxy/` 前缀 → CLIProxy，裸名 → 官方 `chatgpt.com/backend-api/codex`）。
2. **prewarm 的模型取全局默认值**：`request_kind=prewarm`、`turn_id=""` 的预热请求带完整 `thread-id`，模型用 config/picker 的默认模型，**不代表用户对该会话的模型意图**。
3. **WS 桥是连接级路由**：上游在拨号瞬间由当时的 hint/粘性表决定，之后帧盲转——`response.create` 帧内的 model 与连接上游冲突时不改写、不重拨。
4. **粘性表 `cpaThreads`**：thread-id 一旦被任何 `cliproxy/*` 请求标记（含 prewarm），后续同 thread 新拨号（含 `x-codex-parent-thread-id` 继承）强制走 CLIProxy；纯内存态，网关重启清空；只有「标记」没有「解除」路径。

## TUI（codex-tui：终端 / VS Code 扩展宿主）

- **会话创建后约 3 秒即发 prewarm，无需任何用户交互**（实证：会话 13:59:43 创建 → 13:59:46 prewarm `cliproxy/gpt-6-astra`，用户 14:04 才发首条消息）。
- 会话存活期**反复重发 prewarm**（重连、后台保活，分钟级间隔），模型始终跟当时的全局默认值。
- **首条消息可能直接骑在活着的 prewarm WS 连接上**（实证：prewarm 后 28 秒发首条消息，`model=gpt-6.1-terra` 的帧 multiplex 到 prewarm 建的 CLIProxy 桥上，被远端实际服务）。首条消息晚于连接寿命时才会新建拨号（上午 5 分钟间隔即如此）。
- **后果**：默认模型带 `cliproxy/` 前缀时存在两条错路由路径——(a) prewarm 标记线程 → 后续切官方模型的**新拨号**全被粘走（上午 26/27 实证）；(b) prewarm 连接存活期内的 turn **复用错桥**（帧级盲转）。

## Desktop（Codex Desktop / ChatGPT.app，经 app-server）

- **用户会话线程创建后静默**，prewarm 延迟到**首条消息时刻**才发（实证 16:06：guardian reviewer prewarm 16:06:02 → 标题线程 16:06:09 → `alpha/search` 16:06:14，全部跟随用户动作出现；创建会话不发消息则网关零请求）。
- **内部线程会自主 prewarm，无需用户操作**：`thread_source=mcp_extension_host` / `thread_title` / guardian 等线程用独立 thread-id 起预热，模型取全局默认值（实证：11:25:44 `mcp_extension_host` 线程以 `cliproxy/gpt-6-astra` 拨向 CLIProxy，时段无任何用户交互）。
- 内部线程的粘性标记**只落在自身 thread-id**，无 parent 关联到用户会话，不会经继承链污染用户线程。
- **后果**：只要用户不在会话里显式选 `cliproxy/*` 模型，Desktop 用户会话天然免疫启动期污染；但全局默认模型带前缀时，内部线程的后台 prewarm 会持续消耗远端 CLIProxy 配额。

## 差异速查

| 维度 | TUI | Desktop（用户会话线程） | Desktop（内部线程） |
| --- | --- | --- | --- |
| prewarm 时机 | 创建后 ~3s，无需交互 | 首条消息时刻 | 随时（无需交互） |
| prewarm 模型 | 全局默认 | 全局默认/当次选择 | 全局默认 |
| 骑 prewarm 连接发首 turn | 会（连接存活期内） | 会（同左，时机上紧贴首条消息） | 会 |
| 默认模型带前缀时的危害 | 用户线程启动即被标记 + 错桥 | 首条消息时刻被标记 + 错桥 | 仅自身线程走 CLIProxy（配额消耗） |

## 网关侧待办（截至本文定稿）

- `cliproxy/*` 默认 + 会话内切官方模型的两条错路由路径（粘性标记时序、帧级重路由）尚无根治方案；曾试验「prewarm 不落粘性表」的局部修复，因不能覆盖连接复用路径且方案需整体重设计而撤销，待立执行计划统一解决（见 [tech-debt-tracker](exec-plans/tech-debt-tracker.md)「WS 桥帧级模型/路由不一致」条目）。
- 短期规避：**默认模型保持无前缀**。此时 prewarm 桥向官方上游；官方后端不认识带前缀模型名，切 `cliproxy/*` 后首 turn 若骑错桥会**显式报错**、重发即按新 hint 建连恢复；反方向（带前缀默认 + 切官方）因 CLIProxy 接受裸模型名而**静默走错**，危害更大。

## 证据索引

- TUI 启动 prewarm：`logs/cliproxy-v1-responses-ws-01a1af71-*.log` 13:59:46（prewarm, `cliproxy/gpt-6-astra`）；同文件 27 次拨号中 26 次去 `cliproxy.acehubert.top`。
- 连接复用：`logs/cliproxy-v1-responses-ws-01a1b00a-*.log` 16:47:41 prewarm（CLIProxy）→ 16:48:09 `model=gpt-6.1-terra` 帧 ws-send 同连接、两个 `response.created` 均来自 CLIProxy。
- Desktop 首消息触发 prewarm：`logs/cliproxy-v1-responses-ws-01a1afe4-*.log` 16:06:02/16:06:09（originator `Codex Desktop`）。
- Desktop 内部线程自主 prewarm：`logs/cliproxy-v1-responses-ws-01a1aee4-0d76-*.log` 11:25:44（`thread_source=mcp_extension_host`, prewarm, `cliproxy/gpt-6-astra`）。
- 无交互零请求：16:00–16:04 创建 Desktop 会话未发消息，网关 `logs/` 无新文件、`gateway.log` 无请求。
