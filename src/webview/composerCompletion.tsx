/**
 * 输入框里 `@` / `/` 补全的**唯一**归属地：触发词判定、候选取用与优先级、
 * 父目录查询、`pick` / `drill` 的差别、光标落点、「刚选完先别重开」的记忆、
 * 弹层键盘导航与随高亮滚动、以及弹层的 JSX 本身。
 *
 * 为什么收成一个 module：这套规则此前散在 `Composer.tsx` 的 9 段不相邻代码里
 * （跨 4 个 ref + 3 个 state + 2 个 helper），任何一处改动都要靠人记住另外八处。
 * 收进来之后 `Composer` 只剩布局 / 工具行 / 文本域，**不再知道弹层内部规则**；
 * 而规则本身拆成了可离线断言的纯函数（`findTrigger` / `rankCandidates` /
 * `tokenSpan` / `caretAfterInsert` / `candidateRows` / `actionFor` / `popoverVisible`），
 * 断言见 `scripts/mentionNav.test.ts`（行为）与 `scripts/pathInsert.test.ts`（光标算术）。
 *
 * 行为与搬家前**逐字一致**——每一条都对应一条断言：
 * 1. 草稿的两次写（`onDraft` 本地 state + `post({type:"setDraft"})` 宿主持久化）顺序与内容不变；
 * 2. 落光标仍在 `requestAnimationFrame` 里（否则 caret 会被 React 的重渲染顶掉）；
 * 3. `pick`（引用 token / 命令名）与 `drill`（进目录）的差别；
 * 4. 选完先 `dismissed` 一次，避免弹层立刻重开；
 * 5. ESC 优先级链：弹层打开时 ESC 先关弹层并 `stopPropagation`（不能把正在跑的那一轮中止了）；
 * 6. `/` 只有在**行首或空白后**且名字在命令目录里才走命令通道（与 `@` 提及的判定不同）。
 */
import {
  Fragment,
  useCallback,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  type TextareaHTMLAttributes,
} from "react";
import type { CommandView, FileRefView, SessionRefView } from "../shared/chat";
import { formatFileMention, normalizeMentionPath } from "../shared/mentions";
import { post } from "./bridge";
import { IconFolder } from "./icons";
import { mentionParent } from "./mentionNav";
import { formatClock } from "./components/primitives";
import type { Texts } from "./texts";

/* ============================ 纯逻辑（可离线断言） ============================ */

/** 输入框里正在编辑的触发词（`/` 命令或 `@` 文件/对话提及）。 */
export interface Trigger {
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
export type MentionCandidate = CommandView | FileRefView | SessionRefView;

/** 候选列表里的动作：`pick` = 把这一条插进正文，`drill` = 进目录浏览。 */
export type CandidateAction = "pick" | "drill";

/**
 * 找出光标前正在输入的触发词。
 *
 * 两者都以「行首或空白」为边界：
 * - `/` 若只认行首，用户在已有文字后打空格再输 `/` 就弹不出菜单（很常见）；
 * - 而路径里的 `/`（`src/dsh/controller.ts`）前面是非空白字符，用空白边界
 *   就能既允许句中触发、又不误判路径。
 *
 * 纯函数：断言见 `scripts/mentionNav.test.ts`（含「`@` 能与 `/` 在同一段文本里区分」）。
 */
export function findTrigger(text: string, caret: number): Trigger | undefined {
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

/** 这一条候选是不是「对话引用」（有 `mention`，没有文件那样的 `kind`）。 */
export function isSessionCandidate(candidate: MentionCandidate): candidate is SessionRefView {
  return typeof (candidate as SessionRefView).mention === "string";
}

/**
 * 把当前候选排成这一帧的列表。
 *
 * `@` 的顺序是官方 `reference` 源的顺序：文件在前、对话在后；查询已经进入某个
 * 子目录时，**上一层（`..`）永远排在最前**（文件浏览器的惯例，键盘上下也能选中它）。
 * 命令按名字做大小写不敏感的子串过滤。
 */
export function rankCandidates(
  trigger: Trigger | undefined,
  commands: readonly CommandView[],
  items: readonly FileRefView[],
  sessions: readonly SessionRefView[],
): MentionCandidate[] {
  if (!trigger) return [];
  if (trigger.kind === "command") {
    const query = trigger.query.toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().includes(query));
  }
  const files: MentionCandidate[] = [...items];
  const refs: MentionCandidate[] = [...sessions];
  const parent = mentionParent(trigger.query);
  if (parent === undefined) return [...files, ...refs];
  const up: FileRefView = { path: parent, kind: "directory", parent: true };
  return [up, ...files, ...refs];
}

/**
 * 触发词在正文里占的区间（含那个 `@` / `/`）。
 *
 * 内部实现：只有 `replaceToken` 用它，导出没有信息增量（调用方一律只要
 * `caretAfterInsert` 的「新文本 + 新光标」）。位置基于 `findTrigger` 的前提
 * ——光标就在触发词末尾。
 */
interface TokenSpan {
  before: string;
  after: string;
  /** 触发词起点。 */
  start: number;
  /** 触发词之后第一个字符的下标。 */
  end: number;
}

/** 算触发词区间。 */
function tokenSpan(text: string, trigger: Trigger): TokenSpan {
  const start = clampIndex(trigger.start, text.length);
  const end = clampIndex(trigger.start + 1 + trigger.query.length, text.length);
  return { before: text.slice(0, start), after: text.slice(end), start, end };
}

/** `caret` 夹到 `[0, length]`，非有限值按末尾处理。 */
function clampIndex(value: number, length: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(0, Math.trunc(value)), length) : length;
}

