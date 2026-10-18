/**
 * 消息通知队列（**宿主权威**的单一内存队列）。
 *
 * 规则见 `docs/design-notifications.md`；领域术语见 `CONTEXT.md`。这里只放
 * 「队列怎么算」——**不认识 vscode、不认识控制器**，于是整套合并 / 确认 / 容量语义
 * 能在 `npm test` 里直接跑（与 `unreadStore.ts` 同一条纪律）。
 *
 * ## 一个窗口一份，不落盘
 *
 * 队列由控制器持有一份（一个扩展宿主 = 一个 VS Code 窗口），webview 只是它的镜像；
 * 没有任何持久化路径：不写 `globalState` / `workspaceState`，也不放进 webview 的
 * `setState`。重载窗口或退出即清空（那是宿主进程重建的必然结果），关面板 / 切会话 /
 * 断线重连都保留（内存里没人动它）。
 *
 * ## 合并与「实际发生」
 *
 * 未确认的**同归属 + 同级别 + 同类型 + 同关键内容**合并成一条，累加次数并更新最近
 * 时间（`lastAt`，排序用它）；已确认的再发生**新建**一条未确认记录，绝不改旧记录。
 *
 * ## 重发不是新的实际发生
 *
 * 带 durable `seq` 的入口传 `seq`：同一会话里**不比已见过的高位更新**的 `seq` 一律
 * 丢弃（不新建、不累加）。判据是**每会话一个水位**，不是「记住每条 seq」——于是
 * 索引大小与事件条数无关，1000 条之后的老 `seq` 照样被拒（`docs/design-notifications.md`
 * 的「历史重放或传输重发不算新的实际发生」）。
 *
 * durable 事件在一条会话日志里的 `seq` 是单调的，所以水位只需按**会话**记一份，
 * 不必按类型分表。水位表按会话 id 存活；会话被真正删除时控制器调 `forgetSession`，
 * 把它的水位**连同它的通知记录**一起收掉（归档不算删除，水位与通知都留着——那条会话
 * 还能恢复，恢复后仍要拒绝重发、仍要显示它自己的通知）。
 *
 * ## 确认
 *
 * 顶部展示的是**某个时刻的那一份**，确认带上用户当时看到的次数（`count`）：
 * 点击之前如果又合并进来一次实际发生，这次点击不该把它一起吞掉——只把看到的那部分
 * 移入已确认历史，剩余部分继续未确认提醒（见 `acknowledge`）。
 *
 * 已确认历史保留最近 `ACKED_HISTORY_LIMIT` 条；未确认通知**不自动淘汰**。
 */

/** 通知级别：红（影响会话进程）/ 黄（不阻断但要知悉）/ 绿（重要变化）。 */
export type NoticeLevel = "error" | "warn" | "info";

/** 一条通知的入队请求。 */
export interface NoticeInput {
  /** 归属会话 id；缺省 = 共享通知（所有视图都看得到）。 */
  sessionId?: string;
  level: NoticeLevel;
  /**
   * 通知**类型**（`@` 标记的主键，例如 `unknownEvent` / `workingDirectory`）。
   * 合并判据的一段，也是「不同未知事件类型属不同关键内容」的落点。
   */
  kind: string;
  /**
   * 同类型下区分关键内容的参数（未知事件类型本身、目标目录、命令行…）。
   *
   * **缺省用 `text`**：`text` 是插值过的标记（`@fileNotFound:C:\a.ts`），不带显式 key
   * 时它就代表「这次发生在什么目标上」——两条只有参数不同的通知必须各自成条，否则
   * 用户会一直看到第一次的那个理由（`@agentPresetFailed:<reason>` 就是这么暴露的）。
   * 常量文案（`@imageSaveFailed` 这类）用 text 当 key 天然合并成一条。
   */
  key?: string;
  /** 给用户看的语言中立标记（`@key:arg`），由界面按当前语言翻译。 */
  text: string;
  /**
   * 这次实际发生的 durable `seq`（同一会话日志内单调）。
   *
   * 只对**会话归属**的通知有意义（当前只有未知事件用）：水位按会话记，所以它必须来自
   * 那条会话自己的日志。**共享通知不传 `seq`**（没有一条「会话日志」给它当序），
   * 传了会把共享那一档的水位拿去跟某个会话的号比较，判定就没有依据了。
   */
  seq?: number;
  /** 发生时刻；缺省用队列的时钟。测试用它钉住排序与时间。 */
  at?: number;
}

