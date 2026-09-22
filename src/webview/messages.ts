/**
 * **宿主 → 界面文案的唯一一份消息表**（`@key` 标记的登记处）。
 *
 * 从前后加一条用户可见文案要改 7 处（`Texts` 接口、zh 字典、en 字典、`resolveText`
 * 的 `switch`、`scripts/i18n.test.ts` 的标记清单、`hostText.ts` 的 `switch`、
 * `l10n/bundle.l10n.zh-cn.json`）。现在**登记只有这一张表**：
 * - 两份界面词典由表派生（`texts.ts`）；
 * - `resolveText()` 退化成「查表 + 按冒号拆参数」，不再有那台会静默坏掉的长 `switch`
 *   （重复 `case` = 后者不可达，工具链不报）；
 * - 标记清单由表的键派生（`i18n.test.ts`），双向断言照旧；
 * - 会外溢到 VS Code 原生通知的条目加 `vscode: true`（可选 `l10n:` 给位置占位符），
 *   `hostText.ts` 与 l10n bundle 按这套清单对齐，配套断言在 `i18n.test.ts` 第 6 节。
 *
 * 加一条的纪律：**带参数的登记成函数、不带参数的登记成字符串**（于是「裸字符串被
 * 当函数调用」由 `tsc` 拦住）；`zh` / `en` 缺一不可。
 *
 * 一条标记在表里的取值 = 中英各一份文案 + 若干**结构声明**（`vscode` / `argParts` /
 * `swapArgs` / `l10n`）——后者描述这条标记怎么被解析、怎么外溢到 VS Code，不是文案。
 */
export type LocalizedMessage = {
  zh: string | ((...args: never[]) => string);
  en: string | ((...args: never[]) => string);
  vscode?: boolean;
  /**
   * 标记里 `@key:` 之后那一段**怎么分给函数的形参**（只对带参数的登记有意义）。
   *
   * 缺省是整段给第一个形参（`@key:arg` 的常规形态，参数里的冒号不截断）。
   * 写 `2` 表示「按第一段冒号对半切」——只有那几条历史口径如此：
   * `llmRetry` 的「第几次:共几次」、`uploadIncomplete` 的「个数:文件名预览」、
   * `imagePathsInserted` 的「张数:模型名」。
   */
  argParts?: number;
  /**
   * 切出来的两段是否要**对调**再喂给函数形参。
   *
   * 只有 `uploadIncomplete` 需要：标记里的顺序是「个数:文件名预览」，
   * 而词典函数的形参顺序是 `(names, count)`（从前那个 `switch` 里就是这么对调的）。
   */
  swapArgs?: boolean;
  /**
   * 外溢到 **VS Code 原生通知**时的英文源串（`vscode.l10n.t` 的 key）。
   *
   * 只在两种写法不同时才需要：
   * - 界面用 `fill()` 的**具名**占位符（`启动 dsh 进程失败：{detail}`），
   *   而 `vscode.l10n` 的参数是**位置**占位符（`Could not start the dsh process: {0}`）；
   * - 不写这一项时默认取 `en`（要求 `en` 是纯字符串）。
   */
  l10n?: string;
};

/**
 * 消息表按**契约视角**取用：读 `vscode` / `argParts` 这类可选元数据时用它。
 *
 * 表本身是 `satisfies Record<string, LocalizedMessage>`（保住每条的字面量类型，
 * 于是 `MESSAGES.queued.en` 之类的取值仍是具体字符串），而 `satisfies` 只会校验
 * 形状、不会给每条补上可选字段——所以读元数据要换这个视角。函数里带一道运行时
 * 核对：中英两份都得在，缺了直接抛。
 */
export function asMessageTable(table: unknown): MessageTable {
  for (const [key, value] of Object.entries(table as Record<string, LocalizedMessage>)) {
    if (typeof value !== "object" || value === null || !("zh" in value) || !("en" in value)) {
      throw new Error(`消息表条目 ${key} 缺少 zh / en`);
    }
  }
  return table as MessageTable;
}

/**
 * 消息表的**形状契约**：键是标记名，值是 `LocalizedMessage`。
 */
export type MessageTable = Record<Marker, LocalizedMessage>;

/**
 * **唯一一份消息表**：以标记为键，每条自带中英两份。
 *
 * 加一条用户可见的 `@key` 文案，只在这里加一条：
 * - `zh` / `en` 必填（不写 TS 直接报错）；
 * - 带参数的登记成函数、不带参数的登记成字符串——于是「裸字符串被当函数调用」
 *   由 `tsc` 拦住（从前那 4 处机械复制拦不住）；
 * - 可能外溢到 VS Code 原生通知的加 `vscode: true`（见 `LocalizedMessage`）。
 *
 * 两份字典（`Texts`）与 `resolveText()` 都由这张表派生，见 `texts.ts`。
 */
