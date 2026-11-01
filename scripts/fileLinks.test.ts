/**
 * 正文里的**文件链接**：哪些文字点得开、点了打开什么。
 *
 * 这条链路有三段，任何一段静默失效界面上都看不出来（链接只是「点了没反应」）：
 *
 * 1. **判定**（`webview/fileLinks.ts`，纯函数）——markdown 链接目标与行内代码 token
 *    是不是本地文件。逐字对齐官方 `parseFileLink` / `producedFileMentions`；
 * 2. **落地**（`webview/markdown/render.tsx`）——把命中的行内代码换成按钮、把锚点点击交给宿主；
 * 3. **打开**（`dsh/controller.ts`）——解析相对路径、按行号落位、只认三种 scheme。
 *
 * 第 2、3 段的断言是**结构断言**（读源码正则）：它们跑在真实 DOM 与 VS Code 里，
 * 本仓库的 Node 断言环境两者都没有。钉的是「那条判据还在、没被顺手改成别的」。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/webview/components/Markdown";
import { TextsContext, dictionaryFor } from "../src/webview/texts";
import {
  basename,
  externalLinkUrl,
  fileLinkPort,
  parseFileLink,
  resolveFileMention,
} from "../src/webview/fileLinks";

/** 裸路径词表的精确 / 唯一 basename 匹配（无产物别名）。 */
const matchFileMention = (paths: readonly string[], token: string) =>
  resolveFileMention(paths, [], token);

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");

// ---------- 1. markdown 链接目标 → 本地文件与行号（官方 parseFileLink 同口径） ----------

{
  // 相对路径 / 绝对路径 / 盘符：都是文件
  assert.deepStrictEqual(parseFileLink("src/webview/App.tsx"), { path: "src/webview/App.tsx" });
  assert.deepStrictEqual(parseFileLink("/home/u/a.ts"), { path: "/home/u/a.ts" });
  assert.deepStrictEqual(parseFileLink("D:/dev/app/src/a.ts"), { path: "D:/dev/app/src/a.ts" });
  // 盘符是**唯一**放行的 scheme 形态
  assert.deepStrictEqual(parseFileLink("C:\\dev\\a.ts"), { path: "C:\\dev\\a.ts" });

  // GitHub 锚点：`#L12` / `#L12-L40`（行号只取起始行）
  assert.deepStrictEqual(parseFileLink("src/a.ts#L12"), { path: "src/a.ts", line: 12 });
  assert.deepStrictEqual(parseFileLink("src/a.ts#L12-L40"), { path: "src/a.ts", line: 12 });

  // 百分号编码：带空格的文件名
  assert.deepStrictEqual(parseFileLink("src/my%20file.ts"), { path: "src/my file.ts" });

  // Windows 目标修复会把反斜杠编码成 `%5C`（见 webview/markdown/windowsDestinations.ts），
  // 这是 Windows 绝对路径在 DOM 里的**实际 href**，点击委托原样交给这里
  assert.deepStrictEqual(parseFileLink("D:%5Cdev%5Cdemo-app%5Cindex.html"), {
    path: "D:\\dev\\demo-app\\index.html",
  });

  // 不是文件：URL（含 mailto）、页内锚点（目标为空）、查询串、UNC/网络前缀、
  // 控制字符、坏转义、非法行号
  for (const value of [
    "https://example.com/a/b",
    "mailto:someone@example.com",
    "#section",
    "src/a.ts?raw=1",
    "//host/share/a.ts",
    "\\\\host\\share\\a.ts",
    "%zz.ts",
    "src/a.ts#L0",       // 行号从 1 起
    "src/a.ts#L5-L2",    // 区间反了
    "src/a.ts#Lstart",   // 不是行号锚点
    "src/a.\u0000ts",
  ]) {
    assert.strictEqual(parseFileLink(value), undefined, `不该当成本地文件：${JSON.stringify(value)}`);
  }
}
console.log("fileLinks: markdown 链接目标 → 本地文件 + 行号（URL/锚点/查询串不算） ✓");

// ---------- 2. 行内代码 token → 本轮文件词表（官方 producedFileMentions 同口径） ----------

