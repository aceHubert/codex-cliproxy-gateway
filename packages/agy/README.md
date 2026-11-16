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

## 模型与思考级别

模型目录按账号实际能力合并档位变体，统一识别 `low`、`medium`、`high`、
`xhigh`、`max`；请求中的 `reasoning.effort` 精确选择对应的真实上游 ID。
优先消费官方 `groupedModels` 的家族名与 `thinkingSuffix`，只还原目录实际存在的
模型；旧目录缺少分组字段时才按后缀识别。
`xhigh` 与 `max` 是独立档位，不会互相替代或降成 `high`。
没有指定或不支持的档位使用目录默认选择，不进行邻近档位回退。

显式变体 ID 保持直连；Orchestrator 等固定条目不注入 `thinkingLevel`。
没有可选思考级别的条目保留空级别列表，并省略 `default_reasoning_level`，不声明默认中档。
模型明确声明参数级别时，按该模型支持的值发送 `thinkingLevel`。
能力和默认选择随目录缓存及重载，切换模型时不会继承其他模型的档位配置。

## 原生搜索

当账号目录发布 `webSearchModelIds` 时，插件使用该专用模型调用 Google 原生搜索，
不将 Orchestrator 等当前会话模型名送到 ChatGPT 或 CLIProxy。搜索专用模型不会出现在
普通模型选择器中；能力和专用模型随目录缓存、刷新及重载。

- Responses 的 `web_search` 在服务器执行，生成 `web_search_call`，回填结果并继续原模型回答。
- Codex 独立 `/alpha/search` 在动态和纯上游两种模式下都由 AGY 插件接管。
- 支持网页查询及明确标注为网页检索的天气查询；返回摘要、来源和引用，不伪造加密数据或结构化气象结果。
- 目前不支持独立 `open/click/find/image_query/finance` 等命令，返回明确的不支持错误，不回退其他供应商。
- 每次请求最多执行四次搜索，尊重更小的 `max_uses`；禁用联网时不执行搜索。
- 域名和时效通过搜索查询表达式传递，地区、上下文和长度作为搜索提示；不是 Google 底层过滤或精确 token 预算保证。
- 同轮同时要求原生搜索和客户端工具时明确报错，避免执行未配对或重复的客户端调用。

没有搜索专用模型时不声明原生搜索能力；显式搜索请求返回可操作的刷新目录/账号支持提示。

[项目源码与文档](https://github.com/aceHubert/codex-cliproxy-gateway)
