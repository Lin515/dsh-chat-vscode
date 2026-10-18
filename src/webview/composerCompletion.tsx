/**
 * 输入框里 `@` / `/` 补全的**唯一**归属地：触发词判定、候选取用与优先级、
 * 父目录查询、`pick` / `drill` 的差别、光标落点、「刚选完先别重开」的记忆、
 * 弹层键盘导航与随高亮滚动、以及弹层的 JSX 本身。
 *
 * 为什么收成一个 module：这套规则此前散在 `Composer.tsx` 的 9 段不相邻代码里
 * （跨 4 个 ref + 3 个 state + 2 个 helper），任何一处改动都要靠人记住另外八处。
 * 收进来之后 `Composer` 只剩布局 / 工具行 / 文本域，**不再知道弹层内部规则**；
 * 而规则本身拆成了可离线断言的纯函数（`findTrigger` / `rankCandidates` /
 * `tokenSpan` / `caretAfterInsert` / `candidateRows` / `actionFor` / `popoverVisible`），
 * 断言见 `scripts/mentionNav.test.ts`（行为）与 `scripts/pathInsert.test.ts`（光标算术）。
 *
 * 行为与搬家前**逐字一致**——每一条都对应一条断言（`@` 入口的口径除外，它在
 * 2026-10-10 与 2026-10-11 两轮里改过：现在是「光标落在哪个 `@` 块里就以整块为查询串，
 * 块里有内容就触发，但宿主说这块**已经能引用到内容**时整块不弹」，见 `findTrigger` 与
 * `resolvedSuppressed`）：
 * 1. 草稿的两次写（`onDraft` 本地 state + `post({type:"setDraft"})` 宿主持久化）顺序与内容不变；
 * 2. 落光标仍在 `requestAnimationFrame` 里（否则 caret 会被 React 的重渲染顶掉）；
 * 3. `pick`（引用 token / 命令名）与 `drill`（进目录）的差别；
 * 4. 选完先 `dismissed` 一次，避免弹层立刻重开（这份「已关闭」记忆只对**同一次**编辑
 *    动作有效：焦点重新进入输入框时清掉，见 `onFocus`）；
 * 5. ESC：弹层打开时由**元素层**（本次输入）消费——关掉弹层，且不让这次按键落到
 *    归属链的「停止生成」兜底上（见 `./escapeOwner.ts`）；
 * 6. `/` 只有在**行首或空白后**且名字在命令目录里才走命令通道；`@` 走自己的内容块判定
 *    （见 `findTrigger`），两条通道的边界规则相同、判据不同；
 * 7. 指针悬停改高亮**只认 `mousemove`**：列表为露出键盘选中的那行而滚动时，浏览器会把
 *    `mouseenter` 补发给「刚滚到静止指针底下」的行，等于凭空抢走键盘的高亮（官方
 *    `MenuView` 同一判词，现场与断言见行上的注释与 `scripts/mentionNav.test.ts` 的
 *    「悬停改高亮只认真实指针移动」一节）；
 * 8. 弹层**这一帧画不出来**时键盘不归补全（`popoverOpen`）：Enter 是发送、↑↓ 挪光标、
 *    ESC 交给归属链。此前键盘只读「有触发词 + 候选非空」，而 `..` 是无条件挂在最前的，
 *    于是抑制门按住时回车会选中一个看不见的行（用户 2026-10-18 报的现场，断言见
 *    `scripts/mentionNav.test.ts` 的「键盘只在弹层画出来时接管」一节）；
 * 9. 查询串变了、而这一次的帧还在路上时，**画过的那一份候选原地留屏**（`paintedBox`），
 *    列表整个刷新过程只换一次内容。官方 `ui-input-trigger` 的 `menuReduce` 正是这个口径：
 *    `hit` 只把各源置成 pending、items 与高亮原地不动，settle 时才整份换掉；pending 期间
 *    pick、Enter 与 Tab 都被 `arbitrate` / `pick` 里的 `status !== 'ready'` 挡住，界面这
 *    一侧同理把留屏期间的键位与指针动作一并冻结（见 `stale`）。用户 2026-10-18 报的现场是
 *    「刷新时列表先消失再展开」：弹层在 `.composer` 的常规流里，撤掉它输入区就矮一截、
 *    会话区跟着弹一下。
 */
import {
  Fragment,
  useCallback,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  type TextareaHTMLAttributes,
} from "react";
import type { CommandView, FileRefView, SessionRefView } from "../shared/chat";
import { formatFileMention, isBrowseQuery, isDirectoryQuery, normalizeMentionPath } from "../shared/mentions";
import { post } from "./bridge";
import { ComposerSessionDraft, type DraftEditRange } from "./composerSessionDraft";
import { consumeEscape } from "./escapeOwner";
import { IconFolder } from "./icons";
import { mentionParent } from "./mentionNav";
import { resolveDisplayPath } from "./pathDisplay";
import { formatClock } from "./components/primitives";
import type { Texts } from "./texts";

/* ============================ 纯逻辑（可离线断言） ============================ */

/** 输入框里正在编辑的触发词（`/` 命令或 `@` 文件/对话提及）。 */
export interface Trigger {
  kind: "command" | "mention";
  /** 触发词在文本里的起始下标。 */
  start: number;
  query: string;
  /** 折叠会话块的完整可编辑区间，允许标题含空白。 */
  end?: number;
  sessionOnly?: boolean;
}

/**
 * `@` 候选的一条：命令、文件 / 目录、或对话引用。
 *
 * 三者在同一个扁平数组里（键盘上下要在**整张列表**里走，不能分组各走各的），
 * 渲染时按形状分派（见 `isSessionCandidate`）。
 */
export type MentionCandidate = CommandView | FileRefView | SessionRefView;

/** 候选列表里的动作：`pick` = 把这一条插进正文，`drill` = 进目录浏览。 */
export type CandidateAction = "pick" | "drill";

/**
 * 上一次**画在屏上**的那一份候选，与它属于哪一次查询（见 `useCompletion` 的 `paintedBox`）。
 *
 * 存在的理由只有一个：`@` 每改一个字都要重发一次查询，而那一帧回来之前界面不能把列表
 * 撤掉——弹层在 `.composer` 的常规流里（`app.css` 的 `.trigger-popover`），撤掉它输入区
 * 就矮一截、会话区跟着弹一下（用户 2026-10-18 报的现场）。留屏期间屏上那一份是**旧查询**
 * 的结果，所以键位与指针动作也一并冻结（见 `stale`）。
 */
interface PaintedCandidates {
  sessionId?: string;
  /** 触发通道：`/` 与 `@` 的列表不互相顶替。 */
  kind: "command" | "mention";
  /** 触发词在正文里的起点：只有**同一个** `@` 块才谈得上「原地留屏」。 */
  start: number;
  /** 这一份属于哪一次查询（高亮只在它变的时候回到第一条，见 `shownKey`）。 */
  key: string;
  candidates: MentionCandidate[];
}

/**
 * 找出光标前正在输入的触发词。
 *
 * `/` 与 `@` **不是同一条规则**：
 * - `/`：以「行首或空白」为边界（只认行首的话，用户在已有文字后打空格再输 `/` 就弹不出
 *   菜单，很常见）；而路径里的 `/`（`src/dsh/controller.ts`）前面是非空白字符，
 *   用空白边界就能既允许句中触发、又不误判路径。查询串就是光标前那一段。
 * - `@`：光标落在哪个 `@` 内容块里（见 {@link mentionBlockAt}）就以**整块**为查询串，
 *   块里有内容就触发——打会话 id / 名字片段（`@session-…`、`@web`）与目录块一样要弹，
 *   服务端正是拿这个查询串列目录、筛对话（用户 2026-10-11 报的现场：会话 id 打进去
 *   一条候选都不出来，就是这里把「有内容的块」整档判掉了）。
 *
 * **能不能引用到内容由宿主判**（用户 2026-10-11 口径）：块本身已经是一条能引用到
 * 内容的引用（路径在盘上、或对话引用指向的会话还在）时列表整块不弹，否则才弹。判据
 * 要查盘、要查会话列表，界面这一层没有证据，所以它随后面那条 `files/list` 帧回来
 * （`resolved`，抑制门见 `useCompletion`），这里只负责把块认出来。
 *
 * 两条与「能不能引用」无关的既有判据：
 * - **裸 `@`**：块里一个字都没有、且光标紧靠它右侧 → 列工作区根目录（隔了空白的
 *   `@ |` 不算、成对空引号 `@""` 那一块也不算）；
 * - **目录块**（以 `/` 或 `\` 结尾）：那是「进去看这一层」的浏览入口，目录在不在都要
 *   能进去，所以宿主不做判定、恒弹（`shared/mentions.ts` 的 `isBrowseQuery`）。
 *
 * 含空白的路径引用（`formatFileMention` 产出 `@"my dir/"`）按同一个判据算：引号是
 * 引用包装，块是「`@` + 成对引号之间那一段」的整块，查询与替换都去掉那对引号
 * （替换区间覆盖闭引号，正文里不留半个引号）。
 *
 * 纯函数：断言见 `scripts/mentionNav.test.ts`（含「`@` 能与 `/` 在同一段文本里区分」
 * 与上面各条口径的逐字回归）。
 */
export function findTrigger(text: string, caret: number, sessions?: ComposerSessionDraft): Trigger | undefined {
  const at = clampIndex(caret, text.length);
  const session = sessions?.queryAt(at);
  if (session === null) return undefined;
  if (session) return { kind: "mention", ...session };
  const block = mentionBlockAt(text, at);
  if (block) {
    // (1) 裸 `@`：块里一个字都没有，且光标紧靠它右侧（隔了空白的 `@ |` 不算、
    //     成对空引号那一块也不算）
    const bare = !block.quoted && block.body.length === 0 && at === block.start + 1;
    // (2) 有内容的块：查询串取**整个块**——光标可能停在块中间（鼠标点进来、方向键
    //     挪回来），只取光标前半截会查错一层目录，替换时还会留下半截路径。
    if (bare || block.body.length > 0) {
      return { kind: "mention", start: block.start, query: block.body };
    }
  }
  const before = text.slice(0, at);
  const command = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (command) {
    const query = command[2] ?? "";
    return { kind: "command", start: before.length - query.length - 1, query };
  }
  return undefined;
}

