# 官方 Realtime `/live` 代理实施方案

## 当前状态

2026-08-17 已完成配置接入、HTTP call-create 适配和 Bun 原生 WebSocket 桥接。
不受支持的 `/v1/realtime/calls/{callId}` 及其他未识别 Upgrade 仍返回 `426`，不会进入
普通 `passthroughToOfficial()`。

本方案只覆盖 Codex 内置 OpenAI provider 的本地官方 Live 转发。网关维持单账号、
无状态的凭据转发：不读取 `auth.json`，不保存或刷新 OAuth Token/API Key。

## 目标路由

实现后的主路由顺序固定为：

```text
/healthz                              本地处理
GET /v1/models                        官方目录与 CLIProxy 目录合并
/v1/responses[/compact]               按模型选择官方或 CLIProxy
POST /v1/live                         官方 Realtime call-create 适配
POST /v1/realtime/calls               官方 Realtime call-create 适配
WS /v1/live                           普通 Realtime WebSocket 桥接
WS /v1/live/{callId}                  WebRTC sideband WebSocket 桥接
WS /v1/realtime                       普通 Realtime 或 WebRTC sideband 桥接
其他 HTTP/SSE                         passthroughToOfficial()
```

`/v1/realtime/transcription_sessions` 等其他 Realtime HTTP API 不属于上述语音桥接路径，
仍按普通官方接口转发。

`/v1/realtime/calls/{callId}` 不是 opencodex 生成的 sideband 路径。该路径继续本地返回
`426`，不伪造成官方映射；未来官方接口明确定义后再放开。

## 第零阶段：Codex 配置接入

只托管 `openai_base_url` 不足以让 WebRTC call-create 和 sideband 都进入网关。
opencodex 的 sideband WebSocket 默认直连 `https://api.openai.com/v1`，WebRTC
call-create 也可由独立配置绕过 `openai_base_url`。

因此安装逻辑必须：

1. 将 `experimental_realtime_ws_base_url` 加入受管配置键。
2. 将 `experimental_realtime_webrtc_call_base_url` 加入受管配置键。
3. 安装与 gateway `restart` 时将两项都写入与 `openai_base_url` 相同的网关基址，例如：
   `http://127.0.0.1:8320/v1`。
4. 安装前备份两项原值；卸载时只恢复受管键，保留用户后续对其他配置的修改。
5. `status` 输出两项的当前值。

### Provider 快照

网关启动时读取一次 `CODEX_HOME/config.toml`，将 provider 状态缓存在进程内：

- 未配置 `model_provider`：`builtin`，允许本地官方 Live 转发；
- 根配置、任一命名 profile 或任一外部 `*.config.toml` 显式配置
  `model_provider`：`configured`；
- 配置文件无法读取或解析：`invalid`。

`configured` 请求在连接上游前返回 `400`，`invalid` 返回 `503`。两种情况均不得向
任何上游转发第三方 Token。扫描所有 profile 是有意的失败关闭：即使第三方 profile
当前未启用，也不能在网关运行期间切换后把其 Token 误判成官方 API Key。网关不将快照
重复写入自己的 `config.json`；provider 修改后通过重启网关重新加载，重启后的实际
生效情况留给手工验证。

## 第一阶段：HTTP call-create

1. 在读取通用 JSON 请求体之前识别 `POST /v1/live` 和
   `POST /v1/realtime/calls`。
2. 每次 HTTP 请求从本次请求复制 `Authorization`，不缓存凭据。无
   `Authorization` 时返回 `401`。
3. 仅在 `builtin` provider 下处理请求；当同时存在 `Authorization` 与
   `ChatGPT-Account-ID` 时，按 ChatGPT 账号态转发到 ChatGPT backend：
   - 接收 Codex 发来的 API 风格 multipart 请求；
   - 提取 `sdp` 与可选 `session`；
   - 转为 `{ "sdp": "...", "session": {...} }`，并移除 `session.id`；
   - 发送到
     `/realtime/calls?intent=quicksilver&architecture=avas`；
   - 保留客户端已有的其他查询参数，只设置缺失的 `intent` 与 `architecture`；
   - 保留 OAuth、账号、attestation、session 和 quicksilver 协议头；
   - 禁止跨域重定向；
   - 原样返回 SDP 内容、状态码、`Content-Type` 和 `Location`。
4. 仅在 `builtin` provider 下，存在 `Authorization`、没有
   `ChatGPT-Account-ID` 时，按官方 OpenAI API Key 路径转发到
   `https://api.openai.com/v1`：
   - `/live` 保留 multipart 和原始路径，不追加 AVAS 参数；
   - `/realtime/calls` 保留 multipart 和路径，并设置缺失的
     `intent=quicksilver` 与 `architecture=avas`；
   - 不做 ChatGPT backend JSON 转换。
5. `ChatGPT-Account-ID` 仅用于选择账号态路由，不是认证凭据；最终凭据有效性仍由
   官方上游验证。