{
  const paths = ["out/index.html", "a/style.css", "b/style.css"];
  // 全路径写法精确命中（即使同名也不歧义）
  assert.strictEqual(matchFileMention(paths, "a/style.css"), "a/style.css");
  // 只写文件名时按**唯一**同名命中
  assert.strictEqual(matchFileMention(paths, "index.html"), "out/index.html");
  assert.strictEqual(matchFileMention(["src\\dsh\\controller.ts"], "controller.ts"), "src\\dsh\\controller.ts");
  // 同名不止一个 → 不猜（猜错会打开另一个文件，比点不开更糟）
  assert.strictEqual(matchFileMention(paths, "style.css"), undefined);
  // 本轮没写过的 token 保持惰性代码：`2/3`、`a/b` 这类普通代码不该长出假链接
  assert.strictEqual(matchFileMention(paths, "notes.md"), undefined);
  assert.strictEqual(matchFileMention(paths, "2/3"), undefined);
  assert.strictEqual(matchFileMention([], "a.ts"), undefined);
  assert.strictEqual(matchFileMention(paths, ""), undefined);

  assert.strictEqual(basename("a\\b\\c.txt"), "c.txt");
  assert.strictEqual(basename("c.txt"), "c.txt");
}
console.log("fileLinks: 行内代码只认本轮文件词表（精确 / 唯一同名，歧义与未知都不猜） ✓");

// ---------- 2b. 集合唯一匹配：参数别名并入同一集合，任一歧义都不点 ----------
//
// 官方 `producedFileMentions`：先累计精确与 basename 匹配，再把成功操作里
// `argumentPath === token` 的记录目标加入同一集合，只有集合大小为 1 才可点。
// 「最先匹配到的优先」与「别名覆盖精确匹配」都不允许。
{
  const first = "D:/project/one/out/report.txt";
  const second = "D:/project/two/out/report.txt";
  const aliases = [
    { path: first, argumentPath: "out/report.txt" },
    { path: first, argumentPath: "./out/report.txt" },
  ];
  // 同一 canonical 的两个别名都指向唯一目标
  assert.strictEqual(resolveFileMention([first], aliases, "out/report.txt"), first);
  assert.strictEqual(resolveFileMention([first], aliases, "./out/report.txt"), first);
  // 另一个完整路径前缀不是别名，不猜
  assert.strictEqual(resolveFileMention([first], aliases, "one/out/report.txt"), undefined);
  // 两个目标共享同一别名 → 集合有两个目标，保持惰性
  assert.strictEqual(
    resolveFileMention([first, second], [
      { path: first, argumentPath: "out/report.txt" },
      { path: second, argumentPath: "out/report.txt" },
    ], "out/report.txt"),
    undefined,
  );
  // 裸 path 与另一个 canonical 的 basename 同名：集合仍有两个目标（官方同口径）
  assert.strictEqual(
    resolveFileMention(["report.txt", "/project/child/report.txt"], [], "report.txt"),
    undefined,
    "旧的裸路径不能盖过同名的另一个完整路径",
  );
  assert.strictEqual(
    resolveFileMention(["report.txt", "/project/child/report.txt"], [], "/project/child/report.txt"),
    "/project/child/report.txt",
    "完整路径仍可精确命中",
  );
  // 端口：悬停与点击共用 resolve 的结果；paths 仍去重且保持顺序
  const port = fileLinkPort([
    { path: first, argumentPath: "out/report.txt" },
    { path: first, argumentPath: "./out/report.txt" },
  ], [second]);
  assert.deepStrictEqual(port.paths, [first, second]);
  assert.strictEqual(port.resolve("out/report.txt"), first);
  assert.strictEqual(port.resolve("report.txt"), undefined, "basename 装了第一行但别名不参与 basename");
}
console.log("fileLinks: producedFileMentions 集合唯一匹配（含参数别名，歧义保持惰性） ✓");

// ---------- 3. 外链白名单：只认 http / https / mailto ----------
//
// 模型输出不可信：多认一个 scheme 就等于多开一条宿主动作（`file:` 会把本地路径
// 交给系统程序，`command:` 在 VS Code 里能执行命令）。
{
  assert.strictEqual(externalLinkUrl("https://example.com/a"), "https://example.com/a");
  assert.strictEqual(externalLinkUrl("http://127.0.0.1:3080/x"), "http://127.0.0.1:3080/x");
  assert.strictEqual(externalLinkUrl("mailto:a@b.c"), "mailto:a@b.c");
  for (const value of [
    "file:///C:/Windows/System32/calc.exe",
    "command:workbench.action.terminal.new",
    "vscode://x/y",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "./doc/readme.md",   // 相对地址解析不了：那是文件链接那条路的事
  ]) {
    assert.strictEqual(externalLinkUrl(value), undefined, `不该当外链打开：${value}`);
  }
}
console.log("fileLinks: 外链只认 http/https/mailto（相对地址与其它 scheme 不放行） ✓");

