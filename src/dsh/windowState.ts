/**
 * 工作区级「会话窗口状态」缓存。
 *
 * 目标：像 VS Code 自己记得这个文件夹开过哪些文件一样，本扩展也记得
 * **上次关掉工作区时，每个对话窗口开着哪个会话**（主侧栏 / 辅助侧栏 / 编辑区面板），
 * 下次打开这个工作区时各自接回原来的会话。
 *
 * 存放位置是 **VS Code 自己的工作区缓存**（`ExtensionContext.workspaceState`，
 * 落在 `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb`），
 * **不往项目目录里写任何文件**，也不进全局存储——本来就是「这个工作区的窗口布局」。
 *
 * 三处容易踩的坑，这里都按「按契约写」处理：
 *
 * 1. **Memento 是 JSON 过的**（`state.vscdb` 里就是 JSON）：值为 `undefined` 的键
 *    会被整条丢掉，所以「清空某个槽位」必须写 `null`，读回时再把 `null` 折回
 *    `undefined`。漏掉这一步的症状是**清空指令静默失效**——与宿主 → webview 的
 *    帧是同一个坑（见 `shared/wire.ts`）。
 * 2. **缓存是磁盘上的旧数据**：用户可能换过服务器、删过会话、手工动过状态文件，
 *    所以 `parseWindowCache` 对每个字段都做形状校验，坏的**逐条丢弃**而不是整份
 *    丢掉（能救一条是一条），并且 `undefined` 不当成 `null`。
 * 3. **写盘要防抖**：窗口活动顺序每次消息都会更新，直接写会把磁盘打满。
 *
 * 模块刻意**不 import vscode**：缓存语义要能在 `npm test` 里直接跑
 * （见 `scripts/windowState.test.ts`），所以这里只声明一个 `WindowStateStorage`
 * 结构类型，`vscode.Memento` 天然满足它。
 */

/** 窗口种类：主侧栏 / 辅助侧栏 / 编辑区面板。 */
export type WindowKind = "primary" | "secondary" | "panel";

/** 侧栏槽位（固定一个）；编辑区面板是列表，按下标认领。 */
export type SidebarSlot = "primary" | "secondary";

/** 一个窗口上次开着的会话（`sessionId` 为 null = 当时是空态）。 */
export interface WindowEntry {
  sessionId: string | null;
  /**
   * 会话是**子代理**时的地址：子代理不进会话列表，恢复时只能靠这里带回来的
   * 地址重新进入（`parentSessionId` + `mode`）。普通会话没有这个字段。
   */
  subagent?: { parentSessionId: string; mode: "one-shot" | "continuable" };
  /** 最近活动时间（epoch ms），仅供排查用，不参与恢复。 */
  lastActiveAt?: number;
}

/** 这份工作区上次关掉时的窗口状态。 */
export interface WindowCache {
  primary?: WindowEntry;
  secondary?: WindowEntry;
  /** 编辑区面板，**按 VS Code 恢复它们的顺序**排列。 */
  panels: WindowEntry[];
  /** 窗口的最近活动顺序（末尾 = 最近活动）：接回后命令面板入口仍落在原窗口上。 */
  activeOrder: string[];
}

/** 这里只用到 `get` / `update` 两个方法，`vscode.Memento` 结构上满足。 */
export interface WindowStateStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/** 缓存书写版本：将来形状变了，旧数据能被认出来并丢弃。 */
export const WINDOW_CACHE_VERSION = 1;

const KEY_PREFIX = "windowCache";

/**
 * 缓存键：一个工作区一份。
 *
 * 用**工作区文件夹路径**（全部根都拼进去，多根工作区各算一份），而不是
 * workspaceFile 的路径——「同一个文件夹」无论是直接打开还是被某个 .code-workspace
 * 包含，窗口状态都该跟着文件夹走。
 *
 * 路径只做小写归一（Windows 大小写不敏感），**不做 realpath**：磁盘上的
 * `state.vscdb` 本来就由 VS Code 按工作区身份分文件，这里只需在同一个
 * workspaceStorage 里互相区分。
 */
export function windowCacheKey(folders: readonly string[]): string | undefined {
  const normalized = folders
    .map((folder) => folder.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase())
    .filter((folder) => folder.length > 0);
  if (!normalized.length) return undefined;
  // 多根：排序后拼接。顺序不同的同一组根目录应当共用一份缓存
  // （VS Code 的编辑器恢复本来就与根的顺序无关）
  const identity = [...normalized].sort().join("|");
  return `${KEY_PREFIX}:${identity}`;
}

