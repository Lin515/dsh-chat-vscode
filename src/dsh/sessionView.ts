/**
 * 「一个会话在界面上的状态」的**唯一生产者**。
 *
 * 这一组字段以前被写了三遍：首帧快照（`ChatController.snapshotFor`）、增量 patch
 * （投影 / 队列 / 历史分页那十几条 `deliver`）、以及切会话时的整份状态帧。三份各写
 * 各的，加一个字段只改其中一处的后果不是「少了个功能」，而是**那个字段在切换会话后
 * 静默复旧或丢失**——`goal` 清不掉（用户 2026-09-12 报的现场）与
 * 「『加载更早』永久卡死」都是同一族：该清空的键没进快照，界面就停在旧值上。
 *
 * 现在：
 * - **字段清单只在这一个文件里**：`SessionView` 接口 + `SESSION_VIEW_KEYS` 声明顺序
 *   （声明顺序 = 帧里键的顺序，与原快照逐字一致，避免无意义的过线差异）；
 * - **`SESSION_FIELDS` 是唯一的字段表**：每个键的类型与 undefined→null 的折返都在
 *   那一条里（`wireOf`）。加字段只改这一处，`SessionViewSource` 会强制三个调用点
 *   都给出取值，因为它是 `Record<keyof SessionView, ...>`（少一个键编译不过）；
 * - 三个生产者各调一个入口：快照与切会话帧调 `sessionView(source)`（全字段），
 *   增量 patch 调 `sessionPatch(source, 变了的键)`（键仍是同一张表产出的）。
 *
 * 线格式（`shared/wire.ts`）：宿主 → webview 的帧是 JSON 过的，值为 `undefined` 的键
 * 会被整条丢掉，所以「清空」必须发 `null`。三处调用点以前各自记着这件事（漏一处就是
 * 静默失效），现在折返只在 `wireOf` 里做一次。
 */
import type { ChatState } from "../shared/chat";
import type { SessionScope } from "./scope";
import type { SessionAdapter } from "./adapter";

/**
 * 会话在界面上的状态片段（`ChatState` 的一个结构子集，键名逐字与线格式一致）。
 *
 * 字段从哪来（三条生产者都读同一份来源，见 `SessionViewSource`）：
 * - `session` —— `sessions` 列表里该会话的摘要（`SessionSummaryView`）；
 * - `messages` / 粘性显示值 / `fileKinds` / `hasMoreHistory` —— 会话适配器；
 * - `running` / `historyLoading` / 队列 / 投影解析值 —— 会话域（`SessionScope`）。
 *
 * **`attachments` / `draft` 刻意不在里面**：它们按「窗口」（未绑会话时）或会话键存，
 * 由输入区那条链单独维护，与「一次会话切换要整份换掉的状态」不是同一件事。
 */
export interface SessionView {
  session?: ChatState["session"];
  messages: ChatState["messages"];
  running: ChatState["running"];
  queueItems: ChatState["queueItems"];
  models: ChatState["models"];
  model?: ChatState["model"];
  permission?: ChatState["permission"];
  planMode: ChatState["planMode"];
  todos: ChatState["todos"];
  /**
   * 子代理目录。
   *
   * 名字与界面状态字段**逐字相同**（此前宿主叫 `subagents`、界面读 `subagentEntries`，
   * 两个名字指同一件事，改一侧忘另一侧没有任何编译期或断言保护——见
   * `docs/audit-summary.md` B7）。统一取界面侧那个名字：它是这条数据在**视图模型**里
   * 的名字，线格式跟着视图模型走，跨名桥就没有存在的理由。
   */
  subagentEntries: ChatState["subagentEntries"];
  jobs: ChatState["jobs"];
  goal?: ChatState["goal"];
  contextWindow?: ChatState["contextWindow"];
  contextOccupancy?: ChatState["contextOccupancy"];
  lastSpeed?: ChatState["lastSpeed"];
  fileKinds?: ChatState["fileKinds"];
  hasMoreHistory: ChatState["hasMoreHistory"];
  historyLoading: ChatState["historyLoading"];
  contextBreakdown?: ChatState["contextBreakdown"];
  sessionStats?: ChatState["sessionStats"];
  tokenUsage?: ChatState["tokenUsage"];
  turnOutline?: ChatState["turnOutline"];
  imageLimits?: ChatState["imageLimits"];
}

