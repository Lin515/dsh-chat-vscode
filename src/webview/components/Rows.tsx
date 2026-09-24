import { useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { post } from "../bridge";
import type {
  ApprovalView,
  CommandRunView,
  DiffLayout,
  FileChangeKind,
  InjectedSourceView,
  InjectedView,
  QuestionView,
  ToolCallView,
  TurnStatsView,
} from "../../shared/chat";
import { classifyTool, toolTitleKey } from "../../shared/toolMeta";
import { MAX_CATALOG_ENTRIES } from "../../shared/injectedSource";
import { formatDuration, Popover, Row, useElapsed, useSelectionFreeze, useStickyBody } from "./primitives";
import { canSubmit, isAnswered, questionMode } from "../questionFlow";
import { planReviewAnswer, planReviewOf, type PlanReviewView } from "../planReview";
import { DiffView } from "./Diff";
import { CodeBlock } from "./CodeBlock";
import { Markdown } from "./Markdown";
import { ImageGallery } from "./Images";
import { ToolCardBody } from "./ToolCards";
import { fill, useLocale, useTexts, resolveText } from "../texts";
import { pickLocalizedText } from "../../shared/localizedText";
import type { NodeOpenPort } from "../nodeOpen";
import {
  IconAlert,
  IconChevronDown,
  IconClock,
  IconClose,
  IconCode,
  IconDsh,
  IconExternal,
  IconFile,
  IconPencil,
  IconPlug,
  IconQuestion,
  IconRead,
  IconSearch,
  IconSlash,
  IconTerminal,
  IconWrench,
  IconWrite,
} from "../icons";

/**
 * 工具名 → 图标与标题。
 *
 * 分类走**官方的精确名表**（`shared/toolMeta`），不再用子串启发：
 * `includes("web")` 会把任何名字里带 web 的自定义工具误判成网页工具。
 * 变体决定图标，`TOOL_TITLE_KEYS` 里列出的工具用自己的标题（`pwsh`→「Pwsh」、
 * `read_image`→「读取图片」），与官方 `toolRowModel` 的 titleKey 选择一致。
 */
function useDescribeTool(): (name: string) => { icon: JSX.Element; iconClass: string; verb: string } {
  const texts = useTexts();
  return (name: string) => {
    const variant = classifyTool(name);
    const titleKey = toolTitleKey(name);
    // 工具自有标题优先（官方 TOOL_TITLE_KEYS → VARIANT_TITLE_KEYS 的回退顺序）
    const verb = titleKey
      ? (texts as unknown as Record<string, string>)[titleKey] ?? name
      : variant === "search"
        ? texts.toolSearch
        : variant === "read"
          ? texts.toolRead
          : variant === "bash"
            ? texts.toolRun
            : variant === "write"
              ? texts.toolWrite
              : variant === "edit"
                ? texts.toolEdit
                : variant === "code"
                  ? texts.toolCode
                  : name || texts.toolGeneric;
    const icon =
      variant === "search" ? (
        <IconSearch size={13} />
      ) : variant === "read" ? (
        <IconRead size={13} />
      ) : variant === "bash" ? (
        <IconTerminal size={13} />
      ) : variant === "write" ? (
        <IconWrite size={13} />
      ) : variant === "edit" ? (
        <IconPencil size={13} />
      ) : variant === "code" ? (
        <IconCode size={13} />
      ) : (
        <IconWrench size={13} />
      );
    // 变体 → 专属节点色（.node-*，tokens.css 的 --node-*）：完成态静态彩色，
    // 运行中由 .icon-glow 以同色呼吸发光
    return { icon, iconClass: `node-${variant}`, verb };
  };
}

export function ToolRow({
  tool,
  diffLayout,
  node,
}: {
  tool: ToolCallView;
  diffLayout?: DiffLayout;
  /**
   * 展开态与展开意图（由 `Message` 持有，见 `../nodeOpen.ts`）：**不在行里自持**，
   * 否则过程折叠把这一段卸载后状态就丢了。
   */
  node: NodeOpenPort;
}) {
  // 工具调用默认收起（不自动展开），用户手动开合优先
  const open = node.open ?? false;
  const describeTool = useDescribeTool();
  const texts = useTexts();
  const { icon, iconClass, verb } = describeTool(tool.name);
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = tool.status === "running" || tool.status === "pending";
  const stopped = tool.status === "stopped";
  // 运行中：每秒跳一次的实时耗时（协议没有工具进度事件，这是「还在跑」的唯一活证据）
  const elapsed = useElapsed(tool.startedAt ?? tool.endedAt, running);
  // 编辑类工具：结构化 diff（结果里的 hunk，或结果未回时参数推导的预览）
  const diff = tool.diff?.filter((hunk) => hunk.lines.length > 0);
  const hasDiff = Boolean(diff?.length);
  /**
   * 工具卡（官方 `ToolRow` 的 card 槽位）：读取 / 搜索 / 终端 / 网页。
   *
   * **有卡片就不再渲染 IN/OUT**——官方同一条规则（`card !== null` 时 `bodyText` 为
   * null），参数 JSON 因此不会出现在展开区（用户 2026-09-16 口径）。
   * 运行中仍用本扩展自己的「运行中 + 实时耗时 + 完整命令」那一段：官方在跑的时候
   * 只有命令，而长任务里那个计时是「还活着」的唯一证据。
   *
   * `run_code` 的代码卡**不在**这条规则里：官方对 code 变体把正文（代码）交给
   * CodeBlock、同时保留 OUT 段（`cardBody = variant === "code" ? null : bodyText`
   * ——IN 段不渲染，OUT 照常）。跑一段代码最该看的就是它的输出。
   */
  const card = running ? undefined : tool.card;
  const codeCard = card?.kind === "code" ? card : undefined;
  const hasCard = Boolean(card) && codeCard === undefined;
  // 出错时结果文本（失败原因）比 diff 更有用，两者都显示
  const showOutput = Boolean(tool.output) && (!hasDiff || tool.status === "error");
  // 运行中还没有结果，但展开区仍有东西可看：实时耗时 +（认得出的话）完整命令。
  // 一律可展开——任何正在跑的节点都该能点开确认「它还活着」，这正是长任务的需要。
  const runningBody = running;
  /**
   * 「运行中」那一块自己也是一个 `.row-body`（max-height 320 + overflow auto），
   * 长命令一样会撑出滚动条——所以它必须跟着一起定位，否则同一个展开区里会出现
   * 「上面那条滚动条在顶部、下面那条在底部」的怪相。
   */
  const runningRef = useRef<HTMLDivElement>(null);
  // 结果行仍可能被后续更新刷新；用户在其中划选时冻结渲染，保住选区
  const shownOutput = useSelectionFreeze(bodyRef, tool.output ?? "");

  // 官方 `leadingFor`：**只有** error 与 stopped 画状态点，running/ok 显示工具图标。
  // 此前只要传了 tone 就画点，于是所有工具图标都不可见（docs/audit-summary.md「工具行状态点覆盖图标」一条）。
  // 运行中不画小圆点而是让图标本身呼吸（与思考鲸鱼同一组关键帧）：build/命令行
  // 这类长任务里 7px 的圆点太不显眼，图标级发光才是一眼可见的「还在跑」。
  const tone = tool.status === "error" ? "error" : stopped ? "stopped" : undefined;

  // 退出状态：非零退出码 / 被信号杀死要看得出来（bash/pwsh 不把非零退出当 isError，
  // 不自己判的话 `exit 1` 和 `exit 0` 长得一样）
  const exitMeta =
    tool.signal !== undefined
      ? texts.toolSignal(tool.signal)
      : tool.exitCode !== undefined && tool.exitCode !== 0
        ? texts.toolExitCode(tool.exitCode)
        : undefined;

  const meta =
    tool.endedAt && tool.startedAt
      ? formatDuration(tool.endedAt - tool.startedAt)
      : running && tool.startedAt
        ? formatDuration(elapsed)
        : undefined;

  // 改动统计（官方 `diffTotals`）：折叠行右侧的 `+N -M`
  const diffStat = hasDiff && diff
    ? diff.reduce(
        (total, hunk) => ({
          added: total.added + (hunk.added ?? hunk.lines.filter((l) => l.kind === "add").length),
          removed: total.removed + (hunk.removed ?? hunk.lines.filter((l) => l.kind === "del").length),
        }),
        { added: 0, removed: 0 },
      )
    : undefined;
  /**
   * 「输入」段的内容：模型实际传的参数（官方 `cardBody`）。
   *
   * 官方这里给的是**解析后的卡片体**，所以我们把线格式的 JSON 缩进后显示；
   * 解析不了（半截 JSON、非 JSON 参数）就原样透出——总比什么都不显示强。
   */
  const inputText = (() => {
    if (!tool.input) return undefined;
    try {
      const parsed = JSON.parse(tool.input) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return tool.input;
    }
  })();
  /**
   * IN / OUT 卡的渲染判据，**只有这一份**：同一个式子既决定它渲不渲染，也决定要不要
   * 给它做滚动定位——两处各写一份必然漂移（改了渲染忘了定位，那条滚动条就永远停在
   * 顶部，用户 2026-09-21 报的正是这个形态）。
   *
   * 它同时是**运行中工具行的主滚动盒子**：卡片在跑的时候不渲染
   * （`card = running ? undefined : tool.card`），跑 `run_code` / 长命令这类调用时，
   * 展开区里唯一能撑出滚动条的就是这段 IN（参数 JSON）。
   */
  const showIoCard = !hasDiff && !hasCard && ((Boolean(inputText) && !codeCard) || showOutput);
  const ioRef = useRef<HTMLDivElement>(null);
  // 工具展开区（diff / 卡片 / IN-OUT / 运行状态）：**还在跑就贴底**（最新输出才是要看的），
  // 跑完则回到顶部（成型的内容从第一行读起）——判据与理由见 `useStickyBody` 的文件头。
  //
  // **一个滚动盒子一个 ref**（2026-09-17 起的口径）：同一次展开里可能同时存在两段
  // （编辑类出错时 `hasDiff && showOutput`；运行时「状态块 + IN 卡」），共用一个 ref 时
  // React 只保留最后绑上的那个元素，另一段就永远拿不到定位。
  const diffRef = useRef<HTMLDivElement>(null);
  useStickyBody(diffRef, open && hasDiff, running, node.openedWhileActive);
  useStickyBody(bodyRef, open && !hasDiff && (showOutput || hasCard || Boolean(codeCard)), running, node.openedWhileActive);
  useStickyBody(ioRef, open && showIoCard, running, node.openedWhileActive);
  useStickyBody(runningRef, open && runningBody, running, node.openedWhileActive);
  // 展开区只显示「解析后的有价值信息」：编辑类给 diff，其余给 IN/OUT 两段
  // （读取出的文本 / 运行输出 / 搜索结果等）。
  // 运行中也要可展开：长任务（构建）要能看见完整命令与「还在跑」的计时。
  //
  // **图片是展开体的成员**（用户 2026-09-21 口径）：结果里的图跟着展开态走——
  // 折叠态一张都不渲染，展开才画（见下面 children 里的图库）。
  // 所以它必须算进 `hasBody`：否则「只有图、没有别的正文」的调用会变成一行**点不开**
  // 的节点，那条路正好把图片彻底锁死（比难看严重得多）。
  const hasBody =
    hasDiff ||
    hasCard ||
    Boolean(codeCard) ||
    showOutput ||
    Boolean(inputText) ||
    runningBody ||
    Boolean(exitMeta) ||
    (tool.images?.length ?? 0) > 0 ||
    (tool.files?.length ?? 0) > 0;

  // `todo_write`：官方 `TodoRow` 的标题与进度摘要（`{done}/{total} 已完成 · 正在做 X`，
  // 右侧 `+N` 是其余进行中条目的条数）。它没有卡片，正文仍是 IN/OUT。
  const todo = tool.todo;
  const rowTitle = todo ? texts.toolTodoTitle : tool.title || verb;
  const rowDetail = todo
    ? [texts.toolTodoProgress(todo.done, todo.total), todo.active].filter(Boolean).join(" · ")
    : tool.detail;
  const rowDetailSuffix = todo
    ? todo.extra
      ? `+${todo.extra}`
      : undefined
    : tool.readLines
      ? `:${tool.readLines.start}-${tool.readLines.end}`
      : undefined;

  const row = (
    <Row
      // 运行中的节点：行首图标呼吸发光（.icon-glow，与思考鲸鱼同节奏），
      // 光色跟随节点自己的颜色（.node-*）；结束保持静态彩色图标
      // （不落回 .row-icon 的灰），与鲸鱼「结束仍是品牌蓝」同一条语言。
      // 两态都带 .node-icon：它提供 inline-flex 布局，盒子在运行/完成时**完全一致**
      // ——否则完成的一瞬间图标会跳 1.5px（用户 2026-09-12 报的「小挪动」）
      icon={
        <span className={`node-icon ${iconClass}${running ? " icon-glow" : ""}`}>{icon}</span>
      }
      tone={tone}
      // 节点名（动词）完整显示，路径/命令/查询等次要标题进 detail 列，
      // 过长时由 CSS 省略——思考/工具/用量行同一布局
      title={rowTitle}
      detail={rowDetail}
      // 只读了一段时把行号缀在文件名后；待办行则是「其余 N 条进行中」。该片段
      // 不可压缩，窄侧栏也看得见
      detailSuffix={rowDetailSuffix}
      diffStat={diffStat}
      // detail 是文件路径时可点：官方把摘要做成 `fileLink`，点了用侧栏预览打开。
      // 这里只在路径确实存在（不是命令行/查询串）时才挂链接——`tool.command` 类
      // 的 detail 点了会去打开一个不存在的文件。
      onDetailActivate={
        tool.detail && !tool.command
          ? () => post({ type: "openFile", path: tool.detail as string, diff: false })
          : undefined
      }
      meta={meta}
      open={open}
      onToggle={() => {
        if (hasBody) node.setOpen(!open, running);
      }}
    >
      {runningBody ? (
        <div ref={runningRef} className="row-body mono row-running">
          <div className="row-running-head">
            {/* 与思考节点同一个发光标记：一眼看出「还在跑」
                （.icon-brand 提供鲸鱼的独属蓝，.icon-glow 只负责呼吸） */}
            <span className="icon-glow icon-brand" aria-hidden>
              <IconDsh size={11} />
            </span>
            <span>{fill(texts.toolRunning, { duration: formatDuration(elapsed) })}</span>
          </div>
          {tool.command ? <div className="row-running-command">{tool.command}</div> : null}
          <div className="row-running-hint">{texts.toolRunningHint}</div>
        </div>
      ) : null}
      {hasDiff && diff ? (
        <div ref={diffRef} className="row-body diff-body">
          {/* 写入节点固化单栏：整篇新建，双栏会有一整列是空的（用户 2026-09-16 口径） */}
          <DiffView hunks={diff} layout={diffLayout} unified={classifyTool(tool.name) === "write"} />
        </div>
      ) : null}
      {/* 工具卡（官方 `ToolRow` 的 card 槽）：读取 / 搜索 / 终端 / 网页。
          有卡片时**不渲染 IN/OUT**——参数 JSON 就此不再出现在展开区，这与用户
          2026-09-16 的口径一致（工具的展开区重在与可读性 + 输出内容）。 */}
      {hasCard && card ? (
        <div ref={bodyRef} className="row-body card-body">
          <ToolCardBody card={card} />
        </div>
      ) : null}
      {/* `run_code`：正文是代码块，**下面照旧给 OUT**（官方对 code 变体只省掉 IN） */}
      {codeCard ? (
        <div ref={bodyRef} className="row-body card-body">
          <CodeBlock lang="typescript" code={codeCard.code} />
        </div>
      ) : null}
      {/* 通用工具（官方 GenericToolCard）的展开体按 IN/OUT 两段呈现：
          「输入」= 模型实际传的参数（缩进后的 JSON，官方 `formatToolBody` 同义），
          「输出」= 工具返回的正文（出错时整段染红）。
          官方对 diff 类工具直接给 DiffBlock、对上面那些给了卡片的工具也给各自的卡，
          所以这里只在**两者都没有**时渲染——否则同一份内容会出现两次；
          `run_code` 例外：它的输入已经是上面的代码块（官方同样不再渲染 IN）。 */}
      {showIoCard ? (
        <div ref={ioRef} className="row-body io-card">
          {inputText && !codeCard ? (
            <div className="io-section">
              <span className="io-label">{texts.toolInput}</span>
              <span className="io-text mono">{inputText}</span>
            </div>
          ) : null}
          {inputText && !codeCard && showOutput ? <span className="io-divider" aria-hidden /> : null}
          {showOutput ? (
            <div className="io-section">
              <span className="io-label">{texts.toolOutput}</span>
              <span className={`io-text mono${tool.status === "error" ? " is-error" : ""}`}>
                {shownOutput}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
      {hasDiff && showOutput ? (
        <div ref={bodyRef} className="row-body mono">
          {shownOutput}
        </div>
      ) : null}
      {/* 退出状态单独一行：只有非零退出码 / 信号才出现，正常退出不占位置。
          终端卡自己带状态胶囊（官方 `TerminalBlock` 的 status pill），
          所以有卡时不再重复画这一行。 */}
      {exitMeta && card?.kind !== "terminal" ? (
        <div className={`row-exit${tool.status === "error" ? " is-error" : ""}`}>{exitMeta}</div>
      ) : null}
      {/* 结果里的图：**只在展开态渲染**（用户 2026-09-21 口径）。
          这里挂的是 `Row` 的 children，`Row` 只在展开时渲染 children，所以「收起不渲染」
          是结构本身保证的，不靠额外的条件判断——也正因为如此，收起态连 `<img>` 都不存在，
          不会替一个看不见的盒子解码图片（`read_image` 多的会话里这是几十张图）。
          来源含 `read_image`、截图等任何工具回带的 image 块（`tool.images`）。 */}
      {tool.images?.length ? (
        <ImageGallery alt={texts.toolImageAlt} sources={tool.images.map((src) => ({ src }))} />
      ) : null}
      {tool.files?.length ? (
        <div className="row-body">
          {tool.files.map((file) => (
            <button
              key={file.path}
              className="lump-btn"
              onClick={(event) => post({ type: "openFile", path: file.path, diff: wantsChanges(event) })}
            >
              <IconExternal size={12} />
              {file.path}
            </button>
          ))}
        </div>
      ) : null}
    </Row>
  );

  // 图片已在展开体里（上面的 children）。历史沿革：2026-09-18 用户报「agent 发来的图
  // 看不到」（`read_image` / 截图这类调用的 tool/result 块就是 `["text","image"]`），
  // 当时把图挪到行**下方**、不经展开态就能看见；2026-09-21 用户改口径为**折叠态不渲染**，
  // 于是挪回展开体——两条口径的差别只在「折叠时渲不渲染」，展开态都要画。
  return row;
}

export function ThinkingRow({
  text,
  streaming,
  durationMs,
  node,
}: {
  text: string;
  streaming?: boolean;
  durationMs?: number;
  /** 展开态与展开意图（由 `Message` 持有，见 `../nodeOpen.ts`）。 */
  node: NodeOpenPort;
}) {
  const texts = useTexts();
  // **恒默认折叠**（官方 `ReasoningRow` 就是 `useState(false)`，运行中也不展开）：
  // 长思考会把正文顶出屏幕，而思考本身只要一行摘要就够——要看全文点开。
  const open = node.open ?? false;
  const bodyRef = useRef<HTMLDivElement>(null);
  // 思考是**流式增长**的：还在流就贴底跟着长（那正是「最新的一句」所在），
  // 流完就不再动位置（见 useStickyBody 的文件头）
  useStickyBody(bodyRef, open, streaming === true, node.openedWhileActive);
  // 流式期间用户划选正文时冻结渲染，否则每来一个 token 选区就没了
  const shownText = useSelectionFreeze(bodyRef, text);
  /**
   * 折叠摘要与官方逐字同口径（`ReasoningRow` 里的 `summary`）：
   * - **流式中取最后一行**（`latestLine`：先去尾部空白，再取最后一个换行之后）——
   *   正在写的思考，最新的一句才是有信息量的那半；
   * - **结束后取第一行**（`firstLine`）；
   * - 两者都**去掉 `**` 标记**（推理里常带 markdown 强调，摘要里露出来很脏）。
   */
  const summary = (streaming ? latestLine(text) : firstLine(text)).replaceAll("**", "");

  return (
    <Row
      // 鲸鱼恒为品牌蓝（.icon-brand，独属色）：思考中叠 .icon-glow 呼吸发光
      // （光同为蓝），结束后保持蓝色静置——不回落成 .row-icon 的灰色，
      // 裸 .icon-glow 也不行（它已不自带颜色）
      icon={
        <span className={streaming ? "icon-glow icon-brand" : "icon-brand"}>
          <IconDsh size={14} />
        </span>
      }
      title={texts.thinking}
      detail={summary}
      meta={durationMs ? formatDuration(durationMs) : undefined}
      open={open}
      onToggle={() => node.setOpen(!open, streaming === true)}
    >
      <div ref={bodyRef} className="row-body">
        {shownText}
      </div>
    </Row>
  );
}

/** 首行（官方 `firstLine`）：第一个换行之前。 */
function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

/** 最后一行（官方 `latestLine`）：先去尾部空白，再取最后一个换行之后。 */
function latestLine(text: string): string {
  const visible = text.trimEnd();
  const newline = visible.lastIndexOf("\n");
  return newline === -1 ? visible : visible.slice(newline + 1);
}

/**
 * 自动载入节点的标签。
 *
 * **标题用官方词汇**（`dsh-client-ui-chat` 的 `ContextInjectionRow`）：系统提示词那条
 * 叫「系统提示词」（`message.systemPrompt`），跨会话召回叫「跨会话召回」
 * （`message.contextRecall`），**其余注入统一叫「上下文注入」**
 * （`message.contextInjection`，用户 2026-09-14 要求与 Web 一致的正是这一条——
 * 我们此前叫「插件上下文」）。
 *
 * 我们比官方多给一层**副标题**：官方在标题右侧只放 source（插件名），我们把
 * 「项目指令 / 技能目录 / 运行时上下文」这类具体来源也写进去——标题一致、信息不减。
 */
function useDescribeInjected(): (injected: InjectedView) => { label: string; detail?: string } {
  const texts = useTexts();
  return (injected) => {
    const plugin = injected.plugin;
    const form = injected.form;
    const kind = injected.sourceKind;

    // 0.1.7-alpha.1 起来源是**生产者自有**的 kind（旧的通用 `plugin` 成员已从契约删除）：
    // 系统提示词是 `system-prompt`，沙箱/审批那类运行时上下文是 `runtime-context`
    // （旧版本是 `plugin:'@deepseek-ai/dsh-system-prompt'` + `form:'snapshot'`——
    // 两个形态都认，协议没有版本协商）。
    if (kind === "system-prompt") {
      return { label: texts.injectedSystemPrompt, detail: plugin };
    }
    // 官方把跨会话召回单独起名（`provenance.role === "recall"`）
    const label = form === "recall" ? texts.injectedRecall : texts.injectedContext;
    if (kind === "runtime-context" || (plugin === "@deepseek-ai/dsh-system-prompt" && form === "snapshot")) {
      return { label, detail: texts.injectedRuntimeContext };
    }
    if (kind === "agent-instructions") {
      return { label, detail: texts.injectedAgentInstructions };
    }
    if (kind === "skill-catalog") {
      return { label, detail: texts.injectedSkillCatalog };
    }
    // 其余（插件注入等）：副标题给来源插件名，与官方那个 source 位一致；
    // `plugin:<包名>` 的包名已在适配器里取出来（见 `adapter.pushInjected`）
    return { label, detail: plugin ?? kind };
  };
}

/**
 * 自动载入的提示词节点（系统提示词 / 插件注入 / 项目指令 / 技能目录…）。
 *
 * 默认收起：这些内容动辄数千字符（技能目录实测 6.9K），展开全部会把对话淹没。
 * 收起时给出标签 + 字数 + 首行摘要，既能一眼看出「这轮被喂了什么」，
 * 又需要点开才占用注意力。
 */
export function InjectedRow({ injected, node }: { injected: InjectedView; node: NodeOpenPort }) {
  const open = node.open ?? false;
  const texts = useTexts();
  const describe = useDescribeInjected();
  const { label, detail } = describe(injected);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 注入节点永远不会「进行中」（它是轮次开始时一次性到达的），所以没有第 4 个参数：
  // 打开即置顶
  useStickyBody(bodyRef, open);
  const shownText = useSelectionFreeze(bodyRef, injected.text);
  const firstLine = injected.text.split("\n").find((line) => line.trim())?.trim() ?? "";

  return (
    <Row
      icon={
        <span className="node-injected">
          <IconPlug size={13} />
        </span>
      }
      title={label}
      detail={detail ?? firstLine}
      meta={texts.injectedChars(formatChars(injected.text.length))}
      open={open}
      onToggle={() => node.setOpen(!open)}
    >
      {/* 按 form 分派的**结构化正文**（官方 `ContextBody` 的 switch (form)）：
          指令逐条列「文件 + 已新增/已更新/已移除」，目录列条目，快照列分节，
          回忆给「保留 N 条 · 省略 M 条」。形状认不出时这些块不渲染，
          下面的正文原样兜底——不显示半截列表。 */}
      <InjectedFormBody source={injected.source} />
      <div ref={bodyRef} className="row-body mono row-injected">
        {shownText}
      </div>
    </Row>
  );
}

/** 上下文条目的 per-form 正文（官方 `ContextBody` 的对应部分）。 */
function InjectedFormBody({ source }: { source?: InjectedSourceView }) {
  const texts = useTexts();
  if (!source) return null;

  if (source.changes?.length) {
    return (
      <div className="row-body ctx-body">
        <div className="ctx-title">{texts.contextInstructions}</div>
        <ul className="ctx-list">
          {source.changes.map((change) => (
            <li key={change.path}>
              <span className="ctx-state">
                {change.action === "remove"
                  ? texts.contextRemoved
                  : change.action === "set"
                    ? texts.contextAdded
                    : texts.contextUpdated}
              </span>
              <span className="ctx-value">{change.path}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (source.entries?.length) {
    const shown = source.entries.slice(0, MAX_CATALOG_ENTRIES);
    return (
      <div className="row-body ctx-body">
        <div className="ctx-title">{texts.contextCatalogReplaced}</div>
        <ul className="ctx-list">
          {shown.map((entry) => (
            <li key={entry.name}>
              <span className="ctx-value">{entry.name}</span>
              <span className="ctx-desc">{entry.description}</span>
            </li>
          ))}
        </ul>
        {shown.length < source.entries.length ? (
          <div className="ctx-more">
            {texts.contextCatalogMore(source.entries.length - shown.length)}
          </div>
        ) : null}
      </div>
    );
  }

  if (source.sections?.length) {
    return (
      <div className="row-body ctx-body">
        <div className="ctx-title">{texts.contextSnapshotSupersedes}</div>
        {source.sections.map((section) => (
          <div className="ctx-section" key={section.name}>
            <div className="ctx-sub">{section.name}</div>
            <div className="ctx-desc">{section.text}</div>
          </div>
        ))}
      </div>
    );
  }

  if (source.senderSessionId) {
    return (
      <div className="row-body ctx-body">
        <div className="ctx-title">{texts.contextRelayFrom(source.senderSessionId)}</div>
      </div>
    );
  }

  if (source.references?.length) {
    return (
      <div className="row-body ctx-body">
        <ul className="ctx-list">
          {source.references.map((reference) => (
            <li key={reference.label}>
              <span className="ctx-value">{reference.label}</span>
              <span className="ctx-desc">
                {texts.contextRecallCounts(reference.retainedMessages, reference.omittedMessages)}
                {reference.truncated ? ` · ${texts.contextRecallTruncated}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return null;
}

/** 字数：上千用 K，与 token 的展示口径分开（这是字符数，不是 token）。 */
function formatChars(chars: number): string {
  if (chars >= 10_000) return `${Math.round(chars / 1000)}K`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return String(chars);
}

export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const texts = useTexts();
  // 服务端给了本地化展示文案就用它（0.1.7-rc.2 起），否则退回审计用的原文——
  // 与官方 `ApprovalPanel` 同口径；语言在渲染时取，切语言即时生效
  const reason = pickLocalizedText(approval.displayReason, useLocale()) ?? approval.reason;
  const waiting = approval.state === "waiting";
  const verdict =
    approval.state === "approved"
      ? texts.approvalApproved
      : approval.state === "rejected"
        ? texts.approvalRejected
        : approval.state === "expired"
          ? texts.approvalExpired
          : undefined;

  return (
    <div className="approval">
      <div className="approval-title">
        <IconAlert size={14} />
        <b>{waiting ? texts.approvalTitle : verdict}</b>
        <span className="row-detail">{resolveText(approval.toolName, texts)}</span>
      </div>
      {reason ? <div className="approval-detail">{reason}</div> : null}
      {approval.detail ? (
        <div className="approval-detail">{resolveText(approval.detail, texts)}</div>
      ) : null}
      {waiting ? (
        <div className="approval-actions">
          <button
            className="btn btn-primary"
            onClick={() => post({ type: "answerApproval", requestId: approval.requestId, approved: true })}
          >
            {texts.allow}
          </button>
          {approval.allowAlways ? (
            <button
              className="btn"
              onClick={() =>
                post({ type: "answerApproval", requestId: approval.requestId, approved: true, always: true })
              }
            >
              {texts.allowAlways}
            </button>
          ) : null}
          <button
            className="btn btn-ghost"
            onClick={() => post({ type: "answerApproval", requestId: approval.requestId, approved: false })}
          >
            {texts.reject}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 计划审阅卡（`exit_plan_mode`）。
 *
 * 模型在计划模式里把整份计划交上来请你放行，服务端把它变成一次普通提问
 * （`user-questions/request` + `intent.kind === "plan-review"`、计划正文在
 * `detail` 里，见 `webview/planReview.ts`）。官方给它一套**专属布局**
 * （`dsh-client-ui-user-questions` 的 `PlanReviewPanel`）：
 *
 * - 顶部一条 warn 色**条带**（「计划待审」），
 * - 中间是**可滚动的计划正文**（markdown，与助手正文同一个渲染器），
 * - 底部一行决定：`去聊天里说` / `拒绝` / `确认执行`。
 *
 * 两条与官方逐字对齐、且**不能想当然**的口径：
 *
 * 1. **按钮上显示的是界面语言，发出去的是提问方的 label**。官方三个按钮的
 *    文案全部走 locale（`plan.approve` / `plan.decline` / `plan.discuss`），
 *    而 `onClick` 提交的是 `review.approve.label` / `review.decline.label`——
 *    判定在 `dsh-plan-mode` 那边是「逐字等于意图点名的 label」的严格比较，
 *    把界面语言当答案发回去，模型只会收到「用户选择继续规划」。
 * 2. **「去聊天里说」不是答案，是撤回**：发 `ASK_CANCELLED` 的 `rejected`，
 *    让等待方带着「用户想直接说话」的语义收场（编辑器归位）。
 *
 * 条带与底部决定行**不参与滚动**，中间正文自己滚（外层输入区的限高对这张卡
 * 让位，见 `Composer.tsx` 的 `is-plan-review`）：计划动辄几百行，决定按钮
 * 绝不能被滚走。
 */
export function PlanReviewCard({
  question,
  review,
}: {
  question: QuestionView;
  review: PlanReviewView;
}) {
  const texts = useTexts();
  const decide = (label: string) =>
    post({
      type: "answerQuestion",
      requestId: question.requestId,
      answers: [planReviewAnswer(review, label)],
    });
  // 提到局部变量里：`review.decline` 在 JSX 的条件分支里 TS 收不窄，
  // 直接写 `review.decline.label` 得挂个 `!`（官方那边也是先取出来）
  const decline = review.decline;
  return (
    <section className="plan-review" aria-label={review.question}>
      <div className="plan-review-strip">
        <span className="plan-review-dot" aria-hidden />
        {texts.planReviewHeader}
      </div>
      <div className="plan-review-body">
        <Markdown text={review.plan} />
      </div>
      <div className="plan-review-footer">
        <button
          className="btn btn-ghost plan-review-discuss"
          onClick={() => post({ type: "cancelQuestion", requestId: question.requestId })}
        >
          <IconPencil size={14} />
          {texts.planReviewDiscuss}
        </button>
        <div className="plan-review-actions">
          {decline ? (
            <button className="btn" title={decline.description} onClick={() => decide(decline.label)}>
              {texts.planReviewDecline}
            </button>
          ) : null}
          <button
            className="btn btn-primary"
            title={review.approve.description}
            onClick={() => decide(review.approve.label)}
          >
            {texts.planReviewApprove}
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * 问卷卡片（`ask_user_question`）。
 *
 * **记录形态现在挂在工具节点上**（用户 2026-09-24 口径：答案与问卷合并成一个节点）：
 * 适配器从调用参数取题目、从工具结果取答案，折进 `tool.question`，由 `Message` 直接
 * 用这个组件把那个 `ask_user_question` 节点画成记录卡（见 `Message.renderSegment`）。
 * 组件本身不区分「谁来渲染」——独立那条 `question` 段现在只剩两种用途：**等待回答**
 * 时由输入区接管的那张交互卡，以及计划审阅（`exit_plan_mode`）的记录（它的题目只在
 * waterfall 里，durable 参数里没有，所以不参与合并）。
 *
 * 四种形态：
 * 1. **待回答 · 一次展开**（题目数不超过 `dshChat.questionBatch`）：与原来一样，
 *    所有题目一起铺开，全部作答后才能提交；
 * 2. **待回答 · 依次问答**（题目数更多）：一次一道，带「第 N / M 题」与上一题 /
 *    下一题；单选点一下就前进（官方 `choose` 同口径），最后一题变成提交；
 * 3. **已答完**：默认**收缩成一行**（`已作答 N 题`），点行头可再展开看当时的题目
 *    与**用户当时选了什么**——答案取自 `question.answers`（宿主写进卡片的数据），
 *    不是组件自己的 state：换会话回来、另一个窗口答的、页面重载之后，本地 state
 *    都是空的（用户 2026-09-15 报的「展开后没有显示用户的回答」就是这个）；
 * 4. **已撤回**（`cancelled`，没人回答过）：同样收缩成一行（`已取消 N 题`）。
 *
 * 自定义回答是一个**组合组件**（用户 2026-09-15 口径）：一行两件东西——标题
 * 「自定义回答」+ 一个**可多行**的输入框。整行**是一个整体**，与普通选项同权：
 * - 它是选项列表的最后一行（同一个 `.question-option` 外观）；
 * - 点它（标题或行的空白处）= 选中它，**再点一下 = 取消选中**；单选时选中它会取消
 *   已选选项（互斥），多选时与其它已选项并存；
 * - 在输入框里打字同样算选中它（官方 `draftCustom` 同口径）；
 * - **选中别的选项不会清空输入框里的内容**：只取消它的选中态，文字留着，想换回来
 *   再点它一下即可（与官方 `choose` / `draftCustom` 的刻意差异——官方是互相清空的，
 *   用户明确要保留内容）；
 * - 输入框里 Enter 是换行（多行输入需要它），**Ctrl/Cmd+Enter** 才是「答完前进 / 提交」。
 *
 * `batch` 由宿主下发（webview 读不到 VS Code 配置），缺省用默认阈值。
 */
export function QuestionCard({
  question,
  batch,
}: {
  question: QuestionView;
  batch?: number;
}) {
  const texts = useTexts();
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  /**
   * 自定义回答**这个组合组件被选中了没有**。
   *
   * 它与「输入框里有没有字」是两件事（用户 2026-09-15 口径）：选中别的选项只取消
   * 它的选中态、**不清空**输入框，所以光看文字判断「选没选它」是不对的。
   */
  const [customChosen, setCustomChosen] = useState<Record<string, boolean>>({});
  const [index, setIndex] = useState(0);
  // 已答完的问卷默认收缩；用户点开看记录后不再自动收起
  const [expanded, setExpanded] = useState(false);
  /**
   * 「放弃整组问题」已点下（官方 `cancelFlow` 的 busy='cancel' 同一刻）：
   * 收场 patch 回来之前先把提交 / 放弃两个按钮按住，免得这段窗口里重复发帧、
   * 或「放弃」之后又补了一刀提交。宿主侧对这条链路是无条件收场（见 controller
   * 的 `cancelQuestion`：`settle` 命中就 `cancelEvent`），所以不做失败恢复——
   * 万一收场真的没来，切走再切回来（组件重挂载）这个状态就重置了。
   */
  const [closing, setClosing] = useState(false);
  const waiting = question.state === "waiting";
  const cancelled = question.state === "cancelled";
  const items = question.items;
  const mode = questionMode(items.length, batch);
  const interactive = waiting;
  const stepped = interactive && mode === "stepped";
  // 依次问答只渲染当前这一题；题目被服务端更新（数组变短）时夹住下标，
  // 免得 `items[current]` 变成 undefined 把整张卡渲染成空白
  const current = stepped ? Math.min(index, Math.max(0, items.length - 1)) : 0;
  const shown = stepped ? items.slice(current, current + 1) : items;

  /**
   * 收场后的答案**以宿主写进卡片的那份为准**。
   *
   * 本地 state 只在「本窗口刚提交、工具结果还没回来」的窗口里有意义；一旦
   * `question.answers` 到了（本窗口提交时宿主立刻回填，或会话监听从工具结果里
   * 取到），它就是权威值。
   */
  const selectedOf = (itemId: string): string[] =>
    question.answers?.[itemId]?.selected ?? selected[itemId] ?? [];
  const customOf = (itemId: string): string =>
    question.answers?.[itemId]?.custom ?? custom[itemId] ?? "";

  /**
   * 自定义回答这一行**选中了没有**。
   *
   * 宿主已有答案时以答案为准：答案里那串自定义文本非空就说明当时选的就是它
   * （本地 state 在重挂载 / 另一个窗口答的情况下是空的，只能靠 answers）。
   */
  const customChosenOf = (itemId: string): boolean => {
    const answered = question.answers?.[itemId];
    if (answered) return (answered.custom ?? "").trim() !== "";
    return customChosen[itemId] === true;
  };

  // 折成两个「按题目 id 归档」的表再交给 `questionFlow` 那几个纯函数：
  // 判据（选了没选、能不能提交）只有一份，断言也钉在那边。
  // 依赖就是这三样——`selectedOf` / `customOf` 是每次渲染重建的闭包，
  // 把它们列进依赖等于每帧重算，所以按「数据源」列。
  const effectiveSelected = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const item of items) map[item.id] = selectedOf(item.id);
    return map;
  }, [items, question.answers, selected]);
  const effectiveCustom = useMemo(() => {
    const map: Record<string, string> = {};
    // 只有**选中了**它，输入框里的字才算这一题的答案：取消选中之后文字还在，
    // 但它已经不是用户选的答法了（见 `customChosen` 的注释）
    for (const item of items) map[item.id] = customChosenOf(item.id) ? customOf(item.id) : "";
    return map;
  }, [items, question.answers, custom, customChosen]);

  const toggle = (itemId: string, label: string, multi?: boolean) => {
    setSelected((prev) => {
      const active = prev[itemId] ?? [];
      const next = multi
        ? active.includes(label)
          ? active.filter((v) => v !== label)
          : [...active, label]
        : [label];
      return { ...prev, [itemId]: next };
    });
    // 单选：选了普通选项 = 自定义回答不再是这一题的答案 → 只取消它的**选中态**。
    // **不清空输入框**（用户 2026-09-15 口径）：文字留着，想换回来再点它一下
    if (!multi) setCustomChosen((prev) => ({ ...prev, [itemId]: false }));
    // 单选：选中即前进（官方 `choose` 对非多选项就是 index + 1），
    // 最后一题不动——它下面是提交按钮
    if (stepped && !multi && current < items.length - 1) setIndex(current + 1);
  };

  /**
   * 自定义回答那一行的「选中 / 取消选中」。
   *
   * 与普通选项同一套语义：单选选中它会取消已选选项（互斥），多选与其它选项并存；
   * 再次点它是取消选中（用户 2026-09-15 明确要「可以被选中和被取消选中」）。
   * 取消选中**不动输入框里的文字**。
   */
  const toggleCustom = (itemId: string, multi?: boolean) => {
    const next = !customChosenOf(itemId);
    setCustomChosen((prev) => ({ ...prev, [itemId]: next }));
    if (next && !multi) setSelected((prev) => ({ ...prev, [itemId]: [] }));
  };

  /**
   * 「去写自定义回答」那条路：**只补上选中，绝不取消**（用户 2026-09-19 口径）。
   *
   * 点（或 Tab 进）编辑区是去写回答，不是去取消；已经在选中态时什么都不做。
   * 用**函数式更新**读最新值：Focus 与 MouseDown 可能前后脚到，读渲染闭包里的
   * 旧值会把「刚选中」又翻回去（与 `toggleCustom` 的切换语义不同，这里只置真）。
   */
  const chooseCustom = (itemId: string, multi?: boolean) => {
    setCustomChosen((prev) => (prev[itemId] === true ? prev : { ...prev, [itemId]: true }));
    if (!multi) {
      setSelected((prev) => ((prev[itemId]?.length ?? 0) === 0 ? prev : { ...prev, [itemId]: [] }));
    }
  };

  /** 写自定义回答：**打字即选中它**（官方 `draftCustom` 同口径）。 */
  const writeCustom = (itemId: string, value: string, multi?: boolean) => {
    setCustom((prev) => ({ ...prev, [itemId]: value }));
    setCustomChosen((prev) => ({ ...prev, [itemId]: true }));
    if (!multi) setSelected((prev) => ({ ...prev, [itemId]: [] }));
  };

  const submit = () => {
    post({
      type: "answerQuestion",
      requestId: question.requestId,
      answers: items.map((item) => {
        const custom = effectiveCustom[item.id]?.trim() ?? "";
        return {
          id: item.id,
          // 单选 + 自定义文本 ⇒ custom 覆盖、selected 为空（官方口径）
          selected: custom === "" || item.multiSelect === true ? (effectiveSelected[item.id] ?? []) : [],
          custom: custom || undefined,
        };
      }),
    });
  };

  /**
   * 主动放弃整份问卷（官方 `QuestionComposer` 头部的 ✕ / `nav.cancel`，2026-09-21
   * 用户要求与 web 端同步）。**不是回答**：宿主照官方客户端的形状回
   * `rejected` + `UserQuestionError`/`ASK_CANCELLED`（见 controller 的
   * `cancelQuestion`——计划审阅卡的「去聊天里说」走的就是同一条结算），
   * 等待方带着「用户放弃了」收场，卡片经 `cancelEvent` 落成「已取消 N 题」的记录行。
   */
  const dismiss = () => {
    setClosing(true);
    post({ type: "cancelQuestion", requestId: question.requestId });
  };

  /**
   * 自定义回答的编辑框里按 **Ctrl/Cmd+Enter**：依次问答时「答完就前进 / 最后一题提交」
   * （官方 `continueFromCustom` → `continueFlow` 的同一条语义）。
   *
   * 与官方的差异只有快捷键：官方的编辑框是**自增高但仍单行语义**的（Enter 直接提交），
   * 而这里的输入框要支持多行，Enter 必须留给换行。
   *
   * 一次展开的模式下什么都不做——那时提交按钮就在下面，快捷键不该有隐藏语义。
   */
  const continueFromCustom = (itemId: string) => {
    if (!stepped) return;
    if (!isAnswered(effectiveSelected[itemId], effectiveCustom[itemId])) return;
    if (current < items.length - 1) setIndex(current + 1);
    else if (canSubmit(items, effectiveSelected, effectiveCustom)) submit();
  };

  /** 题目正文（两种形态共用）。 */
  const renderItem = (item: QuestionView["items"][number]) => {
    const customValue = customOf(item.id);
    const customSelected = customChosenOf(item.id);
    return (
      <div className="question-item" key={item.id}>
        <div className="question-head">
          <IconQuestion size={11} /> {item.header ?? texts.questionHead}
        </div>
        <div className="question-text">{item.question}</div>
        {/* 题目的补充正文（`detail`）：官方把它排在选项**上方**、用与助手正文同一个
            markdown 渲染器（`QuestionComposer` 的 `.detail`）。计划审阅的计划正文
            就走这里；此前适配器把这个字段整个丢了，界面上只剩一句问句。 */}
        {item.detail ? (
          <div className="question-detail">
            <Markdown text={item.detail} />
          </div>
        ) : null}
        <div className="question-options">
          {item.options.map((option) => {
            const isSelected = selectedOf(item.id).includes(option.label);
            return (
              <button
                key={option.label}
                className={`question-option${isSelected ? " is-selected" : ""}`}
                disabled={!interactive}
                onClick={() => toggle(item.id, option.label, item.multiSelect)}
              >
                <span className="question-option-label">{option.label}</span>
                {option.description ? (
                  <span className="question-option-desc">{option.description}</span>
                ) : null}
              </button>
            );
          })}
          {/* 自定义回答：列表里的最后一行（官方把 `customRow` 放在选项之后、
              同一个容器里）。它是一个**组合组件**——标题 + 多行输入框，整行一起
              被选中 / 取消选中（见组件头的注释）。记录态只在**当时真选了它**时才
              补这一行（没选过的空编辑框在记录里只是噪音）。 */}
          {waiting ? (
            interactive ? (
              <div
                className={`question-option question-custom${customSelected ? " is-selected" : ""}`}
              // 点这一行的**输入框之外**部分 = 选中 / 取消选中它；点输入框是去编辑。
              // 编辑区那条路**也要选中它**（用户 2026-09-19 口径）：以前这里直接放行，
              // 于是「点进编辑区」不会选中该自定义回答（只有打字才选中，见 writeCustom），
              // 单选时它看着像没被选上。现在点进去先补上选中，再放行给输入框
              // （放行 = 不 preventDefault，光标才会落到点击处）。
              onMouseDown={(event) => {
                if ((event.target as Element).closest(".question-input")) {
                  chooseCustom(item.id, item.multiSelect);
                  return;
                }
                event.preventDefault();
                const next = !customSelected;
                toggleCustom(item.id, item.multiSelect);
                // 选中之后把光标送进输入框：这一步的目的就是去写回答
                if (next) {
                  event.currentTarget.querySelector<HTMLTextAreaElement>(".question-input")?.focus();
                }
              }}
            >
              <span
                className="question-custom-title"
                role="button"
                tabIndex={0}
                aria-pressed={customSelected}
                onKeyDown={(event) => {
                  // 键盘上同一件事：Enter / 空格 = 选中或取消选中
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  toggleCustom(item.id, item.multiSelect);
                }}
              >
                {texts.questionCustomTitle}
              </span>
              <textarea
                className="question-input"
                // 多行输入：Enter 换行（见下面的 onKeyDown），框本身给两行高、可往下拉
                rows={2}
                aria-label={texts.questionCustomAria}
                placeholder={texts.questionPlaceholder}
                value={customValue}
                onChange={(event) => writeCustom(item.id, event.target.value, item.multiSelect)}
                // 焦点进到编辑区同样算「选了它」（键盘 Tab、程序性 focus 都走这里）。
                // 只置真不切换，见 `chooseCustom`。
                onFocus={() => chooseCustom(item.id, item.multiSelect)}
                onKeyDown={(event) => {
                  // 输入法组字中的 Enter 是在选字，不是快捷键
                  if (event.nativeEvent.isComposing) return;
                  // ESC：**先归问卷管**。它是「取消这次自定义回答」，不是「停止生成」——
                  // 不拦的话窗口层那个兜底监听会把正在跑的这一轮直接中止，用户
                  // 正在写的半截答案连同卡片一起被结算掉。文字按既有口径保留
                  // （与再点一下取消选中同一条规则：只取消选中，不清空内容）。
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    if (customSelected) toggleCustom(item.id, item.multiSelect);
                    return;
                  }
                  // 多行输入：Enter（含 Shift+Enter）留给换行，Ctrl/Cmd+Enter 才继续
                  if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
                  event.preventDefault();
                  continueFromCustom(item.id);
                }}
              />
              </div>
            ) : customSelected ? (
              // 只读：不给输入框，但**真选过**的自定义回答照旧当记录显示
              <div className="question-option question-custom is-selected">
                <span className="question-custom-title">{texts.questionCustomTitle}</span>
                <span className="question-option-label">{customValue}</span>
              </div>
            ) : null
          ) : customSelected ? (
            <div className="question-option question-custom is-selected">
              <span className="question-custom-title">{texts.questionCustomTitle}</span>
              <span className="question-option-label">{customValue}</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  // 已答完 / 已撤回：收缩成一行（行头可点开复看题目与当时的回答）。用与工具行
  // 同一套 `Row`，视觉语言不分家：这同样是「对话里发生过的一件事」。
  // 计划审阅的记录换个标题：它那次不是「提问」而是「把计划交给人放行」，
  // 展开体里除了选项还有整份计划（`detail`）。
  if (!waiting) {
    return (
      <Row
        icon={
          <span className="node-icon node-others">
            <IconQuestion size={13} />
          </span>
        }
        title={planReviewOf(items) ? texts.planReviewHeader : texts.questionHead}
        detail={
          cancelled && !question.answers
            ? texts.questionCancelled(items.length)
            : texts.questionAnswered(items.length)
        }
        open={expanded}
        onToggle={() => setExpanded(!expanded)}
      >
        <div className="question is-record">{items.map(renderItem)}</div>
      </Row>
    );
  }

  const currentAnswered = isAnswered(
    effectiveSelected[items[current]?.id ?? ""],
    effectiveCustom[items[current]?.id ?? ""],
  );
  const ready = canSubmit(items, effectiveSelected, effectiveCustom);

  return (
    <div className="question">
      {shown.map(renderItem)}
      {/* 只读（子代理记录）：不画提交行——那份记录属于另一个会话 */}
      {interactive ? (
        <div className="question-footer">
          {/* 放弃整组问题（官方卡头 ✕ 的同一条结算，放这里是因为收场语义对**整份**
              问卷生效——放在题头旁边会被误读成「只关这一题」）。点下后输入区让位、
              卡片落成「已取消 N 题」的记录行。 */}
          <button
            type="button"
            className="btn btn-ghost question-dismiss"
            title={texts.questionDismissAll}
            aria-label={texts.questionDismissAll}
            disabled={closing}
            onClick={dismiss}
          >
            <IconClose size={12} />
            {texts.questionDismissAll}
          </button>
          {stepped ? (
            <div className="question-pager">
              <span className="question-step">{texts.questionStep(current + 1, items.length)}</span>
              <button
                className="btn btn-ghost"
                disabled={current === 0}
                onClick={() => setIndex(Math.max(0, current - 1))}
              >
                {texts.questionPrev}
              </button>
              {/* 最后一题的「下一题」就是提交，不再单独放一个按钮（与官方
                  `submit`/`action.next` 同一个按钮同一条语义） */}
              {current < items.length - 1 ? (
                <button
                  className="btn"
                  disabled={!currentAnswered}
                  onClick={() => setIndex(Math.min(items.length - 1, current + 1))}
                >
                  {texts.questionNext}
                </button>
              ) : null}
            </div>
          ) : null}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={!ready || closing} onClick={submit}>
            {texts.submit}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 助手消息里的图片块（模型输出 / 工具回带的图）。
 *
 * 与工具结果的图库同一种呈现（共用 `ImageGallery`），但它是**消息正文的一部分**，
 * 不是某个工具行的展开体，所以单独一个行组件。加载中 `images` 全是空串 →
 * 组件自己返回 null，避免先闪一个 `src=""` 的碎图图标。
 */
export function MessageImages({ images }: { images: string[] }) {
  const texts = useTexts();
  return <ImageGallery alt={texts.messageImageAlt} sources={images.map((src) => ({ src }))} />;
}

/**
 * 轮尾「用时 X」胶囊 + 点开的明细（官方 `TurnTimePanel`）。
 *
 * 官方把它放在轮尾操作条的 `usageAction` 槽里（不算独立一行）：最新一轮常显、
 * 其余轮悬停出现。点开是一张明细卡：**本轮总用时 / 输出速度（TPS）/ 首 token 用时**，
 * 三行都按官方 `message.turnTime.*` 的文案。
 *
 * 为什么不做成时时跳动的秒表：工具行本来就各自显示实时耗时（那是本扩展的信息增量），
 * 轮次总用时只在**轮次结束时**才有意义——进行中算不出总数，跳动的数字也只是噪音。
 */
export function TurnStatsButton({ stats }: { stats: TurnStatsView }) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const speed =
    stats.tokensPerSecond !== undefined ? formatTps(stats.tokensPerSecond) : undefined;
  const duration = texts.turnClock(stats.ranForMs);
  return (
    <span className="turn-stats">
      <button
        type="button"
        className="turn-stats-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={texts.turnTimeTitle}
        onClick={() => setOpen(!open)}
      >
        <IconClock size={12} />
        <span className="turn-stats-label">{texts.turnRanFor(duration)}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} align="right">
        <div className="turn-stats-panel" role="dialog" aria-label={texts.turnTimeTitle}>
          <div className="turn-stats-title">{texts.turnTimeTitle}</div>
          <dl className="turn-stats-rows">
            <dt>{texts.turnTimeDuration}</dt>
            <dd>{duration}</dd>
            {speed !== undefined ? (
              <>
                <dt>{texts.turnTimeSpeed}</dt>
                <dd>{texts.tokensPerSecond(speed)}</dd>
              </>
            ) : null}
            {stats.ttftMs !== undefined ? (
              <>
                <dt>{texts.turnTimeTtft}</dt>
                <dd>{texts.turnLatency(stats.ttftMs)}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </Popover>
    </span>
  );
}

/** 输出速度的数值：官方 `formatTokensPerSecond` 的口径（一位小数）。 */
export function formatTps(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * 连续过程折叠按钮（官方 `TurnProcessNodeView`）。
 *
 * 一轮里**最后那段正文之外**的一切（中途正文、思考、工具、上下文注入、提示、交互卡…）
 * 折成这一枚按钮：标签是「N 次工具调用 · K 个 subagent」，右侧一个朝下的 chevron，
 * 点开把成员铺回来。正文之后若还有够长的过程，那边会再有一枚；各自开合。
 * 口径见 `../turnProcess.ts` 的文件头。官方是 `<button aria-expanded>`，这里照做
 * ——键盘可达、无障碍状态正确。
 */
export function TurnProcessRow({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" className="turn-process" aria-expanded={open} onClick={onToggle}>
      <span className="turn-process-label">{label}</span>
      <IconChevronDown size={14} className="turn-process-chevron" />
    </button>
  );
}

/**
 * 认不出的内容块（官方渲染链 default 分支的 `JsonBlock`）。
 *
 * 标签是「未知内容块」（官方 `message.unknownBlock` 逐字），detail 给出块类型，
 * 展开后是内容本身。默认收起——正常轮次里它不该出现，出现了就该是一条**看得见的
 * 记录**而不是消失在界面上。
 */
export function UnknownBlockRow({
  block,
  node,
}: {
  block: { type: string; json: string };
  /** 展开态与展开意图（由 `Message` 持有，见 `../nodeOpen.ts`）。 */
  node: NodeOpenPort;
}) {
  const texts = useTexts();
  const open = node.open ?? false;
  return (
    <Row
      icon={
        <span className="node-icon node-others">
          <IconQuestion size={14} />
        </span>
      }
      title={texts.unknownBlock}
      detail={block.type}
      open={open}
      onToggle={() => node.setOpen(!open)}
    >
      <div className="row-body mono">{block.json}</div>
    </Row>
  );
}

export function NoticeRow({ level, text }: { level: "info" | "warn" | "error"; text: string }) {
  const texts = useTexts();
  const cls = level === "error" ? "notice notice-error" : level === "warn" ? "notice notice-warn" : "notice";
  return <div className={cls}>{resolveText(text, texts)}</div>;
}

/**
 * 斜杠命令节点（`command/run` ↔ `command/done`）。
 *
 * 用与工具行同一套 `Row`：命令和工具一样是「做了一件事」，视觉语言不该分家。
 * 图标复用 `IconSlash`；结果文案来自处理器（服务端给的英文原文），出错时染红。
 */
export function CommandRow({ command, node }: { command: CommandRunView; node: NodeOpenPort }) {
  const texts = useTexts();
  const open = node.open ?? false;
  const failed = command.state === "error";
  const bodyRef = useRef<HTMLDivElement>(null);
  // 命令与工具同口径：还在跑就贴底（结果一行行在写），跑完回到顶部
  useStickyBody(bodyRef, open, command.state === "running", node.openedWhileActive);
  return (
    <Row
      // 运行中的命令与工具行同等待遇：行首图标呼吸发光（同节点色），
      // 而不是 7px 小圆点；结束保持静态彩色。同样恒带 .node-icon，
      // 免得完成时行首图标跳一下（与 ToolRow 同一个坑）
      icon={
        <span className={`node-icon node-command${command.state === "running" ? " icon-glow" : ""}`}>
          <IconSlash size={13} />
        </span>
      }
      tone={failed ? "error" : undefined}
      title={`/${command.name || texts.commands}`}
      detail={command.args}
      meta={failed ? texts.commandFailed : command.state === "running" ? texts.commandRunning : undefined}
      open={open}
      onToggle={() => node.setOpen(!open, command.state === "running")}
    >
      <div ref={bodyRef} className="row-body mono row-command">
        <div className="row-command-line">{`/${command.name}${command.args ? ` ${command.args}` : ""}`}</div>
        {command.text ? <div className="row-command-result">{command.text}</div> : null}
      </div>
    </Row>
  );
}

/**
 * 轮尾的文件芯片行：本轮改动过的文件（`produced`）与显式申报的交付文件
 * （`deliverables/presented`）。
 *
 * 两者分开成两行、各有标签，因为来源不同：前者从成功的写类调用推导，后者是
 * `present` 工具的申报。默认只铺到上限（与官方 ProducedFiles 相同），多余的收成
 * 末尾一条 `+ N 文件`；点它展开全部文件，再点一次「收起」恢复（官方 produced 行
 * 只有静态计数，展开/收起是扩展自己的便利能力，交互形态与官方交付行的
 * 展开/收起按钮一致）。
 *
 * 芯片的**普通点击是看改动**（`diff`，宿主有改动就开 VS Code 的对比窗口），
 * 按住修饰键时才直接打开文件本身——两行用同一套点击语义，同一个文件不会因为
 * 模型申报没申报交付而行为不同（见 `wantsChanges`）。
 */
export function FileChips({
  label,
  paths,
  kinds,
}: {
  label: string;
  paths: { path: string; description?: string }[];
  /** 芯片路径 → 改动种类（宿主按 git 状态判定，查不到 = 还没分类完，不标记号）。 */
  kinds?: Record<string, FileChangeKind>;
}) {
  const texts = useTexts();
  // 每行独立记忆展开态；消息重渲染（新 segment 追加）不重置
  const [expanded, setExpanded] = useState(false);
  // 收起按钮的显隐只看「有没有被藏过的文件」：展开后 shown 就是全部，
  // 若按 remainder 判断，展开态会把「收起」也一起藏掉（只能展开不能收缩）
  const hasMore = paths.length > SHOWN_FILES;
  const shown = expanded ? paths : paths.slice(0, SHOWN_FILES);
  const remainder = paths.length - SHOWN_FILES;
  return (
    <div className="file-chips">
      <span className="file-chips-label">{label}</span>
      {shown.map((file) => {
        const kind = kinds?.[file.path];
        const deleted = kind === "deleted";
        return (
          <button
            key={file.path}
            className={`file-chip${deleted ? " is-deleted" : ""}`}
            title={
              deleted
                ? `${file.path}\n${texts.fileDeletedHint}`
                : file.description
                  ? `${file.description}\n${texts.openChangesHint}`
                  : `${file.path}\n${texts.openChangesHint}`
            }
            // 无障碍标题走词典：旧写法在这里用模板串硬拼中文全角括号
            // （`${path}（${...}）`），英文界面下会露出全角括号
            aria-label={
              deleted ? texts.deletedFileAria(file.path) : texts.openChangesAria(file.path)
            }
            onClick={(event) => post({ type: "openFile", path: file.path, diff: wantsChanges(event) })}
          >
            <IconFile size={12} />
            {/* 新建文件（git 未跟踪）标 [新增]：它没有可对比的基线，点击直接
                打开文件而不是开 diff——记号让「为什么行为不一样」看得见 */}
            {kind === "new" ? <span className="file-chip-tag">{texts.fileNewTag}</span> : null}
            <span className="file-chip-name">{basename(file.path)}</span>
          </button>
        );
      })}
      {hasMore ? (
        <button
          className="file-chips-more"
          aria-expanded={expanded}
          aria-label={expanded ? texts.filesCollapseAria : texts.filesExpandAria(paths.length)}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? texts.filesCollapse : texts.producedMore(remainder)}
        </button>
      ) : null}
    </div>
  );
}

/** 与官方 `ProducedFiles` 相同的展示上限（多余的只报数量，不铺满侧栏）。 */
const SHOWN_FILES = 6;

/**
 * 文件芯片点击的意图：默认**看改动**（宿主有改动就开 VS Code 的对比窗口，
 * 没有则回落成普通打开）；按住 Alt/Ctrl/Cmd/Shift 时直接打开文件本身
 * ——对比窗口里看内容不方便时的逃生口，同一份文件不必另找入口。
 */
function wantsChanges(event: MouseEvent): boolean {
  return !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
}

/** 路径的末段：窄侧栏里要一眼认出是哪个文件（官方 `presented.basename` 等价物）。 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}
