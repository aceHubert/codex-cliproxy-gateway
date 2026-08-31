# Codex 动态目录与 CPA-only 静态目录方案

## 实施状态

2026-08-27 将原官方合并静态模式替换为 CPA-only 静态目录；官方目录不再由 gateway 落盘缓存。

## 背景

`codex debug models --bundled` 读取的是指定 Codex 二进制内置快照。PATH CLI 与
Codex Desktop runtime 版本不一致时，用它生成的 native rows 可能落后。Codex 在未配置
`model_catalog_json` 时会周期请求 `{openai_base_url}/models?client_version=...`，请求本身
已带当前 OAuth 和客户端版本，因此动态请求才是最新 native catalog 的可靠来源。

## 目标

1. 动态模式把 Codex `/v1/models` 请求转发到官方上游。
2. 官方目录每次 `/v1/models` 请求实时获取，不由 gateway 落盘。
3. CLIProxy 模型只由 `models --sync` 拉取和选择，不在 `/v1/models` 中实时请求。
4. `models --sync --cpa-only` 生成只含 CPA 原始模型 ID 的静态 catalog，并切换到 CPA-only 路由。
5. 普通 `models --sync` 删除受管静态配置，切回动态 split 路由。

> 2026-08-30 语义更新：路由模式只由 `models --sync [--cpa-only]` 的 flag 显式选择；
`config` 命令仅保留设置打印与 `--log on|off`，不再承担模式切换。CPA Responses
WebSocket 无网关侧开关，一律桥接 CLIProxy、由上游按请求判断。

## 重启要求

- `models --sync --cpa-only` 从 split 切换到 CPA-only，或普通 `models --sync` 从
  CPA-only 切回 split 时，CLI 会自动重启网关。同一模式内重新同步目录或
  模型选择不重启网关。
- 模式切换会增删 `model_catalog_json`，Codex app-server 需要重新加载才能切换
  模型管理器。需要立即生效时使用 `--restart-codex`，或者手动重启 Codex。
- CPA-only 中的静态目录更新后，已运行的 Codex app-server 不会自动重读；
  split 模式会周期请求 `/v1/models`，但已打开的选择器仍可能持有旧快照。
- 手工修改 `config.json` 或 `config.toml` 不在 CLI 自动处理范围内，也不会触发
  网关或 Codex 重启。

非目标：

- 不维护官方目录缓存或后台刷新任务。
- 不新增后台定时任务；刷新由 Codex 自己的周期请求驱动。
- 不透传官方 ETag，因为返回内容还包含本地 CLIProxy rows。

## 文件布局

```text
~/.codex/
  config.toml
  models_cache.json                 # Codex 自有 cache

~/.codex-cliproxy-gateway/
  config.json
  state.json
  cliproxy-catalog.json             # 已选择的 CPA 原始 rows，两个模式共用
  models.json                       # 可选模型字段覆盖
```

`models_cache.json` 由 Codex 管理；gateway 不再保存官方目录副本。

## 动态 `/v1/models`

Codex 请求带 `client_version` 时：

```text
GET /v1/models?client_version=0.148.0
  → 保留 Authorization 与 ChatGPT-Account-ID
  → 删除条件请求头，向官方 /models 请求完整响应
  → 校验非空 models 数组
  → 不落盘官方目录
  → 读取 runtime cliproxy-catalog.json 中的原始 CPA rows
  → 仅在响应中添加 cliproxy/ 前缀
  → 调整 routed rows priority 并合并返回
```

官方网络错误、非 2xx、非法 JSON 或空目录时返回 `502`。

## `models --sync`

普通 sync 使用动态模式：

```text
1. 读取 gateway config 和当前选择
2. 请求 CLIProxy /models
3. 用户确认选择
4. 生成只包含原始 CPA rows 的 runtime catalog
5. 删除受管 model_catalog_json
6. 保留 models_cache.json.models，仅把 fetched_at 和 client_version 置为失效
```

如果此前处于 CPA-only 模式，网关会自动重启；Codex 仍需按上述要求重新加载
app-server，之后才会继续周期刷新 `/models`。

## `models --sync --cpa-only`

```text
1. 请求 CLIProxy /models 并确认非空选择
2. 应用 models.json 元数据覆盖，不读取或合并官方 rows
3. 保留 CPA 原始模型 ID，原子写 ~/.codex-cliproxy-gateway/cliproxy-catalog.json
4. 写入 model_catalog_json = "~/.codex-cliproxy-gateway/cliproxy-catalog.json"
5. 设置 cpaOnly=true；仅在模式实际变化时自动重启网关
6. 可加 --restart-codex 停止旧 Codex app-server，让新进程重读静态目录
```

CPA-only 不依赖官方目录，并直接使用两个模式共用的 runtime catalog。目录只因人工同步而变化；普通 `models --sync`
切回 split 时删除受管 `model_catalog_json` 并失效 Codex 动态 cache。模式切换伴随的配置变更都会审计到
`logs/cliproxy-config-*.log`（URL query 脱敏）。

## 失败与安全边界

- 官方失败时返回 `502`，不影响本地 CPA catalog 文件。
- CPA catalog 缺失、损坏或合并失败时，`/v1/models` 只返回官方目录。
- 官方目录 fallback 只保证目录可用；`cpaOnly=true` 时推理请求仍然转发 CPA。
- CPA-only 不得混入官方模型或 `cliproxy/` 路由前缀。
- 非本工具管理的 `model_catalog_json` 不得被覆盖或删除。
- OAuth、API key 与 `ChatGPT-Account-ID` 在请求日志中必须遮蔽。
- `--restart-codex` 只停止 Codex app-server，不重启网关，也不主动启动替代进程；
  启用或退出 CPA-only 时需要它或手动重启 Codex。

## 测试清单

1. 动态 `/models` 转发官方 URL、OAuth、账号头与 `client_version`。
2. 官方成功返回目录，并排除 runtime catalog 中的旧 native rows。
3. 官方失败返回 `502`。
4. 动态返回官方 native rows 与选择的 CLIProxy rows，并重新计算 routed priority。
5. 不带 `client_version` 返回 OpenAI list shape 且同样实时请求官方。
6. `--cpa-only` 写纯 CPA 静态 catalog、`model_catalog_json` 并置 cpaOnly=true。
7. 单引号 literal string 的 `model_catalog_json` 同样参与非受管守卫；值不可解析时显式报错。
8. 普通 sync 删除 CPA-only 静态配置、失效 Codex cache 并置 cpaOnly=false。
9. runtime 不生成官方目录 cache，并保留非托管文件。

## 结论

- native rows：由真实 Codex OAuth `/models` 请求持续更新。
- CLIProxy rows：由 `models --sync` 显式选择并本地保存。
- dynamic：官方实时目录 + 本地 routed overlay。
- CPA-only：只含 CPA 原始模型 ID 的静态 `model_catalog_json`，不合并官方目录。
