## [2026-10-16 15:32] | Task: 修复 ZCode 推送模型的视觉能力规则

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> WorkBuddy 的 GPT-6-Luna 应支持视觉，但 ZCode 显示不支持；修复推送配置。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/gateway` 的 ZCode 客户端模型推送、回归测试与原执行计划。

**Key Actions:**
- 将图片能力写入新版 ZCode 实际读取的
  `providerModelRules[].config.properties.inputFormat.supportsImage`。
- 新旧受管规则均同步该布尔值；模型含 `image` 时为 true，纯文本或缺省为 false。
- 未知上下文窗口也创建能力规则；仅省略没有来源的 `contextWindow`。
- 保留已有上下文、其他输入格式开关、推理配置、用户 provider 与手动规则。
- 添加 2 例回归测试，并在 `models-push-clients.md` 更新设计和追加修复记录。

### 🧠 Design Intent (Why)
此前仅在模型定义中写 `modalities.input`，新版 ZCode 的视觉标签和请求校验使用的
运行时规则缺少对应能力值。修复需更新存量规则，且不能因上下文元数据缺失而丢掉
整个能力规则；显式 false 同时避免纯文本模型继承不准确的视觉声明。

### 📊 Change Stats
> 工作区任务开始前已有未提交内容；以下通过 `git diff --no-index --shortstat` 和
> `git diff --no-index --numstat` 对比任务开始时快照，仅统计本次源码、测试与计划
> 增量，不含本历史文件。

- **Files changed:** 3
- **Insertions:** +130
- **Deletions:** -12

| File | +Added | -Removed |
| --- | ---: | ---: |
| `apps/gateway/src/zcode-client-sync.ts` | +29 | -11 |
| `test/models-push-zcode.test.ts` | +83 | -0 |
| `docs/exec-plans/completed/models-push-clients.md` | +18 | -1 |

### 📁 Files Modified
- `apps/gateway/src/zcode-client-sync.ts`
- `test/models-push-zcode.test.ts`
- `docs/exec-plans/completed/models-push-clients.md`

### ✅ 验证与交付
- 新增回归测试先在旧实现上失败，修复后 ZCode 定向测试 9 例通过。
- 覆盖有无上下文、视觉/文本/未知模态、旧规则升级、ID 大小写、同 ID 用户 provider
  隔离、字段保留及重复推送不产生新写入或备份。
- `bun run check` 的边界检查、构建、严格类型检查通过；沙箱内测试因本地监听失败。
- 获准在沙箱外重跑 `bun run test`：1185 例通过，0 失败，测试耗时 28.17 秒。
- 独立代码审查未发现阻塞问题。未修改真实客户端配置；重新执行修复版本的
  `models --push zcode`，确认模型选择后重启 ZCode 读取能力规则。
