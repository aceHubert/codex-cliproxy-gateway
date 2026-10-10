# 执行计划：实例绑定的服务操作与后台多实例支持

## 目标

按确认的修订方案 A 落地：配置、凭据与服务操作全部按实例绑定；普通配置修改和重启不改写 plist，只有安装或显式更新启动定义才写 plist；`CODEX_CLIPROXY_HOME` 支持完整的前台与后台（launchd）形态，默认安装零迁移。

## 范围

- 包含：
  - 实例身份统一：`resolvePaths` 规范化环境变量输入（trim、`~` 展开、拒绝相对路径），`runWithInstancePaths` 在配置同步前建立调用级异步路径快照；主目录优先级 `--config 目录 > 环境变量 > 默认`。从最近存在的真实祖先补齐缺失目录，保证实例哈希在目录创建前后不变。
  - launchd label 参数化（render×2、start/stop/restart/reload、status print、webui kickstart 全部携带 `{plistPath, label}`）；非默认实例 label/plist 文件名/Keychain 服务名加同一哈希后缀，plist 一律留在 `~/Library/LaunchAgents/`（launchd 登录只扫描该目录），默认实例保持历史 label 与 plist 名。
  - install：plist 嵌入规范化 `CODEX_CLIPROXY_HOME`（仅非默认实例）；非默认实例托管时必须使用独立 `CODEX_HOME`，包括显式指向默认目录也拒绝。安装记录保存客户端目录，并原子声明归属，防止多个实例争用。
  - config/restart 按实例分派：本实例已安装→重启本实例 label；未安装→保存并提示，绝不触碰默认服务；`web --restart` 改为纯重启（不重写 plist）。
  - 上下文贯通：请求日志、调试转储、缓存与凭据使用调用级快照；Web UI 的展示、列表、正文、开关回填及异步上游拉取均使用本实例上下文。
  - 网关与 Web UI 响应携带 `x-ccp-instance`；等待启动、status 与 web 探测统一校验，无标记或其他实例的响应不放行。
  - Keychain 槽位隔离（默认沿用历史服务名，其余加后缀）；存储对象固定创建时的槽位与账号，不随其他调用变化。
- 不包含：
  - 同一主目录多份不同配置的并发互斥强制（文档说明，不做进程级锁）。
  - `managedCatalogFiles` 补齐 qoder/agy/opencode-zen 清单（既有独立债务）。
  - 旧残留文件迁移（自定义 catalogPath 的存量散落文件由用户清理）。

## 背景

- 前序：运行主目录统一（completed/runtime-home-unification.md）验收发现四项问题（P1 服务误绑定 + P2×3），用户在 Codex 会话确认修订方案 A：plist 只在 install / web --daemon 写；普通操作不重写 plist；上下文贯通而非 serve 内改全局 env；Keychain 一并隔离。
- 关键技术事实：launchd 只在登录时扫描 `~/Library/LaunchAgents/`（plist 放数据目录会失去登录自启）；runCli 的配置同步先于 serve()（绑定必须更早）；launchctl kickstart/print 按 label 寻址（固定 label 使多实例冲突）。

## 风险

- 风险：label 参数化波及面大（launchd.ts 8 处 + cli.ts/webui.ts 调用点），遗漏一处即操作错实例。
  缓解：所有服务函数强制显式 `{plistPath, label}`；回归测试覆盖「默认服务在场时 A 的操作不触碰默认 label/文件」两分支。
- 风险：serve 绑定主目录改变临时实例行为（开始写自己的 gateway.log、upstream 缓存进实例目录）。
  缓解：与后台实例语义对齐（用户已确认）；`--config` 指到主目录内其他文件（test.json）仍不写进程日志、不动 state。
- 风险：旧进程尚未返回实例标记，严格健康检查会拒绝其响应。
  缓解：错误与 README 明确要求更新目标服务并重启，不将不明进程视为健康。
