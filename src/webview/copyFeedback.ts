/**
 * 复制反馈的唯一实现：剪贴板写入 + 两种可见反馈。
 *
 * ## 为什么收口成一个模块
 *
 * 「复制」在界面上有十几个入口：工具卡、工具 IN/OUT、diff 头部、写入预览、问卷记录、
 * 后台任务详情、历史会话 ID、代码块、消息操作行、轨迹各段原文，以及没有按钮可换文案的
 * 右键菜单与会话选区快捷键。它们要的是**同一件事**：把正文交给宿主写剪贴板，然后让
 * 用户看见它成功了。此前每处各写一遍状态机与计时，失败模式是「这里 1s、那里 2s，
 * 还有几处干脆没有反馈」——谁也不会注意到（与 `autoScroll.ts` 收口时同一个理由）。
 *
 * 现在只有两档反馈，且都在这里：
 * 1. **有按钮的地方**把图标换成对勾（用户 2026-11-02 口径：所有按钮统一成图标按钮，
 *    不带文字、不换文案），由 `useCopyFeedback` 的 1s 状态机驱动，见
 *    `components/CopyButton.tsx`；
 * 2. **没有按钮的地方**（右键菜单条目、会话选区 Ctrl+C / Cmd+C）在触发点附近闪**一枚
 *    对勾**（同样不带文字），由 `flashCopied` 驱动，见 `CopyFlashLayer`。
 *
 * 两档在视觉上都只说「成功了」，不给用户读的文案；「已复制到剪贴板」这句只经
 * `sr-only` 的 live region 念给读屏。
 *
 * 宿主侧**不发**「已复制」通知（用户 2026-09-17 口径：常规复制成功不入队，见
 * `docs/design-notifications.md`）。这里的提示是界面自己的瞬时反馈，不进通知队列。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { post } from "./bridge";

/**
 * 复制反馈的显示时长（官方 1s）。
 *
 * 按钮的成功态与提示胶囊共用这一个值；样式表里 `copy-flash` 的动画时长也取 1s，
 * 两边改一处就要一起看。
 */
export const COPIED_MS = 1000;

/**
 * 写剪贴板：全界面**唯一**的 `copy` 帧入口。
 *
 * webview 里 `navigator.clipboard` 受限（见 `imageClipboard.ts` 的文件头），纯文本
 * 一律交给宿主的 `vscode.env.clipboard.writeText`。复制按钮、右键菜单与会话选区
 * 快捷键都走这里，别处不再直接 `post({ type: "copy" })`。
 */
export function copyText(text: string): void {
  post({ type: "copy", text });
}

/**
 * 按钮内的复制反馈状态机。
 *
 * - `copy()` 写剪贴板并亮 `COPIED_MS`；亮着期间重复点击**不再重发**（连续点两下
 *   不该写两遍剪贴板，也不该把计时一次次续上）；
 * - 组件卸载时清掉计时器：展开区收起、会话切换都会把按钮摘掉，卸掉之后再
 *   `setState` 没有意义。
 */
export function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  // 计时器与「亮着」各留一份 ref：`copy` 的回调身份要稳定（不随 `copied` 重建），
  // 又必须读到最新状态，所以不能只靠 state 本身
  const copiedRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      if (timer.current !== undefined) clearTimeout(timer.current);
    },
    [],
  );
  const copy = useCallback((text: string) => {
    if (copiedRef.current) return;
    copiedRef.current = true;
    copyText(text);
    setCopied(true);
    timer.current = setTimeout(() => {
      timer.current = undefined;
      copiedRef.current = false;
      setCopied(false);
    }, COPIED_MS);
  }, []);
  return { copied, copy };
}

/** 一条复制提示：每次闪烁换一个 `id`，同一位置连点也能重新播一次动画。 */
export interface CopyFlashValue {
  id: number;
  /** 触发点（视口坐标）；`null` = 没有可用落点，画在视口底部中间。 */
  anchor: { x: number; y: number } | null;
}

let flash: CopyFlashValue | null = null;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
let nextFlashId = 1;
const flashListeners = new Set<(value: CopyFlashValue | null) => void>();

/** 当前正在显示的复制提示；没有时为 `null`。 */
export function copyFlashValue(): CopyFlashValue | null {
  return flash;
}

/** 订阅复制提示的来去（与 `imagePreview.ts` / `contextMenu.ts` 同一套模块级订阅）。 */
export function subscribeCopyFlash(listener: (value: CopyFlashValue | null) => void): () => void {
  flashListeners.add(listener);
  return () => {
    flashListeners.delete(listener);
  };
}

/**
 * 没有按钮可换文案的复制入口（右键菜单「复制」、会话选区 Ctrl+C / Cmd+C）的反馈：
 * 在触发点附近闪**一枚对勾**，1s 后消失。
 *
 * `anchor` 缺省（拿不到选区矩形）时由提示层落到视口底部中间；连续触发只保留最新
 * 一条，不叠出两条提示。
 */
export function flashCopied(anchor?: { x: number; y: number } | null): void {
  // 先清掉上一条的计时器：连点两次时不能让旧计时器把新提示提前收掉
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  flash = {
    id: nextFlashId++,
    anchor: anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y) ? anchor : null,
  };
  for (const listener of flashListeners) listener(flash);
  flashTimer = setTimeout(() => {
    flashTimer = undefined;
    if (flash === null) return;
    flash = null;
    for (const listener of flashListeners) listener(null);
  }, COPIED_MS);
}
