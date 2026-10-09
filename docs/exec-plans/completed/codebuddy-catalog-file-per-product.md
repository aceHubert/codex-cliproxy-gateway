# CodeBuddy/WorkBuddy 目录缓存文件按产品命名（单账号设计）

状态：已完成（全量检查与真机重启验证通过；工作区未提交）
创建日期：2026-10-09

## 目标

把 CodeBuddy/WorkBuddy 的目录缓存文件从「产品×地域」命名（`codebuddy-cn-catalog.json`、`codebuddy-intl-catalog.json`、`workbuddy-cn-catalog.json`、`workbuddy-intl-catalog.json`）收敛为「按产品」命名（`codebuddy-catalog.json`、`workbuddy-catalog.json`）：账号切换设计（锁定单个 `.info` / auto）下默认适配器每产品只提供一个目录族，地域不再需要进文件名；地域或账号标识变化时由 cache_key 变化触发重建，直接重写同一文件。旧地域命名文件在写入时 best-effort 清理，运行目录不再残留；空或相同账号标识的既有边界另记技术债。

## 范围

- 包含：
  - `src/codebuddy/catalog.ts`：
    - `codebuddyCatalogFileName` 改为按产品命名（签名 `(product: "cli" | "work")`，`catalogProductStem` 提供产品→主名映射）；
    - `cacheFile(profile)` 改用 `profileProduct(profile)` 定位文件；`readDisk`/`writeDisk` 的 key 校验不变（账号标识或地域变化后的旧内容按未命中处理）；
    - `writeDisk` 原子写成功后 best-effort 删除同产品旧命名文件 `{product}-{cn|intl}-catalog.json`；
    - 模块头注释、store 文档注释、`cacheDirectory` 选项注释同步。
  - `src/codebuddy/index.ts`：`cacheDirectory` 选项注释同步。
  - `src/paths.ts`：`managedCatalogFiles` 补 `workbuddy-catalog.json`（卸载清理与 `model_catalog_json` 守卫共用清单；原 `codebuddy-catalog.json` 条目在改名后重新成为现行文件名）。
  - 测试：`test/codebuddy-catalog.test.ts` 文件名断言更新，新增「写入产品命名缓存时清理旧地域文件」「账号地域切换重写同一文件」两个用例；`test/codebuddy-gateway.test.ts` 启动刷新落盘断言改名。
  - 收尾：历史记录；qoder/agy/opencode-zen 的 `managedCatalogFiles` 缺口记入 tech-debt-tracker。
- 不包含：
  - 模型前缀（`codebuddy-cn/`、`workbuddy-intl/` 等带地域 slug）不变——前缀是请求路由与凭据选择的依据，与缓存文件命名无关。
  - 内存结构（`Map<profile, CachedCatalog>`、families 去重、last-good/TTL/单飞）不变；auto 模式下仍可能出现 cli+work 两个目录族，逻辑保持通用。
  - 旧地域命名文件的读取兼容与数据迁移：不再读取（与 2026-09-18「旧单文件弃用」同一语义），缓存缺失时由上游重建补齐。
  - qoder/agy/opencode-zen 清单缺口的顺手修复（仅记录债务）。
  - 配置字段、schema、Web UI、网关路由零变化。

## 背景

- 相关文档：
  - [codebuddy-account-switch.md](../completed/codebuddy-account-switch.md)：账号切换设计（锁定单 `.info` 文件名 / auto），单账号使用是本次改名的前提。
  - [codebuddy-proxy-adapter.md](../completed/codebuddy-proxy-adapter.md)：2026-09-18 第二轮迭代引入产品×地域缓存文件命名（旧单文件 `codebuddy-catalog.json` 当时弃用）。
  - `docs/histories/2026-09/20260918-2050-codebuddy-display-label-dedupe.md`：「单账号也会产出两个目录族……文件数反映的是『产品×地域接口数』而非账号数」——地域命名文件在单账号下的由来。
