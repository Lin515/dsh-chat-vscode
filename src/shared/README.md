# src/shared/ — 宿主与界面共用（纯函数、无环境依赖）

运行环境：宿主与 webview **两边共用**——纯函数，不碰 `vscode` 也不碰 DOM。
上一层的说明见 [../README.md](../README.md)。

- `chat.ts` — 视图模型：宿主与 webview 共用的聊天状态形状（刻意与线协议解耦，协议变更只影响 `dsh/` 适配层）。
- `ipc.ts` — 宿主 ↔ webview 的消息协议类型（`HostToWebview` / `WebviewToHost`）。
- `wire.ts` — 宿主 → webview 的过线语义：JSON 过线会丢 `undefined` 键，清空字段必须发 `null`（`jsonSafeFrame` / `mergeWirePatch`）。
- `diff.ts` — 编辑类节点的 diff：两条来源归一成 `DiffHunkView`，只做行序列与增删计数，排版交给界面。
- `changesSummary.ts` — 改动清单的缓存键（必须带会话 id，事件 seq 是按会话各自编号的）。
- `trajectory.ts` — 轨迹视图的线格式与视图模型（记录种类逐字对齐官方契约；**含请求表 `TrajectoryRequest`**——请求级检查器吃的选项 / 用量含会话累计 / 请求计时都在这张表里；时间线投影已 vendor 到 `src/vendor/`，这里只剩类型与域坐标换算）。
- `toolMeta.ts` — 工具行的契约事实：工具分类、退出码解析（`[exit code: N]`）、running/ok/error/stopped 状态语义，纯数据与纯函数。
- `toolCard.ts` — 工具卡契约事实：从「工具名 + 参数 + 结果元数据」折出卡片数据（对齐官方 `deriveSummary`）。
- `toolQuestion.ts` — `ask_user_question` 问卷事实：题目在调用参数、答案在工具结果，两份 durable 材料折出问卷记录（重载后卡片不丢）。
- `turnProcessThreshold.ts` — 连续过程折叠的阈值（默认值与特殊语义只写这一份，两边共用）。
- `imageRef.ts` — 正文图片引用分类（远程 / 内联 / 本地路径）：判断哪些该交给宿主读成 data URL。
- `injectedSource.ts` — 「自动载入的上下文」条目的结构化字段解析（按官方各 `form` 的正文逐条解析，全有或全无）；另给消息正文用的「跨会话引用标题 ↔ 会话 id」读法（逐条跳过认不出的条目）。
- `localizedText.ts` — 服务端给的本地化文案（`{en, [locale]}`）的形状校验与取值（审批 `displayReason` 等官方口径）。
- `mentions.ts` — `@` 引用的文本形态：宿主插目录引用与界面补全插入必须产出一模一样的拼写；另给「这一块指向什么」的三个判据（浏览入口 / 去行号区间的语义路径 / 对话引用 token 的会话 id），宿主拿它们判「这块是不是已经能引用到内容」。
- `presetMatch.ts` — 配置项里的预设（可以写 id，也可以写界面上的名字）折成服务端认的 id：id 优先，名字取目录里第一个命中的。
- `schedule.ts` — 自动化任务的显示与编辑口径：频率 / 相对时间的措辞、运行时间草稿与 `change` 装配、cron 方言校验、时区清单与墙上时钟换算（服务端要求一次提交带上完整的新规则，拼错就是一次静默被拒的保存）。
