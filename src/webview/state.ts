import { useCallback, useMemo, useReducer } from "react";
import type { TrajectoryModel } from "../shared/trajectory";
import type {
  ChatState,
  ChangesSummaryView,
  CommandView,
  FileRefView,
  MessageView,
  Segment,
  SessionRefView,
  SessionSummaryView,
  ContextWindowView,
  ContextOccupancyView,
} from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";
import { mergeWirePatch } from "../shared/wire";
import { changesSummaryKey } from "../shared/changesSummary";
import {
  applyObservedFailed,
  applyObservedOpened,
  applyObservedOutput,
  jobObserveStart,
  type JobObserved,
} from "./jobObserve";

/**
 * webview 侧状态归约：把宿主的增量帧合并成可渲染的聊天状态。
 *
 * 增量帧（message/delta）只改动单条消息的单个段落，避免每来一个 token 就
 * 重建整棵消息树，这是流式渲染保持流畅的关键。
 */

/** 右侧抽屉当前显示的页面。 */
export type PanelKind = "none" | "history" | "jobs" | "trajectory";

export interface AppState extends ChatState {
  /** 会话列表（历史抽屉内容）。 */
  sessions: SessionSummaryView[];
  /** 归档会话列表（历史抽屉的归档视图）。 */
  archivedSessions: SessionSummaryView[];
  panel: PanelKind;
  commands: CommandView[];
  fileRefs: { query: string; items: FileRefView[]; sessions: SessionRefView[] };
  /**
   * 轨迹账本（宿主折叠后下发，见 `src/dsh/trajectory.ts`）。
   *
   * **不是**从消息流派生的：官方轨迹是对同一份 durable 事件的**另一套折叠**
   * （系统提示词 / 上下文 / 压缩 / 子工具这些在聊天流里根本不出行），
   * 所以必须由宿主单独推。`undefined` = 还没取过（面板打开时请求）。
   */
  trajectory?: TrajectoryModel;
  /** 最近一次 `request/context` 事件给出的上下文窗口。 */
  contextWindow?: ContextWindowView;
  /** 当前会话的上下文占用（dsh web 客户端 `context-occupancy` 投影的等价输出）。 */
  contextOccupancy?: ContextOccupancyView;
  /**
   * 改动文件清单的缓存，键 = `changesSummaryKey(sessionId, seq)`。
   *
   * `null` = Host **明确说没有**这份清单（Host 重启过 / Session 已释放），界面据此
   * 不显示卡片、也不再来问；**键不存在** = 还没问过（卡片渲染时发 `requestChanges`）。
   * 两者必须分开，所以这张表的值类型是 `ChangesSummaryView | null`。
   */
  changesSummaries?: Record<string, ChangesSummaryView | null>;
  /**
   * 界面自产的「引用到输入框」请求（会话正文右键菜单的「引用」）。
   *
   * 与宿主下发的 `insertRequest`（`insertToken` 那条路）是**同一件事的两个来源**：
   * 那条把宿主给的路径 / 引用 token 插到光标处，这条把选中文字以**引用块**插进去。
   * 两条都按自增 id 去重——只比对内容的话，连续两次引用同一段文字只会生效一次。
   * 它只活在界面侧，所以不放进 `ChatState`。
   */
  quoteRequest?: { id: number; text: string };
  /**
   * 最近一条停止请求的结算（宿主 `jobs/killResult` 帧的落点，后台任务面板消费）。
   *
   * 只活在界面侧（宿主快照 / patch 里没有这个字段），所以不放进 `ChatState`。
   * **每次结算都换新对象**（同一行连续两次失败也是两帧）——面板按引用相等识别
   * 「来了一条新结算」，把状态机推进到 `failed` / 维持 `pending`。
   */
  jobKill?: { jobId: string; ok: boolean };
  /**
   * 后台任务实时输出的累积（键 = 任务 id），只活在界面侧。
   *
   * 条目在**展开时**建、在**收起 / 关面板 / 换会话**时删：删掉才是对的——宿主那边
   * 收起即取消观察流，重新展开会从服务端环里最旧的保留字节重新锚起，留着旧文本
   * 会把同一段输出接两遍。累积口径在 `jobObserve.ts`（纯函数）。
   */
  jobOutputs?: Record<string, JobObserved>;
}

