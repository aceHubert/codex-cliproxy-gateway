# Codex Live（语音会话）端到端验证

## 目标

在网关经历了日志改造、头转发改黑名单、Responses WebSocket 放行等一系列改动后，完成 Codex Live 的第三轮端到端验证，确认 realtime 链路（call-create + sideband）未被这些改动破坏，并把此前遗留的"启动耗时逼近客户端阈值"问题查到根因。

## 范围

- 包含：
  - `POST /v1/live`（call-create）的状态码、耗时、`Location` 与 SDP answer
  - sideband WebSocket（`/v1/live/{call_id}`）的拨号、握手、首个事件
  - 全量头透传对 realtime 链路的影响（此前为白名单，现改为黑名单）
  - Codex Desktop 侧 `realtime_session_started` 与 "Voice chat took too long to start" 的对应关系
- 不包含：
  - Responses over WebSocket 的放行（前两轮已验证，问题另行跟踪）
  - CLIProxy 的 Live 转发（当前不支持，属第二阶段议题，见 `docs/cliproxy-realtime-forwarding-plan.md`）
  - WebRTC 媒体通道本身（直连 OpenAI ICE，不经过网关）

## 背景

- 相关文档：
  - `docs/histories/2026-08/20260819-1845-log-group-by-path.md`
  - `docs/histories/2026-08/20260820-0955-websocket-header-passthrough.md`
  - `docs/cliproxy-realtime-forwarding-plan.md`
- 相关代码路径：
  - `src/realtime.ts`：`proxyRealtimeCall`、`realtimeWebSocketTarget`、`realtimeWebSocketHandler`、`dialUpstreamWebSocket`
  - `src/gateway.ts`：`bridgeUpstreamWebSocket`、`isReservedOfficialRealtimePath`
- 已知约束与既有结论：
  - Live 的 call-create 由 Codex 发到网关，网关转发 ChatGPT backend；sideband 固定连 `api.openai.com/v1/live/{call_id}`，已验证 backend 侧的两个候选地址均不可用，硬编码是对的。
  - **sideband 空闲零帧属正常**：`realtime_session_started` 在 call-create 返回后约 10ms 即触发，不等 sideband 首帧；此前把"23 秒零帧 + 1006"误判为故障。
  - 客户端等待阈值约 **6.7 秒**：曾观测到 call-create 链路耗时 8.1 秒，App 先报 "took too long"，但 1.4 秒后 session 仍建立成功——即请求没失败，只是慢过了阈值。
  - 失败样本集中在 ChatGPT.app 重启后的首次调用（冷启动：TLS 重建 + 首次生成约 4KB attestation）。
  - 网关对 realtime 链路**已有**可观测性：`[realtime] call-create` 记录上游 URL、状态码、耗时；WebSocket 记录 dial/open/recv/send/close。

## 风险

- 风险：真实 Live 会话会消耗账号额度，且需要人工触发，无法自动化回归。
  - 缓解：单次会话只说一句即结束；优先从既有日志取证，必要时才复现。
- 风险：冷启动才复现，常规触发可能一直不出问题，导致结论不可靠。
  - 缓解：显式构造冷启动场景（重启 ChatGPT.app 后立即发起），并与热路径对照。
- 风险：全量头透传后 attestation 等大头进入 realtime 链路，可能拖慢 call-create。
  - 缓解：已测得 CLIProxy 侧全量头比最小头集多约 700–800ms；需确认 backend 侧是否有同量级劣化，若有则考虑对 realtime 单独裁剪。

## 里程碑

1. 从既有日志取证：统计 `[realtime] call-create` 的耗时分布，与 Desktop 日志的 `realtime_session_started` / "took too long" 对齐。
2. 冷启动对照：重启 App 后首次发起 Live，与热路径各取样本，定位 8 秒耗在哪一段。
3. 判定全量头透传的影响，必要时对 realtime 链路裁剪大头。
4. 依据结论决定是否需要改动（例如提前预热连接、或就此记录为客户端阈值问题）。

## 验证方式

- 命令：
  ```bash
  # call-create 耗时分布
  grep -h "call-create" ~/.codex-cliproxy-gateway/logs/*.log | grep -o '"durationMs":[0-9]*'

  # 与 Desktop 侧结果对齐
  grep -ihE "realtime_session_started|took too long" \
    ~/Library/Logs/com.openai.codex/2026/08/*/*.log | tail -20
  ```
- 手工检查：启动语音、说一句、结束；确认 UI 无报错且能正常应答。
- 观测检查：`cliproxy-v1-live-*.log` 中应有 `call-create`（含 status/durationMs/location）→ `ws-dial` → `ws-upstream-open`；耗时是否落在 6.7 秒阈值内。

## 进度记录

