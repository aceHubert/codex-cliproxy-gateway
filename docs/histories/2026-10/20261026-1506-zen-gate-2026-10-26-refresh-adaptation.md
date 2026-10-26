## [2026-10-26 15:06] | Task: 适配 Zen 门禁 2026-10-26 换代（会话新鲜度 + 模板包含校验 + 端点迁移）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/agent-system-prompt-conversion-layer`

### 🛥 User Query
> opencode-zen 又调用不通了，根据日志分析一下 → 追问新规则是加了工具还是验了提示词 → 用 opencode2 CLI 直接测试 → 升级本机 GA 后再探测 → 换了个代理 IP 再试 → 开始修改网关 → 继续

### 🛠 Changes Overview
**Scope:** packages/opencode-zen、scripts、test、docs

**Key Actions:**
- **[调查]**: 从网关日志定位 429 FreeUsageLimitError；探针实测推翻「工具/标头/UA/IP」四类假设；截获官方 GA 2.1.4 真实请求（改本机 opencode 目录缓存指向本地转发代理）后逐项隔离，锁定新画像：会话四值同配 + **时间段新鲜度校验**、system **包含官方当前代模板全文**、chat 端点迁 `/inference/openai/v1`、匿名池**按 IP** 滚动限额（与形态拒绝同文案）。
- **[快照换代]**: `fingerprint-data.json` 更新为 GA 2.1.4：clientVersion 2.0.29 → 2.1.4、agent 模板 1,474 → 21,010 字符、标题模板 2,119 → 1,806 字符；工具 12 定义与旧快照逐字节一致。
- **[会话派生重写]**: `deriveOpenCodeSessionId` 时间段由外部 id 哈希改为铸造时刻（哈希时间段实测 2/2 被 429），确定性只保留后缀；跨请求粘性改由 resolver 进程内缓存（上限 4096，满即重置）提供。
- **[模板包裹恢复]**: 新增 `mergeOpencodeZenGateSystem`——system 字符串内容包裹为「官方模板在前 + `# Client Instructions` 分隔 + 客户端指令在后」，无 system 或非字符串内容时前插纯模板 system；接入 `injectOpencodeZenFingerprintBody`（2026-10-14「不注入」决策被门禁换代事实推翻）。
- **[tools 上限截断]**: 上游 tools 数组硬上限 128（超出 400 `maximum number of items is 128`，重载 MCP 的 agent 客户端触发）；`mergeOpencodeZenGateTools(Responses)` 合并后按 `OPENCODE_ZEN_TOOLS_MAX` 截断，截断时保证垫补的官方 `read` 存活（前 127 客户端原序 + read 垫底）。
- **[端点拆分]**: `OPENCODE_ZEN_DEFAULT_ENDPOINT` → `/inference/openai/v1`（元数据 api 的回退对齐）；新增 `OPENCODE_ZEN_MODELS_ENDPOINT`（`/models` 列表仅在 `/inference/v1`，openai 基座 404）。
- **[探针重写]**: `scripts/zen-gate-probe.ts` 按新画像重写 9 项（模板包裹对照、纯 system/截断模板/随机 hex 会话三类拒绝项、UA 与多余标头两项无关项），默认模型换 `nemotron-3.5-lightning-free`。
- **[测试同步]**: fingerprint/session/gateway/user-agent/model-exclude 五个测试文件更新——包裹语义断言、派生新契约（同刻恒定/跨刻后缀稳定/进程内粘住）、端点 URL、UA 快照；同日 11:05 任务的「四入口透传」测试改写为「官方模板包裹」语义（其前提被实测推翻）。
- **[文档]**: `docs/fingerprint-data.md` 更新 zen 消费点、系统提示词接线的 zen 段（收回 10-14 例外）、source 行、新增 10-26 换代 notes 与更新记录行。

