/**
 * 视图模型：宿主与 webview 共用的聊天状态形状。
 *
 * 这一层刻意与 DSH 线协议解耦：宿主里的协议适配器（src/dsh/*）负责把
 * session/* 事件流翻译成这里的结构，webview 只认这套结构渲染。
 * 好处是界面代码不随服务端协议变动，协议变更只影响适配器。
 */

import type {
  CatalogEntry,
  InstructionChange,
  RecalledSession,
  SnapshotSection,
} from "./injectedSource";

/**
 * 界面可见的连接状态。
 *
 * `stopped` 与 `error` 的区别是**要不要用户动手**：
 * - `stopped` = 后台根本没在跑（关掉自动启动后的常态）→ 界面显示「启动服务器」；
 * - `error` = 后台在跑/尝试过，但这次连不上 → 界面显示原因 + 「尝试连接」。
 *
 * 两者分开是用户 2026-09-14 的口径：关掉 `dshChat.autoStart` 之后，扩展**不许**在
 * 后台不存在时自己拉起一套，界面上要明明白白给一个「启动服务器」的按钮，
 * 而不是把"没启动"渲染成"正在连接…"（那样用户只会以为卡住了）。
 */
export type ConnectionState = "connecting" | "ready" | "error" | "stopped";

/**
 * 附件种类。
 *
 * 与官方客户端的两条路一一对应（见 `dsh/references.ts` 的文件头说明）：
 * - `image`：图片按内容块发送（官方同样内联图片字节）；
 * - `file`：**上传**后拿 `receiptId` 发送，不再内联正文；
 * - `reference`：`@path` 引用，正文里只出现路径 token；
 * - `context`：纯文本上下文（插件注入等）。
 *
 * **没有 `selection`**：编辑器选区、文件、目录现在**一律走 `@` 引用**（用户
 * 2026-09-14 口径：「不论是目录、文件、文件某行，均以 @ 引用形式而不是附件形式
 * 添加」）——引用是由宿主把 token 插进输入框正文的，不经过附件列表。
 */
export type AttachmentKind = "file" | "image" | "context" | "reference";

/** 文件附件的上传生命周期（官方 `DraftFileUpload`）。 */
export type UploadState =
  | { status: "uploading"; loaded: number; total?: number }
  | { status: "ready"; receiptId: string }
  | { status: "error"; message: string };

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** 文件/目录的绝对路径（图片没有）。 */
  path?: string;
  /** 展示名：优先相对工作区的路径。 */
  name: string;
  /** 图片的 data URL。 */
  dataUrl?: string;
  /** 图片字节数。 */
  bytes?: number;
  /** 该文件附件的上传状态（`kind === "file"` 时）。 */
  upload?: UploadState;
  /** `@` 引用的目标类型（`kind === "reference"` 时）。 */
  referenceKind?: "file" | "directory";
}

/**
 * 工具行的状态。
 *
 * `stopped` 是官方 `ToolRowState` 的第四态：工具调用被**中断**（`turn/end` 因
 * abort 收场时，官方为所有未结算的调用**合成**一个 `error.code === 'interrupted'`
 * 的结果）。它与 `error` 的区别不只是颜色——中断不是工具的失败，界面用警告色而非
 * 错误色，且不该把结果文本渲染成报错。
 */
export type ToolStatus = "pending" | "running" | "ok" | "error" | "stopped";

/** diff 的一行：上下文 / 新增 / 删除。 */
export interface DiffLineView {
  kind: "context" | "add" | "del";
  text: string;
}

/**
 * 一个 diff 段。
 *
 * 来源有两条：服务端 `tool/result.meta.diffs` 的 hunk（edit/write 工具自带
 * 3 行上下文的成对文本），或工具参数里的 `old_string` / `new_string`
 * （结果还没回来时先给个预览）。两者都归一成这里的行序列。
 */
export interface DiffHunkView {
  /** 文件路径（工具参数里的原样字符串）。 */
  path?: string;
  lines: DiffLineView[];
  /** 新增 / 删除的行数，界面用 `+N −M` 展示。 */
  added: number;
  removed: number;
  /** 行数超上限被截断（界面给一行省略提示）。 */
  truncated?: boolean;
}

/** 编辑类节点的 diff 排版：自适应（按容器宽度）/ 固定单栏 / 固定双栏。 */
export type DiffLayout = "auto" | "unified" | "split";

