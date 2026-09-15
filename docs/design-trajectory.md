# 轨迹面板对齐官方 DSH Web 的实现规格

> **实现状态（2026-09-14）**：本规格的 S1–S2、S5–S8 已落地，见
> `src/shared/trajectory.ts`（类型 + 时间线折叠）、`src/dsh/trajectory.ts`（账本折叠）、
> `src/webview/components/Trajectory.tsx`（工具栏 / 账本 / 时间线 / 检查器）、
> `src/webview/trajectoryTexts.ts`（官方文案）、`scripts/trajectory.test.ts`（断言）。
> 时间线的滚轮缩放与右键平移、检查器拖宽与窄屏抽屉、运行中的占位行也都做了。
> **视图形态与官方一致**：轨迹是**整页视图**（`App` 里会话页整块让位、输入区留在
> 原地），不是盖在会话上的抽屉——官方也是把视图注册进 `conversation.view` 槽后整块
> 换掉（`dsh-client-ui-conversation lib/client.js:15122-15129`）。所以这里没有标题栏
> 与关闭按钮，进出靠头部那颗「轨迹 ⇄ 会话」图标。时间线的「加载更早」是**左端**的
> `…`（官方 `earlierHistory` 的位置：贴绘图区左缘、向右渐隐），
> 不是排在绘图区右侧；标题栏里那个重复入口已经删掉。
> **取历史的链路与官方同一条**：轨迹的「加载更早」不发自己的请求，它走会话页那条
> `loadMore`（宿主一次取到底），宿主把 `historyLoading` 落回 false 之后由界面自己
> 重取账本（`App` 里那个 true→false 收尾的 effect）；账本最上面另有官方那行
> `historyLoadRow`（取的过程中显示 spinner）。检查器的「概述」页**直接摊开后几张卡片**
> （官方 `overviewSections`）：工具/子工具 = 参数 / 结果 / Schema / 计时，markdown
> 记录 = 预览，压缩记录 = 摘要正文；分节标题可点，点了切到对应页签。
> **`user/message` 的线格式别读错**：事件 `data` **就是** `UserMessage`
> （`{id, role, content, source}`），不是 `{message}` 包一层（包一层的是
> `system/message` / `tool/result`）。按 `data.message` 读会让**用户与上下文记录整类
> 消失**（2026-09-14 踩过，280 份真实日志里 2443 条 user/message 全无包装）。
> 记录配色逐条对齐官方 `kindTag`：context 绿、message（助手）紫、user 蓝、
> tool/subtool 琥珀（子工具更淡）、system/compacted 中性。
> **仍未做**：流式正文本身（只出空占位行）、系统提示词面替换的完整语义（S3/S4 的
> 边角）、检查器里的 `hierarchy` 跳转 / `usage` 会话累计 / `options` 页签、
> 从对话跳进轨迹（官方 `viewRequest.focus`）、请求边界小标记、
> `session.loadOlder` 的本地节点窗口（我们现在一次取全部历史）。
> 差异清单也写在 `src/dsh/trajectory.ts` 的文件头。
> **本文件其余部分是**当初面向实现的完整规格与逐行证据，动相关代码前先读它。

> 依据：`dsh-client-ui-trajectory` 0.1.5-rc.1 的安装产物（`.d.ts` 契约 + `lib/client.js` 实现逐行核对）。
> 文中官方代码位置一律写成 `包名 lib/xxx.js:行号`；本仓库代码写成 `src/...:行号`。
> 本文只描述**事实与照抄口径**，不下猜测性结论；不确定的部分集中在末尾《证据不足 / 无法确认》。

---

## 0. 核心结论

**官方的「轨迹」没有任何服务端 RPC、也没有任何投影。它是客户端对同一份 durable 会话事件窗口做的第二次独立折叠。**

证据：

1. 遍历 `@deepseek-ai` 全部 `.d.ts` 搜 `'trajectory/`：**零命中**。`dsh-api-session-controller lib/typert.remote-client.d.ts:14-31` 枚举的 `session/*` 远程方法里没有 `trajectory*`。
2. `dsh-client-ui-trajectory lib/client.js` 全文内 `fetch(` / `WebSocket` / `/api/` / `remote.` **零命中**；该包唯一触碰网络的面是 `session.loadOlder()`（`dsh-client-ui-trajectory lib/client.js:8240-8244`）。
3. 数据入口是会话本地的**视图目标（view target）**，不是 RPC：
   - `dsh-client-ui-trajectory lib/client.js:8196-8207` —— `ctx.uiConversation.binding(binding).target("trajectory")` → `{getSnapshot, subscribe}`；
   - `dsh-client-ui-trajectory lib/client.js:8220-8223` —— `ctx.uiSession.provide({hooks:["trajectory"], ...})`；
   - `dsh-client-ui-trajectory lib/client.js:8224-8251` —— 注册到 `conversation.view` 槽，`id:"trajectory"`、`order:10`。
4. 折叠逻辑由 5 个注册函数挂上去的 **8 个 `ConversationNodeDefinition`** 承担（`dsh-client-ui-trajectory lib/client.js:8214-8219`），每个 definition 用 `ctx.uiConversation.events.register(...)` 订阅 durable 事件、用 `buildViewNode()` 产出贡献。

**对本扩展的直接结论**：官方轨迹展示的全部内容都来自我们**已经在收**的两条流——
`session/follow`（事件窗口 + 逐 token 帧）与 `session/page`（往前翻页）。
本扩展 `src/dsh/protocol.ts:173-206` 的 `RENDERED_EVENT_TYPES` 里已经包含 `request/header`、`session/end-seed`、`compaction/start|summary|end`；`tool/ptc-dispatch*` 在 `SILENT_EVENT_TYPES`（`src/dsh/protocol.ts:250-251`）。它们目前落到 `src/dsh/adapter.ts:1100` 的 `default:` 分支被**知情静默**丢弃。

所以差距在**折叠**与**字段保留**，**不在传输**：不需要任何新的服务端调用。

数据流全貌：

```
session/follow（含 session/page prepend）
        │  durable 事件窗口（SessionEvent）+ 客户端瞬时帧（assistant/live-chunk 等价物）
        ▼
ctx.uiConversation 的 ConversationNodeAssembler
        │  按注册的 ConversationNodeDefinition 折成 Context
        ▼
各 Definition 的 buildViewNode() → TrajectoryConversationViewNode（带 anchorSeq / location / data）
        ▼
TrajectorySnapshotBuilder.snapshot() → TrajectorySnapshot
        ▼
TrajectoryView → deriveTrajectoryLayout() → TrajectoryTurnModel[]（账本）
              → deriveTrajectoryTimeline()（时间线）
              → TrajectoryTable 的本地检查器（详情页签）
```

---

## A. 数据从哪来

### A.1 调用点（确切位置）

`dsh-client-ui-trajectory lib/client.js`：

- `:8182-8188` `inject = ["slots","sessions","uiSession","uiConversation","locale"]`
- `:8194-8251` `apply(ctx)`：
  - `:8196-8207` `trajectorySource(binding)`：`ctx.uiConversation.binding(binding).target("trajectory")`
  - `:8208-8211` `ctx.locale.register(NS, {zh, en})`；`:8212` `const t = ctx.locale.bind(NS)`
  - `:8213` `const duration = createTrajectoryDurationStore()`
  - `:8214-8218` 五个注册函数：
    `registerTrajectoryMessageDefinitions` / `registerTrajectoryRequestHeaderDefinition` /
    `registerTrajectoryAssistantDefinition` / `registerTrajectoryToolDefinition` /
    `registerTrajectoryCompactionDefinitions`
  - `:8219` `registerTrajectoryConversationView(ctx)`
  - `:8220-8223` `ctx.uiSession.provide({hooks:["trajectory"], resolve: binding => ({hooks:{trajectory: trajectorySource(binding)}})})`
  - `:8224-8251` `ctx.slots.register({name:"conversation.view", id:"trajectory", order:10, locale:NS,
    label:()=>t("view.trajectory"), children:{"conversation.trajectory.images":{kind:"single",scope:"session"}},
    inject:(sessionId)=>…}, TrajectoryView)`；inject 内 `:8234-8249` 拿 `ctx.sessions.binding(sessionId)?.session`、
    `trajectory.getSnapshot()`、`session.loadOlder()`、`ctx.uiConversation.imageUrl/peekImageUrl`

Definition 的注册点（全部是 `ctx.uiConversation.events.register(...)`）：

| 注册函数 | 行 |
|---|---|
| assistant-step + turn-end | `dsh-client-ui-trajectory lib/client.js:926-929` |
| compaction + session-end | `dsh-client-ui-trajectory lib/client.js:1041-1044` |
| inbox-next-step + input-message | `dsh-client-ui-trajectory lib/client.js:1166-1169` |
| system-message + request-header | `dsh-client-ui-trajectory lib/client.js:1298-1301` |
| tool-call | `dsh-client-ui-trajectory lib/client.js:1773-1775` |
| view target（`trajectory`） | `dsh-client-ui-trajectory lib/client.js:1531-1533` |

### A.2 契约逐字

#### `dsh-client-ui-trajectory lib/types/client/trajectory-record.d.ts`

```ts
/** Closed set of trajectory record kinds. */
export type TrajectoryCellKind = 'system' | 'user' | 'context' | 'compacted' | 'message' | 'tool' | 'subtool';

/** Recorded inputs needed to derive assistant TTFT and decode throughput. */
export interface AssistantMetricDetail {
    timingRecorded: boolean;
    stepStartTime: number | null;
    firstTokenTime: number | null;
    completedTime: number | null;
    usageProvided: boolean;
    outputTokens: number | null;
}

/** One source content block preserved in model order for the details panel. */
export interface TrajectorySourceBlock {
    type: string;
    content: string;
    attachment?: ImageAttachmentRef;
    callId?: string;
    toolName?: string;
}

/** Data and optional presentation attributes for one trajectory record. */
export interface TrajectoryCellProps extends HTMLAttributes<HTMLDivElement> {
    /** 1-based record index shown as `#N`. */
    index: number;
    /** Projection-stable identity when no single source event owns the record lifecycle. */
    recordId?: string;
    kind: TrajectoryCellKind;
    /** Non-Markdown summary or prefix; CSS ellipsis when it overflows. */
    text: string;
    /** Raw Markdown source converted into the single-line summary at its consumer. */
    previewMarkdown?: string;
    /** Whether this user record opens a new model turn. */
    opensTurn?: boolean;
    /** Source session-event seq for cross-record navigation. */
    sourceSeq?: number;
    /** Producer role and name from a user-role message or context injection. */
    messageSource?: unknown;
    /** Producer-owned model-hidden metadata carried beside the message source. */
    /** A separator-only anchor for an auxiliary request with no visible record. */
    requestOnly?: boolean;
    /** Full request/message content for the details panel. */
    inputDetail?: string;
    /** Complete system-prompt/tool-catalog state introduced by a SYSTEM record. */
    promptDetail?: ConversationPromptSnapshot;
    /** Known prompt text without a loaded request config or tool catalog. */
    systemPromptDetail?: string;
    /** System-prompt/tool-catalog state replaced by a SYSTEM update. */
    previousPromptDetail?: ConversationPromptSnapshot;
    /** Full assistant/tool result content for the details panel. */
    outputDetail?: string;
    /** Full assistant reasoning content for the details panel. */
    thinkingDetail?: string;
    /** Original message blocks in source order for the details panel. */
    sourceBlocks?: readonly TrajectorySourceBlock[];
    /** Original tool result blocks in source order for the details panel. */
    outputBlocks?: readonly TrajectorySourceBlock[];
    /** Call-time model-visible tool schema for the details panel. */
    schemaDetail?: string;
    /** Assistant-only timing and token facts for the details panel. */
    assistantMetrics?: AssistantMetricDetail;
    /** Tool-only result summary paired with the call in the same record. */
    result?: string;
    /** Raw Markdown source converted into the tool-result summary at its consumer. */
    resultPreviewMarkdown?: string;
    /** Tool call id used to link message source blocks to tool records. */
    callId?: string;
    /** Tool-only result failure state. */
    isError?: boolean;
    /** Own duration in seconds, or `null` when no duration is known. */
    timeSeconds: number | null;
    /** Unix epoch milliseconds when this operation actually started, when known. */
    startedAt?: number | null;
    /** Message-only prompt token count. */
    input?: number;
    /** Message-only input tokens served from a provider cache. */
    cacheRead?: number;
    /** Message-only input tokens written into a provider cache. */
    cacheWrite?: number;
    /** Message-only completion token count. */
    output?: number;
    /** Message-only reasoning token count. */
    think?: number;
    /** Whether the legacy standalone cell renders its selection treatment. */
    selected?: boolean;
}