/**
 * 会话状态片段的取值来源。
 *
 * 刻意是**一整份**（`Record<keyof SessionView, ...>` 而不是 `Partial<...>`）：
 * 加一个字段到 `SessionView` 时，这份来源类型会立刻要求它有一个取值处——不认识
 * 新键的调用点**编译不过**，不会出现「三个生产者里只有一个知道新字段」。
 *
 * 字段都是 getter 风格（`() => 值`）而不是值：`sessionView(read-all)` 会给每一项求值，
 * `sessionPatch(只取变了的键)` 则只碰用到的那几个——同一个来源对象可以同时服务两条路。
 */
export type SessionViewSource = Record<keyof SessionView, () => unknown>;

/**
 * `SessionView` 的键，顺序 = 帧里键的顺序（与原 `snapshotFor` 逐字一致）。
 *
 * 类型写成 `readonly (keyof SessionView)[]`：多写一个不存在的键**编译不过**；
 * 少写一个键则由下面的 `SESSION_FIELDS` 抓（`Record<SessionViewKey, ...>` 缺键报错）。
 */
export const SESSION_VIEW_KEYS = [
  "session",
  "messages",
  "running",
  "queueItems",
  "models",
  "model",
  "permission",
  "planMode",
  "todos",
  "subagentEntries",
  "jobs",
  "goal",
  "contextWindow",
  "contextOccupancy",
  "lastSpeed",
  "fileKinds",
  "hasMoreHistory",
  "historyLoading",
  "contextBreakdown",
  "sessionStats",
  "tokenUsage",
  "turnOutline",
  "imageLimits",
] as const satisfies readonly (keyof SessionView)[];

/** 键清单里那个「字段名」的类型（`SESSION_VIEW_KEYS` 与字段表必须键集相同）。 */
export type SessionViewKey = (typeof SESSION_VIEW_KEYS)[number];

/**
 * 一个字段的两件事：**取值**（`read`，可缺省来源 = 「这一处没有值」）与**类型**
 * （`_type`，只用于编译期核对；永远不赋值）。
 *
 * `read` 收的是 `Partial<TSource>`：patch 那条路只给变了的字段，取不到的一律当
 * `undefined`；全字段构造器给的是完整来源。返回值再经 `wireOf` 折成 `null`——
 * **折返只写在这一条流水线里**（三处调用点不必各自记得）。
 */
export interface WireField<TSource, TValue> {
  readonly _type?: TValue;
  readonly read: (source: Partial<TSource>) => TValue | undefined;
}

/** 过线前的折返：`undefined` → `null`（见文件头与 `shared/wire.ts`）。 */
export function wireOf<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

/**
 * 一张字段表的完整形状：键集与视图类型逐字相同（缺一个键编译不过）。
 *
 * 泛型放在这里而不是字段定义里：`Record<keyof TView, ...>` 让「往视图加字段」与
 * 「往表加字段」变成**同一件事**，三个调用点不可能只知道其中一部分。
 */
type FieldTable<TView, TSource> = {
  readonly [K in keyof TView]: WireField<TSource, TView[K]>;
};

/** `SESSION_FIELDS` 的完整形状（键集 = `SessionView`）。 */
type SessionFields = FieldTable<SessionView, SessionViewSource>;

/**
 * **唯一的会话字段表**：字段名、类型、取值、折返都在这里。
 *
 * `satisfies SessionFields`（而不是 `: SessionFields`）保住了每个字段的具体类型，
 * 于是 `sessionPatch` 能报出「这个键的值类型」；同时它又强制这张表**键集完整**——
 * 往 `SessionView` 加一个字段而不加一条，编译不过。
 */
