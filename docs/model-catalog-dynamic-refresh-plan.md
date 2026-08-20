# Codex model catalog 动态刷新与静态模式方案

## 实施状态

2026-08-18 已实现动态官方缓存与可选静态 catalog。真实账号下的 300 秒周期刷新和
静态/动态 UI 切换仍需手工验收。

## 背景

`codex debug models --bundled` 读取的是指定 Codex 二进制内置快照。PATH CLI 与
Codex Desktop runtime 版本不一致时，用它生成的 native rows 可能落后。Codex 在未配置
`model_catalog_json` 时会周期请求 `{openai_base_url}/models?client_version=...`，请求本身
已带当前 OAuth 和客户端版本，因此动态请求才是最新 native catalog 的可靠来源。

## 目标

1. 动态模式把 Codex `/v1/models` 请求转发到官方上游。
2. 最近一次有效官方响应原子保存为 gateway last-good cache。
3. CLIProxy 模型只由 `models --sync` 拉取和选择，不在 `/v1/models` 中实时请求。
4. `models --sync --static` 从官方 cache 生成静态 catalog，不调用 `codex debug models`。
5. 普通 `models --sync` 删除受管静态配置，恢复动态刷新。

非目标：

- 不按账号或 `client_version` 分片官方 cache。
- 不新增后台定时任务；刷新由 Codex 自己的周期请求驱动。
- 不透传官方 ETag，因为返回内容还包含本地 CLIProxy rows。

## 文件布局

```text
~/.codex/
  config.toml
  models_cache.json                 # Codex 自有 cache
  cliproxy-catalog.json             # --static 生成

~/.codex-cliproxy-gateway/
  config.json
  state.json
  models-cache.json                 # 官方 /models last-good
  cliproxy-catalog.json             # 仅保存已选择的 cliproxy/ rows
  models.json                       # 可选模型字段覆盖
```

两个模型 cache 不得混用：

- `models-cache.json`：gateway 保存的官方 native catalog。
- `models_cache.json`：Codex 管理的最终合并目录 cache。

## 动态 `/v1/models`

Codex 请求带 `client_version` 时：

```text
GET /v1/models?client_version=0.148.0
  → 保留 Authorization 与 ChatGPT-Account-ID
  → 删除条件请求头，向官方 /models 请求完整响应
  → 校验非空 models 数组
  → 原子更新 models-cache.json
  → 读取 runtime cliproxy-catalog.json 中的 cliproxy/ rows
  → 调整 routed rows priority 并合并返回
```

只有官方成功且 JSON 有效时才覆盖 last-good。网络错误、非 2xx、非法 JSON 或空目录均
回退到旧 cache；没有 last-good 时返回 `502`。

普通 OpenAI 客户端不带 `client_version` 时不触发官方请求，只把 last-good 与 routed rows
转换成 OpenAI list shape。

## `models --sync`

普通 sync 使用动态模式：

```text
1. 读取 gateway config 和当前选择
2. 请求 CLIProxy /models
3. 用户确认选择
4. 生成只包含 cliproxy/ rows 的 runtime overlay
5. 删除受管 model_catalog_json 和对应的静态 catalog 文件
6. 保留 models_cache.json.models，仅把 fetched_at 和 client_version 置为失效
```

如果此前处于静态模式，需要重新启动 Codex 或恢复任务，让新的 model manager 读取配置；
之后 Codex 会继续周期刷新 `/models`。

## `models --sync --static`

```text
1. 检查 ~/.codex-cliproxy-gateway/models-cache.json 存在且有效
2. 请求 CLIProxy /models 并确认选择
3. 使用官方 cache 作为 native rows
4. 应用 models.json 覆盖并合并 cliproxy/ rows
5. 原子写 ~/.codex/cliproxy-catalog.json
6. 写入 model_catalog_json = "~/.codex/cliproxy-catalog.json"
7. 同步 runtime CLIProxy overlay
```

cache 缺失或非法时，在请求 CLIProxy 和写静态 catalog 前失败。静态模式不失效 Codex
`models_cache.json`，因为 `StaticModelsManager` 不读取它；退出静态模式时普通 sync 会失效。

## 失败与安全边界

- 官方失败不得截断或覆盖 last-good。
- 静态 cache 缺失不得回退到 bundled catalog。
- 非本工具管理的 `model_catalog_json` 不得被覆盖或删除。
- OAuth、API key 与 `ChatGPT-Account-ID` 在请求日志中必须遮蔽。
- `--restart-codex` 可在任意 sync 后立即重建模型选择器；启用或退出静态
  `model_catalog_json` 时尤其需要。

## 测试清单

1. 动态 `/models` 转发官方 URL、OAuth、账号头与 `client_version`。
2. 官方成功更新 last-good，并排除 runtime catalog 中的旧 native rows。
3. 官方失败使用 last-good；无 last-good 返回 `502`。
4. 动态返回官方 native rows 与选择的 CLIProxy rows，并重新计算 routed priority。
5. 不带 `client_version` 返回 OpenAI list shape 且不请求官方。
6. `--static` 缺少 cache 时在上游选择前失败。
7. `--static` 写静态 catalog 和 `model_catalog_json`。
8. 普通 sync 删除静态配置并保留 Codex cache 中的 models。
9. runtime 清理包含官方 cache，但保留非托管文件。

## 结论

- native rows：由真实 Codex OAuth `/models` 请求持续更新。
- CLIProxy rows：由 `models --sync` 显式选择并本地保存。
- dynamic：官方 last-good + 本地 routed overlay。
- static：同一份官方 last-good + routed overlay 固化为 `model_catalog_json`。
