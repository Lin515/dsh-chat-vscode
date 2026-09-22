/**
 * 投影摄入：**一个投影键一条登记** —— 形状读取（纯）+ 效果（控制器给的实现），
 * 以及三个调用点的入口（跟随开帧 / `session/control` 的 baseline / `projection` 增量帧）。
 *
 * ## 为什么是一张表而不是「读取表 + 控制器里的 switch」
 *
 * 这个仓库为「同一件事登记两处」付过两次代价：`@key` 的 `MARKERS` 清单（漏一处用户就看到
 * 裸 key）与 `serverExited` / `switchingServer` 那两条死文案。投影键若也拆成「读取表一处、
 * 效果 switch 一处」，就是第三次——而加一个键本来只需要**一条**。
 *
 * 于是：`ProjectionHandlers` 用映射类型把 15 个键写成必填，控制器实现它（少一个键
 * **编译不过**），`READERS` 同表提供解析。两条信息在同一个文件里对齐，加键时改一处。
 *
 * ## 分工
 *
 * - `ProjectionStore`（`dsh/projectionStore.ts`）：这个值**算不算数**（水位、清空），不认识键。
 * - `READERS`（本文件 + `dsh/projections.ts`）：线格式 → 视图值，纯函数，不认识控制器。
 * - `ProjectionHandlers`（控制器实现）：写 `SessionScope` 字段 + 发帧。它要发帧、要提交索引、
 *   要模型目录、要异步读设置——这些能力一个都不进 interface，全在控制器自己的闭包里。
 *
 * ## 清空（「能力缺失」）怎么落到界面
 *
 * `seed` / `truncate` 会清掉键，被清掉的键**同样派发一次**：`store.get` 是 `undefined`，
 * 读取器给出各自的「没有」（`todos` → `[]`、`goal` → `undefined`），且 `present` 为
 * `false`。所以每个效果都要自己回答「这个键没有值时该显示什么」——契约那句
 * 「a key the store has never seen reads `undefined` (capability absent)」的落地方式。
 * 注意有些键的口径是**刻意保留**（`contextPressure` 拿不到就保留旧值，占用条常驻），
 * 那类判断写在效果里，不在 store 里。
 */
import type { ChatState, GoalView, TodoView } from "../shared/chat";
import type { SessionFollowFrame } from "./protocol";
import type { SessionScope } from "./scope";
import type { ProjectionBlockWire } from "./projectionStore";
import {
  agentPresetFromProjection,
  contextBreakdownFromProjection,
  contextPressureFromProjection,
  goalFromProjection,
  imageLimitsFromProjection,
  modelSelectionFromProjection,
  permissionFromProjection,
  planModeFromProjection,
  sessionStatsFromProjection,
  subagentCatalogFromProjection,
  titleFromProjection,
  todosFromProjection,
  tokenUsageFromProjection,
  turnOutlineFromProjection,
  type ModelSelectionDecoded,
  type SubagentCatalogEntryView,
} from "./projections";

/**
 * 每个投影键解析出来的**视图值**（`READERS` 的函数签名就是它逐键对应的那一列）。
 *
 * 两个键的解码**故意留在效果那一半**，因此这里是透传/半成品：
 * - `inbox` → 原样透传：折算成队列项要查「这项是谁提交的」（`submissions` 索引），
 *   那是控制器知识，见 `controller.ingestInboxProjection`；
 * - `subagentCatalog` → 只有投影自己的字段（目录条），与已注册条目**并入**（保留 `activity`）
 *   是效果那一半的事，见 `controller.mergeSubagentEntries` 与 `projections.upsertSubagent`。
 */
export interface ProjectionViewMap {
  /** `inbox` 投影的原始值（两条队列通道之一，折算见 `dsh/queueView.ts`）。 */
  inbox: unknown;
  /** `modelSelection`：`next ?? lastUsed` 取出的原始选择（不含目录查找）。 */
  modelSelection: ModelSelectionDecoded | undefined;
  /** `permissions`：当前权限预设（`options` 没有消费点，不解析）。 */
  permissions: string | undefined;
  /** `plan`：生效状态 = `pending ? !active : active`。 */
  plan: boolean;
  /** `todos`：待办列表（`null` / 坏值 → 空表）。 */
  todos: TodoView[];
  /** `contextPressure`：三个可选水位。 */
  contextPressure: ReturnType<typeof contextPressureFromProjection>;
  /** `tokenUsage`：四桶累计（永远给得出完整对象）。 */
  tokenUsage: NonNullable<ChatState["tokenUsage"]>;
  /** `turnOutline`：轮次大纲（承重字段坏的整条丢弃）。 */
  turnOutline: NonNullable<ChatState["turnOutline"]>;
  /** `imageLimits`：图片准入上限。 */
  imageLimits: NonNullable<ChatState["imageLimits"]>;
  /** `title`：会话标题（没有就是 `undefined`）。 */
  title: string | undefined;
  /** `contextBreakdown`：上下文构成（三字段全有或全无）。 */
  contextBreakdown: NonNullable<ChatState["contextBreakdown"]> | undefined;
  /** `sessionStats`：全日志墙钟统计（`llmMs`/`toolMs` 是承重字段）。 */
  sessionStats: NonNullable<ChatState["sessionStats"]> | undefined;
  /** `subagentCatalog`：投影目录条（与已注册条目的并入见 `controller.mergeSubagentEntries`）。 */
  subagentCatalog: SubagentCatalogEntryView[];
  /** `goal`：目标条数据（嵌套形状，轮次计数在外层）。 */
  goal: GoalView | undefined;
  /** `agentPreset`：本会话运行的预设 id（空会话可以换，换过之后 header 不再代表它）。 */
  agentPreset: string | undefined;
}

