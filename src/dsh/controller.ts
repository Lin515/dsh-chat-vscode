import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import * as vscode from "vscode";
import type {
  Attachment,
  ChatState,
  JobItemView,
  ModelSelectionView,
  ProviderGroupView,
  QuestionView,
  QueuedMessageView,
  SessionSummaryView,
  SubagentView,
} from "../shared/chat";
import type { HostToWebview, WebviewToHost } from "../shared/ipc";
import { SessionAdapter } from "./adapter";
import { DshApiError, DshAuthError, DshClient, type ConnectionState, type SessionSummaryWire } from "./client";
import type { RemoteEventFrame, RemoteEventWaterfall, SessionControlFrame } from "./protocol";
import { ServerManager, type ServerStatus } from "./serverManager";
import { buildSettingsSection } from "./settingsSchema";

/** 服务器 → webview 的会话内容总控。 */
export class ChatController implements vscode.Disposable {
  private client: DshClient | undefined;
  private adapter: SessionAdapter | undefined;
  private sessions: SessionSummaryView[] = [];
  private currentSessionId: string | undefined;
  private followHandle: { cancel(): void } | undefined;
  private controlHandle: { cancel(): void } | undefined;
  private eventsHandle: { cancel(): void } | undefined;
  private eventsClientId: string | undefined;
  private readonly handledEvents = new Set<string>();
  private workspaceHandle: { cancel(): void } | undefined;
  /** 已归档会话的权威集合（来自 workspace/follow 流）。 */
  private archivedSessionIds = new Set<string>();
  /**
   * 本地已删除的会话 id 集合（持久化于 globalState 的 `deletedSessionIds`）。
   *
   * 服务端**没有**会话删除/detach API：当前 dsh 进程打开过的会话常驻服务端内存
   * 直到进程退出，删掉本地日志目录后 `session/list` 仍会列出它们。扩展因此把
   * 删除过的 id 持久化下来，从历史/归档两个列表里永久过滤，界面不再显示。
   */
  private readonly deletedSessionIds: Set<string>;
  /**
   * 草稿与附件按会话隔离：切换会话时输入框文本与附件芯片一起切换。
   * 无当前会话时挂在空 key 上（连接建立前暂存）。
   */
  private readonly drafts = new Map<string, string>();
  private readonly attachmentsBySession = new Map<string, Attachment[]>();
  private models: ProviderGroupView[] = [];
  private model: ModelSelectionView | undefined;
  private running = false;
  private permission: string | undefined;
  private planMode = false;
  private todos: ChatState["todos"] = [];
  private subagents: SubagentView[] = [];
  private jobs: JobItemView[] = [];
  private queueItems: QueuedMessageView[] = [];
  /** 上下文构成与会话统计（投影值），存下来供首帧快照使用。 */
  private contextBreakdown: ChatState["contextBreakdown"];
  private sessionStats: ChatState["sessionStats"];
  private goal: ChatState["goal"];
  private connection: ConnectionState | "error" = "connecting";
  private connectionDetail: string | undefined;
  private disposed = false;

  private readonly listeners = new Set<(frame: HostToWebview) => void>();

  constructor(
    private readonly server: ServerManager,
    private readonly log: (line: string) => void,
    private readonly state: vscode.Memento,
  ) {
    this.deletedSessionIds = new Set(this.state.get<string[]>("deletedSessionIds") ?? []);
  }

  // ---------- 订阅与广播 ----------

  subscribe(listener: (frame: HostToWebview) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private emit(frame: HostToWebview): void {
    for (const listener of this.listeners) listener(frame);
  }

  private workspacePath(): string {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? folder.uri.fsPath : process.cwd();
  }

  /** 当前会话的草稿 / 附件键（无会话时空串）。 */
  private sessionKey(): string {
    return this.currentSessionId ?? "";
  }

  private attachmentsNow(): Attachment[] {
    return this.attachmentsBySession.get(this.sessionKey()) ?? [];
  }

  /** 修改当前会话的附件并同步给界面。 */
  private mutateAttachments(fn: (list: Attachment[]) => void): void {
    const key = this.sessionKey();
    const list = this.attachmentsBySession.get(key) ?? [];
    fn(list);
    this.attachmentsBySession.set(key, list);
    this.emit({ type: "patch", patch: { attachments: [...list] } });
  }

  /** 给新连接的 webview 的首帧快照。 */
  snapshot(): ChatState {
    return {
      connection: this.connection === "error" ? "error" : this.connection === "connected" ? "ready" : "connecting",
      connectionDetail: this.connectionDetail,
      serverUrl: this.client?.baseUrl,
      locale: vscode.env.language,
      showUsageStats: vscode.workspace.getConfiguration("dshChat").get<boolean>("showUsageStats") ?? true,
      session: this.sessions.find((session) => session.id === this.currentSessionId),
      messages: this.adapter?.snapshotMessages() ?? [],
      running: this.running,
      queueItems: this.queueItems,
      attachments: this.attachmentsNow(),
      draft: this.drafts.get(this.sessionKey()) ?? "",
      models: this.models,
      model: this.model,
      permission: this.permission,
      planMode: this.planMode,
      todos: this.todos,
      subagents: this.subagents,
      jobs: this.jobs,
      goal: this.goal,
      // 会话内的粘性显示值：首帧快照必须带上，否则 webview 一重载，上下文占用/
      // 速度/构成/统计就空到下一轮才有数据（表现为「时有时无」）
      ...(this.adapter?.stickyState() ?? {}),
      contextBreakdown: this.contextBreakdown,
      sessionStats: this.sessionStats,
    };
  }

  // ---------- 连接 ----------

  async ensureConnected(): Promise<void> {
    if (this.disposed) return;
    if (this.client && this.connection === "connected") return;
    this.setConnection("connecting");
    try {
      const info = await this.server.ensure();
      const client = new DshClient(info.baseUrl, info.token, this.log);
      await client.authenticate();
      client.onDidChangeState((state) => {
        this.setConnection(state === "connected" ? "connected" : state === "connecting" ? "connecting" : "error", state === "disconnected" ? "与服务器的连接已断开，正在重连…" : undefined);
        if (state === "connected") void this.onConnected();
      });
      this.client = client;
      client.connect();
      await this.loadModels();
      await this.refreshSessions();
      this.setConnection("connected");
      if (!this.currentSessionId) await this.newSession();
    } catch (error) {
      const detail = this.describeError(error);
      this.log(`[connect] 失败：${detail}`);
      this.setConnection("error", detail);
    }
  }

  private async onConnected(): Promise<void> {
    // socket 重建后长活流都要重开
    if (this.currentSessionId) this.follow(this.currentSessionId);
    this.openControlStream();
    this.openEventsStream();
    this.openWorkspaceStream();
  }

  private setConnection(state: ConnectionState | "error", detail?: string): void {
    this.connection = state;
    this.connectionDetail = detail;
    this.emit({
      type: "patch",
      patch: {
        connection: state === "error" ? "error" : state === "connected" ? "ready" : "connecting",
        connectionDetail: detail,
        serverUrl: this.client?.baseUrl,
      },
    });
  }

  private describeError(error: unknown): string {
    if (error instanceof DshAuthError) return error.message;
    if (error instanceof DshApiError) return `${error.message}（${error.code}）`;
    return error instanceof Error ? error.message : String(error);
  }

  async restart(): Promise<void> {
    this.log("[server] 重启");
    this.teardownStreams();
    this.client?.dispose();
    this.client = undefined;
    await this.server.restart();
    await this.ensureConnected();
    vscode.window.showInformationMessage("DSH 服务器已重启。");
  }

  /** 服务器状态变化时同步给界面。 */
  onServerStatus(status: ServerStatus): void {
    if (status.state === "failed" && status.detail) {
      this.setConnection("error", status.detail);
    }
  }

  // ---------- 会话 ----------

  /** 命令面板入口「DSH: 历史对话」：刷新列表并让界面切到历史抽屉。 */
  async openHistory(): Promise<void> {
    await this.refreshSessions();
    this.emit({ type: "ui/openPanel", panel: "history" });
  }

  async refreshSessions(): Promise<void> {
    if (!this.client) return;
    try {
      const value = await this.client.listSessions();
      // 只显示属于**当前工作区**的会话（dsh web 可能为多个项目开过会话，
      // 跨项目会话混进来会既占列表又会因 cwd 不匹配导致 resume 失败）
      const workspace = this.workspacePath().replace(/\\/g, "/").toLowerCase();
      const currentCwd = this.sessions.find((s) => s.id === this.currentSessionId)?.cwd?.replace(/\\/g, "/").toLowerCase();
      this.sessions = (value.items ?? [])
        // 本地删过的会话若被当前 dsh 进程打开过，仍会留在服务端内存里被
        // session/list 列出——按持久化的删除集合过滤，保证界面干净
        .filter((item) => !this.deletedSessionIds.has(item.sessionId))
        .filter((item) => !item.origin && !item.parentSessionId)
        .filter((item) => {
          if (!item.cwd) return false;
          const cwd = item.cwd.replace(/\\/g, "/").toLowerCase();
          return cwd === workspace || (currentCwd !== undefined && cwd === currentCwd);
        })
        .map((item) => this.toSessionView(item));
      this.emitSessionLists();
    } catch (error) {
      this.log(`[sessions] 列表获取失败：${this.describeError(error)}`);
    }
  }

  /** 真正展示给界面的两个列表：历史列表（滤掉已归档会话）与归档列表。 */
  private emitSessionLists(): void {
    const active: SessionSummaryView[] = [];
    const archived: SessionSummaryView[] = [];
    for (const session of this.sessions) {
      (this.archivedSessionIds.has(session.id) ? archived : active).push(session);
    }
    this.emit({ type: "sessions", sessions: active });
    this.emit({ type: "archivedSessions", sessions: archived });
  }

  /**
   * 归档：服务端把会话从工作区分组移出。权威状态经 workspace/follow 流的
   * `archived` 增量回到这里，列表自动刷新；兜底再拉一次列表（增量延迟时）。
   */
  private async archiveSession(sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.archiveSession(sessionId);
      this.archivedSessionIds.add(sessionId);
      this.emitSessionLists();
      setTimeout(() => void this.refreshSessions(), 500);
    } catch (error) {
      this.reportError("归档会话失败", error);
    }
  }

