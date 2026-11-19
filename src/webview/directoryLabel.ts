import type { DirectoryOption } from "../shared/chat";
import { basenameWorkspacePath } from "../shared/workspacePath";
import { dirKey } from "./composerDir";
import { displayPathParts } from "./pathDisplay";

/** 目录展示名的最小输入：路径必填，名字可由宿主给（缺省取末段）。 */
export type DirectoryLabelInput = Pick<DirectoryOption, "path"> & Partial<Pick<DirectoryOption, "name">>;

interface Entry {
  key: string;
  path: string;
  name: string;
  segments: string[];
  /** 当前取末几段；1 = 只有目录名。 */
  depth: number;
}

/**
 * 一组目录的**去重短名**：默认只有末段；不同目录末段撞名时逐级补父目录。
 * 补到根仍撞名（只差盘符 / UNC 的同样尾巴，或 POSIX 上只差大小写）时退回**完整路径**。
 *
 * 为什么需要：`roots` 与历史范围里的「其他目录」都可能出现两个同名项目（`client/app`
 * 与 `server/app`），历史混合目录里也会。只显示 `app` 会让用户分不清点的是哪一个；
 * 直接显示完整路径又会把窄侧栏撑爆。逐级补父段是两件事之间唯一可读的折中。
 *
 * 返回值按 `dirKey` 索引（Windows 大小写 / 斜杠等价，POSIX 保留大小写），路径相同的
 * 目录只留第一份。
 */
export function shortDirectoryLabels(options: readonly DirectoryLabelInput[]): Map<string, string> {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const key = dirKey(option.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const parts = displayPathParts(option.path);
    const name =
      option.name?.trim() ||
      basenameWorkspacePath(option.path.replace(/[/\\]+$/u, "")) ||
      option.path;
    entries.push({ key, path: option.path, name, segments: parts.segments, depth: 1 });
  }

  /** 取末 `depth` 段；`depth` 只能到末段为止，再撞名就由调用处的完整路径兜底。 */
  const labelOf = (entry: Entry): string => {
    if (entry.depth <= 1 || entry.segments.length === 0) return entry.name;
    return entry.segments.slice(-Math.min(entry.depth, entry.segments.length)).join("/");
  };

  // 逐轮把撞名的那些再补一段父目录。轮数由最长路径的段数封顶；补到根仍撞名就停，
  // 那一组改用完整路径（不同盘符 / 只差大小写的目录仍能区分）。
  for (let round = 0; round <= 64; round += 1) {
    const groups = new Map<string, Entry[]>();
    for (const entry of entries) {
      const group = labelOf(entry).toLowerCase();
      const list = groups.get(group);
      if (list) list.push(entry);
      else groups.set(group, [entry]);
    }
    let changed = false;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const entry of group) {
        if (entry.depth < entry.segments.length) {
          entry.depth += 1;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const finalGroups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const group = labelOf(entry).toLowerCase();
    const list = finalGroups.get(group);
    if (list) list.push(entry);
    else finalGroups.set(group, [entry]);
  }
  const label = (entry: Entry): string => {
    const group = finalGroups.get(labelOf(entry).toLowerCase());
    return group && group.length > 1 ? entry.path : labelOf(entry);
  };

  return new Map(entries.map((entry) => [entry.key, label(entry)]));
}
