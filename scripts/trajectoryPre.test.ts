/**
 * 轨迹「一段原文」呈现件（`src/webview/components/TrajectoryPre.tsx`）与其换行偏好
 * （`src/webview/trajectoryPre.ts`）的离线断言。
 *
 * 三条腿，各自钉一件容易漂的事：
 * 1. **默认不换行**：官方 JSON 树打底是 `white-space: pre`（`ui-primitives` 的
 *    `.stringRaw`），只有 `[data-wrap='true']` 才切 `pre-wrap`。这一条曾以相反的口径
 *    存在过（`.trajectory-pre` 常开 `pre-wrap`），把参数 / Schema 的 JSON 缩进结构
 *    打散——判据落在渲染出来的 `data-wrap` 与样式表那条属性选择器上。
 * 2. **渲染不写偏好**：只有用户拨开关才落盘。渲染期顺手写一下看起来无害，后果是
 *    「打开一次轨迹页就把用户的偏好改成当前默认值」。
 * 3. **每段原文都带上这两个动作**：`Trajectory.tsx` 里不许再有裸的
 *    `<pre className="trajectory-pre">`（收口前有十几处，各自长什么样全靠自觉）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 最小 `window`：`bridge.ts` 在模块求值期就挂了 `window.addEventListener`
 * （webview 里那是真实存在的宿主），无头环境里不给它一个就会在 import 阶段炸。
 *
 * **必须补在静态 `import` 之前**：静态导入会被提升到文件最前，而 esbuild 把本地
 * 模块内联进产物、按依赖顺序求值，所以「写在 import 语句前的赋值」根本来不及生效。
 * 办法是**把这些模块改成动态导入**（下面那几个 `await import`）——静态区只剩
 * 不碰 `window` 的那几个。与 `scripts/questionRender.test.ts` 同一套解法。
 */
(globalThis as { window?: unknown }).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
};

const { TrajectoryPre } = (await import("../src/webview/components/TrajectoryPre")) as {
  TrajectoryPre: ComponentType<{ text: string; copyTitle: string; wrapTitle: string }>;
};
const { TextsContext, dictionaryFor } = (await import("../src/webview/texts")) as {
  TextsContext: { Provider: ComponentType<{ value: unknown; children?: ReactNode }> };
  dictionaryFor: (locale: "zh" | "en") => unknown;
};
const { toggleWrap } = (await import("../src/webview/trajectoryPre")) as {
  toggleWrap: (value: boolean) => boolean;
};

const ZH = dictionaryFor("zh");
const EN = dictionaryFor("en");

const WIN = globalThis as unknown as { window: { localStorage: unknown } };

/** 装一份内存版 `localStorage`（初始内容由调用方给），返回恢复用的回调。 */
function installStorage(initial: Map<string, string>): () => void {
  const store = initial;
  WIN.window.localStorage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return () => {
    WIN.window.localStorage = undefined;
  };
}

/** 装一份**访问即抛**的 `localStorage`（隐私模式 / 存储被禁用那一支）。 */
function installBrokenStorage(): () => void {
  WIN.window.localStorage = {
    get getItem(): never {
      throw new Error("storage disabled");
    },
  };
  return () => {
    WIN.window.localStorage = undefined;
  };
}

/** 渲染一段原文（语言走 `TextsContext`，「已复制到剪贴板」那句从它取）。 */
function render(text: string, locale: "zh" | "en" = "zh"): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: locale === "zh" ? ZH : EN },
      createElement(TrajectoryPre, {
        text,
        copyTitle: locale === "zh" ? "复制参数" : "Copy parameters",
        wrapTitle: locale === "zh" ? "自动换行" : "Wrap lines",
      }),
    ),
  );
}

// ---------- 1. 默认不换行、两个动作都在 ----------
{
  const store = new Map<string, string>();
  const restore = installStorage(store);
  let html = "";
  try {
    html = render('{\n  "path": "src/index.ts"\n}');
  } finally {
    restore();
  }

  assert.ok(
    /data-wrap="false"/.test(html),
    `默认必须是**不换行**（与官方 JSON 树的 \`white-space: pre\` 一致），现在是 ${html.slice(0, 120)}`,
  );
  assert.ok(!/data-wrap="true"/.test(html), "没存过偏好时不该出现已换行态");
  assert.ok(
    (html.match(/<button/g) ?? []).length === 2,
    "每段原文恰好两个动作：自动换行 + 复制",
  );
  assert.ok(/aria-pressed="false"/.test(html), "换行开关要是按下态控件（aria-pressed）");
  assert.ok(
    /title="自动换行"/.test(html) && /title="复制参数"/.test(html),
    "两个按钮的悬停说明都要给（复制那颗按段落内容分）",
  );
  assert.ok(
    !/已复制到剪贴板/.test(html),
    "成功态那句只在点过之后出现，初值里不该有",
  );
  assert.strictEqual(store.size, 0, "**渲染不许写偏好**：只有用户拨开关才落盘");
}

