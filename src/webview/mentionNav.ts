/**
 * `@` 候选列表里的**上一层目录**导航。
 *
 * 官方客户端的 `@` 补全没有「上一层」这一行（它的输入框是富文本，往回删一个
 * 路径段很自然）。本扩展的输入框是纯文本 textarea，用户下钻到 `@src/webview/`
 * 之后想回上一层只能手工删字符——用户 2026-09-14 要求列表顶部给一个 `..`。
 *
 * 这里只算**目标查询串**（回到哪一层），渲染与键盘行为在
 * `composerCompletion.tsx`（`rankCandidates` 把 `..` 排在最前，宿主下发的那一行见
 * `docs/design-mentions.md`「三种入口」的 M2）。纯函数、不引 React 也不碰文件系统：
 * 断言见 `scripts/mentionNav.test.ts`。
 *
 * 三种查询各有一条规则（`docs/design-mentions.md`「路径解析」）：
 *
 * - **工作区内 / 带筛选词**（`src/`、`src/webview/Com`）：取到最后一个分隔符为止的目录
 *   部分，再去掉它自己那一段；去掉后为空表示上一层就是**工作区根目录**，返回空串；
 * - **绝对形态**（`D:/dev/other/`、`//server/share/dev/`、`/home/u/`）：去掉最后一段；
 *   已经站在根上（盘根 / 共享根 / POSIX 根）时**回工作区空查询**——那是键盘上唯一一条
 *   「从盘根回工作区」的回路（刻意取舍，见设计文档）；
 * - **含 `..` 段的相对形态**（`../`、`../other/`、`foo/../`）：按**会话 cwd 的深度**做段
 *   算术，允许越出 cwd 往上走，退到根就停（不再增长），到根时同上回工作区空查询。
 *   `foo/../` 先归一到 cwd 本身，所以它的上一层是 cwd 的父目录而不是 `foo/`。
 *
 * `cwd` 是 `files/list` 帧下发的会话工作目录（`pathDisplay.displayPathParts` 认盘符、
 * UNC 与 POSIX 三种根）：**只有它知道 cwd 离根还有几层**。没有它（旧宿主 / 还没绑定
 * 会话）时不敢把纯 `..` 串一路加长，退回老口径（回工作区空查询）；仍在 cwd 内部的那几层
 * （`src/webview/`、`../other/`）不需要深度，照常算。
 *
 * 输出一律是正斜杠形态：`@` 引用本身就是正斜杠语法，写回正文那条路
 * （`drillQueryToken` / `shared/mentions.ts` 的 `normalizeMentionPath`）也会归一，
 * 所以这里不保留用户手输的反斜杠。
 */
import { isDirectoryQuery } from "../shared/mentions";
import { displayPathParts, resolveDisplaySegments } from "./pathDisplay";

/**
 * 当前 `@` 查询进入某个目录时，「上一层」应当填回的查询串。
 *
 * 返回值 `undefined` 表示**没有上一层**（查询还没进任何目录）；空串表示上一层是
 * **工作区根目录**（正文里表现为裸 `@`）。分隔符两种都认（服务端给的是 `/`，查询可能
 * 被用户手输成 `\`）。
 *
 * 「有没有进目录」这一条与候选列表的其它判据同源（`isDirectoryQuery`）：对话候选
 * 只在根目录列，而「`..` 行」只在进了目录时出现——两条不能各写一份正则。
 */
export function mentionParent(query: string, cwd?: string): string | undefined {
  const text = query ?? "";
  if (!isDirectoryQuery(text)) return undefined;
  const normalized = text.replaceAll("\\", "/");
  // 盘符裸写（`@D:`）：宿主按 `D:/` 列盘根（M1 补充口径），盘根没有上一层 → 回工作区
  if (/^[A-Za-z]:$/u.test(normalized)) return "";
  const cut = normalized.lastIndexOf("/");
  // 含尾部分隔符的当前目录（筛选词那一段留给服务器筛，不算目录的一部分）
  const directory = normalized.slice(0, cut + 1);
  // 直接拿**带尾分隔符的目录**拆根与段：`/`、`D:/`、`//server/share/` 这些根部形态
  // 自己就落在 `root` 上（空串是「还没进任何目录」的兜底，前面已被 isDirectoryQuery 挡住）
  const parts = displayPathParts(directory);

  if (parts.root !== "") {
    // 绝对形态：段栈按同一个根锚定语义归一（`D:/a/../b/` 的当前目录就是 `D:/b/`），
    // 再退掉最后一段；已经在根上就没有上一层，回工作区空查询。
    const segments = resolveDisplaySegments(parts.segments);
    if (segments.length === 0) return "";
    return directoryQuery(parts.root, segments.slice(0, -1));
  }

  const depth = cwdDepth(cwd);
  let up = 0;
  const down: string[] = [];
  for (const segment of parts.segments) {
    if (segment !== "..") {
      down.push(segment);
      continue;
    }
    if (down.length > 0) down.pop();
    else if (depth === undefined || up < depth) up += 1;
    // depth 已知且已到根：停在根（`path.resolve` 语义，查询串不再增长）
  }
  if (down.length > 0) {
    down.pop();
  } else if (depth === undefined) {
    // 没有 cwd 证据：算不出「再往上还有几层」，不把纯 `..` 串一路加长（老口径）
    return "";
  } else if (up < depth) {
    up += 1;
  } else {
    // 当前目录就是根：它的上一层不存在，回工作区空查询（键盘上唯一的回路）
    return "";
  }
  if (up === 0 && down.length === 0) return "";
  return `${"../".repeat(up)}${down.length > 0 ? `${down.join("/")}/` : ""}`;
}

/**
 * `cwd` 离它的根还有几层（`D:/dev/proj` 是 2、`D:/` 是 0、`//server/share` 是 0）。
 *
 * `undefined` 表示**算不出来**：没有 cwd，或它自己不是绝对形态（盘符 / UNC / POSIX 三种
 * 根都认，见 `pathDisplay.displayPathParts`）。cwd 里的 `..` 先按同一个根锚定语义消掉，
 * 否则「离根几层」会被它算错。
 */
function cwdDepth(cwd: string | undefined): number | undefined {
  const parts = displayPathParts(cwd ?? "");
  if (parts.root === "") return undefined;
  return resolveDisplaySegments(parts.segments).length;
}

/** 绝对形态的上一层：根 + 段 + 尾分隔符（目录行由界面补尾斜杠，这里给的是浏览查询串）。 */
function directoryQuery(root: string, segments: readonly string[]): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  const body = segments.join("/");
  return body === "" ? base : `${base}${body}/`;
}
