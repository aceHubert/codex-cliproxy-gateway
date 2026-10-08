## [2026-10-02 21:15] | Task: Qoder 桌面版登录回退

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `glm-5.3`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert`
* **Branch**: `main`

### 📥 User Query
> 不需要4个，因为可以使用同一个账号登录，也就是要兼容如果 cli没有的时候也需要检查desktop 是否登录

（前序上下文：用户安装了 Qoder 国际版与国内版桌面应用，经排查确认 CLI 与桌面版
授权存储、加密方式、设备身份、客户端标识均不同但同账号可共存。）

### 🛠 Changes Overview
**Scope:** codex-cliproxy（src/qoder/credentials.ts、src/webui.ts、src/ui/i18n.tsx、src/qoder/index.ts、README、docs）

**Key Actions:**
- **[可行性验证]**: 从桌面版 app.asar 提取 `auth.v1.dat` 读写类，确认信封为
  Electron safeStorage 的 os_crypt v10（PBKDF2-HMAC-SHA1(saltysalt,1003)+AES-128-CBC
  空格 IV），密钥位于 macOS 钥匙串 `Qoder App / Qoder CN App Safe Storage` 条目
  （`security find-generic-password` 可读，未弹窗）。解密后为
  `{schemaVersion:1, token, refreshToken, expiresAt, user:{id…}}`，token 有效期约
  30 天。用桌面令牌构造凭据实测：CN 目录拉取（14 模型）与 Flash 推理直连成功——
  桌面令牌对算法网关与 CLI 令牌等价。
- **[凭据回退]**: `loadQoderCredentials` 在 CLI `user` 文件缺失（ENOENT）时回退
  `loadDesktopQoderCredentials`：读桌面 `auth.v1.dat`+`auth.machine-id` → 钥匙串
  取密钥解密 → 校验 schemaVersion/token/expiresAt → 复用现有 `runtimeFields`
  生成运行时认证。解密结果按文件 mtime+size 进程内缓存（桌面应用刷新令牌后自动
  重读）；凭据不落盘、不写回。CLI 登录始终优先；CLI 凭据损坏仍按原语义报错，
  不静默回退。identity 为 `[region, uid, "desktop"]` 摘要，与 CLI 身份天然隔离，
  目录缓存不会跨凭据复用。
- **[检测与文案]**: 新增 `qoderRegionCredentialsPresent`（CLI 或桌面任一登录即真），
  Web UI `/ui/api/config` 检测改用该函数（新增 `qoderDesktopDir`/`qoderCnDesktopDir`
  注入点）；网关 401 文案与 UI 中英文提示改为「登录 CLI 或打开桌面版」。
- **[测试]**: 新增桌面回退用例（合成 safeStorage 信封）：回退成功与字段校验、
  缓存命中不重复读钥匙串、CLI 优先、钥匙串不可读/信封损坏/过期登录的带指引失败、
  `qoderRegionCredentialsPresent` 矩阵、UI 仅桌面登录也显示开关且不回显机器标识。

### 🧠 Design Intent (Why)
- 同一账号在 CLI 与桌面版各持一套独立令牌与设备身份，服务端均认可；CLI 未安装
  或未登录时桌面版登录是唯一可用凭据，网关应能发现并使用，而不是要求用户
  额外安装 CLI。
- safeStorage 密钥在钥匙串而密文在应用数据目录，文件离开本机不可解，安全边界
  与 CLI 的 machine_id 自包含加密不同但读侧一致：全部只读，凭据仅存内存。

### 📊 Change Stats
> 本次任务改动（Qoder 特性整体仍未提交，`src/qoder/` 与 `test/qoder-*.test.ts`
> 均为 untracked 新文件；此处统计本任务相对上一历史记录的增量）。

- **Files changed:** 6

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/qoder/credentials.ts` | +120（桌面回退+解密+缓存+钥匙串） | ~10 |
| `test/qoder-credentials.test.ts` | +115（4 个新用例） | ~12 |
| `test/qoder-webui.test.ts` | +17（桌面检测用例+注入点） | 0 |
| `src/webui.ts` | +6（检测与注入点） | ~4 |
| `src/ui/i18n.tsx` | +2 | -2 |
| `README.md` | +10（回退说明） | -4 |

### 📁 Files Modified
- `src/qoder/credentials.ts`、`src/webui.ts`、`src/ui/i18n.tsx`、`src/qoder/index.ts`（401 文案）
- `test/qoder-credentials.test.ts`、`test/qoder-webui.test.ts`
- `README.md`、`docs/exec-plans/active/qoder-international-flash-proxy-integration.md`

### ✅ Verification
- `bun run typecheck`、`bun test`（**587 项全通过**）、`bun run build` 均通过。
- 真实端到端（空 CLI 目录 + 真实桌面登录）：
  - CN：凭据加载成功（30 天有效期）、目录 14 模型、推理直连成功；
  - INTL：凭据回退成功；
  - 正式网关已重载，`/v1/models` 双区域正常，`qoder-cn/qfmodel` 调用
    `completed`、`billable=false`；Web UI 服务已重载。
- 钥匙串读取在本机未弹窗（ACL 允许）；launchd 首次读取可能弹一次授权框，
  错误文案已提示选择「始终允许」。

### 📝 Notes & Follow-ups
- 追加（同日 21:40）：凭据新增 `clientProfile`（cli/desktop），传输层按档案发送对应
  产品标识（cli → `Cosy-Business-Product:cli/ClientType:5/session_type:qodercli`，
  desktop → `app/10/app`）；实测算法网关两种标识均接受 COSY 签名，用量页可据此
  区分来源。新增 `QODER_FORCE_DESKTOP=1` 调试变量强制只读桌面登录（launchctl
  setenv 后重启网关生效）。
- 桌面令牌约 30 天过期且网关不做刷新（refreshToken 不使用）；桌面应用正常使用
  会自动续期，长期不开桌面应用时回退令牌过期，错误会指引打开桌面版重新登录。
- 桌面回退仅 macOS（Linux 桌面版数据目录路径未核实，`defaultQoderDesktopDir`
  非 darwin 返回 null）。
- 首次钥匙串授权提示与 Linux 路径已记入技术债务跟踪表。
