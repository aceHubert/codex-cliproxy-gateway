# 密钥存储跨平台兼容：非 macOS 使用 credentials.json 文件后端

## 目标

让 `saveApiKey` / `readApiKey` / `deleteApiKey` 这套密钥存取接口在非 macOS 平台可用：darwin 继续走 `/usr/bin/security` Keychain（行为完全不变），linux / win32 落到 `~/.codex-cliproxy-gateway/credentials.json`（0600、原子写）；`cli.ts` 与 `gateway.ts` 的调用点零改动获得平台兼容，`serve` 在 Linux 上不再因 `/usr/bin/security` 不存在而启动失败。

## 范围

- 包含：
  - `src/keychain.ts` 内部按 `process.platform` 分派后端，模块对外导出的三个函数签名保持不变。
  - `src/paths.ts` 新增 `credentialsFile: path.join(runtimeHome, "credentials.json")`，文件后端经 `resolvePaths()` 取路径。
  - credentials.json 形状：`{ "version": 1, "upstream_api_key": "<key>" }`；`version` 为将来多凭据字段留演进空间。
  - 文件后端实现为接受路径参数的纯函数（save / read / delete），平台分派层负责取路径，单元测试直接注入临时文件路径。
  - 写入用 `atomicWrite`（`toml.ts`，默认 0600），写前确保 `runtimeHome` 目录存在；`deleteApiKey` 保持幂等。
  - 非 darwin 下 `readApiKey` 失败的错误信息指向 credentials.json 具体路径并给出可执行修复提示（重新 install 或手工创建文件），替代现在的 "not found in macOS Keychain"。
  - install 回滚链路（`cli.ts` 的 `previousApiKey` → `saveApiKey` / `deleteApiKey` 恢复）在文件后端下的语义用测试锁定。
  - 损坏 JSON 的处理：`readApiKey` 对 parse 失败抛出说明「文件损坏 + 路径 + 重建方式」的错误，不静默当作缺失（静默缺失会让非 loopback 部署报出误导性的 not found）。
- 不包含：
  - 放开 `requireMacOS()` 对 install / uninstall / web 等命令的整体限制——launchd / LaunchAgent 服务管理在 Linux 上需要 systemd 等替代方案，属于独立的后续工作（记入 tech-debt-tracker）。
  - darwin 上迁移到文件存储或做 Keychain → 文件的双写迁移：macOS 保持 Keychain 单一事实来源。
  - credentials.json 的加密（at-rest 加密、keyring 集成）：第一版只做权限收敛（0600），风险与缓解见下节。
  - Windows 终端交互适配：`readSecretFromTerminal` 依赖 `/bin/bash`，win32 上安装流程仍不可用；文件后端本身平台无关，为将来适配留好地基即可。
  - `schemas/gateway-config.schema.json` 变更：credentials.json 是网关自管密钥文件，不是 `config.json` 配置项，无字段新增。

## 背景

- 相关文档：
  - `AGENTS.md`（安全与配置提示：凭据不得出现在日志 / Web UI / API 响应；原子写入要求）
  - `docs/exec-plans/templates/execution-plan.md`
- 相关代码路径：
  - `src/keychain.ts`：现状三个函数全部 shell 到 `/usr/bin/security`；`keychainAccount()`（`process.env.USER`）仅对 Keychain 后端有意义。
  - `src/paths.ts`：`resolvePaths()`（`HOME || os.homedir()` 派生 `runtimeHome`），新增 `credentialsFile` 字段。
  - `src/toml.ts:140`：`atomicWrite(file, contents, mode = 0o600)`，直接复用。
  - `src/cli.ts`：`getInstallApiKey`（304）、install 保存与回滚（740–829）、卸载清理（829、865）、status 读取（923）；`serve`（1035）不设 macOS 门槛，是当前非 darwin 下的实际断点。
  - `src/gateway.ts`：handler 创建时 `readApiKey()`（630）、realtime target `readApiKey(isLoopbackUrl(...))`（1020）。
- 已知约束：
  - 单文件构建产物（`bun build src/index.ts`），不能引入原生依赖或外部凭据库；文件后端只用 Node 标准库。
  - `process.platform` 在测试内不可 mock，因此平台分派必须是可注入的（工厂函数接受 platform / 路径参数），保证 macOS 开发机上能覆盖 linux 后端的全部行为。
  - 密钥文件绝不能进入请求日志、`gateway.log` 审计与 `/ui/api/*` 响应；现有 `SENSITIVE_HEADERS` / `sanitizeUrlValue` 边界不需要改动，但新增代码不得破例。

## 风险

- 风险：明文凭据落盘，安全性弱于 Keychain 加密存储。
  缓解：文件 0600 + `runtimeHome` 目录权限收敛；README 与错误提示注明该文件包含明文密钥、勿拷贝分享；密钥本身绝不输出到任何日志 / UI / API 响应（沿用既有遮蔽规则）。
