/**
 * 问卷填写草稿：**只活在 webview 内存里**，用于会话切换后恢复半填状态。
 *
 * 为什么不做持久化：DSH 重启后待答问卷本来就要重新发起（等待中的事件随进程消失），
 * 把半份答案写到磁盘上只会留下一份永远对不上的草稿；webview 重载同样按「重新发起」
 * 处理。因此这里的表不接 `bridge` 的状态持久化，也不进宿主的 drafts 账本。
 *
 * 键 = **会话 id + 问卷 requestId**：同一张问卷在切走再切回时是同一把键；不同会话里
 * 恰好同名的问卷也不会串答案。某一会话的草稿在切走之后继续留着，直到它被下次写入的
 * 新条目按上限淘汰，或问卷收场时明确清掉。
 */

/** 一份问卷半填写状态。字段与 `QuestionCard` 的本地 state 一一对应。 */
export interface QuestionDraft {
  /** 选项答案：题目 id → 选中的 label 列表。 */
  selected: Record<string, string[]>;
  /** 自定义回答的输入框内容：题目 id → 文字（选中别的选项时也保留）。 */
  custom: Record<string, string>;
  /** 自定义回答这一行有没有被选中：题目 id → 是否。 */
  customChosen: Record<string, boolean>;
  /** 依次问答当前停在第几题（0 起）；一次展开时恒为 0。 */
  index: number;
}

/**
 * 最多留几份草稿（按写入先后淘汰最旧的）。
 *
 * 草稿只在「有一份待答问卷」时产生，正常使用远到不了这个数；设上限是为了防止长时间
 * 开着界面、反复切会话时表无限增长（每份还带着用户可能输入的大段自定义文本）。
 */
export const MAX_QUESTION_DRAFTS = 32;

const drafts = new Map<string, QuestionDraft>();

/** 一张问卷的草稿键。用 JSON 组键，会话 id 里含分隔符也不会与别的键撞上。 */
export function questionDraftKey(sessionId: string | undefined, requestId: string): string {
  return JSON.stringify([sessionId ?? null, requestId]);
}

/** 读一份草稿；没有（或已被淘汰）时返回 `undefined`。 */
export function readQuestionDraft(key: string): QuestionDraft | undefined {
  return drafts.get(key);
}

/** 写入 / 覆盖一份草稿，并淘汰超出上限的最旧条目。 */
export function writeQuestionDraft(key: string, draft: QuestionDraft): void {
  // 先删再放：Map 的迭代顺序就是写入顺序，重写要把这份挪到「最新」
  drafts.delete(key);
  drafts.set(key, draft);
  while (drafts.size > MAX_QUESTION_DRAFTS) {
    const oldest = drafts.keys().next();
    if (oldest.done) break;
    drafts.delete(oldest.value);
  }
}

/** 丢掉一份草稿（问卷已经作答 / 撤回，半填状态不再有意义）。 */
export function clearQuestionDraft(key: string): void {
  drafts.delete(key);
}

/** 清空整张表。只给离线断言用：每个测试脚本共用同一个模块实例。 */
export function clearAllQuestionDrafts(): void {
  drafts.clear();
}