/**
 * 文件芯片的改动种类（宿主按 git 状态 + 磁盘存在性分类，见 dsh/fileChange.ts）。
 *
 * - `new`：git 未跟踪（模型本轮新建）→ 芯片标 `[新增]`，点击直接打开文件。
 *   **两种 `git.untrackedChanges` 配置都算**：默认 `"mixed"` 下它在工作区清单里、
 *   靠 `status === UNTRACKED` 认出来，`"separate"` 下才在 `untrackedChanges` 里
 *   （只认后者的症状是新文件永远不标 [新增]，见 `dsh/fileChange.ts` 的 `isUntracked`）；
 * - `edited`：有可对比的工作区/暂存/合并改动 → 点击开 VS Code 的对比窗口；
 * - `deleted`：文件已不在磁盘上（且 git 知道它）→ 芯片名画删除线，点击尝试打开旧内容；
 * - `gone`：磁盘上没有、git 也**完全不知道**它（不在工作区/暂存/合并/未跟踪任何
 *   一张清单里）→ 本轮「写了又删、净效果为零」的临时文件（`commit.msg.txt` 这类），
 *   界面**不渲染**这一条：它不代表任何改动，画成删除线只会让人以为仓库脏了。
 */
export type FileChangeKind = "new" | "edited" | "deleted" | "gone";

export interface ApprovalView {
  requestId: string;
  toolName: string;
  reason?: string;
  /** 待执行的参数预览（命令行/文件路径等）。 */
  detail?: string;
  state: "waiting" | "approved" | "rejected" | "expired";
  /** 是否允许「始终允许」。 */
  allowAlways?: boolean;
  /**
   * 这次审批针对的**工具调用 id**（`approval/request` 与 `approval/asked` 都带它）。
   *
   * 用途只有一个：把会话日志里的 `approval/asked {id, callId}` 与随后那条
   * `approval/decided {id, outcome}` 对回本窗口这张卡（另一个窗口答的审批，
   * 本窗口只能从会话日志知道结果，见 `adapter.applyEvent`）。
   * asker 没给 callId 时缺失，那种情况按「本会话唯一在等的审批」兜底。
   */
  callId?: string;
}

