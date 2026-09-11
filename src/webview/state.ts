import { useCallback, useMemo, useReducer } from "react";
import type { ToolCallView } from "../shared/chat";
import type {
  ChatState,
  CommandView,
  FileRefView,
  MessageView,
  Segment,
  SessionSummaryView,
  SettingsSectionView,
  SubagentView,
  ContextWindowView,
  ContextOccupancyView,
} from "../shared/chat";
import type { HostToWebview } from "../shared/ipc";

/**
 * webview 侧状态归约：把宿主的增量帧合并成可渲染的聊天状态。
 *
 * 增量帧（message/delta）只改动单条消息的单个段落，避免每来一个 token 就
 * 重建整棵消息树，这是流式渲染保持流畅的关键。
 */

/** 右侧抽屉当前显示的页面。 */
export type PanelKind = "none" | "history" | "subagents" | "jobs" | "trajectory" | "settings" | "subagent";

export interface AppState extends ChatState {
  /** 会话列表（历史抽屉内容）。 */
  sessions: SessionSummaryView[];
  panel: PanelKind;
  commands: CommandView[];
  fileRefs: { query: string; items: FileRefView[] };
  subagentEntries: SubagentView[];
  /** 轨迹：本会话全部工具调用（从消息流派生，供轨迹面板渲染）。 */
  trajectory: ToolCallView[];
  settingsSections: SettingsSectionView[];
  settingsWritable: boolean;
  settingsLoaded: boolean;
  /** 最近一次 `request/context` 事件给出的上下文窗口。 */
  contextWindow?: ContextWindowView;
  /** 当前会话的上下文占用（dsh web 客户端 `context-occupancy` 投影的等价输出）。 */
  contextOccupancy?: ContextOccupancyView;
  /** 正在查看的子代理对话。 */
  subagent?: { id: string; messages: MessageView[] };
}

export const initialState: AppState = {
  connection: "connecting",
  messages: [],
  running: false,
  queue: 0,
  attachments: [],
  draft: "",
  models: [],
  todos: [],
  subagents: [],
  jobs: [],
  sessions: [],
  panel: "none",
  commands: [],
  fileRefs: { query: "", items: [] },
  subagentEntries: [],
  trajectory: [],
  settingsSections: [],
  settingsWritable: false,
  settingsLoaded: false,
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
  | { type: "ui/setDraft"; text: string };

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "state":
      return { ...state, ...action.state, panel: state.panel };

    case "patch":
      return { ...state, ...action.patch };

    case "message/upsert": {
      // 流式中的助手消息可能没有 changesVersion 语义，直接整条替换
      return { ...state, messages: upsertMessage(state.messages, action.message) };
    }

    case "message/remove":
      return { ...state, messages: state.messages.filter((m) => m.id !== action.messageId) };

    case "messages/reset":
      return { ...state, messages: action.messages };

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

    case "models":
      return { ...state, models: action.groups, model: action.current ?? state.model };

    case "todos":
      return { ...state, todos: action.todos };

    case "subagents/list":
      return { ...state, subagentEntries: action.entries };

    case "jobs/list":
      return { ...state, jobs: action.jobs };

    case "commands/list":
      return { ...state, commands: action.commands };

    case "files/list":
      return { ...state, fileRefs: { query: action.query, items: action.items } };

    case "settings/describe":
      return {
        ...state,
        settingsSections: action.sections,
        settingsWritable: action.writable,
        settingsLoaded: true,
      };

    case "subagent/transcript":
      return { ...state, subagent: { id: action.id, messages: action.messages } };

    case "toast":
      return { ...state, error: action.level === "error" ? action.text : state.error };

    case "ui/setPanel":
      return { ...state, panel: action.panel };

    case "ui/setDraft":
      return { ...state, draft: action.text };

    default:
      return state;
  }
}

export function useAppState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stableDispatch = useCallback(dispatch, [dispatch]);
  // 轨迹直接从消息流派生（消息已是权威状态，无需宿主单独推送）
  const trajectory = useMemo(
    () =>
      state.messages
        .flatMap((message) =>
          message.segments.flatMap((segment) =>
            segment.kind === "tool" ? [segment.tool] : [],
          ),
        )
        .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    [state.messages],
  );
  return useMemo(
    () => ({ state: { ...state, trajectory }, dispatch: stableDispatch }),
    [state, trajectory, stableDispatch],
  );
}
