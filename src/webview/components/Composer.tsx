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
import { AUTO_REVIEW_PRESET, type GoalView, type QueuedMessageView } from "../../shared/chat";
import type { AppState } from "../state";
import { post } from "../bridge";
import {
  IconAttach,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconDsh,
  IconPause,
  IconPencil,
  IconPlay,
  IconRefresh,
  IconSend,
  IconPermissionReadOnly,
  IconPermissionWorkspaceWrite,
  IconPermissionFullAccess,
  IconPermissionAutoReview,
  IconStop,
  IconTarget,
} from "../icons";
import { CtxText, Ellipsis, Popover, Spinner, contextDetailLines, contextNumbers, formatDuration } from "./primitives";
import { ApprovalCard, PlanReviewCard, QuestionCard, formatTps } from "./Rows";
import type { PendingInteraction } from "../pendingInteraction";
import { useComposerCompletion } from "../composerCompletion";
import { consumeEscape } from "../escapeOwner";
import { clickGestureHandler, sendButtonView, watchModifierKeys } from "../composerSend";
import { hitsAnyRect } from "../composerMention";
import { ComposerSessionDraft } from "../composerSessionDraft";
import { openMentionTarget } from "../mentionOpen";
import { usePickerFocus } from "../pickerFocus";
import { presetDisplayText } from "../presetDisplay";
import { bottomGap, type AutoScrollPort } from "../autoScroll";
import { queueDisplayOrder, queueItemHasAttachments } from "../queueOrder";
import { queueTextIsClipped } from "../queueHover";
import { readableMentionText } from "../mentionLinks";
import { segmentColumns } from "../segment";
import { fill, resolveText, useTexts } from "../texts";
import { useUiScale } from "../uiScale";
import { sessionCacheHitPercent } from "../cacheHit";
import { BAR_ORDER, createFitAnchor, pickVariants, toolbarAvailableWidth, type ToolbarVariant } from "../toolbarFit";

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
 * 一档权限在弹层里的展示定义，以及（需要拦一下的）确认卡文案。
 *
 * `confirm` 存在就表示「选它要先过一次警告」：完全权限（本扩展历来如此）与
 * Auto review（官方 `RiskConfirmation`，多一道勾选）。
 */
interface PermissionSeat {
  id: string;
  label: string;
  desc: string;
  icon: ReactNode;
  /** 档位名右上角的实验标记（官方 `auto.badge` = `EXP`）。 */
  badge?: string;
  confirm?: {
    title: string;
    body: string;
    enable: string;
    /** 需要勾选才能点确认时的那句勾选文案（官方 `auto.confirm.acknowledge`）。 */
    acknowledge?: string;
  };
}

/**
 * 权限模式的展示定义：四档图标直接复用官方 Regular SVG，文案与 WebUI 对齐。
 *
 * `autoReview` 为真时在末尾追加**实验性的 Auto review 档**——它不是配置表里的一档，
 * 而是 `dsh-experimental-auto-review` 集成在世时才会出现在
 * `permissionPresets/catalog.options` 里的那一档（宿主据此下发
 * `state.permissionAutoReview`）。所以它存在与否**只由 DSH 决定**，界面不自己猜。
 *
 * 七条文案（档位名 / EXP 标 / 描述 / 警告标题 / 警告正文 / 勾选 / 确认按钮）逐字抄
 * 官方 `ui-permission-presets`：连**中文词典里那一档的名字也是 `Auto review`**
 * （官方没有翻译它），所以这里也不给中文另起名字。
 */
function permissionMeta(
  texts: ReturnType<typeof useTexts>,
  autoReview: boolean,
): PermissionSeat[] {
  const seats: PermissionSeat[] = [
    { id: "read-only", label: texts.permReadOnly, desc: texts.permReadOnlyDesc, icon: <IconPermissionReadOnly size={16} /> },
    {
      id: "workspace-write",
      label: texts.permWorkspaceWrite,
      desc: texts.permWorkspaceWriteDesc,
      icon: <IconPermissionWorkspaceWrite size={16} />,
    },
    {
      id: "danger-full-access",
      label: texts.permFullAccess,
      desc: texts.permFullAccessDesc,
      icon: <IconPermissionFullAccess size={16} />,
      confirm: {
        title: texts.permConfirmTitle,
        body: texts.permConfirmBody,
        enable: texts.permConfirmEnable,
      },
    },
  ];
  if (autoReview) {
    seats.push({
      id: AUTO_REVIEW_PRESET,
      label: texts.permAutoReview,
      desc: texts.permAutoReviewDesc,
      badge: texts.permAutoReviewBadge,
      icon: <IconPermissionAutoReview size={16} />,
      confirm: {
        title: texts.permAutoReviewTitle,
        body: texts.permAutoReviewBody,
        enable: texts.permAutoReviewEnable,
        acknowledge: texts.permAutoReviewAcknowledge,
      },
    });
  }
  return seats;
}

/** 一帧都没结算时的空集合（模块级常量：避免每次渲染新建 Set 触发无谓的重渲染）。 */
const EMPTY_RANKS: ReadonlySet<number> = new Set();

/**
 * 底部工具栏的自适应：量出候选档位的**实际宽度**，按 `toolbarFit.ts` 的优先级
 * 决定这一帧显示哪些（分配规则在那边，这里只管「量」与「什么时候重量」）。
 *
 * 三个要点：
 * - 每次提交后的 layout effect：文案、字号、语言、模型名、数字位数变了就重量，
 *   并且在 layout 阶段结算——不会先画一帧「全挤在一起」再收回去；
 * - `.composer-bar` 的 ResizeObserver **跟着节点走**（`createFitAnchor` 的 callback ref）：
 *   侧栏被拖动、可用宽度变了就重量，节点被条件渲染换掉之后也仍然有人盯着新那一枚
 *   （只读子代理会话那一支会把 `.composer-bar` 换成新元素）；
 * - 量不到盒时这一帧**不结算**（`toolbarAvailableWidth` 返回 `undefined`）：宿主把整个
 *   webview 隐藏起来时内层所有盒都塌成 0，把「量不出来」当成「装不下」会把工具栏锁在
 *   最窄那一套，而恢复显示时未必有人重渲染。
 *
 * 全程没有写死的像素阈值：「多宽显示谁」完全由实测宽度算出来，
 * 所以换语言（权限名长短差近一倍）、换模型、调字号都自动跟上。
 */
