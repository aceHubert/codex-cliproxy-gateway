# CPA-only WebSocket 纯转发模式

> 2026-08-27 后续由 `cpa-only-static-catalog.md` 收敛：CPA-only 改用受管静态 `model_catalog_json`，并由 `--websocket` 显式控制传输。

## 目标

新增可选的 CPA-only 模式：模型目录只暴露 CPA 模型且保留原始模型 ID，请求不再按模型判断或添加 `cliproxy/` 前缀，HTTP 与 Responses WebSocket 统一纯转发到 CLIProxyAPI，兼容 subagents 使用原始模型配置。

## 范围

- 包含：网关配置、模型目录同步、HTTP/Responses WebSocket 路由、CLI 开关、Schema 与测试。
- 不包含：CPA 内部账号/渠道调度、跨账号 WebSocket 多路复用；这些仍由 CPA 负责。

## 背景

- 相关代码：`src/gateway.ts`、`src/catalog.ts`、`src/cli.ts`、`src/realtime.ts`、`schemas/gateway-config.schema.json`。
- 当前 split 模式按 `cliproxy/` 前缀区分官方与 CPA，Codex prewarm 可能先建立官方连接。
- CPA-only 模式只有一个上游，可消除网关层官方与 CPA 串线。

## 风险

- 官方模型将不再通过该实例访问官方上游；需要保留官方模型时继续使用 split 模式。
- 同名模型不再具备官方/CPA 双路由语义。
- CPA 仍可能把长连接绑定到某个账号；本模式不改变 CPA 内部 failover。

## 里程碑

1. 增加 `cpaOnly` 配置与 CLI 入口。
2. 目录和 HTTP/WebSocket 路由切换到纯 CPA 透传。
3. 补测试、运行检查并归档计划。

## 验证方式

- 命令：`bun run check`。
- 手工检查：`models --sync --cpa-only` 后确认目录模型无前缀；发送 subagent 请求并观察 CPA 收到原始模型名。
- 观测检查：WebSocket `ws-dial` 只出现 CPA 上游，帧内模型不被改写。

## 进度记录

- [x] 增加配置与目录模式。
- [x] 完成 HTTP/WebSocket 纯转发。
- [x] 完成测试与验证。

## 决策记录

- 2026-08-27：采用独立 `cpaOnly` 模式，不改变现有 split 模式，避免把 `--model-merge-json`（元数据覆盖）与路由职责混在一起。
