import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { clearLease, clearStaleDocumentLocks, updateLease, writeLease } from "./processRegistry";

/**
 * 服务器连接信息。
 */
export interface ServerInfo {
  /** 形如 http://127.0.0.1:3080（不含尾部斜杠）。 */
  baseUrl: string;
  /** 用于换取签名 cookie 的启动 token（外部服务器可能没有）。 */
  token?: string;
  /** 是否由本扩展启动并持有其生命周期。 */
  owned: boolean;
}

export type ServerState = "stopped" | "starting" | "ready" | "failed";

export interface ServerStatus {
  state: ServerState;
  info?: ServerInfo;
  detail?: string;
}

/**
 * `dsh web` 服务器生命周期管理。
 *
 * 设计要点：
 * - 用 `--port 0 --no-open` 启动：端口交给操作系统分配（永不撞端口），且不抢占用户浏览器。
 * - 服务器就绪时会打印一行 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`，
 *   我们从子进程日志里解析出真实端口与启动 token（0.1.2 起 /api 需要签名 cookie）。
 * - 子进程输出重定向到临时日志文件而非管道：既避免管道缓冲/沙箱限制，也便于出错时回看。
 */
export class ServerManager {
  private child: ChildProcess | undefined;
  private status: ServerStatus = { state: "stopped" };
  private readonly listeners = new Set<(status: ServerStatus) => void>();
  private startPromise: Promise<ServerInfo> | undefined;
  // 日志路径按进程唯一：固定文件名会被同机另一个扩展实例（或测试脚本）截断，
  // 正在等待就绪的那个实例就会永远解析不到 URL 行
  private readonly logFile = join(tmpdir(), `dsh-chat-server-${process.pid}.log`);

  constructor(
    private readonly options: {
      /** 用户显式配置的服务器地址；非空表示"外部服务器"模式，不自行启动。 */
      readonly url?: string;
      /** 启动命令，默认 dsh。 */
      readonly command: string;
      /** 等待就绪的最长毫秒数。 */
      readonly startTimeoutMs: number;
      /** 当前工作区（写进进程租约，同机多窗口时便于分辨）。 */
      readonly workspace?: string;
      readonly log: (line: string) => void;
    },
  ) {}

  getStatus(): ServerStatus {
    return this.status;
  }

