## [2026-10-02 20:15] | Task: 修复 Qoder 排队误判并接入国内版

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 继续排查 Qoder 上游响应失败的问题，并补充上 qodercn 的调用

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/qoder、src/webui.ts、src/ui、README、docs）

**Key Actions:**
- **[排队根因定位]**: 抓包确认「Qoder 上游响应失败」的真身是排队信封
  （`statusCodeValue=403` + `body.code=403/10605` + 嵌套 `isQueued:true,
  retryAfterSeconds:30, serviceAvailable:false, queueType:p3`），
  旧实现把 `statusCodeValue≠200` 一律当致命错误，客户端 1～5 秒收到失败。
- **[排队恢复层]**: 新增 `src/qoder/queue.ts`——剥离排队帧；等待期间每个帧边界
  （含 `: keep-alive` 注释帧）重置外层空闲计时；`isQueued:false`（就绪）按上游
  `retryAfterSeconds`（上限 30s）重试；排队连接被服务端关闭（实测约 120s）也重试；
  默认最多 2 次尝试，单次排队等待 110s（低于 120s 空闲超时）；恢复耗尽抛
  `QoderQueueError` → 503 + `qoder_queued_limited` 分类。
  语义对照官方 CLI 1.1.65 内嵌代码（`[ModelQueue]` 循环）核实。
- **[SSE 解析加固]**: 新增 `src/qoder/sse.ts` 共享 `readFrames`/`parseQueueStatus`；
  `response.ts` 数据信封的对象 body 直接作为 chunk（不再抛协议错误），
  错误信封拆多层 `{code,message}` JSON 字符串取内层 code/message/msg 供分类，
  排队帧在转换层二次防御性跳过；恢复 `msg` 字段回退。
- **[修丢帧缺陷]**: 排队窥探器自持缓冲并在首个内容帧处把未解析余量交还组合流——
  否则单 TCP 块含多帧（测试单块、生产粘包）时会静默丢失 usage/finish 帧。
- **[双地域]**: transport/credentials/catalog/index 区域化（`QoderRegion`）；
  国内版推理端点 `https://gateway.qoder.com.cn`（国内版 CLI 日志与实测确认，
  `openapi.qoder.com.cn` 的 algo 路径 503），凭据目录 `~/.qoder-cn`
  （`QODERCN_CONFIG_DIR`），目录前缀 `qoder-cn/`、显示 `Qoder-CN/`、
  缓存 `qoder-cn-catalog.json`，与国际版独立刷新互不影响；
  单个 `qoder` 开关下自动发现两版登录。
- **[UI/文案]**: Web UI 登录检测改为「国际版或国内版任一登录」（新增
  `qoderCnConfigDir` 注入）；i18n 中英文提示、CLI 帮助、README 同步双版语义。

### 🧠 Design Intent (Why)
- 用户报障「新聊天首次发送失败」：上游排队是账号并发占用的正常状态
  （本机正在运行的 Qoder CLI 会占 slot），官方客户端选择等待，
  网关此前直接判死导致秒失败。按官方 CLI 语义等待/恢复是正确行为，
  且等待期间不得让网关空闲超时误杀（帧边界保活）。
- 国内版（qodercn）CLI 已在本机登录且协议与国际版一致，仅端点/凭据目录不同，
  因此复用同一协议实现、按地域 profile 隔离，不引入第二套转换代码。

### 📊 Change Stats
> `src/qoder/` 与 `test/qoder-*.test.ts` 为本特性（含上一会话国际版实施）未提交新文件；
> 本次任务在其上修改并新增 `sse.ts`、`queue.ts`、`test/qoder-queue.test.ts`。

- **Files changed:** 24（qoder 特性整体，未提交）
- **Insertions:** ~2,260（含新文件 1,618 行中的 sse/queue/queue 测试 ~454 行为本次新增）

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/qoder/sse.ts` | +98 | 新增 |
| `src/qoder/queue.ts` | +213 | 新增 |
| `test/qoder-queue.test.ts` | +143 | 新增 |
| `src/qoder/index.ts` | 双地域门面+排队接入 | 重写 |
| `src/qoder/transport.ts` | 区域 profile | 重写错误路径 |
| `src/qoder/credentials.ts` | 区域参数 | 局部 |
| `src/qoder/catalog.ts` | 区域前缀/路由/缓存 | 局部 |
| `src/qoder/response.ts` | 对象 body+拆包+防御 | 中等 |
| `src/webui.ts` / `src/ui/i18n.tsx` | +92/+40（双版检测与文案） | 局部 |

### 📁 Files Modified
- `src/qoder/sse.ts`（新增）、`src/qoder/queue.ts`（新增）、`test/qoder-queue.test.ts`（新增）
- `src/qoder/{index,transport,credentials,catalog,response}.ts`
- `src/webui.ts`、`src/ui/i18n.tsx`、`src/cli.ts`、`README.md`
- `test/qoder-{gateway,catalog,credentials,webui}.test.ts`
- `docs/exec-plans/active/qoder-international-flash-proxy-integration.md`

### ✅ Verification
- `bun run typecheck` 通过；`bun test` **582 项全部通过**（新增排队恢复 7 项、
  双地域目录/凭据/网关用例）；`bun run build`（UI + CLI）通过。
- 真实验证（重启 `codex-cliproxy-gateway` 后）：
  - `/v1/models` 同时列出 `qoder-intl/*` 与 `qoder-cn/*`。
  - `qoder-cn/qfmodel` 真实调用 **completed / "OK" / billable=false**（约 1s）。
  - 国际版真实排队成功路径：账号并发被本机 Qoder CLI 占用时，
    网关排队恢复等待约 **113 秒**后返回 **completed / "OK" / billable=false**
    （请求日志 `qoder-v1-responses-http-20261002200714.log`，200/113458ms）；
    对照旧行为（1～5 秒失败）确认根因修复有效。
- 排队信封、丢帧缺陷、就绪重试、恢复耗尽分类均有模拟上游的回归测试。

### 📝 Notes & Follow-ups
- 追加排查（同日晚）：用户反馈「上下文 200K 时等待更短」，经四种 `context_length`
  形态对比与官方 CLI 对照证伪——等待差异来自服务端免费池晚高峰拥堵（起点 19:05
  早于 1M 上线 19:19），与上下文档位无关；国内版同期直连秒回。进一步实测确认
  排队流不会被提升为推理流，恢复策略改为官方 CLI 同款「立即放弃排队流 + 30 秒
  节奏重发 + 120 秒总预算」；真实验证拥堵期 120 秒干净失败、容量恢复后 63 秒成功。
- 上游持续排队时网关在 120 秒预算内重试后返回明确排队失败；客户端可据此提示重试或改用 Qoder-CN。
- `~/.qoder-cn/.auth` 的运行时字段（encrypt_user_info/key）与国内版
  openapi 域名的账号接口差异未逐一验证（推理路径已验证）。
- 历史记录格式见 `docs/HISTORY_GUIDE.md`；技术债务待归档时同步跟踪表。
