/**
 * 附件模型：与官方客户端对齐的两种表示。
 *
 * **改自 v0.4.x 的「内联正文」**：早期版本把文件内容读进 prompt（上限 512KB），
 * 官方从不这么做，代价是实打实的：
 * - token 成本高（一个源文件就吃掉几千 token，用户还以为只是「提了一下这个文件」）；
 * - 二进制读不到（只能给路径，等于白加）；
 * - `@path` 的语义消失——系统提示段告诉模型「这是用户显式引用的工作区路径，
 *   需要内容就用 read 工具读」，内联正文把这条约定抹掉了；
 * - 队列「取回重新编辑」退化（原文里混着几百行文件内容）。
 *
 * 官方两条路：
 * 1. **`@path` 引用**（`dsh-client-ui-reference`）：只把路径 token 发出去，
 *    目录以结尾 `/` 标记（`@dir/`）；
 * 2. **文件上传**（`dsh-client-file-upload`）：拖入/选中的文件逐字节上传，
 *    拿回 `receiptId`，随 prompt 作为 `{type:'file', receiptId}` 发出；模型看到的是
 *    「已上传的句柄 + 只读副本路径」。
 *
 * 本模块只放**纯逻辑**（路径 → mention 文本、分类），网络与文件 IO 在控制器。
 */

/** 一个待发送的 `@` 引用。 */
export interface Reference {
  /** 工作区相对（或绝对）路径，原样保留用户选中的拼写。 */
  path: string;
  kind: "file" | "directory";
}

/**
 * 生成 `@` 引用的**模型可见文本**（官方 `formatFileMention`）。
 *
 * 规则逐字对齐官方：
 * - 目录补结尾 `/`（`@src/`）——系统提示段用它区分文件与目录；
 * - 路径含空白时整体加引号（`@"my file.txt"`），否则不加；
 * - 含控制字符或 `"` 的路径**不可引用**（返回 undefined，调用方退回普通文本）。
 *
 * 目录带引号时官方只写**开引号**（`@"dir/`）：这是刻意的——那个形式在输入框里
 * 还是一个「未闭合」的引用，用户继续往下打字（drill）时语法仍然成立。
 */
export function formatFileMention(path: string, kind: "file" | "directory" = "file"): string | undefined {
  // 目录补结尾 `/`——系统提示段靠它区分「这是目录，要内容就 list」。
  // 已经带分隔符时不重复追加：官方那行是无条件 `` `${path}/` ``（调用方从不传带
  // 尾斜杠的路径），而我们的路径可能来自用户手输或工具回传，`@dir//` 虽然语义
  // 不变但很难看。归一化只影响这一个退化输入，正确输入一个字节都不变。
  const needsSlash = kind === "directory" && !/[/\\]$/u.test(path);
  const full = needsSlash ? `${path}/` : path;
  // eslint-disable-next-line no-control-regex -- 官方逐字如此：控制字符会让 token 无法解析
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(full)) return undefined;
  if (!/\s/u.test(full)) return `@${full}`;
  return kind === "directory" ? `@"${full}` : `@"${full}"`;
}

/**
 * 把一批引用拼进用户正文。
 *
 * 官方把引用**就地**拼在用户打字的位置（chip 的 offset 处），本扩展没有富文本
 * 编辑器，所以统一放在正文**之前**、每条一行——与官方「引用是这段话的上下文前提」
 * 的读法一致，且用户能一眼看到自己引了什么。
 *
 * 正文为空时只留引用（`@src/a.ts` 单独发出去是完全合法的提示词）。
 */
export function composeWithReferences(text: string, references: readonly Reference[]): string {
  const mentions = references
    .map((reference) => formatFileMention(reference.path, reference.kind))
    .filter((mention): mention is string => mention !== undefined);
  const body = text.trim();
  if (mentions.length === 0) return body;
  return [...mentions, body].filter((part) => part !== "").join("\n");
}
