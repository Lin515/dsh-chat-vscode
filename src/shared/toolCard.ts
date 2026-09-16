/**
 * 工具卡的**契约事实**：从「工具名 + 参数 + 结果元数据」折出展开区要画的那张卡。
 *
 * 官方把这套推导放在客户端（`@deepseek-ai/dsh-client-ui-tool` 的
 * `models/*-card-model` + `tool-call-model.deriveSummary`），数据全部来自线格式：
 * - **输入**取自调用参数（`tool/call` 的 `arguments`）；
 * - **输出**与元数据取自结算结果（`tool/result` 的 `content` / `meta`）。
 *
 * 本扩展的宿主侧适配器已经拿得到这两份材料（`upsertToolCall` / `settleTool`），
 * 所以在这里一次折好，界面只负责画——与 `shared/toolMeta.ts`、`dsh/readRange.ts`
 * 同一条分工。
 *
 * 与官方**逐条对齐**的判据（括号里是官方出处）：
 * - `read`：meta 必须是 `{path, offset, lines:[{number,text}], totalLines, lang?}` 且
 *   行号严格递增、不越界（`readMeta`）；参数 `file_path` 非空，`offset`/`limit` 给了
 *   就得是 ≥1 的整数（`validReadCall`）；出错 / 中断时不给卡（`readCardModel`）。
 * - `grep` / `glob`：meta 必须带 `truncated:boolean`、`total:int`，`shape` 为
 *   `matches`（`files:[{path,matches:[{lineNumber,line}]}]`）或 `paths:string[]`
 *   （`searchCardModel`）；`grep` 的 `pattern` 可以为空、`glob` 的不行；`include`
 *   带逗号、以 `!` 开头会走通用路径（`validInclude`）。
 * - `bash` / `pwsh`：参数要有非空 `command`；**给了 `description` 才算「一次性命令」**
 *   ——官方把没有 description 的调用当作持久 shell（`shellCall` 返回
 *   `persistent: true`），结算后走通用 IN/OUT（持久 shell 会报重置与部分输出，
 *   没有唯一退出状态可推断）。运行中一律给卡（只有命令与「运行中」）。
 * - `web_search` / `web_fetch`：meta 必须带 `truncated:boolean`，搜索给
 *   `sources:[{url,title?,snippet?,publishedAt?}]`（`answer?`），获取给
 *   `url:string` + `statusCode:int`。
 * - `run_code`：参数里的 `code` 字符串直接当代码块正文（`formatToolBody` 的 code 分支）。
 * - `todo_write`：只折进度数字（官方 `TodoRow` 的 `planSummary`），正文仍走 IN/OUT。
 *
 * 与本扩展**刻意不同**的两处（都在 CHANGELOG 里写明）：
 * 1. 不做「相对会话 cwd 缩短路径」——本扩展的标题一向给完整路径、由界面按宽度
 *    省略前段（见 `webview/pathDisplay.ts` 的文件头），卡片沿用同一条口径；
 * 2. `read` 卡不校验正文信封（官方要求结果正文严格匹配 `<path>…</path><type>file`
 *    `</type><content>…</content>`）。本扩展的 `output` 已经过 `parseToolResult`
 *    剥壳，校验它等于自己跟自己较劲；meta 合法就足以保证卡片内容正确。
 *
 * 纯函数、不引宿主：断言见 `scripts/toolCard.test.ts`。
 */
import type { ToolCardView, WebSourceView } from "./chat";
import { classifyTool, summaryKeys } from "./toolMeta";

/** 折卡片需要的全部事实（适配器在「建卡」与「结算」两处都能给齐）。 */
export interface ToolCardFacts {
  name: string;
  /** 原始参数 JSON（流式期可能是半截文本）。 */
  argsRaw: string;
  /** 结果正文（终端类已剥掉退出标记；未结算时为空）。 */
  output?: string;
  /** 结果内容块的**嵌套层**（`tool-result` 块里的 `content`）。 */
  content?: unknown;
  /** 结果的展示元数据（`tool/result` 的 `meta`）。 */
  meta?: unknown;
  /** 终端类结果的退出状态（适配器已用 `parseExitStatus` 解析过）。 */
  exitCode?: number;
  signal?: string;
  isError: boolean;
  interrupted: boolean;
  /** 是否已结算（false = 还在跑）。 */
  settled: boolean;
}

