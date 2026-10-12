# 审计结论与回归边界

本文保留审计形成的有效规则，不再复录逐批修复流水账。当前行为以实现与回归为准，旧报告中的失败描述不能作为待修清单。

- [输入、队列与附件](<audit-input-queue-attachments.md>)：提交、取回重编、停止的差异。
- [投影与面板](<audit-projections-panels.md>)：解析、目录、会话列表与尚未消费的能力。
- [附件设计](<design-attachments.md>)、[守护进程设计](<design-supervisor.md>)、[轨迹设计](<design-trajectory.md>)：实现边界。
- [服务端契约](<dsh-server-api.md>)、[兼容基准](<dsh-compat.md>)：版本核对入口。

## 协议与显示规则

### goal 投影嵌套形状读错

`goal` 投影为 `{goal: {...}, roundsStarted, createdAt, updatedAt}`，轮次在外层；`null` 清空目标。解析落在 `goalFromProjection`，不得按扁平对象读取。

### subagentCatalog 形状用错 + mode 硬编码

投影条目没有 `kind` / `activity`；旧 RPC 行才有。目录、durable 注册事件、运行状态分别读取，再按 id 并入；缺失的状态不覆盖已知状态。打开会话必须携带真实 `mode`，未知模式按只读的一次性地址处理，不能猜成 continuable。

### 快照回放会覆盖投影折叠值

会话控制投影使用 `ProjectionValueStore`：每键 higher seq wins，同 seq 不覆盖；baseline 按 `asOfSeq` 替换世代、清理缺失键。不要把 follow 快照绕过水位线写回已折叠值。列表镜像有意采用最后到达值，见 [ADR](<adr/0001-projection-value-store.md>)。

### `/plan` 计划模式双向失效

有效目标态为 `pending ? !active : active`。进入、退出通过命令通道，不靠发给模型的正文或本地乐观值。回归在 `projections.test.ts`；真实探针 `planCommandProbe.ts` 需当次授权。

### 手打斜杠命令全部不执行

已接入命令仲裁与 `commands/execute`；未被命令目录认领的输入才走 prompt。附带附件的输入仍按普通消息发送，不能假定支持官方所有命令附件形态。

### 占用条分子口径错

分子取 `projectedTokens ?? pressureTokens`，只含 prompt 侧，不加 output；压缩可产生负增量。容量与压力不是原子观测。`contextBreakdown` 仅展示近似构成，不求和冒充占用；缓存命中率取会话累计 `tokenUsage`，不取最后一步用量。

### 用户消息的非文本内容被丢弃

用户正文、图片和文件块均保留；内容块不能靠文本是否非空过滤。durable `user/message` 的 data 就是消息本体，不包 `message`。会话引用落盘后是 `@标题`，身份由相邻召回事件补回，不能按形状误判为文件链接。

### 交付文件完全不可见

`present` 申报与 write/edit 派生的本轮产物有独立显示入口；图片通过受限本地读取显示。工具产物、命令流程节点与模型正文是不同来源，不要用“正文里已经提到”代替产物登记。

### 中止后工具行永远卡『运行中』

轮次中止须结算在飞工具。结果找不到调用时保留孤立结果卡片，不能静默丢弃。`max-tokens` 收尾已有单独提示，不应重新列为缺失能力。

### 工具行状态点覆盖图标

活性状态与工具种类分开：有 tone 不代表应遮掉工具图标。未知子代理活性不画确定状态点；工具展开内容各自持有 ref，避免 diff、划选和回顶共用最后一个节点。

### 已知未处理的事件反复触发 warn

已知但不渲染的事件列入显式白名单；未知事件才告警。类型登记、实际消费与“有意忽略”须分清，不能通过白名单掩盖应消费的状态。

### 附件表示

路径引用是正文 `@path`，不内联文件全文；文件上传后按回执提交，不能用是否存在 `path` 判定能否发送。路径与字节入口共用 `planIntake` / `ingestAttachments` / `buildPromptContent`，详见附件设计。

### 会话状态字段一致性