// ---------- 2. 偏好存过 `1` 时，新渲染的段落直接是换行态 ----------
{
  const store = new Map<string, string>([["dsh.trajectory.jsonStringWrapping", "1"]]);
  const restore = installStorage(store);
  let html = "";
  try {
    html = render("一段很长的正文");
  } finally {
    restore();
  }
  assert.ok(/data-wrap="true"/.test(html), "存过「换行」的偏好要在这段渲染时被采到");
  assert.ok(/aria-pressed="true"/.test(html), "开关的按下态要跟上偏好");
  assert.ok(
    /class="icon-btn is-on"/.test(html),
    "已换行时开关要亮成「已打开」态（`.icon-btn.is-on`）",
  );
}

// ---------- 3. 读不到存储（隐私模式 / 被禁用）时退回默认 ----------
{
  const restore = installBrokenStorage();
  let html = "";
  try {
    html = render("正文");
  } finally {
    restore();
  }
  assert.ok(/data-wrap="false"/.test(html), "存储读不出来时退回「不换行」，不能把这一页弄挂");
}

// ---------- 4. 拨开关是纯取反（`toggleWrap`）----------
assert.strictEqual(toggleWrap(false), true, "常态拨一下 = 换行");
assert.strictEqual(toggleWrap(true), false, "换行态拨一下 = 不换行");

// ---------- 5. `Trajectory.tsx` 里不许再有裸的 `.trajectory-pre` ----------
{
  const source = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Trajectory.tsx"),
    "utf8",
  );
  const bare = source.match(/<pre className="trajectory-pre"/g) ?? [];
  assert.strictEqual(
    bare.length,
    0,
    `裸的 \`<pre className="trajectory-pre">\` 会让那一段没有复制 / 换行（收口前有十几处）：还有 ${bare.length} 处`,
  );
  assert.ok(
    /<TrajectoryPre/.test(source),
    "检查器的原文一律走 `TrajectoryPre` 呈现件",
  );
}

// ---------- 6. 样式表：默认 `pre`、按 `data-wrap` 切 `pre-wrap` ----------
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const base = /^\.trajectory-pre\s*\{([\s\S]*?)\}/mu.exec(css)?.[1] ?? "";
  assert.ok(base.length > 50, "app.css 里找不到 `.trajectory-pre` 主规则");
  assert.ok(
    /white-space:\s*pre\s*;/.test(base),
    `主规则必须是 \`white-space: pre\`（不换行是默认，官方 JSON 树同款），现在是 "${base.match(/white-space:[^;]*;/)?.[0]}"`,
  );
  const wrapped = /^\.trajectory-pre\[data-wrap="true"\]\s*\{([\s\S]*?)\}/mu.exec(css)?.[1] ?? "";
  assert.ok(wrapped.length > 0, "app.css 里找不到 `.trajectory-pre[data-wrap=\"true\"]`");
  assert.ok(
    /white-space:\s*pre-wrap/.test(wrapped) && /word-break:\s*break-all/.test(wrapped),
    "换行档要与官方 `[data-wrap='true']` 同一套（pre-wrap + break-all，长 URL 也断得开）",
  );
  // 动作条**在流内**、排在正文字段那一段之前：浮层版会把两颗按钮压在正文首行上
  // （不换行 + 长首行是最常见的形态），所以这一条钉的是「不许再改回绝对定位」。
  const actions = /^\.trajectory-pre-actions\s*\{([\s\S]*?)\}/mu.exec(css)?.[1] ?? "";
  assert.ok(actions.length > 20, "app.css 里找不到 `.trajectory-pre-actions`");
  assert.ok(
    !/position:\s*absolute/.test(actions),
    "动作条不许绝对定位（会盖住正文首行）；要它占一行、在流内",
  );
  assert.ok(
    /justify-content:\s*flex-end/.test(actions),
    "动作条靠右（正文块左对齐，按钮贴右上）",
  );
  const block = /^\.trajectory-pre-block\s*\{([\s\S]*?)\}/mu.exec(css)?.[1] ?? "";
  assert.ok(/min-width:\s*0/.test(block), "正文块要能被窄侧栏压窄（min-width: 0）");
}

console.log("trajectoryPre: 默认不换行 + 两个动作齐备 + 渲染不写偏好 ✓");
console.log("trajectoryPre: 偏好采样 / 存储不可用回落 / 拨开关取反 ✓");
console.log("trajectoryPre: 无裸 <pre> + 样式表两条档位 ✓");
console.log("\ntrajectoryPre: all assertions passed");