/**
 * 把 `text` 的一段区间换成 `token`，并给出**替换之后光标该落在哪**。
 *
 * 这是「插进来的 `@路径` 落在哪、后面的字有没有被吃掉」的全部算术——纯函数，
 * 离线可断言（`scripts/pathInsert.test.ts`）。`from`/`to` 会被夹到合法区间。
 *
 * 与 `insertToken` 的分工：那边是「在光标处塞一段文本」（前后按需补空格，宿主
 * 下发的路径插入走它）；这边是「把已经认出来的触发词整段换掉」（补全用），
 * 光标的落点规则不同，不能混用。
 */
export function caretAfterInsert(
  text: string,
  from: number,
  to: number,
  token: string,
): { text: string; caret: number } {
  const start = clampIndex(from, text.length);
  const stop = Math.max(start, clampIndex(to, text.length));
  const next = `${text.slice(0, start)}${token}${text.slice(stop)}`;
  return { text: next, caret: start + token.length };
}

/**
 * 把已经认出来的触发词整段换成 `token`。
 *
 * `token` 一律**已含**那个 `@` / `/`（命令是 `/name`、mention 是 `@path`）：
 * 调用方给的 token 与触发词的第一个字符是同一个通道，所以这里不再判断。
 */
export function replaceToken(
  text: string,
  trigger: Trigger,
  token: string,
): { text: string; caret: number } {
  return caretAfterInsert(text, trigger.start, tokenSpan(text, trigger).end, token);
}

/** 候选行的形状（渲染与动作都只读它，不再各自重推一遍 `kind` 的判断）。 */
export interface CandidateRow {
  /** 在这一帧列表里的序号（键盘导航与鼠标悬停都用它）。 */
  index: number;
  section: string;
  /** 是否在它前面渲染分组标题（组的第一行）。 */
  showSection: boolean;
  /** 命令名 / 会话标题 / `..` 走「优先完整」那一档（长路径不挂）。 */
  priority: boolean;
  /** 对话引用（`kind` / `path` 都不读）。 */
  session: boolean;
  /** 界面自己插的「返回上一层目录」行。 */
  parent: boolean;
  /** 服务端给的可进目录（`..` 不算，它没有「整个目录」按钮）。 */
  folder: boolean;
}

/**
 * 算出这一帧每一行的形状。
 *
 * `section` 由这条候选的种类与触发通道决定（命令一条、`@` 的文件 / 对话各一条，
 * 官方按 `section` 分组渲染）；`priority` 是「宽度不够时先省描述」的标记。
 */
export function candidateRows(
  candidates: readonly MentionCandidate[],
  kind: "command" | "mention",
  texts: Pick<Texts, "commands" | "mentionFiles" | "mentionSessions">,
): CandidateRow[] {
  const sectionOf = (candidate: MentionCandidate): string =>
    kind === "command"
      ? texts.commands
      : isSessionCandidate(candidate)
        ? texts.mentionSessions
        : texts.mentionFiles;
  return candidates.map((candidate, index) => {
    const isCommand = kind === "command";
    const isSession = !isCommand && isSessionCandidate(candidate);
    const isParent = !isCommand && !isSession && (candidate as FileRefView).parent === true;
    const section = sectionOf(candidate);
    return {
      index,
      section,
      showSection: index === 0 || sectionOf(candidates[index - 1]) !== section,
      priority: isCommand || isParent || isSession,
      session: isSession,
      parent: isParent,
      folder: !isCommand && !isSession && (candidate as FileRefView).kind === "directory" && !isParent,
    };
  });
}

/**
 * 这一批候选里有没有**可以进去浏览的目录**（`..` 不算：它是回上一层，Tab 对它没有意义）。
 *
 * 决定「文件」分组标题栏右侧要不要显示 `Tab 进入目录` 的提示——一个目录都没有时
 * 显示它只会让人以为按了有用。
 */
