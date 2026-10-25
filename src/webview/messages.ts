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
   * 缺省是整段给第一个形参（`@key:arg` 的常规形态，参数里的冒号不截断）。写 `N` 表示
   * 「切成 N 段」：切前 N−1 个冒号，**剩下的整段**给最后一个形参——所以含冒号的原文只能
   * 出现在最后一段。两条历史口径是 `2`（`llmRetry` 的「第几次:共几次」、
   * `uploadIncomplete` 的「个数:文件名预览」）；图片那几条用 `3`/`4`
   * （`<文件名>:<数字…>`，以及 `imageFilesUploaded` 的
   * `<张数>:<模型名>`——文件名是 basename 不含冒号，模型名含冒号所以它
   * 必须落在最后一段）。
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

/** 字节 → 兆字节（提示里报量级就够，四舍五入到整数）。 */
function megabytes(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/**
 * 位数量级的缩写：像素上限报成「6400万」/「64M」，而不是 `64000000`。
 *
 * 用户对「这张图有多少像素」没有直觉，位数量级的原始数字只会白占一行（2026-10-13 口径：
 * 像素那条**只报上限**、不报实测值，且这个上限按语言缩写）。用 `Intl` 的 compact 记法，
 * 界面不留自造的万 / 亿换算表——单位后缀由 `Intl` 按语言给出。
 */
function compactCount(locale: "zh" | "en", value: number): string {
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
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
  // 官方 dsh-client-ui-commands 0.2.1-alpha.2 的 description 词条，保持原文。
  commandGoalDescription: { zh: "设置或查看长期任务目标", en: "Set or view the goal for a long-running task" },
  commandPlanDescription: { zh: "进入或退出计划模式", en: "Enter or leave plan mode" },
  commandFeedbackDescription: { zh: "发送关于当前会话的反馈", en: "Record feedback about this session" },
  commandCompactDescription: { zh: "压缩以上对话内容", en: "Compact older conversation history" },
  commandPermissionDescription: { zh: "切换权限预设（沙箱模式与审批策略）", en: "Switch the permission preset (sandbox mode + approval policy)" },
  commandExportDescription: { zh: "将当前会话内容导出为 ZIP", en: "Download this Session log as a ZIP archive" },
  commandOpenMenu: { zh: "打开并筛选斜杠命令", en: "Open and filter slash commands" },
  newChat: { zh: "新建对话", en: "New chat" },
  history: { zh: "历史对话", en: "Chat history" },
  openInEditor: { zh: "在编辑器中打开", en: "Open in editor" },
  openInBrowser: { zh: "在浏览器中打开 DSH Web", en: "Open DSH Web in browser" },
  /**
   * 顶部那颗「打开」按钮的另一种形态：当前连的**就是桌面端内置服务**时，它打开的是
   * 桌面端应用窗口（那套服务对浏览器是关着的，见 `docs/design-desktop.md`「浏览器访问」）。
   */
  openDesktop: { zh: "打开 DSH 桌面端", en: "Open the DSH desktop app" },
  openInBrowserOffline: {
    zh: "还没有连上 DSH 服务器，暂时无法在浏览器中打开。",
    en: "Not connected to a DSH server yet, so it cannot be opened in the browser.",
  },
  openInBrowserFailed: {
    zh: "系统没有打开浏览器，可以手动访问 dsh web 打印的地址。",
    en: "The browser was not opened; you can visit the URL printed by dsh web manually.",
  },
  openExternalFailed: {
    zh: "系统没有打开这条链接。",
    en: "The system did not open this link.",
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
  /** 标题右侧的执行目录说明：与工作区不同，或 VS Code 未打开文件夹时显示。 */
  sessionDir: { zh: "会话执行目录", en: "Session execution directory" },
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
   * **逐字抄官方**（`@deepseek-ai/dsh-client-ui-agent-preset` 的 `locales.ts`，`en` / `zh`
   * 两栏里那八条 `preset*` 键）：这八条由**客户端按当前语言**给，不看服务端为这几个
   * 预设发布的那份文件元数据——官方 `presetDisplayText` 只对**不发布 `name`** 的已知 id
   * 走词典（判据 `isBuiltInPreset`；`trust === 'system'` 那一代已随版本删掉）。所以两边
   * 必须逐字一致：同一个部署在官方 Web UI 与本扩展里该显示同一个名字**与描述**。
   * 用户自己写的预设不翻译；改这八条时回官方那份词典重抄，别在这里顺手改写。
   */
  presetStandardName: { zh: "标准模式", en: "Standard mode" },
  presetStandardDescription: {
    zh: "处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。",
    en: "Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.",
  },
  presetPtcName: { zh: "PTC 模式", en: "PTC mode" },
  presetPtcDescription: {
    zh: "包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。",
    en: "Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.",
  },
  presetMinimalName: { zh: "极简模式", en: "Minimal mode" },
  presetMinimalDescription: {
    zh: "Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。",
    en: "The agent works using only a terminal tool. Useful for testing and comparing its basic performance.",
  },
  presetCordisName: { zh: "创造模式", en: "Creator mode" },
  presetCordisDescription: {
    zh: "用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。",
    en: "Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.",
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
  /** 文件附件还在上传：发送按钮置灰，悬停说明原因（见 shared/attachmentGate）。 */
  sendBlockedUploading: { zh: "等待附件上传完毕", en: "Waiting for uploads to finish" },
  /** 文件附件上传失败：须先重试或移除，不能带着失败芯片发送。 */
  sendBlockedUploadFailed: {
    zh: "附件上传失败，请重试或移除",
    en: "Attachment upload failed; retry or remove",
  },
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
  /**
   * 实验性的 Auto review 档（`permissions` 目录里出现 `auto` 时才列出来）。
   *
   * 七条**逐字抄官方** `ui-permission-presets` 的 `accessZh` / `accessEn`
   * （`auto.label` / `auto.badge` / `auto.description` / `auto.confirm.*`）：
   * 官方中文词典里这一档的名字**本身就不翻译**（仍是 `Auto review`），
   * 只有周围的说明与警告是中文，所以这里也不自己起中文名。
   */
  permAutoReview: { zh: "Auto review", en: "Auto review" },
  permAutoReviewBadge: { zh: "EXP", en: "EXP" },
  permAutoReviewDesc: {
    zh: "无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。",
    en: "Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.",
  },
  permAutoReviewTitle: { zh: "确认启用 Auto review（实验）？", en: "Enable Auto review (experimental)?" },
  permAutoReviewBody: {
    zh: "Auto review 不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。",
    en: "Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.",
  },
  permAutoReviewAcknowledge: {
    zh: "我已了解这些风险，并愿意继续",
    en: "I understand these risks and want to continue",
  },
  permAutoReviewEnable: { zh: "启用 Auto review", en: "Enable Auto review" },
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
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total / 60) % 60;
      const seconds = total % 60;
      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours}小时`);
      if (total >= 60) parts.push(`${minutes}分`);
      parts.push(`${seconds}秒`);
      return parts.join("");
    },
    en: (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor(total / 60) % 60;
      const seconds = total % 60;
      const parts: string[] = [];
      if (hours > 0) parts.push(`${hours}h`);
      if (total >= 60) parts.push(`${minutes}m`);
      parts.push(`${seconds}s`);
      return parts.join(" ");
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
  /**
   * 正文里点的**文件链接**打不开（文件芯片那条走 `chipFileDeleted`）。
   *
   * 参数是宿主**按会话工作目录解析出来的绝对路径**：链接不见了十有八九是基准
   * 不对（模型按另一个目录写的相对路径、或把行号写进了目标），把解析结果说出来，
   * 用户一眼就能判断是路径写错了还是基准不对。
   */
  fileNotFound: {
    zh: (path: string) => `找不到文件：${path}`,
    en: (path: string) => `No such file: ${path}`,
  },
  chipPathUnresolved: {
    zh: "暂时拿不到会话工作目录，无法定位这个文件；稍后再点一次试试",
    en: "The session working directory is not available yet, so this file cannot be located; try again in a moment",
  },
  /**
   * 翻出一枚**本地已经没有**的附件（点了但没有原件，也换不回字节）。
   *
   * 三条来路都会落到这里：本机从没记过它的路径（别的客户端发的、记录被淘汰），记过但
   * 那个文件已经不在原处，以及临时副本被系统清掉。不能写成「只剩服务端副本」——文件
   * 附件在服务端那份**取不回来**（`session/attachment` 只服务图片），那句话会让人以为
   * 还有一条路可走。图片不走这条：它们经 `session/attachment` 总能换回字节。
   */
  attachmentUnavailable: {
    zh: "找不到这个附件的本地文件，也没能从服务端取回副本",
    en: "The local file for this attachment could not be found, and no copy could be retrieved from the server",
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
  // 图片进不了内容块 → **按文件上传**（不是拒收，也不是正文里的 `@` 引用：引用依赖共享
  // 文件系统，远端部署下是空头支票）。参数形如 `<文件名>:<数字…>`；文件名是 basename
  // （Windows 文件名不含冒号），所以按冒号切段是安全的。
  //
  // 后半句按原因分两类，照实说模型能不能直接读那份副本：**逐图**超限（内联字节 / 像素 /
  // 单边）的副本模型也得先缩小才能 `read_image`；**整批**超限（张数 / 总字节）的副本单张
  // 本来就在限内，模型按需读即可。
  imageTooLarge: {
    argParts: 2,
    zh: (name: string, limit: number) =>
      `${name} 超过服务端的图片内联上限 ${megabytes(limit)} MB，未作为图片加入，已作为文件上传；模型需先缩小该图才能直接查看`,
    en: (name: string, limit: number) =>
      `${name} is over the server's ${megabytes(limit)} MB inline limit, so it was uploaded as a file instead of an image; downscale it before the model can view it`,
  },
  // 像素那条**不报实测值**：`72000000` 这种数字对用户没有指导意义，只报上限（按语言
  // 缩写成「6400万」/「64M」）。单边是分辨率，报具体数字用户才缩得准。
  imagePixelsTooLarge: {
    argParts: 2,
    zh: (name: string, limit: number) =>
      `${name} 的像素数（宽 × 高）超过服务端上限 ${compactCount("zh", limit)}，未作为图片加入，已作为文件上传；模型需先缩小该图才能直接查看`,
    en: (name: string, limit: number) =>
      `${name} has more than the server's ${compactCount("en", limit)}-pixel limit (width × height), so it was uploaded as a file instead of an image; downscale it before the model can view it`,
  },
  imageDimensionTooLarge: {
    argParts: 3,
    zh: (name: string, side: number, limit: number) =>
      `${name} 的长边是 ${side} 像素，超过服务端上限 ${limit}，未作为图片加入，已作为文件上传；模型需先缩小该图才能直接查看`,
    en: (name: string, side: number, limit: number) =>
      `${name} is ${side} pixels on its longest side, over the server limit of ${limit}; it was uploaded as a file instead of an image, and must be downscaled before the model can view it`,
  },
  imageCountTooLarge: {
    argParts: 2,
    zh: (name: string, limit: number) =>
      `一条消息最多 ${limit} 张图片，${name} 未作为图片加入，已作为文件上传；模型可直接读取这份副本`,
    en: (name: string, limit: number) =>
      `A message accepts at most ${limit} images; ${name} was uploaded as a file instead, and the model can read that copy on demand`,
  },
  imageBytesTooLarge: {
    argParts: 3,
    zh: (name: string, bytes: number, limit: number) =>
      `一条消息的图片合计不能超过 ${megabytes(limit)} MB（已用 ${megabytes(bytes)} MB），${name} 未作为图片加入，已作为文件上传；模型可直接读取这份副本`,
    en: (name: string, bytes: number, limit: number) =>
      `Images in one message are limited to ${megabytes(limit)} MB in total (already ${megabytes(bytes)} MB); ${name} was uploaded as a file instead, and the model can read that copy on demand`,
  },
  dropHint: { zh: "松开即添加为附件", en: "Release to attach" },

  subagents: { zh: "子代理", en: "Subagents" },
  // 标题后的计数（官方 count.* 同款：总数恒显、有在跑的再亮状态点）
  subagentCount: {
    zh: (count: number) => `${count} 个子代理`,
    en: (count: number) => (count === 1 ? "1 subagent" : `${count} subagents`),
  },
  // 标题点击后清单的两节：顶层会话 / 子代理会话（树形，第 1 层与顶层会话同级对齐）
  subagentTopLevel: { zh: "顶层会话", en: "Top-level session" },
  subagentSessions: { zh: "子代理会话", en: "Subagent sessions" },
  // 标题（会话切换入口）的无障碍 / 悬停提示
  switchSession: {
    zh: (title: string) => `切换会话：${title}`,
    en: (title: string) => `Switch session: ${title}`,
  },
  // 一次性子代理的只读说明（官方 readonly.oneShot.* 同口径，替代整个输入区）
  subagentReadonlyTitle: { zh: "一次性子代理记录", en: "One-shot subagent record" },
  subagentReadonlyBody: {
    zh: "一次性任务不支持后续消息，可在这里查看完整执行记录。",
    en: "One-shot tasks do not accept follow-ups; review the full execution record here.",
  },
  subagentOneShot: { zh: "一次性", en: "one-shot" },
  subagentContinuable: { zh: "可继续", en: "continuable" },
  // 目录里 `activity: 'running'` 的那一条。**不复用后台任务的 `jobRunning`**（「运行中」）：
  // 用户对子代理这一行的口径是「生成中」（见 webview/subagentRow.ts 的状态表），两个界面
  // 说的不是同一件事（任务在跑 vs 子代理在生成），共用一条文案就改不动其中一边。
  subagentRunning: { zh: "生成中", en: "running" },
  // 目录里 `activity: 'inactive'` 且**用户还没看过结果**的那一条：读作**已完成**
  // （不是「未运行」）。子代理一旦列在目录里就必然领过初始任务（one-shot 与
  // continuable 都是带着 prompt 建出来的），所以「现在不在跑」有两种含义，由
  // 「已读」这一位分开：没看过是「已完成」，看过了才是模式名（可继续 / 一次性）。
  subagentCompleted: { zh: "已完成", en: "completed" },
  subagentNotFound: {
    zh: "目录里没有这个子代理，无法进入",
    en: "That subagent is no longer in the catalog",
  },
  subagentFilesUnsupported: {
    zh: "子代理会话不支持文件附件：请移除文件芯片后再发送",
    en: "Subagent conversations do not accept file attachments; remove the attachment and send again",
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
  // 停止按钮（官方 `kill.*` 同口径：两段式——第一下待确认，第二下才发请求）
  jobStopTitle: { zh: (label: string) => `停止任务 ${label}`, en: (label: string) => `Stop task ${label}` },
  jobStopConfirm: { zh: "再次点击确认停止", en: "Click again to confirm" },
  jobStopConfirmAction: { zh: "确认停止", en: "Confirm stop" },
  jobStopFailed: { zh: "停止失败", en: "Stop failed" },
  // 展开一行看实时输出（官方 `row.expandAria` / `row.collapseAria` 同口径）
  jobExpandAria: { zh: (label: string) => `查看 ${label} 的实时输出`, en: (label: string) => `Show live output of ${label}` },
  jobCollapseAria: { zh: (label: string) => `收起 ${label} 的实时输出`, en: (label: string) => `Hide live output of ${label}` },
  /**
   * 输出开头丢了（服务端淘汰了环头、续传有洞，或本扩展的 128KB 上限截断）。
   * 与「无输出」是两回事：这里**有输出**，只是能看到的那部分之前已经没了。
   */
  jobOutputGap: { zh: "……较早的输出已丢弃……", en: "… earlier output dropped …" },
  /** 观察流中断：`detail` 是服务端 / 传输层的原样报错，不翻译。 */
  jobOutputError: {
    zh: (detail: string) => `实时输出流中断：${detail}`,
    en: (detail: string) => `live output stream interrupted: ${detail}`,
  },
  /** 宿主连流都没能开（没连接 / 没有绑定会话）时的概括文案。 */
  jobOutputUnavailable: { zh: "实时输出暂时不可用", en: "Live output is currently unavailable" },
  // ---------- 自动化任务（DSH schedule） ----------
  // 与后台任务同一个抽屉里的另一个分区。任务名一律取服务端存的 title（见
  // shared/schedule.ts 的文件头）：这里没有任何「从指令推名字」的文案。
  scheduleSection: { zh: "自动化任务", en: "Automation tasks" },
  scheduleEmpty: { zh: "当前会话没有自动化任务", en: "This session has no automation tasks" },
  scheduleEmptyHint: {
    zh: "在对话里让模型用 schedule_create 安排后续任务，它们会出现在这里",
    en: "Ask the model to schedule follow-ups with schedule_create; they show up here",
  },
  scheduleLoading: { zh: "正在读取自动化任务…", en: "Loading automation tasks…" },
  // 能力缺失与「读到了空表」是两回事（旧版服务端没有 schedule 命名空间）
  scheduleUnsupported: {
    zh: "这个 DSH 版本没有自动化任务接口（需要 0.1.7-rc.2 及以上）",
    en: "This DSH version has no automation task endpoints (requires 0.1.7-rc.2 or newer)",
  },
  scheduleLoadFailed: {
    zh: "自动化任务读取失败；重新打开面板会再试一次",
    en: "Could not read automation tasks; reopening the panel retries",
  },
  scheduleActive: { zh: "启用中", en: "enabled" },
  scheduleInactive: { zh: "已结束", en: "inactive" },
  scheduleUnknownStatus: { zh: "未知状态", en: "unknown status" },
  scheduleNextRun: { zh: "下次运行", en: "Next run" },
  scheduleLastTarget: { zh: "最后目标", en: "Last target" },
  schedulePromptLabel: { zh: "指令", en: "Instruction" },
  // 行主体（可展开的行是按钮）：无障碍标签带任务名
  scheduleExpandAria: {
    zh: (title: string) => `查看 ${title} 的详情`,
    en: (title: string) => `Show details of ${title}`,
  },
  scheduleCollapseAria: {
    zh: (title: string) => `收起 ${title} 的详情`,
    en: (title: string) => `Hide details of ${title}`,
  },
  // 频率文本（拼装口径在 shared/schedule.ts 的 scheduleFrequency）
  scheduleOnce: { zh: "一次性", en: "Once" },
  scheduleEvery: {
    zh: (value: number, unit: string) => `每 ${value} ${unit}`,
    en: (value: number, unit: string) => `Every ${value} ${unit}`,
  },
  // 单位词带幅度：英文分单复数（`1 hour` / `12 hours`），中文两个分支同词。
  // sec / min 用缩写，两种数量下都不变。
  scheduleUnitSec: { zh: () => "秒", en: () => "sec" },
  scheduleUnitMin: { zh: () => "分", en: () => "min" },
  scheduleUnitHour: { zh: () => "小时", en: (value: number) => (value === 1 ? "hour" : "hours") },
  scheduleUnitDay: { zh: () => "天", en: (value: number) => (value === 1 ? "day" : "days") },
  // 时区为空串 = 与系统时区相同（官方口径：那一行不名时区）
  scheduleDaily: {
    zh: (time: string, zone: string) => (zone ? `每天 ${time}（${zone}）` : `每天 ${time}`),
    en: (time: string, zone: string) => (zone ? `Every day at ${time} (${zone})` : `Every day at ${time}`),
  },
  scheduleWeekly: {
    zh: (weekdays: string, time: string, zone: string) =>
      zone ? `每周 ${weekdays} ${time}（${zone}）` : `每周 ${weekdays} ${time}`,
    en: (weekdays: string, time: string, zone: string) =>
      zone ? `Weekly on ${weekdays} at ${time} (${zone})` : `Weekly on ${weekdays} at ${time}`,
  },
  scheduleCron: {
    zh: (expression: string, zone: string) => (zone ? `Cron ${expression}（${zone}）` : `Cron ${expression}`),
    en: (expression: string, zone: string) => (zone ? `Cron ${expression} (${zone})` : `Cron ${expression}`),
  },
  scheduleWeekday1: { zh: "周一", en: "Mon" },
  scheduleWeekday2: { zh: "周二", en: "Tue" },
  scheduleWeekday3: { zh: "周三", en: "Wed" },
  scheduleWeekday4: { zh: "周四", en: "Thu" },
  scheduleWeekday5: { zh: "周五", en: "Fri" },
  scheduleWeekday6: { zh: "周六", en: "Sat" },
  scheduleWeekday7: { zh: "周日", en: "Sun" },
  scheduleWeekdayJoin: { zh: "、", en: ", " },
  scheduleRelativeFuture: {
    zh: (value: number, unit: string) => `${value} ${unit}后`,
    en: (value: number, unit: string) => `in ${value} ${unit}`,
  },
  scheduleRelativeOverdue: {
    zh: (value: number, unit: string) => `已过期 ${value} ${unit}`,
    en: (value: number, unit: string) => `overdue by ${value} ${unit}`,
  },
  scheduleRelativeNow: { zh: "现在", en: "now" },
  // 运行时间编辑
  scheduleRuleLabel: { zh: "运行时间", en: "Run time" },
  scheduleRepeatLabel: { zh: "重复", en: "Repeat" },
  scheduleRepeatOnce: { zh: "一次", en: "Once" },
  scheduleRepeatEvery: { zh: "固定间隔", en: "Fixed interval" },
  scheduleRepeatDaily: { zh: "每天", en: "Every day" },
  scheduleRepeatWeekly: { zh: "每周", en: "Weekly" },
  scheduleRepeatCron: { zh: "自定义（cron）", en: "Custom (cron)" },
  scheduleFieldDate: { zh: "日期", en: "Date" },
  scheduleFieldTime: { zh: "时间", en: "Time" },
  scheduleFieldZone: { zh: "时区", en: "Time zone" },
  scheduleFieldAmount: { zh: "间隔数量", en: "Interval" },
  scheduleFieldUnit: { zh: "间隔单位", en: "Unit" },
  scheduleFieldWeekdays: { zh: "星期", en: "Weekdays" },
  scheduleFieldExpression: { zh: "cron 表达式", en: "Cron expression" },
  scheduleZoneSystem: {
    zh: (label: string) => `${label}（本机时区）`,
    en: (label: string) => `${label} (system zone)`,
  },
  scheduleSave: { zh: "保存修改", en: "Save changes" },
  scheduleSaving: { zh: "正在保存…", en: "Saving…" },
  scheduleCancel: { zh: "取消", en: "Cancel" },
  scheduleUnsaved: { zh: "有未保存的修改", en: "Unsaved changes" },
  scheduleInactiveReadonly: {
    zh: "已结束的任务不能再改运行时间",
    en: "An inactive task's run time can no longer be changed",
  },
  scheduleRuleUnreadable: {
    zh: "这条任务的规则读不出来，只能查看",
    en: "This task's rule could not be read; it is view-only",
  },
  scheduleCronInvalid: {
    zh: (field: string) => `cron 表达式里「${field}」不合法`,
    en: (field: string) => `The cron expression's ${field} field is invalid`,
  },
  scheduleCronFieldMinute: { zh: "分钟", en: "minute" },
  scheduleCronFieldHour: { zh: "小时", en: "hour" },
  scheduleCronFieldDayOfMonth: { zh: "日", en: "day of month" },
  scheduleCronFieldMonth: { zh: "月", en: "month" },
  scheduleCronFieldDayOfWeek: { zh: "星期", en: "day of week" },
  // 保存 / 删除的失败文案（服务端的稳定错误码，见 dsh/scheduleView.ts）
  scheduleErrConflict: {
    zh: "任务在你编辑期间被改过，请重新打开详情再改",
    en: "The task changed while you were editing; reopen the details and try again",
  },
  scheduleErrEnded: {
    zh: "任务已结束，不能再改运行时间",
    en: "The task has ended; its run time can no longer be changed",
  },
  scheduleErrNotFound: { zh: "任务已不存在（可能已被删除）", en: "The task no longer exists" },
  scheduleErrSubagent: {
    zh: "子代理会话里的任务不能修改",
    en: "A task bound to a subagent session cannot be modified",
  },
  scheduleErrZone: { zh: "时区无效", en: "Invalid time zone" },
  scheduleErrNotFuture: { zh: "目标时间必须晚于现在", en: "The target time must be in the future" },
  scheduleErrInterval: { zh: "间隔不能小于 60 秒", en: "The interval must be at least 60 seconds" },
  scheduleErrInvalid: { zh: "服务端拒绝了这次修改", en: "The host rejected this change" },
  scheduleErrInternal: { zh: "服务端内部错误", en: "The host reported an internal error" },
  scheduleErrOffline: {
    zh: "没能连上服务端，修改未提交",
    en: "Not connected to the host; the change was not submitted",
  },
  // 删除（两段式确认，与停止按钮同口径）
  scheduleDeleteTitle: {
    zh: (title: string) => `删除任务 ${title}`,
    en: (title: string) => `Delete task ${title}`,
  },
  scheduleDeleteConfirm: { zh: "再次点击确认删除", en: "Click again to confirm" },
  scheduleDeleteConfirmAction: { zh: "确认删除", en: "Confirm delete" },
  scheduleDeleting: { zh: "正在删除…", en: "Deleting…" },
  scheduleDeleteFailed: { zh: "删除失败", en: "Delete failed" },
  scheduleDeleteNote: {
    zh: "删除后任务不再触发，已保存的执行记录也会一起删除",
    en: "Deleting stops future delivery and removes the saved delivery records",
  },
  // 执行记录
  scheduleRecords: { zh: "执行记录", en: "Saved deliveries" },
  scheduleRecordsEmpty: { zh: "还没有投递记录", en: "No saved deliveries yet" },
  scheduleRecordsLoading: { zh: "正在读取执行记录…", en: "Loading saved deliveries…" },
  scheduleRecordsMore: { zh: "加载更早", en: "Load older records" },
  scheduleRecordsUnavailable: {
    zh: "更早的记录可能已不可用",
    en: "Earlier deliveries may no longer be available",
  },
  scheduleRecordsPruned: {
    zh: (days: number, records: number) => `服务端只保留最近 ${days} 天、每个任务最多 ${records} 条`,
    en: (days: number, records: number) =>
      `The host keeps at most ${records} records per task within ${days} days`,
  },
  scheduleRecordsFailed: {
    zh: (detail: string) => `执行记录读取失败：${detail}`,
    en: (detail: string) => `Could not read saved deliveries: ${detail}`,
  },
  scheduleRecordsRetry: { zh: "重试", en: "Retry" },
  scheduleRecordsMissing: { zh: "这个任务已不存在（可能已被删除）", en: "This task no longer exists" },
  scheduleRecordsCursorLost: {
    zh: "分页位置已失效，请重新打开记录",
    en: "The page position is no longer valid; reopen the records",
  },
  scheduleRecordsOffline: {
    zh: "未连接或没有绑定会话，暂时读不到执行记录",
    en: "Not connected or no session bound; saved deliveries are unavailable",
  },
  scheduleRecordNoPrompt: {
    zh: "这条记录没有保存当时的指令",
    en: "This record kept no instruction snapshot",
  },
  scheduleRecordTitle: {
    zh: (occurrence: string, delivered: string) => `发生时刻 ${occurrence}，投递确认 ${delivered}`,
    en: (occurrence: string, delivered: string) => `Due ${occurrence}, delivered ${delivered}`,
  },
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
  /** 接入时没有可用会话：后台未连接（整批拒收，见 controller 的 rejectIntakeWithoutSession）。 */
  attachBackendOffline: {
    zh: "后台未连接，暂时无法添加附件",
    en: "The backend is not connected; attachments cannot be added yet",
  },
  /** 接入时没有可用会话：没有工作目录（整批拒收）。 */
  attachNeedsWorkspace: {
    zh: "请选择工作目录后再添加附件",
    en: "Choose a working directory before adding attachments",
  },
  /** 接入时没有可用会话：其余（建会话失败等）——原因已由原生错误提示说明。 */
  attachSessionUnavailable: {
    zh: "会话尚未就绪，附件未添加",
    en: "The session is not ready; the attachments were not added",
  },
  /**
   * 发送失败的那一行（乐观回显的失败态）。
   *
   * 口径（用户 2026-09-25）：失败**不撤回显示**——那一行留在原地、气泡走错误色，
   * 操作行最左侧给这两个动作，行尾写失败原因。正文不塞回输入框（回填会变成两份：
   * 输入框一份 + 消息流一份），要再发就点这里这颗。
   */
  resend: { zh: "重发", en: "Resend" },
  retract: { zh: "撤回", en: "Retract" },
  /** 宿主发的失败原因：`@sendFailed:<detail>`（detail 里可能有冒号，整段保留）。 */
  sendFailed: {
    zh: (detail: string) => `发送失败：${detail}`,
    en: (detail: string) => `Send failed: ${detail}`,
  },
  /** 连不上后台（内部那套没起来 / 目标不可达），什么都没发出去。 */
  sendNoConnection: { zh: "没有连接到 DSH，消息没有发出去", en: "Not connected to DSH; the message was not sent" },
  /** 拼不出任何内容块（附件表示不出来、又没有正文）。 */
  sendEmpty: { zh: "没有可发送的内容", en: "Nothing to send" },
  /** 会话已经关掉 / 连接断了，始终没收到服务端的确认。 */
  sendUnconfirmed: { zh: "未收到服务端确认，这条可能没有发出去", en: "No confirmation from the server; this may not have been sent" },
  /**
   * 服务端**受理了**这条，但那一轮在把它写进会话记录之前就失败了（真实例子：所选模型
   * 没有对应的思考档位）。它与 `@sendUnconfirmed` 的区别是**已经确证**没落盘：这条
   * 待发消息被那一轮领走、却始终没有成为会话里的用户消息，所以内容一定没发出去。
   *
   * `vscode: true`：没有回显的那条（运行中排队发送 / 子代理会话）没有能承载失败的行，
   * 这句原因是**原生错误提示**里唯一说清「为什么没发出去」的细节（见
   * `controller.reportLostSubmission`）。
   */
  sendNotPersisted: {
    zh: "服务端受理后本轮失败，这条没有写进会话（内容未发出）",
    en: "The turn failed after acceptance, so this was never recorded in the session (not sent)",
    vscode: true,
  },
  mentionFiles: { zh: "文件", en: "Files" },
  mentionSessions: { zh: "对话", en: "Sessions" },
  mentionEmpty: { zh: "没有匹配的文件", en: "No matching files" },
  mentionSessionsEmpty: { zh: "没有匹配的对话", en: "No matching sessions" },
  /**
   * 菜单空着的**第二种理由**：这个窗口还没有工作目录（`workspace.path` 是空串）。
   *
   * 空态下 `/` 与 `@` 的候选都来自服务端的**会话作用域**目录（命令目录按 agent 的
   * 组装、文件候选按 agent 的工作目录），而没有工作目录时不会就地建会话（用户
   * 2026-09-24 口径：菜单不弹目录选择器）。不把原因说出来，用户看到的就是「没有可用
   * 命令」这种误导性的空菜单。选目录的入口在页面上方那一行（`workspaceChoose`）。
   */
  menuNoWorkspace: {
    zh: "未选择工作区，请先选择工作目录",
    en: "No workspace selected — choose a working directory first",
  },
  /**
   * **`/` 命令菜单**底部的键位提示：与 `mentionHint` 只差 `Tab`。
   *
   * 命令候选是一个平铺列表，没有目录概念——照搬 `@` 那份（写着「Tab 进入目录」）
   * 等于提示一件按下去没有作用的动作（用户 2026-09-25 口径）。
   */
  commandHint: { zh: "↑↓ 选择 · Enter 引用 · Esc 取消", en: "↑↓ select · Enter reference · Esc cancel" },
  mentionHint: { zh: "↑↓ 选择 · Enter 引用 · Tab 进入目录 · Esc 取消", en: "↑↓ select · Enter reference · Tab browse folder · Esc cancel" },
  mentionSessionsHint: { zh: "↑↓ 选择 · Enter / Tab 引用 · Esc 取消", en: "↑↓ select · Enter / Tab reference · Esc cancel" },
  mentionParent: { zh: "返回上一层目录", en: "Go to the parent folder" },
  mentionDrill: { zh: "进入目录", en: "Browse folder" },
  mentionDrillKey: { zh: "Tab", en: "Tab" },
  mentionNoCwd: { zh: "（无工作目录）", en: "(no cwd)" },
  /**
   * 正文里 `@` 引用做成链接之后的三条悬停提示（`webview/mentionLinks.ts` 判种类）。
   *
   * 三种引用点开的行为不同（文件开文件、目录展开资源管理器、会话开新标签页），
   * 提示必须各说各的——合并成「打开引用」用户点之前不知道会发生什么。
   */
  mentionOpenFile: { zh: "打开这个文件", en: "Open this file" },
  mentionRevealFolder: { zh: "在资源管理器中展开这个目录", en: "Reveal this folder in the Explorer" },
  mentionOpenSession: { zh: "在新标签页中打开这个会话", en: "Open this session in a new tab" },
  /**
   * HTML 家族文件的悬停提示（正文锚点 / 行内代码 / 已发出的 `@` 引用共用）。
   * 普通单击仍在编辑器里打开，所以文案只承诺修饰键这一档。
   */
  webFileBrowserHint: {
    zh: "按住 Ctrl/Cmd 单击，在浏览器中打开",
    en: "Ctrl/Cmd+click to open in browser",
  },
  /**
   * **草稿区**的引用提示（输入框的 title）：草稿里的引用要按住 Ctrl 才点得开，
   * 不说明的话没人会去试（正文里已发出的引用是直接可点的，不必提示）。
   */
  mentionClickHint: {
    zh: "按住 Ctrl 单击可打开这个引用",
    en: "Ctrl+click to open this reference",
  },
  /** 正文里点的**目录**引用找不到（`@src/` 那种；文件那条走 `fileNotFound`）。 */
  folderNotFound: {
    zh: (path: string) => `找不到目录：${path}`,
    en: (path: string) => `No such folder: ${path}`,
  },

  running: { zh: "深度求索中", en: "Deep diving" },
  /**
   * 运行状态的计时文案；末尾那组点由 `<Ellipsis />` 画（官方 `chat.deepDivingFor`）。
   * 中文「用时」后**不留空格**（「用时12秒」）是用户指定的刻意行为，不是漏对齐官方：
   * 官方 `chat.deepDivingFor` 那里有空格，不要再照着补回去。
   */
  runningElapsed: {
    zh: (duration: string) => `深度求索中，用时${duration}`,
    en: (duration: string) => `Deep diving for ${duration}`,
  },
  queued: { zh: "待发送 {n} 条", en: "{n} queued" },
  queueRemove: { zh: "取消这条消息", en: "Remove this message" },
  queueEdit: { zh: "取回重新编辑", en: "Take back to edit" },
  queueMediaOnly: { zh: "（附件）", en: "(attachment)" },
  /**
   * 队列行行首的「这条带附件」标记（用户 2026-09-25 口径）。
   *
   * 队列行只显示正文，带图片 / 文件的那条光看文字看不出来；方括号照用户给的形态。
   */
  queueHasAttachment: { zh: "[含附件]", en: "[with attachments]" },
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
  // 会话正文右键菜单的两条（自绘，见 `webview/contextMenu.ts`）
  quoteSelection: { zh: "引用", en: "Quote" },
  // 复制图片失败：跨域图污染画布、剪贴板被占、浏览器不给写——都在界面里判，宿主不知情
  imageCopyFailed: { zh: "复制图片失败", en: "Could not copy the image" },
  // 图片右键菜单的「保存」与它的失败提示（成功不提示：路径是用户自己选的）
  imageSave: { zh: "保存", en: "Save" },
  imageSaveFailed: { zh: "保存图片失败", en: "Could not save the image" },
  stopped: { zh: "已停止", en: "Stopped" },

  connecting: { zh: "正在连接…", en: "Connecting…" },
  connectionFailed: { zh: "无法连接 DSH 服务器", en: "Cannot reach the DSH server" },
  startInternal: { zh: "启动内部 DSH", en: "Start internal DSH" },
  connectInternal: { zh: "连接内部 DSH", en: "Connect to internal DSH" },
  connectExternal: { zh: "连接外部 DSH", en: "Connect to external DSH" },
  startDesktop: { zh: "启动 DSH 桌面端", en: "Start the DSH desktop app" },
  connectDesktop: { zh: "连接 DSH 桌面端", en: "Connect to the DSH desktop app" },
  restartInternal: { zh: "重启内部 DSH", en: "Restart internal DSH" },
  externalDisabledHint: { zh: "未配置 dshChat.url，没有可连的外部 DSH", en: "dshChat.url is not set, so there is no external DSH to connect to" },
  startingInternal: { zh: "正在启动内部 DSH…", en: "Starting the internal DSH…" },
  connectingInternal: { zh: "正在连接内部 DSH…", en: "Connecting to the internal DSH…" },
  connectingExternal: {
    zh: (baseUrl: string) => `正在连接外部 DSH（${baseUrl}）…`,
    en: (baseUrl: string) => `Connecting to the external DSH (${baseUrl})…`,
  },
  startingDesktop: { zh: "正在启动 DSH 桌面端…", en: "Starting the DSH desktop app…" },
  connectingDesktop: { zh: "正在连接 DSH 桌面端…", en: "Connecting to the DSH desktop app…" },
  stopReconnect: { zh: "停止连接", en: "Stop connecting" },
  showLogs: { zh: "查看日志", en: "Show logs" },
  statusInternalRunning: { zh: "内部 DSH：运行中", en: "Internal DSH: running" },
  statusInternalNotRunning: { zh: "内部 DSH：未运行", en: "Internal DSH: not running" },
  // 内部那一轴不存在（`dshChat.command` 留空）：与外部那半句的「未配置」同口径。
  // 它是**界面文案**（`connectViewOf` 直接读词典），不是宿主发的 `@key` 标记，
  // 所以不进 `i18n.test.ts` 的 HOST_MARKERS（对照 `statusInternalRunning`）
  statusInternalUnconfigured: { zh: "内部 DSH：未配置", en: "Internal DSH: not configured" },
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
  /**
   * 发起「重启内部 DSH」的窗口自己的等待文案（**只进连接条**）。
   *
   * 它不能复用 `connectionLost`：这个窗口的断线是自己造成的，说“连接已断开、正在重连”
   * 与事实不符；而旁观窗口确实是被动掉线，仍走 `connectionLost`。两条文案互斥。
   */
  restartingInternal: { zh: "正在重启内部 DSH…", en: "Restarting the internal DSH…" },
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
  // 桌面端那一支的失败说明（**只进连接条**：`describeError` 的这几种不经过 reportError，
  // 所以没有 vscode / l10n 那一层）。它们都属"要用户动作"：不自动重试。
  desktopCredentialMissing: {
    zh: "读不到 DSH 的本地凭据（DSH 主目录里没有浏览器会话密钥），无法接上桌面端服务。让桌面端或 dsh web 启动过一次就会生成这份凭据。",
    en: "Cannot read the local DSH credential (the DSH home has no browser-session secret), so the desktop app's service cannot be attached. Starting the desktop app or dsh web once creates it.",
  },
  desktopCredentialRejected: {
    zh: "DSH 桌面端拒绝了本扩展签发的会话凭据。通常是桌面端与本扩展解析到的 DSH 主目录不是同一个。",
    en: "The DSH desktop app rejected the session credential this extension signed. This usually means the desktop app and this extension resolve different DSH home directories.",
  },
  desktopSpawnFailed: {
    zh: (detail: string) => `启动 DSH 桌面端失败：${detail}`,
    en: (detail: string) => `Could not start the DSH desktop app: ${detail}`,
  },
  desktopNotReady: {
    zh: "已启动 DSH 桌面端，但没等到它的内置服务就绪。请确认桌面端确实起来了，再用「连接 DSH 桌面端」重试。",
    en: "The DSH desktop app was started but its built-in service did not become ready. Check that the app is running, then try “Connect to the DSH desktop app” again.",
  },
  /**
   * 拉起的桌面端进程**刚启动就退出**（而且当时没有任何桌面端宿主进程在跑）。
   *
   * 参数是退出码；被信号杀死时宿主不带参数，文案自动省掉那一段。
   */
  desktopExited: {
    zh: (code: string) =>
      code
        ? `DSH 桌面端进程刚启动就退出了（退出码 ${code}），没等到它的内置服务。请确认 dshChat.desktopExecutable 指向的程序能手动启动。`
        : "DSH 桌面端进程刚启动就退出了，没等到它的内置服务。请确认 dshChat.desktopExecutable 指向的程序能手动启动。",
    en: (code: string) =>
      code
        ? `The DSH desktop process exited right after launch (exit code ${code}) and its built-in service never became ready. Check that the program at dshChat.desktopExecutable starts on its own.`
        : "The DSH desktop process exited right after launch and its built-in service never became ready. Check that the program at dshChat.desktopExecutable starts on its own.",
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
  // 会话行「复制会话 ID」按钮的 title（当前会话与运行中的会话同样有这颗按钮）
  copySessionId: { zh: "复制会话 ID", en: "Copy session ID" },
  archive: { zh: "归档（从工作区列表移出）", en: "Archive (move out of workspace list)" },
  archiveList: { zh: "归档列表", en: "Archived sessions" },
  deleteSession: { zh: "删除（删除本地日志文件）", en: "Delete (remove local log files)" },
  deleteSessionConfirm: { zh: "再次点击确认删除", en: "Click again to confirm" },
  noArchivedSessions: { zh: "暂无归档会话", en: "No archived sessions" },
  // 历史列表多选：复选框的无障碍名（带标题）与禁用提示（运行中 / 当前会话）
  selectSession: { zh: (title: string) => `选择：${title}`, en: (title: string) => `Select: ${title}` },
  // 顶部多选形态开关（与归档切换同一个位置组：多选在归档左边）
  multiSelect: {
    zh: "多选（批量归档、恢复或删除）",
    en: "Multi-select (batch archive, restore or delete)",
  },
  multiSelectExit: { zh: "退出多选", en: "Exit multi-select" },
  selectLocked: {
    zh: "运行中的会话与当前会话不可选择",
    en: "Running sessions and the session you are viewing cannot be selected",
  },
  // 全选按钮的翻转（还没有全选 → 全选；已经全选 → 取消全选）。英文取「Select all / Clear all」
  // 这对对称的短词：比 Clear selection 短一截，窄侧栏下少截一段字
  selectAll: { zh: "全选", en: "Select all" },
  selectNone: { zh: "取消全选", en: "Clear all" },
  selectedCount: { zh: (count: number) => `已选 ${count} 项`, en: (count: number) => `${count} selected` },
  // 多选工具条的短标签（完整说明在 title 里，取 archive / unarchive / deleteSession）
  batchArchive: { zh: "归档", en: "Archive" },
  batchUnarchive: { zh: "恢复", en: "Restore" },
  batchDelete: { zh: "删除", en: "Delete" },
  unarchive: { zh: "恢复（移回工作区列表）", en: "Restore (move back to workspace list)" },
  deleteSelectedConfirm: {
    zh: (count: number) => `再次点击确认删除 ${count} 项`,
    en: (count: number) => `Click again to delete ${count}`,
  },

  contextUsed: {
    zh: (percent: number, used: string, total: string) => `上下文已用 ${percent}%（${used} / ${total}）`,
    en: (percent: number, used: string, total: string) => `Context used ${percent}% (${used} / ${total})`,
  },
  ctxDetailCached: { zh: "缓存命中", en: "Cache hit" },
  /**
   * 工具栏里**独立的**缓存命中率元素（用户 2026-10-10 口径的最低优先级那一项，
   * 位置在上下文容量数值右边，形如 `98.7%HIT`）。
   *
   * 两份文案**故意写成同一句**：`HIT` 是用户当天明确要的中英文通用写法，
   * 所以这里不做语言区分，两边登记同一份（词典的规矩是 zh/en 缺一不可，
   * 不是「必须不同」）。参数是**不含 `%` 的百分比文本**（算法见 `cacheHit.ts`）。
   */
  ctxCacheHit: {
    zh: (percent: string) => `${percent}%HIT`,
    en: (percent: string) => `${percent}%HIT`,
  },
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
  // 模型不收图片输入是**整批**原因（这一批里每一张都进不了内容块），汇总成一条：按条发
  // 会刷屏。参数形如 `<张数>:<模型名>`（模型名里可能含冒号，所以它必须在最后一段）
  imageFilesUploaded: {
    argParts: 2,
    zh: (count: number, model: string) => `模型「${model}」不支持图片输入，${count} 张图片已作为文件上传`,
    en: (count: number, model: string) =>
      `Model "${model}" does not accept image input; ${count} image${count === 1 ? "" : "s"} uploaded as file${count === 1 ? "" : "s"}`,
  },  queueAttachmentsLost: { zh: "部分附件无法还原，消息已保留在队列中。", en: "Some attachments cannot be restored. The message was kept in the queue." },
  queueContentLost: { zh: "排队消息的内容无法还原，已只中止当前轮", en: "Could not restore the queued message; only the current turn was stopped" },
  /**
   * 排队消息没能发起（ESC 中止后接着发 / 摘不动队列时的回滚）。
   *
   * 刻意不说「内容已放回输入框」：那一刻 agent 若已空闲，这条是**真的发出去了**，
   * 失败会留在对话流里（红框 + 重发 / 撤回），正文并不在输入框；只有回滚那一档才回填。
   * 两种收场各自在界面上看得见，这里只说「没发出去」。
   */
  queueDispatchFailed: { zh: "排队消息没能发出", en: "The queued message could not be sent" },
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
  /** `skill` 工具节点自有标题（官方 `SkillRow` 的 `row.title`）。 */
  toolSkill: { zh: "加载技能", en: "Skill" },
  toolExitCode: { zh: (code: number) => `退出码 ${code}`, en: (code: number) => `exit code ${code}` },
  toolSignal: { zh: (signal: string) => `被信号 ${signal} 终止`, en: (signal: string) => `killed by signal ${signal}` },
  /**
   * 工具行展开区底部那颗「在轨迹里查看这次调用」（官方 `row.inspect`）。
   *
   * 与工具自带标题那族 key 无关（`toolInspect` 是 `cordis_inspect` 那只工具的名字），
   * 这一条是**动作**：点了切到轨迹视图、选中并滚到这次调用那一行。
   */
  toolInspectCall: { zh: "查看", en: "Inspect" },
  toolInspectCallTitle: { zh: "在轨迹里查看这次调用", en: "Inspect this call in the trajectory" },
  toolImageAlt: { zh: "工具返回的图片", en: "Image returned by the tool" },
  messageImageAlt: { zh: "消息里的图片", en: "Image in the message" },
  imagePreview: { zh: "查看原图", en: "View original" },
  imagePreviewClose: { zh: "关闭原图预览", en: "Close original image preview" },
  imageLoadFailed: { zh: "图片加载失败", en: "Image failed to load" },
  /**
   * 知道是哪一张时的同一条降级文案：**引用缀在后面**。
   *
   * 正文里可能有好几张图，一句「加载失败」分不出是谁，排查时也没法把它和宿主
   * 日志里的路径对上。引用可能是本地路径（`out/chart.png`）或远程 URL——都是
   * 用户用来认出「哪张图」的东西，见 `shared/imageRef.ts` 的 `imageRefLabel`。
   */
  imageLoadFailedAt: {
    zh: (path: string) => `图片加载失败：${path}`,
    en: (path: string) => `Image failed to load: ${path}`,
  },
  toolInput: { zh: "输入", en: "IN" },
  toolOutput: { zh: "输出", en: "OUT" },
  /**
   * 节点悬停的修饰键提示：只有**按住 Ctrl/Cmd 单击会打开文件**的节点才挂。
   *
   * 读 / 写 / 编辑节点指向这次调用操作的文件；技能节点指向服务端 `skills/list`
   * 给出的 `SKILL.md`。普通单击仍是开合节点，提示只承诺修饰键那一档。
   */
  toolOpenFileHint: {
    zh: "按住 Ctrl/Cmd 单击打开文件",
    en: "Ctrl/Cmd+click to open the file",
  },
  toolOpenSkillHint: {
    zh: "按住 Ctrl/Cmd 单击打开 SKILL.md",
    en: "Ctrl/Cmd+click to open SKILL.md",
  },
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
  /** 代码块长内容底部那枚居中箭头（`CodeBlock` 的 `code-block-expand`）。 */
  codeBlockExpandAria: { zh: "展开代码块全文", en: "Expand the full code block" },
  codeBlockCollapseAria: { zh: "收起代码块", en: "Collapse the code block" },
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
  /**
   * 「任务清单」面板的抬头：标题 + 进度（已完成 / 总数）。
   *
   * 与工具行的 `toolTodoTitle`（「更新任务清单」，官方 `todo.rowTitle` 的节点名）分开：
   * 面板抬头说的是**当前清单有多少条、完成了几条**，折起来时它是唯一的进度来源。
   * 带两个参数，所以登记成函数（不许在组件里拼字符串：中英语序不同）。
   */
  todoPanelTitle: {
    zh: (done: number, total: number) => `任务清单 (${done}/${total})`,
    en: (done: number, total: number) => `To-do list (${done}/${total})`,
  },
  maxTokens: {
    zh: "已达到输出 token 上限，回答被截断。发送「继续」可接着写。",
    en: "Output token limit reached; the answer was truncated. Send “continue” to resume.",
  },

  branchFromHere: { zh: "从这里分支", en: "Branch from here" },
  branchFailed: { zh: "创建分支失败", en: "Could not create the branch" },
  branchNoAnchor: { zh: "这条消息还取不到分支锚点（本轮尚未收尾），暂时不能分支", en: "No branch anchor for this message yet (the turn has not finished)" },
  branchRunning: { zh: "生成中不能分支", en: "Cannot branch while generating" },
  historyMore: { zh: "加载更早的历史", en: "Load earlier history" },
  historyLoading: { zh: "正在加载更早的历史…", en: "Loading earlier history…" },
  jumpToLatest: { zh: "回到最新", en: "Jump to latest" },
  // 会话查找条（Ctrl+F；自绘——webview 拿不到原生查找部件，见 FindBar.tsx 文件头）
  findInChat: { zh: "在会话中查找", en: "Find in chat" },
  findPlaceholder: { zh: "查找", en: "Find" },
  findPrev: { zh: "上一个匹配（Shift+Enter）", en: "Previous match (Shift+Enter)" },
  findNext: { zh: "下一个匹配（Enter）", en: "Next match (Enter)" },
  findClose: { zh: "关闭查找（Esc）", en: "Close find (Esc)" },
  // ---------- 消息通知（宿主权威的常驻提醒，见 docs/design-notifications.md）----------
  // 顶部常驻条与通知抽屉的界面文案。通知**正文**由宿主发 `@` 标记（`@unknownEvent` /
  // `@executionDirChanged` / `@imageCopyFailed` …），这里只登记外壳文字。
  notifications: { zh: "消息通知", en: "Notifications" },
  // 确认是**写明的按钮**（不以 ✕ / 计时 / 切换视图替代）：只表示已悉知，不表示已解决
  notificationAcknowledge: { zh: "确认", en: "Acknowledge" },
  notificationHistory: { zh: "展开历史", en: "Show history" },
  notificationsEmpty: { zh: "没有消息通知", en: "No notifications" },
  notificationsUnacknowledged: { zh: "未确认", en: "Unacknowledged" },
  notificationsAcknowledged: { zh: "已确认", en: "Acknowledged" },
  // 发生次数：抽屉里 **1 也显示**（那是读数），顶部只在重复发生时报
  notificationCount: {
    zh: (count: number) => `发生 ${count} 次`,
    en: (count: number) => `Occurred ${count} ${count === 1 ? "time" : "times"}`,
  },
  // 首次发生时刻（抽屉里作为最近发生时间的 title，不占额外一行）
  notificationFirstAt: { zh: (time: string) => `首次发生：${time}`, en: (time: string) => `First occurred: ${time}` },
  // 没有会话归属的通知：所有视图都看得到
  notificationShared: { zh: "共享", en: "Shared" },
  notificationSession: { zh: "会话", en: "Session" },
  /**
   * 执行目录改变（宿主 `@executionDirChanged:<dir>`）：绿色重要变化。
   *
   * 参数是完整目录路径（可能含冒号，按默认整段给第一个形参的口径解析）。
   */
  executionDirChanged: {
    zh: (dir: string) => `执行目录已切换为 ${dir}`,
    en: (dir: string) => `Execution directory changed to ${dir}`,
  },
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
  // 没有回显的那条提交被判「受理了却没落盘」：原生提示里的失败细节（见 controller 的
  // `reportLostSubmission`；有回显时这条原因只进失败行，两种收场共用同一句话）
  "sendNotPersisted",
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