function parseEntry(value: unknown): WindowEntry | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const raw = record.sessionId;
  // `null`（当时空态）与字符串都合法；其余形状（数字/对象/undefined）当坏数据丢
  if (raw !== null && typeof raw !== "string") return undefined;
  const entry: WindowEntry = { sessionId: typeof raw === "string" && raw ? raw : null };
  // 子代理地址只在**完整成立**时带回来：半截的（缺父 id / 模式不认识）按普通会话处理
  if (record.subagent && typeof record.subagent === "object") {
    const address = record.subagent as { parentSessionId?: unknown; mode?: unknown };
    if (
      typeof address.parentSessionId === "string" &&
      address.parentSessionId &&
      (address.mode === "one-shot" || address.mode === "continuable")
    ) {
      entry.subagent = { parentSessionId: address.parentSessionId, mode: address.mode };
    }
  }
  if (typeof record.lastActiveAt === "number" && Number.isFinite(record.lastActiveAt)) {
    entry.lastActiveAt = record.lastActiveAt;
  }
  return entry;
}

/**
 * 把缓存值解析成可用形状。
 *
 * 坏数据**逐条丢弃**：一条烂掉的面板记录不该让另外两个窗口也恢复不了。
 * 返回值里的 `dropped` 只用于日志（让「怎么没恢复」在输出通道里看得见）。
 */
export function parseWindowCache(raw: unknown): { cache: WindowCache; dropped: number } {
  const cache: WindowCache = { panels: [], activeOrder: [] };
  if (!raw || typeof raw !== "object") return { cache, dropped: 0 };
  const record = raw as Record<string, unknown>;
  let dropped = 0;
  if (record.version !== WINDOW_CACHE_VERSION) {
    // 版本不认识（含从未写过：undefined）→ 当作没有缓存，但不算「坏数据」
    return { cache, dropped: 0 };
  }
  for (const slot of ["primary", "secondary"] as const) {
    if (record[slot] === undefined) continue;
    const entry = parseEntry(record[slot]);
    if (entry) cache[slot] = entry;
    else dropped += 1;
  }
  if (Array.isArray(record.panels)) {
    for (const value of record.panels) {
      const entry = parseEntry(value);
      if (entry) cache.panels.push(entry);
      else dropped += 1;
    }
  } else if (record.panels !== undefined) {
    dropped += 1;
  }
  if (Array.isArray(record.activeOrder)) {
    cache.activeOrder = record.activeOrder.filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }
  return { cache, dropped };
}

/**
 * 序列化成可存进 Memento 的形状。
 *
 * **槽位缺失写 `null` 而不是 `undefined`**：Memento 走 JSON，`undefined` 的键会
 * 被丢掉，于是「这个窗口当时是空态」与「这条记录没写」在磁盘上长得一样。
 * 这里统一成显式 null，语义唯一。
 */
export function serializeWindowCache(cache: WindowCache): Record<string, unknown> {
  const entry = (value: WindowEntry | undefined): WindowEntry | null =>
    value
      ? {
          sessionId: value.sessionId,
          ...(value.subagent ? { subagent: value.subagent } : {}),
          lastActiveAt: value.lastActiveAt,
        }
      : null;
  return {
    version: WINDOW_CACHE_VERSION,
    primary: entry(cache.primary),
    secondary: entry(cache.secondary),
    panels: cache.panels.map((panel) => ({
      sessionId: panel.sessionId,
      ...(panel.subagent ? { subagent: panel.subagent } : {}),
      lastActiveAt: panel.lastActiveAt,
    })),
    activeOrder: [...cache.activeOrder],
  };
}

/** 会话是 `undefined` 还是 `null` 都表示「空态」。 */
export function isBlank(entry: WindowEntry | undefined): boolean {
  return !entry || !entry.sessionId;
}

/**
 * 恢复期的认领器：回答「这个正在恢复的窗口该接回哪个会话」。
 *
 * 侧栏用固定槽位（`primary`/`secondary`）：一个容器只有一个实例，谈不上顺序。
 *
 * 编辑区面板**优先按 webview 自己存的会话 id 认领**：`deserializeWebviewPanel(panel, state)`
 * 的 `state` 是 webview 用 `acquireVsCodeApi().setState()` 存的（界面把当前会话 id
 * 写进去，见 `webview/bridge.ts` 的 `persistIdentity`）。这是**身份**，不是顺序——
 * 用户 2026-09-21 报的「重载后两个标签的会话交叉了」正是顺序认领的固有缺陷：
 * `activeOrder` 记的是创建顺序，而复用的是「上次的编辑器排布」，两者在重载/重排
 * 之后并不保证一致，对不上位就张冠李戴（Claude Code 的
 * [issue #35022](https://github.com/anthropics/claude-code/issues/35022) 是同一个坑的
 * 另一种表现：序列化器拿到了 state 里的 sessionId 却没用）。
 *
 * 没拿到身份时（旧版本写的面板、用户手工调过状态、身份与缓存对不上）**退回按下标认领**：
 * 谁也不认领的那几个面板仍按 VS Code 的恢复顺序对位，能救一个是一个。两条路都记日志
 * （`classifyPanel`），「这次是按身份还是按顺序接的」在输出通道里看得见。
 */