export const MESSAGES = {
  newChat: { zh: "新建对话", en: "New chat" },
  history: { zh: "历史对话", en: "Chat history" },
  openInEditor: { zh: "在编辑器中打开", en: "Open in editor" },
  openInBrowser: { zh: "在浏览器中打开 DSH Web", en: "Open DSH Web in browser" },
  openInBrowserOffline: {
    zh: "还没有连上 DSH 服务器，暂时无法在浏览器中打开。",
    en: "Not connected to a DSH server yet, so it cannot be opened in the browser.",
  },
  openInBrowserFailed: {
    zh: "系统没有打开浏览器，可以手动访问 dsh web 打印的地址。",
    en: "The browser was not opened; you can visit the URL printed by dsh web manually.",
  },

  // 空态提示同时是**能力公告**：粘贴这条路没有任何按钮可点，不在这里说一句，
  // 用户不会知道它存在（`usePagePaste` 是窗口级监听）
  emptyHint: {
    zh: "用 @ 添加文件或选区作为上下文；也可以直接粘贴图片、文件或目录；Shift+Enter 换行。",
    en: "Use @ to attach files or a selection, or paste an image, file or folder directly. Shift+Enter for a new line.",
  },

  // 空态页的两行元信息（新会话落在哪个目录、用哪套 agent 组装）
  workspaceChange: { zh: "更改工作目录", en: "Change working directory" },
  workspaceChoose: { zh: "选择工作目录", en: "Choose a working directory" },
  /**
   * 没有打开文件夹、也还没选目录时的占位。
   *
   * 绝不拿宿主的 cwd（= VS Code 的安装路径）冒充工作目录（用户 2026-09-22 口径）：
   * 没选就是没选，会话会一直在「未分组」里，直到用户挑一个目录（发第一条消息时也会
   * 问一次，见 `controller.ensureSession`）。
   */
  workspaceNone: { zh: "未选择工作区", en: "No workspace selected" },
  workspaceLocked: {
    zh: "工作目录跟随 VS Code 打开的文件夹",
    en: "Working directory follows the folder open in VS Code",
  },
  agentPresetLabel: { zh: "Agent 预设", en: "Agent preset" },
  agentPresetSeat: {
    zh: "即将开始的这个会话所用的 Agent 预设",
    en: "Agent preset for the session you are about to start",
  },
  /** 工具栏上那枚只读预设标签的 title：会话已经开始，预设只剩「它叫什么」可读。 */
  agentPresetRunning: {
    zh: (name: string) => `本次会话使用的 Agent 预设：${name}`,
    en: (name: string) => `Agent preset used by this session: ${name}`,
  },
  agentPresetNoDescription: { zh: "暂无描述", en: "No description" },
  /**
   * 随产品交付的四个 agent 预设的展示名与描述。
   *
   * **逐字抄官方**（`dsh-client-ui-agent-preset` 的 `locales.ts`）：这几个预设的名字
   * 不由服务端发布，而是客户端按当前语言给（官方 `presetDisplayText` 只对
   * `trust === 'system'` 的已知 id 走词典），所以译文必须与官方一致——同一个部署在
   * 官方 Web UI 与本扩展里该显示同一个名字。用户自己写的预设名不翻译。
   */
  presetStandardName: { zh: "标准模式", en: "Standard mode" },
  presetStandardDescription: {
    zh: "功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。",
    en: "Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.",
  },
  presetPtcName: { zh: "PTC 模式", en: "PTC mode" },
  presetPtcDescription: {
    zh: "功能完整的编码 Agent，但默认不提供 workflow 工具；其他工具通过 PTC 模式 SDK 呈现，让模型用一个 TypeScript 程序组合多步操作。",
    en: "Full coding agent without the workflow tool; other tools are exposed through the PTC mode SDK so the model can combine multi-step operations in one TypeScript program.",
  },
  presetMinimalName: { zh: "极简模式", en: "Minimal mode" },
  presetMinimalDescription: {
    zh: "仅提供持久 shell 的单工具编码 Agent。",
    en: "Single-tool coding agent with a persistent shell.",
  },
  presetCordisName: { zh: "创造模式", en: "Creator mode" },
  presetCordisDescription: {
    zh: "用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、持久化插件管理和 preset 创作指导。",
    en: "Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, persistent plugin management, and preset-authoring guidance.",
  },
  /** 切换预设被服务端拒绝（已开始的会话、id 不存在…）；`reason` 是服务端给的原因。 */
  agentPresetFailed: {
    zh: (reason: string) => `切换 Agent 预设失败：${reason}`,
    en: (reason: string) => `Could not switch the agent preset: ${reason}`,
  },

  placeholderFirst: { zh: "发消息或创建任务，/ 调用指令，@ 文件或对话", en: "Send a message or start a task; / for commands, @ for files or chats" },
  placeholderFollowUp: { zh: "继续追问…", en: "Ask a follow-up" },
  send: { zh: "发送", en: "Send" },
  sendTitle: { zh: "发送（Enter）", en: "Send (Enter)" },
  stopTitle: { zh: "停止生成", en: "Stop generating" },
  thinkingDepth: { zh: "思考深度", en: "Thinking depth" },
  selectModel: { zh: "选择模型", en: "Select model" },
  models: { zh: "模型", en: "Models" },
  defaultModel: { zh: "默认模型", en: "Default model" },
  noModels: { zh: "未获取到模型目录", en: "No model catalog available" },
  attachFile: { zh: "添加文件", en: "Attach file" },
  attachFolder: { zh: "整个目录", en: "whole folder" },
  cancel: { zh: "取消", en: "Cancel" },
  remove: { zh: "移除", en: "Remove" },
  close: { zh: "关闭", en: "Close" },
  back: { zh: "返回", en: "Back" },

  permission: { zh: "权限", en: "Permission" },
  permReadOnly: { zh: "仅可查看", en: "Read Only" },
  permReadOnlyDesc: { zh: "只能读取，不做任何修改", en: "Can read but never modify anything" },
  permWorkspaceWrite: { zh: "工作区内修改", en: "Workspace Write" },
  permWorkspaceWriteDesc: { zh: "可在工作区内读写，越界需授权", en: "Can read and write inside the workspace; beyond it needs approval" },
  permFullAccess: { zh: "完全权限", en: "Full Access" },
  permFullAccessDesc: { zh: "不受工作区限制，含敏感操作（危险）", en: "Unrestricted, including sensitive operations (dangerous)" },
  permConfirmTitle: { zh: "确认启用完全权限？", en: "Enable full access?" },
  permConfirmBody: {
    zh: "启用后新会话将减少确认步骤，可直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。",
    en: "New sessions will skip most confirmations and may run sensitive operations, modify files or run external commands. Only use it when you trust the work that follows.",
  },
  permConfirmEnable: { zh: "启用完全权限", en: "Enable full access" },
  enterPlanMode: { zh: "进入计划模式", en: "Enter plan mode" },
  exitPlanMode: { zh: "退出计划模式", en: "Exit plan mode" },

  goalActive: { zh: "进行中的目标", en: "Ongoing Goal" },
  goalPaused: { zh: "已暂停的目标", en: "Paused Goal" },
  goalBlocked: { zh: "受阻的目标", en: "Blocked Goal" },
  goalPause: { zh: "暂停目标", en: "Pause goal" },
  goalResume: { zh: "恢复目标", en: "Resume goal" },
  goalClear: { zh: "清除目标", en: "Clear goal" },
  goalEdit: { zh: "编辑目标", en: "Edit goal" },
  goalSave: { zh: "保存", en: "Save" },
  goalCancel: { zh: "取消", en: "Cancel" },
  goalExpand: { zh: "展开目标全文", en: "Show the full goal" },
  goalCollapse: { zh: "收起目标全文", en: "Collapse the goal" },
  turnClock: {
    zh: (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes > 0
        ? `${minutes}分${String(seconds).padStart(2, "0")}秒`
        : `${seconds}秒`;
    },
    en: (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const minutes = Math.floor(total / 60);
      const seconds = total % 60;
      return minutes > 0
        ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
        : `${seconds}s`;
    },
  },
  turnRanFor: { zh: (duration: string) => `用时 ${duration}`, en: (duration: string) => `Ran for ${duration}` },
  turnProcessLabel: {
    zh: ({ toolCalls, messages, subagents }: { toolCalls: number; messages: number; subagents: number }) => {
      const parts: string[] = [];
      if (toolCalls > 0) parts.push(`${toolCalls} 次工具调用`);
      if (messages > 0) parts.push(`${messages} 条消息`);
      if (subagents > 0) parts.push(`${subagents} 个 subagent`);
      return parts.length ? parts.join(" · ") : "已思考";
    },
    en: ({ toolCalls, messages, subagents }: { toolCalls: number; messages: number; subagents: number }) => {
      const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
      const parts: string[] = [];
      if (toolCalls > 0) parts.push(plural(toolCalls, "tool call"));
      if (messages > 0) parts.push(plural(messages, "message"));
      if (subagents > 0) parts.push(plural(subagents, "subagent"));
      return parts.length ? parts.join(" · ") : "Thought for a while";
    },
  },
  turnTimeTitle: { zh: "本轮用时和速度", en: "Turn time and speed" },
  turnTimeDuration: { zh: "本轮总用时", en: "Total run time" },
  turnTimeSpeed: { zh: "输出速度（TPS）", en: "Tokens per second (TPS)" },
  turnTimeTtft: { zh: "首 token 用时（TTFT）", en: "Time to first token (TTFT)" },
  tokensPerSecond: { zh: (tps: string) => `${tps} tok/s`, en: (tps: string) => `${tps} tok/s` },
  turnLatency: {
    zh: (ms: number) => {
      const seconds = Math.max(0, ms) / 1000;
      return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}秒`;
    },
    en: (ms: number) => {
      const seconds = Math.max(0, ms) / 1000;
      return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))}s`;
    },
  },

  commandRunning: { zh: "执行中", en: "Running" },
  // 标记 `@commandFailed` 从前走的是词典里的 `commandDispatchFailed`（带参数的那条）。
  // 现在表以标记为键，所以这一条**登记的取值就是那条函数**——不是随手挑的文案。
  commandFailed: { zh: (line: string) => `命令 ${line} 没能发出去`, en: (line: string) => `Could not dispatch ${line}` },
  unknownCommand: { zh: (line: string) => `没有这条命令：${line}`, en: (line: string) => `No such command: ${line}` },
  commandDispatchFailed: { zh: (line: string) => `命令 ${line} 没能发出去`, en: (line: string) => `Could not dispatch ${line}` },
  producedLabel: { zh: "本轮文件改动", en: "Files changed" },
  presentedLabel: { zh: "交付文件", en: "Presented files" },
  // 改动文件卡片（官方 ui-deliverables 的 changed-files card）。标题里的数字是 Host
  // 报的**完整文件数**，可能大于卡片实际铺出来的行数（Host 自己有个上限）。
  changesCardTitle: {
    zh: (files: number) => `改动 ${files} 个文件`,
    en: (files: number) => `${files} file${files === 1 ? "" : "s"} changed`,
  },
  // 增删行数拆成两条：界面上 `+` 走绿色、`−` 走红色（与 diff 视图的统计同配色），
  // 拼成一整串就没法分别上色了。
  changesCardAdded: {
    zh: (added: number) => `+${added}`,
    en: (added: number) => `+${added}`,
  },
  changesCardDeleted: {
    zh: (deleted: number) => `−${deleted}`,
    en: (deleted: number) => `−${deleted}`,
  },
  changesCardBinary: { zh: "二进制", en: "binary" },
  changesCardOversized: { zh: "过大", en: "too large" },
  changesCardMore: {
    zh: (count: number) => `+ ${count} 个文件`,
    en: (count: number) => `+ ${count} more`,
  },
  changesCardExpandAria: {
    zh: (count: number) => `展开全部 ${count} 个改动文件`,
    en: (count: number) => `Show all ${count} changed files`,
  },
  changesCardCollapseAria: {
    zh: "收起改动文件列表",
    en: "Collapse the changed-file list",
  },
  producedMore: { zh: (count: number) => `+ ${count} 个文件`, en: (count: number) => `+ ${count} file${count === 1 ? "" : "s"}` },
  openChangesAria: { zh: (name: string) => `查看 ${name} 的改动`, en: (name: string) => `View changes in ${name}` },
  openChangesHint: { zh: "点击查看改动对比；按住 Alt 直接打开文件", en: "Click to view changes; hold Alt to open the file" },
  filesExpandAria: { zh: (count: number) => `展开全部 ${count} 个文件`, en: (count: number) => `Show all ${count} file${count === 1 ? "" : "s"}` },
  filesCollapse: { zh: "收起", en: "Collapse" },
  filesCollapseAria: { zh: "收起文件列表", en: "Collapse file list" },
  fileNewTag: { zh: "[新增]", en: "[new]" },
  fileDeletedHint: { zh: "文件已从磁盘删除；点击尝试查看删除前的内容", en: "This file is no longer on disk; click to try to view its content before deletion" },
  deletedFileAria: { zh: (name: string) => `已删除的文件 ${name}`, en: (name: string) => `Deleted file ${name}` },
  chipFileDeleted: { zh: "文件已删除，内容找不回来了", en: "The file was deleted; its content is no longer available" },
  chipPathUnresolved: {
    zh: "暂时拿不到会话工作目录，无法定位这个文件；稍后再点一次试试",
    en: "The session working directory is not available yet, so this file cannot be located; try again in a moment",
  },
  dropUnreadable: {
    zh: (name: string) => `${name} 读不出来，没有加进来（目录暂不支持拖放，请用「添加文件」或 @ 引用）`,
    en: (name: string) =>
      `${name} could not be read and was not attached (folders cannot be dropped; use the attach button or an @ reference)`,
  },
  dropTooLarge: {
    zh: (name: string) => `${name} 太大，拖放上限 8 MB；请改用「添加文件」`,
    en: (name: string) => `${name} is too large to drop (limit 8 MB); use the attach button instead`,
  },
  // 粘贴这条路分两截：宿主能从**系统剪贴板取到真路径**时走与「添加文件」完全同一条
  // （目录 → 路径引用、图片 → 内容块、其余 → 不限大小地上传）；取不到路径才退回字节
  // 通道（截图那类剪贴板里本来就没有文件的形态）。下面两条只在**退回字节通道**后出现，
  // 所以措辞按那个场景写：读不出来 = 剪贴板只给了空条目 / 目录条目；
  // 太大 = 字节要过内存通道，8 MB 是它的上限（文件那条路没有这个限制）。
  pasteUnreadable: {
    zh: (name: string) => `${name} 读不出来，没有加进来（目录用 @ 引用即可，那是路径）`,
    en: (name: string) =>
      `${name} could not be read and was not attached (reference a folder with @ instead — that goes in as a path)`,
  },
  pasteTooLarge: {
    zh: (name: string) => `${name} 太大（超过 8 MB），没有加进来；存成文件后用「添加文件」——那条路不限大小`,
    en: (name: string) =>
      `${name} is too large (over 8 MB) and was not attached; save it as a file and use the attach button, which has no size limit`,
  },
  imageTooLarge: {
    zh: (name: string) => `${name} 超过服务端的图片上限，已改为按文件上传`,
    en: (name: string) => `${name} is over the server's image limit and was uploaded as a file instead`,
  },
  dropHint: { zh: "松开即添加为附件", en: "Release to attach" },

  subagents: { zh: "子代理", en: "Subagents" },
  subagentsEmpty: { zh: "当前会话没有子代理", en: "This session has no subagents" },
  subagentOneShot: { zh: "一次性", en: "one-shot" },
  subagentContinuable: { zh: "可继续", en: "continuable" },
  // 目录里 `activity: 'inactive'` 的那一条（用户 2026-09-19 口径）：**已完成**，
  // 不是「未运行」。子代理一旦列在目录里就必然领过初始任务（one-shot 与
  // continuable 都是带着 prompt 建出来的），所以「现在不在跑」= 跑完了。
  subagentCompleted: { zh: "已完成", en: "completed" },
  subagentLoading: { zh: "正在读取子代理会话…", en: "Loading subagent session…" },
  subagentTranscriptEmpty: {
    zh: "这个子代理没有可显示的内容",
    en: "Nothing to show for this subagent",
  },
  trajectory: { zh: "轨迹", en: "Trajectory" },
  trajectoryEmpty: { zh: "本会话还没有工具调用", en: "No tool calls in this session yet" },
  backToChat: { zh: "返回会话", en: "Back to chat" },
  jobs: { zh: "后台任务", en: "Background jobs" },
  jobsEmpty: { zh: "当前会话没有后台任务", en: "This session has no background jobs" },
  jobRunning: { zh: "运行中", en: "running" },
  jobStopping: { zh: "正在停止", en: "stopping" },
  jobCompleted: { zh: "已完成", en: "completed" },
  jobKilled: { zh: "已取消", en: "cancelled" },
  jobUnknown: { zh: "未知状态", en: "unknown status" },
  jobFailed: { zh: "失败", en: "failed" },
  commands: { zh: "命令", en: "Commands" },
  commandsEmpty: { zh: "没有可用命令", en: "No commands available" },
  skillTag: { zh: "技能", en: "Skill" },
  uploadFailed: { zh: "上传失败，点击重试", en: "Upload failed — click to retry" },
  uploadFailedReason: { zh: (reason: string) => `${reason}\n点击重试`, en: (reason: string) => `${reason}\nClick to retry` },
  uploadIncomplete: {
    argParts: 2, // 参数形如 `<个数>:<文件名预览>`（文件名里可能含冒号）
    swapArgs: true, // 标记里个数在前，而函数形参是 (names, count)
    zh: (names: string, count: number) => `有 ${count} 个文件没能上传（${names}），本次只发送了就绪的附件`,
    en: (names: string, count: number) => `${count} file(s) could not be uploaded (${names}); only the ready attachments were sent`,
  },
  uploadNoSession: { zh: "还没有连上服务器，附件传不上去", en: "Not connected to the server yet; the attachment cannot be uploaded" },
  mentionFiles: { zh: "文件", en: "Files" },
  mentionSessions: { zh: "对话", en: "Sessions" },
  mentionEmpty: { zh: "没有匹配的文件", en: "No matching files" },
  mentionHint: { zh: "↑↓ 选择 · Enter 引用 · Tab 进入目录 · Esc 取消", en: "↑↓ select · Enter reference · Tab browse folder · Esc cancel" },
  mentionParent: { zh: "返回上一层目录", en: "Go to the parent folder" },
  mentionDrill: { zh: "进入目录", en: "Browse folder" },
  mentionDrillKey: { zh: "Tab", en: "Tab" },
  mentionNoCwd: { zh: "（无工作目录）", en: "(no cwd)" },

  running: { zh: "深度求索中", en: "Deep diving" },
  queued: { zh: "待发送 {n} 条", en: "{n} queued" },
  queueRemove: { zh: "取消这条消息", en: "Remove this message" },
  queueEdit: { zh: "取回重新编辑", en: "Take back to edit" },
  queueMediaOnly: { zh: "（附件）", en: "(attachment)" },
  runningHint: { zh: "按 ESC 可中止", en: "Press ESC to stop" },
  runningHintQueue: { zh: "按 ESC 可中止并发出排队消息", en: "Press ESC to stop and send the queued message" },

  thinking: { zh: "思考", en: "Thinking" },
  diffTruncated: { zh: "… 内容过长，已截断", en: "… truncated" },

  injectedSystemPrompt: { zh: "系统提示词", en: "System prompt" },
  injectedRuntimeContext: { zh: "运行时上下文", en: "Runtime context" },
  injectedAgentInstructions: { zh: "项目指令", en: "Workspace instructions" },
  injectedSkillCatalog: { zh: "技能目录", en: "Skill catalog" },
  injectedContext: { zh: "上下文注入", en: "Context injection" },
  injectedRecall: { zh: "跨会话召回", en: "Session recall" },
  injectedChars: { zh: (chars: string) => `${chars} 字符`, en: (chars: string) => `${chars} chars` },

  approvalTitle: { zh: "需要你的许可", en: "Permission required" },
  approvalApproved: { zh: "已允许", en: "Allowed" },
  approvalRejected: { zh: "已拒绝", en: "Rejected" },
  approvalExpired: { zh: "已失效", en: "Expired" },
  allow: { zh: "允许", en: "Allow" },
  allowAlways: { zh: "始终允许", en: "Always allow" },
  reject: { zh: "拒绝", en: "Reject" },
  callId: { zh: (id: string) => `调用标识：${id}`, en: (id: string) => `Call ID: ${id}` },
  questionHead: { zh: "问题", en: "Question" },
  questionPlaceholder: { zh: "或直接输入回答…", en: "Or type your own answer…" },
  submit: { zh: "提交", en: "Submit" },
  questionStep: { zh: (index: number, total: number) => `第 ${index} / ${total} 题`, en: (index: number, total: number) => `Question ${index} of ${total}` },
  questionPrev: { zh: "上一题", en: "Previous" },
  questionNext: { zh: "下一题", en: "Next" },
  questionAnswered: {
    zh: (count: number) => `已作答 ${count} 题`,
    en: (count: number) => (count === 1 ? "1 question answered" : `${count} questions answered`),
  },
  questionCancelled: {
    zh: (count: number) => `已取消 ${count} 题`,
    en: (count: number) => (count === 1 ? "1 question withdrawn" : `${count} questions withdrawn`),
  },
  questionCustomTitle: { zh: "自定义回答", en: "Custom answer" },
  questionCustomAria: { zh: "自定义回答（选中后其它选项会被取消）", en: "Custom answer (selecting it clears the other options)" },
  // 官方 `nav.cancel` 逐字：关掉整份还没答的问卷（官方 `QuestionComposer` 头部的 ✕），
  // 不是「跳过某道题」——服务端收到的是 `ASK_CANCELLED` 拒绝，等待方据此收场
  questionDismissAll: { zh: "放弃整组问题", en: "Dismiss all questions" },
  planReviewHeader: { zh: "计划待审", en: "Plan review" },
  planReviewApprove: { zh: "确认执行", en: "Approve" },
  planReviewDecline: { zh: "拒绝", en: "Refuse" },
  planReviewDiscuss: { zh: "去聊天里说", en: "Chat about it" },

  copy: { zh: "复制", en: "Copy" },
  copied: { zh: "已复制到剪贴板", en: "Copied to clipboard" },
  insertToEditor: { zh: "插入到当前编辑器", en: "Insert into the active editor" },
  stopped: { zh: "已停止", en: "Stopped" },

  connecting: { zh: "正在连接…", en: "Connecting…" },
  connectionFailed: { zh: "无法连接 DSH 服务器", en: "Cannot reach the DSH server" },
  startInternal: { zh: "启动内部 DSH", en: "Start internal DSH" },
  connectInternal: { zh: "连接内部 DSH", en: "Connect to internal DSH" },
  connectExternal: { zh: "连接外部 DSH", en: "Connect to external DSH" },
  restartInternal: { zh: "重启内部 DSH", en: "Restart internal DSH" },
  externalDisabledHint: { zh: "未配置 dshChat.url，没有可连的外部 DSH", en: "dshChat.url is not set, so there is no external DSH to connect to" },
  startingInternal: { zh: "正在启动内部 DSH…", en: "Starting the internal DSH…" },
  connectingInternal: { zh: "正在连接内部 DSH…", en: "Connecting to the internal DSH…" },
  connectingExternal: {
    zh: (baseUrl: string) => `正在连接外部 DSH（${baseUrl}）…`,
    en: (baseUrl: string) => `Connecting to the external DSH (${baseUrl})…`,
  },
  stopReconnect: { zh: "停止连接", en: "Stop connecting" },
  showLogs: { zh: "查看日志", en: "Show logs" },
  statusInternalRunning: { zh: "内部 DSH：运行中", en: "Internal DSH: running" },
  statusInternalNotRunning: { zh: "内部 DSH：未运行", en: "Internal DSH: not running" },
  statusExternalReachable: { zh: "外部 DSH：可达", en: "External DSH: reachable" },
  statusExternalUnreachable: { zh: "外部 DSH：不可达", en: "External DSH: unreachable" },
  statusExternalUnconfigured: { zh: "外部 DSH：未配置", en: "External DSH: not configured" },
  statusSeparator: { zh: " · ", en: " · " },
  enterToken: { zh: "输入令牌", en: "Enter token" },
  authNeedsToken: {
    // vscode: 同一条也会经 reportError 进 VS Code 原生通知（下列英文即 l10n 的 key）
    vscode: true,
    zh: "外部 DSH 服务器需要访问令牌：请点「输入令牌」填入 dsh web 启动时打印的 token（或命令面板「DSH: 输入访问令牌」）。",
    en: "The external DSH server requires an access token: click “Enter token” and paste the token printed by dsh web (or run “DSH: Enter Access Token” from the Command Palette).",
  },
  authTokenRejected: {
    vscode: true,
    zh: "服务器要求授权，且自动获取的令牌未被接受。请用命令面板「DSH: 重启内部 DSH」重启它。",
    en: "The server requires authentication and the token obtained automatically was rejected. Restart it with “DSH: Restart Internal DSH” from the Command Palette.",
  },
  connectionLost: { zh: "与服务器的连接已断开，正在重连…", en: "Lost the connection to the server; reconnecting…" },
  serverSpawnFailed: {
    vscode: true,
    // 界面用 `fill()` 的具名占位符，VS Code 的 l10n 用位置占位符 `{0}`
    l10n: "Could not start the dsh process: {0}",
    zh: (detail: string) => `启动 dsh 进程失败：${detail}`,
    en: (detail: string) => `Could not start the dsh process: ${detail}`,
  },
  serverNotReady: {
    vscode: true,
    zh: "后台没有就绪（会合文件里还没有地址或令牌）。可点「重启内部 DSH」重试，或用「查看日志」看原因。",
    en: "The background server did not become ready (the rendezvous file has no address or token yet). Try “Restart Internal DSH”, or check the logs.",
  },
  serverUnreachable: {
    vscode: true,
    l10n: "Cannot reach the DSH server at {0} yet (retrying until it answers or you stop connecting). Make sure dsh web is running there.",
    zh: (baseUrl: string) => `连不上 ${baseUrl}（会一直重试，可点「停止连接」）。请确认该地址上运行着 dsh web。`,
    en: (baseUrl: string) =>
      `Cannot reach the DSH server at ${baseUrl} yet (retrying until it answers or you stop connecting). Make sure dsh web is running there.`,
  },
  serverLogTail: {
    vscode: true,
    l10n: "Log tail:\n{0}",
    zh: (tail: string) => `日志尾部：\n${tail}`,
    en: (tail: string) => `Log tail:\n${tail}`,
  },
  sharedRestarted: { zh: "共享后台已由本窗口接管并重启，其它窗口会自动重新接入。", en: "This window took over the shared server and restarted it; the other windows reconnect automatically." },

  searchSessions: { zh: "搜索历史对话", en: "Search past sessions" },
  today: { zh: "今天", en: "Today" },
  earlier: { zh: "更早", en: "Earlier" },
  noSessions: { zh: "还没有历史对话", en: "No past sessions yet" },
  untitled: { zh: "未命名对话", en: "Untitled chat" },
  runningTag: { zh: "运行中", en: "running" },
  forkedTitle: { zh: (title: string) => `分支: ${title}`, en: (title: string) => `Fork: ${title}` },
  archive: { zh: "归档（从工作区列表移出）", en: "Archive (move out of workspace list)" },
  archiveList: { zh: "归档列表", en: "Archived sessions" },
  deleteSession: { zh: "删除（删除本地日志文件）", en: "Delete (remove local log files)" },
  deleteSessionConfirm: { zh: "再次点击确认删除", en: "Click again to confirm" },
  noArchivedSessions: { zh: "暂无归档会话", en: "No archived sessions" },

  contextUsed: {
    zh: (percent: number, used: string, total: string) => `上下文已用 ${percent}%（${used} / ${total}）`,
    en: (percent: number, used: string, total: string) => `Context used ${percent}% (${used} / ${total})`,
  },
  ctxDetailCached: { zh: "缓存命中", en: "Cache hit" },
  ctxDetailSystem: { zh: "系统提示词", en: "System prompt" },
  ctxDetailTools: { zh: "工具定义", en: "Tool definitions" },
  ctxDetailMessages: { zh: "对话消息", en: "Conversation messages" },
  statsLlmTime: { zh: "模型用时", en: "LLM time" },
  statsToolTime: { zh: "工具调用用时", en: "Tool time" },
  statsTtft: { zh: "首 token 平均（TTFT）", en: "Avg time to first token (TTFT)" },
  statsSpeed: { zh: "平均输出速度（TPS）", en: "Average tokens per second (TPS)" },
  statsTitle: { zh: "会话统计（全日志累计）", en: "Session stats (whole log)" },
  markdownFootnotes: { zh: "脚注", en: "Footnotes" },
  turnFailed: { zh: "本轮执行失败", en: "This turn failed" },
  interrupted: { zh: "本轮被中断", en: "This turn was interrupted" },
  compacted: { zh: "上下文已压缩", en: "Context compacted" },
  llmRetry: {
    argParts: 2, // 参数形如 `<第几次>:<共几次>`（两段都是数字，转换见 texts.ts 的 NUMERIC_ARG）
    zh: (attempt: number, max: number) => `模型调用失败，正在重试（第 ${attempt} / ${max} 次）`,
    en: (attempt: number, max: number) => `The model call failed; retrying (attempt ${attempt} of ${max})`,
  },
  llmRetryAlways: {
    zh: (attempt: number) => `模型调用失败，正在重试（第 ${attempt} 次）`,
    en: (attempt: number) => `The model call failed; retrying (attempt ${attempt})`,
  },
  imagePathsInserted: {
    argParts: 2, // 参数形如 `<张数>:<模型名>`（模型名里可能含冒号）
    zh: (count: number, model: string) => `模型「${model}」不支持图片输入，已把 ${count} 个路径插入输入框`,
    en: (count: number, model: string) => `Model "${model}" does not accept image input; inserted ${count} path(s) into the box`,
  },  queueAttachmentsLost: { zh: "这条消息的附件无法还原，请重新添加（正文已放回输入框）", en: "Attachments could not be restored; please re-attach them (text is back in the box)" },
  queueContentLost: { zh: "排队消息的内容无法还原，已只中止当前轮", en: "Could not restore the queued message; only the current turn was stopped" },
  queueDispatchFailed: { zh: "排队消息没能自动发出，内容已放回输入框", en: "The queued message could not be sent; its content is back in the box" },
  unknownEvent: {
    zh: (type: string) => `遇到了本客户端不认识的事件「${type}」，已跳过其内容。`,
    en: (type: string) => `Skipped an event this client does not understand: "${type}".`,
  },
  toolRead: { zh: "读取", en: "Read" },
  toolWrite: { zh: "写入", en: "Write" },
  toolEdit: { zh: "编辑", en: "Edit" },
  toolRun: { zh: "运行", en: "Run" },
  toolSearch: { zh: "搜索", en: "Search" },
  toolPwsh: { zh: "Pwsh", en: "Pwsh" },
  toolReadImage: { zh: "读取图片", en: "Read image" },
  toolInspect: { zh: "查看插件", en: "Inspect plugin" },
  toolRunCordis: { zh: "运行插件", en: "Run plugin" },
  toolStopCordis: { zh: "停止插件", en: "Stop plugin" },
  toolRemoveCordis: { zh: "移除插件", en: "Remove plugin" },
  toolGeneric: { zh: "工具调用", en: "Tool call" },
  toolCode: { zh: "代码", en: "Code" },
  toolExitCode: { zh: (code: number) => `退出码 ${code}`, en: (code: number) => `exit code ${code}` },
  toolSignal: { zh: (signal: string) => `被信号 ${signal} 终止`, en: (signal: string) => `killed by signal ${signal}` },
  toolImageAlt: { zh: "工具返回的图片", en: "Image returned by the tool" },
  messageImageAlt: { zh: "消息里的图片", en: "Image in the message" },
  imagePreview: { zh: "查看原图", en: "View original" },
  imagePreviewClose: { zh: "关闭原图预览", en: "Close original image preview" },
  imageLoadFailed: { zh: "图片加载失败", en: "Image failed to load" },
  toolInput: { zh: "输入", en: "IN" },
  toolOutput: { zh: "输出", en: "OUT" },
  unknownBlock: { zh: "未知内容块", en: "Unknown content block" },
  contextInstructions: { zh: "上下文指令", en: "Context instructions" },
  contextAdded: { zh: "已新增", en: "Added" },
  contextUpdated: { zh: "已更新", en: "Updated" },
  contextRemoved: { zh: "已移除", en: "Removed" },
  contextCatalogReplaced: { zh: "替换目录", en: "Catalog replaced" },
  contextCatalogMore: { zh: (count: number) => `…还有 ${count} 条`, en: (count: number) => `…and ${count} more` },
  contextSnapshotSupersedes: { zh: "取代先前的快照", en: "Supersedes the previous snapshot" },
  contextRelayFrom: { zh: (session: string) => `来自会话 ${session}`, en: (session: string) => `From session ${session}` },
  contextRecallCounts: {
    zh: (retained: number, omitted: number) => `保留 ${retained} 条 · 省略 ${omitted} 条`,
    en: (retained: number, omitted: number) => `${retained} kept · ${omitted} omitted`,
  },
  contextRecallTruncated: { zh: "已截断", en: "Truncated" },
  toolCollapse: { zh: "收起", en: "Collapse" },
  readWindow: { zh: (shown: number, total: number) => `显示 ${shown} / ${total} 行`, en: (shown: number, total: number) => `Showing ${shown} of ${total} lines` },
  readExpandRest: { zh: (count: number) => `… 其余 ${count} 行`, en: (count: number) => `… ${count} more lines` },
  readExpandAria: { zh: (count: number) => `展开其余 ${count} 行`, en: (count: number) => `Expand ${count} more lines` },
  readCollapseAria: { zh: "收起内容", en: "Collapse content" },
  searchPaths: { zh: (shown: number) => `${shown} 个路径`, en: (shown: number) => `${shown} paths` },
  searchPathsTruncated: { zh: (shown: number, total: number) => `显示 ${shown} / 共 ${total} 个路径`, en: (shown: number, total: number) => `Showing ${shown} of ${total} paths` },
  searchMatches: { zh: (shown: number, files: number) => `${shown} 处匹配 · ${files} 个文件`, en: (shown: number, files: number) => `${shown} matches · ${files} files` },
  searchMatchesTruncated: {
    zh: (shown: number, total: number, files: number) => `显示 ${shown} / 共 ${total} 处匹配 · ${files} 个文件`,
    en: (shown: number, total: number, files: number) => `Showing ${shown} of ${total} matches · ${files} files`,
  },
  searchNoResults: { zh: "无结果", en: "No results" },
  searchExpandAria: { zh: (count: number) => `展开其余 ${count} 行结果`, en: (count: number) => `Expand ${count} more result lines` },
  searchCollapseAria: { zh: "收起结果", en: "Collapse results" },
  searchExpandRest: { zh: (count: number) => `… 其余 ${count} 行`, en: (count: number) => `… ${count} more lines` },
  webNoResults: { zh: "未找到结果", en: "No results found" },
  webSourcesTruncated: { zh: "来源列表已截断", en: "Source list truncated" },
  webHttp: { zh: "HTTP", en: "HTTP" },
  webContentTruncated: { zh: "内容已截断", en: "Content truncated" },
  terminalRunning: { zh: "运行中", en: "Running" },
  terminalDone: { zh: "已完成", en: "Done" },
  terminalFailed: { zh: "失败", en: "Failed" },
  terminalNoOutput: { zh: "无输出", en: "No output" },
  toolTodoTitle: { zh: "更新任务清单", en: "Update to-do list" },
  toolTodoProgress: { zh: (done: number, total: number) => `${done}/${total} 已完成`, en: (done: number, total: number) => `${done}/${total} completed` },
  maxTokens: {
    zh: "已达到输出 token 上限，回答被截断。发送「继续」可接着写。",
    en: "Output token limit reached; the answer was truncated. Send “continue” to resume.",
  },

  branchFromHere: { zh: "从这里分支", en: "Branch from here" },
  branchFailed: { zh: "创建分支失败", en: "Could not create the branch" },
  branchCreated: { zh: (title: string) => `已创建分支：${title}`, en: (title: string) => `Branch created: ${title}` },
  branchNoAnchor: { zh: "这条消息还取不到分支锚点（本轮尚未收尾），暂时不能分支", en: "No branch anchor for this message yet (the turn has not finished)" },
  branchRunning: { zh: "生成中不能分支", en: "Cannot branch while generating" },
  historyMore: { zh: "加载更早的历史", en: "Load earlier history" },
  historyLoading: { zh: "正在加载更早的历史…", en: "Loading earlier history…" },
  jumpToLatest: { zh: "回到最新", en: "Jump to latest" },
  turnRailLabel: { zh: "轮次导航", en: "Turn navigation" },
  turnRailJump: { zh: (turn: number) => `跳到第 ${turn} 轮`, en: (turn: number) => `Jump to turn ${turn}` },
  turnRailJumpLoad: { zh: (turn: number) => `加载并跳到第 ${turn} 轮`, en: (turn: number) => `Load and jump to turn ${turn}` },
  turnRailTurn: { zh: (turn: number) => `第 ${turn} 轮`, en: (turn: number) => `Turn ${turn}` },
  userMessageExpand: { zh: "展开", en: "Expand" },
  userMessageCollapse: { zh: "收起", en: "Collapse" },
  sendQueue: { zh: "排队发送", en: "Queue message" },
  sendSteer: { zh: "插话发送", en: "Send as steer" },
  queueSteer: { zh: "插话发送", en: "Send as steer" },
  queueSteerUnavailable: { zh: "仅运行中可插话发送", en: "Steering is only available while the agent is running" },

  toolRunning: { zh: "运行中 · 已用 {duration}", en: "Running · {duration} elapsed" },
  toolRunningHint: { zh: "输出会在执行结束后显示", en: "Output appears once the call finishes" },
} satisfies Record<string, LocalizedMessage>;

