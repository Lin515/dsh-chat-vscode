/**
 * 投影值存储：一个会话域里「每个投影键此刻是什么值」的权威表。
 *
 * ## 契约（逐字引官方 `dsh-api-session-controller` 的 `ProjectionValueStore`）
 *
 * > *"One session's projection values. Framework semantics, uniform across every key:
 * > a baseline seeds rows at its cut, a push frame updates one row, and in both paths
 * > **a lower-or-equal seq loses** — a replayed frame cannot regress a value, a stale
 * > baseline cannot overwrite a newer frame. A key the store has never seen reads
 * > `undefined` (capability absent)."*
 *
 * 本仓库的副本见 `docs/dsh-server-api.md` §6.10（含客户端的消费规则那条引用）。
 * 存储里是 `key → {value, seq}`，**值本身不做任何解析**——形状解析在
 * `projections.ts` 的读取表里，本模块不认识任何一个具体的投影键。
 *
 * ## 为什么要有它
 *
 * 改造前 `controller.applyProjection(scope, key, value)` 收的是**裸值**：三个调用点
 * （跟随开帧的 snapshot、`session/control` 的 baseline、`projection` 增量帧）全都把
 * 线上带着的水位丢了——
 *
 * | 调用点 | 线上有什么 | 改造前 |
 * |---|---|---|
 * | `projection` 增量帧 | `frame.seq` | 丢掉（`applyProjection(scope, key, value)`） |
 * | `control` 的 `baseline` | `block.asOfSeq` | 丢掉，且块里没带的键**不清** |
 * | `follow` 的 `snapshot` | `projections.asOfSeq` | 丢掉 |
 *
 * 两份流的交错是真的：跟随流与控制在两条 socket 上，重连/切会话回来时一个重放的旧帧
 * 完全可能后到。契约要求它**不能**把新值顶回去，而改造前没有任何东西拦得住。
 *
 * ## 拿不到水位时的纪律
 *
 * `apply(key, value, seq?)` 的 `seq` 是可选的：只有**拿到数字**才做新旧比较
 * （按仓库纪律「安全谓词按肯定证据写」——凭一个猜的水位丢掉真实数据，比不比较更糟）。
 * 没给水位时值照常落地，且**保留该行已有的水位**，免得一次无水位更新把水位抹平成 0。
 */

/** 一行投影值：解析前的原始 wire 值 + 它被提交时的水位。 */
export interface ProjectionRow {
  value: unknown;
  /** 提交这一行的 seq；无水位通道写入时保留旧水位（没有就是 0）。 */
  seq: number;
}

/** `baseline`（或跟随开帧的 `projections` 块）的形状：一批值 + 同一个截止水位。 */
export interface ProjectionBlockWire {
  asOfSeq?: unknown;
  values?: unknown;
}

/** 投影值存储。一个会话域一份（见 `dsh/scope.ts` 的 `SessionScope.projections`）。 */
export class ProjectionStore {
  private readonly rows = new Map<string, ProjectionRow>();

  /**
   * 接受一个投影值。
   *
   * - `seq` 是数字：严格按契约比较，`seq <= 已存水位` 一律**丢弃**（重放帧 / 陈旧
   *   baseline 都不能把值顶回去）；
   * - `seq` 缺失：一律落地（拿不到水位就不比较），并保留该行已有的水位。
   *
   * @returns 这一行是否真的被改动了（调用方据此决定要不要跑效果）
   */
  apply(key: string, value: unknown, seq?: number): boolean {
    const row = this.rows.get(key);
    if (typeof seq === "number" && row && seq <= row.seq) return false;
    this.rows.set(key, { value, seq: typeof seq === "number" ? seq : (row?.seq ?? 0) });
    return true;
  }

  /**
   * 用一个 baseline 块播种：块里带的键按**同一个**截止水位落地；块里没带、且旧值不新于
   * 该截止水位的键**清掉**（契约：「块里没带的键 = 能力缺失」，而比截止点更新的值不能被
   * 陈旧的 baseline 清掉）。
   *
   * 拿不到截止水位（`asOfSeq` 不是数字）时**不清任何键**——没有「截至哪一刻」这个前提，
   * 清空就是凭猜动手。
   *
   * @returns 被改动或被清掉的键（调用方对它们逐一跑效果；被清掉的键要以「值不存在」派发）
   */
  seed(block: ProjectionBlockWire | undefined): string[] {
    const values =
      block?.values && typeof block.values === "object"
        ? (block.values as Record<string, unknown>)
        : {};
    const cut =
      typeof block?.asOfSeq === "number" && Number.isFinite(block.asOfSeq) ? block.asOfSeq : undefined;
    const touched = new Set<string>();

    for (const [key, value] of Object.entries(values)) {
      if (this.apply(key, value, cut)) touched.add(key);
    }
    if (cut === undefined) return [...touched];

    for (const [key, row] of [...this.rows]) {
      if (Object.hasOwn(values, key)) continue;
      if (row.seq > cut) continue;
      this.rows.delete(key);
      touched.add(key);
    }
    return [...touched];
  }

  /**
   * 丢掉比 `lastSeq` **新**的行。
   *
   * 官方的用法是在**替换型 baseline** 之前调它，紧接着 `seed`：这些行描述的是 Host
   * 在持久化之前丢掉的那部分进程状态，留着它们会让它们永远压过重算出来的低水位值。
   *
   * @returns 被丢掉的键（同样要以「值不存在」派发一次）
   */
  truncate(lastSeq: number): string[] {
    const dropped: string[] = [];
    for (const [key, row] of [...this.rows]) {
      if (row.seq <= lastSeq) continue;
      this.rows.delete(key);
      dropped.push(key);
    }
    return dropped;
  }

  /** 当前值；这个键从没被写入过（或已被清掉）时是 `undefined`（能力缺失）。 */
  get(key: string): unknown {
    return this.rows.get(key)?.value;
  }

  has(key: string): boolean {
    return this.rows.has(key);
  }

  /** 已存的键（按插入顺序）。 */
  keys(): string[] {
    return [...this.rows.keys()];
  }

  /** 当前全部值。**只读快照**，改不动存储。 */
  values(): Readonly<Record<string, unknown>> {
    return Object.fromEntries([...this.rows].map(([key, row]) => [key, row.value]));
  }

  /** 丢掉全部行（切换服务器、重连重建整个域时用）。 */
  clear(): void {
    this.rows.clear();
  }
}
