/**
 * Markdown 渲染的**安全与能力边界**。
 *
 * 两件事必须钉住，都属于「静默失效」那一类——界面不报错，功能却没了：
 *
 * 1. **GFM 任务列表的复选框**：marked 会渲染 `<input type="checkbox" disabled>`，
 *    而 DOMPurify 的白名单里没有 `input` 时，整个复选框被**静默剥掉**——
 *    `- [x] 做完的事` 与 `- 没做的事` 在界面上长得一模一样（官方渲染链带
 *    taskList 扩展，复选框是真的画出来的）。
 * 2. **只放行复选框**：白名单一旦允许 `input`，模型输出里的
 *    `<input type="text">` / `type="file"` 也会活下来，在消息正文里长出一个
 *    可交互的控件。所以有个 `uponSanitizeElement` 钩子把非 checkbox 的 input 删掉。
 *
 * 为什么这里是「结构断言 + marked 输出实测」而不是跑一遍 `renderMarkdown`：
 * DOMPurify 需要真实 DOM，本仓库的 Node 测试环境没有 jsdom/happy-dom（不为测试
 * 引入依赖），所以净化本身**在真实浏览器里验证过**（`npm run preview` 的页面，
 * Playwright 实测记录见下面第 3 段注释）。这里钉住的是「配置与钩子还在」，
 * 防止以后有人「顺手清理」掉。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Marked } from "marked";

const source = readFileSync(join(process.cwd(), "src", "webview", "markdown.ts"), "utf8");

// ---------- 1. marked 确实会产出复选框（白名单为什么必须带上 input） ----------
{
  const marked = new Marked({ gfm: true, breaks: true });
  const html = marked.parse("- [x] 做完的事\n- [ ] 没做的事\n", { async: false }) as string;
  assert.ok(
    /<input[^>]*type="checkbox"/.test(html),
    `marked 的任务列表应当产出 checkbox，实际：${html}`,
  );
  assert.ok(/checked/.test(html), "`[x]` 那一项要带 checked");
  assert.ok(/disabled/.test(html), "任务列表的复选框应当是 disabled（消息里的框不该能点）");
  console.log("markdown: marked 的 GFM 任务列表产出复选框 ✓");
}

// ---------- 2. 白名单与钩子（净化配置的结构不变量） ----------
{
  assert.ok(
    /ALLOWED_TAGS:\s*\[[\s\S]*?"input"/.test(source),
    "ALLOWED_TAGS 必须允许 input：否则任务列表的复选框会被静默剥掉（两种待办长得一样）",
  );
  for (const attr of ["type", "checked", "disabled"]) {
    assert.ok(
      new RegExp(`ALLOWED_ATTR:\\s*\\[[^\\]]*"${attr}"`).test(source),
      `ALLOWED_ATTR 必须允许 ${attr}（复选框的形态与只读状态）`,
    );
  }
  assert.ok(
    // 实例按环境解析（`resolvePurify()`：浏览器里默认导出就是实例，Node 下要现造），
    // 所以这里只钉「挂上了这个钩子」，不钉接收者叫什么名字
    /\.addHook\(\s*"uponSanitizeElement"/.test(source),
    "必须有 uponSanitizeElement 钩子：白名单允许了 input，就得把非 checkbox 的挡掉",
  );
  assert.ok(
    /data\.tagName !== "input"/.test(source) && /type !== "checkbox"/.test(source),
    "钩子必须是「只放行 checkbox」这一条判据（按肯定证据写），别放宽成放行所有 input",
  );
  assert.ok(
    /node\.parentNode\?\.removeChild\(node\)/.test(source),
    "非 checkbox 的 input 要**整个删掉**，不是只清属性",
  );
  console.log("markdown: 白名单放行复选框 + 钩子只放行 checkbox ✓");
}

// ---------- 3. 真实浏览器实测记录（无法在 Node 复现，故写成断言注释） ----------
//
// `npm run preview`（test/preview.html）+ Playwright 实推一条含任务列表与
// 恶意 input 的消息，实测结果：
//   - 两个复选框都在：`[x]` → checked=true/disabled=true，`[ ]` → checked=false
//   - 非 checkbox 的 input 数量 = 0（`type="text"`、`type="file"` 都被钩子删掉）
//   - `<script>` 数量 = 0，`<img onerror>` 的 onerror 属性为 null
//   - 正文里搜不到那个 input 的 value（"boom"）
// 这几条是本文件的「净化真的生效」证据；Node 侧跑不了不是遗漏，是没有 DOM。
{
  assert.ok(
    // 用解析出来的实例（`purify`）调用，而不是直接 `DOMPurify.sanitize`：Node 下
    // 默认导出是工厂函数，没有 DOM 时 `sanitize()` 会显式报错而不是放行
    /purify\.sanitize\(/.test(source),
    "渲染前必须经 DOMPurify.sanitize（模型输出不可信）",
  );
  console.log("markdown: 净化链路存在（真实浏览器实测记录见本文件注释） ✓");
}

// ---------- 3. 软换行口径与官方一致（breaks: false） ----------
//
// 官方渲染链是 CommonMark：单个换行当空格，只有硬换行（行尾两个空格 / 反斜杠）
// 才断行。`breaks: true` 会把每个单换行变成 `<br>`——那是本扩展自己的选择，
// 现在按官方对齐（这是**可见的行为改变**：模型输出里不带标记的短行会被并成一段）。
{
  const marked = new Marked({ gfm: true, breaks: false });
  const soft = marked.parse("第一行\n第二行\n", { async: false }) as string;
  assert.ok(
    !/<br\s*\/?>/.test(soft),
    `单个换行不该变成 <br>（CommonMark 软换行），实际：${soft}`,
  );
  const hard = marked.parse("第一行  \n第二行\n", { async: false }) as string;
  assert.ok(/<br\s*\/?>/.test(hard), "行尾两个空格是硬换行，必须断行");
  assert.ok(
    /^\s*breaks:\s*false,/m.test(source),
    "markdown.ts 必须是 breaks: false（官方 CommonMark 口径）",
  );
  // 只看**配置行**：注释里会提到旧写法（`breaks: true`），别把说明文字当成配置
  assert.ok(
    !/^\s*breaks:\s*true,/m.test(source),
    "不能退回 breaks: true（那是本扩展自己的口径）",
  );
  console.log("markdown: 软换行口径对齐官方（breaks: false） ✓");
}

// ---------- 4. 未知内容块不再静默丢弃（官方默认分支的 JsonBlock） ----------
//
// 官方渲染链对认不出的内容块走 default 分支：画一个标签为「未知内容块」的 JSON
// 记录（`message.unknownBlock`）。此前我们的适配器只认 text/reasoning/image，
// 其余块**整块消失**——模型给的东西在界面上连痕迹都没有。
{
  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(
    /kind: "unknown"/.test(adapter),
    "适配器要有一个「未知块」的落点，而不是 continue 掉",
  );
  const segment = readFileSync(join(process.cwd(), "src", "shared", "chat.ts"), "utf8");
  assert.ok(
    /\{ kind: "unknown"; id: string; type: string; json: string \}/.test(segment),
    "Segment 要有 unknown 变体（type + json）",
  );
  const texts = readFileSync(join(process.cwd(), "src", "webview", "texts.ts"), "utf8");
  assert.ok(/unknownBlock: "未知内容块"/.test(texts), "标签与官方逐字一致（中文）");
  assert.ok(/unknownBlock: "Unknown content block"/.test(texts), "标签与官方逐字一致（英文）");
  console.log("markdown: 未知内容块有落点 ✓");
}

console.log("\nmarkdown: all assertions passed");
