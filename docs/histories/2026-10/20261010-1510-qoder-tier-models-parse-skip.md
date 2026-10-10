## [2026-10-10 15:10] | Task: Qoder 聚合档位在目录解析层排除

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `account:zai-individual-coding-plan/GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 🛠 Changes Overview
**Scope:** Qoder 适配器目录解析（`src/qoder/catalog.ts`）与对应测试

**Key Actions:**
- **[解析层排除聚合档位]**: `parseQoderCatalogData` 的跳过条件由仅排除 `auto` 扩展为 `QODER_TIER_MODEL_KEYS` 名单（auto / ultimate / performance / efficient / smodel / cmodel），聚合档位不再进入可选目录与缓存。
- **[缓存修订升级]**: `CACHE_REVISION` 3 → 4，含旧档位条目的磁盘缓存随修订号立即失效重建。
- **[测试补充]**: 目录解析测试的输入补齐全部六个档位 key，断言只有具体模型进入目录。

### 🧠 Design Intent (Why)
用户要求聚合路由档位（Auto/Ultimate/Performance/Efficient/Sonus/Cantus）在代码层面直接排除，不依赖 `excludedModels` 手动规则。排查确认服务端目录数据没有可用的分组信号：`strategies` / `is_sensitive` 在 Kimi/GLM/DeepSeek 等具体模型上同样存在；`inline` 分区在 intl 是 4 个档位、在 cn 却是 13 个具体模型，两地区语义不一致，不能作为判据。因此沿用既有 `auto` 的精确 key 机制扩成名单；服务端新增档位时需在名单补一行（已在常量注释说明）。同步清理了运行时配置中冗余的 5 条 `qoder-*/` 档位排除规则（其余 19 条保留），验证档位拦截完全由代码层承担。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` 与 `git diff --numstat`（工作区未提交改动）。

- **Files changed:** 2
- **Insertions:** +12
- **Deletions:** -4

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/qoder/catalog.ts` | +9 | -3 |
| `test/qoder-catalog.test.ts` | +3 | -1 |

### 📁 Files Modified
- `src/qoder/catalog.ts`
- `test/qoder-catalog.test.ts`
