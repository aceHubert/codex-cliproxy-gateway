# Agent Proxy 网关使用手册

基于 Bun 的跨平台本地网关，为 Codex Desktop 和 Codex CLI 提供官方模型、CLIProxyAPI/new-api 上游与本机 agent 模型。

官方模型保留 Codex 的 ChatGPT 登录；`cliproxy/` 模型使用独立上游 API Key。
ZCode、CodeBuddy/WorkBuddy、Qoder、AGY 与 OpenCode Zen 通过显式装配的插件接入。
安装包为 `@agent-proxy/gateway`，命令入口为 `agent-proxy`。
从旧版本升级时，安装目录与旧安装处理见
[升级指引](https://github.com/aceHubert/codex-cliproxy-gateway/blob/main/docs/monorepo-migration.md)。

## 使用前准备

- 安装 Bun 1.2+ 和 Codex Desktop 或 Codex CLI。
- 准备可访问的 CLIProxyAPI 或 new-api 服务。
- 同时使用官方模型时，先在 Codex 中登录 ChatGPT；只使用第三方上游可选
  `--upstream-only`。

## 安装与首次使用

```bash
npm install -g @agent-proxy/gateway
agent-proxy install
```

默认连接本机上游 `http://127.0.0.1:8317/v1`，网关端口为 `8320`。
默认运行目录是 `~/.agent-proxy-gateway`。首次从旧默认目录安装时，
`install` 会合并用户设置并复制受管文件，保留旧目录；自定义实例目录不自动迁移。
按提示输入 API Key 并选择要在 Codex 中显示的模型：

- `↑` / `↓` 移动，空格勾选，回车确认。
- 本机上游（`127.0.0.1`、`localhost` 或 `::1`）可以不填 Key；远程上游必须提供。
- 安装会备份并更新 Codex 配置、启动网关，保留原有登录状态。

安装完成后，**完全退出并重新打开 Codex Desktop**；使用 CLI 时重新启动 Codex。

### 连接远程上游

```bash
agent-proxy install --upstream-url https://cliproxy.example/v1
```

命令会隐藏输入的 Key。也可以通过环境变量传入：

```bash
API_KEY='your-key' agent-proxy install \
  --upstream-url https://cliproxy.example/v1
```

使用其他环境变量名时，添加 `--key-env NAME`。

重装同一实例时，只要上游地址和类型未变且已有 Key，就会自动复用，跳过密钥输入。
显式提供 `API_KEY` 或 `--key-env NAME` 时优先使用指定来源；更换上游或缺少已存 Key 时仍会提示输入。
显式空 Key 只允许本机上游，不会被当成“保留旧 Key”。

### 使用 new-api

```bash
agent-proxy install \
  --upstream-type newapi \
  --upstream-url https://newapi.example.com/v1
```

### 只使用上游模式

```bash
agent-proxy install --upstream-only --select all
```

未登录 ChatGPT、只将请求转发到上游，不使用本地授权账号配置模型。

### 常用安装参数

| 参数 | 用途 |
| --- | --- |
| `--upstream-url URL` | 设置上游地址，通常以 `/v1` 结尾。 |
| `--upstream-type cliproxy\|newapi` | 选择上游类型，默认 `cliproxy`。 |
| `--upstream-only` | 初始化仅上游模式。 |
| `--port PORT` | 设置网关端口，默认 `8320`。 |
| `--select SELECTOR` | 直接指定模型，支持序号、范围、模型 ID、通配符（如 `gpt-*`）、`all` 或 `none`。 |
| `--manual-codex-config` | 不修改 `~/.codex/config.toml`，安装后以 warning 打印需要手动配置的键与值。与 `--upstream-only` 同用时会询问「是否直接修改 codex 配置」：答 `y` 转为托管写入（本参数不生效），默认 `N` 保持手动模式。 |
| `--restart-codex` | 停止当前 Codex app-server，让后续会话重新加载配置。 |
| `--yes` | 再次安装时跳过原地更新确认。 |

重复运行 `install` 可以更新上游地址、类型等设置，无需先卸载。
每次安装都会将 `config.json` 的 `$schema` 更新为当前程序提供的网关配置规范地址，
覆盖旧地址或用户自定义地址。

无人值守安装时显式提供 `--select`；更新已有安装时可同时添加 `--yes`。

## 选择与刷新模型

```bash
# 查看当前选中的第三方上游模型
agent-proxy models

# 拉取最新列表并重新选择，保留已保存的模式
agent-proxy models --sync

# 选择全部上游模型，保留已保存的模式
agent-proxy models --sync --select all

# 安装后切换模式，目录与配置就绪后重载 Codex
agent-proxy config --upstream-only on --restart-codex
agent-proxy config --upstream-only off --restart-codex
```

**`models` 只读取已保存的模式，不切换模式。** 模式修改使用
`config --upstream-only on|off`；`install --upstream-only` 仍是布尔安装参数。
Web 界面的 upstream-only 路由模式只读，Web API 不接受该字段的修改。
旧的 `models --sync --upstream-only` 和 `--cpa-only` 会在写盘前报错并提示迁移。
刷新时会复用已保存的上游 Key，同时更新已启用兼容端目录与请求所需元数据。
`--sync`、实际改变规则的 `--exclude` 通过热加载更新运行网关的模型配置，
不重启网关；模式、端口或兼容端开关等结构配置修改仍按原流程重启。

模型更新按已保存的 `upstreamOnly` 决定是否更新 Codex 静态目录。
静态文件位于运行主目录的 `codex-catalog.json`，与原始上游目录分开管理。
手动模式（`install --manual-codex-config`）下，后续命令读取安装状态决定管理权限，
无需重复携带安装参数；工具自管目录照常更新，用户 TOML 保持不变。
命令会打印 `model_catalog_json` 的添加或删除指引、期望值与当前匹配情况。
`status` 的 `codexConfigManaged` 字段可查看管理状态。

也可以直接指定选择：

```bash
agent-proxy models --sync --select "1,3,5-8"
agent-proxy models --sync --select "claude-opus-4-6,gemini-3.1-pro"
agent-proxy models --sync --select "gpt-*"
```

模型 ID 以当前上游列表为准；`*` 匹配任意字符，`?` 匹配单个字符，
通配符没有命中时按空选择处理。`--select none` 会直接清空第三方上游选择。

如需使用维护者提供的模型元数据文件，可在安装或同步时添加：

```bash
agent-proxy models --sync --model-merge-json https://github.com/owner/repo
```

也支持直接提供 HTTP(S) 的 `models.json` 文件地址；仓库地址使用最新 Release 的文件。

### 排除模型（excludedModels）

过滤掉不需要在模型选择中显示的模型，Codex 模型选择上限是100条。

**命令行**使用带完整前缀的规则：

```bash
# 终端交互勾选：列出当前全部本地兼容模型（完整 ID + 显示名），
# 空格切换排除、回车保存；已排除的精确 ID 会预勾选
agent-proxy models --exclude

# 直接追加排除规则（逗号或空格分隔，支持多条）
agent-proxy models --exclude "codebuddy*/gpt-4o, agy/gemini-2.5-flash"

# 含字面量的通配（匹配 qoder-cn/ 下的 qoder-code 系列等）
agent-proxy models --exclude "qoder-cn/qoder-*"

# 清空排除列表
agent-proxy models --exclude none
```

规则约束（CLI 与 Web 写入路径一致，大小写不敏感）：

| 规则形态 | 示例 | 说明 |
| --- | --- | --- |
| 完整模型 ID | `agy/gemini-2.5-flash`、`zcode-team-coding-plan/glm-5.3` | 必须带确定的适配器前缀 |
| 产品级家族通配 | `zcode*/glm-5.3`、`codebuddy-*/gpt-4o`、`qoder-*/qwen-3.8-flash` | 一条覆盖该产品的全部套餐/地域/旧前缀（Web 各产品框即存此形态） |
| 前缀后的通配 | `qoder-cn/qoder-*`、`zcode/glm*` | `*` 只允许出现在完整前缀之后 |
| ~~整族形态~~ | ~~`qoder-cn/`、`qoder-cn/*`~~ | **写入时拒绝**：排除整个端请关闭对应开关（`config --qoder off` 等） |
| ~~无前缀/不完整前缀~~ | ~~`gpt-*`、`zcode-*`、裸模型名~~ | **写入时拒绝**：必须从完整适配器前缀开始 |
| ~~作用域外规则~~ | ~~`cliproxy/…`、官方模型 ID~~ | **写入时拒绝**：上游模型用 `models --sync` 选择；官方模型不可排除 |


### 何时需要重启 Codex

- 安装后、切换混合/仅上游模式后：重启 Codex。
- 仅上游模式下修改模型选择或排除规则：重启 Codex 才能加载新静态列表。
- 混合模式下修改模型选择：等待自动刷新；列表仍未更新时再重启。
- `agent-proxy restart` 默认只重启网关。

`install`、`uninstall`、`restart`、`config`、`models --sync`、`models --exclude` 支持
`--restart-codex`。它会停止
当前 Codex app-server，**可能中断正在执行的任务**，不会主动启动替代进程；必要时
重新打开 Codex。模式切换或模型更新会先完成目录、受管 TOML 与安装状态更新，
再执行可选重载；手动配置模式下仍需先按指引完成 TOML，重载不会代为修复配置。

## Web 配置界面

```bash
agent-proxy web
```

打开 Web 配置 `http://127.0.0.1:8321/ui`。

| 命令 | 用途 |
| --- | --- |
| `agent-proxy web --daemon` | 后台运行界面并打开浏览器。 |
| `agent-proxy web --status` | 查看界面服务状态和地址。 |
| `agent-proxy web --stop` | 停止后台界面服务。 |
| `agent-proxy web --restart` | 重启后台界面服务。 |

页面要求输入令牌时，可从 `~/.agent-proxy-gateway/ui-token` 获取。

## 配置与日志

```bash
# 查看当前配置
agent-proxy config

# 切换仅上游模式，目录就绪后重载 Codex
agent-proxy config --upstream-only on --restart-codex

# 开启请求日志，并限制保留量
agent-proxy config --log on --max-request-logs 100 --max-log-size 10MB

# 关闭请求日志
agent-proxy config --log off
```

| 参数 | 用途 |
| --- | --- |
| `--debug on\|off` | 开关调试日志，默认关闭。 |
| `--log on\|off` | 开关请求日志，默认关闭。 |
| `--upstream-only on\|off` | 修改保存的模式；default 选择上游或混合路由，不禁用已开启兼容端。 |
| `--restart-codex` | 配置、目录与状态就绪后停止 Codex app-server，让客户端重新加载。 |
| `--max-request-logs N` | 请求日志目录最多保留的文件数，`0` 表示不限。 |
| `--max-log-size SIZE` | 主日志大小上限，支持 `512KB`、`10MB`、`1M`；`0` 表示不限。 |
| `--zcode on\|off` | 开关 ZCode 模型，缺省开启。 |
| `--codebuddy on\|off` | 开关 CodeBuddy/WorkBuddy 模型，缺省开启；账号使用 `agent-proxy codebuddy --switch`。 |
| `--qoder on\|off` | 开关本机 Qoder 模型，缺省开启；支持国际版与国内版。 |
| `--agy on\|off` | 开关本机 Antigravity（`agy/`）模型，缺省开启。 |
| `--opencode-zen on\|off` | 开关 OpenCode Zen 模型，缺省开启。 |


五类 agent 的缺失开关按 `true` 读取；已有 `false` 保持关闭。开启只作用于已装配
的插件，不创建登录凭据。没有登录或可用模型目录时，先检查对应客户端与网关诊断。

## 服务管理与卸载

以下服务管理命令：

| 命令 | 用途 |
| --- | --- |
| `agent-proxy status` | 查看网关状态、当前模式及安装信息。 |
| `agent-proxy start` | 启动网关。 |
| `agent-proxy stop` | 停止网关及后台 Web 界面。 |
| `agent-proxy restart` | 重启网关。 |
| `agent-proxy uninstall` | 卸载服务并恢复由网关管理的 Codex 设置。 |

卸载会保留网关的 `config.json`，方便再次安装，并保留 Codex 配置中的无关修改。
卸载后重启 Codex。现行业务包名为 `@agent-proxy/gateway`。旧 npm 包
`codex-cliproxy-gateway` 的用户可在确认迁移完成后自行卸载旧包，
旧包与旧命令的发布历史保留。

## 手动运行

网关可在 Bun 支持的平台前台运行，需要先准备好配置文件：

```bash
agent-proxy serve --config /path/to/config.json
```

不传 `--config` 时使用 `~/.agent-proxy-gateway/config.json`。
手动部署还需配置 Codex 的连接地址与模型目录；配置字段见
[配置格式](schemas/gateway-config.schema.json)。`serve` 本身不执行安装或启动 Web 界面。

上游 API Key 在 macOS 保存在登录钥匙串中，其他平台保存在
`~/.agent-proxy-gateway/credentials.json`，权限应为仅本人可读写（Linux 为 `0600`）。
手动部署时可直接创建该文件，内容如下：

```json
{
  "version": 1,
  "upstream_api_key": "your-key"
}
```

该文件包含明文密钥，请妥善保管；仅本机上游允许使用空 Key。

需要单独前台运行 Web 界面时，使用默认位置的配置文件，在另一个终端执行
（以下为 POSIX shell 写法）：

```bash
CODEX_CLIPROXY_UI_SERVICE=1 agent-proxy web
```

此方式只运行界面服务，需自行启动网关并在浏览器打开界面地址。

## 常见问题

- **安装后看不到模型**：先运行 `agent-proxy status` 检查网关，
  再运行 `models --sync` 重新选择，最后重启 Codex。
  同步保留已保存的模式；模式切换使用 `config --upstream-only on|off`。
- **CLIProxy 模型缺少 `max` / `ultra` 思考等级**：
  检查 `status` 的 `codexClientVersion` 是否正确，更新本机 Codex CLI 后重新同步。
  必要时用 `CODEX_CLIPROXY_CLIENT_VERSION` 指定实际使用的客户端版本。
- **ZCode 或 CodeBuddy/WorkBuddy 模型不可用**：
  确认对应客户端已登录、开关已开启。
  CodeBuddy 提示地域无凭据时，运行 `agent-proxy codebuddy --switch`
  确认当前锁定的账号及其地域，或切回 `auto`。
- **无法打开 Web 界面**：重新运行 `agent-proxy web`；
  若提示后台界面占用端口，先运行 `web --stop`。
- **手动改了配置但未生效**：修改网关配置后重启网关，
  修改 Codex 配置后重启 Codex。日常调整优先使用命令或 Web 界面。

源码结构、开发命令与验证流程见
[项目说明](https://github.com/aceHubert/codex-cliproxy-gateway#readme)。
