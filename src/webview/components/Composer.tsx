import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { CommandView, FileRefView, GoalView } from "../../shared/chat";
import type { AppState } from "../state";
import { post } from "../bridge";
import {
  IconAt,
  IconAttach,
  IconChevronDown,
  IconClose,
  IconDsh,
  IconFolder,
  IconPause,
  IconPencil,
  IconPlay,
  IconRefresh,
  IconShield,
  IconShieldCheck,
  IconShieldFilled,
  IconStop,
  IconTarget,
} from "../icons";
import { CtxText, Ellipsis, Popover, Spinner, formatDuration } from "./primitives";
import { insertAtCaret } from "../insert";
import { segmentColumns } from "../segment";
import { fill, useTexts } from "../texts";

/** 权限模式的展示定义：图标固定用盾牌（WebUI 未提供专用图标），文案与 WebUI 对齐。 */
function permissionMeta(
  texts: ReturnType<typeof useTexts>,
): { id: string; label: string; desc: string; icon: ReactNode }[] {
  return [
    { id: "read-only", label: texts.permReadOnly, desc: texts.permReadOnlyDesc, icon: <IconShield size={12} /> },
    {
      id: "workspace-write",
      label: texts.permWorkspaceWrite,
      desc: texts.permWorkspaceWriteDesc,
      icon: <IconShieldCheck size={12} />,
    },
    {
      id: "danger-full-access",
      label: texts.permFullAccess,
      desc: texts.permFullAccessDesc,
      icon: <IconShieldFilled size={12} />,
    },
  ];
}

/** 输入框里正在编辑的触发词（`/` 命令或 `@` 文件提及）。 */
interface Trigger {
  kind: "command" | "mention";
  /** 触发词在文本里的起始下标。 */
  start: number;
  query: string;
}

/**
 * 找出光标前正在输入的触发词。
 *
 * 两者都以「行首或空白」为边界：
 * - `/` 若只认行首，用户在已有文字后打空格再输 `/` 就弹不出菜单（很常见）；
 * - 而路径里的 `/`（`src/dsh/controller.ts`）前面是非空白字符，用空白边界
 *   就能既允许句中触发、又不误判路径。
 */
function findTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const query = mention[2] ?? "";
    return { kind: "mention", start: before.length - query.length - 1, query };
  }
  const command = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (command) {
    const query = command[2] ?? "";
    return { kind: "command", start: before.length - query.length - 1, query };
  }
  return undefined;
}

