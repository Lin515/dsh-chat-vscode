/**
 * 正文渲染阶段。助手消息由 `message.streaming` 显式推导，缺省视为完成态；
 * 静态调用方（计划、工具详情、历史消息）不必传。
 *
 * 阶段 2 只把这个值透传到 `Markdown` / `CodeBlock`，不接代码高亮与公式排版；
 * 后续增强必须按它区分 stream 与 settled，不能靠围栏是否闭合推断。
 */
export type MarkdownPhase = "streaming" | "settled";
