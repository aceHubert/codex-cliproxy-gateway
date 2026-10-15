## [2026-10-11 19:51] | Task: 实施 llm-bridge 封装与三协议兼容转换

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3-Flash`
* **Runtime**: `ZCode`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `detached HEAD @ fafd357（worktree llm-bridge-conversion，未提交）`

### 📥 User Query
> 在 worktree 中实施 llm-bridge-conversion-compatibility.md，按 Responses / Chat Completions / Anthropic 的顺序验收兼容性，实施完不要提交等用户验收。

### 🛠 Changes Overview
**Scope:** `packages/llm-bridge`（骨架 → 完整封装）、`packages/plugin-api`（协议类型与端点识别）、五家 agent 包接入、`apps/gateway` 压缩包装边界、测试 6 个新文件与既有回归。

**Key Actions:**
- **llm-bridge 封装（B1/B2）**：以 npm llm-bridge@2.0.1 为底座实现 `convertRequest(from, to, body, options)` 三来源单跳转换（responses/chat-completions/anthropic → 四目标，同协议 structuredClone 直通）；用脱敏探针实测固化 L1–L6、C1/C2 反例并逐项修复（字符串 input 字段、function_call 历史重建、max_completion_tokens、named tool_choice 双向、custom 工具 {input:string} 可逆降级、直通不复活已删工具、instructions-only system、strict 保留）；工具身份（custom/namespace 安全名）在声明/历史/choice 共用一张映射表随结果返回。响应侧实现严格 SSE 解析（CRLF/多行 data/截断报错）、四协议事件归一（reasoning_content/refusal/usage 明细/签名）、`ResponsesOutputShell`（序号连续/快照/一次终态/raw 条目折叠/custom 收尾合同）与三种客户端渲染器（SSE + 聚合 JSON、错误、取消唤醒、计费透传）。
- **plugin-api**：`ClientProtocol` 统一为 `chat-completions | responses | anthropic`，`identifyClientEndpoint` 新增 `/messages`（`/messages/count_tokens` 等子路径不识别）。
- **CodeBuddy**：请求层改经 convertRequest，插件保留服务合同（单一 system、强制上游 SSE、DeepSeek reasoning 信封回放、服务器工具剥离旁白、工具输出图片提升 user、strict 校验）；响应层换桥接渲染器；forward 接受真实 from。
- **Qoder**：请求/响应解除 `@agent-proxy/codebuddy` 依赖，自持 infer 信封解包、排队识别、私有 tool index 重编号、计费提取（credits/billable 经 usage.billing 透传）；旧 codebuddy-reasoning-v1 信封只读回放。
- **ZCode**：请求层按私有项切段（标准段走 convertRequest → anthropic；thinking 信封/web_search_call 回放/服务器调用摘要由插件转换），z.ai web_search_20250305 与 thinking 预算表保持服务合同；响应层以本地帧级归一化替换库 parseAnthropicStream 依赖，新增 `createZcodeClientResponse` 三协议统一入口（多腿/网关工具编排不变）。
- **OpenCode Zen**：删除 `responsesToChatBody` 与 `OpencodeZenClientProtocol`，convert.ts 只剩 convertRequest 单跳 + `renderOpencodeZenClientOutput`；新增 `forwardMessages`（anthropic 协议模型直通、其余转换渲染）。
- **AGY**：请求侧三来源归一化为 Responses 形状复用既有 CloudCodeAssist 构建路径；响应侧新增自产 Responses SSE → chat-completions/anthropic 独立渲染器，零桥接依赖（包依赖与源码静态检查断言调用次数为零）。
- **网关（B4）**：`withCodexCompaction` 仅对 Responses 请求注入压缩包装（chat-completions/anthropic 直通插件）；集成测试覆盖 `/v1/messages` 派发与 `chat-completions` 上下文。

### 🧠 Design Intent (Why)
公共字段/工具/参数损失在桥接层一次性修复（有失败反例佐证），厂商政策（信封、排队、代执行、预算）留在插件前后处理，避免复制 main 时代五家各自手写标准转换的维护面。取消/超时终态经 `shell.terminal + drain` 保序输出，Qoder 空闲超时 504 合同与 main 一致。`/messages` 只做端点识别与派发，default 原协议转发路径不变。

### ✅ Validation
- `bun run check` 全绿：边界检查 + 八包构建 + 严格类型 + 全量测试 1038 项 0 失败。
- 三协议顺序验收为**主题分组冒烟**（Responses 200 / Chat Completions 119 / Anthropic 68 项），不能替代计划要求的逐家三协议 fake-fetch 验收；该缺口在验收评审中指出后补齐：
  - `test/agent-protocol-matrix.test.ts`（11 项）：codebuddy/qoder/zcode 逐家的 chat-completions 与 anthropic 源请求转换 + 非 Responses 客户端方向渲染（fake 上游/信封），并由此发现并修复 ZCode 非 Responses 源 `max_tokens` 未参与上游上限推导的真实缺陷。
  - `test/agy-protocol.test.ts`（7 项）：chat/anthropic 源归一化（system/工具/图片/调用回放）+ 两个独立渲染器流式与非流式输出；由此修复 anthropic 源 `system` 未并入 systemInstruction、以及非流式客户端误拿聚合 JSON 导致渲染层无帧可解的两处缺陷。
  - `test/opencode-zen-gateway.test.ts` 新增 Messages 入口端到端：chat 协议模型转换渲染 + `@ai-sdk/anthropic` 元数据模型直通（协议来自元数据 npm 映射，探针只补元数据外模型）。
  - bridge 层 gemini 方向回归（STOP/MAX_TOKENS/SAFETY → responses 客户端、整包 JSON → chat、SSE → anthropic）、chat 工具 id/name/arguments 分帧关联、anthropic 源不可表达字段 notes。
- 新增测试：`test/llm-bridge-convert.test.ts`（25，含 L1–L6/C1/C2 反例与安全名三处一致）、`test/llm-bridge-response.test.ts`（18，含 gemini 方向与分帧）、`test/llm-bridge-boundaries.test.ts`（5）、`test/agy-protocol.test.ts`（7）、`test/agent-protocol-matrix.test.ts`（11）；zen convert 测试重写为桥接语义。
- 全程未访问真实凭据或上游；所有后台测试 60 秒上限。

### 🔁 验收评审修复（2026-10-11 晚）
验收发现五项问题，全部修复并补回归：
1. **阻断**：gemini `STOP`/`MAX_TOKENS` 未映射结束原因，正常完成被判 `other` 而在渲染层报 502（zen google 模型可达路径）。已映射，gemini 方向回归覆盖。
2. **中等**：responses 目标的调用历史用客户端原始名，与声明/named choice 的映射名不一致（违反 L4 合同）。修复为源规范化阶段（chat/anthropic）与目标重建（responses）统一映射名，客户端可见名由响应侧身份表还原。
3. **中等**：chat 工具 id 与 name 分帧时静默丢弃（空分支）。改为待定调用缓存，name 到达补发 start、先到 arguments 缓存按序补发；流结束仍缺 name 的待定调用显式产出交由严格身份校验拒绝。
4. **轻微**：anthropic 源 thinking/signature/cache_control 跨协议丢弃无 notes。已补显式能力记录。
5. **流程**：逐家三协议 fake-fetch 测试缺口，如上补齐（agy/zen/三家矩阵），并修正本记录的验收表述。

### 📊 Change Stats
> `git diff --shortstat`（不含未提交新增文件的行数，见 numstat 30 文件口径）：

- **Files changed:** 30 tracked + 12 untracked（llm-bridge src 6、测试 5、历史记录 1）
- **Insertions:** +1656
- **Deletions:** -1461

### ⏭ Follow-ups
- 用户验收后：计划已归档至 `completed/`（2026-10-12），交叉引用已同步；按用户要求**未提交**，改动留在 worktree 待后续入库。
- zen chat 同协议非流式聚合仍用插件内聚合器（`aggregateOpencodeZenStreamToCompletion`）；如需统一可切桥接 chat 渲染器（宽松帧策略差异需先确认服务合同）。
- WorkBuddy 品牌名替换、AGY schema 降级报告细化等在计划遗留清单中未变。
