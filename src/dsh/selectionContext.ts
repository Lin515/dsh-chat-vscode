import type { SelectionContextView } from "../shared/ipc";
import { selectionDirectoryKey } from "../shared/mentions";
import { localFileReference, remoteFileReference, remoteSelectionCwdKey, type SelectionFacts } from "./selection";

interface ViewFacts {
  sessionId: string | undefined;
  cwd: string | undefined;
}

type BoundViewFacts = ViewFacts & { sessionId: string };

interface SelectionHost {
  activeViewId(): string | undefined;
  /** 未绑定的窗口提供新会话目录，已绑定的窗口提供会话执行目录。 */
  view(viewId: string): ViewFacts;
  initialCwd(): string | undefined;
  connectionCurrent(connectionId: string): boolean;
  publish(viewId: string, context: SelectionContextView | null): void;
  log(message: string): void;
}

type Target = Readonly<{
  viewId: string;
} & (
  // 本机相对引用只接受可折算的目录键。
  | { kind: "local"; sessionId: string | undefined; cwdKey: string }
  // 只读副本还依赖原连接；其目录键只用于比较，无法折算时也保留原值。
  | { kind: "remote"; sessionId: string; cwdKey: string | undefined; connectionId: string }
)>;

type Chip = Readonly<SelectionContextView>;
type ChipContent = Omit<Chip, "id">;

interface Pending {
  /** null 表示同一来源的鼠标选区暂时为空。 */
  context: ChipContent | null;
  timer: ReturnType<typeof setTimeout>;
}

interface Delivery {
  // 占位与待投递芯片必定同属一个目标；迁移替换它，不改写任何已交给发送的快照。
  target: Target;
  displayed?: Chip;
  pending?: Pending;
}

/** 按下发送时取出的引用，与之后的选区、焦点、投递状态无关。 */
export interface SelectionSubmission {
  readonly token: string;
  /** 取消时回填的会话；未绑定时由调用方按实际落点回填。 */
  readonly sessionId: string | undefined;
  /** 调用方须先确认实际发送的会话域仍是来源窗口当前绑定的域。 */
  readonly matches: (destination: BoundViewFacts) => boolean;
}

const DEBOUNCE_MS = 300;

function sameContent(displayed: Chip | undefined, next: ChipContent): boolean {
  return displayed?.token === next.token && displayed.preview === next.preview;
}

/**
 * 自动引用的投递与发送资格。宿主提供即时事实和输出端口，本模块不持有 VS Code、
 * 会话域、IPC 或提交账本。防抖只延迟投递，不重读编辑器或重算 token。
 */
export class SelectionContext {
  private delivery?: Delivery;
  private sequence = 0;
  private registered = false;
  private initialView?: string;
  private beforeFirstView?: { facts: SelectionFacts; cwdKey: string };

  constructor(private readonly host: SelectionHost) {}

  viewRegistered(viewId: string): void {
    if (this.registered) return;
    this.registered = true;
    this.initialView = viewId;
    const initial = this.beforeFirstView;
    this.beforeFirstView = undefined;
    if (initial && initial.cwdKey === selectionDirectoryKey(this.host.view(viewId).cwd)) {
      this.capture(initial.facts);
    }
  }

  activeViewChanged(previous: string | undefined): void {
    if (previous !== this.host.activeViewId()) this.clear("活动窗口变化");
  }

  /** 恢复出的默认窗口可以接手本机引用，但必须能证明是同一会话、同一执行目录。 */
  restoreActiveView(viewId: string): void {
    const delivery = this.delivery;
    const target = delivery?.target;
    if (!delivery || !target || target.viewId === viewId) return;
    if (target.kind !== "local" || !this.matches(target, this.host.view(target.viewId)) ||
        !this.matches(target, this.host.view(viewId))) {
      this.clear("恢复活动窗口与引用目标不匹配");
      return;
    }
    delivery.target = { ...target, viewId };
    if (this.initialView === target.viewId) this.initialView = viewId;
    if (delivery.displayed) {
      this.host.publish(target.viewId, null);
      this.host.publish(viewId, delivery.displayed);
    }
  }

