/**
 * ESC 的**归属链**：一次按键只归一个消费者，没有消费者才轮到「停止生成」——
 * 而这一步只在**会话页**占据前景时存在。
 *
 * 归属散在各处时必然出现这三个问题，这条链就是为它们存在的：
 *
 * - 元素上的处理器只 `preventDefault`、没吃掉按键时，事件冒到 window 的兜底：
 *   用户只是想清掉选区 / 退出编辑，正在跑的那一轮被中止；
 * - 两个全局浮层都挂在同一个节点的同一阶段时，`stopPropagation` 互相拦不住，
 *   一次 ESC 把两层一起关掉。浮层的前后必须在**同一处**按显式层级裁决；
 * - 兜底本身被当成全局快捷键：轨迹整页 / 历史 / 任务抽屉在前景时，会话页已经让位，
 *   一次没人消费的 ESC 却还把正在跑的那一轮中止掉。「停止生成」是**会话页这个页面的
 *   动作**，页面不在前景，这个动作就不该存在。
 *
 * 于是只有三件事留在各自的地方，其余都收在这里：
 *
 * 1. **元素层**（输入框、绘图区这类靠焦点拿键的地方）：在自己的 `onKeyDown` 里调
 *    `consumeEscape`，按键的清理动作留在原处（焦点语义不变）；
 * 2. **全局浮层**：用 `useEscapeLayer` 在**活跃期间**登记，声明自己的 `ESC_LAYER`
 *    层级；谁先看由层级说了算，同层才按注册先后（后进先出）；
 * 3. **会话页的兜底**：由 App 用 `attachEscapeFallback` 装唯一监听，兜底是否成立由
 *    `isConversationForeground` 判（只有 `none` 面板为真）——非会话页面在前景时这一键
 *    什么都不做，不需要谁去「抢先消费」。
 *
 * 归属链本身挂在**唯一**一个 window 冒泡监听上（`attachEscapeFallback`）：元素层已经
 * 吃掉的事件到不了它；活跃浮层按层级消费；都没有、会话页在前景且生成中，才停止生成。
 * 会话切换不需要「清空归属栈」——层活着就登记着、浮层关了或组件卸载就注销（见
 * `useEscapeLayer`），无条件 reset 只会让仍然开着的浮层变成没人接管的键。
 */

import { useEffect, useRef } from "react";
import type { PanelKind } from "./state";

/**
 * 全局浮层的归属层级：**数大的先看**。层级与**视觉层级同序**（谁盖在谁上面，谁先消费），
 * 因为用户按下 ESC 时预期关掉的正是他看得见的最上面那层。
 *
 * 只给需要明确先后关系的层定层级，不按「谁后挂上」猜顺序——React 的 effect 会因为
 * 依赖变化重跑（原图的 `value`、回调新身份都会），注册先后不稳定。
 */
export const ESC_LAYER = {
  /** 自绘右键菜单：盖在原图浮层之上（视觉同序），一次 ESC 只关它。 */
  contextMenu: 30,
  /** 原图浮层：菜单关掉之后的下一次 ESC 才轮到它。 */
  imagePreview: 20,
  /**
   * 全屏模态抽屉（会话历史 / 后台任务）：带遮罩顶掉整页（`.drawer-backdrop` 盖住
   * 会话页），所以压过并列浮层；但它自己又在那两层全屏浮层之下（`.drawer` 的层级
   * 低于原图与右键菜单），先后也跟着排在它们后面——层级与视觉层级同序。
   */
  drawer: 15,
  /**
   * 其余并列浮层（通用 Popover、查找条、子代理目录）。它们可能同时开着（查找条与
   * Popover 就不互斥），不做先后假设：同级按注册先后，**登记得晚的先消费**。
   */
  floating: 10,
} as const;

/** 归属链要读的按键面：真的 `KeyboardEvent` 与 React 合成事件都满足。 */
export interface EscapeKeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
  /**
   * React 合成事件的原生事件。消费标记挂在**原生事件**上，于是「合成层消费了」
   * 这个事实能跟着同一次按键走到 window 上的原生监听（合成事件对象每次都是新的）。
   */
  nativeEvent?: unknown;
}

