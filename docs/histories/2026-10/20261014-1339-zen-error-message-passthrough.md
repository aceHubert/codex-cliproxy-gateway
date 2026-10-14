## [2026-10-14 13:39] | Task: Zen 上游错误改为透传 message，取消硬编码修复指引

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `运行时未向 agent 暴露精确模型 id（Codex 桌面应用内会话）`
* **Runtime**: `Codex Desktop App`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 现在调用 zen 免费模型报 `unexpected status 403 FreeTierError：……请升级网关的 Zen 指纹数据或改用本地 opencode 客户端`；「我还有没执行完策略变更，怎么现在就调用不了」。随后追问：错误提示是不是不要转换，直接把 message 反馈回来就好，没有 message 再给统一提示——否则会因为上游修改而提示不正确。

### 🛠 Changes Overview
**Scope:** `packages/opencode-zen`（上游错误归一化）、`test/opencode-zen-gateway.test.ts`

**Key Actions:**
- **[归一化改为透传]**: `normalizeOpencodeZenUpstreamError` 由「分类 + 硬编码指引文案 + 附上游详情」改为「分类 + 原样透传上游 message」；分类逻辑抽出为 `classifyOpencodeZenUpstreamError`，优先看上游结构化 `error.type`，再退到报文关键词与状态码。
- **[去掉 403 一律算门禁]**: 不再 `if (status === 403 || freetier)` 全兜进 `zen_free_tier_error`；`server_error` / `Endpoint is unavailable` 归为 `zen_model_unavailable`，`RegionError` 归 `zen_region_error`，`FreeTierError` 才归门禁。
- **[中性兜底文案]**: 新增 `ZEN_ERROR_FALLBACK`，仅在上游没给描述时使用，只述事实、不含「升级指纹数据」这类会随上游漂移而失效的修复指引（同时消除旧文案里 monorepo 迁移前的 `src/opencode/` 旧路径）。
- **[边界收紧]**: `parseUpstreamError` 对 `null`/标量报文走原文分支（取属性不再可能抛错），且解析未截断的原文、仅在失败时截断到 300 字符；JSON 合法但无描述时返回空串交兜底，不透裸 JSON 给客户端。
- **[测试改写]**: 三处断言由匹配旧文案（`/指纹数据/`、`/限频/`、`/动态轮换/`）改为断言透传的上游原文；新增「403 server_error 不归为门禁失效」用例与「无描述 JSON / 标量报文」两条边界断言。

### 🧠 Design Intent (Why)
排查依据是对照实验而非代码推断：同一套指纹打 `space-bunny-free` 时探针 10/10 放行（含 M1 半成品形态与官方模板+12 工具的回退形态），打 `cat-jam-free` 时**连回退形态都被拒**，报文是 `server_error: Upstream request failed: Endpoint is unavailable.`——即与请求形态无关，该模型上游端点已失效。用户当时的 11:09 `serve` 进程加载的是改动前的注入实现，也排除「M1 未执行完导致」的猜测。

旧归一化把任何未被 region 分支吃掉的 403 都归成门禁失效，并附上一句「升级网关的 Zen 指纹数据」，把用户引向错误的修复方向。硬编码指引的前提是「上游错误语义与修复动作稳定」，而 Zen 无协议承诺、门禁五天内已漂移过一次，这个前提不成立；上游原文（`Endpoint is unavailable` / `not available in your country` / `too many requests`）自述已足够具体。据此采纳透传方案：网关只保留机器可用的 `type` 分类与人话兜底，排查方向交由 `scripts/zen-gate-probe.ts` 单点承接（对照组失败才是指纹本体过期）。本次只动文案层，不动 M1 的指纹与目录实现，`zen-gate-fingerprint-reduction` 计划状态保持「进行中」。

已知同类残留（本次未改，留待后续）：`classifyOpencodeZenProbeSignal` 仍把非 `freetier` 的 403 判为 `served`，因此失效模型（缓存裁决 `cat-jam-free: chat`，10-13 起未过期）不会进 `drop`、继续出现在可见目录；这是「选到死模型」的上游原因，独立于文案错误。

### 📊 Change Stats
> 口径说明：`packages/opencode-zen/src/index.ts` 与 `test/opencode-zen-gateway.test.ts` 工作区里同时含有 `zen-gate-fingerprint-reduction` M1 的未提交改动，`git diff HEAD` 无法分离两者，下表为两文件合并统计；本次任务的写入集中在归一化函数块及其辅助函数、以及对应的三个测试用例。

- **Files changed:** 2
- **Insertions:** +136
- **Deletions:** -75

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/index.ts` | +84 | -54 |
| `test/opencode-zen-gateway.test.ts` | +52 | -21 |

### 🧪 验证
- `bun test test/opencode-zen-gateway.test.ts` → 25 pass / 0 fail；`bun test test/opencode-zen-*.test.ts` → 86 pass / 0 fail（6 个文件）。
- `cd packages/opencode-zen && bun run typecheck` → 通过；`bun run build` 后产物内已无「升级网关的 Zen 指纹数据」运行时字符串。
- 真实报文回放（`bun -e` 调 `normalizeOpencodeZenUpstreamError`）：
  - `403 server_error` → `zen_model_unavailable` / `Upstream request failed: Endpoint is unavailable.`
  - `403 FreeTierError` → `zen_free_tier_error` / `OpenCode's free tier can only be used from within OpenCode`
  - `403 RegionError` → `zen_region_error` / `This model is not available in your country`
  - `429 FreeUsageLimitError` → `zen_rate_limited` / `too many requests`
- 门禁复测：`bun scripts/zen-gate-probe.ts`（space-bunny-free）10/10 OK；`--model cat-jam-free` 对照与回退形态均 `server_error` 403。
- 未执行 `bun run check`：M1 改动仍在工作区进行中，全量构建+测试属该计划 M3 里程碑。

### 📁 Files Modified
- `packages/opencode-zen/src/index.ts`
- `test/opencode-zen-gateway.test.ts`
- `docs/histories/2026-10/20261014-1339-zen-error-message-passthrough.md`（新增）

### 🔁 补充验证与勘误（2026-10-14 15:30，另一会话）

- **官方客户端对照实证**：本机 opencode2（beta-19086，即 10-08 抓包参考客户端）`run -m opencode/cat-jam-free` 返回与网关一致的 `403 "Upstream request failed: Endpoint is unavailable."`（官方侧还把它归类为 `provider.auth`，进一步佐成透传设计）；同客户端调 `space-bunny-free` 正常返回 `ok`。
- **勘误**：本文「该模型上游端点已失效 / 已下线」的定性有误——`cat-jam-free` 是**上新中的测试模型**（动态 ids 在册、元数据 `deprecated:false` 且 `free:true`，用户确认测试上新；门禁次序实证：无垫补请求先被 FreeTierError 拦、垫补请求过门禁后才收到 server_error，说明已路由到该模型后端、仅后端未就绪）。探针默认保留其为 `served`/可见是正确行为，不应按死模型剔除；曾据此误登的技术债行（探针信号分类）已同日撤销。
