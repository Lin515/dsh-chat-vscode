import { useRef, useState } from "react";
import { post } from "../bridge";
import type {
  ApprovalView,
  CommandRunView,
  DiffLayout,
  InjectedView,
  QuestionView,
  ToolCallView,
} from "../../shared/chat";
import { classifyTool, toolTitleKey } from "../../shared/toolMeta";
import { formatDuration, Row, useElapsed, useSelectionFreeze, useStickyBody } from "./primitives";
import { DiffView } from "./Diff";
import { fill, useTexts, resolveText } from "../texts";
import {
  IconAlert,
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
  IconSparkles,
  IconTerminal,
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
function useDescribeTool(): (name: string) => { icon: JSX.Element; verb: string } {
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
        <IconSparkles size={13} />
      );
    return { icon, verb };
  };
}

export function ToolRow({ tool, diffLayout }: { tool: ToolCallView; diffLayout?: DiffLayout }) {
  // 工具调用默认收起（不自动展开），用户手动开合优先
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const describeTool = useDescribeTool();
  const texts = useTexts();
  const open = manual ?? false;
  const { icon, verb } = describeTool(tool.name);
  const bodyRef = useRef<HTMLDivElement>(null);
  const running = tool.status === "running" || tool.status === "pending";
  const stopped = tool.status === "stopped";
  // 运行中：每秒跳一次的实时耗时（协议没有工具进度事件，这是「还在跑」的唯一活证据）
  const elapsed = useElapsed(tool.startedAt ?? tool.endedAt, running);
  // 编辑类工具：结构化 diff（结果里的 hunk，或结果未回时参数推导的预览）
  const diff = tool.diff?.filter((hunk) => hunk.lines.length > 0);
  const hasDiff = Boolean(diff?.length);
  // 出错时结果文本（失败原因）比 diff 更有用，两者都显示
  const showOutput = Boolean(tool.output) && (!hasDiff || tool.status === "error");
  // 运行中还没有结果，但展开区仍有东西可看：实时耗时 +（认得出的话）完整命令。
  // 一律可展开——任何正在跑的节点都该能点开确认「它还活着」，这正是长任务的需要。
  const runningBody = running;
  // 展开且有内容时 body 区贴住最新内容：超出出现滚动条就自动滚到最新一行
  useStickyBody(bodyRef, open && (hasDiff || showOutput));
  // 结果行仍可能被后续更新刷新；用户在其中划选时冻结渲染，保住选区
  const shownOutput = useSelectionFreeze(bodyRef, tool.output ?? "");

  // 官方 `leadingFor`：**只有** error 与 stopped 画状态点，running/ok 显示工具图标。
  // 此前只要传了 tone 就画点，于是所有工具图标都不可见（docs/audit-summary.md §6）。
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

  // 展开区只显示「解析后的有价值信息」：编辑类给 diff，其余给结果文本
  // （读取出的文本 / 运行输出 / 搜索结果等）。原始参数（tool.input）不渲染——
  // 它只是流式期累积的线格式载荷，标题行已表达「做了什么」。
  // 运行中也要可展开：长任务（构建）要能看见完整命令与「还在跑」的计时。
  const hasBody =
    hasDiff ||
    showOutput ||
    runningBody ||
    Boolean(exitMeta) ||
    (tool.images?.length ?? 0) > 0 ||
    (tool.files?.length ?? 0) > 0;

  return (
    <Row
      // 运行中的节点：行首图标呼吸发光（.icon-glow，与思考鲸鱼同节奏）；
      // 结束回落为静态灰图标——「还在动」由动效表达，与鲸鱼结束停呼吸同一条语言
      icon={
        running ? (
          <span className="icon-glow">{icon}</span>
        ) : (
          icon
        )
      }
      tone={tone}
      // 节点名（动词）完整显示，路径/命令/查询等次要标题进 detail 列，
      // 过长时由 CSS 省略——思考/工具/用量行同一布局
      title={tool.title || verb}
      detail={tool.detail}
      // 只读了一段时把行号缀在文件名后；该片段不可压缩，窄侧栏也看得见
      detailSuffix={tool.readLines ? `:${tool.readLines.start}-${tool.readLines.end}` : undefined}
      meta={meta}
      open={open}
      onToggle={() => {
        if (hasBody) setManual(!open);
      }}
    >
      {runningBody ? (
        <div className="row-body mono row-running">
          <div className="row-running-head">
            {/* 与思考节点同一个发光标记：一眼看出「还在跑」 */}
            <span className="icon-glow" aria-hidden>
              <IconDsh size={11} />
            </span>
            <span>{fill(texts.toolRunning, { duration: formatDuration(elapsed) })}</span>
          </div>
          {tool.command ? <div className="row-running-command">{tool.command}</div> : null}
          <div className="row-running-hint">{texts.toolRunningHint}</div>
        </div>
      ) : null}
      {hasDiff && diff ? (
        <div ref={bodyRef} className="row-body diff-body">
          <DiffView hunks={diff} layout={diffLayout} />
        </div>
      ) : null}
      {showOutput ? (
        <div ref={hasDiff ? undefined : bodyRef} className="row-body mono">
          {shownOutput}
        </div>
      ) : null}
      {/* 退出状态单独一行：只有非零退出码 / 信号才出现，正常退出不占位置 */}
      {exitMeta ? (
        <div className={`row-exit${tool.status === "error" ? " is-error" : ""}`}>{exitMeta}</div>
      ) : null}
      {tool.images?.length ? (
        <div className="row-body-images">
          {tool.images.map((src, index) => (
            <img key={index} src={src} alt={texts.toolImageAlt} />
          ))}
        </div>
      ) : null}
      {tool.files?.length ? (
        <div className="row-body">
          {tool.files.map((file) => (
            <button
              key={file.path}
              className="lump-btn"
              onClick={() => post({ type: "openFile", path: file.path })}
            >
              <IconExternal size={12} />
              {file.path}
            </button>
          ))}
        </div>
      ) : null}
    </Row>
  );
}

