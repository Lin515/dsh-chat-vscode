/**
 * 按住 Ctrl/Cmd 时的全局状态（`webview/modifierHeld.ts`）。
 *
 * 用户口径：按住 Ctrl/Cmd 时，所有支持打开文件的节点都要出下划线提示；鼠标悬停
 * 也能单独出提示。这里钉住「修饰键状态从哪来、什么时候清掉」：
 *
 * - keydown / keyup 是主路径；
 * - pointermove / pointerdown 补「键盘焦点不在 webview」的一档；
 * - blur / 页面隐藏必须清掉，避免下划线永久挂着；
 * - 卸载后监听与根类都要收干净（StrictMode 双调用按引用计数合并）。
 *
 * 根类本身不重渲染 React，只是给 CSS 一个全局开关（见 `styles/app.css`）。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";

type Handler = (event: unknown) => void;

function eventTarget(): {
  addEventListener(type: string, handler: Handler): void;
  removeEventListener(type: string, handler: Handler): void;
  fire(type: string, event?: unknown): void;
  count(type: string): number;
} {
  const handlers = new Map<string, Set<Handler>>();
  return {
    addEventListener(type, handler) {
      const set = handlers.get(type) ?? new Set<Handler>();
      set.add(handler);
      handlers.set(type, set);
    },
    removeEventListener(type, handler) {
      handlers.get(type)?.delete(handler);
    },
    fire(type, event = {}) {
      for (const handler of [...(handlers.get(type) ?? [])]) handler(event);
    },
    count(type) {
      return handlers.get(type)?.size ?? 0;
    },
  };
}

const windowTarget = eventTarget();
const documentTarget = eventTarget();
const classes = new Set<string>();

(globalThis as unknown as Record<string, unknown>).window = windowTarget;
(globalThis as unknown as Record<string, unknown>).document = {
  hidden: false,
  documentElement: {
    classList: {
      toggle(name: string, force: boolean) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
    },
  },
  addEventListener: documentTarget.addEventListener,
  removeEventListener: documentTarget.removeEventListener,
};

const { installModifierHeld } = await import("../src/webview/modifierHeld");

const held = (): boolean => classes.has("is-modifier-held");

// ---------- 1. keydown / keyup ----------

{
  const uninstall = installModifierHeld();
  assert.strictEqual(held(), false, "初始不挂类");

  windowTarget.fire("keydown", { key: "Control", ctrlKey: true, metaKey: false });
  assert.strictEqual(held(), true, "按下 Ctrl 要挂类");

  windowTarget.fire("keyup", { key: "Control", ctrlKey: false, metaKey: false });
  assert.strictEqual(held(), false, "松开 Ctrl 要收掉");

  windowTarget.fire("keydown", { key: "Meta", ctrlKey: false, metaKey: true });
  assert.strictEqual(held(), true, "Cmd（Meta）同样算修饰键");

  uninstall();
  assert.strictEqual(held(), false, "卸载时要收掉根类");
}
console.log("modifierHeld: 按住 / 松开 Ctrl、Cmd 切根类；卸载收干净 ✓");

// ---------- 2. 指针事件补「没有键盘焦点」的一档 ----------

{
  const uninstall = installModifierHeld();
  windowTarget.fire("pointermove", { ctrlKey: true, metaKey: false });
  assert.strictEqual(held(), true, "指针事件带 Ctrl 时也要挂类（键盘焦点不在 webview）");

  windowTarget.fire("pointermove", { ctrlKey: false, metaKey: false });
  assert.strictEqual(held(), false, "指针事件不带修饰键时收掉");

  windowTarget.fire("pointerdown", { ctrlKey: false, metaKey: true });
  assert.strictEqual(held(), true, "pointerdown 同样更新状态");
  uninstall();
}
console.log("modifierHeld: 指针事件补上键盘焦点不在本窗口的一档 ✓");

// ---------- 3. blur / 页面隐藏必须清掉 ----------

{
  const uninstall = installModifierHeld();
  windowTarget.fire("keydown", { key: "Control", ctrlKey: true, metaKey: false });
  windowTarget.fire("blur");
  assert.strictEqual(held(), false, "窗口失焦时清掉，避免下划线永久挂着");

  windowTarget.fire("keydown", { key: "Control", ctrlKey: true, metaKey: false });
  const documentState = (globalThis as unknown as { document: { hidden: boolean } }).document;
  documentState.hidden = true;
  documentTarget.fire("visibilitychange");
  assert.strictEqual(held(), false, "页面隐藏时清掉");
  documentState.hidden = false;
  uninstall();
}
console.log("modifierHeld: 失焦 / 页面隐藏清掉状态 ✓");

// ---------- 4. 重复安装按引用计数合并，卸载后监听收干净 ----------

{
  const first = installModifierHeld();
  const second = installModifierHeld();
  assert.strictEqual(windowTarget.count("keydown"), 1, "重复安装只挂一份监听");

  first();
  assert.strictEqual(windowTarget.count("keydown"), 1, "还有一个安装者时监听不能撤");
  second();
  assert.strictEqual(windowTarget.count("keydown"), 0, "最后一个卸载者撤掉监听");

  windowTarget.fire("keydown", { key: "Control", ctrlKey: true, metaKey: false });
  assert.strictEqual(held(), false, "卸载后事件不再改状态");
}
console.log("modifierHeld: 重复安装合并、卸载后不再响应 ✓");

console.log("\nmodifierHeld: all assertions passed");
