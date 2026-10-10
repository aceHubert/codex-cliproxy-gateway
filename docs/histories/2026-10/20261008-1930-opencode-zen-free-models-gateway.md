## [2026-10-08 19:30] | Task: 接入 OpenCode Zen 免费模型网关适配器

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> opencode-zen-free-models-proxy-integration.md 开始实施

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/`（新增模块）、`src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/types.ts`、`src/webui.ts`、`src/request-log.ts`、`schemas/gateway-config.schema.json`、`test/`

**Key Actions:**
- **[会话引擎]**: `session.ts` 实现合规 `ses_` 会话生成（按 opencode2 二进制逆向核验修正官方算法：`r = ts*0x1000 + counter`、降序 Hex 取 `~r` 高 48 位）、X-Session-Id → Zen 会话的 LRU 绑定表（24h 滑动续期、容量淘汰）与三级标头判定（合法头透传 > 外部会话绑定 > 单次临时）。
- **[门禁指纹]**: `fingerprint.ts` + `fingerprint-data.json`（自本机 opencode2 beta-19086 mitm 抓包提取）实现标头指纹（四段式 UA、session 三回填、稳定 project id、W3C 追踪头）与请求体注入（无工具→标题模板+中性覆盖；带工具→agent 模板+官方工具集并入，客户端同名定义优先；模板在前、客户端指令在后）。
- **[SSE 聚合]**: `response.ts` 把上游强制流式（非流式上游一律 403）聚合为完整 chat.completion JSON，含 content/reasoning 拼接与 tool_calls 按 index 分片合并。
- **[目录服务]**: `catalog.ts` + `free-models.json`（自二进制内嵌模型库提取 27 个零计费模型含官方名称）实现 `/zen/v1/models` 动态列表与预置清单并集、`opencode-zen/` slug 前缀与 `OP-ZEN/` 显示前缀、磁盘缓存 + TTL + 失败回退。
- **[网关接线]**: `/v1/chat/completions` 按前缀拦截分发、`/v1/models` 双形状合并（owned_by `opencode-zen`）、`/v1/responses` 对 zen 模型 400 指引；错误归一化（`zen_free_tier_error`/`zen_rate_limited`/`zen_model_unavailable` 带可执行指引）。
- **[配置链路]**: 新增 `opencodeZen` 开关（默认关，upstreamOnly 下禁用，环回监听与前缀保留校验）：types、schema、config-update patch、CLI `config --opencode-zen on|off`、同步回填、审计字段、serve 接线、webui editable。
- **[测试]**: 38 个新用例（session 12 / catalog 9 / fingerprint 7 / gateway 10），全量 `bun run check` 704 用例全绿。

### 🧠 Design Intent (Why)
执行计划的原始假设（仅标头指纹）在实施首日即被证伪：调研文档给的 `opencode/1.18.31` UA 与会话公式在真实上游全部 403。经 mitm 抓包官方客户端 + 逐项隔离实验（约 30 次真实请求）钉死三层门禁：**标头**（新四段式 UA + 会话回填 + 追踪头）、**请求体**（首条 system 须完整包含官方内置模板，逐字符匹配；带工具流量另需官方工具定义在场）、**传输**（仅接受流式）。据此把指纹数据全部收敛到单点 JSON 资产，注入采用「模板在前 + 客户端指令在后」合并——实测靠后指令主导模型行为，真实上游端到端（任务回答与工具调用）验证行为零污染。非流式客户端由网关聚合 SSE，对 Codex/Claude Code 等流式客户端则原样透传事件流。

### 📊 Change Stats
> 数据来自本次任务工作区（新增文件行数 + `git diff --numstat` 未暂存部分；工作区另有此前 codebuddy 任务的已暂存改动，未计入）。

- **Files changed:** 20（新增 11：src 7 + test 4）
- **Insertions:** +2429
- **Deletions:** -14

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/index.ts` | +306 | 新增 |
| `src/opencode-zen/catalog.ts` | +220 | 新增 |
| `src/opencode-zen/fingerprint.ts` | +187 | 新增 |
| `src/opencode-zen/session.ts` | +175 | 新增 |
| `src/opencode-zen/response.ts` | +134 | 新增 |
| `src/opencode-zen/fingerprint-data.json` | +417 | 新增 |
| `src/opencode-zen/free-models.json` | +83 | 新增 |
| `test/opencode-zen-gateway.test.ts` | +386 | 新增 |
| `test/opencode-zen-catalog.test.ts` | +161 | 新增 |
| `test/opencode-zen-session.test.ts` | +146 | 新增 |
| `test/opencode-zen-fingerprint.test.ts` | +115 | 新增 |
| `src/gateway.ts` | +47 | -6 |
| `src/cli.ts` | +26 | -5 |
| `src/config-update.ts` | +10 | 0 |
| `schemas/gateway-config.schema.json` | +5 | 0 |
| `src/types.ts` | +6 | 0 |
| `src/request-log.ts` | +1 | -1 |
| `src/webui.ts` | +1 | 0 |
| `test/zcode-cli.test.ts` | +2 | -2 |
| `docs/`（计划归档 + 技术债 + 本记录） | 若干 | — |

### 📁 Files Modified
- `src/opencode-zen/{session,fingerprint,catalog,response,index}.ts`、`src/opencode-zen/{fingerprint-data,free-models}.json`（新增）
- `src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/types.ts`、`src/webui.ts`、`src/request-log.ts`
- `schemas/gateway-config.schema.json`
- `test/opencode-zen-*.test.ts`（新增 4 个）、`test/zcode-cli.test.ts`
- `docs/exec-plans/completed/opencode-zen-free-models-proxy-integration.md`（自 active/ 归档）、`docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿（tsc 严格模式 + 704 测试 + UI/CLI 构建）。
- 真实上游端到端（临时网关 8399，`opencodeZen: true`）：
  - `/v1/models` 两种形状 37 个免费模型，slug 均带 `opencode-zen/`、显示名均带 `OP-ZEN/`、owned_by `opencode-zen`；
  - 流式转发返回真实 SSE（含 reasoning 增量）；非流式收到聚合 chat.completion（content/usage 齐备，行为覆盖生效）；
  - 工具调用往返：模型正确调用客户端自有工具 `lookup_issue({"issue":42})`，finish_reason `tool_calls`；
  - `/v1/responses` 对 zen 模型 400 + Chat Completions 指引；
  - 相同 `X-Session-Id` 稳定复用同一上游会话、合法 `x-opencode-session` 原样透传（单测断言）。

### 📌 Notes
- 门禁逆向过程与配方实证记录在执行计划「决策记录 #3」；指纹资产更新流程见 `tech-debt-tracker.md` 2026-10-08 行。
- 预置免费清单与动态 `/zen/v1/models` 取并集（当前 37 个）；免费判定 = `-free` 后缀 ∪ 预置零计费清单（含 `grok-code`、`big-pickle` 等无后缀条目）。
