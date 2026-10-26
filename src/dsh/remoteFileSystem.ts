/**
 * VS Code 侧的**只读虚拟文件系统**：把执行世界文件交给编辑器/图片预览展示。
 *
 * 资源 URI 只承担「展示容器」：`dsh-chat-world:/<basename>?id=<连接+会话+路径>`。
 * 内容、存在性与版本一律回问产生该路径的 DSH 连接（见 `remoteFiles.ts`），
 * 不调用本机 `fs`，也不把 URI 变成 `file:`。连接关闭或 URI 不属于当前注册表时，
 * 明确报不可用——绝不交给当前连接解释。
 *
 * **时效**：`readFile` 是读取那一刻的快照。打开中的资源同时订阅 Host 的
 * `workspaceFiles/changes`（官方 payload `{workspaceFileScopeId, path}`），并用
 * 一个有界 restat 兜底断线/观察失败；版本变化才发 `Changed`，明确的
 * `workspace-file/not-found` 才发 `Deleted`，权限/未知错误不发删除。
 *
 * provider 没有写能力：普通文件是只读预览，不伪造「编辑后能保存」；VS Code 的
 * 只读标记由注册项 `isReadonly` 与这里拒绝写操作共同保证。
 */

import * as vscode from "vscode";
import {
  decodeRemoteFileAddress,
  encodeRemoteFileAddress,
  remoteFileBasename,
  type RemoteFileAddress,
} from "./remoteFileAddress";
import {
  HostFileError,
  type HostFileAccess,
  type HostFileWatch,
  type HostFileWatchEvent,
} from "./remoteFiles";

/** 自定义 scheme：只由本扩展注册，不会与本机文件或其它扩展冲突。 */
export const REMOTE_FILE_SCHEME = "dsh-chat-world";

/** 连接 id → 该连接的文件访问；返回 undefined 表示地址已失效。 */
export type HostFileConnectionResolver = (connectionId: string) => HostFileAccess | undefined;

/**
 * 构造一条资源 URI。
 *
 * 身份三元组放在 query（大小写敏感、不会被 URI authority 规范化吞掉）；路径末段
 * 只用于标签显示，行号绝不进 URI。
 */
export function remoteFileUri(address: RemoteFileAddress): vscode.Uri {
  return vscode.Uri.from({
    scheme: REMOTE_FILE_SCHEME,
    path: `/${remoteFileBasename(address.path)}`,
    query: `id=${encodeRemoteFileAddress(address)}`,
  });
}

/** 从 URI 取回身份；不是本 scheme / query 不完整时 undefined。 */
export function parseRemoteFileUri(uri: vscode.Uri): RemoteFileAddress | undefined {
  if (uri.scheme !== REMOTE_FILE_SCHEME) return undefined;
  const query = uri.query;
  if (!query.startsWith("id=")) return undefined;
  return decodeRemoteFileAddress(query.slice(3));
}

function fileSystemError(uri: vscode.Uri, error: unknown): Error {
  if (error instanceof HostFileError) {
    if (error.reason === "absent") return vscode.FileSystemError.FileNotFound(uri);
    if (error.reason === "not-file") return vscode.FileSystemError.FileNotADirectory(uri);
    if (error.reason === "denied") return vscode.FileSystemError.NoPermissions(uri);
    if (error.reason === "closed") {
      return vscode.FileSystemError.Unavailable("The DSH connection that owns this file has closed.");
    }
    return vscode.FileSystemError.Unavailable(error.message);
  }
  return vscode.FileSystemError.Unavailable(
    error instanceof Error ? error.message : String(error),
  );
}

/** 打开中的资源最多同时观察多少个 target（防止长会话里每开一个文件就留一个 timer）。 */
const MAX_WATCHERS = 32;

/** 观察失败 / 断线时的兜底 restat 间隔。 */
const RESTAT_INTERVAL_MS = 10_000;

