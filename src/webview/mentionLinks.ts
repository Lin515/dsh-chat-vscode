/**
 * 正文里 `@` 引用的**可点目标**：`@文件`、`@目录/`、`@会话` 各点开什么。
 *
 * 三类来源：
 *
 * 1. **文件 / 目录**——官方 `file-reference` 的语法：`@` 后跟非空白（`@src/a.ts`）、
 *    含空白时用引号（`@"my file.txt"`）、目录以结尾 `/` 标记（`@src/`）、
 *    行号区间按 `#L12` / `#L12-L40` 挂在末尾（见 `shared/mentions.ts` 的
 *    `formatFileMentionWithLines`）；
 * 2. **会话（草稿里那条还没发出去的形态）**——`@[标题](dsh-session:…)` 与裸
 *    `dsh-session:…`，模式与显示还原**同源**（`shared/mentions.ts` 的
 *    `sessionMentionPattern`）：输入框（以及刚提交、还没被服务端折过的那一帧）里就是
 *    那条给服务端看的原始 token，界面把它折成 `@标题` 并挂上会话 id；
 * 3. **会话（已经发出去、落盘时被服务端折过的形态）**——正文里只剩 `@标题`，会话 id 在
 *    `MessageView.sessionRefs` 里（服务端紧随消息的召回事件给的，见
 *    `shared/injectedSource.ts` 的 `parseRecalledSessionRefs`）。这一档**必须**拿到那份
 *    清单才认：同样的 `@标题` 没有任何证据时，按形状只是一个路径引用（见 {@link refSpanAt}）。
 *
 * 判定一律按**肯定证据**，三类各有一条：
 * - 文件的 token 边界与官方一样是「行首或空白之后」，且路径形状要过得去
 *   （见 `looksLikePath`）——于是 `foo@bar.com`、正文里的 `@2x` 这类保持普通文本；
 * - 草稿形态的会话必须有**解得开**的 id（{@link decodeSessionReferenceUri}）：解不开的
 *   仍然按显示形态折成 `@标题`，但**不做成链接**（点了也不知道该开哪一条）；
 * - 已发出形态的会话必须有 `sessionRefs` 里**逐字相同**的那条标题。
 *
 * 打开动作只有一份（`mentionOpen.ts`）：本模块只回答「哪一段文字指向哪个目标」，
 * 转写里的链接与草稿区的 Ctrl+单击共用它。
 *
 * 纯函数、不碰 DOM 也不引 React：断言见 `scripts/mentionLinks.test.ts`。
 */
import { sessionMentionPattern, decodeSessionReferenceUri } from "../shared/mentions";
import type { MessageSessionRef } from "../shared/chat";
import { parseFileLink } from "./fileLinks";

/** 一条 `@` 引用点开之后要做什么。 */
export type MentionLinkTarget =
  /** 文件：`line` 是 1 基起始行（引用带 `#L12` 时给）。 */
  | { kind: "file"; path: string; line?: number }
  /** 目录：在资源管理器里展开（路径保留结尾 `/`，与引用原文一致）。 */
  | { kind: "directory"; path: string }
  /** 会话：新开一个会话标签打开它。 */
  | { kind: "session"; sessionId: string };

/** 正文里一段 `@` 引用的位置与目标（`[start, end)` 是它在原文里的区间）。 */
export interface MentionLinkSpan {
  /** 起始下标（含 `@`；裸 `dsh-session:` 形态没有 `@`）。 */
  start: number;
  /** 结束下标（不含）。 */
  end: number;
  /** 显示用文本：文件 / 目录就是原文那一段，会话引用折成 `@标题`。 */
  text: string;
  /** 点开的目标；**缺省**表示这段只做显示还原（会话 id 解不开），不可点。 */
  target?: MentionLinkTarget;
}

/**
 * 裸 token 尾部要剥掉的**标点**（不是路径的一部分）。
 *
 * 正文里的引用常被句子包着：「见 @src/a.ts。」「(@src/a.ts)」「@AGENTS.md.」。
 * 路径本身几乎不会以这些字符收尾（真要是这种文件名，写引用时用引号形态即可）。
 * 只剥**尾部**，中间的标点不动——`@a(b).ts` 这类由 {@link looksLikePath} 拦下。
 */
const TRAILING_PUNCTUATION = new Set([
  ".", ",", ";", ":", "!", "?", ")", "]", "}", ">", "\"", "'", "`", "*",
  "。", "，", "、", "；", "：", "！", "？", "）", "】", "》", "」", "』", "”", "’",
]);

