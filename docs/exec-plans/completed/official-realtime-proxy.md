# 官方 Realtime 代理实现

## 目标

让 Codex 官方 Realtime call-create、普通 WebSocket 和 WebRTC sideband 全部经由
本地 gateway，并保持认证、协议头、帧类型和关闭语义。

## 范围

- 包含：Realtime 配置托管、HTTP 适配、WS URL 映射、双向桥接和资源清理。
- 不包含：CLIProxy Realtime、真实官方上游验收、额外依赖。

## 背景

- 相关文档：`docs/official-realtime-proxy-plan.md`
- 相关代码路径：`src/realtime.ts`、`src/gateway.ts`、`src/cli.ts`
- 已知约束：sideband 必须配置 `experimental_realtime_ws_base_url` 才会进入网关。

## 风险

- 风险：错误路径映射、OAuth/attestation 丢失、socket 泄漏、握手期间无界排队。
- 缓解方式：对照 Codex 源码、头部允许列表、双向关闭、1 MiB 握手队列上限。

## 里程碑

1. 完成 Codex 配置接入和恢复。
2. 完成 call-create 两种上游形态与 WebSocket 桥接。
3. 完成集成测试、回归和文档。

## 验证方式

- 命令：`bun run check`
- 手工检查：由用户后续连接真实 ChatGPT/OpenAI Realtime 上游。
- 观测检查：本地 Bun 上游验证文本、二进制、认证头和关闭传播。

## 进度记录

- [x] 托管并恢复 `experimental_realtime_ws_base_url`。
- [x] 实现 multipart→backend JSON、raw SDP 和 API 原样转发。
- [x] 实现普通 WS 与两类 sideband 映射及双向桥接。
- [x] 49 项测试、类型检查和构建通过。
- [ ] 真实官方 Realtime 由用户手动验收。

## 决策记录

- 2026-08-17：ChatGPT backend 普通 WS 直接连接 backend 基址，不追加路径。
- 2026-08-17：sideband 固定映射 `api.openai.com/v1`，并复用传入认证材料。
- 2026-08-17：使用 Bun 原生 WebSocket，不增加 `ws` 等第三方依赖。
