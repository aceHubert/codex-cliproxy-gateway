# Agent Proxy monorepo 迁移指引

本轮将网关迁入 Bun workspace，并将五类 agent 按插件契约装配。
CLI 命令更名为 `agent-proxy`，业务包为 `@agent-proxy/gateway`。
现有 Responses 请求、响应、流式与 compaction 转换保持迁移前行为。
独立的转换封装、通用修复与新增 Chat 适配由
[转换封装与兼容计划](exec-plans/active/llm-bridge-conversion-compatibility.md)
推进；本次目录迁移不代表这些能力已经交付。

## 包与源码位置

根包 `agent-proxy-monorepo` 是 private 工具包，不作为 npm 产品发布。
八个产品包包括业务应用与七个独立包：

| 包名 | 目录 | 职责 |
| --- | --- | --- |
| `@agent-proxy/gateway` | `apps/gateway` | CLI、配置、安装、网关、Web UI 与插件装配 |
| `@agent-proxy/plugin-api` | `packages/plugin-api` | 插件、主机服务、模型归属及生命周期契约 |
| `@agent-proxy/llm-bridge` | `packages/llm-bridge` | 现有外部转换调用的等价导出 |
| `@agent-proxy/zcode` | `packages/zcode` | ZCode 插件 |
| `@agent-proxy/codebuddy` | `packages/codebuddy` | CodeBuddy/WorkBuddy 插件 |
| `@agent-proxy/qoder` | `packages/qoder` | Qoder 插件 |
| `@agent-proxy/agy` | `packages/agy` | Antigravity 插件 |
| `@agent-proxy/opencode-zen` | `packages/opencode-zen` | OpenCode Zen 插件 |

agent 包通过 `plugin-api` 消费主机服务，不反向导入 gateway。
业务组合入口显式装配已安装插件，网关按模型模式确定请求归属。
上游默认转发与 agent 出站链路各自处理，不在失败时互相回退。
现有 CodeBuddy/Qoder 转换复用保留为显式包依赖，后续由转换计划处理。

另有一个不发布的私有包 `@agent-proxy/models`，唯一模型预设源位于 `packages/models/`。网关和插件直接从该包获取模型快照与厂商预设的独立副本，无需主机上下文。各使用方将它声明为开发依赖，构建时内联到发布产物，不增加运行时依赖；发布集合仍为上表八个产品包。

模型覆盖规则的唯一源为 `apps/gateway/models.json`，只允许网关内部用于上游目录并内联进网关产物，不公开包导出。该资源由网关项目自身的 Nx 输入和 Lerna 包内变更判定管理，不作为全包共享输入。ZCode 目录只使用模型包中的 z.ai 预设，不消费网关或运行缓存中的覆盖规则。上游目录的远程覆盖规则及运行实例缓存仍保持原有优先级，缓存不属于仓库源文件。

`CHANGELOG.md` 与 `LICENSE` 只在根目录维护，构建不再向 apps/packages 复制。Lerna 发布时临时提供各包许可证并在结束后清理；本地打包检查模拟同样流程，确认压缩包带有许可证但工作树不留副本。

## 本地构建与 CLI 使用

`@agent-proxy/*` 是本分支的新包名，目前尚未发布到 npm。
先使用仓库构建或本地打包产物验证，不把旧 npm 包当作新 workspace 的安装入口：

```bash
bun install
bun run build
bun apps/gateway/dist/index.js --help
bun apps/gateway/dist/index.js status
bun run pack:check
```

`pack:check` 将八个包打成临时 tarball，在空白消费项目安装并检查导出、
依赖版本与 `agent-proxy --help`。它不发布、不全局安装，也不运行真实 install。
需要自行保留本地 tarball 时，可在完整构建后于各包目录运行 `bun pm pack`。
业务产物必须与对应版本的七个依赖产物一起提供。

开发入口为 `bun run dev <子命令>`；构建后的入口为
`bun apps/gateway/dist/index.js <子命令>`。
文档中的 `agent-proxy` 代表该 bin 安装后的名称。已有子命令和参数保持，
例如 `agent-proxy codebuddy --switch` 与 `agent-proxy models --sync`。

## 默认运行目录与旧安装

