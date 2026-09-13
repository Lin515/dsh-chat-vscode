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
  | { t: "goodbye"; reason: "idle" | "stop" | "replaced" };

/** 一行一行地切分流入的文本（TCP 不保证消息边界，必须自己攒缓冲）。 */
export class LineDecoder {
  private buffer = "";

  /** 喂进一段文本，返回其中**完整**的行（不含换行符）。 */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  }
}

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
  if (value.t === "state") {
    // 状态本身由 `readState` 的宽容规则把关；这里只保证"是个对象或 null"
    const state = value.state;
    const clients = typeof value.clients === "number" && value.clients >= 0 ? value.clients : undefined;
    if (state === null) return { t: "state", state: null, clients };
    if (state && typeof state === "object") return { t: "state", state: state as SupervisorState, clients };
    return undefined;
  }
  return undefined;
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