/** 队列里的一条通知记录（镜像给界面的形状与它同构）。 */
export interface NoticeRecord {
  /** 稳定 id：确认按它定位（界面看到哪个就确认哪个）。 */
  id: string;
  sessionId?: string;
  level: NoticeLevel;
  kind: string;
  key: string;
  text: string;
  /** 合并进来的实际发生次数（确认后新发生的从 1 重新计）。 */
  count: number;
  firstAt: number;
  lastAt: number;
  /**
   * 队列内的**单调发生序号**（每次新建 / 合并都取一个新的、更大的值）。
   *
   * 排序用它做 `lastAt` 的并列裁决：固定时钟（测试注入的 `now`，或者同一毫秒里连来
   * 两条）下光比时间戳排不出先后，也会把「刚合并的那条」留在原位。它只用于排序，
   * 不进镜像（界面的 key 是 `id`）。
   */
  order: number;
  acknowledged: boolean;
}

/** 已确认历史保留上限（未确认不淘汰）。 */
export const ACKED_HISTORY_LIMIT = 500;

/** 合并判据：归属 + 级别 + 类型 + 关键内容（见 `docs/design-notifications.md`）。 */
function sameSubject(
  record: NoticeRecord,
  input: NoticeInput,
): boolean {
  return (
    record.sessionId === input.sessionId &&
    record.level === input.level &&
    record.kind === input.kind &&
    record.key === subjectKeyOf(input)
  );
}

/**
 * 一条通知的「关键内容」：显式 `key` 优先，缺省整条 `text`（见 `NoticeInput.key`）。
 *
 * 缺省取 text 是**防漏**用的：插值过的标记天然把这次的目标 / 原因写进去了，漏传 key
 * 最多是多出几条通知，绝不会把不同目标的两条错并成一条。
 */
function subjectKeyOf(input: NoticeInput): string {
  return input.key ?? input.text;
}

/**
 * 通知队列。
 *
 * 不 import vscode，也不持有定时器；`now` 只为测试注入。
 */