### 🧠 Design Intent (Why)
门禁在 2026-10-16 后换代：匿名免费层从「指纹标头 + 工具实名」升级为「会话时间段新鲜度 + system 包含官方当前代模板 + 按 IP 匿名池限额」，旧注入形态整体失效（表现为 429 FreeUsageLimitError，与配额耗尽同文案）。修复以实测为准：每个注入点都有对应的过闸实验支撑（现铸会话 200 vs 哈希时间段 429；模板+客户端指令追加 200 vs 截断/无模板 429；e2e 真机 200）。模板包裹意味着模型上游会看到 OpenCode 官方 harness 提示词——这是门禁强制的代价，客户端操作性指令以追加方式保留。匿名池按 IP 限额是运行时现实：批量 429 时应先换出口复测再定性指纹漂移（探针脚本已内置该提示）。

### 📊 Change Stats
> 数据来自 `git diff`（工作区未提交改动，含同日 11:05 任务被吸收后的净变化）。

- **Files changed:** 12
- **Insertions:** +445
- **Deletions:** -212

| File | +Added | -Removed |
| --- | ---: | ---: |
| `docs/fingerprint-data.md` | +31 | -9 |
| `packages/opencode-zen/src/catalog.ts` | +8 | -7 |
| `packages/opencode-zen/src/fingerprint-data.json` | +3 | -3 |
| `packages/opencode-zen/src/fingerprint.ts` | +125 | -41 |
| `packages/opencode-zen/src/index.ts` | +22 | -16 |
| `packages/opencode-zen/src/session.ts` | +35 | -24 |
| `scripts/zen-gate-probe.ts` | +46 | -47 |
| `test/model-exclude-gateway.test.ts` | +1 | -1 |
| `test/opencode-zen-fingerprint.test.ts` | +86 | -13 |
| `test/opencode-zen-gateway.test.ts` | +98 | -23 |
| `test/opencode-zen-session.test.ts` | +29 | -23 |
| `test/opencode-zen-user-agent.test.ts` | +3 | -3 |

### 📁 Files Modified
- `packages/opencode-zen/src/fingerprint-data.json`
- `packages/opencode-zen/src/fingerprint.ts`
- `packages/opencode-zen/src/session.ts`
- `packages/opencode-zen/src/index.ts`
- `packages/opencode-zen/src/catalog.ts`
- `scripts/zen-gate-probe.ts`
- `test/opencode-zen-fingerprint.test.ts`
- `test/opencode-zen-session.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `test/opencode-zen-user-agent.test.ts`
- `test/model-exclude-gateway.test.ts`
- `docs/fingerprint-data.md`

### ✅ Validation（追加：tools 上限修复）
- 真实服务（launchd 重启加载后）复刻失败场景：`beam-free` + 130 个 MCP 工具 + `/v1/messages` → HTTP 200（此前同形状 400）。
- 截断行为单测：chat/Responses 双形状 130→128、read 存活、恰 128 不截。

### ✅ Validation
- `bun run check`：构建 + 严格类型检查 + 1256 个 node:test 全部通过。
- 适配器级 e2e（真实网络，经 `createGatewayHandler` 全链路）：目录拉到 8 个免费模型；`session-id` 头 + 非流式 chat 请求（含客户端 system）→ HTTP 200，模型中文正确回答（会话派生 → 模板包裹 → read 合并 → 强制流式 → SSE 聚合回 JSON 全链路生效）。
- 门禁矩阵实测（换 IP 后）：现铸官方格式会话 + GA 模板 + 任意工具 + 任意 UA 连续 200；纯 system/截断模板/哈希时间段会话 429。

### 📌 Notes
- 调查期本机变更：npm 全局包 `opencode-ai@1.18.28`、`@opencode-ai/cli@beta-19086` 替换为 `@opencode/cli@2.1.4`（GA）；回滚命令 `npm rm -g @opencode/cli && npm i -g opencode-ai@1.18.28 @opencode-ai/cli@0.0.0-beta-19086`。opencode 目录缓存与 Clash 节点均已还原。
- 匿名共享池按 IP 限额：当前台湾出口可用，新加坡出口当日耗尽（UTC 午夜重置）。zen 通道在此模式下不保证全天可用，属上游现实而非网关缺陷。
- 模板会随官方发版换代失效：探针 `fallback-official` 被拒即快照过期，按 `docs/fingerprint-data.md`「更新方法」重取（含本次新增的目录缓存劫持截获捷径）。
