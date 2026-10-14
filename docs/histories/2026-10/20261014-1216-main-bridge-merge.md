## [2026-10-14 12:16] | Task: 合入 main 并解决 bridge 协议整合冲突

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 执行 main → codex/llm-bridge-conversion 合并并解决冲突。

### 🛠 Changes Overview
**Scope:** 桥接库、Zen 适配、main 插件产物及发布元数据、转换/打包回归与执行计划。

**Key Actions:**
- **[保存与合并]**: 原有暂存桥接实现经完整检查后保存为 9840884，再合入 main 3723510；解决六个文本冲突文件，保留 main 版本、README、产物常量与目录迁移根链接边界。
- **[公共恢复]**: 公共输出层独立缓冲 custom 包装参数，成功终态后解包并只发送一次正文；普通 function 保留原增量行为，截断或失败不发布补丁。
- **[原生 Responses]**: 支持 custom 增量、输入完成及条目完成的正文恢复和调用关联，保留失败/未完成状态及错误信息；严格拒绝损坏参数、非字符串正文增量和终态后的额外调用。
- **[严格解析]**: 四种上游协议按真实结束信号判断终态；Gemini 保留结束后用量，每个 SSE 请求独立解码 Unicode，避免共享解码状态。
- **[工具身份]**: 仅为实际注入的官方 OpenCode 工具补齐 function 身份，原客户端 custom/namespace 映射优先；未知工具仍拒绝，门禁模板与工具并集保持原行为。
- **[生命周期]**: Zen 将取消与清理传入公共输出器；各客户端流式 final 均能完成，错误与取消有对应结果和错误帧。
- **[发布校验]**: 打包冒烟与桥接 README 改用新公共 API，验证独立安装后的类型、请求转换、目录与响应；不恢复旧兼容接口。

### 🧠 Design Intent (Why)
合并保留公共桥接架构作为唯一标准转换入口，把 main 的 custom 正文、参数校验及断流修复迁入公共层，避免维持两套还原/聚合逻辑。main 的产物边界和发布元数据采用选择性整合，不能以旧 worktree 整文件覆盖。原生 Responses、取消和终态边界需通过实际解析链验证，事件存在或最终 input 正确不足以证明正文 delta 正确。

### ✅ Validation
- 保存原实现前 `bun run check`：1038 项测试通过。
- 最终 `bun run check`：边界、构建、严格类型检查及 78 个文件的 1090 项测试全部通过；单轮测试上限 60 秒。
- `bun run pack:check`：八个公开产物、私包内联、workspace 版本转换、CLI/default、五家目录及 Responses 独立安装冒烟全部通过。
- `git diff --check` 通过，未解决索引为空；独立审查遗留项修复后复核通过。
- 所有上游验证使用模拟输入或临时目录，无生产请求、真实安装或凭据读取；未发布或更新本机服务。
- 执行计划已归档至 `docs/exec-plans/completed/main-into-llm-bridge-conversion.md`。

### 📊 Change Stats
> 来自本次合并提交前相对保存节点 9840884 的 `git diff --cached HEAD --shortstat` 与 `--numstat`；包含 main 引入的变更和本轮整合，排除本记录自身。

- **Files changed:** 60
- **Insertions:** +2569
- **Deletions:** -301

| File | +Added | -Removed |
| --- | ---: | ---: |
| `AGENTS.md` | +1 | -1 |
| `CHANGELOG.md` | +27 | -0 |
| `apps/gateway/README.md` | +4 | -2 |
| `apps/gateway/package.json` | +8 | -8 |
| `apps/gateway/src/cli.ts` | +7 | -5 |
| `apps/gateway/src/default-install-migration.ts` | +45 | -32 |
| `apps/gateway/src/gateway-composition.ts` | +20 | -6 |
| `apps/gateway/src/model-composition.ts` | +6 | -2 |
| `apps/gateway/src/model-state.ts` | +13 | -4 |
| `apps/gateway/src/paths.ts` | +5 | -4 |
| `bun.lock` | +15 | -15 |
| `docs/exec-plans/completed/gateway-plugin-artifact-boundary.md` | +87 | -0 |
| `docs/exec-plans/completed/main-into-llm-bridge-conversion.md` | +50 | -0 |
| `docs/exec-plans/completed/migration-directory.md` | +55 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +0 | -1 |
| `docs/histories/2026-10/20261011-1936-package-readmes-release.md` | +67 | -0 |
| `docs/histories/2026-10/20261011-2348-plugin-artifact-boundary.md` | +58 | -0 |
| `docs/histories/2026-10/20261014-1026-migration-directory.md` | +57 | -0 |
| `docs/histories/2026-10/20261014-1054-zen-custom-tool-response-restore.md` | +54 | -0 |
| `docs/histories/2026-10/20261014-1130-migration-root-link-guard.md` | +49 | -0 |
| `docs/monorepo-migration.md` | +11 | -6 |
| `lerna.json` | +3 | -3 |
| `packages/agy/README.md` | +20 | -0 |
| `packages/agy/package.json` | +3 | -2 |
| `packages/agy/src/catalog.ts` | +5 | -1 |
| `packages/agy/src/index.ts` | +1 | -0 |
| `packages/codebuddy/README.md` | +20 | -0 |
| `packages/codebuddy/package.json` | +3 | -2 |
| `packages/codebuddy/src/catalog.ts` | +8 | -0 |
| `packages/codebuddy/src/index.ts` | +1 | -0 |
| `packages/llm-bridge/README.md` | +22 | -0 |
| `packages/llm-bridge/package.json` | +5 | -4 |
| `packages/llm-bridge/src/events.ts` | +142 | -65 |
| `packages/llm-bridge/src/output.ts` | +134 | -71 |
| `packages/llm-bridge/src/sse.ts` | +2 | -2 |
| `packages/models/package.json` | +1 | -1 |
| `packages/opencode-zen/README.md` | +20 | -0 |
| `packages/opencode-zen/package.json` | +5 | -4 |
| `packages/opencode-zen/src/catalog.ts` | +10 | -2 |
| `packages/opencode-zen/src/convert.ts` | +23 | -0 |
| `packages/opencode-zen/src/index.ts` | +7 | -4 |
| `packages/plugin-api/README.md` | +20 | -0 |
| `packages/plugin-api/package.json` | +3 | -2 |
| `packages/qoder/README.md` | +20 | -0 |
| `packages/qoder/package.json` | +3 | -2 |
| `packages/qoder/src/catalog.ts` | +5 | -1 |
| `packages/qoder/src/index.ts` | +1 | -0 |
| `packages/zcode/README.md` | +20 | -0 |
| `packages/zcode/package.json` | +5 | -4 |
| `packages/zcode/src/index.ts` | +5 | -1 |
| `scripts/pack-check.ts` | +8 | -4 |
| `scripts/verify-package.ts` | +1 | -0 |
| `test/default-install-migration.test.ts` | +293 | -5 |
| `test/gateway.test.ts` | +15 | -22 |
| `test/llm-bridge-events.test.ts` | +303 | -0 |
| `test/llm-bridge-response.test.ts` | +261 | -0 |
| `test/model-state.test.ts` | +3 | -3 |
| `test/opencode-zen-convert.test.ts` | +341 | -0 |
| `test/opencode-zen-gateway.test.ts` | +155 | -6 |
| `test/paths.test.ts` | +33 | -4 |

### 📁 Files Modified
- 逐文件清单见上述 Change Stats。
- 本记录：`docs/histories/2026-10/20261014-1216-main-bridge-merge.md`。
