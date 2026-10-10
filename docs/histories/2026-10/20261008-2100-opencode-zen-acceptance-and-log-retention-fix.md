## [2026-10-08 21:00] | Task: 验收 OpenCode Zen 调用并修复请求日志保留缺口

### 🤖 Execution Context
* **Agent ID**: `claude-code`
* **Base Model**: `Claude Fable 5.1 (claude-fable-5-1)`
* **Runtime**: `Claude Code CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 验收opencode的调用，使用logs中的真实请求来验证，使用exo-free模型来验收，并且只过去免费模型的catalog

### 🛠 Changes Overview
**Scope:** `src/request-log.ts`、`test/gateway.test.ts`（验收本体为只读验证；仅修复验收中发现的保留策略缺口）+ 本记录

**Key Actions:**
- **[真实请求回放]**: 以本机 opencode2（beta-19086）mitm 抓包 `/tmp/zen-captured-full.jsonl`（带 12 个工具的 agent 请求 + 标题生成请求，均为真实客户端报文）为输入，模型替换为 `opencode-zen/exo-free`，经临时网关（127.0.0.1:8399，`opencodeZen: true`，logDir 指向生产日志目录）转发真实上游。
- **[目录断言]**: `/v1/models` 两种形状均只含 37 个免费模型，`exo-free` 在位，`owned_by=opencode-zen`，显示名 `OP-ZEN/` 前缀；上游 87 个模型中 74 个付费条目零泄漏；动态免费 13 个全部在场。
- **[验收结果]**: exo-free 5 个模型请求项全部 503（上游 provider 端点不可用，直连上游 3 次复现，与网关无关）；对照模型 `nemotron-3.5-lightning-free` 14/14 全过：非流式聚合（content+usage 齐备）、SSE 透传、agent+12 工具流式、真实会话头透传、工具调用往返（`lookup_issue`）、`/v1/responses` 400 指引。
- **[边界观察]**: 付费模型 id（`opencode-zen/claude-fable-5`）经网关转发，上游 401 `Missing API key`，归一化 `zen_authentication_error`（文案指向 OPENCODE_API_KEY，未区分场景，已记入技术债 ⑤）。
- **[缺陷修复]**: `REQUEST_LOG_NAME` 正则未含 `opencode-zen` 命名空间：zen 请求日志既不参与保留计数（无界增长）、也不被 Web UI 日志查看器列出（`webui.ts` 用同一函数过滤）。补入正则并新增 2 条断言。

### 🧠 Design Intent (Why)
验收要求"用 logs 中的真实请求"，取抓包原始报文（而非构造请求）能同时验证门禁指纹在网关注入路径下的真实可用性与协议行为。验收过程中发现保留策略缺口：`LogNamespace` 已扩展 `opencode-zen` 但 `REQUEST_LOG_NAME` 漏改，属特性落地遗漏；修复保持"仅命名空间枚举"的最小改动面，不改变保留语义。

### 📊 Change Stats
> 工作区未提交（本次为验收 + 单点修复，无独立提交）；下表为本次任务增量，工作区另有此前 OpenCode Zen 特性的未提交改动，未计入。

- **Files changed:** 2（另：tech-debt 行内追加、本记录新增）
- **Insertions:** +3
- **Deletions:** -1

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/request-log.ts` | +1 | -1 |
| `test/gateway.test.ts` | +2 | 0 |

（`git diff --numstat` 该两文件合计 +4/-2；其中 request-log.ts 的另 1 行属此前特性的 `LogNamespace` 扩展。）

### 📁 Files Modified
- `src/request-log.ts`（`REQUEST_LOG_NAME` 补 `opencode-zen`）
- `test/gateway.test.ts`（`isRequestLogName` 新增 zen 用例断言）
- `docs/exec-plans/tech-debt-tracker.md`（zen 行补 ⑤ 付费 id 401 文案观察）
- `docs/histories/2026-10/20261008-2100-opencode-zen-acceptance-and-log-retention-fix.md`（本记录）

