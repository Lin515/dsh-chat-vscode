/**
 * 执行世界文件资源的 URI 身份：**连接 + 会话 + 路径**。
 *
 * 不能把远端路径直接变成 `vscode.Uri.file`：那会把另一世界的同名本机文件当成目标。
 * 这里把三元组编码进自定义 scheme 的 authority，让 VS Code 的文档/编辑器容器只承担
 * 展示，内容始终回问原连接。行号不是身份的一部分（导航参数另传）。
 *
 * 纯字符串模块，不 import `vscode`：URI 形态本身可离线断言。
 */

/** 一份执行世界文件资源的身份。 */
export interface RemoteFileAddress {
  /** 产生这条路径的 DSH 连接身份；连接关闭后这个地址不再解析。 */
  readonly connectionId: string;
  /** 路径所属会话；相对路径由该会话的 Host 基准解析。 */
  readonly sessionId: string;
  /**
   * `workspaceFiles.stat` 返回的**执行世界绝对路径**。
   *
   * 它也是 `GET /api/file?path=…` 的唯一坐标；资源地址不放原始相对拼写，避免
   * 同一资源因不同写法拿到不同身份。
   */
  readonly path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把三元组编码成 URL-safe 的 authority 片段。 */
export function encodeRemoteFileAddress(address: RemoteFileAddress): string {
  return Buffer.from(
    JSON.stringify({
      c: address.connectionId,
      s: address.sessionId,
      p: address.path,
    }),
    "utf8",
  ).toString("base64url");
}

/** 解码 authority；形状不完整或不是合法 base64url 时返回 undefined。 */
export function decodeRemoteFileAddress(token: string): RemoteFileAddress | undefined {
  if (!token) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const { c, s, p } = parsed;
  if (typeof c !== "string" || c.length === 0) return undefined;
  if (typeof s !== "string" || s.length === 0) return undefined;
  if (typeof p !== "string" || p.length === 0) return undefined;
  return { connectionId: c, sessionId: s, path: p };
}

/**
 * URI 末段（展示用 basename）。
 *
 * 同时认 `/` 与 `\`：路径可能来自 POSIX 或 Windows 执行世界，不能按扩展宿主平台
 * 取 basename。
 */
export function remoteFileBasename(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = at === -1 ? path : path.slice(at + 1);
  return name || "file";
}
