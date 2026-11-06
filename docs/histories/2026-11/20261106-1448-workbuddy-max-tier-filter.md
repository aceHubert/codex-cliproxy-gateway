## [2026-11-06 14:48] | Task: 默认过滤 WorkBuddy 的 max-model 档位

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`（Git user.name 原值已包含邮箱）
* **Branch**: `fix/qoder-1.1.83-protocol-adaptation`

### 📥 User Query
> WorkBuddy 的 max-model 应在代码层面默认排除，并说明目前已经排除哪些模型，例如 auto。

### 🛠 Changes Overview
**Scope:** @agent-proxy/codebuddy、目录回归测试、插件使用说明

**Key Actions:**
- **档位清单**：在 CodeBuddy/WorkBuddy 共用档位过滤集合中加入 `max-model`；现有六项为 `default-model`、`auto`、`fast-model`、`balanced-model`、`primary-model`、`deep-model`。
- **缓存读取**：验证原缓存内容指纹后应用当前档位过滤规则；离线目录读取与刷新失败回退均不会重新展示旧缓存中的档位项。
- **精确匹配**：按完整 ID 且不区分大小写过滤，保留 `max-model-v2` 等不同 ID。
- **回归验证**：覆盖两个产品与两个地域的构建过滤，以及 WorkBuddy 两地域旧缓存的零网络读取和失败回退。

### 🧠 Design Intent (Why)
服务端自动选模档位与具体模型不应混在网关目录中。仅修改构建规则无法立即影响只读缓存的 `models --push`，因此读取已有有效缓存时也应用当前过滤规则，保持目录刷新与离线读取的一致性。

### 📊 Change Stats
> 数据来自限定本任务三个源码、测试和说明文件的 `git diff --shortstat` / `git diff --numstat`；不含本历史文件及其他任务已有改动。

- **Files changed:** 3
- **Insertions:** +62
- **Deletions:** -8

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/codebuddy/README.md` | +4 | -0 |
| `packages/codebuddy/src/catalog.ts` | +7 | -4 |
| `test/codebuddy-catalog.test.ts` | +51 | -4 |

### 📁 Files Modified
- `packages/codebuddy/README.md`
- `packages/codebuddy/src/catalog.ts`
- `test/codebuddy-catalog.test.ts`

### ✅ Verification
- `bun run test test/codebuddy-catalog.test.ts`：35 项通过。
- `bun run check`：模块边界、构建、严格类型检查和 1315 项测试全部通过。
- `git diff --check`：通过。