### ✅ Verification
- `bun run check` 全绿：类型检查 + 704 测试（含新增断言）+ UI/CLI 构建。
- 验收矩阵（临时网关 8399，真实上游）：见上文结果；请求日志落盘 10 个 `opencode-zen-*` 文件于 `~/.codex-cliproxy-gateway/logs`（503 错误、聚合 JSON、SSE 透传、agent 工具流各形态齐备）。
- 对照直连：exo-free 直连上游 503 ×3；nemotron 直连 200（292KB SSE）。

### 📌 Notes
- exo-free 上游 provider（Console）端点 2026-10-08 21:03–21:16 期间不可用（`Endpoint is unavailable`），恢复后可用 `/tmp/zen-accept/accept.ts exo-free` 重跑补齐 5 项；网关侧 503 归一化与日志行为已验证正确。
- 临时验收网关已停止；生产 `~/.codex-cliproxy-gateway/config.json` 未改动（`opencodeZen: false`）。
- 验收脚本、回放载荷与抓包提取物在 `/tmp/zen-accept/`（accept.ts / control-probe.ts / agent-body.json / title-body.json / config.json）。

### 🔁 补充验收（2026-10-08 21:48–22:05）：目录内其他免费模型

- **触发**：用户追问其他模型（例 `space-bunny-alpha`）。该名称来自 2026-09-24 历史记录中经 CLIProxyAPI `cliproxy/free/space-bunny-alpha` 路由的命名；OpenCode Zen 上游当前 id 为 `space-bunny-free`，对应网关模型 `opencode-zen/space-bunny-free`。
- **space-bunny-free 深测**：与 exo-free 同一套 14 项（目录、聚合、透传、agent+12 工具、会话透传、工具调用、responses 拒绝）全部通过。
- **目录随上游轮换刷新**：38 个（动态免费 14 + 预置补 24，新增 `step-5-preview-free`），仍无付费泄漏。
- **可用性矩阵**（每模型一次真实抓包标题请求，`max_tokens: 64`，串行、间隔 1.5s；异常项均经直连上游对照复现，全部为上游侧）：

| 结果 | 数量 | 模型 |
| --- | ---: | --- |
| 200 可用 | 8 | big-pickle、mimo-v2.6-flash-free、space-bunny-free、longcat-2.5-preview-free、nemotron-3-ultra-free、nemotron-3.5-lightning-free、fledge-alpha-free、ling-3.1-flash-free（其中 3 个因 64 token 上限在 reasoning 阶段截断，content 为空但 usage 约 1100 token，链路可用） |
| 503 provider 端点不可用 | 2 | exo-free、step-5-preview-free |
| 403 `RegionError` | 2 | muse-spark-1.3-contributor-free、muse-spark-1.2-contributor-free（上游原文 "This model is not available in your country"，带工具的 agent 形态同样 403） |
| 400 `ModelProtocolUnsupported` | 1 | jev-1.13-free（chat completions 与 responses 两种协议均拒） |
| 404 无路由 | 1 | ling-3.0-flash-fin-free（仍出现在上游 `/models` 列表） |
| 401 "Model X is not supported" | 24 | 全部预置清单独有模型（已轮换下线） |

- **发现（待决，本轮未改代码）**：
  - A. 上游 401 "Model X is not supported" 被 `normalizeZenUpstreamError` 归一化为 `zen_authentication_error`（文案指向 OPENCODE_API_KEY），与执行计划"轮换下线归一化为 `zen_model_unavailable`"的设计不符；建议模型失效判定补 `not supported` 分支并置于 401 分支之前。
  - B. 上游 403 `RegionError` 被归一化为 `zen_free_tier_error` 并给出"升级指纹数据"指引，属误导；建议按上游 `error.type` 区分 `RegionError` 为独立分类。
  - C. 上游 HTTP 200 但流内仅一帧 `data: {"error":{"type":"server_error","message":"Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded"}}` 时，非流式聚合器返回 content 为空、finish=stop、合成 id、无 usage 的"成功"响应（`opencode-zen-v1-chat-http-20261008215257.log`）；流式透传则把该错误帧原样交给客户端。建议聚合器识别 `chunk.error` 并以 5xx `zen_upstream_error` 返回上游原文。
  - D. 目录"动态 ∪ 预置"并集策略使 24 个已下线模型长期可见，且其错误文案"请刷新模型列表"无法消除它们（预置恒在）；建议动态拉取成功时仅暴露动态免费列表，预置清单只作冷启动兜底与显示名来源。
