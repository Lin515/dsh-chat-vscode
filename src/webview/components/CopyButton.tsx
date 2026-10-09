/**
 * 复制按钮（工具卡与后台任务详情共用）。
 *
 * 点了把正文交给宿主写剪贴板（`post({type:"copy"})`，与代码块同一入口）。宿主侧
 * **不发**「已复制」toast（用户 2026-09-17 口径），按钮自己换 1s 文案作反馈。
 *
 * 从 `ToolCards.tsx` 里搬出来的理由与 `autoScroll.ts` 相同：第二个消费方出现了
 * （后台任务展开区也要复制），留在原处就得复制一份反馈计时——两处各写一遍的
 * 失败模式是「一个按钮 1s、另一个 2s」，谁也不会注意到。
 *
 * 本文件现在有**三种外观**：文字版 `CopyButton`、图标版 `IconCopyButton`、
 * 以及图标版开关 `WrapLinesButton`（轨迹的「自动换行」），计时常量共用一份，理由同上。
 */
import { useState } from "react";
import { post } from "../bridge";
import { useTexts } from "../texts";
import { IconCheck, IconCopy, IconWrapLines } from "../icons";

/** 复制按钮的短暂反馈时长（官方 1s）。 */
const COPIED_MS = 1000;

export function CopyButton({ text }: { text: string }) {
  const texts = useTexts();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="copy-btn"
      title={texts.copy}
      onClick={() => {
        if (copied) return;
        post({ type: "copy", text });
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      <IconCopy size={12} />
      <span>{copied ? texts.copied : texts.copy}</span>
    </button>
  );
}

/**
 * 图标版复制按钮：给**放不下文字标签**的紧凑位置用（历史会话行右侧那排操作）。
 *
 * 反馈与 `CopyButton` 同一套口径——1s 内图标换成对勾（`is-copied` 上色），共用
 * 上面那个 `COPIED_MS`，两处计时不会各漂各的。`title` 由调用方给：不同位置的
 * 「复制什么」不一样（会话行复制的是会话 ID，不是那段正文）。
 *
 * `copiedTitle` 覆盖成功态的悬停说明：默认那句是**整个界面通用**的「已复制到剪贴板」，
 * 换一条（例如官方轨迹那句更短的「复制成功」）只是文案覆盖，反馈计时与状态机不变。
 * 轨迹检查器现在仍用默认那句——同一句在全界面只维护一份。
 */
export function IconCopyButton({
  text,
  title,
  copiedTitle,
}: {
  text: string;
  title: string;
  copiedTitle?: string;
}) {
  const texts = useTexts();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`icon-btn${copied ? " is-copied" : ""}`}
      title={copied ? (copiedTitle ?? texts.copied) : title}
      onClick={() => {
        if (copied) return;
        post({ type: "copy", text });
        setCopied(true);
        window.setTimeout(() => setCopied(false), COPIED_MS);
      }}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/**
 * 「自动换行」开关（轨迹检查器里每段原文上方那颗）。
 *
 * 状态由**调用方持有**（每段各自采样一次全局默认、各自可拨），这里只管外观与语义：
 * 两态共用同一个 `title`，读的是**当前状态**而不是「点下去会怎样」——与官方那颗
 * `record.wrapLines` 同口径（官方两个态也是同一个无障碍名）。`aria-pressed` 才是
 * 给读屏的那半个信息。
 */
export function WrapLinesButton({
  wrapped,
  title,
  onClick,
}: {
  wrapped: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${wrapped ? " is-on" : ""}`}
      title={title}
      aria-pressed={wrapped}
      onClick={onClick}
    >
      <IconWrapLines size={13} />
    </button>
  );
}