  viewClosed(viewId: string): void {
    if (this.initialView === viewId) this.initialView = undefined;
    if (viewId === this.host.activeViewId()) this.clear("活动窗口关闭");
  }

  /** 绑定变更已确定，宿主在替换旧绑定前给出新事实；未给出新绑定表示解绑。 */
  bindingChanged(viewId: string, next?: BoundViewFacts & { automaticBlank: boolean }): void {
    const initial = this.initialView === viewId;
    if (initial) this.initialView = undefined;
    const delivery = this.delivery;
    if (!delivery || viewId !== this.host.activeViewId()) return;
    const { target } = delivery;
    if (next?.automaticBlank && initial && target.kind === "local" && target.viewId === viewId &&
        target.sessionId === undefined && this.host.view(viewId).sessionId === undefined &&
        target.cwdKey === selectionDirectoryKey(next.cwd)) {
      // 自动补同目录空壳只更新今后的投递归属，正在发送的快照仍是按下时的目标。
      delivery.target = { ...target, sessionId: next.sessionId };
    } else {
      this.clear(next ? "活动会话绑定变化" : "活动会话解绑");
    }
  }

  executionWorldChanged(): void {
    if (this.delivery || this.beforeFirstView) this.clear("连接执行环境变化");
  }

  /** 执行目录、绑定或原连接事实变化后，立即撤下已失效的投递。 */
  refresh(): void {
    if (this.beforeFirstView && this.beforeFirstView.cwdKey !== selectionDirectoryKey(this.host.initialCwd())) {
      this.clear("执行目录变化");
    }
    const target = this.delivery?.target;
    if (target && (target.viewId !== this.host.activeViewId() || !this.matches(target, this.host.view(target.viewId)))) {
      this.clear("目标、执行目录或原连接变化");
    }
  }

  capture(facts: SelectionFacts): void {
    const viewId = this.host.activeViewId();
    if (!viewId) {
      // 只允许首次开窗消费开窗前的本机选区，旧窗口关闭后不能跨窗继承。
      if (facts.remoteFile) return this.clear("只读副本不属于活动会话或原连接已失效");
      if (this.registered) {
        this.host.log("[selection] 未投递：无活动聊天窗口");
        return;
      }
      const cwdKey = selectionDirectoryKey(this.host.initialCwd());
      if (!cwdKey) return this.clear("执行目录未知或不支持");
      this.beforeFirstView = { facts, cwdKey };
      this.host.log("[selection] 暂存：等待首次聊天窗口");
      return;
    }
    const view = this.host.view(viewId);
    if (facts.remoteFile) {
      const { sessionId, connectionId, path } = facts.remoteFile;
      if (sessionId !== view.sessionId || !this.host.connectionCurrent(connectionId)) {
        return this.clear("只读副本不属于活动会话或原连接已失效");
      }
      const token = remoteFileReference(path, view.cwd, facts.lines);
      if (token === undefined) return this.clear("无法引用只读副本的原路径");
      this.queue({ kind: "remote", viewId, sessionId, connectionId, cwdKey: remoteSelectionCwdKey(view.cwd) },
        { token, preview: facts.preview });
      return;
    }
    const cwdKey = selectionDirectoryKey(view.cwd);
    if (!cwdKey) return this.clear("执行目录未知或不支持");
    const token = localFileReference(facts.filePath, view.cwd, facts.lines);
    if (token === undefined) return this.clear("文件不在执行目录或路径不支持");
    this.queue({ kind: "local", viewId, sessionId: view.sessionId, cwdKey }, { token, preview: facts.preview });
  }

