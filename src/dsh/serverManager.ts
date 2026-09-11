import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

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
        const detail = `无法连接 ${baseUrl}，请确认该地址上运行着 dsh web。`;
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

  /** 停止由本扩展启动的服务器（外部服务器不受影响）。 */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child?.pid !== undefined) {
      this.options.log(`[server] 停止子进程 pid=${child.pid}`);
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

    let exitInfo: string | undefined;
    child.on("error", (error) => {
      exitInfo = `spawn 失败：${error.message}`;
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return; // 已被 stop() 主动结束
      this.child = undefined;
      const detail = `dsh web 进程退出（code=${code ?? "?"} signal=${signal ?? "?"}）`;
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
          this.setStatus({ state: "ready", info });
          return info;
        }
      }
      if (this.child === undefined) break; // 进程已退出
      await delay(300);
    }

    const tail = this.logTail();
    const detail = [
      exitInfo ?? `等待 dsh web 就绪超时（${Math.round(this.options.startTimeoutMs / 1000)}s）`,
      tail && `日志尾部：\n${tail}`,
    ]
      .filter(Boolean)
      .join("\n");
    this.setStatus({ state: "failed", detail });
    this.stop();
    throw new Error(detail);
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
