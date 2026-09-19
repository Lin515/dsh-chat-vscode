import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { CommandView, FileRefView, GoalView, SessionRefView } from "../../shared/chat";
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
import { formatFileMention } from "../../shared/mentions";
import { CtxText, Ellipsis, Popover, Spinner, contextNumbers, formatClock, formatDuration } from "./primitives";
import { ApprovalCard, PlanReviewCard, QuestionCard, formatTps } from "./Rows";
import type { PendingInteraction } from "../pendingInteraction";
import { insertAtCaret } from "../insert";
import { mentionParent } from "../mentionNav";
import { queueDisplayOrder } from "../queueOrder";
import { segmentColumns } from "../segment";
import { fill, resolveText, useTexts } from "../texts";
import { BAR_ORDER, pickVariants, type ToolbarVariant } from "../toolbarFit";

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

/** 输入框里正在编辑的触发词（`/` 命令或 `@` 文件/对话提及）。 */
interface Trigger {
  kind: "command" | "mention";
  /** 触发词在文本里的起始下标。 */
  start: number;
  query: string;
}

/**
 * `@` 候选的一条：命令、文件 / 目录、或对话引用。
 *
 * 三者在同一个扁平数组里（键盘上下要在**整张列表**里走，不能分组各走各的），
 * 渲染时按形状分派（见 `isSessionCandidate`）。
 */
