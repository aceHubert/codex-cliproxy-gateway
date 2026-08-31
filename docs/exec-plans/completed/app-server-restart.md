# Codex app-server 安全停止

> **历史决策（2026-08-30）**：参数名曾统一为 `--codex-restart`，并从
> `models --sync` 扩展到所有会操作受管 `~/.codex/config.toml` 的命令：
> `install`、`uninstall`、`restart` 与 `models --sync`。下文保留首次实现时的
> 历史范围。
>
> **恢复（2026-08-31）**：上述更名已撤销，当前参数名恢复为 `--restart-codex`；
> 下文的操作提示与示例均使用当前名称。

## 目标

在模型目录同步完成后，仅在用户显式同意时安全停止当前用户的旧 Codex
app-server，使后续由 Codex App 拉起的进程重新读取磁盘目录。

## 范围

- 包含：跨平台进程枚举、严格匹配、PID 身份复核、停止结果分类和 CLI 接入。
- 不包含：主动启动 app-server、保证 Codex App 自愈、Dashboard 接入。

## 背景

- 相关文档：`docs/codex-app-server-restart-policy.md`
- 相关代码路径：`src/app-server.ts`、`src/cli.ts`
- 已知约束：Unix 只发 SIGTERM；Windows 优先使用系统 taskkill；任何身份缺失都不得发送信号。

## 风险

- 风险：宽泛匹配或 PID 复用导致误杀。
- 缓解方式：限定可执行文件和首个子命令，发送信号前重新枚举并比较所有身份字段。

## 里程碑

1. 调研现有同步入口和平台进程能力。
2. 实现精确枚举、停止及 `models --sync --restart-codex` 接入。
3. 完成单元测试、真实只读枚举验证和完整构建。

## 验证方式

- 命令：`bun run check`
- 手工检查：真实停止与 Codex App 自愈验收由用户后续手动执行。
- 观测检查：不带显式参数时只提示；停止结果不使用 restarted。

## 进度记录

- [x] 确认范围和安全约束。
- [x] 完成跨平台实现和 CLI 接入。
- [x] 完成 35 项自动化测试和构建；未执行真实停止验收。

## 决策记录

- 2026-08-17：复用现有 `models --sync`，仅新增 `--restart-codex`，不增加重复命令。
- 2026-08-17：macOS 使用 Bun FFI 调用原生 sysctl 读取精确 argv，避免 `ps comm` 截断。
- 2026-08-17：只停止旧进程，不主动启动或声称已重启。
- 2026-08-30（历史决策，2026-08-31 已恢复）：参数更名为 `--codex-restart`，并扩展到 `install`、`uninstall`、
  `restart` 与 `models --sync`；每个命令都在完成 `config.toml` 写入后再停止
  Codex app-server。
