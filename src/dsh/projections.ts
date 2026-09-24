/**
 * 投影值的形状解析（纯函数，便于离线断言）。
 *
 * 抽出来的理由很直接：`goal` 与 `subagentCatalog` 两个 bug 都是**形状读错**——
 * 按猜测的字段写、没有契约核对、也没有断言，于是「恒为空」这种失败在界面上
 * 表现为「这个功能没有」，而不是报错（docs/audit-summary.md「goal 投影嵌套形状读错」
 * 形状解析是这一层里最容易错、又最容易测的部分，所以从控制器里挪出来单测。
 */
import type { ChatState, GoalView, SubagentView, TodoView } from "../shared/chat";

/**
 * `goal` 投影 → 目标条数据。
 *
 * 线格式是**嵌套**的（`GoalProjection`，`dsh-goal/lib/types/types.d.ts`）：
 * ```
 * { goal: { id, revision, objective, phase, blockedReason?, maxGoalRounds },
 *   roundsStarted, createdAt, updatedAt }
 * ```
 * 注意轮次计数在**外层**：`roundsStarted` 不属于 `goal` 本体。
 * 没有目标时投影值是 `null`。
 */
export function goalFromProjection(value: unknown): GoalView | undefined {
  const projection = value as { goal?: unknown; roundsStarted?: unknown } | null | undefined;
  const goal = projection?.goal as
    | {
        id?: unknown;
        revision?: unknown;
        objective?: unknown;
        phase?: unknown;
        blockedReason?: { message?: unknown } | null;
        maxGoalRounds?: unknown;
      }
    | null
    | undefined;
  if (!goal || typeof goal.objective !== "string" || !goal.objective) return undefined;
  const phase = goal.phase;
  return {
    id: typeof goal.id === "string" ? goal.id : undefined,
    revision: typeof goal.revision === "number" ? goal.revision : undefined,
    objective: goal.objective,
    // 词表外的 phase 一律当 active：界面有标签可显示，不至于整条不渲染
    phase: phase === "paused" || phase === "blocked" || phase === "complete" ? phase : "active",
    rounds: typeof projection?.roundsStarted === "number" ? projection.roundsStarted : 0,
    maxRounds: typeof goal.maxGoalRounds === "number" ? goal.maxGoalRounds : undefined,
    blockedReason:
      typeof goal.blockedReason?.message === "string" ? goal.blockedReason.message : undefined,
  };
}

/**
 * `plan` 投影 → 「计划模式是否生效」。
 *
 * 投影是 `{ active, pending }`（`dsh-plan-mode/lib/types/types.d.ts`）：
 * `active` 是**已落日志**的状态（最后一条 `plan/mode`），`pending` 表示有一次
 * `/plan` 选择指向与 `active` 不同的目标、且还没有 `plan/mode` 记录它。
 * 所以**生效**状态是 `pending ? !active : active`（等价于 `active !== pending`）。
 *
 * 只读 `active` 会在**轮次进行中**点「进入计划模式」时立刻出错：那一刻服务端返回
 * 「Entering plan mode (applies from the next step).」，`active` 仍为 false，于是
 * 按钮看起来毫无反应——用户会再点一次，而契约里对同一目标重复选择是 no-op。
 * 官方 chip 用的就是这个表达式（`dsh-client-ui-plan/lib/client.js:47`）。
 */
export function planModeFromProjection(value: unknown): boolean {
  const projection = value as { active?: unknown; pending?: unknown } | null | undefined;
  const active = Boolean(projection?.active);
  const pending = Boolean(projection?.pending);
  return pending ? !active : active;
}

/**
 * `subagentCatalog` 投影 → 子代理列表。
 *
 * 投影值是 `SubagentCatalogEntry[]` = `{id, createdAt, mode, label?}`——**没有**
 * `kind`/`activity`（那两个字段属于 `subagents/list` 的 RPC 行 `SubagentListEntry`）。
 * 把 RPC 行的 `kind === "child"` 过滤套在投影上会让目录恒为空。
 *
 * 投影也不携带驻留状态，所以 `known`（上一次 RPC 列表）里同 id 的 `activity`
 * 原样保留；不知道就不下发——界面据此不画状态点，而不是猜「正在运行」。
 *
 * @param value 投影值（数组）。
 * @param known 上一次已知的列表，用于保留 activity。
 */
