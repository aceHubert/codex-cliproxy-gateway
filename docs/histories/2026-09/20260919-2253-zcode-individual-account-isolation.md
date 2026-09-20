## [2026-09-19 22:53] | Task: 修复 ZCode 个人套餐跨账号复用镜像 Key

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-sol`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 需要（修复个人套餐在账号切换后回退 config.json 镜像 Key 的问题）

### 🛠 Changes Overview
**Scope:** `src/zcode` 与 ZCode 缓存测试

**Key Actions:**
- **账号身份三态解析**：`readZcodeIndividualCredential` 返回 `absent` / `available` / `unavailable`，区分“旧安装没有账号身份”与“有身份但拿不到当前账号 Key”。
- **身份字段修正**：账号身份按 `id` → `user_id` → `email` 顺序解析；ZCode 3.14 实际写的是 `user_info.user_id`，此前只读 `id` 导致永远判定无身份并静默回退镜像。
- **Key 名拼接修正**：`account-provider` 的 provider 段保持明文 `account:<family>-individual-coding-plan`，仅账号 ID 段做 URL 编码，与磁盘实际键名一致。
- **禁止跨账号镜像回退**：账号身份存在但 Key 缺失或不可解密时直接失效，个人套餐报“请在 ZCode 中重新连接当前账号”；仅完全无身份时保留旧安装的镜像回退。
- **账号变化纳入投影**：账号身份进入 `oauthProjection`，同渠道换账号也会触发凭据重建，不再复用上一账号快照。
- **回归测试**：新增“同渠道换账号后不沿用上一账号 Key”和“识别 `user_info.user_id`”用例；更新损坏 `credentials.json` 用例，明确损坏失效、文件缺失才回退镜像。

### 🧠 Design Intent (Why)
个人套餐此前把“无账号身份”和“有身份但 Key 缺失”都折叠为空串，后者会静默回退 `config.json` 的镜像 Key。账号切换后该镜像仍可能属于上一账号，导致请求继续消耗旧账号额度。修复后账号身份是硬边界：能识别身份就必须拿到该身份的 Key，只有完全无身份的旧安装才允许镜像兼容。

### 📊 Change Stats
> 数据来自 `git diff --shortstat -- src/zcode/individual-credentials.ts src/zcode/config.ts test/zcode-cache.test.ts` 与 `git diff --numstat`；历史记录自身不计入。

- **Files changed:** 3
- **Insertions:** +136
- **Deletions:** -30

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/individual-credentials.ts` | 36 | 18 |
| `src/zcode/config.ts` | 25 | 7 |
| `test/zcode-cache.test.ts` | 75 | 5 |

### 📁 Files Modified
- `src/zcode/individual-credentials.ts`
- `src/zcode/config.ts`
- `test/zcode-cache.test.ts`
