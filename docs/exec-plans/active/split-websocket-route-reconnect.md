# Split 模式 Responses WebSocket 路由切换重连

## 目标

在非 CPA-only 的 split 模式下，允许用户显式为兼容的 `cliproxy/gpt-*` 与
`cliproxy/codex-*` 模型启用 Responses WebSocket；官方模型继续连接官方上游。
当 Codex 复用一条下游连接、后续帧需要切换 official/CLIProxy 路由时，网关不得把帧
发往旧上游，而应关闭旧的上下游连接，让 Codex 重新握手并按当前路由建立新的上游
WebSocket。默认行为仍保持安全关闭：未显式启用时，split 模式的 CPA 请求继续以 426
降级到 HTTP/SSE。

## 范围

- 包含：
  - 允许 `models --sync --websocket` 在 split 模式启用 CPA Responses WebSocket，复用现有
    `websocket` 配置字段，不新增第二个开关。
  - 更新 CLI 参数校验、配置写入、状态与健康检查、TypeScript 类型注释、JSON Schema 和
    README，使 `websocket` 表示“是否允许 CPA Responses WebSocket”；官方 WebSocket
    仍不受该开关影响。
  - 调整 `responsesWebSocketTarget()`：按 `x-codex-routing-hint` 选择 official/CLIProxy，
    对 CPA 路由使用剥除 `cliproxy/` 后的上游模型 ID 执行 `gpt-*` / `codex-*` 门控，
    并保留现有认证替换与握手头过滤。
  - 复用 `checkFrameRouting()` 与现有 `1012` 关闭流程：路由不一致的帧不得发送到旧上游，
    同时关闭上下游，由下一次握手重新执行目标选择和认证。
  - 增加 official → CPA、CPA → official 双向重连、认证隔离、模型前缀剥离、426 回退、
    CLI 配置语义及可观测性的自动化测试和真机验收。
- 不包含：
  - 在同一条下游 WebSocket 内透明替换上游连接、上游连接池、按帧多路复用或响应合流。
  - 在网关内保存完整请求/响应历史，或自行把 `previous_response_id` 转换成完整上下文。
  - CLIProxyAPI 内部账号、渠道或凭据轮换；这些连接生命周期仍由 CLIProxyAPI 负责。
  - `/v1/live`、`/v1/realtime`、WebRTC sideband 等 Realtime 专用链路。
  - 为已知不兼容的非 `gpt-*` / `codex-*` CPA 模型启用 WebSocket。

## 背景