`sessionView.ts` 是快照与 patch 的共同字段登记表。切会话必须带上 `historyLoading`、`subagentEntries` 等清空值，不能混用宿主旧名与界面字段名；JSON 清空用 `null`，不发会被丢掉的 `undefined`。

### 文案登记完整性

工具标题、宿主 `@key` 标记与中英词典须双向完整；不能用宽泛类型断言加裸 id 回退掩盖缺项。`i18n.test.ts` 检查登记、真实发射点与原生译文。

## 停止语义：有意差异

官方 UI 只 cancel 并保留队列；本扩展 `stopRunning` 摘空可重发项 → cancel → 等空闲（最多 8 秒）→ 按序走统一提交路径。

历史 `queueContinueProbe.ts` 两轮各 3 次：仅 cancel 均未自动续跑；cancel 后新提交是否唤醒旧队列分别为 0/3 与 3/3。后者是不稳定观察，不能写硬断言，也不能推广为所有版本保证。探针已登记构建入口，重新运行须当次批准。

该流程不是事务：remove、cancel、重发之间存在失败窗口；回滚尽力重排，未提交项回草稿。不得声称绝不丢失或重复。插话项重发成 queue 仍是语义差异。

## 安全不变量

- `command` / `url` 使用 machine 作用域，避免工作区执行命令或改变凭据去向。
- 删除会话目录同时验证安全 id 与解析后的路径包含性。
- 清理端口、孤儿锁与 PID 复用只依据肯定的 DSH 进程身份证据；证据不足不操作。
- 会合目录 / 文件在 POSIX 使用 `0o700` / `0o600`；Windows 依靠 profile ACL。
- socket 状态逐字段验形状；行缓冲上限 1 MiB，超限断开；启动合并并发调用，dispose 后在途操作不能复活连接。
- 展示日志先脱敏，包括含启动令牌的 stdout；CSP nonce 使用安全随机数。
- 字节附件先检查 base64 长度，单文件上限 8 MB；图片路径按服务端单图限额读取，缺省硬上限 64 MB。
- 事件与会话索引有清理路径；通知计时跟稳定身份，回调用 ref；轮次结束不抢走用户正在使用的输入焦点。

主要防线在 `invariants.test.ts`、`supervisorProtocol.test.ts`、`attachments.test.ts`、`localImages.test.ts` 与对应链路回归。

## 明确不改

- 保留模型回答中的 HTTPS 外链图：有潜在 URL 外传面，但渲染能力是既定产品取舍。图片使用 `no-referrer`、lazy；明文 HTTP 不放行。
- 本地图片只读会话 cwd 内的图片路径：先 stat、单张 8 MB、每次最多 24 张；越界或失败降级并报告原引用。SVG 可用于浏览器显示，与模型附件准入表分开。
- 队列“重新编辑”是取回重写，不是服务端原位 edit；完整可还原才取回，细节见输入审计。
- 后台任务名册来自 `job/list` 流，旧服务端兼读 control baseline / jobs 帧；点开面板只重发宿主内存，不是服务端刷新。不能把“点击后出现”直接归因为取数时机。

## 尚未关闭与未确认

- `imageLimits.maxImagesPerMessage` / `maxMessageImageBytes` 的整批预检尚未实现，像素预检与上传进度也未对齐；大图路径读取仍可能同步占用宿主。
- 纯附件发送仍受界面非空正文限制；整队插话未做；权限菜单只消费 currentValue 而不消费部署 options。
- schedule / subagentTiming 面板、会话累计用量胶囊与分桶对话框尚未做；不把这类产品缺口混同已修解析 bug。
- 模型目录默认值、可路由性与 failures 的完整消费，以及未知 context form 的呈现，需按目标契约另行核对。
- 典型会话的 header 去重效果、真实 transcript 设置下流程体量、官方 depth / completed 的实际渲染，以及部署权限预设表，历史审计没有足够证据。
- 轨迹正确性与性能的证据范围以轨迹设计为准；离线全绿不代表 VS Code 安装端 IPC 或全部时序已经验证。
