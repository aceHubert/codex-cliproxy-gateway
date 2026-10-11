# @agent-proxy/qoder

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/qoder)](https://www.npmjs.com/package/@agent-proxy/qoder)

Agent Proxy 的 Qoder 插件，支持国内版与国际版的凭据和模型目录，
组合上游传输、排队处理及请求、响应转换。
通过 `createQoderPlugin` 接入宿主服务。

## 安装

```sh
bun add @agent-proxy/qoder
```

插件由 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
显式装配，并依赖宿主注入 `HostServices`；使用前需在 Qoder 客户端完成登录。
模型预设已内联到发布产物，无需安装私有 `@agent-proxy/models` 包。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
