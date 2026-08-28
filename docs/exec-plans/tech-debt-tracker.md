# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-08-18 | Realtime 上游选择 | 尚未支持通过配置将完整 Live 链路切换至 CLIProxyAPI | 第一阶段先完成本地官方单账号路径，避免提前引入未使用的配置和转发分支 | 按 [CLIProxy Realtime 转发第二阶段实施路径](../cliproxy-realtime-forwarding-plan.md) 实现全局上游选择、认证替换、Location 重写和测试 |
| 2026-08-19 | Realtime provider 门控 | `/v1/realtime/*` 周边路径（client_secrets、sessions、transcription_sessions、translations）不在 `isReservedOfficialRealtimePath` 枚举内，第三方 provider 模式下第三方 Authorization 会落到 ChatGPT backend | 早期按 Codex 实际请求路径逐条枚举；本轮 WebSocket 放行聚焦不扩 scope（已确认） | 改为前缀式门控（`/live` 与 `/realtime` 全子树）并调整 `test/gateway.test.ts` 对应断言 |
| 2026-08-19 | Responses over WebSocket | CLIProxy 侧仅实测过握手 101，帧级协议兼容性未验证；WS 帧内 model 不做前缀改写 | Codex 探测带 routing hint 可定路由，但帧内容改写风险高，先透传观察 | 真机使用中若 cliproxy 会话在 WS 建立后异常断开，收集 `cliproxy-v1-responses-*.log` 的 ws 事件定位；必要时设 `websocket: false` 回退或评估帧级 model 改写 |
| 2026-08-20 | Responses over WebSocket 路由 | WebSocket 只在握手时按 `x-codex-routing-hint` 选定一次上游，而 Codex 会跨 turn 复用同一条连接（实测存活 88 秒），期间模型可变；预热 hint 与真实帧路由不一致时，请求会先顺旧连接发出 | 显式 `--websocket` 后，split 与 CPA-only 的 CPA WebSocket 均可用：逐帧校验 `checkFrameRouting` 在 official/CLIProxy 路由失配时以 1012 关闭旧桥接，由 Codex 重新握手并按新 hint 选上游、换认证；默认仍 `websocket: false`，CPA 请求回 426 走 HTTP/SSE。同一条连接内按帧热换上游（多路复用）仍是未实现的根治方案，真机双向切换与跨路由 continuation 验证尚未完成 | 若 1012 重连在真机出现循环、丢帧或重复执行，回退 `websocket: false` 并评估一次性 session 路由提示；若要消除重连开销，再评估上游连接池与按帧分发。相关实测见 [20260820-1205 历史记录](../histories/2026-08/20260820-1205-websocket-frame-routing.md) |
| 2026-08-28 | CPA WebSocket 模型门控移除 | 网关不再按 `gpt-/codex-` 前缀预判模型能否走 ws，全部交给 CPA 按请求回退；残余风险是已在 CPA ws 上游跑过 codex 凭据模型的连接里，增量轮（`response.append`/`previous_response_id`）切到非 codex/xai provider 模型会触发 CPA 426 `upstream_http_replay_required` 断连，CLI 可能直接报错而非降级 | 真机验证（[20260828 历史记录](../histories/2026-08/)）确认纯非 gpt 会话经 ws 桥接后由 CPA 静默退回 SSE 上游端到端正常，且网关层预判无法防住该断连（只发生在已建立连接内部），保留门控只增加无谓的 426 桥接拒绝 | 使用约束：单会话内不混用"codex 凭据模型 + 非 codex provider 模型"；若真机出现该 426 报错，收集 ws 会话日志确认触发路径，再评估网关侧按帧检测增量轮换模型并提前 1012 重连 |
| YYYY-MM-DD | 示例：web-desktop/doctor 某模块 | 简要说明当前妥协点 | 为什么暂时保留这个状态 | 后续应当执行的动作 |
