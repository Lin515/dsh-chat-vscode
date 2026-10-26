/**
 * 执行世界文件访问：**唯一**承接 `workspaceFiles` 与认证 `/api/file` 的宿主模块。
 *
 * 为什么集中：模型给出的路径属于 DSH 执行世界，可能是本机、WSL、容器或远端；
 * 扩展宿主的 `node:fs` / `vscode.workspace.fs` / `Uri.file` 都不是它的默认替代品。
 * 这里只保留一条读取通道，并把它绑定到**一条连接**：连接换代后旧资源不能再被
 * 当前连接解释（见 {@link HostFileAccess.close}）。
 *
 * 契约（已核对官方 `packages/api/workspace-files`）：
 * - `stat` / `read` 的 scope 是 `workspaceFileScopeId`（session id）；相对路径由
 *   Host 用 `header.cwd ?? sandboxPolicy.workspaceRoot` 解析，文件读取不受工作区
 *   包含性限制。客户端不先做本机 realpath / 目录拼接。
 * - `read` 按行分页，`text` 是页内行用 `\n` 连接、末尾不带终结符；页的 `version`
 *   来自读前的 stat。它只承诺「行片段」，**不承诺原始终结符**，所以绝不能拿它
 *   冒充整份文件字节。`readBytes` 是 binary RPC，本扩展不伪造 JSON 字节形状；
 *   需要真实字节（打开文件、图片）时统一走已认证的
 *   `GET /api/file?path=<stat.absolutePath>`。
 * - 只有 `workspace-file/not-found` 是「不存在」；权限、离线、未知错误与形状不合规
 *   都是 `unknown`，绝不等于删除。
 *
 * 纯宿主端口，不 import `vscode`：离线测试用同形的 fake transport 驱动。
 */

import { randomUUID } from "node:crypto";

/** `/api/file` 取回的一小段：原始字节与 Host 给出的媒体类型。 */
export interface HostFileBytesResponse {
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
}

/**
 * `HostFileAccess` 需要的传输面。
 *
 * 生产实现就是 `DshClient`（`request` + `getBytes`）；离线测试换成脚本化的 fake，
 * 不启动真实 DSH。
 */
export interface HostFileTransport {
  request<T>(
    method: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  getBytes(path: string, timeoutMs?: number): Promise<HostFileBytesResponse | undefined>;
  /**
   * 可选的 `workspaceFiles/changes` 流（已核对 rc.3 与 alpha.2：payload 是
   * `{workspaceFileScopeId, path}`）。传输层只负责原始帧；形状与目标校验在
   * {@link HostFileAccess.watch} 里。
   */
  watchWorkspaceFile?(
    sessionId: string,
    path: string,
    callbacks: {
      readonly onFrame: (frame: unknown) => void;
      readonly onEnd?: () => void;
      readonly onError?: (error: unknown) => void;
    },
  ): { cancel(): void };
}

/** 一条文件观察的事件；`error` 只表示观察失效，不代表文件删除。 */
export type HostFileWatchEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "changed"; readonly version: string }
  | { readonly kind: "absent" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "end" };

/** 文件观察句柄。 */
export interface HostFileWatch {
  dispose(): void;
}

/** 文件访问失败的**原因**；调用方只按它分类，不读错误文案。 */
export type HostFileFailureReason =
  | "absent"
  | "not-file"
  | "not-text"
  | "too-large"
  | "denied"
  | "unsupported"
  | "closed"
  | "unknown";

/** 一次文件访问的失败；`reason` 是唯一判据。 */
export class HostFileError extends Error {
  constructor(
    readonly reason: HostFileFailureReason,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HostFileError";
  }

  /**
   * 给芯片分类用的三态。
   *
   * `not-file` 仍表示「那里有个东西」，所以是 `present`；目录不是删除。
   */
  get existence(): "present" | "absent" | "unknown" {
    if (this.reason === "absent") return "absent";
    if (this.reason === "not-file") return "present";
    return "unknown";
  }
}

/** 一个执行世界文件的 stat；`absolutePath` 是后续 `/api/file` 的唯一授权坐标。 */
export interface HostFileStat {
  readonly absolutePath: string;
  readonly version: string;
  readonly bytes?: number;
}

