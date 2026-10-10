# OpenCode Zen 免费模型网关代理接入执行计划

## 目标

在 `codex-cliproxy` 网关中新增 OpenCode Zen（`https://opencode.ai/zen/v1`）免费模型适配器模块，将 Zen 提供的 37+ 款零计费模型作为网关可用上游。实现模型路由标识前缀 `opencode-zen/` 与 UI 显示前缀 `OP-ZEN/`，并在转发层自动注入合规客户端指纹（`User-Agent`、`Authorization`）与基于外部 `X-Session-Id` 的稳定会话绑定（`x-opencode-session`），使外部客户端（Codex CLI、Claude Code 等）能够稳定、透明地消费 Zen 免费模型资源。

## 范围

- **包含**：
  1. **上游适配器模块 (`src/opencode-zen/` 或 `src/zen/`)**：
     - 实现 Zen 免费模型端点请求构造、标头伪装与双向流式/非流式转发。
     - 支持 `User-Agent: opencode/1.18.31`、`x-opencode-client: cli`、默认公共鉴权 `Authorization: Bearer public`（兼顾可选自定义 `OPENCODE_API_KEY` 注入）。
  2. **会话映射与绑定机制 (`resolveOpenCodeSession`)**：
     - 最高优先级：入站请求若已携带合法 `x-opencode-session`，直接透传不作转换；
     - 次高优先级：若携带 `X-Session-Id`（不区分大小写），通过网关 LRU 会话缓存表（TTL 24小时滑动续期）转换为合规格式 `ses_<12_hex_timestamp><14_base62>` 并建立会话绑定；
     - 兜底策略：生成单次合规的临时 session。
  3. **模型目录与前缀规范**：
     - 网关暴露模型 ID 前缀强制统一为：`opencode-zen/<raw_model_id>`（如 `opencode-zen/nemotron-3.5-lightning-free`）。
     - Web UI / 目录元数据中的显示名称前缀强制统一为：`OP-ZEN/<model_name>`（如 `OP-ZEN/Nemotron 3.5 Lightning Free`）。
     - 支持内置预置清单与动态 `/zen/v1/models` 目录合并过滤（优先筛选零计费及带 `-free` 后缀的模型）。
  4. **网关路由与协议接入 (`src/gateway.ts`)**：
     - 在网关模型端口 `/v1/chat/completions` 与 `/v1/models` 中识别 `opencode-zen/` 前缀并分发至 Zen 适配器。
  5. **测试覆盖**：
     - 会话映射器单元测试（包含已有头透传、`X-Session-Id` 绑定转换与格式正则断言）；
     - Zen 适配器请求构造、标头注入与响应处理单元测试；
     - 网关集成端到端路由与模型前缀格式测试。

- **不包含**：
  - 破解或绕过 OpenCode 服务端的 IP 级频率限制（429 `FreeUsageLimitError`）；
  - 模拟 OpenCode 客户端复杂的多轮本地工作区工具执行逻辑（仅代理标准 LLM 推理与 Tool Calling 报文）。

## 背景

