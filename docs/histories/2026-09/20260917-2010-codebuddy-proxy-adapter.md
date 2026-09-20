# [2026-09-17 20:10] | Task: 执行并验收 CodeBuddy/WorkBuddy 协议转换代理层

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `builtin:zai-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> codebuddy-proxy-adapter.md 执行并验收 —— 按 `docs/exec-plans/active/codebuddy-proxy-adapter.md` 实现全部里程碑、通过 `bun run check`、完成真实积分的验收调用并收尾文档。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（`src/codebuddy/` 新模块 + gateway 挂载 + CLI/Web UI 开关 + 测试 + 文档）

**Key Actions:**
- **[credentials]**: `.info` 凭据只读层——profile 双源判定（domain + JWT issuer，冲突/未知拒绝）、4 个官方端点白名单、mtime 热更新、临近过期 503、符号链接与损坏不回退。
- **[catalog]**: `/v3/config` 拉取 + serves∩picker 交集 + ①~④ 字段映射合成 Codex 条目（gpt-5.5 基底、删 minimal_client_version、倍率并入 display_name、free 后缀）；双指纹 + TTL + last-good 回退缓存，目录内容变化时过期 Codex 目录缓存。
- **[request/response]**: 手写 Responses ↔ OpenAI Chat 双向转换（llm-bridge 实测丢弃 instructions/工具历史/custom 工具，仅作废不采用）；reasoning_content → reasoning 摘要、tool_calls → function/custom_tool_call、refusal 专用事件、严格 SSE 解析 + 事件序号连续；上游恒为流式（实测不支持非流式）。
- **[request-context]**: CLI/WorkBuddy 双身份头（版本常量单一来源）、会话追踪头（X-Conversation-ID 按 thread 稳定）、目录头 x-client-platform 仅限 cli profile。
- **[gateway 挂载]**: `codebuddy/`、`workbuddy/` 前缀族拦截 `/v1/responses[/compact]`、目录合并进 `/v1/models`、WS 升级 426 codebuddy-http-only、`validateCodebuddyConfig` 环回与保留前缀约束。
- **[开关链路]**: `codebuddy?: boolean` 进 types/schema/config-update/cli `config --codebuddy`/Web UI 开关（upstream-only 禁用只读 + 不生效提示 + `codebuddyConfigured` 报告）。
- **[测试]**: 5 个新测试文件 49 个用例（profile 判定、热更新、目录映射与缓存、协议双向转换、前缀路由、错误码、双 token 脱敏、CLI/UI 开关），另补 webui/zcode-cli 既有用例的 codebuddy 断言。
- **[验收]**: 真实账号 `codebuddy/gpt-5.6-luna` 非流式 + 流式各一次通过；请求日志确认上游 `https://www.codebuddy.ai/v2/chat/completions`、model 透传裸 `gpt-5.6-luna`、无 token 明文。

### 🧠 Design Intent (Why)
- **凭据只读不刷新**：本机 CLI 与桌面端共用同一 `.info` 且活跃刷新，网关侧刷新会互相使 refreshToken 失效（codebuddy2api 文档同样警告）；临近过期报带指引 503 把刷新冲突降级为后续债务（见 tech-debt-tracker）。
- **端点硬编码白名单 + 双源 profile 判定**：防 SSRF 与协议降级；域名的区域/产品冲突直接拒绝而不是猜。
- **目录取 serves 交集**：picker 是展示价、serves 是账号实际可服务清单，取交集避免请求期 404；倍率取 serves 条目并回填正则原始捕获避免浮点尾迹。
- **手写协议转换而非 llm-bridge**：实测 `openaiResponsesToUniversal` 丢 instructions、parallel_tool_calls、function_call 历史与 custom 工具，Codex 真实流量必踩；照 zcode/request.ts 的严格手写风格保证不静默丢字段。
- **空 system 注入**：实测上游要求首条消息为 system prompt（空字符串即可通过），无系统内容时注入空 system 不改变模型行为。
- **finish_reason 空串视为未结束**：真实上游未结束帧发 `""` 而非 null，按 null 处理会误报协议错误。

### 📊 Change Stats
> 数据来自 `git diff --cached --shortstat / --numstat`（feature/codebuddy 分支，本次任务全部改动）。

