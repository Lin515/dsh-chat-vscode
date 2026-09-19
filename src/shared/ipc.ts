import type { Attachment, ChatState, MessageView, ModelSelectionView, ProviderGroupView, Segment, SessionSummaryView, TodoView } from "./chat";
import type {
  CommandView,
  FileRefView,
  JobItemView,
  SessionRefView,
  SubagentView,
} from "./chat";

/**
 * 宿主 ↔ webview 消息协议。
 *
 * 宿主持有权威状态；webview 只是一面镜子，通过增量帧更新（避免每来一个
 * token 就重发整棵消息树）。
 */

/**
 * 过线后的状态形状。
 *
 * 宿主发帧前会把「清空」表达成 `null`（`shared/wire.ts`：VS Code 的 webview
 * 消息走 `JSON.stringify`，`undefined` 值的键会被丢掉），所以界面上必须接受
 * `null` 并在合并时把它折回「这个键不存在」。
 */
export type WirePatch = { [K in keyof ChatState]?: ChatState[K] | null };
export type WireState = { [K in keyof ChatState]: ChatState[K] | null };

export type HostToWebview =
  /** 首次连接时的一次性全量快照。 */
  | { type: "state"; state: WireState }
  /** 状态中非消息字段的局部更新。 */
  | { type: "patch"; patch: WirePatch }
  /** 新增或整体替换一条消息。 */
  | { type: "message/upsert"; message: MessageView }
  /** 整体替换消息列表（切换会话、回放历史）。 */
  | { type: "messages/reset"; messages: MessageView[] }
  /** 在消息尾部追加一个段落。 */
  | { type: "message/append"; messageId: string; segment: Segment }
  /** 追加流式文本（text / thinking 段落）。 */
  | { type: "message/delta"; messageId: string; segmentId: string; delta: string }
  /** 整体替换某个段落（工具状态变化、审批结果等）。 */
  | { type: "message/segment"; messageId: string; segment: Segment }
  /** 会话列表（历史抽屉）。 */
  | { type: "sessions"; sessions: SessionSummaryView[] }
  /** 归档会话列表（历史抽屉的归档视图）。 */
  | { type: "archivedSessions"; sessions: SessionSummaryView[] }
  /** 模型目录。 */
  | { type: "models"; groups: ProviderGroupView[]; current?: ModelSelectionView }
  /** 待办清单。 */
  | { type: "todos"; todos: TodoView[] }
  /** 子代理目录（子代理面板）。 */
  | { type: "subagents/list"; entries: SubagentView[]; parentAvailable: boolean }
  /** 后台任务清单（任务面板）。 */
  | { type: "jobs/list"; jobs: JobItemView[] }
  /** 斜杠命令目录（输入框输入 / 时弹出）。 */
  | { type: "commands/list"; commands: CommandView[] }
  /** 文件引用候选（输入框输入 @ 时弹出）。 */
  | { type: "files/list"; query: string; items: FileRefView[]; sessions?: SessionRefView[] }
  /** 指定子代理的会话内容（复用 message 帧之外的单帧快照）。 */
  | { type: "subagent/transcript"; id: string; messages: MessageView[] }
  /** 一次性提示。 */
  | { type: "toast"; level: "info" | "warn" | "error"; text: string }
  /**
   * 正文里本地图片引用的解析结果（`resolveImages` 的回帧）。
   *
   * 键是**引用原文**（`out/chart.png` 这样），值是 data URL；读不到的不在表里。
   * `requestId` 原样回带：界面按它把结果配给发起的那次请求——缓存按会话隔离，
   * 切会话后旧请求的响应必须丢掉，不能按路径盲配（不同会话的同名相对路径
   * 是两个文件）。
   */
  | { type: "images/resolved"; requestId: number; urls: Record<string, string> }
  /**
   * 把一段文本插到输入框的**光标处**（不是替换整个草稿）。
   *
   * 用途：最后兜底——选了读不出来的文件、或模型不收图片时，把
   * `"C:\path"` 这样带引号的路径放进用户正在写的话里，而不是塞成附件芯片。
   * （目录不走这里：目录是 `@dir/` 引用芯片。）
   */
  | { type: "ui/insertText"; text: string }
  /**
   * 轨迹账本（宿主折叠后下发）。
   *
   * 整段 **JSON 字符串**而不是结构化对象：轨迹模型里 `startedAt: null` /
   * `timeSeconds: null` 是有意义的空值，而宿主→webview 的帧过 `JSON.stringify`
   * 时会**丢掉值为 `undefined` 的键**（见 `shared/wire.ts`）。整体过字符串就绕开了
   * 逐键折回那套语义，也不必在 `wire.ts` 里逐个登记轨迹字段。
   */
  | { type: "trajectory"; json: string }
  /** 让界面打开某个右侧抽屉（命令面板入口用，如「DSH: 历史对话」）。 */
  | { type: "ui/openPanel"; panel: string };

