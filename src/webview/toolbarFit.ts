/**
 * 底部工具栏「按优先级 + **实测宽度**」决定这一帧显示哪些元素。
 *
 * ## 为什么不写死阈值
 *
 * 工具栏每一项的宽度都由**文案**决定，而文案的长度会变：
 * 权限名中英文差近一倍（「工作区写入」/ "Workspace Write"）、模型名长短不一、
 * tps 与上下文数字的位数会变，用户还能调字号（`dshChat.fontSize`）。
 * 所以「< 260px 就藏 tps」这类阈值必然是错的——换个语言或换个模型就错位：
 * 要么明明装得下却提前藏了，要么装不下还硬塞、把模型名挤成省略号。
 *
 * 这里的做法是**量出来**而不是猜出来：界面把每个候选档位渲染进一个不可见的
 * 测量层里（`Composer` 的 `.composer-measure`），用 `getBoundingClientRect()`
 * 读出各自的实际宽度，再按固定保底项与用户设置的优先级分配。窗口宽度、文案长度、字号、
 * 语言全都自动被这一步吃掉，源码里没有一个「多少像素该藏谁」的常数。
 *
 * 保底项始终先占位，其余按用户配置取前缀（默认沿用旧次序）。优先级不决定左右位置：
 * 视觉顺序固定在 Composer，调整谁能保留不会移动按钮。
 */
import type { ToolbarOptionId } from "../shared/toolbarPreference";

/** 工具栏里一个「槽位」的一个候选档位。 */
export interface ToolbarVariant {
  /** 槽位名（= 视觉位置）。同一槽位的多个档位互斥，最多只会选中一个。 */
  slot: string;
  /** 档位名（`icon` / `label` / `ring` / `text` / `full`），用来在节点表里取节点。 */
  level: string;
  /** 全局优先级，越小越先保住。 */
  rank: number;
  /** 实测宽度（px）。0 表示这一档在 DOM 里量不到（例如没有数据）。 */
  width: number;
  /** 保底档位：无论多窄都显示（用户口径的 P0）。 */
  pinned?: boolean;
}

/**
 * 固定保底档位不在偏好表里；同槽位的可选档位只会升级，不能挤掉保底项。
 */
const PINNED = ["context:ring", "permission:icon", "model:full", "send:full"] as const;
export type ToolbarVariantId = (typeof PINNED)[number] | ToolbarOptionId;

/** 先排保底，再排启用项；当前没有数据的项在分配前直接跳过。 */
export function toolbarOrder(
  enabled: readonly ToolbarOptionId[],
  available: (id: ToolbarVariantId) => boolean,
): Array<Omit<ToolbarVariant, "width"> & { id: ToolbarVariantId }> {
  return [...PINNED, ...enabled].flatMap((id, rank) => {
    if (!available(id)) return [];
    const [slot, level] = id.split(":");
    return [{ id, slot, level, rank, pinned: rank < PINNED.length }];
  });
}

/**
 * 按优先级挑出这一帧显示的档位：**优先级表的一个前缀**。
 *
 * 也就是说：一旦某一档装不下，排在它后面的档位这一帧也一概不显示。
 * 这不是偷懒，而是「优先级」这三个字的字面含义——
 * 若允许跳过装不下的高档去装低档（贪心填充），就会出现
 * 「附件按钮显示了、优先级更高的思考强度却没有」这种与口径相反的画面，
 * 而且拖宽侧栏时元素会**此起彼伏**（宽一点点：附件进来、上下文环被挤出去；
 * 再宽一点：上下文环又回来）——实测在 242~330px 之间会来回跳三次。
 * 前缀规则下宽度只增不减时元素只进不出，拖动过程干净。
 *
 * 代价是「装不下 A 档时不会拿 B 档去填那块空隙」，即可能出现一段空白；
 * 这是为了口径一致刻意接受的。
 *
 * @param variants 全部候选档位（宽度来自实测；缺数据的档位不要传进来）
 * @param available 工具栏的可用宽度（内容盒：已扣掉左右内边距）
 * @param gap 相邻元素之间的间距（读 `.composer-bar` 的 computed `column-gap`）
 * @returns 槽位名 → 选中的档位。**始终包含全部 `pinned` 档位**。
 */
export function pickVariants<T extends ToolbarVariant>(
  variants: readonly T[],
  available: number,
  gap: number,
): Map<string, T> {
  // 宽度向上取整再求和：浏览器给的是小数（高 DPI 下常见 .34 这种尾数），
  // 与整数可用宽度直接比大小，会在临界点上因半像素来回横跳。
  const widthOf = (variant: ToolbarVariant) => Math.ceil(variant.width);
  const ordered = [...variants].sort((a, b) => a.rank - b.rank);

  const chosen = new Map<string, T>();
  let used = 0;
  /** 装下一档后的总占宽：换档只花差价，新开一个槽位还要多一个间距。 */
  const after = (variant: ToolbarVariant) => {
    const current = chosen.get(variant.slot);
    return used - (current ? widthOf(current) : -gap) + widthOf(variant);
  };

  // P0 先无条件落位（用户口径：始终要显示），后面的档位在这份基数上排队
  for (const variant of ordered) {
    if (!variant.pinned) continue;
    used = after(variant);
    chosen.set(variant.slot, variant);
  }
  for (const variant of ordered) {
    if (variant.pinned) continue;
    const size = after(variant);
    // 装不下就到此为止：这个槽位保持上一档，后面的档位这一帧全部放弃
    if (size > available) break;
    used = size;
    chosen.set(variant.slot, variant);
  }
  return chosen;
}

