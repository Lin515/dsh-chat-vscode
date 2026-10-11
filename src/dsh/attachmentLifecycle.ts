import type { Attachment, UploadState } from "../shared/chat";
import type { IntakeUpload } from "./attachments";

/**
 * **附件草稿**的归属与上传生命周期（唯一权威表）。
 *
 * 附件草稿 = 供一次消息提交选择的附件及其上传状态：未绑定会话的窗口暂归窗口
 * （键 = viewId），绑定之后归所属会话（键 = 会话 id）；**切换查看会话不改变已有
 * 附件的归属**。这份 module 只表达这项生命周期，不碰发送 / 队列政策（草稿文本、
 * 队列、乐观回显都不在这里）。
 *
 * ## 三条结构性保证
 *
 * 1. **归属按持有者身份，不按字符串键**：键会搬（`move`），持有者对象不变；上传的结算
 *    落在开轮那一刻那个持有者上，与窗口此刻看的是哪条会话无关。没人看那条会话就不推帧。
 * 2. **上传的时序全在里面**：开轮（`start` / `retry`）→ 一次 IO → 结算成 ready / error。
 *    宿主只注入一次 IO，不存在「调用方忘了结算」这条漏法。同一枚附件**最多一轮在飞**
 *    （重复 start / 连点重试并成一轮），作废的轮次（被移除 / 被回收 / 被新一轮顶掉）
 *    迟到回来一律丢弃——既不复活已删的芯片，也不覆盖新一轮。
 * 3. **提交是「移走」而不是「销毁」**（`detach` / 提交租约）：一次提交把可见芯片移进
 *    **提交租约**（按 requestId 认），可见列表清空、字节与在飞轮次原样保留。于是：
 *    - 这次提交失败、且没有可承载失败的回显行时，`returnLease` 把**原来那些对象**
 *      （上传状态 / 回执 / 暂存字节 / 在飞那一轮）整份还回输入框，能力不退化；
 *    - 失败红行（有回显）引用租约里那一份活条目，因此在飞完成后**重发**拿得到真回执；
 *    - 重发是**租约交接**（`transferLease`）：换一个 requestId 继续持有，不取消在飞的
 *      上传、不重启、也不放回输入框；
 *    - 只有提交真的收场了才 `releaseLease`：durable 承认、用户撤回、命令执行、没有回显
 *      的提交成功，以及回显被上限淘汰。**租约数量因此由回显表本身与这套完整接线兜住**；
 *      越过告警阈值只记一条开发者日志，**从不按数量销毁**（销毁等于静默丢掉某条失败行的
 *      重试能力，见 `LEASE_WARN_THRESHOLD`）。
 *
 * 字节跟着**持有者**（可见草稿或租约）走：只有字节来源（拖放 / 粘贴）需要账本替它留
 * 一份，且只为「失败后重试 / 回填后重试」而留；成功后立即释放，移除 / 回收 / 释放租约 /
 * dispose 一并释放。
 *
 * ## 与调用方的分工
 *
 * 控制器负责：读字节与 `DshClient.uploadFile`（`performUpload`）、失败原因文案
 * （`describeError`）、把最新列表交给界面（`publish`，由它决定是会话广播还是发给空态
 * 窗口），以及把 `detach` / `returnLease` / `releaseLease` / `transferLease` 接在自己的
 * 提交与回显生命周期上（哪些时刻该收场见各方法的注释）。**归属与上传的记账全在这里**。
 */

/** 一次上传的来源：路径来源由宿主重读磁盘，字节来源用账本暂存的那一份。 */
export type AttachmentUploadSource = IntakeUpload["source"];

export interface PerformUploadInput {
  /** 上传打在**开轮那一刻**的会话上：切会话不改它。 */
  sessionId: string;
  source: AttachmentUploadSource;
  name: string;
}

