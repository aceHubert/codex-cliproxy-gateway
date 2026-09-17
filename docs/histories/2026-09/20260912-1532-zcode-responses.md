## [2026-09-12 15:32] | Task: ZCode 接入 Codex Responses

### 🤖 Execution Context
* **Agent ID**: `Codex`
* **Base Model**: `GPT-6（宿主未公开具体主模型型号）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `HEAD`

### 📥 User Query
> 将旧 Claude Code /zai 入口改为 Codex Responses→Anthropic；使用 llm-bridge；配置 zcode:boolean；按 ZCode 当前 provider、套餐模型列表和厂商预设合并目录，忽略模型大小写；监听三文件且无关变更不重建 Key；增加 zcode-catalog.json 和渠道日志；提供 config --zcode on/off。随后按“只有api请求”补齐套餐鉴权、来源/会话头、正文缓存与上游头日志，不新增控制面、签名或验证流程。

### 🛠 Changes Overview
**Scope:** Bun/TypeScript CLI 网关

- **配置与缓存**：三文件分别根目录优先/缺失回退v2；只比较当前选择、provider及相关授权投影；100ms防抖+500ms上限，同值Key不重建/不延期；实际JWT exp到期共享重读。
- **目录与路由**：共享裸ID磁盘缓存，按套餐models字典键与厂商预设取交集，大小写不敏感；对外渠道前缀、上游原始拼写；不污染官方last-good或CPA目录。
- **协议**：llm-bridge加本地补齐，支持JSON/SSE、function/custom/namespace及截图工具结果、多轮thinking和compaction；正确完成/截断/失败终态及取消清理。
- **CLI与日志**：仅config --zcode on/off；旧开关迁移，状态和审计同步；渠道日志独立，错误中普通及JSON转义Key脱敏，沿用缺省日志目录。
- **模型API补充**：按套餐重建鉴权头，Start仅Bearer；受控ZCode来源和内部会话归因；单一ephemeral缓存点和会话metadata；日志追加脱敏的实际上游头。闲置会话TTL900秒、最多1024条，关闭释放；仅发送原配置模型请求，不新增远端配置/握手/OAuth/验证码。
- **验证与审查**：修复Realtime WS误拦截、缺省日志目录漏记、图片工具结果400、同版本默认值变更影响旧审计等回归。

### 🧠 Design Intent (Why)
文件变动只是候选检查，不能等同于业务Key轮换。登录access_token与实际模型API Key分开处理；套餐目录与授权缓存也独立，避免高频UI配置更新触发凭证计算或目录重建。

### 🧪 Validation
- `bun run check`通过：233测试，0失败，0跳过；原生fs.watch、严格类型检查和单文件构建通过。
- 自动化回归使用临时Keychain替身及仅允许环回的fetch隔离；随后按用户明确授权完成一次真实模型请求，正式运行配置与原有服务未改动。
- 初版221项已验证，本轮新增12项请求层及两渠道三套餐集成用例，最新233项全通过；模型API补充独立审查无P1/P2。
- 独立复核通过；已真实验证Z.ai Coding Plan的GLM-5.3-Flash，其余渠道/套餐仍需分别验证，边界见技术债记录。

- 用户随后明确要求直接修改原文件并将zai改名zcode；已核对版本和备份，完成原worktree实写及源码/测试更名，目录缓存统一为zcode-catalog.json。

### 🔎 用户授权的单次实机验证

- 从已修改的原worktree加载实际网关处理器，临时端口59566，仅发起一次Responses模型请求。
- 对外模型z.ai/glm-5.3-flash，上游模型GLM-5.3-Flash；Z.ai Coding Plan返回HTTP200及response.completed，文本为OK，耗时2866ms。
- 上游用量input35、output62、total97；缓存读取0。正文单个ephemeral标记，metadata中的session与请求头一致。
- 实际上游头含ZCode/3.11.2与SDK标识、Z Code@cli、glm来源标记及生成的请求/追踪/会话字段；两项鉴权均脱敏，无密钥明文日志。
- 临时服务已停止；原8320监听进程在前后检查中未变化。此结果仅证明本次API兼容请求成功，不作为专属额度或其他套餐可用性保证。

### 📊 Change Stats
> 使用任务开始前tracked/untracked快照与实际写回后的原worktree执行 `git diff --no-index --no-renames --shortstat` 和 `--numstat`。排除继承变更、本历史自身及生成的dist产物。

`32 files changed, 3770 insertions(+), 2277 deletions(-)`

- **Files changed:** 32
- **Insertions:** +3770
- **Deletions:** -2277

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | +87 | -107 |
| `bun.lock` | +12 | -0 |
| `docs/exec-plans/completed/zcode-responses.md` | +75 | -0 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |
| `package.json` | +5 | -1 |
| `schemas/gateway-config.schema.json` | +4 | -13 |
| `src/cli.ts` | +22 | -6 |
| `src/config.ts` | +10 | -2 |
| `src/gateway.ts` | +83 | -28 |
| `src/paths.ts` | +1 | -1 |
| `src/request-log.ts` | +14 | -9 |
| `src/types.ts` | +2 | -2 |
| `src/zai-config.ts` | +0 | -194 |
| `src/zai.ts` | +0 | -271 |
| `src/zcode-catalog.ts` | +69 | -0 |
| `src/zcode-config.ts` | +322 | -0 |
| `src/zcode-request-context.ts` | +225 | -0 |
| `src/zcode-request.ts` | +260 | -0 |
| `src/zcode-response.ts` | +389 | -0 |
| `src/zcode-wire.ts` | +32 | -0 |
| `src/zcode.ts` | +206 | -0 |
| `test/zai-cache.test.ts` | +0 | -648 |
| `test/zai-config.test.ts` | +0 | -117 |
| `test/zai.test.ts` | +0 | -878 |
| `test/zcode-cache.test.ts` | +444 | -0 |
| `test/zcode-catalog.test.ts` | +160 | -0 |
| `test/zcode-cli.test.ts` | +93 | -0 |
| `test/zcode-config.test.ts` | +129 | -0 |
| `test/zcode-gateway.test.ts` | +537 | -0 |
| `test/zcode-request-context.test.ts` | +116 | -0 |
| `test/zcode-request.test.ts` | +213 | -0 |
| `test/zcode-response.test.ts` | +259 | -0 |