- 相关文档：
  - `docs/exec-plans/completed/responses-websocket-forwarding.md`
  - `docs/exec-plans/completed/cpa-only-websocket-forwarding.md`
  - `docs/histories/2026-08/20260820-1205-websocket-frame-routing.md`
  - `docs/histories/2026-08/20260827-1558-ws-model-gate.md`
  - `docs/exec-plans/tech-debt-tracker.md` 中的 Responses over WebSocket 路由项
  - [OpenAI Responses WebSocket 重连与恢复](https://developers.openai.com/api/docs/guides/websocket-mode#reconnect-and-recover)
- 相关代码路径：
  - `src/gateway.ts`：`responsesWebSocketTarget()`、`bridgeUpstreamWebSocket()`、
    `startGateway()` 与健康检查。
  - `src/realtime.ts`：`RealtimeSocketData`、`checkFrameRouting()`、
    `realtimeWebSocketHandler.message()`。
  - `src/cli.ts`：`applyRoutingMode()`、`--websocket` 参数校验、`status` 输出。
  - `src/types.ts`、`schemas/gateway-config.schema.json`、`README.md`：配置契约与说明。
  - `test/gateway.test.ts`、`test/realtime.test.ts`、`test/app-server.test.ts`、
    `test/model-catalog-dynamic.test.ts`：路由、桥接、CLI 与模式切换测试。
- 已知约束：
  - Codex 会用 prewarm 握手提前建立连接，并跨 turn 复用同一条连接；握手 hint 可能属于
    预热模型，而真实文本帧可能已切换到另一条路由。
  - official 与 CLIProxy 的上游 URL、认证域和凭据不同；路由变化后不得在旧连接上替换
    `Authorization`，也不得把任一侧凭据发送给另一侧。
  - 当前代码已经能检测帧路由不一致，并以 `1012` 关闭下游、关闭旧上游；但 split 模式
    仍在网关和 CLI 两层禁止 CPA WebSocket，因此当前只会降级 HTTP/SSE。
  - `previous_response_id` 可能依赖原上游或原连接状态。官方文档说明：连接关闭后连接级
    缓存消失；无法继续时必须省略该 ID 并发送完整上下文。当前网关没有执行完整重放所需
    的历史状态。
  - 当前配置只有固定的 official 与 CLIProxy 两个上游；判断 `routeKind` 是否变化已经足够，
    不为未来的多上游场景提前新增 route-key 抽象。

## 风险

- 风险：Codex 收到 `1012` 后不重发当前帧，或新的 prewarm 握手仍携带旧 hint，造成请求
  丢失或重连循环。
- 缓解方式：把真机双向切换作为实现前置门；必须确认一次路由变化至多触发一次重连，
  且当前请求最终只执行一次。若不成立，停止放开 split CPA WebSocket，继续使用 426
  HTTP/SSE 回退，并单独评估一次性 session 路由提示；本计划不自动扩展成连接池。
- 风险：新上游无法识别旧路由生成的 `previous_response_id`，导致
  `previous_response_not_found`、tool call 断链或上下文丢失。
- 缓解方式：真机覆盖含连续对话和 tool call 的切换；验收必须看到客户端完整重放或可用的
  continuation 恢复。不能恢复时保持该功能默认关闭，并不得宣称跨路由连续性可用。
- 风险：CPA API Key、ChatGPT OAuth、`chatgpt-account-id` 或其他 API Key 泄漏到错误上游。
- 缓解方式：对两个方向分别断言实际握手头；CPA 路由必须剥 OAuth、账号 ID、`x-api-key`
  和 `x-goog-api-key` 后注入 CPA Key，官方路由不得出现 CPA Key。
- 风险：模型门控直接匹配带前缀 ID，会把 `cliproxy/gpt-*` 错误判为不兼容。
- 缓解方式：统一使用路由计算得到的上游模型 ID 做门控，并覆盖 `gpt-*`、`codex-*`、
  非兼容模型和无 hint 四类测试。
- 风险：配置语义变化导致原有 CPA-only 或默认 split 行为回归。
- 缓解方式：保持 `websocket` 默认 `false`；覆盖普通 sync、split + `--websocket`、CPA-only
  有/无 `--websocket` 和重新安装重置配置的矩阵测试。

## 里程碑

1. **真机前置验证与方案门控**
   - 临时显式启用 split CPA WebSocket，交替发送 official 与 `cliproxy/gpt-*` 请求。
   - 记录握手 hint、帧内模型、`ws-route-mismatch`、关闭码、下一次 `ws-dial` 目标和最终
     transport，确认 Codex 能完成 official → CPA → official 双向恢复。
   - 用连续对话及一次 tool call 验证 `previous_response_id` 在新路由不可用时是否会完整重放。
   - 若出现丢帧、重复执行或重连循环，停止后续放行，保留现有 HTTP/SSE 行为并更新本计划。
2. **收敛配置与 CLI 语义**
   - 允许 `models --sync --websocket` 与
     `models --sync --cpa-only --websocket`，继续拒绝缺少 `models --sync` 的用法。
   - 让 `applyRoutingMode()` 在两种模式下都按显式参数写入 `websocket`；未传参数时写回
     `false`，形成明确回滚路径。
   - 更新健康检查、`status`、类型、Schema、帮助文本和 README，避免 split 已启用但显示
     `websocket: false`。
3. **放开 split CPA WebSocket 目标选择**
   - 仅在 `route.kind === "cliproxy" && config.websocket !== true` 时返回 null；official 路由
     继续无条件允许 WebSocket。
   - 对 split 模式使用 `route.upstreamModel`，对 CPA-only 使用原始 hinted model 执行兼容
     模型门控；无 hint 时保持现有安全回退，不猜测 CPA 路由。
   - 保留上游 URL 构造、前缀剥离、CPA 认证替换和握手头过滤，不新增路由层抽象。
4. **固化重连和安全边界测试**
   - 目标选择单测：split flag 关闭/开启、两种路由、兼容/不兼容模型、无 hint、CPA-only。
   - 帧测试：同路由正常转发；跨路由帧不触达旧上游，关闭下游 `1012` 并关闭旧上游；
     CPA 帧只剥一次 `cliproxy/` 前缀。
   - 桥接测试：模拟客户端重新握手，验证新连接拨到另一上游、认证头正确，并覆盖双向切换。
   - CLI/配置测试：参数矩阵、Schema 描述、健康检查、`status` 和模式重置。
5. **交付与收尾**
   - 运行定向测试、类型检查和完整 `bun run check`。
   - 真机重复里程碑 1，确认无重连循环、无重复执行、无凭据串线，且 426 回退仍可用。
   - 更新 README、对应历史记录及 `tech-debt-tracker.md`；完成后将本计划移到
     `docs/exec-plans/completed/`。

## 验证方式

- 命令：
  - `bun test test/gateway.test.ts test/realtime.test.ts test/app-server.test.ts test/model-catalog-dynamic.test.ts`
  - `bun run typecheck`
  - `bun run check`
  - 后台测试单次最长运行 60 秒；超时应终止并定位，不得无限等待。
- 手工检查：
  - 默认 split：不传 `--websocket`，确认 CPA WebSocket 探测返回 426 并成功使用 HTTP/SSE。
  - 启用 split：运行 `models --sync --websocket --restart-codex`，交替选择官方模型与
    `cliproxy/gpt-*` 或 `cliproxy/codex-*` 模型完成多轮对话。
  - 兼容性门控：选择 `cliproxy/` 下非 `gpt-*` / `codex-*` 模型，确认不拨号 CPA WS，
    而是 426 后使用 HTTP/SSE。
  - 连续性：跨路由执行一次含 tool call 的多轮请求，确认没有
    `previous_response_not_found`、缺失 function call 或重复工具执行。
  - 回滚：运行不带 `--websocket` 的 `models --sync --restart-codex`，确认 CPA 恢复
    HTTP/SSE，官方 WebSocket 不受影响。
- 观测检查：
  - 路由变化时先出现 `ws-route-mismatch`，旧连接关闭后出现指向另一上游的 `ws-dial`；
    一次切换不得持续循环。
  - official → CPA 时，错误路由帧不出现在官方上游；新 CPA 帧中的模型已去掉
    `cliproxy/` 前缀。
  - CPA 握手日志中 OAuth、账号 ID 与其他 API Key 已遮蔽或不存在；官方握手不得包含
    CPA Key。
  - `status` 与 `/healthz` 在 split + WebSocket 模式下都显示实际启用状态。

## 验收标准

- 默认配置和未传 `--websocket` 的 split 模式行为不变：CPA 继续 HTTP/SSE。
- 显式启用后，兼容 CPA 模型与官方模型都能建立各自的 Responses WebSocket。
- official/CPA 路由切换时，错误帧不会到达旧上游；一次切换至多一次重连，当前请求不丢失、
  不重复执行。
- 跨路由 continuation 能使用有效 ID 恢复，或在 ID 无效时完整重放；连续对话和 tool call
  不断链。
- 任一方向都不存在 OAuth、账号 ID、CPA Key 或其他 API Key 串线。
- 非兼容 CPA 模型、上游拨号失败及显式关闭开关时仍可靠返回 426 并降级 HTTP/SSE。
- 配置、Schema、CLI 帮助、README、状态输出和测试保持一致，`bun run check` 通过。

## 进度记录

- [x] 确认当前握手路由、逐帧校验、`1012` 关闭流程和 split CPA WebSocket 双层门控。
- [x] 收敛首选方案：复用现有“关闭整条桥接并由客户端重连”，不实现透明热换上游。
- [ ] 完成真机前置验证并记录结果。
- [x] 完成配置与 CLI 语义调整。
- [x] 完成 split CPA WebSocket 目标选择调整。
- [x] 完成自动化测试和文档同步。
- [ ] 完成真机验收、历史记录、债务更新和计划归档。

> 2026-08-28：实现与自动化验证已完成；真机前置验证与真机双向切换验收未执行，
> 计划保持 active，未归档。

## 决策记录

- 2026-08-28：路由变化定义为 actual upstream/auth 域发生变化；同一 official 路由内或同一
  CLIProxy 路由内仅模型变化时继续复用连接。
- 2026-08-28：选择关闭下游 `1012` 与旧上游、由 Codex 新握手重建整条桥接；不在同一
  下游连接内替换 `upstream`，避免引入队列切换、事件重绑和跨上游状态迁移。
- 2026-08-28：复用现有 `websocket` 字段并保持默认 `false`；显式开关同时适用于 split 与
  CPA-only，official WebSocket 始终不受该字段控制。
- 2026-08-28：CPA WebSocket 模型门控基于去前缀后的上游模型 ID，继续只允许 `gpt-*` 与
  `codex-*`，其余模型保留 426 回退。
- 2026-08-28：把 Codex 对 `1012` 的真实重试和完整重放行为设为实现门槛；未验证前不把
  split CPA WebSocket 视为可交付能力，也不为绕过该门槛自动扩展成多路复用方案。
