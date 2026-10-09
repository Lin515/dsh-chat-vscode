import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 下拉弹层「打开即定位到当前选中项」的共用机制：模型列表与思考档位（reasoning effort）
 * **共用这一份**，两处不各写一套。
 *
 * 用户报障（2026-10-10）：点模型按钮展开列表后停在顶部，当前生效的模型可能在滚动视野
 * 之外；点思考强度按钮展开同一个弹层时同样。两处缺的是同一个动作——打开时把当前选中项
 * 滚进视野，并让它成为方向键的起点。
 *
 * ## 为什么是「键盘高亮」而不是把 DOM 焦点真挪进条目
 *
 * 这两条入口都是工具栏按钮，打开时焦点在按钮上。把焦点挪进条目看起来更贴「聚焦」这个词，
 * 但条目会随弹层卸载——关闭时焦点被丢给 `body`，于是 `Esc` 之后按回车不再能重开弹层，
 * 那是既有行为的退化。高亮只是多一个类，没有任何焦点副作用：`Esc` / 回车 / 点外部关闭
 * 逐字不变。
 *
 * ## 一个弹层两段可选内容，一次打开只定位一段
 *
 * 弹层里既有模型列表又有思考档位，方向键只能落在其中一段上：由**触发按钮**决定这一次
 * 打开定位哪一段（`group`）。「点模型按钮」定位到当前模型、「点思考强度按钮」定位到当前
 * 档位，走的都是下面这一套。
 */

/** 弹层里可键盘导航的一组条目（模型列表 / 思考档位各算一组）。 */
export interface PickerGroup<Key extends string = string> {
  /** 组的身份：既用于 `group` / `isHighlighted`，也是条目上的 `data-picker-item` 取值。 */
  key: Key;
  /** 条目数；0 = 这一段没有可选条目，方向键不理它。 */
  count: number;
  /** 当前生效项在组内的索引；`-1` = 认不出（那就退回第一项）。 */
  selected: number;
}

export interface PickerFocusOptions<Key extends string> {
  /** 弹层是否打开。 */
  open: boolean;
  /** 这一次打开要定位到哪一组——由触发按钮决定。 */
  group: Key;
  groups: ReadonlyArray<PickerGroup<Key>>;
}

export interface PickerFocus<Key extends string> {
  /**
   * 挂在弹层内容根节点上：滚动定位在它内部按 `data-picker-item` 找条目。
   *
   * 类型是 `RefObject<HTMLDivElement>`（不是 `| null` 那个写法）：这一层要**直接**喂给
   * JSX 的 `ref`，而当前 `@types/react` 只接受这个形状。
   */
  readonly bodyRef: RefObject<HTMLDivElement>;
  /** 该条目此刻是不是键盘高亮（JSX 据此加 `.is-active`）。 */
  isHighlighted(key: Key, index: number): boolean;
}

/**
 * 打开弹层时要定位到的条目索引；`-1` = 这一组没有可定位的条目。
 *
 * 认不出当前选中项（还没有选中、或目录换了导致索引过期）时退回第一项：**不留 `-1`**，
 * 否则「没有选中项」的部署会连方向键都没得用。
 */
export function initialFocusIndex(count: number, selected: number): number {
  if (count <= 0) return -1;
  return selected >= 0 && selected < count ? selected : 0;
}

/**
 * 方向键走一步之后的索引（`step` 为 ±1）：夹在两端、**不环绕**。
 *
 * 不环绕是刻意的：列表两端是语义上差别很大的东西（思考档位那一段的两头、模型列表的
 * 第一个与最后一个提供商），从末项跳回首项会让人以为列表换了。起点认不出时这一下不额外
 * 跳一格，先站到第一项。
 */
export function moveFocusIndex(current: number, count: number, step: number): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return 0;
  return Math.min(count - 1, Math.max(0, current + step));
}

/**
 * 把上面两条接到弹层上：维护高亮、接方向键、把高亮项滚进视野。
 *
 * 调用方要做的只有三件：把 `bodyRef` 挂到弹层内容根、给条目挂 `data-picker-item={组}`、
 * 用 `isHighlighted` 决定加不加 `.is-active`。
 */
export function usePickerFocus<Key extends string>(options: PickerFocusOptions<Key>): PickerFocus<Key> {
  const { open, group, groups } = options;
  const bodyRef = useRef<HTMLDivElement>(null);

  const spec = groups.find((item) => item.key === group);
  const initial = initialFocusIndex(spec?.count ?? 0, spec?.selected ?? -1);

  /**
   * 这一次打开的身份：触发组 + 每组条目数与选中项。任何一项变了都算新的一次打开——关掉
   * 再打开、中途换了触发按钮、目录或选中项更新，起点都要重新回到选中项，上一次方向键停
   * 在哪不能带过来。
   */
  const session = open ? `${group}|${groups.map((item) => `${item.key}:${item.count}:${item.selected}`).join(",")}` : "";

  /** 方向键走过的高亮。带 `session`：只认「这一次打开」里记下的位移。 */
  const [moved, setMoved] = useState<{ session: string; index: number } | null>(null);
  const index = open && moved?.session === session ? moved.index : initial;
  const highlightIndex = open ? index : -1;

  /**
   * 方向键监听读的是「此刻」的高亮与条目数，而不是注册那一刻的闭包（与 `Composer` 的
   * `latest` 同一写法）：否则每按一次键都要重装一次监听。
   */
  const latest = useRef({ session, index: highlightIndex, count: spec?.count ?? 0 });
  latest.current = { session, index: highlightIndex, count: spec?.count ?? 0 };

  useLayoutEffect(() => {
    // 换了一次打开（含关掉）就丢掉上一次的位移：它属于上一次的 session，留着只会等一个
    // 恰好同名的 session 再冒出来
    setMoved(null);
  }, [session]);

  useLayoutEffect(() => {
    if (highlightIndex < 0) return;
    const item = bodyRef.current?.querySelectorAll<HTMLElement>(`[data-picker-item="${group}"]`)[highlightIndex];
    // `block: "nearest"`：已经在视野里就一动不动（只滚到刚好露出选中项，不是把它顶到
    // 第一条）。滚动只落在这一个弹层容器里——触发按钮本来就在视野内，祖先没有需要滚动的
    // 东西，所以弹层的定位与翻转判定不受影响。
    item?.scrollIntoView({ block: "nearest" });
  }, [open, group, highlightIndex]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
      // 只接上下键：`Esc` / 回车 / `Tab` / 左右键一个字都不碰，弹层的既有行为由它自己负责
      if (step === 0 || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      // 焦点在输入框 / 问卷填空里时方向键是它自己的（上下移动光标、翻候选）
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable='true']")) return;
      const current = latest.current;
      if (current.index < 0 || current.count <= 0) return;
      // 抢在浏览器前面：这两下方向键不许滚动页面、也不许滚弹层自己
      event.preventDefault();
      setMoved({ session: current.session, index: moveFocusIndex(current.index, current.count, step) });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return {
    bodyRef,
    isHighlighted: (key, at) => highlightIndex >= 0 && key === group && at === highlightIndex,
  };
}