/* ============================ 量宽的触发与前置条件 ============================
   上面是「怎么分配」，这里是「什么时候分配、什么时候**不**分配」。两者必须分开看：
   分配规则本身是对的，出问题的是把「量不出来」当成了「装不下」。 */

/**
 * 这一帧工具栏的可用宽度（内容盒宽度 = `clientWidth` 减去左右内边距）。
 *
 * **量不到盒时返回 `undefined`，调用方必须不结算、保留上一次那个有效档位。**
 * 宿主把整个 webview 隐藏起来时（用户切到别的 VS Code 标签或侧栏视图），文档视口
 * 还留着原来的宽度，但内层每一枚元素都**没有布局盒**：实测 `body` / `.app` /
 * `.composer` / `.composer-bar` 的 `clientWidth` 全是 0、`getClientRects()` 全为空。
 * 此时上式会算出 `0 - 左右内边距 = -16`，拿它分配就会把工具栏锁成最窄那一套；
 * 而如果恢复显示时恰好没有任何组件重渲染（工具栏自己的观察者又没跟上新节点，见
 * `createFitAnchor`），用户看到的就是「明明够宽却只剩最窄，动一下尺寸才恢复」。
 *
 * 判据必须是**盒在不在**，不能是「宽度够不够」：
 * - 真正的极窄栏（内容盒只剩十几像素、连 P0 都排不下）**有盒**，必须照常按前缀规则
 *   折叠——`available` 因此可能是 0 甚至负数，那仍是一个有效答案；
 * - 轨迹页那种让位是 `visibility: hidden`，**盒还在、宽度实测不变**，测量照旧有效。
 */
export function toolbarAvailableWidth(input: {
  /** 元素是否还在文档里（断开 = 拿不到盒）。 */
  isConnected: boolean;
  /** `getClientRects().length > 0`：有没有布局盒。 */
  hasBox: boolean;
  /** `clientWidth`：内边距盒宽度（含内边距，不含边框与滚动条）。 */
  clientWidth: number;
  padLeft: number;
  padRight: number;
}): number | undefined {
  if (!input.isConnected || !input.hasBox || !(input.clientWidth > 0)) return undefined;
  return input.clientWidth - input.padLeft - input.padRight;
}

/** `ResizeObserver` 里本模块用到的那一面（测试可注入假实现，不必有 DOM）。 */
export interface FitObserver {
  observe: (target: Element) => void;
  disconnect: () => void;
}

/** 工具栏「量宽」的观察者锚：把**当前那一枚** `.composer-bar` 与一枚观察者绑在一起。 */
export interface FitAnchor<El extends HTMLElement = HTMLElement> {
  /**
   * 交给 React 的 `ref`。React 18 口径：收 `node | null`、**不返回清理函数**
   * （带清理函数的是 React 19 的写法）。`null` 表示旧节点已卸载。
   */
  attach: (node: El | null) => void;
  /** 断开观察者：幂等，卸载时调用。 */
  dispose: () => void;
}

/**
 * 观察者**跟着节点走**，而不是「挂载时看一眼当时的节点」。
 *
 * 此前的写法是在 `useEffect(..., [barRef, fit])` 里 `observer.observe(barRef.current)`。
 * 那两个依赖（ref 对象与 `useCallback` 出来的 `fit`）在组件生命周期里恒稳定，于是这个
 * effect 只在**挂载**时跑一次，之后节点被换掉也永不重挂。而 `.composer-bar` 确实会被换掉：
 * 只读子代理会话那一支（`state.subagent.mode === "one-shot"`）渲染的是
 * `div.composer-readonly`，与 `div.composer-shell` 是同类型 div，React 复用外层那个 div、
 * 只把子树换掉，`.composer-bar` 于是是新元素；实测换完之后工具栏**彻底不再跟随自身宽度
 * 变化**（只改自己的可用宽度，档位也不再重算），恢复只能靠别的组件恰好重渲染。
 *
 * 用 callback ref 承担这件事，语义有三条：
 * - 任一时刻**最多一枚**观察者，且只观察当前这一枚节点（换节点时先断开旧的）；
 * - 同一枚节点重复 `attach` 是**幂等**的（React 18 的 StrictMode 会把 effect 走一遍
 *   「挂载 → 清理 → 再挂载」，而 cleanup 会把观察者断掉；调用方因此在 effect 的 setup
 *   里再 `attach` 一次当前节点，幂等才不会白多一枚观察者）；
 * - `onNode` 把节点同步给调用方（`fit` 读宽度要用），`null` 也要同步。
 */
export function createFitAnchor<El extends HTMLElement>(
  fit: () => void,
  onNode: (node: El | null) => void,
  createObserver: (callback: () => void) => FitObserver = (callback) => new ResizeObserver(callback),
): FitAnchor<El> {
  let observer: FitObserver | null = null;
  let current: El | null = null;
  const dispose = () => {
    observer?.disconnect();
    observer = null;
    current = null;
  };
  return {
    attach(node) {
      if (node !== null && node === current && observer) return;
      dispose();
      onNode(node);
      if (!node) return;
      observer = createObserver(fit);
      observer.observe(node);
      current = node;
    },
    dispose,
  };
}
