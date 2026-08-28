# hermes

Hermes 官方远程会话插件。

实现方式：

- 本地会话与正文读取：`~/.hermes/state.db`
- Desktop 前台、路由、Composer、附件、队列、审批和会话操作：Hermes Desktop CDP + 已挂载 React callback
- Desktop 模型、推理、上下文和实时事件：通过 CDP 复用 Renderer 已有的 `HermesGateway`
- Native 会话、发送、打断、审批、模型、推理和事件：Plugin 私有 Hermes Gateway JSON-RPC

Desktop 模式不读取 Gateway `wsUrl`，不建立第二条 WebSocket，也不调用 Plugin-owned
`session.resume`、`prompt.submit`、`session.interrupt` 或附件 RPC。发送、排队、打断和附件
全部调用当前 Renderer 的原生 Composer callback；模型、推理、上下文等结构化请求调用同一个
Renderer `HermesGateway.request()`；事件通过该实例的 `onEvent()` 注册有界 ring。每次操作都在
同一 CDP 求值中重验 route、stored session、live session 和 callback identity，Desktop
草稿或附件非空时返回 `composer_occupied`，绝不覆盖用户输入。

Native 模式与 Desktop 完全隔离。只有 Native 会由 Plugin 启动并持有私有 `hermes serve`
Gateway，并使用 `session.resume`、`prompt.submit` 等正式 JSON-RPC；两种 mode 不共享 live
transport、审批、队列或前台状态。任何 Gateway token 都不写入 Prism 配置、日志或 Hub wire。

对 Hub 的输出固定遵循 PluginBridge 统一契约：会话、历史、运行态、审批
和 `detail_snapshot` 都使用标准字段。Hermes 未稳定提供的能力返回空
option 列表或 `null`，Mobile/Panel 不读取 Hermes 私有字段。

PluginBridge 使用公开 npm 包 `@rokid/pluginbridge-plugin-sdk` 的
`serve(adapter)`，并由 Hub 注入共享 Node 22 runtime；不再在 Prism Desktop
应用包中寻找 SDK，也不再各自实现 stdio wire、订阅取消和事件转发。Hermes 自身的 SDK 是仓库私有的
`@hermes/shared` TypeScript workspace package，并未发布为可安装的多语言
客户端；插件不能依赖用户的 `~/.hermes/hermes-agent` 源码。`hermes_gateway.js`
按该官方 `JsonRpcGatewayClient` 的 JSON-RPC 语义随插件打包，兼容已发布的
Hermes Desktop。Prism 的 Go/Python/Node SDK 仍都可用于其他插件；本插件保留
Node 是因为 Hermes 官方客户端和 CDP bridge 均为 Node/Electron 运行时。

当前能力：

- 列出真实 Hermes 会话
- attach 到已有会话
- 在原会话继续发送消息
- 接收 Hub 已物化的本机附件：图片走 `image.attach`，PDF 优先走
  `pdf.attach`（无法渲染时退回 `file.attach`），其他文件走 `file.attach`；Gateway
  只收到本机 path，不接收 OSS URL 或 Base64
- 读取本轮最终正文
- Desktop 自行发起会话或续聊时，通过 `state.db` 文件监听刷新会话目录；已打开的
  正文流以完整标准 turn 同步 user/assistant，并对同一未完成轮次发 `replace`
- 中断当前 Hermes Desktop 运行
- 回传 `approval.request` 并支持手机端 approve / deny 回写
- 返回统一 `readStatus` 和 `controls.describe` detail snapshot；已发布 session-scoped
  模型与推理控制及真实上下文窗口
- Desktop 空闲发送走原生 Composer，运行中发送进入原生多项队列；每项保留 Hermes 自己的
  queue ID 以及 edit / send-now / delete callback
- Desktop 新会话和已有会话均支持原生 Composer 附件；文件不会绕过 Renderer 直接提交 Gateway