/** 一次 ESC 的归宿。 */
export type EscapeOutcome =
  /** 元素层（输入框 / 时间线绘图区…）已经消费：谁都不许再动这次按键。 */
  | "element"
  /** 某个活跃浮层消费（本次关闭的就是它）。 */
  | "layer"
  /** 没人认领：由调用方按「会话页在前景且生成中」决定要不要停止生成。 */
  | "unclaimed"
  /** 不是 ESC：一律放过。 */
  | "ignored";

/** 一个全局浮层登记进归属链时要交的两样东西。 */
export interface EscapeLayer {
  /** 归属层级（见 `ESC_LAYER`）。 */
  priority: number;
  /** 这次 ESC 归不归本层：true 表示已消费（调用方在这里关掉自己）。 */
  consume: () => boolean;
}

interface ActiveLayer extends EscapeLayer {
  /** 注册序号：只用来打破同层并列（后注册的先看）。 */
  sequence: number;
}

/** 消费标记：挂在事件（或它的原生事件）上，一次按键只认一个真相。 */
const ESCAPE_CONSUMED = Symbol("dsh.chat.escapeConsumed");

type Markable = { [ESCAPE_CONSUMED]?: boolean };

/** 标记落点：合成事件落到原生事件上，原生事件就落在自己身上。 */
function markable(event: EscapeKeyEvent): Markable {
  return (event.nativeEvent ?? event) as Markable;
}

/**
 * 这次按键是否已经被**本归属链**里的某一层消费。
 *
 * 刻意不看 `event.defaultPrevented`：那面旗子谁都能立（浏览器默认行为、其它模块的
 * 处理器），拿它当「ESC 已被接管」会让无关处理器顺手屏蔽掉停止生成。归属只认本模块
 * 盖的章。判据只经 `dispatchEscape` 出场，不外露（对外只需知道归宿）。
 */
function isEscapeConsumed(event: EscapeKeyEvent): boolean {
  return markable(event)[ESCAPE_CONSUMED] === true;
}

/** 活跃浮层：按注册序号索引，注销即删。 */
const activeLayers = new Map<number, ActiveLayer>();
let registerSequence = 0;

/**
 * 登记一个活跃浮层，返回**注销函数**（幂等）。
 *
 * 浮层活着就登记着：组件卸载 / 浮层关掉必须调注销，否则这次按键会被一个不存在的层
 * 永久吞掉（重复 render、StrictMode 的双跑 effect 都靠「注销幂等 + 每次 setup 重新
 * 登记」这一对动作对齐）。
 */
export function registerEscapeLayer(layer: EscapeLayer): () => void {
  const sequence = ++registerSequence;
  activeLayers.set(sequence, { ...layer, sequence });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLayers.delete(sequence);
  };
}

/** 归属顺序：层级高的先看，同层后注册的先看。 */
function orderedLayers(): ActiveLayer[] {
  return [...activeLayers.values()].sort(
    (a, b) => b.priority - a.priority || b.sequence - a.sequence,
  );
}

/**
 * 元素层消费一次 ESC：盖章 + 让浏览器别再处理 + 不再往上冒。
 *
 * 只负责「这次按键归本层了」，本层要做的事（清选区 / 退出编辑 / 关候选列表）由调用方
 * 接着做——焦点语义留在原处，归属只有一个出处。调用方必须先判定
 * `event.key === "Escape"`（见各处 `onKeyDown`）。
 */
export function consumeEscape(event: EscapeKeyEvent): void {
  markable(event)[ESCAPE_CONSUMED] = true;
  event.preventDefault();
  event.stopPropagation();
}

/**
 * 裁决一次按键：**元素层 > 活跃浮层（层级高者先）> 无人认领**。
 *
 * 已经把键吃掉的元素层通常连事件都到不了这里（它 `stopPropagation` 了）；这里仍先认
 * 自己的消费标记，是为了让「谁消费了」只有一个判据——将来某个元素层不方便拦冒泡时，
 * 兜底也不会把这一轮停掉。
 */
export function dispatchEscape(event: EscapeKeyEvent): EscapeOutcome {
  if (event.key !== "Escape") return "ignored";
  if (isEscapeConsumed(event)) return "element";
  for (const layer of orderedLayers()) {
    // 层自己的 consume 可能顺手把别的层关掉（同一次按键只允许消费一个）
    if (!activeLayers.has(layer.sequence)) continue;
    if (!layer.consume()) continue;
    consumeEscape(event);
    return "layer";
  }
  return "unclaimed";
}