export function subagentCatalogFromProjection(value: unknown): SubagentCatalogEntryView[] {
  const entries = Array.isArray(value) ? value : [];
  return entries.map((entry) => {
    const child = entry as { id?: unknown; mode?: unknown; label?: unknown };
    const id = String(child.id ?? "");
    return {
      id,
      label: typeof child.label === "string" && child.label ? child.label : id,
      // `SubagentCatalogEntry` 是判别联合：continuable 必带 label，one-shot 的 label 可省。
      // 0.1.7-alpha.1 起还多一个 `{mode:'unknown', label?}`（认不出模式的候选）。认不出就按
      // one-shot 处理——拿它去 follow 不会被鉴权拒绝，反过来会；界面据此显示「一次性」，
      // 比显示成「持续」（点开会 `subagent/unauthorized`）安全。
      mode: child.mode === "continuable" ? ("continuable" as const) : ("one-shot" as const),
    };
  });
}

/** 投影目录一条（**没有** `activity`：投影里根本没这个字段）。 */
export type SubagentCatalogEntryView = Pick<SubagentView, "id" | "label" | "mode">;

/**
 * `subagents/list` RPC 行 → 子代理列表（**旧服务端专用**：该端点在 0.1.7-alpha.1 被删除）。
 *
 * 这里是 `SubagentListEntry`：`kind:'child'` 才是可用子代理，`kind:'diagnostic'`
 * 是「有候选但读不出身份」的诊断行。与投影不同，这一路**带** `activity`/`mode`。
 * 新服务端上没有这个端点（`controller.endpointAbsent` 会把 404 记成「这一版没有」）。
 */
export function subagentsFromList(value: unknown): SubagentView[] {
  const entries = Array.isArray(value) ? value : [];
  return entries
    .filter((entry) => (entry as { kind?: unknown })?.kind === "child")
    .map((entry) => {
      const child = entry as { id?: unknown; activity?: unknown; label?: unknown; mode?: unknown };
      const id = String(child.id ?? "");
      return {
        id,
        label: typeof child.label === "string" && child.label ? child.label : id,
        mode: child.mode === "continuable" ? ("continuable" as const) : ("one-shot" as const),
        activity: child.activity === "running" ? ("running" as const) : ("inactive" as const),
      };
    });
}

/**
 * `subagent/catalog` **durable 事件** → 目录一条（子代理「注册」的形状读取）。
 *
 * 这是第三种形状，别和上面两种混：
 * ```
 * { version: 0, childId, childCreatedAt, mode, label? }   // SubagentCatalogEvent
 * ```
 * 父会话在子级建立成功时追加它（`dsh-subagent` 的 `establishCatalogChild`），
 * 所以**跟随流里就能拿到**——不必等 RPC，也不必等投影。
 *
 * 两条纪律：
 * - `version !== 0` 或 `childId` 空 → `undefined`（认不出的版本**不猜**，交给 RPC 那条完整路兜）；
 * - **不设 `activity`**：事件里没有这个字段，状态由 `api-session/status` 中继或 RPC 给。
 */
export function subagentFromCatalogEvent(value: unknown): SubagentView | undefined {
  const event = value as { version?: unknown; childId?: unknown; mode?: unknown; label?: unknown } | null | undefined;
  if (event?.version !== 0) return undefined;
  const id = typeof event.childId === "string" ? event.childId : "";
  if (!id) return undefined;
  return {
    id,
    label: typeof event.label === "string" && event.label ? event.label : id,
    mode: event.mode === "continuable" ? "continuable" : "one-shot",
  };
}