/** 一次完整文本读取的结果。 */
export interface HostFileText {
  readonly stat: HostFileStat;
  readonly text: string;
}

/** 一次字节读取的结果；`data` 是原始字节，`stat.bytes` 仍是完整文件大小。 */
export interface HostFileBytes {
  readonly stat: HostFileStat;
  readonly data: Uint8Array;
  readonly mediaType?: string;
  /** 0 起的首字节；`readBytes` 的字节窗口回填。 */
  readonly offset?: number;
  /** 窗口是否含文件最后一个字节。 */
  readonly eof?: boolean;
}

/** 文本读取的预算；都是**本客户端的传输预算**，不是 provider 的读权限。 */
export interface HostTextOptions {
  /** 整份文本最多读多少 UTF-8 字节；超过按 `too-large` 拒绝，绝不静默截断。 */
  readonly maxBytes?: number;
}

/** 字节窗口；官方 `WorkspaceFileBytes.options.range`（0 起算）。 */
export interface HostByteRange {
  readonly offset?: number;
  readonly length?: number;
}

/** 字节读取的预算；不给就完全由 Host 的服务端限额裁决。 */
export interface HostBytesOptions {
  /** 已知完整文件大小时，超过此值的请求不发。 */
  readonly maxBytes?: number;
  /** 字节窗口；缺省读完整文件（上限由 provider / 服务端裁决）。 */
  readonly range?: HostByteRange;
  /**
   * 相对 `path` 从另一个文件所在目录解析（官方 `baseFile` 契约）。
   *
   * 目前没有界面消费它，但端口保留：普通文件字节不再走 `/api/file`，这条能力
   * 只能由二进制 RPC 承载。
   */
  readonly baseFile?: string;
}

const DEFAULT_MAX_TEXT_BYTES = 8 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 60_000;
const BYTES_TIMEOUT_MS = 60_000;
/** 完整字节读取的服务端上限是 32 MiB，给握手与传输留足时间。 */
const BINARY_RPC_TIMEOUT_MS = 120_000;

/** 安全整数且非负。 */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 执行世界的绝对路径形态：POSIX 单斜杠根、Windows 盘符根，或 UNC。
 *
 * **不能用 `node:path.isAbsolute`**：它按扩展宿主平台判断，在 Windows 客户端上看
 * 不出远端 POSIX 的 `/home/x`，在 Linux 客户端上也会把 `C:\x` 当相对路径。这里
 * 只看字符串形态，不做任何规范化。
 */
export function isExecutionWorldAbsolute(path: string): boolean {
  if (!path) return false;
  // POSIX 根：官方判据就是 `startsWith('/')`（`//host/share` 也先算绝对，媒体层再拒 UNC）。
  if (path.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/u.test(path)) return true;
  if (/^\\\\[^\\]/u.test(path)) return true;
  return false;
}

/**
 * 把会话创建目录与相对拼写拼成一个**执行世界绝对路径**（官方
 * `resolveWorkspacePath` 的纯字符串口径）。
 *
 * 只做拼接：绝对输入原样返回，相对输入沿用创建目录的分隔符风格，不消 `.` /
 * `..`、不做本机 realpath、不按扩展宿主平台改写。缺创建目录时相对输入返回
 * `undefined`——调用方不能声称知道它的绝对位置。这个结果还要交 Host 复核映射，
 * 客户端不拿它当读取坐标。
 */
export function resolveExecutionWorldPath(
  cwd: string | undefined,
  path: string,
): string | undefined {
  if (!path) return undefined;
  if (isExecutionWorldAbsolute(path)) return path;
  if (!cwd) return undefined;
  const windows = /^[A-Za-z]:[\\/]/u.test(cwd) || /^\\\\/u.test(cwd);
  const separator = windows && cwd.includes("\\") ? "\\" : "/";
  const base = cwd.replace(/[/\\]+$/u, "");
  const relative = path.replace(/^[/\\]+/u, "");
  return `${base}${separator}${relative}`;
}