  onDidChangeStatus(listener: (status: ServerStatus) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  private setStatus(status: ServerStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }

  /** 服务器日志的路径（供诊断命令展示）。 */
  get logPath(): string {
    return this.logFile;
  }

  /**
   * 用户显式配置的外部服务器地址（`dshChat.url`），未配置时为 undefined。
   * 外部模式才需要访问令牌，控制器据此决定是否提示输入 token。
   */
  get externalUrl(): string | undefined {
    const url = this.options.url?.trim();
    return url ? url.replace(/\/+$/, "") : undefined;
  }

  /** 读取服务器日志尾部，出错时附在提示里。 */
  logTail(lines = 12): string {
    try {
      const text = readFileSync(this.logFile, "utf8");
      return text.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
    } catch {
      return "";
    }
  }

  /**
   * 确保有一个可用服务器：外部模式下只探测；否则按需启动（幂等）。
   */
  async ensure(): Promise<ServerInfo> {
    const external = this.options.url?.trim();
    if (external) {
      const baseUrl = external.replace(/\/+$/, "");
      this.setStatus({ state: "starting", detail: `connecting ${baseUrl}` });
      const ready = await this.waitForHttp(baseUrl, 5_000);
      if (!ready) {
        const detail = `@serverUnreachable:${baseUrl}`;
        this.setStatus({ state: "failed", detail });
        throw new Error(detail);
      }
      const info: ServerInfo = { baseUrl, owned: false };
      this.setStatus({ state: "ready", info });
      return info;
    }
    if (this.status.state === "ready" && this.status.info) return this.status.info;
    this.startPromise ??= this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /** 重启：仅当服务器由本扩展持有时才停止，然后重新启动。 */
  async restart(): Promise<ServerInfo> {
    this.stop();
    return this.ensure();
  }

  /**
   * 扩展停用（关窗 / 重载扩展）时由 context.subscriptions 调用：
   * 把本扩展拉起的整个进程树带走——否则 Windows 上孤儿进程会一直残留。
   */
  dispose(): void {
    this.stop();
  }

  /** 停止由本扩展启动的服务器（外部服务器不受影响）。 */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined) {
      this.options.log(`[server] 停止子进程 pid=${child.pid}`);
      clearLease(child.pid);
      if (process.platform === "win32") {
        // 直接 kill 只结束 cmd 外壳，taskkill /T 才能带走整棵进程树
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          child.kill();
        }
      } else {
        child.kill("SIGTERM");
      }
    }
    this.setStatus({ state: "stopped" });
  }

  private async start(): Promise<ServerInfo> {
    this.setStatus({ state: "starting" });
    // 清空上一次的日志，避免解析到过期的 token/端口
    writeFileSync(this.logFile, "", "utf8");

    // 起进程**之前**清一次崩溃遗留 writer 锁。放在这里而不是只放在激活期：
    // 这是唯一能保证「无论谁触发启动都清过」的位置（重启服务器命令、手动连接、
    // 自动重连都经这里）。`dsh web` 的 boot 锁不到就等 30 秒然后整个进程退出，
    // 而库本身刻意不回收孤儿锁——回收是客户端的责任。
    try {
      const lock = await clearStaleDocumentLocks((line) => this.options.log(line));
      if (lock.cleared.length) {
        this.options.log(`[server] 清理了 ${lock.cleared.length} 个崩溃遗留的文件锁`);
      }
    } catch (error) {
      // 清锁失败不该拦住启动：服务器自己去试，失败时 staleLockHint 会给出说明
      this.options.log(`[server] 残留锁检测失败：${error instanceof Error ? error.message : String(error)}`);
    }

    const args = ["web", "--port", "0", "--no-open"];
    this.options.log(`[server] 启动：${this.options.command} ${args.join(" ")}`);

    const fd = openSync(this.logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(this.options.command, args, {
        shell: true, // Windows 上是 dsh.cmd，必须经 shell 解析
        windowsHide: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, BROWSER: "none" },
      });
    } finally {
      closeSync(fd);
    }
    this.child = child;
    // 进程租约：VS Code 非正常退出（崩溃/强杀）时，下次激活靠它认出并清理残留
    if (child.pid !== undefined) {
      const recorded = writeLease({
        serverPid: child.pid,
        hostPid: process.pid,
        workspace: this.options.workspace,
        command: this.options.command,
        startedAt: Date.now(),
      });
      if (!recorded) {
        // 不致命，但要说清楚：这台机器上残留进程将无法被自动识别
        this.options.log("[server] 进程租约写入失败，残留进程检测对本进程不可用");
      }
    }

    let exitInfo: string | undefined;
    child.on("error", (error) => {
      exitInfo = `@serverSpawnFailed:${error.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // 已被 stop() 主动结束
      this.child = undefined;
      clearLease(child.pid);
      const detail = `@serverExited:${code ?? "?"}:${signal ?? "?"}`;
      this.options.log(`[server] ${detail}`);
      this.setStatus({ state: "failed", detail });
    });

    const deadline = Date.now() + this.options.startTimeoutMs;
    while (Date.now() < deadline) {
      if (exitInfo !== undefined) break;
      const parsed = this.parseAnnouncement();
      if (parsed) {
        const ok = await this.waitForHttp(parsed.baseUrl, 10_000);
        if (ok) {
          const info: ServerInfo = { ...parsed, owned: true };
          this.options.log(`[server] 就绪：${info.baseUrl}`);
          if (child.pid !== undefined) updateLease(child.pid, { baseUrl: info.baseUrl });
          this.setStatus({ state: "ready", info });
          return info;
        }
      }
      if (this.child === undefined) break; // 进程已退出
      await delay(300);
    }

    const tail = this.logTail();
    const detail = [
      exitInfo ??
        `@serverStartTimeout:${Math.round(this.options.startTimeoutMs / 1000)}`,
      this.staleLockHint(),
      tail && `@serverLogTail:${tail}`,
    ]
      .filter(Boolean)
      .join("\n");
    this.setStatus({ state: "failed", detail });
    this.stop();
    throw new Error(detail);
  }

  /**
   * 启动失败时，若原因落在**崩溃遗留的 writer 锁**上，追加一句可操作的说明。
   *
   * `dsh web` 的 boot 会去锁 `.credentials.yaml`，等 30 秒拿不到就抛错退出——
   * 日志里是 `atomic-write: timed out waiting for the writer lock at <path>`。
   * 扩展在启动服务器**之前**会清一遍（`clearStaleDocumentLocks`），但那之后又有
   * 进程被强杀的话，锁还会留下；此时用户看到的只是「启动超时」，无从下手。
   *
   * 返回 undefined 时不影响原有报错（正常失败路径一个字都不变）。
   */
  private staleLockHint(): string | undefined {
    let text: string;
    try {
      text = readFileSync(this.logFile, "utf8");
    } catch {
      return undefined;
    }
    const match = /timed out waiting for the writer lock at (.+?)[\r\n]/.exec(text);
    if (!match) return undefined;
    const lockPath = match[1].trim();
    // 标记而不是中文：这段说明会进 `connectionDetail`，由 webview 按用户选的
    // 界面语言渲染（多行说明写在词典里，见 texts.ts 的 serverStaleLock）。
    return `@serverStaleLock:${lockPath}`;
  }

  /** 从子进程日志里解析 `dsh web: http://127.0.0.1:<port>/?token=<TOKEN>`。 */
  private parseAnnouncement(): { baseUrl: string; token: string } | undefined {
    let text: string;
    try {
      text = readFileSync(this.logFile, "utf8");
    } catch {
      return undefined;
    }
    const match = /dsh web:\s*(https?:\/\/\S+)/.exec(text);
    if (!match) return undefined;
    let url: URL;
    try {
      url = new URL(match[1]);
    } catch {
      return undefined;
    }
    const token = url.searchParams.get("token") ?? "";
    url.search = "";
    return { baseUrl: url.toString().replace(/\/+$/, ""), token };
  }

  /** 轮询直到服务器给出任意 HTTP 响应（未授权时 401/403 也算活着）。 */
  private async waitForHttp(baseUrl: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(baseUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(2_000),
        });
        return true;
      } catch {
        await delay(200);
      }
    }
    return false;
  }
}
