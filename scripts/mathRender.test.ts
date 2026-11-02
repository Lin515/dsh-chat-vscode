/**
 * 官方公式适配器的宿主边界与完整 DOM 回归。
 * Node 无 DOM 安全导入；独立 jsdom realm 执行本仓浏览器 bundle，不污染全局，
 * 不请求真实 DSH / 模型、不加载远程资源。布局 / 字体另由真实浏览器验收。
 * 运行：npm test（已登记 esbuild.scripts.mjs）。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { MAX_MATH_TEX_LENGTH, renderMath, type MathRenderSource } from "../src/webview/markdown/mathRender";

const source: MathRenderSource = { form: "inline", closed: true, tex: "x^2", raw: "$x^2$" };
assert.equal(await renderMath(source), undefined, "无 DOM 时不初始化官方适配器");
assert.equal(await renderMath({ ...source, closed: false }), undefined);
assert.equal(await renderMath({ ...source, tex: "x".repeat(MAX_MATH_TEX_LENGTH + 1) }), undefined);

// 运行时 require，避免将 jsdom / esbuild 的 Node 内部资源折入测试 bundle。
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as typeof import("jsdom");
const { build } = require("esbuild") as typeof import("esbuild");
const bundled = await build({
  absWorkingDir: process.cwd(),
  entryPoints: [join(process.cwd(), "scripts", "mathDomBrowser.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  globalName: "MathDomTests",
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  write: false,
});
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "https://math.test.invalid/",
  runScripts: "outside-only",
});
try {
  // jsdom 无 MathMLElement.style；pmb 的 MathML 样式由真实 Chromium 同入口覆盖。
  const result: unknown = await dom.window.eval(`${bundled.outputFiles[0]!.text}\nMathDomTests.run({ mathmlStyles: false })`);
  console.log("mathRender: 无 DOM 边界、官方树对拍与完整 DOM 回归通过", result);
} finally {
  dom.window.close();
}
