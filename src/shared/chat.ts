/**
 * 视图模型：宿主与 webview 共用的聊天状态形状。
 *
 * 这一层刻意与 DSH 线协议解耦：宿主里的协议适配器（src/dsh/*）负责把
 * session/* 事件流翻译成这里的结构，webview 只认这套结构渲染。
 * 好处是界面代码不随服务端协议变动，协议变更只影响适配器。
 */

export type ConnectionState = "connecting" | "ready" | "error";

export type AttachmentKind = "file" | "folder" | "image" | "selection" | "context";

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
  /** 次要说明（路径、命令摘要）。 */
  detail?: string;
  status: ToolStatus;
  /** 参数（已格式化的文本，惰性渲染）。 */
  input?: string;
  /** 结果文本。 */
  output?: string;
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

export type Segment =
  | { kind: "text"; id: string; text: string; streaming?: boolean }
  | { kind: "thinking"; id: string; text: string; streaming?: boolean; durationMs?: number; open?: boolean }
  | { kind: "tool"; id: string; tool: ToolCallView }
  | { kind: "approval"; id: string; approval: ApprovalView }
  | { kind: "question"; id: string; question: QuestionView }
  | { kind: "notice"; id: string; level: "info" | "warn" | "error"; text: string };

export interface UsageView {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  /** 上下文窗口上限（用于上下文占用条）。 */
  contextWindow?: number;
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
  usage?: UsageView;
  durationMs?: number;
  firstTokenMs?: number;
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

export interface ChatState {
  connection: ConnectionState;
  /** 连接失败/服务器异常时的说明文本。 */
  connectionDetail?: string;
  serverUrl?: string;
  /** VS Code 的显示语言标识（如 zh-cn、en），界面据此选中英文案。 */
  locale?: string;
  session?: SessionSummaryView;
  messages: MessageView[];
  /** 当前会话是否正在生成。 */
  running: boolean;
  /** 是否在折叠行里显示 token 用量与耗时（对应 dshChat.showUsageStats）。 */
  showUsageStats?: boolean;
  /** 排队中的消息数。 */
  queue: number;
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
  /** 最近的错误提示（一次性，展示后清除）。 */
  error?: string;
}