/** 该路径是否为 UNC（媒体路由明确拒绝）。 */
export function isUncPath(path: string): boolean {
  return /^\\\\/u.test(path) || /^\/\//u.test(path);
}

/** 控制字符（含 NUL）不能进入媒体路径。 */
export function hasControlCharacter(path: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(path);
}

/**
 * 媒体路径的**客户端**拒绝条件：UNC、控制字符、盘符相对（`C:foo`）。
 *
 * 不在这里做扩展名白名单或目录包含性判断：那些是 provider 的读权限与服务端限额
 * 的事，不是客户端媒体路由的授权条件。
 */
export function unsupportedMediaPath(path: string): string | undefined {
  if (!path) return "empty path";
  if (hasControlCharacter(path)) return "control character";
  if (isUncPath(path)) return "UNC path";
  if (/^[A-Za-z]:(?![\\/])/u.test(path)) return "drive-relative path";
  return undefined;
}

/** 明确 Windows 形态：盘符绝对或 UNC。只有这类路径才把 `/` 归一成 `\\`。 */
function isWindowsPathForm(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\/u.test(path);
}

/**
 * 路径比较键：**只对明确 Windows 形态**统一分隔符并去掉结尾分隔符。
 *
 * 不无条件把 `\` 换成 `/`：POSIX 的 `a\b` 是合法文件名，与 `a/b` 不是同一个目标。
 * 不消 `.` / `..`，也不按扩展宿主平台猜大小写；绝对化与规范化由 Host 负责。
 */
export function executionPathKey(path: string): string {
  if (isWindowsPathForm(path)) return path.replace(/\//gu, "\\").replace(/\\+$/u, "");
  return path.replace(/\/+$/u, "");
}

/**
 * 两个执行世界路径是否指同一目标。
 *
 * 只做上一条键的**字符串相等**比较；不 lowercase、不消点。Windows 的大小写
 * 不敏感性由 Host 的 `absolutePath` 规范化结果承担，客户端不猜。
 */
export function sameExecutionPath(left: string, right: string): boolean {
  const a = executionPathKey(left);
  const b = executionPathKey(right);
  return a.length > 0 && a === b;
}

/** 媒体类型只取 mime 本体，不带参数。 */
function mediaTypeOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const type = value.split(";")[0]?.trim().toLowerCase();
  return type && type.includes("/") ? type : undefined;
}

/** 一个页/一份文件的 stat 线格式校验。 */
function statFromWire(value: unknown, path: string): HostFileStat {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostFileError("unknown", `workspaceFiles.stat returned a non-object for "${path}"`);
  }
  const record = value as { absolutePath?: unknown; version?: unknown; bytes?: unknown };
  const absolutePath = record.absolutePath;
  const version = record.version;
  const bytes = record.bytes;
  if (typeof absolutePath !== "string" || !isExecutionWorldAbsolute(absolutePath)) {
    throw new HostFileError(
      "unknown",
      `workspaceFiles stat returned an invalid absolutePath for "${path}"`,
    );
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new HostFileError("unknown", `workspaceFiles stat returned an invalid version for "${path}"`);
  }
  if (bytes !== undefined && !isCount(bytes)) {
    throw new HostFileError("unknown", `workspaceFiles stat returned an invalid byte count for "${path}"`);
  }
  return { absolutePath, version, ...(bytes === undefined ? {} : { bytes }) };
}

