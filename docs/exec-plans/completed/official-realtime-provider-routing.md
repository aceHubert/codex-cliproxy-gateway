# 官方 Realtime Provider 路由

## 目标

网关启动时读取一次 Codex provider 配置，在不接触官方凭据存储的前提下，分别支持 ChatGPT 账号态和官方 API Key 的 Live 请求，并拒绝显式配置的第三方 provider。

## 范围

- 包含：provider 快照、官方认证分流、WebRTC call base 接入、HTTP/WebSocket 测试和文档。
- 不包含：CLIProxy Live 转发、多账号、媒体中继、运行中热加载 provider。

## 背景

- 相关文档：`docs/official-realtime-proxy-plan.md`
- 相关代码路径：`src/realtime.ts`、`src/gateway.ts`、`src/cli.ts`、`src/launchd.ts`
- 已知约束：官方 Token/API Key 只从当前请求头转发；第二阶段仅记录实现路径。

## 风险

- 风险：根配置之外的命名或外部 profile 携带第三方凭据并被误发给官方上游。
- 缓解方式：启动时扫描全部 profile；显式 provider 或配置解析失败时在建立上游连接前失败关闭。

## 里程碑

1. 实现启动期 provider 快照和认证分流。
2. 托管 WebRTC call base 并保留自定义 `CODEX_HOME`。
3. 补齐测试、第二阶段文档和历史记录。

## 验证方式

- 命令：`bun run check`
- 手工检查：后期修改 provider 并重启网关确认快照更新。
- 观测检查：第三方 Token 不到达任何 mock 上游。

## 进度记录

- [x] 确认范围和约束。
- [x] 完成 provider 与认证分流。
- [x] 完成配置接入和自动化测试。
- [x] 完成文档、验证与历史记录。

## 决策记录

- 2026-08-18：provider 配置只在网关启动时读取，避免每个 Live 请求访问磁盘。
- 2026-08-18：官方凭据不落地、不缓存，HTTP 每请求复制，WebSocket 每次握手复制。
- 2026-08-18：CLIProxy Live 仅形成第二阶段实施文档，本阶段不增加配置或运行逻辑。
- 2026-08-18：为避免运行期切换外部 profile 泄露第三方 Token，任一命名或外部 profile 配置 provider 时均失败关闭。
