/**
 * 正文里的**文件链接**：哪些文字点得开、点了打开什么。
 *
 * 这条链路有三段，任何一段静默失效界面上都看不出来（链接只是「点了没反应」）：
 *
 * 1. **判定**（`webview/fileLinks.ts`，纯函数）——markdown 链接目标与行内代码 token
 *    是不是本地文件。逐字对齐官方 `parseFileLink` / `producedFileMentions`；
 * 2. **落地**（`webview/fileMentions.ts` + `components/Markdown.tsx`）——把命中的
 *    行内代码换成按钮、把锚点点击交给宿主；
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
import {
  basename,
  externalLinkUrl,
  fileLinkPort,
  matchFileMention,
  parseFileLink,
} from "../src/webview/fileLinks";

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

// ---------- 4. 词表载体：去重、保持遇见顺序、settled 原样带上 ----------

{
  const port = fileLinkPort(["a.ts", undefined, "a.ts", "b.ts"], true);
  assert.deepStrictEqual(port.paths, ["a.ts", "b.ts"]);
  assert.strictEqual(port.settled, true);
  assert.strictEqual(fileLinkPort([undefined], false).paths.length, 0);
}
console.log("fileLinks: 词表去重且不带 undefined ✓");

// ---------- 5. 落地：行内代码换成按钮，且不在代码块 / 锚点里动手 ----------

{
  const mentions = read("src", "webview", "fileMentions.ts");
  assert.ok(
    /createElement\("button"\)/.test(mentions) && /button\.className = MENTION_CLASS/.test(mentions),
    "命中的行内代码要换成真的 <button>（自带键盘可达与语义，不必放宽净化白名单）",
  );
  assert.ok(
    /const MENTION_CLASS = "file-mention"/.test(mentions),
    "类名必须是 file-mention（样式与断言都按它找）",
  );
  assert.ok(
    /code\.closest\("pre"\)/.test(mentions),
    "缩进写法的代码块（`pre > code`）不是行内代码，不能变成链接",
  );
  assert.ok(
    /code\.closest\("a"\)/.test(mentions),
    "锚点里的 token 保持惰性（官方同口径：按钮不能嵌在链接里）",
  );
  assert.ok(
    /code\.childElementCount > 0/.test(mentions),
    "已经被换过的节点不再处理（异常形态下也别把 DOM 套两层）",
  );
  assert.ok(
    /button\.title = path/.test(mentions),
    "按钮要带上**解析后的完整路径**：正文里常只写文件名，悬停得能看出开的是哪个",
  );
  assert.ok(
    /const token = code\.textContent \?\? ""/.test(mentions) &&
      /const path = matchFileMention\(port\.paths, token\)/.test(mentions),
    "判定必须用行内代码的**全文**去对词表（部分匹配会切出半截路径）",
  );
  assert.ok(
    /if \(!port \|\| !port\.settled \|\| port\.paths\.length === 0\) return \(\) => \{\}/.test(mentions),
    "流式期间（settled=false）与没有词表时不做任何事——官方本地文件链接同样是惰性的",
  );
  assert.ok(
    /code\.replaceChildren\(token\)/.test(mentions),
    "清理要把节点还原：词表可能**晚于**正文到达（轮次结束时正文没变），不还原就永远补不上按钮",
  );

  const markdown = read("src", "webview", "components", "Markdown.tsx");
  assert.ok(
    /const undoMentions = hydrateFileMentions\(root, fileLinks, openFile\);/.test(markdown),
    "Markdown 的 HtmlBlock 要把词表交给 hydrate（否则行内代码永远是纯文本）",
  );
  assert.ok(
    /useLayoutEffect\(\(\) => \{[\s\S]*?hydrateFileMentions/.test(markdown),
    "换成按钮要**在绘制前**做完（与本地图同一理由：先画一帧纯文本再跳成按钮会闪）",
  );
  assert.ok(
    /undoImages\(\);\s*\n\s*undoMentions\(\);/.test(markdown),
    "两个 hydrate 的清理都要跑",
  );
}
console.log("fileLinks: 行内代码 → 按钮（跳过代码块与锚点，绘制前完成，可还原） ✓");

// ---------- 6. 落地：锚点点击委托的三分类 ----------

{
  const markdown = read("src", "webview", "components", "Markdown.tsx");
  assert.ok(
    /post\(\{ type: "openFile", path, line, link: true \}\)/.test(markdown),
    "文件链接要带上行号与「来自链接」标记发 openFile（后者决定打不开时的措辞）",
  );
  assert.ok(
    /const file = parseFileLink\(href\);/.test(markdown),
    "锚点要按 parseFileLink 判定是不是本地文件",
  );
  assert.ok(
    /if \(fileLinks && !fileLinks\.settled\) return;/.test(markdown),
    "流式期间本地文件链接保持惰性（官方 renderAnchor 的 streaming 分支同口径）",
  );
  assert.ok(
    /const external = externalLinkUrl\(href\);\s*\n\s*if \(external\) post\(\{ type: "openExternal", url: external \}\);/.test(
      markdown,
    ),
    "外链交给宿主用系统浏览器打开（webview 自己开不了，让 <a> 导航会把聊天界面换掉）",
  );
  assert.ok(
    /if \(href === "" \|\| href\.startsWith\("#"\)\) return;/.test(markdown),
    "页内锚点（模型写的 `[小节](#锚点)`）交给浏览器自己滚，不能被拦成死键",
  );
  assert.ok(
    /event\.preventDefault\(\);/.test(markdown),
    "其余链接一律拦下：webview 里让 <a> 自己导航会把整个聊天界面换掉",
  );
}
console.log("fileLinks: 锚点点击三分类（本地文件 / 外链 / 其余拦下，页内锚点放行） ✓");

// ---------- 7. 助手正文的词表来源：produced ∪ presented，且流式期间不生效 ----------

{
  const message = read("src", "webview", "components", "Message.tsx");
  assert.ok(
    /fileLinkPort\(\s*\n\s*\[\.\.\.\(message\.produced \?\? \[\]\), \.\.\.\(message\.deliverables \?\? \[\]\)\.map\(\(file\) => file\.path\)\],\s*\n\s*!message\.streaming,/.test(
      message,
    ),
    "词表必须是 produced ∪ deliverables（官方 producedFileMentions 同一份来源），settled = !streaming",
  );
  assert.ok(
    /<StreamText key=\{segment\.id\} text=\{segment\.text\} fileLinks=\{fileLinks\} \/>/.test(message),
    "词表要传给正文段（不传的话行内代码永远不会变成链接）",
  );
}
console.log("fileLinks: 词表 = 本轮 produced ∪ deliverables，流式期间 settled=false ✓");

// ---------- 8. 打开：行号落位、相对路径解析、scheme 白名单 ----------

{
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /await this\.openFile\(\s*\n\s*message\.path,\s*\n\s*message\.diff,\s*\n\s*viewId,\s*\n\s*scope \? this\.cwdOf\(scope\) : undefined,\s*\n\s*message\.line,/.test(
      controller,
    ),
    "openFile 分支要把行号与会话 cwd 一起传下去（相对路径的基准只有宿主知道）",
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

  const ipc = read("src", "shared", "ipc.ts");
  assert.ok(
    /\{ type: "openFile"; path: string; diff\?: boolean; line\?: number; link\?: true \}/.test(ipc),
    "openFile 要带可选行号与「来自链接」标记",
  );
  assert.ok(/\{ type: "openExternal"; url: string \}/.test(ipc), "要有 openExternal 这条帧");
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
    /if \(existence === "absent" && !isLineNumber\(effectiveLine\)\) \{[\s\S]*?const split = splitPathLineSuffix\(path\);[\s\S]*?await this\.fileExistence\(vscode\.Uri\.file\(retry\)\)\) === "present"/.test(
      controller,
    ),
    "字面路径不存在时要按「路径:行号」重试一次（字面优先：真叫 `a:12` 的文件照样开得到）",
  );
  assert.ok(
    /const split = splitPathLineSuffix\(path\);/.test(controller),
    "重试必须走 splitPathLineSuffix（判定口径只有一份）",
  );
  assert.ok(
    /private reportMissingFile\(viewId: string \| undefined, resolved: string, fromLink: boolean\): void \{/.test(
      controller,
    ) && /text: fromLink \? `@fileNotFound:\$\{resolved\}` : "@chipFileDeleted"/.test(controller),
    "链接（@fileNotFound，带解析出的绝对路径）与文件芯片（@chipFileDeleted）的措辞必须分开",
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
