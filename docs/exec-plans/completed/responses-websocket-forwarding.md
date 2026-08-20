# Responses over WebSocket 放行 + Upgrade 时序修复

## 目标

按 `x-codex-routing-hint` 路由放行 Codex 的 Responses over WebSocket 试探（官方 + CLIProxy 两条路由），拨号失败时回退现有 426 语义；同时把 realtime sideband 桥接改为"先连通上游、成功后才 upgrade 下游"，修掉上游错误退化为静默断开的问题。新增 `websocket` 配置开关（默认 `true`）。

## 范围

- 包含：`dialUpstreamWebSocket` 共享拨号函数；sideband 与 responses-WS 的 upstream-first 时序；`startGateway.fetch` 中的 responses-WS 拦截（hint 路由 + cliproxy 认证改写）；`websocket` 开关 + Schema 同步；单测与 e2e。
- 不包含：`/v1/realtime/*` 周边路径的 provider 门控缺口（继续挂账）；WS 帧内 model 改写（CLIProxy 帧兼容性作为观察项）；Responses-WS 延迟路由（hint 已覆盖，无需缓冲首帧）。

## 背景

- 相关文档：`docs/official-realtime-proxy-plan.md`、`docs/cliproxy-realtime-forwarding-plan.md`
- 相关代码路径：`src/gateway.ts`（426 分支 :483、`startGateway.fetch` :677）、`src/realtime.ts`（`realtimeWebSocketHandler.open` :371 拨号）、`schemas/gateway-config.schema.json`
- 已知约束：
  - Bun [oven-sh/bun#8986](https://github.com/oven-sh/bun/issues/8986)（await 后 `server.upgrade` 破坏握手）仅影响带子协议请求且已修复（PR #11707），项目要求 bun ≥ 1.2.0；Codex 探测不带 `Sec-WebSocket-Protocol`。以 Step 0 e2e 先验证。
  - 日志 wrapper（gateway.ts:632）对 `response.clone()` 无 undefined 保护——WS 拦截必须全部在 `startGateway.fetch` 完成，不经过 wrapper。
  - CLIProxy responses-WS 仅实测握手 101，帧级协议未验证——`websocket: false` 可一键回退。

## 风险

- 风险：本机 Bun 运行时 await-upgrade 行为异常。
- 缓解：Step 0 spike 先验证；若失败退回 client-first + 拨号失败立即 1011 关闭并记日志。
- 风险：CLIProxy 帧级不兼容导致会话中段断开（Codex 已握手成功，无法再降级）。
- 缓解：配置开关回退；tech-debt 挂账观察。

## 里程碑

1. Step 0 spike 验证 Bun 时序前提。
2. Step 1-4 实现：共享拨号 → sideband upstream-first → responses-WS 放行 → 配置开关。
3. Step 5-6 验证：单测 + e2e + `bun run check` + 真机手工验收。

## 验证方式

- 命令：`bun run check`（typecheck + 全部测试 + build）。
- 手工检查：`codex-cliproxy restart` 后发普通消息 / cliproxy 模型消息 / live 语音各一次。
- 观测检查：`bun scripts/log-check.ts`——`GET /v1/responses` 不再 426，出现 `ws-dial`（含实际的上游 URL 与耗时）及后续 ws 事件；live 正常出声；错误摘要无噪音。

## 进度记录

- [x] Step 0：e2e spike 验证 await 后 server.upgrade（`server.upgrade completes after awaiting inside the fetch handler`）。
- [x] Step 1：抽出 `dialUpstreamWebSocket`（5s 握手超时，settle 后清理回调）。
- [x] Step 2：sideband 桥接改 upstream-first（`bridgeUpstreamWebSocket` 共享；拨号失败 502 + 错误摘要）。
- [x] Step 3：responses-WS 放行（`responsesWebSocketTarget` 纯函数 + startGateway.fetch 拦截；拨号失败 426）。
- [x] Step 4：`websocket` 开关 + Schema + 迁移测试（preflight 断言 + schema 布尔校验）。
- [x] Step 5：单测 + e2e 补齐（新增 6 个测试：目标构建单测、open 队列/防御单测、转发 e2e、426 回退 e2e、sideband 502 e2e）。
- [x] `bun run check` 全绿（80 测试 + typecheck + build）。
- [ ] 真机手工验收通过。

## 决策记录

- 2026-08-19：放行范围取"两条路由都放行"（hint 齐备、两上游握手均实测 101；CLIProxy 帧级失败可开关回退）。
- 2026-08-19：配置字段命名从 `responsesWebSocketProxy` 简化为 `websocket`（用户指定）。
- 2026-08-19：拨号失败返回 426（marker `websocket-upstream-unavailable`）而非 502——保持"协商失败→Codex 降级 SSE"语义且不进错误摘要；sideband 场景拨号失败返回 502（真实故障，进错误日志）。
- 2026-08-19：`/v1/realtime/*` 门控缺口本轮不修，继续挂账（用户确认）。