历史回归（2026-08-11，已被 2026-08-16 Renderer/CDP 路径替代）：Prism 曾通过 Hermes Desktop CDP bridge 取得带授权参数
的 loopback `wsUrl`，Gateway Client 以 `session.list` 成功读取 30 个会话；随后在
专用会话完成新建、正文流、打断和审批拒绝。正文样本收到 8 个 `message.delta`、
`message.completed` 和 `waitForRun -> run.completed`；打断在 Hermes 的真实
`message.complete` 边界收敛为标准 `run.failed`，含 `interrupted=true`；危险命令
`approval.request` 的 `deny` 回写被 Gateway 接收且命令未执行。该记录只证明 Gateway
协议能力，不再代表当前 Desktop transport；当前 Desktop 不读取此 `wsUrl`。

2026-08-12 macOS 实机附件回归：文本加附件的新会话、已有会话的仅附件续发均在
Hermes Desktop 变为可见 user turn，Agent 实际读取 TXT 后返回预期内容；固定 1x1 PNG
也通过 `image.attach` 进入原生会话。Hermes 会把 `@file` 和图片分析临时路径展开后
写入 `state.db`，Plugin 在公开历史边界移除这些 agent-only 上下文，只输出原始文本和
`metadata.attachments[{name,mime_type,kind}]`。本机路径、OSS URL、签名、Base64、文件
正文和视觉分析提示均不得透传给 Mobile/Panel。

2026-08-12 macOS 实机 controls 回归：Gateway `session.active_list` 的 live `id`
与持久 `session_key` 精确映射后，`model.options(session_id)` 返回当前
`openai-api/gpt-5.6-terra`、10 个已认证模型及逐模型 `capabilities.reasoning`。
通过正式 PluginBridge wire 完成 `reasoning.switch(high -> medium)` 与
`model.switch(gpt-5.6-sol -> gpt-5.6-terra)`，每步均由返回的
`detail_snapshot` 和 `state.db` 原生会话状态确认，并恢复原值。

2026-08-12 macOS 实机 context 回归：对唯一 `session_key -> live id` 映射调用
正式 `session.context_breakdown(session_id)`，返回 `context_max=400000`、
`context_used=181085`、`context_percent=45`。Plugin 仅发布统一
`context_window_total`、`context_tokens_used`、`context_window_usage_percent` 与
`context_window`；Gateway 的分类明细、模型名和估计字段不进入 Prism wire。没有唯一
live 映射或该 RPC 失败时全部投影为 `0`/空值，不从 SQLite history 或 token 文本估算。

Hermes Native 与 Desktop 复用同一套 TUI Gateway JSON-RPC 方法语义，但不复用 transport：
Native 由 Plugin 私有 Gateway Client 调用，Desktop 只通过 CDP 调用 Renderer 已有实例。
`session.active_list` 负责持久 `session_key` 到 live `session_id` 的唯一映射，并提供
live 模型和运行状态；完整的当前模型、provider 和推理强度以 `session.info` 事件为权威
来源。模型目录、当前 provider 及逐模型 capability 来自 `model.options(session_id)`，
上下文来自 `session.context_breakdown(session_id)`。
切换模型调用 session-scoped
`config.set(key=model, value="<model> --provider <provider> --session")`，切换推理调用
`config.set(key=reasoning, value=none|minimal|low|medium|high|xhigh)`。SQLite 的
`sessions.model/billing_provider/model_config` 只在会话不再 live 或 Gateway 暂不可用时显示持久值，
不能覆盖 live Gateway 状态，也不能据此发布可操作 options。Native 冷恢复会先返回尚未
构建 agent 的 `context_max=0`；Plugin 在 `session.info` agent-ready 事件后重读，不能把
这次过渡空值当成最终上下文。

2026-08-15 Hermes Native 正式 PluginBridge 回归：选用 SQLite `model_config` 仅含模型、
不含推理的专用会话，live 状态收敛为 `openai-api::gpt-5.6-terra + medium`，并返回 11 个
模型候选和 6 档推理候选；`reasoning.switch(medium -> high -> medium)` 每步均由返回详情
确认并恢复原值。另一专用会话的 `session.context_breakdown` 在 deferred build 前两次返回
`0/0/0`，agent-ready 后收敛为 `400000/21527/5`。

