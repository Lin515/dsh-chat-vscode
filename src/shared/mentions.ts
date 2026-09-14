/**
 * `@` 引用的**文本形态**（宿主与界面共用）。
 *
 * 为什么单独一个文件：`@path` 这个 token 有**两个**产生方——
 * 1. 宿主把引用芯片拼进正文（`dsh/references.ts` 的 `composeWithReferences`）；
 * 2. 界面在候选列表里选中文件时**直接把它插进输入框**（纯路径引用，见
 *    `Composer.tsx` 的 `applyCandidate`）。
 *
 * 两处必须产出**一模一样**的拼写，否则同一次引用会随入口不同而变成两种 token
 * （带不带引号、目录带不带尾斜杠都会变），模型看到的语义也就跟着变。所以规则
 * 只写在这里一份。
 *
 * 规则逐字对齐官方 `formatFileMention`：
 * - 目录补结尾 `/`（`@src/`）——系统提示段用它区分文件与目录；
 * - 路径含空白时整体加引号（`@"my file.txt"`），否则不加；
 * - 含控制字符或 `"` 的路径**不可引用**（返回 undefined，调用方退回普通文本）；
 * - 目录带引号时只写**开引号**（`@"dir/`）：那个形式在输入框里还是一个「未闭合」
 *   的引用，用户继续往下打字（drill）时语法仍然成立。
 */

/** 生成 `@` 引用的模型可见文本；不可引用时返回 undefined。 */
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
 * 带**行号区间**的引用：`@src/config.ts:12-40`（单行时只写一个行号）。
 *
 * 官方语法里**没有**行号（`dsh-file-reference` 的 `FILE_REFERENCE_PROMPT` 只说
 * 「`@` 开头的是用户显式引用的工作区路径；结尾斜杠是目录；其余是文件，需要内容
 * 用 read 工具读」）。这是本扩展为「编辑器选区」补的约定：用户口径是选区也要以
 * `@` 引用形式添加，而行号是这条引用**唯一**区别于「整文件引用」的信息
 * （不说清楚的话，模型只看到一个路径，用户想的是「这几行」）。
 *
 * `path:line` 是编译器/搜索工具通用的写法，模型读得懂；引号形式把行号写在引号
 * **内**（`@"my file.txt:12-40"`），这样整段仍旧是一个 token。
 */
export function formatFileMentionWithLines(
  path: string,
  lines?: { start: number; end: number },
): string | undefined {
  const mention = formatFileMention(path, "file");
  if (mention === undefined || lines === undefined) return mention;
  const range = lines.start === lines.end ? `${lines.start}` : `${lines.start}-${lines.end}`;
  if (!mention.startsWith('@"')) return `${mention}:${range}`;
  return `${mention.slice(0, -1)}:${range}"`;
}
