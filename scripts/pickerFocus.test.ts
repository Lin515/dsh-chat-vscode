/**
 * 输入区模型弹层「打开即定位到当前选中项」的机制，与「滚动只作用于模型列表」的结构契约。
 *
 * 契约（用户 2026-10-10 的口径）：
 *  - 点模型按钮展开列表 → 定位到**当前生效的模型**，而不是停在列表顶部；
 *  - 方向键从定位到的那一项继续走，不从头开始；
 *  - 思考档位**常驻**在弹层里（模型支持才有），滑动滚动条只作用于模型列表那一段；
 *    于是原先「点强度按钮打开弹层再聚焦/滚到档位」的动作取消，方向键只走模型列表。
 *
 * 「定位到哪一项」「方向键走到哪一项」是纯函数（`initialFocusIndex` / `moveFocusIndex`），
 * 能离线逐条断言。其余几条没法用纯函数钉——「滚动容器只有列表那一段」「档位区在它外面且
 * 不参与收缩」「模型不支持可选档位时整块不渲染、不留空占位」「高亮看得见」——读源码 /
 * 样式断言：它们错了的现场是「列表还是停在顶部」「滚列表把档位区卷走了」「档位没了却留下
 * 一条空分隔线」，靠手点很难每次回归都覆盖。
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
assert.strictEqual(initialFocusIndex(0, -1), -1, "没有模型时不给索引");
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

// 空列表：仍是「无处可去」（`usePickerFocus` 据此不抢方向键）
assert.strictEqual(moveFocusIndex(-1, 0, 1), -1);

console.log("pickerFocus: 方向键从选中项继续、两端夹取 ✓");

// ---------- 3. 接线：一套机制、一段可导航、旧的「两段定位」必须拔干净 ----------

const composer = readFileSync(
  join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
  "utf8",
);

// 「一个共用的机制」的最硬判据：整个输入框只调用一次 `usePickerFocus`。
// 各写一套时，这个数必然变成 2（也正是用户报障里两处表现不一致的成因）。
assert.strictEqual(
  composer.match(/usePickerFocus\(/g)?.length,
  1,
  "模型弹层只应有一处 `usePickerFocus` 接线",
);
assert.ok(
  /ref=\{pickerFocus\.bodyRef\}/.test(composer),
  "可滚的模型列表那一层要挂 bodyRef——滚动定位按它找条目",
);

// 模型列表：条目带标记、用同一套判定加高亮
assert.ok(/data-picker-item="model"/.test(composer), "模型按钮要挂 data-picker-item=model");
assert.ok(/modelHighlighted\(/.test(composer), "模型行要高亮判定");

// 旧的「由触发按钮决定这一次定位哪一段」必须整体消失：档位区已常驻，不再需要被定位过去。
assert.ok(!/setModelFocus/.test(composer), "触发按钮不再需要声明定位到哪一段（setModelFocus 已删）");
assert.ok(!/modelFocus\b/.test(composer), "「这一次打开定位哪一段」的状态已删");
assert.ok(!/data-picker-item="effort"/.test(composer), "档位条目不再是键盘导航的候选");
assert.ok(!/isHighlighted\("effort"/.test(composer), "档位区不再参与键盘高亮");

console.log("pickerFocus: 只剩一段可导航、旧的触发按钮定位已拔干净 ✓");

// ---------- 4. 结构：滚的只有模型列表，档位区在它外面且随支持情况整块进出 ----------

const popoverAt = composer.indexOf('className="model-popover"');
const listAt = composer.indexOf('className="model-popover-list"');
const bodyRefAt = composer.indexOf("ref={pickerFocus.bodyRef}");
const effortAt = composer.indexOf('className="model-popover-effort"');
assert.ok(popoverAt >= 0, "模型弹层要带 model-popover（外框分区）");
assert.ok(listAt > popoverAt, "可滚列表要在弹层外框里面");
assert.ok(
  bodyRefAt > listAt && bodyRefAt < effortAt,
  "bodyRef 挂在可滚的模型列表那一层，而不是含档位区的整块——挂错了会把档位区一起滚走",
);
assert.ok(effortAt > listAt, "思考档位区是模型列表的**兄弟**（在滚动容器之外）");

// 档位区的渲染条件（模型支持可选档位）要包住整块，含分隔线：不支持时连分隔线一起消失，
// 面板底部不能留下一条无所指的空线。
const gateAt = composer.lastIndexOf("{state.model?.efforts?.length ? (", effortAt);
assert.ok(gateAt > listAt, "档位区的渲染条件要写在列表之外（它管的是整块）");
const gateEndAt = composer.indexOf(") : null}", effortAt);
assert.ok(gateEndAt > effortAt, "条件不成立时整块不渲染");
const sepAt = composer.indexOf('className="popover-sep"', effortAt);
assert.ok(
  sepAt > gateAt && sepAt < gateEndAt,
  "分隔线属于条件之内——不支持可选档位时不能留下一条空占位线",
);

// 档位内容由数据驱动、反映当前生效值，不硬编码模型名 / 档位名
const effortJsx = composer.slice(effortAt, gateEndAt);
assert.ok(/state\.model\.efforts\.map\(/.test(effortJsx), "档位列表来自 state.model.efforts");
assert.ok(
  /\(state\.model\?\.reasoningEffort \?\? ""\) === item\.id \? " is-selected" : ""/.test(effortJsx),
  "档位区要反映当前生效档位（is-selected），而不是停在第一个",
);

// 换模型时档位只在目标模型支持时才带上，否则退回它的默认档位（服务端会拒绝不支持的档位）
assert.ok(/model\.defaultEffort/.test(composer), "选中模型时档位要退回该模型的默认值");

console.log("pickerFocus: 滚动只归模型列表、档位区常驻且随支持情况整块进出 ✓");

// ---------- 5. 样式：外框不滚、列表才是滚动层、档位区不参与收缩、高亮看得见 ----------

const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");

/** 取出某个选择器自己的声明块（要求选择器后紧跟 `{`，不吃注释里的提及）。 */
function ruleOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, "u").exec(css);
  assert.ok(match, `app.css 里找不到选择器 ${selector}`);
  return match[1];
}

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