/**
 * 一个 `@` **内容块**。
 *
 * 两种形态（判据同一个：`@` 到块尾之间那一段的**语义路径**）：
 * - 不带引号：从 `@` 到下一个空白（或文本末尾）——`@src/webview/`；
 * - 带引号（`formatFileMention` 给含空白路径产出的形态）：从开引号到**成对的闭引号**，
 *   块因此可以跨过空白（`@"my dir/"` 是一整块）。**没有闭引号时退回按空白切块**——
 *   半截引号不许把后面的正文吞进块里。
 */
interface MentionBlock {
  /** 触发用的 `@` 在文本里的下标。 */
  start: number;
  /** 块之后第一个字符的下标（下一个空白 / 文本末尾；带引号时是闭引号之后）。 */
  end: number;
  /** 块的**语义路径**（不含 `@`，带引号时也不含那对引号）——可直接当查询串。 */
  body: string;
  /** 是不是成对引号的形态（空引号块不算裸 `@`，见 `findTrigger`）。 */
  quoted: boolean;
}

/**
 * 光标落在哪一个 `@` 内容块里（不在任何块里就是 undefined）。
 *
 * 分两步，**先认完整的带引号 token、再退回按空白切块**：
 * 1. 光标落在某个成对引号的 token（`@"…"`）区间里时，那个 token 拥有整段——引号块
 *    **可以含空白**，于是里面也可能出现「空白之后的 `@`」（`@"my @scope/"`）。
 *    先认外层 token，那些内部 `@` 就不可能被当成新的触发起点（否则光标一挪到它右侧，
 *    整块就变成 `scope/"`：目录块会被切掉，「进去看这一层」这一路当场失效）。
 * 2. 光标不在任何引号 token 里才按空白切块：块里可以出现 `@`
 *    （`node_modules/@types/` 这种真路径要走得通），但**触发点**必须是「行首或空白之后」
 *    的那个 `@`——与 `/` 同一条边界规则，于是 `mail@example.com`、`看@src` 都不会误开
 *    列表。块里那些不合边界的 `@`（`@types` 那个）只是块内容，不另起一个块。
 *
 * 两步都是「从光标往前找**最近**的那个合格起点，且光标必须落在它的块内」
 * （`@src/ |` 里光标已经出了块，不算）。找到就返回——不再往前退：光标所在的块若是
 * 普通查询，也不该退回更早那个目录块去开列表。
 */
function mentionBlockAt(text: string, caret: number): MentionBlock | undefined {
  const quoted = quotedMentionBlockAt(text, caret);
  if (quoted) return quoted;
  let from = caret;
  while (from > 0) {
    const start = text.lastIndexOf("@", from - 1);
    if (start < 0) return undefined;
    if (start === 0 || /\s/u.test(text[start - 1] ?? "")) {
      const block = mentionBlockFrom(text, start);
      if (caret <= block.end) return block;
    }
    from = start;
  }
  return undefined;
}

/**
 * 光标所在的那个**成对引号** token（`@"…"`）；没有就是 undefined。
 *
 * 只认「行首或空白之后」的 `@"`（与其余触发点同一条边界规则），闭引号必须在光标处或
 * 其后（光标落在引号块**内**、含紧贴闭引号右侧那一格都算）。**没有闭引号时不算**：
 * 半截引号退回按空白切块，不许把它后面的正文吞进块里（见 {@link MentionBlock}）。
 */
function quotedMentionBlockAt(text: string, caret: number): MentionBlock | undefined {
  let search = caret - 1;
  while (search >= 0) {
    const start = text.lastIndexOf('@"', search);
    if (start < 0) return undefined;
    if (start === 0 || /\s/u.test(text[start - 1] ?? "")) {
      const close = text.indexOf('"', start + 2);
      if (close >= 0 && caret <= close + 1) {
        return { start, end: close + 1, body: text.slice(start + 2, close), quoted: true };
      }
    }
    search = start - 1;
  }
  return undefined;
}

/** 从某个合格 `@` 起算整个内容块（形态见 {@link MentionBlock}）。 */
function mentionBlockFrom(text: string, start: number): MentionBlock {
  if (text[start + 1] === '"') {
    const close = text.indexOf('"', start + 2);
    if (close >= 0) {
      return { start, end: close + 1, body: text.slice(start + 2, close), quoted: true };
    }
  }
  const end = mentionBlockEnd(text, start + 1);
  return { start, end, body: text.slice(start + 1, end), quoted: false };
}

/** 从 `from` 起第一个空白字符的下标；没有就是文本末尾。 */
function mentionBlockEnd(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    if (/\s/u.test(text[index] ?? "")) return index;
  }
  return text.length;
}

/** 这一条候选是不是「对话引用」（有 `mention`，没有文件那样的 `kind`）。 */
export function isSessionCandidate(candidate: MentionCandidate): candidate is SessionRefView {
  return typeof (candidate as SessionRefView).mention === "string";
}

/**
 * 把当前候选排成这一帧的列表。
 *
 * `@` 的顺序是官方 `reference` 源的顺序：文件在前、对话在后；查询已经进入某个
 * 子目录时，**上一层（`..`）永远排在最前**（文件浏览器的惯例，键盘上下也能选中它）。
 * 命令按名字做大小写不敏感的子串过滤。
 *
 * **对话候选只在工作区根目录列**（用户 2026-09-25 口径，刻意偏离官方 `@` 源：官方拿
 * 查询串去筛历史对话，进了目录也照样列）。判据必须在这一层，不能只靠宿主不发那批帧：
 * 下钻是同步改正文的，等事实的帧回来才消失就会出现「先进目录、对话条目再慢慢消失」
 * ——用户报的现场。宿主侧有同一条判据（`isDirectoryQuery`），那边据此连查都不查。
 */
export function rankCandidates(
  trigger: Trigger | undefined,
  commands: readonly CommandView[],
  items: readonly FileRefView[],
  sessions: readonly SessionRefView[],
  cwd?: string,
): MentionCandidate[] {
  if (!trigger) return [];
  if (trigger.kind === "command") {
    const query = trigger.query.toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().includes(query));
  }
  if (trigger.sessionOnly) {
    const query = trigger.query.toLowerCase();
    return sessions.filter((session) => session.label.toLowerCase().includes(query));
  }
  const files: MentionCandidate[] = [...items];
  const refs: MentionCandidate[] = isDirectoryQuery(trigger.query) ? [] : [...sessions];
  // 宿主已经下发了「上一层」行（裸 `@` 且信任门通过时，它由 `dsh/controller.ts` 的
  // `completeFileListing` 挂成 `items[0]`）：原样留着——它本来就是这一层的首行，
  // 界面**不再自己合成一条**，否则同一个目标会在列表里出现两行「..」。
  if (files.some(isParentCandidate)) return [...files, ...refs];
  // 界面自己合成的「上一层」：`cwd` 传下去，含 `..` 段的相对查询才知道往上还能走几层
  // （见 `mentionNav.mentionParent`；宿主下发的 parent 行在上一步已经返回，不会被它覆盖）
  const parent = mentionParent(trigger.query, cwd);
  if (parent === undefined) return [...files, ...refs];
  const up: FileRefView = { path: parent, kind: "directory", parent: true };
  return [up, ...files, ...refs];
}

/**
 * 候选列表在界面上的**行数上限**。
 *
 * 为什么要有它：宿主会把「目录列举」被服务器截掉的那 20 条之外的条目补回来
 * （见 `dsh/fileRefListing.ts`），于是一个大目录可能列出几百行；每次高亮变化都要重渲染
 * 这一列，行数不受控时打字与鼠标扫过都会顿。
 *
 * 这个上限的边界（不要读成「这里能访问到任何文件」）：
 * - 一屏约 8 行（`.trigger-popover` 限高 260 设计像素），200 行 = 25 屏——作为「翻目录」
 *   的用法早就不可用了；
 * - 弹列表的块只有两类：浏览入口（裸 `@` 与以分隔符结尾的目录块，查询串就是那一层的
 *   目录路径）与「还不能引用到内容」的检索块（会话 id / 名字片段，见 `findTrigger`），
 *   所以**同一层里排在第 200 条之后的条目在这一列里看不到**。上限收在这一层只是为了让
 *   渲染行数受控，不是可达性保证。
 *
 * 它同时是**唯一**的上限：此前渲染处另有一道没注释的 40 行截断（`.popover-list` 里把
 * `candidates` 直接切掉前 40 条之后的部分），而键盘导航按 `candidates.length` 走下标——
 * 候选多过 40 条时，高亮会走到根本没渲染的行上（看着像「选中了一行却什么都没高亮」）。
 * 上限收到候选取用这一层后，下标、渲染、高亮只认同一份列表。
 */
export const CANDIDATE_LIST_LIMIT = 200;

/**
 * 触发词在正文里占的区间（含那个 `@` / `/`）。
 *
 * `@` 的区间**按文本重算整个内容块**（`mentionBlockFrom`），不是
 * `start + 1 + query.length`：带引号的目录块里查询串是去掉引号的语义路径，长度比正文里
 * 那一段短两个引号——按 query 长度算会把闭引号留在正文里。重算出来的区间覆盖整块
 * （含那对引号），所以光标停在块中间时也是整段替换。命令的区间仍是
 * `start + 1 + query.length`（查询串就是光标前那一段）。
 *
 * 内部实现：只有 `replaceToken` 用它，导出没有信息增量（调用方一律只要
 * `caretAfterInsert` 的「新文本 + 新光标」）。
 */
interface TokenSpan {
  before: string;
  after: string;
  /** 触发词起点。 */
  start: number;
  /** 触发词之后第一个字符的下标。 */
  end: number;
}

/** 算触发词区间。 */
function tokenSpan(text: string, trigger: Trigger): TokenSpan {
  const start = clampIndex(trigger.start, text.length);
  const end = clampIndex(
    trigger.end ?? (trigger.kind === "mention"
      ? mentionBlockFrom(text, start).end
      : start + 1 + trigger.query.length),
    text.length,
  );
  return { before: text.slice(0, start), after: text.slice(end), start, end };
}