/** 没人认领时兜什么底：**会话页**自己的动作。 */
export interface EscapeFallback {
  /** 会话页这一刻占据前景吗（判据见 `isConversationForeground`）。 */
  isConversationForeground: () => boolean;
  /** 这一刻在生成中吗。 */
  isRunning: () => boolean;
  /** 兜底动作：停止生成。 */
  stop: () => void;
}

/**
 * 会话页是否占据**前景**：只有它为真时，「无人认领的 ESC」才等于停止生成。
 *
 * 其余每个面板都在顶掉会话页，判据因此必须为假：
 *
 * - `trajectory`：轨迹是**整页**视图，会话页（消息列表 + 待办）整块卸载、输入区用
 *   `.app.is-trajectory` 移出布局并隐藏；
 * - `history` / `jobs`：抽屉带全屏遮罩（`.drawer-backdrop`，`inset: 0`），会话页在
 *   遮罩后面既点不到也发不了消息。
 *
 * 这些页面上按 ESC 不该中止会话，而这**不能**靠「浮层先消费」兜住：抽屉没登记为浮层、
 * 轨迹绘图区也只在聚焦时消费，没人认领的键照样会落到兜底上。所以判据放在兜底自身：
 * 为假时中止机制根本不存在，这一键就是没人认领、什么都不做。
 *
 * 写成**允许名单**（仅 `none` 为真）：将来新增的面板默认不触发中止，不会因为漏登记
 * 一个值就把正在跑的那一轮停掉。
 */
export function isConversationForeground(panel: PanelKind): boolean {
  return panel === "none";
}

/**
 * 归属链的**唯一**监听体（`attachEscapeFallback` 装的就是它）。
 *
 * 单独导出是为了离线回归能用**同一个**监听体走真实冒泡链（浮层顺序、前景判据与停止
 * 兜底都在这一段里，不能在测试里另写一份）。
 */
export function escapeFallbackListener(
  fallback: EscapeFallback,
): (event: EscapeKeyEvent) => void {
  return (event) => {
    if (dispatchEscape(event) !== "unclaimed") return;
    // 非会话页面占据前景：中止机制不存在，这一键到此为止（不是「被谁抢先消费」）
    if (!fallback.isConversationForeground()) return;
    // 没有消费者且生成中：停止。没有消费者又没在生成时什么都不做
    if (fallback.isRunning()) fallback.stop();
  };
}

/** 事件目标的最小面（真的 `window`；测试里是手写的事件链）。 */
interface EscapeTarget {
  addEventListener(type: string, listener: (event: EscapeKeyEvent) => void): void;
  removeEventListener(type: string, listener: (event: EscapeKeyEvent) => void): void;
}

/**
 * 装上唯一的 ESC 监听（App 挂载时一次，返回注销函数）。
 *
 * 用冒泡而不是捕获：元素层（输入框 / 绘图区）的处理器先有机会消费，浮层再按层级接手
 * ——焦点在哪，键就先归谁，这与「浮层抢在一切之前」的旧捕获顺序不同，有意为之。
 */
export function attachEscapeFallback(fallback: EscapeFallback): () => void {
  const listener = escapeFallbackListener(fallback);
  const target = globalThis as unknown as EscapeTarget;
  target.addEventListener("keydown", listener);
  return () => target.removeEventListener("keydown", listener);
}

/**
 * 组件侧：浮层**活跃期间**登记自己的归属，失活 / 卸载自动注销。
 *
 * 依赖只有 `[priority, active]`：`dismiss` 每次渲染的新身份经 ref 取最新，于是
 * 「回调换了身份」不会重注册、也不会把这一层挤到同层别的层后面（原图 `value` 一变
 * 就重注册，曾是「菜单被挤下去」的隐患）。`active` 为假时一个监听都不留。
 */
export function useEscapeLayer(priority: number, active: boolean, dismiss: () => void): void {
  const latest = useRef(dismiss);
  // 渲染期刷新最新回调：keydown 与渲染同线程，读到的必然是这一帧的闭包
  latest.current = dismiss;
  useEffect(() => {
    if (!active) return;
    return registerEscapeLayer({
      priority,
      consume: () => {
        latest.current();
        return true;
      },
    });
  }, [priority, active]);
}
