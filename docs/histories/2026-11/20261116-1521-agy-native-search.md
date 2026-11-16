## [2026-11-16 15:21] | Task: 接入 AGY 原生搜索并阻止搜索请求误转默认上游

### 🤖 Execution Context
* **Agent ID**: `codex`（主实现及并行协议核查、路由、闭环与测试）
* **Base Model**: `GPT-6 系列（会话未提供具体变体）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`（user.name 本身含邮箱，此处去重展示）
* **Branch**: `fix/agy-reasoning`

### 📥 User Query
> AGY 可以适配 search_web 吗？先适配 agy。
> 背景：Orchestrator 查询天气时，Codex 独立 alpha/search 携带本地 AGY 模型名误送 CLIProxy，返回 auth_not_found；动态模式也可能误送官方。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/agy`、`@agent-proxy/plugin-api`、网关搜索分发。

**Key Actions:**
- **[真实协议]**: 用官方 CLI 1.5.9 和公开查询确认搜索使用目录的 webSearchModelIds，而非会话模型；调用 Google generateContent，requestType=web_search、googleSearch 工具，响应含 grounding 来源与引用。仅记录脱敏结构，未记录认证头或令牌。
- **[公共契约]**: 新增可选 handleSearch/SearchRequestContext/dispatchSearch。网关在两种模式下先将 alpha/search 派发给本地插件；未实现或禁用时明确 501，排除模型 404，不回退其他供应商。普通模型保留原路由与原始压缩体。
- **[AGY 独立入口]**: 使用官方搜索模型和 AGY 凭据，处理网页查询及明确标注的天气网页检索。返回 output/results/encrypted_output:null，校验引用、跳过思考、按 UTF-8 偏移插入标记，来源 URL 去掉 query/hash 并拒绝 userinfo/非法协议。
- **[模型内置搜索]**: 将 web_search 声明转换为网关保留函数，在服务器执行搜索并带签名回填 functionResponse，继续原模型推理；生成 web_search_call 事件和最终回答，不交给客户端执行内部函数。工具闭环使用 agent 请求类型，搜索使用 web_search。
- **[边界]**: 最多四次并遵守更小 max_uses；禁用联网或仅缓存模式拒绝执行。域名/时效以查询表达式表达，地区/上下文/长度以提示传递，不宣称原生精确过滤或 token 预算。混合服务器搜索与客户端函数时，先缓冲客户端调用，确认无混合才外发。
- **[缓存与安全]**: 目录持久化搜索模型并从普通选择器排除专用模型；缓存修订 13。插件边界移除客户端 OAuth/API key/Cookie，搜索日志仅记录状态/计数，不记录查询或令牌。取消传递到 Google 请求和后续模型轮次。

### 🧠 Design Intent (Why)
Codex 工具搜索与模型推理是独立协议，不能把所有请求仅按普通生成端点路由。搜索必须由归属插件明确声明和执行，能力未知时不能静默借用其他供应商。本轮仅实现 AGY，其他插件不会因公共入口存在而被误标为支持。

### 📊 Change Stats
> 前序思考级别改动已在本轮开始前暂存，保持不动。下列统计来自本轮工作区相对索引的 `git diff --shortstat` / `git diff --numstat`：11 files changed, 308 insertions(+), 21 deletions(-)。另计六个新源码/测试文件共 1296 行；不含调研报告、执行计划、本历史及债务记录。

- **Files changed:** 17
- **Insertions:** +1604
- **Deletions:** -21

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/gateway.ts` | 64 | 1 |
| `packages/agy/README.md` | 16 | 0 |
| `packages/agy/src/catalog.ts` | 19 | 10 |
| `packages/agy/src/index.ts` | 74 | 1 |
| `packages/agy/src/request.ts` | 57 | 2 |
| `packages/agy/src/response.ts` | 32 | 3 |
| `packages/agy/src/transport.ts` | 6 | 0 |
| `packages/agy/src/search.ts`（新增） | 221 | 0 |
| `packages/agy/src/search-loop.ts`（新增） | 164 | 0 |
| `packages/plugin-api/README.md` | 5 | 0 |
| `packages/plugin-api/src/registry.ts` | 22 | 1 |
| `packages/plugin-api/src/types.ts` | 10 | 0 |
| `test/agy-request.test.ts` | 3 | 3 |
| `test/agy-search.test.ts`（新增） | 199 | 0 |
| `test/agy-search-gateway.test.ts`（新增） | 284 | 0 |
| `test/agy-native-search-loop.test.ts`（新增） | 238 | 0 |
| `test/plugin-search-routing.test.ts`（新增） | 190 | 0 |

### 📁 Files Modified
- `packages/agy/src/{catalog,index,request,response,transport,search,search-loop}.ts`
- `packages/plugin-api/src/{types,registry}.ts`
- `apps/gateway/src/gateway.ts`
- `packages/agy/README.md`、`packages/plugin-api/README.md`
- 搜索及请求回归测试、调研、执行计划与债务记录。

### ✅ Verification
- 官方 CLI 公开查询原生搜索返回 200；脱敏结构确认独立模型、googleSearch、groundingMetadata。
- 新适配器真实 alpha/search 验收：200、七条来源、引用对应；出网仅 Google。
- Hydrogen 真实 Responses 验收：completed，web_search_call + message，无客户端函数泄漏；签名与结果回填后继续同模型。
- Orchestrator 独立搜索已验证；额外主模型闭环验收经历一次续轮失败及一次超时，不将其算作成功证据。
- `bun run check`：Lint、边界、构建、类型检查和 1432 项测试全部通过，0 失败；测试进程仍有 60 秒上限。
- 独立只读复核通过，无阻断问题；已明确 Alpha 命令覆盖与地区/上下文尽力遵循的范围，后续引用读取已登记技术债。执行计划已归档。
- 未提交、未修改生产配置、未重启服务；运行生效需要更新构建并刷新目录/重启网关。

### ⚠️ Explicitly Deferred
- Alpha 的 open/click/find/image_query/finance/sports 等操作不在本轮范围，明确 501；引用打开后续单独适配，已记入技术债。
- 真实原生接口尚无已验证的精确地区/上下文预算参数，仅提供搜索提示；未伪称完整 Alpha Search 兼容。
