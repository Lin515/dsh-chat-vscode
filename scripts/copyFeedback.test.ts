/**
 * 复制反馈的唯一实现（`src/webview/copyFeedback.ts` + `components/CopyButton.tsx`）。
 *
 * 用户 2026-11-02 口径：复制按钮点完要有反馈，且这一套反馈收口成一个模块；右键菜单
 * 「复制」与会话选区 Ctrl+C / Cmd+C 这类没有按钮可换文案的入口也要有。同一天的第二条
 * 口径把所有复制入口统一成**一枚图标按钮**（无文字标签、成功态只换对勾），所以这里也钉
 * 「只有一种外观」。
 *
 * 这里钉四类事实，都不冒充 DOM 点击或系统剪贴板证明：
 * 1. **唯一入口**：`copy` 帧只在 `copyFeedback.ts` 里发（其余源码只许调 `copyText`）；
 * 2. **清点**：每个复制按钮都走同一个 `CopyButton`，数量一起钉住；
 * 3. **状态机只有一份**：组件不自己计时，1s 常量只有 `copyFeedback.ts`；
 * 4. **提示的来去**：右键菜单 / 快捷键触发的提示在 1s 后自己消失，落点缺失时回落居中。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// `bridge.ts` 在模块求值期挂 `window` 监听；无头环境补最小实现（同 codeBlock.test）
(globalThis as { window?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  innerWidth: 1200,
  innerHeight: 800,
};
const POSTED: unknown[] = [];
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => POSTED.push(message),
});

const { COPIED_MS, copyText, copyFlashValue, flashCopied, subscribeCopyFlash } = await import(
  "../src/webview/copyFeedback"
);
type CopyFlashValue = import("../src/webview/copyFeedback").CopyFlashValue;
const { CopyButton, CopyFlashLayer } = await import("../src/webview/components/CopyButton");
const { TextsContext, dictionaryFor } = await import("../src/webview/texts");

const webviewDir = join(process.cwd(), "src", "webview");
const componentsDir = join(webviewDir, "components");
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

/** 递归列出 `src/webview` 下的源码（只用于「谁还在自己发 copy 帧」这一条不变量）。 */
function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: dictionaryFor("zh") },
      node,
    ),
  );
}

