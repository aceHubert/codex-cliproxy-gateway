## [2026-08-17 20:05] | Task: 实现 model catalog 动态刷新

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 根据既有会话和 `model-catalog-dynamic-refresh-plan.md` 继续完成动态 catalog 功能。

### 🛠 Changes Overview
**Scope:** Codex model catalog 来源、CLI 生命周期和 gateway `/v1/models`

**Key Actions:**
- **动态 catalog**: 移除静态 `model_catalog_json`，将 merged catalog 与 metadata 放入 gateway runtime 目录。
- **native 来源**: 实现 App live、App bundled、CLI bundled、previous cache 四级降级和版本防降级。
- **缓存刷新**: sync 与 uninstall 原子写入过期 `models_cache.json` wrapper。
- **网关响应**: Codex 请求返回完整 catalog，普通客户端返回 OpenAI list，且不访问上游。
- **安全迁移**: 只移除旧安装明确管理的 legacy catalog，保留用户 TOML 修改。

### 🧠 Design Intent (Why)
避免 PATH CLI 与 Desktop runtime 版本不一致导致 native metadata 过期，同时保留显式 sync 的确定性，令 Codex 自己维护有效 cache。

### 📊 Change Stats
> 按本任务补丁统计；重叠文件中既有未提交改动不计入本任务。

- **Files changed:** 10
- **Insertions:** +645
- **Deletions:** -42

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/catalog.ts` | +243 | -3 |
| `src/cli.ts` | +112 | -26 |
| `src/gateway.ts` | +25 | -5 |
| `src/paths.ts` | +4 | -1 |
| `src/types.ts` | +18 | -0 |
| `test/model-catalog-dynamic.test.ts` | +170 | -0 |
| `test/gateway.test.ts` | +14 | -2 |
| `README.md` | +7 | -5 |
| `docs/model-catalog-dynamic-refresh-plan.md` | +5 | -0 |
| `docs/exec-plans/completed/model-catalog-dynamic-refresh.md` | +47 | -0 |

### 📁 Files Modified
- `src/catalog.ts`
- `src/cli.ts`
- `src/gateway.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/model-catalog-dynamic.test.ts`
- `test/gateway.test.ts`
- `README.md`
- `docs/model-catalog-dynamic-refresh-plan.md`
- `docs/exec-plans/completed/model-catalog-dynamic-refresh.md`
