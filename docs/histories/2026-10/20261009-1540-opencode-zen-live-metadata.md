## [2026-10-09 15:40] | Task: OpenCode Zen 元数据实时化（删除静态模型快照）

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 这个是即时变更了，不应该持久化在本地
> （指 free-models.json 这份从 opencode2 二进制提取的静态免费模型清单）

### 🛠 Changes Overview
**Scope:** `src/opencode-zen/catalog.ts`、`fingerprint.ts`、`index.ts`、`test/opencode-zen-{catalog,fingerprint,gateway}.test.ts`、`docs/`

**Key Actions:**
- **[删除静态快照]**: 删除 `src/opencode-zen/free-models.json`（27 个模型的二进制静态档案）及其全部预置逻辑（`PRESET_ZEN_FREE_MODELS`/`mergeFreeModelIds`/`isFreeZenModel`/预置版 `zenEffortLevels`/`zenContextWindow`）。免费池轮换、窗口、档位全部改取实时源。
- **免费判定改权威]**: `parseZenMetadataResponse` 新增提取 `cost`（免费判定）、`name`（显示名）、`reasoning_options`（effort 档位）；`parseZenModelsResponse` 不再预过滤（该端点不带计费信息，只做形状清洗）；`filterZenCatalogIds` 重写——元数据 cost 为零且未 deprecated 才可见，元数据无条目的新模型只认 `-free` 后缀 + 探针裁决，元数据整体不可用时只信 `-free` 后缀。
- **目录属性全实时]**: `buildZenCatalog(ids, metadata?)` 的显示名、`context_window`、`supported_reasoning_levels`/`default_reasoning_level` 全部取自元数据；无元数据的模型删窗口字段、不暴露档位（保持原中性化行为）。
- **id 源与缓存]**: 动态 `/zen/v1/models` 为权威 id 源，为空时回退元数据免费集；完全无缓存（首启即失败）返回空目录，不用快照充数。磁盘缓存 content_hash 改按**原始 ids** 校验（可见性是读取时派生的结果），旧版缓存文件因此保持兼容。
- **effort 校验注入化]**: `normalizeZenEffort` 与 `injectZenFingerprintBody` 改为接收调用方从 store 实时取的档位值域（`store.effortLevels(id)` 新方法），不再读静态数据。
- **[顺手修复]**: `normalizeZenUpstreamError` 把 403 区域限制（"not available in your country"）从 `zen_free_tier_error` 误分类中拆出，新增 `zen_region_error`——该误分类是技术债记录在案的问题，本次实测 muse-spark 触发后修复。

### 🧠 Design Intent (Why)
用户指出免费模型清单是即时变更的、不应持久化在本地。实测印证：静态快照里 5 个 effort 型模型已被官方 metadata 全标记 deprecated，而实时元数据（models.opencode.ai/api.json，网关本就在按 6h TTL 拉取）覆盖了快照的全部字段且更丰富——免费判定（cost）、名称、窗口（limit.context）、effort 档位（reasoning_options）无一缺失，甚至包含快照里没有的档位值域（muse-spark 的 minimal/low/medium/high/xhigh、space-bunny 的 xhigh/max）。元数据不可用时按「保守少示」处理（只信 -free 后缀、空目录），因为误示付费模型会让用户撞 401，比暂时少几个模型更糟。

### 📊 Change Stats
> 数据来自本次任务工作区改动。

- **Files changed:** 6（含 1 个删除）
- **Insertions:** +289
- **Deletions:** -157

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/opencode-zen/catalog.ts` | +172 | -84 |
| `src/opencode-zen/fingerprint.ts` | +12 | -6 |
| `src/opencode-zen/index.ts` | +17 | -2 |
| `src/opencode-zen/free-models.json` | 0 | -83（删除） |
| `test/opencode-zen-catalog.test.ts` | +296 | -180（重写） |
| `test/opencode-zen-fingerprint.test.ts` | +28 | -24 |
| `test/opencode-zen-gateway.test.ts` | +22 | -6 |
| `docs/`（技术债 + 本记录） | 若干 | — |

### 📁 Files Modified
- `src/opencode-zen/catalog.ts`、`src/opencode-zen/fingerprint.ts`、`src/opencode-zen/index.ts`
- `src/opencode-zen/free-models.json`（删除）
- `test/opencode-zen-catalog.test.ts`、`test/opencode-zen-fingerprint.test.ts`、`test/opencode-zen-gateway.test.ts`
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run check` 全绿（tsc + 726 测试 + 构建）。
- 真实网关实测（临时实例，**零本地快照首启**）：
  - `/v1/models` 两种形状 11 个可见模型，全部带实时窗口；付费模型（claude-opus-5）与 deprecated 模型被剔除；
  - 4 个模型暴露实时 effort 档位（含静态快照里没有的 minimal/xhigh/max 值域）；
  - 区域限制错误正确归类为 `zen_region_error`（文案指向更换网络/换模型，不再误导升级指纹）；
  - 已知可过检的 tool-less/tooled 配方复测仍 200（门禁未变）。
- 旧版磁盘缓存（无 metadata 字段）兼容读取有测试覆盖。

### 📌 Notes
- 遗留项（元数据不可用时无后缀零计费模型暂不示、探针成本、`reasoning_content` 拼写未折叠、透传策略未穷举）已更新至技术债追踪 2026-10-09 行。
- 指纹数据 `fingerprint-data.json`（门禁模板/工具/UA）不在本次清理范围——它服务的是「请求过门禁」，与模型目录数据性质不同，其时效债仍在原条目跟踪。
