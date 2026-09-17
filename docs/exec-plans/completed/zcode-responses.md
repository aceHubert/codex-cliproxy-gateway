# ZCode 接入 Codex Responses

## 目标

替换旧 /zai Claude Code 入口，以 zcode:boolean 开关接入 Codex Responses HTTP/SSE。根据 ZCode 当前 provider 合并 z.ai/bigmodel 模型目录，使用 llm-bridge 完成 Anthropic 转换，并保留 freeform 工具、多轮历史、取消和 compaction。

## 范围

- 三份文件 setting.json/config.json/credentials.json 独立采用根目录优先、仅不存在回退 v2。
- 设置选择当前渠道及完整 provider ID，实际地址和 Key 使用所选 config provider options；credentials 只观察计划授权变化，不直接代替业务 Key，不执行 OAuth 兑换。
- 文件事件仅候选检查：100ms 防抖、首事件起500ms上限；只比较相关字段，无关变化不清空快照、不重建Key、不延后期限。
- config仅改变URL/可用性时不重建凭证；credentials变更检查所选provider，Key同值保留。
- 实际Key有JWT exp时按绝对秒时间失效，无exp不猜TTL；过期共享重读，同值过期Key等待文件修复。
- 顶层z.ai/或bigmodel/目录和路由独立于cliproxy前缀；WS426，JSON/SSE双向转换，freeform工具包装还原。
- 日志zai/bigmodel-v1-responses-http-时间戳，脱敏且不复制消费流。
- 不改正式运行配置、不重启现有服务、不提交或发布。

## 背景

基于前次独立worktree已有未提交改动实施，任务开始已在系统临时目录保存tracked/untracked基线。旧completed计划保持历史原貌，本计划取代其“任意事件立即清空授权并等待”的缓存策略。

## 风险

协议转换需补齐llm-bridge工具历史、SSE完整事件、usage和thinking；请求凭据和Codex OAuth不得泄露。并发通过独立检查代次/凭证代次保护，在途请求固定快照。

## 里程碑

1. [x] 保存任务前基线，复核实施约束。
2. [x] 实现配置、三文件差分缓存和过期管理。
3. [x] 实现llm-bridge协议适配、模型目录与网关路由。
4. [x] 实现渠道日志、补齐回归和独立审查。
5. [x] bun run check通过；同步README、增量history并归档。

## 验证方式

所有测试使用虚构凭证、临时目录和模拟上游，最大60秒超时。验证100次无关写入Key构建为0、连续写入不饥饿、真实Key变更只构建一次、URL变化保留Key期限、JWT过期、文件优先级/损坏/原子替换/关闭、两渠道三模式、目录路由、SSE/JSON、function/freeform工具循环、取消、错误、compaction和日志脱敏。最终执行bun run check。

## 决策记录

- 2026-09-12：按用户最终确认实施，复用ZCode保存的业务Key而非登录access_token；文件事件与凭据更新分离。

## 后续确认

- 2026-09-12：当前provider.models字典键与vendor z.ai取大小写不敏感交集；外部ID规范化，上游保留配置原拼写，模型变化不重建Key。
- 2026-09-12：新增zcode-catalog.json共享裸ID磁盘缓存，启动校验源及内容哈希，/models仅筛选及合并，套餐切换不重写缓存。
- 2026-09-12：只支持config --zcode on/off，不新增位置参数形式；复用配置写入、状态、审计和重启流程。
- 2026-09-12：专项测试覆盖namespace独立字段、thinking真实响应回放、工具列表变化、截图工具结果以及SSE错误转义密钥脱敏。
- 2026-09-12：首次全量218测试中217通过，唯一失败为同版本补全无关配置导致旧审计null变0；已改为同版本仅补zcode。
- 2026-09-12：独立审查指出Realtime WS误拦截、缺省日志目录和工具图片结果三个P2；均已修复并补回归。

## 最终验证

- bun run check通过：221项测试、0失败、0跳过，包含原生fs.watch；严格类型检查及Bun单文件构建通过。测试使用虚构Keychain，原生fetch仅允许环回。
- 独立复核确认三项P2修复及同版本审计回归已解决。
- 工作代码在临时副本完成和验证后，按开始前快照比对，将本次增量同步到用户指定的原worktree；不重启现有服务。

## 模型 API 请求补充（2026-09-12）

- 用户补充参考会话“分析 ZCode 特殊请求头”，随后明确范围为“只有api请求”。本轮仅补模型 API 自身，不新增动态配置拉取、握手、签名、PoW、OAuth兑换、验证码或额外重试。
- 套餐由完整builtin provider ID识别：Coding/API Key双鉴权，Start仅Bearer当前config中ZCode保存的计划JWT，凭据来源和三文件差分缓存不变。
- 模型请求增加受控来源头和随机请求/追踪/query标识；Codex thread/session按账号作用域映射为内部会话UUID，900秒闲置TTL、最多1024条，关闭释放。
- 请求正文清理非system旧cache_control，只在最后合法非thinking块设置ephemeral；metadata.user_id只使用空account_uuid及内部session，不读取设备遥测，不注入客户端私有system prompt。
- 日志增加脱敏后的实际upstream request headers，区分原始入站头和实际发送头。不以头部存在或模拟请求成功推断150%配额。
- 原worktree同步与旧文件删除仍等待用户明确确认，未重试此前被拒绝的同步操作。

- 模型API补充最终检查：233项测试全部通过，0失败0跳过；类型检查及构建通过，新增请求层独立审查无P1/P2问题。

- 用户明确要求将zai文件改名为zcode并直接修改原转发文件，同时授权独立临时端口进行一次Responses模型请求与头部日志分析。目录缓存统一命名zcode-catalog.json；渠道标识保持zai/bigmodel。

## 实际写回与单次模型请求

- 用户明确要求直接修改当前转发文件，并统一zai→zcode命名后，已通过版本校验和备份执行原worktree源码/测试更名及实现写回。不是仅保留临时副本。
- 在原worktree重新执行bun run check：233测试，0失败0跳过，类型检查及构建通过。
- 按用户授权仅发起一次真实Responses请求：临时端口59566，Z.ai Coding Plan / GLM-5.3-Flash，HTTP200、completed、OK，2866ms；输入35/输出62 tokens。
- 请求来源、会话归因、meta会话一致性、单个缓存标记及日志脱敏已检查。测试服务关闭，原8320进程不变。其余套餐及专属额度未由此次测试验证。
