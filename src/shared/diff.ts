/**
 * 编辑类节点的 diff：纯函数，宿主与界面共用。
 *
 * 两条数据来源都归一成 {@link DiffHunkView}：
 * - `tool/result.meta.diffs`——dsh-tool-fs 的 edit/write 在结果里附带的
 *   hunk（每段带 3 行上下文的 oldText / newText，见 FileDiff 类型）；
 * - 工具参数里的 `old_string` / `new_string`（结果还没回来时的预览）。
 *
 * 这里只做「行序列 + 增删计数」，排版（单栏/双栏）交给界面，
 * 因为自适应要看对话框宽度。
 */
import type { DiffHunkView, DiffLineView } from "./chat";

/**
 * 行 diff 的规模上限（前后缀裁剪之后的中段，n × m 个格子）。
 * 超过就退化成「整块删除 + 整块新增」——宁可少对齐，也不让界面卡住。
 */
const MAX_CELLS = 250_000;

/** 单个 hunk 渲染的行数上限（大文件的 write 预览可能上千行）。 */
const MAX_LINES_PER_HUNK = 800;

/** 文本 → 行（CRLF 归一化，去掉结尾换行带来的空行）。 */
export function toLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** 两段文本的行级 diff（LCS）。`oldText` 为 null 表示新文件：整体算新增。 */
export function diffLines(oldText: string | null, newText: string): DiffLineView[] {
  const before = oldText === null ? [] : toLines(oldText);
  const after = toLines(newText);
  const out: DiffLineView[] = [];

  // 先把公共前后缀摘掉：hunk 两端通常就是 3 行上下文，DP 规模能小一个量级
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }

  for (let i = 0; i < prefix; i++) out.push({ kind: "context", text: before[i] });
  out.push(
    ...diffMiddle(
      before.slice(prefix, before.length - suffix),
      after.slice(prefix, after.length - suffix),
    ),
  );
  for (let i = before.length - suffix; i < before.length; i++) {
    out.push({ kind: "context", text: before[i] });
  }
  return out;
}

/** 中段 diff：删除行排在新增行之前（双栏对齐时同一块左右配对）。 */
function diffMiddle(before: string[], after: string[]): DiffLineView[] {
  const n = before.length;
  const m = after.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return after.map((text) => ({ kind: "add" as const, text }));
  if (m === 0) return before.map((text) => ({ kind: "del" as const, text }));
  if (n * m > MAX_CELLS) {
    return [
      ...before.map((text) => ({ kind: "del" as const, text })),
      ...after.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // dp[i][j] = before[i..] 与 after[j..] 的最长公共子序列长度（从后往前填）
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        before[i] === after[j]
          ? dp[(i + 1) * width + (j + 1)] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
    }
  }

  const out: DiffLineView[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ kind: "context", text: before[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
      out.push({ kind: "del", text: before[i] });
      i++;
    } else {
      out.push({ kind: "add", text: after[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: "del", text: before[i++] });
  while (j < m) out.push({ kind: "add", text: after[j++] });
  return out;
}

/** 一段式 hunk：一对 old/new 文本 → 行序列 + 增删计数。 */
export function hunkFromTexts(
  path: string | undefined,
  oldText: string | null,
  newText: string,
): DiffHunkView {
  const all = diffLines(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const line of all) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  const truncated = all.length > MAX_LINES_PER_HUNK;
  return {
    path: path || undefined,
    lines: truncated ? all.slice(0, MAX_LINES_PER_HUNK) : all,
    added,
    removed,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** 收窄 `tool/result.meta` 里的 `diffs`（形状不对就当没有，绝不抛错）。 */
export function hunksFromMeta(meta: unknown): DiffHunkView[] | undefined {
  const diffs = (meta as { diffs?: unknown } | undefined)?.diffs;
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined;
  const hunks: DiffHunkView[] = [];
  for (const raw of diffs) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { path?: unknown; oldText?: unknown; newText?: unknown };
    if (typeof item.newText !== "string") continue;
    hunks.push(
      hunkFromTexts(
        typeof item.path === "string" ? item.path : undefined,
        typeof item.oldText === "string" ? item.oldText : null,
        item.newText,
      ),
    );
  }
  return hunks.length ? hunks : undefined;
}

/** 参数里取字符串（工具名与字段名各家不一，宽松一点）。 */
function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * 从工具调用参数推导 diff（结果还没回来时用）。
 *
 * 只处理写文件的工具：`edit` / `str_replace_editor`（old/new 字面量）与
 * `write` / `create_file`（整篇内容）。字段名按 dsh-tool-fs 与
 * dsh-tool-str-replace-editor 两套 schema 兼容取值。
 */
export function hunksFromToolArgs(name: string, argsRaw: string): DiffHunkView[] | undefined {
  const lower = name.toLowerCase();
  const isEdit = lower.includes("edit") || lower.includes("replace");
  const isWrite = !isEdit && (lower.startsWith("write") || lower === "create_file");
  if (!isEdit && !isWrite) return undefined;

  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(argsRaw || "{}");
    if (!parsed || typeof parsed !== "object") return undefined;
    args = parsed as Record<string, unknown>;
  } catch {
    return undefined; // 流式期参数还不是合法 JSON：等完整了再给预览
  }

  const path = pickString(args, ["file_path", "path", "filePath", "filename"]);
  if (isEdit) {
    const oldText = pickString(args, ["old_string", "old_str", "oldText"]);
    const newText = pickString(args, ["new_string", "new_str", "newText"]);
    if (oldText === undefined && newText === undefined) return undefined;
    return [hunkFromTexts(path, oldText ?? null, newText ?? "")];
  }
  const content = pickString(args, ["content", "file_text", "text", "fileText"]);
  if (content === undefined) return undefined;
  // write 没有 before：整体算新增（覆盖已有文件时真实 hunk 由结果 meta 给出）
  return [hunkFromTexts(path, null, content)];
}
