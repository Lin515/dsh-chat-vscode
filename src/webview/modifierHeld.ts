/**
 * 全局修饰键状态 → 根元素上的 `is-modifier-held` 类。
 *
 * 为什么用根类而不是 React state：按住 Ctrl/Cmd 时**所有**可打开文件的节点都要出
 * 下划线提示；走 App 的 state 会把整棵消息树重渲染一遍，这里只切一个类，样式由
 * CSS 负责（见 `styles/app.css` 的 `.is-modifier-held` 规则）。
 *
 * 事件来源：
 * - `keydown` / `keyup`：键盘焦点在 webview 时的主路径；
 * - `pointermove` / `pointerdown`：焦点不在 webview 时收不到 keydown，但指针事件
 *   自带修饰键位（例如按住 Ctrl 从别的应用移回聊天面板）；
 * - `blur` / `visibilitychange`：键盘状态不可靠时清掉，避免下划线永久挂着。
 *
 * 只读修饰键位，不拦截事件、不 preventDefault。
 */

let held = false;

/** 正在安装的窗口数：React StrictMode 的开发期双调用要能正确收尾。 */
let installs = 0;

const windowHandlers = new Map<string, EventListener>();
let visibilityHandler: EventListener | undefined;

function apply(next: boolean): void {
  if (held === next) return;
  held = next;
  if (typeof document !== "undefined") {
    document.documentElement.classList.toggle("is-modifier-held", next);
  }
}

function sync(event: Event): void {
  const modifier = event as KeyboardEvent;
  apply(modifier.ctrlKey === true || modifier.metaKey === true);
}

function clear(): void {
  apply(false);
}

function bindWindow(type: string, handler: EventListener): void {
  window.addEventListener(type, handler, true);
  windowHandlers.set(type, handler);
}

/**
 * 开始跟踪修饰键。返回卸载函数；App 在挂载期间调用一次。
 *
 * 重复安装按引用计数合并，只有最后一次卸载才真正移除监听与根类。
 */
export function installModifierHeld(): () => void {
  installs += 1;
  if (installs === 1 && typeof window !== "undefined") {
    bindWindow("keydown", sync);
    bindWindow("keyup", sync);
    // 指针事件补「没有键盘焦点」的一档：按住 Ctrl 移回聊天面板时也能看到提示。
    bindWindow("pointermove", sync);
    bindWindow("pointerdown", sync);
    bindWindow("blur", clear);
    if (typeof document !== "undefined") {
      visibilityHandler = () => {
        if (document.hidden) clear();
      };
      document.addEventListener("visibilitychange", visibilityHandler);
    }
  }
  return () => {
    installs = Math.max(0, installs - 1);
    if (installs > 0) return;
    if (typeof window !== "undefined") {
      for (const [type, handler] of windowHandlers) {
        window.removeEventListener(type, handler, true);
      }
      windowHandlers.clear();
    }
    if (typeof document !== "undefined" && visibilityHandler !== undefined) {
      document.removeEventListener("visibilitychange", visibilityHandler);
      visibilityHandler = undefined;
    }
    clear();
  };
}
