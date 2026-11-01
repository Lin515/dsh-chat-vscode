/**
 * 工具参数 / 结果里**语言可确定**的源码片段事实（基础高亮用）。
 *
 * 只收明确身份 + 明确字段，不按工具名子串猜：
 * - `workflow`：参数里的脚本。当前工具 schema 用 `script`，旧版 rc.2 的
 *   `code` 仅作兼容兜底；其它参数原样保留，交给调用方与脚本分开显示。
 * - `cordis_inspect_list` / `cordis_inspect_query` / `cordis_inspect_self` /
 *   `cordis_package_inspect` / `cordis_runtime_inspect` / `session_event_read`：
 *   成功结果**整段**能 JSON.parse 且是对象 / 数组时，可按 JSON 着色；不解析
 *   字段树，也不把其它工具的 OUT 当 JSON。`session_event_read` 通常是
 *   「标题 + 围栏 JSON」的文本，整段解析失败就自然回退纯文，不拆围栏。
 *
 * 不联网、不读盘、不碰宿主；纯函数，断言见 `scripts/toolSource.test.ts`。
 */
import { parseToolArgs } from "./toolCard";

/** workflow 脚本字段的优先级：真实 schema（`script`）优先，旧包 `code` 兜底。 */
export const WORKFLOW_SCRIPT_KEYS = ["script", "code"] as const;

export interface WorkflowScript {
  /** 实际命中的字段名（`script` 或 `code`）。 */
  key: string;
  /** 脚本原文；逐字返回，不 trim、不转义。 */
  code: string;
  /** 同一份参数去掉脚本字段后的其余键值（脚本不重复出现在 IN JSON 里）。 */
  rest: Record<string, unknown>;
}

/**
 * 从 workflow 的完整参数里取脚本。参数不是完整 JSON、不是对象、字段缺失 /
 * 空串 / 非字符串时返回 undefined，调用方保持原来的参数原文显示。
 */
export function workflowScriptOf(name: string, argsRaw: string): WorkflowScript | undefined {
  if (name !== "workflow") return undefined;
  const args = parseToolArgs(argsRaw);
  if (args === undefined) return undefined;
  for (const key of WORKFLOW_SCRIPT_KEYS) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (typeof value !== "string" || value === "") continue;
    const rest = { ...args };
    delete rest[key];
    return { key, code: value, rest };
  }
  return undefined;
}

/** 结果整段可按 JSON 着色的明确工具（精确名表，不做子串匹配）。 */
const JSON_OUTPUT_TOOLS: ReadonlySet<string> = new Set([
  "cordis_inspect_list",
  "cordis_inspect_query",
  "cordis_inspect_self",
  "cordis_package_inspect",
  "cordis_runtime_inspect",
  "session_event_read",
]);

/**
 * 这个工具的这段结果是否可按 JSON 着色：只认上表精确身份，且整段能解析成
 * 非 null 对象 / 数组。错误文案、半截 JSON、标量、其它工具一律 false。
 *
 * 只回答「能不能」，不返回解析后的对象——调用方仍显示完整原字符串，避免拆字段
 * 或改变复制载荷。
 */
export function isInspectJsonOutput(name: string, output: string): boolean {
  if (!JSON_OUTPUT_TOOLS.has(name) || output === "") return false;
  try {
    const value = JSON.parse(output) as unknown;
    return value !== null && typeof value === "object";
  } catch {
    return false;
  }
}
