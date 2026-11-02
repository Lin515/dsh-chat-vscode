/**
 * 复制按钮的外观（文字版 `CopyButton`、图标版 `IconCopyButton`、自动换行开关
 * `WrapLinesButton`）与「没有按钮可换文案」那种复制入口的提示层 `CopyFlashLayer`。
 *
 * 状态机、计时与剪贴板写入都在 `../copyFeedback.ts`：本文件只管**长什么样**。
 * 这样所有复制按钮的反馈时长、重复点击语义与成功态文案只维护一份，新增一处复制
 * 按钮不会得到「这里 1s、那里 2s」的差异。
 *
 * 宿主侧**不发**「已复制」通知（用户 2026-09-17 口径）：按钮自己换外观作反馈，
 * 菜单条目与快捷键由 `CopyFlashLayer` 在触发点闪一条提示。
 */
import { useEffect, useState, type CSSProperties } from "react";
import {
  copyFlashValue,
  subscribeCopyFlash,
  useCopyFeedback,
  type CopyFlashValue,
} from "../copyFeedback";
import { useTexts } from "../texts";
import { IconCheck, IconCopy, IconWrapLines } from "../icons";

/** 文字版：给放得下一行文字的位置用（工具卡横幅、后台任务详情），成功态换文案 + 对勾。 */
export function CopyButton({ text }: { text: string }) {
  const texts = useTexts();
  const { copied, copy } = useCopyFeedback();
  return (
    <button
      type="button"
      className={`copy-btn${copied ? " is-copied" : ""}`}
      title={copied ? texts.copied : texts.copy}
      onClick={() => copy(text)}
    >
      {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      <span>{copied ? texts.copied : texts.copy}</span>
    </button>
  );
}

/**
 * 图标版复制按钮：给**放不下文字标签**的紧凑位置用（历史会话行右侧那排操作、
 * 消息操作行、代码块头部、轨迹检查器每段原文）。
 *
 * 反馈与 `CopyButton` 同一套口径：1s 内图标换成对勾（`is-copied` 上色）。`title`
 * 由调用方给：不同位置的「复制什么」不一样（会话行复制的是会话 ID，不是那段正文）。
 *
 * `copiedTitle` 覆盖成功态的悬停说明：默认那句是**整个界面通用**的「已复制到剪贴板」，
 * 换一条（例如官方轨迹那句更短的「复制成功」）只是文案覆盖，反馈计时与状态机不变。
 * `size` 默认 13：消息操作行那颗与分支图标同尺寸（14），调用方显式给。
 */
export function IconCopyButton({
  text,
  title,
  copiedTitle,
  size = 13,
}: {
  text: string;
  title: string;
  copiedTitle?: string;
  size?: number;
}) {
  const texts = useTexts();
  const { copied, copy } = useCopyFeedback();
  const label = copied ? (copiedTitle ?? texts.copied) : title;
  return (
    <button
      type="button"
      className={`icon-btn${copied ? " is-copied" : ""}`}
      title={label}
      aria-label={label}
      onClick={() => copy(text)}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
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

/**
 * 复制提示层（App 根部挂一次）：没有按钮可换文案的复制入口用它。
 *
 * 外层常驻（`role="status"` 的 live region 要先在 DOM 里，屏幕阅读器才会念出随后
 * 插入的内容）；提示本身按闪烁身份重挂，于是同一位置连点两次也会重新播动画。
 * 整层 `pointer-events: none`：它盖在正文上，不能抢走选择、滚动或右键。
 */
export function CopyFlashLayer() {
  const texts = useTexts();
  const [flash, setFlash] = useState<CopyFlashValue | null>(copyFlashValue);
  useEffect(() => {
    setFlash(copyFlashValue());
    return subscribeCopyFlash(setFlash);
  }, []);
  return (
    <div className="copy-flash-layer" role="status" aria-live="polite">
      {flash ? (
        <span
          key={flash.id}
          className={`copy-flash${flash.anchor ? "" : " is-centered"}`}
          style={flashStyle(flash)}
        >
          <IconCheck size={12} />
          {texts.copied}
        </span>
      ) : null}
    </div>
  );
}

/**
 * 提示的落点：贴着触发点右下（靠右下边缘时翻到左 / 上），都不压住鼠标刚点过的地方。
 *
 * 触发点先夹进视口：会话选区可以滚到可视区之外（选完再滚、或键盘复制时选区在
 * 上翻的一段里），不夹的话提示会画在视口外面，等于没有反馈。
 *
 * 只给**触发点那一侧**写偏移，并按那一侧的剩余空间给 `max-width`：提示宽度随语言
 * 变化，写死宽度会在英文或窄侧栏下溢出视口。拿不到视口尺寸（无头渲染）时不写行内
 * 定位，交给样式里的居中档。
 */
function flashStyle(flash: CopyFlashValue): CSSProperties {
  if (!flash.anchor) return {};
  const width = typeof window === "undefined" ? 0 : window.innerWidth;
  const height = typeof window === "undefined" ? 0 : window.innerHeight;
  if (!width || !height) return {};
  const gap = 12;
  // 夹到视口内：落点可能是滚动到可视区之外的选区
  const x = Math.max(gap, Math.min(flash.anchor.x, width - gap));
  const y = Math.max(gap, Math.min(flash.anchor.y, height - gap));
  const nearRight = x > width / 2;
  return {
    ...(nearRight ? { right: width - x + gap } : { left: x + gap }),
    ...(y > height - gap * 5 ? { bottom: height - y + gap } : { top: y + gap }),
    // 那一侧剩下的横向空间：把提示夹在视口里，窄侧栏的英文标签最多省略，不越界
    maxWidth: Math.max(nearRight ? x - gap * 2 : width - x - gap * 2, 80),
  };
}
