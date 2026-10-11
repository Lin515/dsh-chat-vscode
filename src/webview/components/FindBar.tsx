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
 * 2. **程序化滚动与展开折叠是同一次阅读动作**：跳到命中处时先展开折叠的用户气泡，
 *    再放跟随、两帧后居中——整条顺序都在 `../readingPlacement.ts` 的端口里
 *    （`revealMatch`），组件不再自己记「先释放后测量」。不放跟随的话 `autoScroll`
 *    的 settle 会把视口钉回底部、把刚算好的位置吃掉——与轮次横条跳转同一条纪律。
 * 3. **Esc 归 ESC 归属链**（`../escapeOwner.ts`）：本层按浮层层级登记，活跃期间才有
 *     归属，没人认领才轮到「停止生成」——不再自己挂 document 监听。
 *
 * 搜索范围的边界（都是「没渲染的内容搜不到」，与「加载更早」分页同一条诚实口径）：
 * 折叠的连续过程段与工具卡中段是**卸载**的（DOM 里没有）；折叠的用户长消息是
 * CSS 裁剪（文本在 DOM 里，搜得到，跳转时先点它的「展开」再定位）。
 *
 * 纯逻辑（子串定位、环绕推进）在 `../find.ts`，断言见 `scripts/find.test.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  computeMatches,
  FIND_ALL_HIGHLIGHT,
  FIND_CURRENT_HIGHLIGHT,
  stepActive,
} from "../find";
import { ESC_LAYER, useEscapeLayer } from "../escapeOwner";
import type { ReadingPort } from "../readingPlacement";
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
 * 跳到一处命中：交给阅读定位端口的 `revealMatch`——展开折叠的用户气泡、先放跟随、
 * 两帧后把**命中所在那一行**居中，四步的顺序与取消都在端口里。
 */
function reveal(match: Range[], port: ReadingPort): void {
  const range = match[0];
  if (range === undefined) return;
  port.revealMatch(range);
}

export function FindBar({
  /** 阅读定位端口：滚动区 / 正文列表 / 一次完整的命中定位动作都在这一份上。 */
  port,
}: {
  port: ReadingPort;
}) {
  const texts = useTexts();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState(0);
  /** 激活命中的 0 起下标（界面上显示 current + 1）。 */
  const [current, setCurrent] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  /** 正文列表（`.chat-list`）：搜索的根，也是 MutationObserver 的观察对象。 */
  const contentEl = port.contentEl;

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

  // Esc 关闭走归属链（见 `../escapeOwner.ts`）：本层活跃期间登记、关闭即注销。
  // 查找框聚焦时事件从 input 冒泡上来，元素层没人消费才轮到它——它先于「停止生成」
  // 的兜底被问到，因此查找开着时 ESC 只关查找条。
  useEscapeLayer(ESC_LAYER.floating, open, close);

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
      reveal(matches[clamped], port);
    },
    [port],
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
