import type {
  ChatState,
  JobItemView,
  ModelSelectionView,
  QueuedMessageView,
  SubagentView,
  TodoView,
} from "../shared/chat";
import type { SessionAdapter } from "./adapter";
import type { QueueOrigin } from "./queueView";

/**
 * 一个被窗口打开的**会话域**。
 *
 * 控制器曾是单会话总控（`currentSessionId` + 一个 `adapter` + 一条 follow 流 +
 * 一套投影/队列/运行状态）。支持多窗口后，每个窗口要能开**不同的会话**，
 * 所有「当前会话」绑定的状态都搬到这里——每个会话一个域，互不干扰。
 * 控制器只保留跨会话共享的全局态（连接、会话列表、模型目录、设置……）。
 *
 * 域内产生的帧（适配器回放、队列、投影……）只发给**绑定到该会话的窗口**，
 * 不再广播给所有窗口（见控制器的 `deliver`）；全局帧（连接、会话列表……）
 * 走 `emitAll`。
 *
 * 域的生命周期：窗口首次绑定该会话时惰性创建（建 follow 流）；最后一个
 * 绑定的窗口解绑时回收（会话本身在服务端继续存活，重新打开时重新跟随、
 * 重新推快照，一切状态从服务端重算）。
 */
export class SessionScope {
  readonly sessionId: string;

  /** 本会话的视图模型（消息流与粘性显示值）。socket 重连时整个重建。 */
  adapter: SessionAdapter | undefined;
  /** `session/follow` 流句柄（每会话一条，remote.mux 上多路复用）。 */
  followHandle: { cancel(): void } | undefined;

  /** 本会话是否正在生成（由适配器的 running patch 帧同步）。 */
  running = false;
  /** 排队中的消息（session/control 的 queue 帧）。 */
  queueItems: QueuedMessageView[] = [];
  /** 队列项 id → 它的原始输入（每次队列帧到达时按 rpcId 重建）。 */
  readonly queueOrigin = new Map<string, QueueOrigin>();

  /** 会话内投影：待办 / 子代理目录 / 后台任务 / 目标条 / 计划模式 / 权限。 */
  todos: TodoView[] = [];
  subagents: SubagentView[] = [];
  jobs: JobItemView[] = [];
  goal: ChatState["goal"];
  planMode = false;
  permission: string | undefined;

  /**
   * 本会话下一轮将用的模型（`modelSelection` 投影，新会话没有选择时是部署默认）。
   * 不同会话各自独立——`session/selectModel` 按会话生效。
   */
  model: ModelSelectionView | undefined;
  /** UI 切换模型时只记到这里，下次发送前才真正 selectModel（与旧单值同机制）。 */
  pendingModel: ModelSelectionView | undefined;
  /** 最近一次收到的 modelSelection 原始投影，模型目录就绪后用于重放。 */
  lastModelSelection: unknown;

  /** 粘性投影值：上下文构成 / 会话统计 / 全日志用量 / 轮次导航 / 图片准入。 */
  contextBreakdown: ChatState["contextBreakdown"];
  sessionStats: ChatState["sessionStats"];
  tokenUsage: ChatState["tokenUsage"];
  turnOutline: ChatState["turnOutline"];
  imageLimits: ChatState["imageLimits"];

  /** 命令目录（`commands/list`）：把手打的 `/xxx` 路由到命令通道。 */
  readonly commandCatalog = new Map<string, { hint?: string }>();

  /** 当前绑定到本会话的窗口数（归零时控制器回收整个域）。 */
  viewers = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }
}
