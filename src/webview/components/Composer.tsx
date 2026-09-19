import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { GoalView } from "../../shared/chat";
import type { AppState } from "../state";
import { post } from "../bridge";
import {
  IconAt,
  IconAttach,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconDsh,
  IconFolder,
  IconPause,
  IconPencil,
  IconPlay,
  IconRefresh,
  IconSend,
  IconShield,
  IconShieldCheck,
  IconShieldFilled,
  IconStop,
  IconTarget,
} from "../icons";
import { CtxText, Ellipsis, Popover, Spinner, contextNumbers, formatDuration } from "./primitives";
import { ApprovalCard, PlanReviewCard, QuestionCard, formatTps } from "./Rows";
import type { PendingInteraction } from "../pendingInteraction";
import { useComposerCompletion } from "../composerCompletion";
import { bottomGap, type AutoScrollPort } from "../autoScroll";
import { queueDisplayOrder } from "../queueOrder";
import { segmentColumns } from "../segment";
import { fill, resolveText, useTexts } from "../texts";
import { BAR_ORDER, pickVariants, type ToolbarVariant } from "../toolbarFit";

/**
 * 输入框的布局、工具行与文本域。
 *
 * **`@` / `/` 补全的一切规则都不在这里**：触发词判定、候选取用与优先级、
 * `pick` / `drill`、光标落点、弹层键盘导航与弹层 JSX 全部归
 * `composerCompletion.tsx` 的 `useComposerCompletion`（本组件只调它并摆位）。
 * 光标算术是那边的纯函数（`caretAfterInsert` / `insertToken`），离线可断言。
 *
 * **贴底 / 回底那一套也不在这里**：意愿、手势、胶囊状态全在 `autoScroll.ts`
 * （本组件只拿它的端口读滚动容器），这里剩下的只有一个瞬时补回的容差：
 */

/**
 * 量高瞬态补回的判据：量高**前**距底 ≤ 1px 才算"原本贴底"。
 *
 * 比 `autoScroll.ts` 的 `STICK_THRESHOLD_PX`（40）严得多，是**有意**的：这一条不是
 * 「意愿」判定，而是"刚才那一下瞬态要不要补回原位"，宁可少补也不能把用户从
 * 阅读位置拽到底部。两处用途不同，所以各自留一个显式的数。
 */
const RESTORE_TOLERANCE_PX = 1;

/**
 * 权限模式的展示定义：图标固定用盾牌（WebUI 未提供专用图标），文案与 WebUI 对齐。
 */
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

/** 一帧都没结算时的空集合（模块级常量：避免每次渲染新建 Set 触发无谓的重渲染）。 */
const EMPTY_RANKS: ReadonlySet<number> = new Set();

/**
 * 底部工具栏的自适应：量出候选档位的**实际宽度**，按 `toolbarFit.ts` 的优先级
 * 决定这一帧显示哪些（分配规则在那边，这里只管「量」与「什么时候重量」）。
 *
 * 两个触发点：
 * - 每次提交后的 layout effect：文案、字号、语言、模型名、数字位数变了就重量，
 *   并且在 layout 阶段结算——不会先画一帧「全挤在一起」再收回去；
 * - `.composer-bar` 的 ResizeObserver：侧栏被拖动、可用宽度变了就重量。
 *
 * 全程没有写死的像素阈值：「多宽显示谁」完全由实测宽度算出来，
 * 所以换语言（权限名长短差近一倍）、换模型、调字号都自动跟上。
 */
