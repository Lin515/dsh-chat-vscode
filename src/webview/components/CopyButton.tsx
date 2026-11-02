/**
 * 复制按钮的**唯一**外观，加上「没有按钮可换文案」那种复制入口的提示层
 * （`CopyFlashLayer`）与轨迹检查器的自动换行开关（`WrapLinesButton`）。
 *
 * 状态机、计时与剪贴板写入都在 `../copyFeedback.ts`：本文件只管**长什么样**。
 *
 * ## 只有一个图标，不带文字
 *
 * 用户 2026-11-02 口径：所有复制入口统一成**一枚图标按钮**，不显示「复制」文字标签；
 * 点一下成功态只把图标换成对勾（并上成功色），**不换文案、不弹提示**。于是
 * 「复制什么」由悬停说明（`title` / `aria-label`）交代，不再占用一行宽度——工具卡、
 * diff 头部、IN/OUT 标签行、问卷记录、后台任务、历史会话、代码块、消息操作行、
 * 轨迹原文全部复用这一个组件，不再有「文字版 / 图标版」两套外观要各自维护。
 *
 * 视觉上不出现文字，但成功与否仍要让读屏知道：按钮里带一段 `sr-only` 的
 * `aria-live` 文本，只在成功的那 1s 里有内容（`copyFeedback.ts` 的 `COPIED_MS`）。
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

/**
 * 复制按钮：给所有复制入口用。
 *
 * `title` 是「复制什么」的唯一说明（头像悬停与读屏都读它）：默认是整个界面通用的
 * 「复制」；同一张卡里出现两枚时要区分（IN / OUT 给「复制输入」「复制输出」），
 * 历史会话行给「复制会话 ID」，轨迹各段按内容给。
 *
 * `size` 默认 13：与相邻的节点图标同档；消息操作行那颗给 14。
 *
 * 两态共用同一个 `title` / `aria-label`：成功态是**按钮自己的图标**在变，文案不变，
 * 所以悬停说明不会在 1s 后自己跳回另一句。
 */
export function CopyButton({
  text,
  title,
  size = 13,
}: {
  text: string;
  title?: string;
  size?: number;
}) {
  const texts = useTexts();
  const { copied, copy } = useCopyFeedback();
  const label = title ?? texts.copy;
  return (
    <button
      type="button"
      className={`icon-btn${copied ? " is-copied" : ""}`}
      title={label}
      aria-label={label}
      onClick={() => copy(text)}
    >
      {copied ? <IconCheck size={size} /> : <IconCopy size={size} />}
      {/* 视觉上没有文字，读屏仍要听见「已复制」：live region 先存在、后填内容 */}
      <span className="sr-only" aria-live="polite">
        {copied ? texts.copied : ""}
      </span>
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
 * 复制提示层（App 根部挂一次）：没有按钮可换文案的复制入口用它——右键菜单「复制」、
 * 会话选区 Ctrl+C / Cmd+C。
 *
 * 与按钮同一套反馈语言：**只有一个对勾**，不带文字说明（文字只留给读屏）。外层
 * `role="status"` 的 live region 常驻，屏幕阅读器才会念出随后插入的内容；提示本身
 * 按闪烁身份重挂，于是同一位置连点两次也会重新播动画。整层 `pointer-events: none`：
 * 它盖在正文上，不能抢走选择、滚动或右键。
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
        <span key={flash.id} className={`copy-flash${flash.anchor ? "" : " is-centered"}`} style={flashStyle(flash)}>
          <IconCheck size={12} />
          <span className="sr-only">{texts.copied}</span>
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
