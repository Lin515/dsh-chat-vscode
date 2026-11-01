/**
 * 正文文件链接 / 外链的**悬停标题**与 HTML 文件的浏览器打开判据。
 *
 * 这一份只测纯函数与接线：
 * - `isBrowserOpenableFile`：哪些扩展名可以交给系统浏览器（白名单，界面与宿主共用）；
 * - `browserOpenRequested`：Ctrl/Cmd + 扩展名同时成立才换路；
 * - `fileOpenIntent` / `modifierLabelFor` / `altLabelFor`：Alt 真实文件、平台标签；
 * - `fileLinkHoverTitle` / `externalLinkHoverTitle` / `mergeHoverTitle`：悬停给完整
 *   路径 / 完整地址，并保留作者写的 title；
 * - 渲染与宿主两端的接线（标题现在由 React 渲染树合成，DOM 证据见 markdown 测试）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isBrowserOpenableFile } from "../src/shared/webFile";
import { browserOpenRequested, fileOpenIntent } from "../src/webview/fileLinks";
import { externalLinkHoverTitle, fileLinkHoverTitle, mergeHoverTitle } from "../src/webview/linkHovers";
import { altLabelFor, modifierLabelFor } from "../src/webview/modifierLabel";

const read = (...parts: string[]): string => readFileSync(join(process.cwd(), ...parts), "utf8");
const texts = {
  openRealFileHint: (alt: string) => `按住 ${alt} 单击打开可编辑的真实文件`,
  webFileBrowserHint: (modifier: string) => `按住 ${modifier} 单击，在浏览器中打开`,
};

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

// ---------- 1b. 平台修饰键标签：Mac 是 Cmd，其余是 Ctrl ----------
{
  assert.strictEqual(modifierLabelFor("MacIntel"), "Cmd");
  assert.strictEqual(modifierLabelFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Cmd");
  assert.strictEqual(modifierLabelFor("Win32"), "Ctrl");
  assert.strictEqual(modifierLabelFor("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), "Ctrl");
  assert.strictEqual(modifierLabelFor("Linux x86_64"), "Ctrl");
  assert.strictEqual(modifierLabelFor(undefined), "Ctrl");
  assert.strictEqual(altLabelFor("MacIntel"), "Option");
  assert.strictEqual(altLabelFor("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"), "Option");
  assert.strictEqual(altLabelFor("Win32"), "Alt");
  assert.strictEqual(altLabelFor("Linux x86_64"), "Alt");
  assert.strictEqual(altLabelFor(undefined), "Alt");
}
console.log("linkHovers: 平台标签 Mac→Cmd/Option、Win/Linux→Ctrl/Alt ✓");

// ---------- 2. 点击意图：Alt 打开真实文件，Ctrl/Cmd + HTML 走浏览器 ----------
{
  const alt = { altKey: true, ctrlKey: false, metaKey: false };
  const ctrl = { altKey: false, ctrlKey: true, metaKey: false };
  const meta = { altKey: false, ctrlKey: false, metaKey: true };
  const plain = { altKey: false, ctrlKey: false, metaKey: false };
  assert.strictEqual(browserOpenRequested(ctrl, "out/index.html"), true);
  assert.strictEqual(browserOpenRequested(meta, "out/index.html"), true);
  assert.strictEqual(browserOpenRequested(alt, "out/index.html"), false);
  assert.strictEqual(browserOpenRequested(plain, "out/index.html"), false);
  // 普通文件按住 Ctrl/Cmd 仍是只读预览
  assert.strictEqual(browserOpenRequested(ctrl, "src/a.ts"), false);

  assert.strictEqual(fileOpenIntent(alt, "src/a.ts"), "real");
  assert.strictEqual(fileOpenIntent(alt, "out/index.html"), "real");
  assert.strictEqual(fileOpenIntent(ctrl, "out/index.html"), "browser");
  assert.strictEqual(fileOpenIntent(ctrl, "src/a.ts"), "read");
  assert.strictEqual(fileOpenIntent(plain, "src/a.ts"), "read");
}
console.log("linkHovers: Alt 走真实文件、Ctrl/Cmd+HTML 走浏览器、普通文件 Ctrl 仍只读 ✓");

// ---------- 3. 悬停标题：完整路径 / 完整链接 / 真实文件与浏览器提示 ----------
{
  assert.strictEqual(
    fileLinkHoverTitle("D:/dev/app", "src/index.html", texts, "Alt", "Ctrl"),
    `D:/dev/app/src/index.html\n${texts.openRealFileHint("Alt")}\n${texts.webFileBrowserHint("Ctrl")}`,
  );
  // 绝对路径归一（盘符保留、分隔符统一）；macOS 标签
  assert.strictEqual(
    fileLinkHoverTitle("D:/dev/app", "D:\\dev\\demo\\index.html", texts, "Option", "Cmd"),
    `D:/dev/demo/index.html\n${texts.openRealFileHint("Option")}\n${texts.webFileBrowserHint("Cmd")}`,
  );
  // 普通文件只给路径与真实文件提示，不补浏览器提示
  assert.strictEqual(
    fileLinkHoverTitle("D:/dev/app", "src/a.ts", texts, "Alt", "Ctrl"),
    `D:/dev/app/src/a.ts\n${texts.openRealFileHint("Alt")}`,
  );
  // 没有 cwd 时不猜绝对位置：保留链接上的原样拼写
  assert.strictEqual(
    fileLinkHoverTitle(undefined, "src/index.html", texts, "Alt", "Ctrl"),
    `src/index.html\n${texts.openRealFileHint("Alt")}\n${texts.webFileBrowserHint("Ctrl")}`,
  );
  assert.strictEqual(externalLinkHoverTitle("https://example.com/a"), "https://example.com/a");
}
console.log("linkHovers: 文件链接给完整路径、Alt 真实文件提示（HTML 再加 Ctrl/Cmd 浏览器） ✓");

// ---------- 3b. 作者 title 与完整目标合成到同一个 title 属性 ----------
{
  assert.strictEqual(mergeHoverTitle(null, "D:/a/b.ts"), "D:/a/b.ts");
  assert.strictEqual(mergeHoverTitle(undefined, "D:/a/b.ts"), "D:/a/b.ts");
  assert.strictEqual(mergeHoverTitle("作者写的说明", "D:/a/b.ts"), "作者写的说明\nD:/a/b.ts");
  assert.strictEqual(mergeHoverTitle("D:/a/b.ts", "D:/a/b.ts"), "D:/a/b.ts", "重复的同一条不必叠两遍");
  assert.strictEqual(mergeHoverTitle("只有作者说明", undefined), "只有作者说明");
  assert.strictEqual(mergeHoverTitle(null, undefined), undefined);
  assert.strictEqual(mergeHoverTitle("", "hint"), "hint");
}
console.log("linkHovers: 作者 title 与完整目标合成、空值不编标题 ✓");

// ---------- 4. 接线：宿主白名单与提示文案登记 ----------
{
  const controller = read("src", "dsh", "controller.ts");
  assert.ok(
    /if \(!isBrowserOpenableFile\(stat\.absolutePath\)\)/.test(controller) &&
      /openThroughHost\(client, stat\.absolutePath, "open", sessionId\)/.test(controller),
    "宿主必须用同一份白名单再验一次（webview 帧不可信），并交给 Host 原生打开",
  );
  const messages = read("src", "webview", "messages.ts");
  assert.ok(
    /openRealFileHint: \{\s*\n\s*zh:/.test(messages) &&
      /webFileBrowserHint: \{\s*\n\s*zh:/.test(messages) &&
      /en:/.test(messages),
    "真实文件与浏览器提示必须中英各一条",
  );
}
console.log("linkHovers: 真实文件 / 浏览器分流在宿主侧再验、提示中英登记 ✓");

console.log("\nlinkHovers: all assertions passed");
