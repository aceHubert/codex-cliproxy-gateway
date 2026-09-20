## [2026-09-19 15:53] | Task: 修复 BigModel 团队目录合并

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-5`
* **Runtime**: `Codex desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 排查当前使用的 BigModel team coding plan 为什么 Codex model catalog 不显示；
> 网关没有合并 `zcode-catalog.json`，个人 coding plan 都能合并。

### 🛠 Changes Overview
**Scope:** ZCode BigModel 团队套餐配置读取与目录快照。

**Key Actions:**
- **OAuth 键名修正**: BigModel 个人与团队凭据改读 `oauth:bigmodel:*`，与本机
  ZCode 3.12.3 实际磁盘布局一致；缓存失效投影同样使用该键名。
- **Team 路由门控修正**: team 选择只从 config 镜像读取 baseURL 与模型字典，
  不再被旧个人 OAuth 镜像的 `oauth_provider_inactive` 拦截；个人套餐仍保留门控。
- **回归测试**: 新增 BigModel team 加停用镜像的复现用例，确认快照能取得模型
  并继续进入 `zcode-catalog.json` 与 `/v1/models` 的交集合并链路。

### 🧠 Design Intent (Why)
`zcode-catalog.json` 启动时已被载入；个人套餐可显示说明合并函数正常。Team 目录
为空是因为 BigModel OAuth 键名解析错误，且旧个人 OAuth 停用状态误拦 team 路由，
导致 `createZcodeCatalog()` 得不到当前套餐模型集合。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`，仅统计本任务 4 个文件，
> 不含本历史记录与并行 `.gitignore` 改动。

- **Files changed:** 4
- **Insertions:** +36
- **Deletions:** -9

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/config.ts` | +6 | -5 |
| `src/zcode/individual-credentials.ts` | +1 | -2 |
| `src/zcode/team-credentials.ts` | +1 | -2 |
| `test/zcode-cache.test.ts` | +28 | -0 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/zcode/individual-credentials.ts`
- `src/zcode/team-credentials.ts`
- `test/zcode-cache.test.ts`
- `docs/histories/2026-09/20260919-1553-zcode-bigmodel-team-catalog.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/zcode-cache.test.ts test/zcode-gateway.test.ts`：59 pass / 0 fail。
- 键名残留修正后复跑 `bun run typecheck` 与 `bun test test/zcode-cache.test.ts`：
  24 pass / 0 fail。
- `bun run check`：440 pass / 0 fail，UI 与 CLI 构建通过。
- 本地只读解密检查确认 BigModel team OAuth 输入可解析。
- 未获生产外呼确认：未重启运行中网关，未请求真实 `/v1/models`，未调用 BigModel
  团队项目接口，也未创建或复制远端 Key。
