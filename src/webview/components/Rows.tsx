import { useRef, useState } from "react";
import { post } from "../bridge";
import type {
  ApprovalView,
  QuestionView,
  ToolCallView,
  UsageView,
} from "../../shared/chat";
import { formatDuration, formatTokens, Row, useStickyBody } from "./primitives";
import { useTexts, resolveText } from "../texts";
import {
  IconAlert,
  IconCheck,
  IconDsh,
  IconExternal,
  IconFile,
  IconGlobe,
  IconList,
  IconPencil,
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

export function ToolRow({ tool }: { tool: ToolCallView }) {
  // 工具调用默认收起（不自动展开），用户手动开合优先
  const [manual, setManual] = useState<boolean | undefined>(undefined);
  const describeTool = useDescribeTool();
  const open = manual ?? false;
  const { icon, verb } = describeTool(tool.name);
  const bodyRef = useRef<HTMLDivElement>(null);
  // 展开且有结果时 body 区贴住最新内容：超出出现滚动条就自动滚到最新一行
  useStickyBody(bodyRef, open && Boolean(tool.output));
  const tone = tool.status === "running" || tool.status === "pending"
    ? "running"
    : tool.status === "error"
      ? "error"
      : "ok";

  const meta =
    tool.endedAt && tool.startedAt ? formatDuration(tool.endedAt - tool.startedAt) : undefined;

  // 展开区只显示「解析后的有价值信息」：结果文本（读取出的文本 / 运行输出 /
  // 搜索结果等）。原始参数（tool.input）不渲染——它只是流式期累积的线格式载荷，
  // 标题行已表达「做了什么」。没有任何展开内容时该行不可点开。
  const hasBody =
    Boolean(tool.output) || (tool.images?.length ?? 0) > 0 || (tool.files?.length ?? 0) > 0;

  return (
    <Row
      icon={icon}
      tone={tone}
      // 节点名（动词）完整显示，路径/命令/查询等次要标题进 detail 列，
      // 过长时由 CSS 省略——思考/工具/用量行同一布局
      title={tool.title || verb}
      detail={tool.detail}
      meta={meta}
      open={open}
      onToggle={() => {
        if (hasBody) setManual(!open);
      }}
    >
      {tool.output ? (
        <div ref={bodyRef} className="row-body mono">
          {tool.output}
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
        {text}
      </div>
    </Row>
  );
}

/** dsh 的用量/耗时信息默认收进折叠行，保持对话面干净。 */
export function UsageRow({
  usage,
  durationMs,
  firstTokenMs,
  enabled = true,
}: {
  usage?: UsageView;
  durationMs?: number;
  firstTokenMs?: number;
  /** 对应 dshChat.showUsageStats；关掉后这些统计完全不出现。 */
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const texts = useTexts();
  if (!enabled) return null;
  const parts: string[] = [];
  if (usage?.totalTokens) parts.push(`${formatTokens(usage.totalTokens)} tok`);
  if (durationMs) parts.push(formatDuration(durationMs));
  if (!parts.length) return null;

  return (
    <Row title={texts.usage} detail={parts.join(" · ")} open={open} onToggle={() => setOpen(!open)}>
      <div className="row-body mono">
        {[
          usage?.inputTokens !== undefined ? `${texts.usageInput} ${formatTokens(usage.inputTokens)}` : null,
          usage?.cachedTokens !== undefined ? `${texts.usageCached} ${formatTokens(usage.cachedTokens)}` : null,
          usage?.outputTokens !== undefined ? `${texts.usageOutput} ${formatTokens(usage.outputTokens)}` : null,
          usage?.reasoningTokens !== undefined ? `${texts.usageReasoning} ${formatTokens(usage.reasoningTokens)}` : null,
          firstTokenMs !== undefined ? `${texts.usageFirstToken} ${formatDuration(firstTokenMs)}` : null,
          durationMs !== undefined ? `${texts.usageTotal} ${formatDuration(durationMs)}` : null,
        ]
          .filter(Boolean)
          .join("\n")}
      </div>
    </Row>
  );
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