/** `caret` 夹到 `[0, length]`，非有限值按末尾处理。 */
function clampIndex(value: number, length: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(0, Math.trunc(value)), length) : length;
}

/**
 * 把 `text` 的一段区间换成 `token`，并给出**替换之后光标该落在哪**。
 *
 * 这是「插进来的 `@路径` 落在哪、后面的字有没有被吃掉」的全部算术——纯函数，
 * 离线可断言（`scripts/pathInsert.test.ts`）。`from`/`to` 会被夹到合法区间。
 *
 * 与 `insertToken` 的分工：那边是「在光标处塞一段文本」（前后按需补空格，宿主
 * 下发的路径插入走它）；这边是「把已经认出来的触发词整段换掉」（补全用），
 * 光标的落点规则不同，不能混用。
 */
export function caretAfterInsert(
  text: string,
  from: number,
  to: number,
  token: string,
): { text: string; caret: number } {
  const start = clampIndex(from, text.length);
  const stop = Math.max(start, clampIndex(to, text.length));
  const next = `${text.slice(0, start)}${token}${text.slice(stop)}`;
  return { text: next, caret: start + token.length };
}

/**
 * 把已经认出来的触发词整段换成 `token`。
 *
 * `token` 一律**已含**那个 `@` / `/`（命令是 `/name`、mention 是 `@path`）：
 * 调用方给的 token 与触发词的第一个字符是同一个通道，所以这里不再判断。
 */
export function replaceToken(
  text: string,
  trigger: Trigger,
  token: string,
): { text: string; caret: number } {
  return caretAfterInsert(text, trigger.start, tokenSpan(text, trigger).end, token);
}

/** 候选行的形状（渲染与动作都只读它，不再各自重推一遍 `kind` 的判断）。 */
export interface CandidateRow {
  /** 在这一帧列表里的序号（键盘导航与鼠标悬停都用它）。 */
  index: number;
  section: string;
  /** 是否在它前面渲染分组标题（组的第一行）。 */
  showSection: boolean;
  /** 命令名 / 会话标题 / `..` 走「优先完整」那一档（长路径不挂）。 */
  priority: boolean;
  /** 对话引用（`kind` / `path` 都不读）。 */
  session: boolean;
  /** 界面自己插的「返回上一层目录」行。 */
  parent: boolean;
  /** 服务端给的可进目录（`..` 不算，它没有「整个目录」按钮）。 */
  folder: boolean;
}

/**
 * 这一条候选是不是**「返回上一层」行**。
 *
 * 两个来源同形：界面自己合成的（`rankCandidates`，进了子目录时的 `..`）与宿主下发的
 * （裸 `@` 且信任门通过时由 `completeFileListing` 放在 `items[0]`）。渲染、动作与排序
 * 都只读这一个判据，不各推一遍。
 */
function isParentCandidate(candidate: MentionCandidate): boolean {
  return (candidate as FileRefView).parent === true;
}

/**
 * 算出这一帧每一行的形状。
 *
 * `section` 由这条候选的种类与触发通道决定（命令一条、`@` 的文件 / 对话各一条，
 * 官方按 `section` 分组渲染）；`priority` 是「宽度不够时先省描述」的标记。
 */
export function candidateRows(
  candidates: readonly MentionCandidate[],
  kind: "command" | "mention",
  texts: Pick<Texts, "commands" | "mentionFiles" | "mentionSessions">,
): CandidateRow[] {
  const sectionOf = (candidate: MentionCandidate): string =>
    kind === "command"
      ? texts.commands
      : isSessionCandidate(candidate)
        ? texts.mentionSessions
        : texts.mentionFiles;
  return candidates.map((candidate, index) => {
    const isCommand = kind === "command";
    const isSession = !isCommand && isSessionCandidate(candidate);
    const isParent = !isCommand && !isSession && isParentCandidate(candidate);
    const section = sectionOf(candidate);
    return {
      index,
      section,
      showSection: index === 0 || sectionOf(candidates[index - 1]) !== section,
      priority: isCommand || isParent || isSession,
      session: isSession,
      parent: isParent,
      folder: !isCommand && !isSession && (candidate as FileRefView).kind === "directory" && !isParent,
    };
  });
}

/**
 * 这一批候选里有没有**可以下钻的目录**（`..` 不算：它是回上一层，不是进到它里面）。
 *
 * 判据只服务一件事：「文件」分组标题栏右侧要不要显示 `Tab 进入目录` 的提示——一个能
 * 下钻的子目录都没有时，显示它只会让人以为按了有用。它与「Tab 在这一行有没有动作」
 * **不是**同一件事：`..` 上 Tab 照旧有动作（回上一层，见 `outcomeFor`），只是那个动作
 * 不是「进入目录」，所以这一行的存在不能当作显示提示的依据。
 */
export function hasDrillableFolder(candidates: readonly MentionCandidate[]): boolean {
  return candidates.some(
    (candidate) =>
      !isSessionCandidate(candidate) &&
      (candidate as FileRefView).kind === "directory" &&
      !isParentCandidate(candidate),
  );
}

/** 选中这一条会发生什么（渲染只为它决定按钮，动作只在 `actionFor` 里判断一次）。 */
export type CandidateOutcome =
  /** 命令：写 `/name` 进正文，不查询。 */
  | { type: "command"; name: string }
  /** 对话引用：把服务端铸好的 mention 原样插进正文。 */
  | { type: "session"; token: string }
  /** `..`：回到上一层（正文只留上一层查询串）；Enter 与 Tab 是同一条动作。 */
  | { type: "parent"; path: string }
  /** 目录（Enter / 行右侧「整个目录」按钮）：引用**整个目录**。 */
  | { type: "insert"; token: string }
  /** 目录 + drill（Tab / **点行主体**）：**打开**它，列表换成下一层的内容。 */
  | { type: "drill"; path: string };

/** 某条候选带某个动作时的结果；命令通道忽略 `action`。 */
export function outcomeFor(
  kind: "command" | "mention",
  candidate: MentionCandidate | undefined,
  action: CandidateAction,
): CandidateOutcome | undefined {
  if (!candidate) return undefined;
  if (kind === "command") return { type: "command", name: (candidate as CommandView).name };
  if (isSessionCandidate(candidate)) {
    const token = candidate.mention.trim();
    // 没有 token 的对话候选不该让用户选中（服务端理论上不会给），原样保留这条保护
    return token ? { type: "session", token } : undefined;
  }
  const file = candidate as FileRefView;
  // 「返回上一层」行**两把键做同一件事**：pick（Enter / 点行主体）与 drill（Tab）都回
  // 上一层。它不是「可以下钻的目录」——下钻是进到它里面，而它本身就是往上走一层；
  // `hasDrillableFolder` 因此仍把它排除在「Tab 进入目录」提示之外，但那只是**提示的
  // 依据**，不是「Tab 无动作」：`..` 与目录行一样是导航行，两把键落在它身上理当给出
  // 同一个结果，而不是让 Tab 被静默吞掉。
  if (isParentCandidate(file)) return { type: "parent", path: file.path };
  if (file.kind === "directory" && action === "drill") return { type: "drill", path: file.path };
  return { type: "insert", token: formatFileMention(file.path, file.kind) ?? `"${file.path}"` };
}

/**
 * 弹层要不要渲染：有触发词，并且要么有候选、要么有话可说——
 * `@` 空结果要给「没有文件」的提示；`/` 空结果本来不弹（一个空框挂在那里没有用），
 * 但**还没有工作目录**时例外：那时两个菜单都必然是空的，弹层是唯一能把原因
 * （`menuNoWorkspace`）说给用户的地方（用户 2026-09-24 口径：空态下 `/` 不弹命令栏
 * 是缺陷，不是「没有命令」）。
 */
export function popoverVisible(
  trigger: Trigger | undefined,
  count: number,
  noWorkspace = false,
): boolean {
  return Boolean(trigger && (count > 0 || trigger.kind === "mention" || noWorkspace));
}

/**
 * **鼠标点行主体**时的动作（用户 2026-09-21 口径）。
 *
 * 目录行点进去（下钻到该目录的候选），其余一律选中。用户的原话：「鼠标点击目录的默认
 * 行为应该是打开该目录，而不是直接选中该目录，如果是选中该目录，尾部已有整个目录按钮
 * 用于满足该需求了」——所以行右侧那枚「整个目录」按钮才是鼠标的「选中」入口。
 *
 * 键盘分工**不动**（官方口径）：Enter = 选中、Tab = 下钻。两边各有一条路：
 * 想引用整个目录，鼠标点按钮、键盘按 Enter，谁都不会被挤掉。
 */
export function clickAction(shape: CandidateRow): CandidateAction {
  return shape.folder ? "drill" : "pick";
}

/**
 * 下钻 / 回上一层写回正文的 `@` token（`drill` 与 `..` 共用，方向只差那个路径）。
 *
 * 三件事都由它一处负责：
 * - **分隔符归一**：候选路径可能来自 Windows 侧（`src\webview`），不归一就会在家里
 *   留下 `@src\webview/`（用户 2026-09-21 报的）；
 * - **含空白要带引号**：不带引号时块在空白处结束——`@my dir/` 会当场掉出候选态
 *   （块只剩 `my`），所以空格路径写成 `@"my dir/"`（`formatFileMention` 产出，与选中
 *   候选写回正文的拼写同一份规则，见 `shared/mentions.ts` 的文件头）；
 * - **回到工作区根目录写裸 `@`**：那是唯一的「从头浏览」形态，写成 `@/` 会多出一个
 *   没有意义的根目录段。
 *
 * 路径含控制字符或 `"` 时 `formatFileMention` 给不出 token（那种路径本来就不可引用），
 * 退回与归一后同形的裸写法，行为与不带引号时代一致。
 */
function drillQueryToken(path: string): string {
  const normalized = normalizeMentionPath(path ?? "");
  if (normalized === "") return "@";
  return formatFileMention(normalized, "directory") ?? `@${normalized}/`;
}

/* ============================ hook ============================ */

