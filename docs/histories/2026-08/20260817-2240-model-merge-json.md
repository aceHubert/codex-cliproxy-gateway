## [2026-08-17 22:40] | Task: 添加远程模型合并配置

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> 添加 `model_merge_json` 配置，支持 GitHub 仓库或 HTTP(S) 文件地址，并优先使用本地缓存。

### 🛠 Changes Overview
**Scope:** CLI 配置、模型元数据覆盖与运行时缓存

**Key Actions:**
- **配置与缓存**: 保存 `model_merge_json`；GitHub 仓库读取 latest release，HTTP(S) 文件地址直接下载。
- **同步行为**: 显式 URL 强制刷新；缺少缓存时按已保存 URL 下载；无 URL 时回退内置文件。
- **验证**: 覆盖缓存优先、显式刷新、非法 URL、无效内容不覆盖旧缓存和卸载清理。

### 🧠 Design Intent (Why)
*复用现有模型覆盖解析与原子写入能力，避免新增依赖，并确保下载失败不会破坏可用缓存。*

### 📊 Change Stats
> 数据来自本次任务的未暂存差异，已暂存内容为任务开始前基线。

- **Files changed:** 7
- **Insertions:** +183
- **Deletions:** -5

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +21 | -4 |
| `src/catalog.ts` | +48 | -0 |
| `src/cli.ts` | +21 | -1 |
| `src/paths.ts` | +1 | -0 |
| `src/types.ts` | +2 | -0 |
| `test/gateway.test.ts` | +42 | -0 |
| `docs/histories/2026-08/20260817-2240-model-merge-json.md` | +48 | -0 |

### 📁 Files Modified
- `README.md`
- `src/catalog.ts`
- `src/cli.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/gateway.test.ts`
- `docs/histories/2026-08/20260817-2240-model-merge-json.md`