- 风险：安装回滚、托管转手动及卸载中断遗留客户端归属。
  缓解：新声明记录回滚身份；手动安装和卸载回收自身遗留声明；卸载先持久化客户端恢复阶段，再清理其他资源及归属，重试不再触碰已交还的客户端。

## 里程碑

1. 方案确认（用户在 Codex 会话拍板，本轮只读核查 label/Keychain 使用面）。
2. paths/launchd/keychain 基础设施 + cli/webui/gateway 接线。
3. 测试（几何/嵌入/两分支/拒绝/隔离/贯通/标记）。
4. 文档、计划与历史记录，`bun run check` 全绿。

## 验证方式

- 命令：`bun run check`（类型检查、完整测试、构建），测试执行设置 60 秒上限。
- 手工检查：`CODEX_CLIPROXY_HOME=A config --debug on`——A 未安装时提示不重启且默认 plist 原样；`~/Library/LaunchAgents/codex-cliproxy-gateway-<hash>.plist` 内容含嵌入的环境变量。
- 观测检查：healthz 响应头 `x-ccp-instance` 与实例标记一致。

## 进度记录

- [x] 方案确认与使用面核查。
- [x] 基础设施与接线实现。
- [x] 测试与文档。
- [x] 首轮 `bun run check` 全绿（759 pass），历史记录追加。
- [x] 修复后续验收发现的五项实例边界问题，并补齐归属释放的中断恢复。
- [x] 新增回归测试；`bun run check` 全绿（790 pass），独立复核通过，历史记录追加。

## 决策记录

- 2026-10-09：实例身份 = 运行主目录（realpath 哈希 8 位）。默认实例后缀为空串，历史 label/plist 名/Keychain 服务名零迁移；显式指到默认目录仍是默认身份。
- 2026-10-09：plist 一律留在 `~/Library/LaunchAgents/`，非默认实例用文件名后缀区分（修正上一轮「放到数据目录」的错误提案——launchd 登录不扫描其他目录）。
- 2026-10-09：上下文贯通采用 `bindInstanceHome`（进程入口、配置同步前、显式 API），否决 serve 内改写 process.env（同步已先行 + 污染子进程）。
- 2026-10-09：普通 `config`/`restart` 只 kickstart 对应 label，不重写 plist；启动定义（含环境变量）只在 install / web --daemon 写入——临时改动重启后按 plist 登记目录的已保存配置执行（用户拍板）。
- 2026-10-09：非默认实例托管安装必须 `--manual-codex-config` 或独立 `CODEX_HOME`（config.toml 受管键争用）；`CODEX_CLIPROXY_HOME` 不隔离 Codex 自身配置。
- 2026-10-09（验收修复）：以 AsyncLocalStorage 调用快照替代进程绑定，避免失败、并发及嵌套命令串实例；所有 UI 操作显式使用 ctx.paths。
- 2026-10-09（验收修复）：客户端目录写入安装记录，后续管理恢复原绑定，显式不同目录报错；旧安装优先从生产备份路径恢复，无法判断的非默认旧安装要求提供原 CODEX_HOME。
- 2026-10-09（验收修复）：以完整临时文件的独占发布声明客户端归属；卸载保留状态至清理完成，以 uninstallClientRestored 阶段标记防止重试改写另一实例已接管的配置。

## 后续验收修复

用户授权直接修改以下问题，保持普通配置与重启不改写 plist 的边界：

1. Web UI 的日志展示、列表、内容和开关回填全部使用本实例路径上下文。
2. 从最近存在的真实路径祖先补齐缺失目录，保证软链接下首次创建前后的实例身份不变。
3. 以调用级异步路径上下文替代进程级绑定；失败及并行调用均不影响其他实例。
4. 健康检查各入口统一验证实例标记，不把无标记或其他实例的响应视为启动成功。
5. 校验并记录 Codex 客户端目录归属；管理命令恢复安装时绑定，托管安装防止共享目录争用。

验证使用临时目录及模拟系统调用，不安装、重启或修改本机真实服务与凭据。
