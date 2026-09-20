## [2026-09-19 21:16] | Task: 暂停暴露 ZCode Start Plan 并登记技术债

### 🤖 Execution Context
* **Agent ID**: `zcode`
* **Base Model**: `GLM-5.3 (account:zai-individual-coding-plan)`
* **Runtime**: `ZCode CLI`
* **Git User**: `hubert <hubert@lejian.com>`
* **Branch**: `feature/codebuddy`

### 📥 User Query
> 那 catalog 中 start plan 先不要放进去，先让无法调用，记录到技术债里去

### 🛠 Changes Overview
**Scope:** `src/zcode/index.ts`、网关测试、README、AGENTS.md、技术债追踪

**Key Actions:**
- 适配器套餐路由表移除 `start-plan`：目录不再生成 `zcode-start-plan/*` 条目，请求一律 404；`readZcodePlanSelections` 槽位、`plan:"start-plan"` 强制缓存、zcodejwttoken 凭据、catalog 前缀/显示名等底层能力与单测全部保留，重新暴露只需把该 kind 加回路由表。
- 网关测试：并集用例改为个人+团队并断言 start-plan 404（含原因注释）；鉴权/归因矩阵用例撤掉 start-plan 分支（无 x-api-key 的头语义仍由 request-context 单测覆盖）。
- 技术债追踪新增 2026-09-19 行：3007 captcha 门槛、官方 runtimeProviderHeaders/签名层机制、后续验证与复归路径。
- README 标注免费档暂未开放；AGENTS.md 同步「解析能力保留但暂不暴露」。

### 🧠 Design Intent (Why)
鉴权修复（zcodejwttoken）后 start-plan 仍被中继的阿里云 captcha 门槛（`code:3007`）拦截，暴露目录只会让会话选到必然失败的模型；官方客户端靠 UI 解验证码注入 `X-Aliyun-Captcha-Verify-Param`，网关无法 headless 复刻。撤下路由让「可选即可用」成立，个人/团队不受影响，并把验证窗口与签名层复刻登记为技术债。

### 📊 Change Stats
> 本次未提交；分支上叠有此前任务未提交改动，以下为工作区相对 HEAD 的合计统计。

- **Files changed:** 5
- **Insertions:** +322
- **Deletions:** -86

| File | +Added | -Removed |
| --- | ---: | ---: |
| `src/zcode/index.ts` | +121 | -27 |
| `test/zcode-gateway.test.ts` | +193 | -57 |
| `README.md` | +5 | -1 |
| `AGENTS.md` | +2 | -1 |
| `docs/exec-plans/tech-debt-tracker.md` | +1 | -0 |

### 📁 Files Modified
- `src/zcode/index.ts`
- `test/zcode-gateway.test.ts`
- `README.md`
- `AGENTS.md`
- `docs/exec-plans/tech-debt-tracker.md`

### ✅ Verification
- `bun run typecheck`、`bun test`（453 pass / 0 fail）、`bun run build`
- 网关重启后实测：`/v1/models` 仅个人档条目（团队因本机缺 bigmodel 登录不可用，属预期）；`zcode-start-plan/glm-5.3-flash` 请求 404
