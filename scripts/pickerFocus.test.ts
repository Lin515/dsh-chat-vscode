/**
 * 输入区模型弹层「打开即定位到当前选中项」的共用机制。
 *
 * 契约（用户 2026-10-10 的两条报障）：
 *  - 点模型按钮展开列表 → 定位到**当前生效的模型**，而不是停在列表顶部；
 *  - 点思考强度按钮展开同一个弹层 → 定位到**当前档位**（两处共用一套，不是各写一套）；
 *  - 方向键从定位到的那一项继续走，不从头开始。
 *
 * 「定位到哪一项」「方向键走到哪一项」都是纯函数（`initialFocusIndex` / `moveFocusIndex`），
 * 所以能离线逐条断言。另外两条没法用纯函数钉的——「两处共用同一个机制」与「高亮在两段里
 * 都看得见」——读源码 / 样式断言：它们错了的现场是「列表还是停在顶部」「方向键跳回第一项」，
 * 靠手点很难每次回归都覆盖。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialFocusIndex, moveFocusIndex } from "../src/webview/pickerFocus";

// ---------- 1. 打开瞬间定位到哪一项 ----------

// 有当前生效项：定位到它本身（列表不停在顶部）
assert.strictEqual(initialFocusIndex(12, 7), 7);
assert.strictEqual(initialFocusIndex(4, 0), 0, "当前生效的是第一项时，定位到第一项（本来就在顶部）");
assert.strictEqual(initialFocusIndex(4, 3), 3, "当前生效的是最后一项时，定位到最后一项");

// 认不出选中项（还没选中、或目录换了导致索引过期）：给一个能用的起点，而不是 -1
assert.strictEqual(initialFocusIndex(6, -1), 0);
assert.strictEqual(initialFocusIndex(6, 99), 0, "索引过期（列表变短）也要有起点，否则方向键整段失灵");

// 没有可选条目：明确「无处可去」，调用方据此不画高亮
assert.strictEqual(initialFocusIndex(0, -1), -1, "没有模型 / 没有档位时不给索引");
assert.strictEqual(initialFocusIndex(0, 2), -1);

console.log("pickerFocus: 打开即定位到选中项 ✓");

// ---------- 2. 方向键的起点与两端的夹取 ----------

// 「从当前选中项继续移动」：选中第 6 项（索引 5）时按一下「下」= 索引 6，而不是索引 1
assert.strictEqual(moveFocusIndex(5, 12, 1), 6, "方向键必须从定位到的那一项继续走");
assert.strictEqual(moveFocusIndex(5, 12, -1), 4);
assert.strictEqual(moveFocusIndex(0, 12, 1), 1);

// 夹在两端、**不环绕**：末项再按「下」还是末项（环绕会让人以为列表换了）
assert.strictEqual(moveFocusIndex(0, 4, -1), 0);
assert.strictEqual(moveFocusIndex(3, 4, 1), 3);

// 起点认不出：先站到第一项，这一下不额外跳一格
assert.strictEqual(moveFocusIndex(-1, 4, 1), 0);
assert.strictEqual(moveFocusIndex(9, 4, 1), 0);

// 空组：仍是「无处可去」（`usePickerFocus` 据此不抢方向键）
assert.strictEqual(moveFocusIndex(-1, 0, 1), -1);

console.log("pickerFocus: 方向键从选中项继续、两端夹取 ✓");

// ---------- 3. 两处下拉共用同一个机制（接线） ----------

const composer = readFileSync(
  join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
  "utf8",
);

// 「一个共用的机制」的最硬判据：整个输入框只调用一次 `usePickerFocus`。
// 两处各写一套时，这个数必然变成 2（也正是用户报障里两处表现不一致的成因）。
assert.strictEqual(
  composer.match(/usePickerFocus\(/g)?.length,
  1,
  "模型列表与思考档位必须共用同一个 `usePickerFocus`，不许各写一套",
);
assert.ok(
  /ref=\{pickerFocus\.bodyRef\}/.test(composer),
  "弹层内容根要挂 bodyRef——滚动定位按它找条目",
);

// 模型列表：条目带组标记、用同一套判定加高亮
assert.ok(/data-picker-item="model"/.test(composer), "模型按钮要挂 data-picker-item=model");
assert.ok(/isHighlighted\("model"/.test(composer), "模型行要高亮判定");
// 思考档位：同一套标记与判定，另一组
assert.ok(/data-picker-item="effort"/.test(composer), "思考档位要挂 data-picker-item=effort");
assert.ok(/isHighlighted\("effort"/.test(composer), "档位行要高亮判定");

// 两枚触发按钮各自说明「这一次打开定位哪一段」：少了任一条，那一处就退回停在顶部
assert.ok(/setModelFocus\("model"\)/.test(composer), "模型按钮要声明定位到模型列表");
assert.ok(/setModelFocus\("effort"\)/.test(composer), "思考强度按钮要声明定位到档位");

console.log("pickerFocus: 两处下拉共用一套机制 ✓");

// ---------- 4. 高亮在两段里都看得见 ----------

const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");

/**
 * 收集包含该选择器的**所有**规则块：成组选择器（`.a,\n.b { … }`）与后面另起的补充规则
 * 都要算进来——高亮的底色与焦点环就分在这两条里。
 */
function ruleBodies(selector: string): string {
  const bodies: string[] = [];
  for (let at = css.indexOf(selector); at >= 0; at = css.indexOf(selector, at + selector.length)) {
    const open = css.indexOf("{", at);
    bodies.push(css.slice(open + 1, css.indexOf("}", open)));
  }
  assert.ok(bodies.length > 0, `app.css 里找不到 ${selector}`);
  return bodies.join("\n");
}

// 「高亮」必须看得见：只加类不给样式时，方向键走到哪一行用户根本看不见。
// 两处要求同等待遇（底色 + 焦点环）——只给一处样式，另一处的键盘操作就等于没有反馈。
for (const selector of [".popover-item.is-active", ".segment-item.is-active"]) {
  const body = ruleBodies(selector);
  assert.ok(/background:/.test(body), `${selector} 要有底色（键盘高亮看不见等于没定位）`);
  assert.ok(/outline:/.test(body), `${selector} 要有焦点环（高亮落在当前生效那一行上时，底色与选中态相同）`);
}

console.log("pickerFocus: 键盘高亮在两段里都看得见 ✓");

console.log("\npickerFocus: all assertions passed");
