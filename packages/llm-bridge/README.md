# @agent-proxy/llm-bridge

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/llm-bridge)](https://www.npmjs.com/package/@agent-proxy/llm-bridge)

Agent Proxy 对外部 `llm-bridge` 库转换接口的统一导出。
原样导出 `translateBetweenProviders`、`handleUniversalStreamRequest`、
`parseAnthropicStream` 和 `ProviderType`，供插件复用现有协议转换行为。

## 安装

```sh
bun add @agent-proxy/llm-bridge
```

通过包入口导入所需转换函数；网关与插件由
[@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
装配运行。此包提供转换接口，不提供独立 CLI。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