export class NotificationQueue {
  /** 未确认记录（不淘汰，见文件头）。 */
  private readonly live: NoticeRecord[] = [];
  /** 已确认历史（最近 `ACKED_HISTORY_LIMIT` 条，最新的在后）。 */
  private readonly acked: NoticeRecord[] = [];
  /** 每会话已见到的最高 durable `seq`（缺省那一档是共享通知的水位）。 */
  private readonly watermarks = new Map<string, number>();
  private sequence = 0;
  /** 单调发生序号（排序的并列裁决，见 `NoticeRecord.order`）。 */
  private order = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 一次实际发生入队。
   *
   * @returns 合并 / 新建出来的那条记录；重发（`seq` 不比水位新）时返回 `undefined`
   */
  enqueue(input: NoticeInput): NoticeRecord | undefined {
    if (input.seq !== undefined && Number.isFinite(input.seq)) {
      const scope = input.sessionId ?? "";
      const watermark = this.watermarks.get(scope);
      if (watermark !== undefined && input.seq <= watermark) return undefined;
      this.watermarks.set(scope, input.seq);
    }
    const at = input.at ?? this.now();
    const existing = this.live.find((record) => sameSubject(record, input));
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      existing.order = (this.order += 1);
      return existing;
    }
    const record: NoticeRecord = {
      id: this.mintId(),
      sessionId: input.sessionId,
      level: input.level,
      kind: input.kind,
      key: subjectKeyOf(input),
      text: input.text,
      count: 1,
      firstAt: at,
      lastAt: at,
      order: (this.order += 1),
      acknowledged: false,
    };
    this.live.push(record);
    return record;
  }

  /**
   * 确认一条通知（用户明确知悉）。
   *
   * `seenCount` 是界面**当时**渲染出来的次数（重复点击 / 第二个视图用同一份镜像再确认时
   * 它与 `count` 相等，因此是幂等的）。它小于记录当前次数时，说明这次点击之前又合并
   * 进来过实际发生：只把看到的那部分移入历史，**剩余部分换一个全新 id** 继续未确认
   * ——旧 id 只存在于历史里，于是：
   * - 同一个 id 不会同时出现在未确认与已确认两份列表里（界面 key 不冲突）；
   * - 迟到的、基于旧镜像的再次确认（第二个视图 / 重复投递）找不到那个 id，是空操作，
   *   不会把用户没看见的那些发生一起吞掉。
   *
   * @returns 这次调用有没有改变队列（记录不存在 / 已经确认过时为 `false`）
   */
  acknowledge(id: string, seenCount?: number): boolean {
    const index = this.live.findIndex((record) => record.id === id);
    if (index < 0) return false;
    const record = this.live[index];
    const seen = Number.isFinite(seenCount)
      ? Math.max(1, Math.min(Math.floor(seenCount as number), record.count))
      : record.count;
    if (seen >= record.count) {
      this.live.splice(index, 1);
      this.pushAcked(record);
      return true;
    }
    this.pushAcked({ ...record, count: seen });
    this.live[index] = {
      ...record,
      id: this.mintId(),
      count: record.count - seen,
      order: (this.order += 1),
    };
    return true;
  }

  /**
   * 某个视图**可见**的通知（当前会话 + 共享；未绑定会话时只有共享）。
   *
   * 未确认与已确认混在一份里，按最近发生排序（`lastAt` 相同时按单调发生序号，
   * 于是固定时钟下新发生 / 刚合并的那条也会置顶）——顶部取第一条未确认，抽屉按同一份
   * 列表渲染并标出确认状态（见 `docs/design-notifications.md` 的展示与操作）。
   */
  visible(sessionId: string | undefined): NoticeRecord[] {
    return [...this.live, ...this.acked]
      .filter((record) => record.sessionId === undefined || record.sessionId === sessionId)
      .sort((left, right) => right.lastAt - left.lastAt || right.order - left.order)
      .map((record) => ({ ...record }));
  }

  /**
   * 会话被真正删除时丢掉它的 `seq` 水位**和它的通知记录**。
   *
   * 归档 / 关闭视图 / 断线重连都**不**调用：那条会话还能恢复或重新打开，水位要留着挡重发，
   * 通知也还能被重新打开的画面看到。删除是终结性的（会话日志与 id 都不会再来，控制器还把它
   * 记进 `deletedSessionIds`），此时不清理就是**永久留存**：没有任何窗口能绑到这条会话，
   * 它自己的未确认记录既不可见也不可确认，会一直占着队列；已确认的那部分还会占着
   * `ACKED_HISTORY_LIMIT` 的名额，把活着的会话的历史挤出去。
   *
   * **共享通知（没有归属）与其他会话的记录一律保留。**
   */
  forgetSession(sessionId: string): void {
    this.watermarks.delete(sessionId);
    this.dropSessionRecords(this.live, sessionId);
    this.dropSessionRecords(this.acked, sessionId);
  }

  /** 未确认条数（调试 / 断言用）。 */
  pendingCount(): number {
    return this.live.length;
  }

  /** 已确认历史条数（调试 / 断言用）。 */
  ackedCount(): number {
    return this.acked.length;
  }

  /** 记着水位的会话数（调试 / 断言用，见 `forgetSession`）。 */
  watermarkCount(): number {
    return this.watermarks.size;
  }

  /** 新 id：确认后新建 / 部分确认的剩余部分都用它（见 `acknowledge`）。 */
  private mintId(): string {
    return `n${(this.sequence += 1)}`;
  }

  /**
   * 就地从一份列表里摘掉某条会话的记录（`forgetSession` 用）。
   *
   * 只比会话归属：共享记录（`sessionId === undefined`）与其他会话都不会命中。
   */
  private dropSessionRecords(records: NoticeRecord[], sessionId: string): void {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].sessionId === sessionId) records.splice(index, 1);
    }
  }

  /** 已确认历史：最新在后；超出上限时丢最旧的。 */
  private pushAcked(record: NoticeRecord): void {
    this.acked.push({ ...record, acknowledged: true });
    while (this.acked.length > ACKED_HISTORY_LIMIT) this.acked.shift();
  }
}