export const SESSION_FIELDS = {
  session: {
    read: (source) => source.session?.() as SessionView["session"],
  },
  messages: {
    read: (source) => (source.messages?.() ?? []) as SessionView["messages"],
  },
  running: {
    read: (source) => (source.running?.() ?? false) as SessionView["running"],
  },
  queueItems: {
    read: (source) => (source.queueItems?.() ?? []) as SessionView["queueItems"],
  },
  models: {
    read: (source) => (source.models?.() ?? []) as SessionView["models"],
  },
  model: {
    read: (source) => source.model?.() as SessionView["model"],
  },
  permission: {
    read: (source) => source.permission?.() as SessionView["permission"],
  },
  planMode: {
    read: (source) => (source.planMode?.() ?? false) as SessionView["planMode"],
  },
  todos: {
    read: (source) => (source.todos?.() ?? []) as SessionView["todos"],
  },
  subagentEntries: {
    read: (source) => (source.subagentEntries?.() ?? []) as SessionView["subagentEntries"],
  },
  jobs: {
    read: (source) => (source.jobs?.() ?? []) as SessionView["jobs"],
  },
  goal: {
    read: (source) => source.goal?.() as SessionView["goal"],
  },
  contextWindow: {
    read: (source) => source.contextWindow?.() as SessionView["contextWindow"],
  },
  contextOccupancy: {
    read: (source) => source.contextOccupancy?.() as SessionView["contextOccupancy"],
  },
  lastSpeed: {
    read: (source) => source.lastSpeed?.() as SessionView["lastSpeed"],
  },
  fileKinds: {
    read: (source) => source.fileKinds?.() as SessionView["fileKinds"],
  },
  // 三个布尔原来在快照里就写死了 `?? false`（线格式里它们是必填），保留同一口径
  hasMoreHistory: {
    read: (source) => (source.hasMoreHistory?.() ?? false) as SessionView["hasMoreHistory"],
  },
  historyLoading: {
    read: (source) => (source.historyLoading?.() ?? false) as SessionView["historyLoading"],
  },
  contextBreakdown: {
    read: (source) => source.contextBreakdown?.() as SessionView["contextBreakdown"],
  },
  sessionStats: {
    read: (source) => source.sessionStats?.() as SessionView["sessionStats"],
  },
  tokenUsage: {
    read: (source) => source.tokenUsage?.() as SessionView["tokenUsage"],
  },
  turnOutline: {
    read: (source) => source.turnOutline?.() as SessionView["turnOutline"],
  },
  imageLimits: {
    read: (source) => source.imageLimits?.() as SessionView["imageLimits"],
  },
} satisfies SessionFields;

/** 会话状态片段：全字段，值已按线格式折返（`undefined` → `null`）。 */
export type WireSessionView = { readonly [K in keyof SessionView]: SessionView[K] | null };

/**
 * `ChatState` 的**线格式**形态：每个键允许 `null`（= 过线时的「清空这个键」）。
 *
 * 形状与 `shared/wire.ts` 的 `WireState` / `WirePatch` 同源，只是这里只需要一个
 * **快照**类型给 `snapshotFor` 用（那边还需要逐帧的联合类型）。`null` 只在过线语义
 * 里有意义：调用方拿到的 `ChatState`（界面侧）永远是折回 `undefined` 之后的。
 */
export type WireChatState = { readonly [K in keyof ChatState]: ChatState[K] | null };

/**
 * **全字段**构造器：首帧快照与「切会话」的整份状态帧都用它。
 *
 * 键集恒等于 `SESSION_VIEW_KEYS`（与来源给没给无关）：JSON 过线时值为 `null` 的键
 * 会留下，界面侧 `mergeWirePatch` 再折回「键不存在」——这正是「清空上一会话残留」
 * 的机制（`goal` 清不掉的根因就是有些键压根没发）。
 */
export function sessionView(source: SessionViewSource): WireSessionView {
  const out: Record<string, unknown> = {};
  for (const key of SESSION_VIEW_KEYS) {
    out[key] = wireOf(SESSION_FIELDS[key].read(source));
  }
  return out as WireSessionView;
}

/**
 * **只取列出的键**的增量 patch（`WirePatch` 的直接入参）。
 *
 * 键仍然来自同一张字段表：patch 与快照的字段名、折返口径不可能漂。`keys` 用
 * `Pick<SessionView, K>` 约束，写错字段名或值类型编译不过。
 */
export function sessionPatch<K extends keyof SessionView>(
  source: Partial<SessionViewSource>,
  keys: readonly K[],
): Pick<WireSessionView, K> {
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = wireOf(SESSION_FIELDS[key].read(source));
  return out as Pick<WireSessionView, K>;
}

/**
 * 全局外观态（**与会话无关**的那几项：语言、diff 排版、字号、问卷批次、过程折叠阈值、
 * 运行中发送行为）。
 *
 * 与 `SessionView` 同一个来源形态与同一条折返流水线；它填的是首帧快照里属于部署/窗口
 * 设置的那一半。刻意与 `SessionView` 分开：会话切换时它们**不变**，混在一起会让
 * 「切会话要清掉哪些键」变得不可读。
 */
