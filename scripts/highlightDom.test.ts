/** 官方高亮 → 宿主 span → 生产组件的 DOM 回归；无真实 DSH / 模型 / 远程资源。 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as typeof import("jsdom");
const { build } = require("esbuild") as typeof import("esbuild");
const bundled = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [join(process.cwd(), "scripts", "highlightDomBrowser.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "HighlightDomTests",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://highlight.test.invalid/",
  runScripts: "outside-only",
});
try {
  // jsdom 不提供布局观测；这里只测试着色与文本，不声称验证 diff 响应式宽度。
  dom.window.eval(`
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    Range.prototype.getBoundingClientRect = () => new DOMRect();
  `);
  const result: unknown = await dom.window.eval(`${bundled.outputFiles[0]!.text}\nHighlightDomTests.run()`);
  console.log("highlightDom: 官方高亮、正文 / 工具、选区与身份回归通过", result);
} finally {
  dom.window.close();
}