Native 的模型与推理切换是同步 Gateway 控制，不依赖 Desktop watcher。`config.set` 成功并
回读当前 session 后，Plugin 返回 `details_confirmed=true`，Hub 立即发布随结果携带的完整
detail。首次进入会话时 `model.options` 仍可后台加载；目录完成会记录 `controls.updated`，
Native plugin-wide watcher 随即发布包含候选项的新 detail，Mobile 在用户已打开选择器的
情况下自动继续，不再提示等待桌面同步。Desktop 模式不设置 `details_confirmed`，继续以真实
renderer watcher 作为操作结果的权威来源。

Hermes 的 `desktop` 与 `native` 都在 manifest 中把模型、推理声明为 `stable` 控件，但每次
只运行当前 mode 对应的 Plugin 进程和 watcher。Hub 在 mode 切换时撤销旧 detail，不能把
两个 runtime 的 options、approval 或 queue 合并；Hermes 不发布同语义的动态控件。

会话操作同样按 runtime 隔离：`desktop` 将重命名、置顶、归档、删除声明为 `direct`，只发布
当前 Renderer/CDP 已验证的真实 action；`native` 四项均声明为 `unsupported`，Hub 会删除
Desktop detail 遗留入口。以后 Native 获得稳定原生 RPC 时只修改 Hermes manifest 和 adapter，
不修改 Hub/API。置顶统一使用幂等 `pin + {enabled:boolean}`，重复请求不得反向 toggle。

2026-08-12 macOS 正式托管 Desktop 回归：无附件首发通过原生 composer 创建并选中同一
stored/live session；正式 PluginBridge 回执在 `state.db` user turn 落库后返回
`visible=true`。运行态由只读 `session.active_list` 补全，避免仅因 Prism 自己没有持有
run 而把 Desktop 的 `working` 误报为空闲。空闲专用会话中
`reasoning.switch(medium -> high -> medium)` 分别在 190ms 与 155ms 完成，未等待模型目录。
Desktop 多条队列从 `QueuePanel.entries` 的稳定 item ID 和原生
`onEdit/onSendNow/onDelete` callback 生成 opaque action；已实测 delete 收敛为空队列、edit
回填 composer、立即发送后 queue/composer 同时清空，重渲染前的旧 action 返回
`control_target_stale`。2026-08-12 macOS 专用会话以真实 `rm -rf /tmp/...`
审批完成正式 PluginBridge `controls.describe -> resolveApproval(deny)` 回归：详情只发布
Desktop 当前审批条的两个 direct action，拒绝后审批消失且目标目录仍保留。审批执行在同一
CDP renderer 求值内重新验证 stored/live session、approval 和 callback identity 后调用
原生 button click，不能拆成跨 CDP 往返的元素查找和坐标点击。随后以另一唯一 `/tmp`
目录完成同一正式 wire 的 `once` 回归：第一个 direct action 令目录被实际删除，审批同步
消失；Mobile 不解释 action 语义，只回传当前 detail 下发的 opaque action ID。切换 Desktop
到另一会话后复用旧审批 action 会返回 `control_target_stale`，原审批命令不会在新会话执行。

模型与推理控制的边界：

- `controls.describe` 先用 `session.active_list` 建立唯一 live 映射，以最近一次
  `session.info` 的 model/provider/reasoning 为当前值，并以 `state.db` 持久值兜底；只有
  `session.active_list` 恰好返回同一 `session_key` 的单个 live session 时，才发布
  `model_options[]`、`reasoning_options[]` 和可用 action。历史会话可显示持久当前值，
  但不能获得可操作 options。
- 模型 option ID 固定为 Gateway 公开的 `provider::model`，仅接受最近一次正式
  `model.options(session_id)` 返回且已认证、未禁用的精确组合。与 Hermes Desktop 一致，
  用户点已展示 option 时立即调用
  `config.set(model, "<model> --provider <provider> --session")`，明确避免 Hermes
  默认的全局 model 持久化；成功后乐观更新当前值并异步刷新 picker，不在写前或写后等待
  完整 provider/pricing/capabilities 目录。live session、空闲状态和 option identity
  仍在写前重验；RPC 失败时保持旧值并返回错误。
