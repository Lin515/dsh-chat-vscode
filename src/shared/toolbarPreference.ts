import { isRecord } from "./jsonValue";

/** 可配置档位的稳定标识（槽位:档位）。顺序是默认的保留优先级，不是视觉顺序。 */
const DEFAULT_ENABLED = [
  "effort:full",
  "attach:full",
  "tps:full",
  "permission:label",
  "preset:full",
  "context:text",
  "model:provider",
  "cache:full",
] as const;
const DEFAULT_HIDDEN = ["tokens:full"] as const;
const OPTIONS = [...DEFAULT_ENABLED, ...DEFAULT_HIDDEN];

export type ToolbarOptionId = (typeof OPTIONS)[number];

export interface ToolbarPreference {
  readonly enabled: readonly ToolbarOptionId[];
  readonly hidden: readonly ToolbarOptionId[];
}

export const DEFAULT_TOOLBAR_PREFERENCE: ToolbarPreference = {
  enabled: DEFAULT_ENABLED,
  hidden: DEFAULT_HIDDEN,
};

export type ToolbarPreferenceAction =
  | { type: "move"; id: ToolbarOptionId; direction: "up" | "down" }
  | { type: "enable" | "hide"; id: ToolbarOptionId }
  | { type: "reset" };

function isOption(value: unknown): value is ToolbarOptionId {
  return OPTIONS.some((option) => option === value);
}

/** 保留用户顺序，剔除未知/重复项；未记录的新档位按自己的默认状态追加。 */
export function normalizeToolbarPreference(value: unknown): ToolbarPreference {
  if (!isRecord(value) || !Array.isArray(value.enabled) || !Array.isArray(value.hidden)) return DEFAULT_TOOLBAR_PREFERENCE;

  const seen = new Set<ToolbarOptionId>();
  const take = (list: readonly unknown[]) => list.filter((id): id is ToolbarOptionId => {
    if (!isOption(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const enabled = take(value.enabled);
  const hidden = take(value.hidden);
  return {
    enabled: [...enabled, ...take(DEFAULT_ENABLED)],
    hidden: [...hidden, ...take(DEFAULT_HIDDEN)],
  };
}

/** 宿主对当前权威状态应用单个动作；无变化时保留原引用。 */
export function applyToolbarPreferenceAction(current: ToolbarPreference, action: unknown): ToolbarPreference {
  if (!isRecord(action)) return current;
  if (action.type === "reset") {
    const matches = (a: readonly ToolbarOptionId[], b: readonly ToolbarOptionId[]) =>
      a.length === b.length && a.every((id, i) => id === b[i]);
    return matches(current.enabled, DEFAULT_ENABLED) && matches(current.hidden, DEFAULT_HIDDEN)
      ? current
      : DEFAULT_TOOLBAR_PREFERENCE;
  }
  if (!isOption(action.id)) return current;
  const { id } = action;
  if (action.type === "enable" && current.hidden.includes(id)) {
    return { enabled: [...current.enabled, id], hidden: current.hidden.filter((item) => item !== id) };
  }
  if (action.type === "hide" && current.enabled.includes(id)) {
    return { enabled: current.enabled.filter((item) => item !== id), hidden: [...current.hidden, id] };
  }
  if (action.type === "move" && (action.direction === "up" || action.direction === "down")) {
    const from = current.enabled.indexOf(id);
    const to = from + (action.direction === "up" ? -1 : 1);
    if (from < 0 || to < 0 || to >= current.enabled.length) return current;
    const enabled = [...current.enabled];
    [enabled[from], enabled[to]] = [enabled[to], enabled[from]];
    return { ...current, enabled };
  }
  return current;
}