- **相关文档**：
  - [docs/opencode2-zen-free-models-gateway-research.md](file:///Users/hubert/Desktop/projects/codex-cliproxy/docs/opencode2-zen-free-models-gateway-research.md)：调研报告、逆向数据与实测验证记录；
  - `schemas/gateway-config.schema.json`：网关配置规范；
  - `src/catalog.ts`、`src/upstream-catalog.ts`：网关目录服务。
- **相关代码路径**：
  - `src/gateway.ts`：网关请求转发与上游分发中枢；
  - `src/catalog.ts`、`src/models.ts`：模型元数据覆盖与注册；
  - 参考已有的单向上游集成模块：`src/qoder/`、`src/agy/`、`src/zcode/`。
- **已知约束**：
  - OpenCode 服务端针对免费模型强制要求合规的 `User-Agent`（版本 $\ge 1.17.0$）和 `x-opencode-session`（30字符特定降序十六进制时间戳结构），缺一不可；
  - 模型 ID 与显示名称必须严格遵循用户的命名规范约定：模型前缀 `opencode-zen/`，显示前缀 `OP-ZEN/`。

## 风险与缓解

| 风险 | 级别 | 缓解方式 |
| :--- | :--- | :--- |
| **官方门禁策略调整**：服务端未来引入人机验证或客户端签名导致 403 `FreeTierError` | 高（实施期已部分兑现：原「仅标头校验」已升级为标头+请求体模板+强制流式三层，详见决策记录 #3） | 明确降级与错误透传提示；指纹数据（UA 版本、内置模板、官方工具集）集中在 `fingerprint-data.json` 单点更新，无需改代码逻辑；错误信息引导使用官方本地 daemon 桥接。 |
| **频控限流 (429 Rate Limit)**：免费额度受每小时请求数或 IP 限频约束 | 中 | 在网关错误响应中标准化返回清晰的限流说明（`zen_rate_limited`），不掩盖上游原始错误语义。 |
| **模型目录轮换下线**：免费模型存在动态轮换，某些模型可能临时下线 | 低 | 动态拉取在线模型列表与预置清单并集；已轮换模型请求由上游明确报错并归一化为 `zen_model_unavailable`（含动态轮换指引）。 |
| **行为污染**：门禁模板（标题生成器/agent 提示词）可能干扰客户端原始指令 | 中（实测已消除） | 「模板在前 + 客户端指令在后」合并注入，实测模型行为由靠后的客户端指令主导；真实上游端到端验证任务回答与工具调用均不受污染。 |

## 里程碑

1. **里程碑 1：核心会话映射与指纹生成器（Session & Fingerprint Engine）**
   - 实现 `createOpenCodeSessionId`、`resolveOpenCodeSession` 及 LRU 滑动续期绑定表。
   - 编写确定性单元测试验证正则 `^ses_[0-9A-Za-z]{26}$`、时间戳反解合理性及 `X-Session-Id` 稳定绑定行为。
2. **里程碑 2：模型目录与前缀规整（Catalog & Prefix Normalizer）**
   - 建立 OpenCode Zen 免费模型列表管理（预置 37 款免费模型元数据）；
   - 实现模型 ID 统一添加 `opencode-zen/` 前缀、显示名称添加 `OP-ZEN/` 前缀转换器；
   - 接入网关 `catalog.ts` 与 `/v1/models`。
3. **里程碑 3：网关转发与协议适配器（Gateway Upstream Adapter）**
   - 实现 OpenCode Zen 上游请求转发器，注入伪装标头与绑定后的 Session ID；
   - 支持 SSE 流式传输与普通 JSON 回包，支持 Tool Calls 结构透传；
   - 错误响应格式归一化（准确转换 403 `FreeTierError` 与 429 限制）。
4. **里程碑 4：端到端验证与文档同步**
   - 运行全量类型检查 `bun run typecheck` 与测试套件 `bun test`；
   - 使用 curl 模拟 Codex 客户端验证端到端转发与会话连续性；
   - 生成改动历史记录（`docs/histories/`）。

## 验证方式

- **自动化测试**：
  ```bash
  bun test test/opencode-zen-session.test.ts      # 12 用例
  bun test test/opencode-zen-catalog.test.ts      # 9 用例
  bun test test/opencode-zen-fingerprint.test.ts  # 7 用例
  bun test test/opencode-zen-gateway.test.ts      # 10 用例
  bun run check # 严格执行类型检查、测试（704）与打包构建
  ```
- **手工检查**：
  1. **已有会话透传验证**：发送带 `x-opencode-session: ses_3a4ee6335ffedFB8f76BPU1Eb3` 的请求，确认上游收到的完全一致未被重写；✅（单测 + 真实上游实测）
  2. **会话绑定验证**：发送两个连续带相同 `X-Session-Id: test-conv-1` 的请求，确认网关向上游转发时使用的 `x-opencode-session` 完全一致；✅（单测断言 + e2e）
  3. **前缀格式验证**：请求网关 `/v1/models`，确认模型 ID 均带 `opencode-zen/` 前缀，显示标签均带 `OP-ZEN/` 前缀。✅（真实网关实测：37 个免费模型两种形状均合规）
- **真实上游端到端（2026-10-08 实测，临时网关 127.0.0.1:8399）**：
  - 流式转发返回真实 SSE（含 reasoning 增量与 `: keep-alive` 注释行透传）；
  - 非流式客户端收到聚合后的完整 `chat.completion` JSON（content/usage/finish_reason
    齐备），行为覆盖生效（模型正确回答任务而非生成标题）；
  - 工具调用往返：模型正确调用**客户端自有**工具 `lookup_issue({"issue":42})`，
    官方工具集仅作门禁在场、未干扰行为；
  - `/v1/responses` 对 zen 模型返回 400 + Chat Completions 指引。

## 进度记录

- [x] 任务 1：创建会话绑定与指纹生成模块及对应测试用例（`session.ts`，12 个用例；
  生成算法按 opencode2 二进制逆向核验修正为 `r = ts*0x1000 + counter`、降序 Hex 取
  `~r` 高 48 位——调研文档原公式缺 counter，与官方真实样例 `...ffe` 结尾不符）
- [x] 任务 2：创建 OpenCode Zen 目录服务与前缀映射逻辑（`catalog.ts` + 预置清单
  `free-models.json`，自 opencode2 内嵌模型库提取 27 个零计费模型含官方名称；与
  `/zen/v1/models` 动态列表取并集，9 个用例）
- [x] 任务 3：实现网关上游适配器与路由分发（`index.ts`/`fingerprint.ts`/`response.ts`；
  门禁实为三层校验，见决策记录 2026-10-08 #3；网关接线 `/v1/chat/completions` +
  `/v1/models` + 配置开关 `opencodeZen`，指纹 7 个用例 + 网关 10 个用例）
- [x] 任务 4：完成全量回归测试与文档历史记录归档（`bun run check` 全绿：类型检查 +
  704 测试 + 构建；真实上游端到端验证见「验证方式」补充）

## 决策记录

- **2026-10-08**：确立命名规范：内部与接口模型 ID 前缀统一为 `opencode-zen/`，UI 与展示层前缀统一为 `OP-ZEN/`。
- **2026-10-08**：确立标头优先级策略：入站已携带合法 `x-opencode-session` 时原样透传不转换；未携带但存在 `X-Session-Id` 时通过内存 LRU 滑动续期表映射绑定到合规的 `ses_` 格式；两者皆无时生成单次临时合规 session。
- **2026-10-08（实施期逆向修正）**：调研文档所述「仅标头指纹」已过时。经 mitm 抓包
  （opencode2 beta-19086）与上游逐项隔离实验实证，门禁为三层：
  1. **标头层**：UA 须为新四段式 `opencode/<channel>/<version>/<clientName>`（旧式
     `opencode/1.18.31` 已失效）；须回填 `x-session-affinity`/`x-session-id` 同 session
     值、任意稳定 40-hex 的 `x-opencode-project` 与 W3C `traceparent`/`b3` 追踪头；
  2. **请求体层**：首条 system 消息须完整包含官方内置提示词模板（逐字符匹配，改一
     词即 403，其后追加自定义内容不影响）。无工具流量用标题生成器模板 + 中性行为
     覆盖；带工具流量必须用 agent 模板且 tools 内含足量官方工具定义（允许追加与
     裁剪，客户端同名定义优先）。实施为「模板在前 + 客户端指令在后」的合并注入
     （实测靠后指令主导模型行为，行为污染已消除）；
  3. **传输层**：上游仅接受 `stream: true`（非流式一律 403），因此非流式客户端由
     网关强制上游流式并在本地聚合 SSE 为完整 chat.completion JSON（`response.ts`）。
  模板、工具集与客户端版本集中在 `fingerprint-data.json` 单点维护。
- **2026-10-08（实施期）**：目录采用「动态优先 + 预置兜底」并集策略：公开
  `/zen/v1/models` 无计费元数据，免费判定 = `-free` 后缀 ∪ 预置零计费清单（含
  `grok-code`、`big-pickle` 等无后缀零计费模型）∪（若提供）cost 字段为零。
- **2026-10-08（实施期）**：`/v1/responses` 对 `opencode-zen/` 模型明确 400 拒绝并
  指引 Chat Completions，避免带前缀模型 id 落入通用转发后被上游误判。
