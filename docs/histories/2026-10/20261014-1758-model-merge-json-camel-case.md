## [2026-10-14 17:58] | Task: 将模型覆盖来源配置重命名为 modelMergeJson

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `codex/llm-bridge-conversion`

### 📥 User Query
> 重构成 modelMergeJson，不需要做历史兼容；将修改移到与主聊天相同的 worktree。

### 🛠 Changes Overview
**Scope:** 网关配置、目录覆盖下载、CLI、Schema、测试及需求文档。

**Key Actions:**
- 将 model_merge_json 配置键统一重命名为 modelMergeJson，同步类型、Schema、读取、写入、审计和错误文案。
- 默认安装目录迁移只处理新键，不增加旧键别名、读取回退或自动改名逻辑。
- 保留命令行选项 --model-merge-json，并验证其写入新键、审计 URL 继续脱敏。
- 补充新键规范校验及旧键不迁移、不触发下载的回归测试。
- 改动迁入主聊天使用的 llm-bridge-conversion worktree，保留其中已有修改，并撤回原分支中的本次改动。

### 🧠 Design Intent (Why)
配置字段统一采用驼峰命名。按用户要求直接切换到新键；已有覆盖文件的缓存优先策略保持不变，不对旧配置键增加兼容行为。

### 📊 Change Stats
> 数据来自目标 worktree 修改前快照与迁移后的 git diff --no-index --shortstat / --numstat；不计本记录及原有未提交改动。

- **Files changed:** 10
- **Insertions:** +44
- **Deletions:** -19

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/schemas/gateway-config.schema.json` | +1 | -1 |
| `apps/gateway/src/catalog.ts` | +4 | -4 |
| `apps/gateway/src/cli.ts` | +3 | -3 |
| `apps/gateway/src/default-install-migration.ts` | +1 | -1 |
| `apps/gateway/src/types.ts` | +1 | -1 |
| `apps/gateway/src/upstream-catalog.ts` | +1 | -1 |
| `docs/requirements/codex-gateway-monorepo.md` | +1 | -1 |
| `test/bundled-model-overrides.test.ts` | +27 | -2 |
| `test/default-install-migration.test.ts` | +2 | -2 |
| `test/model-catalog-dynamic.test.ts` | +3 | -3 |

### ✅ Validation
- 原目录 bun run check 通过：边界检查、完整构建、类型检查及全部 992 项测试通过。
- 目标 worktree 的模型覆盖、默认安装迁移与动态目录专项测试共 40 项通过。
- 目标 worktree 全量类型检查存在过时字段引用错误；使用修改前快照进行只读编译对比，迁移前后均为 102 项诊断，无新增错误。
- 目标增量经快照对比仍为 10 个文件、44 行新增、19 行删除，原分支中的本次改动已全部撤回，其它任务的文件保持原样。
- git diff --check 通过；业务源码中不再引用旧键，测试只保留验证不兼容所需的旧键输入。

### 📁 Files Modified
- 网关的配置类型、Schema、目录覆盖加载与下载、CLI 和默认安装目录迁移模块。
- 三份模型目录与安装迁移测试，以及需求文档。
- 本历史记录。
