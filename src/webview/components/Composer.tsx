import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CommandView, FileRefView } from "../../shared/chat";
import type { AppState } from "../state";
import { post } from "../bridge";
import {
  IconChevronDown,
  IconClose,
  IconDsh,
  IconImage,
  IconShield,
  IconShieldCheck,
  IconShieldFilled,
  IconSparkles,
  IconStop,
} from "../icons";
import { CtxText, Ellipsis, Popover, formatDuration } from "./primitives";
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
  // UI 里点「进入计划模式」不直接发 /plan：记到所属会话 id，下一条消息发出时
  // 把 /plan 拼到消息前面一起提交（服务端随消息进入计划模式）。挂起态绑定会话，
  // 输入区显示「下轮生效」提示条并可以取消
  const [pendingPlan, setPendingPlan] = useState<string | undefined>(undefined);
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
    // 进入计划模式时：把 /plan 拼到这条消息前面一起发出（只认挂起态所属的会话）
    const pending = state.session !== undefined && pendingPlan === state.session.id;
    const text = pending ? `/plan ${draft.trim()}` : draft.trim();
    if (pending) setPendingPlan(undefined);
    post({ type: "send", text, attachments: state.attachments });
    onDraft("");
    dismissedRef.current = null;
    setTrigger(undefined);
  };

  /** 把触发词替换成选中的命令 / 文件。 */
  const applyCandidate = (index: number) => {
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
    // 文件作为附件芯片加入，文本里不留 @token
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
      {/* 计划模式挂起态：下一条消息带 /plan 前缀发出，可取消 */}
      {state.session !== undefined && pendingPlan === state.session.id && !state.planMode ? (
        <div className="lump is-stacked">
          <IconSparkles size={11} />
          <span>{texts.planPending}</span>
          <span className="spacer" />
          <button className="lump-cancel" onClick={() => setPendingPlan(undefined)}>
            {texts.cancel}
          </button>
        </div>
      ) : null}
      <Lump state={state} waitingApproval={waitingApproval} waitingQuestion={waitingQuestion} />

      {/* 运行状态：会话底部一行无边框文字；等待审批/提问时 agent 暂停，
          不该说「生成中」；队列消息与它并存（不再互相覆盖） */}
      {state.running && !waitingApproval && !waitingQuestion ? (
        <div className="running-line">
          <span className="lump-thinking" aria-hidden>
            <IconDsh size={13} />
          </span>
          <span>{texts.running}</span>
          <Ellipsis />
          <span className="lump-hint">{texts.runningHint}</span>
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
              return (
                <button
                  key={isCommand ? row.name : row.path}
                  className={`popover-item${index === highlight ? " is-selected" : ""}`}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyCandidate(index);
                  }}
                >
                  <span className="popover-item-main">
                    {isCommand ? `/${row.name}` : row.path}
                  </span>
                  {isCommand && row.description ? (
                    <span className="popover-item-sub">{row.description}</span>
                  ) : !isCommand && row.kind === "directory" ? (
                    <span className="popover-item-sub">{texts.attachFolder}</span>
                  ) : null}
                </button>
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
                <span className="chip" key={attachment.id} title={attachment.path ?? attachment.name}>
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
                      <span className="popover-item-main">{item.label}</span>
                      <span className="popover-item-sub">{item.desc}</span>
                    </button>
                  ))
                )}
                <div className="popover-sep" />
                <button
                  className={`popover-item${
                    state.planMode || (state.session !== undefined && pendingPlan === state.session.id)
                      ? " is-selected"
                      : ""
                  }`}
                  onClick={() => {
                    if (state.planMode) {
                      // 退出计划模式：无副作用，即时切换
                      post({ type: "send", text: "/plan", attachments: [] });
                    } else {
                      // 进入计划模式：不直接发指令，下一条消息带 /plan 前缀发出。
                      // 挂起态绑定当前会话，输入区显示「下轮生效」提示条、可取消
                      setPendingPlan(state.session?.id);
                    }
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
                    <div className="segment">
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
                图片按钮按当前模型的 acceptsImage 动态显示。 */}
            {state.model?.acceptsImage ? (
              <button className="pill" data-mini="hide" title={texts.addImage} onClick={() => post({ type: "addImages" })}>
                <IconImage size={13} />
              </button>
            ) : null}

            <span className="spacer" />

            {tps !== undefined ? (
              <span className="ctx-speed" title={statsTitle || undefined}>{tps.toFixed(1)} tps</span>
            ) : null}
            <CtxText
              percent={state.contextOccupancy?.percent}
              used={state.contextOccupancy?.usedTokens ?? lastMessage?.usage?.totalTokens}
              total={state.contextOccupancy?.contextWindow ?? state.contextWindow?.tokens ?? state.model?.contextWindow}
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
 * 缺口状态条。按优先级显示当前最该被看到的状态——与 Continue 的 LumpToolbar
 * 同样的思路，但只保留 dsh 真正需要的分支。
 */
function Lump({
  state,
  waitingApproval,
  waitingQuestion,
}: {
  state: AppState;
  waitingApproval: boolean;
  waitingQuestion: boolean;
}) {
  const texts = useTexts();
  // 等待审批/提问优先：那时 agent 暂停等人，不该说「生成中」
  if (waitingApproval) {
    return (
      <div className="lump">
        <span>{texts.waitingApproval}</span>
        <span className="spacer" />
        <span className="lump-hint">{texts.waitingApprovalHint}</span>
      </div>
    );
  }
  if (waitingQuestion) {
    return (
      <div className="lump">
        <span>{texts.waitingQuestion}</span>
        <span className="spacer" />
        <span className="lump-hint">{texts.waitingQuestionHint}</span>
      </div>
    );
  }
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
              className="queue-cancel"
              title={texts.queueRemove}
              onClick={() => post({ type: "queueRemove", id: item.id })}
            >
              <IconClose size={11} />
            </button>
          </div>
        ))}
      </div>
    );
  }
  const todos = state.todos.filter((todo) => todo.status !== "completed").length;
  if (todos > 0) {
    return (
      <div className="lump">
        <span>{fill(texts.todosLeft, { n: todos })}</span>
      </div>
    );
  }
  return null;
}

