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
  for (const match of text.matchAll(/(^|[\s（(])\/([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_/\\-]|\.[\p{L}\p{N}_.-])/gu)) {
    const name = match[2] ?? "";
    const command = catalog.get(name);
    if (!command) continue;
    const start = match.index + (match[1]?.length ?? 0);
    spans.push({ start, end: start + name.length + 1, text: `/${name}`,
      target: command.skill
        ? command.skillPath ? { kind: "file", path: command.skillPath } : undefined
        : { kind: "command", name } });
  }
  return spans;
}