/**
 * Resolve the identity that survives prepending older projected records.
 * @param cell - Projected trajectory record.
 * @returns Stable identity from the owning event or tool call, with a fixture fallback.
 */
export declare function trajectoryRecordId(cell: TrajectoryCellProps): string;

/**
 * Format a duration in milliseconds with thousands separators.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export declare function formatDurationMillis(milliseconds: number | null, t: TrajectoryTranslate): string;

/**
 * Format an elapsed duration given in seconds as a millisecond label.
 * @returns `—` when unknown, otherwise an integer-millisecond label.
 */
export declare function formatElapsedSeconds(seconds: number | null, t: TrajectoryTranslate): string;
```

#### `dsh-client-ui-trajectory lib/types/client/trajectory-contract.d.ts`

```ts
/** Request-header facts retained by the Trajectory target. */
export interface TrajectoryRequestHeaderState {
    readonly seq: number;
    readonly time: number;
    readonly prompt: ConversationPromptSnapshot;
    readonly change?: RequestPromptChange;
    readonly location: ConversationLocation;
}

/** One independently assembled contribution to the legacy Trajectory ledger. */
export type TrajectoryContribution = {
    readonly kind: 'system-prompt';
    readonly prompt: SystemPromptNode;
} | {
    readonly kind: 'node';
    readonly node: ConversationNode;
} | {
    readonly kind: 'assistant';
    readonly node?: AssistantMessageNode;
    readonly partial: PartialAssistant | null;
    readonly request?: Extract<RequestView, {
        purpose: 'assistant';
    }>;
} | {
    readonly kind: 'tool';
    readonly root: ToolCallBlock;
} | {
    readonly kind: 'request-header';
    readonly header: TrajectoryRequestHeaderState;
} | {
    readonly kind: 'compaction';
    readonly request: Extract<RequestView, {
        purpose: 'compaction';
    }>;
} | {
    readonly kind: 'session-end';
    readonly seq: number;
    readonly time: number;
} | {
    readonly kind: 'turn-end';
    readonly turn: number;
    readonly time: number;
    readonly error?: string;
    readonly errorCode?: string;
};

/** Target envelope consumed by the Trajectory snapshot builder. */
export interface TrajectoryConversationViewNode extends ConversationViewNode {
    readonly target: 'trajectory';
    readonly anchorSeq: number;
    readonly location: ConversationLocation;
    readonly data: TrajectoryContribution;
}

/** Stage-oriented Trajectory data assembled from registered business Contexts. */
export interface TrajectorySnapshot {
    /** Complete loaded prompt text whose request header is outside the window. */
    readonly systemPrompts?: readonly SystemPromptNode[];
    readonly eventNodes: readonly ConversationNode[];
    readonly eventLocations: ReadonlyMap<number, ConversationLocation>;
    readonly requests: readonly RequestView[];
    readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>;
    readonly partial: PartialAssistant | null;
    readonly runningCalls: readonly RunningToolCall[];
}

/** Selector hook over the current Conversation binding's Trajectory target. */
export type UseTrajectory = SnapshotSelectorHook<TrajectorySnapshot>;

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
    interface ConversationViewSnapshotMap {
        /** Independently assembled data consumed by the Trajectory view. */
        trajectory: TrajectorySnapshot;
    }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface SessionStandardProps {
        useTrajectory: UseTrajectory;
    }
    interface SlotMap {
        /**
         * Renderer for one group of durable record images in the Trajectory
         * ledger. The owner supplies image references, an authorized loader, and
         * alignment. A registration replaces the shipped gallery; without one,
         * images are omitted.
         */
        'conversation.trajectory.images': {
            kind: 'single';
            scope: 'session';
            owner: MessageImagesOwnerProps;
        };
    }
}
```

#### `dsh-client-ui-trajectory lib/types/client/TrajectoryTable.d.ts`（props 与请求编号）

```ts
/** Props for the trajectory ledger. */
export interface TrajectoryTableProps {
    t: TrajectoryTranslate;
    /** Slot-backed durable image renderer shared with the Chat gallery. */
    renderImages: RenderMessageImages;
    /** Session-global request numbers for the request groups visible in this context. */
    requestNumbers?: readonly TrajectoryRequestNumber[];
    /** Grouped records in display order. */
    turns: readonly TrajectoryTurnModel[];
    /** In-flight cells whose content replaces the matching structural record index. */
    streamingCells?: readonly TrajectoryCellProps[];
    /** Record indexes emphasized by the active timeline focus. */
    timelineFocusIndexes?: ReadonlySet<number> | null;
    /** Record indexes retained by the active live search, or null without a query. */
    searchMatchIndexes?: ReadonlySet<number> | null;
    onSelectedIndexChange?: (index: number | null) => void;
    onRecordSelect?: (index: number) => void;
    recordSelection?: { readonly index: number } | null;
    recordFocus?: { readonly index: number } | null;
    /** Whether the initial history tail is still loading. */
    historyLoading?: boolean;
    /** Whether one older history page request is pending anywhere. */
    olderHistoryLoading?: boolean;
    /** First loaded raw event, used to preserve scroll position after prepending a page. */
    historyStartSeq?: number | undefined;
    /** Whether one older history page can be requested. */
    hasOlderRecords?: boolean;
    /** Load one older history page. */
    onLoadOlder?: () => Promise<boolean>;
    onClearSelection?: () => void;
    /** Turn ids whose rows after the first are folded into a summary. */
    collapsedTurns: ReadonlySet<number>;
    onToggleTurn: (turn: number) => void;
    /** Stable Assistant record ids whose tool calls are folded. */
    collapsedAssistants: ReadonlySet<string>;
    onToggleAssistant: (id: string) => void;
    /** One-shot cross-view inspect: open and scroll to this call's record. */
    inspectCallId?: string | null;
    onInspectApplied?: (() => void) | undefined;
}

/** Request-inspector fields shared by ordinary generation and compaction. */
interface TrajectoryRequestNumberBase {
    group: string;
    number: number;
    status?: 'complete' | 'running' | 'error';
    startedAt?: number;
    completedAt?: number | null;
    error?: string;
    errorCode?: string;
    retry?: number;
    maxRetries?: number;
    retryDelayMs?: number;
    resultSeq?: number;
    provider?: string;
    model?: string;
    requestConfig?: AssistantRequestConfig;
    usage?: TrajectoryUsage;
    cumulativeUsage?: TrajectoryUsage;
}

/** One purpose-discriminated request identity paired with its session-global number. */
export type TrajectoryRequestNumber = TrajectoryRequestNumberBase & ({
    purpose?: 'assistant';
    /** Request anchor event sequence; absent for the currently streaming request. */
    seq?: number;
    turn: number;
    step: number;
} | {
    purpose: 'compaction';
    /** Request anchor event sequence and stable compaction identity. */
    seq: number;
    turn: number | null;
    step: 0;
});

/** Disjoint provider token buckets for one request or a session prefix. */
export interface TrajectoryUsage {
    input?: number;
    cacheRead?: number;
    cacheWrite?: number;
    output?: number;
    reasoning?: number;
}
```

#### `dsh-client-ui-trajectory lib/types/client/layout.d.ts` / `timeline.d.ts`

```ts
/** One Message or Step group inside a turn. */
export interface TrajectoryGroupModel {
    title: string;
    description?: string;
    cells: readonly TrajectoryCellProps[];
}
/** One sticky turn, or a standalone compaction section between turns. */
export interface TrajectoryTurnModel {
    turn: number | null;
    groups: readonly TrajectoryGroupModel[];
}
/** Snapshot slice the trajectory view folds. */
export interface TrajectoryLayoutInput {
    systemPrompts?: TrajectorySnapshot['systemPrompts'];
    nodes: TrajectorySnapshot['eventNodes'];
    eventLocations?: ReadonlyMap<number, ConversationLocation>;
    partial: TrajectorySnapshot['partial'];
    runningCalls: TrajectorySnapshot['runningCalls'];
    requests?: readonly RequestView[];
    callSchemas?: RequestInspectionSnapshot['callSchemas'];
}
export declare function deriveTrajectoryLayout(input: TrajectoryLayoutInput, t: TrajectoryTranslate): readonly TrajectoryTurnModel[];
export declare function appendTrajectoryPartialLayout(turns: readonly TrajectoryTurnModel[], partial: TrajectorySnapshot['partial'], lastIndex: number, t: TrajectoryTranslate): readonly TrajectoryTurnModel[];
```

```ts
/** Horizontal projection used by the trajectory timeline. */
export type TrajectoryTimelineMode = 'sequence' | 'duration' | 'time' | 'actual';
/** Inclusive selection in the active timeline projection's domain. */
export interface TrajectoryTimeRange { start: number; end: number; }
/** One ledger record projected into the active timeline domain. */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
    index: number;
    isError: boolean;
    kind: TrajectoryCellKind;
    label: string;
    lane: number;
}
/** One turn boundary in the active timeline domain. */
export interface TrajectoryTimelineTurnBoundary { turn: number; time: number; }
/** Full-domain model used by the overview. */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
    spans: readonly TrajectoryTimelineSpan[];
    turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}
