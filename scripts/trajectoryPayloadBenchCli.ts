/**
 * 【脚本定位】工具型 · 零 token · **OS 入口薄壳** —— M06 完整载荷量测的 argv / IO / 退出码。
 *
 * 它**只做三件事**：按 argv 决定走哪条路、把结果写到 stdout / stderr、按结果设置退出码。
 * 业务逻辑全在纯模块 [量测核心](<./trajectoryPayloadBench.ts>)（资格闸门 / 整链路分段量测 /
 * 报告）与 [浏览器工件](<./trajectoryPayloadBenchBrowser.ts>)（真浏览器整链路）。
 *
 * 为什么单独一个文件而不是在核心模块里判「是不是被直接运行」：本仓库所有脚本都是 esbuild
 * 打出来的 **bundle**，把核心模块 import 进别的 bundle（测试 / 私有实验）时 `import.meta.url`
 * 与 `process.argv[1]` 都指向那个**入口 bundle**，`import.meta.main` 也恒真——任何「身份猜测」
 * 都会让 CLI 在测试里抢跑。所以核心模块**没有顶层副作用**，入口由构建条目显式指定
 * （`build/trajectory-payload-bench.mjs`）。
 *
 * ## 退出码
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 每份夹具都过闸门并完成量测 / 工件已写出 / 服务器已就绪 |
 * | 2 | 用法与输入问题（未给 `--fixture`、夹具不可读、参数非法、浏览器模式走错入口） |
 * | 3 | 有夹具未过闸门（资格不足、登记不自洽、派生摘要不符、同一路径重复计样）、工件写出失败、`--out` 写失败、服务起不来 |
 *
 * `--out` 与「写工件」是**指定交付物**：写不成就按失败退出（3），不 exit0 + ignored。
 *
 * 用法：
 *   node build/trajectory-payload-bench.mjs --fixture <夹具.json> [--fixture …] [--samples <n>] [--warmup <n>] [--json] [--out <报告.json>] [--expect-derive-sha256 <hex>]
 *   node build/trajectory-payload-bench.mjs --fixture <夹具.json> [--fixture …] --emit-browser <目录> [--expect-derive-sha256 <hex>]
 *   node build/trajectory-payload-bench.mjs --serve-browser <目录> [--port <n>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  BENCH_EXIT,
  benchLines,
  machineReport,
  parseBenchInvocation,
  runBenchCli,
  runMeasure,
} from "./trajectoryPayloadBench";
import {
  BrowserEmitError,
  BrowserServerError,
  browserRefusalText,
  emitBrowserArtifacts,
  serveBrowserArtifacts,
  type BrowserServer,
} from "./trajectoryPayloadBenchBrowser";

/** 统一的失败出口：固定双语两行，**不回显路径或异常原文**。 */
function fail(exitCode: number, zh: string, en: string): never {
  process.stderr.write(`${zh}\n${en}\n`);
  process.exit(exitCode);
}

/** 取一条核心文案并写 stderr，按给定码退出。 */
function failWithKey(exitCode: number, key: Parameters<typeof benchLines>[0], params: Record<string, string | number> = {}): never {
  const [zh, en] = benchLines(key, params);
  return fail(exitCode, zh, en);
}

const argv = process.argv.slice(2);
const invocation = parseBenchInvocation(argv);

if (invocation.kind === "usage" || invocation.kind === "measure") {
  // 用法错误与量测都走纯模块：usage 由 `runBenchCli` 给文案，量测由 `runMeasure` 给报告。
  if (invocation.kind === "usage") {
    const outcome = runBenchCli(argv);
    if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
    if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
    process.exit(outcome.exitCode);
  }
  const { outcome, reports } = runMeasure(invocation.options);
  if (outcome.stdout !== "") process.stdout.write(outcome.stdout);
  if (outcome.stderr !== "") process.stderr.write(outcome.stderr);
  // `--out` 是 IO，属于入口：报告对象由纯模块给出，这里只负责落盘（只在成功时写）。
  // **写不成就是失败**：指定交付文件的失败不能被「忽略」掉。
  if (invocation.options.out !== undefined && outcome.exitCode === BENCH_EXIT.ok) {
    try {
      mkdirSync(dirname(resolve(invocation.options.out)), { recursive: true });
      writeFileSync(
        resolve(invocation.options.out),
        `${JSON.stringify(machineReport(reports, invocation.options), null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      const detail = (error as NodeJS.ErrnoException).code ?? "unknown";
      failWithKey(BENCH_EXIT.refused, "outWriteFailed", { detail });
    }
  }
  process.exit(outcome.exitCode);
}

if (invocation.kind === "emit-browser") {
  if (invocation.fixtures.length === 0) {
    failWithKey(BENCH_EXIT.usage, "fixtureMissing");
  }
  let written: string[] = [];
  try {
    written = await emitBrowserArtifacts(
      invocation.directory,
      invocation.fixtures,
      invocation.expectDeriveSha256 === undefined ? {} : { expectDeriveSha256: invocation.expectDeriveSha256 },
    );
  } catch (error) {
    if (error instanceof BrowserEmitError) {
      switch (error.code) {
        case "no-fixture":
          failWithKey(BENCH_EXIT.usage, "fixtureMissing");
          break;
        case "fixture-unreadable":
          failWithKey(BENCH_EXIT.usage, "emitFixtureUnreadable", { ordinal: error.ordinal ?? 0 });
          break;
        case "duplicate-fixture-path":
          failWithKey(BENCH_EXIT.refused, "emitFixtureDuplicate", { ordinal: error.ordinal ?? 0 });
          break;
        case "not-qualified":
          // 与量测**同一条**拒测文案：同一个闸门，同一套话术。
          process.stderr.write(browserRefusalText(error.refusals));
          process.exit(BENCH_EXIT.refused);
          break;
        case "style-missing":
          failWithKey(BENCH_EXIT.refused, "emitStyleMissing", { detail: error.detail ?? "unknown" });
          break;
        default:
          failWithKey(BENCH_EXIT.refused, "emitInstrumentationFailed", { detail: error.detail ?? "unknown" });
          break;
      }
    }
    fail(BENCH_EXIT.refused, "浏览器工件写出失败。", "Browser artifacts could not be written.");
  }
  process.stdout.write(`已写出浏览器工件 / browser artifacts written: ${written.length}\n`);
  for (const file of written) process.stdout.write(`  ${file}\n`);
  process.exit(BENCH_EXIT.ok);
}

// serve-browser：进程保持存活打印 URL（由运行者用 Ctrl+C 结束）。
let server: BrowserServer | undefined;
try {
  server = await serveBrowserArtifacts(invocation.directory, invocation.port);
} catch (error) {
  if (error instanceof BrowserServerError) {
    failWithKey(BENCH_EXIT.refused, error.code === "bind-failed" ? "serveBindFailed" : "serveNotListening", {
      detail: error.detail,
    });
  }
  failWithKey(BENCH_EXIT.refused, "serveNotListening", { detail: "unknown" });
}
if (server === undefined) failWithKey(BENCH_EXIT.refused, "serveNotListening", { detail: "unknown" });
process.stdout.write(`浏览器工件服务已启动 / browser artifacts server: ${server.url}\n`);
process.stdout.write("结果在 window.__M06__；完成标记 window.__M06_DONE__。按 Ctrl+C 结束。\n");
process.stdout.write("Result: window.__M06__; completion marker: window.__M06_DONE__. Press Ctrl+C to stop.\n");