/** 解析参数 JSON；不是对象（数组 / 标量 / 半截）一律按「没有参数」处理。 */
export function parseToolArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(argsRaw || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** 取首个非空字符串（官方 `pickString`：`""` 不算，未 trim）。 */
function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

/** 首行（官方 `firstLine`）。 */
function firstLine(text: string): string {
  const cut = text.indexOf("\n");
  return cut === -1 ? text : text.slice(0, cut);
}

/**
 * 单行摘要（官方 `deriveSummary`）。
 *
 * 顺序：`queries[]` 数组（网页搜索）→ 变体自己的字段表 → **参数里第一个非空字符串**
 * → 原始参数的首行。最后两级是官方对未知工具的兜底（`SUMMARY_KEYS.others` 是空表），
 * 此前本扩展只在一小撮精选字段里找，取不到就什么都不显示。
 */
export function deriveToolSummary(name: string, argsRaw: string): string | undefined {
  const args = parseToolArgs(argsRaw);
  if (!args) return argsRaw ? firstLine(argsRaw) : undefined;
  const variant = classifyTool(name);
  if (variant === "search" && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === "string" && query !== "");
    if (queries.length > 0) return queries.map(firstLine).join(", ");
  }
  const picked = pickString(args, summaryKeys(variant));
  if (picked !== undefined) return firstLine(picked);
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value !== "") return firstLine(value);
  }
  return firstLine(argsRaw);
}

// ---------- 结果内容块 ----------

/**
 * 结算结果里**唯一**的文本块（官方 `singleResultText`）。
 *
 * 内容块不是「恰好一个 text」时返回 undefined：图片、多块、空内容都走通用路径——
 * 官方各卡片模型同样只认这一种布局。
 */
function singleText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const only = content[0] as { type?: unknown; text?: unknown } | undefined;
  return only?.type === "text" && typeof only.text === "string" ? only.text : undefined;
}

// ---------- read ----------

/** 模型给的 1-based 行位置 / 条数：≥1 的整数（官方 `positiveInteger`）。 */
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** 官方 `validReadCall`：`file_path` 非空，`offset`/`limit` 给了就得合法。 */
function validReadCall(name: string, args: Record<string, unknown> | undefined): boolean {
  if (name !== "read" || !args) return false;
  if (typeof args.file_path !== "string" || args.file_path.trim() === "") return false;
  if (args.offset !== undefined && !positiveInteger(args.offset)) return false;
  if (args.limit !== undefined && !positiveInteger(args.limit)) return false;
  return true;
}

/** 官方 `readMeta`：形状不合一律 null（宁可走通用 IN/OUT，也不要画半截内容）。 */
function readMeta(meta: unknown): { path: string; lines: { number: number; text: string }[]; totalLines: number; lang?: string } | null {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>;
  if (typeof path !== "string") return null;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 1) return null;
  if (typeof totalLines !== "number" || !Number.isInteger(totalLines) || totalLines < 0) return null;
  if (!Array.isArray(lines)) return null;
  if (lang !== undefined && typeof lang !== "string") return null;
  const narrowed: { number: number; text: string }[] = [];
  let previous = offset - 1;
  for (const line of lines) {
    if (typeof line !== "object" || line === null || Array.isArray(line)) return null;
    const { number, text } = line as { number?: unknown; text?: unknown };
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1 || number <= previous) return null;
    if (number > totalLines || typeof text !== "string") return null;
    previous = number;
    narrowed.push({ number, text });
  }
  return { path, lines: narrowed, totalLines, ...(lang === undefined ? {} : { lang }) };
}

// ---------- 搜索 ----------

/** 官方 `validInclude`：空串、`!` 开头、顶层逗号都不算合法 include。 */
function validInclude(include: string): boolean {
  if (include.trim() === "" || include.startsWith("!")) return false;
  let depth = 0;
  for (const character of include) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "," && depth === 0) return false;
  }
  return true;
}

/** 官方 `validSearchCall`：返回工具名（grep / glob），不合法返回 null。 */
function validSearchCall(name: string, args: Record<string, unknown> | undefined): "grep" | "glob" | null {
  if (!args) return null;
  if (name !== "grep" && name !== "glob") return null;
  const pattern = args.pattern;
  if (typeof pattern !== "string") return null;
  if (name === "grep" && pattern === "") return null;
  if (name === "glob" && pattern.trim() === "") return null;
  if (args.path !== undefined && (typeof args.path !== "string" || args.path.trim() === "")) return null;
  if (name === "grep" && args.include !== undefined) {
    if (typeof args.include !== "string" || !validInclude(args.include)) return null;
  }
  return name;
}

