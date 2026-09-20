# [2026-09-19 13:44] | Task: 适配 ZCode 团队套餐凭据

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `fix/zcode-3.12.3-compat`

### 📥 User Query
> 换到 `codex-cliproxy-zcode3123` worktree 实施 `docs/exec-plans/active/zcode-team-plan-adapter.md`。

### 🛠 Changes Overview
**Scope:** codex-cliproxy（ZCode 配置缓存、团队凭据解析、测试与执行文档）

**Key Actions:**
- **[选择模型]**: `readSelection` 继续输出 legacy 路由 providerID，同时保留 `kind` 与团队 `productId`/`organizationId`/`projectId`；team 字段缺失或不可打印时直接报配置错误。
- **[凭据隔离]**: 新增 `zcode/credential-cipher.ts`、`zcode/individual-credentials.ts` 与 `zcode/team-credentials.ts`：分别负责通用 `enc:v1` AES-256-GCM 解密、个人当前账号的 account-provider Key、官方团队项目校验与项目 API Key 读取/缺失创建/secret 复制；个人本地 Key 缺失时回退 config 镜像。
- **[缓存失效]**: 凭据身份包含 family、kind、providerID 与团队三元组；团队凭据文件内容变化会重新解析，选择或文件事件等待刷新期间不提供旧快照，失败后不回退个人 Key 或旧项目 Key。
- **[协议保持]**: 团队上下文只用于本地凭据解析，模型 API 继续使用现有 Anthropic Messages 请求链，不新增团队 endpoint、请求头或请求体字段。
- **[测试]**: 使用互不相同的虚构个人、团队 A、团队 B Key 覆盖切换、创建、加密、失败关闭、团队 `credentials.json` 删除/恢复与上游请求边界。

### 🧠 Design Intent (Why)
ZCode 3.12.3 将个人与团队套餐折叠到同一个模型路由 provider，但两者运行时凭据解析路径不同。只比较 providerID 会让个人切换团队或团队项目切换后继续使用旧快照，最坏情况是请求成功但消耗个人额度。因此路由身份与凭据身份必须分离，并在团队凭据不确定时关闭旧快照。

### 📊 Change Stats
> 数据来自本次工作区 `git diff --shortstat` / `git diff --numstat`，另计入两个新增源文件/计划文件的行数；不包含本 history 文件。

- **Files changed:** 10
- **Insertions:** +907
- **Deletions:** -40

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/config.ts` | +228 | -33 |
| `src/zcode/team-credentials.ts` | +147 | 0 |
| `src/zcode/credential-cipher.ts` | +42 | 0 |
| `src/zcode/individual-credentials.ts` | +34 | 0 |
| `test/zcode-cache.test.ts` | +208 | -3 |
| `test/zcode-gateway.test.ts` | +45 | 0 |
| `AGENTS.md` | +1 | -1 |
| `docs/exec-plans/completed/zcode-team-plan-adapter.md` | +200 | 0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -2 |
| `docs/zcode-team-plan-credential-isolation.md` | +1 | -1 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `src/zcode/credential-cipher.ts`
- `src/zcode/individual-credentials.ts`
- `src/zcode/team-credentials.ts`
- `test/zcode-cache.test.ts`
- `test/zcode-gateway.test.ts`
- `AGENTS.md`
- `docs/exec-plans/completed/zcode-team-plan-adapter.md`
- `docs/exec-plans/tech-debt-tracker.md`
- `docs/zcode-team-plan-credential-isolation.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test test/zcode-cache.test.ts test/zcode-gateway.test.ts`：58 pass / 0 fail。
- `bun run check`：356 pass / 0 fail，UI 与 CLI 构建通过。
- 开发与验收只使用临时目录、虚构凭据和模拟官方接口；未读取真实 `~/.zcode` 凭据、未调用生产接口、未创建远端项目 Key。
