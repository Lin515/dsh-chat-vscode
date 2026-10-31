/**
 * 问卷「自定义回答」输入框的自增高：
 * **内容最多长到 5 行，超过 5 行才在框内出现垂直滚动条**（用户 2026-10-31 口径）。
 *
 * 这里钉两件事：
 * 1. `customAnswerSize` 的算术——行高、内边距、边框怎么叠加，什么时候判滚动。
 *    它被 `Rows.tsx` 的 `CustomAnswerInput` 直接用来写字高，算错不会报错，只会让
 *    第五行被切掉、或刚满五行就冒出滚动条。
 * 2. 接线：文本域从 `rows` 拿两行下限、保留原生拖拽、脚本在绘制前量高。
 *    这层用源码与样式断言（无头环境没有布局）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CUSTOM_ANSWER_MAX_LINES,
  customAnswerSize,
  type CustomAnswerMetrics,
} from "../src/webview/questionInput";

const base: CustomAnswerMetrics = {
  scrollHeight: 39,
  lineHeight: 20,
  paddingTop: 4,
  paddingBottom: 4,
  borderTopWidth: 1,
  borderBottomWidth: 1,
};

const metricsOf = (scrollHeight: number, overrides: Partial<CustomAnswerMetrics> = {}) => ({
  ...base,
  scrollHeight,
  ...overrides,
});

// ---------- 1. 上限就是 5 行 ----------
{
  assert.strictEqual(CUSTOM_ANSWER_MAX_LINES, 5, "自定义回答最多自动扩到 5 行");
}

// ---------- 2. 五行以内：跟着内容长高，没有滚动条 ----------
{
  // 两行内容 + 上下内边距 8：scrollHeight 含内边距，值高要再加两条边框
  const twoLines = metricsOf(2 * 20 + 8);
  assert.deepStrictEqual(customAnswerSize(twoLines), { height: 50, scroll: false }, "两行内容高 50（含边框）");
  // 正好五行：不许出现滚动条，也不许把第五行切掉
  const fiveLines = metricsOf(5 * 20 + 8);
  assert.deepStrictEqual(
    customAnswerSize(fiveLines),
    { height: 110, scroll: false },
    "正好 5 行时高度到顶，但还没有滚动条",
  );
}

// ---------- 3. 超过五行：高度停在五行，判滚动 ----------
{
  const sixLines = metricsOf(6 * 20 + 8);
  assert.deepStrictEqual(
    customAnswerSize(sixLines),
    { height: 110, scroll: true },
    "6 行内容高度停在 5 行，由文本域自己滚",
  );
}

// ---------- 4. 小数行高：正好五行不能因取整冒出滚动条 ----------
{
  // 1.5 倍行高在 13px 字号下是 19.5px；5 行 = 97.5px，而 scrollHeight 取整成 98。
  // 不留容差的话「第五行刚写满」就会被当成溢出。
  const exactFive = metricsOf(98, {
    lineHeight: 19.5,
    paddingTop: 0,
    paddingBottom: 0,
    borderTopWidth: 0,
    borderBottomWidth: 0,
  });
  assert.deepStrictEqual(customAnswerSize(exactFive), { height: 98, scroll: false }, "取整误差不算溢出");
  const six = metricsOf(117, {
    lineHeight: 19.5,
    paddingTop: 0,
    paddingBottom: 0,
    borderTopWidth: 0,
    borderBottomWidth: 0,
  });
  assert.deepStrictEqual(customAnswerSize(six), { height: 98, scroll: true }, "超过 5 行才滚");
}

// ---------- 5. 接线：两行下限、绘制前量高、手动拖拽仍然可用 ----------
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /rows=\{CUSTOM_ANSWER_ROWS\}/.test(rows),
    "文本域仍用 rows 给两行下限（一两个字时不会缩成一行）",
  );
  assert.ok(
    /customAnswerSize\(\{[\s\S]{0,500}?scrollHeight: el\.scrollHeight/.test(rows),
    "高度必须量 scrollHeight 后交给 customAnswerSize",
  );
  // 曾经溢出后，旧滚动条占宽使原本五行的内容多折一行；量高必须先恢复完整宽度。
  const grow = rows.slice(rows.indexOf("  const grow = useCallback("), rows.indexOf("  const finishGrip ="));
  const resetOverflow = grow.indexOf('el.style.overflowY = "hidden"');
  const measure = grow.indexOf("scrollHeight: el.scrollHeight");
  assert.ok(resetOverflow >= 0 && resetOverflow < measure, "量内容高度前必须撤掉旧滚动条，避免删除内容后滚动条滞留");
  const savedTop = grow.indexOf("const previousTop = el.scrollTop");
  assert.ok(
    savedTop >= 0 && savedTop < resetOverflow &&
      grow.indexOf('el.style.overflowY = size.scroll ? "auto" : "hidden"') > measure &&
      grow.indexOf("el.scrollTop = atBottom ? el.scrollHeight : previousTop") > measure,
    "重测前保存滚动位置，重测后恢复溢出状态与滚动位置",
  );
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*grow\(\);\s*\}, \[grow, props\.value, uiScale\]\)/.test(rows),
    "量高在绘制前（useLayoutEffect），内容或字号倍率变化都要重量",
  );
  assert.ok(
    /new ResizeObserver[\s\S]{0,600}?Math\.abs\(rect\.width - width\) < 0\.5/.test(rows),
    "拖侧栏改变折行后要重量，但宽度没变时不能来回量",
  );
  // 手动拖拽不能因为自增高而消失（用户 2026-10-31 明确要求保留）：
  // 右下角把手一旦真的拖动过，就以用户定的高度为准，自动量高让位。
  assert.ok(/gripStart/.test(rows) && /manual\.current = true/.test(rows), "右下角把手要有手动拖拽的检测");
  assert.ok(
    /if \(!el \|\| manual\.current\) return;/.test(rows),
    "手动拖过高度之后，自动量高必须让位（否则下一次输入把拖拽结果弹回去）",
  );

  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const rule = /\.question-custom \.question-input \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.ok(/line-height:\s*1\.5/.test(rule), "行高必须是确定数值（脚本按它算高度）");
  assert.ok(/resize:\s*vertical/.test(rule), "右下角的手动拖拽把手必须保留（原功能不能丢）");
  assert.ok(/overflow-y:\s*hidden/.test(rule), "未超行数上限时不显示滚动条（由脚本放开）");
  // 要让自绘滚动条与 resizer 生效，`scrollbar-color` 必须是 auto：不是 auto 时
  // Chromium 会整组忽略 `::-webkit-*`。
  assert.ok(
    /scrollbar-color:\s*auto/.test(rule),
    "scrollbar-color 必须是 auto，否则自绘滚动条规则会被 Chromium 整组忽略",
  );
  assert.ok(
    /\.question-custom \.question-input::-webkit-scrollbar-track \{\s*background:\s*transparent/.test(css),
    "滚动条轨道必须透明（否则会给右下角拖拽把手垫底色）",
  );
  assert.ok(
    /\.question-custom \.question-input::-webkit-scrollbar-corner \{\s*background:\s*transparent/.test(css),
    "滚动条角落必须透明（避免在角落垫出一块底色）",
  );
  assert.ok(
    /\.question-custom \.question-input::-webkit-scrollbar-thumb \{[\s\S]{0,240}?var\(--vscode-scrollbarSlider-background/.test(css) &&
      /background-clip:\s*padding-box/.test(css),
    "滑块颜色必须来自主题，并用透明边把可见厚度收到 6px",
  );
  assert.ok(
    /\.question-custom \.question-input::-webkit-resizer \{\s*border-color:\s*transparent/.test(css),
    "原生 resizer 的边框必须隐藏（改边框会连斜线一起抹掉，图形交给自绘把手）",
  );
  assert.ok(
    /className="question-input-grip"/.test(rows),
    "自绘把手 SVG 必须挂在输入框上（原生把手图形已隐藏）",
  );
  assert.ok(
    /\.question-input-grip \{[\s\S]{0,240}?pointer-events:\s*none/.test(css) &&
      /\.question-input-grip \{[\s\S]{0,180}?var\(--vscode-descriptionForeground/.test(css),
    "自绘把手必须让指针穿透给原生 resizer，颜色取主题次要文字色",
  );
}
console.log("questionInput: 自定义回答最多 5 行、超出才滚动，手动拖拽保留 ✓");
