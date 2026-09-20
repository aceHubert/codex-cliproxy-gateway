## [2026-09-19 22:08] | Task: 修复 ZCode 仅团队套餐时残留个人槽位

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `gpt-5.6-sol`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 参考 LocalQuoteBar 中最新的处理，当前 zcode 中登录的账号没有个人套餐，只有团队套餐

### 🛠 Changes Overview
**Scope:** `src/zcode` 与 ZCode 缓存测试

**Key Actions:**
- **套餐槽位叠加 OAuth 凭证门控**：`readZcodePlanSelections` 在汇总个人/团队连接槽位时读取 `credentials.json`，只有对应渠道仍有 `oauth:<family>:access_token` 时才暴露该槽位；`bigmodel` 不接受 `oauth:zai:access_token` 回退，槽位检查与团队凭据读取保持一致。
- **残留连接不再命中旧 Key**：账号切到仅有团队凭证的渠道后，另一渠道留在 `setting.json` 的个人连接不再回退 `config.json` 的旧个人 Key，而是按“没有可用的个人 Coding Plan 连接”撤下。后续账号身份与个人 Key 的严格隔离见 [22:53 历史记录](20260919-2253-zcode-individual-account-isolation.md)。
- **Start Plan 与 api-key 语义不变**：凭证文件缺失只撤销 OAuth 套餐槽位，损坏或权限问题仍明确报错；Start Plan 仍由 `zcodejwttoken` / billing 资格决定，api-key 仍只跟随当前渠道。
- **凭证变化即时生效**：`credentials.json` 变化时重新解析套餐槽位；删除个人渠道 OAuth 凭证后，已发布的个人槽位会立即撤下。
- **回归测试**：新增“仅团队凭证时个人槽位不可用”“bigmodel 团队槽位不接受 zai 凭证回退”和“个人凭证恢复/删除后槽位热更新”用例，并补齐既有连接形态切换用例的 OAuth 夹具。

### 🧠 Design Intent (Why)
ZCode 3.14 起 `providerFamilyConnectionSelections` 只表达各渠道的连接形态，渠道切换后旧连接可能继续留在磁盘；参考 `LocalQuotaBar` 的最新处理，槽位存在必须叠加对应渠道的 OAuth 凭证存在性。否则账号实际只有团队套餐时，网关仍会暴露个人套餐目录，请求最终命中冻结的个人 Key。

### 📊 Change Stats
> 数据来自 `git diff --shortstat -- src/zcode/config.ts test/zcode-cache.test.ts` 与 `git diff --numstat`；历史记录自身不计入。

- **Files changed:** 2
- **Insertions:** +106
- **Deletions:** -6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/config.ts` | 28 | 5 |
| `test/zcode-cache.test.ts` | 78 | 1 |

### 📁 Files Modified
- `src/zcode/config.ts`
- `test/zcode-cache.test.ts`