type MentionCandidate = CommandView | FileRefView | SessionRefView;

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
  chatScrollRef,
  onDraft,
  onFollowLatest,
}: {
  state: AppState;
  /** 正在等用户回答的交互（审批 / 提问）：有它时**接管**输入区（官方 `conversation.composer` 槽）。 */
  pending?: PendingInteraction;
  /**
   * 会话滚动区（`.chat-scroll`）。自适应量高的瞬态会把它的高度与 scrollTop
   * 各动一次（见下方 effect 的注释），补回动作要在绘制之前做，所以得拿到它。
   */
  chatScrollRef?: React.RefObject<HTMLDivElement>;
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
  // ESC 关掉候选弹层后记下当时的文本与光标：只要没有真实编辑，随后的 keyup /
  // 聚焦回调不会重新探测触发词把列表弹回来（否则表现为「按 ESC 列表又弹出」）
  const dismissedRef = useRef<{ value: string; caret: number } | null>(null);
  /** 候选行的容器（`@` / `/` 弹层本体，可滚动的那一层），键盘导航要滚它。 */
  const popoverRef = useRef<HTMLDivElement>(null);
  /** 这一次高亮变化是不是键盘导航引起的（鼠标悬停不滚动列表，见 onKeyDown）。 */
  const keyboardNavRef = useRef(false);
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
    const pane = chatScrollRef?.current ?? null;
    const distBefore = pane ? pane.scrollHeight - pane.scrollTop - pane.clientHeight : 0;
    const prevTop = pane?.scrollTop ?? 0;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.7)}px`;
    if (!pane) return;
    if (pane.scrollTop !== prevTop) {
      // auto 瞬态把端口撑高、scrollTop 被浏览器夹小：补回原位。
      // （赋值超上限时浏览器自动夹住 = 恰好贴底，与「无瞬态」的理想布局一致。）
      pane.scrollTop = prevTop;
    } else if (distBefore <= 1) {
      // 原本贴底而这次量高让端口变矮：settle 要到下一帧才钉，那一帧底部缺一条
      // ——直接在这里钉住（贴底 ≤1px 时意愿必为跟随，与 onScroll 的裁定同源）。
      const dist = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (dist > 0) pane.scrollTop = pane.scrollHeight;
    }
  }, [draft, chatScrollRef]);

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

  /**
   * 当前 `@` 查询进入子目录时的「上一层」查询串（没有就是 undefined）。
   *
   * 计算在 `mentionNav.ts`（纯函数，带断言）：这里只把它接到候选列表与选中动作上。
   */
  const parentQuery = trigger?.kind === "mention" ? mentionParent(trigger.query) : undefined;

  const candidates = useMemo(() => {
    if (!trigger) return [];
    if (trigger.kind === "command") {
      const query = trigger.query.toLowerCase();
      return state.commands.filter((command) => command.name.toLowerCase().includes(query));
    }
    const files: MentionCandidate[] = state.fileRefs.items;
    // 「..」永远排在最前（文件浏览器的惯例），键盘上下也能选中它。
    // 只在查询已经进入某个子目录时才有这一行（根目录没有上一层）。
    //
    // 对话候选排在文件之后（官方 `reference` 源就是这个顺序：`fileItems` 在前、
    // `sessionItems` 在后，各自一组；查询本身由服务端按标题/路径过滤）。
    // 注：官方在 `@"引号路径"` 里不给对话候选，本扩展的触发词还不认识引号形式
    // （见 findTrigger），所以这里没有那一道分叉。
    const sessions: MentionCandidate[] = state.fileRefs.sessions;
    if (parentQuery === undefined) return [...files, ...sessions];
    const up: FileRefView = { path: parentQuery, kind: "directory", parent: true };
    return [up, ...files, ...sessions];
  }, [trigger, state.commands, state.fileRefs, parentQuery]);

  /** 这一条候选是不是「对话引用」（有 `mention`，没有文件那样的 `kind`）。 */
  const isSessionCandidate = (candidate: MentionCandidate): candidate is SessionRefView =>
    typeof (candidate as SessionRefView).mention === "string";

  /** 候选分组标题：命令一条、`@` 的文件 / 对话各一条（官方按 `section` 分组渲染）。 */
  const sectionOf = (candidate: MentionCandidate): string => {
    if (trigger?.kind === "command") return texts.commands;
    return isSessionCandidate(candidate) ? texts.mentionSessions : texts.mentionFiles;
  };

  /**
   * 这一批候选里有没有**可以进去浏览的目录**（`..` 不算：它是回上一层，Tab 对它没有意义）。
   *
   * 决定「文件」分组标题栏右侧要不要显示 `Tab 进入目录` 的提示——一个目录都没有时
   * 显示它只会让人以为按了有用。
   */
  const hasFolderCandidate = candidates.some(
    (candidate) =>
      !isSessionCandidate(candidate) &&
      (candidate as FileRefView).kind === "directory" &&
      (candidate as FileRefView).parent !== true,
  );

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
   * 键盘上下键移动高亮时，把选中行**滚进视野**。
   *
   * 弹层是 `max-height: 330px; overflow-y: auto`（`.popover`）：候选多于一屏时，
   * 光改高亮而不滚动，选中项会跑到视野外——用户看着列表「没反应」，回车却选中了
   * 一个看不见的条目（用户 2026-09-14 报的）。
   *
   * 只在**键盘导航**后滚动（`keyboardNavRef`）：鼠标悬停也会改高亮
   * （`onMouseEnter`），那时滚列表会把指针底下的内容挪走，晃得没法用。
   * 用 `getBoundingClientRect` 自己算差值而不是 `scrollIntoView`：后者会连带
   * 滚动外层容器（对话区），而这里只想动弹层自己。
   */
  useLayoutEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    const list = popoverRef.current;
    const item = list?.querySelector<HTMLElement>(".popover-item.is-selected");
    if (!list || !item) return;
    // 回到第一行时滚到最顶：让「命令 / 文件」那行分组标题也一起露出来
    // （只按「贴边」算的话，第一行会顶在标题下面、标题永远被压在视野外）
    const first = list.querySelector<HTMLElement>(".popover-item");
    if (item === first) {
      list.scrollTop = 0;
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [highlight, trigger]);

  const send = (gesture: "enter" | "accelerated" = "enter") => {
    if (!canSend) return;
    // 只发**手势**，不发模式：`session/prompt.mode` 由宿主按
    // `ui-conversation.busyEnter` + 「按下的那一刻 agent 在不在跑」解析
    // （官方 resolveSubmitMode）。界面自己算会算错——它拿到的是上一帧的 running。
    post({ type: "send", text: draft.trim(), attachments: state.attachments, gesture });
    // 发出去了就是要看回答：脱贴状态下也贴回最新（与切会话同一条规则）
    onFollowLatest?.();
    onDraft("");
    dismissedRef.current = null;
    setTrigger(undefined);
  };

  /**
   * 把触发词替换成选中的命令 / 文件 / 对话。
   *
   * `action` 只在 `@` 的**目录行**上有区别（官方 `input-trigger` 的 `pick` 与 `drill`）：
   * - `"pick"`（Enter / 点击行 / 文件 / 对话）：把路径或 mention **作为引用 token
   *   插进正文**；
   * - `"drill"`（Tab / 行右侧的「进入目录」徽标）：下钻到该目录，列表换成它的内容。
   *
   * 与官方逐字对齐：官方 `onPick({candidate, action})` 只在
   * `fileKind === "directory" && action === "drill"` 时 `continue: true`（下钻），
   * 其余一律 `insert`（`dsh-client-ui-reference/lib/client.js`）；键盘上只有
   * **Tab** 会带上 `drill`（`dsh-client-ui-input-trigger` 的 `case "tab"` 先看
   * `item.drill === true`），**Enter 永远是普通 pick**（`case "enter"`）。
   */
  const applyCandidate = (index: number, action: "pick" | "drill" = "pick") => {
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
      // 光标落到命令名之后：接下来直接打参数，再按回车就是执行。
      // 同步改 textarea 的 DOM 值与光标——React 这帧提交时 prop 值已相同、
      // 不会再重置光标，于是这次 Enter 随后的 keyup 读到的正是「新文本+新光标」。
      // 把同一对记进「已关闭」标记：keyup 重新探测时命中它、列表保持关闭。
      // 不记的话（尤其光标还停在 `/` 后面），findTrigger 会再次命中触发词，
      // 弹层关了又弹出——即「按回车命令列表闪一下」
      const caret = before.length + 1 + command.name.length;
      const node = textareaRef.current;
      if (node) {
        node.focus();
        node.value = next;
        node.setSelectionRange(caret, caret);
      }
      dismissedRef.current = { value: next, caret };
      return;
    }

    // 对话引用：把服务端铸好的 mention 原样插进正文（`@[标题](dsh-session:…)`）。
    // 服务端在用户消息进入模型前把它换成被引用会话的快照，客户端不做任何读取；
    // 与文件引用不同，它**没有**目录概念，也不参与下钻。
    if (isSessionCandidate(candidate)) {
      const mention = candidate.mention.trim();
      if (!mention) return;
      insertMentionText(mention);
      return;
    }

    const file = candidate as FileRefView;
    // 「..」：回到上一层目录。正文里只留 `@<上一层>`（上一层就是工作区根目录时
    // 是裸 `@`），光标停在末尾——服务端按结尾斜杠当目录查询，列表于是变成那一层
    // 的内容（与下钻走同一条链路，只是方向相反）。
    if (file.parent) {
      const next = `${before}@${file.path}${after}`;
      onDraft(next);
      post({ type: "setDraft", text: next });
      const caret = before.length + 1 + file.path.length;
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(caret, caret);
        refreshTrigger(next, caret);
      });
      post({ type: "queryFiles", query: file.path });
      return;
    }
    // 目录 + Tab（drill）：**打开**它（下钻），不是把它本身载入。
    // 下钻 = 把触发词替换成 `@<path>/` 并继续留在候选态；服务端按结尾斜杠
    // 把它当目录查询，于是列表变成该目录的内容。
    if (file.kind === "directory" && action === "drill") {
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
    // 文件 / 目录（pick）：把路径**作为纯引用 token 插进正文**。
    //
    // 用户口径（2026-09-14）：`@` 的语义就是「纯路径引用，交给 agent 自己读」，
    // 与「附件上传」是两条不同的通道，界面上也要一眼可分。所以这里**不再**生成
    // 附件栏里的引用芯片（那会让 @ 和「添加文件」看起来一模一样），而是把官方的
    // `@path` token 直接写进输入框——这正是官方客户端发出去的那串文本
    // （见 shared/mentions.ts 的文件头）。
    //
    // 目录走同一条路（2026-09-15 与官方对齐）：Enter / 点击目录行 = 引用整个目录，
    // 想进去浏览按 Tab（见 `drill` 分支与 `applyCandidate` 的注释）。
    const mention = formatFileMention(file.path, file.kind);
    insertMentionText(mention ?? `"${file.path}"`); // 不可引用（含控制字符/引号）→ 退回带引号路径
  };

  /**
   * 把一段 mention 文本插进正文并**关掉候选弹层**（文件引用与对话引用共用）。
   *
   * 「已关闭」标记必须记：否则随后那次 keyup 的重新探测会在同一个位置再命中
   * `@path`，弹层关了又弹（与 `/` 命令选中后同一套处理，见 refreshTrigger）。
   */
  const insertMentionText = (mention: string) => {
    if (!trigger) return;
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(trigger.start + 1 + trigger.query.length);
    post({ type: "queryFiles", query: "" });
    const next = `${before}${mention}${after}`;
    onDraft(next);
    post({ type: "setDraft", text: next });
    setTrigger(undefined);
    const caret = before.length + mention.length;
    dismissedRef.current = { value: next, caret };
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(caret, caret);
    });
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
          // 标记「这次高亮是键盘来的」：只有键盘导航才把选中行滚进视野，
          // 鼠标悬停（onMouseEnter 也会改高亮）时滚动列表会晃得没法用
          keyboardNavRef.current = true;
          setHighlight((value) => (value + 1) % candidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          keyboardNavRef.current = true;
          setHighlight((value) => (value - 1 + candidates.length) % candidates.length);
          return;
        }
        // Enter = 选中（目录就是「引用整个目录」）；Tab = 目录下钻，非目录退回选中。
        // 与官方一致（见 `applyCandidate` 的注释）：Esc/↑↓/Tab 之外，Tab 是唯一
        // 会「进入目录」的键。
        if (event.key === "Enter") {
          event.preventDefault();
          applyCandidate(highlight, "pick");
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          applyCandidate(highlight, "drill");
          return;
        }
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      // 长按重复：官方 keymap 明确忽略 `event.repeat`（避免一次按住连发多条）
      if (event.repeat) return;
      event.preventDefault();
      // Cmd/Ctrl+Enter = **加速手势**（官方 `ComposerSubmitGesture` 的
      // `accelerated`）：运行中它取 busyEnter 的**相反**行为。手势原样交给宿主，
      // 由宿主按「按下的那一刻」的运行状态解析（见 send 的注释）。
      send(event.ctrlKey || event.metaKey ? "accelerated" : "enter");
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
        <div className="popover trigger-popover" role="listbox" ref={popoverRef}>
          {candidates.length === 0 ? (
            <>
              <div className="popover-section">
                {trigger.kind === "command" ? texts.commands : texts.mentionFiles}
              </div>
              <div className="popover-empty">
                {trigger.kind === "command" ? texts.commandsEmpty : texts.mentionEmpty}
              </div>
            </>
          ) : (
            candidates.slice(0, 40).map((candidate, index) => {
              const isCommand = trigger.kind === "command";
              const isSession = !isCommand && isSessionCandidate(candidate);
              const row = candidate as CommandView & FileRefView & SessionRefView;
              // 「..」也算目录行，但不是服务端给的目录：它是「回上一层」——右侧不该有
              // 「整个目录」按钮，也不算「这一组有可下钻的目录」（标题栏那个 Tab 提示）
              const isParent = !isCommand && !isSession && row.parent === true;
              const isFolder = !isCommand && !isSession && row.kind === "directory" && !isParent;
              // 分组标题在**组的第一行**前面渲染（官方 MenuView 按 `section` 变更加标题）：
              // `@` 于是有「文件」「对话」两组，命令只有一组。
              const section = sectionOf(candidate);
              const showSection = index === 0 || sectionOf(candidates[index - 1]) !== section;
              return (
                <Fragment key={isCommand ? `c:${row.name}` : isSession ? `s:${row.sessionId}` : `f:${row.path}`}>
                  {showSection ? (
                    <div className="popover-section popover-section-row">
                      <span>{section}</span>
                      {/* 「Tab 进入目录」提示挂在**文件分组标题栏的最右侧**（靠右）：
                          它是这一组目录行的键盘说明，不是某一行的动作按钮——
                          行右侧那个位置留给「整个目录」按钮（见下面）。 */}
                      {!isCommand && section === texts.mentionFiles && hasFolderCandidate ? (
                        <>
                          <span className="spacer" />
                          <span className="popover-drill-hint">
                            <kbd className="popover-item-key">{texts.mentionDrillKey}</kbd>
                            {texts.mentionDrill}
                          </span>
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  <div
                    className={`popover-item${index === highlight ? " is-selected" : ""}`}
                    onMouseEnter={() => setHighlight(index)}
                  >
                    {/* 主体：点它 = 选中（等于 Enter）。文件 / 对话插入引用 token；
                        目录插入 `@dir/`（**引用整个目录**）；「..」回上一层。
                        下钻只走右侧的 Tab 徽标（见下面的按钮），与官方一致。 */}
                    <button
                      className="popover-item-hit"
                      title={isParent ? texts.mentionParent : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyCandidate(index, "pick");
                      }}
                    >
                      {/* 命令名与对话标题走「优先完整」那档样式（`.is-priority`）：宽度不够时
                          先省略右边的描述，绝不把命令截成 `/git-guard…`、把对话截成半个标题。
                          文件路径不做这个标记——长路径必须能省略。 */}
                      <span
                        className={`popover-item-main${
                          isCommand || isParent || isSession ? " is-priority" : ""
                        }`}
                      >
                        {isCommand
                          ? `/${row.name}`
                          : isSession
                            ? row.label
                            : isParent
                              ? ".."
                              : row.path}
                      </span>
                      {isParent ? (
                        <span className="popover-item-sub">
                          {/* 上一层就是根目录时没有路径可显示，退回说明文案 */}
                          {row.path || texts.mentionParent}
                        </span>
                      ) : isCommand && row.description ? (
                        <span className="popover-item-sub">{row.description}</span>
                      ) : isSession ? (
                        // 对话候选的次要说明照官方 `sessionCandidate`：非同工作区时给
                        // 工作目录（没有记录给「无工作目录」占位），再接时间。
                        <span className="popover-item-sub">
                          {[
                            row.sameWorkspace
                              ? undefined
                              : row.cwd
                                ? row.cwd
                                : texts.mentionNoCwd,
                            row.updatedAt !== undefined ? formatClock(row.updatedAt) : undefined,
                          ]
                            .filter((part): part is string => Boolean(part))
                            .join(" · ")}
                        </span>
                      ) : null}
                      {isCommand && row.skill ? (
                        <span className="popover-item-tag">{texts.skillTag}</span>
                      ) : null}
                    </button>
                    {/* 目录行右侧：**整个目录**（原样保留的按钮）——点它就是把目录本身
                        作为 `@dir/` 引用载入。它与点行主体（Enter）是**同一个动作**，
                        按钮只是把这件事显式摆出来；「进入目录」是 Tab 的事，
                        提示在分组标题栏右侧（见上）。 */}
                    {isFolder ? (
                      <button
                        className="popover-item-action"
                        title={texts.attachFolder}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyCandidate(index, "pick");
                        }}
                      >
                        <IconFolder size={11} />
                        {texts.attachFolder}
                      </button>
                    ) : null}
                  </div>
                </Fragment>
              );
            })
          )}
          <div className="popover-hint">{texts.mentionHint}</div>
        </div>
      ) : null}

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