export const initialState: AppState = {
  connection: "connecting",
  // 语言起步值：`navigator.language`（webview 里跟随 VS Code 显示语言，与宿主
  // `readLanguage()` 的 auto 分支同源）。它只撑「首帧快照到来之前」的渲染——
  // 此前是 undefined，词典归一化落英文，自动连接期间整个界面都是英文；宿主
  // 首帧会带上权威值（`dshChat.language` 固定选择优先），到了即覆盖。
  locale: typeof navigator !== "undefined" ? navigator.language : undefined,
  messages: [],
  // 乐观回显起步为空表：宿主首帧快照会带上权威值（见 `shared/chat.ts` 的
  // `pendingMessages`），这里只是「快照还没到」时的空档
  pendingMessages: [],
  running: false,
  queueItems: [],
  attachments: [],
  draft: "",
  models: [],
  todos: [],
  subagentEntries: [],
  jobs: [],
  sessions: [],
  archivedSessions: [],
  panel: "none",
  commands: [],
  fileRefs: { query: "", items: [], sessions: [] },
};

function replaceSegment(message: MessageView, segment: Segment): MessageView {
  const index = message.segments.findIndex((s) => s.id === segment.id);
  if (index < 0) return { ...message, segments: [...message.segments, segment] };
  const segments = message.segments.slice();
  segments[index] = segment;
  return { ...message, segments };
}

function appendDelta(message: MessageView, segmentId: string, delta: string): MessageView {
  const index = message.segments.findIndex((s) => s.id === segmentId);
  if (index < 0) {
    // 段落尚未建立（例如取消了再重来）：按纯文本补一个
    return {
      ...message,
      segments: [...message.segments, { kind: "text", id: segmentId, text: delta, streaming: true }],
    };
  }
  const segment = message.segments[index];
  if (segment.kind !== "text" && segment.kind !== "thinking") return message;
  const segments = message.segments.slice();
  segments[index] = { ...segment, text: segment.text + delta, streaming: true } as Segment;
  return { ...message, segments };
}

function upsertMessage(messages: MessageView[], message: MessageView): MessageView[] {
  const index = messages.findIndex((m) => m.id === message.id);
  if (index < 0) return [...messages, message];
  const next = messages.slice();
  next[index] = message;
  return next;
}

/** 只改动目标消息，保持其余消息引用不变。 */
function mapMessage(
  state: AppState,
  messageId: string,
  update: (message: MessageView) => MessageView,
): AppState {
  const index = state.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages[index] = update(messages[index]);
  return { ...state, messages };
}