/** 标记名（表的键）——`Marker` 是从这张表**派生**出来的联合类型，不是手抄清单。 */
export type Marker = keyof typeof MESSAGES;

/**
 * **VS Code 原生 UI 面向的标记**：表里标了 `vscode: true` 的那些键，在这里列一次。
 *
 * 为什么不直接从表里筛：这份清单要能被**离线测试**读到，而 `hostText.ts` 依赖
 * `vscode`（测试进程里 import 不进来）。所以放在本模块（无任何运行时依赖），
 * `hostText.ts` 与 `scripts/i18n.test.ts` 都 import 它。
 *
 * `asMessageTable()` 在运行时核对它与表里的 `vscode: true` 标记**完全一致**——
 * 漏写一条会抛，多写一条也会抛，不存在「两处悄悄漂开」。
 */
export const VSCODE_FACING_MARKERS = [
  "authNeedsToken",
  "authTokenRejected",
  "serverSpawnFailed",
  "serverNotReady",
  "serverUnreachable",
  "serverLogTail",
] satisfies readonly Marker[];

/**
 * 取某条消息的**英文源串**（`vscode.l10n.t` 的 key）。
 *
 * `vscode.l10n` 的 key 是英文源串而不是自定义 id，所以要求这一条的 `en` 是
 * **纯字符串**（带参数的用 `{0}` 占位，见 `hostText.ts` 的 `arg: true`）。
 * 若这条登记成了函数，这里直接抛——那种形态没有可供 l10n 查表的源串。
 *
 * 顺带核对 `VSCODE_FACING_MARKERS` 与表里 `vscode: true` 的条目完全一致
 * （两处都在这一个文件里，落在这里检查就不必担心初始化顺序）。
 */
