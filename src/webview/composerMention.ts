/**
 * 草稿区 `@` 引用的**渲染镜像**：给引用上链接色（静止态）、按住 Ctrl / Cmd 时补下划线，
 * 以及「按住 Ctrl 悬停在引用上方才把光标变成手指」的命中判定（用户 2026-10-10 口径）。
 *
 * 为什么要有镜像层：输入框是 `<textarea>`，它里面是**一段连续的纯文本**，没有任何
 * 行内结构——CSS 选不中「其中某几个字」。所以可见的字全部由这层 `div` 画（文本域
 * 自己的字是透明的，见 `styles/app.css` 的 `.composer-input`），两层用**同一个
 * 类名**保证字号 / 行高 / 折行口径逐字一致；宽度、高度与滚动位置由组件从文本域同步
 * （镜像层自己量不出文本域的可视区）。
 *
 * 第一条硬约束是：**镜像层与文本域的可见文本必须逐字相同**——否则后续文字全部错位。
 * 本模块只切输入切片，不负责折叠。会话引用先由 `ComposerSessionDraft` 投影成 `@标题`，
 * 文本域和镜像同时使用投影；落盘与发送则由该端口序列化回完整 token。
 *
 * 纯函数、不碰 DOM 也不引 React：断言见 `scripts/composerMention.test.ts`。
 */
import { scanMentionLinks } from "./mentionLinks";

/** 草稿按引用切出来的一段（各段拼起来**逐字**等于整份草稿）。 */
export interface DraftSegment {
  /** 这一段的原文（原样，不做任何显示还原）。 */
  text: string;
  /** 是不是一条**可打开**的引用（镜像层给它上链接色）。解不开会话 id 的那类不算。 */
  link: boolean;
  /** 这一段在草稿里的起始下标（React 列表键：原文里唯一）。 */
  at: number;
}

/**
 * 把草稿切成「普通文本 / 可打开的引用」交替的若干段。
 *
 * 空草稿返回空表：镜像层不渲染任何东西，与空文本域完全一致。
 */
export function draftSegments(draft: string): DraftSegment[] {
  const spans = scanMentionLinks(draft);
  if (spans.length === 0) return draft ? [{ text: draft, link: false, at: 0 }] : [];
  const out: DraftSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      out.push({ text: draft.slice(cursor, span.start), link: false, at: cursor });
    }
    // 切段不改变输入内容；显示投影由会话草稿端口统一处理。
    out.push({
      text: draft.slice(span.start, span.end),
      link: span.target !== undefined,
      at: span.start,
    });
    cursor = span.end;
  }
  if (cursor < draft.length) out.push({ text: draft.slice(cursor), link: false, at: cursor });
  return out;
}

/** 一个矩形：`getClientRects()` 的元素就够用，测试里也不必造真的 `DOMRect`。 */
export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 点是否落在这些矩形中的某一个里（一条引用跨行时会有多个矩形）。
 *
 * 判定用文字**实际画出来**的那些矩形（`getClientRects()`）：它与用户眼睛看到的
 * 命中面是同一个东西。按「第几个字符 × 平均字宽」估会在等宽字体与 CJK 混排下偏，
 * 而这里连 `@` 与路径混排都得准。
 */
export function hitsAnyRect(rects: ArrayLike<Rect>, x: number, y: number): boolean {
  for (let index = 0; index < rects.length; index += 1) {
    const rect = rects[index];
    if (!rect) continue;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}
