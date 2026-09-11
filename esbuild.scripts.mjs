import esbuild from "esbuild";
import { mkdirSync, readdirSync, rmSync } from "node:fs";

/**
 * 开发期脚本的打包（冒烟测试、诊断探针、环境修复）。
 *
 * 产物放在 `build/` 而不是 `dist/`：`dist/` 是随 vsix 发布的内容，
 * 测试与诊断脚本不该混进去。
 *
 * 打包前先清掉旧的 `*.mjs`：`npm test` 用 `build/*.test.mjs` 通配来发现断言，
 * 删掉的测试若留下旧产物会被继续执行，看起来像「测试还在跑但改了没生效」。
 *
 * `ws` 是 CJS 且会动态 require Node 内置模块，ESM 产物需要补一个 require。
 */
const banner = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};

mkdirSync("build", { recursive: true });
for (const name of readdirSync("build")) {
  if (name.endsWith(".mjs")) rmSync(`build/${name}`, { force: true });
}

const entries = {
  "build/smoke.mjs": "scripts/smoke.ts",
  "build/model-switch.mjs": "scripts/modelSwitch.ts",
  "build/dump-settings.mjs": "scripts/dumpSettings.ts",
  "build/panels-probe.mjs": "scripts/panelsProbe.ts",
  "build/schema-debug.mjs": "scripts/schemaDebug.ts",
  "build/probe.mjs": "scripts/probe.ts",
  "build/set-default-model.mjs": "scripts/setDefaultModel.ts",
  "build/queue-esc-e2e.mjs": "scripts/queueEscE2E.ts",
  "build/cookie-survives-restart.mjs": "scripts/cookieSurvivesRestart.ts",
  "build/parse-tool-result.test.mjs": "scripts/parseToolResult.test.ts",
  "build/diff.test.mjs": "scripts/diff.test.ts",
  "build/attachments.test.mjs": "scripts/attachments.test.ts",
  "build/queue-view.test.mjs": "scripts/queueView.test.ts",
  "build/session-cookie.test.mjs": "scripts/sessionCookie.test.ts",
  "build/tool-view.test.mjs": "scripts/toolView.test.ts",
  "build/text-file.test.mjs": "scripts/textFile.test.ts",
  "build/thinking-stream.test.mjs": "scripts/thinkingStream.test.ts",
  "build/injected.test.mjs": "scripts/injected.test.ts",
  "build/unknown-event.test.mjs": "scripts/unknownEvent.test.ts",
  "build/styles.test.mjs": "scripts/styles.test.ts",
  "build/read-range.test.mjs": "scripts/readRange.test.ts",
  "build/segment.test.mjs": "scripts/segment.test.ts",
  "build/path-insert.test.mjs": "scripts/pathInsert.test.ts",
  "build/system-prompt-probe.mjs": "scripts/systemPromptProbe.ts",
  "build/effort-probe.mjs": "scripts/effortProbe.ts",
  "build/read-range-probe.mjs": "scripts/readRangeProbe.ts",
  "build/plan-command-probe.mjs": "scripts/planCommandProbe.ts",
  "build/token-cleanup.test.mjs": "scripts/tokenAndCleanup.test.ts",
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