- 相关代码路径：
  - `src/codebuddy/catalog.ts`：`codebuddyCatalogFileName`、`cacheFile`/`readDisk`/`writeDisk`、`createCodebuddyCatalogStore`（families / refreshFamilies / catalog）。
  - `src/codebuddy/index.ts`：`createCodebuddyAdapter` 的 credentials 回调（对 cli/work 各取一次凭据）。
  - `src/codebuddy/credentials.ts`：`forProduct` 同地域产品回退（profile 改写为 `{region}-{product}`，单账号因此产出两族）。
  - `src/paths.ts`：`managedCatalogFiles`（`removeManagedRuntimeFiles` 卸载清理与 `applyModelCatalogToml` 守卫共用）。
- 已知约束：
  - cache_key = digest({profile, revision, identity})：地域、accountUid/enterpriseId、客户端版本任一变化即 key 变化 → 磁盘文件按未命中处理并重建；同地域不同登录标识为空或相同时的隔离限制见风险与技术债。
  - families 每轮最多两族（cli+work，同地域）；锁定账号与 auto 都会经产品回退产出两族，因此磁盘文件稳定为每产品一份。
  - 全库 grep 确认旧地域命名文件仅本模块读写，无外部消费者；本机运行目录现存 4 个地域命名文件，切换账号后旧文件成为永不复用残留。

## 方案

1. 命名：文件按产品命名，地域不进文件名。

   ```ts
   /** 目录缓存文件按产品命名：`codebuddy-catalog.json`、`workbuddy-catalog.json`。 */
   export function codebuddyCatalogFileName(product: "cli" | "work"): string {
     return `${catalogProductStem(product)}-catalog.json`;
   }
   ```

2. 存储：`cacheFile(profile)` 用 `profileProduct(profile)` 定位文件；`readDisk` 的 `cache_key` 校验已能识别跨账号/跨地域的旧内容（按未命中重建），无需额外迁移逻辑。
3. 清理：`writeDisk` 原子写成功后 best-effort 删除同产品旧命名文件（`fs.rmSync(..., { force: true })`，失败不影响目录服务）：

   ```ts
   for (const legacy of legacyCodebuddyCatalogFileNames(profileProduct(profile))) {
     fs.rmSync(path.join(options.cacheDirectory, legacy), { force: true });
   }
   ```

   两个产品族各刷新一次后，运行目录只余 `codebuddy-catalog.json` / `workbuddy-catalog.json`。
4. `managedCatalogFiles` 增加 `workbuddy-catalog.json`。
5. 测试：更新既有文件名断言；新增「旧地域文件清理」「地域切换重写同一文件（不产生地域命名文件、不复用旧地域缓存）」用例。
6. 不变量：前缀、路由、去重、last-good、TTL、单飞、serve 语义全部不动，行为面仅剩「缓存文件叫什么名字、旧文件是否被清理」。

## 风险

- 风险：未来若出现同产品双地域目录族（当前默认适配器每产品只取一份凭据），单文件为后写者胜，另一族读盘未命中→重建；若重启后该族上游不可用，它没有磁盘 last-good，目录族会被省略。
  缓解：持续保持默认适配器每产品仅一个目录族的不变量；未来支持同产品多地域时必须重新设计磁盘隔离，不能仅依赖 cache_key。
- 既有边界：cache_key 的身份来自 accountUid/enterpriseId；两个同地域登录标识为空或相同时，切换可能不改变键。本次不改变键规则，已单独登记技术债；账号隔离测试覆盖标识变化的情况。
- 风险：删除行为误伤受管外文件。
  缓解：只删缓存目录内固定旧命名的两个文件，`force: true` 对缺失无副作用，每个文件独立捕获异常，不阻断其余文件清理或目录返回；产品文件原子写失败时不清理旧文件。
- 风险：外部脚本依赖旧文件名。
  缓解：全库 grep 确认无消费者；改名在历史记录中说明。

## 里程碑

