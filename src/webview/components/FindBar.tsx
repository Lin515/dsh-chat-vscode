/**
 * 会话查找条（Ctrl+F）——webview 里的自绘查找。
 *
 * VS Code 的 webview 拿不到编辑器的原生查找部件（侧栏 WebviewView 连选项都没有，
 * microsoft/vscode#173643 还开着），官方 Chat 1.134 的 Find in chat 也是核心自己画的。
 * 交互按官方同款收敛到本扩展要的三件事：**高亮 + 计数 + 上一处/下一处**；
 * 不做替换、不做正则（用户口径）。
 *
 * 三条实现纪律：
 *
 * 1. **高亮走 CSS Custom Highlight API**（`CSS.highlights` 登记 Range）：只读 DOM
 *    不改 DOM，React 流式重渲染、语法高亮 span 都不会被高亮标记冲掉（往文本节点里
 *    包 `<mark>` 的做法在这里必死——消息流每帧都在重渲染）。配色取编辑器查找的
 *    主题变量（`--vscode-editor-findMatch*`），主题跟随白送。
 * 2. **程序化滚动先放跟随**：跳到命中处之前先 `releaseFollow`，否则 `autoScroll`
 *    的 settle 会把视口钉回底部、把刚算好的位置吃掉——与轮次横条跳转同一条纪律。
 * 3. **Esc 在 document 层消费**：先于 App.tsx window 层的「Esc 停止生成」，
 *     与 SubagentNav 的浮层同一套分层。
 *
 * 搜索范围的边界（都是「没渲染的内容搜不到」，与「加载更早」分页同一条诚实口径）：
 * 折叠的连续过程段与工具卡中段是**卸载**的（DOM 里没有）；折叠的用户长消息是
 * CSS 裁剪（文本在 DOM 里，搜得到，跳转时先点它的「展开」再定位）。
 *
 * 纯逻辑（子串定位、环绕推进）在 `../find.ts`，断言见 `scripts/find.test.ts`。
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  computeMatches,
  FIND_ALL_HIGHLIGHT,
  FIND_CURRENT_HIGHLIGHT,
  stepActive,
} from "../find";
import { useTexts } from "../texts";
import { IconChevronDown, IconClose, IconSearch } from "../icons";

/** 内容变化后的重算合并窗口（ms）：流式期间 MutationObserver 连发，按它合并。 */
const RESCAN_DELAY_MS = 150;
/** 打开 / 换词后的首算延迟（ms）：连敲键盘时不逐键全量扫。 */
const TYPING_DELAY_MS = 80;

/**
 * CSS Custom Highlight API 的**最小类型面**：lib.dom 各版本对 `Highlight` /
 * `HighlightRegistry` 的覆盖参差，自带一份不依赖 TS 版本的窄声明。
 */
interface HighlightLike {
  add(range: AbstractRange): void;
}
type HighlightCtor = new () => HighlightLike;
interface HighlightRegistryLike {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
}

function highlightRegistry(): HighlightRegistryLike | undefined {
  if (typeof CSS === "undefined") return undefined;
  return (CSS as unknown as { highlights?: HighlightRegistryLike }).highlights;
}

function highlightCtor(): HighlightCtor | undefined {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight;
}

/**
 * 按文档序采出滚动正文里的全部文本节点。
 *
 * 排除两类：空节点（对拼接串没有贡献）与「加载更早」按钮的文字（界面文案，
 * 不是会话内容）。折叠的段 / 工具卡中段根本不在 DOM 里，天然不进来。
 */
function collectTextNodes(root: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Text): number {
      const parent = node.parentElement;
      if (parent === null || parent.closest(".history-more") !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.data.length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    nodes.push(current as Text);
  }
  return nodes;
}

function rangeOf(node: Text, start: number, end: number): Range {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range;
}

/** 把匹配结果登记进 Highlight 注册表（当前命中单独一份，配色更深）。 */
function paint(matches: Range[][], current: number): void {
  const registry = highlightRegistry();
  const Highlight = highlightCtor();
  // 没有这个 API（不会发生在本扩展支持的引擎上）就只保留计数与跳转
  if (!registry || !Highlight) return;
  const all = new Highlight();
  for (const match of matches) {
    for (const range of match) all.add(range);
  }
  registry.set(FIND_ALL_HIGHLIGHT, all);
  const active = matches[current];
  if (active === undefined) {
    registry.delete(FIND_CURRENT_HIGHLIGHT);
    return;
  }
  const one = new Highlight();
  for (const range of active) one.add(range);
  registry.set(FIND_CURRENT_HIGHLIGHT, one);
}

