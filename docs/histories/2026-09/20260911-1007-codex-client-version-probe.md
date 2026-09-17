## [2026-09-11 10:07] | Task: 修复 CLIProxy 目录请求固定发送 client_version 0.0.0

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `deepseek-flash`
* **Runtime**: `ZCode Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> `bun run dev models --sync` 后 `opencode-go/deepseek-*` 模型没有 `max` reasoning（后续确认是所有模型都没有）。
> 追问 1：为什么要传 `"0.0.0"`？newapi 适配也不用传 `"0.0.0"`。
> 追问 2：所以是 `officialCache` 移除后成了固定的 `0.0.0`？
> 追问 3：`~/.codex-cliproxy-gateway/models-cache.json` 为什么没更新，是版本一样不写吗？
> 结论要求：这条缓存还是要写；版本获取优先级为 网关 `models-cache.json` > `codex --version` > fallback。

### 🛠 Changes Overview
**Scope:** 目录同步的 client_version 链路（cli / gateway / paths / types），新增 codex-version.ts

**Key Actions:**
- **根因定位**: `models --sync` 与 `install` 向上游请求目录时把 `client_version` 写死为 `"0.0.0"`；CLIProxy 按该版本过滤目录内容，版本过低会静默剥掉 `max`/`ultra` reasoning 等级（实测阈值在 `0.140.0` 与 `0.145.0` 之间，模型总数恒为 52 不变，只有等级变化）。
- **回归来源**: `cef889f`（以 cpa-only 替代静态模式）删除了 last-good 官方缓存及其 loader，调用点的 `officialCache?.clientVersion ?? "0.0.0"` 被内联成 `"0.0.0"`；同时删掉的用例里，剩下的兜底测试恰好断言 `0.0.0`，因此恒真通过。
- **恢复网关侧写入**: `gateway.ts` 新增 `rememberClientVersion()`，在 `/models` 请求携带 `client_version` 时原子写入 `paths.upstreamModelsCacheFile`；路径经 `paths.ts`/`types.ts` 的 `ResolvedPaths.upstreamModelsCacheFile` 供给，`serve` → `startGateway` → `createGatewayHandler` → `catalogModelsResponse` 逐层透传。
- **版本解析链**: 新增 `src/codex-version.ts`，按 `CODEX_CLIPROXY_CLIENT_VERSION` → 网关 `models-cache.json` 的 `client_version` → `codex --version` 探测 → `0.0.0` 依次回退；显式指定的值校验为 `X.Y.Z`，非法值给出可执行报错。
- **接线**: `upstreamClientVersion(paths, type)` 只在 cliproxy 上游解析版本，newapi 保持不传（目录本地合成，与版本无关）；`codex-cliproxy status` 输出 `codexClientVersion` 便于核验。
- **测试守卫**: 新增 `test/codex-version.test.ts`；`test/model-catalog-dynamic.test.ts` 恢复「真实版本贯穿到上游 URL」断言（原先被弱化为断言 `0.0.0`），并新增网关写入断言（写 `client_version`、不带 `client_version` 的请求不覆盖）。

### 🧠 Design Intent (Why)
**目录内容随客户端版本变化，因此版本必须是真实值，而不是常量。** CLIProxy 用 `client_version` 决定下发哪些 reasoning 等级与 `minimal_client_version` 门控，写死 `0.0.0` 等于自报「最老客户端」，代价是所有模型失去 `max`（实测 19 个已选模型中 14 个本应带 `max`）。

**为什么版本来源是网关自己的 `models-cache.json`，而不是 `~/.codex/models_cache.json`**：后者在设了 `model_catalog_json`（upstream-only）时 Codex 走 static manager、根本不请求 `/models`，文件可能不存在；而且它由 `invalidateModelsCache` 刻意写成 `0.0.0` 以标记失效。网关自己在 `/models` 请求里记录客户端的自报版本，既与目录同步走同一条事实来源，也不受上述两种情况影响。

**为什么网关缓存优先于 `codex --version`**：`codex --version` 探测到的是 PATH 上那个二进制，可能是**另一个安装**（本机实测 PATH 为 `0.153.4`、Cursor 扩展自带 `0.153.0`）。拿它当首选可能报出比真实消费者更新的版本，让 CLIProxy 下发客户端接不住的等级；探测因此降为「网关还没记过任何版本，例如首次安装」时的兜底。

**为什么缓存只存版本、不带 native rows**：native rows 每次请求实时获取，其 last-good 回退行为已在 `cef889f` 被有意移除（现行断言是官方刷新失败返回 502）；把整份目录重新持久化会复活无人读取的数据，并让每次 `/models` 轮询都写一份大文件。旧的历史残留文件（带 `models` 字段）仍可被读取——解析只取 `client_version`，0.0.0/非法值视为不可用。

### 📊 Change Stats
> 工作区在相关文件中已有大量未提交改动；下表是相关文件相对 Git 索引的完整差异，包含这些既有改动。本次任务自身新增两个文件（`src/codex-version.ts` 80 行、`test/codex-version.test.ts` 94 行），其余改动集中在调用点与参数透传。

- **Files changed:** 9
- **Insertions:** +711
- **Deletions:** -177

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/cli.ts` | +333 | -107 |
| `test/codex-version.test.ts` | +94 (新增) | -0 |
| `src/codex-version.ts` | +80 (新增) | -0 |
| `README.md` | +74 | -18 |
| `test/model-catalog-dynamic.test.ts` | +44 | -31 |
| `src/gateway.ts` | +40 | -17 |
| `AGENTS.md` | +23 | -0 |
| `src/paths.ts` | +12 | -1 |
| `src/types.ts` | +11 | -3 |

### 📁 Files Modified
- `src/codex-version.ts`（新增）
- `src/cli.ts`
- `src/gateway.ts`
- `src/paths.ts`
- `src/types.ts`
- `test/codex-version.test.ts`（新增）
- `test/model-catalog-dynamic.test.ts`
- `README.md`
- `AGENTS.md`

### ✅ Verification
- `bun run typecheck`、`bun test`（130 pass / 0 fail）、`bun run check` 通过。
- 优先级实测（真实机器、PATH 探测值 `0.153.4`）：缓存写 `0.160.0` → 解析 `0.160.0`（压过探测）；缓存为 `0.0.0` 或缺失 → 解析 `0.153.4`（落到探测）；都以 `CODEX_CLIPROXY_CLIENT_VERSION` 覆盖。
- `codex-cliproxy status` 在真实环境输出 `codexClientVersion: 0.149.0`，即取自网关缓存的历史记录而非 PATH 探测值，验证优先级已生效。
- 实机验收：`bun run dev models --sync` 后同步目录出现 `max`/`ultra`，`opencode-go/deepseek-v4-pro`、`opencode-go/deepseek-v4.1-flash` 等级为 `["high","max"]`，`z.ai/glm-5.3` 为 `["low","high","max"]`，19 个模型中 14 个带 `max`。
- **注意**：记录的写入逻辑需重启网关进程才生效（运行中的进程仍是改动前的代码）；期间读取侧用的是 8/27 的历史记录 `0.149.0`，仍在阈值之上，功能不受影响。