/**
 * 把一条目录**并入**列表（注册语义：只增不删）。
 *
 * 三种来源（durable 事件 / 投影 / RPC）都走这里，区别只在 activity：
 * 同 id 时更新 `label`/`mode` 并**保留已知的 `activity`**（新来源没带状态时不能把
 * 已知结论抹成「不知道」）；新 id 追加到末尾，顺序就是发现顺序。
 *
 * 为什么不是整表替换：子代理会话只增不删，而三种来源的**完整度不同**——进程外
 * provider 不写 `subagent/catalog`，投影里就没有它们；拿投影整表替换会把 RPC 刚拿到的
 * 那些行丢掉（每次投影刷新都丢，直到下一次 RPC）。
 */
export function upsertSubagent(entries: readonly SubagentView[], entry: SubagentView): SubagentView[] {
  const index = entries.findIndex((item) => item.id === entry.id);
  if (index < 0) return [...entries, entry];
  const next = entries.slice();
  const previous = entries[index]!;
  next[index] = {
    ...previous,
    ...entry,
    ...(entry.activity === undefined && previous.activity !== undefined
      ? { activity: previous.activity }
      : {}),
  };
  return next;
}

/**
 * 一条子代理的驻留状态变化（`api-session/status` 中继）→ 新的列表。
 *
 * 与 `upsertSubagent` 分开是**有意的**：状态是**就地覆盖**的一条，不碰 label/mode；
 * 找不到这个 id 就原样返回（那说明它不是本会话已注册的子代理，不动手）。
 * 官方同款见 `dsh-api-session-controller` 客户端的 `updateCatalogActivity`。
 */
export function withSubagentActivity(
  entries: readonly SubagentView[],
  childSessionId: string,
  running: boolean,
): { entries: SubagentView[]; changed: boolean } {
  const activity = running ? ("running" as const) : ("inactive" as const);
  const index = entries.findIndex((item) => item.id === childSessionId);
  if (index < 0 || entries[index]!.activity === activity) return { entries: [...entries], changed: false };
  const next = entries.slice();
  next[index] = { ...entries[index]!, activity };
  return { entries: next, changed: true };
}

// ---------------------------------------------------------------------------
// 其余投影键的形状读取（2026-09-19：从 `controller.applyProjection` 的 switch 里搬进来）
//
// 搬出来的**只有解析**，一行判断都没有改：每个函数体逐字来自原来那个 case，包括
// 「承重字段坏了整条丢弃」与「坏值退化成什么」的容忍度。效果（写哪些 scope 字段、
// 发哪一帧）仍在控制器里——见 `dsh/projectionIngest.ts` 的登记表。
//
// 为什么这一步值得做：这个 switch 是**三次「按猜测的形状写」的现场**（`goal` /
// `subagentCatalog` / `turnOutline`，见 `docs/audit-summary.md` 三、四章的对应条目），而它住的
// 文件没有任何测试接缝（`scripts/` 里没有文件 import controller.ts）。搬进来之后，
// 每个键都能按契约逐字构造一个值来钉形状，而不必起 VS Code、起服务器。
//
// 契约来源：`docs/dsh-server-api.md`「投影」一节的 19 个键表（值类型逐条对照本机安装树）。
// ---------------------------------------------------------------------------

/** 形状里的数字：给了有限数就取它，否则用兜底值（与搬出来之前的 `numberOr` 逐字一致）。 */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** 形状里的可选数字：不是有限数就是「没有」。**不折成 0**——0 与缺失是两回事。 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `permissions` 投影 → 当前权限预设。
 *
 * 契约：`{options: PresetOption[]; currentValue: string}`。**只读 `currentValue`**：
 * `options` 至今没有消费点（界面上的权限胶囊读的是 `SessionScope.permission` 一路），
 * 解析一份没人用的目录只会攒出「解析了但既没人用」的死代码——那正是 `turnOutline`
 * 曾经的处境（审计里点名的「最差的状态」）。
 */
export function permissionFromProjection(value: unknown): string | undefined {
  const current = (value as { currentValue?: unknown } | null | undefined)?.currentValue;
  return typeof current === "string" && current ? current : undefined;
}

