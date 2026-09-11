/**
 * 视图模型：宿主与 webview 共用的聊天状态形状。
 *
 * 这一层刻意与 DSH 线协议解耦：宿主里的协议适配器（src/dsh/*）负责把
 * session/* 事件流翻译成这里的结构，webview 只认这套结构渲染。
 * 好处是界面代码不随服务端协议变动，协议变更只影响适配器。
 */

export type ConnectionState = "connecting" | "ready" | "error";

/**
 * 附件种类。
 *
 * 没有 `folder`：目录的内容无法内嵌，按「不能内嵌」处理——其带引号的路径直接
 * 插进输入框，而不是变成一个芯片（见 `dsh/attachments.classifyPath`）。
 */
export type AttachmentKind = "file" | "image" | "selection" | "context";

export interface Attachment {
  id: string;
  kind: AttachmentKind;
  /** 文件/目录的绝对路径（图片与选区没有）。 */
  path?: string;
  /** 展示名：优先相对工作区的路径。 */
  name: string;
  /** 随消息发送的文本内容（选区、文件正文）。 */
  text?: string;
  /** 图片的 data URL。 */
  dataUrl?: string;
  /** 图片字节数。 */
  bytes?: number;
}

export type ToolStatus = "pending" | "running" | "ok" | "error";

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

export interface ApprovalView {
  requestId: string;
  toolName: string;
  reason?: string;
  /** 待执行的参数预览（命令行/文件路径等）。 */
  detail?: string;
  state: "waiting" | "approved" | "rejected" | "expired";
  /** 是否允许「始终允许」。 */
  allowAlways?: boolean;
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

export interface QuestionView {
  requestId: string;
  items: QuestionItemView[];
  state: "waiting" | "answered";
  /** 已回答的选项，按问题 id 归档。 */
  answers?: Record<string, string[]>;
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
}

export type Segment =
  | { kind: "text"; id: string; text: string; streaming?: boolean }
  | { kind: "thinking"; id: string; text: string; streaming?: boolean; durationMs?: number; open?: boolean }
  | { kind: "tool"; id: string; tool: ToolCallView }
  | { kind: "approval"; id: string; approval: ApprovalView }
  | { kind: "question"; id: string; question: QuestionView }
  | { kind: "injected"; id: string; injected: InjectedView }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

export interface UsageView {
  inputTokens?: number;
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
  model?: string;
  /** 本 step 的用量：只用于上下文占用条与输出速度（tok/s），不再单独成行展示。 */
  usage?: UsageView;
  deliverables?: DeliverableView[];
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

export interface GoalView {
  objective: string;
  phase: string;
  rounds: number;
  maxRounds?: number;
}

export interface SubagentView {
  id: string;
  label: string;
  activity: "running" | "inactive";
}

export interface JobItemView {
  id: string;
  kind: string;
  label: string;
  status: "running" | "stopping" | "completed" | "killed" | "failed";
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
}

/** 文件引用候选（fileReferences/list）。 */
export interface FileRefView {
  path: string;
  kind: "file" | "directory";
}

/** 设置页的一个字段（由 schema 推导）。 */
export interface SettingsFieldView {
  /** 字段路径，写回时作为 settings/mutate 的 path。 */
  path: string[];
  label: string;
  type: "string" | "number" | "boolean" | "enum" | "json";
  value: unknown;
  defaultValue?: unknown;
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  /** 是否属于密钥字段（写入走 credentials/set 而非 settings）。 */
  secret?: boolean;
  /**
   * 密钥写入用的引用名（POSIX 环境变量名，如 `DEEPSEEK_API_KEY`）。
   * 取自同一对象里 `role: credential-ref` 的兄弟字段的值——服务端的凭据
   * 引用空间是「环境变量名」，不是设置路径。
   */
  secretRef?: string;
  secretSet?: boolean;
  /** 该字段被用户层覆盖过（user 里出现过）。 */
  overridden?: boolean;
}

export interface SettingsSectionView {
  ns: string;
  applies: "live" | "restart";
  revision: number;
  fields: SettingsFieldView[];
  /** 表单无法表达的复杂结构（对象数组等），退化为 JSON 文本编辑。 */
  jsonFields: { path: string[]; label: string; value: unknown }[];
  writable: boolean;
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
