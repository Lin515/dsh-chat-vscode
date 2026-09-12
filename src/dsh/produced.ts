/**
 * 「本轮产生了哪些文件」的推导。
 *
 * 依据是**成功的第一方变更调用**（write / edit / str_replace_editor），不是收尾
 * 正文里的点名——模型记得与否都该列出来。逐字对齐官方
 * `dsh-client-ui-deliverables` 的 `mutationPath`（`lib/client.js:289-322`）：
 * 读类工具、不认识的工具、参数残缺的调用一律不算，路径保持调用参数里的原样拼写
 * （不归一化，界面直接拿它去开文件）。
 *
 * 为什么放宿主侧：判定要看 `tool/result` 是否成功，而那只有适配器知道；
 * 界面拿到的是已经折好的 `MessageView.produced`。
 */

/** 反序列化后的参数对象（官方 `isRecord`）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空路径保留原样拼写。 */
function pathValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** `edit` 执行所需的字段是否齐全（官方 `validEditArgs`）。 */
function validEditArgs(args: Record<string, unknown>): boolean {
  return (
    typeof args.old_string === "string" &&
    args.old_string.length > 0 &&
    typeof args.new_string === "string" &&
    args.old_string !== args.new_string &&
    (args.replace_all === undefined || typeof args.replace_all === "boolean")
  );
}

/** 只有完整的**变更**子命令才算产出（官方 `editorMutationPath`）。 */
function editorMutationPath(args: Record<string, unknown>): string | undefined {
  const path = pathValue(args.path);
  if (path === undefined) return undefined;
  switch (args.command) {
    case "create":
      return typeof args.file_text === "string" ? path : undefined;
    case "str_replace":
      return typeof args.old_str === "string" &&
        args.old_str.length > 0 &&
        (args.new_str === undefined || typeof args.new_str === "string")
        ? path
        : undefined;
    case "insert":
      return typeof args.insert_line === "number" &&
        Number.isInteger(args.insert_line) &&
        args.insert_line >= 0 &&
        typeof args.new_str === "string"
        ? path
        : undefined;
    default:
      return undefined;
  }
}

/**
 * 从一个工具调用的参数里取出「被改动的文件路径」。
 *
 * @param name 线格式工具名。
 * @param argsRaw 模型产出的 JSON 参数字符串（流式期可能还不是合法 JSON）。
 * @returns 变更路径；该调用不是受支持的第一方变更调用时返回 undefined。
 */
export function producedPath(name: string, argsRaw: string): string | undefined {
  let args: unknown;
  try {
    args = JSON.parse(argsRaw);
  } catch {
    return undefined;
  }
  if (!isRecord(args)) return undefined;
  switch (name) {
    case "write":
      return typeof args.content === "string" ? pathValue(args.file_path) : undefined;
    case "edit":
      return validEditArgs(args) ? pathValue(args.file_path) : undefined;
    case "str_replace_editor":
      return editorMutationPath(args);
    default:
      return undefined;
  }
}
