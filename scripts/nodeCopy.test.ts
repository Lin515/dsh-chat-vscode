/** 生产节点的复制点击回归；仅 jsdom + 离线桥接，不连接 DSH 或系统剪贴板。 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as typeof import("jsdom");
const { build } = require("esbuild") as typeof import("esbuild");
const bundled = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [join(process.cwd(), "scripts", "nodeCopyBrowser.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "NodeCopyTests",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://copy.test.invalid/",
  runScripts: "outside-only",
});
try {
  dom.window.eval(`
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    globalThis.__copyFrames = [];
    globalThis.acquireVsCodeApi = () => ({ postMessage(frame) { __copyFrames.push(frame); } });
  `);
  const result: unknown = await dom.window.eval(`${bundled.outputFiles[0]!.text}\nNodeCopyTests.run()`);
  console.log("nodeCopy: 节点点击、轮尾末尾正文载荷与冻结渲染通过", result);
} finally {
  dom.window.close();
}