/** 账本要宿主做的三件事：一次上传 IO、失败原因文案、把最新列表交给界面。 */
export interface AttachmentLifecyclePorts {
  /**
   * 真正的一次上传：路径来源重读磁盘、字节来源用给的那一份，再走官方同一条路由
   * （`DshClient.uploadFile`）。失败就抛，原因由 `describeError` 落成芯片文案。
   */
  performUpload(input: PerformUploadInput): Promise<{ receiptId: string }>;
  /** 上传失败的原因文案（`@key` 或服务端原文），写进芯片的错误态。 */
  describeError(error: unknown): string;
  /** 某个键上的可见列表变了：把**最新一份**交给界面（调用方决定按会话广播还是发窗口）。 */
  publish(key: string, attachments: readonly Attachment[]): void;
  /** 开发者日志（上传失败、租约兜底等），可选。 */
  log?(message: string): void;
}

export interface AttachmentChangeOptions {
  /**
   * 要不要把最新列表下发给界面，默认下发。
   *
   * `false` 留给「调用方自己合成一帧」的几处：发送失败时把正文与附件**合成一个**
   * `draft + attachments` 补丁（`appendDraft`）、发送前按会话键复述清空、以及队列还原
   * 回填。那几处若由账本先推一帧、调用方再推一帧，界面上是两帧连续的同字段补丁。
   */
  publish?: boolean;
}

/** 「没有会话可传」：语言中立标记，由界面查词典（不在宿主里写死中文）。 */
const NO_SESSION = "@uploadNoSession";

/**
 * 在飞租约数的**告警**阈值（只记日志，**从不销毁**）。
 *
 * 真实上限由接线决定：每份租约都挂在一个回显或一次在飞提交上，而回显有
 * `MAX_PENDING_MESSAGES × MAX_PENDING_KEYS` 这道闸（见 `controller.ts`），所以这里取它的
 * 两倍——接线正确时永远碰不到；碰到就说明有地方漏了 `releaseLease`，那时记一条日志指出
 * 来。**碰到也不许销毁任何一份**：租约背后是某条失败行的重试能力（或一次仍在飞的提交），
 * 按数量丢最旧等于静默丢用户的数据。
 */
const LEASE_WARN_THRESHOLD = 1024;

/** 没有这一份时的只读空表（每次新建一个空数组会在快照热路径上白分配）。 */
const NONE: readonly Attachment[] = [];

/**
 * 一轮在飞的上传。
 *
 * 它是**私有**的：调用方拿不到、也不可能伪造一轮，于是「必须配对地结算」不是一条靠人
 * 记住的规则，而是结构上没有第二条路。`holder` 是可变的引用——换键 / 两份合并 / 提交移走 /
 * 租约交接 / 归还时把一轮正在飞的上传重新指向新的持有者，结算因此永远落在正确那份账上。
 */
interface InflightUpload {
  holder: AttachmentHolder;
  attachmentId: string;
  name: string;
  source: AttachmentUploadSource;
  /** 被移除 / 被回收 / 被替代置真：之后迟到的结算一律丢弃。 */
  cancelled: boolean;
}

/**
 * 一份附件条目的持有者：**可见草稿**（`detached: false`，按键挂）或**提交租约**
 * （`detached: true`，按 requestId 挂）。
 *
 * 两者的记账规则完全一样（条目 / 暂存字节 / 在飞轮次），差别只有一条：租约不是界面上的
 * 草稿，**结算不许推帧**（它的条目只被失败行与回填引用）。
 */
interface AttachmentHolder {
  /** 可见草稿的键；租约没有键（只按 requestId 认），这里是空串。 */
  key: string;
  detached: boolean;
  list: Attachment[];
  bytes: Map<string, Uint8Array>;
  pending: Map<string, InflightUpload>;
}

export class AttachmentLifecycle {
  /** 可见草稿：键 → 持有者。 */
  private readonly records = new Map<string, AttachmentHolder>();
  /** 提交租约：requestId → 持有者（一次提交的芯片，收场之前一直在这里）。 */
  private readonly leases = new Map<string, AttachmentHolder>();
  private disposed = false;

