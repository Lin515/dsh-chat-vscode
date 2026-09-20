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

/**
 * webview 侧状态归约：把宿主的增量帧合并成可渲染的聊天状态。
 *
 * 增量帧（message/delta）只改动单条消息的单个段落，避免每来一个 token 就
 * 重建整棵消息树，这是流式渲染保持流畅的关键。
 */

/** 右侧抽屉当前显示的页面。 */
export type PanelKind = "none" | "history" | "subagents" | "jobs" | "trajectory" | "subagent";

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
  /** 正在查看的子代理对话（只读）。`loading` 为真时抽屉里显示「正在读取…」。 */
  subagent?: { id: string; messages: MessageView[]; loading?: boolean };
  /**
   * 改动文件清单的缓存，键 = `changesSummaryKey(sessionId, seq)`。
   *
   * `null` = Host **明确说没有**这份清单（Host 重启过 / Session 已释放），界面据此
   * 不显示卡片、也不再来问；**键不存在** = 还没问过（卡片渲染时发 `requestChanges`）。
   * 两者必须分开，所以这张表的值类型是 `ChangesSummaryView | null`。
   */
  changesSummaries?: Record<string, ChangesSummaryView | null>;
}

export const initialState: AppState = {
  connection: "connecting",
  // 语言起步值：`navigator.language`（webview 里跟随 VS Code 显示语言，与宿主
  // `readLanguage()` 的 auto 分支同源）。它只撑「首帧快照到来之前」的渲染——
  // 此前是 undefined，词典归一化落英文，自动连接期间整个界面都是英文；宿主
  // 首帧会带上权威值（`dshChat.language` 固定选择优先），到了即覆盖。
  locale: typeof navigator !== "undefined" ? navigator.language : undefined,
  messages: [],
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
  | { type: "ui/openSubagent"; id: string }
  | { type: "ui/dismissNotice" }
  | { type: "ui/setDraft"; text: string };

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
      };
    }

    case "patch":
      return mergeWirePatch(state, action.patch);

    case "message/upsert": {
      // 流式中的助手消息可能没有 changesVersion 语义，直接整条替换
      return { ...state, messages: upsertMessage(state.messages, action.message) };
    }

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
      return {
        ...state,
        fileRefs: { query: action.query, items: action.items, sessions: action.sessions ?? [] },
      };

    case "subagent/transcript":
      return { ...state, subagent: { id: action.id, messages: action.messages, loading: false } };

    case "ui/openSubagent":
      // 点开某个子代理：**先清掉上一次的内容**并置 loading，再等宿主那份快照。
      // 不清的话「先点 A、再点 B」时抽屉会拿 A 的记录充数，看起来像 B 的内容。
      return { ...state, panel: "subagent", subagent: { id: action.id, messages: [], loading: true } };

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

    case "ui/setPanel":
      return { ...state, panel: action.panel };

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