- **Files changed:** 27
- **Insertions:** +3489
- **Deletions:** -27

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/codebuddy/response.ts` | +448 | 0 |
| `src/codebuddy/catalog.ts` | +341 | 0 |
| `test/codebuddy-gateway.test.ts` | +469 | 0 |
| `src/codebuddy/credentials.ts` | +288 | 0 |
| `test/codebuddy-catalog.test.ts` | +311 | 0 |
| `src/codebuddy/request.ts` | +296 | 0 |
| `src/codebuddy/index.ts` | +276 | 0 |
| `test/codebuddy-response.test.ts` | +187 | 0 |
| `src/codebuddy/request-context.ts` | +184 | 0 |
| `test/codebuddy-credentials.test.ts` | +170 | 0 |
| `test/codebuddy-request.test.ts` | +177 | 0 |
| `src/gateway.ts` | +63 | -14 |
| `README.md` | +71 | -1 |
| `docs/exec-plans/active/codebuddy-proxy-adapter.md` | +98 | 0 |
| `src/cli.ts` | +26 | -4 |
| `test/webui.test.ts` | +20 | -3 |
| `src/ui/ConfigPage.tsx` | +27 | 0 |
| `schemas/gateway-config.schema.json` | +5 | 0 |
| `src/config-update.ts` | +11 | -2 |
| `src/paths.ts` | +6 | -1 |
| `src/request-log.ts` | +2 | -2 |
| `src/ui/i18n.tsx` | +6 | 0 |
| `test/zcode-cli.test.ts` | +1 | 0 |
| `src/types.ts` / `src/ui/api.ts` / `src/webui.ts` | +4 | 0 |

### 📁 Files Modified
- `src/codebuddy/{credentials,catalog,request,response,request-context,index}.ts`（新模块）
- `src/gateway.ts`、`src/cli.ts`、`src/config-update.ts`、`src/types.ts`、`src/paths.ts`、`src/request-log.ts`、`src/webui.ts`、`src/ui/{ConfigPage,api,i18n}.tsx`
- `schemas/gateway-config.schema.json`、`README.md`
- `test/codebuddy-{credentials,catalog,request,response,gateway}.test.ts`、`test/webui.test.ts`、`test/zcode-cli.test.ts`

### 验证
- `bun run check`：类型检查 + 395 测试全绿 + 构建（UI 重建、CLI 打包）通过。
- 验收调用（真实积分 x0.14 两次）：非流式返回合法 Responses JSON（`status:"completed"`、output 含 message/text、usage 齐全）；流式事件序列 `response.created → …增量 → response.completed` 且序号连续；请求日志确认上游 URL 与裸 model 透传、authorization 头脱敏、双 token 明文与 JSON 转义形式零泄漏。
- `config --codebuddy off` 后 `/v1/models` 无 codebuddy 条目、请求回落常规路由，入口关闭。

---

# [2026-09-18 追加] | Task: 过滤 CodeBuddy 目录中的服务端档位模型

### 📥 User Query
> 模型选择框出现 Auto/Fast/Balanced/Primary/Deep（default-model 等 5 个档位条目）——把这几个给过滤掉。

### 🛠 Changes Overview
- `src/codebuddy/catalog.ts`：新增 `TIER_MODEL_IDS`（default-model/fast-model/balanced-model/primary-model/deep-model，大小写不敏感），`buildCodebuddyCatalog` 在 serves∩picker 交集阶段跳过档位条目；目录缓存键并入 `CATALOG_SCHEMA_VERSION`（v2），旧缓存整体失效重建。
- 测试：catalog 新增档位过滤用例；gateway 的 workbuddy 用例改用 `gpt-5.6-luna` 并断言档位条目不在 `/v1/models`。
- 文档：README 两处措辞更新（档位被过滤、不再举例 Auto 倍率）；completed 执行计划补记调整说明。

### 验证
- `bun run check`：396 测试全绿。
- 真机：开启开关后 `/v1/models?client_version=…` 的 codebuddy 条目从 17 变为 15，`*-model` 档位零残留（缓存版本升级强制重建），关闭开关恢复默认。