/** 一页文本的线格式校验。 */
function pageFromWire(
  value: unknown,
  path: string,
  requestedOffset: number,
): HostFileStat & { offset: number; text: string; lines: number; eof: boolean } {
  const stat = statFromWire(value, path);
  const record = value as {
    offset?: unknown;
    text?: unknown;
    lines?: unknown;
    eof?: unknown;
  };
  if (!isCount(record.offset) || record.offset < 1 || record.offset !== requestedOffset) {
    throw new HostFileError(
      "unknown",
      `workspaceFiles.read returned offset ${String(record.offset)} for a request at ${requestedOffset} for "${path}"`,
    );
  }
  if (typeof record.text !== "string" || !isCount(record.lines) || typeof record.eof !== "boolean") {
    throw new HostFileError("unknown", `workspaceFiles.read returned an invalid page for "${path}"`);
  }
  const counted = record.text === "" ? (record.lines === 0 ? 0 : 1) : record.text.split("\n").length;
  if (counted !== record.lines) {
    throw new HostFileError(
      "unknown",
      `workspaceFiles.read page for "${path}" reports ${record.lines} lines but carries ${counted}`,
    );
  }
  if (record.lines === 0 && !record.eof) {
    throw new HostFileError("unknown", `workspaceFiles.read returned an empty page before EOF for "${path}"`);
  }
  return {
    ...stat,
    offset: record.offset,
    text: record.text,
    lines: record.lines,
    eof: record.eof,
  };
}

/** 一条完整字节结果：stat + 0 起算的窗口与原始字节。 */
function bytesFromWire(value: unknown, path: string): HostFileBytes {
  const stat = statFromWire(value, path);
  const record = value as { offset?: unknown; data?: unknown; eof?: unknown };
  if (!isCount(record.offset)) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned an invalid offset for "${path}"`);
  }
  if (typeof record.eof !== "boolean") {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned an invalid eof for "${path}"`);
  }
  if (!(record.data instanceof Uint8Array)) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned no bytes for "${path}"`);
  }
  return {
    stat,
    data: record.data,
    offset: record.offset,
    eof: record.eof,
  };
}

/**
 * 字节窗口自洽：客户端不能把「截片」冒充完整文件，也不能接受错位的窗口。
 *
 * 无 `range` 时要求 offset 0、eof true，且（Host 报了大小时）长度等于完整大小；
 * 有 `range` 时要求回显的 offset 与请求一致、数据不超过请求 length，并核对
 * offset + 数据长度与 `stat.bytes` 的 eof 关系。
 */
function assertByteWindow(
  bytes: HostFileBytes,
  range: HostByteRange | undefined,
  path: string,
): void {
  const offset = bytes.offset;
  const eof = bytes.eof;
  if (offset === undefined || eof === undefined) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned no window for "${path}"`);
  }
  const expectedOffset = range?.offset ?? 0;
  if (offset !== expectedOffset) {
    throw new HostFileError(
      "unknown",
      `workspaceFiles.readBytes returned offset ${offset} for a request at ${expectedOffset} for "${path}"`,
    );
  }
  if (bytes.data.byteLength === 0 && !eof) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned an empty window before EOF for "${path}"`);
  }
  if (!range) {
    if (offset !== 0 || !eof) {
      throw new HostFileError("unknown", `workspaceFiles.readBytes returned a partial file for "${path}"`);
    }
    if (bytes.stat.bytes !== undefined && bytes.data.byteLength !== bytes.stat.bytes) {
      throw new HostFileError("unknown", `workspaceFiles.readBytes returned a truncated file for "${path}"`);
    }
    return;
  }
  if (range.length !== undefined && bytes.data.byteLength > range.length) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned more bytes than requested for "${path}"`);
  }
  const end = offset + bytes.data.byteLength;
  if (bytes.stat.bytes !== undefined) {
    if (end > bytes.stat.bytes) {
      throw new HostFileError("unknown", `workspaceFiles.readBytes returned a window past EOF for "${path}"`);
    }
    if (eof && end !== bytes.stat.bytes) {
      throw new HostFileError("unknown", `workspaceFiles.readBytes claimed EOF before the file ended for "${path}"`);
    }
    if (!eof && end >= bytes.stat.bytes) {
      throw new HostFileError("unknown", `workspaceFiles.readBytes missed EOF at the end of the file for "${path}"`);
    }
  }
  if (range.length !== undefined && bytes.data.byteLength < range.length && !eof) {
    throw new HostFileError("unknown", `workspaceFiles.readBytes returned a short window without EOF for "${path}"`);
  }
}

