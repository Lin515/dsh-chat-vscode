/**
 * `@` 候选列表里的**上一层目录**导航。
 *
 * 官方客户端的 `@` 补全没有「上一层」这一行（它的输入框是富文本，往回删一个
 * 路径段很自然）。本扩展的输入框是纯文本 textarea，用户下钻到 `@src/webview/`
 * 之后想回上一层只能手工删字符——用户 2026-09-14 要求列表顶部给一个 `..`。
 *
 * 这里只算**目标查询串**（回到哪一层），渲染与键盘行为在 `Composer.tsx`。
 *
 * 纯函数、不引 React：断言见 `scripts/mentionNav.test.ts`。
 */

/**
 * 当前 `@` 查询进入某个目录时，「上一层」应当填回的查询串。
 *
 * 规则按「用户此刻在看哪一层」定：
 * - 查询里**没有分隔符** → 正在工作区根目录列候选，没有上一层 → `undefined`；
 * - 有分隔符 → 取到最后一个分隔符为止的目录部分，再去掉它自己那一段；
 *   去掉后为空表示上一层就是**工作区根目录**，返回空串（正文里表现为裸 `@`）。
 *
 * 例：`src/` → `""`（根）；`src/webview/` → `"src/"`；`src/webview/Com` → `"src/"`。
 * 分隔符两种都认（服务端给的是 `/`，但查询可能被用户手输成 `\`）。
 */
export function mentionParent(query: string): string | undefined {
  const text = query ?? "";
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  const directory = text.slice(0, cut + 1); // 含尾部分隔符的当前目录
  const inner = directory.replace(/[/\\]+$/u, "");
  const up = Math.max(inner.lastIndexOf("/"), inner.lastIndexOf("\\"));
  return up < 0 ? "" : inner.slice(0, up + 1);
}
