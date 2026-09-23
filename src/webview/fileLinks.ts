/**
 * 正文里的**文件链接**：哪些文字点得开、点了打开哪个文件。
 *
 * 两条来源**逐字对齐官方**（本扩展是 `dsh web` 的自绘前端，能力与语义必须一致）：
 *
 * 1. **markdown 链接目标**（`[看这里](src/webview/App.tsx#L12)`）——官方
 *    `dsh-client-ui-primitives` 的 `parseFileLink`：目标解码后像**本地路径**就是文件，
 *    带 `#L12` / `#L12-L40` 这种 GitHub 锚点时连行号一起给；
 * 2. **行内代码 token**（`` `App.tsx` ``）——官方 `dsh-client-ui-deliverables` 的
 *    `producedFileMentions`：只有 token 能对上**本轮写过或申报交付的文件**时可点。
 *
 * 第二条刻意不做「看起来像路径就做成链接」的猜测：正文里的 `` `2/3` ``、`` `a/b` ``
 * 这类普通代码会被猜成一堆假链接，而真正的路径本来就来自本轮的工具调用——那正是
 * 词表里有的东西。对不上（或同名文件不止一个）就保持惰性。
 *
 * 纯函数、不碰 DOM 也不引 React：断言见 `scripts/fileLinks.test.ts`。DOM 那一步
 * （把命中的行内代码换成按钮）在 `webview/fileMentions.ts`。
 */

/** 一个本地文件链接的目标：路径 + 可选起始行（1 基）。 */
export interface FileLinkTarget {
  /** 原文解码后的路径；相对于会话工作目录时由宿主解析。 */
  path: string;
  /** 1 基起始行；缺省表示文件开头。 */
  line?: number;
}

/**
 * markdown 链接目标 → 本地文件与可选起始行。
 *
 * 文件名里真的带 `?` / `#` 时必须百分号编码，所以这两者在目标里出现就说明这条链接
 * 不是文件（`?` 是查询串、`#` 之后按行号锚点解析）。
 *
 * @param value markdown 解析出来的链接目标（未解码）。
 * @returns 本地路径与可选起始行；URL、页内锚点、查询串、坏编码、非法行号一律 undefined。
 */
export function parseFileLink(value: string): FileLinkTarget | undefined {
  const hash = value.indexOf("#");
  const destination = hash < 0 ? value : value.slice(0, hash);
  if (destination.includes("?")) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(destination);
  } catch {
    // 坏掉的百分号转义指不明一个文件（`%zz`），不猜
    return undefined;
  }
  if (
    path.length === 0 ||
    // 控制字符（含 NUL）不可能是路径的一部分；UNC/网络前缀（`\\host`、`//host`）
    // 打开的是**另一台机器**上的东西，不做
    /[\u0000-\u001f\u007f]/u.test(path) ||
    /^[\\/]{2}/u.test(path) ||
    // 带 scheme 的一律不是文件——但 Windows 盘符（`C:\` / `C:/`）要放行
    (/^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path))
  ) {
    return undefined;
  }
  if (hash < 0) return { path };
  const fragment = value.slice(hash + 1);
  const match = /^L([1-9]\d*)(?:-L([1-9]\d*))?$/u.exec(fragment);
  if (match === null) return undefined;
  const line = Number(match[1]);
  const end = match[2] === undefined ? line : Number(match[2]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(end) || end < line) return undefined;
  return { path, line };
}

/** 路径的最后一段（官方 `basename`：只按分隔符切，不做别的归一化）。 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at === -1 ? path : path.slice(at + 1);
}

/**
 * 行内代码 token 在本轮文件词表里指向哪个文件。
 *
 * 先按**原样路径**精确匹配（`a/style.css` 这种全路径写法即使重名也认得出），
 * 再按**唯一同名**匹配（正文里通常只写 `style.css`）；同名文件不止一个时**不猜**，
 * 保持惰性代码——猜错会打开另一个文件，这比点不开更糟。
 *
 * @param paths 本轮写过或申报交付的文件路径（保持原样拼写）。
 * @param token 行内代码的全文（必须是完整 token，前后没有别的字符）。
 * @returns 命中的完整路径；对不上或同名歧义时 undefined。
 */
export function matchFileMention(paths: readonly string[], token: string): string | undefined {
  if (!token) return undefined;
  if (paths.includes(token)) return token;
  const matches = paths.filter((path) => basename(path) === token);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * 外链目标：交给系统浏览器的那些 scheme（官方 `sanitizeUrl` 的三档）。
 *
 * 白名单而不是黑名单：模型输出不可信，多认一个 scheme 就等于多开一条宿主动作。
 *
 * @param value markdown 链接目标。
 * @returns 可打开的绝对地址；不是这三档时 undefined。
 */
export function externalLinkUrl(value: string): string | undefined {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:" ? value : undefined;
  } catch {
    // 相对地址（`./doc`）在这里就失败——那是文件链接那条路的事
    return undefined;
  }
}

/**
 * 正文里文件链接词表的载体：**渲染与点击共用一份**（一条交互链路一个端口对象）。
 *
 * `paths` 为空时行内代码保持惰性，但 markdown 链接照旧可点——后者自带完整路径，
 * 不需要词表。
 */
export interface FileLinkPort {
  /** 本轮写过或申报交付的文件（行内代码只有能对上它们时才可点）。 */
  readonly paths: readonly string[];
  /**
   * 这一轮是否已经结束。
   *
   * **流式期间本地文件链接保持惰性**（官方 `renderAnchor` 的 `streaming` 分支同口径）：
   * 正文每个 token 都在变，此刻那条路径既可能是写了一半的，点下去的目标也会随着
   * 下一帧被替换掉——「点了没反应」在这里是刻意的，不是坏掉。
   */
  readonly settled: boolean;
}

/**
 * 组装一份词表（去重，保持遇见顺序）。
 *
 * @param paths 本轮写过或申报交付的文件（可能有 undefined 空档）。
 * @param settled 这一轮是否已经结束。
 */
export function fileLinkPort(
  paths: readonly (string | undefined)[],
  settled: boolean,
): FileLinkPort {
  const unique: string[] = [];
  for (const path of paths) {
    if (path && !unique.includes(path)) unique.push(path);
  }
  return { paths: unique, settled };
}
