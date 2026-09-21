import { useCallback, useState, type Dispatch, type SetStateAction } from "react";

/**
 * 折叠节点的**展开态**：由消息（`Message`）持有，而不是各行自己 `useState`。
 *
 * 两个理由，都是用户 2026-09-21 的口径：
 *
 * 1. **过程折叠会把整段成员卸载**：一轮结束时，这一轮里凑够阈值（`turnProcessThreshold`）
 *    的那一段过程会被折成一枚按钮，成员全部不渲染——状态放在行里就跟着没了。而用户要的是
 *    「这一段里有被他主动点开的节点，就不要自动折这一段」，能判定这件事的只有拥有成员
 *    清单的消息。
 * 2. **展开那一刻节点在不在跑，要一直记着**：跑着的时候点开 = 用户在看最新一行，所以
 *    跑完那一刻**新出现**的正文盒子（运行状态块 + 输入卡 → 结果卡 / 终端卡）也要贴底，
 *    而不是置顶（用户第 2 条口径）。这条意图与展开态同生共死——关掉再打开是一次新的
 *    展开，重新按当下状态判定——所以它和展开态存在一起，而不是散在各行的 ref 里。
 *
 * 纯逻辑（`hasUserOpenedNode` / `withNodeOpen` / `nodePortOf`）+ 一个 hook（`useNodeOpen`）：
 * `Message` 持有一份覆盖整条消息的状态，把端口发给每一行；行只读 `open` /
 * `openedWhileActive`、只写 `setOpen`，自己不留状态。
 */

/** 一个折叠节点的展开态与它的展开意图。 */
export interface NodeOpenRecord {
  /** 用户把它开着还是关着。 */
  open: boolean;
  /** 用户**点开它的那一刻**，这个节点是不是还在跑 / 还在长。 */
  openedWhileActive: boolean;
}

/** 行组件手上的那一份端口：读展开态、报用户开合。 */
export interface NodeOpenPort {
  /** `undefined` = 用户还没动过（行用各自的默认值，目前一律默认收起）。 */
  readonly open: boolean | undefined;
  /** 见 `NodeOpenRecord.openedWhileActive`；用户没动过时是 `false`。 */
  readonly openedWhileActive: boolean;
  /**
   * 用户手动开合。
   *
   * @param open 展开还是收起。
   * @param whileActive 这一刻节点是不是还在跑：工具 / 命令传 `running`，思考传 `streaming`。
   */
  setOpen(open: boolean, whileActive?: boolean): void;
}

/** 一份展开态（段 id → 记录）。 */
export type NodeOpenState = ReadonlyMap<string, NodeOpenRecord>;

export const NO_NODE_OPEN: NodeOpenState = new Map();

/**
 * 这些段里有没有**用户点开且还开着**的节点——过程折叠据此不自动折这一段。
 *
 * 只认 `open === true`：用户点开又自己收起的，没有要保住的东西。
 */
export function hasUserOpenedNode(
  state: NodeOpenState,
  segments: readonly { id: string }[],
): boolean {
  return segments.some((segment) => state.get(segment.id)?.open === true);
}

/** 写入一条记录，返回**新的一份**（React 要新引用才会重渲染）。 */
export function withNodeOpen(
  state: NodeOpenState,
  id: string,
  open: boolean,
  whileActive: boolean,
): NodeOpenState {
  const next = new Map(state);
  // 收起时把「跑着的时候点开的」一并清掉：下次展开重新判，不继承上一次的意图
  next.set(id, { open, openedWhileActive: open ? whileActive : false });
  return next;
}

/** `id` 那一行手上的端口。 */
export function nodePortOf(
  state: NodeOpenState,
  id: string,
  update: Dispatch<SetStateAction<NodeOpenState>>,
): NodeOpenPort {
  const record = state.get(id);
  return {
    open: record?.open,
    openedWhileActive: record?.openedWhileActive ?? false,
    setOpen: (open, whileActive = false) =>
      update((previous) => withNodeOpen(previous, id, open, whileActive)),
  };
}

/** 消息持有的那一份：`portOf(id)` 发给每一行，`state` 用于判定过程折叠要不要自动展开。 */
export function useNodeOpen(): {
  state: NodeOpenState;
  portOf: (id: string) => NodeOpenPort;
} {
  const [state, setState] = useState<NodeOpenState>(NO_NODE_OPEN);
  const portOf = useCallback((id: string) => nodePortOf(state, id, setState), [state]);
  return { state, portOf };
}