  /**
   * 删除会话。服务端**没有**删除/detach API（会话日志文件只增不减），这里
   * 直接删除本地日志目录：`~/.dsh/sessions/<工作区>/session-<会话id>`（目录名
   * 就是会话 id，见日志文件头 `id` 字段），并把会话 id 记入 `deletedSessionIds`
   * （持久化）：被当前 dsh 进程打开过的会话常驻服务端内存、`session/list` 会
   * 一直列出它，客户端必须过滤才能让列表干净。
   *
   * 日志目录已不存在（此前已删过）时同样记录 id 并清理列表——那次删除已经把
   * 文件删掉了，这里不再报错。
   *
   * 保护：运行中的会话不能删（服务端还在往里写）；当前正在跟随的会话不能删
   * （删完无处可看，且服务端内存里还开着它）。
   */
  private async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      this.log(`[sessions] 删除失败：列表中不存在会话 ${sessionId}`);
      return;
    }
    if (session.running) {
      void vscode.window.showWarningMessage("该会话正在运行，无法删除。");
      return;
    }
    if (sessionId === this.currentSessionId) {
      void vscode.window.showWarningMessage("不能删除当前正在查看的会话，请先切换到其他会话。");
      return;
    }
    const dir = this.findSessionDir(sessionId);
    let removed = false;
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
        removed = true;
        this.log(`[sessions] 已删除会话日志：${dir}`);
      } catch (error) {
        this.reportError("删除会话失败", error);
        return;
      }
    }
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.rememberDeleted(sessionId);
    this.emitSessionLists();
    if (!removed) {
      this.log(
        `[sessions] 会话 ${sessionId} 的日志目录已不存在，已从列表中移除（服务端内存中的副本仍存活到 dsh 进程退出）`,
      );
    }
  }

  /** 记住一个已删除的会话 id 并持久化（跨扩展重载，列表保持干净）。 */
  private rememberDeleted(sessionId: string): void {
    if (this.deletedSessionIds.has(sessionId)) return;
    this.deletedSessionIds.add(sessionId);
    void this.state.update("deletedSessionIds", [...this.deletedSessionIds]);
  }

  /** 在 `~/.dsh/sessions` 的各工作区子目录里找会话日志目录（目录名=会话 id）。 */
  private findSessionDir(sessionId: string): string | undefined {
    const root = join(homedir(), ".dsh", "sessions");
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const candidate = join(root, entry, sessionId);
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // 不在这个工作区，继续
      }
    }
    return undefined;
  }

  private toSessionView(item: SessionSummaryWire): SessionSummaryView {
    const title = item.projections?.values?.title;
    return {
      id: item.sessionId,
      // 标题留空表示「还没生成标题」，由界面按当前语言回退为「未命名对话」；
      // 宿主不写死文案，否则会漏进另一种语言的界面
      title: typeof title === "string" ? title : "",
      updatedAt: item.updatedAt ?? Date.now(),
      cwd: item.cwd,
      running: Boolean(item.running),
      blank: item.blank,
    };
  }

  async newSession(): Promise<void> {
    if (!this.client) return;
    try {
      const created = await this.client.createSession(this.workspacePath());
      this.currentSessionId = created.sessionId;
      this.pendingReasoningEffort =
        vscode.workspace.getConfiguration("dshChat").get<string>("defaultReasoningEffort") || undefined;
      this.follow(created.sessionId);
      await this.refreshSessions();
      this.clearStickySessionState();
      this.emit({ type: "messages/reset", messages: [] });
      this.emit({ type: "todos", todos: [] });
      this.emit({
        type: "patch",
        patch: {
          session: this.sessions.find((s) => s.id === created.sessionId) ?? {
            id: created.sessionId,
            title: "",
            updatedAt: Date.now(),
            running: false,
          },
          running: false,
          // 新会话的草稿与附件天然是空的，显式下发让输入框复位
          draft: this.drafts.get(created.sessionId) ?? "",
          attachments: this.attachmentsBySession.get(created.sessionId) ?? [],
          // 上一会话的投影与队列残留清掉（新会话队列必为空）
          ...this.clearedStickyPatch(),
          queueItems: [],
        },
      });
    } catch (error) {
      this.reportError("新建会话失败", error);
    }
  }

  async openSession(sessionId: string): Promise<void> {
    this.currentSessionId = sessionId;
    this.follow(sessionId);
    // 重开控制流拿新会话的 baseline（队列/任务/投影），否则旧会话的队列残留
    this.openControlStream();
    this.clearStickySessionState();
    this.emit({
      type: "patch",
      patch: {
        session: this.sessions.find((s) => s.id === sessionId),
        // 输入框内容跟随会话切换
        draft: this.drafts.get(sessionId) ?? "",
        attachments: this.attachmentsBySession.get(sessionId) ?? [],
        // 上一会话的粘性显示值清掉，等新会话的 snapshot/baseline 回填
        ...this.clearedStickyPatch(),
      },
    });
  }

  /** 切换会话时清掉控制器侧存的投影值（新会话由新适配器/投影重新填）。 */
  private clearStickySessionState(): void {
    this.contextBreakdown = undefined;
    this.sessionStats = undefined;
  }

  /** 切换会话时一并把界面上的粘性显示值清空。 */
  private clearedStickyPatch(): Pick<
    ChatState,
    "contextBreakdown" | "sessionStats" | "contextOccupancy" | "contextWindow" | "lastSpeed"
  > {
    return {
      contextBreakdown: undefined,
      sessionStats: undefined,
      contextOccupancy: undefined,
      contextWindow: undefined,
      lastSpeed: undefined,
    };
  }

  private follow(sessionId: string): void {
    if (!this.client) return;
    this.followHandle?.cancel();
    const adapter = new SessionAdapter((frame) => this.emit(frame));
    adapter.setSession(
      this.sessions.find((s) => s.id === sessionId) ?? {
        id: sessionId,
        title: "",
        updatedAt: Date.now(),
        running: false,
      },
    );
    this.adapter = adapter;
    this.followHandle = this.client.followSession(sessionId, {
      onItem: (value) => {
        const frame = value as { type?: string; projections?: { values?: Record<string, unknown> } };
        // 开窗投影带全部折叠值（模型选择、上下文构成、会话统计…）：逐个走
        // applyProjection，未知 key 忽略
        if (frame?.type === "snapshot") {
          for (const [key, projectionValue] of Object.entries(frame.projections?.values ?? {})) {
            this.applyProjection(key, projectionValue);
          }
        }
        adapter.applyFrame(value as never);
      },
      onError: () => {
        // socket 断开重连后会由 onConnected 重开
      },
    });
  }

  /**
   * 从 `modelSelection` 投影同步模型胶囊。
   *
   * 投影形如 `{lastUsed, next}`：`lastUsed` 是上一轮实际用的，`next` 是下一轮将要
   * 用的（新会话里用户选了模型就落在这）。胶囊显示「下一次会用什么」，所以优先 `next`。
   * 两者都为空（全新会话还没跑过）时，退回部署默认模型。
   */
  private applyModelSelection(selection: unknown): void {
    this.lastModelSelection = selection;
    const value = selection as
      | {
          lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
          next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
        }
      | null
      | undefined;
    const used = value?.next ?? value?.lastUsed;
    if (!used?.provider || !used.model) {
      void this.loadDefaultModel();
      return;
    }
    const group = this.models.find((g) => g.id === used.provider);
    const model = group?.models.find((m) => m.id === used.model);

    this.model = {
      provider: used.provider,
      model: used.model,
      label: model?.name ?? used.model,
      reasoningEffort: used.reasoningEffort || undefined,
      efforts: model?.efforts,
      contextWindow: model?.contextWindow ?? this.model?.contextWindow,
      acceptsImage: this.acceptsImageFor(used.provider, used.model),
    };
    this.emit({ type: "patch", patch: { model: this.model } });
    void this.applyPendingEffort();
  }

  /** 把 `dshChat.defaultReasoningEffort` 应用到当前会话（只做一次）。 */
  private async applyPendingEffort(): Promise<void> {
    const wanted = this.pendingReasoningEffort;
    if (!wanted || !this.client || !this.currentSessionId || !this.model) return;
    if (this.model.reasoningEffort === wanted) {
      this.pendingReasoningEffort = undefined;
      return;
    }
    this.pendingReasoningEffort = undefined;
    const { provider, model } = this.model;
    try {
      await this.client.selectModel(this.currentSessionId, provider, model, wanted);
      if (this.model) {
        this.model = { ...this.model, reasoningEffort: wanted };
        this.emit({ type: "patch", patch: { model: this.model } });
      }
    } catch (error) {
      this.log(`[model] 应用默认思考深度失败：${this.describeError(error)}`);
    }
  }

  private teardownStreams(): void {
    this.followHandle?.cancel();
    this.controlHandle?.cancel();
    this.eventsHandle?.cancel();
    this.workspaceHandle?.cancel();
    this.followHandle = undefined;
    this.controlHandle = undefined;
    this.eventsHandle = undefined;
    this.workspaceHandle = undefined;
    this.eventsClientId = undefined;
    this.handledEvents.clear();
  }

  private openControlStream(): void {
    if (!this.client) return;
    this.controlHandle?.cancel();
    this.controlHandle = this.client.followControl({
      onItem: (value) => this.onControlFrame(value as SessionControlFrame),
    });
  }

  private openWorkspaceStream(): void {
    if (!this.client) return;
    this.workspaceHandle?.cancel();
    this.workspaceHandle = this.client.openStream(
      "workspace/follow",
      {},
      {
        onItem: (value) =>
          this.onWorkspaceFrame(
            value as { type?: string; value?: { archivedSessionIds?: string[] }; archivedSessionIds?: string[] },
          ),
      },
    );
  }

  /**
   * 工作区状态流承载已归档会话的权威集合：每代以一个 `baseline` 开场，
   * 其后是 `archived` 增量（每次都是**完整集合**）。`session/list` 不分
   * 归档与否，归档过滤在客户端做。
   */
  private onWorkspaceFrame(
    frame: { type?: string; value?: { archivedSessionIds?: string[] }; archivedSessionIds?: string[] },
  ): void {
    let next: string[] | undefined;
    if (frame?.type === "baseline") next = frame.value?.archivedSessionIds;
    else if (frame?.type === "archived") next = frame.archivedSessionIds;
    if (!Array.isArray(next)) return;
    const nextSet = new Set(next);
    let changed = nextSet.size !== this.archivedSessionIds.size;
    if (!changed) {
      for (const id of nextSet) {
        if (!this.archivedSessionIds.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this.archivedSessionIds = nextSet;
    this.emitSessionLists();
  }

  /**
   * 控制流承载队列、后台任务与**投影**。
   *
   * 投影是会话整体状态的折叠值（模型选择、权限预设、待办、计划模式、标题…），
   * 比客户端自己重放日志省事得多。每次重连以一个 `baseline` 开场，其后是逐条
   * `projection` 增量；两者都按「seq 更小者不覆盖」的规则消费。
   */
  private onControlFrame(frame: SessionControlFrame): void {
    if (!frame || typeof frame !== "object") return;

    if (frame.type === "baseline") {
      const value = (frame as { value?: { queues?: Record<string, unknown[]>; jobs?: Record<string, unknown[]>; projections?: Record<string, { values?: Record<string, unknown> }> } }).value;
      if (!value) return;
      const sessionId = this.currentSessionId;
      if (sessionId) {
        const projections = value.projections?.[sessionId]?.values ?? {};
        for (const [key, projectionValue] of Object.entries(projections)) {
          this.applyProjection(key, projectionValue);
        }
        this.queueItems = queueItemsView(value.queues?.[sessionId]);
        this.emit({ type: "patch", patch: { queueItems: this.queueItems } });
        this.applyJobs(value.jobs?.[sessionId]);
      }
      return;
    }

    if (frame.type === "queue" && frame.sessionId === this.currentSessionId) {
      this.queueItems = queueItemsView(frame.items);
      this.emit({ type: "patch", patch: { queueItems: this.queueItems } });
      return;
    }

    if (frame.type === "jobs" && frame.sessionId === this.currentSessionId) {
      this.applyJobs(frame.jobs);
      return;
    }

    if (frame.type === "projection" && frame.sessionId === this.currentSessionId) {
      this.applyProjection(String(frame.key ?? ""), frame.value);
    }
  }

  /** 单个投影值 → 界面状态。未知 key 直接忽略（插件没加载 = 能力缺失，不是错误）。 */
  private applyProjection(key: string, value: unknown): void {    switch (key) {
      case "modelSelection":
        this.applyModelSelection(value);
        break;

      case "permissions": {
        // {options:[{value,name}], currentValue}：用它初始化权限胶囊
        const current = (value as { currentValue?: string } | null)?.currentValue;
        if (typeof current === "string" && current) {
          this.permission = current;
          this.emit({ type: "patch", patch: { permission: current } });
        }
        break;
      }

      case "plan": {
        const active = Boolean((value as { active?: boolean } | null)?.active);
        this.planMode = active;
        this.emit({ type: "patch", patch: { planMode: active } });
        break;
      }

      case "todos": {
        const items = Array.isArray(value) ? value : [];
        this.todos = items.map((todo, index) => {
          const item = todo as { id?: string; content?: string; text?: string; status?: string };
          return {
            id: String(item?.id ?? index),
            content: String(item?.content ?? item?.text ?? ""),
            status:
              item?.status === "completed"
                ? ("completed" as const)
                : item?.status === "in_progress"
                  ? ("in_progress" as const)
                  : ("pending" as const),
          };
        });
        this.emit({ type: "todos", todos: this.todos });
        break;
      }

      case "title": {
        if (typeof value === "string" && value) {
          const existing = this.sessions.find((s) => s.id === this.currentSessionId);
          const session: SessionSummaryView = existing
            ? { ...existing, title: value }
            : {
                id: this.currentSessionId ?? "",
                title: value,
                updatedAt: Date.now(),
                running: false,
              };
          if (existing) existing.title = value;
          this.adapter?.setSession(session);
          this.emit({ type: "patch", patch: { session } });
        }
        break;
      }

      case "contextPressure": {
        // {pressureTokens?, projectedTokens?, contextWindow?}：给上下文占用条提供分母
        const contextWindow = (value as { contextWindow?: number } | null)?.contextWindow;
        if (typeof contextWindow === "number" && contextWindow > 0 && this.model) {
          this.model = { ...this.model, contextWindow };
          this.emit({ type: "patch", patch: { model: this.model } });
        }
        break;
      }

      case "contextBreakdown": {
        // {systemTokens, toolsTokens, messageTokens}：上下文构成的启发式估算
        const bd = value as { systemTokens?: number; toolsTokens?: number; messageTokens?: number } | null;
        if (
          bd &&
          typeof bd.systemTokens === "number" &&
          typeof bd.toolsTokens === "number" &&
          typeof bd.messageTokens === "number"
        ) {
          this.contextBreakdown = {
            systemTokens: bd.systemTokens,
            toolsTokens: bd.toolsTokens,
            messageTokens: bd.messageTokens,
          };
          this.emit({ type: "patch", patch: { contextBreakdown: this.contextBreakdown } });
        }
        break;
      }

      case "sessionStats": {
        // 全日志墙钟统计：{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens}
        const st = value as {
          turns?: number;
          steps?: number;
          llmMs?: number;
          toolMs?: number;
          ttftMs?: number;
          ttftSteps?: number;
          decodeMs?: number;
          decodeTokens?: number;
        } | null;
        if (st && typeof st.llmMs === "number" && typeof st.toolMs === "number") {
          this.sessionStats = {
            turns: st.turns ?? 0,
            steps: st.steps ?? 0,
            llmMs: st.llmMs,
            toolMs: st.toolMs,
            ttftMs: st.ttftMs ?? 0,
            ttftSteps: st.ttftSteps ?? 0,
            decodeMs: st.decodeMs ?? 0,
            decodeTokens: st.decodeTokens ?? 0,
          };
          this.emit({ type: "patch", patch: { sessionStats: this.sessionStats } });
        }
        break;
      }

      case "subagentCatalog": {
        // 投影里已经带着子代理目录，界面无需再单独请求一次
        const entries = Array.isArray(value) ? value : [];
        this.subagents = entries
          .filter((entry) => (entry as { kind?: string })?.kind === "child")
          .map((entry) => {
            const child = entry as { id: string; mode?: string; activity?: string; label?: string };
            return {
              id: child.id,
              label: child.label ?? child.id,
              activity: child.activity === "running" ? ("running" as const) : ("inactive" as const),
            };
          });
        this.emit({
          type: "subagents/list",
          entries: this.subagents,
          parentAvailable: this.subagents.length > 0,
        });
        break;
      }

      case "goal": {
        const goal = value as
          | { objective?: string; phase?: string; rounds?: number; maxRounds?: number }
          | null
          | undefined;
        if (goal?.objective) {
          this.goal = {
            objective: goal.objective,
            phase: goal.phase ?? "",
            rounds: goal.rounds ?? 0,
            maxRounds: goal.maxRounds,
          };
        } else {
          this.goal = undefined;
        }
        this.emit({ type: "patch", patch: { goal: this.goal } });
        break;
      }

      default:
        break;
    }
  }

  /** 后台任务帧 → 界面状态。 */
  private applyJobs(jobs: unknown): void {
    const list = Array.isArray(jobs) ? jobs : [];
    this.jobs = list.map((job) => {
      const item = job as {
        id: string;
        kind?: string;
        label?: string;
        status?: string;
        detail?: string;
        startedAt?: number;
        finishedAt?: number;
      };
      const status =
        item.status === "running" ||
        item.status === "stopping" ||
        item.status === "completed" ||
        item.status === "killed" ||
        item.status === "failed"
          ? item.status
          : "completed";
      return {
        id: item.id,
        kind: item.kind ?? "job",
        label: item.label ?? item.id,
        status,
        detail: item.detail,
        startedAt: item.startedAt ?? Date.now(),
        finishedAt: item.finishedAt,
      };
    });
    this.emit({ type: "jobs/list", jobs: this.jobs });
    this.emit({ type: "patch", patch: { jobs: this.jobs } });
  }

  // ---------- 主机事件（审批 / 提问） ----------

  private openEventsStream(): void {
    if (!this.client) return;
    this.eventsHandle?.cancel();
    this.eventsHandle = this.client.openEvents({
      onItem: (value) => void this.onEventFrame(value as RemoteEventFrame),
    });
  }

  /**
   * 审批与提问只从这条流来。**收到 waterfall 必须回复**——不回复会把 Agent 永久挂住，
   * 而且重连后同一条会重投递，所以要按 eventId 去重。
   */
  private async onEventFrame(frame: RemoteEventFrame): Promise<void> {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "ready") {
      this.eventsClientId = frame.clientId;
      return;
    }
    if (frame.type !== "waterfall") return;
    const waterfall = frame as RemoteEventWaterfall;
    if (this.handledEvents.has(waterfall.eventId)) {
      // 重投递：直接放行给链上的下一个处理器，避免重复弹卡片
      await this.replyEvent(waterfall.eventId, { kind: "next" });
      return;
    }

    if (waterfall.event === "approval/request") {
      const request = waterfall.request as { toolName?: string; callId?: string; reason?: string };
      this.handledEvents.add(waterfall.eventId);
      this.adapter?.addApproval({
        requestId: waterfall.eventId,
        toolName: request.toolName ?? "工具",
        reason: request.reason,
        detail: request.callId ? `调用标识：${request.callId}` : undefined,
        state: "waiting",
      });
      this.pendingApproval = waterfall.eventId;
      return;
    }

    if (waterfall.event === "user-questions/request") {
      const request = waterfall.request as { questions?: QuestionView["items"] };
      this.handledEvents.add(waterfall.eventId);
      this.adapter?.addQuestion({
        requestId: waterfall.eventId,
        items: (request.questions ?? []).map((item) => ({
          id: item.id,
          header: item.header,
          question: item.question,
          options: item.options ?? [],
          multiSelect: item.multiSelect,
        })),
        state: "waiting",
      });
      this.pendingQuestion = waterfall.eventId;
      return;
    }

    // 不认识的事件：放行，不能拦着
    await this.replyEvent(waterfall.eventId, { kind: "next" });
  }

  private pendingApproval: string | undefined;
  private pendingQuestion: string | undefined;
  /** 新建会话后要套用的默认思考深度（来自 dshChat.defaultReasoningEffort）。 */
  private pendingReasoningEffort: string | undefined;
  /** 待应用的模型选择：UI 切换模型时只记到这里，下次发送前才真正 selectModel。 */
  private pendingModel: {
    provider: string;
    model: string;
    reasoningEffort?: string;
    label?: string;
    efforts?: { id: string; name: string }[];
    contextWindow?: number;
    acceptsImage?: boolean;
  } | undefined;
  /** 最近一次收到的 modelSelection 原始投影，模型目录就绪后用于重放。 */
  private lastModelSelection: unknown;

  private async replyEvent(eventId: string, outcome: unknown): Promise<void> {
    if (!this.client || !this.eventsClientId) return;
    try {
      await this.client.answerEvent(this.eventsClientId, eventId, outcome as never);
    } catch (error) {
      this.log(`[$events] 回复失败：${this.describeError(error)}`);
    }
  }

  // ---------- 模型 ----------

  /**
   * `provider:model` → 是否接受图片输入。
   *
   * `session/modelCatalog` 的线格式不带输入模态（严格 schema 只有
   * id/name/description/reasoning），模态只存在于 LLM 适配器的设置命名空间：
   * - `llm-pi-ai`：`{providers: {<route>: {defaultInput?, models?, modelOverrides?}}}`；
   * - `llm-deepseek`：`{models: [{id, inputModalities?}]}`（provider 固定 deepseek-official）。
   * 从 `settings/describe` 读出后按模型归档；未声明者按「支持」处理（与 dsh web
   * 一致——它也不隐藏按钮，发送时由服务端 `session/attachment` 复核并报错）。
   */
  private imageCaps = new Map<string, boolean>();

  private acceptsImageFor(provider: string, model: string): boolean {
    return this.imageCaps.get(`${provider}:${model}`) ?? true;
  }

  private async refreshImageCaps(): Promise<void> {
    if (!this.client) return;
    try {
      const described = await this.client.settingsDescribe();
      const caps = new Map<string, boolean>();
      for (const section of described.namespaces ?? []) {
        const value = section.value as Record<string, any> | null | undefined;
        if (!value || typeof value !== "object") continue;
        const providers = value.providers as Record<string, any> | undefined;
        if (section.ns === "llm-pi-ai" && providers && typeof providers === "object") {
          for (const [provider, profile] of Object.entries(providers)) {
            const p = (profile && typeof profile === "object" ? profile : {}) as Record<string, any>;
            const defaultInput = Array.isArray(p.defaultInput) ? p.defaultInput : undefined;
            const record = (id: string, declared?: string[]) => {
              const list = declared ?? defaultInput;
              if (Array.isArray(list)) caps.set(`${provider}:${id}`, list.includes("image"));
            };
            if (Array.isArray(p.models)) {
              for (const entry of p.models) {
                if (entry?.id) record(entry.id, Array.isArray(entry.input) ? entry.input : undefined);
              }
            }
            const overrides = (p.modelOverrides && typeof p.modelOverrides === "object" ? p.modelOverrides : {}) as Record<string, any>;
            for (const [id, ov] of Object.entries(overrides)) {
              if (!caps.has(`${provider}:${id}`)) record(id, Array.isArray(ov?.input) ? ov.input : undefined);
            }
          }
        } else if (section.ns === "llm-deepseek" && Array.isArray(value.models)) {
          for (const m of value.models) {
            if (m?.id && Array.isArray(m.inputModalities)) {
              caps.set(`deepseek-official:${m.id}`, m.inputModalities.includes("image"));
            }
          }
        }
      }
      this.imageCaps = caps;
      // 当前模型同步刷新后推给界面（切换模型前目录/设置可能已更新）
      if (this.model) {
        this.model = { ...this.model, acceptsImage: this.acceptsImageFor(this.model.provider, this.model.model) };
        this.emit({ type: "patch", patch: { model: this.model } });
      }
    } catch (error) {
      this.log(`[models] 图片输入能力读取失败：${this.describeError(error)}`);
    }
  }

  private async loadModels(): Promise<void> {
    if (!this.client) return;
    try {
      const catalog = await this.client.modelCatalog();
      this.models = (catalog.groups ?? []).map((group) => ({
        id: group.id,
        name: group.name,
        models: (group.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          description: model.description,
          efforts: model.reasoning?.efforts,
          defaultEffort: model.reasoning?.defaultEffort,
        })),
      }));
      this.emit({ type: "models", groups: this.models, current: this.model });
      // 图片能力来自设置命名空间，在选定默认/当前模型前刷新
      await this.refreshImageCaps();
      // 投影可能先于模型目录到达（WS 一开就推 baseline），那时只能显示模型 id；
      // 目录就绪后用原始投影重放一次，把 id 换成人类可读的名字
      if (this.lastModelSelection) this.applyModelSelection(this.lastModelSelection);
      else await this.loadDefaultModel();
    } catch (error) {
      this.log(`[models] 目录获取失败：${this.describeError(error)}`);
    }
  }

  /**
   * 新会话在首次对话前没有 modelSelection，但 agent 仍会用部署默认值。
   * 从 `agent-default-model` 设置命名空间读出来，开场就显示真实模型。
   */
  private async loadDefaultModel(): Promise<void> {
    if (!this.client || this.model) return;
    try {
      const described = await this.client.settingsDescribe();
      const section = described.namespaces?.find((item) => item.ns === "agent-default-model");
      const value = section?.value as { provider?: string; model?: string; reasoningEffort?: string } | undefined;
      if (!value?.provider || !value.model) return;
      const group = this.models.find((g) => g.id === value.provider);
      const model = group?.models.find((m) => m.id === value.model);
      this.model = {
        provider: value.provider,
        model: value.model,
        label: model?.name ?? value.model,
        reasoningEffort: value.reasoningEffort,
        efforts: model?.efforts,
        contextWindow: model?.contextWindow,
        acceptsImage: this.acceptsImageFor(value.provider, value.model),
      };
      this.emit({ type: "patch", patch: { model: this.model } });
      void this.applyPendingEffort();
    } catch (error) {
      this.log(`[models] 默认模型读取失败：${this.describeError(error)}`);
    }
  }

  // ---------- webview 指令 ----------

  async handle(message: WebviewToHost): Promise<void> {
    switch (message.type) {
      case "ready":
        this.emit({ type: "state", state: this.snapshot() });
        break;

      case "send":
        // 未连接时先恢复连接：历史会话切换后跟随流尚未建立时直接 prompt
        // 会触发服务端 resume，冷启动竞态下 resume 可能失败
        if (!this.client || this.connection !== "connected") await this.ensureConnected();
        await this.send(message.text, message.attachments);
        break;

      case "stop":
        if (this.client && this.currentSessionId) {
          await this.client.cancel(this.currentSessionId);
          this.emit({ type: "patch", patch: { running: false } });
        }
        break;

      case "queueRemove":
        // 移除后服务端会重发队列帧，界面以帧为准；这里只做请求与兜底报错
        if (this.client && this.currentSessionId && message.id) {
          this.client.updateQueueRemove(this.currentSessionId, message.id).catch((error) => {
            this.reportError("取消排队消息失败", error);
          });
        }
        break;

      case "newSession":
        await this.newSession();
        break;

      case "openSession":
        await this.openSession(message.sessionId);
        break;

      case "listSessions":
        await this.refreshSessions();
        break;

      case "archiveSession":
        await this.archiveSession(message.sessionId);
        break;

      case "deleteSession":
        await this.deleteSession(message.sessionId);
        break;

      case "setModel":
        // 延迟到下一次发送时生效（与 UI 进入计划模式同机制）：
        // 避免正在生成时切模型导致本轮中途换模型，也让界面立刻反映选择
        const group = this.models.find((g) => g.id === message.provider);
        const model = group?.models.find((m) => m.id === message.model);
        this.pendingModel = {
          provider: message.provider,
          model: message.model,
          reasoningEffort: message.reasoningEffort,
          label: model?.name ?? message.model,
          efforts: model?.efforts,
          contextWindow: model?.contextWindow ?? this.model?.contextWindow,
          acceptsImage: this.acceptsImageFor(message.provider, message.model),
        };
        // 立即更新胶囊显示（实际 selectModel 在下次发送前执行）
        this.model = {
          provider: this.pendingModel.provider,
          model: this.pendingModel.model,
          label: this.pendingModel.label ?? this.pendingModel.model,
          reasoningEffort: this.pendingModel.reasoningEffort,
          efforts: this.pendingModel.efforts,
          contextWindow: this.pendingModel.contextWindow,
          acceptsImage: this.pendingModel.acceptsImage,
        };
        this.emit({ type: "patch", patch: { model: this.model } });
        break;

      case "setPermission":
        await this.runCommand(`/permission ${message.permission}`);
        break;

      case "answerApproval": {
        const eventId = message.requestId;
        if (!eventId) break;
        await this.replyEvent(eventId, {
          kind: "result",
          value: message.approved ? "allowed-once" : "rejected",
        });
        this.adapter?.resolveApproval(eventId, message.approved ? "approved" : "rejected");
        if (this.pendingApproval === eventId) this.pendingApproval = undefined;
        break;
      }

      case "answerQuestion": {
        const eventId = message.requestId;
        if (!eventId) break;
        await this.replyEvent(eventId, {
          kind: "result",
          value: { answers: message.answers },
        });
        this.adapter?.resolveQuestion(eventId);
        if (this.pendingQuestion === eventId) this.pendingQuestion = undefined;
        break;
      }

      case "addFiles":
        await this.pickFiles();
        break;

      case "addImages":
        // 模型不支持图片输入时拒绝（防御性，正常情况下 UI 已隐藏按钮）
        if (this.model && this.model.acceptsImage === false) {
          this.emit({
            type: "toast",
            level: "warn",
            text: `@imageUnsupported:${this.model.label ?? this.model.model}`,
          });
          break;
        }
        await this.pickImages();
        break;

      case "addMention": {
        // @ 提及选中的文件/目录：直接作为附件芯片加入（不再弹系统对话框）
        const key = this.sessionKey();
        const list = this.attachmentsBySession.get(key) ?? [];
        if (list.some((item) => item.path === message.path)) break;
        list.push({
          id: randomUUID(),
          kind: message.kind === "directory" ? "folder" : "file",
          path: message.path,
          name: this.relativePath(message.path),
        });
        this.attachmentsBySession.set(key, list);
        this.emit({ type: "patch", patch: { attachments: [...list] } });
        break;
      }

      case "removeAttachment":
        this.removeAttachment(message.id);
        break;

      case "setDraft":
        this.drafts.set(this.sessionKey(), message.text);
        break;

      case "openFile":
        await this.openFile(message.path);
        break;

      case "insertText":
        await this.insertIntoEditor(message.text);
        break;

      case "copy":
        await vscode.env.clipboard.writeText(message.text);
        this.emit({ type: "toast", level: "info", text: "已复制到剪贴板" });
        break;

      case "listSubagents":
        await this.refreshSubagents();
        break;

      case "openSubagent":
        await this.openSubagent(message.id);
        break;

      case "listJobs":
        this.emit({ type: "jobs/list", jobs: this.jobs });
        break;

      case "listCommands":
        await this.listCommands();
        break;

      case "queryFiles":
        await this.queryFiles(message.query);
        break;

      case "describeSettings":
        await this.describeSettings();
        break;

      case "saveSetting":
        await this.saveSetting(message.ns, message.path, message.value, message.expectedRevision);
        // 设置里可能改了 LLM 适配器的输入模态声明，刷新图片能力
        void this.refreshImageCaps();
        break;

      case "resetSettings":
        await this.resetNamespace(message.ns);
        void this.refreshImageCaps();
        break;

      case "saveSecret":
        await this.saveSecret(message.ns, message.path, message.value, message.ref);
        break;

      case "openVscodeSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "dshChat");
        break;

      case "openInEditor":
        await vscode.commands.executeCommand("dshChat.openInEditor");
        break;

      case "showLogs":
        this.log("");
        break;

      case "restartServer":
        await this.restart();
        break;

      case "openSettings":
        await vscode.commands.executeCommand("workbench.action.openSettings", "dshChat");
        break;

      default:
        break;
    }
  }

  private async send(text: string, attachments: Attachment[]): Promise<void> {
    if (!this.client) return;
    if (!this.currentSessionId) await this.newSession();
    if (!this.currentSessionId) return;

    const content: unknown[] = [];
    const contextText = this.buildContextText(attachments);
    if (contextText) content.push({ type: "text", text: contextText });
    if (text.trim()) content.push({ type: "text", text: text.trim() });
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.dataUrl) {
        const match = /^data:([^;]+);base64,(.*)$/.exec(attachment.dataUrl);
        if (match) {
          content.push({ type: "image", mediaType: match[1], data: match[2], name: attachment.name });
        }
      }
    }
    if (content.length === 0) return;

    try {
      // 发送前应用待生效的模型选择（与计划模式前缀同机制：切换即时生效于"下一轮"）
      if (this.pendingModel) {
        const { provider, model, reasoningEffort } = this.pendingModel;
        this.pendingModel = undefined;
        try {
          await this.client.selectModel(this.currentSessionId, provider, model, reasoningEffort);
        } catch (error) {
          this.log(`[model] 发送前应用模型选择失败：${this.describeError(error)}`);
        }
      }
      const key = this.sessionKey();
      this.attachmentsBySession.set(key, []);
      this.drafts.set(key, "");
      this.running = true;
      this.emit({ type: "patch", patch: { attachments: [], draft: "", running: true } });
      // dsh 自身维护队列：运行中提交即排队（steer 需要显式打断语义，首期不用）
      await this.client.prompt(this.currentSessionId, content, "queue");
    } catch (error) {
      this.running = false;
      this.emit({ type: "patch", patch: { running: false } });
      this.reportError("发送失败", error);
    }
  }

  /** 把文件/文件夹附件折叠成上下文文本（不做文件上传，保持简单可靠）。 */
  private buildContextText(attachments: Attachment[]): string {
    const parts: string[] = [];
    for (const attachment of attachments) {
      if (attachment.kind === "selection" && attachment.text) {
        parts.push(`以下是来自 ${attachment.name} 的选中代码：\n\`\`\`\n${attachment.text}\n\`\`\``);
        continue;
      }
      if (attachment.kind === "file" && attachment.path) {
        try {
          const stat = statSync(attachment.path);
          if (stat.size > 512 * 1024) {
            parts.push(`文件 ${this.relativePath(attachment.path)} 过大（${Math.round(stat.size / 1024)} KB），未内联。`);
            continue;
          }
          const body = readFileSync(attachment.path, "utf8");
          parts.push(`文件 ${this.relativePath(attachment.path)} 的内容：\n\`\`\`\n${body}\n\`\`\``);
        } catch {
          parts.push(`文件路径：${attachment.path}`);
        }
        continue;
      }
      if (attachment.kind === "folder" && attachment.path) {
        parts.push(`请关注目录：${this.relativePath(attachment.path)}`);
      }
    }
    return parts.join("\n\n");
  }

  private relativePath(path: string): string {
    const root = this.workspacePath();
    const rel = relative(root, path);
    return rel && !rel.startsWith("..") ? rel : path;
  }

  /**
   * 执行一条斜杠命令。
   *
   * `commands/execute` 的第三个位置参数在 0.1.5 从 `images` 改名为
   * `submittedAttachments`，而网关对参数名做严格校验（多一个少一个都拒）。
   * 协议没有版本协商，所以先按新名调用，命中 `gateway/arguments-invalid`
   * 时回退到旧名，并记住生效的那个。
   */
  private async runCommand(line: string): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    const agentId = this.currentSessionId;
    const attempt = (attachmentsKey: "submittedAttachments" | "images") =>
      this.client!.request("commands/execute", { agentId, line, [attachmentsKey]: [] });

    try {
      await attempt(this.attachmentsParam);
    } catch (error) {
      const isArgumentMismatch = error instanceof DshApiError && error.code === "gateway/arguments-invalid";
      if (!isArgumentMismatch) {
        this.reportError(`执行 ${line} 失败`, error);
        return;
      }
      const fallback = this.attachmentsParam === "submittedAttachments" ? "images" : "submittedAttachments";
      this.log(`[commands] 参数名不被接受，回退为 ${fallback}`);
      try {
        await attempt(fallback);
        this.attachmentsParam = fallback;
      } catch (retryError) {
        this.reportError(`执行 ${line} 失败`, retryError);
      }
    }
  }

  /** 记下 0.1.5 起的参数名，回退成功后更新。 */
  private attachmentsParam: "submittedAttachments" | "images" = "submittedAttachments";

  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: true,
      openLabel: "添加为上下文",
    });
    if (!picked?.length) return;
    this.mutateAttachments((list) => {
      for (const uri of picked) {
        let isDirectory = false;
        try {
          isDirectory = statSync(uri.fsPath).isDirectory();
        } catch {
          continue;
        }
        const attachment: Attachment = {
          id: randomUUID(),
          kind: isDirectory ? "folder" : "file",
          path: uri.fsPath,
          name: this.relativePath(uri.fsPath),
        };
        if (!list.some((a) => a.path === attachment.path)) list.push(attachment);
      }
    });
  }

  private async pickImages(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      filters: { Images: ["png", "jpg", "jpeg", "webp", "gif"] },
      openLabel: "添加图片",
    });
    if (!picked?.length) return;
    this.mutateAttachments((list) => {
      for (const uri of picked) {
        try {
          const bytes = readFileSync(uri.fsPath);
          const ext = uri.fsPath.split(".").pop()?.toLowerCase() ?? "png";
          const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
          list.push({
            id: randomUUID(),
            kind: "image",
            name: basename(uri.fsPath),
            path: uri.fsPath,
            dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
            bytes: bytes.length,
          });
        } catch (error) {
          this.log(`[image] 读取失败：${this.describeError(error)}`);
        }
      }
    });
  }

  private removeAttachment(id: string): void {
    this.mutateAttachments((list) => {
      const index = list.findIndex((a) => a.id === id);
      if (index >= 0) list.splice(index, 1);
    });
  }

  /** 供编辑器命令调用：把一段文本作为上下文加入输入框。 */
  addSelection(name: string, text: string): void {
    this.mutateAttachments((list) => {
      list.push({ id: randomUUID(), kind: "selection", name, text });
    });
  }

  addFileContext(path: string): void {
    this.mutateAttachments((list) => {
      if (list.some((a) => a.path === path)) return;
      list.push({
        id: randomUUID(),
        kind: "file",
        path,
        name: this.relativePath(path),
      });
    });
  }

  private async openFile(path: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      this.log(`[open] 打开失败 ${path}：${this.describeError(error)}`);
    }
  }

  private async insertIntoEditor(text: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage("没有打开的编辑器，代码已复制到剪贴板。");
      return;
    }
    await editor.edit((builder) => builder.insert(editor.selection.active, text));
  }

  // ---------- 子代理 ----------

  /** 拉取子代理目录（投影里没有时按需请求）。 */
  private async refreshSubagents(): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "subagents/list", entries: [], parentAvailable: false });
      return;
    }
    try {
      const result = await this.client.request<{ entries?: unknown[]; parentAvailable?: boolean }>(
        "subagents/list",
        { parentSessionId: this.currentSessionId },
      );
      const entries = (result.entries ?? []).filter(
        (entry) => (entry as { kind?: string })?.kind === "child",
      );
      this.subagents = entries.map((entry) => {
        const child = entry as { id: string; activity?: string; label?: string; mode?: string };
        return {
          id: child.id,
          label: child.label ?? child.id,
          activity: child.activity === "running" ? ("running" as const) : ("inactive" as const),
        };
      });
      this.emit({
        type: "subagents/list",
        entries: this.subagents,
        parentAvailable: result.parentAvailable ?? this.subagents.length > 0,
      });
    } catch (error) {
      this.log(`[subagents] 列表获取失败：${this.describeError(error)}`);
      this.emit({ type: "subagents/list", entries: [], parentAvailable: false });
    }
  }

  /**
   * 打开某个子代理的对话记录。
   *
   * 子代理是独立会话，用 `session/follow` 的 subagent 地址打开一次快照即可
   * （不需要长跟随：这里只是查看）。
   */
  private async openSubagent(childSessionId: string): Promise<void> {
    if (!this.client || !this.currentSessionId) return;
    const parentSessionId = this.currentSessionId;
    const adapter = new SessionAdapter(() => {});
    adapter.setSession({
      id: childSessionId,
      title: childSessionId,
      updatedAt: Date.now(),
      running: false,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        handle?.cancel();
        this.emit({ type: "subagent/transcript", id: childSessionId, messages: adapter.snapshotMessages() });
        resolve();
      };
      const handle = this.client!.openStream(
        "session/follow",
        {
          request: {
            address: { kind: "subagent", parentSessionId, childSessionId, mode: "continuable" },
            maxMessages: 60,
            assistantStream: false,
          },
        },
        {
          onItem: (value) => {
            adapter.applyFrame(value as never);
            if ((value as { type?: string })?.type === "event") {
              // 拿到第一条事件（或快照）后给一个小窗口收完剩余记录
              setTimeout(finish, 800);
            } else if ((value as { type?: string })?.type === "snapshot") {
              setTimeout(finish, 800);
            }
          },
          onError: () => finish(),
          onEnd: () => finish(),
        },
      );
      setTimeout(finish, 8_000);
    });
  }

  // ---------- 斜杠命令与文件提及 ----------

  /** 斜杠命令目录；冷会话也能列。 */
  private async listCommands(): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "commands/list", commands: [] });
      return;
    }
    try {
      const rows = await this.client.request<
        { name: string; description?: string; input?: { hint?: string } }[]
      >("commands/list", { agentId: this.currentSessionId });
      this.emit({
        type: "commands/list",
        commands: (rows ?? []).map((row) => ({
          name: row.name,
          description: row.description ?? "",
          hint: row.input?.hint,
        })),
      });
    } catch (error) {
      this.log(`[commands] 列表获取失败：${this.describeError(error)}`);
      this.emit({ type: "commands/list", commands: [] });
    }
  }

  /** @ 提及：查询文件引用候选。 */
  private async queryFiles(query: string): Promise<void> {
    if (!this.client || !this.currentSessionId) {
      this.emit({ type: "files/list", query, items: [] });
      return;
    }
    try {
      const rows = await this.client.request<{ path: string; kind: "file" | "directory" }[]>(
        "fileReferences/list",
        { agentId: this.currentSessionId, query },
      );
      this.emit({ type: "files/list", query, items: rows ?? [] });
    } catch (error) {
      this.log(`[files] 查询失败：${this.describeError(error)}`);
      this.emit({ type: "files/list", query, items: [] });
    }
  }

  // ---------- 设置 ----------

  /** 读取全部设置命名空间，并把手里的 schema 化成可渲染字段。 */
  private async describeSettings(): Promise<void> {
    if (!this.client) return;
    try {
      const described = await this.client.settingsDescribe();
      const namespaces = (described as { namespaces?: Record<string, unknown>[] }).namespaces ?? [];
      const sections = namespaces.map((item) => buildSettingsSection(item as never));
      this.emit({
        type: "settings/describe",
        sections,
        writable: Boolean((described as { writable?: boolean }).writable),
      });
    } catch (error) {
      this.log(`[settings] 读取失败：${this.describeError(error)}`);
      this.emit({ type: "settings/describe", sections: [], writable: false });
    }
  }

  /** 写入一个字段：布尔/数字/字符串都走 settings/mutate 的 set 操作。 */
  private async saveSetting(
    ns: string,
    path: string[],
    value: unknown,
    expectedRevision: number,
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("settings/mutate", {
        ns,
        ops: [{ op: "set", path, value }],
        expectedRevision,
      });
      this.emit({ type: "toast", level: "info", text: "settingsSaved" });
      await this.describeSettings();
    } catch (error) {
      this.reportError(`保存到 ${ns} 失败`, error);
      // 版本冲突后重读，界面拿到新的 revision 才能重试
      await this.describeSettings();
    }
  }

  /** 重置某个命名空间的用户层覆盖。 */
  private async resetNamespace(ns: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.request("settings/replace", { ns, section: {} });
      this.emit({ type: "toast", level: "info", text: "settingsResetDone" });
      await this.describeSettings();
    } catch (error) {
      this.reportError(`重置 ${ns} 失败`, error);
    }
  }

  /**
   * 密钥字段写入凭据存储（值不会回显，服务端只回 set 状态）。
   *
   * ref 是 POSIX 环境变量名（schema 里 `role: credential-ref` 的兄弟字段给出，
   * 界面随字段一起带到 secretRef），不是设置路径。
   */
  private async saveSecret(ns: string, path: string[], value: string, ref?: string): Promise<void> {
    if (!this.client || !value) return;
    const target = ref || path[path.length - 1];
    try {
      await this.client.request("credentials/set", { ref: target, value });
      this.emit({ type: "toast", level: "info", text: "settingsSaved" });
      await this.describeSettings();
    } catch (error) {
      this.reportError(`写入密钥失败（${ns} → ${target}）`, error);
    }
  }

  private reportError(prefix: string, error: unknown): void {
    const detail = this.describeError(error);
    this.log(`[error] ${prefix}：${detail}`);
    void vscode.window.showErrorMessage(`${prefix}：${detail}`);
  }

  dispose(): void {
    this.disposed = true;
    this.teardownStreams();
    this.client?.dispose();
  }
}