- 推理选项只在当前模型的 Gateway `capabilities[model].reasoning=true` 时发布，值为
  Hermes 正式枚举 `none|minimal|low|medium|high|xhigh`，不来自 Desktop 文案。应用后
  以同一会话的 `state.db.model_config.reasoning_config` 确认。Hermes 官方
  `config.set(reasoning)` 同时更新该 live session 和 profile 默认 effort，Desktop 自身
  使用同一 RPC；Mobile 不隐瞒此原生语义，也绝不在没有 live `session_id` 时调用它。
- 控制路径从不为 detail 调用 `session.resume`，不抢占 Desktop 的单一 event transport。
  映射消失、重复、会话运行中、option 已变化或未认证时统一返回
  `control_target_stale`；`config.set` 的正式成功回包是本次提交确认，后续 detail watcher
  与异步 picker 刷新负责状态收敛，不能用慢目录请求阻塞用户点击。
- 上下文窗口也只在相同的唯一 live mapping 下读取。Gateway 当前按连接串行处理部分
  查询，因此 Plugin 先读取 `session.context_breakdown`，随后独立尝试 `model.options`；
  后者超时只隐藏模型/推理 options，不能阻塞或清空已经读取到的 context snapshot。
- Hermes 没有 Codex 式权限档位。`yolo` 只是 approval bypass，`scope=global` 会改写
  所有会话的持久审批配置；本插件不发布 `permission_options[]` 或 `permission.switch`，
  也不把 yolo 伪装成通用权限模式。

会话操作边界：

- `rename` 是当前唯一发布的 Hermes 会话操作。它走正式 Gateway
  `session.title`，仅在 Desktop 当前前台会话、SQLite `session_key` 与 Gateway live
  `session_id` 精确一一对应时可用。提交后必须回读 `state.db` 的标题；未持久化即失败，
  目录 watcher 再将标题变化同步到上层。
- `pin` 已发布为当前 Host 的 Desktop-local 会话操作。Hermes 置顶是 Desktop renderer 的
  `localStorage` 布局状态，不是账户级会话持久属性，也没有 Gateway RPC。Plugin 从当前
  session row 的真实 React `onPin` handler 执行，按 `localStorage` 的 lineage-root pin ID
  作状态后验；Mobile 始终回传稳定 `pin` action，Plugin 根据当前状态返回“置顶/取消置顶”
  展示文案。所有连接同一 Host 的手机都会同步该 Host 的镜像；另一台运行 Hermes Desktop 的
  电脑有独立 localStorage，不保证互相同步。2026-08-12 macOS 专用会话完成
  未置顶 -> 置顶 -> detail/index 都为 true -> 取消置顶 -> detail/index 都恢复 false 回归。
- `archive` 已发布为持久会话操作。Desktop 目前通过 preload REST PATCH 修改
  `sessions.archived`，Gateway 没有对应稳定 RPC；Plugin 只执行当前会话 row 的真实 React
  `onArchive` handler，不匹配菜单文案、不依赖固定位置，也绝不直接写 `state.db`。Mobile
  必须先显示本地二次确认；执行成功的唯一后验是 `sessions.archived=1`，随后 SQLite 目录
  watcher 发出 `desktop.session.directory.reconciled`，Hub 重建目录并让同一 Host 的所有手机
  移除该会话。2026-08-12 专用会话完成正式 PluginBridge 回归：handler 可用 -> archive 成功 ->
  SQLite `archived=1` -> `listSessions` 不再返回该会话 -> Desktop 回到新草稿页。
- `delete` 已发布为永久会话操作，独立于 archive。Desktop 原生 `onDelete` 会先结束当前
  runtime、移除本地 pin，再经 preload `DELETE /api/sessions/:id` 删除会话和全部消息；Plugin
  只从当前 row 的真实 handler 调用，Mobile 必须显示“不可恢复”的二次确认。成功后必须同时
  证明 `sessions` 行和该 session 的 `messages` 均不存在，SQLite 目录 watcher 再让同一 Host
  的全部手机收敛移除。2026-08-12 专用会话正式 PluginBridge 回归已确认这三个后验及 Desktop
  返回新草稿页。

当前限制：