export type Action =
  | HostToWebview
  | { type: "ui/setPanel"; panel: PanelKind }
  | { type: "ui/dismissNotice" }
  | { type: "ui/setDraft"; text: string }
  /** 界面自产的「引用到输入框」（右键菜单）：文本已经是当前语言的成品，不走 `@key`。 */
  | { type: "ui/quoteText"; text: string }
  /**
   * 界面自产的轻提示（如「复制图片失败」）。
   *
   * 这条通道原本只有宿主有（`toast` 帧），而复制图片是在界面里做的（见
   * `imageClipboard.ts`），失败时宿主根本不知情。文案由调用方从词典取好，这里存成品。
   */
  | { type: "ui/notice"; level: "info" | "warn" | "error"; text: string }
  /**
   * 展开一行后台任务：铸造这一轮的观察代号并清空旧累积（见 `AppState.jobOutputs`）。
   *
   * 界面自己发而不是等宿主：`watchId` 必须**先**进状态，宿主回带的帧才有号可对
   * （`jobObserve.ts` 的守卫），所以它和 `post({type:"observeJob"})` 是同一个手势里
   * 前后脚的两件事。
   */
  | { type: "ui/jobObserve"; jobId: string; watchId: number }
  /** 收起一行（或关面板）：释放这条观察的累积；重新展开会重新锚起。 */
  | { type: "ui/jobClose"; jobId: string };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "state": {
      // 过线帧里可选字段的「空」是 null（`shared/wire.ts`），合并时折回 undefined
      const merged = mergeWirePatch(state, action.state);
      // 换了会话（含「新建对话」）：整份快照里**没有**轨迹模型（它只在
      // `listTrajectory` 时现折，见 `shared/ipc.ts`），旧账本必须立刻丢掉——
      // 否则轨迹视图会拿上一个会话的记录充数，直到新的一帧回来。
      // 判据要「先前有会话 + id 变了」：首帧从「还没有会话」绑到 s1 时不能清，
      // 那一帧本身就是全量快照（清掉等于把随帧来的账本一起扔了）。
      const switched = state.session !== undefined && merged.session?.id !== state.session.id;
      return {
        ...merged,
        panel: state.panel,
        ...(switched ? { trajectory: undefined } : {}),
        // 清单缓存同理：键里带会话 id，理论上不会串，但换会话后旧会话那些条目再也
        // 用不上（一张会话几十轮就是几十条），跟着一起丢掉
        ...(switched ? { changesSummaries: undefined } : {}),
        // 实时输出的累积也一样：换会话后旧任务的条目再也不会被渲染（面板读的是新
        // 会话的名册），而键是全局唯一的任务 id，留着就是一堆谁也用不上的文本
        ...(switched ? { jobOutputs: undefined } : {}),
      };
    }

    case "patch":
      return mergeWirePatch(state, action.patch);

    case "message/upsert": {
      // 流式中的助手消息可能没有 changesVersion 语义，直接整条替换
      return { ...state, messages: upsertMessage(state.messages, action.message) };
    }

    case "message/remove":
      // 整条消息消失（审批卡结算之后那条只剩空壳的助手消息）。按 id 去掉，找不到就
      // 原样返回：宿主与界面的产物版本不一致时，这一帧不该牵连别的行。
      return {
        ...state,
        messages: state.messages.filter((message) => message.id !== action.messageId),
      };

    case "messages/reset":
      return { ...state, messages: action.messages };

    case "changes/summary": {
      // 只收**当前会话**的清单：切会话瞬间在途的那一帧不能落进新会话的表里
      // （帧本身带 sessionId，就是为这一下）
      if (state.session?.id !== action.sessionId) return state;
      return {
        ...state,
        changesSummaries: {
          ...state.changesSummaries,
          [changesSummaryKey(action.sessionId, action.seq)]: action.summary,
        },
      };
    }

    case "message/append":
      return mapMessage(state, action.messageId, (m) => ({
        ...m,
        segments: [...m.segments, action.segment],
      }));

    case "message/delta":
      return mapMessage(state, action.messageId, (m) =>
        appendDelta(m, action.segmentId, action.delta),
      );

    case "message/segment":
      return mapMessage(state, action.messageId, (m) => replaceSegment(m, action.segment));

    case "sessions":
      return { ...state, sessions: action.sessions };

    case "archivedSessions":
      return { ...state, archivedSessions: action.sessions };

    case "models":
      return { ...state, models: action.groups, model: action.current ?? state.model };

    case "todos":
      return { ...state, todos: action.todos };

    case "subagents/list":
      return { ...state, subagentEntries: action.entries };

    case "jobs/list":
      return { ...state, jobs: action.jobs };

    case "jobs/killResult":
      // 一条停止请求的结算：面板把「请求中」推进到失败 / 等名册收场（jobsKill.ts）。
      // 故意整对象替换（不按 jobId 合并）：连着两次失败的结算也要各推进一次状态机。
      return { ...state, jobKill: { jobId: action.jobId, ok: action.ok } };

    case "jobs/opened":
    case "jobs/output":
    case "jobs/observeFailed": {
      // 实时输出：三个累积口径都是纯函数（`jobObserve.ts`），**拿不到条目或代号
      // 对不上就原样返回**——帧不该让界面上冒出一个没人展开的条目（那是泄漏），
      // 也不该把另一轮观察的字节接进这一轮。
      const entry = state.jobOutputs?.[action.jobId];
      const next =
        action.type === "jobs/opened"
          ? applyObservedOpened(entry, action)
          : action.type === "jobs/output"
            ? applyObservedOutput(entry, action)
            : applyObservedFailed(entry, action);
      if (!next) return state;
      return { ...state, jobOutputs: { ...state.jobOutputs, [action.jobId]: next } };
    }

    case "trajectory": {
      // 宿主发的是一整段 JSON 字符串（不是逐键 patch）：
      // 轨迹模型里 `startedAt: null` / `timeSeconds: null` 是**有意义的空值**，
      // 而宿主→webview 的帧过一遍 JSON.stringify，值为 `undefined` 的键会被整条
      // 丢掉（见 `shared/wire.ts`）。整体过字符串就绕开了这套逐键折回语义。
      let model: TrajectoryModel | undefined;
      try {
        model = JSON.parse(action.json) as TrajectoryModel;
      } catch {
        return state;
      }
      return { ...state, trajectory: model };
    }

    case "commands/list":
      return { ...state, commands: action.commands };

    case "files/list":
      // 只换**文件**那一半：对话候选还在路上（它要扫全部会话日志，慢得多），先把
      // 上一批留在屏上——官方的 `@` 菜单就是 stale-while-revalidate
      // （`ui-input-trigger` 的 `menuReduce`：新一代替换之前，旧条目继续渲染）。
      // 这一帧也是界面认「这是哪一次查询」的锚（见下面的 `files/sessions`）。
      return {
        ...state,
        fileRefs: { ...state.fileRefs, query: action.query, items: action.items },
      };

    case "files/sessions":
      // 属于**别的查询**的对话候选直接丢（敲字快时后到的那一批）：收下就会渲染出
      // 「文件是这一层的、对话是上一层筛出来的」这种混合列表。
      if (action.query !== state.fileRefs.query) return state;
      return {
        ...state,
        fileRefs: { ...state.fileRefs, sessions: action.sessions },
      };

    case "toast": {
      // 每次都给新的 id：同样文案连续两次也要重新计时
      const previous = state.notice?.id ?? 0;
      return {
        ...state,
        notice: { id: previous + 1, level: action.level, text: action.text },
      };
    }

    case "ui/insertText": {
      // 同样用自增 id：连续两次插入同一段文本也要各插一次
      const previous = state.insertRequest?.id ?? 0;
      return { ...state, insertRequest: { id: previous + 1, text: action.text } };
    }

    case "ui/quoteText": {
      // 与 `ui/insertText` 同一套去重口径（见 AppState.quoteRequest）
      const previous = state.quoteRequest?.id ?? 0;
      return { ...state, quoteRequest: { id: previous + 1, text: action.text } };
    }

    case "ui/notice": {
      // 与宿主的 `toast` 帧同一个落点（`notice`），id 同样自增
      const previous = state.notice?.id ?? 0;
      return { ...state, notice: { id: previous + 1, level: action.level, text: action.text } };
    }

    case "ui/setPanel":
      return { ...state, panel: action.panel };

    case "ui/jobObserve": {
      // 展开：**覆盖**同 id 的旧条目（`jobObserveStart` 是空的）——上一轮的文本必须
      // 丢掉，否则新流从环头重发的字节会接在旧尾巴后面，同一段输出出现两遍
      return {
        ...state,
        jobOutputs: { ...state.jobOutputs, [action.jobId]: jobObserveStart(action.watchId) },
      };
    }

    case "ui/jobClose": {
      if (!state.jobOutputs || !(action.jobId in state.jobOutputs)) return state;
      const jobOutputs = { ...state.jobOutputs };
      delete jobOutputs[action.jobId];
      return { ...state, jobOutputs };
    }

    case "ui/openPanel":
      return { ...state, panel: action.panel as PanelKind };

    case "ui/dismissNotice":
      return { ...state, notice: undefined };

    case "ui/setDraft":
      return { ...state, draft: action.text };

    default:
      return state;
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stableDispatch = useCallback(dispatch, [dispatch]);
  return useMemo(() => ({ state, dispatch: stableDispatch }), [state, stableDispatch]);
}
