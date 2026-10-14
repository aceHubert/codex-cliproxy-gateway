# @agent-proxy/agy

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/agy)](https://www.npmjs.com/package/@agent-proxy/agy)

Agent Proxy 的 Antigravity 插件，只读消费已有登录凭据，
获取动态模型目录并将客户端请求、响应与上游协议双向转换。
通过 `createAgyPlugin` 接入宿主服务；凭据过期时需在原客户端重新登录。

## 安装

```sh
bun add @agent-proxy/agy
```

插件由 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
显式装配，并依赖宿主注入 `HostServices`。
模型预设已内联到发布产物，无需安装私有 `@agent-proxy/models` 包。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