/** 摘掉全部查找高亮（关闭、清词、卸载共用）。 */
function clearMarks(): void {
  const registry = highlightRegistry();
  registry?.delete(FIND_ALL_HIGHLIGHT);
  registry?.delete(FIND_CURRENT_HIGHLIGHT);
}

/**
 * 跳到一处命中：先放跟随、展开折叠的用户气泡（若命中在里面），等布局落定后
 * 把**命中所在那一行**居中。
 *
 * 两个时序要点：
 * - 展开必须**点按钮**（Message.tsx 操作行里的「展开」）而不是自己撕 class：
 *   `is-clamped` 是 React 状态画的，手改 class 撑不过下一次渲染；
 * - 程序化滚动不算手势：不放的话 settle 会把视口钉回底部（轮次跳转同一条纪律）。
 *
 * 居中用**命中 Range 自己**的矩形（展开提交之后量）：气泡展开后有十几行，
 * 以气泡顶为居中目标的话命中行仍可能留在折叠视口之下。展开是否已落进布局
 * 用双 rAF 等——第一帧等 React 提交，第二帧量到的才是展开后的布局。
 */
function reveal(
  match: Range[],
  scrollEl: RefObject<HTMLElement | null>,
  releaseFollow: () => void,
): void {
  const scroller = scrollEl.current;
  const range = match[0];
  const anchor = range?.startContainer.parentElement;
  if (!scroller || !range || !anchor || !anchor.isConnected) return;
  const bubble = anchor.closest(".bubble");
  if (bubble !== null && bubble.classList.contains("is-clamped")) {
    // 展开按钮带 `aria-expanded`：失败回显行的「重发 / 撤回」与它共用 `msg-expand`
    // 类（Message.tsx 的 echoActions），裸类名选择器在那几行会点到「重发」。
    // 短气泡（内容没被裁）本来就没有这颗按钮，optional chaining 落成无害空操作。
    bubble
      .closest(".msg")
      ?.querySelector<HTMLButtonElement>(".msg-expand[aria-expanded]")
      ?.click();
  }
  // 程序化滚动不算手势：不放的话 settle 会把视口钉回底部（轮次跳转同一条纪律）
  releaseFollow();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (!anchor.isConnected) return;
      const line = range.getBoundingClientRect();
      if (line.height === 0) return; // 还是不可见（没有可点的展开钮）：不动视口
      scroller.scrollTop += line.top - scroller.getBoundingClientRect().top - scroller.clientHeight / 2;
    }),
  );
}