export class WindowRestore {
  private panelCursor = 0;
  /** 已经被认领过的面板下标（按身份跳着认领时下标不是连续的）。 */
  private readonly claimedIndices = new Set<number>();
  /** 「认领完毕」那一行日志打过了没有（只打一次，见 `reportLeftovers`）。 */
  private reported = false;
  /** 问过话的侧栏槽位（认领过就不再计入「还没恢复完」）。 */
  private readonly slotsClaimed = new Set<SidebarSlot>();

  constructor(
    private cache: WindowCache,
    private readonly log: (line: string) => void = () => {},
  ) {}

  /** 当前缓存（解析后的形状，调用方不要改；断言用它核对认领结果）。 */
  get value(): WindowCache {
    return this.cache;
  }

  /** 换一份缓存（测试与「缓存后来才读到」的场景用）。 */
  replace(cache: WindowCache): void {
    this.cache = cache;
    this.panelCursor = 0;
    this.claimedIndices.clear();
    this.reported = false;
    this.slotsClaimed.clear();
  }

  /**
   * 还有没有被认领的缓存窗口。
   *
   * 恢复**不是一次做完的**：契约（`vscode.d.ts` 的 `WebviewPanelSerializer`）写的是
   * 「webview 重启后**第一次变为可见**时」才回调序列化器——用户没点到的面板标签页
   * 可能过很久才认领，甚至直到关窗都没认领。所以「恢复窗口」结束的判据不是某个
   * 超时，而是**缓存里的窗口都被问过了**（侧栏按槽位、面板按条，见 `classifyPanel`）。
   */
  get pending(): boolean {
    return this.remaining > 0;
  }

  /** 还剩几个缓存窗口没被认领（侧栏按槽位算、面板按条数算）。 */
  get remaining(): number {
    let count = this.remainingPanels;
    for (const slot of ["primary", "secondary"] as const) {
      if (!this.slotsClaimed.has(slot) && !isBlank(this.cache[slot])) count += 1;
    }
    return count;
  }

  /** 侧栏槽位要接回的会话（没有就是空态）。 */
  slot(slot: SidebarSlot): WindowEntry | undefined {
    this.slotsClaimed.add(slot);
    const entry = this.cache[slot];
    // 空态（记录在、sessionId 为 null）与「这条记录压根没有」都返回 undefined
    return isBlank(entry) ? undefined : entry;
  }

  /**
   * 认领一个编辑区面板的会话，并说清是**按身份**还是**按下标**认领的。
   *
   * `known` 是面板自己存下来的窗口身份（`deserializeWebviewPanel` 的 `state` 里读回，
   * 含子代理地址）。能对上缓存里一条**还没被认领**的记录就用它；对不上退回下标。
   * 返回值里的 `by` 只用于日志与断言——调用方（控制器）拿 `sessionId` / `subagent`
   * 去做接回。
   */
  classifyPanel(known?: WindowEntry): { sessionId: string | undefined; subagent?: WindowEntry["subagent"]; by: "identity" | "cursor" } {
    if (known?.sessionId) {
      const index = this.cache.panels.findIndex(
        (entry, at) => entry.sessionId === known.sessionId && !this.claimedIndices.has(at),
      );
      if (index >= 0) {
        this.claimedIndices.add(index);
        this.reportLeftovers();
        // 没有子代理地址时键不出现（过 JSON 才不产生无意义的 null 字段）
        return {
          sessionId: known.sessionId,
          ...(known.subagent ? { subagent: known.subagent } : {}),
          by: "identity",
        };
      }
    }
    const claimed = this.claimPanel();
    return {
      sessionId: claimed?.sessionId ?? undefined,
      ...(claimed?.subagent ? { subagent: claimed.subagent } : {}),
      by: "cursor",
    };
  }

  /** 认领下一个编辑区面板的会话（按下标；没被认领过的第一条）。 */
  claimPanel(): WindowEntry | undefined {
    while (this.panelCursor < this.cache.panels.length) {
      const index = this.panelCursor;
      this.panelCursor += 1;
      if (this.claimedIndices.has(index)) continue;
      this.claimedIndices.add(index);
      this.reportLeftovers();
      const entry = this.cache.panels[index];
      return isBlank(entry) ? undefined : entry;
    }
    this.reportLeftovers();
    return undefined;
  }