// ---------- 1. copy 帧只有一个发射点 ----------
{
  const offenders = sourceFiles(webviewDir)
    .filter((path) => !path.endsWith(join("webview", "copyFeedback.ts")))
    .filter((path) => /post\(\{\s*type:\s*"copy"/.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path));
  assert.deepStrictEqual(
    offenders,
    [],
    "写剪贴板只许经过 copyFeedback.ts 的 copyText；这些文件还在自己发 copy 帧",
  );

  POSTED.length = 0;
  copyText("一段正文");
  assert.deepStrictEqual(POSTED, [{ type: "copy", text: "一段正文" }], "copyText 原样把正文交给宿主");
}
console.log("copyFeedback: copy 帧只有一个发射点 ✓");

// ---------- 2. 清点：每个复制按钮都走共享组件 ----------
//
// 复制按钮的位置（用户 2026-11-02 清点，第二批补齐后统一成图标按钮）：
// - 工具卡 4 处（读 / 搜索 / 终端横幅 + 网页搜索卡内容右上角）；
// - 工具行 IN / OUT 标签行各 1 处（有意超集：官方通用 IN/OUT 不出复制）；
// - 问卷记录的展开体首右上角 1 处（已答 / 已取消 / 计划审阅共用同一份记录形态）；
// - 思考 / 注入 / 技能 / 命令 / 提示 / 未知块 6 处，待答审批 / 计划 / 问卷 3 处；
// - diff 头部 1 处（write / edit 的 hunk 头，复制整张卡的全部 hunk）；
// - write 原文预览 1 处（还没有 diff 时复制屏幕上那段原文）；
// - 后台任务详情的命令头 1 处；
// - 历史会话行的「复制会话 ID」1 处；
// - 轨迹检查器每段原文 1 处（`TrajectoryPre` 收口，实例数随原文段数变）；
// - 代码块头部 1 处；
// - 消息 2 处（用户气泡整条 / 助手轮尾的最后一段正文，中间正文不挂按钮）。
{
  const count = (file: string, pattern: RegExp) => (read(componentsDir, file).match(pattern) ?? []).length;
  const inventory: [string, RegExp, number][] = [
    ["ToolCards.tsx", /<CopyButton\b/g, 4],
    ["Rows.tsx", /<CopyButton\b/g, 12],
    ["Diff.tsx", /<CopyButton\b/g, 1],
    ["WriteBody.tsx", /<CopyButton\b/g, 1],
    ["Panels.tsx", /<CopyButton\b/g, 1],
    ["History.tsx", /<CopyButton\b/g, 1],
    ["TrajectoryPre.tsx", /<CopyButton\b/g, 1],
    ["CodeBlock.tsx", /<CopyButton\b/g, 1],
    ["Message.tsx", /<CopyButton\b/g, 2],
  ];
  for (const [file, pattern, expected] of inventory) {
    assert.strictEqual(count(file, pattern), expected, `${file} 的复制按钮数量变了，需要同步确认反馈`);
  }

  // 除了共享组件自己，任何组件都不许再手写复制按钮的标记（否则就是绕开反馈）
  const handRolled = sourceFiles(componentsDir)
    .filter((path) => !path.endsWith(join("components", "CopyButton.tsx")))
    .filter((path) => /<IconCopy\b/.test(readFileSync(path, "utf8")))
    .map((path) => relative(process.cwd(), path));
  assert.deepStrictEqual(handRolled, [], "复制按钮只能由 CopyButton.tsx 提供（图标 / 反馈一套）");
}
console.log("copyFeedback: 所有复制按钮都走共享组件 ✓");

// ---------- 3. 状态机只有一份、外观只有一种（图标 + 对勾）----------
{
  const source = read(componentsDir, "CopyButton.tsx");
  assert.match(source, /useCopyFeedback/, "按钮从 copyFeedback.ts 取反馈状态机");
  assert.ok(!/setTimeout/.test(source), "组件里不许再各写一份计时器（时长与重复点击口径只留一份）");
  assert.ok(!/export function IconCopyButton/.test(source), "不再有「图标版 / 文字版」两套外观");
  const core = read(webviewDir, "copyFeedback.ts");
  assert.match(core, /export const COPIED_MS = 1000/, "反馈时长是 1000ms（与提示动画同一档）");
  assert.strictEqual(COPIED_MS, 1000);

  // 初始态：没有点击，按钮只有图标，不显示成功态、也没有文字标签
  const button = render(createElement(CopyButton, { text: "正文" }));
  assert.match(button, /class="icon-btn"/, "复制按钮是图标按钮");
  assert.match(button, /title="复制"/, "默认悬停说明是「复制」");
  assert.match(button, /aria-label="复制"/, "图标按钮要有无障碍名");
  assert.ok(!button.includes("is-copied"), "点击前没有成功态");
  assert.ok(
    !/<span>(复制|已复制到剪贴板)<\/span>/.test(button),
    "按钮里不许有可见文字（用户 2026-11-02 口径：只显示图标）",
  );
  assert.match(button, /class="sr-only" aria-live="polite"/, "成功提示只留给读屏（视觉上只有一个对勾）");

  // title 覆盖「复制什么」；同一张卡里的两枚（IN / OUT）因此能分开听
  const input = render(createElement(CopyButton, { text: "正文", title: "复制输入" }));
  assert.match(input, /title="复制输入"/);
  assert.match(input, /aria-label="复制输入"/);
}
console.log("copyFeedback: 反馈状态机只有一份、外观只有图标一种 ✓");

// ---------- 4. 非按钮入口的提示：落点、替换与自动消失 ----------
{
  assert.strictEqual(copyFlashValue(), null, "初始没有提示");
  const seen: (CopyFlashValue | null)[] = [];
  const unsubscribe = subscribeCopyFlash((value) => seen.push(value));

  flashCopied({ x: 320, y: 240 });
  const first = copyFlashValue();
  assert.ok(first, "闪一下之后有当前提示");
  assert.deepStrictEqual(first?.anchor, { x: 320, y: 240 }, "提示钉在触发点");
  assert.deepStrictEqual(seen.map((value) => value?.anchor), [{ x: 320, y: 240 }], "订阅者立即收到");

  // 同一处再点一次：换一个身份（动画重播），不叠出第二条
  flashCopied({ x: 320, y: 240 });
  const second = copyFlashValue();
  assert.notStrictEqual(second?.id, first?.id, "连续复制换身份，提示重新播动画");
  assert.deepStrictEqual(seen.map((value) => value?.anchor), [
    { x: 320, y: 240 },
    { x: 320, y: 240 },
  ]);

  // 拿不到落点（或拿到坏坐标）：不当作锚点，交给提示层回落居中
  flashCopied();
  assert.strictEqual(copyFlashValue()?.anchor, null, "没有落点时回落到居中提示");
  flashCopied({ x: Number.NaN, y: 10 });
  assert.strictEqual(copyFlashValue()?.anchor, null, "非有限坐标不当作落点");

  // 渲染：锚点位置写进行内 left/top，居中档不带坐标
  flashCopied({ x: 600, y: 300 });
  const anchored = render(createElement(CopyFlashLayer));
  assert.match(anchored, /role="status"/, "提示层是 live region");
  assert.match(anchored, /class="copy-flash"/, "有提示时画出胶囊");
  assert.match(anchored, /left:612px;top:312px/, "提示贴着触发点右下");
  assert.match(
    anchored,
    /<span class="sr-only">已复制到剪贴板<\/span>/,
    "提示与按钮同一套语言：只有一个对勾，文字只留给读屏",
  );
  assert.ok(
    !/class="copy-flash[^"]*">[^<]*已复制/.test(anchored),
    "提示胶囊里不许出现可见文字",
  );

  flashCopied();
  const centered = render(createElement(CopyFlashLayer));
  assert.match(centered, /class="copy-flash is-centered"/, "没有落点时居中显示");
  assert.ok(!/left:|top:/.test(centered), "居中档不写行内坐标");

  // 到点自己消失（计时与 COPIED_MS 同一档）
  unsubscribe();
  await new Promise((resolve) => setTimeout(resolve, COPIED_MS + 60));
  assert.strictEqual(copyFlashValue(), null, "提示到点自己消失");
  const idle = render(createElement(CopyFlashLayer));
  assert.ok(!/class="copy-flash[ ")]/.test(idle), "没有提示时不画胶囊");
  assert.match(idle, /class="copy-flash-layer"/, "live region 常驻（屏幕阅读器要它先存在）");
}
console.log("copyFeedback: 提示的落点、替换与自动消失 ✓");

