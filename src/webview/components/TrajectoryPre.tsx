/**
 * 轨迹检查器里「一段原文」的统一呈现件：正文 + 正上方那对按钮（复制 / 自动换行）。
 *
 * 为什么收口成一个组件：这类裸 `<pre>` 在 `Trajectory.tsx` 里有十几处（参数 / 结果 /
 * 原始输出 / 来源 / 系统提示词与其对照 / 工具 Schema / 思考 / 请求选项），从前每处
 * 都是同一行 `<pre className="trajectory-pre">{...}</pre>`。一个按钮一个开关散在十几处
 * 只会得到「这里能复制、那里不能」这种没人注意得到的差异；收口后**加一处新原文
 * 就自动带上这两个动作**。
 *
 * 两条口径对着官方核过（`ui-trajectory` 的 `ProgramInput` / `InspectorCopyButton`
 * 与 `ui-primitives` 的 `JsonTree`）：
 * 1. **默认不换行**：官方 JSON 树打底 `white-space: pre`，只有 `[data-wrap='true']`
 *    才切 `pre-wrap` + `break-all`。参数与 Schema 的缩进结构要靠横向滚动看清，
 *    常开换行会把结构打散（`.trajectory-pre` 自己带 `overflow: auto`，横向滚动是
 *    它本来就有的行为）。
 * 2. **开关的记忆是「渲染时采样的全局默认」**：每段各自拿一份初值、各自可拨，
 *    拨动会把新值写成全局默认（`trajectoryPre.ts`）——与官方每个 `ProgramInput`
 *    各自 `useState(initialWrapped)` + `setDefault(next)` 同一套语义。
 *
 * 文案分两处取（所以签名里两个 title 是调用方给的、复制成功那句不是）：轨迹那本词典
 * 管「复制」「自动换行」，而「已复制到剪贴板」是整个界面共用的一条
 * （`texts.ts` 的 `Texts`，宿主标记与代码块按钮都在用），不复刻第二份。
 *
 * 动作条占正文**上方**一行（不是浮在正文角上）：浮层的代价是盖住首行，见下面渲染处的注释。
 */
import { useState } from "react";
import { IconCopyButton, WrapLinesButton } from "./CopyButton";
import { useTexts } from "../texts";
import { readWrapPreference, toggleWrap, writeWrapPreference } from "../trajectoryPre";

export function TrajectoryPre({
  text,
  copyTitle,
  wrapTitle,
}: {
  text: string;
  /** 复制按钮的悬停说明（官方按内容分 `code.copySource` / `code.copyOutput` / `copy.json`）。 */
  copyTitle: string;
  /** 自动换行开关的悬停说明（官方 `record.wrapLines`，全页同一句）。 */
  wrapTitle: string;
}) {
  const texts = useTexts();
  // 惰性初值：全局默认只在**这段渲染时**采样一次（官方 `useState(initialWrapped)` 同口径）
  const [wrapped, setWrapped] = useState(readWrapPreference);
  return (
    <div className="trajectory-pre-block">
      {/* 动作条在正文**之上、不浮动**：官方就是这么做参数 / 结果那一格的
          （`programPanel > header.overviewHeading + .programContent`）。早先试过把
          按钮绝对定位浮在正文右上角（官方 JSON 树里字符串那枚就是浮的），实测在
          「不换行 + 首行很长」这种最常见的形态下，两颗 24px 按钮正好压在首行文字上
          ——**改布局而不是给按钮加底色**：底下就是正文，盖住哪一段都算丢内容。 */}
      <div className="trajectory-pre-actions">
        <WrapLinesButton
          wrapped={wrapped}
          title={wrapTitle}
          onClick={() => {
            const next = toggleWrap(wrapped);
            setWrapped(next);
            writeWrapPreference(next);
          }}
        />
        <IconCopyButton text={text} title={copyTitle} copiedTitle={texts.copied} />
      </div>
      {/* `data-wrap` 就是开关本身：样式表按它切 `pre` / `pre-wrap`（与官方 JsonTree 同一手法） */}
      <pre className="trajectory-pre" data-wrap={wrapped}>
        {text}
      </pre>
    </div>
  );
}
