import esbuild from "esbuild";

/**
 * 开发期脚本的打包（冒烟测试、诊断探针、环境修复）。
 *
 * 产物放在 `build/` 而不是 `dist/`：`dist/` 是随 vsix 发布的内容，
 * 测试与诊断脚本不该混进去。
 *
 * `ws` 是 CJS 且会动态 require Node 内置模块，ESM 产物需要补一个 require。
 */
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};

const entries = {
  "build/smoke.mjs": "scripts/smoke.ts",
  "build/model-switch.mjs": "scripts/modelSwitch.ts",
  "build/dump-settings.mjs": "scripts/dumpSettings.ts",
  "build/panels-probe.mjs": "scripts/panelsProbe.ts",
  "build/schema-debug.mjs": "scripts/schemaDebug.ts",
  "build/probe.mjs": "scripts/probe.ts",
  "build/set-default-model.mjs": "scripts/setDefaultModel.ts",
};

await Promise.all(
  Object.entries(entries).map(([outfile, entryPoints]) =>
    esbuild.build({
      entryPoints: [entryPoints],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "info",
      banner,
    }),
  ),
);



