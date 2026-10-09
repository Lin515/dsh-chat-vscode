/**
 * 子代理目录一行的**显示状态**（副文字 + 状态点色调）。
 *
 * 用户 2026-10-10 口径（三个维度：运行状态 / 用户是否已读 / 生命周期模式）：
 *
 * | 运行状态 | 已读 | 普通（可继续） | 一次性 |
 * |---|---|---|---|
 * | running | — | 生成中 + 运行色点 | 生成中 + 运行色点 |
 * | inactive | 未读 | 已完成 + 完成色点 | 已完成 + 完成色点 |
 * | inactive | 已读 | 可继续 + 完成色点 | 一次性 + **灰点** |
 *
 * 三条纪律：
 *
 * 1. **状态点恒画**：`activity` 缺失时也要画（一次性子代理从前整行没有点，用户分不出
 *    「生成中」与「已完成」）。官方的读法是「`status.running ?? summary.running` 为真才是
 *    running、否则 inactive」（`dsh-client-ui-subagent` 的 `CatalogDropdown`），所以这里
 *    与它同口径：**只有确证在跑才是「生成中」**，拿不到证据一律按静止渲染。
 * 2. **灰点只属于「已读的一次性」**：它表达的是「这条是只读记录、没有新内容等你」。
 *    把「状态未知」也画成灰的会让两件事在界面上分不开，所以未知走上面那条静止分支的
 *    模式名，而不是共用灰色。
 * 3. **只有运行中带呼吸动画**（`.dot-running`，见 `styles/app.css`）：其余两色都是
 *    静止的结论色；点还在呼吸与「还在跑」必须指的是同一件事。
 *
 * 文案不从组件里写死：返回的是 `messages.ts` 里的**键**，由调用方查词典（中英各一份）。
 * 纯函数、不引 React：断言见 `scripts/subagentRowState.test.ts`。
 */
import type { SubagentView } from "../shared/chat";

/** 副文字取词典里的哪一条（四个键都在 `messages.ts` 登记）。 */
export type SubagentRowTextKey =
  /** 生成中 */
  | "subagentRunning"
  /** 已完成（服务端收尾了、用户还没看过这一份结果） */
  | "subagentCompleted"
  /** 可继续（看过了，这条会话还能接着说话） */
  | "subagentContinuable"
  /** 一次性（看过了，这条是只读记录） */
  | "subagentOneShot";

/** 状态点的色调类名（配 `.dot` 用）：只有 `dot-running` 带呼吸动画。 */
export type SubagentRowTone = "dot-running" | "dot-ok" | "dot-muted";

export interface SubagentRowFace {
  key: SubagentRowTextKey;
  tone: SubagentRowTone;
}

/**
 * 一行子代理的显示状态。
 *
 * @param entry 目录行（`activity` / `unread` 由宿主按账本填，见 `dsh/controller.ts` 的
 *   `decorateSubagent`；两个字段缺失都按「不知道」处理，落到静止分支）。
 */
export function subagentRowFace(entry: SubagentView): SubagentRowFace {
  if (entry.activity === "running") return { key: "subagentRunning", tone: "dot-running" };
  // 「结果还没被看过」优先于模式名：用户要的是「有新东西」这件事先说出口
  if (entry.unread === true) return { key: "subagentCompleted", tone: "dot-ok" };
  return entry.mode === "one-shot"
    ? { key: "subagentOneShot", tone: "dot-muted" }
    : { key: "subagentContinuable", tone: "dot-ok" };
}
