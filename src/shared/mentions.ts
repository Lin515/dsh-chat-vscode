/**
 * `@` 引用的**文本形态**（宿主与界面共用）。
 *
 * 为什么单独一个文件：`@path` 这个 token 有**两个**产生方——
 * 1. 宿主把引用芯片拼进正文（`dsh/references.ts` 的 `composeWithReferences`）；
 * 2. 界面在候选列表里选中文件时**直接把它插进输入框**（纯路径引用，见
 *    `src/webview/composerCompletion.tsx` 的 `outcomeFor` / `applyCandidate`）。
 *
 * 两处必须产出**一模一样**的拼写，否则同一次引用会随入口不同而变成两种 token
 * （带不带引号、目录带不带尾斜杠都会变），模型看到的语义也就跟着变。所以规则
 * 只写在这里一份。
 *
 * 规则以官方 `formatFileMention` 为底，**两处刻意偏离**（用户 2026-09-21 口径，
 * 原话：「引用进目录时，将 `\` 统一换成 `/`」「引进带空格目录时，只有头部有引号、
 * 尾部没有」）：
 * - 目录补结尾 `/`（`@src/`）——系统提示段用它区分文件与目录；
 * - **分隔符统一成 `/`**：Windows 侧的路径来源五花八门（`path.relative()` 给 `\`、
 *   服务端候选多半给 `/`），不归一就会写出 `@src\webview/` 这种混合形态。
 *   反斜杠在 Windows 上就是分隔符，改成正斜杠指向同一个文件（fs 两边都认），
 *   而 `@` 引用本身就是正斜杠语法（官方系统提示段的例子全是 `/`）。POSIX 上名字里
 *   含 `\` 的文件是极端个例，这次刻意不为它保留原样；
 * - 含空白的路径整体加**成对**引号（`@"my dir/"`）。官方对目录只写开引号
 *   （`@"dir/`，为了「未闭合还能继续打字」），但那个未闭合形态一旦被发出去就是
 *   半截 token，用户看到的就是「只有头部有引号」——而带空格的路径**本来就没法**
 *   用触发词继续下钻（查询按空白切段），所以那个理由在这里不成立；
 * - 含控制字符或 `"` 的路径**不可引用**（返回 undefined，调用方退回普通文本）。
 */

/**
 * 把路径里的分隔符统一成 `/`（`@` 引用只认正斜杠，见文件头）。
 *
 * 导出给**不经过 `formatFileMention` 的写入口**用：`@` 列表里的「下钻 / 回上一层」
 * 是直接改写正文里的查询串（`@src\webview/`），不走 token 生成那条路。
 */
export function normalizeMentionPath(path: string): string {
  return path.replaceAll("\\", "/");
}

/** 生成 `@` 引用的模型可见文本；不可引用时返回 undefined。 */
export function formatFileMention(path: string, kind: "file" | "directory" = "file"): string | undefined {
  // 先归一化分隔符，再谈尾斜杠：`src\dsh\` 归一后就是 `src/dsh/`，不必再补
  const normalized = normalizeMentionPath(path);
  const needsSlash = kind === "directory" && !normalized.endsWith("/");
  const full = needsSlash ? `${normalized}/` : normalized;
  // eslint-disable-next-line no-control-regex -- 官方逐字如此：控制字符会让 token 无法解析
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(full)) return undefined;
  if (!/\s/u.test(full)) return `@${full}`;
  // 引号**成对**：文件和目录一视同仁（见文件头的偏离说明）
  return `@"${full}"`;
}

/**
 * 带**行号区间**的引用：`@src/config.ts#L12-L40`（单行时 `#L12`）。
 *
 * 官方语法里**没有**行号（`dsh-file-reference` 的 `FILE_REFERENCE_PROMPT` 只说
 * 「`@` 开头的是用户显式引用的工作区路径；结尾斜杠是目录；其余是文件，需要内容
 * 用 read 工具读」）。这是本扩展为「编辑器选区」补的约定：用户口径是选区也要以
 * `@` 引用形式添加，而行号是这条引用**唯一**区别于「整文件引用」的信息
 * （不说清楚的话，模型只看到一个路径，用户想的是「这几行」）。
 *
 * 用 GitHub 的 `#L12-L40` 而不是编译器的 `:12-40`：`#` 开头的锚点**不可能是
 * 文件路径**，所以「模型把行号当成路径的一部分去 read」这条误读路径根本不存在
 * （`:12-40` 在 Windows 上还容易和盘符/流语法混淆）。GitHub 的锚点语法模型也见得多。
 *
 * 引号形式把行号写在引号**内**（`@"my file.txt#L12-L40"`），这样整段仍旧是一个 token。
 */
export function formatFileMentionWithLines(
  path: string,
  lines?: { start: number; end: number },
): string | undefined {
  const mention = formatFileMention(path, "file");
  if (mention === undefined || lines === undefined) return mention;
  const range = lines.start === lines.end ? `#L${lines.start}` : `#L${lines.start}-L${lines.end}`;
  if (!mention.startsWith('@"')) return `${mention}${range}`;
  return `${mention.slice(0, -1)}${range}"`;
}

/**
 * 把正文里的**对话引用 mention** 还原成可读的 `@标题`（只用于**显示**）。
 *
 * 用户在 `@` 列表里选中一个历史对话时，插进正文的是官方那条规范 token
 * （`@[标题](dsh-session:…)`，见 `SessionRefView.mention`）。它是**给服务端看的**：
 * 服务端在消息进入模型前把它换成被引用会话的快照，并顺手把正文里的 token 换成
 * 可读的 `@标题`（`dsh-session-reference` 的 `parseSessionReferenceText`）。
 *
 * 但**落盘的 durable 事件里仍是原始 token**（`prepareDirectMessages` 只产出给模型
 * 用的那一份副本），所以聊天转写直接渲染正文就会显示一长串
 * `@[标题](dsh-session:eyJ…)`。这里按官方同一个正则折成 `@标题`——
 * 只认严格形态，普通文本里的 `@[...]` 一个字节都不动。
 */
export function displaySessionMentions(text: string): string {
  return text.replace(
    /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu,
    (_match, rawLabel: string | undefined, markdownUri: string | undefined, bareUri: string | undefined) => {
      const uri = markdownUri ?? bareUri;
      if (uri === undefined) return _match;
      const label = rawLabel === undefined ? uri.slice("dsh-session:".length) : rawLabel.replace(/\\(.)/gu, "$1");
      return `@${label}`;
    },
  );
}