export interface ToolCallView {
  id: string;
  /** 原始工具名，如 read / edit / pwsh / grep。 */
  name: string;
  /** 人类可读的一行标题，如「读取 package.json」。 */
  title: string;
  /** 次要说明（路径、命令摘要），单行标题里过长会被省略。 */
  detail?: string;
  /**
   * 完整、未截断的「在做什么」（命令原文 / 完整路径 / 查询串）。
   *
   * `detail` 会被标题的省略号截掉，构建这类长命令看不全；展开区用它显示原文。
   */
  command?: string;
  /**
   * 读取类工具本次读到的行号区间。
   *
   * 只读了一段时界面把它缀在文件名后（`…/controller.ts:100-120`），
   * 让用户一眼看出模型是看了整个文件还是只扫了一段。整篇读取时不下发。
   *
   * 刻意与 `detail` 分开、而不是拼进字符串：`detail` 是从**右侧**省略的，
   * 把行号拼在末尾会在窄侧栏被截掉，正好丢掉这个信息。
   */
  readLines?: { start: number; end: number };
  status: ToolStatus;
  /** 原始参数载荷（流式期逐 delta 累积，durable 事件到达后重新摘要）。界面不直接渲染。 */
  input?: string;
  /** 结果文本。 */
  output?: string;
  /**
   * 编辑类工具的结构化 diff（edit / str_replace / write）。
   *
   * 展开时优先渲染它而不是 `output` 的确认句；结果带 `meta.diffs` 时以它为准，
   * 否则用参数里的 old/new 文本兜底（运行中也就能看到将要改什么）。
   */
  diff?: DiffHunkView[];
  /** 图片结果（data URL）。 */
  images?: string[];
  /**
   * 终端类结果的退出状态（`parseExitStatus` 的产物）。
   *
   * 结果正文里那行 `[exit code: N]` 已被剥掉，改由这两个字段承载；界面据此把
   * 非零退出呈现为失败（bash/pwsh 工具**故意**不把非零退出标成 isError）。
   */
  exitCode?: number;
  signal?: string;
  /** 该工具产生的可交付文件。 */
  files?: { path: string; description?: string }[];
  startedAt?: number;
  endedAt?: number;
  /** 用户手动折叠状态；undefined 表示按运行状态自动决定。 */
  open?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionItemView {
  id: string;
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** 一道题的回答（`AskUserQuestionAnswerItem` 的界面投影）。 */
export interface QuestionAnswerView {
  /** 选中的选项 label（单选 + 自定义文本时为空数组，官方口径）。 */
  selected: string[];
  /** 自由文本「其它」答案。 */
  custom?: string;
}

export interface QuestionView {
  requestId: string;
  items: QuestionItemView[];
  /**
   * `waiting`：正在等回答（卡片接管输入区）。
   * `answered`：已答完（本窗口提交、另一个窗口提交、或会话监听判定完成了）。
   * `cancelled`：请求被撤回（Host 取消了这次提问 / 轮次被中止），**没人回答过**。
   *
   * 后两者都表示「不再是待处理交互」——输入区据此把位置让出来（见
   * `pendingInteraction.isTakenOverByComposer`）。
   */
  state: "waiting" | "answered" | "cancelled";
  /**
   * 用户提交的回答，按问题 id 归档。
   *
   * **展开记录要显示「用户当时选了什么」只能靠它**：卡片自己的本地 state 在
   * 重挂载（换会话回来、另一个窗口答的）时是空的（用户 2026-09-15 报的就是
   * 「答完的问题展开后没有显示用户的回答」）。
   */
  answers?: Record<string, QuestionAnswerView>;
}

/** 上下文注入条目里按 form 各自解析出来的结构化字段（见 `shared/injectedSource.ts`）。 */
export interface InjectedSourceView {
  changes?: InstructionChange[];
  entries?: CatalogEntry[];
  sections?: SnapshotSection[];
  senderSessionId?: string;
  references?: RecalledSession[];
}

/**
 * 一条**自动载入**的提示词内容（系统提示词 / 插件注入 / 项目指令 / 技能目录…）。
 *
 * 这些不是用户输入，但确实进入了模型上下文：服务端把它们作为
 * `system/message` 事件，或作为 `source.kind !== 'user'` 的 `user/message`
 * 事件发出来。此前全部被丢弃，用户看不到「模型到底被喂了什么」。
 *
 * 只带语言中立字段，标签由界面按当前语言渲染。
 */
export interface InjectedView {
  /** 来源大类：`system`（系统提示词）/ `plugin` / `agent-instructions` / `skill-catalog` / 其它。 */
  sourceKind: string;
  /** 具体插件名（`source.plugin`），如 `dsh-mcp-manager`。 */
  plugin?: string;
  /** 注入形式（`source.form`）：`instructions` / `snapshot` / `catalog` / `recall` / `mcp-status`… */
  form?: string;
  /** 内容文本。 */
  text: string;
  /**
   * `source` 里的**结构化字段**（按 form 各自解析，见 `shared/injectedSource.ts`）。
   *
   * 官方的上下文条目是按 form 分派正文的：指令列出「哪个文件 + 已新增/已更新/已移除」、
   * 目录列出条目、快照列出分节、回忆给出「保留 N 条 · 省略 M 条」。这些字段此前被我们
   * 整个丢掉，界面上只剩一段文字。形状不合预期时**整项不填**，退回「正文 + 原样字段」。
   */
  source?: InjectedSourceView;
}

/**
 * 助手消息里的一个显示段。
 *
 * 外面套一层 `{ step?: number }`：**该段所属的 step**（轮内从 0 起），供轮级统计与
 * 时序判断使用。**轮级过程折叠不看 step**：它按段的**性质**分派（正文 / 提示永不折，
 * 只折思考、工具与非 system 的上下文注入），所以历史里缺 `step/start` 时同样折得对
 * （见 `webview/turnProcess.ts`）。
 */
export type Segment = { step?: number } & (
  | { kind: "text"; id: string; text: string; streaming?: boolean }
  | { kind: "thinking"; id: string; text: string; streaming?: boolean; durationMs?: number; open?: boolean }
  | { kind: "tool"; id: string; tool: ToolCallView }
  | { kind: "approval"; id: string; approval: ApprovalView }
  | { kind: "question"; id: string; question: QuestionView }
  | { kind: "injected"; id: string; injected: InjectedView }
  | { kind: "command"; id: string; command: CommandRunView }
  /**
   * 助手消息里的图片块（模型输出或工具回带的图）。
   *
   * 契约里 `assistant/message` 的 `content` 是完整的内容块联合
   * （`text | reasoning | image | file | tool-call | tool-result`），此前适配器只折叠
   * text/reasoning，**图片块被静默丢弃**——模型给你看一张图，界面上什么都没有。
   * `images` 是已经换成 data URL 的字节（句柄 → `session/attachment` 的 RPC 由控制器
   * 完成），加载中会是空数组（宁可不占位，也不要先闪一个碎图图标）。
   */
  | { kind: "images"; id: string; images: string[] }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string }
  /**
   * **认不出的内容块**（官方渲染链的 default 分支：`JsonBlock` + 「未知内容块」）。
   *
   * 此前适配器只认 text/reasoning/image，其余块**整块消失**——模型给的东西在界面上
   * 连痕迹都没有。现在按官方口径留一条 JSON 记录：`type` 是块类型、`json` 是内容
   * （超长会截断，见适配器里的上限）。`file` 块也走这里——官方同样没给它专属分支。
   */
  | { kind: "unknown"; id: string; type: string; json: string }
);

/**
 * 一轮的用时与速度（官方的 turn-time）：轮尾操作条上那枚「用时 X」胶囊 + 点开的明细。
 *
 * - `ranForMs`：本轮总用时 = `turn/end` 的时刻 − 本段开始时刻（与官方
 *   `runMs = turn.end.time - turn.start.time` 同口径）。**同轮被插话切成多段时**
 *   是「本段」的用时（官方没有分段概念，这是本扩展自己的机制）。
 * - `tokensPerSecond`：解码吞吐 = 各 step 的输出 token 之和 ÷ 各 step 解码窗口之和
 *   （官方 `stats.decodeTokens / (stats.decodeMs / 1e3)` 的同一个算法）。
 * - `ttftMs`：**本轮第一步**的首 token 用时（官方 `firstStepTtftMs`）。
 */
export interface TurnStatsView {
  ranForMs: number;
  tokensPerSecond?: number;
  ttftMs?: number;
}

export interface UsageView {  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** 缓存读取 token（provider cacheRead），缓存命中率分子。 */
  cacheReadTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** 上下文窗口上限（用于上下文占用条）。 */
  contextWindow?: number;
  /**
   * 输出 token 生成速度（tok/s）：该消息所在 step 的 decode 窗口速度，
   * `outputTokens / (首个 token delta → 最终消息)`，对齐 dsh web 客户端
   * `turn-metrics` 的 decode 吞吐口径（不含 prefill/工具等待）。
   * 仅当该 step 同时有 timing 和 usage 时才计算。
   */
  tokensPerSecond?: number;
}

/** 上下文占用（dsh web 客户端 `context-occupancy` 投影的输出形状）。 */
export interface ContextOccupancyView {
  percent: number;
  usedTokens: number;
  contextWindow: number;
}

export interface DeliverableView {
  path: string;
  description?: string;
}

export interface MessageView {
  id: string;
  role: "user" | "assistant";
  ts: number;
  /** 用户消息正文（助手正文在 segments 里）。 */
  text?: string;
  segments: Segment[];
  attachments?: Attachment[];
  streaming?: boolean;
  /**
   * 轮尾的用时与速度（`turn/end` 时写入，见 `TurnStatsView`）。
   *
   * 只在**轮次结束后**才有值：轮次进行中算不出总用时，也不该显示。
   */
  turnStats?: TurnStatsView;
  model?: string;
  /** 本 step 的用量：只用于上下文占用条与输出速度（tok/s），不再单独成行展示。 */
  usage?: UsageView;
  deliverables?: DeliverableView[];
  /**
   * 本轮**产生**的文件（成功的 write / edit / str_replace_editor 调用）。
   *
   * 与 `deliverables`（`present` 工具的显式申报）是两回事：官方也分开算——
   * 这是从工具参数推导的，不依赖模型记得在正文里点名（`dsh-client-ui-deliverables`
   * 的 `producedForClosing`）。界面在轮尾列出它们。
   */
  produced?: string[];
  /** 出错时的提示文本。 */
  error?: string;
}

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoView {
  id: string;
  content: string;
  status: TodoStatus;
}

export interface SessionSummaryView {
  id: string;
  title: string;
  updatedAt: number;
  cwd?: string;
  running: boolean;
  blank?: boolean;
  /**
   * 源会话 id：分支（`session/fork`）出来的会话带它，列表里缩进显示在源会话下面。
   *
   * 注意**不能**用「有没有它」判断该不该显示——子代理会话也有它，
   * 但子代理另有 `origin: 'subagent'`（见 `dsh/sessionList.ts`）。
   */
  parentSessionId?: string;
  /** 血缘深度（root = 0；分支 1、分支的分支 2…），界面乘一个缩进宽度。 */
  depth?: number;
}

export interface ModelEffortView {
  id: string;
  name: string;
}

export interface ModelOptionView {
  id: string;
  name: string;
  description?: string;
  efforts?: ModelEffortView[];
  defaultEffort?: string;
  /** 上下文窗口上限，用于占用条。 */
  contextWindow?: number;
  /** 该模型是否接受图片输入（目录里的 input 模态）。 */
  acceptsImage?: boolean;
}

export interface ProviderGroupView {
  id: string;
  name: string;
  models: ModelOptionView[];
}

export interface ModelSelectionView {
  provider: string;
  model: string;
  /** 展示用名称，如「DeepSeek-V4-Pro」。 */
  label: string;
  reasoningEffort?: string;
  efforts?: ModelEffortView[];
  /** 该模型的上下文窗口上限，用于占用条。 */
  contextWindow?: number;
  /** 该模型是否接受图片输入（目录里的 input 模态）。 */
  acceptsImage?: boolean;
}

/** 目标生命周期（`GoalSnapshot.phase` 词表，逐字取自 `dsh-goal`）。 */
export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/**
 * 目标条的数据（`goal` 投影的**嵌套**形状）。
 *
 * 线格式是
 * `{ goal: { id, revision, objective, phase, blockedReason?, maxGoalRounds },
 *    roundsStarted, createdAt, updatedAt }`
 * ——目标本体嵌在 `goal` 里，轮次计数却在**外层**。
 * 早先按扁平的 `{objective, phase, rounds, maxRounds}` 读，于是
 * `goal?.objective` 恒 undefined、状态恒被清空（docs/audit-summary.md §3）。
 */
export interface GoalView {
  id?: string;
  revision?: number;
  objective: string;
  phase: GoalPhase;
  /** 已开始的轮次数（外层 `roundsStarted`）。 */
  rounds: number;
  /** 轮次上限（`goal.maxGoalRounds`；契约里是必填字段）。 */
  maxRounds?: number;
  /** 仅在 `phase === "blocked"` 时给出。 */
  blockedReason?: string;
}

/**
 * 子代理（子代理面板一行）。
 *
 * 两个来源的字段集**不一样**，别互相套用：
 * - `subagents/list` RPC 返回 `SubagentListEntry`：`{kind:'child', id, activity,
 *   hasChildren, mode, label?}`；
 * - `subagentCatalog` **投影**返回 `SubagentCatalogEntry`：`{id, createdAt, mode,
 *   label?}`——**没有 `kind`/`activity`**。
 *
 * 早先把 RPC 行的过滤（`kind === "child"`）套在投影上，于是面板每次刷新都被
 * 清空（docs/audit-summary.md §4）。
 */
export interface SubagentView {
  id: string;
  label: string;
  /**
   * 生命周期模式。打开子代理对话时必须原样带上：硬编码 `continuable` 会被
   * 宿主以 `subagent/unauthorized` 拒绝 one-shot 子代理。
   */
  mode: "one-shot" | "continuable";
  /**
   * 是否驻留（`SubagentListEntry.activity`，仅 RPC 行有）。
   *
   * 投影没有这个字段，所以投影刷新时保留已知值、未知就**不下发**——
   * 界面据此决定画不画状态点，而不是猜一个「正在运行」。
   */
  activity?: "running" | "inactive";
}

/**
 * 一条斜杠命令的执行记录。
 *
 * 由会话日志里的 `command/run` ↔ `command/done` 按 `commandId` 配对折出：
 * 官方 web 端把它渲染成持久节点（两个事件都是**日志事件**，不是模型表层），
 * 这样任何入口发出的命令都有可见结果——包括命令面板上的按钮。
 */
export interface CommandRunView {
  commandId: string;
  /** 命令名（不含前导斜杠）。 */
  name: string;
  /** 命令名之后的原始参数（`command/run` 的 `args`，前导空白含在内）。 */
  args?: string;
  state: "running" | "ok" | "error";
  /** 处理器给出的结果文案；成功时也可能没有。 */
  text?: string;
}

/** 官方 `SessionJob.status` 的五态（`dsh-api-session-controller` 的线上契约）。 */
export type JobStatus = "running" | "stopping" | "completed" | "killed" | "failed";

export interface JobItemView {
  id: string;
  kind: string;
  label: string;
  /**
   * 五态之一，也可能是**服务端将来新增的状态**。
   *
   * 这里刻意保留原字符串、不折成已知值：以前未知状态被兜底成 `"completed"`，
   * 于是服务端一加新状态（比如 `paused`）界面就显示「已完成」——一个与事实相反
   * 的**肯定结论**。界面按查表 + 兜底渲染（未知 → 原样显示、不猜色调）。
   * 类型写成 `JobStatus | (string & {})`：既保留自动补全，又接受任意字符串。
   */
  status: JobStatus | (string & {});
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

/**
 * 排队中（尚未发送）的消息。
 *
 * 线格式是 `SessionQueuedItem`：`placement` 有 `queued`（排队）/ `steering`
 * （插话）/ `context`（插件注入的环境上下文）三种——后一种是服务器自己放的，
 * 不算用户消息，宿主不下发。
 */
export interface QueuedMessageView {
  /** 线格式消息 id；取消 / 重新编辑时经 session/updateQueue 带回。 */
  id: string;
  /**
   * 提交这批内容时客户端铸造的 requestId（`SessionQueuedItem.rpcId`）。
   * 用于把队列项对回用户原始输入——线上正文含内联的文件上下文，不是原样。
   */
  rpcId?: string;
  /** 消息文本内容：优先用户原始输入，取不到才退回线上文本。 */
  text: string;
  /** 已恢复的附件数量（有原始记录时）。 */
  attachments?: number;
  /** 是否携带图片/文件等附件（文本为空时界面用「附件」占位）。 */
  hasMedia?: boolean;
  /** `queued`（排队等待）或 `steering`（中途插话）。 */
  placement: "queued" | "steering";
}

/** 斜杠命令描述符（commands/list）。 */
export interface CommandView {
  name: string;
  description: string;
  hint?: string;
  /**
   * 这条其实是**技能**而非斜杠命令（来自 `skills/list`）。
   *
   * 技能没有 `commands/execute` 处理器：选中它只是把名字写进正文（用户照着
   * 点名让模型调起），所以界面要标出来，别让用户以为回车就会执行。
   */
  skill?: boolean;
}

/** 文件引用候选（fileReferences/list）。 */
export interface FileRefView {
  path: string;
  kind: "file" | "directory";
  /**
   * 界面自己插入的「返回上一层目录」行（不是服务端给的候选）。
   *
   * 只在 `@` 查询已经进入某个子目录时才有：它的 `path` 是**上一层目录**的
   * 拼写（工作区根目录是空串），选中它就回到那一层。服务端从不产出这个标记。
   */
  parent?: boolean;
}

/**
 * 对话引用候选（`sessionReferenceResolver/candidates`）。
 *
 * 官方的 `@` 源是**文件与对话共用同一个列表**（`dsh-client-ui-reference` 的
 * `candidates()` 并行取 `fileReferences.list` 与
 * `sessionReferenceResolver.candidates`，按 `section.files` / `section.sessions`
 * 分两组渲染）。选中一条就是把 `mention`（`@[标题](dsh-session:…)`）插进正文——
 * 服务端在用户消息进入模型前把它换成被引用会话的快照，客户端不做任何读取。
 */
export interface SessionRefView {
  sessionId: string;
  /** 候选标题（最近一次会话标题，没有标题时是会话 id）。 */
  label: string;
  /** 规范 mention token（`@[label](dsh-session:…)`），插入正文用。 */
  mention: string;
  /** 源会话的工作目录（没记录时缺失）。 */
  cwd?: string;
  /** `cwd` 与**当前会话**的工作目录相同（服务端算好的，客户端不比较路径）。 */
  sameWorkspace?: boolean;
  /** 源会话时间（服务端候选给的是创建时间，epoch ms）；仅用于列表显示。 */
  updatedAt?: number;
}

/** 上下文窗口的权威值来源（由服务端 `request/context` 事件给出）。 */
export interface ContextWindowView {
  tokens: number;
  /** 该上下文窗口属于哪个模型（模型 id）。 */
  model: string;
}

export interface ChatState {
  connection: ConnectionState;
  /** 连接失败/服务器异常时的说明文本。 */
  connectionDetail?: string;
  /**
   * 自动重连循环正在跑（`connection === "connecting"` 时的补充信息）。
   *
   * 重连**没有总超时**（用户 2026-09-14 口径：只要守护进程与 dsh 还在，就一直试）。
   *
   * **它不是「停止连接」按钮的开关**（2026-09-15 改）：那个按钮绑的是
   * `connection === "connecting"`——首轮连接、掉线后的循环、外部地址的等待，都属于
   * "正在连接"，用户都得能停下。这个字段只回答"循环还在不在跑"，用于连接条的文案。
   */
  reconnecting?: boolean;
  /**
   * 后台（守护进程 + dsh）此刻是不是真的在跑。
   *
   * 与 `connection` 正交：`stopped` + `serverRunning` 表示"后台在跑，但用户按了停止重连"，
   * 界面据此给「尝试连接」而不是「启动服务器」。
   */
  serverRunning?: boolean;
  /**
   * 当前是**外部服务器**模式（`dshChat.url` 非空）。
   *
   * 界面靠它决定"没连上时给哪个按钮"：外部服务器不由本扩展启动，所以 `stopped` 态下
   * 给的是「尝试连接」而不是「启动服务器」。
   */
  externalServer?: boolean;
  /** 外部服务器要求授权且尚未拿到有效令牌：界面显示「输入令牌」入口。 */
  needsToken?: boolean;
  serverUrl?: string;
  /** VS Code 的显示语言标识（如 zh-cn、en），界面据此选中英文案。 */
  locale?: string;
  session?: SessionSummaryView;
  messages: MessageView[];
  /** 当前会话是否正在生成。 */
  running: boolean;
  /** 编辑类节点的 diff 排版（对应 dshChat.diffLayout）。 */
  diffLayout?: DiffLayout;
  /**
   * 文件芯片的改动种类表（键 = 芯片上的原样路径，值 = git/磁盘判定的种类）。
   *
   * 宿主在会话加载与每轮写类调用后**整表**重算下发（patch 顶层合并，整表替换）；
   * 界面只查表渲染 `[新增]` / 删除线，不做任何自己的判定。查不到的路径（还没
   * 分类完、或不在 git 仓库）就没有记号——没有记号不是「没改动」，只是「不确定」。
   */
  fileKinds?: Record<string, FileChangeKind>;
  /**
   * 界面字号（整数 px，对应 `dshChat.fontSize`）：不下发时（配置为 0）
   * 跟随 VS Code 注入的字号。界面只把它当 CSS 变量用，不做逻辑判断。
   */
  fontSizePx?: number;
  /**
   * 一份问卷一次展开几道题（对应 `dshChat.questionBatch`，取值 ≥0）。
   *
   * 题目数**多于**它时界面改为依次问答；`0` 表示始终一次展开全部。
   * 宿主只下发用户填的数，界面不再自己读配置（webview 读不到 VS Code 配置）。
   */
  questionBatch?: number;
  /** 排队中（尚未发送）的消息列表，来自 session/control 的 queue 帧。 */
  queueItems: QueuedMessageView[];
  attachments: Attachment[];
  draft: string;
  models: ProviderGroupView[];
  model?: ModelSelectionView;
  /** 权限模式标识（read-only / workspace-write / full-access）。 */
  permission?: string;
  planMode?: boolean;
  todos: TodoView[];
  goal?: GoalView;
  subagents: SubagentView[];
  /** 后台任务（bash / pwsh / 子代理等），来自 session/control 的 jobs 帧。 */
  jobs: JobItemView[];
  /** 历史是否还有更早的内容可加载。 */
  hasMoreHistory?: boolean;
  /**
   * 宿主正在取更早的一页历史（`session/page` 在飞）。
   *
   * 由**宿主**发而不是界面自己记：界面只知道「消息数变了没有」，遇到「这一页回来了
   * 但没带来新内容」就分不清是还在飞还是已经取完（只能干等超时）。有了这个标记，
   * 「加载更早」按钮能在整条连取链期间稳定显示「正在加载更早消息…」的不可点状态，
   * 一落定就恢复；连取下一页的时机也由它决定。
   */
  historyLoading?: boolean;
  /**
   * 一次性轻提示（复制成功、设置已保存、图片被跳过…）。
   *
   * `id` 每次自增：同样的文案连续来两次（例如连点两次复制）也要重新计时，
   * 否则第二次会因为没有状态变化而不刷新。
   */
  notice?: { id: number; level: "info" | "warn" | "error"; text: string };
  /**
   * 待插入输入框光标处的文本（宿主 → 界面的单向指令）。
   *
   * `id` 递增让界面能识别「这是新的一次插入」；界面按 id 去重后自行把文本
   * 插进光标位置并移动光标——宿主不知道也无需知道光标在哪。
   */
  insertRequest?: { id: number; text: string };
  /**
   * 当前生效的上下文窗口（来自 `request/context` 事件，与当前 model/selection 对齐）。
   * 占用条只显示百分比，明细放 hover。
   */
  contextWindow?: ContextWindowView;
  /**
   * 当前会话的上下文占用（来自 dsh web 客户端 `context-occupancy` 投影的等价输出）。
   * 百分比只在 hover 时变化，避免主界面每次发送更新时闪烁。
   */
  contextOccupancy?: ContextOccupancyView;
  /**
   * 最近一次已知的输出速度（tok/s）。
   *
   * 速度是按 step 算的，而新一轮一开始「最后一条消息」还没有 usage——界面若只读
   * 最后一条消息，速度就会闪没。宿主保留上一次的已知值，有新值再覆盖，
   * 即「拿不到最新数据就以旧数据显示」。
   */
  lastSpeed?: number;
  /**
   * 上下文构成（`contextBreakdown` 投影）：系统提示词 / 工具定义 / 对话消息的
   * 启发式估算 token 数——是构成占比，不是计费值，也不与占用分子相加。
   */
  contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number };
  /**
   * 全日志累计的 provider 用量（`tokenUsage` 投影），四桶**互不重叠**。
   *
   * 注意 reasoning token **已经算在 outputTokens 里**，不再单列——重复计入是
   * 最容易被误读成「用量异常」的地方。这个值与占用条**不是一回事**：占用条是
   * prompt 侧（不含 output），这里是全会话累计。
   */
  tokenUsage?: {
    uncachedInputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /**
   * 轮次大纲（`turnOutline` 投影）：**每一轮**的序号、`turn/start` 的 seq 与
   * 两段有界预览。
   *
   * 形状按契约逐字核过（`@deepseek-ai/dsh-session-turn-outline/lib/types/types.d.ts`
   * 的 `TurnOutlineEntry`）：`{turn, seq, prompt, response}`。此前这里读的是
   * `{summary, startedAt}`——投影里根本没有这两个字段，于是恒为空串/0，而
   * `prompt`/`response` 从未被读过（第三次「按猜测的形状写」，前两次是 goal 与
   * subagentCatalog）。侧边轮次横条就是它的消费者。
   *
   * 注意：投影**独立于分页窗口**——没加载进来的轮次也在里面，这正是横条能列出
   * 全部轮次、并按 `seq` 往前加载到某一轮的依据。
   */
  turnOutline?: { turn: number; seq: number; prompt: string; response: string }[];
  /**
   * 「繁忙时的发送行为」（`ui-conversation.busyEnter`，全局部署设置）。
   *
   * 界面只用它显示运行中发送按钮的文案（排队发送 / 插话发送）与插话可用性提示；
   * **真正发出去的 `session/prompt.mode` 由宿主解析**（官方 `resolveSubmitMode`：
   * 运行中主手势用这个值、Cmd/Ctrl+Enter 用相反值，空闲恒 queue）——界面不知道
   * 「按下回车那一刻 agent 还在不在跑」，自己算会算错。
   */
  busyEnter?: "queue" | "steer";
  /**
   * 图片准入上限（`imageLimits` 投影）。
   *
   * 有它就能在**发送前**拦住超限的图并说明原因；没有就只能等服务端拒绝。
   */
  imageLimits?: {
    maxImagesPerMessage?: number;
    maxImageBytes?: number;
    maxMessageImageBytes?: number;
  };
  /**
   * 全日志会话统计（`sessionStats` 投影）：轮次/步骤计数与 LLM / 工具 / 首 token /
   * 解码墙钟时间合计。分页与压缩不改变这些数字。
   */
  sessionStats?: {
    turns: number;
    steps: number;
    llmMs: number;
    toolMs: number;
    /** 已记录首 token 的步上的首 token 时延合计。 */
    ttftMs: number;
    /** 记录过首 token 的步数（ttftMs 的分母）。 */
    ttftSteps: number;
    /** 同时报告了输出 token 的步上的解码墙钟合计。 */
    decodeMs: number;
    /** 同一批步的 provider 输出 token 合计。 */
    decodeTokens: number;
  };
}
