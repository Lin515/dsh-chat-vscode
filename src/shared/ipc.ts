import type { Attachment, ChatState, ChangesSummaryView, MessageView, ModelSelectionView, ProviderGroupView, Segment, SessionSummaryView, TodoView } from "./chat";
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
  /**
   * 把一条消息从列表里去掉（`messageId` 不存在时是空操作）。
   *
   * 目前唯一的发射点是审批卡结算（`SessionAdapter.dropApprovalCard`）：审批卡常常
   * **独占一条助手消息**（宿主为它新建的那条），摘掉那一段之后整条消息就什么都不剩了，
   * 留着会在界面上留一行空行。不走 `messages/reset` 整份重发：那会让界面把整个消息
   * 列表重渲染一遍（列表没有虚拟滚动），而这件事每次审批只发生一次、只涉及一条消息。
   */
  | { type: "message/remove"; messageId: string }
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
  /**
   * 一条 `workspace/changes` 宣告的改动清单（`/api/changes.summary` 的结果）。
   *
   * `summary: null` = Host **明确说没有**这份清单（404：Host 重启过、Session 已
   * 释放）。它必须与「还没问过」区分开，所以走独立帧而不是 `patch`——`patch` 里
   * `null` 的语义是「清空这个键」（见 `shared/wire.ts`），界面就再也分不出
   * 「问过了、没有」与「还没问」了。
   */
  | { type: "changes/summary"; sessionId: string; seq: number; summary: ChangesSummaryView | null }
  /** 归档会话列表（历史抽屉的归档视图）。 */
  | { type: "archivedSessions"; sessions: SessionSummaryView[] }
  /** 模型目录。 */
  | { type: "models"; groups: ProviderGroupView[]; current?: ModelSelectionView }
  /** 待办清单。 */
  | { type: "todos"; todos: TodoView[] }
  /** 子代理目录（标题旁导航的清单）。 */
  | { type: "subagents/list"; entries: SubagentView[] }
  /** 后台任务清单（任务面板）。 */
  | { type: "jobs/list"; jobs: JobItemView[] }
  /**
   * 一条停止请求的结算（`killJob` 的回帧）。
   *
   * `ok: true` = 服务端受理了（`requested` / `already-finished`）——界面停在
   * 「请求中」，行状态由名册帧推成 `stopping` / `killed` 后自然收场；
   * `ok: false` = 请求没被受理（没连接、没绑定会话、404 / `job/not-found` 等），
   * 界面亮一小段「停止失败」。**每次结算都要发**，连失败也一样——它是界面
   * 唯一能用来结束「请求中」的信号。
   */
  | { type: "jobs/killResult"; jobId: string; ok: boolean }
  /**
   * 一条后台任务的实时输出**观察流已开**（`job/follow` 的 `opened` 锚点）。
   *
   * `from` 是第一条输出帧的起点、`earliest` 是环里最旧的保留字节：界面用这一对
   * 判「要看的开头是不是已经被淘汰」（`from < earliest`，或第一次观察就直接锚在
   * `from > 0`），判据在 `webview/jobObserve.ts`。
   */
  | { type: "jobs/opened"; jobId: string; watchId: number; from: number; earliest: number }
  /**
   * 一段实时输出（服务端已合并过的批次，不是逐字节）。
   *
   * `gapBefore` 是宿主折算好的「这段之前丢过字节」：服务端的 `lossy` 与
   * 任一 chunk 自己的 `gapBefore` 对界面是同一件事，折算在 `dsh/jobView.ts`。
   */
  | { type: "jobs/output"; jobId: string; watchId: number; text: string; gapBefore: boolean }
  /**
   * 观察流**终态失败**（流被服务端拒绝、连接已断且不再重开、宿主没能开流）。
   *
   * `detail` 缺席 = 宿主连流都没能开（没连接 / 没有绑定会话），界面显示一句
   * 概括文案；给了 `detail` 就是服务端 / 传输层的原样报错，界面套模板显示、
   * **不翻译**（模型与服务端的原始报错一律原样露出）。
   */
  | { type: "jobs/observeFailed"; jobId: string; watchId: number; detail?: string }
  /** 斜杠命令目录（输入框输入 / 时弹出）。 */
  | { type: "commands/list"; commands: CommandView[] }
  /**
   * `@` 候选的**文件那一半**（输入框输入 @ 时弹出）。
   *
   * 与对话候选分成两条帧，因为两个源在服务端的成本差三个数量级：文件那一半是
   * 一次 `readdir`（本机实测 0.1ms），对话候选要扫**全部**会话日志
   * （`sessionReferenceResolver/candidates` → `sessionQuery.listSessions` →
   * 逐个会话 stat + 读头部，本机 339 条会话实测 130ms 以上）。合成一条帧就是
   * 「切进一个只有几个文件的目录，却要等一次全语料扫描」——用户报的
   * 「@ 列表切换目录感觉慢」正是它。官方的 `@` 源同样是两个 source 各自结算
   * （`dsh-client-ui-input-trigger` 的 `source-settled`），界面按同一口径合并。
   */
  | { type: "files/list"; query: string; items: FileRefView[] }
  /**
   * `@` 候选的**对话那一半**（`sessionReferenceResolver/candidates`）。
   *
   * `query` 说明这一批候选**属于哪一次查询**：界面只收与当前文件列表同属一次查询的
   * 那一批，晚到的旧批次直接丢——否则会渲染出「文件是这一层的、对话是上一层筛出来的」
   * （宿主侧更早就作废了旧查询，见 `controller.queryFiles` 的作废口径）。
   */
  | { type: "files/sessions"; query: string; sessions: SessionRefView[] }
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
  /**
   * **撤回**一条发送失败的回显：把那一行删掉。
   *
   * 不把正文塞回输入框（用户 2026-09-25 口径）：失败的那条消息**留在原地**，
   * 要重发就点它旁边的「重发」。
   */
  | { type: "retractPending"; requestId: string }
  /**
   * **重发**一条发送失败的回显：先撤回（删掉那一行），再按普通发送重走一遍。
   *
   * 这是失败消息唯一的再发路径——它不在会话内容里（宿主账本之外没有任何地方引用它），
   * 所以「后续会话继续」永远不会把它带上。连点两次是安全的：第二下找不到那条回显，
   * 宿主直接不做。
   */
  | { type: "resendPending"; requestId: string }
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
  /**
   * 更改**新会话的工作目录**（空态页那一行，只在 VS Code 没有打开文件夹时可用）。
   *
   * 宿主弹系统目录选择器；选定后这个目录成为新会话的 cwd——已绑定的那个空白会话
   * 会在新目录里**重建**（会话 header 的 cwd 是创建事实，改不了）。
   */
  | { type: "pickWorkspace" }
  /**
   * 给当前**空白会话**切换 agent 预设（`agentPresets/select`）。
   *
   * 只在会话还没有产生任何轮次时有效：服务端对已经开始的会话回
   * `agent-preset/locked`，宿主把它当一次明确的失败提示出来。
   */
  | { type: "setAgentPreset"; id: string }
  /** 切换到某个会话。 */
  | {
      type: "openSession";
      sessionId: string;
      /**
       * 会话是**子代理**时的地址：子代理不进会话列表、只能用子代理地址打开
       * （`session/follow` 的 subagent 地址是鉴权的一部分）。面包屑返回父会话、
       * 切到兄弟子代理、以及恢复路径都带它；普通会话没有这个字段。
       */
      subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" };
    }
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
  /**
   * 加载更早的历史（`session/page`）。
   *
   * **两档语义**（与官方 `loadOlder` / `loadThrough` 同构，判据在宿主侧）：
   * - 不带 `targetSeq`：单页档，取一页就停——会话页与轨迹视图的「加载更早」按钮；
   * - 带 `targetSeq`：到目标档，循环取到窗口覆盖该 seq 为止——轮次横条上那些
   *   「未加载」的刻点，取完再落位到那一轮。
   */
  | { type: "loadMore"; targetSeq?: number }
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
   * 拖放 / 粘贴进来的文件。**只有字节和文件名，没有路径**——这是 webview 的能力边界，
   * 不是偷懒：VS Code 不把拖拽的资源注入 webview 的 `DataTransfer`
   * （既没有 `ResourceURLs`，也没有 `text/uri-list`），而 `File.path` 自 Electron 32
   * 起已被移除（本机 VS Code 用 Electron 42），webview 侧的 `window.vscode` 也只有
   * `acquireVsCodeApi`、拿不到 `webUtils.getPathForFile`。字节因此是**唯一**通道
   * （粘贴这条路为什么也走字节、以及 `Ctrl+V` 在桌面版是怎么被 VS Code 接管又补发的，
   * 见 `webview/attachIntake.ts` 的文件头）。
   *
   * `base64` 而不是 `Uint8Array`：webview → 宿主的消息不保证是结构化克隆
   * （`Uint8Array` 过一遍 JSON 会烂成 `{"0":…}`），base64 在两种序列化下都对。
   * 代价是 4/3 体积，所以调用方在**读字节之前**先按 `ATTACH_BYTES_LIMIT` 拦掉超大文件。
   *
   * `unreadable` / `tooLarge` 是这一批里**没进来**的名字：目录（`File` 读字节会抛
   * IO 错误）/ 0 字节 / 超限文件。宿主据此明确提示，而不是静默丢弃——提示文案按
   * `source` 分「拖放 / 粘贴」两套措辞（只影响措辞，准入判据完全相同）。
   *
   * **拖放不支持文件夹**：VS Code 不把 OS 路径交给 webview（pre 脚本只转发
   * `shiftKey`、宿主只切换 iframe 的 `pointer-events`、Electron 32+ 又移除了
   * `File.path`），所以拖进来的目录只能落成 `unreadable`。粘贴那条路另有宿主侧的
   * 系统剪贴板真路径（`dsh/clipboardPaths.ts`），目录在那里才成得了 `@dir/` 引用。
   *
   * `mimeType` 是浏览器声明的类型（`File.type`）：宿主**优先**按它判图片（官方
   * 同样按 MIME 判定，见 `dsh/attachments.ts` 的 `imageMediaTypeForEntry`），
   * 拿不到（旧帧 / 空串）才退回文件名后缀。
   *
   * `source` 缺省当 `"drop"`（旧帧只有拖放这一条路）。
   */
  | {
      type: "attachBytes";
      source?: "drop" | "paste";
      files: { name: string; mimeType?: string; base64: string }[];
      unreadable: string[];
      tooLarge: string[];
    }
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
   *
   * `line` 是 1 基起始行（正文里 `[…](src/a.ts#L12)` 这种带行号的链接）：
   * 打开后光标落在这一行。宿主会先验证它是不是正整数，非法就当没给。
   *
   * `link` 表示这次点击来自**正文里的文件链接**（不是工具行的文件芯片）：
   * 两者「文件不在那儿」时的措辞不同——芯片的文件确实存在过，链接却常常一开始
   * 就没指对地方（相对的不是会话工作目录、或把行号写进了目标），所以链接那条路
   * 要把**解析出来的绝对路径**报出来（见 `controller.reportMissingFile`）。
   */
  | { type: "openFile"; path: string; diff?: boolean; line?: number; link?: true }
  /**
   * 用**系统默认程序**打开一条外链（正文里 `[说明](https://…)` 这类链接）。
   *
   * webview 自己没有开浏览器的能力，而让 `<a>` 自己导航会把整个聊天界面换掉。
   * 只认 http / https / mailto（界面的白名单与宿主这一层各判一次，见
   * `webview/fileLinks.ts` 的 `externalLinkUrl`）：模型输出不可信，多认一个
   * scheme 就等于多开一条宿主动作。
   */
  | { type: "openExternal"; url: string }
  /**
   * 请求一条 `workspace/changes` 宣告的改动清单。
   *
   * **按需**（卡片真要渲染时）而不是事件到达即推：清单要经一次 HTTP 往返，而用户
   * 完全可能在等待期间切走再切回来——那时推的帧已经丢了。按需请求能把缺的补回来，
   * 宿主侧按 `seq` 做 fetch-once 缓存（见 controller 的 `loadChangesSummary`）。
   */
  | { type: "requestChanges"; sessionId: string; seq: number }
  /** 在编辑器区打开一个独立的聊天面板。 */
  | { type: "openInEditor" }
  /** 把代码块内容插入当前编辑器。 */
  | { type: "insertText"; text: string }
  /** 复制到剪贴板（webview 里 navigator.clipboard 受限，交给宿主）。 */
  | { type: "copy"; text: string }
  /**
   * 把会话里的一张图**另存**到用户选的路径（图片右键菜单的「保存」）。
   *
   * 界面只交**图片地址原文**（`data:` / `https:`）：webview 读不了磁盘、弹不了系统
   * 对话框，它的 CSP（`default-src 'none'`）也 fetch 不了外链图。宿主负责解析字节
   * （data URL 直接解码、外链拉一次）、弹保存对话框、写盘（见 `dsh/imageFiles.ts`）。
   *
   * `name` 是界面从 `<img alt>` 摘来的**建议文件名**，可能为空、也可能根本不是
   * 文件名（无障碍文案「消息里的图片」就是这种）——宿主只当建议，最终扩展名按
   * 真实媒体类型定。
   *
   * 复制图片**不走这条**：那条路在界面里就能完成（canvas 转 PNG + `ClipboardItem`），
   * 见 `webview/imageClipboard.ts`。
   */
  | { type: "saveImage"; src: string; name?: string }
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
  /** 刷新当前会话的子代理目录（标题旁导航打开 / 悬停时）。 */
  | { type: "listSubagents" }
  /**
   * 进入某个子代理的对话（**会话级切换**，与官方 Web 的 `openSession(address)` 同构）：
   * 窗口整个绑到子代理会话上，消息流 / 输入框都换成它的。
   */
  | { type: "openSubagent"; id: string }
  /** 请求后台任务清单。 */
  | { type: "listJobs" }
  /**
   * 停止一条后台任务（两段式按钮的第二下；`job/kill`，见 `dsh/client.killJob`）。
   *
   * 宿主**总是**回一帧 `jobs/killResult`（连不上、没绑定会话、请求失败都算
   * `ok: false`）——界面的「请求中」状态靠它收场，不回帧按钮会永远转下去。
   */
  | { type: "killJob"; jobId: string }
  /**
   * 展开一行后台任务：开始观察它的实时输出（`job/follow`）。
   *
   * `watchId` 由**界面**铸造、宿主原样回带：一条观察流可能被重开（断线重连、
   * 收起后再点开），而两轮的在途帧会在界面上交错——带上这个号，界面只认自己
   * 当前那一个，旧流的残余帧一律丢掉（判据在 `webview/jobObserve.ts`）。
   *
   * 宿主**不一定回帧**：正常路径由 `jobs/opened` 起头；开不了流时必须回一帧
   * `jobs/observeFailed`（否则展开区永远停在「还没有输出」）。
   */
  | { type: "observeJob"; jobId: string; watchId: number }
  /**
   * 收起（或关面板 / 行离开名册）：释放这次观察。
   *
   * 观察流是**按窗口**跟踪的（同一时刻只有一行是展开的），所以释放即取消——
   * 界面上没有第二个人在看，留着流只是白占一条 socket 多路复用通道。
   */
  | { type: "unobserveJob"; jobId: string }
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