  /**
   * 这个下标的面板有没有被认领过（按身份或按下标都算）。
   *
   * 写缓存要它：**尚未认领**的那几条属于还没露面的窗口，必须按原位保留
   * （见 `mergeWindowCache`）。用「按条问」而不是一个总数——按身份认领时下标是
   * 跳着的，总数分不出是哪几条。
   */
  panelClaimed(index: number): boolean {
    return this.claimedIndices.has(index);
  }

  /** 这个侧栏槽位这一代**有没有被问过话**（问过 = 它已经在内存里有最新状态）。 */
  isSlotClaimed(slot: SidebarSlot): boolean {
    return this.slotsClaimed.has(slot);
  }

  /**
   * 一次性日志：缓存里的面板都被认领完时打一行。
   *
   * 只在**认领完最后一个面板**时打，不是每个面板都打——否则输出通道会被刷屏。
   * 这一行是排查「怎么少恢复了一个窗口」的线索：VS Code 恢复了几个面板从界面上
   * 看不出来，只有「认领数 vs 缓存数」对得上才对得上账；缓存里还剩几条没被认领，
   * 下一次写缓存时会自然收敛掉。
   */
  private reportLeftovers(): void {
    if (this.reported || this.remainingPanels > 0) return;
    this.reported = true;
    const blanks = this.cache.panels.filter((panel) => isBlank(panel)).length;
    this.log(
      `[restore] 编辑区面板认领完毕：${this.claimedIndices.size} 个（缓存里空态 ${blanks} 个）`,
    );
  }

  /** 还没被认领的面板条数（`remaining` 与日志共用）。 */
  private get remainingPanels(): number {
    let count = 0;
    for (let index = 0; index < this.cache.panels.length; index += 1) {
      if (!this.claimedIndices.has(index)) count += 1;
    }
    return count;
  }
}

/**
 * 把「内存里的最新窗口状态」与「还没被认领的旧缓存」合成一份要落盘的缓存。
 *
 * 恢复**不是一次做完的**：VS Code 只在 webview「第一次变为可见」时回调序列化器，
 * 侧栏容器折叠着时它的视图根本不会被实例化。所以恢复期内**不能**拿内存状态整份
 * 覆写——那会把还没露面的窗口连同它们的会话一起抹掉。
 *
 * 但也不能像早先那样「整个恢复窗口内都不写」：`pending` 可能**永远为真**
 * （某个缓存过的窗口这一代再也没露面），于是这一轮的每一次变更都被押后，
 * 关掉 VS Code 时缓存还停在启动时读到的那份旧值上。用户 2026-09-15 报的
 * 「编辑区窗口从会话 A 切到 B，重启后还是打开 A」正是这个：
 * 工作区缓存里保存的是**初始会话**，不是最终会话。
 *
 * 折中就是这里：**已认领的部分**一律用内存里的最新状态，**尚未认领的**按原位接在后面。
 *
 * 面板用**按条问**（`panelClaimed(index)`）而不是拿一个认领总数去切：按身份认领时
 * 下标是跳着的（第 2 个面板可能先认领），拿「认领了几条」当游标会把还没露面的那条
 * 当成已认领而丢掉。
 *
 * @param options.memory 内存里那几张表的投影（`persistWindowState` 的产物）。
 * @param options.previous 启动时读到的缓存（尚未认领的条目从这里取）。
 * @param options.panelClaimed 某个下标的面板这一代有没有被认领过。
 * @param options.restorePending 恢复窗口是否还没结束。
 * @param options.slotClaimed 某个侧栏槽位这一代有没有被问过话。
 */
export function mergeWindowCache(options: {
  memory: WindowCache;
  previous: WindowCache;
  panelClaimed: (index: number) => boolean;
  restorePending: boolean;
  slotClaimed: (slot: SidebarSlot) => boolean;
}): WindowCache {
  const { memory, previous, panelClaimed, restorePending, slotClaimed } = options;
  if (!restorePending) return memory;
  const merged: WindowCache = { ...memory, panels: [...memory.panels] };
  // 面板：内存里已经比「认领过的条数」多（用户在这次恢复窗口里新开了一个面板）时不再补，
  // 否则同一条会话会被写两遍、下次恢复还会错位。
  const claimed = previous.panels.reduce(
    (count, _entry, index) => (panelClaimed(index) ? count + 1 : count),
    0,
  );
  if (merged.panels.length <= claimed) {
    previous.panels.forEach((entry, index) => {
      if (!panelClaimed(index)) merged.panels.push(entry);
    });
  }
  // 侧栏：这一代没被问过话的槽位保留旧值（它的视图还没被 VS Code 实例化）。
  // 已认领的槽位即使内存里是 `null`（空态）也照写——那是「用户把它清空了」。
  for (const slot of ["primary", "secondary"] as const) {
    if (merged[slot] !== undefined || slotClaimed(slot)) continue;
    const entry = previous[slot];
    if (entry) merged[slot] = entry;
  }
  return merged;
}

