import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  closeContextMenu,
  contextMenuValue,
  subscribeContextMenu,
  type ContextMenuValue,
} from "../contextMenu";

/**
 * 自绘右键菜单浮层（App 根部挂一次）。
 *
 * 状态与判据都不在这里（见 `contextMenu.ts`）：这个组件只管「画在哪儿、什么时候
 * 收起来」。四条关闭路径缺一不可——选了一条、点了别处、按 ESC、滚动或改窗口大小
 * （菜单钉在**视口坐标**上，正文一滚它就跟点它的那张图错位了）。
 */
export function ContextMenuLayer() {
  const [value, setValue] = useState<ContextMenuValue | null>(contextMenuValue);

  useEffect(() => {
    setValue(contextMenuValue());
    return subscribeContextMenu(setValue);
  }, []);

  useEffect(() => {
    if (!value) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".ctx-menu")) return;
      closeContextMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // ESC 要**吃掉**：App 另有一个 window 级 ESC（中止生成），菜单开着时它必须先收菜单
      // （与 `Images.tsx` 的原图浮层同一条优先级链，普通按键不拦）。
      event.stopPropagation();
      closeContextMenu();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", closeContextMenu, true);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", closeContextMenu, true);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [value]);

  // 贴边修正：先按落点画出来，量到真实尺寸后再往里推（量之前不知道菜单有多宽）。
  const ref = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    setOffset({ x: 0, y: 0 });
    const node = ref.current;
    if (!node || !value) return;
    const rect = node.getBoundingClientRect();
    const margin = 4;
    // 右侧 / 下方放不下就翻到落点的另一侧；再放不下就贴边（宁可压住落点，也不出界）
    const x =
      value.x + rect.width + margin > window.innerWidth
        ? Math.max(margin, value.x - rect.width)
        : value.x;
    const y =
      value.y + rect.height + margin > window.innerHeight
        ? Math.max(margin, value.y - rect.height)
        : value.y;
    setOffset({ x: x - value.x, y: y - value.y });
    // 焦点进菜单（第一条）：箭头键才有的可动，否则键盘用户只剩下 ESC
    node.querySelector<HTMLButtonElement>(".ctx-menu-item")?.focus();
    // 尺寸只跟「换了一次菜单」走：位置修正自己不该再触发一轮测量
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!value) return null;
  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: `${value.x + offset.x}px`, top: `${value.y + offset.y}px` }}
      // 菜单自己身上的右键不该把系统菜单弹上来（窗口级判据看它不在正文区，会放行）
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".ctx-menu-item")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = items[(at + step + items.length) % items.length];
        next?.focus();
      }}
    >
      {value.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          className="ctx-menu-item"
          onClick={() => {
            // 先收菜单再执行：动作可能弹宿主侧的保存对话框，菜单留在屏幕上会挡着
            closeContextMenu();
            item.run();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