// 外框：竖排 flex + 自己不滚（滚动留给列表那一层）。少了 `overflow: hidden`，
// 外框会把整份内容一起滚——档位区就跟着列表走了，等于没拆。
{
  const outer = ruleOf(".popover.model-popover");
  assert.ok(/display:\s*flex/.test(outer) && /flex-direction:\s*column/.test(outer), "模型弹层要按竖排 flex 分配两段的高度");
  assert.ok(
    /overflow:\s*hidden/.test(outer),
    "模型弹层外框自己不许滚（滚动要留给 .model-popover-list）——外框一滚，档位区就跟着列表走了",
  );
}

// 滚动层：唯一可滚的一段，且允许收缩（min-height: 0），否则模型一多就把档位区挤出限高
{
  const list = ruleOf(".model-popover-list");
  assert.ok(/overflow-y:\s*auto/.test(list), "模型列表那一层才是滚动容器（overflow-y: auto）");
  assert.ok(
    /min-height:\s*0/.test(list),
    ".model-popover-list 必须 min-height: 0——否则模型一多就按内容高度把外框顶开，档位区被挤出 max-height",
  );
  assert.ok(/flex:\s*1\s+1/.test(list), ".model-popover-list 吃掉外框剩余高度");
  assert.ok(/contain:\s*paint/.test(list), "滚动列表要 contain: paint（绘制边界清帧，消候选行残影）");
}

// 档位区：不参与收缩，列表再长也压不掉它
assert.ok(
  /flex:\s*0\s+0/.test(ruleOf(".model-popover-effort")),
  ".model-popover-effort 必须 flex: 0 0 auto（不参与收缩），否则列表一长就把档位区压没",
);

// 「高亮」必须看得见：只加类不给样式时，方向键走到哪一行用户根本看不见
{
  const body = ruleBodies(".popover-item.is-active");
  assert.ok(/background:/.test(body), ".popover-item.is-active 要有底色（键盘高亮看不见等于没定位）");
  assert.ok(/outline:/.test(body), ".popover-item.is-active 要有焦点环（高亮落在当前生效那一行上时，底色与选中态相同）");
}

console.log("pickerFocus: 外框不滚、列表才滚、档位区常驻、高亮看得见 ✓");

console.log("\npickerFocus: all assertions passed");