function useToolbarFit(barRef: React.RefObject<HTMLDivElement>, variants: ToolbarVariant[]) {
  /** 测量层里的 DOM（rank → 元素），宽度每次结算时重新读。 */
  const nodes = useRef(new Map<number, HTMLElement>());
  // 每次渲染刷新「当前档位表」：ResizeObserver 的回调引用是稳定的，
  // 只有通过 ref 才能读到这一帧的表
  const latest = useRef(variants);
  latest.current = variants;
  /** 上一次结算出的档位签名（排序后的 rank），用来判断要不要重新渲染。 */
  const signature = useRef("");
  const [shown, setShown] = useState<ReadonlySet<number>>(EMPTY_RANKS);

  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const style = getComputedStyle(bar);
    const px = (value: string) => Number.parseFloat(value) || 0;
    // 可用宽度 = 内容盒宽度（clientWidth 已排除边框与滚动条）再扣掉左右内边距
    const available = bar.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
    // 间距同样读实算值：宽/窄两种形态的 gap 不一样（`.app.is-mini` 会改它）
    const gap = px(style.columnGap);
    const measured = latest.current.map((variant) => ({
      ...variant,
      // 每次都**重新读 DOM**，不能沿用 ref 回调那一次的结果：文案/字号/语言变了
      // 宽度就变，而节点本身没有重新挂载，ref 回调不会再触发
      width: nodes.current.get(variant.rank)?.getBoundingClientRect().width ?? 0,
    }));
    const picked = [...pickVariants(measured, available, gap).values()]
      .map((variant) => variant.rank)
      .sort((a, b) => a - b)
      .join(",");
    if (picked === signature.current) return;
    signature.current = picked;
    setShown(new Set(picked ? picked.split(",").map(Number) : []));
  }, [barRef]);

  useLayoutEffect(fit);

  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const observer = new ResizeObserver(fit);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [barRef, fit]);

  // ref 回调必须**稳定**：每次渲染新建函数的话，React 会先把旧的解绑（传 null）
  // 再绑新的，白白多一轮往返。档位表变没变看 rank 列表就够了。
  const ranks = variants.map((variant) => variant.rank).join(",");
  const register = useMemo(() => {
    const map = new Map<number, (element: HTMLElement | null) => void>();
    for (const rank of ranks ? ranks.split(",").map(Number) : []) {
      map.set(rank, (element) => {
        if (element) nodes.current.set(rank, element);
        else nodes.current.delete(rank);
      });
    }
    return map;
  }, [ranks]);

  return { shown, register };
}

