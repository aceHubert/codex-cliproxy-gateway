## [2026-10-16 15:52] | Task: 修复 Zen 目录模态并全量替换客户端模型定义

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feat/model-catalog-push`

### 📥 User Query
> Zen catalog 将全部模型错误地标为纯文本，需要修复。`--push` 必须全量替换模型
> 配置，不是单个模型合并；已删除的模型及过时配置应当移除。

### 🛠 Changes Overview
**Scope:** `@agent-proxy/opencode-zen` 的目录生成与缓存，网关 ZCode/DSH 推送及手册。

**Key Actions:**
- Zen 从官方 `modalities.input` 读取明确声明的 text/image，去重并过滤客户端暂不支持
  的音频、视频和 PDF；缺失或异常时保守按文本，不使用模型名或 attachment 推断。
- 元数据缓存新增可选 `inputModalities`，磁盘读回保留，刷新后生成正确的成品目录。
- ZCode 全量重建受管模型映射、模型规则，清除受管模型手动覆盖，避免旧能力或字段
  残留；无上下文元数据的模型仍生成视觉能力规则。
- DSH 取消按 ID 复用旧模型节点，完整重建受管 `models[]`。
- 两目标均按本次有效清单移除已删除或未选择的模型，同 ID 也更新完整定义；
  供应商连接字段与其他供应商的数据保持。ZCode 原有 deletedModels 过滤保持。
- 更新原执行计划和 CLI 使用手册，明确模型定义全量替换，不逐模型合并。

### 🧠 Design Intent (Why)
Zen 原先把每个模型固定为纯文本，导致客户端无法按目录启用图片输入；同时推送只
替换 ID 清单、复用旧模型定义，使错误能力、旧名称、窗口、推理配置持续残留。
用户明确要求模型配置完整替换，因此每次用当前目录重新生成整份受管模型配置，
并继续沿用写前备份、原子写入与失败回滚。

### 📊 Change Stats
> 通过 `git diff --no-index --shortstat` 与 `git diff --no-index --numstat` 对比本轮
> 开始时的工作区快照，排除已有未提交内容及本历史文件。

- **Files changed:** 8
- **Insertions:** +249
- **Deletions:** -101

| File | +Added | -Removed |
| --- | ---: | ---: |
| `packages/opencode-zen/src/catalog.ts` | +20 | -7 |
| `test/opencode-zen-catalog.test.ts` | +39 | -2 |
| `apps/gateway/src/dsh-client-sync.ts` | +4 | -16 |
| `test/models-push-dsh.test.ts` | +75 | -1 |
| `apps/gateway/src/zcode-client-sync.ts` | +23 | -50 |
| `test/models-push-zcode.test.ts` | +47 | -17 |
| `apps/gateway/README.md` | +3 | -1 |
| `docs/exec-plans/completed/models-push-clients.md` | +38 | -7 |

### 📁 Files Modified
- `packages/opencode-zen/src/catalog.ts`
- `apps/gateway/src/dsh-client-sync.ts`
- `apps/gateway/src/zcode-client-sync.ts`
- `test/opencode-zen-catalog.test.ts`
- `test/models-push-dsh.test.ts`
- `test/models-push-zcode.test.ts`
- `apps/gateway/README.md`
- `docs/exec-plans/completed/models-push-clients.md`

### ✅ 验证与交付
- 先验证回归测试在旧实现失败，再完成修复；目录定向 25 例、ZCode 9 例、DSH 9 例通过。
- 覆盖官方声明解析、异常回退、元数据刷新和磁盘重载、模型删除、同 ID 定义完整
  重建、旧字段与手动覆盖清理、其他供应商隔离、幂等、写前备份及失败回滚。
- 获准在沙箱外运行 `bun run check`，边界检查、构建、类型检查和全部测试通过：
  1189 例，0 失败，测试用时 29.28 秒。
- 独立审查未发现阻塞项。首次交付仅修改代码并验证，未修改真实客户端配置。
- 后续实际生效补验（16:02）：用户指出 DSH 仍只有 text，核对发现后台网关从
  12:13 一直运行修复前实现。重启网关加载新代码后，元数据与成品目录均生成
  正确的 text/image；按当前选择重推 ZCode 58 个、DSH 63 个模型，写前自动备份。
- 真实文件读回：DSH desktop/web 的 Space Bunny 均为 `[text, image]`，ZCode
  运行时规则 `supportsImage: true`；供应商连接字段及其他供应商对比备份均未变化。
  用户确认 Web 已生效，桌面端需完全退出后重开读取配置。本次补验未改源码。
