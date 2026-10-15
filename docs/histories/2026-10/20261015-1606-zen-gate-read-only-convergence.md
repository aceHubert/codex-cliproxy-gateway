# [2026-10-15 16:06] | Task: 工具闸终版画像修正——read 唯一必须，合并面收敛为仅 read

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 再确认一下工具貌似必须>=2, 现在是bash 和read对吗，和那个仓库保持的一样？
> https://linux.do/t/topic/2912664 按这个帖子，read是必须的，其它没有关系
> （另附帖子可用 curl：/zen/v1/responses + 最小标头 + 单 read 工具 `{path:{}}`）
> 10/15 更新 似乎又更换了新验证规则……和你分析的应该是一致了，至少一个read tool

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（fingerprint.ts）、scripts/zen-gate-probe.ts、test/（fingerprint/gateway/convert）、docs/fingerprint-data.md、docs/opencode2-zen-free-models-gateway-research.md

**Key Actions:**
- **[画像修正]**: 逐项隔离实测修正早前结论——**`read` 唯一必须**：仅官方 `read` 单件即放行（bash/shell 及数量无关，仅 shell 无 read 仍 403），与 linux.do 2912664 帖子及用户提供的可用 curl（单 read、`{path:{}}` 最小 schema）一致；schema 须**非空**（空 properties 403，官方完整定义与最小形均过）。早前「read+shell 双件」的误判源于把空 schema 反例计入了件数（pad-read-only 当时用的是空占位）。
- **[标头与端点钉死]**: 最小头实验四件 Authorization + UA + `x-opencode-session-id` + `x-session-affinity`；完整指纹集下单缺 affinity 亦放行（标头互备）。帖子内 `/zen/v1/responses` 可用的 curl 为迁移间隙过时信息——复测 chat/responses 双协议全 403，`/zen/v1` 死透。
- **[合并面收敛]**: `GATE_REQUIRED_TOOL_ORDER` 由 `["read","shell"]` 收敛为 `["read"]`（chat 包裹与 Responses 扁平两个合并函数共用），官方 `read` 完整定义按名合并、客户端同名定义优先；模型可见的不可执行官方工具从两件减为一件。
- **[探针重写]**: 13 项画像对照（新增 minimal-read / minimal-read-schema / read-empty-schema / shell-without-read / no-affinity-header），实跑 **13/13 OK**；结论文案与脚本头画像注释同步终版。
- **[测试同步]**: fingerprint/gateway/convert 三组用例改写为 read-only 语义（合并规则、回环调用、身份名单 bash/shell 不入选）；`bun run check` 1130/1130 通过。
- **[真机闭环]**: 网关重启后 curl chat 协议、curl responses 协议、真实 `codex exec` 三路 E2E 全部 200（codex 返回 gateway-ok）。

### 🧠 Design Intent (Why)
工具闸的真实约束比早前判定的更窄：只认 `read` 一个名字 + 非空 schema。据此把合并面收敛到最小——过闸确定性不变（官方完整 read 定义严格强于帖子的最小形），而模型看到的伪官方工具从 read+shell 两件减到一件，进一步降低模型误调不可执行工具的概率；也与仓库「最小伪装面」的一贯取舍一致（10-14 收敛的初衷）。bash/shell 名字不再合并，但客户端自带同名工具原样保留不受影响。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD；fingerprint.ts、探针与测试的差值混有同日早前两任务的改动，本表为当日三任务累计）。

- **Files changed:** 7
- **Insertions:** +304
- **Deletions:** -184

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/fingerprint.ts` | +70 | -32 |
| `test/opencode-zen-gateway.test.ts` | +74 | -72 |
| `scripts/zen-gate-probe.ts` | +47 | -41 |
| `test/opencode-zen-fingerprint.test.ts` | +27 | -26 |
| `test/opencode-zen-convert.test.ts` | +7 | -11 |
| `docs/fingerprint-data.md` | +41 | -1 |
| `docs/opencode2-zen-free-models-gateway-research.md` | +38 | -1 |

### 📁 Files Modified
- `packages/opencode-zen/src/fingerprint.ts`
- `scripts/zen-gate-probe.ts`
- `test/opencode-zen-fingerprint.test.ts`
- `test/opencode-zen-gateway.test.ts`
- `test/opencode-zen-convert.test.ts`
- `docs/fingerprint-data.md`
- `docs/opencode2-zen-free-models-gateway-research.md`