export function hasDrillableFolder(candidates: readonly MentionCandidate[]): boolean {
  return candidates.some(
    (candidate) =>
      !isSessionCandidate(candidate) &&
      (candidate as FileRefView).kind === "directory" &&
      (candidate as FileRefView).parent !== true,
  );
}

/** 选中这一条会发生什么（渲染只为它决定按钮，动作只在 `actionFor` 里判断一次）。 */
export type CandidateOutcome =
  /** 命令：写 `/name` 进正文，不查询。 */
  | { type: "command"; name: string }
  /** 对话引用：把服务端铸好的 mention 原样插进正文。 */
  | { type: "session"; token: string }
  /** `..`：回到上一层（正文只留上一层查询串）。 */
  | { type: "parent"; path: string }
  /** 目录（Enter / 行右侧「整个目录」按钮）：引用**整个目录**。 */
  | { type: "insert"; token: string }
  /** 目录 + drill（Tab / **点行主体**）：**打开**它，列表换成下一层的内容。 */
  | { type: "drill"; path: string };

/** 某条候选带某个动作时的结果；命令通道忽略 `action`。 */
export function outcomeFor(
  kind: "command" | "mention",
  candidate: MentionCandidate | undefined,
  action: CandidateAction,
): CandidateOutcome | undefined {
  if (!candidate) return undefined;
  if (kind === "command") return { type: "command", name: (candidate as CommandView).name };
  if (isSessionCandidate(candidate)) {
    const token = candidate.mention.trim();
    // 没有 token 的对话候选不该让用户选中（服务端理论上不会给），原样保留这条保护
    return token ? { type: "session", token } : undefined;
  }
  const file = candidate as FileRefView;
  if (file.parent) return { type: "parent", path: file.path };
  if (file.kind === "directory" && action === "drill") return { type: "drill", path: file.path };
  return { type: "insert", token: formatFileMention(file.path, file.kind) ?? `"${file.path}"` };
}

/** 弹层要不要渲染：有触发词，并且要么有候选、要么是 `@`（空结果也要给个「没有文件」）。 */
export function popoverVisible(trigger: Trigger | undefined, count: number): boolean {
  return Boolean(trigger && (count > 0 || trigger.kind === "mention"));
}

/**
 * **鼠标点行主体**时的动作（用户 2026-09-21 口径）。
 *
 * 目录行点进去（下钻到该目录的候选），其余一律选中。用户的原话：「鼠标点击目录的默认
 * 行为应该是打开该目录，而不是直接选中该目录，如果是选中该目录，尾部已有整个目录按钮
 * 用于满足该需求了」——所以行右侧那枚「整个目录」按钮才是鼠标的「选中」入口。
 *
 * 键盘分工**不动**（官方口径）：Enter = 选中、Tab = 下钻。两边各有一条路：
 * 想引用整个目录，鼠标点按钮、键盘按 Enter，谁都不会被挤掉。
 */
export function clickAction(shape: CandidateRow): CandidateAction {
  return shape.folder ? "drill" : "pick";
}

/* ============================ hook ============================ */

/** `useComposerCompletion` 的输入。 */
export interface UseComposerCompletionInput {
  /** 当前草稿（受控：组件持有 state，这里只读）。 */
  draft: string;
  /** 光标位置；缺省按草稿末尾。 */
  caret?: number;
  /** 命令目录（`commands/list`）。 */
  commands: readonly CommandView[];
  /** 文件 / 对话候选（`fileReferences/list` + `sessionReferenceResolver/candidates`）。 */
  fileRefs: {
    query: string;
    items: readonly FileRefView[];
    sessions: readonly SessionRefView[];
  };
  /** 界面文案（词典）。 */
  texts: Texts;
  /** 草稿写回：本地 state（宿主持久化那一写由本 module 自己发）。 */
  onDraft: (text: string) => void;
  /**
   * 弹层**没接管**的 Enter 交给它（`"accelerated"` = Cmd/Ctrl+Enter）。
   *
   * 为什么归这个 module：文本域只有**一个** `onKeyDown`（组件把 `textareaProps` 摊上去），
   * 而 Enter 的语义分在两地就会丢一半——2026-09-19 把弹层分支搬进来时，发送分支留在原地
   * 没人看见，于是回车变成了换行（用户当天报的现场）。一条键的语义必须只住一处。
   */
  onSubmit?: (gesture: "enter" | "accelerated") => void;
  /** 宿主下发的「插到光标处」请求（`setDraft` 帧），按 id 去重。 */
  insertRequest?: { id: number; text: string };
  /**
   * 界面自产的「引用到输入框」请求（正文右键菜单的「引用」），按 id 去重。
   *
   * 与 `insertRequest` 同为「往文本域里插东西」，但拼接口径不同（块 vs 行内，
   * 见 `quoteBlock`），所以是两条请求而不是一条带标志位的。
   */
  quoteRequest?: { id: number; text: string };
  /**
   * 文本域节点的 ref。组件自己的自适应量高与「跑完把焦点还回来」也要同一个节点，
   * 传进来两边就共用**一个** ref 对象（同一个元素上挂两个 ref 属性时只有最后一个生效）。
   */
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
}