/** `useComposerCompletion` 的输入。 */
export interface UseComposerCompletionInput {
  /** 当前草稿（受控：组件持有 state，这里只读）。 */
  draft: string;
  /** 光标位置；缺省按草稿末尾。 */
  caret?: number;
  /** 命令目录（`commands/list`）。 */
  commands: readonly CommandView[];
  /** 当前查询归属与执行目录；改变任一项都要重取，即使查询串未变。 */
  sessionId?: string;
  workingDirectory?: string;
  /**
   * 文件 / 对话候选（`fileReferences/list` + `sessionReferenceResolver/candidates`）
   * 与**这一块自己**的判定。
   *
   * `resolved` = 宿主说光标所在那个 `@` 块本身已经是一条能引用到内容的引用
   * （路径在盘上 / 对话引用指向的会话还在）——那种块整块不弹（用户 2026-10-11 口径，
   * 判据见 `controller.mentionResolves`）。它**与 `query` 同一批**回来：两者都属于
   * 同一次查询，`query` 对不上就是「这一次的判定还没到」。缺省（旧宿主不发）按
   * `false` 处理，退回「一律弹列表」的旧行为。
   */
  fileRefs: {
    sessionId?: string;
    query: string;
    items: readonly FileRefView[];
    sessions: readonly SessionRefView[];
    resolved?: boolean;
    /**
     * 这次的**执行目录**（`files/list` 帧下发；旧宿主不发时缺失）。
     *
     * 悬停标题拿它把候选里的相对路径与界面自己合成的「上一层」行解析成完整绝对路径
     * （见 `pathDisplay.ts` 的 `resolveDisplayPath`）。缺失时退回原样的展示路径。
     */
    cwd?: string;
  };
  /** 界面文案（词典）。 */
  texts: Texts;
  /**
   * 这个窗口**还没有工作目录**（`workspace.path` 是空串，见 `ChatState.workspace`）。
   *
   * 空态下 `/` 与 `@` 的候选都来自会话作用域的服务端目录，而没有目录时宿主不会就地
   * 建会话（用户 2026-09-24 口径：菜单不弹目录选择器）——于是两个菜单必然为空，
   * 弹层要改说「未选择工作区」而不是「没有可用命令 / 没有匹配的文件」。
   * `workspace` 还没下发时按 false 处理：那时「为什么空」还无从判断，不猜。
   */
  noWorkspace?: boolean;
  /** 草稿写回：本地 state（宿主持久化那一写由本 module 自己发）。 */
  onDraft: (text: string) => void;
  /** 会话草稿端口：统一显示、写回与触发区间，不将绑定泄漏给文本域。 */
  sessionDraft?: ComposerSessionDraft;
  /**
   * 弹层**没接管**的 Enter 交给它（`"accelerated"` = Cmd/Ctrl+Enter）。
   *
   * 为什么归这个 module：文本域只有**一个** `onKeyDown`（组件把 `textareaProps` 摊上去），
   * 而 Enter 的语义分在两地就会丢一半——2026-09-19 把弹层分支搬进来时，发送分支留在原地
   * 没人看见，于是回车变成了换行（用户当天报的现场）。一条键的语义必须只住一处。
   */
  onSubmit?: (gesture: "enter" | "accelerated") => void;
  /** 宿主下发的「插到光标处」请求（`setDraft` 帧），按 id 去重。 */
  insertRequest?: { id: number; text: string };
  /**
   * 界面自产的「引用到输入框」请求（正文右键菜单的「引用」），按 id 去重。
   *
   * 与 `insertRequest` 同为「往文本域里插东西」，但拼接口径不同（块 vs 行内，
   * 见 `quoteBlock`），所以是两条请求而不是一条带标志位的。
   */
  quoteRequest?: { id: number; text: string };
  /**
   * 文本域节点的 ref。组件自己的自适应量高与「跑完把焦点还回来」也要同一个节点，
   * 传进来两边就共用**一个** ref 对象（同一个元素上挂两个 ref 属性时只有最后一个生效）。
   */
  textareaRef?: MutableRefObject<HTMLTextAreaElement | null>;
}

/** `useComposerCompletion` 的返回：弹层 + 文本域要接的那几个 prop。 */
export interface ComposerCompletion {
  /** 触发词弹层（没触发时是 null）。 */
  popover: ReactNode;
  /**
   * 文本域要接的 prop（ref + 五个事件）。
   *
   * `onKeyDown` 里带着 ESC 优先级链与 Enter/Tab 的补全语义，所以**不能**由组件
   * 自己再写一份——组件只负责把工具行、文本域这些「其余一切」拼起来。
   *
   * `onFocus` 与其余四个一样是**规则的一部分**（焦点回到输入框 = 新的编辑动作，见
   * `onFocus`），组件必须原样摊到文本域上。
   *
   * `ref` 就是传进来的 `textareaRef`（没传时是 hook 自建的那个），所以组件既可以直接
   * `{...textareaProps}` 交给文本域，也可以自己再挂一个 ref——两种写法都能用。
   */
  textareaProps: Pick<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "onChange" | "onKeyUp" | "onClick" | "onFocus" | "onKeyDown"
  > & {
    /**
     * 就是传进来的 `textareaRef`（没传时是本 hook 自建的那个）。
     *
     * 类型与入参同为 `MutableRefObject<HTMLTextAreaElement | null>`：React 18 的
     * `RefObject<T>` 把 `current` 标成 `readonly`，而这里写的是「可写、可能为 null」
     * 的那一支（文本域的 `ref` 属性两者都收）。
     */
    ref: MutableRefObject<HTMLTextAreaElement | null>;
  };
}

/**
 * `@` / `/` 补全的完整规则集（见文件头）。`Composer` 只调用它并摆位。
 */
export function useComposerCompletion(input: UseComposerCompletionInput): ComposerCompletion {
  // 状态钩子经 context 取：默认就是 React 的 `useState`，只有离线测试会换掉它
  // （server 渲染里状态更新被丢弃，弹层永远只有第一帧，见 `ComposerCompletionState`）。
  const useStateImpl = useContext(ComposerCompletionState);
  return useCompletion(input, useStateImpl);
}

/** 测试用的状态钩子替身：把状态挂在同一个 map 上跨渲染保留。 */
export type ComposerCompletionStateHook = <T>(initial: T | (() => T)) => [T, Dispatch<SetStateAction<T>>];

/**
 * 状态钩子的注入点。
 *
 * 存在的唯一理由是**可离线断言**：`react-dom/server` 的渲染不重放状态更新
 * （`setState` 排队后就结束），弹层因此永远停在第一帧。测试用这个 context 换一个
 * 「状态跨渲染保留」的假钩子，就能跑真实的「事件 → 下一帧」链路；
 * 生产里没人提供它，走的就是 React 自己的 `useState`。
 */
export const ComposerCompletionState = createContext<ComposerCompletionStateHook>(useState);

