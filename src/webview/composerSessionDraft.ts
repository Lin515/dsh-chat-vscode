/**
 * 会话引用草稿的唯一端口：文本域只编辑 @标题，持久化和发送仍使用原始确定性 token。
 * 绑定按区间而不是按标题保存（同名会话也不串线）；标题被编辑后立即丢弃旧身份。
 * 失效区间继续作为完整标题查询，包含空白、标点和路径分隔符时也不退回原始格式。
 */
import { decodeSessionReferenceUri, sessionMentionPattern } from "../shared/mentions";
import { draftSegments, type DraftSegment } from "./composerMention";
import { scanMentionLinks, type MentionLinkTarget } from "./mentionLinks";
import { scanCommandLinks } from "./commandLinks";
import type { CommandView } from "../shared/chat";

interface SessionBlock {
  start: number;
  end: number;
  token?: string;
  sessionId?: string;
}

export interface DraftEditRange { start: number; end: number }
export interface SessionDraftQuery {
  start: number;
  end: number;
  query: string;
  sessionOnly: true;
}

export class ComposerSessionDraft {
  text = "";
  raw = "";
  private blocks: SessionBlock[] = [];
  private owner?: string;

  /** 外部草稿还原或切会话时重新建账；本端口刚写出的回声不丢失待匹配区间。 */
  sync(raw: string, owner?: string): void {
    if (this.owner === owner && raw === this.raw) return;
    this.owner = owner;
    this.blocks = [];
    this.text = "";
    this.raw = "";
    this.write(raw, raw.length);
  }

  /** 更新可编辑文本，返回折叠后的光标；range 是 beforeinput 捕获的原选区。 */
  write(value: string, caret: number, range?: DraftEditRange): { text: string; raw: string; caret: number } {
    const old = this.text;
    let start = 0;
    while (start < old.length && start < value.length && old[start] === value[start]) start += 1;
    let end = old.length;
    let nextEnd = value.length;
    while (end > start && nextEnd > start && old[end - 1] === value[nextEnd - 1]) {
      end -= 1;
      nextEnd -= 1;
    }
    // 原选区能消除重复字符的差分歧义，也能识别「选中后重输同样的标题」。
    if (range && range.start >= 0 && range.end >= range.start && range.end <= old.length &&
        value.length >= range.start + old.length - range.end &&
        old.slice(0, range.start) === value.slice(0, range.start) &&
        old.slice(range.end) === value.slice(value.length - (old.length - range.end))) {
      start = range.start;
      end = range.end;
      nextEnd = value.length - (old.length - end);
    }
    const delta = value.length - old.length;
    const changed = old !== value || (range !== undefined && range.start !== range.end);
    const moved: SessionBlock[] = [];
    for (const block of this.blocks) {
      if (!changed || end <= block.start) {
        moved.push({ ...block, start: block.start + (changed ? delta : 0), end: block.end + (changed ? delta : 0) });
      } else if (start >= block.end && !(start === block.end && nextEnd > start && !/^\s/u.test(value.slice(start, nextEnd)))) {
        moved.push(block);
      } else if (start >= block.start && end <= block.end && value[block.start] === "@") {
        // 只保留标题区间，绝不把旧 token 带到编辑后的标题里。
        moved.push({ start: block.start, end: block.end + delta });
      }
    }

    // 新插入 / 粘贴的规范 token 也走同一折叠路径；无效负载不凭形状绑定。
    let text = value;
    let cursor = 0;
    let at = caret;
    // 从右向左折叠：左侧 token 的原始坐标不受右侧折叠影响。
    for (const match of [...value.matchAll(sessionMentionPattern())].reverse()) {
      const token = match[0];
      const sessionId = decodeSessionReferenceUri(match[2] ?? "");
      if (match[1] === undefined || sessionId === undefined) continue;
      const from = match.index;
      const to = from + token.length;
      const title = `@${match[1].replace(/\\(.)/gu, "$1")}`;
      text = text.slice(0, from) + title + text.slice(to);
      const shrink = title.length - token.length;
      if (at >= to) at += shrink;
      else if (at > from) at = from + Math.min(at - from, title.length);
      for (const block of moved) {
        if (block.end <= from) continue;
        if (block.start >= to) { block.start += shrink; block.end += shrink; }
        else { block.start = -1; block.end = -1; }
      }
      moved.push({ start: from, end: from + title.length, token, sessionId });
    }
    this.text = text;
    this.blocks = moved.filter((block) => block.start >= 0 && text[block.start] === "@")
      .sort((a, b) => a.start - b.start);
    let raw = "";
    cursor = 0;
    for (const block of this.blocks) {
      if (block.token === undefined) continue;
      raw += text.slice(cursor, block.start) + block.token;
      cursor = block.end;
    }
    this.raw = raw + text.slice(cursor);
    return { text, raw: this.raw, caret: Math.max(0, Math.min(text.length, at)) };
  }

  /** null 表示已绑定块，undefined 表示普通文本，由补全模块按原有规则处理。 */
  queryAt(caret: number): SessionDraftQuery | null | undefined {
    const block = this.blocks.find((item) => caret > item.start && caret <= item.end);
    if (!block) return undefined;
    if (block.token !== undefined) return null;
    return { start: block.start, end: block.end, query: this.text.slice(block.start + 1, block.end), sessionOnly: true };
  }

  /** 镜像与 Ctrl 点击共用的精确目标，失效标题不能被误当作文件路径。 */
  targetAt(caret: number, commands: readonly CommandView[] = []): MentionLinkTarget | undefined {
    const block = this.blocks.find((item) => caret >= item.start && caret <= item.end);
    if (block) return block.sessionId ? { kind: "session", sessionId: block.sessionId } : undefined;
    const mention = scanMentionLinks(this.text).find((span) => caret >= span.start && caret <= span.end);
    if (mention) return mention.target;
    return scanCommandLinks(this.text, commands).find((span) => caret >= span.start && caret <= span.end)?.target;
  }

  segments(commands: readonly CommandView[] = []): DraftSegment[] {
    const out: DraftSegment[] = [];
    let cursor = 0;
    const append = (start: number, end: number) => {
      out.push(...draftSegments(this.text.slice(start, end), commands).map((segment) => ({ ...segment, at: segment.at + start })));
    };
    for (const block of this.blocks) {
      append(cursor, block.start);
      out.push({ text: this.text.slice(block.start, block.end), at: block.start, link: block.sessionId !== undefined });
      cursor = block.end;
    }
    append(cursor, this.text.length);
    return out;
  }
}
