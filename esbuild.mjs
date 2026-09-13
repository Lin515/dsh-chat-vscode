import esbuild from "esbuild";
import { rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

rmSync("dist", { recursive: true, force: true });

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ["src/webview/main.tsx"],
  outfile: "dist/webview.js",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
  // 根 tsconfig 是给宿主用的（不含 jsx），这里显式指定自动运行时，
  // 否则 esbuild 会退回经典转换并要求 React 全局变量
  jsx: "automatic",
  loader: { ".svg": "dataurl", ".png": "dataurl" },
  define: {
    "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
  },
};

/**
 * supervisor 进程（设计 `docs/design-supervisor.md`）：**随扩展一起分发**，
 * 由扩展用 VS Code 自带的 Node 拉起（`src/dsh/runtimeResolve.ts`）。
 *
 * 固定 CJS + `node20`：运行它的是 VS Code 自带的 Electron-as-Node，
 * 产物不能依赖"某个特定 Electron 版本才有"的语法/API。
 */
/** @type {import('esbuild').BuildOptions} */
const supervisor = {
  entryPoints: ["src/supervisor/main.ts"],
  outfile: "dist/supervisor.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: production ? false : "inline",
  minify: production,
  logLevel: "info",
};

if (watch) {
  const ctxHost = await esbuild.context(host);
  const ctxWeb = await esbuild.context(webview);
  const ctxSupervisor = await esbuild.context(supervisor);
  await Promise.all([ctxHost.watch(), ctxWeb.watch(), ctxSupervisor.watch()]);
  console.log("[dsh-chat] watching for changes...");
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview), esbuild.build(supervisor)]);
  console.log("[dsh-chat] build complete");
}
