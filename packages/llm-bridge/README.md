# @agent-proxy/llm-bridge

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/llm-bridge)](https://www.npmjs.com/package/@agent-proxy/llm-bridge)

Agent Proxy 的规范协议转换与流式输出接口，以 `@ai-sdk/*`（Vercel AI SDK）为出站
拼装引擎：`convertRequest(from, to, body)`（from 为上游 endpoint 协议、to 为调用方
route 协议；**异步函数，返回 `Promise`**——引擎调用所致，对同步消费方是破坏性
变更）经离线捕获引擎产出的目标请求体并返回工具身份表，全程不执行网络 I/O；
`parseUpstreamEvents` 解析上游事件，`createClientResponse` 输出客户端 SSE 或完整
JSON。协议类型直接引用 `@agent-proxy/plugin-api` 的 `ClientProtocol`
（`responses`、`chat-completions`、`anthropic`、`gemini`）；工具身份表保留 custom
与 namespace 信息，供响应侧还原；被剥离的服务器内置工具以 `strippedTools`
结构化返回。

## 安装

```sh
bun add @agent-proxy/llm-bridge
```

通过包入口导入所需转换函数；网关与插件由
[@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
装配运行。此包提供转换接口，不提供独立 CLI。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
