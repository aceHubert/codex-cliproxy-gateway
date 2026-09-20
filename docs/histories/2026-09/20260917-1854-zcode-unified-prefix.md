## [2026-09-17 18:54] | Task: 统一 ZCode 对外模型前缀为 zcode/

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/codex-api`

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/zcode、src/gateway、test）

**Key Actions:**
- **[目录前缀统一]**: `zcodeModelFamily`（按 slug 区分 `z.ai/`/`bigmodel/`）替换为 `isZcodeModel` 布尔判定，`createZcodeCatalog` 对外统一输出 `zcode/<裸ID>`，`zcodeUpstreamModel` 只剥 `zcode/` 前缀并按 厂商目录∩当前套餐 解析。
- **[渠道判定后移]**: `forward` 的 `family` 改为取自套餐快照 `snapshot.family`（鉴权、上游地址与日志分流逻辑不变），删除旧的「slug 前缀渠道 ≠ 套餐渠道」404 检查；404 文案改为「此模型不属于 ZCode 当前套餐或厂商目录」。
- **[命名空间收敛]**: `mergeZcodeCatalog` 只过滤 base 里 `zcode/` 前缀条目，上游目录的裸 `z.ai/*`、`bigmodel/*` 原样保留（不再被剥离/替换）；`validateZcodeConfig` 保留前缀校验只认 `zcode/`。
- **[owned_by]**: `/v1/models`（无 client_version 形态）中 ZCode 条目的 `owned_by` 统一为 `zcode`。
- **[测试与文档]**: catalog/gateway/request/response/webui/cli 测试全部切到统一前缀；保留前缀校验用例改用 `prefix: "zcode/"`；README 同步对外 ID、保留前缀与 upstream-only 说明。

### 🧠 Design Intent (Why)
模型 ID 不再携带渠道信息：切换 zai/bigmodel 套餐后模型 ID 不变，客户端选择不失效；渠道（决定鉴权与上游）完全由转发时的套餐快照决定。旧前缀无兼容需求，日志命名空间仍按 zai/bigmodel 区分（用户明确要求保留，用于转发通道排查）。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`（未提交的工作区改动）。

- **Files changed:** 10（另含本历史文件）
- **Insertions:** +103
- **Deletions:** -97

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/catalog.ts` | +11 | -12 |
| `src/zcode/index.ts` | +10 | -7 |
| `src/gateway.ts` | +5 | -6 |
| `test/zcode-gateway.test.ts` | +43 | -44 |
| `test/zcode-catalog.test.ts` | +22 | -18 |
| `test/zcode-request.test.ts` | +2 | -2 |
| `test/zcode-response.test.ts` | +1 | -1 |
| `test/webui.test.ts` | +1 | -1 |
| `test/zcode-cli.test.ts` | +1 | -1 |
| `README.md` | +6 | -5 |

### 📁 Files Modified
- `src/zcode/catalog.ts`
- `src/zcode/index.ts`
- `src/gateway.ts`
- `test/zcode-catalog.test.ts`
- `test/zcode-gateway.test.ts`
- `test/zcode-request.test.ts`
- `test/zcode-response.test.ts`
- `test/webui.test.ts`
- `test/zcode-cli.test.ts`
- `README.md`

### ✅ Verification
- `bun run typecheck` 通过。
- `bun test`：345 pass / 0 fail。
- `bun run check`（类型检查 + 测试 + 构建）通过。