/**
 * 队列里「用户等待发送的消息」的视图（线格式 `SessionQueuedItem` → `QueuedMessageView`）。
 *
 * 队列项有三种 `placement`：`queued`（用户排队待发的消息）、`steering`（插话）、
 * `context`（插件注入的环境上下文，例如 MCP 服务器状态）。context 不是用户消息，
 * 不下发——否则全新会话一开场就会显示一串「排队消息」。
 */
function queueItemsView(items: unknown[] | undefined): QueuedMessageView[] {
  if (!Array.isArray(items)) return [];
  const out: QueuedMessageView[] = [];
  for (const raw of items) {
    const item = raw as {
      id?: string;
      placement?: string;
      message?: { content?: unknown[] };
    } | null;
    if (!item?.id) continue;
    if (item.placement !== "queued" && item.placement !== "steering") continue;
    const parts = Array.isArray(item.message?.content) ? item.message!.content : [];
    const text = parts
      .map((part) => part as { type?: string; text?: string } | null)
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part!.text)
      .join("\n")
      .trim();
    const hasMedia = parts.some((part) => {
      const type = (part as { type?: string } | null)?.type;
      return type === "image" || type === "file";
    });
    out.push({ id: item.id, text, hasMedia, placement: item.placement });
  }
  return out;
}

/** 供日志通道使用的时间戳。 */
export function stamp(line: string): string {
  return `[${new Date().toLocaleTimeString()}] ${line}`;
}