export function ThinkingRow({
  text,
  streaming,
  durationMs,
}: {
  text: string;
  streaming?: boolean;
  durationMs?: number;
}) {
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const texts = useTexts();
  // 流式期间展开，思考结束后自动收起
  const open = manual ?? Boolean(streaming);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 思考是流式增长的：展开时 body 区贴住最新内容
  useStickyBody(bodyRef, open);
  // 流式期间用户划选正文时冻结渲染，否则每来一个 token 选区就没了
  const shownText = useSelectionFreeze(bodyRef, text);
  const firstLine = text.split("\n").find((line) => line.trim())?.trim() ?? "";

  return (
    <Row
      // 鲸鱼恒为品牌蓝：思考中额外呼吸发光，结束后保持蓝色静置
      // （不回落成 .row-icon 的灰色——那样节点只剩标题可辨）
      icon={
        <span className={streaming ? "icon-glow" : "icon-brand"}>
          <IconDsh size={14} />
        </span>
      }
      title={texts.thinking}
      detail={firstLine}
      meta={durationMs ? formatDuration(durationMs) : undefined}
      open={open}
      onToggle={() => setManual(!open)}
    >
      <div ref={bodyRef} className="row-body">
        {shownText}
      </div>
    </Row>
  );
}

/** 自动载入节点的标签：优先按来源大类，其次按注入形式，最后退回通用文案。 */
function useDescribeInjected(): (injected: InjectedView) => { label: string; detail?: string } {
  const texts = useTexts();
  return (injected) => {
    const plugin = injected.plugin;
    const form = injected.form;

    // 系统提示词插件的 snapshot 形态 = 运行时上下文（沙箱/审批策略等），
    // 与那条完整的系统提示词区分开，标签更准确
    if (injected.sourceKind === "system") {
      return { label: texts.injectedSystemPrompt, detail: plugin };
    }
    if (plugin === "@deepseek-ai/dsh-system-prompt" && form === "snapshot") {
      return { label: texts.injectedRuntimeContext, detail: form };
    }
    if (injected.sourceKind === "agent-instructions") {
      return { label: texts.injectedAgentInstructions, detail: form };
    }
    if (injected.sourceKind === "skill-catalog") {
      return { label: texts.injectedSkillCatalog, detail: form };
    }
    if (injected.sourceKind === "plugin") {
      return { label: texts.injectedPlugin, detail: plugin ?? form };
    }
    return { label: texts.injectedGeneric, detail: plugin ?? injected.sourceKind };
  };
}

/**
 * 自动载入的提示词节点（系统提示词 / 插件注入 / 项目指令 / 技能目录…）。
 *
 * 默认收起：这些内容动辄数千字符（技能目录实测 6.9K），展开全部会把对话淹没。
 * 收起时给出标签 + 字数 + 首行摘要，既能一眼看出「这轮被喂了什么」，
 * 又需要点开才占用注意力。
 */
export function InjectedRow({ injected }: { injected: InjectedView }) {
  const [open, setOpen] = useState(false);
  const texts = useTexts();
  const describe = useDescribeInjected();
  const { label, detail } = describe(injected);
  const bodyRef = useRef<HTMLDivElement>(null);
  useStickyBody(bodyRef, open);
  const shownText = useSelectionFreeze(bodyRef, injected.text);
  const firstLine = injected.text.split("\n").find((line) => line.trim())?.trim() ?? "";

  return (
    <Row
      icon={<IconPlug size={13} />}
      title={label}
      detail={detail ?? firstLine}
      meta={texts.injectedChars(formatChars(injected.text.length))}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div ref={bodyRef} className="row-body mono row-injected">
        {shownText}
      </div>
    </Row>
  );
}

