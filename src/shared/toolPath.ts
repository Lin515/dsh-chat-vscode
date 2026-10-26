/**
 * 工具行的**打开目标 / 产物目标 / 终端目录**判据（纯函数，宿主与测试共用）。
 *
 * 三类消费者各自有独立规则，**不能合并成一条三档回退**：
 *
 * - 工具行（官方 `toolRowModel`）：先看调用参数里有没有路径；记录值只覆盖已有参数
 *   路径，不能凭空造动作。运行中 / 失败 / 嵌套调用的相对参数不可用；已成功结算的
 *   根调用才允许相对参数。绝对记录值不另加成功条件。
 * - 本轮产物（官方 `mutationResultPath`）：只在成功的、参数完整的第一方变更调用上
 *   使用；结果元数据自有 `path` 无效时，只有**参数本身绝对**才保留。
 * - 终端标签（官方 `terminalCardModel`）：记录 `meta.cwd` 原样优先；旧根调用用创建
 *   目录回退；运行中 / 嵌套调用只认请求里的绝对 `workdir`。
 *
 * 官方证据：`ui-tool/src/client/tool/models/{tool-call-model,recorded-path,
 * terminal-card-model}.ts` 与 `ui-deliverables/src/client/turn-deliverables.ts`。
 */

import { isFilePathTool } from "./toolMeta";
import {
  isAbsoluteWorkspacePath,
  normalizeWorkspaceSegments,
  recordedAbsolutePath,
  resolveWorkspacePath,
} from "./workspacePath";

/** 反序列化后的参数对象（官方 `isRecord`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 合法 JSON 对象参数；流式半截字符串按「没有参数」处理。 */
function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(argsRaw || "{}") as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 首行（官方 `firstLine`）。 */
function firstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/** 首个非空字符串（官方 `pickString`：`""` 不算，未 trim）。 */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/**
 * 从一段（可能还在流式增长）的 JSON 文本里读一个**已闭合**的顶层字符串字段。
 *
 * 官方工具行参数是增量视图（`ToolArgs.complete('file_path')` + `args.text(...)`），
 * 所以 `{"file_path":"/a/x.ts","content":"仍在流` 这种半截载荷里，路径字段本身已经
 * 完整时就能给打开动作。这里用有界扫描器复刻这个判据，而不是拍正则猜路径：
 *
 * - 只认**顶层**键（嵌套对象里的同名键不参与）；
 * - 字符串必须闭合、转义合法（非法转义与未闭合一律当作「还不完整」）；
 * - 字段不是字符串、或扫到文本结束都没见到它，返回 undefined；
 * - 只解析这一个字段，不要求整份 JSON 合法——但它之后是否还有半截内容不影响结果。
 *
 * `path` 字段没有这条增量通道：官方只对 `file_path` 用 `complete('file_path')`，
 * `path` 的兜底仍要求整份参数是合法 JSON。
 */