function useCompletion(
  {
    draft,
    caret,
    commands,
    fileRefs,
    sessionId,
    workingDirectory,
    texts,
    noWorkspace,
    onDraft,
    sessionDraft,
    onSubmit,
    insertRequest,
    quoteRequest,
    textareaRef,
  }: UseComposerCompletionInput,
  useStateImpl: ComposerCompletionStateHook,
): ComposerCompletion {
  /**
   * 本 hook 要用的文本域节点。
   *
   * 优先用组件传进来的那个（组件自己的自适应量高与「跑完把焦点还回来」也要这个
   * 节点）：两边是**同一个 ref 对象**，不需要在一个元素上挂两个 ref 属性——同一个
   * 元素上挂两个时只有最后一个生效。没传（测试 / 独立使用）就自己建一个。
   */
  const ownRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? ownRef;
  /**
   * 上一次「关掉弹层」时的文本与光标（ESC 关闭，或选中一条命令 / 引用之后）。
   *
   * 只要**同一次编辑动作**里文本与光标都没变，随后的 keyup 重新探测不该把列表弹回来
   * （否则表现为「按 ESC 列表又弹出」「选完按回车列表闪一下」）。
   *
   * 它记的是「这一次编辑动作」，所以**焦点重新进入输入框时由 `onFocus` 清掉**：用户
   * 从框外回来、光标又落在某个 `@` 块里（点回来的位置常常就是末尾那一格）时，位置没变
   * 而记忆还命中，列表就永远不出来——用户 2026-10-11 报的「从框外回来不弹，得先在框内
   * 挪一下光标才弹」正是它（挪光标让位置变了，记忆才失效）。
   */
  const dismissedRef = useRef<{ value: string; caret: number } | null>(null);
  /** 候选行的容器（`.popover-list`，弹层里**唯一**可滚的那一层），键盘导航要滚它。 */
  const popoverRef = useRef<HTMLDivElement | null>(null);
  /** 这一次高亮变化是不是键盘导航引起的（鼠标悬停不滚动列表）。 */
  const keyboardNavRef = useRef(false);
  /**
   * 初始触发词由**第一帧**的草稿 + 光标位置算出来。
   *
   * 生产里 `Composer` 不传 `caret`（它把 undefined 当末尾），而第一次渲染时草稿本来
   * 就是空字符串，所以这里恒等于 `findTrigger("", 0) === undefined`——与搬家前
   * `useState(undefined)` 逐字等价。传了 `caret`（测试与独立使用）时才能从第一帧
   * 就看见触发词，否则「弹层该不该渲染」这类断言没法离线跑。
   */
  const [trigger, setTrigger] = useStateImpl<Trigger | undefined>(() => findTrigger(draft, caret ?? draft.length, sessionDraft));
  const [highlight, setHighlight] = useStateImpl<number>(0);
  /**
   * 上一次**画在屏上**的那一份候选（`@` 弹层的 stale-while-revalidate，见文件头第 9 条）。
   *
   * 只在**同一个** `@` 块里复用：触发词起点变了就是另一块，没有「原地留屏」可言，
   * 上一块的候选行不许占新块的首行（用户 2026-10-18 报的「快按 Enter 选到上一层」）。
   * 触发词消失（选中一条 / ESC / 光标离开这个块）即清空：光标移回一条已经写好的引用时，
   * 上一块的列表不许先闪一下（用户 2026-10-10 报的现场）。
   *
   * 为什么是挂在**可注入状态钩子**上的可变盒子，而不是 `useRef`：离线断言是逐帧重新渲染
   * 的（每个 `frame` 都是一棵新树、一个新实例，见 `ComposerCompletionState`），`useRef`
   * 在那一侧每次归零，「跨帧留屏」这条规则就永远断不出来。这个盒子在生产里就是一次
   * `useState` 的初始值——此后只改 `.current`、不再 `set`，所以不会引起重渲染。
   */
  const [paintedBox] = useStateImpl<{ current: PaintedCandidates | null }>(() => ({ current: null }));
  /**
   * 每次都读到**最新一帧**的草稿、目录与回调。
   *
   * rAF 里的落光标与 keyup 的重新探测都要读「刚才那一帧」的值，闭包捕获会读到旧的
   * （草稿已被 React 换成新的，捕获的却还是上一帧）——搬家前这些代码直接读组件作用
   * 域里的 `state.draft`，等价于这里每次都取最新值。
   */
  const latest = useRef({ draft, commands, fileRefs, texts, onDraft, onSubmit, sessionDraft });
  latest.current = { draft, commands, fileRefs, texts, onDraft, onSubmit, sessionDraft };

  /**
   * 草稿的**两次写**：本地 state（`onDraft`，界面立刻变）+ 宿主持久化
   * （`setDraft` 帧，换会话 / 重载后草稿还在）。顺序与内容必须与搬家前一致。
   */
  const writeDraft = useCallback((text: string, caret: number, range?: DraftEditRange) => {
    const result = latest.current.sessionDraft?.write(text, caret, range) ?? { text, raw: text, caret };
    latest.current.draft = result.text;
    latest.current.onDraft(result.raw);
    post({ type: "setDraft", text: result.raw });
    return result;
  }, []);

  // textarea 的 input 没有可靠的旧选区；在原生 beforeinput 中捕获，避免重复标题串绑。
  const beforeEdit = useRef<DraftEditRange | undefined>();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const capture = (event: Event) => {
      const input = event as InputEvent;
      // 插入 / 选区替换保留精确位置；无选区删除和历史回退的实际区间由差分计算。
      beforeEdit.current = input.inputType.startsWith("insert") ||
        (input.inputType.startsWith("delete") && node.selectionStart !== node.selectionEnd)
        ? { start: node.selectionStart, end: node.selectionEnd }
        : undefined;
    };
    const replaceUnchanged = () => {
      const range = beforeEdit.current;
      // 重输相同选区时浏览器仍发 input，但 React 因 value 未变不会发 onChange。
      // 只在实际 input 后失效，取消的 beforeinput 不应影响绑定。
      if (!latest.current.sessionDraft || !range || range.start === range.end || node.value !== latest.current.draft) return;
      beforeEdit.current = undefined;
      const result = writeDraft(node.value, node.selectionStart, range);
      dismissedRef.current = null;
      setTrigger(findTrigger(result.text, result.caret, latest.current.sessionDraft));
    };
    node.addEventListener("beforeinput", capture);
    node.addEventListener("input", replaceUnchanged);
    return () => {
      node.removeEventListener("beforeinput", capture);
      node.removeEventListener("input", replaceUnchanged);
    };
  }, [ref, sessionDraft, writeDraft]);

  /**
   * 触发词出现时才去拉候选列表，避免每次输入都请求。
   *
   * **两条通道的重取时机不同**：
   * - `@`：查询串就是候选的入参（服务端按它列目录、筛对话），每变一次都要重取；
   * - `/`：命令目录与查询串**无关**（过滤在本地做，见 `rankCandidates`），所以只在
   *   命令通道**打开**时取一次。此前它跟着 `trigger?.query` 一起重取，等于每敲一个字
   *   换一次 `commands/list` + `skills/list`，去算一个本地就能算出来的过滤结果。
   */
  const commandChannel = trigger?.kind === "command";
  useEffect(() => {
    if (commandChannel) post({ type: "listCommands" });
  }, [commandChannel]);

  /**
   * 屏上这一份列表的**新鲜度**，以及要不要原地留屏。
   *
   * - `fresh`：`files/list` 这一帧问的就是当前查询串，候选与判定都属于这一次。`/` 通道
   *   恒算新鲜——它列的是命令目录，与查询串无关（过滤在 `rankCandidates` 里本地做）。
   * - `keep`：这一帧还在路上，而**同一个块**上一次画过一份——那一份原地留屏（见
   *   `paintedBox`），既不塌成空列表、也不掺进这一帧画得出来的半份（例如只有 `..`）。
   *
   * 留屏期间列表内容一行不动：这就是「整个刷新过程只换一次内容」的全部实现
   * （用户 2026-10-18 口径）。
   */
  const fresh = trigger !== undefined && (commandChannel || (
    fileRefs.query === trigger.query &&
    (sessionId === undefined || fileRefs.sessionId === sessionId) &&
    (workingDirectory === undefined || fileRefs.cwd === workingDirectory)
  ));
  const painted = paintedBox.current;
  const keep =
    !fresh && trigger !== undefined && painted !== null && painted.sessionId === sessionId && painted.kind === trigger.kind && painted.start === trigger.start
      ? painted
      : null;

  /**
   * 屏上这一份列表是不是**上一次查询**留下的（这一次的帧还在路上）。
   *
   * 画着的是旧结果，所以这一段的键位与指针动作一并冻结（见 `onKeyDown` / `applyCandidate`
   * / 候选行上的 `onMouseMove`）：官方 `ui-input-trigger` 的 `arbitrate` 与 `pick` 同样按
   * 各源的 `status !== 'ready'` 把 pending 期间的 pick、Enter 与 Tab 挡掉。
   */
  const stale = keep !== null;

  /**
   * 屏上这一份属于哪一次查询（触发通道 + 触发词起点 + 查询串）。
   *
   * 高亮只在它变的时候回到第一条：列表整份换掉了，停在旧下标上会选错行；而留屏期间内容
   * 没换，把用户刚挪过去的高亮抹掉是白改一次界面（官方 `menuReduce` 在 `hit` 时同样保留
   * 高亮，settle 时才重新校验）。
   */
  const listKey = trigger === undefined ? "" : JSON.stringify([sessionId, workingDirectory, trigger.kind, trigger.start, trigger.query]);
  const shownKey = keep ? keep.key : listKey;

  /**
   * `@` 候选的唯一重取点：查询语义、会话身份或执行目录改变时发一次 `queryFiles`。
   *
   * 下钻 / 回上一层（`replace`）不再自己发一遍——一次导航发两遍会让服务端那趟
   * 「扫全部会话日志」的活翻倍，而两批回答的先后也没有保证（旧批次可能后到）。
   */
  useEffect(() => {
    if (trigger?.kind === "mention") post({ type: "queryFiles", query: trigger.query, ...(trigger.sessionOnly ? { sessionOnly: true } : {}) });
  }, [trigger?.kind, trigger?.query, trigger?.sessionOnly, sessionId, workingDirectory]);

  // 列表整份换掉了才把高亮回到第一条（判据见 `shownKey`）。
  useEffect(() => {
    setHighlight(0);
  }, [shownKey]);

  /**
   * 宿主要求把文本插到光标处（选了不能内嵌的路径：目录 / 二进制 / 非 UTF-8…）。
   *
   * 光标位置只有界面知道，所以这里读 textarea 的 selectionEnd 决定插在哪，
   * 插完再把光标挪到插入内容之后。同一个请求只处理一次（重渲染不该重复插入）。
   */
  const handledInsertId = useRef(0);
  useEffect(() => {
    const request = insertRequest;
    if (!request || request.id === handledInsertId.current) return;
    handledInsertId.current = request.id;

    const el = ref.current;
    const text = latest.current.draft;
    // 有选区时插在选区之后（不删用户已选中的文字）
    const at = el?.selectionEnd ?? caret ?? text.length;
    const next = insertToken(text, request.text, at);
    const written = writeDraft(next.value, next.caret, { start: at, end: at });
    // 等 React 把新 value 渲染出来再定位光标
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(written.caret, written.caret);
    });
    // 只依赖 id：effect 内读的草稿就是这次请求对应的那一帧
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertRequest?.id]);

  /**
   * 正文右键菜单的「引用」：把选中文字以**引用块**插到光标处（见 `quoteBlock`）。
   *
   * 与上面那条（宿主下发的插入）同一套落点口径与去重方式：读文本域的 `selectionEnd`、
   * 插完把光标落在插入内容之后、`requestAnimationFrame` 里落光标。两条分开写而不是
   * 合成一条带标志位的，是因为拼接规则**完全不同**（块 vs 行内），共用一个函数只会
   * 让「这段到底补不补空格」变成运行时的分支。
   */
  const handledQuoteId = useRef(0);
  useEffect(() => {
    const request = quoteRequest;
    if (!request || request.id === handledQuoteId.current) return;
    handledQuoteId.current = request.id;

    const el = ref.current;
    const text = latest.current.draft;
    const at = el?.selectionEnd ?? caret ?? text.length;
    const next = quoteBlock(text, request.text, at);
    const written = writeDraft(next.value, next.caret, { start: at, end: at });
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(written.caret, written.caret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteRequest?.id]);

  /**
   * 当前这一帧的候选（命令通道取命令目录、`@` 通道取文件 + 对话 + `..`）。
   *
   * 上限在**这里**收（见 `CANDIDATE_LIST_LIMIT`）：键盘导航、渲染与 `applyCandidate`
   * 的下标都读这一份数组，三者不会各算一套；`..` 那一行由 `rankCandidates` 排在最前，
   * 所以任何上限下它都在（否则用户进了目录就出不来）。
   *
   * 三条来路，按优先级：
   * 1. **原地留屏的那一份**（`keep`）：整份是上一次查询的，一行不加、一行不减——掺进
   *    这一帧的半份（例如只有 `..`）就是「先塌再长」，正是用户 2026-10-18 报的那个闪烁；
   * 2. **这一帧的候选**（`fresh`）：文件 / 对话用帧里的，`..` 由 `rankCandidates` 按
   *    当前查询合成；
   * 3. **这一块还没画过**（刚敲 `@`、光标刚移进这个块）：只画按当前查询**就地**算得出来
   *    的那一份——浏览入口的 `..` 不等帧（等一个往返就是「刚敲 `@` 列表没反应」）；普通
   *    查询在这一档根本不画弹层（见 `waiting`），不会拿半份结果糊弄。
   *
   * `cwd` 是这次查询冻结的**执行目录**（不随查询串变），三条来路都传当前帧里的那个，用于算 `..`
   * 的动作层深度与候选行的悬停完整路径。
   */
  const candidates = useMemo(() => {
    if (trigger === undefined) return [];
    if (keep) return keep.candidates;
    if (fresh) {
      return rankCandidates(trigger, commands, fileRefs.items, fileRefs.sessions, fileRefs.cwd).slice(
        0,
        CANDIDATE_LIST_LIMIT,
      );
    }
    return rankCandidates(trigger, commands, [], [], fileRefs.cwd).slice(0, CANDIDATE_LIST_LIMIT);
  }, [trigger, commands, fileRefs, fresh, keep]);

  const rows = useMemo(
    () => candidateRows(candidates, trigger?.kind ?? "mention", texts),
    [candidates, trigger?.kind, texts],
  );

  const hasFolderCandidate = useMemo(() => hasDrillableFolder(candidates), [candidates]);

  /**
   * 键盘上下键移动高亮时，把选中行**滚进视野**。
   *
   * 弹层是 `max-height: 330px; overflow-y: auto`（`.popover`）：候选多于一屏时，
   * 光改高亮而不滚动，选中项会跑到视野外——用户看着列表「没反应」，回车却选中了
   * 一个看不见的条目。
   *
   * 只在**键盘导航**后滚动（`keyboardNavRef`）：鼠标悬停也会改高亮，那时滚列表
   * 会把指针底下的内容挪走，晃得没法用。用 `getBoundingClientRect` 自己算差值
   * 而不是 `scrollIntoView`：后者会连带滚动外层容器（对话区）。
   *
   * `useLayoutEffect`（绘制之前）与搬家前一致——晚一帧就是「选中行先闪一下再滚」。
   */
  useLayoutEffect(() => {
    if (!keyboardNavRef.current) return;
    keyboardNavRef.current = false;
    const list = popoverRef.current;
    const item = list?.querySelector<HTMLElement>(".popover-item.is-selected");
    if (!list || !item) return;
    // 回到第一行时滚到最顶：让「命令 / 文件」那行分组标题也一起露出来
    // （只按「贴边」算的话，第一行会顶在标题下面、标题永远被压在视野外）
    const first = list.querySelector<HTMLElement>(".popover-item");
    if (item === first) {
      list.scrollTop = 0;
      return;
    }
    const listRect = list.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }, [highlight, trigger]);

  /**
   * 把光标落到 `token` 替换结果算出的那一格。
   *
   * 必须在 `requestAnimationFrame` 里落：同步改 DOM 的位置会被这一次重渲染顶掉
   * （React 提交时会按新 prop 重置光标），表现为「选完光标跑回原处」。
   */
  const landCaret = useCallback((at: number) => {
    requestAnimationFrame(() => {
      const node = ref.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(at, at);
    });
  }, []);

  /** 触发词整段替换 + 两次写 + 落光标（`drill` 与 `..` 共用）。 */
  const replace = useCallback(
    (token: string) => {
      const current = latest.current;
      if (!trigger) return;
      const replaced = replaceToken(current.draft, trigger, token);
      const result = writeDraft(replaced.text, replaced.caret, tokenSpan(latest.current.draft, trigger));
      landCaret(result.caret);
      // 下钻 / 回上一层**不**关弹层：列表换成新那一层的内容继续留在候选态。
      // 重取候选由「查询串变了就发一次」的那个 effect 负责（它读的是下一帧的
      // trigger），这里**不再自己发一遍**——一次导航发两遍是白烧一遍服务端的
      // 全语料扫描，而且两批回答谁先到没有保证。
      setTrigger(findTrigger(result.text, result.caret, latest.current.sessionDraft));
    },
    [trigger, writeDraft, landCaret],
  );

  /**
   * 把一段 mention 文本插进正文并**关掉候选弹层**（文件引用与对话引用共用）。
   *
   * 「已关闭」标记必须记：否则随后那次 keyup 的重新探测会在同一个位置再命中
   * `@path`，弹层关了又弹。光标在 rAF 里落（同步改 DOM 会被 React 的重渲染顶掉）。
   *
   * 选完**不**发清空查询的帧：弹层已经关了，没有人在看那份列表；而重开 `@` 时
   * 触发词从无到有，那个重取 effect 本来就会重取一次。多发一帧等于白烧一次
   * 服务端的全语料扫描。
   */
  const insertMentionText = useCallback(
    (mention: string) => {
      if (!trigger) return;
      const replaced = replaceToken(latest.current.draft, trigger, mention);
      const result = writeDraft(replaced.text, replaced.caret, tokenSpan(latest.current.draft, trigger));
      setTrigger(undefined);
      dismissedRef.current = { value: result.text, caret: result.caret };
      landCaret(result.caret);
    },
    [trigger, writeDraft, landCaret],
  );

  /**
   * 选中一条候选。三条通道的差别全在 `outcomeFor` 里，这里只执行：
   * - **Enter** = `pick`（目录就是「引用整个目录」）；
   * - **Tab** = `drill`（目录下钻，非目录退回 `pick`；「..」两把键都回上一层）；
   * - **鼠标点行主体** = 目录下钻、其余 `pick`（行右侧「整个目录」按钮才是选中目录）。
   *
   * 与官方的差别只有一处：官方鼠标点行 = `pick`（与 Enter 同义），这里改成「点目录
   * 就进去」（用户 2026-09-21 口径）。键盘分工不动，所以「引用整个目录」在键盘上
   * 仍是 Enter、鼠标上是那枚按钮——两条都有路可走，谁也不会被挤掉。
   *
   * **留屏期间（`stale`）一行都不许选中**：屏上那一份属于上一次查询，点它 / 敲它都会把
   * 这一块的正文改写成另一个目标。判据收在这一个入口，键盘与指针走的都是它（官方
   * `controller.pick` 同样按 `group.status === 'ready'` 把 pending 期间的点击挡掉）。
   */
  const applyCandidate = useCallback(
    (index: number, action: CandidateAction = "pick") => {
      const current = latest.current;
      if (!trigger || stale) return;
      const outcome = outcomeFor(
        trigger.kind,
        candidates[index],
        action,
      );
      if (!outcome) return;
      if (outcome.type === "command") {
        const replaced = replaceToken(current.draft, trigger, `/${outcome.name}`);
        const result = writeDraft(replaced.text, replaced.caret, tokenSpan(latest.current.draft, trigger));
        setTrigger(undefined);
        // 光标同步落到命令名之后：接下来直接打参数，再按回车就是执行。
        // 同步改 textarea 的 DOM 值与光标——React 这帧提交时 prop 值已相同、
        // 不会再重置光标，于是这次 Enter 随后的 keyup 读到的正是「新文本+新光标」。
        // 把同一对记进「已关闭」标记：keyup 重新探测时命中它、列表保持关闭。
        // 不记的话（尤其光标还停在 `/` 后面），findTrigger 会再次命中触发词，
        // 弹层关了又弹出——即「按回车命令列表闪一下」
        dismissedRef.current = { value: result.text, caret: result.caret };
        const node = ref.current;
        if (node) {
          node.focus();
          node.value = result.text;
          node.setSelectionRange(result.caret, result.caret);
        }
        return;
      }
      if (outcome.type === "session") {
        // 对话引用：服务端铸好的 mention 原样插进正文（`@[标题](dsh-session:…)`），
        // 它**没有**目录概念，也不参与下钻。
        insertMentionText(outcome.token);
        return;
      }
      if (outcome.type === "parent") {
        // 「..」：回到上一层目录，与 drill 同一条链路、方向相反。
        // 分隔符归一（用户 2026-09-21 口径）：用户手输 `src\webview\` 时上一层是
        // `src\`，写成 `@src/` 才和引用文本的语法一致（见 `shared/mentions.ts`）。
        // 含空白的上一层写成带引号的形态（见 `drillQueryToken`）。
        replace(drillQueryToken(outcome.path));
        return;
      }
      if (outcome.type === "drill") {
        // 目录 + Tab / 点行主体：**打开**它（下钻），不是把它本身载入。正文里补上
        // 结尾斜杠，服务端按它当目录查询，列表于是换成该目录的内容。
        //
        // 分隔符归一：候选路径可能来自 Windows 侧（`src\webview`），不归一就会在正文里
        // 留下 `@src\webview/`（用户 2026-09-21 报的）；含空白的路径还要带上引号，
        // 否则块在空白处结束、下钻当场掉出候选态（见 `drillQueryToken`）。
        replace(drillQueryToken(outcome.path));
        return;
      }
      // 文件 / 目录（pick）：把路径**作为纯引用 token 插进正文**。
      //
      // 用户口径：`@` 的语义就是「纯路径引用，交给 agent 自己读」，与「附件上传」
      // 是两条不同的通道（见 `shared/mentions.ts` 的文件头）。
      insertMentionText(outcome.token);
    },
    [trigger, stale, candidates, writeDraft, insertMentionText, replace],
  );

  /**
   * 每次输入 / 光标移动后重算触发词。
   *
   * 「已关闭」标记命中（文本与光标都没变）就保持关闭；任何真实变化都解除它。
   */
  const refreshTrigger = useCallback(
    (value: string, at: number) => {
      const dismissed = dismissedRef.current;
      if (dismissed && dismissed.value === value && dismissed.caret === at) {
        // ESC 刚关闭、文本与光标都没变：保持关闭，不重新弹出
        setTrigger(undefined);
        return;
      }
      // 任何真实的文本 / 光标变化都解除「已关闭」标记
      dismissedRef.current = null;
      setTrigger(findTrigger(value, at, latest.current.sessionDraft));
    },
    [],
  );

  /**
   * 「这一块已经能引用到内容」把列表整块按住（用户 2026-10-11 口径）。
   *
   * 判据只有宿主能给（要查盘、要查会话列表），所以它随 `files/list` 那一条帧回来；
   * 只有**属于当前查询**的那一次判定才算数（`fresh`）——别的查询留下的判定说的是别的
   * 路径，拿它按这一块的头，光标一移进新块就会整块不弹：
   * - **判定说「能引用」** → 整块不弹：光标移进一条已经写好的引用（`@src/a.ts`、
   *   `@[标题](dsh-session:…)`）时不该冒出列表来（用户 2026-10-10 报的现场）。
   *   `sessionOnly` 块不看这条：它列的就是服务端按整块筛出来的对话候选。
   * - **判定还没到** → 看 `waiting`：这一块之前画过就继续画（那一份原地留屏），没画过
   *   就先不弹。宿主对「能引用」的块根本不发查询、当场回帧（子毫秒级），而「不能引用」
   *   的块那条文件查询是**索引**查询（官方 `file-reference-local` 只有每个工作区的第一次
   *   要遍历一遍，之后陈旧索引当场作答，见 `search.ts` 的 `indexFor`），所以这段等待在
   *   一两帧之内——比先闪一个空结果说明出来好。
   *
   * 浏览入口（裸 `@`、以 `/` 或 `\` 结尾的路径）由 `shared/mentions.ts` 的 `isBrowseQuery`
   * 认：那是「进去看这一层」的意思，目录在不在都要能进去，不吃判定、也不等判定。
   */
  const resolvedSuppressed =
    trigger?.kind === "mention" &&
    fresh &&
    !trigger.sessionOnly &&
    !isBrowseQuery(trigger.query) &&
    fileRefs.resolved === true;

  /**
   * 这一类普通 `@` 查询**还没画过**、而这一帧的判定还在路上：先不弹。
   *
   * 画过的（`stale`）继续画——那一份原地留屏，**不塌也不重画**（见 `candidates`）。
   */
  const waiting =
    trigger?.kind === "mention" && !fresh && !isBrowseQuery(trigger.query) && keep === null;

  /**
   * 弹层**这一帧画不画**——键盘与渲染读**同一份**判据。
   *
   * 键盘那一支（`onKeyDown` 的 Enter / Tab / ↑↓ / ESC）此前只读「有触发词 + 候选非空」，
   * 而 `..` 由 `rankCandidates` **无条件**挂在最前（进了目录就一定有它），于是抑制门
   * 把弹层按住时，候选照样非空：用户按下回车就选中了一个**看不见**的第一行。
   * 用户 2026-10-18 报的现场正是它——敲一条工作区外的完整路径（宿主判定说这块已经能引用
   * 到内容 → 抑制门按住 → 列表一个行都不画），回车把正文改写成上一层目录。
   *
   * 判据只能有一份：看到的和按键接管的必须是同一个东西。弹层没画出来时这一键就不归补全
   * ——Enter 照旧是发送，↑↓ 照旧挪光标，ESC 交给归属链的兜底（没有画出来的东西可关）。
   * 官方 `ui-input-trigger` 的 `arbitrate` 第一句同样是 `if (!state.open) return 'pass'`。
   */
  const popoverOpen = !resolvedSuppressed && !waiting && popoverVisible(trigger, candidates.length, noWorkspace);

  // 记下**这一帧真的画出来了什么**：下一次 pending 就靠它原地留屏（见 `paintedBox`）。
  // 冻结中的那一份不再重记——它的 key 属于旧查询，重记会把 key 换成新的、把高亮抹掉；
  // 弹层没画出来时不动记录（关掉的列表不该在下一帧复活），触发词消失即清空。
  if (trigger === undefined) {
    paintedBox.current = null;
  } else if (popoverOpen && keep === null) {
    paintedBox.current = { sessionId, kind: trigger.kind, start: trigger.start, key: listKey, candidates };
  }

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (popoverOpen) {
        // ESC 关掉候选弹层：优先级最高。记下文本+光标防止随后的 keyup 重新
        // 探测把列表弹回来；consumeEscape 让这次 ESC 归元素层（不再落到「停止生成」
        // 的兜底上，见 escapeOwner.ts）。留屏期间也照关：画着的东西总能关掉。
        if (event.key === "Escape") {
          consumeEscape(event);
          dismissedRef.current = {
            value: draft,
            caret: event.currentTarget.selectionStart ?? draft.length,
          };
          setTrigger(undefined);
          return;
        }
        if (stale) {
          // 屏上这一份是**上一次查询**留下的：Enter / Tab / ↑↓ 一律**吞掉**（preventDefault
          // 之后什么都不做）。官方 `ui-input-trigger` 的 `arbitrate` 同款——pending 期间
          // Enter「既不选中陈旧的候选、也不落到发送」，Tab「不让焦点离开输入框」，而 ↑↓
          // 在各源都还 pending 时本来就没有可移动的目标（`positions` 只走 ready 组）。
          //
          // 三件事都不许发生：选中陈旧行（用户 2026-10-18 报的「选中上一层」，见
          // `paintedBox` 的块判据）、把半截 `@` 查询当普通消息发出去、把焦点/光标挪走。
          // 这几键归弹层（画着的那一份还没轮到它们），不是「没画出来」那一档。
          if (
            event.key === "Enter" ||
            event.key === "Tab" ||
            event.key === "ArrowDown" ||
            event.key === "ArrowUp"
          ) {
            event.preventDefault();
            return;
          }
        } else if (candidates.length > 0) {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            // 标记「这次高亮是键盘来的」：只有键盘导航才把选中行滚进视野，
            // 鼠标悬停（`mousemove` 也会改高亮）时滚动列表会晃得没法用
            keyboardNavRef.current = true;
            setHighlight((value) => (value + 1) % candidates.length);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            keyboardNavRef.current = true;
            setHighlight((value) => (value - 1 + candidates.length) % candidates.length);
            return;
          }
          // Enter = 选中（目录就是「引用整个目录」）；Tab = 目录下钻，非目录退回选中。
          // 「..」行是两把键的**同一个**结果：Enter 与 Tab 都回上一层（见 `outcomeFor`
          // 的 parent 分支）——它是导航行，既没有「引用它自己」也没有「进到它里面」。
          if (event.key === "Enter") {
            event.preventDefault();
            applyCandidate(highlight, "pick");
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            applyCandidate(highlight, "drill");
            return;
          }
        }
      }
      // 弹层**没**接管的 Enter = 发送（Shift+Enter 换行、Cmd/Ctrl+Enter = 加速手势）。
      // 「没接管」包括**弹层这一帧没画出来**（`popoverOpen` 为假，见它那里的注释）与
      // **留屏期间被吞掉**的那一次（`stale`，上面已经 return）。
      //
      // 与官方同口径：组合输入（中文输入法选词）中的 Enter 一律放过；`send` 只发**手势**，
      // 「排队 / 插话 / 停止」由宿主按按下的那一刻在不在跑来解析。
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        latest.current.onSubmit?.(event.ctrlKey || event.metaKey ? "accelerated" : "enter");
      }
    },
    [popoverOpen, stale, candidates, highlight, draft, applyCandidate],
  );

  const onEdit = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = event.target.value;
      const result = writeDraft(value, event.target.selectionStart ?? value.length, beforeEdit.current);
      beforeEdit.current = undefined;
      if (result.text !== value) {
        event.target.value = result.text;
        event.target.setSelectionRange(result.caret, result.caret);
      }
      refreshTrigger(result.text, result.caret);
    },
    [refreshTrigger, writeDraft],
  );

  const onCaretMove = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>) => {
      // 光标移动（方向键、点击）也要重算触发词
      const el = event.currentTarget;
      refreshTrigger(el.value, el.selectionStart ?? el.value.length);
    },
    [refreshTrigger],
  );

  /**
   * 焦点**重新进入**输入框：这是一次新的编辑动作（用户 2026-10-11 报的现场）。
   *
   * 两件事都要做，缺一件就是用户看到的样子：
   * - **清掉「已关闭」记忆**：它只对**同一次**编辑动作有效（ESC 关掉列表、选中一条之后
   *   先别重开）。从框外回来时位置往往一个字都没动（点在文本右侧的空白处 = 末尾那一格，
   *   正好等于记忆里的光标），记忆仍命中 → 那次探测直接返回、列表永远不出来；
   * - **重算触发词**：`findTrigger` 只在事件里跑，而光标这时**已经**落在某个 `@` 块里
   *   （点进来、宿主把焦点还回来），不重算就一个列表都不弹——用户看到的正是「回到框里
   *   没反应，得先在框内挪一下光标才弹」。
   *
   * 纯焦点（没有点击、没有敲键）也必须重算：宿主把焦点还回来（发完一轮、插入路径之后）
   * 走的就是它。查询串没变时这一步不会多发帧——重取 effect 的依赖是触发词种类 + 查询串。
   */
  const onFocus = useCallback(
    (event: React.FocusEvent<HTMLTextAreaElement>) => {
      dismissedRef.current = null;
      const el = event.currentTarget;
      refreshTrigger(el.value, el.selectionStart ?? el.value.length);
    },
    [refreshTrigger],
  );

  /**
   * 这一行的悬停标题：**完整绝对路径**（解析不出就退回展示路径本身）。
   *
   * 长路径在窄侧栏里被 `text-overflow: ellipsis` 省略，悬停是确认目标的唯一手段。
   * 候选路径可能是绝对的（工作区外的 M1）、`../` 形态的（M3），也可能是界面自己合成的
   * 「上一层」行（`src/`、`../`、盘根回工作区的**空串**——空串就是 cwd 本身），所以统一
   * 拿这一帧下发的会话 cwd 解析（见 `pathDisplay.ts` 的 `resolveDisplayPath`）。旧宿主
   * 不发 cwd 时退回原样的展示路径，不猜。
   */
  const hoverPath = useCallback(
    (path: string): string | undefined => resolveDisplayPath(fileRefs.cwd, path) ?? (path || undefined),
    [fileRefs.cwd],
  );

  const popover = useMemo(
    () =>
      popoverOpen ? (
        <div className="popover trigger-popover">
          {/* 只有这一层滚（`.popover-list`）：底部提示栏是它的**兄弟**节点，
              列表滑到哪儿都不影响提示常驻（用户 2026-09-25 口径）。 */}
          <div className="popover-list" role="listbox" ref={popoverRef}>
            {candidates.length === 0 ? (
              <>
                <div className="popover-section">
                  {trigger?.kind === "command" ? texts.commands : trigger?.sessionOnly ? texts.mentionSessions : texts.mentionFiles}
                </div>
                <div className="popover-empty">
                  {/* 空的理由分两种：没有工作目录（宿主根本没去取目录）与真的没匹配项。
                      前者说「没有可用命令」会把用户引向错误的方向（见 menuNoWorkspace）。 */}
                  {noWorkspace
                    ? texts.menuNoWorkspace
                    : trigger?.kind === "command"
                      ? texts.commandsEmpty
                      : trigger?.sessionOnly
                        ? texts.mentionSessionsEmpty
                        : texts.mentionEmpty}
                </div>
              </>
            ) : (
              candidates.map((candidate, index) => {
                const isCommand = trigger?.kind === "command";
                const row = candidate as CommandView & FileRefView & SessionRefView;
                // 行的形状（分组、优先完整、是不是「..」/「整个目录」/对话）都由
                // candidateRows 算好：渲染不再自己重推一遍那串 kind 判断
                const shape = rows[index];
                return (
                  <Fragment key={isCommand ? `c:${row.name}` : shape.session ? `s:${row.sessionId}` : `f:${row.path}`}>
                    {shape.showSection ? (
                      <div className="popover-section popover-section-row">
                        <span>{shape.section}</span>
                        {/* 「Tab 进入目录」提示挂在**文件分组标题栏的最右侧**（靠右）：
                            它是这一组目录行的键盘说明，不是某一行的动作按钮——
                            行右侧那个位置留给「整个目录」按钮（见下面）。 */}
                        {!isCommand && shape.section === texts.mentionFiles && hasFolderCandidate ? (
                          <>
                            <span className="spacer" />
                            <span className="popover-drill-hint">
                              <kbd className="popover-item-key">{texts.mentionDrillKey}</kbd>
                              {texts.mentionDrill}
                            </span>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {/* 指针悬停改高亮**只能用 `mousemove`**，不许用 `mouseenter`（官方
                        `MenuView` 同款，理由也一样）：列表为露出键盘选中的那一行而滚动时，
                        浏览器会把 `mouseover` / `mouseenter` **补发**给「刚滚到静止指针底下」
                        的某一行——那等于用一次没有发生的指针移动把键盘的高亮抢回指针那条，
                        紧接着的下一次方向键就从那里继续走（用户 2026-09-25 报的现场：
                        连按 12 次，第 6 次起高亮从 6 跳回指针所在的 2）。
                        `mousemove` 只在指针**真的动了**时派发，滚动伪造不出来。
                        已经是选中行的不用再挂：指针在行内移动会连发 `mousemove`，
                        每次都 `setHighlight` 同一个值纯属白跑。 */}
                    <div
                      className={`popover-item${index === highlight ? " is-selected" : ""}`}
                      // 留屏期间连高亮也不动（`stale`）：这几行是上一次查询的结果，指针扫过去
                      // 先把高亮挪上来、紧接着的 Enter 又被吞掉，等于用一次没有结果的选中骗人。
                      // 官方 `hover` 同样只认 ready 组（`validHighlight` 在 pending 组上返回 null）。
                      onMouseMove={stale || index === highlight ? undefined : () => setHighlight(index)}
                    >
                      {/* 主体：**目录行点它就是打开该目录**（下钻进下一层），
                          文件 / 对话插入引用 token，「..」回上一层。
                          选中**整个目录**由行右侧那枚「整个目录」按钮负责（用户 2026-09-21
                          口径：鼠标点行 = 进目录，想引用整个目录有专门的按钮）；
                          键盘那边仍是官方分工——Enter 选中、Tab 下钻；「..」行例外，
                          它不是可下钻的目标，两把键都回上一层（见 `outcomeFor`）。 */}
                      <button
                        className="popover-item-hit"
                        title={shape.parent ? texts.mentionParent : shape.folder ? texts.mentionDrill : undefined}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          applyCandidate(index, clickAction(shape));
                        }}
                      >
                        {/* 命令名与对话标题走「优先完整」那档样式（`.is-priority`）：宽度不够时
                            先省略右边的描述，绝不把命令截成 `/git-guard…`、把对话截成半个标题。
                            文件路径不做这个标记——长路径必须能省略。
                            省略之后的确认手段是**悬停标题里的完整绝对路径**：路径本身可能是
                            绝对的（`D:/dev/other/x.txt`）或 `../` 形态（工作区外），也可能带
                            一串被省略的目录段——所以拿这一帧的会话 cwd 解析（`resolveDisplayPath`），
                            解析不出就退回原样的展示路径。界面自己合成的「上一层」行走的也是
                            同一条（它的 path 是 `src/` / `../` / 空串，空串就是 cwd 本身）。 */}
                        <span
                          className={`popover-item-main${shape.priority ? " is-priority" : ""}`}
                          title={isCommand || shape.session ? undefined : hoverPath(row.path)}
                        >
                          {isCommand
                            ? `/${row.name}`
                            : shape.session
                              ? row.label
                              : shape.parent
                                ? ".."
                                : row.path}
                        </span>
                        {shape.parent ? (
                          <span className="popover-item-sub">
                            {/* 上一层就是根目录时没有路径可显示，退回说明文案 */}
                            {row.path || texts.mentionParent}
                          </span>
                        ) : isCommand && row.description ? (
                          <span className="popover-item-sub">{row.description}</span>
                        ) : shape.session ? (
                          // 对话候选的次要说明照官方 `sessionCandidate`：非同工作区时给
                          // 工作目录（没有记录给「无工作目录」占位），再接时间。
                          <span className="popover-item-sub">
                            {[
                              row.sameWorkspace
                                ? undefined
                                : row.cwd
                                  ? row.cwd
                                  : texts.mentionNoCwd,
                              row.updatedAt !== undefined ? formatClock(row.updatedAt) : undefined,
                            ]
                              .filter((part): part is string => Boolean(part))
                              .join(" · ")}
                          </span>
                        ) : null}
                        {isCommand && row.skill ? (
                          <span className="popover-item-tag">{texts.skillTag}</span>
                        ) : null}
                      </button>
                      {/* 目录行右侧：**整个目录**——点它就是把目录本身作为 `@dir/` 引用载入。
                          它现在是**鼠标唯一的「选中整个目录」入口**（点行主体是下钻），
                          键盘对应 Enter（见 onKeyDown）；「进入目录」键盘上是 Tab，
                          鼠标上就是点行主体，提示在分组标题栏右侧（见上）。 */}
                      {shape.folder ? (
                        <button
                          className="popover-item-action"
                          title={texts.attachFolder}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            applyCandidate(index, "pick");
                          }}
                        >
                          <IconFolder size={11} />
                          {texts.attachFolder}
                        </button>
                      ) : null}
                    </div>
                  </Fragment>
                );
              })
            )}
          </div>
          <div className="popover-hint">
            {trigger?.kind === "command" ? texts.commandHint : trigger?.sessionOnly ? texts.mentionSessionsHint : texts.mentionHint}
          </div>
        </div>
      ) : null,
    [trigger, stale, candidates, rows, hasFolderCandidate, highlight, texts, noWorkspace, applyCandidate, popoverOpen, hoverPath],
  );

  return {
    popover,
    textareaProps: {
      ref,
      onChange: onEdit,
      onKeyUp: onCaretMove,
      onClick: onCaretMove,
      // 焦点回来也是一次新的编辑动作（清「已关闭」记忆 + 重算触发词，见 `onFocus`）：
      // 少了它，「从框外回来、光标已经在能触发的 @ 块里」一帧都不弹，非得再挪一下光标
      onFocus,
      onKeyDown,
    },
  };
}

