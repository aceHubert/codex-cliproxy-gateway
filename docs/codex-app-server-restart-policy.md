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

1. 不带 `--restart-codex` 的命令不枚举或停止 Codex app-server。路由模式
   实际变化时，CLI 仍会自动重启网关；`config` 写入任何配置后也统一重启
   网关。这些是与 Codex 进程无关的另一层动作。`config` 设置 zcode、
   codebuddy 开关或地域偏好时，写盘同时失效 Codex 的 `models_cache.json`
   （与 install / models --sync 同一机制），使新拉起的 app-server 启动时
   立即重拉 `/models`；纯日志选项不失效。
2. `install`、`uninstall`、`restart` 和 `models --sync` 都会操作受管的
   `~/.codex/config.toml`，因此统一接受 `--restart-codex`。`config` 不在此列：
   它只写网关侧 `config.json`，从不触碰 `config.toml` 的
   `model_catalog_json`，停止 app-server 换不来对应的静态目录切换；动态
   目录下停进程也无法刷新已打开的 picker（见「生效边界」）。因此 `config`
   不接受该参数，误传按未知参数报错。只有显式传入该参数时才允许停止
   Codex app-server；CPA-only 静态目录切换或更新需要重新加载 app-server。
   不使用该参数时，由用户手动重启 Codex 或等待它自身刷新。
3. 必须在日志中说明 active turn 可能被中断；这是显式同意边界。
4. 手工修改 `config.json` 或 `config.toml` 不会触发任何网关重启或 Codex
   app-server 刷新。

## 两层重启边界

- **网关重启**：模式在 split 与 CPA-only 之间变化、每次带参数的 `config`
  配置写入，或显式执行 `codex-cliproxy restart` 时发生。
- **Codex app-server 刷新**：只由 `--restart-codex` 或用户重启 Codex 触发。
  `--restart-codex` 只停止旧进程，不声称已启动新进程。

## Codex 侧目录刷新链路（2026-09-21 源码与实测，Codex 0.155.0 / ChatGPT.app）

依据 openai/codex 的 `models-manager` 与 app-server 源码（cache.rs /
manager.rs / models_refresh_worker.rs / catalog_processor.rs），结合本机
`codex` 二进制与 `app.asar` 的字符串分析：目录从网关到 picker 经过三层缓存，
任何一层都不向下游推送。

| 层 | 机制 | 数值 | 刷新/失效条件 |
| --- | --- | --- | --- |
| UI（react-query） | `model/list` 查询 | staleTime 5 分钟 | 缓存过期后需再发生一次挂载或窗口聚焦（refetchOnWindowFocus）才会重新拉取；queryKey 含 `modelCatalogPath`/`modelProvider` |
| app-server 后台 worker | `models_refresh_worker` 定时以 `RefreshStrategy::Online` 强制回源 | 270 秒 | 无条件定时刷新，刻意短于缓存 TTL，使磁盘缓存永远新鲜 |
| app-server 磁盘缓存 | `models_cache.json`（`ModelsCacheEntry`：fetched_at / etag / client_version / identity / models） | TTL 300 秒 | `client_version` 与期望不符即判 miss（本工具的失效写入正打在此点）；保存时整体重序列化、丢弃未知字段 |

补充事实：

- 静态/动态目录是 `ModelsManager` 的两个实现，进程构造时二选一：
  `StaticModelsManager` 的刷新方法是空操作，永不重读磁盘；只有动态实现
  才有缓存与回源。这就是静态目录更新与模式切换必须重启 app-server 的根因。
- 协议中没有模型列表推送（skills 有 `SkillsChanged` 通知，models 没有）；
  UI 侧 picker 也没有刷新入口。`session_configured` 事件会携带
  `available_models`/`default_model` 快照，但 picker 渲染主要来自上表的
  5 分钟查询。
- 走本网关时官方 ETag 不透传（响应混入本地 rows），codex 缓存的 `etag`
  字段恒为空，动态模式实际靠 TTL 与 270 秒 worker 判新鲜度。
- 推论：动态模式下变更目录，picker 最坏延迟 ≈ UI 的 5 分钟 staleTime
  （app-server 侧最多 270 秒自愈）。要立即看到变化：重载 App 窗口（如
  可用）、等 5 分钟后点击一次窗口，或重启 Codex App；外部进程无法更快。

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

2026-09-21 实测（Codex 0.155.0 / ChatGPT.app）：app-server 被停止后 App 会
重新拉起并在约 4 秒内重新拉取 `/models`，`models_cache.json` 同步更新——
网关与 app-server 侧链路全通；但已打开的模型选择器仍渲染旧快照。UI 层的
刷新时机在 App 进程内部，外部进程（网关、CLI、app-server 重启）均无法触发；
立即刷新手段见上节「Codex 侧目录刷新链路」。

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
