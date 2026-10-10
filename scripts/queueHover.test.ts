/**
 * 队列行「悬停看全文」的判据与接线（`src/webview/queueHover.ts` + `Composer.tsx`）。
 *
 * 用户 2026-10-10 口径：队列每条恒为**单行**省略，正文放不下时鼠标悬停要看得到全文，
 * 而且**只有真的被截断时才看得到**（放得下的一条悬停不该弹任何东西）；**不加展开按钮**。
 * 显示形态是**与文件芯片同一套浮窗小字**（原生 `title`，用户同日第二条口径）——
 * 界面不再自绘浮层，所以这里也钉住「没有自绘浮层」。
 *
 * 难点在判据：jsdom 里 `scrollWidth` / `clientWidth` 恒为 0，纯 DOM 测量在单测里跑不了。
 * 所以「要不要显示」抽成了纯函数 `queueTextIsClipped`（输入：文本 + 可用宽度 + 测量函数），
 * 组件注入**真实**测量（Range 量文本自然宽度，与 `primitives.tsx` 的 `useClipped`、
 * `GoalBar` 的截断判定同一套），这里断言它的判定表。
 *
 * 断言里刻意**没有**任何字数阈值：同一段正文在宽 / 窄两种可用宽度下结论相反，
 * 「按字数猜」的实现在这一条上必挂。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queueTextIsClipped } from "../src/webview/queueHover";

/** 固定测量结果的测量函数（组件里那一份是 Range 实测，这里注入结果）。 */
const measure = (width: number | undefined) => () => width;

// ---------- 1. 要不要显示：判据是实测溢出，不是字数 ----------
{
  // 放得下 → 不显示（没有省略号却弹提示是噪音）
  assert.strictEqual(queueTextIsClipped("短消息", 320, measure(120)), false, "放得下不该显示");
  // 放不下 → 显示
  assert.strictEqual(queueTextIsClipped("一条很长的排队消息", 320, measure(640)), true, "放不下要显示");

  // 边界：恰好等于不算截断；亚像素抖动也不算；真的多出可见宽度才算
  assert.strictEqual(queueTextIsClipped("刚好放下", 320, measure(320)), false, "恰好等于可用宽度不算截断");
  assert.strictEqual(queueTextIsClipped("差半个像素", 320, measure(320.5)), false, "亚像素误差不算截断");
  assert.strictEqual(queueTextIsClipped("多出可见的一截", 320, measure(324)), true, "真的超出才算截断");

  // 纯附件那条渲染的是空串（或「（仅附件）」占位）：没有正文可看，也不该为它量一次 DOM
  let measured = 0;
  assert.strictEqual(
    queueTextIsClipped("", 320, () => {
      measured++;
      return 999;
    }),
    false,
    "空正文不显示",
  );
  assert.strictEqual(measured, 0, "空正文连测量都不该做（测量会强制一次同步布局）");

  // 量不到证据（未挂载 / 未布局 / 宿主隐藏）一律不显示：拿不到证据就不动手
  assert.strictEqual(queueTextIsClipped("文本", 0, measure(500)), false, "可用宽度为 0（未布局）不显示");
  assert.strictEqual(queueTextIsClipped("文本", Number.NaN, measure(500)), false, "可用宽度不是数不显示");
  assert.strictEqual(queueTextIsClipped("文本", -10, measure(500)), false, "可用宽度为负不显示");
  assert.strictEqual(queueTextIsClipped("文本", 320, measure(undefined)), false, "文本宽度量不到不显示");
  assert.strictEqual(queueTextIsClipped("文本", 320, measure(0)), false, "文本宽度为 0（未布局）不显示");
  assert.strictEqual(queueTextIsClipped("文本", 320, measure(Number.NaN)), false, "文本宽度不是数不显示");

  // 判据来自实测：**同一段正文**，宽栏 / 小字号放得下（不显示），窄栏 / 大字号放不下（显示）
  const same = "同一条排队消息，字数一模一样";
  assert.strictEqual(queueTextIsClipped(same, 400, measure(180)), false, "宽栏 + 小字号：一句放得下");
  assert.strictEqual(queueTextIsClipped(same, 120, measure(360)), true, "窄栏 + 大字号：同一句放不下");
  assert.strictEqual(queueTextIsClipped(same, 180, measure(180)), false, "换算回来正好放下");
}
console.log("queueHover: 悬停全文的判据（实测溢出，非字数） ✓");