/* ============================ 宿主的「插到光标处」 ============================ */

/** 需要在插入内容前补空格吗：前面有内容、且不是空白结尾。 */
function needPrefix(before: string): boolean {
  return before.length > 0 && !/\s$/.test(before);
}

/** 需要在插入内容后补空格吗：后面还有内容、且不是空白开头。 */
function needSuffix(after: string): boolean {
  return after.length > 0 && !/^\s/.test(after);
}

/** 在光标处插入一段文本的结果。 */
export interface InsertResult {
  /** 插入后的完整文本。 */
  value: string;
  /** 插入内容之后的光标位置。 */
  caret: number;
}

/**
 * 把 `insert` 放到 `caret` 处（宿主下发的路径 / 引用插入走这条路）。
 *
 * - `caret` 会被夹到 `[0, value.length]`，越界不抛错（调用方可能传来过期的位置）；
 * - 前后按需补一个空格，让插入结果与已有文字自然分开（避免 `text"C:\x"` 粘连）；
 * - 返回的新光标落在插入内容之后，用户可以直接接着打字。
 *
 * 与 `caretAfterInsert` 的区别：那边是「把认出来的触发词整段换掉」（不多补空格），
 * 这边是「在光标处塞一段新文本」（要补空格），两条不同的光标算术，别混用。
 */
