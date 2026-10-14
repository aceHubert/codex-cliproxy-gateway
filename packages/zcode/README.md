# @agent-proxy/zcode

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/zcode)](https://www.npmjs.com/package/@agent-proxy/zcode)

Agent Proxy 的 ZCode 插件，组合本地配置、套餐与 API Key 模型目录，
处理 ZCode 模型路由和请求、响应转换。
通过 `createZcodePlugin` 接入宿主服务。

## 安装

```sh
bun add @agent-proxy/zcode
```

插件由 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
显式装配，并依赖宿主注入 `HostServices`；使用前需准备可用的 ZCode 配置。
模型预设已内联到发布产物，无需安装私有 `@agent-proxy/models` 包。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
