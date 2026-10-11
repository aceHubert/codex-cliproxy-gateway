# Agent Proxy

[![Deploy 状态](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml/badge.svg?branch=main)](https://github.com/aceHubert/codex-cliproxy-gateway/actions/workflows/deploy.yml)
[![npm 版本](https://img.shields.io/npm/v/@agent-proxy/gateway)](https://www.npmjs.com/package/@agent-proxy/gateway)

Agent Proxy 是基于 Bun 的跨平台本地网关，为 Codex Desktop 和 Codex CLI
连接官方模型、CLIProxyAPI/new-api 上游与本机 agent 模型。
官方模型保留 Codex 的 ChatGPT 登录，第三方上游使用独立 API Key，
本机 agent 通过插件接入。

本仓库采用 Bun workspace 管理一个业务应用、七个公开独立包与一个私有模型包，
由 Lerna 编排构建与发布。根包 `agent-proxy-monorepo` 为私有开发工具包；
面向用户的 CLI 安装包为 `@agent-proxy/gateway`，命令名为 `agent-proxy`。

安装、配置、模型管理与故障排查见
[网关使用手册](apps/gateway/README.md)。

## 项目结构

```text
apps/
└── gateway/          CLI、网关、安装、配置、Web UI 与插件装配
    ├── src/          业务源码；src/ui/ 为 React 界面
    ├── models.json   网关内部的上游模型覆盖规则
    ├── schemas/      网关配置的 JSON Schema
    └── README.md     随 CLI 包发布的使用手册
packages/
├── models/           私有模型快照与厂商预设包，构建内联，不发布
├── plugin-api/       插件接口、主机服务、模型归属与生命周期契约
├── llm-bridge/       外部协议转换库的统一导出入口
├── zcode/            ZCode 插件
├── codebuddy/        CodeBuddy/WorkBuddy 插件
├── qoder/            Qoder 插件
├── agy/              Antigravity 插件
└── opencode-zen/     OpenCode Zen 插件
test/                 自动化测试
scripts/              构建、验证、版本与发布辅助脚本
docs/                 架构说明、执行计划与变更历史
```

`apps/gateway/models.json` 仅供网关内部使用，不向插件导出。
共享模型预设由私有 `packages/models` 包提供。

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

`dev:ui` 启动网关与界面 API 后，在 `127.0.0.1:8322` 提供 Vite 开发页面。
修改 React 界面后，正式产物需要重新运行 `bun run build:ui`。

网关 CLI 产物为 `apps/gateway/dist/index.js`，
界面产物为 `apps/gateway/dist/ui/index.html`；
独立包产物位于各自的 `dist/`，构建产物不手工编辑。
`pack:check` 验证八个包的发布内容、依赖与隔离安装后的 CLI，
不发布包，也不改写真实用户安装。

## 项目文档

- [网关使用手册](apps/gateway/README.md)：安装、模型、配置、服务与排障。
- [插件契约](docs/plugin-contract.md)：模型归属、主机服务与插件生命周期。
- [安装与目录迁移指引](docs/monorepo-migration.md)：包结构与旧安装处理。
- [执行计划规范](docs/PLANS_GUIDE.md)：分阶段任务与技术债务记录。
- [变更历史规范](docs/HISTORY_GUIDE.md)：仓库修改的记录方式。
