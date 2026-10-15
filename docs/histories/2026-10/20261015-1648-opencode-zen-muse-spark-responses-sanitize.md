# [2026-10-15 16:48] | Task: muse-spark 系列的 /responses 请求净化

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 分析 Codex 会话 01a13e88-499d 的报错 `zen_upstream_error: input[0] did not match
> any supported type`；随后要求对 `muse-spark-*` 做特殊处理（含 cliproxy 时代对
> `web_search.search_content_types` 的过滤经验），按 /v1/responses 请求时净化，
> 先落执行任务文档再实施。

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（插件适配层）、test（网关行为测试）、docs（执行计划）

**Key Actions:**
- **[错误诊断]**: Codex 0.162 新线格式把全部工具声明改为 `input[0]` 的
  `additional_tools` 信封项（namespace 分组，顶层 `tools` 消失），muse-spark 的
  zen `/responses` 上游不识别该 input 项直接 400；抓包 + A/B 重放（原样 400 /
  仅移除信封项 200）唯一确定因果。
- **[上游能力探针]**: chat 端点 `ModelProtocolUnsupported`（排除改路由）；顶层
  namespace 工具可过（提升零改名成为可能）；`web_search.search_content_types`
  400、剥离后 200（证实 cliproxy 时代经验，且该参数在 `web_search_preview` 合法）。
- **[净化实现]**: `packages/opencode-zen/src/index.ts` 新增 `muse-spark-` 前缀限定
  的请求净化，接入 `adaptOpencodeZenUpstreamRequest` 出口：① 剥离 input 的
  `additional_tools` 信封项并把工具声明原样提升到顶层 `tools`（同名保留顶层）；
  ② function/custom/namespace 的空缺 `description` 以工具名占位；③ 丢弃 `custom`
  工具声明（含 namespace 内层与清空的 namespace）；④ 从 `web_search` 剥离
  `search_content_types`（`web_search_preview` 保留）。
- **[测试]**: 新增 2 个网关行为测试（净化生效 / 非 muse 模型不受影响），既有
  responses 直通测试的夹具模型由 muse-spark 换成中立合成模型（该测试意图是
  直通保真，muse 现在按设计有净化）。
- **[端到端验证]**: 源码网关（隔离 home + 真实上游）跑 `codex exec`：请求不再
  400，模型可经提升后的 namespace 发起函数调用（`clock.sleep` 调用往返成功）；
  custom 工具（node REPL `exec`）按预期不可用。

### 🧠 Design Intent (Why)
muse-spark 是目录里唯一的 responses 协议家族，同协议直通把 Codex 原始请求逐字节
送上游，于是 Codex 0.162 的线格式变化最先在这里爆雷。chat 端点实测不可用，没有
改路由空间；改 llm-bridge 同协议直通语义会波及所有插件路径。因此收敛为模型前缀
限定的出口净化：只动 muse-spark，其余模型零行为变化；工具声明原样搬运保证调用
历史与声明名一致，custom 工具只丢弃不转换（custom_tool_call 响应形状无法在直通
链路改写回 function_call）。

### 📊 Change Stats
> 注：两份文件在本任务前已带分支未提交改动，numstat 为相对 HEAD 的合并值；
> 本任务净增量约为 index.ts +108 行（净化块 + isRecord 更名）、测试 +102 行。

- **Files changed:** 2（代码）+ 1（执行计划，新增）
- **Insertions:** +338
- **Deletions:** -110

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/index.ts` | +162 | -35 |
| `test/opencode-zen-gateway.test.ts` | +176 | -75 |

### 📁 Files Modified
- `packages/opencode-zen/src/index.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/exec-plans/completed/opencode-zen-muse-spark-responses-sanitize.md`（新增）
