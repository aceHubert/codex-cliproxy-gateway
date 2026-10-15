# Agent Proxy

[![Deploy 状态](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/gateway)](https://www.npmjs.com/package/@agent-proxy/gateway)

Agent Proxy 是基于 Bun 的跨平台本地网关，为 Codex Desktop 和 Codex CLI
连接官方模型、CLIProxyAPI/new-api 上游与本机 agent 模型。
官方模型保留 Codex 的 ChatGPT 登录，第三方上游使用独立 API Key，
本机 agent 通过插件接入。


安装、配置、模型管理与故障排查见
[网关使用手册](apps/gateway/README.md)。

## 项目结构

```text
apps/
└── gateway/          CLI、网关、安装、配置、Web UI 与插件装配
    ├── src/          业务源码；src/ui/ 为 React 界面
    ├── models.json   维护者个人的模型覆盖规则源文件（经 --model-merge-json 消费）
    ├── config.schema.json  网关配置的 JSON Schema（随包发布）
    └── README.md     随 CLI 包发布的使用手册
packages/
├── models/           私有模型快照与厂商预设包，构建内联，不发布
├── plugin-api/       插件接口、主机服务、模型归属与生命周期契约
├── llm-bridge/       规范协议转换封装（@ai-sdk/* 引擎离线捕获 + 自有流式/渲染）
└── ...               插件
test/                 自动化测试
scripts/              构建、验证、版本与发布辅助脚本
docs/                 架构说明、执行计划与变更历史
```

## 开发与验证

需要 Bun 1.2+。在仓库根目录安装开发依赖：

```bash
bun install
```

常用命令：

```bash
# 从源码运行 CLI
bun run dev status

# 启动 Web UI 开发页面
bun run dev:ui

# 构建全部 workspace 包
bun run build

# 单独构建 Web UI
bun run build:ui

# 完整验证：依赖边界、构建、类型检查、测试
bun run check

# 打包并在隔离消费项目验证包与 CLI
bun run pack:check
```

## 项目文档

- [网关使用手册](apps/gateway/README.md)：安装、模型、配置、服务与排障。
- [插件契约](docs/plugin-contract.md)：模型归属、主机服务与插件生命周期。
- [执行计划规范](docs/PLANS_GUIDE.md)：分阶段任务与技术债务记录。
- [变更历史规范](docs/HISTORY_GUIDE.md)：仓库修改的记录方式。