  /** 只有同一编辑器来源的鼠标折叠才走这里；其他折叠由采样方立即清除。 */
  deferCollapse(): void {
    this.refresh();
    const delivery = this.delivery;
    if (!delivery?.displayed) return this.clear("选区为空");
    this.schedule(delivery, null);
  }

  replay(viewId: string): void {
    const chip = this.displayedFor(viewId);
    if (chip) this.host.publish(viewId, chip);
  }

  dismiss(viewId: string, id: number): void {
    if (this.displayedFor(viewId)?.id === id) this.clear("用户收起引用");
  }

  referenceForSend(viewId: string, id: number | undefined, token: string | undefined): SelectionSubmission | undefined {
    const chip = this.displayedFor(viewId);
    const delivery = this.delivery;
    // 防抖期间旧芯片只是占位；IPC 传回的标识与 token 都必须命中稳定的投递。
    if (delivery && !delivery.pending && chip && chip.id === id && chip.token === token) {
      const { target } = delivery;
      return {
        token: chip.token,
        sessionId: target.sessionId,
        // 按下时未绑定的本机引用允许落到同目录会话；只读副本不能转移会话或原连接。
        matches: (destination) => this.matches(target, destination, true),
      };
    }
    if (token !== undefined) this.host.log("[selection] 未随发送提交：界面引用已失效或不匹配");
    return undefined;
  }

  clear(reason: string): void {
    const old = this.delivery;
    this.disposeDelivery();
    // 诊断只记录分支，不记录路径、行号、文本、引用或会话标识。
    this.host.log(`[selection] 未投递或已撤下：${reason}`);
    if (old?.displayed) this.host.publish(old.target.viewId, null);
  }

  dispose(): void {
    this.disposeDelivery();
    this.initialView = undefined;
  }

  private disposeDelivery(): void {
    clearTimeout(this.delivery?.pending?.timer);
    this.delivery = undefined;
    this.beforeFirstView = undefined;
  }

  private displayedFor(viewId: string): Chip | undefined {
    this.refresh();
    return this.delivery?.target.viewId === viewId ? this.delivery.displayed : undefined;
  }

  private matches(target: Target, view: ViewFacts, allowInitialBinding = false): boolean {
    if (target.kind === "remote") {
      return target.sessionId === view.sessionId && this.host.connectionCurrent(target.connectionId) &&
        target.cwdKey === remoteSelectionCwdKey(view.cwd);
    }
    return (target.sessionId === view.sessionId || (allowInitialBinding && target.sessionId === undefined)) &&
      target.cwdKey === selectionDirectoryKey(view.cwd);
  }

  private queue(target: Target, context: ChipContent): void {
    this.refresh();
    const previous = this.delivery?.target;
    if (previous && (previous.kind !== target.kind ||
        (previous.kind === "remote" && target.kind === "remote" && previous.connectionId !== target.connectionId))) {
      this.clear("引用来源身份变化");
    }
    const delivery = this.delivery ?? (this.delivery = { target });
    if (!delivery.pending && sameContent(delivery.displayed, context)) return;
    this.schedule(delivery, context);
  }

  private schedule(delivery: Delivery, context: ChipContent | null): void {
    clearTimeout(delivery.pending?.timer);
    const pending: Pending = { context, timer: setTimeout(() => this.deliver(delivery, pending), DEBOUNCE_MS) };
    delivery.pending = pending;
  }

  private deliver(delivery: Delivery, pending: Pending): void {
    if (this.delivery !== delivery || delivery.pending !== pending) return;
    this.refresh();
    if (this.delivery !== delivery) return;
    delivery.pending = undefined;
    const next = pending.context;
    if (!next) return this.clear("鼠标选区为空");
    // 回到同一选区：到此才恢复发送资格，不换标识，也不重发帧。
    if (sameContent(delivery.displayed, next)) return;
    const chip = { ...next, id: ++this.sequence };
    delivery.displayed = chip;
    this.host.log("[selection] 已投递引用");
    this.host.publish(delivery.target.viewId, chip);
  }
}
