# @agent-proxy/opencode-zen

[![Deploy](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/opencode-zen)](https://www.npmjs.com/package/@agent-proxy/opencode-zen)

Agent Proxy 的 OpenCode Zen 插件，提供免费模型目录、会话与客户端指纹处理，
按模型端点协议完成 Chat Completions、Responses 等请求和流式响应转换。
通过 `createOpencodeZenPlugin` 接入宿主服务。

## 安装

```sh
bun add @agent-proxy/opencode-zen
```

插件由 [@agent-proxy/gateway](https://www.npmjs.com/package/@agent-proxy/gateway)
显式装配，并依赖宿主注入 `HostServices`；默认使用公共鉴权，支持自定义 API Key。
模型预设已内联到发布产物，无需安装私有 `@agent-proxy/models` 包。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