/** 本扩展**消费**的投影键。契约里其余的键（`schedule` / `subagent` …）不在这里。 */
export type ProjectionKey = keyof ProjectionViewMap;

/**
 * 每个键的**效果**：写 `SessionScope` 的字段、发帧。
 *
 * 映射类型 ⇒ 少一个键编译不过；这就是「加一个投影键 = 改一处」的强制手段。
 *
 * 两个参数要分清楚：
 * - `value` 是该键解析后的视图值；
 * - `present` 是**这个键此刻在不在 store 里**（`false` = 能力缺失／被 baseline 清掉了）。
 *
 * `present` 必须单独给：读取器对「没有值」的容忍度各不相同——`todos` 给空表、
 * `tokenUsage` 给四个 0（它本来永远给得出完整对象），后者照原样发出去就成了
 * 「用量显示为 0」而不是「用量未知」。哪个键「没有值」时该清空、该保留、该回落默认，
 * 只有效果那一半答得出来。
 */
export type ProjectionHandlers = {
  [K in ProjectionKey]: (scope: SessionScope, value: ProjectionViewMap[K], present: boolean) => void;
};

/**
 * 键 → 形状读取器。**纯函数**：只吃线格式的原始值，不碰控制器、不碰 scope。
 * 有依赖的那两处（`inbox` 的提交索引、`subagentCatalog` 与 RPC 行的合并）在效果那一半。
 */
const READERS: { [K in ProjectionKey]: (value: unknown) => ProjectionViewMap[K] } = {
  inbox: (value) => value,
  modelSelection: modelSelectionFromProjection,
  permissions: permissionFromProjection,
  plan: planModeFromProjection,
  todos: todosFromProjection,
  contextPressure: contextPressureFromProjection,
  tokenUsage: tokenUsageFromProjection,
  turnOutline: turnOutlineFromProjection,
  imageLimits: imageLimitsFromProjection,
  title: titleFromProjection,
  contextBreakdown: contextBreakdownFromProjection,
  sessionStats: sessionStatsFromProjection,
  subagentCatalog: subagentCatalogFromProjection,
  goal: goalFromProjection,
  agentPreset: agentPresetFromProjection,
};

/**
 * 本扩展消费的全部投影键（运行时形态）。
 *
 * 断言用它跟**契约那份清单**对拍（`scripts/projectionIngest.test.ts`）：契约里新增一个
 * 客户端可见的键时，这张表要么补上、要么在测试里显式登记「有意不消费」——不允许静默漏掉。
 */
export const PROJECTION_KEYS = Object.keys(READERS) as ProjectionKey[];

/** 这个键本扩展认不认（不认的键仍然会进 store，只是没有效果）。 */
export function isProjectionKey(key: string): key is ProjectionKey {
  return Object.hasOwn(READERS, key);
}

/** 一个键的原始值 → 视图值。未知键返回 `undefined`。 */
export function readProjection(key: string, value: unknown): unknown {
  return isProjectionKey(key) ? READERS[key](value) : undefined;
}

/**
 * 派发一个键的效果：**从 store 读最终值**再解析。
 *
 * 「读 store 而不是读传进来的参数」是有意的：baseline 那条路上（先 truncate 再 seed）
 * 同一个键可能先被清掉再被重新播种，读最终状态能保证**只派发一次、且派发的是终值**。
 */
function dispatch(handlers: ProjectionHandlers, scope: SessionScope, key: ProjectionKey): void {
  const value = READERS[key](scope.projections.get(key)) as never;
  handlers[key](scope, value, scope.projections.has(key));
}

