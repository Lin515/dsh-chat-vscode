/**
 * 草稿区 `@` 引用的**渲染镜像**：给引用上链接色（静止态）、按住 Ctrl / Cmd 时补下划线，
 * 以及「按住 Ctrl 悬停在引用上方才把光标变成手指」的命中判定（用户 2026-10-10 口径）。
 *
 * 为什么要有镜像层：输入框是 `<textarea>`，它里面是**一段连续的纯文本**，没有任何
 * 行内结构——CSS 选不中「其中某几个字」。所以可见的字全部由这层 `div` 画（文本域
 * 自己的字是透明的，见 `styles/app.css` 的 `.composer-input`），两层用**同一个
 * 类名**保证字号 / 行高 / 折行口径逐字一致；宽度取文本域 content box 的**分数值**、
 * 高度与滚动位置由组件从文本域同步（镜像层自己量不出文本域的可视区；`clientWidth` 是
 * 取整后的值，见 {@link mirrorBoxWidth}）。
 *
 * 第一条硬约束是：**镜像层与文本域的可见文本必须逐字相同**——否则后续文字全部错位。
 * 本模块只切输入切片，不负责折叠。会话引用先由 `ComposerSessionDraft` 投影成 `@标题`，
 * 文本域和镜像同时使用投影；落盘与发送则由该端口序列化回完整 token。
 *
 * 纯函数、不碰 DOM：断言见 `scripts/composerMention.test.ts`。
 */
import { scanMentionLinks } from "./mentionLinks";
import { scanCommandLinks } from "./commandLinks";
import type { CommandView } from "../shared/chat";

/** 草稿按引用切出来的一段（各段拼起来**逐字**等于整份草稿）。 */
export interface DraftSegment {
  /** 这一段的原文（原样，不做任何显示还原）。 */
  text: string;
  /** 是不是一条**可打开**的引用（镜像层给它上链接色）。解不开会话 id 的那类不算。 */
  link: boolean;
  /** 目录中的虚拟技能也着色，但没有文件路径时不伪造打开动作。 */
  highlighted?: boolean;
  /** 这一段在草稿里的起始下标（React 列表键：原文里唯一）。 */
  at: number;
}

/**
 * 把草稿切成「普通文本 / 可打开的引用」交替的若干段。
 *
 * 空草稿返回空表：镜像层不渲染任何东西，与空文本域完全一致。
 */
export function draftSegments(draft: string, commands: readonly CommandView[] = []): DraftSegment[] {
  const mentions = scanMentionLinks(draft);
  const commandSpans = scanCommandLinks(draft, commands)
    .filter((span) => !mentions.some((mention) => span.start < mention.end && span.end > mention.start));
  const spans = [...mentions, ...commandSpans].sort((a, b) => a.start - b.start);
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
      ...(commandSpans.includes(span) ? { highlighted: true } : {}),
      at: span.start,
    });
    cursor = span.end;
  }
  if (cursor < draft.length) out.push({ text: draft.slice(cursor), link: false, at: cursor });
  return out;
}

/**
 * 镜像层（border-box）应有的宽度。
 *
 * 文本域真正用来排字的宽度是 **content box 的分数值**：布局单位是 1/64 CSS px，
 * 面板宽度、内边距与滚动条都会带小数。`clientWidth` 只会给出四舍五入后的整数
 * （实测 400.59375 的文本域 `clientWidth` 是 401），直接拿它当镜像层宽度，镜像层
 * 就比文本域宽出零点几个像素——恰好卡在折行边界上时，最后一两个字在镜像层留在
 * 第一行，而文本域（光标、选区、点击落点都由它排版）已经把它排到第二行，于是
 * 光标看起来比文字多走了一个「虚空字」。宽度必须来自分数值：优先用
 * `ResizeObserver` 的 content box（已扣掉滚动条与内边距），取不到时用
 * border-box 宽度减掉「边框 + 滚动条」。
 */
export function mirrorBoxWidth(input: {
  /** ResizeObserver 报的 content box 宽度；还没报过时省略。 */
  contentWidth?: number;
  /** `getBoundingClientRect().width`（border box，分数值）。 */
  borderWidth: number;
  /** `offsetWidth - clientWidth`（边框 + 滚动条，整数）。 */
  borderAndScrollbar: number;
  paddingLeft: number;
  paddingRight: number;
}): number {
  const padding = input.paddingLeft + input.paddingRight;
  if (input.contentWidth !== undefined && Number.isFinite(input.contentWidth)) {
    return input.contentWidth + padding;
  }
  return input.borderWidth - input.borderAndScrollbar;
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