- 风险：`HOME` 指向共享或非常规路径（CI、容器）时密钥写到意外位置。
  缓解：路径统一经 `resolvePaths()` 派生（与 config.json、ui-token 同源同目录），错误信息里始终带绝对路径，用户可自查；不为 credentials.json 单独增加路径覆盖环境变量，避免多一套路径语义。
- 风险：重构分派结构时改变 darwin 现有行为（install 回滚、幂等卸载）。
  缓解：M1 做纯重构（不新增文件后端），现有 `bun run check` 全绿后再叠加实现；darwin 后端调用参数逐字保留。
- 风险：损坏或手改过的 credentials.json 让网关启动失败，用户难以定位。
  缓解：parse 失败抛出含路径与重建指引的明确错误；`readApiKey(optional)` 的 loopback 豁免语义只作用于「文件不存在 / 空 key」，不吞 parse 错误。
- 风险：文件写入中途崩溃留下半写文件。
  缓解：统一走 `atomicWrite`（临时文件 + rename），不手写 `writeFileSync` 直写。

## 里程碑

1. **M1 纯重构**：`keychain.ts` 拆为「平台分派 + darwin 后端」，导出函数签名与 darwin 行为不变；`paths.ts` 增加 `credentialsFile`；`bun run check` 全绿。
2. **M2 文件后端**：实现 credentials.json 的 save / read / delete 纯函数并接入分派；新增 `test/credentials-store.test.ts` 覆盖：save→read 往返、空 key 走 delete、delete 幂等、0600 权限、损坏 JSON 报错含路径、非 darwin 错误文案；补 install 回滚链路在文件后端下的测试。
3. **M3 验证与收尾**：Linux 环境（Docker 或 CI）实际运行 `serve` 走一遍「写 key → 网关启动 → 转发带 Authorization」；README / AGENTS.md 增补 credentials.json 说明与安全提示；tech-debt-tracker 记录「非 macOS 的服务管理（systemd）与 Windows 终端交互」两项后续债务。

## 验证方式

- 命令：`bun run check`（类型检查 + 全部测试 + 构建）。
- 手工检查（macOS 回归）：`bun run dev install` 后 `security find-generic-password -s codex-cliproxy-gateway -w` 仍能取到 key；卸载后条目消失。
- 手工检查（Linux / 容器）：`HOME=<临时目录> bun run dev serve` 前置写好 credentials.json，网关启动并向上游转发带 `Authorization: Bearer ...`；删除文件后非 loopback 配置应报含路径的错误。
- 观测检查：`gateway.log` 与请求日志中不出现明文 key；`/ui/api/*` 响应不含 credentials.json 内容。

## 进度记录

- [x] M1：完成 keychain.ts 平台分派重构，darwin 行为不变（`createApiKeyStore` 工厂 + darwin 后端原参数保留）。
- [x] M2：credentials.json 后端实现与测试全部落地（`src/credentials-store.ts` + `test/credentials-store.test.ts`，10 个用例全绿，含评审修复的 EISDIR/EACCES）。
- [x] M3：文档与债务登记收尾（README / AGENTS.md / tech-debt-tracker）；按用户确认，验收以单元测试为准，Linux 真机 / 容器验证推迟为债务。

## 决策记录

- 2026-09-13：创建计划。后端选择按 `process.platform` 在 `keychain.ts` 内部分派，保持三个导出函数签名不变，消费方（`cli.ts` / `gateway.ts`）零改动；macOS 不做双写迁移，Keychain 仍是唯一事实来源；文件后端实现为接受路径的纯函数以便在 macOS 开发机上测试 linux 分支。
- 2026-09-13：不做独立的 credentials.json 路径覆盖环境变量，路径统一从 `HOME` 经 `resolvePaths()` 派生，与 config.json / ui-token 同源，避免多一套路径语义。
- 2026-09-13：用户确认范围调整——暂无 Windows 适配需求，验收以单元测试为准（不跑 Linux 真机 / 容器全链路）；「Linux 真机 serve 全链路验证」与「Windows 终端交互 / NTFS 权限语义」两项登记进 tech-debt-tracker。
- 2026-09-13：M1/M2 合并为一次实现推进（分派工厂与文件后端互相依赖，拆开提交中间态不可编译）；darwin 分支逐字保留原 `security` 调用参数，回归靠现有全量测试（296 通过）覆盖。
- 2026-09-13：评审修复——读取失败的缺失豁免收窄到 ENOENT：凭据路径被目录占用（EISDIR，已复现）或权限不可读（EACCES）时，任何 optional 取值都必须带 errno 原因、路径与 `cause` 抛出，不得静默返回空 key（否则 loopback 网关会带着空 Authorization 启动、把鉴权失败推迟到上游暴露）；「文件不存在」的错误文案也只在该场景出现。补 EISDIR/EACCES 两个测试（root 环境跳过 EACCES）。