- 新会话必须通过 Hermes Desktop 原生 Composer 首次提交创建，不能以 Gateway
  `session.create` 替代。文本和附件首发都走 Renderer 的 `onAttachDroppedItems + onSubmit`；
  Plugin 只有在 route 获得 stored/live identity、`state.db` 已出现同一 session 且 user turn
  可见后才返回成功。Hermes 自身创建超时可能短暂留下 route identity，这不构成 Prism 成功，
  也不能写入幂等完成状态。
- 原生首次 submit 会先产生 Desktop 的 stored/live identity，随后异步写入 `state.db`。
  Plugin 的首发回执最多等待 30 秒确认同一会话的 user turn；不会只因 identity 已出现
  就把消息标记为可见。超时仍返回失败并保留幂等开始记录，防止重试产生重复会话。
- 队列 action 的身份来自当前 `QueuePanel` Fiber 的结构化 `entries[]` 与
  `onEdit/onSendNow/onDelete` callback，不来自折叠/展开后的图标、按钮文案或位置。执行前
  重读同一前台 session、item 和 callback identity；任何 Desktop 重渲染、切会话或条目变化
  都返回 `control_target_stale`。当前已回归 edit/delete/send-now；approval 不能因源码可见
  而视为已完成。
- Gateway 的 `message.*`、thinking/reasoning、tool、status 和 approval 事件已映射为标准
  PluginBridge event。Desktop 提交前在 Renderer 自有 Gateway 上安装有界事件 ring；新建后
  再补齐 `live session_id -> stored session_key` 映射，因此不建立第二条 transport 也不会丢快速首帧。
- Hermes Gateway 每个 live session 只有一个 event transport；`session.resume` 和
  `prompt.submit` 都会将它移交给最后一个调用者。Desktop 模式绝不调用这两个方法，只复用
  Renderer 自己的连接；Native 才拥有独立 Gateway。`state.db` 的精确文件监听承担 durable reverse
  mirror：Plugin-wide watcher 仅发布标准目录重算事件，正文 stream 从 SQLite 产生通用
  `turn append/replace`。它不是 Gateway token-level observer；只有当前前台 renderer
  可见的唯一审批条能以 Fiber callback identity 投影并回写，后台或历史 Gateway
  `approval.request` 不能恢复为可操作 action。取证确认 `state.db` 没有
  approval/pending 表，待审批队列只存在 Gateway/进程内内存；不接管 Desktop transport
  就不能恢复非前台审批的 action identity。
- 上述 watcher 已以隔离 SQLite 数据库回归：新 user/assistant turn 产生 `append`，助手
  随后落库时对同一 `turn_id` 产生 revision 递增的 `replace`。仍待 Hermes Desktop 真机
  Desktop-originated 回归和 Windows/Linux；模型/推理已通过 Gateway 的稳定 ID 取证，
  但 approval bypass 没有通用 permission 语义，继续返回空权限选项
- 附件的本机 materialize 目录保留由 Hub 统一管理（当前成功发送后保留 24 小时），因为
  Hermes Gateway 可能在 send receipt 返回后才读取文件；Plugin 不提前删除，也不把
  `LocalPath` 写入事件或历史
- 需要本机可用的 Hermes Desktop 与 `~/.hermes/state.db`
- `state.db` 查询先以 SQLite 显式只读 URI 打开；仅当 macOS Desktop 替换 journal 时返回
  `SQLITE_CANTOPEN(14)`，才降级为 immutable 只读快照。该降级永不写库且只覆盖当前快照；
  文件 watcher 仍会在后续数据库变化时重新读取。
- CDP 控制要求 Hermes 暴露 DevTools 端口。普通 Plugin 请求绝不停止、重启或自动拉起
  Hermes Desktop：用户必须在 Prism Desktop 的插件页显式选择托管启动，或直接使用已暴露
  CDP 的实例。这样不会因短暂的 CDP 探测失败启动第二个 Electron 实例。开发调试才可显式
  设置 `PRISM_HERMES_ALLOW_MANAGED_LAUNCH=1` 或
  `PRISM_HERMES_ALLOW_MANAGED_RELAUNCH=1`；后者会关闭现有 Hermes，不能作为常规配置。

