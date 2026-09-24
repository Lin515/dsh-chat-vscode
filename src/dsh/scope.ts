import type {
  ChatState,
  JobItemView,
  ModelSelectionView,
  QueuedMessageView,
  SubagentView,
  TodoView,
} from "../shared/chat";
import type { SessionAdapter } from "./adapter";
import { ProjectionStore } from "./projectionStore";
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
  /**
   * 会话是**子代理**时的地址（普通会话没有它）。
   *
   * `session/follow` / `session/page` 要用子代理地址打开（地址是宿主鉴权的一部分，
   * `mode` 必须是子代理的真实模式）；发消息与停止分别走 `subagents/prompt` 与
   * `subagents/interruptByParent`。官方把同样的信息建模在客户端 Session 的
   * `address` 上（`dsh-api-session-controller`）。
   */
  subagentAddress: { parentSessionId: string; mode: "one-shot" | "continuable" } | undefined;

  readonly sessionId: string;

  /** 本会话的视图模型（消息流与粘性显示值）。socket 重连时整个重建。 */
  adapter: SessionAdapter | undefined;
  /** `session/follow` 流句柄（每会话一条，remote.mux 上多路复用）。 */
  followHandle: { cancel(): void } | undefined;
  /**
   * `job/list` 流句柄（每会话一条，0.1.7-alpha.1 起的后台任务名册通道）。
   *
   * 与 `session/control` 的 `jobs` 帧是**两条同源通道**：新服务端走这条流，
   * 旧服务端只有控制流那条（见 `controller.onControlFrame`）。两条都读、都写同一个
   * `jobs` 字段，所以哪条先到都对。
   */
  jobsHandle: { cancel(): void } | undefined;

  /** 本会话是否正在生成（由适配器的 running patch 帧同步）。 */
  running = false;
  /**
   * 本会话是否有一页更早的历史正在取（`loadMore` 的并发闸门）。
   *
   * 界面那边靠宿主发的 `historyLoading` 帧去重，但帧要一个来回才到——用户滚到顶时
   * 一秒能来几十个滚动事件，闸门放在宿主侧才真正「一次只飞一页」（否则同一页会被
   * 并发请求多次，白白重折一遍历史）。
   */
  historyLoading = false;
  /** 排队中的消息（`inbox` 投影；旧服务端是 session/control 的队列帧）。 */
  queueItems: QueuedMessageView[] = [];
  /** 队列项 id → 它的原始输入（每次队列帧到达时按 rpcId 重建）。 */
  readonly queueOrigin = new Map<string, QueueOrigin>();

  /**
   * 本会话的**投影值存储**（`key → {value, seq}`，契约见 `dsh/projectionStore.ts`）。
   *
   * 它是这个域里所有投影键的权威表：谁的值算数、块里没带的键要不要清，都由它按
   * 「higher seq wins」判。下面的 `todos` / `goal` / `planMode`… 是它**解析后的视图缓存**
   * （唯一写入者是 `dsh/projectionIngest.ts` 派发的效果），读点保持不变。
   */
  readonly projections = new ProjectionStore();

  /** 会话内投影：待办 / 子代理目录 / 后台任务 / 目标条 / 计划模式 / 权限。 */
  todos: TodoView[] = [];
  /**
   * 子代理目录。名字与线格式 / 视图模型**逐字相同**（`subagentEntries`）：
   * 此前宿主侧叫 `subagents`、界面读 `subagentEntries`，跨名桥没有任何保护
   * （见 `docs/audit-summary.md`「7.2 功能 BUG」表 B7）。
   */
  subagentEntries: SubagentView[] = [];
  /**
   * 子代理会话专用：**父会话**的子代理目录快照（兄弟行，含自己）。
   *
   * 进入子代理那一刻从父会话域抄一份，父会话目录后来变化时由控制器再推
   * （见 `controller.syncSubagentContext`）。它只服务界面上那个切换下拉；
   * 父会话域被回收后不再刷新，下拉里兄弟行的状态可能变旧——重新进入父会话
   * 会话时会整体重算（状态从服务端重算的既定口径）。
   */
  subagentSiblings: SubagentView[] = [];
  jobs: JobItemView[] = [];
  goal: ChatState["goal"];
  planMode = false;
  permission: string | undefined;
  /**
   * 本会话运行的 agent 预设（`agentPreset` 投影；空会话换过预设后 header 不再代表它）。
   *
   * 初值由 `newSession` 从 `session/create` 的返回值补上（投影帧要晚一点才到），
   * 之后由投影帧与切换成功的返回值接管。
   */
  agentPreset: string | undefined;

  /**
   * 本会话下一轮将用的模型（`modelSelection` 投影，新会话没有选择时是部署默认）。
   * 不同会话各自独立——`session/selectModel` 按会话生效。
   */
  model: ModelSelectionView | undefined;
  /** UI 切换模型时只记到这里，下次发送前才真正 selectModel（与旧单值同机制）。 */
  pendingModel: ModelSelectionView | undefined;

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
