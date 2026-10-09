/**
 * 正文里 `@` 引用的**可点目标**：`@文件`、`@目录/`、`@会话` 各点开什么。
 *
 * 两类来源（都是用户自己写进正文的引用，不是「看起来像路径的文本」）：
 *
 * 1. **文件 / 目录**——官方 `file-reference` 的语法：`@` 后跟非空白（`@src/a.ts`）、
 *    含空白时用引号（`@"my file.txt"`）、目录以结尾 `/` 标记（`@src/`）、
 *    行号区间按 `#L12` / `#L12-L40` 挂在末尾（见 `shared/mentions.ts` 的
 *    `formatFileMentionWithLines`）；
 * 2. **会话**——`@[标题](dsh-session:…)` 与裸 `dsh-session:…`，模式与显示还原
 *    **同源**（`shared/mentions.ts` 的 `sessionMentionPattern`）：正文里落盘的
 *    是那条给服务端看的原始 token，界面把它折成 `@标题` 并挂上会话 id。
 *
 * 判定一律按**肯定证据**，两类各有一条：
 * - 文件的 token 边界与官方一样是「行首或空白之后」，且路径形状要过得去
 *   （见 `looksLikePath`）——于是 `foo@bar.com`、正文里的 `@2x` 这类保持普通文本；
 * - 会话必须有**解得开**的 id（{@link decodeSessionReferenceUri}）：解不开的仍然
 *   按显示形态折成 `@标题`，但**不做成链接**（点了也不知道该开哪一条）。
 *
 * 打开动作只有一份（`mentionOpen.ts`）：本模块只回答「哪一段文字指向哪个目标」，
 * 转写里的链接与草稿区的 Ctrl+单击共用它。
 *
 * 纯函数、不碰 DOM 也不引 React：断言见 `scripts/mentionLinks.test.ts`。
 */
import { sessionMentionPattern, decodeSessionReferenceUri } from "../shared/mentions";
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
 */
export function scanMentionLinks(text: string): MentionLinkSpan[] {
  const spans: MentionLinkSpan[] = [];
  const session = sessionMentionPattern();
  for (let at = 0; at < text.length; at += 1) {
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
    // 会话引用：`@` 开头的 markdown 形态（引文里那条规范 token）
    const file = fileTargetAt(text, at);
    if (!file) continue;
    spans.push({ start: at, end: file.end, text: text.slice(at, file.end), target: file.target });
    at = file.end - 1;
  }
  return spans;
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
 * durable 事件里存的是**给服务端看的原始 token**（会话引用是
 * `@[标题](dsh-session:…)`），界面上显示的却是折好的 `@标题`。凡是把消息正文当
 * **纯文本**用的地方都要先过这一道，否则用户看到的是带 base64 会话 id 的长 token：
 * 复制按钮（`components/Message.tsx`）与轮次大纲的提问预览（`turnRail.ts`）都是。
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