// ---------- 2. 接线：组件真的用实测判据、只在截断时挂全文、且没有自绘浮层 ----------
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  /** 取一段顶层 `function` 声明的源码块（到下一个顶层 `function` 为止）。 */
  const block = (signature: string): string => {
    const start = composer.indexOf(signature);
    assert.ok(start >= 0, `Composer.tsx 里找不到 ${signature}`);
    const next = composer.indexOf("\nfunction ", start + signature.length);
    return composer.slice(start, next < 0 ? composer.length : next);
  };

  const row = block("function QueueItem(");
  assert.ok(/queueTextIsClipped\(/.test(row), "队列行要用 queueTextIsClipped 判定（判据只有这一处）");
  assert.ok(
    /clientWidth/.test(row) && /createRange\(\)/.test(row) && /getBoundingClientRect\(\)/.test(row),
    "必须注入**真实测量**：Range 量文本自然宽度、与 clientWidth 比（scrollWidth 在 flex 行里不可靠）",
  );
  assert.ok(
    !/\.length\s*>\s*\d/.test(row),
    "不许用字数阈值判断截断：同一段文字在不同字号 / 侧栏宽度下截断点不同",
  );
  // 全文走原生 title（与文件芯片同一套浮窗小字），且**只在真的截断时**挂上去
  assert.ok(
    /<div className="queue-item" title=\{clipped \? label : undefined\}>/.test(row),
    "全文要挂在 title 上、且挂**整行**（只挂正文那一格时鼠标偏到附件标记 / 空白就没有提示），" +
      "并以实测量出来的 clipped 为闸门：没被截断的那条一个字符都不挂",
  );
  // 队列行是预览：队列条目存的是**用户提交的原文**（会话引用还是 token），
  // 显示前必须折成 `@标题`（否则单行省略与悬停全文看到的都是 base64 会话 id）
  assert.ok(
    /const label = readableMentionText\(item\.text/.test(row),
    "队列行的正文要先过 readableMentionText（与复制按钮、轮次大纲预览同一道还原）",
  );
  assert.ok(
    /post\(\{ type: "queueSteer", id: item\.id \}\)/.test(row) &&
      /post\(\{ type: "queueEdit", id: item\.id \}\)/.test(row),
    "插话 / 编辑只发 id（原始内容由宿主取）：还原后的显示文本不许回写进协议",
  );
  assert.ok(
    !/onPointerEnter|onPointerLeave/.test(row),
    "原生 title 由宿主负责悬停判定与显示，界面不许再自己跟踪悬停态",
  );
  // 不加展开按钮：队列行只有插话 / 编辑 / 取消三个动作
  const posted = [...row.matchAll(/post\(\{ type: "(\w+)"/g)].map((match) => match[1]);
  assert.deepStrictEqual(
    posted,
    ["queueSteer", "queueEdit", "queueRemove"],
    "队列行的动作只有插话 / 编辑 / 取消三者——悬停全文不加展开按钮",
  );

  assert.ok(
    !/QueueFullText|queue-fulltext|queueFullTextPlacement/.test(composer),
    "自绘浮层与它的落位算法已经删掉：悬停全文交宿主渲染（用户 2026-10-10 口径）",
  );

  const lump = block("function Lump(");
  assert.ok(/<QueueItem/.test(lump), "队列区块要把每条交给 QueueItem 渲染（hooks 不能在 map 回调里调）");
}
console.log("queueHover: 组件接线（原生 title + 不加展开按钮 + 无自绘浮层） ✓");

// ---------- 3. 样式：队列行仍是单行省略 ----------
{
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
    assert.ok(match, `app.css 里找不到选择器 ${selector}`);
    return match[1];
  };

  const text = rule(".queue-text");
  assert.ok(
    /white-space:\s*nowrap/.test(text) &&
      /text-overflow:\s*ellipsis/.test(text) &&
      /overflow:\s*hidden/.test(text),
    "队列行仍是单行省略（悬停全文只是挂了个 title，行本身不许改成长文本自己撑开）",
  );
  assert.ok(
    !/\.queue-fulltext/.test(css),
    "自绘浮层的样式要一起删掉（悬停全文的样式归宿主那套浮窗小字）",
  );
}
console.log("queueHover: 队列行仍是单行省略、无自绘浮层样式 ✓");

console.log("\nqueueHover: all assertions passed");
