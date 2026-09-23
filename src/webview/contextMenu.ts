import { useEffect } from "react";
import { localImageMediaType } from "../shared/imageRef";
import { post } from "./bridge";
import { copyImageElement } from "./imageClipboard";
import type { Action } from "./state";
import type { Texts } from "./texts";

/**
 * 会话里的**自绘右键菜单**：正文给「复制 / 引用」，图片给「复制 / 保存」；
 * 其余地方的**原生菜单一律拦掉**，只有「右键压在自己选中的文字上」时才放行。
 *
 * ## 为什么必须自绘 / 必须全局接管
 *
 * webview 里的右键菜单是 VS Code 自己弹的（`webview/browser/pre/index.html` 监听
 * `contextmenu`：`defaultPrevented` 为真才 return，否则 `did-context-menu` 弹原生菜单），
 * 内容是那套「剪切 / 复制 / 粘贴」——在这个界面里除了复制都没有意义。所以换掉它 /
 * 拦掉它的唯一手段就是 `preventDefault()`。
 *
 * ## 挂在哪：`document`，**不能挂 `window`**
 *
 * VS Code 那个监听挂在**内层 iframe 的 `window`** 上，而且是在创建 iframe 时**同步**
 * 注册的（远早于我们这份脚本）。同节点同阶段按注册顺序派发，所以挂在 `window` 上的
 * 任何处理函数都**晚于**它：它先 `preventDefault()` 并弹菜单，我们再看 `defaultPrevented`
 * 就只剩「已处理」的结论，等于没接。挂在 `document` 上则天然更靠近目标节点，
 * 冒泡时先于 `window` 触发（React 的事件委托在 `#root`，仍早于我们，于是抽屉、轨迹页
 * 那些自己 `preventDefault()` 的特化处理照旧优先）。
 *
 * ## 判据（纯函数 `contextMenuKind`，顺序即优先级）
 *
 * 1. **可编辑元素**（输入框、问卷填空、目标编辑器）→ 放行原生菜单（自绘菜单做不了粘贴，
 *    吃掉它等于把粘贴删掉）；
 * 2. **图片**（缩略图 / 原图浮层 / 正文与子代理记录里的图）→ 自绘「复制 / 保存」；
 * 3. **会话正文区里有选中的文字** → 自绘「复制 / 引用」；
 * 4. **右键落点压在选中的文字上** → 放行原生菜单（那里有真正有用的 Copy）；
 * 5. 其余一切（正文区里没选区、头部、历史抽屉、子代理 / 后台任务面板、轨迹页……）
 *    → 拦掉，什么都不弹。
 *
 * 「引用」把选中文字以 **markdown 引用块**插进输入框（换行独立成块），落点算术在
 * `composerCompletion.quoteBlock`；「保存」走宿主（界面弹不了系统对话框、也读不了
 * 磁盘），见 `shared/ipc.ts` 的 `saveImage`。
 */

/** 右键该弹哪一种菜单。`native` = 不拦，交给系统；`blocked` = 拦下且不弹。 */
export type ContextMenuKind = "native" | "image" | "text" | "blocked";

/** 判据（DOM 无关：调用方把 DOM 事实翻成这几个字段，于是这套矩阵可以离线断言）。 */
export interface ContextMenuProbe {
  /** 落在可编辑元素里（`input` / `textarea` / `contenteditable`）。 */
  editable: boolean;
  /** 落在图片上。 */
  image: boolean;
  /** 落在会话正文区（`.chat-scroll`）里。 */
  inChat: boolean;
  /** 会话正文区里当前选中的文字（已 trim；空串 = 没有选中）。 */
  selectedText: string;
  /** 这次右键是否压在**当前选区**上（选区就在这一点上，不限于正文区）。 */
  onSelection: boolean;
}

export function contextMenuKind(probe: ContextMenuProbe): ContextMenuKind {
  if (probe.editable) return "native";
  if (probe.image) return "image";
  if (probe.inChat && probe.selectedText) return "text";
  if (probe.onSelection) return "native";
  return "blocked";
}

/** 菜单里的一条。`run` 在菜单关掉之后执行（关菜单不等于取消动作）。 */
export interface ContextMenuItem {
  id: string;
  label: string;
  run: () => void;
}

