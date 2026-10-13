/**
 * 概述页里**一节的外壳**：标题行（标题 + 该节正文的动作条）+ 正文预览。
 *
 * ## 为什么动作条要挂到标题行上
 *
 * 一段原文的两个动作（复制 / 自动换行）原本排在正文正上方、**独立占一行**。概述页里
 * 于是成了「标题行 + 动作行」两行，而正文框上边距那一档（2dp + 24dp 按钮 + 2dp）比
 * 「正文框 → 下一节标题」的节间距（8dp）还大——正文看起来归下一节，读起来完全违背
 * 直觉（2026-10-13 用户口径）。官方那边是**标题与动作条同一行**（`OverviewSection` 的
 * `h3.overviewHeading` 里放标题按钮 + `programActions`，`margin-left: auto`），正文紧贴
 * 在下面。
 *
 * 这里照同一手法：标题行右侧留一个**插槽**，正文块里的动作条 `createPortal` 挂进来
 * （见 `TrajectoryPre`）。这样两件事同时成立：
 * - 标题永远是这一节的**第一行**，正文紧贴在它下面（节内 2dp < 节间 8dp）；
 * - 正文的形状不受影响——有的节标题下面**不是**紧跟引用块（Schema 那节先是工具名与
 *   描述、再是那段 JSON），动作条挂在标题行上，不依赖正文首元素是什么。
 *
 * 没有插槽时（页签视图、`<details>` 里的工具目录、对照节……凡是**没有标题行**的地方），
 * 动作条仍是正文上方独立一行：那些地方那一行就是正文自己的工具条，不存在上面那个
 * 「两行」的问题。
 */
import { createContext, useState } from "react";
import type { ReactNode } from "react";

/**
 * 这一节标题行里的动作条插槽（`null` = 这里没有标题行，动作条留在正文上方）。
 *
 * 由 `TrajectorySection` 提供、`TrajectoryPre` 消费：**唯一的写入者是它自己那条
 * portal**，读点只有一处，所以形状就一个 `HTMLElement`。
 */
export const TrajectoryActionsHostContext = createContext<HTMLElement | null>(null);

/**
 * 概述页的一节。
 *
 * @param heading 标题行里标题那部分（可点的那枚按钮 / 纯文本，由调用方按要不要跳页签给）。
 * @param children 该节的正文预览（`TrajectoryPre` 的动作条会 portal 进标题行）。
 */
export function TrajectorySection({ heading, children }: { heading: ReactNode; children: ReactNode }) {
  // 插槽元素要到挂载之后才存在，所以用 state 收：ref 回调在提交阶段跑，React 会在
  // 这一次提交里再渲染一遍（画到屏幕之前），界面上看不到「先独立一行、再跳上去」。
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null);
  return (
    <section className="trajectory-overview-section">
      <div className="trajectory-overview-heading">
        {heading}
        <span className="trajectory-overview-actions" ref={setSlot} />
      </div>
      <div className="trajectory-overview-preview">
        <TrajectoryActionsHostContext.Provider value={slot}>{children}</TrajectoryActionsHostContext.Provider>
      </div>
    </section>
  );
}
