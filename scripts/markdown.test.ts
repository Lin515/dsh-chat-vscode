/**
 * 正文 Markdown 的**行为与安全边界**（真实解析 + 服务端渲染，无浏览器）。
 *
 * 迁移后正文走 `webview/markdown/` 的 micromark → mdast → React 单文档树；这里
 * 不再断言 marked 配置或净化源码形状，而是把用户真正会看到 / 点到的 HTML 渲染
 * 出来断言：
 *
 * - GFM 任务列表复选框只由列表语法产生；模型写的原始 HTML 只显示文字；
 * - 软 / 硬换行保持 CommonMark 口径；
 * - 查找所依赖的文本节点分隔（列表项 / 表格单元格）不跨视觉单元串词；
 * - 图片保留作者 title、HTTPS 三属性、危险 scheme 不进入 DOM，HTTP 仍由 CSP 拒载；
 * - Windows 反斜杠的链接 / 图片目标保真，且不放宽到非 Windows 形状；
 * - 中文标点收尾的加粗（官方 cjkFriendlyStrong）；
 * - 文件链接 / 外链 / 页内锚点 / 行内代码文件按钮的准入与悬停。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFileLink, fileLinkPort } from "../src/webview/fileLinks";
import { Markdown } from "../src/webview/components/Markdown";
import { parseMarkdown } from "../src/webview/markdown/parse";
import { parseGfm } from "../src/vendor/ui-primitives/markdown/parse";
import { localImagePath } from "../src/shared/imageRef";
import { isExecutionWorldAbsolute, unsupportedMediaPath } from "../src/dsh/remoteFiles";
import { TextsContext, dictionaryFor } from "../src/webview/texts";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");
const texts = dictionaryFor("zh");

/** 渲染一份正文（与业务组件同一个入口）。 */
const render = (text: string, fileLinks?: ReturnType<typeof fileLinkPort>): string =>
  renderToStaticMarkup(
    createElement(
      TextsContext.Provider,
      { value: texts },
      createElement(Markdown, { text, fileLinks }),
    ),
  );

const firstUrl = (source: string, kind: "link" | "image"): string | undefined => {
  const document = parseMarkdown(source);
  let found: string | undefined;
  const visit = (node: { type: string; url?: string; children?: unknown[] }): void => {
    if (found === undefined && node.type === kind) found = node.url;
    for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) visit(child);
  };
  visit(document.root as unknown as { type: string; children?: unknown[] });
  return found;
};

// ---------- 1. GFM 任务列表与原始 HTML ----------
{
  const html = render("- [x] 做完的事\n- [ ] 没做的事\n");
  assert.strictEqual(
    [...html.matchAll(/<input[^>]*>/g)].length,
    2,
    "两个任务项各一个复选框",
  );
  assert.match(html, /<input type="checkbox" disabled="" readonly="" checked=""\/>/);
  assert.match(html, /<input type="checkbox" disabled="" readonly=""\/>/);
  assert.ok(!/<input[^>]*type="text"/.test(html), "任务项之外不能出现文本输入框");

  const hostile = "<script>alert(1)</script><input type=\"text\" value=\"boom\"><img src=x onerror=alert(1)>";
  const literal = render(`文本 ${hostile}`);
  assert.ok(literal.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "原始 HTML 按字面显示");
  assert.ok(!/<(?:script|input|img|svg|iframe)\b/i.test(literal), "原始 HTML 不生成脚本 / 输入框 / 图片等节点");
  assert.ok(!/class="file-mention"/.test(literal), "原始 HTML 不获得内部组件能力");
}
console.log("markdown: 任务复选框只读、原始 HTML 只显示文字 ✓");

// ---------- 2. 软换行 / 硬换行 ----------
{
  const soft = render("第一行\n第二行\n");
  assert.ok(!soft.includes("<br"), `单个换行保持软换行，实际：${soft}`);
  assert.ok(soft.includes("第一行\n第二行"), "软换行保留文本分隔");
  const hard = render("第一行  \n第二行\n");
  assert.match(hard, /第一行<br\/>\n第二行/, "行尾两个空格是硬换行");
}
console.log("markdown: 软换行并段、硬换行断行 ✓");