function completedTopLevelStringField(argsRaw: string, field: string): string | undefined {
  const text = argsRaw;
  let at = skipWhitespace(text, 0);
  if (text[at] !== "{") return undefined;
  at += 1;
  while (at < text.length) {
    at = skipWhitespace(text, at);
    if (text[at] === "}") return undefined;
    if (text[at] !== '"') return undefined;
    const keyEnd = scanJsonString(text, at);
    if (keyEnd === undefined) return undefined;
    const key = decodeJsonString(text.slice(at, keyEnd));
    if (key === undefined) return undefined;
    at = skipWhitespace(text, keyEnd);
    if (text[at] !== ":") return undefined;
    at = skipWhitespace(text, at + 1);
    if (key === field) {
      if (text[at] !== '"') return undefined;
      const valueEnd = scanJsonString(text, at);
      if (valueEnd === undefined) return undefined;
      return decodeJsonString(text.slice(at, valueEnd));
    }
    const valueEnd = skipJsonValue(text, at);
    if (valueEnd === undefined) return undefined;
    at = skipWhitespace(text, valueEnd);
    if (text[at] === ",") {
      at += 1;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** 跳过空白，返回下一个非空白位置。 */
function skipWhitespace(text: string, at: number): number {
  while (at < text.length && /\s/.test(text[at] as string)) at += 1;
  return at;
}

/**
 * 扫一个 JSON 字符串字面量，返回**收尾引号之后**的位置；未闭合或转义非法时
 * 返回 undefined。开始位置必须指向开引号。
 */
function scanJsonString(text: string, start: number): number | undefined {
  if (text[start] !== '"') return undefined;
  let at = start + 1;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') return at + 1;
    if (character === "\\") {
      const escape = text[at + 1];
      if (escape === undefined) return undefined;
      if (escape === "u") {
        const hex = text.slice(at + 2, at + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
        at += 6;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape)) return undefined;
      at += 2;
      continue;
    }
    // 未转义的控制字符不是合法 JSON 字符串
    if (character.charCodeAt(0) < 0x20) return undefined;
    at += 1;
  }
  return undefined;
}

/** 把已确认合法的 JSON 字符串字面量（含引号）解码成文本。 */
function decodeJsonString(literal: string): string | undefined {
  try {
    const decoded = JSON.parse(literal) as unknown;
    return typeof decoded === "string" ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 跳过一个 JSON 值，返回它之后的位置；值还不完整时返回 undefined。
 *
 * 只做结构扫描（字符串、数组 / 对象深度、顶层逗号 / 收尾括号），不校验数字与
 * 字面量的语法——它的唯一用途是越过「不是目标键」的值，跳错也只会更保守地
 * 返回 undefined，不会凭空造出一个路径。
 */
function skipJsonValue(text: string, start: number): number | undefined {
  let at = start;
  let depth = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === '"') {
      const end = scanJsonString(text, at);
      if (end === undefined) return undefined;
      at = end;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      at += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      if (depth === 0) return at;
      depth -= 1;
      at += 1;
      continue;
    }
    if (character === "," && depth === 0) return at;
    at += 1;
  }
  return undefined;
}

/**
 * 从调用参数派生要打开的路径（官方 `argumentSummary` + `deriveFilePath`）。
 *
 * 只有官方 `FILE_PATH_VARIANTS`（read / write / edit 及其同变体工具）才谈得上文件。
 * `file_path` 完整时优先用它（**包括流式半截载荷里已闭合的 `file_path`**）；否则
 * 仅在整份参数是合法 JSON 时按 `path`、`file_path` 的顺序取首个非空字符串。
 * `path` 不享受半截解析，`url` 永远不是文件路径。
 *
 * @param name 线格式工具名。
 * @param argsRaw 模型产出的原始 JSON 参数串。
 */
export function argumentPathOf(name: string, argsRaw: string): string | undefined {
  if (!isFilePathTool(name)) return undefined;
  // 与官方 `argumentSummary` 一样先看 `file_path`（`complete` 且 `text` 非空）
  const streamed = completedTopLevelStringField(argsRaw, "file_path");
  if (streamed !== undefined && streamed !== "") return firstLine(streamed);
  const args = parseArgs(argsRaw);
  if (!args) return undefined;
  const filePath = args.file_path;
  if (typeof filePath === "string" && filePath !== "") return firstLine(filePath);
  const picked = pickString(args, ["path", "file_path"]);
  return picked === undefined ? undefined : firstLine(picked);
}

/** 工具行打开目标需要的全部事实。 */
export interface ToolRowPathFacts {
  /** 线格式工具名。 */
  name: string;
  /** 原始参数 JSON（流式期可能是半截文本）。 */
  argsRaw: string;
  /** 结算结果的 `meta`；运行中为 undefined。 */
  meta?: unknown;
  /** 是否已结算。 */
  settled: boolean;
  /** 结果是否失败（含中断）。 */
  isError: boolean;
  /**
   * 嵌套调用（PTC 子调用）的父调用 id。根调用的 `tool/call` 事件没有这个字段，
   * 而子调用的相对参数不是历史打开目标。
   */
  parentCallId?: string;
}

/**
 * 工具行的**打开目标**（官方 `toolRowModel` 的 `filePath`）。
 *
 * 顺序逐字对齐官方：
 * 1. 先从参数派生 `argumentPath`；没有参数路径时，孤立的 `meta.path` **不**新增动作。
 * 2. 已结算且 `meta.path` 绝对时优先用记录值。
 * 3. 否则仅当参数本身绝对，或调用已成功结算且是根调用时，才使用参数路径。
 *
 * 运行中、失败、嵌套调用的相对参数不成为打开目标；记录值有效时不受成功条件限制。
 */
export function toolRowFilePath(facts: ToolRowPathFacts): string | undefined {
  const argumentPath = argumentPathOf(facts.name, facts.argsRaw);
  if (argumentPath === undefined) return undefined;
  const recordedPath = facts.settled ? recordedAbsolutePath(facts.meta, "path") : undefined;
  const canUseArgumentPath =
    isAbsoluteWorkspacePath(argumentPath) ||
    (facts.settled && !facts.isError && facts.parentCallId === undefined);
  return recordedPath ?? (canUseArgumentPath ? argumentPath : undefined);
}

/**
 * 一次成功变更调用最终登记为哪个产物路径（官方 `mutationResultPath`）。
 *
 * 与工具行的规则**无关**，三档：
 * - `meta` 不是记录对象、或没有自有 `path` 键 → 回退参数路径（含旧结果的相对拼写）；
 * - 自有 `path` 是绝对字符串 → 用记录值；
 * - 自有 `path` 存在但无效（相对 / 空串 / 非字符串）→ 只有参数本身绝对才保留，否则
 *   不登记。
 *
 * @param argumentPath 已确认完整的变更调用参数路径。
 * @param meta 结算结果的 `meta`。
 * @returns 产物路径，或 null（该结果无效、不能登记）。
 */
export function mutationResultPath(argumentPath: string, meta: unknown): string | null {
  if (!isRecord(meta) || !Object.hasOwn(meta, "path")) return argumentPath;
  if (typeof meta.path === "string" && isAbsoluteWorkspacePath(meta.path)) return meta.path;
  return isAbsoluteWorkspacePath(argumentPath) ? argumentPath : null;
}

/** 终端目录标签需要的事实。 */
export interface TerminalCwdFacts {
  /** 线格式工具名（bash / pwsh，以及已结算的 terminal_send）。 */
  name: string;
  /** 原始参数 JSON。 */
  argsRaw: string;
  /** 结算结果的 `meta`；运行中为 undefined。 */
  meta?: unknown;
  /** 是否已结算。 */
  settled: boolean;
  /** 是否嵌套调用（PTC 子调用）。 */
  parentCallId?: string;
  /** 会话**创建目录**（官方 `terminalCardModel` 的 `sessionCwd`）。 */
  sessionCwd?: string;
}

/** shell 调用里与目录标签有关的部分；不是合法 shell 调用时返回 null。 */
function shellWorkdirOf(name: string, argsRaw: string): { workdir: string | undefined } | null {
  if (name !== "bash" && name !== "pwsh") return null;
  const args = parseArgs(argsRaw);
  if (!args) return null;
  const { command, description, timeoutMs, workdir, run_in_background: background } = args;
  if (typeof command !== "string" || command.trim() === "") return null;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    return null;
  }
  if (workdir !== undefined && typeof workdir !== "string") return null;
  if (background !== undefined && typeof background !== "boolean") return null;
  // description 缺省按持久 shell 处理（结算后没有终端卡），但目录标签仍取调用里的
  // workdir：本判据只回答「标签该显示哪个目录」，不替卡片是否展示做决定。
  if (description === undefined) return { workdir };
  if (typeof description !== "string" || description.trim() === "") return null;
  return { workdir };
}

/** 合法 `terminal_send` 调用（官方 `terminalSendCall`）：它没有自己的 workdir。 */
function isTerminalSendCall(name: string, argsRaw: string): boolean {
  if (name !== "terminal_send") return false;
  const args = parseArgs(argsRaw);
  if (!args) return false;
  const { sessionId, text, submit, run_in_background: background } = args;
  if (typeof sessionId !== "string" || sessionId === "" || typeof text !== "string") return false;
  if (submit !== undefined && typeof submit !== "boolean") return false;
  if (background !== undefined && typeof background !== "boolean") return false;
  return true;
}

/**
 * 旧结果的目录回退（官方 `resolveTerminalCwd`）。
 *
 * 绝对 / 相对 `workdir` 都拼到创建目录上并折叠 `.` / `..`；省略 `workdir` 时就是
 * 创建目录本身。创建目录缺失时，相对拼写**只做原样规范化**（仍不是可读取的绝对目标）。
 */
function resolveTerminalCwd(workdir: string | undefined, sessionCwd: string | undefined): string | undefined {
  if (workdir === undefined || workdir === "") return sessionCwd;
  if (sessionCwd === undefined || sessionCwd === "") return normalizeWorkspaceSegments(workdir);
  return normalizeWorkspaceSegments(resolveWorkspacePath(sessionCwd, workdir));
}

/**
 * 终端卡的目录标签（官方 `terminalCardModel` 的 `cwd`）。
 *
 * - 已结算结果优先采用绝对 `meta.cwd`，原样保留记录值；`terminal_send` 也走这一档
 *   （它没有自己的 `workdir`，回退时取不到请求目录）；
 * - 没有记录值、且是已结算的根 shell 调用：相对 `workdir` 拼创建目录，省略则显示
 *   创建目录；参数派生的标签折叠 `.` / `..`；
 * - 运行中或嵌套调用只从请求取得绝对 `workdir` 标签，不替相对 / 省略参数猜目录；
 *   非 shell 调用（例如 `terminal_send`）不借 shell 的创建目录回退。
 */
export function terminalCwdOf(facts: TerminalCwdFacts): string | undefined {
  const shell = shellWorkdirOf(facts.name, facts.argsRaw);
  if (shell === null) {
    // 官方把 `shellCall ?? terminalSendCall` 一起解析：已结算的 terminal_send 同样
    // 认记录目录；但它没有 workdir，所以没有任何创建目录回退。
    if (!facts.settled || !isTerminalSendCall(facts.name, facts.argsRaw)) return undefined;
    return recordedAbsolutePath(facts.meta, "cwd");
  }
  const absoluteRequestCwd =
    shell.workdir !== undefined && isAbsoluteWorkspacePath(shell.workdir)
      ? normalizeWorkspaceSegments(shell.workdir)
      : undefined;
  if (!facts.settled) return absoluteRequestCwd;
  return (
    recordedAbsolutePath(facts.meta, "cwd") ??
    (facts.parentCallId === undefined ? resolveTerminalCwd(shell.workdir, facts.sessionCwd) : absoluteRequestCwd)
  );
}
