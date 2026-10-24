/**
 * 正文文件链接 / 外链的**悬停标题**与 HTML 文件的浏览器打开判据。
 *
 * 这一份只测纯函数与接线：
 * - `isBrowserOpenableFile`：哪些扩展名可以交给系统浏览器（白名单，界面与宿主共用）；
 * - `browserOpenRequested`：修饰键 + 扩展名同时成立才换路；
 * - `fileLinkHoverTitle` / `externalLinkHoverTitle`：悬停给完整路径 / 完整地址；
 * - 渲染与宿主两端的接线（DOM 那一步在真实 webview 里，Node 断言环境没 DOM）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBrowserOpenableFile } from "../src/shared/webFile";
import { browserOpenRequested } from "../src/webview/fileLinks";
import { externalLinkHoverTitle, fileLinkHoverTitle, hydrateLinkTitles } from "../src/webview/linkHovers";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");
const texts = { webFileBrowserHint: "按住 Ctrl/Cmd 单击，在浏览器中打开" };

// ---------- 1. web 文件白名单：只认 HTML 家族 ----------
{
  for (const path of [
    "index.html",
    "out/page.htm",
    "D:\\dev\\demo\\index.HTML",
    "src/page.xhtml",
    "site/index.shtml",
    "page.html?x=1#L2",
  ]) {
    assert.strictEqual(isBrowserOpenableFile(path), true, `应当可以用浏览器打开：${path}`);
  }
  for (const path of [
    "a.exe",
    "a.html.exe",
    "a.ts",
    "a.svg",
    "a.mhtml",
    "a.md",
    "a.htm.txt",
    "a.htmlx",
    "folder.html/a.ts",
    "html",
    "",
  ]) {
    assert.strictEqual(isBrowserOpenableFile(path), false, `不应交给浏览器：${path}`);
  }
}
console.log("linkHovers: 浏览器可直接打开的文件只认 HTML 家族（大小写 / 查询串不影响） ✓");

// ---------- 2. 修饰键：Ctrl/Cmd + HTML 文件才换路 ----------
{
  const ctrl = { ctrlKey: true, metaKey: false };
  const meta = { ctrlKey: false, metaKey: true };
  const plain = { ctrlKey: false, metaKey: false };
  assert.strictEqual(browserOpenRequested(ctrl, "out/index.html"), true);
  assert.strictEqual(browserOpenRequested(meta, "out/index.html"), true);
  assert.strictEqual(browserOpenRequested(plain, "out/index.html"), false);
  // 普通文件按住修饰键仍是打开编辑器：不扩大宿主动作
  assert.strictEqual(browserOpenRequested(ctrl, "src/a.ts"), false);
}
console.log("linkHovers: 只有 Ctrl/Cmd + HTML 文件才改走浏览器 ✓");

// ---------- 3. 悬停标题：完整路径 / 完整链接 ----------
{
  assert.strictEqual(
    fileLinkHoverTitle("D:/dev/app", "src/index.html", texts),
    `D:/dev/app/src/index.html\n${texts.webFileBrowserHint}`,
  );
  // 绝对路径归一（盘符保留、分隔符统一）
  assert.strictEqual(
    fileLinkHoverTitle("D:/dev/app", "D:\\dev\\demo\\index.html", texts),
    `D:/dev/demo/index.html\n${texts.webFileBrowserHint}`,
  );
  // 普通文件只给路径，不补浏览器提示
  assert.strictEqual(fileLinkHoverTitle("D:/dev/app", "src/a.ts", texts), "D:/dev/app/src/a.ts");
  // 没有 cwd 时不猜绝对位置：保留链接上的原样拼写
  assert.strictEqual(fileLinkHoverTitle(undefined, "src/index.html", texts), `src/index.html\n${texts.webFileBrowserHint}`);
  assert.strictEqual(externalLinkHoverTitle("https://example.com/a"), "https://example.com/a");
}
console.log("linkHovers: 文件链接给完整路径、外链给完整地址（HTML 再补修饰键提示） ✓");

// ---------- 3b. 锚点 title 注入与还原（最小节点替身，只实现用到的 DOM 面） ----------
{
  interface FakeAnchor {
    attributes: Map<string, string>;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
  }
  const anchor = (href: string, title?: string): FakeAnchor => {
    const attributes = new Map<string, string>([["href", href]]);
    if (title !== undefined) attributes.set("title", title);
    return {
      attributes,
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => void attributes.set(name, value),
      removeAttribute: (name) => void attributes.delete(name),
    };
  };
  const file = anchor("src/index.html");
  const link = anchor("https://example.com/a");
  const page = anchor("#section");
  const authored = anchor("src/a.ts", "作者写的说明");
  const anchors = [file, link, page, authored];
  const root = {
    querySelectorAll: (selector: string) => (selector === "a[href]" ? anchors : []),
  } as unknown as HTMLElement;

  const undo = hydrateLinkTitles(root, "D:/dev/app", texts);
  assert.strictEqual(
    file.attributes.get("title"),
    `D:/dev/app/src/index.html\n${texts.webFileBrowserHint}`,
  );
  assert.strictEqual(link.attributes.get("title"), "https://example.com/a");
  assert.strictEqual(page.attributes.get("title"), undefined, "页内锚点不编标题");
  assert.strictEqual(
    authored.attributes.get("title"),
    `作者写的说明\nD:/dev/app/src/a.ts`,
    "markdown 自带的标题保留，完整目标追加在后",
  );
  undo();
  assert.strictEqual(file.attributes.get("title"), undefined, "清理要把新加的 title 摘掉");
  assert.strictEqual(link.attributes.get("title"), undefined);
  assert.strictEqual(authored.attributes.get("title"), "作者写的说明", "自带的标题要还原");
}
console.log("linkHovers: 锚点 title 注入完整目标、保留作者标题、可还原 ✓");

// ---------- 4. 接线：锚点标题注入、行内代码与宿主分流 ----------
{
  const markdown = read("src", "webview", "components", "Markdown.tsx");
  assert.ok(
    /hydrateLinkTitles\(root, cwd, texts\)/.test(markdown),
    "锚点的 title 要在渲染后补（注入的 HTML 不在 React props 树里）",
  );
  assert.ok(
    /openFileInBrowser/.test(markdown) &&
      /if \(event && browserOpenRequested\(event, path\)\) \{/.test(markdown) &&
      /openFile\(file\.path, file\.line, event\)/.test(markdown),
    "本地文件点击统一走 openFile，按住修饰键时由它发 openFileInBrowser",
  );
  const mentions = read("src", "webview", "fileMentions.ts");
  assert.ok(
    /fileLinkHoverTitle\(cwd, path, texts\)/.test(mentions),
    "行内代码按钮的 title 用同一份构造器",
  );
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /if \(!isBrowserOpenableFile\(resolved\)\)/.test(controller),
    "宿主必须用同一份白名单再验一次（webview 帧不可信）",
  );
  const messages = read("src", "webview", "messages.ts");
  assert.ok(
    /webFileBrowserHint: \{\s*\n\s*zh:/.test(messages) && /en:/.test(messages),
    "浏览器提示必须中英各一条",
  );
}
console.log("linkHovers: 悬停标题与浏览器打开在渲染 / 宿主两端都接上 ✓");

console.log("\nlinkHovers: all assertions passed");
