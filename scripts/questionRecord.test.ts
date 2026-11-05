/** 已答记录的逐题复看：生产 Message + 真实 DOM 点击，离线且不连接 DSH。 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as typeof import("jsdom");
const { build } = require("esbuild") as typeof import("esbuild");
const bundled = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [join(process.cwd(), "scripts", "questionRecordBrowser.tsx")],
  bundle: true, platform: "browser", format: "iife", globalName: "QuestionRecordTests",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, write: false,
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://question.test.invalid/", runScripts: "outside-only",
});
try {
  dom.window.eval(`
    globalThis.ResizeObserver = class { observe() {} disconnect() {} };
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    globalThis.__questionFrames = [];
    globalThis.acquireVsCodeApi = () => ({ postMessage(frame) { __questionFrames.push(frame); } });
  `);
  const result: unknown = await dom.window.eval(`${bundled.outputFiles[0]!.text}\nQuestionRecordTests.run()`);
  console.log("questionRecord: 已答问卷逐题复看通过", result);
} finally {
  dom.window.close();
}