// ---------- 3. 查找文本节点分隔：列表项 / 表格单元格 ----------
{
  const list = render("- tight one\n- tight two\n");
  assert.match(list, /<ul>\n<li>/, "列表首项前有分隔文本");
  assert.match(list, /<\/li>\n<li>/, "列表项之间有分隔文本");
  assert.match(list, /<\/li>\n<\/ul>/, "列表末项后有分隔文本");
  const table = render("| left | right |\n| - | - |\n| alpha | beta |\n| gamma | delta |\n");
  assert.match(table, /<td>alpha<\/td>\n<td>beta<\/td>/, "同一行单元格之间有分隔文本");
  assert.match(table, /<\/tr>\n<tr>/, "表格行之间有分隔文本");
  assert.ok(!table.includes("leftright") && !table.includes("alphabeta"), "单元格之间不能直接粘连");
  const textNodes = list.replace(/<[^>]*>/g, "");
  assert.ok(!textNodes.includes("tight onetight two") && textNodes.includes("tight one\ntight two"));
}
console.log("markdown: 列表 / 表格的查找文本有语义分隔 ✓");

// ---------- 4. 图片：title、三属性、scheme 准入 ----------
{
  const remote = render("![图](https://example.com/a.png \"标题\")\n");
  assert.match(remote, /src="https:\/\/example\.com\/a\.png"/);
  assert.match(remote, /alt="图"/);
  assert.match(remote, /title="标题"/);
  assert.match(remote, /referrerpolicy="no-referrer"/i, "外链图不带来源");
  assert.match(remote, /loading="lazy"/, "外链图懒加载");
  assert.match(remote, /decoding="async"/);

  const referenced = render("![图][img]\n\n[img]: https://example.com/a.png \"参考标题\"\n");
  assert.match(referenced, /title="参考标题"/, "参考定义的图片 title 同样保留");

  for (const [source, expected] of [
    ["![x](http://example.com/a.png)", "http://example.com/a.png"],
    ["![x](file:///C:/a.png)", "file:///C:/a.png"],
    ["![x](data:image/png;base64,AAAA)", "data:image/png;base64,AAAA"],
    ["![x](D:\\app\\a.png)", "D:%5Capp%5Ca.png"],
  ] as const) {
    const html = render(source);
    assert.ok(html.includes(`<img src="${expected}"`), `可渲染的图片地址：${source} → ${html}`);
  }

  const dangerous = render("![图](javascript:alert(1))");
  assert.ok(!/<img/i.test(dangerous), "危险 scheme 不生成 img");
  assert.match(dangerous, /class="image-failed"/, "按加载失败降级");
  assert.ok(dangerous.includes("javascript:alert(1)"), "失败占位保留原引用，便于识别");

  // CSP 是明文 HTTP 的最后一道：img-src 只放行 data: 与 https:
  const chatView = read("src", "chatView.ts");
  assert.ok(
    /img-src \$\{webview\.cspSource\} data: https:/.test(chatView),
    "CSP 的 img-src 必须只放行 data: 与 https:（宿主产生的图是 data URL）",
  );
  assert.ok(!/img-src[^`]*http:(?!\/)/.test(chatView), "img-src 不能放行明文 http:");
}
console.log("markdown: 图片 title / 三属性 / 危险 scheme 降级 / HTTP 交 CSP ✓");

// ---------- 5. Windows 反斜杠的链接 / 图片目标 ----------
{
  const dotted = "D:\\app\\demo\\.agent\\temp\\vm";
  const body = `视觉证据：![XP 上 10 个样例窗口](${dotted}\\xp-samples.png)`
    + `（截图存于 [xp-samples.png](${dotted}\\xp-samples.png)，`
    + `进程与窗口标题原始记录在 [lin-xp-run.log](${dotted}\\lin-xp-run.log)）`;
  const rendered = render(body);
  const hrefs = [...rendered.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!);
  assert.deepStrictEqual(
    hrefs.map(decodeURIComponent),
    [`${dotted}\\xp-samples.png`, `${dotted}\\lin-xp-run.log`],
    "链接目标保住每个反斜杠且顺序不变",
  );
  const src = /src="([^"]*)"/.exec(rendered)?.[1] ?? "";
  assert.strictEqual(decodeURIComponent(src), `${dotted}\\xp-samples.png`, "图片目标同样保真");
  assert.deepStrictEqual(parseFileLink(hrefs[0]!), { path: `${dotted}\\xp-samples.png` });
  assert.strictEqual(localImagePath(src), `${dotted}\\xp-samples.png`);

  // 行号锚点与修复共存
  for (const [fragment, line] of [["#L12", 12], ["#L12-L40", 12]] as const) {
    assert.deepStrictEqual(
      parseFileLink(firstUrl(`[t](${dotted}\\a.ts${fragment})`, "link") ?? ""),
      { path: `${dotted}\\a.ts`, line },
    );
  }

  // 尖括号目标（空格与中文）
  const spaced = render("![中文 图](<D:\\app\\demo\\.agent\\截图 目录\\我的 图.png>)");
  assert.strictEqual(
    decodeURIComponent(/src="([^"]*)"/.exec(spaced)?.[1] ?? ""),
    "D:\\app\\demo\\.agent\\截图 目录\\我的 图.png",
  );

  // 标签里有未配对 backtick / HTML 属性含 `]`：新解析器认出的合法链接不能丢目标字符
  for (const label of ["a ` b", "a <b title=\"x]y\"> b", "a `]` b"]) {
    const source = `[${label}](D:\\app\\.file)`;
    assert.deepStrictEqual(
      parseFileLink(firstUrl(source, "link") ?? ""),
      { path: "D:\\app\\.file" },
      `标签形状不得影响目标提取：${label}`,
    );
  }
  assert.deepStrictEqual(
    parseFileLink(firstUrl("![a ` b](D:\\app\\.file.png)", "image") ?? ""),
    { path: "D:\\app\\.file.png" },
  );

  // 已经带 %5C 的不二次编码
  assert.strictEqual(firstUrl("[x](D:%5Capp%5C.file)", "link"), "D:%5Capp%5C.file");
  assert.ok(!render("[x](D:%5Capp%5C.file)").includes("%255C"), "不得二次编码");

  // 参考式定义保持 CommonMark 原语义（修复只针对行内目标）
  const defined = parseMarkdown("[x][r]\n\n[r]: D:\\a\\.b\n");
  assert.ok(!(defined.definitions.get("R")?.url ?? "").includes("%5C"), "参考定义不在此修复范围");

  // 代码里的路径是字面量：不变成链接 / 图片，也不被改写
  const coded = render("行内 `D:\\app\\.agent\\a.png`\n\n```\nD:\\app\\.agent\\b.png\n```\n");
  assert.ok(!/href="[^"]*app/.test(coded) && !/src="[^"]*app/.test(coded), "代码里的路径不生成链接");
  assert.ok(coded.includes("D:\\app\\.agent\\a.png") && coded.includes("D:\\app\\.agent\\b.png"));

  // 链接文字仍是普通 Markdown 转义（修复只保护目标）
  const labeled = render(`[${dotted}\\a.log](${dotted}\\a.log)`);
  assert.match(labeled, />D:\\app\\demo\.agent\\temp\\vm\\a\.log<\/a>/, "链接文字按 CommonMark 转义");

  // 没放宽任何东西：非 Windows 形状的目标与 vendor 解析结果逐字相同
  for (const untouched of [
    "[x](a\\.b)",
    "[x](a/b/c.md)",
    "[x](src\\a.ts)",
    "[x](javascript:alert(1))",
    "[x](data:text/html,x)",
    "[x](file:///etc/passwd)",
    "[x](mailto:a@b.c)",
    "[x](https://example.com/a?q=1#L2)",
    "[x](#页内锚点)",
    "![x](https://example.com/a.png)",
  ]) {
    const kind = untouched.startsWith("![") ? "image" : "link";
    assert.strictEqual(
      firstUrl(untouched, kind),
      firstUrlOfRoot(parseGfm(untouched), kind),
      `非 Windows 形状不得被修复改动：${untouched}`,
    );
  }
  // 负向对照：vendor 解析会把 `\.` 当转义吃掉——修复是必要的
  assert.ok(
    !(firstUrlOfRoot(parseGfm(`[t](${dotted}\\a.log)`), "link") ?? "").includes("%5C"),
    "vendor 解析本身不保留 Windows 反斜杠",
  );

  // UNC 只保住路径文本，点击准入照旧拒绝
  assert.strictEqual(
    parseFileLink(firstUrl("[x](\\\\host\\share\\.agent\\a.txt)", "link") ?? ""),
    undefined,
    "UNC 链接在修复后仍被点击判定拒绝",
  );

  // 落到真实文件：渲染目标能交给宿主，且盘上确实有
  {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "markdown-links-"));
    try {
      const vm = join(root, ".agent", "temp", "vm");
      mkdirSync(vm, { recursive: true });
      const png = join(vm, "xp-samples.png");
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const live = render(`![图](<${png}>)`);
      const hostPath = localImagePath(/src="([^"]*)"/.exec(live)?.[1] ?? "");
      assert.strictEqual(hostPath, png, "渲染出的图片目标原样交给宿主");
      assert.ok(hostPath && isExecutionWorldAbsolute(hostPath), "宿主拿到执行世界绝对路径");
      assert.strictEqual(unsupportedMediaPath(hostPath ?? ""), undefined);
      assert.ok(existsSync(hostPath as string), "夹具本身在盘上");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