// ---------- 4. 词表载体：去重、保持遇见顺序 ----------

{
  const port = fileLinkPort(["a.ts", undefined, "a.ts", "b.ts"]);
  assert.deepStrictEqual(port.paths, ["a.ts", "b.ts"]);
  assert.strictEqual(fileLinkPort([undefined]).paths.length, 0);
}
console.log("fileLinks: 词表去重且不带 undefined ✓");

// ---------- 5. 落地：行内代码按钮 / 代码块与锚点里不动（React 文档树） ----------
{
  const render = (text: string, port?: ReturnType<typeof fileLinkPort>): string =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor("zh") },
        createElement(Markdown, { text, fileLinks: port }),
      ),
    );
  const port = fileLinkPort(["src/webview/App.tsx"]);
  const mentioned = render("入口在 `App.tsx`，注意大小写。", port);
  assert.match(
    mentioned,
    /<code><button type="button" class="file-mention" title="[^"]*App\.tsx[^"]*">App\.tsx<\/button><\/code>/,
    "命中的行内代码渲染成真的 <button>，title 带完整路径与真实文件提示",
  );
  assert.ok(
    !render("```\nApp.tsx\n```", port).includes("file-mention"),
    "围栏代码块不是行内代码，不能变成文件按钮",
  );
  assert.ok(
    !render("[看 `App.tsx`](https://example.com)", port).includes("file-mention"),
    "锚点里的行内代码保持惰性（按钮不能嵌在链接里）",
  );
  assert.ok(!render("入口在 `App.tsx`").includes("file-mention"), "没有词表时保持普通行内代码");
  assert.ok(
    /const file = parseFileLink\(node\.url\)/.test(read("src", "webview", "markdown", "render.tsx")),
    "锚点按 parseFileLink 判定是不是本地文件",
  );
  assert.ok(
    /event\.preventDefault\(\);\s*\n\s*event\.stopPropagation\(\);/m.test(read("src", "webview", "markdown", "render.tsx")),
    "接手的锚点点击必须掐断冒泡（VS Code 外层还有不看 defaultPrevented 的 did-click-link）",
  );
}
console.log("fileLinks: 行内代码 → 按钮（跳过代码块与锚点，悬停与点击同一目标） ✓");

// ---------- 6. 落地：锚点三分类与行内代码文件按钮（React 渲染） ----------
{
  const render = (text: string, port?: ReturnType<typeof fileLinkPort>): string =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor("zh") },
        createElement(Markdown, { text, fileLinks: port }),
      ),
    );
  const html = render(
    "[文件](src/webview/App.tsx#L12) 与 [外链](https://example.com/a) 与 [锚点](#x) 与 [危险](javascript:alert(1))",
  );
  assert.match(html, /<a href="src\/webview\/App\.tsx#L12"/, "本地文件链接保留目标与行号");
  assert.match(html, /title="[^"]*App\.tsx[^"]*"/, "本地文件悬停给完整路径");
  assert.match(html, /<a href="https:\/\/example\.com\/a"/, "外链保留完整地址");
  assert.match(html, /<a href="#x"/, "页内锚点放行");
  assert.match(html, /<a>危险<\/a>/, "其余 scheme 不给 href，点下去不导航");
  assert.ok(
    !/href="javascript:/.test(html),
    "危险 scheme 不进入 href",
  );
  assert.ok(
    /externalLinkUrl\(node\.url\)/.test(read("src", "webview", "markdown", "render.tsx")),
    "外链判定仍走 externalLinkUrl 白名单",
  );
}
console.log("fileLinks: 锚点三分类（本地文件 / 外链 / 其余拦下，页内锚点放行） ✓");

// ---------- 6b. 代码块源文保真：链接修复不改代码内容 ----------
{
  const render = (text: string): string =>
    renderToStaticMarkup(
      createElement(
        TextsContext.Provider,
        { value: dictionaryFor("zh") },
        createElement(Markdown, { text }),
      ),
    );
  const coded = render("行内 `D:\\app\\.agent\\a.ts`\n\n```\nD:\\app\\.agent\\b.ts\n```\n");
  assert.ok(!/href="[^"]*D:/.test(coded) && !/src="[^"]*D:/.test(coded), "代码里的路径不生成链接");
  assert.ok(coded.includes("D:\\app\\.agent\\a.ts") && coded.includes("D:\\app\\.agent\\b.ts"), "反斜杠逐字保留");
}
console.log("fileLinks: 代码块里的路径不生成链接、反斜杠逐字保留 ✓");