- **证据**：`/tmp/zen-accept/matrix.log`、`matrix-results.json`、`accept-space-bunny.log`、`n3u-stream.txt`、`control-probe*.ts`；网关请求日志 `~/.codex-cliproxy-gateway/logs/opencode-zen-*`。

### 🧩 追加实现（2026-10-08 22:30–23:15）：目录按端点协议与下线状态过滤

- **需求**（用户两问）：能否获取每个模型的端点类型、过滤掉非 openai chat 协议模型；能否过滤掉已下线模型。
- **数据源**：`https://models.opencode.ai/api.json`，opencode 官方客户端同源的实时元数据（5.4MB）。opencode provider 每个模型带 `provider.npm`（端点协议：缺省即继承 `@ai-sdk/openai-compatible` chat；`@ai-sdk/anthropic` / `@ai-sdk/google` / `@ai-sdk/openai` 为非 chat）与 `status: "deprecated"`（官方下线标记）。本机二进制快照缺新模型（jev / step-5 / space-bunny 等），故弃用二进制改实时数据集。
- **实现**：
  - `src/opencode-zen/catalog.ts`：新增 `parseZenMetadataResponse`（元数据解析）、`classifyZenProbeResult`（探针分类）、`filterZenCatalogIds`（可见目录过滤）；store 在"动态 ∪ 预置"之上叠加两层过滤——官方元数据（下线 / 非 chat 协议剔除）与元数据缺失新模型的探针裁决；元数据 6h TTL、裁决 24h TTL，随 `opencode-zen-catalog.json` 落盘（`metadata` + `probe_verdicts` 字段），`content_hash` 改按过滤后的可见列表计算；元数据不可用时保守不过滤；旧版缓存文件（无新字段）兼容读取。
  - `src/opencode-zen/index.ts`：新增 `ZEN_METADATA_URL` 与 `fetchMetadata` / `probeModel` 闭包（复用与转发一致的指纹标头；探针为一次 gated 最小请求 `max_tokens: 1`）；`ZenDependencies` 增加两个测试注入点。
- **探针裁决规则**：400 `ModelProtocolUnsupported`、401、404、403 `RegionError` → 剔除；200、5xx、429、403 `FreeTierError` → 保守保留（指纹失效时不误伤）；探针失败不记录裁决、下轮刷新重试。
- **真实上游验证**（临时网关 8399，真实上游）：目录 38 → 11，保留 big-pickle、exo-free、mimo-v2.6-flash-free、space-bunny-free、longcat-2.5-preview-free、step-5-preview-free、ling-3.0-flash-fin-free、nemotron-3-ultra-free、nemotron-3.5-lightning-free、fledge-alpha-free、ling-3.1-flash-free；`jev-1.13-free` 探针 drop、`muse-spark-1.3-contributor-free` 协议剔除、25 个 deprecated 剔除、`step-5-preview-free` 因 503 保守保留；缓存文件含 metadata（120 条）与 jev 裁决记录；codex 形状同为 11；`space-bunny-free` 经网关真实请求 200（聚合 chat.completion，usage 1209）。
- **测试**：新增 7 个用例（元数据解析、探针分类、过滤函数、store 过滤+探针+磁盘回读、探针失败重试、旧缓存兼容、网关目录过滤集成）；`bun run check` 711 用例全绿（类型检查 + 构建）。
- **Files**：`src/opencode-zen/catalog.ts`、`src/opencode-zen/index.ts`、`test/opencode-zen-catalog.test.ts`、`test/opencode-zen-gateway.test.ts`（均为未提交的新模块/文件）。
- **遗留**：`ling-3.0-flash-fin-free` 元数据未标 deprecated 但上游 404 无路由（上游自身不一致，目录仍暴露，使用时报 `zen_model_unavailable`）；错误归一化三处（401 not supported 文案、403 RegionError 分类、流内 error 帧聚合）与 A/B/C 发现同状态待决；临时网关已停止，生产配置未动。