/** 浮层当前状态：视口坐标 + 条目。 */
export interface ContextMenuValue {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * 菜单状态走模块级订阅（与 `Images.tsx` 的原图浮层同一套写法）：弹出点是**窗口级
 * 的 `contextmenu` 事件**，它不在某个组件的 props 树里，而浮层挂在 App 根部一次。
 */
let value: ContextMenuValue | null = null;
const listeners = new Set<(value: ContextMenuValue | null) => void>();

export function openContextMenu(next: ContextMenuValue): void {
  value = next;
  for (const listener of listeners) listener(value);
}

export function closeContextMenu(): void {
  if (!value) return;
  value = null;
  for (const listener of listeners) listener(null);
}

export function subscribeContextMenu(listener: (value: ContextMenuValue | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function contextMenuValue(): ContextMenuValue | null {
  return value;
}

/** 可编辑元素的判据（与 `History.tsx` 放行系统菜单的那条逐字相同）。 */
const EDITABLE = "input, textarea, [contenteditable='true']";

/**
 * 会话正文区里当前选中的文字。
 *
 * 选区**两端都必须在正文区里**才作数：只按「有选区」判的话，头部 / 抽屉里残留的
 * 选区会被引进来（用户看不到选区，却引用了一段别处的文字）。
 */
export function chatSelectionText(chat: Element | null): string {
  if (!chat) return "";
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
  const text = selection.toString().trim();
  if (!text) return "";
  const inside = (node: Node | null): boolean => {
    if (!node) return false;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    return !!element && chat.contains(element);
  };
  return inside(selection.anchorNode) && inside(selection.focusNode) ? text : "";
}

/** 右键落点上的图片：缩略图是 `<button class="image-thumb">` 包着 `<img>`，落点常在按钮上。 */
function imageAt(target: Element): HTMLImageElement | null {
  if (target instanceof HTMLImageElement) return target;
  return target.closest(".image-thumb")?.querySelector("img") ?? null;
}

/** 图片地址（本地图是宿主换过 `src` 的 data URL，`currentSrc` 拿到的就是它）。 */
function imageSrc(image: HTMLImageElement): string {
  return image.currentSrc || image.src || image.getAttribute("src") || "";
}

/**
 * 保存对话框的建议文件名：`alt`**看着像图片文件名**才交给宿主。
 *
 * 图库的 `alt` 在有名字时是原文件名 / 本地路径，没有时是「消息里的图片」这类无障碍
 * 文案——后者当文件名只会得到一个 `Image in the message.png`。宿主另有「地址里的
 * 文件名 → `image`」两级兜底，所以这里给不出就不给。
 */
export function suggestedFileName(image: HTMLImageElement): string | undefined {
  const alt = image.alt?.trim();
  return alt && localImageMediaType(alt) ? alt : undefined;
}

/**
 * 这次右键是否压在**当前选区**上。
 *
 * 只在「没有特化菜单、也没有特化处理」的地方用来决定要不要放行原生菜单：放行的条件
 * 就是它——用户先选中了一段文字，再在这段文字上右键（浏览器自己也是这么判的）。
 * 用 `intersectsNode` 而不是比坐标：选区可能跨节点、还可能是多段。
 */
export function selectionCovers(target: Element): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(target)) return true;
  }
  return false;
}

/**
 * 页面级右键接取：按 `contextMenuKind` 的结论拦下 / 放行，并组装菜单条目。
 *
 * 挂 `document`（**不是 `window`**）：VS Code 自己那个监听挂在 window 上、注册得比我们
 * 早得多，挂 window 就等于排在它后面，永远只能看到 `defaultPrevented` 已经是 true（见
 * 文件头）。一处接住的理由与 `usePagePaste` 相同——原图浮层挂在 `.app` 之外，按容器
 * 各挂一个只会让同一套判据散开。
 */
export function usePageContextMenu(dispatch: (action: Action) => void, texts: Texts): void {
  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      // 别人已经处理过这次右键（抽屉、轨迹时间线这些地方自己 preventDefault 声明了在管）
      // ——与 VS Code 自己的判据一致，不能抢。
      if (event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const chat = target.closest(".chat-scroll");
      const image = imageAt(target);
      const selectedText = chatSelectionText(chat);
      const kind = contextMenuKind({
        editable: !!target.closest(EDITABLE),
        image: !!image,
        inChat: !!chat,
        selectedText,
        onSelection: selectionCovers(target),
      });
      if (kind === "native") return;

      event.preventDefault();
      if (kind === "blocked") {
        closeContextMenu();
        return;
      }

      if (kind === "image" && image) {
        const src = imageSrc(image);
        if (!src) {
          // 地址都没有（几乎不可能：画出来的图都有 src）——拦下菜单但不给一条点不动的
          closeContextMenu();
          return;
        }
        openContextMenu({
          x: event.clientX,
          y: event.clientY,
          items: [
            {
              id: "copy",
              label: texts.copy,
              run: () => {
                void copyImageElement(image).then((ok) => {
                  if (!ok) {
                    dispatch({ type: "ui/notice", level: "error", text: texts.imageCopyFailed });
                  }
                });
              },
            },
            {
              id: "save",
              label: texts.imageSave,
              // 磁盘上写哪儿由宿主弹对话框问（界面弹不了系统对话框，也读不了磁盘）
              run: () => post({ type: "saveImage", src, name: suggestedFileName(image) }),
            },
          ],
        });
        return;
      }

      openContextMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          {
            id: "copy",
            label: texts.copy,
            // 与「复制」按钮同一个入口（webview 里 navigator.clipboard 受限，交给宿主）
            run: () => post({ type: "copy", text: selectedText }),
          },
          {
            id: "quote",
            label: texts.quoteSelection,
            // 插进输入框光标处（不自动发送）：落点算术在 `quoteBlock`
            run: () => dispatch({ type: "ui/quoteText", text: selectedText }),
          },
        ],
      });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [dispatch, texts]);
}
