# 执行计划：运行主目录统一与环境变量覆盖（CODEX_CLIPROXY_HOME）

## 目标

网关自管的全部数据目录（请求日志、调试转储、各适配器目录缓存）统一从运行主目录派生——默认 `~/.codex-cliproxy-gateway`，可用环境变量 `CODEX_CLIPROXY_HOME` 重定向，目录不存在时随首次写入自动创建；彻底废除「从 catalogPath 等文件位置倒推目录」的散落启发式。

## 范围

- 包含：
  - `resolvePaths` 支持 `CODEX_CLIPROXY_HOME`（优先级：显式 `runtimeHomeOverride` > 环境变量 > 默认主目录）；LaunchAgent plist 位置不随环境变量移动（服务管理面语义不变）。
  - `requestLogDir` 缺省回退改为 `resolvePaths().logDir`，运行时各 sink 与 CLI/Web UI 提示、回填自动一致。
  - agy/codebuddy/qoder/opencode 适配器的 `cacheDirectory` 缺省回退改为 `resolvePaths().runtimeHome`。
  - zcode 适配器新增 `cacheDirectory` 依赖（models.json 覆盖、zcode-catalog.json），缺省同上。
  - `install` 在设置了环境变量时直接拒绝（launchd 进程不继承 shell 变量，避免配置写到服务读不到的位置）。
  - 测试：paths 环境变量优先级、config 命令提示/回退/回填一致性（含环境变量重定向）、install 防呆、agy 调试转储缺省目录、zcode 请求日志缺省目录、zcode fixture 注入 cacheDirectory。
  - schema `logDir` 描述与 README「运行主目录与环境变量」小节。
- 不包含：
  - `managedCatalogFiles` 补齐 qoder/agy/opencode-zen 目录缓存清单（既有独立债务，本次行为变化让它更接近「全部落在 runtimeHome」的清理前提，但仍单独立项）。
  - `web --daemon` 的环境变量防呆（web 读取安装产物，install 已在源头拦截；直接以 env 运行 web 会得到明确的「未安装」错误）。
  - Windows/Linux 服务管理形态。

## 背景

- 前序：`config --debug on` 的目录提示缺陷（自定义 catalogPath 时提示与实际分叉）首轮以「共享 requestLogDir + 统一回退」修复，用户随后指出这是全局问题：目录不应从文件位置倒推，应统一到运行主目录并支持环境变量。
- 相关代码：`src/paths.ts`（resolvePaths）、`src/request-log.ts`（requestLogDir）、五适配器的 cacheDirectory 回退、`src/cli.ts` serve/install/configCommand。
- 已知约束：LaunchAgent 拉起的网关进程不继承 shell 环境变量——环境变量只影响设置它的进程，因此 install 必须拒绝，文档必须写明「服务安装形态用默认主目录」。
- 默认安装行为不变：生产实例 catalogPath 就在 runtimeHome 内，新旧回退规则等值；只有自定义 catalogPath / `serve --config` 临时实例的落盘位置改变（这正是本计划的目标）。

## 风险

- 风险：`serve --config` 临时实例的请求日志/调试转储/目录缓存从「配置同目录」变为「默认主目录」，多实例并行时目录缓存同名文件会互相覆盖。
  缓解：环境变量即官方隔离机制（`CODEX_CLIPROXY_HOME=<dir> serve --config <dir>/config.json`）；README 给出示例；默认主目录内的同名缓存按上游类型/产品命名，单实例语义不变。
- 风险：环境变量与 LaunchAgent 服务语义错位（配置写到服务读不到的位置）。
  缓解：install 显式拒绝并给出解释；文档写明该变量只用于前台/多实例场景。
- 风险：测试隐式依赖 catalog 同目录落盘。
  缓解：为 zcode 补 cacheDirectory 依赖注入，fixture 显式指向测试目录；缺省目录断言改用环境变量钉住位置。

## 里程碑

1. 方案收敛（本计划）。
2. resolvePaths 环境变量 + requestLogDir/五适配器回退统一 + install 防呆。
3. 测试重写与补充、schema/README 文档。
4. `bun run check` 全绿，历史记录追加。

## 验证方式

- 命令：`bun run check`（类型检查、753 个测试、构建）。
- 手工检查：`CODEX_CLIPROXY_HOME=/tmp/x bun run dev config` 输出的 logDir 为 `/tmp/x/logs`；`CODEX_CLIPROXY_HOME=... codex-cliproxy install` 被拒绝且不产生任何目录。
- 观测检查：自定义 catalogPath 时 `config --debug on` 提示、`config` 无参输出、agy 调试转储实际落盘三者指向同一目录。

## 进度记录

- [x] 方案收敛。
- [x] resolvePaths 环境变量与回退统一、install 防呆。
- [x] 测试与文档。
- [x] `bun run check` 全绿（753 pass），历史记录追加。

## 决策记录

- 2026-10-09：优先级定为 显式 override > 环境变量 > 默认主目录——`serve --config` 的实例目录是更具体的显式意图，环境变量是进程级环境默认。
- 2026-10-09：LaunchAgent plist 位置不随环境变量移动。环境变量定位为「数据目录重定向」（serve/多实例/容器/CI）；服务管理面（install 的 plist、卸载清理）保持默认几何，install 拒绝设置环境变量时执行，从源头消除错位。
- 2026-10-09：zcode 补 `cacheDirectory` 依赖而不是让测试设置 HOME——依赖注入与其他适配器一致，测试目录语义显式，避免全局环境污染。
- 2026-10-09：不迁移旧数据。自定义 catalogPath 的存量场景本就是错位状态（缓存散落、卸载清理不到），统一后新写入全部落运行主目录；存量文件由用户按 tech-debt 清单的后续清理任务处理。
