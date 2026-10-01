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
 * 本文件现在有**两种外观**：文字版 `CopyButton` 与图标版 `IconCopyButton`，
 * 计时常量共用一份，理由同上。
 */
import { useState } from "react";
import { post } from "../bridge";
import { useTexts } from "../texts";
import { IconCheck, IconCopy } from "../icons";

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
 */
export function IconCopyButton({ text, title }: { text: string; title: string }) {
  const texts = useTexts();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`icon-btn${copied ? " is-copied" : ""}`}
      title={copied ? texts.copied : title}
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
