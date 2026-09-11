import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  METHODS,
  STREAMS,
  type ClientRequest,
  type RemoteEventOutcome,
  type RpcError,
  type ServerResponse,
} from "./protocol";

/** 业务错误（HTTP 200 里带回的 ok:false）。 */
export class DshApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DshApiError";
  }
}

/** 认证错误：单独一类，便于提示用户如何解决。 */
export class DshAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshAuthError";
  }
}

export type ConnectionState = "connecting" | "connected" | "disconnected";

export interface StreamHandle {
  cancel(): void;
}

interface StreamCallbacks {
  onItem: (value: unknown) => void;
  onEnd?: () => void;
  onError?: (error: RpcError) => void;
}

/**
 * DSH 服务器客户端。
 *
 * 传输由两部分组成（协议无 SSE、无轮询）：
 * - 一元调用：`POST /api/<method>`，信封 `{type:'client-request', rpcId, method, payload:{args}}`；
 * - 流：单条 WebSocket `/api/remote.mux`，用 `streamId` 多路复用若干逻辑流。
 *
 * 0.1.2 起 `/api` 需要签名 cookie：由 `GET /?token=<启动令牌>` 换取，HTTP 与 WS
 * 握手都要带上。令牌是进程级内存随机值，所以只有自己启动服务器才拿得到。
 */
export class DshClient {
  readonly baseUrl: string;
  private cookie = "";
  private ws: WebSocket | undefined;
  private disposed = false;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private retryDelay = 1_000;

  private readonly streams = new Map<string, StreamCallbacks>();
  private readonly pendingOpens: { streamId: string; endpoint: string; args: unknown }[] = [];

  private stateListener: ((state: ConnectionState) => void) | undefined;

  constructor(
    baseUrl: string,
    private readonly launchToken: string | undefined,
    private readonly log: (line: string) => void,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  onDidChangeState(listener: (state: ConnectionState) => void): void {
    this.stateListener = listener;
  }

  // ---------- 认证 ----------

  /** 用启动令牌换取签名 cookie；旧版无认证时静默通过。 */
  async authenticate(): Promise<void> {
    if (!this.launchToken) {
      // 未持有令牌（外部服务器）：先按无认证试一次，401 时再报错
      this.cookie = "";
      return;
    }
    const url = new URL("/", new URL(this.baseUrl));
    url.searchParams.set("token", this.launchToken);
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new DshAuthError("服务器拒绝了启动令牌（可能已过期），请重启 DSH 服务器。");
    }
    const setCookie = res.headers.get("set-cookie");
    this.cookie = setCookie ? setCookie.split(";")[0].trim() : "";
    this.log("[auth] 已取得会话 cookie");
  }

  // ---------- 一元 RPC ----------

  async request<T>(method: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
    const attempt = async () => {
      const message: ClientRequest = {
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload: { args },
      };
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.cookie) headers.cookie = this.cookie;
      const res = await fetch(`${this.baseUrl}/api/${method}`, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = res.ok ? ((await res.json()) as ServerResponse) : undefined;
      return { status: res.status, rpcId: message.rpcId, body };
    };

    const out = await attempt();
    if (out.status === 401 || out.status === 403) {
      throw new DshAuthError(
        `服务器要求授权（HTTP ${out.status}）。请让本扩展自行启动 DSH 服务器（命令面板：DSH: 重启服务器）。`,
      );
    }
    if (!out.body) throw new Error(`${method} 失败：HTTP ${out.status}`);
    if (!("result" in out.body)) throw new Error(`${method} 收到了非响应帧`);
    if (!out.body.result.ok) {
      const error = out.body.result.error;
      throw new DshApiError(error.code, error.message, error.details);
    }
    return out.body.result.value as T;
  }

  // ---------- 流 ----------

  /** 建立（或复用）底层 WebSocket；长活流断开后由调用方收到 onError 并重开。 */
  connect(): void {
    if (this.disposed || this.ws) return;
    this.stateListener?.("connecting");
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/remote.mux";
    const ws = new WebSocket(url, {
      handshakeTimeout: 8_000,
      headers: this.cookie ? { cookie: this.cookie } : {},
    });
    this.ws = ws;

    ws.on("open", () => {
      this.retryDelay = 1_000;
      this.stateListener?.("connected");
      const pending = this.pendingOpens.splice(0);
      for (const item of pending) this.sendOpen(item.streamId, item.endpoint, item.args);
    });

    ws.on("message", (data) => {
      let frame: { type?: string; streamId?: string; value?: unknown; error?: RpcError };
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // 丢弃损坏帧
      }
      const stream = frame.streamId ? this.streams.get(frame.streamId) : undefined;
      if (!stream) return;
      if (frame.type === "item") stream.onItem(frame.value);
      else if (frame.type === "end") {
        this.streams.delete(frame.streamId!);
        stream.onEnd?.();
      } else if (frame.type === "error") {
        this.streams.delete(frame.streamId!);
        const error = frame.error ?? { code: "gateway/internal", message: "stream failed" };
        this.log(`[stream] 失败 ${error.code}: ${error.message}`);
        stream.onError?.(error);
      }
    });