/**
 * 路径里**不会出现**的字符（出现了就说明这段文字不是路径）。
 *
 * 方括号与圆括号在正文里是 markdown 语法（`@[不是引用](https://…)`），引号是
 * 说话的一部分——把它们认成路径会造出点不开的假链接。真正含这些字符的文件名
 * 在引用时本就该用引号形态（`@"a(b).ts"`），那种走引号分支，不过这一关。
 */
const NOT_A_PATH = /[[\](){}<>|"`]/u;

/** `at` 处的 `@` 是不是一个引用的开头（行首、空白或标点之后——邮箱里的 `@` 不是）。 */
function isMentionBoundary(text: string, at: number): boolean {
  if (at <= 0) return true;
  return !/[\p{L}\p{N}_.\\/-]/u.test(text[at - 1] ?? "");
}

/**
 * 剥掉尾部标点之后，这段 token 还像不像一个路径。
 *
 * 与 `webview/fileLinks.ts` 的 `parseFileLink` 同一口径的否定条件（scheme / UNC /
 * 控制字符）由它兜住，这里只管「形状」：不能为空、不能是 `.` / `..` 这类相对段、
 * 不能含路径里不会出现的字符。
 */
function looksLikePath(body: string): boolean {
  if (!body || body === "." || body === "..") return false;
  return !NOT_A_PATH.test(body);
}

/** 从 `@` 开始的**文件 / 目录** token：给出目标与结束下标；不成形时 undefined。 */
function fileTargetAt(
  text: string,
  at: number,
): { end: number; target: MentionLinkTarget } | undefined {
  const rest = text.slice(at);
  const quoted = /^@"([^"\n]*)("?)/u.exec(rest);
  let body: string;
  let end: number;
  if (quoted) {
    // 引号形态：含空白的路径（官方对目录还会只写开引号，未闭合时取到行尾）
    body = quoted[1] ?? "";
    end = at + (quoted[0]?.length ?? 0);
  } else {
    const bare = /^@(\S*)/u.exec(rest);
    body = bare?.[1] ?? "";
    // 尾部标点属于句子，不属于引用（`见 @src/a.ts。`）
    let cut = body.length;
    while (cut > 0 && TRAILING_PUNCTUATION.has(body[cut - 1] ?? "")) cut -= 1;
    body = body.slice(0, cut);
    end = at + 1 + cut;
  }
  if (!looksLikePath(body)) return undefined;
  const parsed = parseFileLink(body);
  if (!parsed) return undefined;
  // 目录：结尾 `/`（官方的目录标记），引号形态同样成立（`@"my dir/"`）
  if (parsed.path.endsWith("/") || parsed.path.endsWith("\\")) {
    return { end, target: { kind: "directory", path: parsed.path } };
  }
  return {
    end,
    target: { kind: "file", path: parsed.path, ...(parsed.line === undefined ? {} : { line: parsed.line }) },
  };
}

/**
 * 扫描正文里全部的 `@` 引用。
 *
 * 返回的区间**互不重叠、按出现顺序**排列，且覆盖原文的每一段（中间那些普通文本
 * 由调用方按区间自己切）——见 `Message.tsx` 的 `renderMentionText`。
 *
 * @param text 正文（草稿或某条消息的原文）。
 * @param sessionRefs 这条正文里**已经发出去**的会话引用（`MessageView.sessionRefs`）；
 *   只有消息气泡拿得到它，草稿（里面是原始 token）不需要。
 */
export function scanMentionLinks(
  text: string,
  sessionRefs?: readonly MessageSessionRef[],
): MentionLinkSpan[] {
  const spans: MentionLinkSpan[] = [];
  const session = sessionMentionPattern();
  const refs = sessionRefs === undefined || sessionRefs.length === 0
    ? undefined
    : [...sessionRefs].sort((left, right) => right.label.length - left.label.length);
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "@" && refs !== undefined) {
      const ref = refSpanAt(text, at, refs);
      if (ref !== undefined) {
        spans.push(ref);
        at = ref.end - 1;
        continue;
      }
    }
    // 会话引用的两种形态都以这两个字面量开头；不先判一次就会在每个下标上跑一遍
    // 全文搜索（`exec` 会一直往后找），一条长消息上就是平方级
    if (text[at] === "@" || text.startsWith("dsh-session:", at)) {
      const sessionMatch = matchSessionAt(session, text, at);
      if (sessionMatch) {
        spans.push(sessionMatch);
        at = sessionMatch.end - 1;
        continue;
      }
    }
    if (text[at] !== "@") continue;
    if (!isMentionBoundary(text, at)) continue;
    // 落到这里的只剩文件 / 目录：路径形状与行号锚点在 `fileTargetAt` 里判
    const file = fileTargetAt(text, at);
    if (!file) continue;
    spans.push({ start: at, end: file.end, text: text.slice(at, file.end), target: file.target });
    at = file.end - 1;
  }
  return spans;
}