console.log("markdown: Windows 反斜杠目标保真、非 Windows 不放宽、UNC 仍拒绝 ✓");

// ---------- 6. 中文标点收尾的加粗 ----------
{
  const reported = "建议把路径来源基准保存到消息或工具视图模型中；回放时结合目录变更事件恢复。"
    + "**变化可能发生在同一轮内部，只按轮次记目录也不够。**"
    + "分页历史缺少前置目录状态时，应补齐基准或明确无法解析，不能拿最新目录猜。";
  assert.match(render(reported), /<strong>变化可能发生在同一轮内部，只按轮次记目录也不够。<\/strong>/);

  for (const [src, expected] of [
    ["**句号。**后续", "句号。"],
    ["恢复。**变化不够。**分页", "变化不够。"],
    ["提醒！**先存盘！**再改", "先存盘！"],
    ["先确认？**还早？**接着走", "还早？"],
    ["あ。**あ。**あ", "あ。"],
    ["ア。**ア。**ア", "ア。"],
    ["가。**가。**나", "가。"],
    ["ㄅ。**ㄅ。**ㄆ", "ㄅ。"],
  ] as const) {
    const html = render(src);
    assert.ok(html.includes(`<strong>${expected}</strong>`), `标点收尾的加粗要成对：${src} → ${html}`);
    assert.ok(!html.includes("**"), `星号不得留在正文里：${src}`);
  }

  // 加粗内部仍真解析；代码里的星号保持字面
  assert.match(render("**加 `code` 的收尾。**后续"), /<strong>加 <code>code<\/code> 的收尾。<\/strong>/);
  assert.match(render("行内 `**变化不够。**分页`"), /<code>\*\*变化不够。\*\*分页<\/code>/);
  assert.ok(render("```\n**变化不够。**分页\n```").includes("**变化不够。**分页"), "围栏代码保持字面");
}
console.log("markdown: 中文 / 日文 / 韩文标点收尾的加粗成对 ✓");

