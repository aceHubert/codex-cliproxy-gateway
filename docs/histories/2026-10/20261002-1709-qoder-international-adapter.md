## [2026-10-02 17:09] | Task: 实现并验证 Qoder 国际版本机适配

### 🤖 Execution Context
* **Agent ID**: `codex`
* **Base Model**: `GPT-6（当前会话未提供具体子型号）`
* **Runtime**: `Codex Desktop`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `main`

### 📥 User Query
> config 只保留 qoder 一个开关，自动发现各地域登录，分别生成 INTL-Qoder 和 CN-Qoder 模型目录并使用对应授权。先实施国际版，使用本机已登录的 CLI 验证；参考调用协议，不直接运行 qodercli2api。

### 🛠 Changes Overview
**Scope:** Bun/TypeScript 网关、配置和 Schema、Web UI、国际版 Qoder 适配与测试。

**Key Actions:**
- **原生调用**：使用 Node 标准加密库独立实现只读登录解析、COSY 签名和 Encode=1 线格式；直接请求国际版模型目录与推理端点，不依赖参考代理或 CLI 推理子进程。
- **动态目录**：按当前账号顶层 chat 清单生成 INTL-Qoder 条目，模型 ID 为 qoder-intl/<key>；仅展示启用的具体模型，不合并内置表、auto 或 BYOK。
- **显示与上下文修正**：按用户后续要求，显示名改为 Qoder-INTL／Qoder-CN；各模型从自己的 context_config 自动识别最大窗口并发送 parameters.context_length。默认输入限制 max_input_tokens 独立保留，没有手动配置。当前两模型均为 1M，客户端保留5%有效预算。
- **推理与倍率**：按实时目录映射低、中、超高及各模型默认档位，拒绝未声明档位；按 price_factor 显示免费或倍率后缀，升级缓存修订并补齐生产启动时 Codex 目录失效路径。
- **目录生命周期**：启动和两分钟定时刷新、100 秒 TTL、30 秒失败退避、并发合并、账号隔离、最近成功缓存回退、原子写盘及 Codex 缓存失效。
- **协议适配**：复用仓库现有 Responses/OpenAI 消息转换，处理 Qoder 信封、独立 finish 事件、并行工具索引、推理和计费元数据；支持取消及上下文压缩路径。
- **日志和超时修复**：增加 qoder 命名空间请求元数据日志，WebSocket 降级也归入同一命名空间；不记录私有认证、提示词及工具内容。固定总时长中止改为空闲超时，字节和心跳重置计时，超时记录 504 并补齐 response.failed；清理回调不再抢先把成功记为 499。
- **配置入口**：qoder 默认关闭，进入 CLI、Schema、配置审计、状态同步和 Web UI；纯上游模式下不生效，启用时限制本机环回监听。
- **界面文案**：按用户后续要求，中英文 Qoder 开关说明仅保留 Responses 入口及纯上游模式限制，去掉自动检测登录与目录生成细节。
- **地域与安全**：国内版尚未启用，明确拒绝国内或旧前缀；未知模型不回退。登录只读，不续期、不写回、不向客户端或日志暴露凭据，入站 ChatGPT 授权不参与 Qoder 请求。

### 🧠 Design Intent (Why)
将 Qoder 作为项目内模型适配器，与现有 CodeBuddy/WorkBuddy 使用相同的配置与生命周期组织方式，同时按 Qoder 当前协议维护独立授权、目录和推理。目录以当前账号动态结果为准，避免参考代理静态表及默认模型回退带来的权限和计费误判。