export function Composer({
  state,
  pending,
  chatScroll,
  onDraft,
  onFollowLatest,
}: {
  state: AppState;
  /** 正在等用户回答的交互（审批 / 提问）：有它时**接管**输入区（官方 `conversation.composer` 槽）。 */
  pending?: PendingInteraction;
  /**
   * 会话滚动区的**唯一端口**（`autoScroll.ts`）：贴底意愿、放跟随、回最新这套规则
   * 都在那个模块里，这里只借用它的滚动容器——自适应量高的瞬态会把容器的高度与
   * scrollTop 各动一次（见下方 effect 的注释），补回动作要在绘制之前做。
   */
  chatScroll?: AutoScrollPort;
  onDraft: (text: string) => void;
  /**
   * 用户显式"要看最新"时回调（发消息 / 插话）：恢复贴底并回到底部。
   *
   * 官方 `useAutoScroll` 同口径（用户消息数变化即重新打开跟随）。脱贴只看**滚动手势**，
   * 而"发出去"本身就是"我要看回答"——不该还停在旧的阅读位置。
   */
  onFollowLatest?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [modeOpen, setModeOpen] = useState(false);
  // 模型按钮 toggle 标志：标记「这次关闭是按钮触发的」，让 Popover 的
  // mousedown 外部检测跳过它（选中模型后弹层不关，再点按钮需能关闭）
  const modelToggleRef = useRef(false);
  // 权限按钮与模型按钮同机制：弹层已开时再点按钮是关闭，而不是被外部检测
  // 「关掉」之后又被 click 翻转回来
  const modeToggleRef = useRef(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const texts = useTexts();
  const permissions = permissionMeta(texts);

  const draft = state.draft;
  /**
   * `@` / `/` 补全：弹层 + 文本域要接的那几个 prop。
   *
   * 这个 hook **拥有**整套规则（触发词判定、候选取用与优先级、父目录查询、
   * `pick` vs `drill`、光标落点、ESC 优先级链、弹层键盘导航与弹层 JSX），
   * 也拥有宿主下发的「插到光标处」请求。组件这边只剩布局 / 工具行 / 文本域。
   */
  const completion = useComposerCompletion({
    draft,
    commands: state.commands,
    fileRefs: state.fileRefs,
    texts,
    onDraft,
    // 弹层没接管时的 Enter（含 Cmd/Ctrl+Enter 的加速手势）：键的语义住在补全 hook 里，
    // 这里只把「怎么发」交给它——分在两地时，2026-09-19 就丢过一次（回车变换行）。
    // 包一层箭头：`send` 在下面才声明（它是组件自己的发送入口）。
    onSubmit: (gesture) => send(gesture),
    insertRequest: state.insertRequest,
    // 补全 hook 与下面的自适应量高 / 焦点归还要用**同一个**文本域节点
    textareaRef,
  });
  // 「有没有在等审批 / 提问」不在这个组件里再推一遍：它就是 `pending` 这个 prop
  // 本身（选举结果见 `pendingInteraction.ts`），下面的运行中那行直接读它。

  // 自适应高度
  //
  // 「塌回 auto 再量」有一帧内的瞬态，必须在这里一并消化掉，否则多行草稿打字时
  // 整个会话内容会跟着每次按键上下弹一行高（用户 2026-09-17 报的「输入大于 1 行时
  // 打字会话页闪烁」；实测探针：贴底 scrollTop 1021 ↔ 1000 来回振荡）：
  // - textarea 塌回一行 → 输入区变矮 → `.chat-scroll` 可视端口**变高** → 浏览器
  //   立刻把 scrollTop **夹小**（贴底时 1021→1000）；随后量完把高度设回去，端口
  //   复原，但 scrollTop 不会自己弹回来——下一帧 rAF 的 settle 才钉回底部。
  //   于是每个按键都落进「底部缺一条 → 钉回」的一帧振荡。
  // - 输入框**长高**的那次（换行）则相反：端口变矮裁掉底部一条，同样要等下一帧。
  // 两者的修复都是「绘制之前」在本 effect 里补：先记量高前的贴底距离与 scrollTop，
  // 量完把被夹走的 scrollTop 补回；原本贴底而端口变矮时直接钉底（与 settle 的
  // 裁定一致，只是提前到同一帧）。一行草稿塌回 auto 高度不变，天然无此问题。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const pane = chatScroll?.scrollEl.current ?? null;
    const distBefore = pane ? bottomGap(pane) : 0;
    const prevTop = pane?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.7)}px`;
    if (!pane) return;
    if (pane.scrollTop !== prevTop) {
      // auto 瞬态把端口撑高、scrollTop 被浏览器夹小：补回原位。
      // （赋值超上限时浏览器自动夹住 = 恰好贴底，与「无瞬态」的理想布局一致。）
      pane.scrollTop = prevTop;
    } else if (distBefore <= RESTORE_TOLERANCE_PX) {
      // 原本贴底而这次量高让端口变矮：settle 要到下一帧才钉，那一帧底部缺一条
      // ——直接在这里钉住（贴底 ≤1px 时意愿必为跟随，与 settle 的裁定同源）。
      if (bottomGap(pane) > 0) pane.scrollTop = pane.scrollHeight;
    }
  }, [draft, chatScroll]);

  // 运行结束后把焦点还给输入框
  useEffect(() => {
    if (state.running) return;
    // 但**别从别人手里抢**：用户这时可能在历史抽屉的搜索框、目标编辑框里打字
    // （这一轮结束时把焦点抽走，正在敲的字就断了）。只有焦点空闲（body）或本来
    // 就在输入框里时才还回去。
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active !== textareaRef.current) return;
    textareaRef.current?.focus();
  }, [state.running]);

  /**
   * 能不能发送。
   *
   * `stopped`（按钮态：关掉 `dshChat.autoConnect`、用户点过停止、或内部那套不在）
   * **也算能发**：用户口径（2026-09-14，2026-09-18 沿用）是"发消息这类显式动作照旧
   * 允许拉起后台"——输入了一句话却发不出去、还得先去点按钮，是把自动连接的语义读成了
   * "什么都不许做"。`connecting` / `error` 不给发：正在连或连不上，发出去只会失败。
   */
  const canSend = draft.trim().length > 0 && (state.connection === "ready" || state.connection === "stopped");

  /**
   * 把草稿发出去。
   *
   * 只发**手势**，不发模式：`session/prompt.mode` 由宿主按 `ui-conversation.busyEnter`
   * + 「按下的那一刻 agent 在不在跑」解析（官方 resolveSubmitMode）。界面自己算会算错
   * ——它拿到的是上一帧的 running。
   *
   * 候选弹层打开时 Enter 到不了这里（补全 hook 的 onKeyDown 先消费并
   * `stopPropagation`），所以这里不必再判弹层状态。
   */
  const send = (gesture: "enter" | "accelerated" = "enter") => {
    if (!canSend) return;
    post({ type: "send", text: draft.trim(), attachments: state.attachments, gesture });
    // 发出去了就是要看回答：脱贴状态下也贴回最新（与切会话同一条规则）
    onFollowLatest?.();
    onDraft("");
  };

  const currentPermission =
    permissions.find((item) => item.id === state.permission) ?? permissions[1];

  // 生成速度：**始终**显示明细里那条「平均输出速度」——全会话累计
  // （Σ 输出 token ÷ Σ 解码窗口，`sessionStats` 投影），与 Web 的会话统计同口径。
  //
  // 此前取的是「最近一条助手消息的解码窗口吞吐」（逐 token 帧时间戳折出来的
  // `usage.tokensPerSecond`，回退宿主保留的 `lastSpeed`）：那是**另一个数**，
  // 与悬停明细里写的「平均输出速度」对不上，用户看到的就是「胶囊上的数字和
  // 明细里的不一样」（2026-09-15 口径：以明细为准，两边同一个数）。
  const stats = state.sessionStats;
  const lastMessage = state.messages.at(-1);
  const tps =
    stats && stats.decodeMs > 0 && stats.decodeTokens > 0
      ? stats.decodeTokens / (stats.decodeMs / 1000)
      : undefined;
  const speedValue = tps !== undefined ? formatTps(tps) : undefined;

  // 速度值的悬停明细：全日志会话统计（`sessionStats` 投影），口径对齐
  // Web 的「会话统计」对话框；未知项省略，无数据则不显示 tooltip。
  // 第一行是**标题**；「平均输出速度」这一行与胶囊上的数字**同源同格式**
  // （同一个 `formatTps` + 同一个词典 key），否则「显示的是不是同一个值」
  // 又要靠人眼比对。
  const statsTitle = stats
    ? [
        texts.statsTitle,
        stats.llmMs > 0 ? `${texts.statsLlmTime} ${formatDuration(stats.llmMs)}` : null,
        stats.toolMs > 0 ? `${texts.statsToolTime} ${formatDuration(stats.toolMs)}` : null,
        stats.ttftSteps > 0 ? `${texts.statsTtft} ${formatDuration(stats.ttftMs / stats.ttftSteps)}` : null,
        speedValue !== undefined ? `${texts.statsSpeed} ${texts.tokensPerSecond(speedValue)}` : null,
      ]
        .filter((line): line is string => line !== null)
        .join("\n")
    : undefined;



  /* ---------------- 底部工具栏：候选档位表 ---------------- */
  //
  // 每个档位一个节点，键是 `槽位:档位`，与 `toolbarFit.ts` 的 BAR_ORDER 一一对应。
  // 这些节点是**先渲染、再决定显不显示**的：`useToolbarFit` 会把整张表渲染进一个
  // 不可见的测量层里量出各自的实际宽度，再按优先级挑出这一帧显示哪些。
  //
  // 缺数据的档位（模型没有思考档位、还没有 tps、还没有上下文测量）直接不进表——
  // 渲染成 null 的档位会白占一个坑位和一段间距，把本来装得下的东西挤掉。

  /** 权限胶囊：`withLabel` 是用户口径里最低优先级那一档（图标 + 权限名）。 */
  const permissionPill = (withLabel: boolean) => (
    <button
      className="pill-mode"
      title={currentPermission.label}
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
    >
      {currentPermission.icon}
      {withLabel ? <span className="pill-mode-label">{currentPermission.label}</span> : null}
      <IconChevronDown size={8} />
    </button>
  );

  /** 模型切换按钮（P0）。 */
  const modelPill = (
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
  );

  // 思考强度：用户口径的次优先级元素，显示在模型按钮右侧。
  // 只读展示当前档位（改档位仍在弹层里选，避免点一下就把思考深度换掉）；
  // 点它开/关**同一个**模型弹层（思考档位就在那一层里）。开合语义必须与模型
  // 按钮**逐字一致**（都是 toggle + 同一个 modelToggleRef）——否则「弹层开着时
  // 再点一下」在模型按钮上关闭、在思考强度上却没反应，看起来像按钮失灵。
  const effort = state.model?.efforts?.find((item) => item.id === state.model?.reasoningEffort);
  const effortPill = effort ? (
    <button
      className="pill pill-effort"
      title={texts.thinkingDepth}
      onMouseDown={() => {
        // 与模型按钮共用同一个标志：两者开的是同一个弹层
        modelToggleRef.current = true;
      }}
      onClick={() => {
        // 同一次交互内消费标志（mousedown 已先于 click 触发）。
        // toggle 与模型按钮同一语义：弹层开着时再点一下就关掉
        setTimeout(() => {
          modelToggleRef.current = false;
        }, 0);
        setModelOpen((v) => !v);
      }}
    >
      {effort.name}
    </button>
  ) : null;

  // 附件按钮是通用入口：图片按图片发送，其余文件逐字节上传
  // （@ 只产生引用，真正上传只从这里发生），所以它不随模型是否支持图片而隐藏。
  const attachPill = (
    <button className="pill" title={texts.attachFile} onClick={() => post({ type: "addFiles" })}>
      <IconAttach size={13} />
    </button>
  );

  const speedText =
    speedValue !== undefined ? (
      <span className="ctx-speed" title={statsTitle || undefined}>
        {texts.tokensPerSecond(speedValue)}
      </span>
    ) : null;

  // 上下文占用：三个值**同源**，都取自宿主按官方口径算好的 contextOccupancy。
  // 刻意不回退到 usage / contextWindow 事件——那会得到一个含 output、
  // 且压缩后不下降的数，与投影口径不是一回事（同一个圆环在不同时刻
  // 代表不同东西，正是「数字卡住 / 乱跳」的观感来源）。
  const ctxNumbers = contextNumbers(
    state.contextOccupancy?.percent,
    state.contextOccupancy?.usedTokens,
    state.contextOccupancy?.contextWindow,
  );
  const ctxProps = {
    percent: state.contextOccupancy?.percent,
    used: state.contextOccupancy?.usedTokens,
    total: state.contextOccupancy?.contextWindow,
    // 明细里的缓存命中与构成是**独立**的投影，有就显示
    usage: lastMessage?.usage,
    breakdown: state.contextBreakdown,
  };

  // 运行中的主按钮（官方 `primaryStops = running && (empty || blocked)`）：
  // - 草稿为空 → 停止（生成中还能"点一下停"，这是用户最需要的动作）；
  // - 草稿非空 → **发送**，文案按 `busyEnter` 标成「排队发送 / 插话发送」。
  //
  // 以前运行中一律是「停止」，于是设置项描述里的「发送按钮的行为」在本扩展里
  // 根本无从生效（审计结论 §3.4）。
  const busySendLabel = state.busyEnter === "steer" ? texts.sendSteer : texts.sendQueue;
  const sendPill = state.running && !canSend ? (
    <button className="send-btn is-stop" title={texts.stopTitle} onClick={() => post({ type: "stop" })}>
      <IconStop size={12} />
    </button>
  ) : (
    <button
      className="send-btn"
      disabled={!canSend}
      title={state.running ? busySendLabel : texts.sendTitle}
      onClick={() => send("enter")}
    >
      {state.running ? busySendLabel : texts.send}
    </button>
  );

  const barNodes: Record<string, ReactNode> = {
    "permission:icon": permissionPill(false),
    "permission:label": permissionPill(true),
    "model:full": modelPill,
    "send:full": sendPill,
    "effort:full": effortPill,
    "attach:full": attachPill,
    "tps:full": speedText,
    "context:ring": ctxNumbers ? <CtxText {...ctxProps} /> : null,
    "context:text": ctxNumbers ? <CtxText {...ctxProps} detailed /> : null,
  };
  const barVariants: ToolbarVariant[] = BAR_ORDER.filter(
    (spec) => barNodes[`${spec.slot}:${spec.level}`] != null,
  ).map((spec) => ({ ...spec, width: 0 }));
  const barRef = useRef<HTMLDivElement>(null);
  const { shown, register } = useToolbarFit(barRef, barVariants);
  /** 这一帧实际要渲染的节点（槽位 → 节点），按优先级分配的结果。 */
  const bar: Record<string, ReactNode> = {};
  for (const variant of barVariants) {
    if (shown.has(variant.rank)) bar[variant.slot] = barNodes[`${variant.slot}:${variant.level}`];
  }

  return (
    <div className="composer">
      {/* 目标条：官方 dock 在输入框上方的同一个位置（`conversation.input.dock`） */}
      <GoalBar goal={state.goal} />
      {/* 待处理的审批 / 提问接管输入区（官方 `conversation.composer` 的 `pendingInteraction`
          选举）：卡片常驻视野、就在你敲字的地方，而不是滚上去就看不见。
          已答过的卡不在这里——它们留在对话流里当记录（见 Message.tsx）。
          计划审阅卡自带「条带 + 内滚正文 + 底部决定行」，限高交给它自己
          （见 `is-plan-review`），否则外层再限一次就成了两层滚动条。 */}
      {pending ? (
        <div
          className={`composer-interaction${pending.kind === "plan-review" ? " is-plan-review" : ""}`}
        >
          {pending.kind === "approval" ? (
            <ApprovalCard approval={pending.approval} />
          ) : pending.kind === "plan-review" ? (
            <PlanReviewCard question={pending.question} review={pending.review} />
          ) : (
            <QuestionCard question={pending.question} batch={state.questionBatch} />
          )}
        </div>
      ) : null}
      <Lump state={state} onFollowLatest={onFollowLatest} />

      {/* 运行状态：会话底部一行无边框文字；等待审批/提问时 agent 暂停，
          不该说「生成中」；队列消息与它并存（不再互相覆盖）。
          提示文案跟着 ESC 的实际行为走：有排队消息时 ESC 还会把队首发出去。
          判据是 `!pending`（**等价于**原来的「没有 waiting 的审批且没有 waiting 的提问」）：
          选举只认 `waiting` 的审批 / 提问，存在任何一张就必被选中，所以「没有待处理交互」
          与「没有 waiting 的审批/提问」是同一件事——这里不再自己 `.some(...)` 推第三遍。 */}
      {state.running && !pending ? (
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

      {/* 触发词候选弹层（`@` / `/`）：规则与 JSX 都在 composerCompletion.tsx。 */}
      {completion.popover}

      <div className="composer-shell">
        {/*
          拖放接取**不在这里**：全页由 App 的 usePageFileDrop 统一接（window 监听），
          输入框自己不再处理 drop——两处都接会双发 attachBytes（同一份文件两条附件）。
          平台限制（拖入必须按住 Shift，否则 VS Code 把文件打开）见 `dropAttach.ts`。
        */}
        <div className="composer-box">
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
                      // 悬停给出**服务端/宿主的真实失败原因**，不再一律「上传失败」：
                      // 原因可能是 `@` 标记（如缺会话），也可能是服务端原始报错
                      // （原样显示，不翻译）——都过一遍 resolveText
                      title={
                        attachment.upload.message
                          ? texts.uploadFailedReason(resolveText(attachment.upload.message, texts))
                          : texts.uploadFailed
                      }
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

          {/* 触发词（`@` / `/`）的 ref 与 onChange / onKeyUp / onClick / onKeyDown
              全在 `completion.textareaProps` 里：ESC 优先级链、Enter/Tab 的补全语义、
              两次写草稿都在那边，组件不能再写一份。 */}
          <textarea
            className="composer-input"
            rows={1}
            value={draft}
            placeholder={state.messages.length ? texts.placeholderFollowUp : texts.placeholderFirst}
            {...completion.textareaProps}
          />

          {/* 底部工具栏：显示哪些由 useToolbarFit 按实测宽度 + 优先级决定，
              这里只按视觉顺序摆位（槽位 → 节点）。 */}
          <div className="composer-bar" ref={barRef}>
            {/* 权限：P0（始终显示）。窄时只有盾牌图标，宽裕时才补上权限名。
                悬停始终有 title，点开弹层也能看到权限名。 */}
            <div className="anchor">
              {bar.permission}
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

            {/* 模型切换：P0（始终显示）。 */}
            <div className="anchor">
              {bar.model}
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

            {/* 思考强度：次优先级，紧挨在模型右侧（点它开模型弹层）。 */}
            {bar.effort}

            {/* / 与 @ 直接在输入框里打符号即可触发，不再放按钮。
                附件按钮是通用入口：图片按图片发送，其余文件逐字节上传
                （@ 只产生引用，真正上传只从这里发生），所以它不随模型
                是否支持图片而隐藏。 */}
            {bar.attach}

            <span className="spacer" />

            {/* tps 与上下文占用：次优先级（占用只给圆环）；最宽裕时圆环
                右侧才补上 `44K/128K` 的精确数值（最低优先级）。 */}
            {bar.tps}
            {bar.context}

            {bar.send}

            {/* 测量层：把**所有**候选档位渲染出来量实际宽度（见 useToolbarFit）。
                零尺寸 + overflow: hidden，所以既不占位也不给页面添横向滚动条；
                visibility: hidden 让它不进无障碍树、也不吃 Tab 焦点。 */}
            <div className="composer-measure" aria-hidden="true">
              <div className="composer-measure-row">
                {barVariants.map((variant) => (
                  <span
                    className="measure-item"
                    key={`${variant.slot}:${variant.level}`}
                    ref={register.get(variant.rank)}
                  >
                    {barNodes[`${variant.slot}:${variant.level}`]}
                  </span>
                ))}
              </div>
            </div>
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
  // 内联编辑的草稿：undefined = 不在编辑态。必须放在早退之前（hooks 顺序固定）
  const [draft, setDraft] = useState<string | undefined>(undefined);
  // 目标正文默认一行截断，展开后显示全文（再点收起）
  const [expanded, setExpanded] = useState(false);
  const objectiveRef = useRef<HTMLSpanElement>(null);
  /**
   * 正文是否**真的**被截断了（默认一行 + 省略号，见 `.goal-objective` 的 CSS）。
   *
   * 没被截断时展开按钮是纯噪音——点了什么都不会变，只会把整条撑成两行（用户
   * 2026-09-14 报的）。量法与 `.row-detail-dir` 的渐隐判定同一套：Range 量的是
   * 文本的**自然宽度**（`overflow: hidden` 只影响绘制，不影响 Range 的矩形），
   * 比盒子宽就是被截断了。
   *
   * 展开态**不测**：那时正文已经换行铺开，量出来必然「不截断」，会把收起按钮
   * 一起藏掉——按钮一旦因截断出现过，就一直留到收起为止。
   */
  const [truncated, setTruncated] = useState(false);
  const objective = goal?.objective;
  useLayoutEffect(() => {
    if (expanded || !objective) return;
    const el = objectiveRef.current;
    if (!el) return;
    const check = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      setTruncated(range.getBoundingClientRect().width - el.clientWidth > 1);
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, objective]);
  if (!goal || goal.phase === "complete") return null;
  const phase =
    goal.phase === "paused"
      ? texts.goalPaused
      : goal.phase === "blocked"
        ? texts.goalBlocked
        : texts.goalActive;
  const run = (action: "pause" | "resume" | "clear") =>
    post({ type: "runCommand", line: `/goal ${action}` });
  /**
   * 提交内联编辑走 `/goal edit <objective>`：与暂停 / 恢复 / 清除同一条命令通道，
   * 结果会作为命令节点留在对话里（看得见生效没有）。
   *
   * 目标正文必须先压成**一行**：命令是按行解析的，正文里的换行会把剩下的部分
   * 变成第二条命令。空正文不提交（服务端也会拒），直接退出编辑态。
   */
  const save = () => {
    const objective = (draft ?? "").replace(/\s*\n\s*/g, " ").trim();
    setDraft(undefined);
    if (objective) post({ type: "runCommand", line: `/goal edit ${objective}` });
  };
  if (draft !== undefined) {
    return (
      <div className="goal-bar is-editing">
        <span className="goal-icon" aria-hidden>
          <IconTarget size={12} />
        </span>
        <input
          className="goal-edit-input"
          aria-label={texts.goalEdit}
          // 用原正文当占位符：输入框空着也知道在改什么
          placeholder={goal.objective}
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
            else if (event.key === "Escape") {
              // **必须吃掉这次 ESC**：不 stopPropagation 的话，窗口层那个
              // 「ESC = 停止生成」的兜底监听会跟着触发——用户只是想取消改目标，
              // 结果把正在跑的这一轮也中止了（ESC 优先级链见 App.tsx）。
              event.preventDefault();
              event.stopPropagation();
              setDraft(undefined);
            }
          }}
        />
        <button className="goal-action" title={texts.goalSave} onClick={save}>
          <IconCheck size={12} />
        </button>
        <button className="goal-action" title={texts.goalCancel} onClick={() => setDraft(undefined)}>
          <IconClose size={12} />
        </button>
      </div>
    );
  }
  return (
    <div
      className={`goal-bar is-${goal.phase}${expanded ? " is-expanded" : ""}`}
      // 悬停必须能读到**完整目标**：受阻时把受阻原因接在后面，而不是拿它顶掉目标
      // （顶掉的那版让人看不到自己在做什么）
      title={goal.blockedReason ? `${goal.objective}\n${goal.blockedReason}` : goal.objective}
    >
      <span className="goal-icon" aria-hidden>
        <IconTarget size={12} />
      </span>
      <span className="goal-phase">{phase}</span>
      <span className="goal-objective" ref={objectiveRef}>
        {goal.objective}
      </span>
      {goal.maxRounds ? (
        <span className="goal-rounds">{`${goal.rounds}/${goal.maxRounds}`}</span>
      ) : null}
      <span className="spacer" />
      {/* 展开 / 收起全文：正文默认一行截断，要看全文按这里（悬停也能看）。
          位置按用户要求放在暂停按钮**左侧**；**只有真的被截断时才出现**——
          一行放得下的目标不需要这个按钮。 */}
      {truncated || expanded ? (
        <button
          className={`goal-action goal-expand${expanded ? " is-open" : ""}`}
          title={expanded ? texts.goalCollapse : texts.goalExpand}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <IconChevronDown size={12} />
        </button>
      ) : null}
      {goal.phase === "active" ? (
        <button className="goal-action" title={texts.goalPause} onClick={() => run("pause")}>
          <IconPause size={12} />
        </button>
      ) : (
        <button className="goal-action" title={texts.goalResume} onClick={() => run("resume")}>
          <IconPlay size={12} />
        </button>
      )}
      {/* 内联编辑：官方 GoalBar 的动作就是 pause/resume、edit（同一横条里的内联表单）
          与 clear 三个，这里对齐 */}
      <button
        className="goal-action"
        title={texts.goalEdit}
        onClick={() => setDraft(goal.objective)}
      >
        <IconPencil size={12} />
      </button>
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
function Lump({
  state,
  onFollowLatest,
}: {
  state: AppState;
  /** 把排队的那条立刻发出去 = 要看回答：与 `send` 同一条"贴回最新"规则（见 `Composer`）。 */
  onFollowLatest?: () => void;
}) {
  const texts = useTexts();
  if (state.queueItems.length > 0) {
    // 排队中（尚未发送）的消息逐条列出，每条可单独取消。
    // 不套状态条边框：做成淡化版用户消息气泡，和上方对话同一视觉语言
    //
    // **显示顺序**：插话（`steering`，马上进当前轮）排在排队（`queued`，等下一轮）上方
    // （用户 2026-09-15 口径；只动显示，数据顺序留给宿主重发用，见 `queueOrder.ts`）
    const items = queueDisplayOrder(state.queueItems);
    return (
      <div className="queue">
        <span className="queue-head">{fill(texts.queued, { n: items.length })}</span>
        {items.map((item) => (
          <div className="queue-item" key={item.id}>
            <span className="queue-text">{item.text || texts.queueMediaOnly}</span>
            {/* 「插话发送」（官方 queue 行的第三个动作 `{kind:'steer'}`）：
                只对**排队中**的那条给出（已经是 steering 的不必再来一次），
                并且只有 agent 正在运行时可用——服务端同样要求运行中，否则回
                `session/steer-unavailable`（宿主按官方口径静默处理）。 */}
            {item.placement !== "steering" ? (
              <button
                className="queue-action"
                disabled={!state.running}
                title={state.running ? texts.queueSteer : texts.queueSteerUnavailable}
                onClick={() => {
                  post({ type: "queueSteer", id: item.id });
                  // 把排队的那条立刻发出去 = 要看回答：同 `send`，脱贴也贴回最新
                  onFollowLatest?.();
                }}
              >
                <IconSend size={12} />
              </button>
            ) : null}
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

