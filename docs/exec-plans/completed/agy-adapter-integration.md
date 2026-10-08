# Antigravity（agy）适配器接入计划

状态：已完成。`agy/` 前缀目录 + Responses 推理全链路打通并通过真实调用验证；
Web UI 与 CLI 开关、config schema、请求日志与测试齐备；上游凭据只读消费，网关不刷新令牌。
2026-10-06 复核修复：startGateway WS 分流门与 responsesWebSocketTarget 补 agy、
httpOnlyModelFamily 加 agy 族、serve 传 agyDependencies、CLI `--agy` 全套接线、
compaction/426/族拒绝/models-cache 失效测试补齐。

创建日期：2026-10-06（北京时间）。

## 目标

按调研文档（`docs/antigravity-cli-upstream-research.md`）实现 Antigravity CLI 上游适配器：
config 提供 `agy` 开关，自动读取本机 agy 登录（只读），动态生成 `agy/` 前缀模型目录
（显示名用大写 `AGY/` 标签，路由 slug 仍为 `agy/`），Codex 经 `/v1/responses` 调用 Google Cloud Code Assist `v1internal`
推理；Web UI 增加开关展示。与 Qoder/CodeBuddy 同构接入，不影响既有上游与安全红线。

## 范围

- 包含：`src/agy/` 适配器（凭据只读、目录动态拉取与缓存、Responses ↔ v1internal 双向
  转换、错误分类白名单）、gateway 路由与目录合并、`agy` 配置字段与 schema、Web UI
  开关（存在性探测显隐）、i18n、请求日志 `agy` 命名空间、mock 测试、一次真实调用验证。
- 包含：通过本地 MITM 代理抓取 agy 1.2.17 真实请求，实证线格式并按实证修正实现
  （真实 UA、`project: "aicode-consumers"`、外层 model/camelCase 包装、
  thinkingConfig 形态、daily 通道默认）。
- 不包含：令牌刷新（refresh_token 网关永不触碰；过期快速失败并指引运行 agy）；
  企业 BAIC 通道；图片附件直传（resumable upload）；多账号轮换；公网部署。
- 不包含：对 Google 上游的自动化压测；真实调用仅限单次低频验证与用户主动使用。

## 背景

- 调研结论见 `docs/antigravity-cli-upstream-research.md`（含 2026-10-06 MITM 实证修正节）。
- access_token 有效期整 1 小时，由 agy 进程（含 remote-control daemon）惰性刷新并
  回写 `~/.gemini/antigravity-cli/antigravity-oauth-token`；daemon 停跑 1 小时后断供。
- 上游：`POST https://daily-cloudcode-pa.googleapis.com/v1internal:{fetchAvailableModels,
  streamGenerateContent?alt=sse}`；stable 通道对该账号推理 429（实测），故默认 daily。
- 目录以 `agentModelSorts` 推荐位 + `tieredModelIds` 档位并集为准，剔除
  tab/图像/音频专用模型；`deprecatedModelIds` 在请求前重定向旧 id。

## 关键决策

1. **凭据只读**：对齐 CodeBuddy 红线；发送前校验文件内 `expiry`（RFC3339 纳秒），
   过期即 401 分类错误 `antigravity_token_stale` 语义（message 指引运行 agy）。
2. **线格式以 MITM 实证为准**：静态 strings 推断的 `default-cli-project`、
   `request_id`/`user_agent` snake_case、`metadata` 均被 protojson 拒绝或与真实流量不符，
   已全部按实证修正；UA 复刻 `antigravity/cli/1.2.17 (aidev_client; …)`。
3. **请求侧 reasoning 历史不回放**（thought signature 属模型私有态），响应侧 thought
   部件映射为 reasoning 摘要、`thoughtSignature` 不透传。
4. **requestType 复用 "checkpoint"**（实证可用的最小值）；主 agent 会话的真实
   requestType 语义未穷尽，留待观察（见 tech-debt）。
5. **图片块**：data: URI → `inlineData`（base64），URL → `fileData.fileUri`；未经真实
   图像请求验证（见 tech-debt）。

## 风险与缓解

- 封号风险：指纹与真实 CLI 对齐（UA/投影 body）、无多账号轮换、目录刷新 6 分钟、
  错误不重试风暴；真实调用低频。
- daemon 停跑断供：401 分类错误明示刷新方式；Web UI 描述与 missing 提示同步交代。
- 上游协议演进：目录解析严格校验（未知字段忽略），响应错误走预定义分类白名单。

## 验证方式

- `bun run check`（typecheck + 634 测试 + build）全绿；新增
  `test/agy-{credentials,catalog,request,response,gateway}.test.ts` 共 37 例，
  全部 mock transport，不发真实请求。
- 真实验证（单次，`/tmp/agy-verify/run.ts`）：目录 14 模型、
  `agy/gemini-3.8-flash-high` 推理 200，完整 Responses 事件流（reasoning summary +
  output_text），3929 字符 TIME_WAIT 技术详答，usage 含 reasoning_tokens=1867。

## 回滚

config `agy: false`（或移除字段）即完全停用；`src/agy/` 为独立模块，摘除路由
三处引用即可移除。
