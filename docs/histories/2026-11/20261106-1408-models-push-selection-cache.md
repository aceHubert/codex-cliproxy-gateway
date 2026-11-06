## [2026-11-06 14:08] | Task: 在配置中保存 models --push 的排除偏好

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`（Git user.name 原值已包含邮箱）
* **Branch**: `fix/qoder-1.1.83-protocol-adaptation`

### 📥 User Query
> models --push 记住上次选择，保存到配置文件。excludedModels 与推送排除独立，都从全部本地插件模型中选择；推送排除字段命名为 latestPushExcludedModels。首次缺少该字段时，以 excludedModels 作为默认值。

### 🛠 Changes Overview
**Scope:** @agent-proxy/gateway、test、CLI 使用手册

**Key Actions:**
- **推送排除缓存**：在当前实例 `config.json` 的 `latestPushExcludedModels` 字段保存取消勾选的模型 ID，所有推送目标共享，与网关排除规则共用已加载配置，不额外读取缓存文件。
- **独立清单**：网关排除与推送排除均从全部本地插件模型中选择；最终推送清单只减去 `latestPushExcludedModels`，选择器和统一写入入口均不再过滤 `excludedModels`。
- **恢复交互**：推送排除的模型默认不勾选，新模型默认选中；暂时失效的既有推送排除偏好继续保留。两个配置字段的编辑与保存互不影响。
- **首次默认值**：仅当 `latestPushExcludedModels` 字段缺失时，使用 `excludedModels` 匹配当前模型，支持精确 ID、大小写不敏感和通配规则。确认后保存独立 ID 列表，即使全选也写入 `[]`；显式空数组不会再次继承，取消首次选择不初始化字段。
- **写入时机**：确认后、客户端推送前备份并原子保存；取消不覆盖，推送失败仍保留排除偏好，排除项未变化不重复写入和备份。
- **配置边界**：同步配置类型与 JSON Schema，加入配置变更审计；通过文件元数据检查拦截选择期间的配置修改，避免常见并发覆盖。
- **原字段保留**：模型命令读取时保留省略的 agent 开关，默认启用语义由插件注册层处理，避免保存选择时写回隐式默认值。
- **回归验证**：覆盖首次精确与通配规则默认、首次取消、空数组持久化、后续网关排除变化不影响推送、两套列表正反向解耦、失效排除保留、新模型默认推送、目标失败、非法字段、实例隔离、Schema、零额外配置读取、备份、并发变更和原子替换失败；真实 CLI 子进程验证省略开关保留。

### 🧠 Design Intent (Why)
减少重复勾选，将推送偏好与网关排除集中在配置文件中管理，同时保持两套过滤完全独立。缓存继承调用级实例路径，避免不同实例混用偏好。推送偏好不影响运行时路由，无需重启服务。

### 📊 Change Stats
> 数据来自 `git diff --shortstat` / `git diff --numstat`，限定本任务的七个代码、规范、测试和手册文件；不含本历史文件及工作区已有改动。

- **Files changed:** 7
- **Insertions:** +431
- **Deletions:** -41

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/README.md` | +16 | -1 |
| `apps/gateway/config.schema.json` | +9 | -0 |
| `apps/gateway/src/cli.ts` | +53 | -19 |
| `apps/gateway/src/models-push.ts` | +4 | -9 |
| `apps/gateway/src/types.ts` | +2 | -0 |
| `test/model-exclude.test.ts` | +6 | -4 |
| `test/models-push.test.ts` | +341 | -8 |

### 📁 Files Modified
- `apps/gateway/README.md`
- `apps/gateway/config.schema.json`
- `apps/gateway/src/cli.ts`
- `apps/gateway/src/models-push.ts`
- `apps/gateway/src/types.ts`
- `test/model-exclude.test.ts`
- `test/models-push.test.ts`

### ✅ Verification
- `bun run test test/models-push.test.ts test/model-exclude.test.ts`：56 项通过。
- `bun run check`：模块边界、构建、严格类型检查和 1314 项测试全部通过。
- 沙箱内首次完整测试因本机端口监听失败而未通过；扩大执行权限后完整检查通过。
- `git diff --check`：通过。