1. 方案确认（本文件 review 通过）。
2. 验证：`bun run check`；真机重启观察运行目录与 `/v1/models`。
3. 收尾：历史记录、tech-debt 记录、计划归档。

## 验证方式

- 命令：`bun run check`（typecheck + `bun test` + build）。
- 重点回归：`test/codebuddy-catalog.test.ts`（文件名、清理、地域切换；既有 last-good、TTL、冷却、单飞、旧缓存键用例必须保持通过）、`test/codebuddy-gateway.test.ts`（适配器启动刷新落盘断言）。
- 手工检查：重启网关后运行目录只出现 `codebuddy-catalog.json` / `workbuddy-catalog.json`，4 个旧地域文件被清理；`codebuddy --switch` 切换账号后同一文件内容随账号更新；`/v1/models` 的 codebuddy/workbuddy 条目与改前一致。
- 观测检查：gateway.log 无新增错误；目录刷新日志正常。

## 进度记录

- [x] 用户明确要求开始实施；完成并行只读审查，修正清理异常边界并登记既有身份限制。
- [x] `bun run check` 全量通过（748 pass / 0 fail，类型检查与构建成功；整条检查设置 60 秒上限）。
- [x] 真机重启验证运行目录文件与目录内容（四旧文件清除、两产品文件存在；21 个展示条目的 slug/display_name 与重启前完全一致，healthz 正常）。
- [x] 历史记录 + tech-debt 记录；计划归档 `completed/`。

### 实施备注（2026-10-09）

- 接手时方案代码已在工作区（未提交）；保留同文件里系统提示词等其他任务的既有改动，仅补齐本任务异常处理与验证。
- 旧文件删除改为逐个 best-effort；新增清理失败续做、另一产品/用户文件保护、原子写失败保留旧文件、同地域账号标识变化且上游失败不复用旧缓存的测试。
- `test/paths.test.ts` 与 `test/gateway.test.ts` 补齐两产品受管清单、临时目录、TOML 接受/移除及卸载删除回归。
- 实际执行 `bun run dev restart`；运行目录仅剩两产品文件，分别包含 16/21 个裸 ID 条目；API 展示仍使用 codebuddy-intl/workbuddy-intl 前缀。重启前后模型展示列表逐字节一致；观察窗口新增日志 5 行、错误 0 行。
- 未执行真实账号切换；跨地域切换与同地域换账号由隔离的自动化 store 用例验证，避免为了验证缓存文件名而改动当前使用中的登录选择。
- 历史记录见 [实施记录](../../histories/2026-10/20261009-1801-codebuddy-catalog-file-per-product.md)；其他适配器清单与弱账号标识边界见 [技术债追踪](../tech-debt-tracker.md)。

## 决策记录

- 2026-10-09：文件名按产品（`{codebuddy|workbuddy}-catalog.json`），地域不进文件名——单账号设计下按地域命名只会产生切换后的残留文件；跨地域切换由 cache_key 变化触发重建，同一文件天然承载新账号目录。
- 2026-10-09：写入时 best-effort 清理旧地域命名文件——否则运行目录永久残留 4 个不再读写的文件；清理范围限定为同产品两个旧文件名。
- 2026-10-09：`managedCatalogFiles` 仅补 `workbuddy-catalog.json`；qoder/agy/opencode-zen 的清单缺口（卸载残留、toml 守卫不认）与本任务无耦合，记入 tech-debt-tracker 另行处理。
- 2026-10-09：前缀、路由、内存缓存结构、last-good 语义全部不动——本任务只改磁盘文件命名与残留清理，把行为面收敛到最小。
- 2026-10-09：每个旧文件分别捕获清理异常；一个路径不可删除时仍尝试同产品另一旧文件。保持原子写成功后才清理的顺序。
- 2026-10-09：真实重启验证文件与目录，账号切换使用隔离自动化验证；既有 cache_key 的空/相同账号标识问题保持原规则并明确记录债务。
