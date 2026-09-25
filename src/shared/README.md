# src/shared/ — 宿主与界面共用（纯函数、无环境依赖）

运行环境：宿主与 webview **两边共用**——纯函数，不碰 `vscode` 也不碰 DOM。
上一层的说明见 [../README.md](../README.md)。

- `chat.ts` — 视图模型：宿主与 webview 共用的聊天状态形状（刻意与线协议解耦，协议变更只影响 `dsh/` 适配层）。
- `ipc.ts` — 宿主 ↔ webview 的消息协议类型（`HostToWebview` / `WebviewToHost`）。
- `wire.ts` — 宿主 → webview 的过线语义：JSON 过线会丢 `undefined` 键，清空字段必须发 `null`（`jsonSafeFrame` / `mergeWirePatch`）。
- `diff.ts` — 编辑类节点的 diff：两条来源归一成 `DiffHunkView`，只做行序列与增删计数，排版交给界面。
- `changesSummary.ts` — 改动清单的缓存键（必须带会话 id，事件 seq 是按会话各自编号的）。
- `trajectory.ts` — 轨迹视图的线格式与视图模型（记录种类逐字对齐官方契约）。
- `toolMeta.ts` — 工具行的契约事实：工具分类、退出码解析（`[exit code: N]`）、running/ok/error/stopped 状态语义，纯数据与纯函数。
- `toolCard.ts` — 工具卡契约事实：从「工具名 + 参数 + 结果元数据」折出卡片数据（对齐官方 `deriveSummary`）。
- `toolQuestion.ts` — `ask_user_question` 问卷事实：题目在调用参数、答案在工具结果，两份 durable 材料折出问卷记录（重载后卡片不丢）。
- `turnProcessThreshold.ts` — 连续过程折叠的阈值（默认值与特殊语义只写这一份，两边共用）。
- `imageRef.ts` — 正文图片引用分类（远程 / 内联 / 本地路径）：判断哪些该交给宿主读成 data URL。
- `injectedSource.ts` — 「自动载入的上下文」条目的结构化字段解析（按官方各 `form` 的正文逐条解析，全有或全无）。
- `localizedText.ts` — 服务端给的本地化文案（`{en, [locale]}`）的形状校验与取值（审批 `displayReason` 等官方口径）。
- `mentions.ts` — `@` 引用的文本形态：宿主插目录引用与界面补全插入必须产出一模一样的拼写。
