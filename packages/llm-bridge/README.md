# @agent-proxy/llm-bridge

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/llm-bridge)](https://www.npmjs.com/package/@agent-proxy/llm-bridge)

Agent Proxy 的规范协议转换与流式输出接口，以外部 `llm-bridge` 库为底座。
`convertRequest` 转换请求并返回工具身份表，`parseUpstreamEvents` 解析上游事件，
`createClientResponse` 输出客户端 SSE 或完整 JSON。
`BridgeProtocol` 使用 `responses`、`chat-completions`、`anthropic` 和 `gemini`；
工具身份表保留 custom 与 namespace 信息，供响应侧还原。

## 安装

```sh
bun add @agent-proxy/llm-bridge
```

通过包入口导入所需转换函数；网关与插件由
[@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
装配运行。此包提供转换接口，不提供独立 CLI。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