### ✅ Validation
- 初始 `bun run check` 通过；后续修复最终全量测试 570 项通过，类型检查、UI 构建及 CLI 构建通过；后台测试最长 60 秒。
- 自动 1M 档位的 Flash 短请求成功，返回 QODER_1M_OK、billable=false；目录与出站参数一致，未进行满容量输入负载测试。
- 实时目录确认 Flash 默认中、Max 默认超高，均支持低中超高；Flash 低与超高原生请求成功且 billable=false。
- 当前显示 Flash (free)、Max (x0.5)。Max 的 is_free=true 不覆盖其非零 price_factor；活动倍率随目录更新。
- 本机 Qoder CLI 1.1.65 国际版登录：原生 GET 目录成功。当前账号 chat 共 17 条，仅 Max 与 Flash 两条启用。
- 原生 Flash 推理成功；完整网关 Responses 返回 `QODER_GATEWAY_OK`、`status=completed`、`billable=false`。
- 真实 Codex CLI 通过临时网关完成一次只读 printf 工具调用及结果回传，返回 `QODER_CLIENT_TOOL_OK` 并退出成功。
- Chrome 验证 Web UI 检测到国际登录并显示 Qoder 开关和 INTL-Qoder 描述。
- 临时测试服务和页面已关闭，本机正式网关、Codex 配置和 Qoder 登录未改写。
- 后续日志修复已重载正式网关，未修改配置或登录；真实 Flash 流式请求约 2.2 秒完成，billable=false，生成 qoder-v1-responses-http 日志，记录 200 而非 499。
- 日志与超时专项测试验证持续字节及心跳超过总时长仍成功、响应头超时返回 504、流式停顿产生失败终态、WebSocket 协商命名正确；首次全量 check 被既有 status 测试默认 5 秒超时阻断，改用单项及总计 60 秒限制后全量测试通过，类型检查及构建通过。
- 一项既有 ZCode CLI 测试的安装配置夹具补齐 qoder:false，保持其拒绝非法组合且不写配置的测试前提。
- 独立审查修复畸形 Qoder JSON 请求进入通用正文日志的问题，增加 Responses 和压缩路径脱敏回归并复核通过。
- 国内版、长期稳定性、长上下文容量和 CLI 升级兼容尚未实测；免费结论仅指已验证请求，未独立核对账户账单。

### 📊 Change Stats
> 统计仅覆盖本次代码、README 和测试：共享文件使用 `git diff --shortstat` / `git diff --numstat` 相对当前暂存基线统计，新增文件使用 `git diff --no-index` 补入任务补丁后汇总。未包含执行前已有的暂存变更、执行计划及本历史记录；没有创建提交。

- **Files changed:** 28
- **Insertions:** +2783
- **Deletions:** -22

| File | +Added | -Removed |
| --- | ---: | ---: |
| `README.md` | 38 | 3 |
| `schemas/gateway-config.schema.json` | 5 | 0 |
| `src/cli.ts` | 24 | 4 |
| `src/config-update.ts` | 10 | 1 |
| `src/gateway.ts` | 58 | 9 |
| `src/request-log.ts` | 2 | 2 |
| `test/gateway.test.ts` | 1 | 0 |
| `src/realtime.ts` | 3 | 1 |
| `src/types.ts` | 2 | 0 |
| `src/ui/ConfigPage.tsx` | 32 | 0 |
| `src/ui/api.ts` | 3 | 0 |
| `src/ui/i18n.tsx` | 8 | 0 |
| `src/webui.ts` | 7 | 2 |
| `test/zcode-cli.test.ts` | 1 | 0 |
| `src/qoder/catalog.ts` | 315 | 0 |
| `src/qoder/index.ts` | 207 | 0 |
| `src/qoder/credentials.ts` | 130 | 0 |
| `src/qoder/transport.ts` | 139 | 0 |
| `src/qoder/request.ts` | 47 | 0 |
| `src/qoder/response.ts` | 204 | 0 |
| `test/qoder-request.test.ts` | 77 | 0 |
| `test/qoder-webui.test.ts` | 113 | 0 |
| `test/qoder-catalog.test.ts` | 271 | 0 |
| `test/qoder-credentials.test.ts` | 94 | 0 |
| `test/qoder-response.test.ts` | 158 | 0 |
| `test/qoder-config.test.ts` | 142 | 0 |
| `test/qoder-gateway.test.ts` | 587 | 0 |
| `test/qoder-transport.test.ts` | 105 | 0 |

### 📁 Files Modified
- 核心模块：`src/qoder/credentials.ts`、`transport.ts`、`catalog.ts`、`request.ts`、`response.ts`、`index.ts`。
- 网关与配置：上表列出的 gateway/realtime/cli/types/config-update、Schema 和 Web UI 文件。
- 验证：八份 Qoder 测试，以及 ZCode CLI 安装配置夹具。
- 文档：README 和进行中的双地域接入计划。国际版阶段已完成，国内版阶段继续保留在 active。
