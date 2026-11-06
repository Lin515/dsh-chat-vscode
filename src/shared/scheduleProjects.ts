/**
 * 自动化任务「创建目录」候选的**纯函数**（宿主与 webview 共用，浏览器安全）。
 *
 * 来源是官方 Workspace 注册表（`workspace/follow` 的 `WorkspaceView`），不是
 * `session/list` 里的 `cwd`：会话列表只带「已经有会话」的目录，已注册但还没有会话的
 * Workspace 会在界面上凭空消失。这里把注册表折成官方 `projectChoices` 同口径的候选：
 *
 * - **注册表在前、顺序照原样**（注册表本身就是官方 Workspace 列表的顺序）；
 * - 会话 `cwd` 只作**旧端点兼容的回退**，补在注册表之后，并去掉已经出现过的目录；
 * - 默认目录取「标题仍是 `default-workspace` 的那条」，否则取注册表第一条，再没有就是
 *   空串（与服务端「未指定目录」的语义一致，不拿会话 cwd 冒充注册表默认值）；
 * - 空路径不是候选；空标题退回显示路径。判重按 `workspacePathKey`（Windows 两种分隔符
 *   视为同一拼写；不转小写、不消 `.` / `..`，理由见 `workspacePath.ts`）。
 *
 * 官方出处：`@deepseek-ai/dsh-client-ui-schedule` 的 `TaskEditorFields.tsx`
 * (`projectChoices`) 与 `dsh-api-workspace-controller/default-workspace`
 * (`DEFAULT_WORKSPACE_DIRECTORY` / `workspaceDisplayTitle`)。
 */
import type { ScheduleProjectView } from "./chat";
import { workspacePathKey } from "./workspacePath";

/** 官方 `DEFAULT_WORKSPACE_DIRECTORY`：自动创建的首个 Workspace 的标题。 */
export const DEFAULT_WORKSPACE_TITLE = "default-workspace";

/** 下拉框的一项（与 `shared/schedule.ts` 的目录候选同形）。 */
export interface ScheduleProjectChoice {
  value: string;
  label: string;
}

/** 目录候选与「新目标默认落到哪」——官方 `ProjectChoices` 的同形结果。 */
export interface ScheduleProjectChoices {
  items: ScheduleProjectChoice[];
  /**
   * 新目录默认值：默认 Workspace，其次注册表第一条；没有注册表时是空串。
   *
   * **空串表示「不显式指定目录」**（服务端按自己的默认工作区建会话），不是某个
   * 空路径候选。调用方不要把它塞进候选表。
   */
  defaultCwd: string;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * 一条候选的收窄；认不出返回 `undefined`（整条丢弃，不编路径）。
 *
 * `title` 缺失是合法的：旧服务端的注册表行可能没有标题，界面按路径显示。
 */
function projectFromWire(value: unknown): ScheduleProjectView | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as { path?: unknown; title?: unknown };
  const path = text(raw.path);
  if (path === undefined) return undefined;
  const title = text(raw.title);
  return title === undefined ? { path } : { path, title };
}

/**
 * 一帧里的候选表收窄。
 *
 * `undefined` = **这一帧没有候选表**（未知 / 旧宿主），与空数组「注册表明确为空」
 * 严格分开：调用方据此决定要不要保留旧候选来源。坏条目逐条丢弃，不整份拒绝。
 */
export function scheduleProjectsFromWire(value: unknown): ScheduleProjectView[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const projects: ScheduleProjectView[] = [];
  for (const raw of value) {
    const project = projectFromWire(raw);
    if (project === undefined) continue;
    const key = workspacePathKey(project.path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
  }
  return projects;
}

/**
 * 注册 Workspace + 会话 cwd → 下拉候选。
 *
 * @param projects 注册表投影；`undefined` = 还不知道（旧服务端 / 断线清理后）。
 * @param sessionCwds 会话列表里出现过的目录（旧端点兼容的回退来源）。
 * @param defaultName 自动标题的显示名（官方按语言传入；本仓库没有登记这份文案时
 *   用官方英文标题，界面仍能选中它）。
 */
export function scheduleProjectChoices(
  projects: readonly ScheduleProjectView[] | undefined,
  sessionCwds: readonly (string | undefined)[],
  defaultName: string = DEFAULT_WORKSPACE_TITLE,
): ScheduleProjectChoices {
  const items: ScheduleProjectChoice[] = [];
  const seen = new Set<string>();
  const push = (path: string, label: string): void => {
    const key = workspacePathKey(path);
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ value: path, label });
  };
  const registered = scheduleProjectsFromWire(projects) ?? [];
  let defaultCwd = "";
  for (const project of registered) {
    const title = project.title;
    push(project.path, title === undefined ? project.path : title === DEFAULT_WORKSPACE_TITLE ? defaultName : title);
    if (defaultCwd === "" && title === DEFAULT_WORKSPACE_TITLE) defaultCwd = project.path;
  }
  if (defaultCwd === "" && registered.length > 0) defaultCwd = registered[0].path;
  // 旧端点兼容：注册表缺这条目录（或整份注册表还没有到）时，会话里真实用过的 cwd
  // 仍可选。已经由注册表给出的同一拼写不再重复。
  for (const cwd of sessionCwds) {
    if (text(cwd) === undefined) continue;
    push(cwd as string, cwd as string);
  }
  return { items, defaultCwd };
}