/**
 * 一个投影值进来（`projection` 增量帧，或跟随开帧里的某一个键）。
 *
 * 未知键**照样入 store**（store 不认识键，只认水位），但不派发效果——「插件没加载 =
 * 能力缺失，不是错误」，这条口径与改造前一致。
 *
 * @param seq 线格式带的水位；拿不到就传 `undefined`（见 `ProjectionStore.apply`）
 * @returns 这个值是否被接受（陈旧/重放的帧返回 `false`）
 */
export function ingestProjection(
  handlers: ProjectionHandlers,
  scope: SessionScope,
  key: string,
  value: unknown,
  seq?: number,
): boolean {
  if (!scope.projections.apply(key, value, seq)) return false;
  if (isProjectionKey(key)) dispatch(handlers, scope, key);
  return true;
}

/** baseline 块里的 `values`（形状不对就是空的）。 */
function blockValues(block: ProjectionBlockWire | undefined): Record<string, unknown> {
  return block?.values && typeof block.values === "object"
    ? (block.values as Record<string, unknown>)
    : {};
}

/** 块里的截止水位；不是有限数就是「没有」（此时一律不做新旧比较、也不清空）。 */
function blockCut(block: ProjectionBlockWire | undefined): number | undefined {
  return typeof block?.asOfSeq === "number" && Number.isFinite(block.asOfSeq) ? block.asOfSeq : undefined;
}

/**
 * **跟随开帧**的 `projections` 块：逐个键 `apply`（水位 = 块的 `asOfSeq`）。
 *
 * 与下面 baseline 那条路的差别是**有意照抄官方**的：跟随开帧的官方做法就是逐键
 * `store.apply(key, values[key], block.asOfSeq)`（`manager.js` 的 snapshot 分支），
 * **不清空**块里没带的键。
 *
 * @returns 被改动的键
 */
export function ingestFollowSnapshot(
  handlers: ProjectionHandlers,
  scope: SessionScope,
  block: ProjectionBlockWire | undefined,
): ProjectionKey[] {
  const cut = blockCut(block);
  const touched: ProjectionKey[] = [];
  for (const [key, value] of Object.entries(blockValues(block))) {
    if (scope.projections.apply(key, value, cut) && isProjectionKey(key)) touched.push(key);
  }
  for (const key of touched) dispatch(handlers, scope, key);
  return touched;
}

/**
 * **`session/control` 的替换型 baseline**：`truncate` + `seed`，块里没带的键清掉。
 *
 * 官方的顺序是 `truncate(asOfSeq)` → `seed({asOfSeq, values})`：
 * - `truncate` 先丢掉比这个 cut **新**的行——它们描述的是 Host 在持久化之前丢掉的进程
 *   状态，留着会永远压过重算出来的低水位值（换服务器时尤其重要）；
 * - `seed` 再按同一个 cut 落地块里的值、清掉块里没带且不新的行。
 *
 * 拿不到 `asOfSeq` 时**退化成逐键 apply、不清空**（没有「截至哪一刻」这个前提，
 * 清空就是凭猜动手）——真实 baseline 到底带不带它，见 `scripts/projectionSeqProbe.ts`。
 *
 * @returns 被改动或被清掉的键
 */
export function ingestControlBaseline(
  handlers: ProjectionHandlers,
  scope: SessionScope,
  block: ProjectionBlockWire | undefined,
): ProjectionKey[] {
  const cut = blockCut(block);
  if (cut === undefined) return ingestFollowSnapshot(handlers, scope, block);
  const touched = new Set<string>([
    ...scope.projections.truncate(cut),
    ...scope.projections.seed(block),
  ]);
  const keys = [...touched].filter(isProjectionKey);
  for (const key of keys) dispatch(handlers, scope, key);
  return keys;
}

/**
 * 跟随开帧的处理顺序：**先让适配器回放历史记录，再铺开投影值**。
 *
 * 顺序反了会让历史里最后一个事件把折叠值覆盖回旧状态——`plan` 是活例：轮次进行中发出的
 * `/plan` 只留下 `pending`，日志里没有对应的 `plan/mode`，回放末尾那条旧的 `plan/mode`
 * 会把界面上的计划模式关掉，每次重开会话都复现。
 *
 * 抽成函数只为**可断言**：以前这条顺序只能靠正则去 `controller.ts` 里比两个 `indexOf` 的
 * 大小（`scripts/projections.test.ts`），而那是「测试面是文件字符」的典型——换行、提取、
 * 改名都会打碎它，失败信息还指向错误的方向。
 */
export function replayFollowSnapshot(
  frame: SessionFollowFrame | undefined,
  adapter: { applyFrame(frame: SessionFollowFrame): void },
  applyProjections: (block: ProjectionBlockWire | undefined) => void,
): void {
  adapter.applyFrame(frame as SessionFollowFrame);
  if (frame?.type === "snapshot") applyProjections(frame.projections);
}
