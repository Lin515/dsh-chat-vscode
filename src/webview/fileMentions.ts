import { matchFileMention, type FileLinkPort } from "./fileLinks";

/**
 * 正文里**行内代码文件链接**的那一步 DOM 变换（webview 侧）。
 *
 * 命中本轮文件词表的 `` `App.tsx` `` 会被换成
 * `<code><button class="file-mention" title="…">App.tsx</button></code>`——
 * 结构与官方渲染链一致（官方 `MarkdownFileLink` 也是 `code > button.fileMention`）。
 *
 * 为什么在 DOM 上做而不是让 markdown 渲染器直接吐按钮：渲染链（`markdown.ts`）只
 * 拿到正文与净化配置，词表是**界面这层**才知道的东西（本轮写过哪些文件）；而且
 * 按钮是**真的**内层控件——它自带键盘可达与语义，不必为此放宽 DOMPurify 的白名单
 * （`role` / `tabindex` 一旦放行，模型自己写的 `<span tabindex>` 也会活下来）。
 * 这与本地图片走 `hydrateLocalImages` 是同一条路子：注入的 HTML 不在任何组件的
 * props 树里，只能在**渲染之后**把交互接回去。
 *
 * 判定发生在这一步一次，点击处理器直接绑在按钮上——不在点击时重新解析，
 * 「能点」与「点了开哪个」因此不会漂移。
 */

/** 行内代码块里可点链接的类名（样式见 `app.css` 的 `.md code > .file-mention`）。 */
const MENTION_CLASS = "file-mention";

/**
 * 把正文里命中文件词表的行内代码换成可点按钮。
 *
 * @param root 已渲染的容器（`dangerouslySetInnerHTML` 的那个 div）。
 * @param port 本轮文件词表；`undefined` 或没结束（流式）时不做任何事。
 * @param open 打开文件的动作（界面侧只负责发帧，路径解析在宿主）。
 * @returns 清理函数：还原被换掉的节点，让下一次 hydrate 能重新判定
 *   （词表可能**晚于**正文到达——轮次结束时正文不变、`produced` 才到齐，
 *   React 不会重设 `innerHTML`，不还原就永远补不上按钮）。
 */
export function hydrateFileMentions(
  root: HTMLElement,
  port: FileLinkPort | undefined,
  open: (path: string) => void,
): () => void {
  if (!port || !port.settled || port.paths.length === 0) return () => {};
  const restore: (() => void)[] = [];

  for (const code of root.querySelectorAll("code")) {
    // 代码块（缩进写法仍在正文里）不是行内代码
    if (code.closest("pre")) continue;
    // 官方口径：锚点里的 token 保持惰性（按钮不能嵌在链接里）
    if (code.closest("a")) continue;
    if (code.childElementCount > 0) continue;
    const token = code.textContent ?? "";
    const path = matchFileMention(port.paths, token);
    if (path === undefined) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = MENTION_CLASS;
    // 悬停看到**打开的是哪个文件**：正文里可能只写了 `App.tsx`，
    // 而词表把它对到了某个完整路径上
    button.title = path;
    button.textContent = token;
    const onClick = (event: MouseEvent): void => {
      // 别让正文容器上的委托也处理这一下（它管的是锚点与图片）
      event.stopPropagation();
      event.preventDefault();
      open(path);
    };
    button.addEventListener("click", onClick);
    code.replaceChildren(button);

    restore.push(() => {
      button.removeEventListener("click", onClick);
      code.replaceChildren(token);
    });
  }

  return () => {
    for (const undo of restore) undo();
  };
}
