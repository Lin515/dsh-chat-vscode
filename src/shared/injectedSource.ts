/**
 * 「自动载入的上下文」条目里 `source` 的结构化字段解析。
 *
 * 官方对每种 `form` 有**各自的正文**（`ContextBody` 里的 `switch (form)`）：
 * `instructions` 逐条列出「哪个文件 + 已新增/已更新/已移除」、`catalog` 列出条目、
 * `snapshot` 列出分节、`relay` 标出来自哪个会话、`recall` 给出「保留 N 条 · 省略 M 条」；
 * 认不出的形状退回不透明呈现（正文 + 原样字段）。
 *
 * 我们此前只留了 `{kind, plugin, form}` 与正文，**把这些字段整个丢了**，于是界面上
 * 只有一段文字、看不出「这轮指令是新增的还是移除的」。这里按官方谓词逐条解析，
 * 并且**全有或全无**：任一条目形状不对就返回 undefined，退回不透明呈现——
 * 半个列表比没有列表更容易误导（官方 `instructionChanges` 等函数也是这个口径）。
 *
 * 纯函数、不引 React / vscode：断言见 `scripts/injectedSource.test.ts`。
 */

/** 指令变更（`form: "instructions"`）：官方 `instructionChanges`。 */
export interface InstructionChange {
  path: string;
  action: "set" | "replace" | "remove";
}

/** 目录条目（`form: "catalog"`）：官方 `catalogEntries`。 */
export interface CatalogEntry {
  name: string;
  description: string;
}

/** 快照分节（`form: "snapshot"`）：官方 `snapshotSections`。 */
export interface SnapshotSection {
  name: string;
  text: string;
}

/** 回忆到的会话（`form: "recall"`）：官方 `recalledSessions`。 */
export interface RecalledSession {
  label: string;
  retainedMessages: number;
  omittedMessages: number;
  truncated: boolean;
}

/**
 * 官方 `MAX_ENTRIES = 200`：目录条目最多列这么多，其余的用「…还有 N 条」交代。
 * 技能目录实测上千行，全渲染会把页面拖住。
 */
export const MAX_CATALOG_ENTRIES = 200;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `form: "instructions"` 的 `source.changes`；形状不对返回 undefined。 */
export function parseInstructionChanges(source: unknown): InstructionChange[] | undefined {
  const list = asRecord(source)?.["changes"];
  if (!Array.isArray(list)) return undefined;
  const changes: InstructionChange[] = [];
  for (const item of list) {
    const change = asRecord(item);
    const path = change?.["path"];
    const action = change?.["action"];
    if (typeof path !== "string" || path === "") return undefined;
    if (action !== "set" && action !== "replace" && action !== "remove") return undefined;
    changes.push({ path, action });
  }
  return changes;
}

/** `form: "catalog"` 的 `source.entries`；形状不对返回 undefined。 */
export function parseCatalogEntries(source: unknown): CatalogEntry[] | undefined {
  const list = asRecord(source)?.["entries"];
  if (!Array.isArray(list)) return undefined;
  const entries: CatalogEntry[] = [];
  for (const item of list) {
    const entry = asRecord(item);
    const name = entry?.["name"];
    const description = entry?.["description"];
    if (typeof name !== "string" || name === "" || typeof description !== "string") return undefined;
    entries.push({ name, description });
  }
  return entries;
}

/** `form: "snapshot"` 的 `source.sections`；形状不对返回 undefined。 */
export function parseSnapshotSections(source: unknown): SnapshotSection[] | undefined {
  const list = asRecord(source)?.["sections"];
  if (!Array.isArray(list)) return undefined;
  const sections: SnapshotSection[] = [];
  for (const item of list) {
    const section = asRecord(item);
    const name = section?.["name"];
    const text = section?.["text"];
    if (typeof name !== "string" || name === "" || typeof text !== "string") return undefined;
    sections.push({ name, text });
  }
  return sections;
}

/** `form: "relay"` 的 `source.senderSessionId`；形状不对返回 undefined。 */
export function parseRelaySender(source: unknown): string | undefined {
  const sender = asRecord(source)?.["senderSessionId"];
  return typeof sender === "string" && sender !== "" ? sender : undefined;
}

/** `form: "recall"` 的 `source.references`；形状不对返回 undefined。 */
export function parseRecalledSessions(source: unknown): RecalledSession[] | undefined {
  const list = asRecord(source)?.["references"];
  if (!Array.isArray(list)) return undefined;
  const sessions: RecalledSession[] = [];
  for (const item of list) {
    const reference = asRecord(item);
    const label = reference?.["label"];
    const retained = reference?.["retainedMessages"];
    const omitted = reference?.["omittedMessages"];
    const truncated = reference?.["truncated"];
    if (typeof label !== "string" || label === "") return undefined;
    if (typeof retained !== "number" || typeof omitted !== "number") return undefined;
    if (typeof truncated !== "boolean") return undefined;
    sessions.push({
      label,
      retainedMessages: retained,
      omittedMessages: omitted,
      truncated,
    });
  }
  return sessions;
}
