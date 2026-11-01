import type { Root, RootContent } from "mdast";

/**
 * Windows 绝对路径的链接 / 图片目标修复（本地解析适配）。
 *
 * CommonMark 把链接目标里的「`\` + ASCII 标点」当转义，`D:\app\demo\.agent\a.log`
 * 里的 `\.` 到 mdast 的 `url` 时已经丢掉反斜杠。修复不在 tokenizer 层重写语法，
 * 而是**解析之后**按节点的源码位置回到原文取目标：只有目标本身呈 Windows 绝对
 * 路径形状（盘符或 UNC）且原文里真有反斜杠时，才把反斜杠编码成 `%5C` 交给下游的
 * `parseFileLink` / `localImagePath` 解码。
 *
 * 边界与旧实现一致：
 * - 只修行内链接与图片；参考式定义（`[x]: D:\a\.b`）不在此列；
 * - 非 Windows 形状的目标保持 CommonMark 原语义（`a\.b` 仍是转义）；
 * - 链接文字、裸路径文本与代码里的反斜杠不动；
 * - 已经带 `%5C` 的目标不会二次编码。
 */

const WINDOWS_DEST = /^(?:[a-z]:[\\/]|\\\\)/iu;

/** 对整棵树应用修复，原地修改并返回同一个根。 */
export function fixWindowsDestinations(root: Root, source: string): Root {
  visit(root, source);
  return root;
}

function visit(node: Root | RootContent, source: string): void {
  if (node.type === "link" || node.type === "image") {
    const destination = rawDestination(node, source);
    if (
      destination !== undefined
      && destination.includes("\\")
      && WINDOWS_DEST.test(destination)
    ) {
      node.url = destination.replace(/\\/g, "%5C");
    }
  }
  if ("children" in node) {
    for (const child of node.children) visit(child, source);
  }
}

/**
 * 从节点源码位置里取回**未处理**的目标串。
 *
 * 不从行首重扫整个 `[label]`：合法标签里可以出现未配对的 backtick（它是字面文字）
 * 或带 `]` 的行内 HTML 属性，按“找第一个未转义 `]`”扫会定位错闭合位置，
 * 进而丢掉目标里的 `\.` 这类转义。这里改用**可证明的尾部**：节点位置覆盖完整的
 * `[label](dest "title")`，所以从右往左找每一个 `](`，用目标 + 可选标题的文法
 * 尝试解析到节点末尾；能从该处一路吃到最后一个 `)` 的，就是真正的目标起点。
 * 目标里即使含有 `](`（配平的括号允许），从内部起点也吃不到末尾的那个 `)`。
 */
function rawDestination(
  node: Extract<RootContent, { type: "link" | "image" }>,
  source: string,
): string | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined || end <= start) return undefined;

  const raw = source.slice(start, end);
  const opening = node.type === "image" ? "![" : "[";
  if (!raw.startsWith(opening)) return undefined;

  for (let at = raw.length - 2; at >= 1; at -= 1) {
    if (raw[at] !== "]" || raw[at + 1] !== "(") continue;
    const destination = destinationTail(raw, at + 2);
    if (destination !== undefined) return destination;
  }
  return undefined;
}

/**
 * 从 `(` 之后解析目标与可选标题，只有恰好吃到最后一个 `)` 才算命中。
 *
 * 支持 CommonMark 的两种目标形态（尖括号 / 裸目标，裸目标允许配平括号与反斜杠
 * 转义）以及三种标题引号；不在这里解释标签或 HTML，那属于解析器的职责。
 */
function destinationTail(raw: string, from: number): string | undefined {
  let cursor = from;
  while (cursor < raw.length && isWhitespace(raw[cursor]!)) cursor += 1;

  let destination = "";
  if (raw[cursor] === "<") {
    cursor += 1;
    let closed = false;
    while (cursor < raw.length) {
      const char = raw[cursor]!;
      if (char === "\\" && cursor + 1 < raw.length) {
        destination += char + raw[cursor + 1]!;
        cursor += 2;
        continue;
      }
      if (char === ">") {
        cursor += 1;
        closed = true;
        break;
      }
      destination += char;
      cursor += 1;
    }
    if (!closed) return undefined;
  } else {
    let depth = 0;
    let closed = false;
    while (cursor < raw.length) {
      const char = raw[cursor]!;
      if (char === "\\" && cursor + 1 < raw.length) {
        destination += char + raw[cursor + 1]!;
        cursor += 2;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth -= 1;
      }
      if (depth === 0 && isWhitespace(char)) break;
      destination += char;
      cursor += 1;
    }
    if (!closed && depth > 0) return undefined;
  }

  while (cursor < raw.length && isWhitespace(raw[cursor]!)) cursor += 1;
  if (raw[cursor] === "\"" || raw[cursor] === "'" || raw[cursor] === "(") {
    const close = raw[cursor] === "(" ? ")" : raw[cursor]!;
    cursor += 1;
    let closedTitle = false;
    while (cursor < raw.length) {
      const char = raw[cursor]!;
      if (char === "\\" && cursor + 1 < raw.length) {
        cursor += 2;
        continue;
      }
      if (char === close) {
        cursor += 1;
        closedTitle = true;
        break;
      }
      cursor += 1;
    }
    if (!closedTitle) return undefined;
    while (cursor < raw.length && isWhitespace(raw[cursor]!)) cursor += 1;
  }
  // 只有最后一个字符才是节点的闭括号；中段出现 `)` 说明这不是目标起点。
  if (cursor !== raw.length - 1 || raw[cursor] !== ")") return undefined;
  return destination;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}