/**
 * 从 `at` 起是不是一条**已经发出去的**会话引用（落盘正文里被折成了 `@标题`）。
 *
 * 只做「正文这一点起就是那条标题」的**字面比对**：标题与 id 都来自紧随消息的召回事件，
 * 不是从形状猜的。命中就把整段 `@标题` 认成会话，不再让它落到「按形状当路径」那一档
 * （那正是用户 2026-10-10 报的「发出去的会话引用被识别为文件链接」）。
 *
 * 与官方同一条口径：`dsh-client-ui-primitives` 的 `projectUserText` 先按
 * `referenceLabels` 找 `@标题`、命中的区间标成会话，之后按形状的那一档按游标跳过与它
 * 重叠的区间。标题也照官方**长的先认**（`@会话` 与 `@会话 2` 并存时不会认错）。
 */
function refSpanAt(
  text: string,
  at: number,
  refs: readonly MessageSessionRef[],
): MentionLinkSpan | undefined {
  if (!isMentionBoundary(text, at)) return undefined;
  for (const ref of refs) {
    if (ref.label === "" || !text.startsWith(ref.label, at + 1)) continue;
    return {
      start: at,
      end: at + 1 + ref.label.length,
      text: `@${ref.label}`,
      // id 认不出来时只做显示（官方正文里的会话引用本来也只是个标签，点不开）
      ...(ref.sessionId === undefined ? {} : { target: { kind: "session", sessionId: ref.sessionId } as const }),
    };
  }
  return undefined;
}

/** 从 `at` 起是不是一条会话引用（没有 `@` 的裸形态也算）。 */
function matchSessionAt(pattern: RegExp, text: string, at: number): MentionLinkSpan | undefined {
  // 裸形态也要边界：`seedsh-session:x` 里的后半截不是引用
  if (!isMentionBoundary(text, at)) return undefined;
  pattern.lastIndex = at;
  const match = pattern.exec(text);
  if (!match || match.index !== at) return undefined;
  const rawLabel = match[1];
  const uri = match[2] ?? match[3];
  if (uri === undefined) return undefined;
  const label = rawLabel === undefined ? uri.slice("dsh-session:".length) : rawLabel.replace(/\\(.)/gu, "$1");
  const sessionId = decodeSessionReferenceUri(uri);
  return {
    start: at,
    end: at + match[0].length,
    text: `@${label}`,
    ...(sessionId === undefined ? {} : { target: { kind: "session", sessionId } as const }),
  };
}

/**
 * 光标 / 点击落在哪一条引用上（草稿区的 Ctrl+单击按这个判）。
 *
 * 区间按**闭区间**判定（`start <= index <= end`）：点在 token 最后一个字符的右边缘
 * 时光标会落在 `end` 上，那一下显然还是冲着这条引用来的。相邻两条引用之间至少隔着
 * 一个边界字符（`@a@b` 里的第二个 `@` 前面是 `a`，不成 token），所以闭区间不会同时
 * 命中两条。
 *
 * 不可点的段（会话 id 解不开）**不算命中**：调用方据此既不给提示也不打开。
 */
export function mentionAt(text: string, index: number): MentionLinkSpan | undefined {
  if (!Number.isFinite(index)) return undefined;
  const at = Math.trunc(index);
  return scanMentionLinks(text).find(
    (span) => span.target !== undefined && span.start <= at && at <= span.end,
  );
}

/**
 * 把一段正文里的引用换成**给人看的那份文本**（原始 token → 显示文本）。
 *
 * 正文里可能是两种形态：**已经发出**的消息里服务端已经折好了（`@[标题](dsh-session:…)`
 * → `@标题`），而队列条目、用户手写的裸 URI、折过之前的历史快照里仍是**给服务端看的
 * 原始 token**。凡是把消息正文当**纯文本**用的地方都要先过这一道，否则用户看到的是带
 * base64 会话 id 的长 token：复制按钮（`components/Message.tsx`）与轮次大纲的提问预览
 * （`turnRail.ts`）、队列行预览（`components/Composer.tsx`）都是；已经是可读形态的
 * 正文过这一道原样返回。
 *
 * 文件 / 目录引用的 `span.text` 就是原文那一段（`@src/a.ts`、`@src/`），所以那两档
 * 原样保留；一条都扫不到时原样返回。
 */
export function readableMentionText(text: string): string {
  const spans = scanMentionLinks(text);
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + span.text;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}
