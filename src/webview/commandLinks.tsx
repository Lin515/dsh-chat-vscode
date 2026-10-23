/** `/` 的目录识别、官方描述与打开端口；不参与发送路由。 */
import { createContext, useContext } from "react";
import type { CommandView } from "../shared/chat";
import type { Texts } from "./texts";
import type { DraftEditRange } from "./composerSessionDraft";
import type { MentionLinkSpan } from "./mentionLinks";

const OFFICIAL_DESCRIPTIONS = new Map<string, keyof Pick<Texts,
  "commandGoalDescription" | "commandPlanDescription" | "commandFeedbackDescription" |
  "commandCompactDescription" | "commandPermissionDescription" | "commandExportDescription">>([
  ["@deepseek-ai/dsh-command-goal", "commandGoalDescription"],
  ["@deepseek-ai/dsh-plan-mode", "commandPlanDescription"],
  ["@deepseek-ai/dsh-command-feedback", "commandFeedbackDescription"],
  ["@deepseek-ai/dsh-command-compact", "commandCompactDescription"],
  ["@deepseek-ai/dsh-permission-presets", "commandPermissionDescription"],
  ["@deepseek-ai/dsh-session-log-export", "commandExportDescription"],
]);

/** 与官方 Web 相同，按 definitionId 选词典；第三方和技能保留其单语言原文。 */
export function commandDescription(command: CommandView, texts: Texts): string {
  const key = command.skill ? undefined : OFFICIAL_DESCRIPTIONS.get(command.definitionId ?? "");
  return (key ? texts[key] : undefined) || command.description;
}

export interface CommandMenuRequest {
  id: number;
  query: string;
  /** 草稿点击时定位该 token；转写点击时不指定，插入当前光标处再展开补全。 */
  range?: DraftEditRange;
}
export interface CommandLinksPort {
  commands: readonly CommandView[];
  request?: CommandMenuRequest;
  acknowledge?: (id: number) => void;
  openMenu: (query: string, range?: DraftEditRange) => void;
}
export const CommandLinksContext = createContext<CommandLinksPort>({ commands: [], openMenu: () => {} });
export const useCommandLinks = () => useContext(CommandLinksContext);

/** 只认目录中完整名字；路径、URL、未知命令不凭形状染色，@ 区间由调用方优先保留。 */
export function scanCommandLinks(text: string, commands: readonly CommandView[]): MentionLinkSpan[] {
  const catalog = new Map<string, CommandView>();
  for (const command of commands) {
    const existing = catalog.get(command.name);
    if (!existing || (existing.skill && !command.skill)) catalog.set(command.name, command);
  }
  const spans: MentionLinkSpan[] = [];
  for (const match of text.matchAll(/\/([\p{L}\p{N}_-]+)/gu)) {
    const start = match.index;
    const name = match[1] ?? "";
    const end = start + name.length + 1;
    if (!isCommandTokenStart(text, start) || !isCommandTokenEnd(text, end)) continue;
    const command = catalog.get(name);
    if (!command) continue;
    spans.push({ start, end, text: `/${name}`,
      target: command.skill
        ? command.skillPath ? { kind: "file", path: command.skillPath } : undefined
        : { kind: "command", name } });
  }
  return spans;
}

/**
 * 命令 token 的**前界**：行首、空白，或句子的包装标点。
 *
 * 用户报障（`(/plan)` 能点但不出菜单）的根因是扫描与输入框触发各写了一套边界：
 * 扫描只多认了左圆括号，触发只认行首 / 空白。这里收成唯一判据，`findTrigger`
 * 与 `scanCommandLinks` 都读它。
 *
 * 为什么是**白名单**而不是「不是路径字符就行」：`https://host/plan`、`C:/plan`、
 * `src/plan` 的 `/plan` 前面分别是 `t`、`:`、`c`，白名单天然排除；`@/plan` 的 `@`
 * 也不在表里。`_` 刻意**不**在白名单：它本身就是合法命令名字符（`__/plan__`
 * 里那一段不能当成一条命令，完整名歧义优先）。
 *
 * `](/plan)` 是 markdown / mention 的链接目标而不是正文命令，单看左圆括号会误认；
 * 这一处按「`(`/`（` 前是 `]`/`】`」排除。
 */
export function isCommandTokenStart(text: string, index: number): boolean {
  if (index <= 0) return true;
  const previous = text[index - 1] ?? "";
  if (previous === "(" && (text[index - 2] === "]" || text[index - 2] === "】")) return false;
  if (previous === "（" && (text[index - 2] === "]" || text[index - 2] === "】")) return false;
  return /\s/u.test(previous) || COMMAND_TOKEN_OPENERS.has(previous);
}

/** 句子的包装标点：引号、括号、书名号与 markdown 的 `**` / 反引号。 */
const COMMAND_TOKEN_OPENERS = new Set([
  "(", "[", "{",
  "（", "【", "「", "『", "《", "〈",
  "\"", "'", "`", "*",
  "“", "‘",
]);

/**
 * 命令名之后必须断在这里：字母数字下划线、路径分隔符、或「点 + 名字字符」都说明
 * 这一段不是完整命令（`/plan.md`、`/plan/file`、`/planner`、`/plan_x` 都不染色）。
 *
 * 与 `isCommandTokenStart` 一样被扫描与点击后的 range 复核共用，避免两处各写一条
 * 后界（旧实现的后界只活在扫描正则里）。
 */
const COMMAND_TOKEN_CONTINUATION = /^(?:[\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}_.-])/u;

export function isCommandTokenEnd(text: string, end: number): boolean {
  return !COMMAND_TOKEN_CONTINUATION.test(text.slice(end));
}
