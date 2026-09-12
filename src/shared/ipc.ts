import type { Attachment, ChatState, MessageView, ModelSelectionView, ProviderGroupView, Segment, SessionSummaryView, TodoView } from "./chat";
import type {
  CommandView,
  FileRefView,
  JobItemView,
  SettingsSectionView,
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
  /** 删除一条消息（回退/重放时使用）。 */
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
  | { type: "files/list"; query: string; items: FileRefView[] }
  /** 设置各命名空间（设置面板）。 */
  | { type: "settings/describe"; sections: SettingsSectionView[]; writable: boolean }
  /** 指定子代理的会话内容（复用 message 帧之外的单帧快照）。 */
  | { type: "subagent/transcript"; id: string; messages: MessageView[] }
  /** 一次性提示。 */
  | { type: "toast"; level: "info" | "warn" | "error"; text: string }
  /**
   * 把一段文本插到输入框的**光标处**（不是替换整个草稿）。
   *
   * 用途：最后兜底——选了读不出来的文件、或模型不收图片时，把
   * `"C:\path"` 这样带引号的路径放进用户正在写的话里，而不是塞成附件芯片。
   * （目录不走这里：目录是 `@dir/` 引用芯片。）
   */
  | { type: "ui/insertText"; text: string }
  /** 让界面打开某个右侧抽屉（命令面板入口用，如「DSH: 历史对话」）。 */
  | { type: "ui/openPanel"; panel: string };

export type WebviewToHost =
  /** webview 加载完成，请求首帧状态。 */
  | { type: "ready" }
  /** 发送一条消息。 */
  | { type: "send"; text: string; attachments: Attachment[] }
  /** 停止当前生成。 */
  | { type: "stop" }
  /** 取消一条排队中（尚未发送）的消息。 */
  | { type: "queueRemove"; id: string }
  /** 把一条排队中（尚未发送）的消息取回输入框重新编辑。 */
  | { type: "queueEdit"; id: string }
  /** 新建会话。 */
  | { type: "newSession" }
  /** 切换到某个会话。 */
  | { type: "openSession"; sessionId: string }
  /** 请求会话列表。 */
  | { type: "listSessions" }
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
  /** 选择文件 / 文件夹加入上下文（图片按图片发送，其余文件上传，目录做引用）。 */
  | { type: "addFiles" }
  /** @ 提及选中的文件 / 目录，作为 `@path` / `@dir/` 参考芯片加入（不上传）。 */
  | { type: "addMention"; path: string; kind: "file" | "directory" }
  /**
   * 把一个**目录**作为 `@dir/` 引用加入（不是下钻打开）。
   *
   * 用户口径：`@` 列表里选中目录默认是**打开该目录**（继续下钻），
   * 只有点右侧的「整个目录」才是把目录本身载入。
   */
  | { type: "addFolderReference"; path: string }
  /** 重传一个上传失败的文件附件。 */
  | { type: "retryUpload"; id: string }
  /** 直接执行一条命令（命令面板里点的，不是手打的正文）。 */
  | { type: "runCommandLine"; line: string }
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
   * （SCM 的「打开更改」），否则——未跟踪文件、文件没改过、根本不是 git 仓库——
   * 回落成普通打开（判定见 `dsh/fileChange.ts`）。
   */
  | { type: "openFile"; path: string; diff?: boolean }
  /** 在编辑器区打开一个独立的聊天面板。 */
  | { type: "openInEditor" }
  /** 把代码块内容插入当前编辑器。 */
  | { type: "insertText"; text: string }
  /** 复制到剪贴板（webview 里 navigator.clipboard 受限，交给宿主）。 */
  | { type: "copy"; text: string }
  | { type: "showLogs" }
  | { type: "restartServer" }
  /** 输入 / 替换外部服务器的访问令牌（服务端要求授权时使用）。 */
  | { type: "setToken" }
  | { type: "openSettings" }
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
  /** 请求设置内容。 */
  | { type: "describeSettings" }
  /** 写入一个设置字段。 */
  | { type: "saveSetting"; ns: string; path: string[]; value: unknown; expectedRevision: number }
  /** 重置整个命名空间（清除用户层覆盖）。 */
  | { type: "resetSettings"; ns: string }
  /** 写入密钥字段（走 credentials/set，ref 为环境变量名）。 */
  | { type: "saveSecret"; ns: string; path: string[]; value: string; ref?: string }
  /** 打开原生设置（VS Code 侧配置）。 */
  | { type: "openVscodeSettings" };