function searchFiles(value: unknown): { path: string; matches: { lineNumber: number; line: string }[] }[] | null {
  if (!Array.isArray(value)) return null;
  const files: { path: string; matches: { lineNumber: number; line: string }[] }[] = [];
  for (const file of value) {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return null;
    const { path, matches } = file as { path?: unknown; matches?: unknown };
    if (typeof path !== "string" || !Array.isArray(matches)) return null;
    const narrowed: { lineNumber: number; line: string }[] = [];
    for (const match of matches) {
      if (typeof match !== "object" || match === null || Array.isArray(match)) return null;
      const { lineNumber, line } = match as { lineNumber?: unknown; line?: unknown };
      if (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
      if (typeof line !== "string") return null;
      narrowed.push({ lineNumber, line });
    }
    files.push({ path, matches: narrowed });
  }
  return files;
}

// ---------- 终端 ----------

/**
 * 输出尾部是不是「完整结果被落到文件」的 spill 提示。
 *
 * 官方 `hasSpillNotice` 逐字比对 `spill-policy` 的提示文案；这里只认它那条不变的
 * 定位短语（` Full formatted result stored at: `）加上「整段是最后一块括号」。判错
 * 的代价不对称：漏判只是画出终端卡（现状），误判会把整条输出降级成通用 IN/OUT。
 */
function hasSpillNotice(text: string): boolean {
  if (!text.endsWith(")")) return false;
  // 只丢掉 "\n\n"，尾巴从 "(" 开始（+3 会连左括号一起切掉，判据就永远不成立）
  const start = text.lastIndexOf("\n\n(");
  const tail = start < 0 ? text : text.slice(start + 2);
  return tail.startsWith("(") && tail.includes(" Full formatted result stored at: ");
}

/** 官方 `shellCall` 认得的字段（这里只取画卡需要的三样）。 */
interface ShellCall {
  command: string;
  description?: string;
  workdir?: string;
  persistent: boolean;
  background: boolean;
}

function shellCall(name: string, args: Record<string, unknown> | undefined): ShellCall | null {
  if (!args) return null;
  if (name !== "bash" && name !== "pwsh") return null;
  const { command, description, workdir, run_in_background: background } = args;
  if (typeof command !== "string" || command.trim() === "") return null;
  if (workdir !== undefined && typeof workdir !== "string") return null;
  if (background !== undefined && typeof background !== "boolean") return null;
  if (args.sandbox_permissions !== undefined || args.justification !== undefined) {
    const permission = args.sandbox_permissions;
    const justification = args.justification;
    if (permission !== "workspace-write" && permission !== "danger-full-access") return null;
    if (typeof justification !== "string" || justification.trim() === "") return null;
  }
  // 没有 description ⇒ 官方的持久 shell 路径（结算后没有唯一退出状态）
  if (description === undefined) {
    return { command, workdir, persistent: true, background: false };
  }
  if (typeof description !== "string" || description.trim() === "") return null;
  return { command, description, workdir, persistent: false, background: background === true };
}

// ---------- 网页 ----------

function webSources(value: unknown): WebSourceView[] | null {
  if (!Array.isArray(value)) return null;
  const sources: WebSourceView[] = [];
  for (const source of value) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) return null;
    const { url, title, snippet, publishedAt } = source as Record<string, unknown>;
    if (typeof url !== "string") return null;
    if (title !== undefined && typeof title !== "string") return null;
    if (snippet !== undefined && typeof snippet !== "string") return null;
    if (publishedAt !== undefined && typeof publishedAt !== "string") return null;
    sources.push({
      url,
      ...(title === undefined ? {} : { title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(publishedAt === undefined ? {} : { publishedAt }),
    });
  }
  return sources;
}

function validWebCall(name: string, args: Record<string, unknown> | undefined): "web_search" | "web_fetch" | null {
  if (!args) return null;
  if (name === "web_search") {
    const queries = args.queries;
    if (!Array.isArray(queries) || queries.length === 0) return null;
    return queries.every((query) => typeof query === "string" && query.trim() !== "") ? "web_search" : null;
  }
  if (name === "web_fetch") {
    return typeof args.url === "string" && args.url.trim() !== "" ? "web_fetch" : null;
  }
  return null;
}

// ---------- todo ----------

/**
 * `todo_write` 的进度（官方 `TodoRow` 的 `planSummary`）。
 *
 * `active` 取第一个进行中条目的正文（空串不算），`extra` 是其余进行中条目的条数
 * ——官方在摘要右侧缀 `+N`。
 */
export function todoProgressOf(argsRaw: string): { done: number; total: number; active?: string; extra?: number } | undefined {
  const args = parseToolArgs(argsRaw);
  const todos = args?.todos;
  if (!Array.isArray(todos) || todos.length === 0) return undefined;
  const items = todos.filter((item): item is { content?: unknown; status?: unknown } => typeof item === "object" && item !== null);
  if (items.length !== todos.length) return undefined;
  const done = items.filter((item) => item.status === "completed").length;
  const active = items.filter((item) => item.status === "in_progress");
  const first = active[0]?.content;
  const named = typeof first === "string" && first.trim() !== "";
  return {
    done,
    total: items.length,
    ...(named ? { active: first } : {}),
    ...(named && active.length > 1 ? { extra: active.length - 1 } : {}),
  };
}

// ---------- 入口 ----------

/**
 * 折出展开区的卡片；返回 undefined 表示走通用 IN/OUT。
 *
 * 分派顺序与官方 `ToolRow` 的 card 槽一致（terminal → read → search → web），
 * 每个分支只在**排除了通用路径的情形**下返回卡片。
 */
export function toolCardOf(facts: ToolCardFacts): ToolCardView | undefined {
  const args = parseToolArgs(facts.argsRaw);
  const variant = classifyTool(facts.name);

  if (variant === "bash") {
    const call = shellCall(facts.name, args);
    if (!call || call.background) return undefined;
    if (!facts.settled) {
      return { kind: "terminal", command: call.command, cwd: call.workdir, output: "", running: true };
    }
    // 出错、持久 shell、spill 预览都退回通用 IN/OUT（官方同口径：
    // 这三种情形没有唯一的进程退出状态可推断）
    if (facts.isError || facts.interrupted || call.persistent) return undefined;
    if (singleText(facts.content) === undefined) return undefined;
    const output = facts.output ?? "";
    if (hasSpillNotice(output)) return undefined;
    return {
      kind: "terminal",
      command: call.command,
      cwd: call.workdir,
      output,
      ...(facts.exitCode === undefined ? {} : { exitCode: facts.exitCode }),
      ...(facts.signal === undefined ? {} : { signal: facts.signal }),
    };
  }

  if (facts.settled && (facts.isError || facts.interrupted)) return undefined;

  if (facts.name === "read") {
    if (!validReadCall(facts.name, args)) return undefined;
    const meta = readMeta(facts.meta);
    if (!meta) return undefined;
    return {
      kind: "read",
      label: meta.path,
      lines: meta.lines,
      totalLines: meta.totalLines,
      ...(meta.lang === undefined ? {} : { lang: meta.lang }),
    };
  }

  const search = validSearchCall(facts.name, args);
  if (search !== null) {
    if (typeof facts.meta !== "object" || facts.meta === null || Array.isArray(facts.meta)) return undefined;
    const meta = facts.meta as Record<string, unknown>;
    if (typeof meta.truncated !== "boolean") return undefined;
    if (typeof meta.total !== "number" || !Number.isInteger(meta.total) || meta.total < 0) return undefined;
    // 被截断时正文里带着「完整结果在哪」的说明，卡片要把它一并给出（官方 recovery）
    const recovery = meta.truncated ? facts.output : undefined;
    if (search === "grep") {
      if (meta.shape !== "matches") return undefined;
      const files = searchFiles(meta.files);
      if (files === null) return undefined;
      return {
        kind: "search",
        shape: "matches",
        files,
        total: meta.total,
        truncated: meta.truncated,
        ...(recovery === undefined ? {} : { recovery }),
      };
    }
    if (meta.shape !== "paths" || !Array.isArray(meta.paths)) return undefined;
    if (!meta.paths.every((path) => typeof path === "string")) return undefined;
    return {
      kind: "search",
      shape: "paths",
      paths: [...(meta.paths as string[])],
      total: meta.total,
      truncated: meta.truncated,
      ...(recovery === undefined ? {} : { recovery }),
    };
  }

  const web = validWebCall(facts.name, args);
  if (web !== null) {
    if (typeof facts.meta !== "object" || facts.meta === null || Array.isArray(facts.meta)) return undefined;
    const meta = facts.meta as Record<string, unknown>;
    if (typeof meta.truncated !== "boolean") return undefined;
    if (web === "web_search") {
      const sources = webSources(meta.sources);
      if (sources === null || (meta.answer !== undefined && typeof meta.answer !== "string")) return undefined;
      return {
        kind: "web_search",
        ...(meta.answer === undefined ? {} : { answer: meta.answer }),
        sources,
        truncated: meta.truncated,
      };
    }
    if (typeof meta.url !== "string") return undefined;
    if (typeof meta.statusCode !== "number" || !Number.isInteger(meta.statusCode)) return undefined;
    return { kind: "web_fetch", url: meta.url, statusCode: meta.statusCode, truncated: meta.truncated };
  }

  // run_code：正文就是参数里的 code（官方 `formatToolBody` 的 code 分支）
  if (variant === "code") {
    const code = args?.code;
    if (typeof code === "string" && code !== "") return { kind: "code", code };
  }

  return undefined;
}
