## [2026-10-15 23:28] | Task: CodeBuddy 凭据列表内存缓存与请求路径过期重试

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/release-action`

### 📥 User Query
> 网关应该做一个缓存，只有 —switch 和 web 调用做实时，调用变更缓冲错了也会重试机制。补充：要解决 intl/cn 同时调用的问题，但也不影响，只是可用列表缓存，从缓存列表中选择。账号切换清缓存，只在内存中。

### 🛠 Changes Overview
**Scope:** packages/codebuddy、test

**Key Actions:**
- **[缓存化凭据列表]**: `createCodebuddyCredentialCache.forProduct` 不再每次选取前全量重扫认证目录，改为直接在内存缓存快照上按 profile 选取（intl/cn 各自独立成条，同时调用互不影响）。
- **[新增 refresh()]**: `CodebuddyCredentialCache` 接口新增 `refresh(): void`，同步强制重扫并更新内存缓存，作为正确性兜底。
- **[watch 加强]**: `reconcileWatcher` 在目录 inode 变化重建 watcher 时主动补一次去抖重扫，弥补目录删除重建场景。
- **[请求路径重试]**: `forward()` 把"选取凭据 → 上游调用"包进最多两轮循环：凭据错误（缺登录/临近过期）触发 refresh 后重选一次；上游 401/403 触发 refresh，仅当 token 因此变化才重发上游，未变化视为确定性失败直接透传。
- **[目录刷新容错]**: catalog store 的 `credentials()` 回调对单个产品的凭据错误先 refresh 重试一次再跳过。
- **[错误优先级调整]**: `forward()` 中模型名 400/404 校验与请求翻译提前到凭据选取之前，坏请求不再依赖登录状态返回稳定错误码。

### 🧠 Design Intent (Why)
原实现每次模型请求都同步重扫并解析全部 `.info` 文件（正确性不依赖 fs.watch）。凭据列表实际只有几 KB、变更频率低，改为常驻内存快照后：请求热路径零文件 I/O；fs.watch（100ms 去抖）作为提前触发保持缓存新鲜；请求路径在发现缓存过期（凭据错误或上游 401/403）时 refresh + 重试一次，覆盖 watch 事件丢失/未达的场景。CLI `--switch` 与 Web UI 账号列表走独立的实时全扫函数（`listCodebuddyAccounts` / `codebuddyAccountLabel`），保持实时语义不变；账号切换（launchd 流程）通过进程重启重建缓存。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（工作区未提交改动）。

- **Files changed:** 4
- **Insertions:** +293
- **Deletions:** -47

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/codebuddy/src/credentials.ts` | +35 | -19 |
| `packages/codebuddy/src/index.ts` | +57 | -16 |
| `test/codebuddy-credentials.test.ts` | +91 | -8 |
| `test/codebuddy-gateway.test.ts` | +110 | -4 |

### 📁 Files Modified
- `packages/codebuddy/src/credentials.ts`
- `packages/codebuddy/src/index.ts`
- `test/codebuddy-credentials.test.ts`
- `test/codebuddy-gateway.test.ts`

### 📌 Known Boundaries
- 无 launchd 时热切换 `codebuddyAccount` 不会重建运行中的插件（组合层"构造前固定运行态快照"的既有设计，非本次引入）：缓存列表不受影响，锁定值仍需重启生效。
- 目录被删除后缓存暂留旧凭据，选取不报错；陈旧凭据由上游 401/403 重试兜底，refresh 后进入失败态并返回带指引的 503。