// ---------- 5. 样式：提示层不抢指针、压过右键菜单、动画时长与状态机同一档 ----------
//
// 复制成功态还有一个只有真浏览器才看得见的坑：`.msg-actions .icon-btn` /
// `.code-block-actions .icon-btn` 给自己的图标按钮设了 Muted 色（0-2-0，排在后面），
// 不加一档特异性就会把成功态压回灰色。所以选择器必须是带元素名的 `button...`，
// 并在注释里写明理由；这里把机制本身钉住。
{
  const css = readFileSync(join(webviewDir, "styles", "app.css"), "utf8");
  const ruleBody = (selector: string): string => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `样式里应当有 ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };

  const layer = ruleBody(".copy-flash-layer");
  assert.match(layer, /pointer-events:\s*none/, "提示层不能抢走正文的指针事件（选择 / 滚动 / 右键）");
  const z = Number(/z-index:\s*(\d+)/.exec(layer)?.[1]);
  assert.ok(z > 50, "提示层要压过右键菜单（.ctx-menu 的 z-index 是 50）");

  // 动画时长与 COPIED_MS 对齐：两边各改一处时这里先炸
  const flash = ruleBody(".copy-flash {");
  const seconds = Number(/animation:\s*copy-flash\s+([\d.]+)s/.exec(flash)?.[1]);
  assert.strictEqual(Math.round(seconds * 1000), COPIED_MS, "提示动画时长必须等于 COPIED_MS");

  // 成功态的特异性提升：只有图标按钮一种外观，且带 `button`（压得过上下文的 muted 色）
  const success = "button.icon-btn.is-copied";
  assert.ok(css.includes(success), `${success} 必须存在（否则正文里的成功态会被容器色压回灰）`);
  assert.match(ruleBody(`${success},`), /color:\s*var\(--success\)/, `${success} 用成功色`);
  assert.ok(!css.includes(".copy-btn"), "统一成图标按钮后，文字版按钮的样式不该再留着");
  // 辅助行里的复制按钮跟行高走：20dp 而不是 24dp 的方盒（用户 2026-11-02 口径）
  assert.match(
    ruleBody(".tool-card-banner .icon-btn,"),
    /width:\s*calc\(20 \* var\(--dp\)\)/,
    "工具卡横幅等辅助行里的复制按钮用 20dp，别把一行小字撑高",
  );

  // 淡入淡出是装饰性动效：与其它装饰动画同住文件末尾唯一的 reduce 块
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(reduced, "应当存在 prefers-reduced-motion 媒体查询");
  assert.match(reduced[1], /\.copy-flash\s*\{[^}]*animation:\s*none/, "减少动画时提示不做淡入淡出");
}
console.log("copyFeedback: 提示层与成功态的样式约束 ✓");

console.log("\ncopyFeedback: all assertions passed");