function useToolbarFit(variants: ToolbarVariant[]) {
  /** 测量层里的 DOM（rank → 元素），宽度每次结算时重新读。 */
  const nodes = useRef(new Map<number, HTMLElement>());
  // 每次渲染刷新「当前档位表」：ResizeObserver 的回调引用是稳定的，
  // 只有通过 ref 才能读到这一帧的表
  const latest = useRef(variants);
  latest.current = variants;
  /** 上一次结算出的档位签名（排序后的 rank），用来判断要不要重新渲染。 */
  const signature = useRef("");
  const [shown, setShown] = useState<ReadonlySet<number>>(EMPTY_RANKS);
  /**
   * 当前那一枚 `.composer-bar`。**由下面 `anchor` 的 callback ref 写**，不在挂载时取一次：
   * 这个节点会被换掉（只读子代理会话那一支是同类型 div 的子树替换），而 `fit` 读的是
   * 「现在这一枚」的宽度。
   */
  const barRef = useRef<HTMLDivElement | null>(null);

  const fit = useCallback(() => {
    const bar = barRef.current;
    if (!bar) return;
    const style = getComputedStyle(bar);
    const px = (value: string) => Number.parseFloat(value) || 0;
    // 可用宽度 = 内容盒宽度（`clientWidth` 已排除边框与滚动条）再扣掉左右内边距。
    // 量不到盒时是 `undefined`：这一帧不结算，保留上一次那个有效档位
    // （判据与理由见 `toolbarFit.ts` 的 `toolbarAvailableWidth`）。
    const available = toolbarAvailableWidth({
      isConnected: bar.isConnected,
      hasBox: bar.getClientRects().length > 0,
      clientWidth: bar.clientWidth,
      padLeft: px(style.paddingLeft),
      padRight: px(style.paddingRight),
    });
    if (available === undefined) return;
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

  /**
   * 观察者随节点走（`createFitAnchor`）：换节点先断旧的、再盯新的，任一时刻最多一枚。
   *
   * effect 的 setup 里再 `attach` 一次当前节点，是为了 React 18 的 StrictMode 会把 effect
   * 走一遍「挂载 → 清理 → 再挂载」——cleanup 把观察者断掉了，而 ref 回调**不会跟着重放**，
   * 只写清理而不在 setup 里重挂，开发期就永久没有观察者。`attach` 对同一枚节点幂等，
   * 所以正常那次挂载不会因此多出一枚。
   */
  const anchor = useMemo(
    () =>
      createFitAnchor<HTMLDivElement>(fit, (node) => {
        barRef.current = node;
      }),
    [fit, barRef],
  );
  useEffect(() => {
    anchor.attach(barRef.current);
    return () => anchor.dispose();
  }, [anchor, barRef]);
  // 测量层那些 ref 回调（`register`）必须**稳定**：每次渲染新建函数的话，React 会先把旧的
  // 解绑（传 null）再绑新的，白白多一轮往返，`nodes` 也会被反复清空又填上。
  // 档位表变没变看 rank 列表就够了。
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

  // 交给 `.composer-bar` 的 callback ref：它既把节点同步给 `fit`，又把观察者挂到**这一枚**
  // 节点上（换节点先断旧的）。必须是这个而不是裸 ref 对象——裸 ref 只写 `barRef.current`，
  // 观察者就没人管了。
  return { shown, register, attachBar: anchor.attach };
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
  /**
   * 草稿的**渲染镜像**（`../composerMention`）：文本域的字透明，看得见的字全由这一层
   * 画，其中引用那几段上链接色。它自己量不出文本域的盒子，宽度 / 高度 / 滚动位置都由
   * 下面的 `syncMirror` 同步。
   */
  const mirrorRef = useRef<HTMLDivElement>(null);
  /**
   * Ctrl / Cmd 此刻按着没有。
   *
   * **必须是 state**：按住时镜像层里的引用要补下划线（`is-modifier`），那是渲染结果，
   * 只放在 ref 里画不出来。每按一次 Ctrl 多一次渲染，代价可以接受（一次键盘事件而已）。
   */
  const [modifierHeld, setModifierHeld] = useState(false);
  /**
   * 鼠标最后一次扫过输入框时的位置。
   *
   * 修饰键按下 / 松开那一刻鼠标多半一动不动，而手指光标要在那一刻就位（按下出现、
   * 松开收回）——所以位置得记着，重新判一次命中。
   */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  /**
   * 模型弹层这一次打开要定位到哪一段（见 `pickerFocus.ts`）：模型按钮与思考强度按钮
   * 各自对应一段。两枚按钮开的是同一个弹层，但「打开时该聚焦到当前模型还是当前档位」
   * 是两回事（用户 2026-10-10 两条报障各对应一处）。
   */
  const [modelFocus, setModelFocus] = useState<"model" | "effort">("model");
  const [modeOpen, setModeOpen] = useState(false);
  // 模型按钮 toggle 标志：标记「这次关闭是按钮触发的」，让 Popover 的
  // mousedown 外部检测跳过它（选中模型后弹层不关，再点按钮需能关闭）
  const modelToggleRef = useRef(false);
  // 权限按钮与模型按钮同机制：弹层已开时再点按钮是关闭，而不是被外部检测
  // 「关掉」之后又被 click 翻转回来
  const modeToggleRef = useRef(false);
  /**
   * 正在确认哪一档权限（`null` = 没在确认，弹层显示档位列表）。
   *
   * 存**档位 id** 而不是一个布尔：需要过警告的档有两档（完全权限、Auto review），
   * 各自的文案与勾选要求都不同。选中它时顺带复位勾选态，避免上一档的勾选漏过来。
   */
  const [confirmPermission, setConfirmPermission] = useState<string | null>(null);
  /** Auto review 警告里的「我已了解这些风险」勾选（官方 `RiskConfirmation` 要求先勾才能确认）。 */
  const [acknowledged, setAcknowledged] = useState(false);
  const texts = useTexts();
  /**
   * 界面倍率（设计像素 → 实际像素）。输入框的**自适应高度**要用它当依赖：那个高度是
   * 量 `scrollHeight` 得来的，而字号一变，同一个草稿的行高与内边距都变了——不重算就会
   * 停在旧倍率的那个值上（用户 2026-10-03 报的「刚调完字体，输入框偏矮，敲一个字才正常」）。
   */
  const uiScale = useUiScale();
  // 目录说「这个部署有 Auto review 这一档」才列出来；当前值已经是 `auto` 时也列
  // （目录那一次请求可能失败或还没回来，而此时会话确实停在那一档上，不列的话胶囊
  // 会退回显示别的档位——假结论）。判据合成一处，列表与胶囊读同一份。
  const permissions = permissionMeta(
    texts,
    state.permissionAutoReview === true || state.permission === AUTO_REVIEW_PRESET,
  );

  const draft = state.draft;
  const sessionDraft = useMemo(() => new ComposerSessionDraft(), [state.session?.id]);
  sessionDraft.sync(draft, state.session?.id);
  const displayDraft = sessionDraft.text;
  /**
   * `@` / `/` 补全：弹层 + 文本域要接的那几个 prop。
   *
   * 这个 hook **拥有**整套规则（触发词判定、候选取用与优先级、父目录查询、
   * `pick` vs `drill`、光标落点、ESC 优先级链、弹层键盘导航与弹层 JSX），
   * 也拥有宿主下发的「插到光标处」请求。组件这边只剩布局 / 工具行 / 文本域。
   */
  const completion = useComposerCompletion({
    draft: displayDraft,
    sessionDraft,
    commands: state.commands,
    fileRefs: state.fileRefs,
    texts,
    // 还没有工作目录：空态下 `/` 与 `@` 的候选都是会话作用域的服务端目录，宿主在没有
    // 目录时不会就地建会话（用户 2026-09-24 口径），两个菜单必然为空——弹层要改说
    // 「未选择工作区」而不是「没有可用命令」（`workspace.path` 空串 = 没选，
    // 判据与空态页那一行同源；快照还没到时按「不知道」处理，不猜）。
    noWorkspace: state.workspace !== undefined && state.workspace.path === "",
    onDraft,
    // 弹层没接管时的 Enter（含 Cmd/Ctrl+Enter 的加速手势）：键的语义住在补全 hook 里，
    // 这里只把「怎么发」交给它——分在两地时，2026-09-19 就丢过一次（回车变换行）。
    // 包一层箭头：`send` 在下面才声明（它是组件自己的发送入口）。
    onSubmit: (gesture) => send(gesture),
    insertRequest: state.insertRequest,
    // 界面自产的「引用到输入框」（正文右键菜单）：与上面那条同一套落点算术，
    // 但拼接口径不同（引用块自己占整行），所以是另一条请求
    quoteRequest: state.quoteRequest,
    // 补全 hook 与下面的自适应量高 / 焦点归还要用**同一个**文本域节点
    textareaRef,
  });
  // 「有没有在等审批 / 提问」不在这个组件里再推一遍：它就是 `pending` 这个 prop
  // 本身（选举结果见 `pendingInteraction.ts`），下面的运行中那行直接读它。

  /**
   * 把镜像层的几何对齐到文本域：宽度取它的 content box（`clientWidth` 已扣掉滚动条与
   * 内边距）、高度与滚动位置照抄。镜像层自己量不出这些——它是个绝对定位的浮层，不知道
   * 文本域此刻多宽、滚到了哪一行。
   *
   * 只读两个 ref，所以可以稳定（空依赖）：绘制前那一处与下面盯尺寸的 `ResizeObserver`
   * 共用同一个对齐动作。
   */
  const syncMirror = useCallback(() => {
    const el = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!el || !mirror) return;
    mirror.style.width = `${el.clientWidth}px`;
    mirror.style.height = `${el.clientHeight}px`;
    mirror.scrollTop = el.scrollTop;
  }, []);

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
    // 必须在高度定下来**之后**对齐镜像层：草稿长到出滚动条时，文本域的内容宽度会窄
    // 一条滚动条，镜像层要跟着窄，否则一换行就错位
    syncMirror();
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
  }, [draft, chatScroll, uiScale, syncMirror]);

  /**
   * 文本域**尺寸**变了也要重新对齐镜像层。
   *
   * 上面那个 layout effect 只在草稿 / 字号变时跑：拖侧栏、开合面板、切分编辑器都不会
   * 动草稿，而文本域的宽度一变，镜像层的换行位置就停在旧宽度上——整段蓝字与文字错位，
   * 直到用户敲下一个字才恢复。`ResizeObserver` 盯的就是文本域自己的盒子，宽度、高度
   * （含滚动条出现那一下）都收得住。
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncMirror());
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncMirror]);

  /**
   * 草稿里的引用**按住 Ctrl / Cmd 才可点**（与文本域的 onClick 同一判据，见
   * `../mentionOpen`）。按住时给它补下划线（`is-modifier`，样式在 `app.css`），
   * 松开就收回去——与 VS Code 编辑器里那条「按住 Ctrl 才显示成链接」的习惯一致。
   *
   * 监听本身归 `../composerSend` 的 `watchModifierKeys`：keydown / keyup 判修饰键、
   * 窗口失焦一律按「没按」（切到别的应用后键盘状态不再可靠），发送按钮的按住态与
   * 这一层的下划线**共用同一份状态与同一条监听**，不再各写一遍。
   */
  useEffect(() => watchModifierKeys(window, setModifierHeld), []);

  /**
   * 鼠标扫过输入框：命中一条引用、且按着 Ctrl / Cmd 时，把光标换成手指。
   *
   * 命中判定读镜像层里那几段引用**实际画出来**的矩形（`hitsAnyRect`），不是按字符
   * 位置估——草稿里等宽字体与 CJK 混排，估算必偏，而这块的判定精度就是「手指出现
   * 的位置对不对」。光标是纯 DOM 副作用（下划线才是渲染结果），不走状态。
   */
  const hitsMentionAt = (x: number, y: number): boolean => {
    const mirror = mirrorRef.current;
    if (!mirror) return false;
    for (const mark of mirror.querySelectorAll<HTMLElement>(".mention-mark")) {
      if (hitsAnyRect(mark.getClientRects(), x, y)) return true;
    }
    return false;
  };

  /** 按当下的修饰键状态给文本域一个光标：命中引用且按着 Ctrl / Cmd = 手指。 */
  const applyMentionCursor = (x: number, y: number): void => {
    const el = textareaRef.current;
    if (!el) return;
    const next = modifierHeld && hitsMentionAt(x, y) ? "pointer" : "";
    if (el.style.cursor !== next) el.style.cursor = next;
  };

  /**
   * 修饰键按下 / 松开那一刻，鼠标通常**一动不动**（没有下一次 mousemove）：这里按
   * 最后记下的位置重判一次——按下时手指立刻出现，松开时连同下划线一起收回。
   */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (!modifierHeld) {
      el.style.cursor = "";
      return;
    }
    const point = pointerAt.current;
    if (point) applyMentionCursor(point.x, point.y);
    // 依赖里只列 `modifierHeld`：命中判定与光标写入读的都是它这一次渲染的值
  }, [modifierHeld]);

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
   *
   * **不发附件**：附件的权威是宿主账本，界面这份 `state.attachments` 只是它的投影，
   * 宿主发送时自己取账本（见 `shared/ipc.ts` 的 `send`）。回传一份副本意味着图片的
   * base64 要从这里再走一趟单程。
   */
  const send = (gesture: "enter" | "accelerated" = "enter") => {
    if (!canSend) return;
    post({ type: "send", text: draft.trim(), gesture });
    // 发出去了就是要看回答：脱贴状态下也贴回最新（与切会话同一条规则）
    onFollowLatest?.();
    onDraft("");
  };

  // 认不出的当前值（`custom`：两个旋钮的组合不对应任何一档）退回第二档显示，
  // 与之前一致。
  const currentPermission =
    permissions.find((item) => item.id === state.permission) ?? permissions[1];
  /** 正在确认的那一档（弹层此时显示它的警告卡而不是档位列表）。 */
  const confirmSeat = permissions.find((item) => item.id === confirmPermission);
  const confirmCard = confirmSeat?.confirm;

  // 生成速度：**始终**显示明细里那条「平均输出速度」——全会话累计
  // （Σ 输出 token ÷ Σ 解码窗口，`sessionStats` 投影），与 Web 的会话统计同口径。
  //
  // 此前取的是「最近一条助手消息的解码窗口吞吐」（逐 token 帧时间戳折出来的
  // `usage.tokensPerSecond`，回退宿主保留的 `lastSpeed`）：那是**另一个数**，
  // 与悬停明细里写的「平均输出速度」对不上，用户看到的就是「胶囊上的数字和
  // 明细里的不一样」（2026-09-15 口径：以明细为准，两边同一个数）。
  const stats = state.sessionStats;
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

  /**
   * 权限胶囊：`withLabel` 是用户口径里最低优先级那一档（图标 + 权限名）。
   *
   * `EXP` 标只在**带文字那一档**出现：它本身就是一段文字，而「只有图标」那一档是
   * P0 的最小宽度形态（Auto review 用官方盾牌内的 A 区分，见 `IconPermissionAutoReview`）。
   */
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
          // 经按钮关闭时顺带复位确认态（含勾选）
          if (v) {
            setConfirmPermission(null);
            setAcknowledged(false);
          }
          return !v;
        });
      }}
    >
      {currentPermission.icon}
      {withLabel ? (
        <span className="pill-mode-label">
          {currentPermission.label}
          {currentPermission.badge ? <sup className="perm-badge">{currentPermission.badge}</sup> : null}
        </span>
      ) : null}
    </button>
  );

  /**
   * 模型切换按钮（P0）。`withProvider` 是同槽位的最低优先级档：宽度充裕时把
   * 提供商展示名加在模型名前面（`提供商/模型名`，用户口径）；目录里认不出该
   * 提供商（找不到分组）就保持裸模型名。
   *
   * 名字**不写死显示上限**（用户 2026-09-23 口径：工具栏够长就显示全）：胶囊宽度
   * 来自测量层的自然宽度，由 `toolbarFit` 决定为它让出多少（放不下的低优先级档位
   * 少显示几个）；真排不下时由 flex 压缩出省略号。
   *
   * 悬停提示是**动作**（「选择模型」），不是「思考深度」——那个标签属于右侧的思考
   * 强度胶囊；同一个弹层由两个入口打开，但两个入口各自是干什么的要说各自的（用户
   * 2026-09-23 报的：悬停模型按钮也显示「思考深度」）。
   */
  const providerGroup = state.models.find((group) => group.id === state.model?.provider);
  const modelLabelText = state.model?.label ?? texts.defaultModel;
  const modelPillText = (withProvider: boolean) =>
    withProvider && providerGroup ? `${providerGroup.name}/${modelLabelText}` : modelLabelText;
  const modelPill = (withProvider: boolean) => (
    <button
      className="pill"
      title={texts.selectModel}
      onMouseDown={() => {
        // 标记：接下来 Popover 的 mousedown 外部检测是「按钮触发的」，跳过
        modelToggleRef.current = true;
      }}
      onClick={() => {
        // 同一次交互内消费标志（mousedown 已先于 click 触发）
        setTimeout(() => {
          modelToggleRef.current = false;
        }, 0);
        // 从模型按钮打开：弹层定位到当前模型那一行
        setModelFocus("model");
        setModelOpen((v) => !v);
      }}
    >
      <span className="pill-label">{modelPillText(withProvider)}</span>
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
        // 从思考强度打开：弹层定位到当前档位（与模型按钮同源、只是换了要定位的那一段）
        setModelFocus("effort");
        setModelOpen((v) => !v);
      }}
    >
      {effort.name}
    </button>
  ) : null;

  // agent 预设标签：**只读**（不可点、不可改）——用户口径 2026-09-22「会话开始后，
  // 在思考强度与附件之间显示当前会话的 agent 预设名」。
  //
  // 「会话开始后」的判据与 App 的空态页同一条（`messages.length === 0` 就是空态）：
  // 空态页上那个可选的下拉框（`EmptyMeta` 的 AgentPresetChip）已经承担了「用哪套组装」，
  // 而会话一旦开始，服务端就锁死了预设（`agent-preset/locked`），这里只剩「它叫什么」可读。
  //
  // 展示名的折叠与空态页共用 `presetDisplayText`（随产品交付的四个走词典、用户自写的用原文），
  // 认不出 id（预设被删）时退回 id：它是唯一还认得出的身份。
  const presetOption = state.agentPresets?.options.find((item) => item.id === state.agentPreset);
  const presetName =
    state.agentPreset && state.agentPresets?.options.length
      ? presetOption
        ? presetDisplayText(presetOption, texts).name
        : state.agentPreset
      : undefined;
  const presetLabel =
    state.messages.length > 0 && presetName ? (
      <span className="bar-preset" title={texts.agentPresetRunning(presetName)}>
        {presetName}
      </span>
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
  /**
   * 缓存命中率（用户 2026-10-10 口径：工具栏**最低优先级**的那一项，位置在上下文容量
   * 数值右边，写法是 `98.7%HIT`——中英文同一份）。
   *
   * 取的是**会话累计**口径（`tokenUsage` 投影，官方 UsagePill 的同一个键与同一个
   * 分母）。这个值是界面上**唯一**的命中率来源：工具栏那一枚与两处悬停明细里的
   * 「缓存命中」行都读它（用户 2026-10-10 口径：明细里要显示与工具栏同一个数——
   * 官方可见的也是这个口径，而官方那个上下文面板本身没有这一行）。
   * 拿不到数据时是 `undefined`：那一档**不进节点表**，于是既不占坑位、也不会把
   * 「数据缺失」显示成 `0%HIT`（判据与算法在 `cacheHit.ts`）。
   */
  const cacheHitText = sessionCacheHitPercent(state.tokenUsage);
  const ctxProps = {
    percent: state.contextOccupancy?.percent,
    used: state.contextOccupancy?.usedTokens,
    total: state.contextOccupancy?.contextWindow,
    cacheHit: cacheHitText,
    breakdown: state.contextBreakdown,
  };
  /**
   * 悬停明细：**圆环与缓存命中读数共用同一份文本**（用户 2026-10-10 口径：缓存命中
   * 悬停要显示与上下文悬停一模一样的信息）。拼法只有一份（`contextDetailLines`），
   * 两处喂的又是同一组 `ctxProps`，所以两处悬停必然逐字一致。
   *
   * 一行都没有时给 `undefined`（不挂空提示）：此时圆环那边同样没有明细可看，
   * 悬停弹出一个空白框反而像坏了。
   */
  const ctxDetailTitle = contextDetailLines(ctxProps, texts).join("\n") || undefined;

  // 运行中的主按钮（官方 `primaryStops = running && (empty || blocked)`）：
  // - 草稿为空 → 停止（生成中还能"点一下停"，这是用户最需要的动作；按住修饰键也不变）；
  // - 草稿非空 → **发送**，文字按这一次的手势预告走哪条路（见 `../composerSend`：
  //   按住 Ctrl / Cmd 时换成加速手势对应的那一条，与键盘 Ctrl/Cmd+Enter 一致）。
  //
  // 点击的手势**读事件当下的修饰键**（`clickGestureHandler`），不读上面那份渲染期
  // 的 `modifierHeld` 快照——按住 / 松开与点击之间没有重渲染的保证，用快照会点错手势。
  const sendView = sendButtonView({
    running: state.running,
    canSend,
    busyEnter: state.busyEnter,
    modifierHeld,
    texts,
  });
  const sendPill =
    sendView.kind === "stop" ? (
      <button className="send-btn is-stop" title={sendView.title} onClick={() => post({ type: "stop" })}>
        <IconStop size={12} />
      </button>
    ) : (
      <button
        className="send-btn"
        disabled={!canSend}
        title={sendView.title}
        onClick={clickGestureHandler(send)}
      >
        {sendView.label}
      </button>
    );

  const barNodes: Record<string, ReactNode> = {
    "permission:icon": permissionPill(false),
    "permission:label": permissionPill(true),
    "model:full": modelPill(false),
    "model:provider": modelPill(true),
    "send:full": sendPill,
    "effort:full": effortPill,
    "preset:full": presetLabel,
    "attach:full": attachPill,
    "tps:full": speedText,
    "context:ring": ctxNumbers ? <CtxText {...ctxProps} /> : null,
    "context:text": ctxNumbers ? <CtxText {...ctxProps} detailed /> : null,
    // 缓存命中率是**独立元素**（用户 2026-10-10 第二条口径：不与上下文数字逗号连写），
    // 所以它不要求 `ctxNumbers`——命中率读的是另一个投影（`tokenUsage`），有数据就显示。
    // 只在拿不到命中率数据时整档消失（不显示 `0%HIT`）。
    // 悬停给的是**与上下文圆环同一份**明细（`ctxDetailTitle`）：元素是独立的，
    // 但信息不缩水。
    "cache:full": cacheHitText ? (
      <span className="ctx-cache-hit" title={ctxDetailTitle}>
        {texts.ctxCacheHit(cacheHitText)}
      </span>
    ) : null,
  };
  const barVariants: ToolbarVariant[] = BAR_ORDER.filter(
    (spec) => barNodes[`${spec.slot}:${spec.level}`] != null,
  ).map((spec) => ({ ...spec, width: 0 }));
  const { shown, register, attachBar } = useToolbarFit(barVariants);
  /** 这一帧实际要渲染的节点（槽位 → 节点），按优先级分配的结果。 */
  const bar: Record<string, ReactNode> = {};
  for (const variant of barVariants) {
    if (shown.has(variant.rank)) bar[variant.slot] = barNodes[`${variant.slot}:${variant.level}`];
  }

  /**
   * 「第几行」→ 模型：弹层里的模型按钮按提供商分组渲染，而键盘导航要的是**扁平序号**
   * （分组标题只占视觉、不占号）。键与按钮自己的 `key` 同源（`提供商:模型`），于是
   * 选中项的序号与每一行的高亮判定都只查这一张表，不必把 JSX 拍平。
   */
  const modelSeat = new Map<string, number>();
  for (const group of state.models) {
    for (const model of group.models) modelSeat.set(`${group.id}:${model.id}`, modelSeat.size);
  }
  const modelSelected = state.model ? (modelSeat.get(`${state.model.provider}:${state.model.model}`) ?? -1) : -1;
  const effortSelected = state.model?.efforts?.findIndex((item) => item.id === state.model?.reasoningEffort) ?? -1;
  /**
   * 模型弹层「打开即定位到选中项」：模型列表与思考档位共用一个机制（`pickerFocus.ts`），
   * 这一次打开定位哪一段由 `modelFocus`（触发按钮）决定。
   */
  const pickerFocus = usePickerFocus({
    open: modelOpen,
    group: modelFocus,
    groups: [
      { key: "model", count: modelSeat.size, selected: modelSelected },
      { key: "effort", count: state.model?.efforts?.length ?? 0, selected: effortSelected },
    ],
  });
  /** 该模型行此刻是不是键盘高亮（`usePickerFocus` 的判定入口）。 */
  const modelHighlighted = (provider: string, id: string) =>
    pickerFocus.isHighlighted("model", modelSeat.get(`${provider}:${id}`) ?? -1);

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

      {/* 一次性子代理的对话是**只读**执行记录（官方 `SubagentReadOnlyComposer` 的
          选举：one-shot 永远只读）——输入区整个换成一段说明，不给任何能发出去的
          东西；可继续子代理照常走下面的完整输入区。 */}
      {state.subagent?.mode === "one-shot" ? (
        <div className="composer-readonly" role="status">
          <strong>{texts.subagentReadonlyTitle}</strong>
          <span>{texts.subagentReadonlyBody}</span>
        </div>
      ) : (
      <div className="composer-shell">
        {/*
          拖放 / 粘贴接取**都不在这里**：全页由 App 的 usePageFileDrop + usePagePaste
          统一接（window 监听），输入框自己不再处理——两处都接会双发 attachBytes
          （同一份文件两条附件）。
          平台限制（拖入必须按住 Shift，否则 VS Code 把文件打开）与「Ctrl+V 被 VS Code
          接管、它再补发一次 paste」这两条机制都见 `attachIntake.ts`。
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

          {/* 草稿区：文本域 + 它的**渲染镜像**（见 `../composerMention`）。
              镜像层在文本域**下面**，画的是全部看得见的字（引用那几段上链接色）；
              文本域自己的字透明（`app.css` 的 `textarea.composer-input`），只留光标与
              选区。两层共用同一个类名保证排版逐字一致，宽度 / 高度 / 滚动位置由
              `syncMirror` 同步。外层负责给它当定位基准，并让文本域照旧撑满整行
              （列向 flex 的交叉轴拉伸）。 */}
          <div className="composer-field">
            {/* 类名刻意与文本域**共用** `composer-input`：字号 / 行高 / 内边距 /
                折行口径只有那一处，另写一份就一定会与文本域漂开；`is-modifier` 是
                「按住 Ctrl / Cmd」——那时引用补下划线（可点的提示） */}
            <div
              className={`composer-input composer-mirror${modifierHeld ? " is-modifier" : ""}`}
              aria-hidden
              ref={mirrorRef}
            >
              {sessionDraft.segments().map((segment) =>
                segment.link ? (
                  <span className="mention-mark" key={segment.at}>
                    {segment.text}
                  </span>
                ) : (
                  segment.text
                ),
              )}
            </div>
            {/* 触发词（`@` / `/`）的 ref 与 onChange / onKeyUp / onClick / onFocus /
                onKeyDown 全在 `completion.textareaProps` 里：ESC 优先级链、Enter/Tab 的
                补全语义、两次写草稿、焦点回到输入框时的重算都在那边，组件不能再写一份。 */}
            <textarea
              className="composer-input"
              rows={1}
              value={displayDraft}
              placeholder={state.messages.length ? texts.placeholderFollowUp : texts.placeholderFirst}
              // 草稿里的引用要按住 Ctrl（macOS 上 Cmd）单击才打开——文本域是**纯文本**，
              // 做不出真正的行内链接，只能按光标位置判（见 `../mentionOpen`）。
              title={texts.mentionClickHint}
              {...completion.textareaProps}
              // 写在摊开之后：文本域只有一个 `onClick`，这里**接着**补全那边的光标刷新
              // 再判一次 Ctrl+单击，而不是把它顶掉（否则候选菜单不再跟着光标走）。
              onClick={(event) => {
                completion.textareaProps.onClick?.(event);
                // 不按 Ctrl 时什么都不做：普通单击只管定位光标
                if (!event.ctrlKey && !event.metaKey) return;
                const target = sessionDraft.targetAt(event.currentTarget.selectionStart ?? 0);
                if (target) openMentionTarget(target);
              }}
              // 手指光标：划到引用上方且按着修饰键才出现（判据与上面那条 onClick 同源）
              onMouseMove={(event) => {
                pointerAt.current = { x: event.clientX, y: event.clientY };
                applyMentionCursor(event.clientX, event.clientY);
              }}
              onMouseLeave={(event) => {
                pointerAt.current = null;
                event.currentTarget.style.cursor = "";
              }}
              // 草稿长过上限时文本域自己内滚：镜像层跟着滚，否则蓝字会停在原处
              onScroll={(event) => {
                const mirror = mirrorRef.current;
                if (mirror) mirror.scrollTop = event.currentTarget.scrollTop;
              }}
            />
          </div>

          {/* 底部工具栏：显示哪些由 useToolbarFit 按实测宽度 + 优先级决定，
              这里只按视觉顺序摆位（槽位 → 节点）。 */}
          <div className="composer-bar" ref={attachBar}>
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
                  setConfirmPermission(null);
                  setAcknowledged(false);
                }}
              >
                <div className="popover-section">{texts.permission}</div>
                {confirmSeat && confirmCard ? (
                  /* 风险确认卡：文案逐字取官方（完全权限 + Auto review 两档各一套）。
                     Auto review 那一档多一道勾选（官方 `RiskConfirmation` 同款：
                     没勾选时确认按钮不可点），因为它不做沙箱隔离、还会花额外 token。 */
                  <div className="confirm-block">
                    <div className="confirm-title">{confirmCard.title}</div>
                    <div className="confirm-body">{confirmCard.body}</div>
                    {confirmCard.acknowledge ? (
                      <label className="confirm-ack">
                        <input
                          type="checkbox"
                          checked={acknowledged}
                          onChange={(event) => setAcknowledged(event.currentTarget.checked)}
                        />
                        <span>{confirmCard.acknowledge}</span>
                      </label>
                    ) : null}
                    <div className="approval-actions">
                      <button
                        className="btn btn-primary"
                        disabled={confirmCard.acknowledge !== undefined && !acknowledged}
                        onClick={() => {
                          post({ type: "setPermission", permission: confirmSeat.id });
                          setModeOpen(false);
                          setConfirmPermission(null);
                          setAcknowledged(false);
                        }}
                      >
                        {confirmCard.enable}
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => {
                          setConfirmPermission(null);
                          setAcknowledged(false);
                        }}
                      >
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
                        // 需要过警告的档（完全权限、Auto review）：先弹确认卡，
                        // 真正下发在确认按钮那一步。当前已经停在它上面时不弹（无从确认什么）。
                        if (item.confirm && state.permission !== item.id) {
                          setAcknowledged(false);
                          setConfirmPermission(item.id);
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
                      <span className="popover-item-main is-priority">
                        {item.label}
                        {item.badge ? <sup className="perm-badge">{item.badge}</sup> : null}
                      </span>
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
                    // 见 scripts/planCommandProbe.ts 与 docs/design-draft.md。
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
                  选中态只在点击时更新（不再随鼠标悬停变化），与权限/命令弹层一致。
                  内层 div 是「打开即定位到选中项」机制的挂点（`pickerFocus.bodyRef`）：
                  没有它，滚动定位就得满文档去找条目。它是普通块级容器，不参与
                  .popover 的定位与翻转判定。 */}
              <Popover
                open={modelOpen}
                onClose={() => {
                  // 由按钮 toggle 触发的关闭不在此处理（按钮自己已翻转状态）
                  if (modelToggleRef.current) return;
                  setModelOpen(false);
                }}
              >
                <div ref={pickerFocus.bodyRef}>
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
                            data-picker-item="model"
                            className={`popover-item${
                              state.model?.model === model.id && state.model?.provider === group.id
                                ? " is-selected"
                                : ""
                            }${modelHighlighted(group.id, model.id) ? " is-active" : ""}`}
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
                        {state.model.efforts.map((item, index) => (
                          <button
                            key={item.id}
                            data-picker-item="effort"
                            className={`segment-item${
                              (state.model?.reasoningEffort ?? "") === item.id ? " is-selected" : ""
                            }${pickerFocus.isHighlighted("effort", index) ? " is-active" : ""}`}
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
                </div>
              </Popover>
            </div>

            {/* 思考强度：次优先级，紧挨在模型右侧（点它开模型弹层）。 */}
            {bar.effort}

            {/* agent 预设：最低优先级，位置就在思考强度与附件之间（用户 2026-09-22 口径）。
                只读文字标签——会话开始后预设已经锁定，没有可点的东西。 */}
            {bar.preset}

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

            {/* 缓存命中率：全场最低优先级，位置在容量数值右边，但**自成一项**
                （用户 2026-10-10 第二条口径）——它与容量数值各自进退。 */}
            {bar.cache}

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
      )}
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
              // **必须把这次 ESC 归元素层**：不消费的话，归属链的兜底（生成中 =
              // 停止生成）会跟着触发——用户只是想取消改目标，结果把正在跑的这一轮
              // 也中止了（见 escapeOwner.ts）
              consumeEscape(event);
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
    //
    // 这里**只**画服务端给的队列项（`state.queueItems`）：排队中的消息还没有发出去，
    // 它在界面上唯一的去处就是这个队列（乐观回显只服务「已经发出去」的那一类，
    // 见 `webview/pendingMessage.ts`）。
    const items = queueDisplayOrder(state.queueItems);
    return (
      <div className="queue">
        <span className="queue-head">{fill(texts.queued, { n: items.length })}</span>
        {items.map((item) => {
          return (
            <QueueItem
              key={item.id}
              item={item}
              running={state.running}
              onFollowLatest={onFollowLatest}
            />
          );
        })}
      </div>
    );
  }
  return null;
}

/**
 * 队列里的一行：正文恒为**单行省略**，真的放不下时鼠标悬停在**整行**上显示全文
 * （原生浮窗小字）。正文显示前先还原会话引用（`readableMentionText`），
 * 否则单行省略与悬停全文看到的都是原始 token 里的 base64。
 *
 * **不加展开按钮**（用户 2026-10-10 口径）：队列只是待发列表，展开会把输入区顶上去、
 * 整块跳一下；悬停是零成本的那条路。判据必须实测——字号（`dshChat.fontSize`）、
 * 界面倍率、侧栏宽度都会挪截断点，按字数猜一定猜错，规则与量法都在 `queueHover.ts`。
 *
 * 一行做成组件而不是在 `.map` 回调里内联：截断态是**每行自己的** state，
 * 而 hooks 不能在回调里调。
 */
function QueueItem({
  item,
  running,
  onFollowLatest,
}: {
  item: QueuedMessageView;
  /** agent 是否在跑：插话发送只在运行中可用（服务端同样要求）。 */
  running: boolean;
  onFollowLatest?: () => void;
}) {
  const texts = useTexts();
  // 带附件的排队消息在**行首**标出来（用户 2026-09-25 口径）：这一行只有正文，
  // 光看文字看不出这条还带着图片 / 文件。
  const withAttachments = queueItemHasAttachments(item);
  // 文本为空时本来用「（附件）」占位；已经有行首标记就不再重复说一遍。
  // 队列行只是**预览**，所以正文先过 `readableMentionText`：队列条目来自 `inbox`
  // 投影，里面是**用户提交的原文**——会话引用还是原始 token
  // （`@[标题](dsh-session:eyJ…)`，服务端只在落盘时才折，见 `mentionLinks.ts` 的文件头），
  // 不还原的话单行省略显示的是 base64、悬停全文弹出来的也是 base64。文件 / 目录引用
  // 本来就是 `@src/a.ts` 这种字面量，原样保留。真正的编辑 / 插话仍用 `item.text` 原文
  // （那两个动作只发 id，原始内容由宿主取）。
  const label = readableMentionText(item.text || (withAttachments ? "" : texts.queueMediaOnly));
  const textRef = useRef<HTMLSpanElement>(null);
  /** 正文是否真的被裁（判据见 `queueHover.ts`；量不到证据时恒为 false）。 */
  const [clipped, setClipped] = useState(false);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const check = () =>
      setClipped(
        queueTextIsClipped(label, el.clientWidth, () => {
          // 量**文本自己的**自然布局宽度：本行是 flex 容器、文本排在匿名 flex 项里，
          // 项内的溢出不计入父级的 scrollable overflow（实测 `scrollWidth == clientWidth`），
          // 与 `primitives.tsx` 的 `useClipped` 同一个坑
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect().width;
        }),
      );
    check();
    // 侧栏宽度 / 字号变化都会挪截断点：宽度一变就复检（内容变化由依赖触发）
    const observer = new ResizeObserver(check);
    observer.observe(el);
    return () => observer.disconnect();
  }, [label]);

  return (
    // 悬停显示全文走**原生 title**（用户 2026-10-10 口径）：与正文里的文件芯片、
    // 改动卡片同一套浮窗小字，样式由宿主统一渲染，不在界面里自绘一层浮层。
    // 挂在**整行**而不是只挂正文那一格：这一行的其余部分（附件标记、空白）也属于这条
    // 消息，只挂正文时鼠标偏一格就没有提示。行内三枚按钮各自带 title，内层胜过外层，
    // 所以那三处不会被全文顶掉。
    // 只在**真的被裁**时挂上去——放得下的那条悬停不该弹任何东西（判据见
    // `queueHover.ts`：字数阈值一定会猜错，字号 / 侧栏宽度都会挪截断点）。
    <div className="queue-item" title={clipped ? label : undefined}>
      {withAttachments ? <span className="queue-tag">{texts.queueHasAttachment}</span> : null}
      <span className="queue-text" ref={textRef}>
        {label}
      </span>
      {/* 「插话发送」（官方 queue 行的第三个动作 `{kind:'steer'}`）：
          只对**排队中**的那条给出（已经是 steering 的不必再来一次），
          并且只有 agent 正在运行时可用——服务端同样要求运行中，否则回
          `session/steer-unavailable`（宿主按官方口径静默处理）。 */}
      {item.placement !== "steering" ? (
        <button
          className="queue-action"
          disabled={!running}
          title={running ? texts.queueSteer : texts.queueSteerUnavailable}
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
  );
}

/**
 * 队列行的悬停全文**不再自绘浮层**（用户 2026-10-10 口径）：改用宿主渲染的浮窗小字
 * （原生 `title`），与正文里的文件芯片、改动卡片同一套视觉。原先那份 `position: fixed`
 * + 视口坐标的浮层、以及配套的落位算法都随之删掉了——自绘浮层与宿主那套本来就各写一份
 * 样式，用户要的是统一的那一套。
 */