新默认运行目录为 `~/.agent-proxy-gateway`，配置文件为
`~/.agent-proxy-gateway/config.json`。
`CODEX_CLIPROXY_HOME`、显式实例目录与 `serve --config` 覆盖继续优先。
环境变量名称与 launchd 服务身份保留；`~/.codex` 配置和缓存不搬入网关目录。

macOS 用户在确认构建产物后运行新入口的 install，例如：

```bash
bun apps/gateway/dist/index.js install
```

只有默认实例的 install 会识别 `~/.codex-cliproxy-gateway`。
它先读取旧配置与安装归属，再把受管文件复制到新默认目录，保留旧目录。
配置合并顺序为新目录已有字段、旧目录缺失字段补充、最后应用新默认值。
未知配置字段、账号选择及已有开关均保留。

迁移仅改写明确受管默认地址：`catalogPath` 的默认派生目录文件、
默认 `logs` 目录以及受管 `models.json` 引用。
自定义目录和远程 URL 不做字符串替换。
每次 install 将配置中的 `$schema` 设置为当前程序提供的网关配置规范地址，
覆盖旧地址或用户自定义地址。
安装状态中的配置镜像同步最终配置；日志、目录缓存、模型覆盖与恢复材料
按受管文件名单复制，已有目标文件优先，原文件权限保留。
非 macOS 凭据文件的迁移经过现有 keychain 分派存储，不输出凭据。

若新旧安装归属或 state 冲突，install 会保留两端文件并报错。
按错误中的字段核对安装归属后再重试，不要通过删掉旧目录规避检查。
迁移与后续安装失败会走回滚路径；旧默认目录不会被自动删除。
显式使用自定义运行目录的实例不触发这项默认目录迁移。

## agent 缺省值

`zcode`、`codebuddy`、`qoder`、`agy` 与 `opencodeZen`
五个开关缺失时均按 `true` 读取。已有 `false` 继续关闭，不因升级覆盖。
新安装保存合并后的默认值；存量配置不因缺省值变化批量重写。
缺省开启只对已装配插件生效，不下载插件、不创建凭据。
没有登录或可用目录时，使用对应客户端登录与现有诊断流程。

CLI 与 Web UI 共同读取有效配置。页面布局、接口、配置字段和账号选择保持，
账号与来源查询在每次请求时读取当前实例状态。
UI 令牌默认位于 `~/.agent-proxy-gateway/ui-token`。

## 保留的旧名称

`agent-proxy` 是当前 CLI 与界面名称；以下旧标识仍承担兼容职责：

- `CODEX_CLIPROXY_*` 环境变量、LaunchAgent 标签、Keychain 服务名及 ownership 文件名：保持已有安装和实例身份。
- `.codex-cliproxy-gateway`：只用于识别旧默认安装并迁移，不再作为新默认目录。
- `x-codex-cliproxy-gateway`：保留本地响应分类与 WebSocket 协商标记；实例健康身份头仍是独立的 `x-ccp-instance`。
- Zen 项目 ID 中的 `codex-cliproxy-gateway:` 哈希前缀：保持同一输入生成的项目身份，不因品牌更名改变上游行为。
- Schema `$id/title`、仓库 URL 和许可证：保持现有配置引用与仓库身份。
- `.agents/plugins` 与 `.claude-plugin` 的 marketplace 名称：属于仓库附带插件市场的身份，本轮网关 CLI 更名没有迁移这些市场标识。

日志检查脚本使用与网关一致的路径解析，默认读取 `.agent-proxy-gateway/logs`，并尊重 `CODEX_CLIPROXY_HOME` 与显式 `--dir`。

## 回归与交付边界

`bun run check` 构建 workspace、检查类型并运行测试；
UI 单独构建使用 `bun run build:ui`。
业务 CLI 与 UI 产物位于 `apps/gateway/dist`，独立包产物位于各自 `dist`。
不要手工编辑构建产物。

验收覆盖 Responses 到五类 agent 的迁移前行为、插件派发与生命周期、
Codex 模型目录、安装回滚以及隔离消费项目的 CLI 调用。
保留现有 Zen Chat 能力；不据此宣称五家新增 Chat 转换已完成。
本地模拟上游与打包冒烟通过后，真实 npm 发布、全局安装及真实用户配置改写
仍属于单独的交付动作。
