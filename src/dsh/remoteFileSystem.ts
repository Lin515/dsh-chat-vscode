/**
 * VS Code 侧的**只读虚拟文件系统**：把执行世界文件交给编辑器/图片预览展示。
 *
 * 资源 URI 只承担「展示容器」：`dsh-chat-world:/<basename>?id=<连接+会话+路径>`。
 * 内容、存在性与版本一律回问产生该路径的 DSH 连接（见 `remoteFiles.ts`），
 * 不调用本机 `fs`，也不把 URI 变成 `file:`。连接关闭或 URI 不属于当前注册表时，
 * 明确报不可用——绝不交给当前连接解释。
 *
 * **时效**：`readFile` 是读取那一刻的快照；普通文件走 `workspaceFiles/readBytes`
 * 二进制 RPC（不是媒体路由）。打开中的资源同时订阅 Host 的
 * `workspaceFiles/changes`（官方 payload `{workspaceFileScopeId, path}`），并用
 * 一个有界 restat 兜底断线/观察失败；版本变化才发 `Changed`，明确的
 * `workspace-file/not-found` 才发 `Deleted`，权限/未知错误不发删除。删除后观察
 * 继续，文件重建时发 `Created`。同一个 URI 的多个观察者各自 dispose，最后一个
 * 才取消流与 timer；这些规则在 `remoteFileSync.ts` 里（可离线测试）。
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
import { RemoteFileSync, type RemoteFileWatchTarget } from "./remoteFileSync";
import { HostFileError, type HostFileAccess } from "./remoteFiles";

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
      return vscode.FileSystemError.Unavailable(
        vscode.l10n.t("The DSH connection that owns this file has closed."),
      );
    }
    return vscode.FileSystemError.Unavailable(error.message);
  }
  return vscode.FileSystemError.Unavailable(
    error instanceof Error ? error.message : String(error),
  );
}

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
  private readonly sync: RemoteFileSync;
  /** 只有诊断/测试会读：观察数与版本表条目数。 */
  get watcherCount(): number {
    return this.sync.watcherCount;
  }

  constructor(
    private readonly resolveConnection: HostFileConnectionResolver,
    options: {
      readonly maxWatchers?: number;
      readonly maxVersions?: number;
      readonly pollIntervalMs?: number;
      readonly now?: () => number;
      readonly setInterval?: (callback: () => void, ms: number) => { cancel(): void };
    } = {},
  ) {
    this.sync = new RemoteFileSync({
      emit: (key, change) => {
        this.changes.fire([
          {
            type:
              change === "created"
                ? vscode.FileChangeType.Created
                : change === "deleted"
                  ? vscode.FileChangeType.Deleted
                  : vscode.FileChangeType.Changed,
            uri: vscode.Uri.parse(key),
          },
        ]);
      },
      ...options,
    });
  }

  private access(uri: vscode.Uri): { access: HostFileAccess; address: RemoteFileAddress } {
    const address = parseRemoteFileUri(uri);
    if (!address) throw vscode.FileSystemError.FileNotFound(uri);
    const access = this.resolveConnection(address.connectionId);
    if (!access || access.isClosed) {
      // 失效地址只报不可用，绝不回退当前连接（那会把另一个连接的同名文件冒充成它）。
      throw vscode.FileSystemError.Unavailable(
        vscode.l10n.t("The DSH connection that owns this file is no longer available."),
      );
    }
    return { access, address };
  }

  /**
   * 观察一个打开中的资源。
   *
   * 同一 URI 的第二次 watch 复用同一观察（引用计数，各自 dispose）；观察数超过
   * 上限时返回空句柄（文件仍能正常读取），避免无界 timer。关闭文档时 VS Code 会
   * dispose 这里返回的每一个句柄。
   */
  watch(
    uri: vscode.Uri,
    _options: { readonly recursive: boolean; readonly excludes: readonly string[] },
  ): vscode.Disposable {
    const key = uri.toString();
    let resolved: { access: HostFileAccess; address: RemoteFileAddress };
    try {
      resolved = this.access(uri);
    } catch {
      return new vscode.Disposable(() => {});
    }
    const target: RemoteFileWatchTarget = {
      get closed() {
        return resolved.access.isClosed;
      },
      stat: () => resolved.access.stat(resolved.address.sessionId, resolved.address.path),
      watch: (absolutePath, onEvent) => {
        const handle = resolved.access.watch(
          resolved.address.sessionId,
          resolved.address.path,
          absolutePath,
          onEvent,
        );
        return handle ? { cancel: () => handle.dispose() } : undefined;
      },
    };
    const handle = this.sync.watch(key, target);
    return new vscode.Disposable(() => handle.dispose());
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { access, address } = this.access(uri);
    try {
      const stat = await access.stat(address.sessionId, address.path);
      // mtime 由 opaque 版本派生，不是 Host 给的墙钟；同版本稳定、新版本严格递增。
      // 没有它，同大小内容更新在 VS Code 的缓存里仍是旧内容。
      const mtime = this.sync.mtimeFor(uri.toString(), stat.version);
      return {
        type: vscode.FileType.File,
        ctime: mtime,
        mtime,
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
      // 普通文件走 workspaceFiles/readBytes；`/api/file` 只服务正文图片/媒体，
      // 不能把它的 MIME 与部署限额套到任意普通文件上。
      // 不传 maxBytes：限额由 Host 的 workspaceFiles.maxFileBytes（官方默认 32 MiB）
      // 裁决，客户端不复制部署限额。
      const file = await access.readBytes(address.sessionId, address.path);
      this.sync.mtimeFor(uri.toString(), file.stat.version);
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
    this.sync.dispose();
    this.changes.dispose();
  }
}