2026-08-12 macOS 启动与只读回归：通过与 Prism Desktop 相同的用户目录，以
`--remote-debugging-port=0` 显式启动 Hermes 后，`DevToolsActivePort` 为 `54010`，
PluginBridge 正式执行 `probe -> listSessions -> attachSession -> readHistory -> readStatus ->
controls.describe` 全部成功；detail 正确标识当前 Desktop 前台会话，且没有调用
`session.resume`。同一专用回归会话通过正式 `controlSession(rename)` 改名并恢复原标题，
两次标题均由 `state.db` 回读确认。恢复时一次 `session.active_list` 在 15 秒超时，独立重试
成功；这不是错误改名，后续应为 live mapping 的只读查询补有限重试，不能让已成功的 Gateway
写入被紧接的详情刷新误报为失败。

2026-08-16 macOS Desktop Renderer/CDP 回归（替代 2026-08-12 Plugin-owned Gateway 的
Desktop 控制与耗时结论）：Plugin 不再建立第二条 Gateway WebSocket。
专用会话真实提交 `sleep 20` 后，第二条消息进入 Hermes 多项队列并取得原生 ID
`queued-1786809243409-70plnl`；调用该 item 的真实 `send_now` callback 后，SQLite 出现第二条
user turn 和精确 assistant 回复。Renderer `onEvent()` ring 收到 `message.start/delta/complete`、
`thinking.delta`、`session.info` 与 `reasoning.available`。附件首发新会话
`20260816_000747_87e24e` 同时满足 route stored/live identity、SQLite session、带安全文件名的
user turn，Agent 实际读取文件并回复 `PRISM_HERMES_NEW_ATTACHMENT_OK`。模型/推理写改为
Renderer 内异步 mutation：调用立即返回 opaque mutation ID，不把 Hermes 最长约一分钟后才返回的
`config.set` 误报为失败；最终仍由 Composer/SQLite watcher 收敛。专用会话已完成
`medium -> high -> medium`，并恢复 `openai-api/gpt-5.6-terra + medium`。

2026-08-16 macOS Native 正式 wire 回归：独占单个 Plugin/Gateway 时，`listSessions` 返回 72 条，
附件首发后变为 73 条且新会话可再次 attach；Agent 读取 TXT 并精确回复
`PRISM_HERMES_NATIVE_ATTACHMENT_OK`，公开 history 含文件名但不含本机 path。模型目录 11 项、
推理 6 档、context `400000/20436/5` 均通过，推理 `medium -> high -> medium` 同步确认并恢复。
经授权的 `sleep 60` 在一秒后 `session.interrupt`，Prism 终态为
`run.failed(interrupted=true)`。Native 危险命令审批随后以两个独立专用会话完成真实回归：
`deny` 保留唯一 `/private/tmp` 目标，`once` 只删除另一唯一目标，两次均在回写后立即从 detail
消失；复用各自旧 action 均返回 `control_target_stale`。Plugin 以已解决审批 tombstone 过滤
15 分钟 Gateway event ring，避免重连或刷新重新发布已处理请求；回写 action 也必须仍存在于当前
审批的 `actions[]`，不能向 Gateway 发送任意 choice。

开发者模式下可用的环境变量：

- `PRISM_HERMES_CDP_URL`
- `PRISM_HERMES_CDP_PORT`
- `PRISM_HERMES_DEVTOOLS_FILE`
- `PRISM_HERMES_USER_DATA_DIR`
- `PRISM_HERMES_ALLOW_MANAGED_LAUNCH`（仅开发调试，允许 Plugin 在未运行时直接启动）
- `PRISM_HERMES_ALLOW_MANAGED_RELAUNCH`（仅开发调试，允许 Plugin 停止后重启现有实例）
- `PRISM_HERMES_APP_EXECUTABLE`
- `PRISM_HERMES_APP_PATH`
- `PRISM_HERMES_LINUX_COMMAND`
- `PRISM_HERMES_BACKEND_URL` / `PRISM_HERMES_BACKEND_TOKEN`（仅独立 Gateway 开发调试）
- `HERMES_HOME`
- `HERMES_BIN`

通过 Prism Desktop 安装：在插件页直接输入本地路径 `plugins/hermes`。

仓库开发验证：

```bash
node --check plugins/hermes/index.js
node --test plugins/hermes/test/hermes_controls.test.js
```