export declare function formatTimelineOffset(milliseconds: number, t: TrajectoryTranslate): string;
export declare function deriveTrajectoryTimeline(turns: readonly TrajectoryTurnModel[], mode?: TrajectoryTimelineMode): TrajectoryTimelineModel | null;
export declare function trajectoryTimelineFocusIndexes(turns: readonly TrajectoryTurnModel[], range: TrajectoryTimeRange, mode?: TrajectoryTimelineMode): ReadonlySet<number>;
```

#### `dsh-client-ui-trajectory lib/types/client/TrajectoryView.d.ts`（注入面）

```ts
/** Session-bound controls not already supplied by the conversation view slot. */
export interface TrajectoryViewInjected {
    hooks: { duration: SnapshotStore<boolean>; };
    loadOlder: () => Promise<boolean>;
    loadImage: MessageImageLoader;
    setActualDuration: (actualDuration: boolean) => void;
}
export declare function TrajectoryView({ useSession, useTrajectory, useDuration, loadOlder, loadImage, setActualDuration, viewRequest, completeViewRequest, renderSlot, t }: …): JSX.Element;
```

#### 外部配套契约（`dsh-client-ui-conversation`、`dsh-api-session-controller`、`dsh-session`）

- `SystemPromptNode`（`dsh-client-ui-conversation lib/types/client/contract/request-inspection.d.ts:23-40`）：
  `{seq, time, turn, step, text, update}`；`text` 为空表示「没有系统提示词」；
  `update:true` = 「在已加载的 system 节点之后追加的、模型在该位置读到的历史内更新」。
- `ConversationPromptSnapshot`（同文件 `:10-21`）：`{config: AssistantRequestConfig, system: string, tools: readonly ToolSchema[]}`；
  `system` 为空表示「该请求没有系统提示词，或节点在已加载窗口之外」。
- `RequestPromptChange`（同文件 `:42-55`）：`{seq, time, kind:'initial'|'system'|'tools'|'system-and-tools', previous?: ConversationPromptSnapshot}`。
- `AssistantRequestConfig`（`dsh-client-ui-conversation lib/types/client/contract/records.d.ts:10-19`）：
  `{provider, model, purpose?, thinking?, reasoningEffort?, temperature?, maxTokens?, stop?}`。
- `RequestView`（`dsh-client-ui-conversation lib/types/client/contract/request-inspection.d.ts:125`）=
  `AssistantRequestView{purpose:'assistant', turn, step, prompt?, promptChange?, retry?, maxRetries?, retryDelayMs?, …}`
  | `CompactionRequestView{purpose:'compaction', turn:number|null, step:0, replacementSeq?, summary?, rawOutput?, …}`；
  共同基类 `RequestViewBase{startSeq, startedAt, completedAt:number|null, status:'running'|'complete'|'error', error?, errorCode?, provenance?, requestConfig?, usage?, resultSeq?}`（`:80-94`）。
- `ConversationNode`（`dsh-client-ui-conversation lib/types/client/contract/records.d.ts:249`）=
  `UserMessageNode | AssistantMessageNode | SteeringMessageNode | ContextMessageNode | ModelRetryNode | TurnErrorNode | TurnMaxTokensNode | ToolResultNode | CommandNode | CompactionSummaryNode | UnknownSurfaceNode`。
- `RunningToolCall`（同文件 `:250-263`）：`{callId, parentCallId?, name, argsRaw, turn, step, time, subCalls}`；
  `ToolResultNode`（`:151-175`）：`{kind:'tool-result', seq, time, callId, parentCallId?, call:{name,argsRaw}|null, callTime:number|null, content, isError, error?:{name,code}, meta?, subCalls}`。
- `PartialAssistant`（`:267-271`）：`{turn, step, blocks}`；
  `AssistantTiming`（`:54-61`）：`{stepStartTime:number|null, firstTokenTime:number|null, completedTime:number}`。
- 客户端**合成事件**（`dsh-api-session-controller lib/types/client/contract/events.d.ts`）：
  `AssistantLiveChunkEvent = {type:'assistant/live-chunk', seq, time, data:{attemptId, turn, step, chunk: StreamChunk}}`（`:6-16`）；
  `SessionEventLike = SessionEvent | AssistantLiveChunkEvent`（`:18`）；
  窗口条目 `SessionEventLikeEntry = {type:'event', event} | {type:'transient', event}`（`:20-26`）；
  `SessionAssistantSettlementEntry = {type:'event', event: SessionEvent<'assistant/message'> | SessionEvent<'assistant/attempt'>}`（`:31-34`）。
- `session.loadOlder()` 契约（`dsh-api-session-controller lib/types/client/contract/session.d.ts:120-124`）。
- `request/header` 事件载荷（`dsh-session lib/types/types.d.ts:366-371`）：`{header: EpochHeader, reason: RequestHeaderReason, startsSeries?: true}`；
  `EpochHeader`（`:208-215`）：`{config: LlmCallConfig, adapterDefaults?, tools?: ToolSchema[]}`；
  `system/message`（`:294-298`）：`{turn, step, message: SystemMessage}`；
  `session/end-seed`（`:401-403`）：`{inherited?: true}`。

### A.3 各 definition 贡献什么

`dsh-client-ui-trajectory lib/client.js`：

| definition kind | 行 | match 的事件 | 产出的 contribution |
|---|---|---|---|
| `trajectory-assistant-step` | `:824-890` | `step/start`(start)；`assistant/live-chunk` / `assistant/message` / `llm/retry` / `step/end`(update) | `{kind:'assistant', node?, partial, request?}` |
| `trajectory-turn-end` | `:891-920` | `turn/end` | `{kind:'turn-end', turn, time, error?, errorCode?}` |
| `trajectory-compaction` | `:976-1017` | `compaction/start`(start)；`compaction/summary` / `compaction/end` / `user/message`(source.kind='plugin' && plugin='compact' && 有 `compactionId`) (update) | `{kind:'compaction', request}` |
| `trajectory-session-end` | `:1018-1035` | `session/end-seed` | `{kind:'session-end', seq, time}` |
| `trajectory-inbox-next-step` | `:1105-1120` | `agent/inbox/spliced`(target='next-step') | 无 `target`（纯状态；用来把 `user/message` 分类成 user / steering） |
| `trajectory-input-message` | `:1121-1160` | `user/message` | `{kind:'node', node}`，`node.kind ∈ user`(`:1124-1153`) / `steering`(`:1140-1146`) / `context`(`:1131-1139`) |
| `trajectory-system-message` | `:1184-1253` | `system/message`，或 `"surfaceOp" in event && event.surfaceOp !== 'append'` | `{kind:'request-header'}` 或 `{kind:'system-prompt', prompt}` |
| `trajectory-request-header` | `:1260-1292` | `request/header` | `{kind:'request-header', header}` |
| `trajectory-tool-call` | `:1715-1767` | `tool/call`(start)；`tool/result`；`tool/ptc-dispatch-start`；`tool/ptc-dispatch` | `{kind:'tool', root}` |

`TrajectoryCellKind` 的**判据**（`layout.js` 里逐个 cell 赋值，不是枚举本身）：
`system` `:7027`、`compacted` `:7046`、`user` `:7079`（`:7093` 的 steering 也归 `user`）、
`message` `:7009`（requestOnly）/ `:7340`（assistant）、`context` `:7117`、
`tool` `:7139` / `:7185` / `:7377`、`subtool` `:7574`。

### A.4 排序与合并规则

**排序（两层）**

1. 贡献入账前：`dsh-client-ui-trajectory lib/client.js:1515-1519` `rebuildContributions()`
   ```js
   this.contributions = [...this.nodes.values()]
     .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key));
   ```
   `anchorSeq` 由每个 definition 经 `trajectoryNode(context, anchorSeq, data)` 给出（`:414-424`）。
2. 折成账本时 `layoutEntryOrder`（`:6868-6870`）：
   **`kind==='system' && change.kind==='initial'` 强制为 `-Infinity`**（初始系统提示词永远排最前），其余按 `seq`。
3. 输出排序：`requests.sort((l,r)=>l.startSeq-r.startSeq)` `:1501`；`finalized.sort((l,r)=>l.seq-r.seq)` `:1504`；
   turns 按 `firstCellIndex` 升序 `:7209`；`turn===null` 的独立压缩段先追加到末尾再一起排序。
4. prologue 特例：**turn 0 的分组整体并进 turn 1**（`:7200-7207`）。

**合并（`TrajectorySnapshotBuilder.snapshot()`，`dsh-client-ui-trajectory lib/client.js:1424-1514`）**

- `request-header` → 只更新 `previousHeader` / `previousTools`，并按 `turn\0step` 建 `headersByStep` 表（`:1425-1435`）；
  **自身不产生事件行**。
- `system-prompt` → 进 `systemPrompts`，但被 `representedPrompts`（= 带 `change` 的 header 的 `change.seq`，`:1436`）
  代表过的**不重复收**（`:1451-1454`）。
- `node` → `finalized.push` + `eventLocations.set(seq, location)`（`:1460-1463`）。
- `assistant` → `node` 进 finalized 并 `withRequestConfig` 补 `requestConfig`；`partial` 覆盖式赋值（**只保留最后一个**）；
  `request` 经 `applyHeader` 补 `prompt` / `requestConfig` / `promptChange`（`:1465-1475`，
  `consumedPromptChanges` 保证同一次 change 只挂一次）。
- `tool` → 带 `kind` 的（已结算 `ToolResultNode`）进 finalized；不带 `kind` 的（`RunningToolCall`）进 `runningCalls`；
  并按 `previousHeader.seq < anchorSeq` 捕获 `callSchemas`（`:1477-1481`；`captureSchemas` 递归 `subCalls`，`:1346-1351`）。
- `compaction` → `requests.push`（`:1483-1486`）。
- `session-end` → `boundaries.push`（`:1487-1492`）。
- 其余（`turn-end`）→ `turnEndings.push`（`:1494-1499`）。
- 后处理：`interruptCompactions(requests, boundaries)`（`:1355-1377`，把未被 `compaction/end` 收尾的 running compaction
  在 session 边界上标为 `status:'error'` + `error:'trajectory.compaction-interrupted'`，常量见 `:1306`）；
  `applyTurnErrors(requests, turnEndings)`（`:1378-1395`，把 turn 的 error 挂到该轮**最后一条 assistant request**）。
- `EMPTY_TRAJECTORY_SNAPSHOT`（`:1311-1318`）用于尚未组装时。

### A.5 「加载更早」走 `session.loadOlder()`

- View 层 `loadEarlierHistory`（`dsh-client-ui-trajectory lib/client.js:8105-8109`）：
  ```js
  if (!hasResidentOlderHistory && !await loadOlder()) return false;
  setHistoryNodeLimit(limit => limit + HISTORY_PAGE_NODES);  // 50
  return true;
  ```
  `hasResidentOlderHistory = historyStartIndex > 0`（`:7861`）；
  `hasOlderHistory = hasResidentOlderHistory || sessionHasOlder`（`:7862`）
  → **短路意味着本地还有未显示节点时不会再打一次 RPC**。
- 本地节点窗口：`HISTORY_PAGE_NODES = 50`（`:7757`）；`historyTailSeq` 钉在挂载时的最新 seq（`:7834-7847`）；
  `historyEndIndex/historyStartIndex`（`:7838-7840`）；`inspection` 用 `slice(historyStartIndex)` 并过滤 `requests`（`:7848-7857`）。
- 槽注入的 `loadOlder`（`:8240-8244`）：
  ```js
  loadOlder: async () => {
      const before = trajectory.getSnapshot();
      await session.loadOlder();
      return trajectory.getSnapshot() !== before;
  }
  ```
- `session.loadOlder()` 实现（`dsh-api-session-controller lib/types/client/sessions/session.js:313-333`）：
  `events.prepend({ beforeSeq: this.baseSeq, maxMessages: PAGE_MESSAGES })`，`PAGE_MESSAGES = 50`（同文件 `:20`）。
- **与 Chat 同一条路**：`dsh-client-ui-chat lib/client.js:8326-8327` 也是
  `loadOlder: () => { session.loadOlder(); }`；`:8329` 另有 `loadThrough: (seq) => session.loadThrough(seq)`
  （契约 `dsh-api-session-controller lib/types/client/contract/session.d.ts:125-133`，
  实现 `dsh-api-session-controller lib/types/client/sessions/session.js:335-369`，`JUMP_PAGE_MESSAGES = 200`）。
- 底层 RPC：`session/page`（`dsh-api-session-controller lib/typert.remote-client.d.ts:25` 与 `:47`），
  请求 `SessionPageRequest = {address, throughSeq, beforeSeq?, maxMessages?}`，
  响应 `SessionPage = {records, hasMore}`。
  `throughSeq` **只能**取自同一次 `session/follow` 开帧的 `snapshot.cursor`。
- 本扩展现状：`src/dsh/client.ts:422-426` 已实现 `page()`；`src/dsh/controller.ts:1780-1810` 是 `pageBackwards()`；
  策略注释与停止条件见 `src/dsh/historyPaging.ts`。

---

## B. 界面结构

### B.1 工具栏（`TrajectoryToolbar`）

实现 `dsh-client-ui-trajectory lib/client.js:6124-6215`；CSS 同文件 `:6093`。

结构：`div[role=toolbar][aria-label=t("toolbar.aria")] > div.inner > [ div.actions（4 个按钮）, div.search ]`。
高度 `var(--dsh-trajectory-toolbar-height) = 32px`（`:7738`）；`position:sticky; top:0; z-index:4`。

| 控件 | 读哪个字段 | 显示什么 | 交互 |
|---|---|---|---|
| 时长 | `actualDuration`（`useDuration(v=>v)`，`:7823`；持久 store 名 `dsh.trajectory.duration`，`:41`） | 时钟图标 + `t("toolbar.duration")`；`aria-pressed=actualDuration`；`title` 在 `useActualDuration`/`useEqualWidth` 间切换 | 点击 `onActualDurationChange(!actualDuration)`，并 `setTimelineSelection(null)`（`:8116-8119`） |
| 实际时间 | `actualTime`（局部 state，`:7824`） | `role="switch"` + `aria-checked` + 轨道/滑块 | **`hidden:true`（`:6160`）→ 当前不可见**；点击后同样清空时间线选择（`:8121-8124`） |
| 轮次 | `allTurnsCollapsed`（`:8058`） | `⊞/⊟` + `t("toolbar.turns")`；`aria-label`/`title` 按状态切 `expandTurns`/`collapseTurns` | `onToggleAllTurns`（`:8081-8088`），只作用 `collapsibleTurnIds` |
| 调用 | `allAssistantsCollapsed`（`:8072`） | 同上，文案 `expandCalls`/`collapseCalls` | `onToggleAllAssistants`（`:8097-8103`） |
| 搜索 | `searchQuery`（`:7825`） | 放大镜 + `input[type=search]`（`aria-label=t("toolbar.search")`、`placeholder=t("toolbar.searchPlaceholder")`） | `onSearchQueryChange`；索引 3s 节流（`:7756`、`:8010-8021`） |

可折叠判据：

- `collapsibleTurnIds`（`:8057`）= `turn !== null` 且该轮
  `cells.filter(c => c.requestOnly !== true && c.kind !== 'system').length > 1`；
- `collapsibleAssistantIds`（`:8059-8071`）= `kind === 'message'` 且**紧邻下一条**是 `tool`/`subtool`；
- 时间线模式（`:8001`）：`actualDuration ? (actualTime ? 'actual' : 'duration') : (actualTime ? 'time' : 'sequence')`。

### B.2 账本的列与行布局

**只有 2 列**（`dsh-client-ui-trajectory lib/client.js:5394-5398`）：

```jsx
<colgroup>
  <col className={…eventColumn} />
  <col className={…contentColumn} />