/**
 * `agentPreset` 投影 → 本会话运行的预设 id。契约：`string | null`；
 * `null`（与空串）都表示「这个部署没有组装任何预设」，与「还没拿到」同义。
 *
 * 官方注释强调 *"Reconstruction reads the `agentPreset` Session projection, never
 * the header alone."*——创建时的 header 只是**起始**事实，空白会话换过预设之后
 * header 不会变，所以界面标签必须读投影（见 `dsh/agent-presets` 的 session.ts）。
 */
export function agentPresetFromProjection(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * `agentPresets/list` 的 roster → 界面要的那个目录（纯函数，离线可断言）。
 *
 * 契约（`AgentPresetRoster`）**三代不同**，包名也跟着改过：
 * ```
 * ≤ 0.1.6-alpha.2（`@deepseek-ai/dsh-agent-presets`）：
 *   { presets: { id, trust, isDefault, name?, description?, broken? }[],
 *     authorable: boolean, modeSelectionEnabled: boolean }
 * ≥ 0.1.7-alpha.1（`@deepseek-ai/dsh-agent-preset-registry`）：
 *   { presets: { id, isDefault, name?, description?, broken? }[],
 *     modeSelectionEnabled: boolean }
 * ≥ 0.1.7-rc.2：{ presets: { id, isDefault, name?, description?, broken? }[] }
 * ```
 * 0.1.7-alpha.1 **删掉了 `trust`（与 `authorable`）**，所以「哪几个是随产品交付的内置预设」
 * 不再是服务端说了算的字段——判定挪到客户端（见 `webview/presetDisplay.ts` 的
 * `isBuiltInPresetOption`）。这两处的口径必须一起改，只改一处会让四个内置预设把
 * 服务端那份**不翻译**的名字显示出来（中文界面里显示英文）。
 *
 * 0.1.7-rc.2 又把**选择可见性**这个策略整个搬出协议：服务端只回目录，客户端自己决定
 * 要不要显示选择入口（官方前端的判据是「代码工作工具」开关，宿主持久化在 `ui-settings`
 * 命名空间）。所以第二个参数就是客户端这一侧的许可，由调用方从设置命名空间读出来传进来
 * ——判据仍然只有这一处实现，界面不自己判第二次。
 *
 * 三条口径：
 * - **坏掉的预设不进目录**（`broken` 非空）：它组装不出会话，列进去只会把
 *   「这个预设不可用」这件事推迟到一次失败的会话上（官方 `presetOptions` 同口径）；
 * - **服务端有显式策略就以它为准**（老服务端的 `modeSelectionEnabled`），
 *   **没有就看客户端偏好**（rc.2 起）；
 * - 不允许选择时目录给空表——界面据此什么都不渲染（可选性与目录合成一件事）。
 *
 * 形状认不出（没给目录 / `presets` 不是数组）一律按「没有」处理，不猜，也不拿客户端
 * 偏好去把一份看不出形状的东西说成「可选」。
 */
export function agentPresetsFromList(
  value: unknown,
  /** 客户端这一侧的许可（宿主 `ui-settings.enabled`）。缺省 / 读不到时按「允许」。 */
  hostSelectionEnabled = true,
): NonNullable<ChatState["agentPresets"]> {
  const roster = (value ?? {}) as { presets?: unknown; modeSelectionEnabled?: unknown };
  const rows = Array.isArray(roster.presets) ? roster.presets : [];
  const options: NonNullable<ChatState["agentPresets"]>["options"] = [];
  if (!Array.isArray(roster.presets)) return { options, selectable: false };
  const selectable =
    typeof roster.modeSelectionEnabled === "boolean" ? roster.modeSelectionEnabled : hostSelectionEnabled;
  if (!selectable) return { options, selectable };
  for (const row of rows) {
    const preset = row as {
      id?: unknown;
      trust?: unknown;
      isDefault?: unknown;
      name?: unknown;
      description?: unknown;
      broken?: unknown;
    };
    const id = typeof preset.id === "string" ? preset.id : "";
    // id 是承重字段（选中、切换、展示兜底都用它），没有就整条丢弃
    if (!id) continue;
    if (typeof preset.broken === "string" && preset.broken) continue;
    options.push({
      id,
      // `trust` 只在新版之前存在；新版给不出，展示层按官方 `isBuiltInPreset` 兜
      ...(preset.trust === "system" || preset.trust === "user" ? { trust: preset.trust } : {}),
      ...(typeof preset.name === "string" && preset.name ? { name: preset.name } : {}),
      ...(typeof preset.description === "string" && preset.description
        ? { description: preset.description }
        : {}),
      ...(preset.isDefault === true ? { isDefault: true } : {}),
    });
  }
  return { options, selectable };
}

/** `todos` 投影 → 待办列表。契约：`TodoItem[] | null`（`null` 与 `[]` 同义）。 */
export function todosFromProjection(value: unknown): TodoView[] {
  const items = Array.isArray(value) ? value : [];
  return items.map((todo, index) => {
    const item = todo as { id?: string; content?: string; text?: string; status?: string };
    return {
      id: String(item?.id ?? index),
      // `content` 是当前字段，`text` 是更早服务端的拼写；都给不出就是空串
      content: String(item?.content ?? item?.text ?? ""),
      status:
        item?.status === "completed"
          ? ("completed" as const)
          : item?.status === "in_progress"
            ? ("in_progress" as const)
            : ("pending" as const),
    };
  });
}

/**
 * `contextPressure` 投影 → 三个可选数字。
 *
 * `usedTokens = projectedTokens ?? pressureTokens`（分子**不含 output**，且
 * `projectedTokens` 会跟着压缩下降）——那是消费者（占用条）的口径，这里只负责把三个
 * 水位原样取出来，缺哪个就是哪个缺失。
 */
export function contextPressureFromProjection(value: unknown): {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
} {
  const pressure = (value ?? {}) as Record<string, unknown>;
  return {
    pressureTokens: optionalNumber(pressure.pressureTokens),
    projectedTokens: optionalNumber(pressure.projectedTokens),
    contextWindow: optionalNumber(pressure.contextWindow),
  };
}

/**
 * `tokenUsage` 投影 → 全日志累计的四桶。
 *
 * 四桶**互不重叠**（`reasoning` 已含在 `outputTokens` 里）；缺字段补 0，所以这个键
 * 永远给得出一个完整对象（不会「解析失败」）。
 */
export function tokenUsageFromProjection(value: unknown): NonNullable<ChatState["tokenUsage"]> {
  const usage = (value ?? {}) as {
    uncachedInputTokens?: unknown;
    outputTokens?: unknown;
    cacheReadTokens?: unknown;
    cacheWriteTokens?: unknown;
  };
  return {
    uncachedInputTokens: numberOr(usage.uncachedInputTokens, 0),
    outputTokens: numberOr(usage.outputTokens, 0),
    cacheReadTokens: numberOr(usage.cacheReadTokens, 0),
    cacheWriteTokens: numberOr(usage.cacheWriteTokens, 0),
  };
}

/**
 * `turnOutline` 投影 → 轮次大纲。
 *
 * 形状**逐字按契约**（`dsh-session-turn-outline` 的 `TurnOutlineEntry`）：
 * `{turn, seq, prompt, response}`。容忍度与官方 `outlineEntry` 同口径：`turn`/`seq`
 * 是**承重字段**（没有它们横条既画不出记号也跳不了），坏了就整条丢弃；两段预览只是
 * 装饰，类型不对退化成空串。
 */
export function turnOutlineFromProjection(value: unknown): NonNullable<ChatState["turnOutline"]> {
  const rounds = Array.isArray(value) ? value : [];
  return rounds.flatMap((round) => {
    const item = round as { turn?: unknown; seq?: unknown; prompt?: unknown; response?: unknown };
    const turn = numberOr(item.turn, -1);
    const seq = numberOr(item.seq, -1);
    if (!Number.isSafeInteger(turn) || turn < 0) return [];
    if (!Number.isSafeInteger(seq) || seq < 0) return [];
    return [
      {
        turn,
        seq,
        prompt: typeof item.prompt === "string" ? item.prompt : "",
        response: typeof item.response === "string" ? item.response : "",
      },
    ];
  });
}

/**
 * `imageLimits` 投影 → 图片准入上限。
 *
 * 契约里还有 `maxImagePixels` / `maxImageDimension` / `mediaTypes` 三个字段，本扩展
 * 没有消费点，**不解析**（同 `permissions.options` 的理由）。
 */
export function imageLimitsFromProjection(value: unknown): NonNullable<ChatState["imageLimits"]> {
  const limits = (value ?? {}) as {
    maxImagesPerMessage?: unknown;
    maxImageBytes?: unknown;
    maxMessageImageBytes?: unknown;
  };
  return {
    maxImagesPerMessage: numberOr(limits.maxImagesPerMessage, 0) || undefined,
    maxImageBytes: numberOr(limits.maxImageBytes, 0) || undefined,
    maxMessageImageBytes: numberOr(limits.maxMessageImageBytes, 0) || undefined,
  };
}

/** `title` 投影 → 会话标题。契约：`string | null`；空串与 `null` 同义（没有标题）。 */
export function titleFromProjection(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * `contextBreakdown` 投影 → 上下文构成。
 *
 * `{systemTokens, toolsTokens, messageTokens}`：启发式估算，是**构成占比**，不与占用
 * 分子相加。三个字段**全有或全无**——缺一个就不给（半份构成画出来的占比是错的）。
 */
export function contextBreakdownFromProjection(value: unknown): NonNullable<ChatState["contextBreakdown"]> | undefined {
  const bd = value as { systemTokens?: unknown; toolsTokens?: unknown; messageTokens?: unknown } | null;
  if (
    bd &&
    typeof bd.systemTokens === "number" &&
    typeof bd.toolsTokens === "number" &&
    typeof bd.messageTokens === "number"
  ) {
    return {
      systemTokens: bd.systemTokens,
      toolsTokens: bd.toolsTokens,
      messageTokens: bd.messageTokens,
    };
  }
  return undefined;
}

/**
 * `sessionStats` 投影 → 全日志墙钟统计。
 *
 * 八个字段里 `llmMs` / `toolMs` 是承重的（缺了这份统计没有意义），其余缺失补 0。
 */
export function sessionStatsFromProjection(value: unknown): NonNullable<ChatState["sessionStats"]> | undefined {
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
    return {
      turns: st.turns ?? 0,
      steps: st.steps ?? 0,
      llmMs: st.llmMs,
      toolMs: st.toolMs,
      ttftMs: st.ttftMs ?? 0,
      ttftSteps: st.ttftSteps ?? 0,
      decodeMs: st.decodeMs ?? 0,
      decodeTokens: st.decodeTokens ?? 0,
    };
  }
  return undefined;
}

/**
 * `modelSelection` 投影里**选中的那一份**（`next ?? lastUsed`）的原始标识。
 *
 * 只是 wire 上的三个字段，还没有查目录——展示名、上下文窗口、是否收图由控制器补
 * （见 `controller.applyModelSelectionProjection`）。
 */
export interface ModelSelectionDecoded {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/**
 * `modelSelection` 投影 → **原始选择**（还没查目录）。
 *
 * 契约：`{lastUsed: ModelSelection|null; next: ModelSelection|null}`，生效值是
 * `next ?? lastUsed`（`next` 是「下一轮生效」的待提交值）。
 *
 * 「provider 有、model 缺」这种半截选择按**没有选择**处理——与下游
 * `applyModelSelectionProjection` 的判据一致（那边缺任一就走「退回部署默认」）。
 */
export function modelSelectionFromProjection(value: unknown): ModelSelectionDecoded | undefined {
  const selection = value as
    | {
        lastUsed?: { provider?: string; model?: string; reasoningEffort?: string } | null;
        next?: { provider?: string; model?: string; reasoningEffort?: string } | null;
      }
    | null
    | undefined;
  const used = selection?.next ?? selection?.lastUsed;
  if (!used?.provider || !used.model) return undefined;
  return {
    provider: used.provider,
    model: used.model,
    reasoningEffort: used.reasoningEffort || undefined,
  };
}
