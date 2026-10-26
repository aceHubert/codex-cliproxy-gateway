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

跨协议转换会将 Codex `input[].additional_tools` 合并到顶层 `tools`，再移除信封；
原生 Responses 直通保留信封位置，仅用合并视图注册工具身份。顶层同身份声明优先，同名 namespace 合并成员，
保留 function/custom 的声明、历史和选择身份。自定义转换器可从
`@agent-proxy/llm-bridge/responses-tools` 导入同步的
`normalizeResponsesToolDeclarations(body)`，在专用工具规划前复用相同规则。
适配官方 agent 指纹的自定义转换器可导入同步的
`stripClientSystemPrompt(protocol, body)`：按客户端入口协议返回剥离全部系统级
内容（instructions/system 消息/顶层 system/systemInstruction）的新请求体，调用方
原始对象保持不变，用于把官方提示词种入上游系统槽前清空客户端基底。

## 安装

```sh
bun add @agent-proxy/llm-bridge
```

通过包入口导入所需转换函数；网关与插件由
[@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
装配运行。此包提供转换接口，不提供独立 CLI。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
