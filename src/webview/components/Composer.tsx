import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandView, FileRefView } from "../../shared/chat";
import type { AppState } from "../state";
import { post } from "../bridge";
import {
  IconAt,
  IconChevronDown,
  IconImage,
  IconShield,
  IconShieldCheck,
  IconShieldFilled,
  IconSlash,
  IconStop,
} from "../icons";
import { CtxText, Popover } from "./primitives";
import { fill, useTexts } from "../texts";

/** 权限模式的展示定义：图标固定用盾牌（WebUI 未提供专用图标），文案与 WebUI 对齐。 */
function permissionMeta(
  texts: ReturnType<typeof useTexts>,
): { id: string; label: string; desc: string; icon: JSX.Element }[] {
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
  // UI 里点「进入计划模式」不再直接发 /plan：记到这里，下一条消息发出时
  // 把 /plan 拼到消息前面一起提交（服务端会随消息进入计划模式）
  const pendingPlanRef = useRef(false);
  // 模型按钮 toggle 标志：标记「这次关闭是按钮触发的」，让 Popover 的
  // mousedown 外部检测跳过它（选中模型后弹层不关，再点按钮需能关闭）
  const modelToggleRef = useRef(false);
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
    // 进入计划模式时：把 /plan 拼到这条消息前面一起发出
    const text = pendingPlanRef.current ? `/plan ${draft.trim()}` : draft.trim();
    pendingPlanRef.current = false;
    post({ type: "send", text, attachments: state.attachments });
    onDraft("");
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
    if (trigger && candidates.length > 0) {
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
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(undefined);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
    if (event.key === "Escape" && state.running) post({ type: "stop" });
  };

  /** 每次输入后重算触发词。 */
  const refreshTrigger = (value: string, caret: number) => {
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

  // 实时生成速度：按最近 3 秒的输出 token 增量计算 tps（与 dsh web 一致，每秒刷新一次）
  const lastMessage = state.messages.at(-1);
  const liveUsage = lastMessage && (lastMessage.streaming || state.running) ? lastMessage.usage : undefined;
  const speedRef = useRef<{ t: number; n: number } | undefined>(undefined);
  const [tps, setTps] = useState<number | undefined>(undefined);
  const tpsValueRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const value = liveUsage?.outputTokens;
    const now = Date.now();
    if (typeof value !== "number") return;
    const prev = speedRef.current;
    if (prev && now - prev.t < 5_000 && value >= prev.n) {
      const tpsNow = (value - prev.n) / ((now - prev.t) / 1000);
      speedRef.current = { t: now, n: value };
      if (Math.abs((tpsNow ?? 0) - (tpsValueRef.current ?? 0)) >= 0.5) {
        tpsValueRef.current = tpsNow;
        setTps(tpsNow);
      }
      return;
    }
    speedRef.current = { t: now, n: value };
    tpsValueRef.current = undefined;
    setTps(undefined);
  }, [liveUsage?.outputTokens]);
  useEffect(() => {
    if (!state.running) {
      speedRef.current = undefined;
      tpsValueRef.current = undefined;
      setTps(undefined);
    }
  }, [state.running]);

  return (
    <div ref={appRef} className={`composer${mini ? " is-mini" : ""}`}>
      <Lump state={state} waitingApproval={waitingApproval} waitingQuestion={waitingQuestion} />

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
            {/* 权限：盾牌图标 + 权限名（不再显示 Agent） */}
            <div className="anchor">
              <button
                className="pill-mode"
                onClick={() => setModeOpen((v) => !v)}
                title={texts.permission}
              >
                {currentPermission.icon}
                {currentPermission.label}
                <IconChevronDown size={8} />
              </button>
              <Popover open={modeOpen} onClose={() => { setModeOpen(false); setConfirmFullAccess(false); }}>
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
                  className={`popover-item${state.planMode ? " is-selected" : ""}`}
                  onClick={() => {
                    if (state.planMode) {
                      // 退出计划模式：无副作用，即时切换
                      post({ type: "send", text: "/plan", attachments: [] });
                    } else {
                      // 进入计划模式：不直接发指令，下一条消息带 /plan 前缀发出
                      pendingPlanRef.current = true;
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

            <button className="pill" data-mini="hide" title={texts.commands} onClick={() => insertToken("/")}>
              <IconSlash size={13} />
            </button>
            <button className="pill" data-mini="hide" title={texts.addImage} onClick={() => post({ type: "addImages" })}>
              <IconImage size={13} />
            </button>
            {/* @ 走提及列表（选具体文件），不再直接弹系统文件对话框 */}
            <button className="pill" data-mini="hide" title={texts.mentionFiles} onClick={() => insertToken("@")}>
              <IconAt size={13} />
            </button>

            <span className="spacer" />

            {tps !== undefined ? (
              <span className="ctx-speed">{tps.toFixed(1)} tps</span>
            ) : null}
            <CtxText
              used={state.messages.at(-1)?.usage?.totalTokens}
              total={state.model?.contextWindow}
              usage={state.messages.at(-1)?.usage}
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

  /** 把触发字符插到光标处并立即唤起候选列表。 */
  function insertToken(token: string) {
    const el = textareaRef.current;
    const at = el?.selectionStart ?? draft.length;
    const needsSpace = at > 0 && !/\s/.test(draft[at - 1] ?? "");
    const next = `${draft.slice(0, at)}${needsSpace ? " " : ""}${token}${draft.slice(at)}`;
    onDraft(next);
    post({ type: "setDraft", text: next });
    const caret = at + (needsSpace ? 1 : 0) + token.length;
    setTrigger({ kind: token === "/" ? "command" : "mention", start: caret - 1, query: "" });
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
  }
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
  if (state.running) return null;
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
  if (state.queue > 0) {
    return (
      <div className="lump">
        <span>{fill(texts.queued, { n: state.queue })}</span>
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