    ws.on("error", (error) => {
      this.log(`[ws] 错误：${error instanceof Error ? error.message : String(error)}`);
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.disposed) return;
      this.stateListener?.("disconnected");
      const streams = [...this.streams.values()];
      this.streams.clear();
      for (const stream of streams) {
        stream.onError?.({ code: "stream/socket-closed", message: "连接已断开" });
      }
      const delay = this.retryDelay;
      this.retryDelay = Math.min(delay * 2, 15_000);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  /** 打开一条逻辑流；返回取消句柄。未连接时会自动发起连接，open 帧排队补发。 */
  openStream(endpoint: string, args: unknown, callbacks: StreamCallbacks): StreamHandle {
    const streamId = randomUUID();
    this.streams.set(streamId, callbacks);
    if (!this.sendOpen(streamId, endpoint, args)) {
      this.pendingOpens.push({ streamId, endpoint, args });
      this.connect();
    }
    return {
      cancel: () => {
        this.streams.delete(streamId);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "cancel", streamId }));
        }
      },
    };
  }

  private sendOpen(streamId: string, endpoint: string, args: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(
      JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }),
    );
    return true;
  }

  // ---------- 高层封装 ----------

  listSessions(): Promise<{ items: SessionSummaryWire[] }> {
    return this.request(METHODS.sessionList, { _request: {} });
  }

  createSession(cwd: string, sessionId?: string): Promise<{ sessionId: string; agentPreset?: string }> {
    return this.request(METHODS.sessionCreate, {
      request: { cwd, ...(sessionId ? { sessionId } : {}) },
    });
  }

  prompt(
    sessionId: string,
    content: unknown[],
    mode: "queue" | "steer" = "queue",
  ): Promise<{ accepted: true }> {
    return this.request(
      METHODS.sessionPrompt,
      {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode,
          content,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
      120_000,
    );
  }

  cancel(sessionId: string): Promise<{ accepted: true }> {
    return this.request(METHODS.sessionCancel, { request: { sessionId } });
  }

  rename(sessionId: string, title: string): Promise<{ title: string }> {
    return this.request(METHODS.sessionRename, { request: { sessionId, title } });
  }

  page(sessionId: string, throughSeq: number, beforeSeq: number, maxMessages = 50): Promise<{ records: unknown[]; hasMore: boolean }> {
    return this.request(METHODS.sessionPage, {
      request: { address: { kind: "session", sessionId }, throughSeq, beforeSeq, maxMessages },
    });
  }

  modelCatalog(): Promise<{ groups: ModelGroupWire[]; failures?: unknown[] }> {
    return this.request(METHODS.sessionModelCatalog, {});
  }

  /**
   * 读取设置总览。
   *
   * 新会话在第一次对话前 `modelSelection` 投影是 `{lastUsed:null,next:null}`，
   * 但 agent 实际会用 `agent-default-model` 设置里的选择——从那里取，
   * 界面才不会在开场时只能说「默认模型」。
   */
  settingsDescribe(): Promise<{ namespaces?: { ns: string; value?: unknown }[] }> {
    return this.request("settings/describe", {});
  }

  /**
   * 切换模型 / 思考深度。
   *
   * 报文字段是**扁平**的（`SessionSelectModelRequest extends ModelSelection { sessionId }`），
   * 不是嵌在 `selection` 里——网关严格校验字段名，写错会得到 `gateway/arguments-invalid`。
   */
  selectModel(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<{ selected: { provider: string; model: string; reasoningEffort?: string } }> {
    return this.request(METHODS.sessionSelectModel, {
      request: {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    });
  }

  /** 打开会话事件流（含逐 token 增量，必须带 assistantStream）。 */
  followSession(sessionId: string, callbacks: StreamCallbacks): StreamHandle {
    return this.openStream(
      STREAMS.sessionFollow,
      {
        request: {
          address: { kind: "session", sessionId },
          maxMessages: 60,
          assistantStream: true,
        },
      },
      callbacks,
    );
  }

  followControl(callbacks: StreamCallbacks): StreamHandle {
    return this.openStream(STREAMS.sessionControl, {}, callbacks);
  }

  /**
   * 打开主机事件流。审批与提问都只从这里来，**收到 waterfall 必须回复**，
   * 否则请求会一直挂着（重连还会重投递，需按 eventId 幂等）。
   */
  openEvents(callbacks: StreamCallbacks): StreamHandle {
    return this.openStream(STREAMS.events, {}, callbacks);
  }

  answerEvent(clientId: string, eventId: string, outcome: RemoteEventOutcome): Promise<unknown> {
    return this.request(METHODS.eventsResult, { clientId, eventId, outcome });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = undefined;
  }
}

// ---------- 线格式的会话摘要 ----------

export interface SessionSummaryWire {
  sessionId: string;
  updatedAt: number;
  running?: boolean;
  blank?: boolean;
  cwd?: string;
  parentSessionId?: string;
  origin?: string;
  agentPreset?: string;
  projections?: { asOfSeq: number; values: Record<string, unknown> };
}

export interface ModelGroupWire {
  id: string;
  name: string;
  models: {
    id: string;
    name: string;
    description?: string;
    contextWindow?: number;
    reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string };
  }[];
}