</colgroup>
```

官方 CSS 常量（同文件 `:3660` 的 `css$3` 字符串，下列为选择器原文）：

- `.eventColumn{width:122px}`；`@container Y0dWHa_trajectory-table (width<=620px){ .eventColumn{width:50px} }`
- `.contentColumn{width:auto}`
- `.table{--trajectory-turn-accent:color-mix(in srgb, var(--dsw-static-blue-500) 22%, var(--dsw-alias-bg-layer-1));
  border-spacing:0; table-layout:fixed; width:100%; min-width:0; font:var(--dsw-font-xxs-12)}`
- `.event{padding-left:36px!important; padding-right:4px!important}` → 窄容器 `{padding-left:28px!important; padding-right:3px!important}`
- `.kindSlot{flex:none; justify-content:flex-end; align-items:flex-end; width:76px}` → 窄容器 `{width:19px}`
- `.kindTag{… height:19px; padding:0 5px; font-size:10px; font-weight:650; line-height:16px; border-radius:4px; border:1px solid #0000}`
- `.kindTagLabel{opacity:1; white-space:nowrap; max-width:72px}` → 窄容器 `{opacity:0; max-width:0}`
- `.kindTagIcon{… width:0; height:13px}` → 窄容器 `{opacity:1; width:13px; transform:scale(1)}`
- `.contentText{text-overflow:ellipsis; white-space:nowrap; min-width:0; display:block; overflow:hidden}`
- `.resultPreview{grid-template-columns:clamp(180px, var(--trajectory-tool-request-width, calc(36cqw - 56px)), 480px) minmax(0,1fr);
  align-items:center; gap:8px; font-family:var(--ds-font-family-code); font-size:12px}`
- `.requestBoundaryControl{--request-boundary-base-left:12px; z-index:6; top:-8px; left:calc(var(--request-boundary-base-left) + var(--request-boundary-offset,0px));
  width:16px; height:16px}` → 窄容器 `{--request-boundary-base-left:6px}`
- `.turnRail{z-index:4; background:var(--trajectory-turn-accent); width:2px; top:-1px; bottom:-1px}`
- `.selectionRail{z-index:5; width:3px; top:0; bottom:0; left:0; background:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}`；error 时 `background:var(--dsw-alias-state-error-primary)`
- `.turnLabel{z-index:3; position:absolute; top:0; left:0; font:8px/10px var(--ds-font-family-code); padding:1px 5px; border-radius:0 0 2px; display:inline-grid}`
- `.details{border-left:.5px solid var(--dsw-alias-border-l2); width:clamp(320px,38%,440px); max-width:calc(100% - 280px)}`
- `@media (width<=760px){ .details{z-index:5; width:min(92%,420px); max-width:92%; position:absolute; top:0; bottom:0; right:0; box-shadow:-12px 0 32px #00000024} }`
- `views.module.css`（同文件 `:7738`）：`.root{--dsh-trajectory-toolbar-height:32px}`；
  `.ledger{--dsh-trajectory-bottom-clearance:calc(var(--dsh-composer-height,152px) + 16px)}`
- 行高常量（同文件 `:3596-3598`）：`CONTENT_ROW_HEIGHT=30`、`COLLAPSED_SUMMARY_HEIGHT=20`、`TERMINAL_BOUNDARY_HEIGHT=9`

**行内布局次序**（`dsh-client-ui-trajectory lib/client.js:5458-5618`）。
`<tr>` 带整套 `data-*`：`data-kind / data-trajectory-row-key / data-virtual-position / data-record-index /
data-request-only / data-terminal-request-boundary / data-group-start / data-turn-start / data-error /
data-running / data-turn-end / data-collapsed-summary / data-selected / data-timeline-focus`，
另有 `aria-rowindex / aria-selected / aria-label / tabIndex`。

1. `<td class=event>`（`:5519`）内，按叠放次序：
   - `requestBoundaryControl` 按钮（`:5522-5538`，仅 `request !== undefined` 时）：
     绝对定位 `top:-8px; left:calc(12px + var(--request-boundary-offset))`，
     `data-label / data-request-status / data-request-run-index`；
     偏移量 `requestRunIndex * 8px`（`:5453-5454`；`indexRequestBoundaryRuns` `:4133-4145`）。
   - `turnRail`（`:5539-5542`）。
   - `selectionRail`（`:5543-5546`）。
   - `turnLabel`（`:5547-5559`）：`turnLabelFull` = 「第 N 轮」/「轮次之间」，
     `turnLabelCompact` = `#N`；窄容器靠 CSS 切换显隐。
   - `div.eventInner`（`:5560-5581`）→ `span.kindSlot` → `span.kindTag`
     （配色类按 kind 分派：`systemNeutral` / `contextGreen` / `compacted` / `toolAmber` /
     `assistantVioletBright` / `subtoolAmber` / 其余按 kind 名）
     + `Tooltip` 包住的 `kindTagIcon`（13px SVG）+ `kindTagLabel`。
     **折叠摘要行与 `requestOnly` 行不渲染 `kindSlot`**（`:5562`）。
2. `<td class=content>`（`:5583-5617`）：
   - `requestOnly` → 空；
   - `collapsedSummary` → `collapsedTurnContent`：`…` + 摘要单行省略（`title=` 给全文）；
   - 否则 → `span.contentText`（单行省略）内含 `RecordListText`；
     **有结果时**容器换成 `span.resultPreview`，变 2 列 grid：
     左列 `.resultRequest`（工具名等宽 + 参数），右列 `.inlineResult`（`→` + 结果文本，error 变红）；
     `title = "请求 → 结果"`。

`RecordListText`（`:4493-4506`）：`tool-call-only` → `record.toolCallOnly`；
工具/文本按 `" · "` 切 name/args（`toolCallTextParts` `:4460-4468`）。

图标映射 `KIND_ICON`（`:3899-3907`）：system = `IconSettingsOutline16`，user = `IconUserOutline16`，
context = 自绘 Information，compacted = 自绘 Compacted，message = `IconSparkle16`，
tool/subtool = 自绘 Wrench。
**标签键映射 `KIND_LABEL_KEY`（`:3824-3832`）里 `message → "kind.assistant"`**
（所以 `kind.message` 这个 key 全库零引用）。

### B.3 详情检查器的页签

面板出现条件（`dsh-client-ui-trajectory lib/client.js:5632`）：
`selectedRequestInfo !== undefined || promptSelected || (selected !== undefined && selectedState !== undefined)`
才渲染 `<aside class="details" aria-label={t("details.event")}>`。
可拖拽调宽（`:5637-5696`；`clampDetailsWidth` `:3988-3991`，`DETAILS_MIN_WIDTH=320` / `DETAILS_MAX_WIDTH=720` /
`TABLE_MIN_WIDTH=280` / `DETAILS_RESIZE_STEP=16`，`:3927-3931`）。

页签集合（`selectedTabs`，`:5148`）：

```js
selectedRequestInfo !== undefined
  ? REQUEST_TABS.filter(tab => tab.id !== 'options' || selectedRequestOptions !== undefined)
  : selected === undefined ? [] : detailTabs(selected)
```

- `REQUEST_TABS`（`:3947-3964`）：`overview`(tab.summary) / `options`(tab.options) / `usage`(tab.usage) / `timing`(tab.timing)；
  **`options` 仅当 `requestConfig !== undefined` 时出现**。
- `SYSTEM_PROMPT_TABS`（`:3936-3942`）：`system-prompt`(tab.systemPrompt) / `tools`(tab.tools)。
- `SYSTEM_UPDATE_TABS`（`:3943-3946`）：`diff`(tab.diff) + 上面两个。
- `detailTabs(record)`（`:4393-4445`）：
  - `kind === 'system'`：若 `promptDetail === undefined && systemPromptDetail !== undefined` → **只有 `system-prompt`**；
    否则 `previousPromptDetail === undefined ? SYSTEM_PROMPT_TABS : SYSTEM_UPDATE_TABS`；
  - `kind === 'compacted'` → `[overview, raw(tab.rawOutput)]`；
  - markdown 记录（user/context/message，`isMarkdownRecord` `:4365-4367`）→
    `[overview, rendered(tab.preview), raw(tab.raw)]`，**`messageSource !== undefined` 时**追加 `source(tab.source)`；
  - 其余（tool/subtool）→ `[overview] + (inputDetail ? payload) + (outputDetail ? result) + [schema, timing]`。

各页签渲染什么、数据取自哪里（`:5755-6085`）：

| tab | 渲染内容 | 数据来源 |
|---|---|---|
| `overview`（请求）`:5761-5839` | `details.status`(statusLabel) / `details.purpose`(仅 compaction) / `details.provider` / `details.model`（`provider ?? requestConfig.provider`）/ `details.toolCalls` 计数 / `details.subtoolCalls` 计数 / `details.error` / `details.retry`(+`request.retryProgress`) / `details.retryDelay` / `details.result` 跳转；再叠 Options / Usage / Timing 三段预览（可点开对应页签） | `sessionRequestNumbers` + 该请求组内的记录 |
| `options` `:5840-5843` | `JsonTree`；无值 → `options.notRecorded`（`:4324-4335`） | `selectedRequestInfo.requestConfig` |
| `usage` `:5844-5848` | 两段「本次请求 / 会话累计」各 `UsageRows`（`:4300-4323`；`inputTotal = input+cacheRead+cacheWrite`，`otherOutput = output-reasoning`；`usage.notReported` 兜底） | `request.usage` / `cumulativeUsage`，缺失时回退 assistant cell 的 input/cacheRead/cacheWrite/output/think（`:5137-5143`） |
| `timing` `:5849-5854` | `RequestTiming`（`:4868-4894`）：有 assistant → `RecordTiming`（`:4852-4867`）走 `AssistantTimingPanel`（`:4052-4066`，开始时间/总时长/TTFT/生成/吞吐）；无 → request 的 `startedAt/completedAt`；再退到 anchor cell | `assistantMetrics` / `request.startedAt` |
| `diff` `:5855-5859` | `SystemPromptDiff(previousPromptDetail, promptDetail)`（`:4718-4733`）：对 `system` 文本与 `JSON.stringify(tools,null,2)` 各出一段 `structuredPatch` | `previousPromptDetail` + `promptDetail` |
| `system-prompt` `:5860-5869` | 空串 → `record.systemPromptMissing`；否则 MarkdownText | `promptDetail.system ?? systemPromptDetail` |
| `tools` `:5870-5873` | `ToolCatalog`（`:4633-4673`，每工具一个 `<details>`：name / description / `JsonTree(parameters)`）；空 → `record.toolsMissing` | `promptDetail.tools` |
| `overview`（compacted）`:5874-5897` | 状态 / 时长 / Token（固定 `—`）+ `outputDetail` Markdown | `selected.cell.timeSeconds` / `outputDetail` |
| `overview`（其余记录）`:5898-6042` | `details.source`（`messageSourceLabel` `:4336-4351`）/ `details.hierarchy`（父 message / 父 tool / 所属请求跳转）/ `details.status` / `TokenRows`（message 才有，`:4247-4260`）/ 时长（user/context）；再叠 `tab.preview`（markdown 记录）或 payload / result / schema 三段 + `timing.request`（message）+ `tab.timing`（tool/subtool） | `cell.messageSource` / `parentRecords`（`:4368-4388`） |
| `rendered` / `raw` `:6043-6060` | `MarkdownRecordContent(rendered: true/false)` | `markdownSource`（`:4389-4392`） |
| `source` `:6061-6064` | `JsonTree`（label = `source.messageJson`）；无值 → `source.notRecorded`（`:4352-4364`） | `cell.messageSource` |
| `input` / `output` `:6065-6076` | `RecordPayload`（`:4895-4941`）：JSON 容器 → `JsonTree`；工具结果块 → `ToolOutputBlocks`；user/context/message → Markdown；否则 `<pre>` | `cell.inputDetail` / `cell.outputDetail` |
| `schema` `:6077-6080` | `RecordSchema`（`:4942-4975`）：`parseToolSchema`（`:4977-4991`）→ 名称 + 描述 + 参数树；解析失败退回 `<pre>`；无值 → `record.schemaUnavailable` | `cell.schemaDetail` |
| `timing` `:6081-6084` | `RecordTiming` | `cell.startedAt` / `timeSeconds` / `assistantMetrics` |

页签激活态由 `tabHistory`（`:5037`）驱动：切记录时优先保留仍可用的旧页签（`:5170-5179`）。

### B.4 时间线

形态：固定顶部概览条。`.plot{grid-template-columns:44px minmax(0,1fr); height:50px}`（`dsh-client-ui-trajectory lib/client.js:6346`）。
左侧 `LaneLabels` 三行标签（`:6457-6466`）：lane0 = `column.input`，lane1 = `column.model`，lane2 = `column.tools`。
`laneFor`（`:6229-6233`）：`tool|subtool → 2`，`message|compacted → 1`，其余（system/user/context）`→ 0`。

**分组：按记录（cell），不按轮次。**

- `sequence` 模式（`:6251-6279`）：每条可见 cell 占 **1 个单位宽**
  （`start = spans.length + offset, end = +1`），`model = {start:0, end:spans.length}`。
- 其余模式走 `deriveTimedTimeline`（`:6280-6332`）：domain 是**记录时间毫秒**
  （`cellRange` `:6237-6244`：`start = startedAt, end = startedAt + timeSeconds*1000`；
  `startedAt` 非有限则整条不进时间线）。`duration`/`actual` 用真实宽度；
  `time` 模式每条宽度归零（`end = span.start`，DOM `data-equal-duration`）；
  `duration` 模式（`compressIdle = true`）扣掉操作之间的空闲间隔（`:6301-6308`）。
- **轮次边界是独立竖线**（`turnBoundaries`，`:6258-6261` / `:6321-6324`），仅 `turn !== null` 时产生；
  `turn === null` 的独立压缩段没有边界。

交互：

- 左键拖动 = 选区（`onRangeChange`，`:6627-6660`）；
- 右键拖动 = 平移视口（仅已缩放时 `pannable`，`:6627-6640` + `:6668-6678`）；
  **`contextmenu` 无条件 `preventDefault`（`:6776-6778`）**——右键在这条时间线上是手势，
  不该弹出宿主菜单。本扩展原先只在 `zoom > 1` 时拦截，于是未缩放时右键弹菜单、
  看着像「拖不动」（用户 2026-09-15 报的）；现在整条时间线都拦截，并且平移监听挂在
  `document` 上（官方用 pointer capture），拖出元素也继续跟手；
- 滚轮 = 以光标为锚缩放（`Math.exp(deltaY * 0.0015)`，`:6561-6580`）；
- `Escape` 或双击 = 清空选区（`:6740-6744`、`:6772-6775`）；
- 点击 span = 选中该记录（`onRecordSelect`）；点空白 = 聚焦最近记录（`onRecordFocus`）；
- 左端 `…` 按钮 = `history.clickToLoadEarlier` 悬浮提示 + `onLoadEarlier`
  （`:6468-6494`；仅 `domainStart === model.start` 时显示，`:6544`）；
- span tooltip（`timelineTooltipLabel` `:6417-6429`）：种类名 + `开始于 {time}`（或起止区间）
  + `总计 {duration}` + `首 token {ttft} · 解码 {decoding}`。

span 的 DOM（`:6838-6858`）：
`span[data-timeline-span=kind][data-timeline-record-index][data-assistant-timing][data-error]
[data-equal-duration][data-current][data-hovered][data-search-match][data-selected]`，
CSS 变量 `--trajectory-span-left / -width / -gap / -lane / -assistant-ttft`。

常量（`:6373-6378`）：`MINIMUM_DRAG_PX = 3`、`MINIMUM_ZOOM_OPERATIONS = 4`、`TIMELINE_TOOLTIP_DELAY_MS = 500`。

### B.5 展开 / 收起、默认展开、滚动与定位

- **默认全部展开**：`collapsedTurns = useState(EMPTY_TURN_IDS)`（`:7816`）、
  `collapsedAssistants = useState(EMPTY_RECORD_IDS)`（`:7821`），两个 `EMPTY_*` 都是空 `Set`（`:7754-7755`）。
- **默认不选中任何记录**：`selectedRecordId = null`、`selectedRequest = null`（`:5028-5029`）→ 检查器不渲染；
  `activeTab` 初值 `'overview'`（`:5030`），`tabHistory` 初值 `{"overview"}`（`:5037`）。
- 行交互（`:5484-5518`）：单击 = `selectRecord(index)`；
  双击 = 整轮收起 → 展开整轮 / 该 message 后跟工具 → 切「调用」折叠 / 轮首且该轮内容 >1 → 收起整轮；
  `Enter`/`Space` 同单击；折叠摘要行单击 = 展开。
- **默认滚动**：`anchorTo:"end"` + `followOnAppend:"auto"`（`:5094-5098`）；
  首次布局在非 loading 时滚到底（`scrollToEnd({behavior:'auto'})` 或 `pane.scrollTop = pane.scrollHeight`，`:5346-5353`）；
  `BOTTOM_FOLLOW_THRESHOLD_PX = 2`（`:3818`）判定「贴着底」，仅贴底时继续跟随（`:5355-5356`、`:5377`）。
- 初始窗口：挂载时 `historyTailSeq = 最新节点 seq`（`:7835`、`:7841-7847`），
  只渲染最后 `HISTORY_PAGE_NODES = 50` 个**节点**（`:7836-7840`）。
- 向上滚动自动加载更早：`OLDER_LOAD_THRESHOLD_PX = 48`（`:3819`、`:5315-5335`）；
  prepend 后用 `scrollHeight` 差补偿 `scrollTop`（`:5336-5345`）避免视口跳动。
- 虚拟化：`records.length > 100 || hasOlderRecords` 时启用（`:5079`），
  `VIRTUAL_OVERSCAN_ROWS = 12`、`VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600`（`:3822-3823`）；
  `groupTrajectoryVirtualRows`（`:3616-3642`）把零高的 `requestOnly` 行挂到下一条内容行上。
- 记录身份：`trajectoryRecordId`（`:3568-3573`）优先 `recordId` → `kind\0call\0callId`
  → `kind\0seq\0sourceSeq` → `kind\0index\0N`；
  DOM key 在此基础上再加 `\0summary\0turn|assistant`（`:3605-3608`）。
- 跨视图定位：`inspectCallId = viewRequest?.view === 'trajectory' ? viewRequest.focus : null`（`:7870`），
  命中前自动扩容本地节点窗口以覆盖目标（`:7871-7875`），命中后 `openRecordSummary` +
  平滑滚动居中 + `onInspectApplied()`（`:5223-5234`、`:5235-5265`）。
  地址契约：`ConversationViewRequest{view, focus}`
  （`dsh-client-ui-conversation lib/types/client/contract/views.d.ts:11-16`）。

### B.6 搜索索引（工具栏搜索的数据口径）

`TrajectorySearchIndex`（`dsh-client-ui-trajectory lib/client.js:7692-7735`）：

- `update(layouts)` 增量同步（`:7700-7722`），对每条记录算 `recordSources(turn, group, cell)`；
- `recordSources`（`:7663-7690`）——**要搜的字段清单，逐字照抄**：
  `turn === null ? "between turns" : \`turn ${turn}\``、`group`、`cell.kind`、
  `cell.kind === 'message' ? 'assistant' : ''`、`cell.text`、`cell.previewMarkdown ?? ''`、
  `cell.inputDetail ?? ''`、`cell.outputDetail ?? ''`、`cell.thinkingDetail ?? ''`、
  `cell.schemaDetail ?? ''`、`cell.result ?? ''`、`cell.resultPreviewMarkdown ?? ''`、`cell.callId ?? ''`、
  以及 `[...sourceBlocks, ...outputBlocks]` 每条块的 `type / content / callId / toolName / attachment?.name`、
  再 `JSON.stringify` 的 `messageSource` / `promptDetail` / `previousPromptDetail`；
- 匹配文本 = `[...sources, markdownPreview(cell), resultPreview(cell)].join('\n').toLocaleLowerCase()`（`:7711-7715`）；
- `search(query)`（`:7728-7734`）：按空白切词、**全部词都命中**才算，空查询返回 `null`；
- 预览函数 `trajectoryPreviewText`：`PREVIEW_SOURCE_CHARACTERS = 2048`、`PREVIEW_OUTPUT_CHARACTERS = 512`
  （`:3646-3647`），实现 `:3653-3658`。

---

## C. 文案（175 key，逐条）

`dsh-client-ui-trajectory lib/types/client/locales.d.ts` 的 `zh` 是 key 集合的唯一来源（`:4-181`），
`en` 声明为 `Record<TrajectoryKey, string>`（`:193`）。实现体在
`dsh-client-ui-trajectory lib/client.js:49-225`（zh）/ `:227-403`（en）。

**程序化核对结果：zh 175 key、en 175 key，`Compare-Object` 集合差异为空。**
下列 `zh 行` 指 `lib/client.js` 中 zh 字典的行号（en 对应行号 = zh 行 + 178）。

### C.1 视图 / 工具栏（14）

| key | zh | en | zh 行 |
|---|---|---|---|
| view.trajectory | 轨迹 | Trajectory | :50 |
| toolbar.aria | 轨迹工具栏 | Trajectory toolbar | :51 |
| toolbar.duration | 时长 | Duration | :52 |
| toolbar.useActualDuration | 使用实际时长 | Use actual duration | :53 |
| toolbar.useEqualWidth | 使用等宽操作 | Use equal-width operations | :54 |
| toolbar.actualTime | 实际时间 | Actual time | :55 |
| toolbar.turns | 轮次 | Turns | :56 |
| toolbar.expandTurns | 展开所有轮次 | Expand turns | :57 |
| toolbar.collapseTurns | 收起所有轮次 | Collapse turns | :58 |
| toolbar.calls | 调用 | Calls | :59 |
| toolbar.expandCalls | 展开所有调用 | Expand calls | :60 |
| toolbar.collapseCalls | 收起所有调用 | Collapse calls | :61 |
| toolbar.search | 搜索轨迹 | Search trajectory | :62 |
| toolbar.searchPlaceholder | 搜索 | Search | :63 |

### C.2 记录种类（9）

| key | zh | en | zh 行 |
|---|---|---|---|
| kind.system | 系统 | SYSTEM | :64 |
| kind.user | 用户 | USER | :65 |
| kind.context | 上下文 | CONTEXT | :66 |
| kind.compacted | 已压缩 | COMPACTED | :67 |
| kind.message | 消息 | Message | :68 |
| kind.assistant | 助手 | ASSISTANT | :69 |
| kind.tool | 工具 | TOOL | :70 |
| kind.subtool | 子工具 | SUBTOOL | :71 |
| kind.sub | 子项 | Sub | :72 |

（`kind.message` / `kind.sub` **零引用**；UI 上 `message` 走 `kind.assistant`。）

### C.3 列名（6；仅 3 个被用，且只作时间线泳道标签）

| key | zh | en | zh 行 | 用处 |
|---|---|---|---|---|
| column.input | 输入 | Input | :73 | 时间线 lane0（`:6462`） |
| column.output | 输出 | Output | :74 | 零引用 |
| column.think | 思考 | Think | :75 | 零引用 |
| column.time | 时间 | Time | :76 | 零引用 |
| column.model | 模型 | Model | :77 | 时间线 lane1（`:6463`） |
| column.tools | 工具 | Tools | :78 | 时间线 lane2（`:6464`） |

### C.4 轮次 / 分组 / 状态（8）

| key | zh | en | zh 行 |
|---|---|---|---|
| turn.label | 第 {turn} 轮 | Turn {turn} | :79 |
| section.betweenTurns | 轮次之间 | Between turns | :80 |
| group.message | 消息 | Message | :81 |
| group.step | 步骤 {step} | Step {step} | :82 |
| group.compaction | 压缩 {seq} | Compaction {seq} | :83 |
| status.failed | 失败 | Failed | :84 |
| status.pending | 等待中 | Pending | :85 |
| status.completed | 已完成 | Completed | :86 |

### C.5 计时（19）

| key | zh | en | zh 行 |
|---|---|---|---|
| timing.notAvailable | 不可用 | Not available | :87 |
| timing.notRecorded | 未记录 | Not recorded | :88 |
| timing.stepStartUnavailable | 步骤开始时间不可用 | Step start unavailable | :89 |
| timing.firstTokenUnavailable | 首 token 时间不可用 | First token unavailable | :90 |
| timing.usageUnavailable | 用量不可用 | Usage unavailable | :91 |
| timing.outputTokensUnavailable | 输出 token 数不可用 | Output tokens unavailable | :92 |
| timing.durationTooShort | 时长过短 | Duration too short | :93 |
| timing.showLocalTime | 显示本地时间 | Show local time | :94 |
| timing.showUnixTimestamp | 显示 Unix 时间戳 | Show Unix timestamp | :95 |
| timing.started | 开始时间 | Started | :96 |
| timing.totalDuration | 总时长 | Total duration | :97 |
| timing.ttft | 首 token 延迟 | TTFT | :98 |
| timing.generation | 生成 | Generation | :99 |
| timing.throughput | 吞吐量 | Throughput | :100 |
| timing.duration | 时长 | Duration | :101 |
| timing.source | 计时来源 | Timing source | :102 |
| timing.sessionTimestamps | 会话时间戳 | Session timestamps | :103 |
| timing.sessionTimestampsRunning | 会话时间戳（运行中） | Session timestamps (running) | :104 |
| timing.request | 请求计时 | Request Timing | :105 |

### C.6 单位（4）

| key | zh | en | zh 行 |
|---|---|---|---|
| unit.milliseconds | {value} 毫秒 | {value} ms | :106 |
| unit.seconds | {value} 秒 | {value} s | :107 |
| unit.tokens | {value} tok | {value} tok | :108 |
| unit.tokensPerSecond | {value} tok/s | {value} tok/s | :109 |

### C.7 用量（11）

| key | zh | en | zh 行 |
|---|---|---|---|
| usage.tokens | Token | Tokens | :110 |
| usage.reasoning | 推理 | Reasoning | :111 |
| usage.content | 内容 | Content | :112 |
| usage.notReported | 未报告用量 | Usage not reported | :113 |
| usage.input | 输入 | Input | :114 |
| usage.cached | 缓存读取 | Cached | :115 |
| usage.cacheCreated | 缓存写入 | Cache created | :116 |
| usage.other | 其他 | Other | :117 |
| usage.output | 输出 | Output | :118 |
| usage.thisRequest | 本次请求 | This request | :119 |
| usage.sessionCumulative | 会话累计 | Session cumulative | :120 |

### C.8 选项 / 来源（10）

| key | zh | en | zh 行 |
|---|---|---|---|
| options.notRecorded | 未记录选项 | Options not recorded | :121 |
| options.json | 请求选项 JSON | Request options JSON | :122 |
| source.unknown | 未知 | Unknown | :123 |
| source.user | 用户 | User | :124 |
| source.plugin | 插件 | Plugin | :125 |
| source.pluginNamed | 插件 · {plugin} | Plugin · {plugin} | :126 |
| source.goal | 目标 | Goal | :127 |
| source.goalRound | 目标 · Round {round} | Goal · Round {round} | :128 |
| source.notRecorded | 未记录来源 | Source not recorded | :129 |
| source.messageJson | 消息来源 JSON | Message source JSON | :130 |

### C.9 页签（14）

| key | zh | en | zh 行 |
|---|---|---|---|
| tab.summary | 概述 | Summary | :131 |
| tab.rawOutput | 原始输出 | Raw Output | :132 |
| tab.preview | 预览 | Preview | :133 |
| tab.raw | 原始内容 | Raw | :134 |
| tab.source | 来源 | Source | :135 |
| tab.payload | 参数 | Payload | :136 |
| tab.result | 结果 | Result | :137 |
| tab.schema | Schema | Schema | :138 |
| tab.timing | 计时 | Timing | :139 |
| tab.diff | 差异 | Diff | :140 |
| tab.systemPrompt | 系统提示词 | System Prompt | :141 |
| tab.tools | 工具 | Tools | :142 |
| tab.options | 选项 | Options | :143 |
| tab.usage | 用量 | Usage | :144 |

### C.10 记录正文 / 块（21）

| key | zh | en | zh 行 |
|---|---|---|---|
| record.toolCallOnly | （仅工具调用） | (tool call only) | :145 |
| record.noContent | 无内容 | No content | :146 |
| record.noPayload | 未捕获参数 | No payload captured | :147 |
| record.noResult | 未捕获结果 | No result captured | :148 |
| record.noOutput | 无输出 | No output | :149 |
| record.schemaUnavailable | Schema 不可用 | Schema unavailable | :150 |
| record.parameters | 参数 | Parameters | :151 |
| record.resultJson | 结果 JSON | Result JSON | :152 |
| record.json | JSON | JSON | :153 |
| record.parametersJson | 参数 JSON | parameters JSON | :154 |
| record.namedParametersJson | {name} 参数 JSON | {name} parameters JSON | :155 |
| record.payloadJson | 参数 JSON | Payload JSON | :156 |
| record.outputJson | 结果 JSON | Result JSON | :157 |
| record.thinking | 思考 | Thinking | :158 |
| record.systemPromptMissing | 本次请求没有系统提示词 | No system prompt in this request | :159 |
| record.toolsMissing | 本次请求没有工具 | No tools in this request | :160 |
| record.systemPrompt | 系统提示词 | System Prompt | :161 |
| record.tools | 工具 | Tools | :162 |
| block.openSummary | 打开第 {index} 个块的工具调用概述 | Open Block #{index} tool call summary | :163 |
| block.openSummaryTitle | 打开工具调用概述 | Open tool call summary | :164 |
| block.label | 块 #{index} {type} | Block #{index} {type} | :165 |

（`record.json` / `record.parametersJson` 零引用；
`record.payloadJson` / `record.outputJson` 在 `:4928` 按方向取用。）

### C.11 历史（5）

| key | zh | en | zh 行 |
|---|---|---|---|
| history.loadingTrajectory | 正在加载轨迹… | Loading trajectory… | :166 |
| history.loadingEarlier | 正在加载更早的历史… | Loading earlier history… | :167 |
| history.loadingEarlierAria | 正在加载更早的历史… | Loading earlier history… | :168 |
| history.loadEarlier | 加载更早的历史 | Load earlier history | :169 |
| history.clickToLoadEarlier | 点击加载更早的历史 | Click to load earlier history | :170 |

### C.12 请求 / 折叠摘要（16）

| key | zh | en | zh 行 |
|---|---|---|---|
| request.label | 请求 #{request} | Request #{request} | :171 |
| request.labelCompaction | 请求 #{request} · 压缩 | Request #{request} · Compaction | :172 |
| request.compaction | 压缩 · {section} | Compaction · {section} | :173 |
| request.compactionPurpose | 压缩 | Compaction | :174 |
| request.retryProgress | {retry}/{maximum} | {retry} of {maximum} | :175 |
| request.collapsedSummary | 已收起的{kind}概述，{summary} | Collapsed {kind} summary, {summary} | :176 |
| request.collapsedTurn | 轮次 | turn | :177 |
| request.collapsedAssistant | 助手 | assistant | :178 |
| request.rowAria | {request}{kind}，{content} | {request}{kind}, {content} | :179 |
| request.rowPrefix | 请求 {request}， | Request {request}, | :180 |
| request.rowAriaCompaction | 请求 {request}，压缩 | Request {request}, compaction | :181 |
| request.noContent | 无内容 | no content | :182 |
| summary.toolCalls.one | {count} 个工具调用 | {count} tool call | :183 |
| summary.toolCalls.other | {count} 个工具调用 | {count} tool calls | :184 |
| summary.steps.one | {count} 个步骤 | {count} step | :185 |
| summary.steps.other | {count} 个步骤 | {count} steps | :186 |

### C.13 详情（21）

| key | zh | en | zh 行 |
|---|---|---|---|
| details.event | 事件详情 | Event details | :187 |
| details.resize | 调整事件详情宽度 | Resize event details | :188 |
| details.resizeTitle | 拖动调整大小；双击恢复默认值。 | Drag to resize. Double-click to reset. | :189 |
| details.close | 关闭详情 | Close details | :190 |
| details.status | 状态 | Status | :191 |
| details.purpose | 用途 | Purpose | :192 |
| details.provider | 提供方 | Provider | :193 |
| details.model | 模型 | Model | :194 |
| details.toolCalls | 工具调用 | Tool calls | :195 |
| details.subtoolCalls | 子工具调用 | Subtool calls | :196 |
| details.error | 错误 | Error | :197 |
| details.failure.auth | API 密钥无效 | API key is invalid | :198 |
| details.retry | 重试 | Retry | :199 |
| details.scheduled | 已计划 | Scheduled | :200 |
| details.retryDelay | 重试延迟 | Retry delay | :201 |
| details.result | 结果 | Result | :202 |
| details.compacted | 已压缩 | Compacted | :203 |
| details.assistantMessage | 助手消息 | Assistant Message | :204 |
| details.source | 来源 | Source | :205 |
| details.hierarchy | 层级 | Hierarchy | :206 |
| details.toolCall | 工具调用 | Tool Call | :207 |

### C.14 时间线（6）

| key | zh | en | zh 行 |
|---|---|---|---|
| timeline.aria | 轨迹时间线 | Trajectory timeline | :208 |
| timeline.overviewAria | 时间线概览；水平拖动可聚焦事件 | Timeline overview; drag horizontally to focus events | :209 |
| timeline.noTimingData | 无计时数据 | No timing data | :210 |
| timeline.total | 总计 {duration} | Total {duration} | :211 |
| timeline.started | 开始于 {time} | Started {time} | :212 |
| timeline.ttftDecoding | 首 token {ttft} · 解码 {decoding} | TTFT {ttft} · Decoding {decoding} | :213 |

### C.15 布局（11）

| key | zh | en | zh 行 |
|---|---|---|---|
| layout.compacting | 正在压缩上下文… | Compacting context… | :214 |
| layout.compactionFailed | 上下文压缩失败 | Compaction failed | :215 |
| layout.compacted | 上下文已压缩 | Context compacted | :216 |
| layout.toolCallOnly | 仅工具调用 | Tool call only | :217 |
| layout.imageOnly | 图片 ×{count} | Images ×{count} | :218 |
| layout.fileAttachments | 文件 ×{count} | Files ×{count} | :219 |
| layout.initialSystemPrompt | 初始系统提示词 | Initial System Prompt | :220 |
| layout.systemPromptUpdated | 系统提示词已更新 | System Prompt Updated | :221 |
| layout.toolsUpdated | 工具已更新 | Tools Updated | :222 |
| layout.systemPromptAndToolsUpdated | 系统提示词和工具已更新 | System Prompt and Tools Updated | :223 |
| layout.compactionInterrupted | 上下文压缩在完成前被中断。 | Compaction was interrupted before completion. | :224 |

### C.16 带参数的 key 清单（实现里必须写成函数，禁止字符串拼接）

`turn.label{turn}`、`group.step{step}`、`group.compaction{seq}`、
`unit.milliseconds{value}`、`unit.seconds{value}`、`unit.tokens{value}`、`unit.tokensPerSecond{value}`、
`source.pluginNamed{plugin}`、`source.goalRound{round}`、
`block.openSummary{index}`、`block.label{index,type}`、
`request.label{request}`、`request.labelCompaction{request}`、`request.compaction{section}`、
`request.retryProgress{retry,maximum}`、`request.collapsedSummary{kind,summary}`、
`request.rowAria{request,kind,content}`、`request.rowPrefix{request}`、`request.rowAriaCompaction{request}`、
`summary.toolCalls.one{count}`、`summary.toolCalls.other{count}`、
`summary.steps.one{count}`、`summary.steps.other{count}`、
`timeline.total{duration}`、`timeline.started{time}`、`timeline.ttftDecoding{ttft,decoding}`、
`layout.imageOnly{count}`、`layout.fileAttachments{count}`、`record.namedParametersJson{name}`。

### C.17 时间 / 时长格式化函数口径

| 函数 | 行 | 口径 |
|---|---|---|
| `formatDurationMillis(ms, t)` | `dsh-client-ui-trajectory lib/client.js:3580-3583` | `null`/非有限 → `"—"`；否则 `t("unit.milliseconds", { value: String(Math.round(ms)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") })`（整数毫秒 + 千分位） |
| `formatElapsedSeconds(sec, t)` | 同 `:3590-3592` | `sec === null ? null : sec * 1e3` 后走 `formatDurationMillis` |
| `formatDurationMs(ms, t)` | 同 `:3995-3998` | `ms < 1e3` → `unit.milliseconds`（四舍五入整数）；否则 `unit.seconds`，`ms < 1e4` 保留 2 位、否则 1 位小数 |
| `formatStartedAt(ts, t)` | 同 `:3999-4006` | `null`/非有限 → `timing.notAvailable`；否则本地时间 `YYYY-MM-DD HH:mm:ss.SSS` |
| `formatRecordedTime(ts)` | 同 `:6409-6416` | `new Date(ts).toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3})` |
| `formatTimelineOffset(ms, t)` | 同 `:6226-6228` | 直接转发 `formatDurationMillis` |
| `formatGroupDuration(sec, t)` | 同 `:7313-7316` | 非有限 → `undefined`；否则 `formatElapsedSeconds` |
| `trajectoryPreviewText(text)` | 同 `:3653-3658` | 源截 `2048` 字符 → `extractMarkdownPlainText` → 空白折叠 → 截 `512` 字符，被截过则追加 `…` |
| 总时长/TTFT/生成/吞吐 | 同 `:4026-4051` | `totalTime = completed - stepStartTime`；`ttft = firstToken - stepStartTime`；`generation = completed - firstToken`；`throughput = output / ((completed - firstToken)/1000)`，`<=0` → `timing.durationTooShort`；各分支的兜底文案依次是 `timing.notRecorded` / `timing.stepStartUnavailable` / `timing.firstTokenUnavailable` / `timing.usageUnavailable` / `timing.outputTokensUnavailable` / `status.pending` |

---

## D. 本扩展现状与差距

> **本节已过时（2026-09-14 之后）**：D.1–D.3 写的是**落地之前**的现状与计划——里面的
> `Panels.tsx` 抽屉版 `TrajectoryPanel`、`state.trajectory: ToolCallView[]` 都已经不存在，
> 现在看本文件开头的《实现状态》与 `src/webview/components/Trajectory.tsx`、
> `src/dsh/trajectory.ts` 的文件头。这里保留下来只作「官方要哪些字段」的索引（D.2 的
> 差距表按记录种类逐条列了字段来源，仍然好用）。

### D.1 现在有什么

- **入口**：`src/webview/App.tsx:80-83`（图标按钮 `toggle("trajectory")`）、`src/webview/App.tsx:518-524`
  （`<TrajectoryPanel tools={state.trajectory} diffLayout={state.diffLayout} onClose={closePanel} />`）。
- **面板**：`src/webview/components/Panels.tsx:186-208` —— 只是个 `Drawer`，把 `tools` 按 `startedAt`
  **降序**排一遍，逐条丢给 `ToolRow`（复用聊天区工具行）。
  其上方注释（`src/webview/components/Panels.tsx:178-185`）已自认「只做了工具调用一列，不冒充官方那个视图」。
- **数据**：`src/webview/state.ts:37-38`（`trajectory: ToolCallView[]`）、`:67`（初值 `[]`）、
  `:228-239`（`useMemo` 从 `state.messages[].segments[]` 筛 `kind === 'tool'`，按 `startedAt` **升序**排；
  与面板的降序排序互相抵消，等于白排一次）。
- **类型**：`src/shared/chat.ts:141-193` `ToolCallView`；
  `src/shared/chat.ts:261-288` `Segment`（含 `{kind:'tool', id, tool}`，`step?` 可选）；
  `src/shared/chat.ts:336-364` `MessageView`。
- **宿主折叠**：`src/dsh/adapter.ts` 的 `SessionAdapter`（`:390` 起）。
  `seen: Map<seq, SessionWireEvent>`（`:443`）存**全部** durable 事件；`refold()`（`:765` 起）重放折叠成 `MessageView[]`。
  `applyEvent`（`:791-1113`）现有 case：`turn/start`(`:797`)、`turn/end`(`:813`)、`step/start`(`:881`)、
  `user/message`(`:887`)、`system/message`(`:940`)、`assistant/message`(`:946`)、`tool/call`(`:951`)、
  `tool/result`(`:960`)、`session/title`、`todo/write`、`plan/mode`、`permission/preset`、`sandbox/mode`、
  `request/context`(`:1004`)、`model/selection`、`deliverables/presented`、`command/run|done`、
  `llm/retry|retry-started`、`compaction/summary`(`:1088`)。
- **宿主分页**：`src/dsh/controller.ts:1750-1810`（`loadMore` / `pageBackwards`）；
  `src/dsh/client.ts:422-426` `page()`；`src/dsh/adapter.ts:731-748` `prependRecords`、`:750-762` `earliestSeq`/`cursor`。
- **文案**：`src/webview/texts.ts:181-182`（`trajectory` / `trajectoryEmpty` 声明）、
  `:593-594`（zh）、`:915-916`（en）。

### D.2 差距表：哪些记录种类今天能产出、缺什么

关键事实：**官方折叠所需的全部 durable 事件我们都已经收到。**
`src/dsh/protocol.ts:173-206` 的 `RENDERED_EVENT_TYPES` 已含 `request/header`、`session/end-seed`、
`compaction/start|summary|end`；`tool/ptc-dispatch` / `tool/ptc-dispatch-start` 在
`src/dsh/protocol.ts:250-251` 的 `SILENT_EVENT_TYPES`。
它们目前落到 `src/dsh/adapter.ts:1100` 的 `default:` 被**知情静默**丢弃。
所以差距在**折叠**与**字段保留**，不在传输。

| 记录种类 | 今天能否产出 | 缺什么 |
|---|---|---|
| `user` | ✅ | 只需 `user/message`（`source.kind ∈ user/user-rpc`），`src/dsh/adapter.ts:887-932` 已有。需新增 `opensTurn` 标记（官方 `dsh-client-ui-trajectory lib/client.js:7081`，仅真用户消息才有） |
| `context` | ✅（原始事件在） | 现在折成 `Segment{kind:'injected'}`（`pushInjected`，`src/dsh/adapter.ts:1594-1615`），只留 `{kind, plugin, form, text, source?}`；轨迹要的是 `{seq, time, content, source}` + `messageSource`。**做标签只用 `source.kind` / `source.plugin` / `source.round`**（`messageSourceLabel`，官方 `:4336-4351`），三者我们都有 |
| `steering` | ⚠️ 半 | 官方靠 `agent/inbox/spliced(target='next-step')` 的 claim 集合区分 user / steering（官方 `:1105-1157`）。该事件到达但我们静默（`src/dsh/protocol.ts:224`）；需按官方 `:1078-1104` 的 splice 折叠补上 |
| `message`（助手） | ✅ | `assistant/message` 已有（`src/dsh/adapter.ts:1116` 起 `applyAssistantMessage`）。缺：`AssistantTiming{stepStartTime, firstTokenTime, completedTime}`（我们有 `stepStartedAt`/`stepFirstTokenAt`/`event.time`，`src/dsh/adapter.ts:421-423`）、`usage` 的 **cacheRead/cacheWrite**（`toUsage` `src/dsh/adapter.ts:180` 起只认线格式 `cacheReadTokens`/`cacheWriteTokens`，需核对是否保留）、`provenance{provider,model}`（`message.source`，当前未留）、`interrupted` 标记 |
| `tool` | ✅ | `tool/call` + `tool/result` 都有；`callTime` = 我们的 `startedAt`，`time` = 我们的 `endedAt`。需要 `subCalls` 才能出嵌套层级 |
| `subtool` | ❌ | 需 `tool/ptc-dispatch-start` / `tool/ptc-dispatch`（官方 `:1632-1658`、`:7541-7595`）。事件到达但**完全没折** |
| `system` | ❌ | 需 `request/header`（`dsh-session lib/types/types.d.ts:208-215,366-371`）+ `system/message`（`:294-298`）的 surface 替换语义。`request/header` 到达但被丢；`system/message` 只被当一段文本塞进 `injected` |
| `compacted` | ❌ | 需 `compaction/start` / `compaction/summary` / `compaction/end` 的完整生命周期（`startSeq`/`status`/`startedAt`/`completedAt`/`summary`/`rawOutput`/`usage`/`provider`/`model`/`maxTokens`）。今天只有 `compaction/summary` → 一条 `@compacted` notice（`src/dsh/adapter.ts:1088-1098`），其余字段全丢 |
| `RequestView[]` | ❌ | `assistantRequest`（官方 `:798-822`）的口径要从 `step/start` + `step/end` + `llm/retry` + `assistant/message` 重建；`compaction` 的要从 `compaction/*` 重建 |
| `callSchemas` | ❌ | 来自 `request/header.header.tools` + `previousHeader.seq < anchorSeq` 的时序判断（官方 `:1480`）。事件在，Schema 没留 |
| `partial`（流式中） | ⚠️ | 我们有流式叠加层（`liveSegments`，`src/dsh/adapter.ts:394`），语义与官方 `AssistantLiveChunkEvent`（`dsh-api-session-controller lib/types/client/contract/events.d.ts:6-16`，按 `attemptId/revision/index/chunk` 组织、可被 durable settlement 原子替换，`:31-34`）**不同**。映射不对会出现重复行 |
| 时间线 | ✅ 数据够 | 需 `startedAt` + `timeSeconds` + `assistantMetrics`（TTFT / decoding）。`startedAt`/`endedAt` 已有，TTFT 有 `stepFirstTokenAt - stepStartedAt` |
| 工具栏搜索 | ✅ | 纯本地；要搜的字段清单见 B.6（照抄官方 `:7663-7690`） |
| 「加载更早」 | ✅ | `session.loadOlder()` 已实现（`src/dsh/client.ts:422-426`）；官方另加本地节点窗口（`HISTORY_PAGE_NODES = 50`）+ 时间线左端 `…` 按钮 |

**结论：数据层面约 8 成可达**（user / context / message / tool / subtool / compacted / 请求 / 时间线 / 搜索）；
**system 与 callSchemas 需额外实现 surface 语义**；**流式 partial 需一次语义映射**。

### D.3 需要哪些服务端调用

**不需要任何新的 RPC 方法。** 逐条确认：

1. 事件窗口：`session/follow`（`src/dsh/client.ts:466-486`）+ `session/page`（`src/dsh/client.ts:422-426`）
   已足够 —— 官方轨迹的**全部**输入都在这两条里。
2. `dsh-api-session-controller lib/typert.remote-client.d.ts:14-31` 枚举的 `session/*` 里**没有** `trajectory*`。
3. 唯一实现细节：`throughSeq` **只能**取自 `session/follow` 开帧的 `snapshot.cursor`
   （线格式 `src/dsh/protocol.ts:56`）；本扩展已遵守（`src/dsh/adapter.ts:671`、`src/dsh/controller.ts:1788`）。

**真正要新增的是宿主 → webview 的线格式**（不是服务端调用）：

1. `src/shared/ipc.ts`：新增 `HostToWebview` 分支 `{ type: "trajectory/turns"; turns: TrajectoryTurnModel[] }`
   （或 `{ type: "trajectory"; model }`），带请求编号 `TrajectoryRequestNumber[]` 与 `hasOlderRecords`。
2. `src/dsh/controller.ts`：在 `deliver(...)` 的既有推帧点（参考 `:1761`、`:1792`，以及 `turn/end` 收尾后）
   推一次轨迹模型；`loadMore`（`:1750-1770`）成功后重推。
3. `src/webview/state.ts`：`reducer` 加 case 存进 `AppState.trajectory`（类型换成 `TrajectoryTurnModel[]`），
   并**删掉 `:228-239` 的 `useMemo` 派生**。
4. 仓库铁律：宿主 → webview 的帧是 `JSON.stringify` 过的，**值为 `undefined` 的键会被整条丢掉**，
   清空字段必须发 `null`（`src/shared/wire.ts`；`mergeWirePatch` 折回「键不存在」）。
   轨迹模型里 `timeSeconds: null`、`startedAt: null`、`completedTime: null` 是**有意义的空值**，不能省键 ——
   建议整体传 JSON 字符串（`{ type: "trajectory", json: string }`）绕开逐键折回，或在 `src/shared/wire.ts` 登记这些字段。
5. `src/dsh/client.ts` **不用改**（`page()` 已是官方签名）。

---

## 证据不足 / 无法确认

1. **时间线 lane0 的具体语义**：`laneFor`（`dsh-client-ui-trajectory lib/client.js:6229-6233`）把
   `system`/`user`/`context` 都归 lane0，而 lane0 的标签是 `column.input`。
   我**没有**找到同一 lane 内的进一步排序或分层规则（重叠处理在 CSS，未在 JS 显式分层）。只报事实。
2. **七个 key 零引用**：`kind.message`、`kind.sub`、`column.output`、`column.think`、`column.time`、
   `record.json`、`record.parametersJson`（对 175 key × `lib/client.js` 全文做了引用扫描）。
   是「留给未来」还是「遗留死键」，无法判定。
3. **`openCallSummary` 对 subtool 的跳转行为**：官方 `:5217-5220` 只按 `record.cell.callId === callId`
   找第一条；subtool 的 `callId` 与父 tool 不同，因此从 assistant 的 source block 跳到 subtool 不成立。
   是否属于官方缺陷 / 有意，无法确认。
4. **`session/page` 之后 `throughSeq` 是否变化**：官方由 `dsh-api-gateway` 的 `RemoteJournalStream`
   内部管理（`dsh-api-session-controller lib/types/client/transport.d.ts:61-76`），我没有读 gateway 实现。
   本扩展用「固定的开帧 cursor + 动态 `earliestSeq()` 作 `beforeSeq`」
   （`src/dsh/controller.ts:1788-1789`）是等价实现，但**官方侧是否同构**无法从已读代码确认。
5. **`assistant/attempt` 事件在轨迹里的角色**：`trajectory-assistant-step` 的 `match`
   （官方 `:832-835`）**不含** `assistant/attempt`；`fallbackState$1`（官方 `:742-758`）也只处理
   live-chunk / message / step-end。因此「commit 了 attempt 但没有 `assistant/message`」的步骤
   在轨迹里如何呈现，未能确认。
6. **`data-*` 属性是否为官方稳定契约**（供样式与测试挂钩）：JSX 里明确写了，
   但我没有找到声明它们是公开契约的文档；照抄属于「跟随实现」而非「跟随契约」。
7. `AssistantMetricDetail.usageProvided` / `outputTokens` 的**单位**没有注释；
   我从官方 `:7356-7357` 读出是 token 数，但注释未写。

---

## 分步实现计划

### S0 取基线

- 动作：`node build/command-e2e.mjs`（约 1 分钟）、`npm run preview` 留档。
- 文件：无改动。
- 依赖：无。风险：低。

### S1 契约落地（纯类型，零行为）

- 新建 `src/shared/trajectory.ts`：逐字照抄 `TrajectoryCellKind` / `TrajectoryCellProps` /
  `AssistantMetricDetail` / `TrajectorySourceBlock` / `TrajectoryContribution` 的本扩展等价类型
  （去掉 React / `HTMLAttributes` 依赖，保留全部可选性语义），并加
  `TrajectoryTurnModel` / `TrajectoryGroupModel` / `TrajectoryRequestNumber` / `TrajectoryUsage` /
  `TrajectoryTimelineMode` / `TrajectoryTimelineSpan`。
- 依据：`dsh-client-ui-trajectory lib/types/client/trajectory-record.d.ts:7-89`、
  `… trajectory-contract.d.ts:12-64`、`… layout.d.ts:10-19`、
  `… TrajectoryTable.d.ts:60-99`、`… timeline.d.ts:6-19`。
- 依赖：无。风险：低。

### S2 宿主折叠层（最大工作量，纯函数）

- 新建 `src/dsh/trajectory.ts`：`deriveTrajectoryLayout(events, opts)`、`deriveTrajectoryTimeline`、
  `trajectoryTimelineFocusIndexes`、`trajectoryPreviewText`、`trajectoryRecordId`。
- 逐条照抄（**不要重新设计**）：主循环 `dsh-client-ui-trajectory lib/client.js:6893-7210`
  （含 `:6968-7001` entries 排序、`:7002-7160` 各 kind 分支、`:7161-7199` partial/runningCalls、
  `:7200-7207` turn0 并入 turn1、`:7208` 挂 schema）；assistant 展开 `:7326-7393`；
  subtool 展开 `:7541-7595`；compaction cell `:7040-7071`；system cell `:7021-7038`；
  分组时长描述 `:7289-7316`；`summarizeCall` / `summarizeResult` / `detailResult` / `detailContent` /
  `detailReasoning` / `previewContent` `:7596-7638`；时间线 `:6226-6343`；预览 `:3646-3658`；
  记录身份 `:3568-3573`。
- `src/dsh/adapter.ts` 需提供输入：新增
  `trajectoryEvents(): SessionWireEvent[]`（`[...seen.values()]` 按 seq 排序）+
  `liveChunks(): AssistantLiveChunkEvent[]`（在 `applyAssistantStream`（`src/dsh/adapter.ts:1335` 起）里
  同时记**结构化** chunk 副本，而不是只累加成字符串）。
- 依赖：S1。风险：**高**。`expandAssistant` 的 `index` 推进、`withSubCalls` 的重编号（官方 `:7541-7559`）、
  `appendTrajectoryPartialLayout` 的索引偏移（官方 `:7219-7264`）三处互相自洽，抄错一处整本账本编号就乱。

### S3 补齐被丢弃的事件字段

- `src/dsh/adapter.ts:791` `applyEvent` 增加 case：`request/header`、`compaction/start`、`compaction/end`、
  `session/end-seed`、`step/end`、`tool/ptc-dispatch` / `tool/ptc-dispatch-start`、`agent/inbox/spliced`。
- **必须改 `src/dsh/adapter.ts:793`**：当前
  `if (event.surfaceOp && typeof event.surfaceOp === "object") return;`
  会把所有**表层替换**事件整条丢掉，系统提示词的替换历史因此拿不到。
  改成「允许轨迹折叠看到，聊天折叠仍按原规则忽略」——建议在该早退处只把事件转交轨迹收集器，
  **不要**直接删掉早退。
- 依赖：S1（可与 S2 并行）。风险：**高**。这一行同时被聊天区依赖；改错会让聊天区的注入节点重复或错位。

### S4 系统提示词 / 工具目录折叠（官方耦合最强处）

- 移植两个纯函数：
  - `inspectRequestPrompt`——官方实现 `dsh-client-ui-conversation lib/client.js:839-861`，
    契约 `dsh-client-ui-conversation lib/types/client/contract/request-inspection.d.ts:68-78`；
  - `inspectSystemPrompt`——官方实现 `dsh-client-ui-conversation lib/client.js:890-943`，
    契约 `dsh-client-ui-conversation lib/types/client/contract/system-prompt.d.ts:24-33`（六条规则）。
- 再照抄 `trajectory-request-header-definition`（官方 `:1171-1301`）与
  `trajectorySystemMessageDefinition`（官方 `:1184-1253`）的接线，以及
  `TrajectorySnapshotBuilder.snapshot()` 的 `headersByStep` / `representedPrompts` / `applyHeader` /
  `withRequestConfig` / `captureSchemas` / `indexTools`（官方 `:1424-1519`）。
- 依赖：S3（需要 `request/header` 被保留）。风险：**最高**。官方把这两个 inspector 放在
  `uiConversation` **服务**里（`dsh-client-ui-trajectory lib/types/client/trajectory-request-header-definition.d.ts:12-17`
  明说 client bundle 无法 value-import），必须自己实现；`uncertain`（窗口不完整时**故意不显示**提示词）
  与 `update` 语义最容易抄错。

### S5 线格式与状态

- `src/shared/ipc.ts`：加 `trajectory` 帧（建议整体 JSON 字符串，见 D.3 第 4 条）。
- `src/dsh/controller.ts`：在既有推帧点（`:1761`、`:1792`、`turn/end` 收尾后）推轨迹模型；
  `loadMore`（`:1750`）成功后重推；会话切换 / `messages/reset` 后重推。
- `src/webview/state.ts`：`AppState.trajectory` 改类型 + `reducer` 加 case；**删掉 `:228-239` 的 `useMemo`**。
- 依赖：S2（模型可用）。风险：中。

### S6 界面

- 重写 `src/webview/components/Panels.tsx:186-208` 的 `TrajectoryPanel` 为四件套；
  新建 `src/webview/components/Trajectory.tsx`，导出
  `TrajectoryToolbar` / `TrajectoryTimeline` / `TrajectoryTable` / `TrajectoryInspector`
  （对应官方四个模块）。
- 布局与交互照抄 §B.1–B.6；样式加进 `src/webview/styles/app.css`（照官方常量：
  eventColumn 122/50、kindSlot 76/19、toolbar 32px、timeline 50px/44px、
  details `clamp(320px,38%,440px)`、`--trajectory-tool-request-width` 与 58cqw 的联动）。
- 依赖：S5。风险：中。

### S7 文案

- `src/webview/texts.ts`：`Texts` 接口加 175 条（按 §C.1–C.15 的分区前缀命名，例如
  `trajectoryToolbarDuration`、`trajectoryKindSystem`…），`zh` / `en` 两本各补 175 条；
  §C.16 的带参 key 一律写成函数（本仓库硬规则：文案不许拼字符串，中英语序不同）。
- **不走 `@key` 标记**：这些文案全部在 webview 内部消费，直接读词典即可，
  因此 `scripts/i18n.test.ts` 的 `MARKERS` 清单**不需要**扩张。
  若 S5 决定让宿主发 `@key`，则必须同时改 `MARKERS` 与 `resolveText()`，否则 `scripts/i18n.test.ts`
  第 5 节（登记扫描）会炸。
- 依赖：S6（界面先定下需要哪些文案）。风险：低（量大；中英必须同批落地）。

### S8 测试与夹具

- 新建 `scripts/trajectory.test.ts`（**必须登记到 `esbuild.scripts.mjs` 的 `entries`**，
  否则 `npm test` 会静默不跑）。
- 用**真实日志**做夹具（复用 `scripts/sessionLog.ts` / `scripts/sessionLogScan.ts` 的读日志能力）；
  断言：kind 序列、`index` 连续性 `1..N`、turn/group 归属、timeline lane、`callSchemas` 命中。
- 更新 `test/preview.html` 夹具 + `scripts/previewFixture.test.ts`
  （AGENTS.md：夹具数据必须来自真实输出，不许编）。
- 依赖：S2（纯函数可先测）。风险：中。断言只钉确定的事实，
  不写会随机器负载飘的硬断言。

### 风险等级与依赖顺序

**最高风险排序**：S4（系统提示词 / 工具目录，官方服务内私有逻辑，语义最绕）
> S3（改 `src/dsh/adapter.ts:793` 会波及聊天区）
> S2（索引自洽的三处重编号）
> S5（`undefined` 丢键与 `null` 语义）
> S8 / S6 / S7。

**依赖顺序**：S1 → S2 →（S3 与 S4 可并行，但 **S4 依赖 S3** 保留 `request/header`）→ S5 → S6 → S7 → S8。