/**
 * 执行世界文件的只读 provider。
 *
 * 注册方式见 `extension.ts`：`registerFileSystemProvider(REMOTE_FILE_SCHEME, …,
 * { isReadonly: true })`。这里不持有 controller，只通过 resolver 查当前登记的
 * 连接，测试可以注入一个脚本化的 resolver 与 fake access。
 */
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;
  /** 每个 URI 最近一次 stat 的 version；观察开始时用它判断「真的变了」。 */
  private readonly versions = new Map<string, string>();
  private readonly watchers = new Map<string, vscode.Disposable>();

  constructor(private readonly resolveConnection: HostFileConnectionResolver) {}

  private access(uri: vscode.Uri): { access: HostFileAccess; address: RemoteFileAddress } {
    const address = parseRemoteFileUri(uri);
    if (!address) throw vscode.FileSystemError.FileNotFound(uri);
    const access = this.resolveConnection(address.connectionId);
    if (!access || access.isClosed) {
      // 失效地址只报不可用，绝不回退当前连接（那会把另一个连接的同名文件冒充成它）。
      throw vscode.FileSystemError.Unavailable(
        "The DSH connection that owns this file is no longer available.",
      );
    }
    return { access, address };
  }

  /**
   * 观察一个打开中的资源。
   *
   * 先订阅 Host 的 change feed；传输断开或 watch 不可用时保留有界 restat 兜底。
   * 观察数超过 {@link MAX_WATCHERS} 时不建立新观察（文件仍能正常读取），避免
   * 无界 timer；关闭文档时 VS Code 会 dispose 这里返回的句柄。
   */
  watch(uri: vscode.Uri, _options: { readonly recursive: boolean; readonly excludes: readonly string[] }): vscode.Disposable {
    const key = uri.toString();
    const existing = this.watchers.get(key);
    if (existing) return existing;
    if (this.watchers.size >= MAX_WATCHERS) return new vscode.Disposable(() => {});
    const target = (() => {
      try {
        return this.access(uri);
      } catch {
        return undefined;
      }
    })();
    if (!target) return new vscode.Disposable(() => {});

    let disposed = false;
    let stream: HostFileWatch | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const handle = new vscode.Disposable(() => dispose());

    const emit = (type: vscode.FileChangeType): void => {
      if (disposed) return;
      this.changes.fire([{ type, uri }]);
    };

    const check = async (): Promise<void> => {
      if (disposed) return;
      if (target.access.isClosed) {
        dispose();
        return;
      }
      try {
        const stat = await target.access.stat(target.address.sessionId, target.address.path);
        if (disposed) return;
        const previous = this.versions.get(key);
        this.versions.set(key, stat.version);
        if (previous !== undefined && previous !== stat.version) emit(vscode.FileChangeType.Changed);
      } catch (error) {
        if (disposed) return;
        // 只有明确的 not-found 才是删除；权限 / 离线 / 未知错误保持现状。
        if (error instanceof HostFileError && error.reason === "absent") {
          emit(vscode.FileChangeType.Deleted);
          dispose();
        }
      }
    };

    const onEvent = (event: HostFileWatchEvent): void => {
      if (disposed) return;
      if (event.kind === "ready") {
        // ready 只确认观察生效；不以它改状态，版本仍以 stat 为准。
        return;
      }
      if (event.kind === "changed") {
        const previous = this.versions.get(key);
        this.versions.set(key, event.version);
        if (previous !== undefined && previous !== event.version) {
          emit(vscode.FileChangeType.Changed);
        }
        return;
      }
      if (event.kind === "absent") {
        emit(vscode.FileChangeType.Deleted);
        dispose();
        return;
      }
      // error / end：流失效，不推断文件状态；保留 restat 兜底。
      stream?.dispose();
      stream = undefined;
    };

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      stream?.dispose();
      stream = undefined;
      if (this.watchers.get(key) === handle) this.watchers.delete(key);
      this.versions.delete(key);
    };

    // 初始版本取最近一次 stat；没有就先跑一次，避免把第一次 restat 当成「变化」。
    void target.access
      .stat(target.address.sessionId, target.address.path)
      .then((stat) => {
        if (disposed) return;
        this.versions.set(key, stat.version);
        stream = target.access.watch(
          target.address.sessionId,
          target.address.path,
          stat.absolutePath,
          onEvent,
        );
      })
      .catch(() => {
        // 读不到不建立观察；下一次真正打开时还会再试。
      });
    timer = setInterval(() => {
      void check();
    }, RESTAT_INTERVAL_MS);
    timer.unref?.();
    this.watchers.set(key, handle);
    return handle;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { access, address } = this.access(uri);
    try {
      const stat = await access.stat(address.sessionId, address.path);
      this.versions.set(uri.toString(), stat.version);
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: 0,
        // `bytes` 是 Host 报告的完整文件大小；缺省时用 0，不拿本机 stat 补。
        size: stat.bytes ?? 0,
      };
    } catch (error) {
      throw fileSystemError(uri, error);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { access, address } = this.access(uri);
    try {
      const file = await access.readBytes(address.sessionId, address.path);
      this.versions.set(uri.toString(), file.stat.version);
      return file.data;
    } catch (error) {
      throw fileSystemError(uri, error);
    }
  }

  readDirectory(uri: vscode.Uri): never {
    // 资源面只承载单文件；目录列举仍走普通文件链接 / `@` 查询，不在虚拟 FS 里伪造。
    throw vscode.FileSystemError.FileNotADirectory(uri);
  }

  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) watcher.dispose();
    this.watchers.clear();
    this.versions.clear();
    this.changes.dispose();
  }
}
