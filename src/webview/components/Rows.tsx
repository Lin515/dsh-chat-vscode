import { useRef, useState } from "react";
import { post } from "../bridge";
import type {
  ApprovalView,
  DiffLayout,
  InjectedView,
  QuestionView,
  ToolCallView,
} from "../../shared/chat";
import { formatDuration, Row, useElapsed, useSelectionFreeze, useStickyBody } from "./primitives";
import { DiffView } from "./Diff";
import { fill, useTexts, resolveText } from "../texts";
import {
  IconAlert,
  IconCheck,
  IconDsh,
  IconExternal,
  IconFile,
  IconGlobe,
  IconList,
  IconPencil,
  IconPlug,
  IconQuestion,
  IconRead,
  IconSearch,
  IconTerminal,
  IconWrite,
} from "../icons";

/** 工具名 → 图标与动词。 */
function useDescribeTool(): (name: string) => { icon: JSX.Element; verb: string } {
  const texts = useTexts();
  return (name: string) => {
    const key = name.toLowerCase();
    if (key.startsWith("read")) return { icon: <IconRead size={13} />, verb: texts.toolRead };
    if (key.startsWith("write") || key === "create_file")
      return { icon: <IconWrite size={13} />, verb: texts.toolWrite };
    if (key.startsWith("edit") || key.includes("replace"))
      return { icon: <IconPencil size={13} />, verb: texts.toolEdit };
    if (key.includes("pwsh") || key.includes("bash") || key.includes("shell"))
      return { icon: <IconTerminal size={13} />, verb: texts.toolRun };
    if (key.includes("grep") || key.includes("search"))
      return { icon: <IconSearch size={13} />, verb: texts.toolSearch };
    if (key.includes("glob") || key.includes("list"))
      return { icon: <IconList size={13} />, verb: texts.toolGlob };
    if (key.includes("web") || key.includes("fetch"))
      return { icon: <IconGlobe size={13} />, verb: texts.toolWeb };
    if (key.includes("present")) return { icon: <IconFile size={13} />, verb: texts.toolPresent };
    return { icon: <IconCheck size={13} />, verb: name };
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
  const tone = running ? "running" : tool.status === "error" ? "error" : "ok";

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
    (tool.images?.length ?? 0) > 0 ||
    (tool.files?.length ?? 0) > 0;

  return (
    <Row
      icon={icon}
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
      {tool.images?.length ? (
        <div className="row-body-images">
          {tool.images.map((src, index) => (
            <img key={index} src={src} alt="工具返回的图片" />
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
      // 流式思考中发光，结束后恢复常态
      icon={
        streaming ? (
          <span className="icon-glow">
            <IconDsh size={14} />
          </span>
        ) : (
          <IconDsh size={14} />
        )
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
        <span className="row-detail">{approval.toolName}</span>
      </div>
      {approval.reason ? <div className="approval-detail">{approval.reason}</div> : null}
      {approval.detail ? <div className="approval-detail">{approval.detail}</div> : null}
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
