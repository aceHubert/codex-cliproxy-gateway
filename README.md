# codex-cliproxy-gateway

A small cross-platform, Bun-powered local gateway for Codex Desktop and Codex CLI.

It keeps Codex signed in with ChatGPT for native models, while models whose IDs begin with `cliproxy/` are sent to CLIProxyAPI with a separate API key.

## 使用前准备

- 安装 Bun 1.2+ 和 Codex Desktop 或 Codex CLI。
- 准备可访问的 CLIProxyAPI 或 new-api 服务。
- 同时使用官方模型时，先在 Codex 中登录 ChatGPT；只使用第三方上游可选
  `--upstream-only`。
- 自动安装、卸载及后台服务管理目前仅支持 macOS。其他 Bun 支持的平台可手动配置后
  前台运行，见[手动运行](#手动运行)。

## 安装与首次使用

以下自动安装步骤适用于 macOS：

```bash
npm install -g codex-cliproxy-gateway
codex-cliproxy install
```

默认连接本机上游 `http://127.0.0.1:8317/v1`，网关端口为 `8320`。
按提示输入 API Key 并选择要在 Codex 中显示的模型：

- `↑` / `↓` 移动，空格勾选，回车确认。
- 本机上游（`127.0.0.1`、`localhost` 或 `::1`）可以不填 Key；远程上游必须提供。
- 安装会备份并更新 Codex 配置、启动网关，保留原有登录状态。

安装完成后，**完全退出并重新打开 Codex Desktop**；使用 CLI 时重新启动 Codex。
默认模式下，官方模型保持原名，第三方上游模型带 `cliproxy/` 前缀。

### 连接远程上游

```bash
codex-cliproxy install --upstream-url https://cliproxy.example/v1
```

命令会隐藏输入的 Key。也可以通过环境变量传入：

```bash
API_KEY='your-key' codex-cliproxy install \
  --upstream-url https://cliproxy.example/v1
```

使用其他环境变量名时，添加 `--key-env NAME`。

### 使用 new-api

```bash
codex-cliproxy install \
  --upstream-type newapi \
  --upstream-url https://newapi.example.com/v1
```

new-api 渠道需要支持 Codex 使用的 `/v1/responses`。
未登录 ChatGPT、只使用该上游时，添加 `--upstream-only`。

### 只使用第三方上游

```bash
codex-cliproxy install --upstream-only --select all
```

此模式使用上游原始模型名，不添加 `cliproxy/` 前缀，
也不提供官方、ZCode 或 CodeBuddy/WorkBuddy 模型。

### 常用安装参数

| 参数 | 用途 |
| --- | --- |
| `--upstream-url URL` | 设置上游地址，通常以 `/v1` 结尾。 |
| `--upstream-type cliproxy\|newapi` | 选择上游类型，默认 `cliproxy`。 |
| `--port PORT` | 设置网关端口，默认 `8320`。 |
| `--prefix PREFIX` | 设置第三方模型前缀，默认 `cliproxy/`。 |
| `--select SELECTOR` | 直接指定模型，支持序号、范围、模型 ID、通配符（如 `gpt-*`）、`all` 或 `none`。 |
| `--upstream-only` | 只使用第三方上游。 |
| `--restart-codex` | 停止当前 Codex app-server，让后续会话重新加载配置。 |
| `--yes` | 再次安装时跳过原地更新确认。 |

重复运行 `install` 可以更新上游地址、类型等设置，无需先卸载。
无人值守安装时显式提供 `--select`；更新已有安装时可同时添加 `--yes`。

## 选择与刷新模型

```bash
# 查看当前选中的第三方上游模型
codex-cliproxy models

# 拉取最新列表并重新选择，使用默认混合模式
codex-cliproxy models --sync

# 选择全部模型，保持或切换到仅上游模式
codex-cliproxy models --sync --upstream-only --select all
```

**不带 `--upstream-only` 的同步命令会切回混合模式。**
刷新时会复用已保存的上游 Key。

也可以直接指定选择：

```bash
codex-cliproxy models --sync --select "1,3,5-8"
codex-cliproxy models --sync --select "claude-opus-4-6,gemini-3.1-pro"
codex-cliproxy models --sync --select "gpt-*"
```

模型 ID 以当前上游列表为准；`*` 匹配任意字符，`?` 匹配单个字符，
通配符没有命中时按空选择处理。`--select none` 可清空第三方上游选择。

如需使用维护者提供的模型元数据文件，可在安装或同步时添加：

```bash
codex-cliproxy models --sync --model-merge-json https://github.com/owner/repo
```

也支持直接提供 HTTP(S) 的 `models.json` 文件地址；仓库地址使用最新 Release 的文件。

### 何时需要重启 Codex

- 安装后、切换混合/仅上游模式后：重启 Codex。
- 仅上游模式下修改模型选择：重启 Codex 才能加载新列表。
- 混合模式下修改模型选择：等待自动刷新；列表仍未更新时再重启。
- `codex-cliproxy restart` 默认只重启网关。

`install`、`uninstall`、`restart` 和 `models --sync` 都支持
`--restart-codex`。它会停止当前 Codex app-server，**可能中断正在执行的任务**，
不会主动启动替代进程；必要时重新打开 Codex。

## Web 配置界面

```bash
codex-cliproxy web
```

命令会检查并按需启动网关，然后打开浏览器。默认地址为
`http://127.0.0.1:8321/ui`；自定义网关端口时，界面端口为网关端口加 1。
按 `Ctrl-C` 停止前台界面服务，网关继续运行。

界面支持修改配置、选择上游模型、查看日志及中英文切换。
保存后按页面提示应用设置或重启 Codex。

| 命令 | 用途 |
| --- | --- |
| `codex-cliproxy web --daemon` | 后台运行界面并打开浏览器。 |
| `codex-cliproxy web --status` | 查看界面服务状态和地址。 |
| `codex-cliproxy web --stop` | 停止后台界面服务。 |
| `codex-cliproxy web --restart` | 重启后台界面服务。 |

界面默认关闭，仅允许本机访问。请通过 `web` 打开带访问令牌的链接；
页面要求输入令牌时，可从 `~/.codex-cliproxy-gateway/ui-token` 获取。
后台界面不会在重新登录或重启电脑后自动开启，需再次运行 `web --daemon`。

## 配置与日志

```bash
# 查看当前配置
codex-cliproxy config

# 开启请求日志，并限制保留量
codex-cliproxy config --log on --max-request-logs 100 --max-log-size 10MB

# 关闭请求日志
codex-cliproxy config --log off
```

| 参数 | 用途 |
| --- | --- |
| `--log on\|off` | 开关请求日志，默认关闭。 |
| `--max-request-logs N` | 请求日志目录最多保留的文件数，`0` 表示不限。 |
| `--max-log-size SIZE` | 主日志大小上限，支持 `512KB`、`10MB`、`1M`；`0` 表示不限。 |
| `--zcode on\|off` | 开关 ZCode 模型，默认关闭。 |
| `--codebuddy on\|off` | 开关 CodeBuddy/WorkBuddy 模型，默认关闭。 |

参数可以组合使用。CLI 配置写入仅支持 macOS：已安装后台服务时自动重启网关，
没有后台服务时仅保存配置，需自行重启前台进程。
如提示配置已保存但重启失败，执行 `codex-cliproxy restart`。

常用文件位置：

- 配置：`~/.codex-cliproxy-gateway/config.json`
- 主日志：`~/.codex-cliproxy-gateway/gateway.log`
- 请求日志：`~/.codex-cliproxy-gateway/logs/`

请求日志数量限制作用于整个目录，正在写入的文件可能使数量暂时超出上限。
主日志达到大小上限后轮换，保留最近 5 份备份。

### 使用 ZCode 模型

先在本机 ZCode 中登录并选择可用的渠道与套餐，然后开启：

```bash
codex-cliproxy config --zcode on
```

在 Codex 中选择 `zcode/` 开头的模型，例如 `zcode/glm-5.3`。
可用型号取决于当前 ZCode 配置与网关支持范围；登录失效时请回到 ZCode 处理。

关闭：

```bash
codex-cliproxy config --zcode off
```

### 使用 CodeBuddy/WorkBuddy 模型

先在本机 CodeBuddy/WorkBuddy 中登录，然后开启：

```bash
codex-cliproxy config --codebuddy on
```

在 Codex 中选择 `codebuddy/` 或 `workbuddy/` 开头的模型，
实际列表取决于当前登录的产品和账号权限。网关不会代为登录或刷新登录凭据；
提示凭据过期或即将过期时，请回到对应客户端重新登录。

关闭：

```bash
codex-cliproxy config --codebuddy off
```

这两类接入均需网关监听本机环回地址，并且在 `--upstream-only` 模式下不生效。
Web 界面检测到本机配置后会显示对应开关；已经开启的开关会保留显示，方便关闭。

## 服务管理与卸载

以下服务管理命令适用于 macOS 自动安装：

| 命令 | 用途 |
| --- | --- |
| `codex-cliproxy status` | 查看网关状态、当前模式及安装信息。 |
| `codex-cliproxy start` | 启动网关。 |
| `codex-cliproxy stop` | 停止网关及后台 Web 界面。 |
| `codex-cliproxy restart` | 重启网关。 |
| `codex-cliproxy uninstall` | 卸载服务并恢复由网关管理的 Codex 设置。 |

卸载会保留网关的 `config.json`，方便再次安装，并保留 Codex 配置中的无关修改。
卸载后重启 Codex；如需移除 npm 包，再执行：

```bash
npm uninstall -g codex-cliproxy-gateway
```

## 手动运行

网关可在 Bun 支持的平台前台运行，需要先准备好配置文件：

```bash
codex-cliproxy serve --config /path/to/config.json
```

不传 `--config` 时使用 `~/.codex-cliproxy-gateway/config.json`。
手动部署还需配置 Codex 的连接地址与模型目录；配置字段见
[配置格式](schemas/gateway-config.schema.json)。`serve` 本身不执行安装或启动 Web 界面。
非 macOS 平台需自行编辑配置文件和管理进程，不能使用上述安装、卸载、
后台服务管理及 `config --...` 写入命令。

macOS 的上游 Key 保存在登录钥匙串中。其他平台需手动准备
`~/.codex-cliproxy-gateway/credentials.json`，内容如下，并将权限设为仅本人可读写
（Linux 为 `0600`）：

```json
{
  "version": 1,
  "upstream_api_key": "your-key"
}
```

该文件包含明文密钥，请妥善保管；仅本机上游允许使用空 Key。

其他平台需要 Web 界面时，使用默认位置的配置文件，在另一个终端执行
（以下为 POSIX shell 写法）：

```bash
CODEX_CLIPROXY_UI_SERVICE=1 codex-cliproxy web
```

此方式只运行界面服务，需自行启动网关并在浏览器打开界面地址。

## 常见问题

- **安装后看不到模型**：先运行 `codex-cliproxy status` 检查网关，
  再运行 `models --sync` 重新选择，最后重启 Codex。
  使用仅上游模式时，同步命令需加 `--upstream-only`。
- **CLIProxy 模型缺少 `max` / `ultra` 思考等级**：
  检查 `status` 的 `codexClientVersion` 是否正确，更新本机 Codex CLI 后重新同步。
  必要时用 `CODEX_CLIPROXY_CLIENT_VERSION` 指定实际使用的客户端版本。
- **ZCode 或 CodeBuddy/WorkBuddy 模型不可用**：
  确认对应客户端已登录、开关已开启，且网关未处于仅上游模式。
- **无法打开 Web 界面**：重新运行 `codex-cliproxy web`；
  若提示后台界面占用端口，先运行 `web --stop`。
- **手动改了配置但未生效**：修改网关配置后重启网关，
  修改 Codex 配置后重启 Codex。日常调整优先使用命令或 Web 界面。
