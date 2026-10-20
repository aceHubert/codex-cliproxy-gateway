# @agent-proxy/codebuddy

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/codebuddy)](https://www.npmjs.com/package/@agent-proxy/codebuddy)

Agent Proxy 的 CodeBuddy / WorkBuddy 插件，读取本地已有凭据，
拉取各产品模型目录并处理模型路由和请求、响应转换。
通过 `createCodebuddyPlugin` 接入宿主服务。

## 安装

```sh
bun add @agent-proxy/codebuddy
```

插件由 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
显式装配，并依赖宿主注入 `HostServices`；使用前需在对应客户端完成登录。
模型预设已内联到发布产物，无需安装私有 `@agent-proxy/models` 包。

账号选择为 `auto` 时，插件依据本地 `.info` 登录凭据分别拉取 CN 和国际版目录；
两地都有可用登录时，`codebuddy-cn/*` 与 `codebuddy-intl/*` 同时展示和参与模型同步。
锁定账号时只展示该账号当前地域。每个产品的缓存文件内部按 profile 独立保存目录，
单侧拉取失败会回退该侧缓存，不影响另一侧；客户端模型推送同样保留两个地域的模型 ID。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
