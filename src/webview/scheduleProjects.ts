/**
 * webview 侧的**注册 Workspace 候选**镜像（自动化任务的创建目录）。
 *
 * 数据来自宿主 `ChatState.scheduleProjects`：`workspace/follow` 的注册表在宿主折成
 * 候选表后，随首帧 / 增量 patch 过线。这里不复制宿主逻辑——只做三件事：
 *
 * - **收窄**：非数组 / 坏条目一律不认（`scheduleProjectsFromWire`），`null` 与缺键
 *   都表示「还没有权威注册表」；
 * - **连接清理**：`images/scope` 的执行世界换代意味着候选属于**上一条连接**，清掉；
 *   宿主在连接清理时也会发一帧 `null`，两条路径互不依赖；
 * - **订阅**：用 `useSyncExternalStore` 让表单随注册表变化重渲染，不把候选混进
 *   会话状态机（它是部署级事实，切会话不该换掉）。
 *
 * 为什么不经过 `App.tsx` / `state.ts`：候选只服务自动化任务这一条链，和
 * `localImages.ts` 的范围版本一样，用专用 store 读原始帧即可；会话状态机不需要
 * 为它多一个 reducer 分支。
 */
import { useSyncExternalStore } from "react";
import type { ScheduleProjectView } from "../shared/chat";
import { scheduleProjectsFromWire } from "../shared/scheduleProjects";
import { subscribe } from "./bridge";

/** `useSyncExternalStore` 的快照：项目数组按引用稳定，只有真变化才换新对象。 */
export interface ScheduleProjectsSnapshot {
  /** 单调递增的版本号（同一份快照内不变）。 */
  version: number;
  /** `undefined` = 没有权威注册表；`[]` = 注册表明确为空。 */
  projects: ScheduleProjectView[] | undefined;
}

let version = 0;
let projects: ScheduleProjectView[] | undefined;
let snapshot: ScheduleProjectsSnapshot = { version, projects };

/** 执行世界连接号；`undefined` = 还没收到 `images/scope`。 */
let connectionId: string | null | undefined;

const listeners = new Set<() => void>();

function sameProjects(left: ScheduleProjectView[] | undefined, right: ScheduleProjectView[] | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((project, index) => {
    const other = right[index];
    return other !== undefined && project.path === other.path && project.title === other.title;
  });
}

function apply(next: ScheduleProjectView[] | undefined): void {
  if (sameProjects(projects, next)) return;
  projects = next;
  version += 1;
  snapshot = { version, projects };
  for (const listener of listeners) listener();
}

/** 当前快照（`useSyncExternalStore` 的 getSnapshot；同一份值按引用稳定）。 */
export function scheduleProjectsSnapshot(): ScheduleProjectsSnapshot {
  return snapshot;
}

export function subscribeScheduleProjects(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 注册 Workspace 候选：`undefined` = 还没有权威注册表（旧服务端 / 刚清理连接）。
 *
 * 调用方（`SchedulesSection`）把它原样交给编辑器，与会话 `cwd` 的合并规则在
 * `shared/scheduleProjects.ts` 里，界面不自己判「空表是不是没有」。
 */
export function useScheduleProjects(): ScheduleProjectView[] | undefined {
  return useSyncExternalStore(
    subscribeScheduleProjects,
    scheduleProjectsSnapshot,
    scheduleProjectsSnapshot,
  ).projects;
}

subscribe((message) => {
  if (message.type === "state") {
    // 整份快照是权威：旧宿主没有这个键 = 还没有注册表，不能沿用上一页的值。
    const state = message.state as { scheduleProjects?: unknown } | undefined;
    apply(scheduleProjectsFromWire(state?.scheduleProjects));
    return;
  }
  if (message.type === "patch") {
    const patch = message.patch as Record<string, unknown> | undefined;
    if (patch === undefined || patch === null || typeof patch !== "object") return;
    if (!Object.prototype.hasOwnProperty.call(patch, "scheduleProjects")) return;
    apply(scheduleProjectsFromWire(patch.scheduleProjects));
    return;
  }
  if (message.type === "images/scope") {
    const next = message.connectionId;
    if (connectionId === undefined) {
      // 首帧：只记认，不清——快照可能已经带着同一条连接的候选。
      connectionId = next;
      return;
    }
    if (next === connectionId) return;
    connectionId = next;
    // 执行世界换代：旧连接的注册表候选不再可信。宿主清理连接时也会发 null，
    // 这里再兜一道，避免界面在新连接 baseline 到达前继续显示旧目录。
    apply(undefined);
  }
});