// ---------- 7. 链接、页内锚点与行内代码文件按钮 ----------
{
  const links = render(
    "[文件](D:\\app\\.file) 与 [外链](https://example.com/a?q=1#L2) 与 [锚点](#x) 与 [危险](javascript:alert(1))",
  );
  assert.match(links, /<a href="D:%5Capp%5C.file"/, "文件链接保留目标");
  assert.match(links, /title="[^"]*按住 Alt 单击打开可编辑的真实文件"/, "本地文件悬停带真实文件提示");
  assert.match(links, /<a href="https:\/\/example\.com\/a\?q=1#L2"/, "外链保留完整地址");
  assert.match(links, /<a href="#x"/, "页内锚点放行");
  assert.match(links, /<a>危险<\/a>/, "危险 scheme 不给 href");

  const port = fileLinkPort(["src/bootstrap.ts"]);
  const mentioned = render("配置只读一次：`bootstrap.ts`", port);
  assert.match(
    mentioned,
    /<code><button type="button" class="file-mention" title="[^"]*bootstrap\.ts[^"]*">bootstrap\.ts<\/button><\/code>/,
    "命中词表的行内代码渲染成文件按钮",
  );
  const plain = render("配置只读一次：`bootstrap.ts`");
  assert.ok(!plain.includes("file-mention"), "没有词表时保持普通行内代码");
  const inAnchor = render("[看 `bootstrap.ts` 这一段](https://example.com)", port);
  assert.ok(!inAnchor.includes("file-mention"), "锚点内不再嵌套可交互按钮");
}
console.log("markdown: 文件 / 外链 / 页内锚点 / 危险 scheme 与行内代码按钮 ✓");

// ---------- 8. 未知内容块仍有落点（适配器不在本次迁移范围） ----------
{
  const adapter = read("src", "dsh", "adapter.ts");
  assert.ok(/kind: "unknown"/.test(adapter), "适配器要有「未知块」落点，而不是 continue 掉");
  const segment = read("src", "shared", "chat.ts");
  assert.ok(/\{ kind: "unknown"; id: string; type: string; json: string \}/.test(segment));
  assert.strictEqual(dictionaryFor("zh").unknownBlock, "未知内容块");
  assert.strictEqual(dictionaryFor("en").unknownBlock, "Unknown content block");
}
console.log("markdown: 未知内容块有落点 ✓");

console.log("\nmarkdown: all assertions passed");

/** 从任意 mdast 根取第一个链接 / 图片的 url（本文件断言用）。 */
function firstUrlOfRoot(root: unknown, kind: "link" | "image"): string | undefined {
  let found: string | undefined;
  const visit = (node: { type: string; url?: string; children?: unknown[] }): void => {
    if (found === undefined && node.type === kind) found = node.url;
    for (const child of (node.children ?? []) as { type: string; children?: unknown[] }[]) visit(child);
  };
  visit(root as { type: string; children?: unknown[] });
  return found;
}
