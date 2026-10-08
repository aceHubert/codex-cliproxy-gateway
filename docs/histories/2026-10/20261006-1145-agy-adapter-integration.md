## [2026-10-06 11:45] | Task: 接入 Antigravity（agy）上游适配器

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3-Flash (zai-start-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 分析本机 antigravity cli 如何调用上游（不实测防封号）写入文档；随后要求以 `agy/` 为前缀、
> 显示名一致、Web UI 增加开关实施接入；令牌只读不更新授权；测试模型用 gemini-3.8-flash、
> 真实 prompt（不发"你好"类）；追问 chat 端点与端点归属后继续。

### 🛠 Changes Overview
**Scope:** `src/agy/`（新增模块）、gateway 路由与目录合并、config 字段与 schema、Web UI 开关、i18n、请求日志命名空间、测试与调研文档

**Key Actions:**
- **[调研]** 静态分析 agy 二进制（protobuf descriptor 还原 v1internal 协议、端点矩阵、headers 清单），写入 `docs/antigravity-cli-upstream-research.md`；全程未发真实请求
- **[实证]** 自签 CA + 本地 CONNECT 代理（MITM）抓取 agy 1.2.17 一次真实会话，实证 UA/`aicode-consumers`/外层 model/camelCase 包装/thinkingConfig 形态，静态推断的三处错误（default-cli-project、snake_case 字段、fetchAvailableModels metadata）被 protojson 400 与抓包否定并修正
- **[凭据]** `src/agy/credentials.ts`：只读 `antigravity-oauth-token`，expiry（RFC3339 纳秒）发送前校验，过期快速失败带刷新指引；绝不刷新、绝不写回
- **[目录]** `src/agy/catalog.ts`：fetchAvailableModels → agentModelSorts 推荐位 + tieredModelIds 并集，剔除 tab/图像/音频专用模型，deprecatedModelIds 旧 id 重定向；6 分钟 TTL（对齐 CLI 轮询）、双指纹磁盘缓存
- **[转换]** `src/agy/request.ts`/`response.ts`：Responses ↔ v1internal streamGenerateContent 全量手写转换（functionCall/functionResponse、custom 工具信封、thought→reasoning 摘要、finishReason/错误分类）；`transport.ts` 白名单 4 header + 实证 UA
- **[接入]** gateway：`agyEnabled`/`isAgyModel` 路由（含 compaction 与 WS 426）、目录合并 `mergeAgyCatalog`、owned_by=agy；config `agy` 字段贯穿 types/schema/config-update；Web UI ConfigPage 开关（`detected.agy` 存在性探测显隐）+ i18n 中英文案；request-log 新增 `agy` 命名空间
- **[验证]** 真实单次调用：`agy/gemini-3.8-flash-high` 200，3929 字符 TIME_WAIT 三问详答，usage 含 reasoning_tokens=1867；stable 通道推理 429 实测故默认 daily 通道

### 🧠 Design Intent (Why)
上游是 Google 内部 REST（v1internal，JSON+SSE），无私有签名，比 Qoder 更简单；真正的难点是线格式全部靠实证——静态 strings 给出的形状被 protojson 逐字段拒绝（`metadata`/`uri` 属未知字段），最终以 MITM 抓包为准。凭据沿用 CodeBuddy「只读消费」红线：agy daemon 负责 1 小时令牌的保鲜，网关过期即失败并指引，杜绝刷新冲突与凭据外发。风险控制：UA/body 指纹与真实 CLI 对齐、requestType 用已验证最小值、目录刷新 6 分钟对齐 CLI 自身节奏、错误白名单不外发正文。

### 📊 Change Stats
> `git diff --shortstat`（agy 相关全量 + 共享文件改动）

- **Files changed:** 17
- **Insertions:** +1002（另有 src/agy/ 与 test/agy-* 新文件共 2263 行）
- **Deletions:** -71

| File | 说明 |
| --- | --- |
| `src/agy/{credentials,transport,catalog,request,response,index}.ts` | 新增 1531 行适配器 |
| `test/agy-{credentials,catalog,request,response,gateway}.test.ts` | 新增 732 行 mock 测试（37 例） |
| `src/gateway.ts` | agy 路由/目录合并/validate/close 四处接线 |
| `src/types.ts` `src/config-update.ts` `schemas/gateway-config.schema.json` | `agy` 配置字段贯穿 |
| `src/webui.ts` `src/ui/{api,ConfigPage,i18n}` | 开关显隐探测与中英文案 |
| `src/request-log.ts` | `agy` 日志命名空间 |
| `docs/antigravity-cli-upstream-research.md` | 调研文档 + MITM 实证修正节 |
| `docs/exec-plans/active/agy-adapter-integration.md` | 执行计划 |

### 📁 Files Modified
- `src/agy/credentials.ts` `src/agy/transport.ts` `src/agy/catalog.ts` `src/agy/request.ts` `src/agy/response.ts` `src/agy/index.ts`
- `test/agy-credentials.test.ts` `test/agy-catalog.test.ts` `test/agy-request.test.ts` `test/agy-response.test.ts` `test/agy-gateway.test.ts`
- `src/gateway.ts` `src/types.ts` `src/request-log.ts` `src/config-update.ts` `src/webui.ts` `src/ui/api.ts` `src/ui/ConfigPage.tsx` `src/ui/i18n.tsx`
- `schemas/gateway-config.schema.json`
- `docs/antigravity-cli-upstream-research.md` `docs/exec-plans/active/agy-adapter-integration.md` `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check`：typecheck + 634 tests（0 fail）+ UI build 全绿
- 真实验证：目录 14 模型；`agy/gemini-3.8-flash-high` 流式 200，完整 Responses 事件链（reasoning summary → output_text → completed）
- 红线自查：凭据/令牌不入日志与响应（交换日志仅 model+stream+status+usage）；URL 不外发；入站授权不透传上游

### 📝 Post-completion Amendment（2026-10-06 12:10）
- 显示名前缀改为大写 `AGN/`（`AGY_DISPLAY_PREFIX`），路由 slug 仍为 `agy/`——对齐 CodeBuddy 的 CB-/WB- 显示标签风格；目录、两处测试断言与执行计划措辞同步更新，`bun test test/agy-*` + webui 81 例全绿，UI 已重建。

### 📝 Post-completion Amendment 2（2026-10-06 复核修复）
外部复核确认 6 项接线缺陷，全部修复并补测试：
- **WS 防护失效**：startGateway 分流门与 responsesWebSocketTarget 均漏 agy，带 routing-hint 的升级请求会被桥接到官方/CPA 上游；两处补齐 + handler 级 426 测试（`agy-http-only`）。
- **帧级族守卫**：`httpOnlyModelFamily` 补 agy（含 realtime 双桥 reject 用例），防 WS 帧内模型名泄漏到错误上游。
- **serve 依赖注入**：补第 8 参 `agyDependencies`（codexModelsCacheFile），models-cache 失效链路生效并补测试（fetched_at 回拨语义）。
- **CLI 面**：`--agy on|off` 全套（usage/AUDITED_FIELDS/DEFAULTS/同版本补键/configCommand 组合校验/models-cache 失效/无参状态输出）+ README Antigravity 小节。
- **小项**：agy_model 死字段移除；AGY/ 前缀大小写归一（归一后命中目录）；safeAgyUpstreamError 显式返回类型；执行计划移入 completed/。
- 新增 `test/agy-config.test.ts`（schema/写入审计/非法值），agy-gateway 补 426/大小写/compaction 用例，webui 探测断言补 agy。
- 复核修复后全量回归：640 tests 0 fail（新增 agy-config 3 例、agy-gateway +3 例、realtime 族 +2 例、catalog 失效 1 例、webui 探测断言、zcode-cli 补键期望更新）。