  constructor(private readonly ports: AttachmentLifecyclePorts) {}

  /**
   * 某个归属键此刻的附件草稿（只读）。
   *
   * 键不存在给空表；返回的是账本里那一份，调用方**只读**（要发给界面请经 `publish`，
   * 它推的也是这一份）。
   */
  list(key: string | undefined): readonly Attachment[] {
    if (key === undefined) return NONE;
    return this.records.get(key)?.list ?? NONE;
  }

  /** 接下一批附件草稿（按 `id` 去重；这一批就是 `planIntake` 判出来的那几枚）。 */
  add(key: string, attachments: readonly Attachment[], options?: AttachmentChangeOptions): void {
    if (this.disposed) return;
    const record = this.ensureRecord(key);
    const seen = new Set(record.list.map((attachment) => attachment.id));
    for (const attachment of attachments) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      record.list.push(attachment);
    }
    this.publishNow(record, options);
  }

  /**
   * 整份替换一个键上的列表：调用方已经按自己的身份口径合并好了（队列「取回重新编辑」
   * 的回填用它——同回执 / 同 durable 句柄 / 图片同字节都算同一份，那套判据在
   * `queueView.appendRestoredAttachments`）。
   *
   * **掉出列表的那些枚一并作废**：在飞轮次取消、暂存字节释放。这条是「字节与轮次只跟着
   * 列表走」的落点——移除也只是它的特例，调用方造不出「列表里没有、却还占着字节或在飞
   * 轮次」的孤儿。
   */
  replace(key: string, attachments: readonly Attachment[], options?: AttachmentChangeOptions): void {
    if (this.disposed) return;
    const record = this.ensureRecord(key);
    const next = new Set(attachments.map((attachment) => attachment.id));
    for (const existing of record.list) {
      if (!next.has(existing.id)) this.discard(record, existing.id);
    }
    record.list = [...attachments];
    this.publishNow(record, options);
  }

  /**
   * 用户删掉一枚芯片：列表里去掉它，并**同时**作废它在飞的那一轮、释放它的暂存字节。
   *
   * 作废是关键：那一轮迟到回来时既不能把芯片复活，也不能在一份已经变了样的列表上结算。
   */
  remove(key: string, id: string): void {
    if (this.disposed) return;
    const record = this.records.get(key);
    if (!record) return;
    const index = record.list.findIndex((attachment) => attachment.id === id);
    if (index < 0) return;
    record.list.splice(index, 1);
    this.discard(record, id);
    this.ports.publish(record.key, record.list);
  }

  /**
   * 整份列表换键：空壳窗口首次绑定（viewId → 会话 id）与退回空态（会话 id → viewId）。
   *
   * 判据是「这个键上有一份记录」而不是「列表非空」——提交后的空表也算一份，要跟着搬
   * （否则绑定之后会话键下读到的是更早的值）。目标键上已经有一份时**合并**而不是覆盖
   * （两个窗口共用一条空壳时，后绑定者不该顶掉先者的草稿），在飞的那一轮跟着条目走。
   *
   * 只搬**可见草稿**：提交租约按 requestId 认、与键无关（所以窗口解绑不会误杀会话的失败行
   * 重试能力，见 `release`）。
   *
   * **不推帧**：两个调用点（绑定 / 退回空态）随后都会推一份整份状态快照，那一帧就带着
   * 搬过去的列表。
   */
  move(from: string, to: string): void {
    if (this.disposed || from === to) return;
    const source = this.records.get(from);
    if (!source) return;
    this.records.delete(from);
    const target = this.records.get(to);
    if (!target) {
      source.key = to;
      this.records.set(to, source);
      return;
    }
    this.absorb(target, source);
  }

  /**
   * 回收一个**可见草稿**键：窗口下线（键是 viewId 的那一份）与扩展停用。
   *
   * 两件刻意不做的事：
   * - **会话键那一份不回收**——切走 / 新建对话之后用户还要切回来接着发，草稿必须留着；
   * - **不按 key 连带回收提交租约**——租约按 requestId 认，挂在一个回显或一次在飞提交上；
   *   按 key 连带回收会在「另一个窗口解绑」时误杀某条会话的失败行重试能力。租约由提交自己
   *   的生命周期收场（见 module 头注释第 3 条）。
   */
  release(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    this.abandon(record);
  }

  /**
   * 提交那一刻：把可见芯片**移进这次提交的租约**（按 requestId 认），可见列表清空并下发。
   *
   * 同一 requestId 再来一次就并进同一份租约——`send` 在建会话 / 绑定之后还会按会话键复述
   * 一次清空（防共享空壳把别的窗口的芯片合并进来），那次必须并入同一个租约而不是另开一份。
   *
   * 返回租约里此刻的条目（调用方用它让失败红行引用**活的那一份**），没有可移的条目时返回
   * `undefined`。**不销毁任何东西**：字节与在飞轮次原样保留。
   */
  detach(key: string, requestId: string, options?: AttachmentChangeOptions): readonly Attachment[] | undefined {
    if (this.disposed) return undefined;
    // 与早先的提交帧序一致：这个键上没有记录也照样下发一份空表（界面凭它收芯片）
    const record = this.ensureRecord(key);
    const existing = this.leases.get(requestId);
    if (record.list.length === 0) {
      this.publishNow(record, options);
      return existing ? [...existing.list] : undefined;
    }
    const lease = existing ?? this.createLease(requestId);
    this.absorb(lease, record);
    this.publishNow(record, options);
    return [...lease.list];
  }

  /**
   * 重发时的**租约交接**：把租约换到这次新提交的 requestId 上继续持有。
   *
   * 重发不许取消仍在飞的上传、不许重启、也不许把芯片放回输入框——只是换一个提交身份继续
   * 持有它（旧 requestId 那一行已经撤回，新的一行接管）。旧 requestId 没有租约时是空操作
   * （撤回一条本来就没有附件的消息、或租约已经收场）。
   */
  transferLease(fromRequestId: string, toRequestId: string): void {
    if (this.disposed || !fromRequestId || fromRequestId === toRequestId) return;
    const lease = this.leases.get(fromRequestId);
    if (!lease) return;
    this.leases.delete(fromRequestId);
    const target = this.leases.get(toRequestId);
    if (!target) {
      this.leases.set(toRequestId, lease);
      return;
    }
    this.absorb(target, lease);
  }

  /** 这次提交此刻持有的租约条目（只读）；没有租约给 `undefined`。 */
  lease(requestId: string): readonly Attachment[] | undefined {
    return this.leases.get(requestId)?.list;
  }

  /**
   * 提交失败、把内容还回输入框时**归还租约**：整份并回这个键上的可见列表，在飞轮次重新
   * 指回可见记录（于是它照旧结算、照旧能被重试）。
   *
   * 返回归还后的可见列表（没租约时 `undefined`，调用方按老口径把手上那一批放回去）。
   * 按 id 去重（可见列表在前），所以调用方紧接着 `add` 同一批界面副本不会重复。
   */
  returnLease(
    requestId: string,
    key: string,
    options?: AttachmentChangeOptions,
  ): readonly Attachment[] | undefined {
    if (this.disposed) return undefined;
    const lease = this.leases.get(requestId);
    if (!lease) return undefined;
    this.leases.delete(requestId);
    const target = this.ensureRecord(key);
    this.absorb(target, lease);
    this.publishNow(target, options);
    return [...target.list];
  }

  /**
   * 这次提交真的收场了：最终释放它的租约（取消在飞轮次、释放暂存字节、丢掉条目）。
   *
   * 调用点就是「这条提交不再被任何人引用」的那些时刻：durable 承认、用户撤回、命令执行、
   * 没有回显的提交成功、回显被上限淘汰。
   */
  releaseLease(requestId: string): void {
    const lease = this.leases.get(requestId);
    if (!lease) return;
    this.leases.delete(requestId);
    this.abandon(lease);
  }

  /**
   * 起一轮上传：把芯片置成「上传中」，让宿主传一次，结果由账本自己结算。
   *
   * 同一枚附件已经有一轮在飞时并成一轮（判定在 `open` 里，**早于**收字节——重复的 start
   * 不许把在飞那一轮的来源换掉）。没有会话可传时（空壳窗口 / 客户端还没接上）不打 IO，
   * 直接落 `@uploadNoSession`。
   */
  start(key: string, id: string, sessionId: string | undefined, source: AttachmentUploadSource): void {
    if (this.disposed) return;
    const record = this.records.get(key);
    const attachment = record?.list.find((entry) => entry.id === id);
    if (!record || !attachment) return;
    this.open(record, attachment, sessionId, source);
  }

  /**
   * 重试一枚失败的附件：来源从账本自己取——暂存的字节优先，否则退回附件自己的路径。
   *
   * 三种情况都是空操作（不假装还能再传）：还在一轮在飞（见 `open`）、已经有回执
   * （成功之后没有「再传一次」这回事）、两者都没有（字节来源且那一份已经释放）。
   */
  retry(key: string, id: string, sessionId: string | undefined): void {
    if (this.disposed) return;
    const record = this.records.get(key);
    const attachment = record?.list.find((entry) => entry.id === id);
    if (!record || !attachment) return;
    if (attachment.upload?.status === "ready") return;
    const staged = record.bytes.get(id);
    const source: AttachmentUploadSource | undefined = staged
      ? { kind: "bytes", bytes: staged }
      : attachment.path
        ? { kind: "path", path: attachment.path }
        : undefined;
    if (!source) return;
    this.open(record, attachment, sessionId, source);
  }

  /** 扩展停用：所有可见草稿、提交租约、暂存字节与在飞轮次一起清掉，之后不再接受记账。 */
  dispose(): void {
    for (const record of this.records.values()) this.abandon(record);
    for (const lease of this.leases.values()) this.abandon(lease);
    this.records.clear();
    this.leases.clear();
    this.disposed = true;
  }

  private ensureRecord(key: string): AttachmentHolder {
    const existing = this.records.get(key);
    if (existing) return existing;
    const created = this.holder(key, false);
    this.records.set(key, created);
    return created;
  }

  /** 新开一份提交租约（越过告警阈值只记一条日志：**不销毁任何一份**，见 `LEASE_WARN_THRESHOLD`）。 */
  private createLease(requestId: string): AttachmentHolder {
    const lease = this.holder("", true);
    this.leases.set(requestId, lease);
    if (this.leases.size === LEASE_WARN_THRESHOLD) {
      this.ports.log?.(
        `[attach] 在飞提交租约达到 ${LEASE_WARN_THRESHOLD} 份（告警阈值）：` +
          `检查是否有地方漏了 releaseLease；这里不丢弃任何一份（可能是失败行的重试能力）`,
      );
    }
    return lease;
  }

  private holder(key: string, detached: boolean): AttachmentHolder {
    return { key, detached, list: [], bytes: new Map(), pending: new Map() };
  }

  /**
   * 把 `source` 的条目 / 暂存字节 / 在飞轮次并进 `target`（按 id 去重，`target` 在前），
   * 并让在飞轮次改指 `target`；`source` 到此作废。
   *
   * 换键相遇、提交移走、租约交接、归还全都走这一处——「在飞的那一轮跟着条目走」只有一份实现。
   */
  private absorb(target: AttachmentHolder, source: AttachmentHolder): void {
    const seen = new Set(target.list.map((attachment) => attachment.id));
    for (const attachment of source.list) {
      if (seen.has(attachment.id)) continue;
      seen.add(attachment.id);
      target.list.push(attachment);
    }
    for (const [id, bytes] of source.bytes) if (!target.bytes.has(id)) target.bytes.set(id, bytes);
    for (const [id, round] of source.pending) {
      const existing = target.pending.get(id);
      if (existing) existing.cancelled = true;
      round.holder = target;
      target.pending.set(id, round);
    }
    source.list.length = 0;
    source.bytes.clear();
    source.pending.clear();
  }

  private open(
    holder: AttachmentHolder,
    attachment: Attachment,
    sessionId: string | undefined,
    source: AttachmentUploadSource,
  ): void {
    // 同一枚附件最多一轮在飞：判据必须在**收字节之前**——否则重复的 start（连点 / 重复的
    // 接入请求）会把在飞那一轮的字节来源换成新的一份，第一轮失败后「重试」传的就是从未
    // 验过的那份字节。在飞的一律并成一轮，来源以先到者为准。
    if (holder.pending.has(attachment.id)) return;
    if (source.kind === "bytes") holder.bytes.set(attachment.id, source.bytes);
    const round: InflightUpload = {
      holder,
      attachmentId: attachment.id,
      name: attachment.name,
      source,
      cancelled: false,
    };
    holder.pending.set(attachment.id, round);
    attachment.upload = { status: "uploading", loaded: 0 };
    this.publishNow(holder, undefined);
    void this.run(round, sessionId);
  }

  private async run(round: InflightUpload, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      this.settle(round, { status: "error", message: NO_SESSION });
      return;
    }
    try {
      const value = await this.ports.performUpload({
        sessionId,
        source: round.source,
        name: round.name,
      });
      this.settle(round, { status: "ready", receiptId: value.receiptId });
    } catch (error) {
      this.ports.log?.(`[upload] ${round.name} 上传失败：${this.ports.describeError(error)}`);
      this.settle(round, { status: "error", message: this.ports.describeError(error) });
    }
  }

  /**
   * 结算一轮：**只有**这一轮仍是那个持有者上那一枚附件当前的在飞轮次时才落地。
   *
   * 三道门都在这一处：轮次被作废（移除 / 回收 / 替代）、被新一轮顶掉（同一枚附件最多一轮
   * 在飞）、附件已经不在持有者手里（既不复活、也不把字节留在账上）。持有者被换键 / 合并 /
   * 移进租约 / 交接**不是**门：`round.holder` 跟着条目走，结算照常落到那份账上。
   */
  private settle(round: InflightUpload, state: UploadState): void {
    if (round.cancelled) return;
    const holder = round.holder;
    if (holder.pending.get(round.attachmentId) !== round) return;
    holder.pending.delete(round.attachmentId);
    const target = holder.list.find((attachment) => attachment.id === round.attachmentId);
    if (!target) {
      holder.bytes.delete(round.attachmentId);
      return;
    }
    target.upload = state;
    // 成功之后没有「再传一次」这回事（界面只在失败态给重试），字节到此为止
    if (state.status === "ready") holder.bytes.delete(round.attachmentId);
    // 租约不是可见草稿：结算只更新条目（失败行 / 回填引用它），不许推帧
    if (!holder.detached) this.ports.publish(holder.key, holder.list);
  }

  /** 去掉一枚附件的在飞轮次与暂存字节（移除 / 被替换时）。 */
  private discard(holder: AttachmentHolder, id: string): void {
    const round = holder.pending.get(id);
    if (round) {
      round.cancelled = true;
      holder.pending.delete(id);
    }
    holder.bytes.delete(id);
  }

  /** 整份持有者作废（回收 / 释放租约 / dispose）：在飞轮次全部取消，字节全释放。 */
  private abandon(holder: AttachmentHolder): void {
    for (const round of holder.pending.values()) round.cancelled = true;
    holder.pending.clear();
    holder.bytes.clear();
    holder.list.length = 0;
  }

  private publishNow(holder: AttachmentHolder, options: AttachmentChangeOptions | undefined): void {
    if (holder.detached) return;
    if (options?.publish === false) return;
    this.ports.publish(holder.key, holder.list);
  }
}