/** 服务端错误码 → 本模块的失败原因；只有 not-found 是 absent。 */
function errorFromTransport(error: unknown): HostFileError {
  if (error instanceof HostFileError) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "workspace-file/not-found") {
    return new HostFileError("absent", message, String(code));
  }
  if (code === "workspace-file/not-regular-file") {
    return new HostFileError("not-file", message, String(code));
  }
  if (code === "workspace-file/not-text") {
    return new HostFileError("not-text", message, String(code));
  }
  if (code === "workspace-file/too-large") {
    return new HostFileError("too-large", message, String(code));
  }
  if (code === "workspace-file/outside-workspace") {
    // 文件读没有这条；它只会来自目录列举 / 观察，按未知处理，绝不等于 absent。
    return new HostFileError("unknown", message, String(code));
  }
  if (code === "workspace-file/watch-unsupported") {
    return new HostFileError("unsupported", message, String(code));
  }
  if (
    code === "gateway/lookup-not-found" ||
    code === "gateway/invocation-unavailable" ||
    code === "gateway/service-unavailable" ||
    code === "gateway/method-unavailable"
  ) {
    return new HostFileError("unknown", message, String(code));
  }
  // 认证、网络、HTTP 5xx、旧服务端没有 workspaceFiles……都不是「文件没了」。
  return new HostFileError("unknown", message, typeof code === "string" ? code : undefined);
}

/**
 * 一条连接上的执行世界文件访问。
 *
 * 生产路径由 controller 在客户端换代时创建 / 关闭；`connectionId` 是资源 URI
 * 的一部分，关闭后不再解析，绝不把旧 URI 交给新连接。
 */
export class HostFileAccess {
  /** 资源 URI 的连接身份；与 DSH 客户端对象一一对应。 */
  readonly connectionId = randomUUID();
  private closed = false;
  private readonly maxTextBytes: number;

  constructor(
    private readonly transport: HostFileTransport,
    options: { readonly maxTextBytes?: number } = {},
  ) {
    this.maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
  }