export function englishSource(key: Marker): string {
  assertVscodeFacingList();
  const explicit = (MESSAGES[key] as LocalizedMessage).l10n;
  if (explicit !== undefined) return explicit;
  const value = MESSAGES[key].en;
  if (typeof value !== "string") {
    throw new Error(
      `${key} 的 en 是函数：VS Code 的 l10n key 必须是英文**源串**——` +
        "要么把 en 写成 {0} 占位的字符串，要么在这一条上加 `l10n: \"...{0}...\"`",
    );
  }
  return value;
}

/** `VSCODE_FACING_MARKERS` 必须与表里标了 `vscode: true` 的条目一模一样。 */
export function assertVscodeFacingList(): void {
  const table = asMessageTable(MESSAGES);
  const declared = (Object.keys(table) as Marker[])
    .filter((key) => table[key].vscode === true)
    .sort();
  const listed = [...VSCODE_FACING_MARKERS].sort();
  if (declared.join("|") !== listed.join("|")) {
    throw new Error(
      "VSCODE_FACING_MARKERS 与表里 `vscode: true` 的条目不一致：\n" +
        `  标了 vscode: true：${declared.join("、") || "（无）"}\n` +
        `  VSCODE_FACING_MARKERS：${listed.join("、") || "（无）"}`,
    );
  }
}
