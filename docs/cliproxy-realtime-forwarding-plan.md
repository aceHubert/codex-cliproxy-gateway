# CLIProxy Realtime 转发第二阶段实施路径

> 状态：仅记录实施路径，不增加配置、不改 Schema、不实现任何 CLIProxy Live 转发。

## 目标

第二阶段允许本地网关通过一个全局配置，选择继续走第一阶段的官方 Live 转发，或将
完整 Realtime 链路交给 CLIProxyAPI。切换必须覆盖 HTTP call-create、普通 WebSocket 与
WebRTC sideband，不能只转发 `/v1/live`。

## 配置与路由

1. 在 `GatewayConfig` 增加 `realtimeUpstream: "official" | "cliproxy"`，默认
   `official`，并同步默认配置、JSON Schema、配置校验和测试；旧配置保持官方路径。
2. 配置是全局上游选择：不按模型前缀分流，也不在本地维护 `call_id → upstream` 状态。
3. `official` 继续使用第一阶段的 provider 快照和官方认证分流，不改变既有行为。
4. `cliproxy` 统一转发 `/v1/live`、`/v1/realtime/calls`、`/v1/live/{call_id}` 和
   `/v1/realtime?call_id=...` 到 `cliproxyBaseUrl`；HTTP、普通 WebSocket 与 sideband
   必须使用同一个选择结果。

## 认证与协议透明性

5. CLIProxy 路径保持原始请求体、路径、查询参数、二进制帧、关闭码和关闭原因；不执行
   ChatGPT backend 的 multipart → JSON 转换。
6. 出站前删除传入的官方 `Authorization`、`ChatGPT-Account-ID` 及其他账号态认证头，
   注入 macOS Keychain 中已保存的 CLIProxy API Key，禁止官方 OAuth/API Key 泄露给
   CLIProxy。
7. HTTP 上游为 `http/https`、WebSocket 上游为对应的 `ws/wss`；转发时保持其余路径和
   查询参数。校验或重写 HTTP `Location`，使其始终指回本地网关，且不改变 `call_id`，
   从而保证 sideband 仍经本地转发。

## 兼容性、验证与回退

8. 部署前要求 CLIProxyAPI 至少为 `v7.2.135`。媒体 relay、临时密钥、sessions、hangup
   与其他 Realtime SDK 接口不在第二阶段范围。
9. 自动化测试至少覆盖：`official` 默认兼容、切换到 `cliproxy` 后的四条入口路径、
   官方认证头移除、CLIProxy Key 注入、HTTP Location 重写、查询/二进制帧/关闭信息保持，
   以及 CLIProxy 不可用时的可诊断错误。
10. 上线步骤：先保留 `official` 默认值；配置 `cliproxy` 后仅对测试环境验证完整 call-create
    与 sideband；出错时将 `realtimeUpstream` 改回 `official` 并重启网关。OpenAI 侧已知的
    sideband `403` 与 `404 call_id_not_found` 需要单独记录，切换 CLIProxy 不应被视为其
    自动修复。

## 完成条件

第二阶段只在以上配置、类型、Schema、认证隔离、完整路由和测试均落地后才算完成；当前
文档不构成任何运行时行为变更。
