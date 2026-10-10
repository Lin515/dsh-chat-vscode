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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Marked } from "marked";
import { parseFileLink } from "../src/webview/fileLinks";
import { windowsPathTokenizers } from "../src/webview/linkDestinations";
import { localImagePath } from "../src/shared/imageRef";
import { resolveLocalImagePath } from "../src/dsh/localImages";
import { dictionaryFor } from "../src/webview/texts";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");
const source = read("src", "webview", "markdown.ts");

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
  assert.strictEqual(dictionaryFor("zh").unknownBlock, "未知内容块", "标签与官方逐字一致（中文）");
  assert.strictEqual(dictionaryFor("en").unknownBlock, "Unknown content block", "标签与官方逐字一致（英文）");
  console.log("markdown: 未知内容块有落点 ✓");
}

// ---------- 5. 正文里的图片：外链放行，但三件加固必须都在 ----------
//
// 模型写的 `![](https://…)` 是一张浏览器**真的会去拉**的图。用户 2026-09-17 拍板
// 保留这个显示能力（去掉 `img-src https:` 就能堵住外传通道，但回答里的外链图
// 也就没了），代价用三条加固来压：不带来源、不急着拉、明文 http 不放行。
// 这三条一旦被「顺手清理」掉，界面看不出任何异常——只是悄悄开始把信息带出去。
{
  const marked = new Marked({ gfm: true, breaks: false });
  const html = marked.parse("![图](https://example.com/a.png)", { async: false }) as string;
  assert.ok(
    /<img[^>]*src="https:\/\/example\.com\/a\.png"/.test(html),
    `marked 会把图片渲染成 <img>，实际：${html}`,
  );
  assert.ok(
    /ALLOWED_TAGS:\s*\[[\s\S]*?"img"/.test(source),
    "ALLOWED_TAGS 必须放行 img：否则正文里的图整块消失（静默）",
  );
  assert.ok(
    /\.addHook\(\s*"afterSanitizeAttributes"/.test(source),
    "必须有 afterSanitizeAttributes 钩子给图片加固",
  );
  assert.ok(
    /node\.nodeName !== "IMG"/.test(source),
    "加固钩子只对 IMG 生效（别顺手改到其它标签上）",
  );
  for (const attr of ["referrerpolicy", "loading", "decoding"]) {
    assert.ok(
      new RegExp(`ALLOWED_ATTR:\\s*\\[[^\\]]*"${attr}"`).test(source),
      `ALLOWED_ATTR 必须允许 ${attr}（图片加固用的属性）`,
    );
  }
  assert.ok(
    /setAttribute\("referrerpolicy", "no-referrer"\)/.test(source),
    "外链图片必须带 no-referrer：否则每个外链图都会把「谁在什么来源下打开了它」带出去",
  );
  assert.ok(
    /setAttribute\("loading", "lazy"\)/.test(source),
    "外链图片必须 lazy：不滚到的图不该在打开消息时就全拉一遍",
  );

  // CSP 是最后一道：明文 http 不放行（会被拦下 → 界面按「加载失败」降级）
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.ok(
    /img-src \$\{webview\.cspSource\} data: https:/.test(chatView),
    "CSP 的 img-src 必须只放行 data: 与 https:（宿主产生的图是 data URL）",
  );
  assert.ok(
    !/img-src[^`]*http:(?!\/)/.test(chatView),
    "img-src 不能放行明文 http:（可被中间人替换，且和 https 一样带外传面）",
  );
  console.log("markdown: 外链图片放行 + 三条加固（no-referrer / lazy / 只 https）✓");
}

// ---------- 6. Windows 反斜杠路径的链接 / 图片目标不被 CommonMark 当转义吃掉 ----------
//
// CommonMark 规定链接目标里「`\` + ASCII 标点」是转义序列，marked 的 `Tokenizer.link`
// 据此把 `D:\app\demo\.agent\a.log` 里 `\.` 的反斜杠吞掉——路径里每一个「反斜杠 +
// ASCII 标点」的分隔符都会丢，`\.agent` 只是最常见的形状（`\_cache`、`\-tmp` 同样
// 中招），后面跟字母的 `\dev`、`\temp` 不受影响。用户会看到两件看着无关、其实同源
// 的事：链接点开报「找不到文件：`…\demo.agent\a.log`」、正文里的本地图片显示
// 「图片加载失败」。修复在 `webview/linkDestinations.ts`（tokenizer 层把 Windows
// 形状目标里的反斜杠预编码成 `%5C`），本段用**真 marked + 真下游判定**钉住它，
// 并钉住「没有放宽任何东西」。
//
// 净化那一步在 Node 里没有 DOM（本文件上面几条「白名单与钩子」「外链图片放行」
// 的断言也是这个口径），所以补一步等价的：把 `markdown.ts` 的 `ALLOWED_URI_REGEXP`
// 取出来对**渲染产物**真跑一遍——DOMPurify 判 `href` / `src` 用的就是这条正则，
// 缺了它会出现「Node 全绿、真实浏览器里 href 被剥掉」的静默缺口。浏览器里的净化
// 与请求回路仍由 `npm run preview` 验收（判据见本文件开头那段实测记录）。
{
  const withFix = new Marked({ gfm: true, breaks: false, tokenizer: windowsPathTokenizers() });
  const withoutFix = new Marked({ gfm: true, breaks: false });
  const render = (marked: Marked, src: string): string => marked.parse(src, { async: false }) as string;
  const attrs = (html: string, name: "href" | "src"): string[] =>
    [...html.matchAll(new RegExp(`${name}="([^"]*)"`, "gu"))].map((match) => match[1]);
  const attr = (html: string, name: "href" | "src"): string => attrs(html, name)[0] ?? "";
  /** 题述症状里的点目录形状（`D:\app\demo\.agent\temp\vm`）。 */
  const dotted = "D:\\app\\demo\\.agent\\temp\\vm";

  // 点目录：图片与链接两条路都要拿回**原始**路径（下游一律 decodeURIComponent）
  const body = `视觉证据：![XP 上 10 个样例窗口](${dotted}\\xp-samples.png)`
    + `（截图存于 [xp-samples.png](${dotted}\\xp-samples.png)，`
    + `进程与窗口标题原始记录在 [lin-xp-run.log](${dotted}\\lin-xp-run.log)）`;
  const rendered = render(withFix, body);
  assert.deepStrictEqual(
    attrs(rendered, "src").map(decodeURIComponent),
    [`${dotted}\\xp-samples.png`],
    `本地图片的 Windows 路径要在 src 里原样保留，实际：${rendered}`,
  );
  assert.deepStrictEqual(
    attrs(rendered, "href").map(decodeURIComponent),
    [`${dotted}\\xp-samples.png`, `${dotted}\\lin-xp-run.log`],
    `链接目标要原样保留且顺序不变（否则点到的是另一个文件），实际：${rendered}`,
  );
  assert.deepStrictEqual(
    parseFileLink(attr(rendered, "href")),
    { path: `${dotted}\\xp-samples.png` },
    "点击判定要拿回原始路径（丢了 `\\.` 就会报「找不到文件」）",
  );
  assert.strictEqual(
    localImagePath(attr(rendered, "src")),
    `${dotted}\\xp-samples.png`,
    "本地图片那条路也要拿回原始路径（丢了就显示「图片加载失败」）",
  );

  // 行号锚点（起始行 / 区间）与修复共存
  for (const [fragment, line, label] of [["#L12", 12, "起始行"], ["#L12-L40", 12, "区间"]] as const) {
    assert.deepStrictEqual(
      parseFileLink(attr(render(withFix, `[t](${dotted}\\a.ts${fragment})`), "href")),
      { path: `${dotted}\\a.ts`, line },
      `行号锚点（${label}）要和反斜杠路径修复共存`,
    );
  }

  // 不止点目录：任何「反斜杠 + ASCII 标点」开头的目录名都会丢分隔符（`\_cache`），
  // 同一条修复覆盖它们（不扩实现，只钉住这一条规则的方向）
  const underscored = render(withFix, "[t](D:\\app\\demo\\_cache\\a.txt)");
  assert.deepStrictEqual(
    parseFileLink(attr(underscored, "href")),
    { path: "D:\\app\\demo\\_cache\\a.txt" },
    `下划线开头的目录同样要保住分隔符，实际：${underscored}`,
  );

  // 尖括号目标：文件名里有空格与中文时只能这么写
  const spaced = render(withFix, "![中文 图](<D:\\app\\demo\\.agent\\截图 目录\\我的 图.png>)");
  assert.strictEqual(
    decodeURIComponent(attr(spaced, "src")),
    "D:\\app\\demo\\.agent\\截图 目录\\我的 图.png",
    `尖括号目标（含空格与中文）要逐字保留，实际：${spaced}`,
  );

  // 代码文本不变：行内与围栏代码里的路径是字面量，不该长出链接、也不该被改
  const coded = render(withFix, "行内 `D:\\app\\.agent\\a.png`\n\n```\nD:\\app\\.agent\\b.png\n```\n");
  assert.strictEqual(
    attrs(coded, "href").length + attrs(coded, "src").length,
    0,
    `代码里的路径不该变成链接或图片，实际：${coded}`,
  );
  assert.ok(
    coded.includes("D:\\app\\.agent\\a.png") && coded.includes("D:\\app\\.agent\\b.png"),
    `行内与围栏代码里的反斜杠要逐字保留，实际：${coded}`,
  );

  // 刻意只保护**目标**：链接文字仍是普通 Markdown 转义（本修复不动 text）
  const labeled = render(withFix, `[${dotted}\\a.log](${dotted}\\a.log)`);
  assert.strictEqual(
    /<a[^>]*>([\s\S]*?)<\/a>/u.exec(labeled)?.[1],
    "D:\\app\\demo.agent\\temp\\vm\\a.log",
    "链接文字保持 CommonMark 原语义（点目录前的反斜杠仍被当转义），实际：" + labeled,
  );
  assert.strictEqual(
    decodeURIComponent(attr(labeled, "href")),
    `${dotted}\\a.log`,
    "同一条链接的目标要保住",
  );

  // 没放宽任何东西：非 Windows 形状的目标，挂与不挂修复必须产出**逐字相同**的 HTML
  for (const untouched of [
    "[x](a\\.b)",                                 // 普通转义语义（刻意不修）
    "[x](a/b/c.md)",
    "[x](src\\a.ts)",                             // 相对路径里的反斜杠不算 Windows 绝对路径
    "[x](javascript:alert(1))",
    "[x](data:text/html,x)",
    "[x](file:///etc/passwd)",
    "[x](mailto:a@b.c)",
    "[x](https://example.com/a?q=1#L2)",
    "[x](#页内锚点)",
    "![x](https://example.com/a.png)",
  ]) {
    assert.strictEqual(
      render(withFix, untouched),
      render(withoutFix, untouched),
      `非 Windows 形状的目标不得被这次修复改动：${untouched}`,
    );
  }
  // UNC 只保住路径文本，准入照旧拒绝（`parseFileLink` 的 UNC 分支）
  assert.strictEqual(
    parseFileLink(attr(render(withFix, "[x](\\\\host\\share\\.agent\\a.txt)"), "href")),
    undefined,
    "UNC 链接在修复后仍被点击判定拒绝",
  );

  // 负向对照：没有这层修复时 `\.` 就被当转义吃了——这正是要修的那条 CommonMark 语义。
  // marked 升级后此处若变红，说明上游改了这条规则，需重新评估 `linkDestinations` 是否还必要。
  assert.deepStrictEqual(
    parseFileLink(attr(render(withoutFix, `[t](${dotted}\\a.log)`), "href")),
    { path: "D:\\app\\demo.agent\\temp\\vm\\a.log" },
    "负向对照：默认管线会把点目录前的反斜杠吃掉",
  );

  // 净化层：DOMPurify 的 URI 白名单必须放行渲染产物里的每一条引用。
  // 这条闸此前咬过一次（盘符 href 被整个剥掉，锚点成空壳），所以这里不满足于
  // `fileLinks.test.ts` 里那份手写样张，而是拿**本次渲染产物**去跑同一条正则。
  const literal = /ALLOWED_URI_REGEXP\s*=\s*\/([\s\S]*?)\/([a-z]*)\s*;/u.exec(source);
  assert.ok(literal, "markdown.ts 里必须有一份显式的 ALLOWED_URI_REGEXP 字面量");
  const allowed = new RegExp(literal[1], literal[2]);
  for (const ref of [...attrs(rendered, "src"), ...attrs(rendered, "href")]) {
    assert.ok(
      allowed.test(ref),
      `净化层必须放行渲染产物里的引用（被剥掉时界面看着像文件不存在）：${ref}`,
    );
  }
  // 接线不变量：注释掉一行也算「没接」，所以这里要求它是一行**真配置**
  // （行首只允许空白，不含 `//`），并连 import 一起钉住
  assert.ok(
    /^[ \t]*tokenizer: windowsPathTokenizers\(\),$/mu.test(source),
    "markdown.ts 的 marked 实例必须真的接入 windowsPathTokenizers()（挂漏或注释掉都是静默失效）",
  );
  assert.ok(
    /import \{ windowsPathTokenizers \} from "\.\/linkDestinations";/u.test(source),
    "markdown.ts 必须从 linkDestinations 导入 windowsPathTokenizers",
  );

  // 落到真实文件：真渲染 → 真判定 → 真宿主解析（`resolveLocalImagePath` 的白名单）→ 盘上有这张图
  {
    const root = mkdtempSync(join(tmpdir(), "markdown-links-"));
    try {
      const cwd = join(root, "proj");
      const vm = join(cwd, ".agent", "temp", "vm");
      mkdirSync(vm, { recursive: true });
      const png = join(vm, "xp-samples.png");
      const log = join(vm, "lin-xp-run.log");
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      writeFileSync(log, "exit=0\n");
      // 目标用尖括号写（临时目录路径里可能有空格，裸写法本来就不是合法目标）
      const live = render(withFix, `![图](<${png}>)与[日志](<${log}>)`);
      const resolvedImage = resolveLocalImagePath(cwd, attr(live, "src"));
      assert.strictEqual(resolvedImage, png, `宿主白名单要解析出工作目录内那张真实图片，实际：${resolvedImage}`);
      assert.ok(existsSync(resolvedImage as string), "解析结果必须真的在盘上");
      const link = parseFileLink(attr(live, "href"));
      assert.deepStrictEqual(link, { path: log }, "点击判定要拿回原始路径");
      assert.ok(existsSync(resolve(cwd, link.path)), "点开时宿主解析出来的路径必须真的在盘上");
      if (process.platform === "win32") {
        assert.strictEqual(
          resolveLocalImagePath(cwd, "\\\\host\\share\\.agent\\a.png"),
          undefined,
          "UNC 图片引用必须继续被白名单拒绝（修复只保住路径文本）",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  console.log("markdown: Windows 反斜杠路径的链接/图片目标（真 marked → 真判定 → 真宿主解析）✓");
}

console.log("\nmarkdown: all assertions passed");