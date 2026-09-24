import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import {
  METHODS,
  STREAMS,
  type ClientRequest,
  type RemoteEventOutcome,
  type RpcError,
  type ServerResponse,
  type SessionFollowRequest,
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

/**
 * 「这个服务端没有这个端点」的判据（**肯定证据**，不是「请求失败」）。
 *
 * 网关对不存在的路由回 HTTP 404/405，而 `request()` 在非 2xx 时抛的正是
 * `<method> 失败：HTTP <status>`（本轮之前 0.1.7-rc.1 上实测到的形态）；
 * 若某个版本改成用信封回错误，`DshApiError` 的错误码里也带 not-found / unknown。
 *
 * 只用于**记住端点不存在**这一类结论：超时、断线、5xx 都不算——那些是「这次没拿到」，
 * 下次还要再问。存在的理由：0.1.7-alpha.1 删掉了 `subagents/list`，而扩展还要兼容
 * 旧服务端，协议没有版本协商，只能按实际回包认（见 `controller.refreshSubagentCatalog`）。
 */
export function endpointAbsent(error: unknown): boolean {
  if (error instanceof DshApiError) {
    // 只认**网关**那层的「没有这个方法/路由」。业务自己的 `session/not-found`
    // （会话不存在）与端点缺失是两回事，把它算进来会让一次业务拒绝永久关掉这条通道。
    return error.code.startsWith("gateway/")
      && /not-found|unknown|unsupported|no-such/.test(error.code);
  }
  const text = error instanceof Error ? error.message : String(error);
  return /\bHTTP (404|405)\b/.test(text);
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

  /**
   * 当前会话 cookie（`name=value`，可直接放进 Cookie 头）。
   *
   * 换取成功后由宿主持久化：**它是这里唯一值得存下来的东西**——cookie 的签名
   * 密钥存在服务端凭据库里（跨重启不变，默认 30 天），而启动令牌是
   * `randomBytes(32)` 按进程生成的，每次 `dsh web` 启动都会刷新。
   */
  get sessionCookie(): string {
    return this.cookie;
  }

  /**
   * 直接使用一个已有的签名 cookie，跳过启动令牌交换。
   *
   * 外部服务器（固定地址）重启后走这条：不需要用户重新输入令牌。
   * cookie 不对时后续请求会 401 → `DshAuthError`，调用方据此回退到令牌。
   */
  useSessionCookie(cookie: string): void {
    this.cookie = cookie;
  }

  /** 用启动令牌换取签名 cookie；旧版无认证时静默通过。 */
  async authenticate(): Promise<void> {
    // 已经带着会话 cookie（复用上次换来的）：不必再走令牌交换
    if (this.cookie) return;
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
      throw new DshAuthError(
        "服务器拒绝了启动令牌（令牌每次启动都会刷新，请用 dsh web 最新打印的 URL）。",
      );
    }
    const setCookie = res.headers.get("set-cookie");
    this.cookie = setCookie ? setCookie.split(";")[0].trim() : "";
    this.log("[auth] 已取得会话 cookie");
  }

  // ---------- 一元 RPC ----------

  /**
   * 上传一个文件，拿回它的 `receiptId`（官方 `dsh-client-file-upload`）。
   *
   * 走**原始 HTTP 路由**而不是 RPC 信封：
   * `POST /api/session/uploadFileBinary?sessionId&name`，
   * `content-type: application/octet-stream`，body 是原始字节。
   * 响应**永远是 HTTP 200**，成败在 JSON 信封里
   * （`{ok:true,value:{receiptId,file}}` / `{ok:false,error:{code,message,details}}`）。
   *
   * `receiptId` 只对铸造它的会话作用域有效——拿别的会话的 receipt 去发 prompt
   * 会被宿主以 `session/attachment-invalid`（`FILE_NOT_STAGED`）拒绝。
   */
  async uploadFile(
    sessionId: string,
    bytes: Uint8Array,
    name?: string,
  ): Promise<{ receiptId: string; file: { attachmentId: string; name: string; bytes: number } }> {
    const query = new URLSearchParams({ sessionId });
    if (name) query.set("name", name);
    const headers: Record<string, string> = { "content-type": "application/octet-stream" };
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(`${this.baseUrl}/api/session/uploadFileBinary?${query.toString()}`, {
      method: "POST",
      headers,
      // undici 接受 Uint8Array；TS 的 BodyInit 定义偏窄，这里收窄一次
      body: bytes as unknown as Uint8Array<ArrayBuffer>,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new DshAuthError("上传文件时被拒绝：会话 cookie 已失效。");
    }
    if (response.status !== 200) {
      throw new DshApiError("upload/transport", `file upload failed with HTTP ${response.status}`, undefined);
    }
    const parsed = (await response.json().catch(() => undefined)) as
      | { ok?: unknown; value?: unknown; error?: { code?: string; message?: string } }
      | undefined;
    if (parsed?.ok !== true) {
      throw new DshApiError(
        parsed?.error?.code ?? "upload/failed",
        parsed?.error?.message ?? "file upload failed",
        undefined,
      );
    }
    const value = parsed.value as
      | { receiptId?: unknown; file?: { attachmentId?: unknown; name?: unknown; bytes?: unknown } }
      | undefined;
    const receiptId = value?.receiptId;
    const file = value?.file;
    if (
      typeof receiptId !== "string" ||
      typeof file?.attachmentId !== "string" ||
      typeof file.name !== "string" ||
      typeof file.bytes !== "number"
    ) {
      throw new DshApiError("upload/invalid", "file upload returned an invalid receipt", undefined);
    }
    return {
      receiptId,
      file: { attachmentId: file.attachmentId, name: file.name, bytes: file.bytes },
    };
  }

  /**
   * 读一条认证的 Host HTTP 路由（`GET /api/…`）。
   *
   * `404` 返回 `undefined`：这是「Host 现在不提供这份东西」（Host 重启过、Session
   * 已释放），属于**正常结果**而不是错误——调用方据此决定界面上不显示，而不是
   * 把它当失败反复重试。其余非 2xx 抛错（401/403 抛 `DshAuthError`，上层的认证链
   * 据此回退到启动令牌）。
   */
  async getJson(path: string, timeoutMs = 30_000): Promise<unknown | undefined> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return undefined;
    if (res.status === 401 || res.status === 403) {
      throw new DshAuthError(`服务器要求授权（HTTP ${res.status}）。`);
    }
    if (!res.ok) throw new DshApiError("host/get", `GET ${path} 失败：HTTP ${res.status}`, undefined);
    return (await res.json().catch(() => undefined)) as unknown;
  }

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
      throw new DshAuthError(`服务器要求授权（HTTP ${out.status}）。`);
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

  /**
   * 注册（或幂等取回）一个工作区：DSH Web 的会话按**工作区**分组，而分组不是
   * 按 cwd 推出来的——它是一张持久注册表（`workspace/create`，路径经 realpath
   * 归一做唯一性）。扩展此前只按 cwd 建会话，于是服务端**从没把会话记进任何
   * 工作区**，同一批会话在 DSH Web 端全部落在「未分组」。
   */
  createWorkspace(path: string): Promise<{ workspace?: { workspaceId?: string }; created?: boolean }> {
    return this.request("workspace/create", { request: { path } });
  }

  /**
   * 新建会话。
   *
   * 契约（`dsh-api-session-controller` 的 `create`）**只接受两者之一**：
   * 给了 `workspaceId` 就按那个工作区的路径建会话并把会话记进工作区；
   * 只给 `cwd` 建出来的会话不属于任何工作区（Web 端显示为未分组）。
   * 同时给两个会被网关以 `gateway/bad-request` 拒绝。
   *
   * 第一个参数收字符串是给探针脚本用的（`createSession(process.cwd())`）：
   * 那些脚本要的是「按 cwd 建一条临时会话」，与工作区分组无关。
   */
  createSession(
    target: string | { workspaceId?: string; cwd?: string; agentPreset?: string },
    sessionId?: string,
  ): Promise<{ sessionId: string; agentPreset?: string }> {
    const wanted = typeof target === "string" ? { cwd: target } : target;
    // `agentPreset` 与 `workspaceId`/`cwd` **可以同时给**（契约
    // `SessionCreateRequest` 里它们是并列的可选字段）：一个决定会话落哪个目录、
    // 一个决定它用哪套组装。没给就由服务端按自己的默认预设组装。
    const preset = wanted.agentPreset ? { agentPreset: wanted.agentPreset } : {};
    const request = wanted.workspaceId
      ? { workspaceId: wanted.workspaceId, ...preset, ...(sessionId ? { sessionId } : {}) }
      : { cwd: wanted.cwd ?? "", ...preset, ...(sessionId ? { sessionId } : {}) };
    return this.request(METHODS.sessionCreate, { request });
  }

  /**
   * 部署提供的 agent 预设名单（`agentPresets/list`）。
   *
   * 返回值**刻意是 `unknown`**：形状由 `dsh/projections.ts` 的
   * `agentPresetsFromList` 逐字段收窄（那是个纯函数，离线可断言）——客户端这一层
   * 只负责把线格式原样带回来，不猜形状。
   */
  listAgentPresets(): Promise<unknown> {
    return this.request("agentPresets/list", {});
  }

  /**
   * 给某个**空白会话**换 agent 预设（`agentPresets/select`）。
   *
   * 参数名 `agentId` 是网关对「Agent 形参」的统一接线（会话 id 就是 agent 身份）。
   * 返回**生效的 preset id**（服务端可能按 id 归一）。
   */
  selectAgentPreset(agentId: string, agentPreset: string): Promise<string> {
    return this.request("agentPresets/select", { agentId, agentPreset });
  }

  /**
   * 提交一轮对话。
   *
   * `requestId` 由客户端铸造，是**唯一的关联身份**：Host 会把它写进 durable
   * `user/message` 的 `source.rpcId`，队列里的那一条也带（当前服务端是
   * `inbox` 投影消息的 `source.rpcId`，2026-09-09 之前是
   * `SessionQueuedItem.rpcId`，见 `queueView.ts`）。
   * 调用方因此能凭它把「服务端队列里的这一条」对回「用户当时真正输入的文本」——
   * 这里的内容块已经把文件上下文内联进正文了，队列回显不足以还原输入框。
   */
  prompt(
    sessionId: string,
    content: unknown[],
    mode: "queue" | "steer" = "queue",
    requestId: string = randomUUID(),
  ): Promise<{ accepted: true }> {
    return this.request(
      METHODS.sessionPrompt,
      {
        request: {
          requestId,
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

  /**
   * 给**可继续的子代理**续发一条人的消息（`subagents/prompt`）。
   *
   * 参数形状逐字对照契约（`dsh-subagent/lib/types/control-types.d.ts` 的
   * `SubagentPromptRequest`；位置参数名见 docs/dsh-server-api.md §9.2）：
   * `mode` 在线上**恒为 `'continuable'`**——那是地址的判别标记，不是本子代理的
   * 模式（一次性子代理走不到这里：界面只读，宿主也不发）。
   * `delivery` 是官方 prompt `mode` 在这条端点上的名字（`queue` / `steer`）。
   * 父会话不在线会回 `subagent/parent-unavailable`（调用方按需提示）。
   */
  promptSubagent(
    parentSessionId: string,
    childSessionId: string,
    content: unknown[],
    delivery: "queue" | "steer",
    requestId: string = randomUUID(),
  ): Promise<{ messageId: string }> {
    return this.request("subagents/prompt", {
      request: {
        requestId,
        parentSessionId,
        childSessionId,
        mode: "continuable",
        delivery,
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    });
  }

  /**
   * 停止子代理的当前轮（`subagents/interruptByParent`，三个**平铺**位置参数）。
   *
   * 官方的停止路由（`ISession.cancel` 对子代理地址的分支）：父地址是**持久事实**，
   * 所以父 Agent 不在线也停得了；受理 ≠ 已停（行状态由会话状态位收敛）。
   */
  interruptSubagentByParent(
    childSessionId: string,
    parentSessionId: string,
  ): Promise<{ accepted: true }> {
    return this.request("subagents/interruptByParent", {
      childSessionId,
      parentSessionId,
      mode: "continuable",
    });
  }

  /**
   * 读取一个会话的投影值快照（`session/projections`，参数 `{sessionId}`）。
   *
   * 调用方（`controller` 的父目录补齐）只取 `values.subagentCatalog`；失败（含旧
   * 服务端没有这条路由的 404）由调用方兜住，不抛出去。
   */
  sessionProjections(sessionId: string): Promise<{ asOfSeq?: number; values?: Record<string, unknown> }> {
    return this.request("session/projections", { sessionId });
  }

  /**
   * 人的后台任务停止请求（`job/kill`，契约
   * `@deepseek-ai/dsh-api-job-controller/types` 的 `JobKillRequest` / `JobKillValue`）。
   *
   * 受理 ≠ 已停：回包只说「请求收下了」（`requested`）或「任务恰好已经收场」
   * （`already-finished`），行状态的真正收敛仍由 `job/list` 名册帧推过来
   * （与官方 `JobListInjected.killJob` 的注释同一口径）。失败（含旧服务端
   * 没有 `job` 命名空间的 404、`job/not-found`）由调用方如实回给界面。
   */
  killJob(sessionId: string, jobId: string): Promise<{ outcome?: string }> {
    return this.request(METHODS.jobKill, { request: { sessionId, jobId } });
  }

  /**
   * 移除一条排队 / 插话消息（`SessionUpdateQueueRequest`，action `{kind:'remove'}`）。
   * 服务端随后会重发队列（当前服务端重发 `inbox` 投影），界面以它为准。
   */
  updateQueueRemove(sessionId: string, itemId: string): Promise<{ accepted: true }> {
    return this.request(METHODS.sessionUpdateQueue, {
      request: { sessionId, itemId, action: { kind: "remove" } },
    });
  }

  /**
   * 把一条**排队中**的消息改成插话（`action {kind:'steer'}`），语义见
   * `dsh-api-session-controller` 的 `SessionQueueAction`。
   *
   * 服务端要求 agent 正在运行，否则报 `session/steer-unavailable`——调用方按官方
   * 口径把这一类拒绝当**静默 no-op**（队列本身就是权威，拒绝意味着状态没变）。
   */
  updateQueueSteer(sessionId: string, itemId: string): Promise<{ accepted: true }> {
    return this.request(METHODS.sessionUpdateQueue, {
      request: { sessionId, itemId, action: { kind: "steer" } },
    });
  }

  rename(sessionId: string, title: string): Promise<{ title: string }> {
    return this.request(METHODS.sessionRename, { request: { sessionId, title } });
  }

  /**
   * 归档会话：从工作区分组移出（`WorkspaceArchiveValue`）。
   * 服务端**没有**删除会话的 API（日志文件只增不减）；权威归档集合经
   * `workspace/follow` 流的 baseline / `archived` 增量下发。
   */
  archiveSession(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
    return this.request("workspace/archiveSession", { request: { sessionId } });
  }

  /**
   * 往前取一页历史（`session/page`）。地址与 `followSession` 同一套：`subagent`
   * 给出时用子代理地址（普通会话地址取不到子代理会话的分页）。
   */
  page(
    sessionId: string,
    throughSeq: number,
    beforeSeq: number,
    maxMessages = 50,
    subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
  ): Promise<{ records: unknown[]; hasMore: boolean }> {
    const address = subagent
      ? {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          childSessionId: sessionId,
          mode: subagent.mode,
        }
      : { kind: "session" as const, sessionId };
    return this.request(METHODS.sessionPage, {
      request: { address, throughSeq, beforeSeq, maxMessages },
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

  /**
   * 打开会话事件流（含逐 token 增量，必须带 `assistantStream: true`）。
   *
   * 注意**没有** `beforeSeq` 这个参数：它属于 `session/page` 的请求
   * （`SessionPageRequest`），不在 `session/follow` 的契约里。此前这里带了一个
   * 从没有人传过的 `beforeSeq` 选项——那种「多给一个字段」的写法一旦有人用上，
   * 就会撞上与 `assistantStream: false` 同一道边界校验（见 `SessionFollowRequest`）。
   * 往前翻历史走 `page()`。
   *
   * `subagent` 给出时用**子代理地址**打开（`{kind:'subagent', …}`）：地址是宿主
   * 鉴权的一部分，`mode` 必须是子代理的真实模式，硬编码 `continuable` 打开
   * one-shot 子代理会被 `subagent/unauthorized` 拒绝。
   */
  followSession(
    sessionId: string,
    callbacks: StreamCallbacks,
    subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" },
  ): StreamHandle {
    const address = subagent
      ? {
          kind: "subagent" as const,
          parentSessionId: subagent.parentSessionId,
          childSessionId: sessionId,
          mode: subagent.mode,
        }
      : { kind: "session" as const, sessionId };
    return this.openStream(
      STREAMS.sessionFollow,
      {
        request: {
          address,
          // 跟随窗口带多少条消息。默认 60：够渲染一屏多的上下文，又不至于每次
          // 打开会话都把整段历史搬过来。往前翻页用 session/page（见 page()）。
          maxMessages: 60,
          assistantStream: true,
        } satisfies SessionFollowRequest,
      },
      callbacks,
    );
  }

  followControl(callbacks: StreamCallbacks): StreamHandle {
    return this.openStream(STREAMS.sessionControl, {}, callbacks);
  }

  /**
   * 跟随某个会话看得见的后台任务名册（`job/list`，0.1.7-alpha.1 起的新通道）。
   *
   * 帧是**整表替换**的 `{type:'rows', jobs}`：打开时一帧、之后每次生命周期变化一帧。
   * 参数名与其它流一致，是 `request`（网关只认这一个字段名）。
   */
  followJobs(sessionId: string, callbacks: StreamCallbacks): StreamHandle {
    return this.openStream(STREAMS.jobList, { request: { sessionId } }, callbacks);
  }

  /**
   * 跟随**一个后台任务的保留输出**（`job/follow`）：打开一帧 `opened`（锚点偏移），
   * 之后是合并过的 `output` 批次，任务收场且环排空后一帧 `status`，随后流结束。
   *
   * `from` 是**续传游标**（上一帧的 `next`）：只在「断线重连接着看」时给。
   * 第一次观察刻意**不带**它——服务端会从环里最旧的保留字节锚起，而
   * `opened.from > 0` 正是「开头已经被淘汰」的信号（界面据此给「较早输出已丢弃」），
   * 传 `0` 会把这个信号抹掉。
   *
   * 失败照旧走 `callbacks.onError`：旧服务端根本没有 `job` 命名空间（404）、
   * 名册里已经没有这个任务（`job/not-found`）都从这里出来，调用方如实转给界面。
   */
  followJob(
    sessionId: string,
    jobId: string,
    callbacks: StreamCallbacks,
    from?: number,
  ): StreamHandle {
    return this.openStream(
      STREAMS.jobFollow,
      { request: { sessionId, jobId, ...(from !== undefined ? { from } : {}) } },
      callbacks,
    );
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

/**
 * 对话引用候选（`sessionReferenceResolver/candidates` 的线格式）。
 *
 * 契约：`@deepseek-ai/dsh-session-reference/lib/types/types.d.ts` 的
 * `SessionReferenceMentionCandidate`——`mention` 是服务端铸好的规范 token
 * （`@[label](dsh-session:…)`），客户端原样插进正文即可，服务端在消息进入
 * 模型前把它换成被引用会话的快照。
 */
export interface SessionReferenceCandidateWire {
  sessionId: string;
  label: string;
  cwd?: string;
  /** 与发起会话同一工作目录（服务端算好的，客户端不比较路径）。 */
  sameWorkspace?: boolean;
  /** 源会话创建时间（epoch ms）。 */
  createdAt?: number;
  /** 规范 mention token。 */
  mention: string;
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