  /** 该连接已失效：后续请求全部以 `closed` 失败。 */
  close(): void {
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new HostFileError("closed", "the DSH connection that owns this file has closed");
    }
  }

  /**
   * 读取一个文件的身份、版本与大小。
   *
   * `path` 可以是执行世界绝对路径，也可以原样交给 Host 的相对路径；客户端不拼
   * 目录、不检查包含性。
   */
  async stat(sessionId: string, path: string): Promise<HostFileStat> {
    this.assertOpen();
    try {
      const raw = await this.transport.request<unknown>(
        "workspaceFiles/stat",
        { workspaceFileScopeId: sessionId, path },
        PAGE_TIMEOUT_MS,
      );
      const stat = statFromWire(raw, path);
      this.assertOpen();
      return stat;
    } catch (error) {
      throw errorFromTransport(error);
    }
  }

  /**
   * 分页读取完整文本。
   *
   * 每页的 `version` 必须与前页一致；读到一半文件变了就不能把两版拼在一起。
   * 结果是**行片段的拼接**：页的 `text` 不带最后那个终结符，所以这里也不推测
   * 原文件末尾是否有换行。需要真实字节的消费方（VS Code 资源、图片）走
   * {@link readBytes}，不拿这份文本反推。
   */
  async readText(sessionId: string, path: string, options: HostTextOptions = {}): Promise<HostFileText> {
    this.assertOpen();
    const maxBytes = options.maxBytes ?? this.maxTextBytes;
    try {
      const first = await this.readPage(sessionId, path, 1);      const stat: HostFileStat = {
        absolutePath: first.absolutePath,
        version: first.version,
        ...(first.bytes === undefined ? {} : { bytes: first.bytes }),
      };
      const parts = [first.text];
      let total = Buffer.byteLength(first.text, "utf8");
      let offset = 1 + first.lines;
      let eof = first.eof;
      let lines = first.lines;
      while (!eof) {
        if (lines === 0) {
          throw new HostFileError("unknown", `workspaceFiles.read made no progress for "${path}"`);
        }
        if (total > maxBytes) {
          throw new HostFileError("too-large", `text of "${path}" exceeds the client read budget`);
        }
        const page = await this.readPage(sessionId, path, offset);
        if (page.absolutePath !== stat.absolutePath || page.version !== stat.version) {
          throw new HostFileError("unknown", `"${path}" changed while it was being read`);
        }
        if (page.lines === 0) {
          throw new HostFileError("unknown", `workspaceFiles.read made no progress for "${path}"`);
        }
        total += 1 + Buffer.byteLength(page.text, "utf8");
        parts.push(page.text);
        offset += page.lines;
        lines = page.lines;
        eof = page.eof;
      }
      if (total > maxBytes) {
        throw new HostFileError("too-large", `text of "${path}" exceeds the client read budget`);
      }
      this.assertOpen();
      // 页模型只在换行处分页；用 `\n` 接回去保留页内原有的 CRLF 与多字节字符。
      // 末尾终结符不在任何一页里，保持「不推测」。
      return { stat, text: parts.join("\n") };
    } catch (error) {
      throw errorFromTransport(error);
    }
  }

  /**
   * 读取完整文件或原始字节（**普通文件**：`workspaceFiles/readBytes` 二进制 RPC）。
   *
   * 这条通道承载任意普通文件，不经过媒体路由的 MIME / 图片限额；`data` 是原始
   * 字节，`stat` 与窗口字段逐项校验。相对路径由 Host 按会话根解析；`baseFile`
   * 保留官方契约（相对 `path` 从该文件所在目录解释）。
   *
   * 需要 `/api/file` 的消费方（正文图片、媒体预览）走 {@link readBytesAt}：那条
   * 路由的部署限额由 Host 裁决，不能拿这个 RPC 冒充，也不能反过来把媒体路由当
   * 通用文件系统。
   */
  async readBytes(
    sessionId: string,
    path: string,
    options: HostBytesOptions = {},
  ): Promise<HostFileBytes> {
    this.assertOpen();
    const range = options.range;
    if (range) {
      if (range.offset !== undefined && !isCount(range.offset)) {
        throw new HostFileError("unknown", `invalid byte range offset for "${path}"`);
      }
      if (range.length !== undefined && (!isCount(range.length) || range.length === 0)) {
        throw new HostFileError("unknown", `invalid byte range length for "${path}"`);
      }
    }
    const wire: Record<string, unknown> = {};
    if (range) {
      const wireRange: Record<string, number> = {};
      if (range.offset !== undefined) wireRange.offset = range.offset;
      if (range.length !== undefined) wireRange.length = range.length;
      wire.range = wireRange;
    }
    if (options.baseFile !== undefined) wire.baseFile = options.baseFile;
    try {
      const raw = await this.transport.request<unknown>(
        "workspaceFiles/readBytes",
        { workspaceFileScopeId: sessionId, path, options: wire },
        BINARY_RPC_TIMEOUT_MS,
      );
      this.assertOpen();
      const bytes = bytesFromWire(raw, path);
      assertByteWindow(bytes, range, path);
      if (options.maxBytes !== undefined && bytes.data.byteLength > options.maxBytes) {
        throw new HostFileError("too-large", `"${path}" exceeds the client byte budget`);
      }
      return bytes;
    } catch (error) {
      throw errorFromTransport(error);
    }
  }

  /**
   * 从**已知 stat** 取原始字节（媒体走已认证的 `GET /api/file`）。
   *
   * `stat.absolutePath` 必须来自本连接的 `workspaceFiles.stat`；调用方不得用本机
   * 路径拼它。媒体路由的部署限额（官方图片字节上限）由 Host 裁决，客户端不另造
   * 图片字节门；普通文件不经过这里，走 {@link readBytes} 的二进制 RPC。
   */
  async readBytesAt(stat: HostFileStat, path: string, options: HostBytesOptions = {}): Promise<HostFileBytes> {
    this.assertOpen();
    if (options.maxBytes !== undefined && stat.bytes !== undefined && stat.bytes > options.maxBytes) {
      throw new HostFileError("too-large", `"${path}" exceeds the client byte budget`);
    }
    if (!isExecutionWorldAbsolute(stat.absolutePath)) {
      throw new HostFileError("unknown", `"${path}" has no execution-world absolute path`);
    }
    const query = new URLSearchParams({ path: stat.absolutePath });
    let response: HostFileBytesResponse | undefined;
    try {
      response = await this.transport.getBytes(`/api/file?${query.toString()}`, BYTES_TIMEOUT_MS);
    } catch (error) {
      throw errorFromTransport(error);
    }
    this.assertOpen();
    if (!response) {
      // stat 刚说存在，路由却 404：更可能是这个 Host 没有媒体路由，或文件在两次请求间没了。
      // 两种都不能声称「已删除」，因此是 unknown。
      throw new HostFileError("unknown", `the Host returned no bytes for "${path}"`, "host/file-missing");
    }
    if (options.maxBytes !== undefined && response.bytes.byteLength > options.maxBytes) {
      throw new HostFileError("too-large", `"${path}" exceeds the client byte budget`);
    }
    return {
      stat,
      data: response.bytes,
      offset: 0,
      eof: true,
      ...(mediaTypeOf(response.mediaType) === undefined ? {} : { mediaType: mediaTypeOf(response.mediaType) }),
    };
  }

  /** 芯片分类用的三态；任何非 not-found 的失败都不会被说成删除。 */
  async classify(sessionId: string, path: string): Promise<"present" | "absent" | "unknown"> {
    try {
      await this.stat(sessionId, path);
      return "present";
    } catch (error) {
      if (error instanceof HostFileError) return error.existence;
      return "unknown";
    }
  }

  /**
   * 观察一个文件在 Host 里的变化（有界：只订阅一个 target，dispose 即取消）。
   *
   * 帧形状来自官方 `changes.ts`：`ready` 之后是
   * `{kind:'change', change:{absolutePath, version}}` 或
   * `{kind:'change', change:{absolutePath, absent:true}}`。`absolutePath` 必须与
   * 打开时 stat 的目标一致，否则忽略——不能拿另一个路径的版本刷新这个资源。
   * 观察失败（权限、传输断开、watch 不支持）只报 `error`，绝不发 `absent`。
   */
  watch(
    sessionId: string,
    path: string,
    absolutePath: string,
    onEvent: (event: HostFileWatchEvent) => void,
  ): HostFileWatch | undefined {
    if (this.closed || !this.transport.watchWorkspaceFile) return undefined;
    const stream = this.transport.watchWorkspaceFile(sessionId, path, {
      onFrame: (frame) => {
        if (this.closed) return;
        if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
        const kind = (frame as { kind?: unknown }).kind;
        if (kind === "ready") {
          onEvent({ kind: "ready" });
          return;
        }
        if (kind !== "change") return;
        const change = (frame as { change?: unknown }).change;
        if (typeof change !== "object" || change === null || Array.isArray(change)) return;
        const record = change as { absolutePath?: unknown; version?: unknown; absent?: unknown };
        if (typeof record.absolutePath !== "string" || !sameExecutionPath(record.absolutePath, absolutePath)) {
          return;
        }
        if (record.absent === true) {
          onEvent({ kind: "absent" });
          return;
        }
        if (typeof record.version === "string" && record.version.length > 0) {
          onEvent({ kind: "changed", version: record.version });
        }
      },
      onEnd: () => onEvent({ kind: "end" }),
      onError: (error) => onEvent({ kind: "error", error }),
    });
    return {
      dispose: () => {
        stream.cancel();
      },
    };
  }

  private async readPage(
    sessionId: string,
    path: string,
    offset: number,
  ): Promise<HostFileStat & { offset: number; text: string; lines: number; eof: boolean }> {
    const raw = await this.transport.request<unknown>(
      "workspaceFiles/read",
      {
        workspaceFileScopeId: sessionId,
        path,
        // 不传 limit：由服务端的 maxLines 决定页大小，客户端不猜部署配置。
        range: { offset },
      },
      PAGE_TIMEOUT_MS,
    );
    return pageFromWire(raw, path, offset);
  }
}

/** 日志用的一句话：原因 + 服务端 code，不把服务端 message 当用户文案。 */
export function describeHostFileError(error: unknown): string {
  if (error instanceof HostFileError) {
    return `${error.reason}${error.code ? ` (${error.code})` : ""}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