/** `useComposerCompletion` 的返回：弹层 + 文本域要接的那几个 prop。 */
export interface ComposerCompletion {
  /** 触发词弹层（没触发时是 null）。 */
  popover: ReactNode;
  /**
   * 文本域要接的 prop（ref + 四个事件）。
   *
   * `onKeyDown` 里带着 ESC 优先级链与 Enter/Tab 的补全语义，所以**不能**由组件
   * 自己再写一份——组件只负责把工具行、文本域这些「其余一切」拼起来。
   *
   * `ref` 就是传进来的 `textareaRef`（没传时是 hook 自建的那个），所以组件既可以直接
   * `{...textareaProps}` 交给文本域，也可以自己再挂一个 ref——两种写法都能用。
   */
  textareaProps: Pick<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "onChange" | "onKeyUp" | "onClick" | "onKeyDown"
  > & {
    /**
     * 就是传进来的 `textareaRef`（没传时是本 hook 自建的那个）。
     *
     * 类型与入参同为 `MutableRefObject<HTMLTextAreaElement | null>`：React 18 的
     * `RefObject<T>` 把 `current` 标成 `readonly`，而这里写的是「可写、可能为 null」
     * 的那一支（文本域的 `ref` 属性两者都收）。
     */
    ref: MutableRefObject<HTMLTextAreaElement | null>;
  };
}

/**
 * `@` / `/` 补全的完整规则集（见文件头）。`Composer` 只调用它并摆位。
 */
export function useComposerCompletion(input: UseComposerCompletionInput): ComposerCompletion {
  // 状态钩子经 context 取：默认就是 React 的 `useState`，只有离线测试会换掉它
  // （server 渲染里状态更新被丢弃，弹层永远只有第一帧，见 `ComposerCompletionState`）。
  const useStateImpl = useContext(ComposerCompletionState);
  return useCompletion(input, useStateImpl);
}

/** 测试用的状态钩子替身：把状态挂在同一个 map 上跨渲染保留。 */
export type ComposerCompletionStateHook = <T>(initial: T | (() => T)) => [T, Dispatch<SetStateAction<T>>];

/**
 * 状态钩子的注入点。
 *
 * 存在的唯一理由是**可离线断言**：`react-dom/server` 的渲染不重放状态更新
 * （`setState` 排队后就结束），弹层因此永远停在第一帧。测试用这个 context 换一个
 * 「状态跨渲染保留」的假钩子，就能跑真实的「事件 → 下一帧」链路；
 * 生产里没人提供它，走的就是 React 自己的 `useState`。
 */
export const ComposerCompletionState = createContext<ComposerCompletionStateHook>(useState);

