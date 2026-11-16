# @agent-proxy/plugin-api

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/plugin-api)](https://www.npmjs.com/package/@agent-proxy/plugin-api)

Agent Proxy 网关与插件共享的 TypeScript 契约和运行基础库。
提供 `GatewayPlugin`、`HostServices`、请求上下文与模型目录类型，
以及 `PluginRegistry` 的模型归属、请求分派和生命周期调度。

## 安装

```sh
bun add @agent-proxy/plugin-api
```

编写插件时，由宿主注入 `HostServices`，提供配置、网络、目录及日志服务。
在 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
中显式装配插件；使用网关 CLI 请安装网关包。

插件可通过可选 `handleSearch(SearchRequestContext)` 接管 Codex 的独立 `/alpha/search`。
搜索与模型生成采用独立上下文，注册表按模型归属分发；匹配插件未实现该方法时返回
明确的 501，不回退默认模型上游。宿主在插件边界移除客户端认证信息，插件使用自己的
凭据执行搜索，并返回客户端搜索协议需要的结果。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