export function Composer({ state, onDraft }: { state: AppState; onDraft: (text: string) => void }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // 模型按钮 toggle 标志：标记「这次关闭是按钮触发的」，让 Popover 的
  // mousedown 外部检测跳过它（选中模型后弹层不关，再点按钮需能关闭）
  const modelToggleRef = useRef(false);
  // 权限按钮与模型按钮同机制：弹层已开时再点按钮是关闭，而不是被外部检测
  // 「关掉」之后又被 click 翻转回来
  const modeToggleRef = useRef(false);
  // ESC 关掉候选弹层后记下当时的文本与光标：只要没有真实编辑，随后的 keyup /
  // 聚焦回调不会重新探测触发词把列表弹回来（否则表现为「按 ESC 列表又弹出」）
  const dismissedRef = useRef<{ value: string; caret: number } | null>(null);
  const [trigger, setTrigger] = useState<Trigger | undefined>(undefined);
  const [highlight, setHighlight] = useState(0);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const texts = useTexts();
  const permissions = permissionMeta(texts);

  const draft = state.draft;
  const waitingApproval = state.messages.some((m) =>
    m.segments.some((s) => s.kind === "approval" && s.approval.state === "waiting"),
  );
  const waitingQuestion = state.messages.some((m) =>
    m.segments.some((s) => s.kind === "question" && s.question.state === "waiting"),
  );

  // 自适应高度
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.7)}px`;
  }, [draft]);

  // 运行结束后把焦点还给输入框
  useEffect(() => {
    if (!state.running) textareaRef.current?.focus();
  }, [state.running]);

  /**
   * 宿主要求把文本插到光标处（选了不能内嵌的路径：目录 / 二进制 / 非 UTF-8…）。
   *
   * 光标位置只有界面知道，所以宿主只下发「插什么」，由这里读 textarea 的
   * selectionEnd 决定插在哪，插完再把光标挪到插入内容之后。
   * 按 id 去重：同一个请求只处理一次（重渲染不该重复插入）。
   */
  const handledInsertId = useRef(0);
  useEffect(() => {
    const request = state.insertRequest;
    if (!request || request.id === handledInsertId.current) return;
    handledInsertId.current = request.id;

    const el = textareaRef.current;
    // 有选区时插在选区之后（不删用户已选中的文字）
    const caret = el?.selectionEnd ?? state.draft.length;
    const next = insertAtCaret(state.draft, request.text, caret);
    onDraft(next.value);
    post({ type: "setDraft", text: next.value });
    // 等 React 把新 value 渲染出来再定位光标
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    // 只依赖 id：effect 内读的 state.draft 就是这次请求对应的那一帧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.insertRequest?.id]);

  // 触发词出现时才去拉候选列表，避免每次输入都请求
  useEffect(() => {
    if (trigger?.kind === "command") post({ type: "listCommands" });
    if (trigger?.kind === "mention") post({ type: "queryFiles", query: trigger.query });
    setHighlight(0);
  }, [trigger?.kind, trigger?.query]);

  const candidates = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "command") {
      const query = trigger.query.toLowerCase();
      return state.commands.filter((command) => command.name.toLowerCase().includes(query));
    }
    return state.fileRefs.items;
  }, [trigger, state.commands, state.fileRefs]);

  const canSend = draft.trim().length > 0 && state.connection === "ready";

  const send = () => {
    if (!canSend) return;
    post({ type: "send", text: draft.trim(), attachments: state.attachments });
    onDraft("");
    dismissedRef.current = null;
    setTrigger(undefined);
  };

  /** 把触发词替换成选中的命令 / 文件。 */
  const applyCandidate = (index: number, drill = false) => {
    const candidate = candidates[index];
    if (!candidate || !trigger) return;
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(trigger.start + 1 + trigger.query.length);

    if (trigger.kind === "command") {
      const command = candidate as CommandView;
      const next = `${before}/${command.name}${after}`;
      onDraft(next);
      post({ type: "setDraft", text: next });
      setTrigger(undefined);
      // 命令通常需要回车执行，这里保留焦点让用户确认参数
      textareaRef.current?.focus();
      return;
    }

    const file = candidate as FileRefView;
    // 目录：**默认打开**它（下钻），不是把它本身载入——这是用户明确的口径。
    // 下钻 = 把触发词替换成 `@<path>/` 并继续留在候选态；服务端按结尾斜杠
    // 把它当目录查询，于是列表变成该目录的内容。
    if (file.kind === "directory" && !drill) {
      const next = `${before}@${file.path}/${after}`;
      onDraft(next);
      post({ type: "setDraft", text: next });
      // 光标落在结尾斜杠之后：下一层候选立刻按新前缀拉取
      const caret = before.length + 1 + file.path.length + 1;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
        refreshTrigger(next, caret);
      });
      post({ type: "queryFiles", query: `${file.path}/` });
      return;
    }
    // 文件（或用户点了「整个目录」按钮）：把路径从正文里拿掉，改成引用芯片。
    // 正文里不出现 `@token` —— 引用是芯片，发送时由宿主拼回正文（见 dsh/references.ts）。
    post({ type: "queryFiles", query: "" });
    const next = `${before}${after}`;
    onDraft(next);
    post({ type: "setDraft", text: next });
    post({ type: "addMention", path: file.path, kind: file.kind });
    setTrigger(undefined);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (trigger) {
      // ESC 关掉候选弹层：优先级最高。记下文本+光标防止随后的 keyup 重新
      // 探测把列表弹回来；stopPropagation 让这次 ESC 不再落到「关弹层 / 停止
      // 生成」的更高层监听上
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissedRef.current = {
          value: draft,
          caret: event.currentTarget.selectionStart ?? draft.length,
        };
        setTrigger(undefined);
        return;
      }
      if (candidates.length > 0) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setHighlight((value) => (value + 1) % candidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setHighlight((value) => (value - 1 + candidates.length) % candidates.length);
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          event.preventDefault();
          applyCandidate(highlight);
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
    // ESC 停止生成统一由 App 的 window 层兜底（候选弹层 / 浮层都没有消费时才到）
  };

  /** 每次输入后重算触发词。 */
  const refreshTrigger = (value: string, caret: number) => {
    const dismissed = dismissedRef.current;
    if (dismissed && dismissed.value === value && dismissed.caret === caret) {
      // ESC 刚关闭、文本与光标都没变：保持关闭，不重新弹出
      setTrigger(undefined);
      return;
    }
    // 任何真实的文本 / 光标变化都解除「已关闭」标记
    dismissedRef.current = null;
    const found = findTrigger(value, caret);
    setTrigger(found);
    if (!found && candidates.length) setHighlight(0);
  };

  const currentPermission =
    permissions.find((item) => item.id === state.permission) ?? permissions[1];

  // 窄边栏适配：测 .app 宽度，宽度 < 220px 进入「迷你模式」——
  // 聊天列表/头部按钮/发送栏全部收成图标条，避免文字被裁半的「一层底一层」。
  // 滞回（<220 进、≥232 出）避免临界抖动。拖到 VS Code 最小宽度时原生收起侧栏。
  const appRef = useRef<HTMLDivElement>(null);
  const [mini, setMini] = useState(false);
  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const check = () => {
      const w = el.clientWidth;
      setMini((prev) => (prev ? w < 232 : w < 220));
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // 生成速度：优先取最近一条助手消息的 usage.tokensPerSecond（由宿主从 dsh 协议
  // 流式帧时间戳折叠得出：decode 窗口 = 首个 token delta → 最终消息，等价于
  // dsh web 客户端 `turn-metrics` 的 decode 吞吐口径，不含 prefill/工具等待）。
  // 新一轮刚发出时最新消息还没有 usage，退回宿主保留的上一次已知值
  // （state.lastSpeed），避免数字闪没。
  const lastMessage = state.messages.at(-1);
  const tps = lastMessage?.usage?.tokensPerSecond ?? state.lastSpeed;

  // 速度值的悬停明细：全日志会话统计（`sessionStats` 投影），口径对齐
  // Web 的「会话统计」对话框；未知项省略，无数据则不显示 tooltip
  const stats = state.sessionStats;
  const statsTitle = stats
    ? [
        stats.llmMs > 0 ? `${texts.statsLlmTime} ${formatDuration(stats.llmMs)}` : null,
        stats.toolMs > 0 ? `${texts.statsToolTime} ${formatDuration(stats.toolMs)}` : null,
        stats.ttftSteps > 0 ? `${texts.statsTtft} ${formatDuration(stats.ttftMs / stats.ttftSteps)}` : null,
        stats.decodeMs > 0 && stats.decodeTokens > 0
          ? `${texts.statsSpeed} ${Math.round(stats.decodeTokens / (stats.decodeMs / 1000))} tok/s`
          : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    : undefined;



  return (
    <div ref={appRef} className={`composer${mini ? " is-mini" : ""}`}>
      {/* 目标条：官方 dock 在输入框上方的同一个位置（`conversation.input.dock`） */}
      <GoalBar goal={state.goal} />
      <Lump state={state} />

      {/* 运行状态：会话底部一行无边框文字；等待审批/提问时 agent 暂停，
          不该说「生成中」；队列消息与它并存（不再互相覆盖）。
          提示文案跟着 ESC 的实际行为走：有排队消息时 ESC 还会把队首发出去 */}
      {state.running && !waitingApproval && !waitingQuestion ? (
        <div className="running-line">
          <span className="lump-thinking" aria-hidden>
            <IconDsh size={13} />
          </span>
          <span>{texts.running}</span>
          <Ellipsis />
          <span className="lump-hint">
            {state.queueItems.length > 0 ? texts.runningHintQueue : texts.runningHint}
          </span>
        </div>
      ) : null}

      {/* 触发词候选：浮在输入框上方 */}
      {trigger && (candidates.length > 0 || trigger.kind === "mention") ? (
        <div className="popover trigger-popover" role="listbox">
          <div className="popover-section">
            {trigger.kind === "command" ? texts.commands : texts.mentionFiles}
          </div>
          {candidates.length === 0 ? (
            <div className="popover-empty">
              {trigger.kind === "command" ? texts.commandsEmpty : texts.mentionEmpty}
            </div>
          ) : (
            candidates.slice(0, 40).map((candidate, index) => {
              const isCommand = trigger.kind === "command";
              const row = candidate as CommandView & FileRefView;
              const isFolder = !isCommand && row.kind === "directory";
              return (
                <div
                  key={isCommand ? row.name : row.path}
                  className={`popover-item${index === highlight ? " is-selected" : ""}`}
                  onMouseEnter={() => setHighlight(index)}
                >
                  {/* 主体：点它选中。目录在 `@` 列表里**默认是打开该目录**（下钻），
                      只有右侧的「整个目录」按钮才是把目录本身载入——用户明确的口径。 */}
                  <button
                    className="popover-item-hit"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      applyCandidate(index);
                    }}
                  >
                    {/* 命令名走「优先完整」那档样式（`.is-priority`）：宽度不够时
                        先省略右边的描述，绝不把命令截成 `/git-guard…`（用户口径）。
                        文件路径不做这个标记——长路径必须能省略。 */}
                    <span className={`popover-item-main${isCommand ? " is-priority" : ""}`}>
                      {isCommand ? `/${row.name}` : row.path}
                    </span>
                    {isCommand && row.description ? (
                      <span className="popover-item-sub">{row.description}</span>
                    ) : null}
                    {isCommand && row.skill ? (
                      <span className="popover-item-tag">{texts.skillTag}</span>
                    ) : null}
                  </button>
                  {isFolder ? (
                    <button
                      className="popover-item-action"
                      title={texts.attachFolder}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyCandidate(index, true);
                      }}
                    >
                      <IconFolder size={11} />
                      {texts.attachFolder}
                    </button>
                  ) : null}
                </div>
              );
            })
          )}
          <div className="popover-hint">{texts.mentionHint}</div>
        </div>
      ) : null}

      <div className="composer-shell">
        <div
          className={`composer-box${dragOver ? " is-drop-target" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
          }}
        >
          {state.attachments.length ? (
            <div className="composer-chips">
              {state.attachments.map((attachment) => (
                <span
                  className={`chip${attachment.upload?.status === "error" ? " is-error" : ""}`}
                  key={attachment.id}
                  title={attachment.path ?? attachment.name}
                >
                  {/* 上传状态：官方 FileCard 里文件芯片带进度/失败态。
                      失败可点重试，否则用户只能删掉重选（内容其实还在磁盘上）。 */}
                  {attachment.upload?.status === "uploading" ? (
                    <span className="chip-spinner" aria-hidden>
                      <Spinner size={10} />
                    </span>
                  ) : attachment.upload?.status === "error" ? (
                    <button
                      className="chip-retry"
                      title={texts.uploadFailed}
                      onClick={() => post({ type: "retryUpload", id: attachment.id })}
                    >
                      <IconRefresh size={11} />
                    </button>
                  ) : attachment.kind === "reference" ? (
                    <span className="chip-glyph" aria-hidden>
                      {attachment.referenceKind === "directory" ? <IconFolder size={11} /> : <IconAt size={11} />}
                    </span>
                  ) : null}
                  <span className="chip-name">{attachment.name}</span>
                  <button
                    className="chip-remove"
                    title={texts.remove}
                    onClick={() => post({ type: "removeAttachment", id: attachment.id })}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <textarea
            ref={textareaRef}
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={state.messages.length ? texts.placeholderFollowUp : texts.placeholderFirst}
            onChange={(event) => {
              onDraft(event.target.value);
              post({ type: "setDraft", text: event.target.value });
              refreshTrigger(event.target.value, event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyUp={(event) => {
              // 光标移动（方向键、点击）也要重算触发词
              const el = event.currentTarget;
              refreshTrigger(el.value, el.selectionStart ?? el.value.length);
            }}
            onClick={(event) => {
              const el = event.currentTarget;
              refreshTrigger(el.value, el.selectionStart ?? el.value.length);
            }}
            onKeyDown={onKeyDown}
          />

          <div className="composer-bar">
            {/* 权限：始终只显示盾牌图标（悬停有 title，点开弹层可见权限名） */}
            <div className="anchor">
              <button
                className="pill-mode"
                onMouseDown={() => {
                  // 标记：接下来 Popover 的 mousedown 外部检测是「按钮触发的」，跳过
                  modeToggleRef.current = true;
                }}
                onClick={() => {
                  // 同一次交互内消费标志（mousedown 已先于 click 触发）
                  setTimeout(() => {
                    modeToggleRef.current = false;
                  }, 0);
                  setModeOpen((v) => {
                    // 经按钮关闭时顺带复位完全权限确认态
                    if (v) setConfirmFullAccess(false);
                    return !v;
                  });
                }}
                title={currentPermission.label}
              >
                {currentPermission.icon}
                <IconChevronDown size={8} />
              </button>
              <Popover
                open={modeOpen}
                onClose={() => {
                  // 由按钮 toggle 触发的关闭不在此处理（按钮自己已翻转状态）
                  if (modeToggleRef.current) return;
                  setModeOpen(false);
                  setConfirmFullAccess(false);
                }}
              >
                <div className="popover-section">{texts.permission}</div>
                {confirmFullAccess ? (
                  <div className="confirm-block">
                    <div className="confirm-title">{texts.permConfirmTitle}</div>
                    <div className="confirm-body">{texts.permConfirmBody}</div>
                    <div className="approval-actions">
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          post({ type: "setPermission", permission: "danger-full-access" });
                          setModeOpen(false);
                          setConfirmFullAccess(false);
                        }}
                      >
                        {texts.permConfirmEnable}
                      </button>
                      <button className="btn btn-ghost" onClick={() => setConfirmFullAccess(false)}>
                        {texts.cancel}
                      </button>
                    </div>
                  </div>
                ) : (
                  permissions.map((item) => (
                    <button
                      key={item.id}
                      className={`popover-item${state.permission === item.id ? " is-selected" : ""}`}
                      onClick={() => {
                        if (item.id === "danger-full-access" && state.permission !== item.id) {
                          setConfirmFullAccess(true);
                          return;
                        }
                        post({ type: "setPermission", permission: item.id });
                        setModeOpen(false);
                      }}
                    >
                      <span className="popover-item-icon">{item.icon}</span>
                      {/* 档位名同样是「主文字」：英文下 Read Only / Workspace Write /
                          Full Access 曾经被长描述挤成 `Read O…`（预览页 252px 宽实测）。
                          注意下面 `/plan` 那一行**不**加这个标记——那行的副文字是命令名，
                          该让位的是左侧标签，与用户「命令要完整」的口径一致。 */}
                      <span className="popover-item-main is-priority">{item.label}</span>
                      <span className="popover-item-sub">{item.desc}</span>
                    </button>
                  ))
                )}
                <div className="popover-sep" />
                <button
                  className={`popover-item${state.planMode ? " is-selected" : ""}`}
                  onClick={() => {
                    // 进出计划模式都必须走命令通道：把 `/plan` 拼进消息正文服务端
                    // 不认（实测 plan.active 仍为 false），而退出应当是 `/plan off`
                    // ——正文写 `/plan` 按官方语义反而是**进入**，方向会反。
                    // 见 scripts/planCommandProbe.ts 与 docs/audit-summary.md §1。
                    post({ type: "runCommand", line: state.planMode ? "/plan off" : "/plan" });
                    setModeOpen(false);
                  }}
                >
                  <span className="popover-item-main">
                    {state.planMode ? texts.exitPlanMode : texts.enterPlanMode}
                  </span>
                  <span className="popover-item-sub">/plan</span>
                </button>
              </Popover>
            </div>

            <div className="anchor">
              <button
                className="pill"
                title={texts.thinkingDepth}
                onMouseDown={() => {
                  // 标记：接下来 Popover 的 mousedown 外部检测是「按钮触发的」，跳过
                  modelToggleRef.current = true;
                }}
                onClick={() => {
                  // 同一次交互内消费标志（mousedown 已先于 click 触发）
                  setTimeout(() => {
                    modelToggleRef.current = false;
                  }, 0);
                  setModelOpen((v) => !v);
                }}
              >
                <span className="pill-label">{state.model?.label ?? texts.defaultModel}</span>
                <IconChevronDown size={8} />
              </button>
              {/* 选完模型不关闭：思考深度区留在同一面板里继续调。
                  选中态只在点击时更新（不再随鼠标悬停变化），与权限/命令弹层一致 */}
              <Popover
                open={modelOpen}
                onClose={() => {
                  // 由按钮 toggle 触发的关闭不在此处理（按钮自己已翻转状态）
                  if (modelToggleRef.current) return;
                  setModelOpen(false);
                }}
              >
                <div className="popover-section">{texts.models}</div>
                {state.models.length === 0 ? (
                  <div className="popover-empty">{texts.noModels}</div>
                ) : (
                  state.models.map((group) => (
                    <div key={group.id}>
                      {state.models.length > 1 ? (
                        <div className="popover-section">{group.name}</div>
                      ) : null}
                      {group.models.map((model) => (
                        <button
                          key={`${group.id}:${model.id}`}
                          className={`popover-item${
                            state.model?.model === model.id && state.model?.provider === group.id
                              ? " is-selected"
                              : ""
                          }`}
                          onClick={() => {
                            // 档位只在目标模型支持时才带上，否则服务端会拒绝；
                            // 面板保持打开，用户可紧接着调深度
                            const wanted = model.efforts?.some(
                              (item) => item.id === state.model?.reasoningEffort,
                            )
                              ? state.model?.reasoningEffort
                              : model.defaultEffort;
                            post({
                              type: "setModel",
                              provider: group.id,
                              model: model.id,
                              reasoningEffort: wanted,
                            });
                          }}
                        >
                          <span className="popover-item-main">{model.name}</span>
                        </button>
                      ))}
                    </div>
                  ))
                )}
                {state.model?.efforts?.length ? (
                  <>
                    <div className="popover-sep" />
                    <div className="popover-section">{texts.thinkingDepth}</div>
                    {/* 5 档及以上固定分两行（列数由 segmentColumns 决定）：
                        自然换行会随文案长度折成 4+1 这类不均匀分布，且中英文不一致 */}
                    <div
                      className={`segment${segmentColumns(state.model.efforts.length) ? " is-multi-row" : ""}`}
                      style={
                        {
                          "--segment-columns": segmentColumns(state.model.efforts.length) ?? 1,
                        } as CSSProperties
                      }
                    >
                      {state.model.efforts.map((item) => (
                        <button
                          key={item.id}
                          className={`segment-item${(state.model?.reasoningEffort ?? "") === item.id ? " is-selected" : ""}`}
                          onClick={() => {
                            post({
                              type: "setModel",
                              provider: state.model!.provider,
                              model: state.model!.model,
                              reasoningEffort: item.id,
                            });
                          }}
                        >
                          {item.name}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </Popover>
            </div>

            {/* / 与 @ 直接在输入框里打符号即可触发，不再放按钮。
                附件按钮是通用入口：图片按图片发送，其余文件逐字节上传
                （@ 只产生引用，真正上传只从这里发生），所以它不随模型
                是否支持图片而隐藏。 */}
            <button
              className="pill"
              data-mini="hide"
              title={texts.attachFile}
              onClick={() => post({ type: "addFiles" })}
            >
              <IconAttach size={13} />
            </button>

            <span className="spacer" />

            {tps !== undefined ? (
              <span className="ctx-speed" title={statsTitle || undefined}>{tps.toFixed(1)} tps</span>
            ) : null}
            <CtxText
              // 三个值**同源**：都取自宿主按官方口径算好的 contextOccupancy。
              // 刻意不回退到 usage / contextWindow 事件——那会得到一个含 output、
              // 且压缩后不下降的数，与投影口径不是一回事（同一个圆环在不同时刻
              // 代表不同东西，正是「数字卡住 / 乱跳」的观感来源）。
              percent={state.contextOccupancy?.percent}
              used={state.contextOccupancy?.usedTokens}
              total={state.contextOccupancy?.contextWindow}
              // 明细里的缓存命中与构成是**独立**的投影，有就显示
              usage={lastMessage?.usage}
              breakdown={state.contextBreakdown}
            />

            {state.running ? (
              <button className="send-btn is-stop" title={texts.stopTitle} onClick={() => post({ type: "stop" })}>
                <IconStop size={12} />
              </button>
            ) : (
              <button className="send-btn" disabled={!canSend} title={texts.sendTitle} onClick={send}>
                {texts.send}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );

}

/**
 * 目标条：当前目标的阶段、进度与操作，贴在输入框上方。
 *
 * 位置与官方 `GoalBar` 一致（会话输入区的 dock 条）。渲染规则也照抄官方：
 * 没有目标（`undefined`/`null`）与 phase 为 `complete` 的目标**都不占位**——
 * 已完成的目标留在条上只会挡住输入区。
 *
 * 三个操作走**命令通道**（`/goal pause|resume|clear`）而不是目标专用 RPC：
 * `/goal` 命令处理器调的就是同一个目标服务，而命令结果会作为命令节点留在
 * 对话里（看得见生效没有），不必再造一套 RPC 与错误通道。
 */
function GoalBar({ goal }: { goal: GoalView | undefined }) {
  const texts = useTexts();
  if (!goal || goal.phase === "complete") return null;
  const phase =
    goal.phase === "paused"
      ? texts.goalPaused
      : goal.phase === "blocked"
        ? texts.goalBlocked
        : texts.goalActive;
  const run = (action: "pause" | "resume" | "clear") =>
    post({ type: "runCommand", line: `/goal ${action}` });
  return (
    <div className={`goal-bar is-${goal.phase}`} title={goal.blockedReason ?? goal.objective}>
      <span className="goal-icon" aria-hidden>
        <IconTarget size={12} />
      </span>
      <span className="goal-phase">{phase}</span>
      <span className="goal-objective">{goal.objective}</span>
      {goal.maxRounds ? (
        <span className="goal-rounds">{`${goal.rounds}/${goal.maxRounds}`}</span>
      ) : null}
      <span className="spacer" />
      {goal.phase === "active" ? (
        <button className="goal-action" title={texts.goalPause} onClick={() => run("pause")}>
          <IconPause size={12} />
        </button>
      ) : (
        <button className="goal-action" title={texts.goalResume} onClick={() => run("resume")}>
          <IconPlay size={12} />
        </button>
      )}
      <button className="goal-action" title={texts.goalClear} onClick={() => run("clear")}>
        <IconClose size={12} />
      </button>
    </div>
  );
}

/**
 * 输入框上方的状态条。按优先级显示当前最该被看到的状态——与 Continue 的
 * LumpToolbar 同样的思路，但只保留 dsh 真正需要的分支。
 *
 * 刻意**只**剩「排队消息」一种：审批卡片、提问卡片、待办清单都在上方常驻
 * 且自带操作按钮，在输入框上方再说一遍只是噪音。
 *
 * 注意状态条空着不代表 agent 一定在跑：等待审批/提问时 agent 其实是暂停的，
 * 那两种情况由 `running-line` 的抑制条件负责，不在这里表达。
 */
function Lump({ state }: { state: AppState }) {
  const texts = useTexts();
  if (state.queueItems.length > 0) {
    // 排队中（尚未发送）的消息逐条列出，每条可单独取消。
    // 不套状态条边框：做成淡化版用户消息气泡，和上方对话同一视觉语言
    return (
      <div className="queue">
        <span className="queue-head">{fill(texts.queued, { n: state.queueItems.length })}</span>
        {state.queueItems.map((item) => (
          <div className="queue-item" key={item.id}>
            <span className="queue-text">{item.text || texts.queueMediaOnly}</span>
            <button
              className="queue-action"
              title={texts.queueEdit}
              onClick={() => post({ type: "queueEdit", id: item.id })}
            >
              <IconPencil size={13} />
            </button>
            <button
              className="queue-action is-danger"
              title={texts.queueRemove}
              onClick={() => post({ type: "queueRemove", id: item.id })}
            >
              <IconClose size={13} />
            </button>
          </div>
        ))}
      </div>
    );
  }
  return null;
}

