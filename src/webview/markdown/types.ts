/**
 * 正文渲染阶段。助手消息由 `message.streaming` 显式推导，缺省视为完成态；
 * 静态调用方（计划、工具详情、历史消息）不必传。
 *
 * 阶段 3 起 `CodeBlock` 按它决定是否初始化完成态高亮：只有 settled 才创建引擎，
 * streaming / SSR 保持纯文本；不能靠围栏是否闭合推断。
 */
export type MarkdownPhase = "streaming" | "settled";