// ---------- 7. 助手正文的词表来源：produced ∪ presented ----------

{
  const message = read("src", "webview", "components", "Message.tsx");
  assert.ok(
    /fileLinkPort\(\s*\n\s*message\.produced \?\? \[\],\s*\n\s*\(message\.deliverables \?\? \[\]\)\.map\(\(file\) => file\.path\),\s*\n\s*\)/.test(
      message,
    ),
    "词表必须是 produced 操作 ∪ deliverables（官方 producedFileMentions 同一份来源，produced 保留参数别名）",
  );
  assert.ok(
    /<StreamText[\s\S]*?text=\{segment\.text\}[\s\S]*?fileLinks=\{fileLinks\}[\s\S]*?cwd=\{cwd\}/.test(message),
    "词表与 cwd 要传给正文段（不传的话行内代码永远不会变成链接、悬停也补不出完整路径）",
  );
  assert.ok(
    /streaming=\{message\.streaming === true\}/.test(message),
    "完成态由 message.streaming 显式给出，不从围栏闭合推断",
  );
}
console.log("fileLinks: 词表 = 本轮 produced ∪ deliverables ✓");

// ---------- 8. 打开：行号落位、相对路径解析、scheme 白名单 ----------

{
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /await this\.openFile\(\s*\n\s*message\.path,\s*\n\s*message\.diff,\s*\n\s*viewId,\s*\n\s*scope\?\.sessionId,\s*\n\s*message\.line,/.test(
      controller,
    ),
    "openFile 分支要把行号与会话身份一起传下去（相对路径的基准由 Host 会话决定）",
  );
  assert.ok(
    /function isLineNumber\(value: number \| undefined\): value is number \{\s*\n\s*return value !== undefined && Number\.isSafeInteger\(value\) && value >= 1;/.test(
      controller,
    ),
    "行号判据只有一份（isLineNumber：1 基安全正整数）",
  );
  assert.ok(
    /private revealLine\(document: vscode\.TextDocument, line\?: number\): vscode\.Position \| undefined \{[\s\S]*?if \(!isLineNumber\(line\)\) return undefined;[\s\S]*?Math\.min\(line - 1, Math\.max\(0, document\.lineCount - 1\)\)/.test(
      controller,
    ),
    "行号要夹到文件实际行数：越界的 Position 在 VS Code 里是**抛异常**而不是夹取",
  );
  assert.ok(
    /\.\.\.\(position \? \{ selection: new vscode\.Range\(position, position\) \} : \{\}\)/.test(controller),
    "只有拿到位置时才给 selection（拿不到就照旧从文件开头打开）",
  );
  assert.ok(
    /case "openExternal": \{\s*\n\s*await this\.openExternal\(message\.url, viewId\);/.test(controller),
    "宿主要有 openExternal 分支，并把提示发给**点它的那个窗口**",
  );
  assert.ok(
    /const allowed = \["http:", "https:", "mailto:"\];/.test(controller),
    "宿主这层要再判一次 scheme 白名单：webview 发来的帧不该被当成可信输入",
  );
  assert.ok(
    /const opened = await vscode\.env\.openExternal\(vscode\.Uri\.parse\(url\)\);/.test(controller) &&
      /if \(!opened\) \{/.test(controller),
    "系统没接受打开请求时要明确提示，不能静默（「点了没反应」正是本条要避免的失败）",
  );
  assert.ok(
    /case "openFile": \{[\s\S]*?message\.real === true/.test(controller),
    "openFile 帧要把 real 标记传给宿主（缺省只读，显式才尝试真实文件）",
  );
  assert.ok(
    /private async openRealFile\(/.test(controller) &&
      /isLocalAbsolutePath\(stat\.absolutePath, platform\)/.test(controller) &&
      /sameBytes\(remote\.data, localBytes\)/.test(controller),
    "真实文件打开要有本机路径形态、本机存在性与字节身份校验",
  );
  assert.ok(
    /case "openFileInBrowser": \{[\s\S]*?await this\.openFileInBrowser\(viewId, message\.path\);/.test(controller),
    "宿主要有 openFileInBrowser 分支（HTML 文件的 Ctrl/Cmd 单击）",
  );
  assert.ok(
    /private async openFileInBrowser\(viewId: string, path: string\): Promise<void> \{[\s\S]*?if \(!isBrowserOpenableFile\(stat\.absolutePath\)\) \{[\s\S]*?await this\.openThroughHost\(client, stat\.absolutePath, "open", sessionId\)/.test(
      controller,
    ),
    "宿主这层要用同一份 web 文件白名单再验一次，并交给 Host 原生打开（不 Uri.file / 不本机 openExternal）",
  );

  const ipc = read("src", "shared", "ipc.ts");
  assert.ok(
    /type: "openFile"[\s\S]*?real\?: true/.test(ipc),
    "openFile 要带可选行号、「来自链接」标记、真实文件标记与改动坐标",
  );
  assert.ok(/\{ type: "openExternal"; url: string \}/.test(ipc), "要有 openExternal 这条帧");
  assert.ok(
    /\{ type: "openFileInBrowser"; path: string \}/.test(ipc),
    "要有 openFileInBrowser 这条帧（与 openFile 分开，宿主才能按 web 文件白名单收窄）",
  );
}
console.log("fileLinks: 宿主侧行号落位 + 相对路径解析 + 外链白名单 ✓");

// ---------- 8b. 打不开时：先试「路径:行号」，再按来路给不同的措辞 ----------
//
// 两个都在宿主侧，都是**用户报「文件不存在」时最直接的落点**：
// 1. 链接目标里的行号常被写成 `:24`（DSH 的标签约定串进了目标），整条
//    `src/a.ts:24` 当文件名去查盘必然 miss —— 字面路径 miss 后再拆一次；
// 2. 链接打不开时说「文件已删除」是误导（模型写的相对路径从一开始就没指对
//    地方也能触发这句），所以把**解析出来的绝对路径**报出来。
{
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /if \(isLineNumber\(line\) \|\| !splitPathLineSuffix\(path\)\) return \{ kind: "absent" \}/.test(controller) &&
      /const split = splitPathLineSuffix\(path\);/.test(controller) &&
      /await access\.stat\(sessionId, split\.path\)/.test(controller),
    "字面路径 not-found 时按「路径:行号」重试一次（字面优先：真叫 `a:12` 的文件照样开得到）",
  );
  assert.ok(
    /const split = splitPathLineSuffix\(path\);/.test(controller),
    "重试必须走 splitPathLineSuffix（判定口径只有一份）",
  );
  assert.ok(
    /text: fromLink \? `@fileNotFound:\$\{path\}` : "@chipFileDeleted"/.test(controller),
    "链接（@fileNotFound，带目标路径）与文件芯片（@chipFileDeleted）的措辞必须分开",
  );

  const messages = read("src", "webview", "messages.ts");
  assert.ok(
    /fileNotFound: \{\s*\n\s*zh: \(path: string\) => `找不到文件：\$\{path\}`,\s*\n\s*en: \(path: string\) => `No such file: \$\{path\}`,\s*\n\s*\},/.test(
      messages,
    ),
    "fileNotFound 必须中英各一条、带路径参数（文案不许拼字符串）",
  );
}
console.log("fileLinks: 路径:行号重试 + 链接/芯片措辞分开 ✓");

// ---------- 9. 样式：可点的行内代码要有可点的样子，且仍是一枚代码芯片 ----------

{
  const css = read("src", "webview", "styles", "app.css");
  const rule = /\n\.md code > \.file-mention \{([\s\S]*?)\}/.exec(css);
  assert.ok(rule, "app.css 里找不到 .md code > .file-mention");
  assert.ok(/cursor:\s*pointer/.test(rule[1]), "可点的行内代码要给手型光标");
  assert.ok(
    /background:\s*none/.test(rule[1]) && /border:\s*none/.test(rule[1]),
    "按钮自己不画底色/边框：芯片的样子由外层 code 给（官方 .fileMention 同口径）",
  );
  assert.ok(/color:\s*var\(--link\)/.test(rule[1]), "文字按链接色");
  const hover = /\n\.md code > \.file-mention:hover,\s*\n\.md code > \.file-mention:focus-visible \{([\s\S]*?)\}/.exec(css);
  assert.ok(hover, "找不到悬停/聚焦那一条");
  assert.ok(
    /text-decoration:\s*underline dotted currentColor/.test(hover[1]),
    "悬停与键盘聚焦都要给下划线：静止态不给（等宽字的下伸部会和下划线打架）",
  );
}
console.log("fileLinks: 可点行内代码的光标/悬停/聚焦样式 ✓");

console.log("\nfileLinks: all assertions passed");
