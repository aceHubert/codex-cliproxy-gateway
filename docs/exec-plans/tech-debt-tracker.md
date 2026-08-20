# 技术债追踪

这里记录那些暂时不阻塞当前任务、但已经值得留档的技术债。

| 日期 | 区域 | 债务描述 | 为什么会存在 | 计划中的后续动作 |
| --- | --- | --- | --- | --- |
| 2026-08-18 | Realtime 上游选择 | 尚未支持通过配置将完整 Live 链路切换至 CLIProxyAPI | 第一阶段先完成本地官方单账号路径，避免提前引入未使用的配置和转发分支 | 按 [CLIProxy Realtime 转发第二阶段实施路径](../cliproxy-realtime-forwarding-plan.md) 实现全局上游选择、认证替换、Location 重写和测试 |
| 2026-08-18 | 官方模型缓存 | `models-cache.json` 只保留最近一次官方响应，未按账号和 `client_version` 分片 | 当前 gateway 面向本机单一主要 Codex runtime，先使用一份 last-good 降低复杂度 | 需要并行使用多个 ChatGPT 工作区或 Codex 版本时，改为按账号与客户端版本分文件缓存 |
| 2026-08-19 | Realtime provider 门控 | `/v1/realtime/*` 周边路径（client_secrets、sessions、transcription_sessions、translations）不在 `isReservedOfficialRealtimePath` 枚举内，第三方 provider 模式下第三方 Authorization 会落到 ChatGPT backend | 早期按 Codex 实际请求路径逐条枚举；本轮 WebSocket 放行聚焦不扩 scope（已确认） | 改为前缀式门控（`/live` 与 `/realtime` 全子树）并调整 `test/gateway.test.ts` 对应断言 |
| 2026-08-19 | Responses over WebSocket | CLIProxy 侧仅实测过握手 101，帧级协议兼容性未验证；WS 帧内 model 不做前缀改写 | Codex 探测带 routing hint 可定路由，但帧内容改写风险高，先透传观察 | 真机使用中若 cliproxy 会话在 WS 建立后异常断开，收集 `cliproxy-v1-responses-*.log` 的 ws 事件定位；必要时设 `websocket: false` 回退或评估帧级 model 改写 |
| 2026-08-20 | Responses over WebSocket 路由 | WebSocket 只在握手时按 `x-codex-routing-hint` 选定一次上游，而 Codex 会跨 turn 复用同一条连接（实测存活 88 秒），期间模型可变，导致 `cliproxy/*` 请求顺着通往 ChatGPT backend 的连接发出、被回 `The 'cliproxy/gpt-5.6-luna' model is not supported`。**根因在预热阶段**：Codex 以 `request_kind: prewarm` 抢先建连，预热用的 hint 是无前缀模型（如 `gpt-5.6-luna`），真实请求却可能是 `cliproxy/` 前缀，连接自建立起就绑错了上游 | 当前用两道防线兜底而非根治：cliproxy 默认不放行 WebSocket（`websocket: false`，回 426 走 HTTP，实测 42ms 降级），外加逐帧校验 `checkFrameRouting` 在模型与连接路由失配时以 1012 断开重连。根治需要按帧动态选上游（一条下游连接对应多条上游连接的多路复用），工作量与生命周期管理成本高，暂不投入 | 若后续要让 `cliproxy/*` 真正用上 WebSocket：实现上游连接池并按帧 `model` 分发、合并响应回下游；同时解决 CLIProxy 拨号偏慢（实测基线 1.5–3s，全量头透传再增约 700–800ms，5s 超时余量小）。相关实测见 [20260820-1205 历史记录](../histories/2026-08/20260820-1205-websocket-frame-routing.md) |
| YYYY-MM-DD | 示例：web-desktop/doctor 某模块 | 简要说明当前妥协点 | 为什么暂时保留这个状态 | 后续应当执行的动作 |
