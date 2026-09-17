/**
 * supervisor 的 **socket 协议**：按行 JSON 的双向消息（设计 §3.0）。
 *
 * 为什么高频信号走 socket 而不是文件（用户口径）：连接本身就是"我在用"的信号，
 * 断开即知；控制请求是结构化消息，不需要再造"请求文件"；supervisor 退场前还能主动通知。
 * 文件只留跨世代会合信息（见 `supervisorProtocol.ts`）。
 *
 * 报文（每行一个 JSON 对象，行尾 `\n`）：
 * ```
 * 客户端 → supervisor : {"t":"hello","hostId":"…","pid":123,"workspace":"D:\\…"}
 *                       {"t":"ping"}                       ← 保活，1s 一次
 *                       {"t":"control","action":"restart"|"stop"}
 * supervisor → 客户端 : {"t":"state","state":{…}|null}      ← 连接建立时回一份 + 状态变化时推
 *                       {"t":"goodbye","reason":"idle"|"stop"}   ← 退场前通知（界面可提示）
 *                       {"t":"error","kind":"tick","message":"…"} ← 守护进程内部异常（转发进输出通道）
 * ```
 * 这份编解码**纯函数、可离线断言**；真正的连接在 `supervisorClient.ts` 与 `src/supervisor/main.ts`。
 */
import type { SupervisorState } from "./supervisorProtocol";

/** 客户端 → supervisor。 */
export type ClientMessage =
  | { t: "hello"; hostId: string; pid: number; workspace?: string }
  | { t: "ping" }
  | { t: "control"; action: "restart" | "stop" };

/** supervisor → 客户端。 */
export type ServerMessage =
  | {
      t: "state";
      state: SupervisorState | null;
      /**
       * 当前有几个窗口连着这个后台（**只有 supervisor 知道**）。
       *
       * 由它报而不是让各窗口自己数：旧实现里"还有几个人在用"是窗口之间互相投票，
       * 那正是"新实例还没出生、投不了票"这类死角的总根源。
       */
      clients?: number;
    }
  | { t: "goodbye"; reason: "idle" | "stop" | "replaced" }
  /**
   * 守护进程**捕获到内部异常**，如实上报（2026-09-15 加）。
   *
   * 用途：守护进程是独立进程，它自己的日志在 `~/.dsh/dsh-chat-vscode/supervisors/<分组>/supervisor.log`
   * ——用户看不到那个文件，所以"守护进程内部出错了"此前表现为**后台莫名不重启**。
   * 这条消息让窗口把错误转发进 VS Code 输出通道「DSH Chat」。
   *
   * 宽容是必须的：**旧扩展不认识 `t:"error"`**（`decodeServerMessage` 返回 undefined 并忽略），
   * 所以加这条消息不会让旧扩展出错——这正是协议里"读不懂就忽略"的价值。
   */
  | { t: "error"; kind: string; message: string };

/**
 * 一行一行地切分流入的文本（TCP 不保证消息边界，必须自己攒缓冲）。
 *
 * **缓冲有上限**（`MAX_LINE_CHARS`）：对面（同一台机器上的任意进程，或版本不匹配的
 * 另一端）只要一直发不含换行的数据，`buffer` 就会无限长，把**长期存活的守护进程**
 * 或扩展宿主拖到内存耗尽。超限时丢弃半行并以 `overflowed` 标记，由调用方决定
 * 断开连接（见 `supervisorClient` 与 `src/supervisor/main.ts`）。
 */
export class LineDecoder {
  private buffer = "";
  private overflowed = false;

  /** 喂进一段文本，返回其中**完整**的行（不含换行符）。 */
  push(chunk: string): string[] {
    if (this.overflowed) return [];
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (this.buffer.length > MAX_LINE_CHARS) {
      // 半行超限：丢掉它并进入"溢出"状态（后续 chunk 直接忽略，直到 `reset`）
      this.buffer = "";
      this.overflowed = true;
      return [];
    }
    return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  }

  /** 缓冲是否已经因单行超长而失效（调用方据此断开这条连接）。 */
  get isOverflowed(): boolean {
    return this.overflowed;
  }

  reset(): void {
    this.buffer = "";
    this.overflowed = false;
  }
}

/** 单行上限：协议报文都是几百字节级，1 MiB 已经远超任何合法消息。 */
export const MAX_LINE_CHARS = 1024 * 1024;