export type WebviewToHost =
  /** webview 加载完成，请求首帧状态。 */
  | { type: "ready" }
  /**
   * 发送一条消息。
   *
   * `gesture` 是**手势**，不是模式（官方 `ComposerSubmitGesture`）：
   * - 缺省 / `"enter"`：主发送按钮与回车（同一个手势）；
   * - `"accelerated"`：Cmd/Ctrl+Enter。
   *
   * 两者最终发到服务端的 `session/prompt.mode` 由宿主按
   * `ui-conversation.busyEnter` + 是否正在运行解析（官方 `resolveSubmitMode`：
   * 运行中主手势用设置值、加速手势用**相反**值；空闲恒 queue）。
   * 界面不自己算——它不知道「发出去的那一刻 agent 还在不在跑」。
   */
  | { type: "send"; text: string; attachments: Attachment[]; gesture?: "enter" | "accelerated" }
  /** 停止当前生成。 */
  | { type: "stop" }
  /** 取消一条排队中（尚未发送）的消息。 */
  | { type: "queueRemove"; id: string }
  /** 把一条排队中（尚未发送）的消息取回输入框重新编辑。 */
  | { type: "queueEdit"; id: string }
  /**
   * 把一条**排队中**的消息改成插话发送（`session/updateQueue` + `{kind:'steer'}`）。
   *
   * 与 `send` 的 `mode:"steer"` 不是一回事：那条是「新消息直接以 steer 投递」，
   * 这条是把**已经在队列里**的那一条改成插话。服务端要求 agent 正在运行，
   * 否则回 `session/steer-unavailable`（官方把它当静默 no-op）。
   */
  | { type: "queueSteer"; id: string }
  /** 新建会话。 */
  | { type: "newSession" }
  /** 切换到某个会话。 */
  | { type: "openSession"; sessionId: string }
  /** 请求会话列表。 */
  | { type: "listSessions" }
  /**
   * 请求轨迹账本（宿主折好之后回一帧 `trajectory`）。
   *
   * 按需请求而不是每个事件都推：账本能到几百行，流式期间每帧重算再整份下发
   * 是白烧。面板打开时请求一次，之后「一轮结束」时再请求一次（见 App 的接线）。
   */
  | { type: "listTrajectory" }
  /** 归档会话（服务端 workspace/archiveSession：从工作区分组移出，可再找回）。 */
  | { type: "archiveSession"; sessionId: string }
  /** 删除会话（服务端没有删除 API：本地删除会话日志文件目录）。 */
  | { type: "deleteSession"; sessionId: string }
  /** 加载更早的历史。 */
  | { type: "loadMore" }
  /** 切换模型 / 思考深度。 */
  | { type: "setModel"; provider: string; model: string; reasoningEffort?: string }
  /** 切换权限模式。 */
  | { type: "setPermission"; permission: string }
  /**
   * 执行一条斜杠命令（`commands/execute`）。
   *
   * 界面里所有「按钮化的命令」（权限预设、进入/退出计划模式）都走这里，
   * 不走会话 prompt：`/plan` 这类命令**必须**经命令通道，把它拼进消息正文
   * 服务端不认（实测见 `scripts/planCommandProbe.ts`）。
   */
  | { type: "runCommand"; line: string }
  /** 审批工具调用。 */
  | { type: "answerApproval"; requestId: string; approved: boolean; always?: boolean }
  /** 回答模型提问。 */
  | { type: "answerQuestion"; requestId: string; answers: { id: string; selected: string[]; custom?: string }[] }
  /**
   * **撤回**一次还在等的提问（用户主动关掉，不是回答）。
   *
   * 服务端的编码是 `rejected` + `UserQuestionError`/`ASK_CANCELLED`
   * （`dsh-api-gateway` 的 `parseRemoteEventRejection` 只认这三个键），
   * 与「答完了」是两种结算——`exit_plan_mode` 的「去聊天里说」正走这条：
   * 它让等待方带着「用户想直接说话」的语义收场，而不是收到一份答案。
   */
  | { type: "cancelQuestion"; requestId: string }
  /** 选择文件 / 文件夹加入上下文（图片按图片发送，其余文件上传，目录做引用）。 */
  | { type: "addFiles" }
  /**
   * 拖放进来的文件。**只有字节和文件名，没有路径**——这是 webview 的能力边界，
   * 不是偷懒：VS Code 不把拖拽的资源注入 webview 的 `DataTransfer`
   * （既没有 `ResourceURLs`，也没有 `text/uri-list`），而 `File.path` 自 Electron 32
   * 起已被移除（本机 VS Code 用 Electron 42），webview 侧的 `window.vscode` 也只有
   * `acquireVsCodeApi`、拿不到 `webUtils.getPathForFile`。字节因此是**唯一**通道。
   *
   * `base64` 而不是 `Uint8Array`：webview → 宿主的消息不保证是结构化克隆
   * （`Uint8Array` 过一遍 JSON 会烂成 `{"0":…}`），base64 在两种序列化下都对。
   * 代价是 4/3 体积，所以调用方在**读字节之前**先按 `DROP_BYTES_LIMIT` 拦掉超大文件。
   *
   * `unreadable` / `tooLarge` 是这一批里**没进来**的名字：目录（`File` 读字节会抛
   * IO 错误）与超限文件。宿主据此明确提示，而不是静默丢弃。
   */
  | { type: "attachBytes"; files: { name: string; base64: string }[]; unreadable: string[]; tooLarge: string[] }
  /** 重传一个上传失败的文件附件。 */
  | { type: "retryUpload"; id: string }
  /**
   * 从某条助手消息**创建分支**：以该轮为界开一个新会话，原会话不动。
   *
   * `messageId` 是视图里的消息 id（`a:<turn>`），宿主换算出 `atSeq` 边界——
   * 契约要求是 `turn/end` 的 seq（在开放轮里锚定会被拒绝，而不是往前裁剪）。
   */
  | { type: "branchFrom"; messageId: string }
  | { type: "removeAttachment"; id: string }
  /** 更新草稿（宿主侧保留，重载后不丢）。 */
  | { type: "setDraft"; text: string }
  /**
   * 在编辑器中打开文件。
   *
   * `diff` 表示「想看改动」：宿主查到可对比的改动就开 VS Code 的改动对比窗口
   * （SCM 的「打开更改」）；拿不到改动时不会静默——文件没改过、根本不是 git 仓库
   * 由宿主回落成普通打开，未跟踪的新文件则由 git 自己解析成打开文件本身
   * （判定见 `dsh/fileChange.ts`）。
   */
  | { type: "openFile"; path: string; diff?: boolean }
  /** 在编辑器区打开一个独立的聊天面板。 */
  | { type: "openInEditor" }
  /** 把代码块内容插入当前编辑器。 */
  | { type: "insertText"; text: string }
  /** 复制到剪贴板（webview 里 navigator.clipboard 受限，交给宿主）。 */
  | { type: "copy"; text: string }
  | { type: "showLogs" }
  | { type: "restartInternal" }
  /**
   * 「启动内部 DSH」：**用户显式**要求一套内部后台可用（按钮态里内部不在时的主动作）。
   *
   * 与「连接内部 DSH」**同一套逻辑**（没有就起、有就接上）；两者的差别只在界面按两轴状态
   * 给的措辞。只有「连接外部 DSH」不走这条——外部目标从来不由扩展拉起。
   */
  | { type: "startInternal" }
  /** 「连接内部 DSH」：有就接上、没有就起一套（与「启动内部 DSH」同一套逻辑）。 */
  | { type: "connectInternal" }
  /**
   * 「连接外部 DSH」：去连 `dshChat.url`（备用地址）。
   *
   * 地址没配时界面上这枚按钮是置灰的（点击不会到宿主），连接失败只进日志与连接条。
   */
  | { type: "connectExternal" }
  /**
   * 「停止连接」：停掉**正在进行的连接**（中止在途那一轮 + 关掉自动重连）。
   *
   * 界面在**任何**连接中的状态都会给这个按钮（`connection === "connecting"`），
   * 不限于"重连循环在跑"——用户 2026-09-15 口径。后台不动，可随时再点连接按钮。
   */
  | { type: "stopReconnect" }
  /** 输入 / 替换外部服务器的访问令牌（服务端要求授权时使用）。 */
  | { type: "setToken" }
  /**
   * 用**系统默认浏览器**打开这个 dsh web（带启动令牌）。
   *
   * 刻意不做「打开到指定会话」：Web UI 没有任何 URL 深链——它唯一读查询串的地方是
   * fixture 测试开关（官方 `dsh-client-connection` 的 `fixtureOptionsFromLocation`），
   * 会话选择存在浏览器本地的持久单元（`dsh.sessions.current`），外部指定不了；
   * 而且启动令牌换 cookie 是 `303 → 裸 /`，附带的查询串本来就会被丢掉。
   */
  | { type: "openInBrowser" }
  /** 打开子代理面板（列出当前会话的子代理）。 */
  | { type: "listSubagents" }
  /** 查看某个子代理的对话记录。 */
  | { type: "openSubagent"; id: string }
  /** 请求后台任务清单。 */
  | { type: "listJobs" }
  /** 请求斜杠命令目录。 */
  | { type: "listCommands" }
  /** 查询文件引用候选（@ 提及）。 */
  | { type: "queryFiles"; query: string }
  /**
   * 解析正文里的**本地图片引用**（`![](out/chart.png)`）。
   *
   * webview 读不了磁盘，只能把引用原文交给宿主：宿主按会话工作目录解析、
   * 校验在工作目录内、读成 data URL 回帧（见 `dsh/localImages.ts`）。
   */
  | { type: "resolveImages"; requestId: number; paths: string[] };