export function FindBar({
  scrollEl,
  contentEl,
  releaseFollow,
}: {
  /** 会话滚动区（`.chat-scroll`）：跳转定位的坐标系。 */
  scrollEl: RefObject<HTMLDivElement | null>;
  /** 正文列表（`.chat-list`）：搜索的根，也是 MutationObserver 的观察对象。 */
  contentEl: RefObject<HTMLDivElement | null>;
  /** 把「跟随最新」放掉（跳转前调用，理由见文件头第 2 条）。 */
  releaseFollow: () => void;
}) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  /** 激活命中的 0 起下标（界面上显示 current + 1）。 */
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // —— 回调里读最新值的 ref 面（与 autoScroll / turnRailNav 同一套手法）——
  const matchesRef = useRef<Range[][]>([]);
  const openRef = useRef(false);
  const queryRef = useRef("");
  const currentRef = useRef(0);
  /** 上次真正搜过的词：内容重算时保持激活位置，换词时回到第一处。 */
  const lastNeedleRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  openRef.current = open;
  queryRef.current = query;

  const schedule = useCallback(
    (delay: number, search: () => void) => {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(search, delay);
    },
    [],
  );

  /**
   * 全量重算：采节点 → 纯函数定位 → 造 Range → 登记高亮。
   *
   * 激活下标的口径：**换词回到第一处**（与编辑器查找一致），内容更新（流式追加、
   * 展开）保持原位置（夹到新范围内）——逐 token 跳回第一处会把读者拽走。
   */
  const search = useCallback(() => {
    const root = contentEl.current;
    const needle = queryRef.current;
    if (!root || !openRef.current || needle === "") {
      matchesRef.current = [];
      lastNeedleRef.current = null;
      currentRef.current = 0;
      setCount(0);
      setCurrent(0);
      clearMarks();
      return;
    }
    const nodes = collectTextNodes(root);
    const found = computeMatches(
      nodes.map((node) => node.data),
      needle,
    ).map((spans: ReturnType<typeof computeMatches>[number]) =>
      spans.map((span) => rangeOf(nodes[span.node], span.start, span.end)),
    );
    matchesRef.current = found;
    if (needle !== lastNeedleRef.current) {
      lastNeedleRef.current = needle;
      currentRef.current = 0;
    }
    currentRef.current = found.length === 0 ? 0 : Math.min(currentRef.current, found.length - 1);
    setCount(found.length);
    setCurrent(currentRef.current);
    paint(found, currentRef.current);
  }, [contentEl]);

  // 打开 / 换词后（合并连击）重算；关闭时上面的 search 早退分支负责清干净
  useEffect(() => {
    if (!open) return;
    schedule(TYPING_DELAY_MS, search);
  }, [open, query, schedule, search]);

  // 正文一变就重算（节流）：流式追加、图片落位、节点展开都在这里进来
  useEffect(() => {
    const root = contentEl.current;
    if (!root) return;
    const observer = new MutationObserver(() => {
      if (openRef.current && queryRef.current !== "") schedule(RESCAN_DELAY_MS, search);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [contentEl, schedule, search]);

  // 卸载（切到轨迹视图 / 面板销毁）时摘掉注册表里的高亮——它们是全局的
  useEffect(() => {
    const timer = timerRef.current;
    return () => {
      clearTimeout(timer);
      clearMarks();
    };
  }, []);

  const close = useCallback(() => {
    clearTimeout(timerRef.current);
    setOpen(false);
    openRef.current = false;
    matchesRef.current = [];
    clearMarks();
  }, []);

  /** 打开：把会话里已选中的文字带进查找框（编辑器查找的同款便利）。 */
  const openBar = useCallback(() => {
    const selection = window.getSelection();
    const selected = selection?.toString() ?? "";
    const root = contentEl.current;
    if (selected !== "" && root !== null && root.contains(selection?.anchorNode ?? null)) {
      setQuery(selected);
    }
    setOpen(true);
    openRef.current = true;
  }, [contentEl]);

  // Ctrl+F / Cmd+F 在 webview 里开查找（编辑器查找要求 editorFocus，侧栏视图没有
  // 那个上下文，按键会落进 webview）。已开着时再按 = 回到输入框并全选。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f") return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (openRef.current) inputRef.current?.select();
      else openBar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openBar]);

  // Esc 关闭：document 层消费，压过 App.tsx window 层的「Esc 停止生成」（分层先例：
  // SubagentNav）。查找框聚焦时事件从 input 冒泡上来，同样走这里。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  // 打开时聚焦并全选（再按 Ctrl+F 的 select 也走同一个框）
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  const goTo = useCallback(
    (index: number) => {
      const matches = matchesRef.current;
      if (matches.length === 0) return;
      const clamped = Math.min(Math.max(index, 0), matches.length - 1);
      currentRef.current = clamped;
      setCurrent(clamped);
      paint(matches, clamped);
      reveal(matches[clamped], scrollEl as RefObject<HTMLElement | null>, releaseFollow);
    },
    [scrollEl, releaseFollow],
  );

  const step = useCallback(
    (delta: number) => {
      goTo(stepActive(currentRef.current, matchesRef.current.length, delta));
    },
    [goTo],
  );

  if (!open) return null;

  return (
    <div className="find-bar" role="search" aria-label={texts.findInChat}>
      <IconSearch size={12} />
      <input
        ref={inputRef}
        className="find-input"
        type="text"
        aria-label={texts.findInChat}
        placeholder={texts.findPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          step(event.shiftKey ? -1 : 1);
        }}
      />
      {/* 0/0 与无结果共用一格：数字走 tabular-nums 防跳动，文案走词典 */}
      <span className="find-count" aria-live="polite">
        {query === "" ? "" : count === 0 ? texts.searchNoResults : `${current + 1}/${count}`}
      </span>
      <button
        type="button"
        className="icon-btn find-step is-up"
        title={texts.findPrev}
        aria-label={texts.findPrev}
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <IconChevronDown size={13} />
      </button>
      <button
        type="button"
        className="icon-btn find-step"
        title={texts.findNext}
        aria-label={texts.findNext}
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <IconChevronDown size={13} />
      </button>
      <button type="button" className="icon-btn" title={texts.findClose} aria-label={texts.findClose} onClick={close}>
        <IconClose size={13} />
      </button>
    </div>
  );
}