/** 编码一条消息（含行尾换行）。 */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * 解析一条消息；形状不认识时返回 `undefined`（**不抛**）。
 *
 * 宽容是刻意的：协议对面可能是不同版本的扩展/supervisor，一条读不懂的消息
 * 只该被忽略，不该把整条连接弄死（否则用户看到的是"后台莫名断了"）。
 */
export function decodeClientMessage(line: string): ClientMessage | undefined {
  const value = parseObject(line);
  if (!value) return undefined;
  if (value.t === "ping") return { t: "ping" };
  if (value.t === "hello" && typeof value.hostId === "string" && typeof value.pid === "number") {
    return {
      t: "hello",
      hostId: value.hostId,
      pid: value.pid,
      workspace: typeof value.workspace === "string" ? value.workspace : undefined,
    };
  }
  if (value.t === "control" && (value.action === "restart" || value.action === "stop")) {
    return { t: "control", action: value.action };
  }
  return undefined;
}

/** 解析 supervisor 发来的消息（同样宽容）。 */
export function decodeServerMessage(line: string): ServerMessage | undefined {
  const value = parseObject(line);
  if (!value) return undefined;
  if (value.t === "goodbye") {
    const reason = value.reason;
    if (reason === "idle" || reason === "stop" || reason === "replaced") return { t: "goodbye", reason };
    return { t: "goodbye", reason: "stop" };
  }
  if (value.t === "error") {
    // 只有两样都是字符串才认（守护进程侧用 `kind` 标来源，扩展侧只负责转进输出通道）
    if (typeof value.kind !== "string" || typeof value.message !== "string") return undefined;
    return { t: "error", kind: value.kind, message: value.message };
  }
  if (value.t === "state") {
    // 形状**逐字段校验**，不只判"是个对象"：这份状态来自 socket 的另一端，而它会
    // 决定客户端接下来把启动令牌与 cookie 发到哪个 origin（`onStatePush` → `baseUrl`）。
    // `readState` 那套宽容规则管的是**文件**那条路，这条路得自己把住。
    const state = value.state;
    const clients = typeof value.clients === "number" && value.clients >= 0 ? value.clients : undefined;
    if (state === null) return { t: "state", state: null, clients };
    const checked = checkState(state);
    return checked ? { t: "state", state: checked, clients } : undefined;
  }
  return undefined;
}

/**
 * 校验 socket 推来的状态形状（不认识就整条丢掉）。
 *
 * 只做**形状**收窄，不改写语义：`baseUrl` 必须是 http(s) 且能解析，`token` 必须是
 * 字符串，pid/时刻必须是整数。**刻意不限制 host 必须是回环**——用户完全可以让自己的
 * `dsh web` 绑到局域网地址（`--host`），那种配置是合法的；能写这两个文件/连这条管道的
 * 攻击者本来就已经以同一用户身份运行了。
 */
function checkState(value: unknown): SupervisorState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const supervisorPid = raw.supervisorPid;
  const startedAt = raw.startedAt;
  const command = raw.command;
  const socket = raw.socket;
  if (typeof supervisorPid !== "number" || !Number.isInteger(supervisorPid) || supervisorPid <= 0) return undefined;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return undefined;
  if (typeof command !== "string" || typeof socket !== "string") return undefined;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : undefined;
  if (baseUrl !== undefined && !isHttpUrl(baseUrl)) return undefined;
  const token = typeof raw.token === "string" ? raw.token : undefined;
  const serverPid = typeof raw.serverPid === "number" && Number.isInteger(raw.serverPid) ? raw.serverPid : undefined;
  const idleSec = typeof raw.idleSec === "number" ? raw.idleSec : undefined;
  const runtimeRaw = raw.runtime as Record<string, unknown> | undefined;
  const runtime =
    runtimeRaw && typeof runtimeRaw.execPath === "string" && typeof runtimeRaw.node === "string"
      ? {
          execPath: runtimeRaw.execPath,
          node: runtimeRaw.node,
          electron: typeof runtimeRaw.electron === "string" ? runtimeRaw.electron : undefined,
        }
      : undefined;
  return {
    version: typeof raw.version === "number" ? raw.version : 1,
    supervisorPid,
    startedAt,
    serverPid,
    baseUrl,
    token,
    command,
    idleSec: idleSec ?? 0,
    socket,
    serverStartedAt: typeof raw.serverStartedAt === "number" ? raw.serverStartedAt : undefined,
    starting: raw.starting === true,
    runtime,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