export function insertToken(value: string, insert: string, caret: number): InsertResult {
  const at = clampIndex(caret, value.length);
  const before = value.slice(0, at);
  const after = value.slice(at);
  const body = `${needPrefix(before) ? " " : ""}${insert}${needSuffix(after) ? " " : ""}`;
  return { value: `${before}${body}${after}`, caret: before.length + body.length };
}

/**
 * 把一段**选中的文字**以 markdown 引用块插到 `caret` 处（正文右键菜单的「引用」）。
 *
 * 与 `insertToken` 是两条不同的拼接口径，别混用：
 * - 那边是**行内**插入一段 token（前后按需补空格，插完接着写字还在同一行）；
 * - 这边是**块**插入：引用块要自己占整行（用户 2026-09-23 口径「换行成单独的引用块」），
 *   所以前面不在行首就补一个换行，后面再补一个换行让光标落在引用块**之外**——
 *   否则用户接着敲的字会被并进引用里。
 *
 * 引用内部的空行也带上 `>`：markdown 的引用块靠连续 `>` 行界定，中间留一个裸空行
 * 会把块切断。
 */
export function quoteBlock(value: string, quote: string, caret: number): InsertResult {
  const at = clampIndex(caret, value.length);
  const before = value.slice(0, at);
  const after = value.slice(at);
  const body = quote
    .replace(/\r\n?/g, "\n")
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");
  const lead = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
  const tail = after.startsWith("\n") ? "" : "\n";
  const inserted = `${lead}${body}${tail}`;
  return { value: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