function useCompletion(
  {
    draft,
    caret,
    commands,
    fileRefs,
    texts,
    onDraft,
    onSubmit,
    insertRequest,
    quoteRequest,
    textareaRef,
  }: UseComposerCompletionInput,
  useStateImpl: ComposerCompletionStateHook,
): ComposerCompletion {
  /**
   * 本 hook 要用的文本域节点。
   *
   * 优先用组件传进来的那个（组件自己的自适应量高与「跑完把焦点还回来」也要这个
   * 节点）：两边是**同一个 ref 对象**，不需要在一个元素上挂两个 ref 属性——同一个
   * 元素上挂两个时只有最后一个生效。没传（测试 / 独立使用）就自己建一个。
   */
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? ownRef;
  // ESC 关掉候选弹层后记下当时的文本与光标：只要没有真实编辑，随后的 keyup /
  // 聚焦回调不会重新探测触发词把列表弹回来（否则表现为「按 ESC 列表又弹出」）
  const dismissedRef = useRef<{ value: string; caret: number } | null>(null);
  /** 候选行的容器（弹层本体，可滚动的那一层），键盘导航要滚它。 */
  const popoverRef = useRef<HTMLDivElement | null>(null);
  /** 这一次高亮变化是不是键盘导航引起的（鼠标悬停不滚动列表）。 */
  const keyboardNavRef = useRef(false);
  /**
   * 初始触发词由**第一帧**的草稿 + 光标位置算出来。
   *
   * 生产里 `Composer` 不传 `caret`（它把 undefined 当末尾），而第一次渲染时草稿本来
   * 就是空字符串，所以这里恒等于 `findTrigger("", 0) === undefined`——与搬家前
   * `useState(undefined)` 逐字等价。传了 `caret`（测试与独立使用）时才能从第一帧
   * 就看见触发词，否则「弹层该不该渲染」这类断言没法离线跑。
   */
  const [trigger, setTrigger] = useStateImpl<Trigger | undefined>(() => findTrigger(draft, caret ?? draft.length));
  const [highlight, setHighlight] = useStateImpl<number>(0);
  /**
   * 每次都读到**最新一帧**的草稿、目录与回调。
   *
   * rAF 里的落光标与 keyup 的重新探测都要读「刚才那一帧」的值，闭包捕获会读到旧的
   * （草稿已被 React 换成新的，捕获的却还是上一帧）——搬家前这些代码直接读组件作用
   * 域里的 `state.draft`，等价于这里每次都取最新值。
   */
  const latest = useRef({ draft, commands, fileRefs, texts, onDraft, onSubmit });
  latest.current = { draft, commands, fileRefs, texts, onDraft, onSubmit };

  /**
   * 草稿的**两次写**：本地 state（`onDraft`，界面立刻变）+ 宿主持久化
   * （`setDraft` 帧，换会话 / 重载后草稿还在）。顺序与内容必须与搬家前一致。
   */
  const writeDraft = useCallback((text: string) => {
    latest.current.onDraft(text);
    post({ type: "setDraft", text });
  }, []);

  /** 触发词出现时才去拉候选列表，避免每次输入都请求。 */
  useEffect(() => {
    if (trigger?.kind === "command") post({ type: "listCommands" });
    if (trigger?.kind === "mention") post({ type: "queryFiles", query: trigger.query });
    setHighlight(0);
  }, [trigger?.kind, trigger?.query]);

  /**
   * 宿主要求把文本插到光标处（选了不能内嵌的路径：目录 / 二进制 / 非 UTF-8…）。
   *
   * 光标位置只有界面知道，所以这里读 textarea 的 selectionEnd 决定插在哪，
   * 插完再把光标挪到插入内容之后。同一个请求只处理一次（重渲染不该重复插入）。
   */
  const handledInsertId = useRef(0);
  useEffect(() => {
    const request = insertRequest;
    if (!request || request.id === handledInsertId.current) return;
    handledInsertId.current = request.id;

    const el = ref.current;
    const text = latest.current.draft;
    // 有选区时插在选区之后（不删用户已选中的文字）
    const next = insertToken(text, request.text, el?.selectionEnd ?? caret ?? text.length);
    writeDraft(next.value);
    // 等 React 把新 value 渲染出来再定位光标
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    // 只依赖 id：effect 内读的草稿就是这次请求对应的那一帧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertRequest?.id]);

  /**
   * 正文右键菜单的「引用」：把选中文字以**引用块**插到光标处（见 `quoteBlock`）。
   *
   * 与上面那条（宿主下发的插入）同一套落点口径与去重方式：读文本域的 `selectionEnd`、
   * 插完把光标落在插入内容之后、`requestAnimationFrame` 里落光标。两条分开写而不是
   * 合成一条带标志位的，是因为拼接规则**完全不同**（块 vs 行内），共用一个函数只会
   * 让「这段到底补不补空格」变成运行时的分支。
   */
  const handledQuoteId = useRef(0);
  useEffect(() => {
    const request = quoteRequest;
    if (!request || request.id === handledQuoteId.current) return;
    handledQuoteId.current = request.id;

    const el = ref.current;
    const text = latest.current.draft;
    const next = quoteBlock(text, request.text, el?.selectionEnd ?? caret ?? text.length);
    writeDraft(next.value);
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.caret, next.caret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteRequest?.id]);

  /** 当前这一帧的候选（命令通道取命令目录、`@` 通道取文件 + 对话 + `..`）。 */
  const candidates = useMemo(
    () => rankCandidates(trigger, commands, fileRefs.items, fileRefs.sessions),
    [trigger, commands, fileRefs],
  );

  const rows = useMemo(
    () => candidateRows(candidates, trigger?.kind ?? "mention", texts),
    [candidates, trigger?.kind, texts],
  );

  const hasFolderCandidate = useMemo(() => hasDrillableFolder(candidates), [candidates]);

  /**
   * 键盘上下键移动高亮时，把选中行**滚进视野**。
   *
   * 弹层是 `max-height: 330px; overflow-y: auto`（`.popover`）：候选多于一屏时，
   * 光改高亮而不滚动，选中项会跑到视野外——用户看着列表「没反应」，回车却选中了
   * 一个看不见的条目。
   *
   * 只在**键盘导航**后滚动（`keyboardNavRef`）：鼠标悬停也会改高亮，那时滚列表
   * 会把指针底下的内容挪走，晃得没法用。用 `getBoundingClientRect` 自己算差值
   * 而不是 `scrollIntoView`：后者会连带滚动外层容器（对话区）。
   *
   * `useLayoutEffect`（绘制之前）与搬家前一致——晚一帧就是「选中行先闪一下再滚」。
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

  /**
   * 把光标落到 `token` 替换结果算出的那一格。
   *
   * 必须在 `requestAnimationFrame` 里落：同步改 DOM 的位置会被这一次重渲染顶掉
   * （React 提交时会按新 prop 重置光标），表现为「选完光标跑回原处」。
   */
  const landCaret = useCallback((at: number) => {
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(at, at);
    });
  }, []);

  /** 触发词整段替换 + 两次写 + 落光标（`drill` 与 `..` 共用）。 */
  const replace = useCallback(
    (token: string, query: string) => {
      const current = latest.current;
      if (!trigger) return;
      const result = replaceToken(current.draft, trigger, token);
      writeDraft(result.text);
      post({ type: "queryFiles", query });
      landCaret(result.caret);
      // 下钻 / 回上一层**不**关弹层：列表换成新那一层的内容继续留在候选态
      setTrigger(findTrigger(result.text, result.caret));
    },
    [trigger, writeDraft, landCaret],
  );

  /**
   * 把一段 mention 文本插进正文并**关掉候选弹层**（文件引用与对话引用共用）。
   *
   * 「已关闭」标记必须记：否则随后那次 keyup 的重新探测会在同一个位置再命中
   * `@path`，弹层关了又弹。光标在 rAF 里落（同步改 DOM 会被 React 的重渲染顶掉）。
   */
  const insertMentionText = useCallback(
    (mention: string) => {
      if (!trigger) return;
      const result = replaceToken(latest.current.draft, trigger, mention);
      post({ type: "queryFiles", query: "" });
      writeDraft(result.text);
      setTrigger(undefined);
      dismissedRef.current = { value: result.text, caret: result.caret };
      landCaret(result.caret);
    },
    [trigger, writeDraft, landCaret],
  );

  /**
   * 选中一条候选。三条通道的差别全在 `outcomeFor` 里，这里只执行：
   * - **Enter** = `pick`（目录就是「引用整个目录」）；
   * - **Tab** = `drill`（目录下钻，非目录退回 `pick`）；
   * - **鼠标点行主体** = 目录下钻、其余 `pick`（行右侧「整个目录」按钮才是选中目录）。
   *
   * 与官方的差别只有一处：官方鼠标点行 = `pick`（与 Enter 同义），这里改成「点目录
   * 就进去」（用户 2026-09-21 口径）。键盘分工不动，所以「引用整个目录」在键盘上
   * 仍是 Enter、鼠标上是那枚按钮——两条都有路可走，谁也不会被挤掉。
   */
  const applyCandidate = useCallback(
    (index: number, action: CandidateAction = "pick") => {
      const current = latest.current;
      if (!trigger) return;
      const outcome = outcomeFor(
        trigger.kind,
        candidates[index],
        action,
      );
      if (!outcome) return;
      if (outcome.type === "command") {
        const result = replaceToken(current.draft, trigger, `/${outcome.name}`);
        writeDraft(result.text);
        setTrigger(undefined);
        // 光标同步落到命令名之后：接下来直接打参数，再按回车就是执行。
        // 同步改 textarea 的 DOM 值与光标——React 这帧提交时 prop 值已相同、
        // 不会再重置光标，于是这次 Enter 随后的 keyup 读到的正是「新文本+新光标」。
        // 把同一对记进「已关闭」标记：keyup 重新探测时命中它、列表保持关闭。
        // 不记的话（尤其光标还停在 `/` 后面），findTrigger 会再次命中触发词，
        // 弹层关了又弹出——即「按回车命令列表闪一下」
        dismissedRef.current = { value: result.text, caret: result.caret };
        const node = ref.current;
        if (node) {
          node.focus();
          node.value = result.text;
          node.setSelectionRange(result.caret, result.caret);
        }
        return;
      }
      if (outcome.type === "session") {
        // 对话引用：服务端铸好的 mention 原样插进正文（`@[标题](dsh-session:…)`），
        // 它**没有**目录概念，也不参与下钻。
        insertMentionText(outcome.token);
        return;
      }
      if (outcome.type === "parent") {
        // 「..」：回到上一层目录，与 drill 同一条链路、方向相反。
        // 分隔符归一（用户 2026-09-21 口径）：用户手输 `src\webview\` 时上一层是
        // `src\`，写成 `@src/` 才和引用文本的语法一致（见 `shared/mentions.ts`）。
        const parent = normalizeMentionPath(outcome.path);
        replace(`@${parent}`, parent);
        return;
      }
      if (outcome.type === "drill") {
        // 目录 + Tab / 点行主体：**打开**它（下钻），不是把它本身载入。正文里补上
        // 结尾斜杠，服务端按它当目录查询，列表于是换成该目录的内容。
        //
        // 分隔符同样归一：候选路径可能来自 Windows 侧（`src\webview`），
        // 不归一就会在正文里留下 `@src\webview/`（用户 2026-09-21 报的）。
        // 这里写的是**查询形态**（还没选中任何东西），所以不加引号——带空格的路径
        // 本来就无法用触发词继续下钻（查询按空白切段），引号只属于最终引用。
        const path = normalizeMentionPath(outcome.path);
        replace(`@${path}/`, `${path}/`);
        return;
      }
      // 文件 / 目录（pick）：把路径**作为纯引用 token 插进正文**。
      //
      // 用户口径：`@` 的语义就是「纯路径引用，交给 agent 自己读」，与「附件上传」
      // 是两条不同的通道（见 `shared/mentions.ts` 的文件头）。
      insertMentionText(outcome.token);
    },
    [trigger, candidates, writeDraft, insertMentionText, replace],
  );

  /**
   * 每次输入 / 光标移动后重算触发词。
   *
   * 「已关闭」标记命中（文本与光标都没变）就保持关闭；任何真实变化都解除它。
   */
  const refreshTrigger = useCallback(
    (value: string, at: number) => {
      const dismissed = dismissedRef.current;
      if (dismissed && dismissed.value === value && dismissed.caret === at) {
        // ESC 刚关闭、文本与光标都没变：保持关闭，不重新弹出
        setTrigger(undefined);
        return;
      }
      // 任何真实的文本 / 光标变化都解除「已关闭」标记
      dismissedRef.current = null;
      setTrigger(findTrigger(value, at));
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (trigger) {
        // ESC 关掉候选弹层：优先级最高。记下文本+光标防止随后的 keyup 重新
        // 探测把列表弹回来；stopPropagation 让这次 ESC 不再落到「关弹层 / 停止
        // 生成」的更高层监听上（App.tsx 的 window 层兜底）
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
          // 与官方一致：Esc/↑↓/Tab 之外，Tab 是唯一会「进入目录」的键。
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
      // 弹层**没**接管的 Enter = 发送（Shift+Enter 换行、Cmd/Ctrl+Enter = 加速手势）。
      //
      // 与官方同口径：组合输入（中文输入法选词）中的 Enter 一律放过；`send` 只发**手势**，
      // 「排队 / 插话 / 停止」由宿主按按下的那一刻在不在跑来解析。
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        latest.current.onSubmit?.(event.ctrlKey || event.metaKey ? "accelerated" : "enter");
      }
    },
    [trigger, candidates, highlight, draft, applyCandidate],
  );

  const onEdit = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      latest.current.onDraft(value);
      post({ type: "setDraft", text: value });
      refreshTrigger(value, event.target.selectionStart ?? value.length);
    },
    [refreshTrigger],
  );

  const onCaretMove = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      // 光标移动（方向键、点击）也要重算触发词
      const el = event.currentTarget;
      refreshTrigger(el.value, el.selectionStart ?? el.value.length);
    },
    [refreshTrigger],
  );

  const popover = useMemo(
    () =>
      popoverVisible(trigger, candidates.length) ? (
        <div className="popover trigger-popover" role="listbox" ref={popoverRef}>
          {candidates.length === 0 ? (
            <>
              <div className="popover-section">
                {trigger?.kind === "command" ? texts.commands : texts.mentionFiles}
              </div>
              <div className="popover-empty">
                {trigger?.kind === "command" ? texts.commandsEmpty : texts.mentionEmpty}
              </div>
            </>
          ) : (
            candidates.slice(0, 40).map((candidate, index) => {
              const isCommand = trigger?.kind === "command";
              const row = candidate as CommandView & FileRefView & SessionRefView;
              // 行的形状（分组、优先完整、是不是「..」/「整个目录」/对话）都由
              // candidateRows 算好：渲染不再自己重推一遍那串 kind 判断
              const shape = rows[index];
              return (
                <Fragment key={isCommand ? `c:${row.name}` : shape.session ? `s:${row.sessionId}` : `f:${row.path}`}>
                  {shape.showSection ? (
                    <div className="popover-section popover-section-row">
                      <span>{shape.section}</span>
                      {/* 「Tab 进入目录」提示挂在**文件分组标题栏的最右侧**（靠右）：
                          它是这一组目录行的键盘说明，不是某一行的动作按钮——
                          行右侧那个位置留给「整个目录」按钮（见下面）。 */}
                      {!isCommand && shape.section === texts.mentionFiles && hasFolderCandidate ? (
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
                    {/* 主体：**目录行点它就是打开该目录**（下钻进下一层），
                        文件 / 对话插入引用 token，「..」回上一层。
                        选中**整个目录**由行右侧那枚「整个目录」按钮负责（用户 2026-09-21
                        口径：鼠标点行 = 进目录，想引用整个目录有专门的按钮）；
                        键盘那边仍是官方分工——Enter 选中、Tab 下钻。 */}
                    <button
                      className="popover-item-hit"
                      title={shape.parent ? texts.mentionParent : shape.folder ? texts.mentionDrill : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        applyCandidate(index, clickAction(shape));
                      }}
                    >
                      {/* 命令名与对话标题走「优先完整」那档样式（`.is-priority`）：宽度不够时
                          先省略右边的描述，绝不把命令截成 `/git-guard…`、把对话截成半个标题。
                          文件路径不做这个标记——长路径必须能省略。 */}
                      <span className={`popover-item-main${shape.priority ? " is-priority" : ""}`}>
                        {isCommand
                          ? `/${row.name}`
                          : shape.session
                            ? row.label
                            : shape.parent
                              ? ".."
                              : row.path}
                      </span>
                      {shape.parent ? (
                        <span className="popover-item-sub">
                          {/* 上一层就是根目录时没有路径可显示，退回说明文案 */}
                          {row.path || texts.mentionParent}
                        </span>
                      ) : isCommand && row.description ? (
                        <span className="popover-item-sub">{row.description}</span>
                      ) : shape.session ? (
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
                    {/* 目录行右侧：**整个目录**——点它就是把目录本身作为 `@dir/` 引用载入。
                        它现在是**鼠标唯一的「选中整个目录」入口**（点行主体是下钻），
                        键盘对应 Enter（见 onKeyDown）；「进入目录」键盘上是 Tab，
                        鼠标上就是点行主体，提示在分组标题栏右侧（见上）。 */}
                    {shape.folder ? (
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
      ) : null,
    [trigger, candidates, rows, hasFolderCandidate, highlight, texts, applyCandidate],
  );

  return {
    popover,
    textareaProps: {
      ref,
      onChange: onEdit,
      onKeyUp: onCaretMove,
      onClick: onCaretMove,
      onKeyDown,
    },
  };
}

/* ============================ 宿主的「插到光标处」 ============================ */

/** 需要在插入内容前补空格吗：前面有内容、且不是空白结尾。 */
function needPrefix(before: string): boolean {
  return before.length > 0 && !/\s$/.test(before);
}

/** 需要在插入内容后补空格吗：后面还有内容、且不是空白开头。 */
function needSuffix(after: string): boolean {
  return after.length > 0 && !/^\s/.test(after);
}

/** 在光标处插入一段文本的结果。 */
export interface InsertResult {
  /** 插入后的完整文本。 */
  value: string;
  /** 插入内容之后的光标位置。 */
  caret: number;
}

/**
 * 把 `insert` 放到 `caret` 处（宿主下发的路径 / 引用插入走这条路）。
 *
 * - `caret` 会被夹到 `[0, value.length]`，越界不抛错（调用方可能传来过期的位置）；
 * - 前后按需补一个空格，让插入结果与已有文字自然分开（避免 `text"C:\x"` 粘连）；
 * - 返回的新光标落在插入内容之后，用户可以直接接着打字。
 *
 * 与 `caretAfterInsert` 的区别：那边是「把认出来的触发词整段换掉」（不多补空格），
 * 这边是「在光标处塞一段新文本」（要补空格），两条不同的光标算术，别混用。
 */
export function insertToken(value: string, insert: string, caret: number): InsertResult {
  const at = clampIndex(caret, value.length);
  const before = value.slice(0, at);
  const after = value.slice(at);
  const body = `${needPrefix(before) ? " " : ""}${insert}${needSuffix(after) ? " " : ""}`;
  return { value: `${before}${body}${after}`, caret: before.length + body.length };
}

/**
 * 把一段**选中的文字**以 markdown 引用块插到 `caret` 处（正文右键菜单的「引用」）。
 *
 * 与 `insertToken` 是两条不同的拼接口径，别混用：
 * - 那边是**行内**插入一段 token（前后按需补空格，插完接着写字还在同一行）；
 * - 这边是**块**插入：引用块要自己占整行（用户 2026-09-23 口径「换行成单独的引用块」），
 *   所以前面不在行首就补一个换行，后面再补一个换行让光标落在引用块**之外**——
 *   否则用户接着敲的字会被并进引用里。
 *
 * 引用内部的空行也带上 `>`：markdown 的引用块靠连续 `>` 行界定，中间留一个裸空行
 * 会把块切断。
 */
export function quoteBlock(value: string, quote: string, caret: number): InsertResult {
  const at = clampIndex(caret, value.length);
  const before = value.slice(0, at);
  const after = value.slice(at);
  const body = quote
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const tail = after.startsWith("\n") ? "" : "\n";
  const inserted = `${lead}${body}${tail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