6. 请求体和响应体分别设置 16 MiB 上限，上游超时设置为 120 秒。

## 第二阶段：WebSocket 桥接

1. 将 `startGateway()` 的 `Bun.serve()` 改为接收 `fetch(request, server)`，并配置
   Bun 原生 `websocket` handler。
2. 对合法的 Realtime Upgrade 调用 `server.upgrade()`，在 socket data 中保存上游地址、
   协议头和待发送帧。
3. 先完成 provider 与认证检查：`configured` 返回 `400`、`invalid` 返回 `503`、
   无 `Authorization` 返回 `401`，均在 Upgrade 前完成且不连接上游。只有
   `builtin` provider 可继续建立连接。
4. 建立上游 WebSocket 时从当前握手复制认证和协议头。连接建立后不从每个帧重读
   认证；断线重连时由新的客户端握手提供当前认证。
5. 再区分普通启动连接和 WebRTC sideband 连接：

   ```text
   普通启动，OpenAI API 上游：
   /v1/live?...      → {officialBaseUrl}/live?...
   /v1/realtime?...  → {officialBaseUrl}/realtime?...

   普通启动，ChatGPT backend 上游：
   /v1/live?...      → {officialBaseUrl}?...
   /v1/realtime?...  → {officialBaseUrl}?...

   WebRTC sideband：
   /v1/live/{callId}          → wss://api.openai.com/v1/live/{callId}
   /v1/realtime?call_id=...   → wss://api.openai.com/v1/realtime?call_id=...
   ```

   账号态普通 WebSocket 按配置的 ChatGPT backend 转发；只有
   `Authorization` 的 API Key 普通 WebSocket 固定转发到 OpenAI API 基址。
   `https://` 转为 `wss://`，`http://` 转为 `ws://`。OpenAI API 基址按本地路径追加
   `/live` 或 `/realtime`；ChatGPT backend 基址本身已是 Realtime 入口，opencodex
   直接连接该基址，不额外追加路径后缀。

   sideband 固定连官方 API 域名。opencodex 会复用 call-create 的认证材料；
   `/v1/realtime?...` 仅在存在 `call_id` 查询参数时按 sideband 处理，否则按普通启动处理。

6. 只转发明确允许的认证和协议头，不转发客户端生成的
   `Host`、`Connection`、`Upgrade`、`Sec-WebSocket-Key`。
   允许列表至少覆盖 `Authorization`、`ChatGPT-Account-ID`、`openai-alpha`、
   `x-session-id`、`session-id`、`thread-id`、attestation 和 originator。
7. 双向保持文本帧、二进制帧、关闭码和关闭原因；上游打开前使用有字节上限的短队列，
   超限立即关闭连接。
8. 任一方向错误或关闭时清理另一端，禁止断线后的孤立上游连接。

## 验收测试

- 不支持的 `/v1/realtime/calls/{callId}` 及未识别 Upgrade 返回 `426`，且不会调用
  普通 `fetch()`。
- `/v1/realtime/transcription_sessions` 等非桥接接口仍转发官方。
- 安装与 gateway `restart` 会写入 `openai_base_url`、
  `experimental_realtime_ws_base_url` 与
  `experimental_realtime_webrtc_call_base_url`；`models --sync` 不修改这三个服务地址；
  卸载只恢复受管键；`status` 能显示当前值。
- 网关启动时仅加载一次 `CODEX_HOME/config.toml` 的 provider 快照：未设置 provider
  可继续，指定 provider 返回 `400`，无法解析返回 `503`；拒绝时 Token 不得出站。
- 无 `Authorization` 返回 `401`；账号态请求走 ChatGPT backend，只有
  `Authorization` 的内置 provider 请求走 OpenAI API。连续 HTTP 请求和 WebSocket
  重连均使用各自请求/握手携带的最新认证。
- HTTP call-create 的 multipart→JSON、路径、查询参数、`session.id` 移除、OAuth 与
  `Location` 转发正确。
- OpenAI API 风格上游保留 `/live` multipart，且不为 Frameless 追加旧查询参数。
- WebSocket 上游映射覆盖普通 `/live`、普通 `/realtime`、Frameless sideband
  `/live/{callId}` 和 V1 sideband `/realtime?call_id=...`。
- sideband 请求保留 call-create 复用的认证与协议头。
- WebSocket 文本、二进制、双向关闭和上游连接失败均有集成测试。
- `/v1/responses` 的 HTTP/SSE 和现有 `426` 回退行为不受影响。
- 未命中的未来 HTTP 接口继续直接执行 `passthroughToOfficial()`。

## 实施状态

配置接入、provider 快照、HTTP 适配、认证分流、URL/头部规则、文本与二进制帧桥接、
关闭传播均应有自动化测试。真实 ChatGPT/OpenAI Realtime 上游连接，以及 provider
修改后重启生效的确认，保留给手动验收；当前实现未增加第三方依赖。
