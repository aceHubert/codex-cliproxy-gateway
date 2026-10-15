# [2026-10-15 16:12] | Task: opencode-zen 代码级屏蔽 jev 模型家族

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `zai-api/GLM-5.3-FLASHX`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> jev-1.13-free 的 endpoint 不对，需要排除
> 这个不应该通过 exclude，应该在代码里就排除掉

### 🛠 Changes Overview
**Scope:** packages/opencode-zen（catalog.ts）、test/opencode-zen-catalog.test.ts

**Key Actions:**
- **[实测定性]**: 拉线上目录与元数据 + 逐端点实测：jev-1.13-free（元数据无条目的新免费模型）chat 端点 400 ModelProtocolUnsupported，responses/anthropic/gemini 端点一律 403 FreeTierError——chat 是网关唯一注入门禁材料的协议，该模型在网关无任何可用端点。本机缓存里的探针裁决是同日 13:33 门禁抖动期按「门禁全局异常保守保留」规则记下的 `chat-completions`（24h TTL），模型因此挂进目录且转发必失败。
- **[代码级屏蔽]**: catalog.ts 新增 `OPENCODE_ZEN_BLOCKED_MODEL_PREFIXES`（现含 `jev-` 前缀）与 `isOpencodeZenBlockedModel`；`filterOpencodeZenCatalogIds` 在所有路径（元数据权威 / `-free` 宽限 / 元数据降级）之上无条件剔除屏蔽家族，`probeMissing` 跳过屏蔽 id 不再花费真实探针请求。
- **[测试]**: 过滤用例补「门禁抖动期保守裁决也屏蔽」断言（对照组：同批无元数据 `-free` 模型照常宽限）；探针存储用例的 jev 夹具语义拆分为两块——探针翻转/探针失败语义改用中性夹具 `exo-2-free`，jev 断言改为「不暴露、不探测、不受裁决翻转影响」。`bun run test` 1129→1130 全过（本轮改后复跑全绿），typecheck 通过。
- **[配置回收]**: 上一轮临时加进本机 `excludedModels` 的 `opencode-zen/jev-1.13-free` 经 `applyWebUiConfigPatch` 正规路径摘除（44→43 条，其余规则原样保留），网关 launchd 重启后真机验证：`/v1/models` 无 jev（纯代码屏蔽生效），`deepseek-v4.1-flash-free` 同批上线并端到端转发 200。

### 🧠 Design Intent (Why)
jev 家族是「网关结构性不可服务」而非「暂时不可判定」：门禁材料只对 chat-completions 注入，该模型恰好只在上非 chat 端点存在。探针的「门禁抖动期保守保留」规则（防指纹故障期免费池整体误删）决定了它会在每次门禁抖动后被重新放行 24 小时，配置级排除又把正确机制错放在每台机器的用户配置里。按家族前缀放进可见性过滤的代码级屏蔽名单，一条规则覆盖后续 jev-1.14-free 等轮换，且不受探针裁决与门禁状态影响；若上游未来提供正式 chat 支持，删除名单条目即可。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区 vs HEAD），已扣除同文件在途改动的基线（catalog.ts +4/-4、测试 +4/-4）。

- **Files changed:** 2
- **Insertions:** +45
- **Deletions:** -19

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/catalog.ts` | +22 | -3 |
| `test/opencode-zen-catalog.test.ts` | +23 | -16 |

### 📁 Files Modified
- `packages/opencode-zen/src/catalog.ts`
- `test/opencode-zen-catalog.test.ts`