export interface AppearanceView {
  locale?: ChatState["locale"];
  diffLayout?: ChatState["diffLayout"];
  fontSizePx?: ChatState["fontSizePx"];
  questionBatch?: ChatState["questionBatch"];
  turnProcessThreshold?: ChatState["turnProcessThreshold"];
  busyEnter?: ChatState["busyEnter"];
}

export type AppearanceViewSource = Record<keyof AppearanceView, () => unknown>;

export const APPEARANCE_VIEW_KEYS = [
  "locale",
  "diffLayout",
  "fontSizePx",
  "questionBatch",
  "turnProcessThreshold",
  "busyEnter",
] as const satisfies readonly (keyof AppearanceView)[];

export type AppearanceViewKey = (typeof APPEARANCE_VIEW_KEYS)[number];

type AppearanceFields = FieldTable<AppearanceView, AppearanceViewSource>;

export const APPEARANCE_FIELDS = {
  locale: { read: (source) => source.locale?.() as AppearanceView["locale"] },
  diffLayout: { read: (source) => source.diffLayout?.() as AppearanceView["diffLayout"] },
  fontSizePx: { read: (source) => source.fontSizePx?.() as AppearanceView["fontSizePx"] },
  questionBatch: { read: (source) => source.questionBatch?.() as AppearanceView["questionBatch"] },
  turnProcessThreshold: {
    read: (source) => source.turnProcessThreshold?.() as AppearanceView["turnProcessThreshold"],
  },
  busyEnter: { read: (source) => source.busyEnter?.() as AppearanceView["busyEnter"] },
} satisfies AppearanceFields;

export type WireAppearanceView = {
  readonly [K in keyof AppearanceView]: AppearanceView[K] | null;
};

/** 外观态的全字段构造器（首帧快照用；配置热更新那条 patch 仍走 `refreshAppearance`）。 */
export function appearanceView(source: AppearanceViewSource): WireAppearanceView {
  const out: Record<string, unknown> = {};
  for (const key of APPEARANCE_VIEW_KEYS) out[key] = wireOf(APPEARANCE_FIELDS[key].read(source));
  return out as WireAppearanceView;
}

/**
 * 会话域 + 适配器 → `SessionViewSource` 的**唯一读法**。
 *
 * 值全部来自这两处，控制器不再在别处拼一份（`?? []` / `?? false` 这类默认值也只在
 * `SESSION_FIELDS` 里）：`adapter` 缺失（域刚建、follow 还没开窗）时给出与原来快照
 * 逐字相同的兜底（空消息、空表、无粘性值、`hasMoreHistory: false`）。
 *
 * 两个例外**不是会话域的东西**，由调用方补进这一份来源（都是控制器持有的全局值）：
 * - `models` 是**模型目录**（跨会话共享，来自 `models` 帧 / 首帧）；
 * - `session` 是会话列表里的那一行摘要（域本身只有 id）。
 */
export function sessionSourceOf(
  scope: SessionScope | undefined,
  session: SessionView["session"],
  models: SessionView["models"],
): SessionViewSource {
  const adapter: SessionAdapter | undefined = scope?.adapter;
  return {
    session: () => session,
    messages: () => adapter?.snapshotMessages(),
    running: () => scope?.running,
    queueItems: () => scope?.queueItems,
    models: () => models,
    model: () => scope?.model,
    permission: () => scope?.permission,
    planMode: () => scope?.planMode,
    todos: () => scope?.todos,
    subagentEntries: () => scope?.subagentEntries,
    jobs: () => scope?.jobs,
    goal: () => scope?.goal,
    // 粘性显示值（上下文窗口 / 占用 / 速度）由适配器持有
    contextWindow: () => adapter?.stickyState().contextWindow,
    contextOccupancy: () => adapter?.stickyState().contextOccupancy,
    lastSpeed: () => adapter?.stickyState().lastSpeed,
    fileKinds: () => adapter?.fileKindsState(),
    hasMoreHistory: () => adapter?.hasMoreHistory(),
    historyLoading: () => scope?.historyLoading,
    contextBreakdown: () => scope?.contextBreakdown,
    sessionStats: () => scope?.sessionStats,
    tokenUsage: () => scope?.tokenUsage,
    turnOutline: () => scope?.turnOutline,
    imageLimits: () => scope?.imageLimits,
  };
}