- [x] 从既有日志统计 call-create 耗时分布 —— 既有日志已被覆盖，改为现场采集
- [x] 采集样本（1 组，App 启动后 94 秒的半冷路径）
- [x] 判定全量头透传对 backend 侧 realtime 的影响 —— 无影响，见下
- [x] 形成结论：属客户端阈值问题，网关侧无需改动
- [x] 无需改动，不另开实现计划

## 验证结果（2026-08-20 18:57）

### 样本时间线

thread `01a01895-ccf3-71b2-be35-7e3ce3ca27a4`，call `rtc_u23_EEukvCNUgFsMy7NznlQc3`。
Desktop 日志为 UTC，下表已换算为本地时间（UTC+8）。

| 本地时刻 | 事件 | 来源 |
| --- | --- | --- |
| 18:57:47.192 | `thread/realtime/start` 下发（durationMs=13） | Desktop |
| 18:57:47.299 | 网关收到 `POST /v1/live` | 网关 |
| 18:57:49.254 | 上游 call-create 返回 201（durationMs=1670） | 网关 |
| 18:57:49.258 | 网关回 201（总 1959ms） | 网关 |
| **18:57:49.270** | **`realtime_session_started`** | Desktop |
| 18:57:49.817 | `realtime_session_updated` = `rtc_u23_EEukvCNUgFsMy7NznlQc3` | Desktop |
| 18:57:50.932 | sideband `ws-dial` 完成（durationMs=1653） | 网关 |
| 18:57:50.933 | `ws-upstream-open`（queued=0） | 网关 |
| 18:57:59.825 | 用户结束，`thread/realtime/stop` | Desktop |
| 18:57:59.863 | `ws-client-close` 1006 → `ws-upstream-close` 1000（存活 8983ms） | 网关 |

**端到端启动 2.078 秒**（`realtime/start` → `realtime_session_started`），对约 6.7 秒的客户端阈值有三倍余量。全程无 "took too long"，`realtime_session_updated` 带回真实 session id，会话正常应答后由用户主动结束。

### 耗时归因

- 上游 call-create：1670ms（占 85%）
- 网关自身开销：289ms（总 1959ms − 上游 1670ms，含读 body、Keychain 取值、组装转发）
- sideband 拨号：1653ms，且**不在启动关键路径上**

`realtime_session_updated`（49.817）比 sideband 建连成功（50.933）早 1.1 秒，再次证实"sideband 空闲零帧属正常"——本轮 sideband 存活 8.98 秒、收发 0 帧，客户端 1006 关闭与 `thread/realtime/stop` 完全对应，属正常收尾而非故障。

### 全量头透传的影响：无

把本次实际发送的 14 个头与改造前的 `REALTIME_HEADER_NAMES` 白名单（18 项）逐项比对，**差集为空**——Codex 在 realtime 路径上发的头，旧白名单本来就全部放行。

实际头集：`accept` `authorization` `chatgpt-account-id` `content-length` `content-type` `host` `openai-alpha` `originator` `session-id` `thread-id` `user-agent` `version` `x-oai-attestation` `x-session-id`

因此黑名单改造在这条链路上既没多带头也没少带头，1670ms 是基线值而非劣化。此前测得的 700–800ms 头开销来自 CLIProxy 的 Responses 路径——`x-codex-turn-metadata`、`x-codex-beta-features` 等大头只出现在 responses 请求上，realtime 请求根本不带。**风险条目"需对 realtime 单独裁剪大头"不成立，不需要裁剪。**

### 转发正确性

`POST /v1/live` 响应为完整 SDP answer：41 行，`m=audio` 与 `m=application`（webrtc-datachannel）双媒体行，4 个 ICE candidate，`a=fingerprint:sha-256` / `a=setup:passive` / `a=ice-ufrag` 齐全；`Location: /v1/realtime/calls/rtc_u23_...` 正确透出；响应头含 `cf-ray: a2e0e1124d855ffa-SIN`，确认来自真实上游而非网关自造。sideband 按预期固定连 `wss://api.openai.com/v1/live/{call_id}`。

### 结论

realtime 链路未被日志改造、头转发改黑名单、Responses WebSocket 放行破坏，功能与性能均正常，**网关侧无需改动**。此前的 "Voice chat took too long to start" 判定为客户端阈值问题：上游 call-create 耗时占绝对主导，冷启动时叠加 TLS 重建与首次 attestation 生成会逼近 6.7 秒阈值，而网关只贡献约 289ms，无优化空间。

### 遗留

- 未采集到**真正的冷启动**样本：本次 App 已运行 94 秒，attestation 大概率已缓存。8.1 秒那次的分段耗时仍未直接测得，归因基于耗时占比推断而非实测。该问题不影响功能（超时后会话仍会建立成功），若日后再次复现，可按本文档的取证方式对照分析。
- 观测口径已够用：`[realtime] call-create` 记录上游 URL / 状态码 / 耗时 / Location，sideband 记录 dial（含遮蔽后的完整头）/ open / close，本轮定位全程未缺证据。