/** 字数：上千用 K，与 token 的展示口径分开（这是字符数，不是 token）。 */
function formatChars(chars: number): string {
  if (chars >= 10_000) return `${Math.round(chars / 1000)}K`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)}K`;
  return String(chars);
}

export function ApprovalCard({ approval }: { approval: ApprovalView }) {
  const texts = useTexts();
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
      {approval.reason ? <div className="approval-detail">{approval.reason}</div> : null}
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

export function QuestionCard({ question }: { question: QuestionView }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const texts = useTexts();
  const waiting = question.state === "waiting";

  const toggle = (itemId: string, label: string, multi?: boolean) => {
    setSelected((prev) => {
      const current = prev[itemId] ?? [];
      const next = multi
        ? current.includes(label)
          ? current.filter((v) => v !== label)
          : [...current, label]
        : [label];
      return { ...prev, [itemId]: next };
    });
  };

  const submit = () => {
    post({
      type: "answerQuestion",
      requestId: question.requestId,
      answers: question.items.map((item) => ({
        id: item.id,
        selected: selected[item.id] ?? [],
        custom: custom[item.id]?.trim() || undefined,
      })),
    });
  };

  return (
    <div className="question">
      {question.items.map((item) => (
        <div className="question-item" key={item.id}>
          <div className="question-head">
            <IconQuestion size={11} /> {item.header ?? texts.questionHead}
          </div>
          <div className="question-text">{item.question}</div>
          {item.options.length ? (
            <div className="question-options">
              {item.options.map((option) => {
                const isSelected = (selected[item.id] ?? []).includes(option.label);
                return (
                  <button
                    key={option.label}
                    className={`question-option${isSelected ? " is-selected" : ""}`}
                    disabled={!waiting}
                    onClick={() => toggle(item.id, option.label, item.multiSelect)}
                  >
                    <span className="question-option-label">{option.label}</span>
                    {option.description ? (
                      <span className="question-option-desc">{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          {waiting ? (
            <input
              className="question-input"
              placeholder={texts.questionPlaceholder}
              value={custom[item.id] ?? ""}
              onChange={(event) => setCustom((prev) => ({ ...prev, [item.id]: event.target.value }))}
            />
          ) : null}
        </div>
      ))}
      {waiting ? (
        <div className="approval-actions">
          <button
            className="btn btn-primary"
            disabled={question.items.some(
              (item) => !(selected[item.id]?.length || custom[item.id]?.trim()),
            )}
            onClick={submit}
          >
            {texts.submit}
          </button>
        </div>
      ) : null}
    </div>
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
export function CommandRow({ command }: { command: CommandRunView }) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const failed = command.state === "error";
  const bodyRef = useRef<HTMLDivElement>(null);
  useStickyBody(bodyRef, open);
  return (
    <Row
      // 运行中的命令与工具行同等待遇：行首图标呼吸发光，而不是 7px 小圆点
      icon={
        command.state === "running" ? (
          <span className="icon-glow">
            <IconSlash size={13} />
          </span>
        ) : (
          <IconSlash size={13} />
        )
      }
      tone={failed ? "error" : undefined}
      title={`/${command.name || texts.commands}`}
      detail={command.args}
      meta={failed ? texts.commandFailed : command.state === "running" ? texts.commandRunning : undefined}
      open={open}
      onToggle={() => setOpen(!open)}
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
 * `present` 工具的申报。与官方一致，超出上限只在首个多余位置显示一条剩余计数。
 */
export function FileChips({
  label,
  paths,
}: {
  label: string;
  paths: { path: string; description?: string }[];
}) {
  const texts = useTexts();
  const shown = paths.slice(0, SHOWN_FILES);
  const remainder = paths.length - shown.length;
  return (
    <div className="file-chips">
      <span className="file-chips-label">{label}</span>
      {shown.map((file) => (
        <button
          key={file.path}
          className="file-chip"
          title={file.description ?? file.path}
          aria-label={texts.producedOpen(file.path)}
          onClick={() => post({ type: "openFile", path: file.path })}
        >
          <IconFile size={12} />
          <span className="file-chip-name">{basename(file.path)}</span>
        </button>
      ))}
      {remainder > 0 ? <span className="file-chips-more">{texts.producedMore(remainder)}</span> : null}
    </div>
  );
}

/** 与官方 `ProducedFiles` 相同的展示上限（多余的只报数量，不铺满侧栏）。 */
const SHOWN_FILES = 6;

/** 路径的末段：窄侧栏里要一眼认出是哪个文件（官方 `presented.basename` 等价物）。 */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut >= 0 ? path.slice(cut + 1) : path;
}