/** 一份缓存最多记多少个窗口——防手改状态文件塞进来一个巨大的数组。 */
const MAX_ENTRIES = 64;

/** 把缓存裁剪到合理范围（最近活动的面板优先保留，其余按原顺序）。 */
export function trimCache(cache: WindowCache): WindowCache {
  if (cache.panels.length <= MAX_ENTRIES) return cache;
  return { ...cache, panels: cache.panels.slice(-MAX_ENTRIES) };
}

/**
 * 缓存的读写 + 防抖落盘。
 *
 * 读是同步的（构造时一次），写在 `markDirty()` 后延迟合并——但 `dispose()`
 * 会**立刻刷一次**：扩展停用（关窗、重载）时那一次写很可能就是最后一次机会，
 * 漏掉它等于这一轮的窗口状态白记了。
 */
export class WorkspaceWindowStateStore {
  private readonly storage: WindowStateStorage;
  private readonly log: (line: string) => void;
  /** 这个工作区对应的缓存键；没有打开的文件夹时是 undefined（不缓存）。 */
  key: string | undefined;
  private cache: WindowCache;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private disposed = false;

  constructor(options: {
    storage: WindowStateStorage;
    /**
     * 工作区根目录路径（`vscode.workspace.workspaceFolders` 的 fsPath）。
     *
     * 可以**晚一点再给**（构造时不传、之后用 `bindFolders`）：面板恢复可能正是
     * 扩展被激活的原因，那一刻 `workspaceFolders` 未必已经就绪。
     */
    folders?: readonly string[];
    log?: (line: string) => void;
    /** 防抖窗口（ms）。测试里调小即可。 */
    debounceMs?: number;
  }) {
    this.storage = options.storage;
    this.log = options.log ?? (() => {});
    this.debounceMs = options.debounceMs ?? 2_000;
    this.cache = { panels: [], activeOrder: [] };
    this.key = undefined;
    this.bindFolders(options.folders ?? []);
  }

  private readonly debounceMs: number;

  /**
   * 绑定工作区身份并读回缓存；已经有键时什么都不做（幂等）。
   *
   * 返回当前缓存——调用方（控制器）要拿它初始化恢复认领器。
   */
  bindFolders(folders: readonly string[]): WindowCache {
    if (!this.key) {
      this.key = windowCacheKey(folders);
      if (!this.key) return this.cache;
      // 读不出来 / 格式不认识时给空缓存：恢复不了是遗憾，崩掉是事故
      let raw: unknown;
      try {
        raw = this.storage.get<unknown>(this.key);
      } catch (error) {
        this.log(`[restore] 窗口缓存读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      const parsed = parseWindowCache(raw);
      if (parsed.dropped) {
        this.log(`[restore] 窗口缓存里有 ${parsed.dropped} 条形状不对的记录，已丢弃`);
      }
      this.cache = parsed.cache;
    }
    return this.cache;
  }

  /** 当前缓存（供 `WindowRestore` 使用；返回的是内部引用，别改）。 */
  snapshot(): WindowCache {
    return this.cache;
  }

  /** 换一份缓存（测试用；生产路径只从磁盘读一次）。 */
  load(cache: WindowCache): void {
    this.cache = cache;
  }

  /** 标记「窗口状态变了」，防抖合并后落盘。 */
  markDirty(): void {
    if (this.disposed || !this.key) return;
    this.dirty = true;
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * 立刻写盘（幂等）。
   *
   * `update` 失败只记日志：状态缓存写不进去不该影响会话本身——
   * 磁盘满 / 权限异常时最坏的结果是下次少恢复几个窗口。
   */
  flush(): void {
    if (!this.dirty || !this.key) return;
    this.dirty = false;
    const payload = serializeWindowCache(trimCache(this.cache));
    try {
      void Promise.resolve(this.storage.update(this.key, payload)).catch((error: unknown) => {
        this.log(`[restore] 窗口缓存写入失败：${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      this.log(`[restore] 窗口缓存写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.flush();
    this.disposed = true;
  }
}
