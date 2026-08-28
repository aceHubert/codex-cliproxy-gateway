# Codex App Server 重启策略

## 结论

Codex `app-server` 在启动时读取 `model_catalog_json`，并在内存中构建静态模型目录；
后续静态 catalog 更新后，它不会自动重读。动态模式不配置该字段，会周期请求
`/models`。启用静态目录或删除已加载的静态配置时，需要停止旧 `app-server` 才能切换
模型管理器；动态 `/models` 即使返回了新目录，已打开的模型选择器也可能继续持有旧快照。

这里实现的不是“OpenCodex 重启 Codex App”，而是：

```text
更新磁盘 catalog 或配置
  -> 停止匹配的旧 Codex app-server
  -> 等待 Codex App 自动拉起新 app-server，或由用户新开会话触发
  -> 新进程重新读取磁盘 catalog
```

## 触发策略

1. 不带 `--restart-codex` 的 sync 只更新配置和目录，不发送任何信号。
2. 用户在任意 `models --sync` 中显式传入 `--restart-codex` 时，才允许停止进程；
   CPA-only 静态目录切换需要它，动态 split 模式可用它立即刷新当前模型选择器。
3. 必须在日志中说明 active turn 可能被中断；这是显式同意边界。

## 进程匹配

只允许终止当前用户拥有的进程，并且命令行必须满足：

- 可执行文件是 `codex` / `codex.exe` / `codex.cmd`，或官方 target-triple 形式；
  且跳过全局参数后第一个子命令是 `app-server`；
- 或可执行入口是 `codex-code-mode-host` / `codex-code-mode-host.exe`。

禁止用宽泛的 `*codex*` 匹配，避免误杀包含 `codex` 字符串的无关进程。
进程枚举失败时视为 `unknown`，不得当作“没有进程”处理。

## 停止策略

- macOS/Linux：发送 `SIGTERM`，共享 2 秒等待期；不升级到 `SIGKILL`。
- Windows：使用可信路径解析的 `taskkill /PID <pid> /T /F`，必要时回退
  `process.kill(pid, SIGTERM)`。
- 结果只报告 `stopped`、`surviving`、`failed`，不报告 `restarted`。
- OpenCodex 不主动启动新的 `app-server`，也不保证 Codex App 会立即自愈。

## 生效边界

旧进程停止后，内存中的旧模型目录一定消失。模型选择器是否立即刷新，取决于
Codex App 是否重新拉起 `app-server` 并重新请求模型列表。若 App 侧保留 UI
缓存或未自动恢复，需要新开会话、重新打开选择器，或重启 Codex App。

## 实现保护

停止前必须重新枚举并确认 PID 身份，防止 PID 复用误杀。仅比较
`pid + command line` 仍不够；如果可获取启动时间，应在分类、候选过滤和发送
信号前比较启动时间。任一身份信息不可读时放弃对该 PID 发送信号。

## 验收要点

- 不带显式参数的同步不枚举或停止进程。
- 只匹配明确的 `codex app-server` / `codex-code-mode-host` 进程。
- Unix 不升级 `SIGKILL`；Windows 使用受信任的 `taskkill` 路径。
- PID 消失、命令行变化、启动时间变化或身份不可读时不会发送信号。
- 停止后不声称“已重启”，只报告停止结果和潜在 UI 刷新边界。
