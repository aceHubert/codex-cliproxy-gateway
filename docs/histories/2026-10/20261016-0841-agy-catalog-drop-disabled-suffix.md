## [2026-10-16 08:41] | Task: agy 目录同步剔除 -disabled 后缀模型

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/release-action`

### 📥 User Query
> any 的同步需要更新去掉 -disabled 后缀的。（即 agy 目录同步时剔除上游以 `-disabled` 后缀命名的下线模型）

### 🛠 Changes Overview
**Scope:** packages/agy、test

**Key Actions:**
- **[模型过滤]**: `parseAgyCatalogData` 剔除 id 以 `-disabled` 结尾的模型（上游把下线模型保留在目录里以后缀命名）；推荐位/档位引用的同名 id 由既有 selection 重排自然跳过。
- **[重定向过滤]**: `deprecatedModelIds` 的重定向目标若以 `-disabled` 结尾则不产出重定向，避免把可请求的旧 id 指到下线模型。
- **[缓存修订]**: `CACHE_REVISION` 6 → 7，旧磁盘缓存（自洽的 content_hash 不会因过滤失效）经 cache_key 整体失效，下次拉取重建。

### 🧠 Design Intent (Why)
上游 Antigravity 目录把当前下线的模型保留在 models 映射里并用 `-disabled` 后缀命名（如 `gemini-4-argon-disabled`），网关此前原样透传成 `agy/*` 条目，客户端选到即报错。同步（目录构建）时统一剔除，目录里只出现可实际调用的模型。

### 📊 Change Stats
> 数据来自 `git diff --numstat`（工作区未提交改动，仅本任务相关文件）。

- **Files changed:** 2
- **Insertions:** +28
- **Deletions:** -3

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/agy/src/catalog.ts` | +9 | -3 |
| `test/agy-catalog.test.ts` | +19 | -0 |

### 📁 Files Modified
- `packages/agy/src/catalog.ts`
- `test/agy-catalog.test.ts`

### 📌 备注
同一时刻已同步移除 ZCode 本机 `Local` 供应商中的 `agy/gemini-4-argon-disabled` 条目（`~/.zcode/v2/provider_config.json`，修改前有备份）。
