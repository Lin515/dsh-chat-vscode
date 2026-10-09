/**
 * `scripts/trajectoryPayloadBench.ts`（纯核心）/ `scripts/trajectoryPayloadBenchCli.ts`（OS 入口）/
 * `scripts/trajectoryPayloadBenchBrowser.ts`（浏览器工件）的**离线回归**。
 *
 * ## 全部材料都是本进程合成的受控材料
 *
 * 夹具在本文件里用**真实折叠层**造：合成事件 → `deriveTrajectoryModel` → `redactTrajectoryModel`
 * → 登记。**不读用户日志、不读 `~/.dsh`、不读 `DSH_HOME`、不连服务、不花 token。**
 * 子进程那几条把 `HOME` / `USERPROFILE` / `DSH_HOME` 一并指向受控根，并在受控根里放一份
 * **诱饵夹具**：工具要是偷偷扫描，诱饵就会出现在结果里——本文件断言它一次都不出现。
 *
 * ## 真实 OS 入口：**本测试自己从源码现场打包**，不依赖共享 `build/`
 *
 * CLI 条目用 esbuild API 打进受控根（与 `esbuild.scripts.mjs` 同一套选项），因此：
 * ①跑的是**当前源码**而不是可能过期的旧产物；②把本测试产物复制到别处跑也照样有牙
 * （仓库根靠向上查找定位）。共享产物存在与否不影响本文件。
 *
 * ## 红在哪里（防线的牙）
 *
 * 1. **资格闸门**：正常载荷绿；降载、`payloadReduced` 谎报为假、缺资格成员、派生摘要不符、
 *    结构计数被改**五种变体全红**（三条资格判据各自独立成立，不是一条链上顺带过）；
 * 2. **emit 复用同一闸门**：不合格载荷 → 退 3 且**零工件**（目录都不建）；pin 不匹配同样拒；
 * 3. **无默认扫描**：不传 `--fixture` 退出 2，且受控 `DSH_HOME` 里的诱饵一份都不参与；
 * 4. **真实 OS 入口**：spawn 现场打出的 CLI，逐条核对退出码 0 / 2 / 3 与「不回显路径」；
 * 5. **`--out` 写失败是失败**：写到目录上必须退 3（旧行为是 exit0 + ignored）；
 * 6. **多夹具逐份**：emit 写出的 `fixture.js` 有 N 份，runner 逐份量测（不是只用 `fixtures[0]`）；
 * 7. **生产样式同字节**：工件里的 `app.css` / `tokens.css` 与仓库当前字节**逐字节相同**，
 *    摘要进见证；页面有 CSS link 与 13px 离线桥；
 * 8. **组件内部打点**：每个锚点在当前生产源码里**恰好命中一次**，原字节 / 变换后字节各留摘要；
 *    变异（锚点不存在 / 出现两次）必须报 0 / 2 命中——打点没折进去不许被当成「已归因」；
 * 9. **服务器**：公布**真实**端口并实连拿到本工件页面；绑失败必须抛出可判定错误、
 *    CLI 退非 0 且给中英两行——实连失败**不静默 skip**。
 * 10. **timer 身份绑定**：节流判据不接受「同 nonce 但 timer id 不同」，也不接受 pair 自带的
 *    `timerIdMatched: true` 标签（伪造标签照样红）；身份缺失（id 为 null、窗口内同 nonce 不唯一）
 *    与「pair 与原始 schedule / fire 事件矛盾」各自点名。合法同 timer、同 nonce 的正例照旧绿。
 *
 * ## 不声称什么
 *
 * 这些断言**不**证明真实夹具可用、**不**证明来源真实（登记自洽不是认证）、
 * **不**等于浏览器整链路已跑过：浏览器里的实际量测由主代理在真浏览器里跑一次，
 * 结果以页面上的 `window.__M06__.status` / `checks[]` 为准。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import type { SessionWireEvent } from "../src/dsh/protocol";
import {
  BENCH_EXIT,
  CHAIN_STAGES,
  BENCH_MESSAGES,
  benchLines,
  machineReport,
  measureFixturePayload,
  parseBenchArgs,
  parseBenchInvocation,
  qualifyFixturePayload,
  runBenchCli,
  runMeasure,
  sha256Hex,
  summarizeSamples,
} from "./trajectoryPayloadBench";
import {
  INSTRUMENTATION_POINTS,
  PRODUCTION_STYLE_SOURCES,
  BrowserEmitError,
  BrowserServerError,
  emitBrowserArtifacts,
  instrumentSource,
  resolveServedFile,
  serveBrowserArtifacts,
  compileProbeWindowVerdict,
  compileScrollWindowVerdict,
  PROBE_RUNTIME_SOURCE,
  PROBE_WINDOW_VERDICT_SOURCE,
} from "./trajectoryPayloadBenchBrowser";
import {
  DEFAULT_FIELD_LIMIT,
  FIXTURE_INVARIANT_CODES,
  FIXTURE_REDACTION_VERSION,
  canonicalJson,
  capabilitiesOf,
  checkFixtureInvariants,
  redactTrajectoryModel,
  structureOf,
} from "./trajectoryFixture";

/**
 * 仓库根：从产物所在目录向上找到同时含 `package.json` 与 `src/dsh/trajectory.ts` 的那一级。
 * 这样写是为了产物被复制到别处（例如实施者的私有验证目录）时仍指向同一个仓库。
 */
function findRepo(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src", "dsh", "trajectory.ts"))) return dir;
    const parent = dirname(dir);
    assert.notStrictEqual(parent, dir, "找不到仓库根（缺少 package.json / src/dsh/trajectory.ts）");
    dir = parent;
  }
}

const REPO = findRepo(dirname(fileURLToPath(import.meta.url)));
const CLI_ENTRY = join(REPO, "scripts", "trajectoryPayloadBenchCli.ts");
const BANNER = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};
/** 运行期用 CJS `require` 取 esbuild：不让它被折进本测试产物（esbuild 的 JS API 依赖自身
 *  文件位置定位二进制，折进 bundle 会失效）。类型仍走 `import type`。 */
const esbuild = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");

// ── 受控根：一切落盘都在这一个 mkdtemp 里，跑完删掉 ────────────────────────
const tmpRoot = mkdtempSync(join(tmpdir(), "m06-payload-bench-"));
const CONTROLLED = resolve(tmpRoot);
const FIXTURES = join(CONTROLLED, "fixtures");
const DECOY_HOME = join(CONTROLLED, "home");
const DECOY_FIXTURE = join(DECOY_HOME, ".dsh", "sessions", "decoy-ws", "decoy-session.json");
const BROWSER_DIR = join(CONTROLLED, "browser");
mkdirSync(FIXTURES, { recursive: true });
mkdirSync(dirname(DECOY_FIXTURE), { recursive: true });

/** 现场打出的 CLI 产物（受控根内；不碰共享 `build/`）。 */
const CLI = join(CONTROLLED, "trajectory-payload-bench.mjs");
const PRODUCTION_SOURCES = [
  "src/dsh/trajectory.ts",
  "src/webview/components/Trajectory.tsx",
  "src/webview/trajectoryLedgerRows.ts",
  "src/webview/trajectoryVirtual.ts",
  "src/webview/trajectoryTimeline.ts",
  "src/vendor/ui-trajectory/trajectory-search-index.ts",
  "src/shared/trajectory.ts",
  "scripts/trajectoryPayloadBench.ts",
  "scripts/trajectoryPayloadBenchBrowser.ts",
] as const;

const sha256File = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const hashAll = (): Record<string, string> =>
  Object.fromEntries(PRODUCTION_SOURCES.map((file) => [file, sha256File(join(REPO, file))]));

/** 受控根内的合成夹具路径。 */
const fixturePath = (name: string): string => join(FIXTURES, `${name}.json`);

// ── 合成夹具：真折叠 + 真脱敏 + 真登记 ─────────────────────────────────────
const BASE = Date.UTC(2026, 9, 9, 0, 0, 0);

let seq = 0;
function event(type: string, offsetMs: number, data: Record<string, unknown>): SessionWireEvent {
  seq += 1;
  return { type, seq: seq - 1, time: BASE + offsetMs, data } as SessionWireEvent;
}

/** 形态齐全的合成会话：多轮、system 更新、工具调用与结果、工具目录变更。 */
function synthesizeEvents(turns: number, toolsPerTurn: number): SessionWireEvent[] {
  const events: SessionWireEvent[] = [];
  events.push(event("request/header", 0, {
    header: {
      config: { provider: "provider-a", model: "model-a" },
      tools: [{ name: "Read", description: "读取文件", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    },
    reason: { kind: "initial" },
  }));
  let clock = 1000;
  for (let turn = 1; turn <= turns; turn += 1) {
    events.push(event("turn/start", (clock += 100), { turn }));
    events.push(event("step/start", (clock += 100), { turn, step: 1 }));
    events.push(event("user/message", (clock += 100), {
      id: `u${turn}`, role: "user", source: { kind: "user" },
      content: [{ type: "text", text: `合成问题 ${turn}：请检查第 ${turn} 个模块。` }],
    }));
    const blocks: unknown[] = [
      { type: "reasoning", text: `合成思考 ${turn}：先看目录结构，再定位到具体文件，逐段核对。`.repeat(3) },
    ];
    for (let tool = 1; tool <= toolsPerTurn; tool += 1) {
      blocks.push({
        type: "tool-call",
        id: `call_${turn}_${tool}`,
        name: tool % 2 === 0 ? "Read" : "Grep",
        arguments: JSON.stringify({ path: `src/mod${turn}.ts`, line: tool }),
      });
    }
    blocks.push({ type: "text", text: `合成回答 ${turn}：已完成核对，结论见下。`.repeat(2) });
    events.push(event("assistant/message", (clock += 200), {
      turn, step: 1,
      message: { id: `a${turn}`, role: "assistant", source: { provider: "provider-a", model: "model-a" }, content: blocks },
      stream: [{ time: BASE + clock - 100, text: "合" }],
      usage: { inputTokens: 100 * turn, cacheReadTokens: 10, outputTokens: 20 * turn, reasoningTokens: 5 },
    }));
    for (let tool = 1; tool <= toolsPerTurn; tool += 1) {
      events.push(event("tool/call", (clock += 50), {
        turn, step: 1, callId: `call_${turn}_${tool}`,
        name: tool % 2 === 0 ? "Read" : "Grep",
        arguments: JSON.stringify({ path: `src/mod${turn}.ts` }),
      }));
      events.push(event("tool/result", (clock += 50), {
        turn, step: 1, callId: `call_${turn}_${tool}`,
        message: { role: "tool", content: [{ type: "text", text: `合成结果 ${turn}/${tool}：` + "匹配行内容。".repeat(20) }] },
      }));
    }
    events.push(event("turn/end", (clock += 100), { turn, reason: { kind: "completed" } }));
    if (turn % 3 === 0) {
      events.push(event("system/message", (clock += 100), {
        source: { kind: "system" },
        message: {
          id: `s${turn}`, role: "system", source: { kind: "system" },
          content: [{ type: "text", text: `合成系统提示词 v${turn}：` + "规则条目。".repeat(40) }],
        },
      }));
      events.push(event("request/header", (clock += 50), {
        header: {
          config: { provider: "provider-a", model: "model-a" },
          tools: [{ name: "Read", description: "读取文件", parameters: { type: "object" } }],
        },
        reason: { kind: "system" },
      }));
    }
  }
  return events;
}

/** 由事件流造一份完整、自洽、未截断的夹具载荷。 */
function buildPayload(name: string, events: readonly SessionWireEvent[], fieldLimit = DEFAULT_FIELD_LIMIT): Record<string, unknown> {
  const model = deriveTrajectoryModel(events, false);
  assert.ok(model.turns.length > 0, "合成事件必须折出轮次");
  const { model: redacted, stats, timeShiftMs } = redactTrajectoryModel(model, { fieldLimit });
  const structure = structureOf(redacted);
  const payloadReduced = Object.keys(stats.truncated).length > 0;
  assert.deepStrictEqual(
    checkFixtureInvariants(redacted, { fieldLimit, payloadReduced, truncatedFields: stats.truncated }),
    [],
    "合成夹具必须通过结构不变量",
  );
  return {
    provenance: {
      fixture: name,
      sourceSha256: sha256Hex("synthetic-source-bytes"),
      sourceFormat: "v4",
      sourceEventCounts: { "turn/start": 1 },
      sourceBytes: 4096,
      redaction: { version: FIXTURE_REDACTION_VERSION, rules: ["text:pseudotext-equal-length"], stats, timeShiftMs, fieldLimit },
      extractor: { file: "scripts/trajectoryFixtureBuild.ts", sha256: sha256Hex("extractor-source") },
      derive: { file: "src/dsh/trajectory.ts", sha256: sha256Hex("derive-source") },
      structure,
      capabilities: capabilitiesOf(redacted),
      seqMapping: { retainedIn: "cell.seq", count: structure.seqCount, range: structure.seqRange },
      modelSha256: sha256Hex(canonicalJson(redacted)),
      truncatedFields: stats.truncated,
      payloadReduced,
      payloadMeasurementEligible: !payloadReduced,
      invariants: { checks: [...FIXTURE_INVARIANT_CODES], issues: [] },
      generatedBy: "scripts/trajectoryPayloadBench.test.ts",
    },
    model: redacted,
  };
}

function writePayload(name: string, payload: unknown): string {
  const file = fixturePath(name);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

const payloadSmall = buildPayload("bench-small", synthesizeEvents(2, 1));
const payloadLarge = buildPayload("bench-large", synthesizeEvents(9, 2));
const payloadReduced = buildPayload("bench-reduced", synthesizeEvents(9, 2), 40);
const smallFile = writePayload("bench-small", payloadSmall);
const largeFile = writePayload("bench-large", payloadLarge);
const reducedFile = writePayload("bench-reduced", payloadReduced);
/** 诱饵：只有真的去扫受控 `DSH_HOME` 才会被看到。 */
writeFileSync(DECOY_FIXTURE, `${JSON.stringify({ provenance: { fixture: "decoy-never-scanned" }, model: { turns: [] } })}\n`, "utf8");

const before = hashAll();
let failed = false;

try {
  // ── 0. 现场打出受控 CLI（同一套 esbuild 选项；不碰共享 build/） ──────────
  {
    assert.ok(existsSync(CLI_ENTRY), `找不到 CLI 入口：${CLI_ENTRY}`);
    await esbuild.build({
      entryPoints: [CLI_ENTRY],
      outfile: CLI,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      logLevel: "silent",
      banner: BANNER,
      alias: { vscode: join(REPO, "scripts", "vscodeTestStub.ts") },
      jsx: "automatic",
      absWorkingDir: REPO,
    });
    assert.ok(existsSync(CLI), "现场打包必须产出 CLI");
    console.log(`[fixture] 受控 CLI 现场打出：${statSync(CLI).size}B sha256=${sha256File(CLI).slice(0, 16)}…`);
  }

  // ── 1. 文案两套齐全 ────────────────────────────────────────────────────
  {
    for (const [key, entry] of Object.entries(BENCH_MESSAGES)) {
      const { zh, en } = entry as { zh: string; en: string };
      assert.ok(zh.length > 0 && en.length > 0, `${key} 必须中英两套都有`);
      assert.match(zh, /[\u4e00-\u9fff]/, `${key} 的中文必须含中文`);
      assert.strictEqual(/[\u4e00-\u9fff]/.test(en), false, `${key} 的英文不得含中文`);
    }
    const [zh, en] = benchLines("measured", { fixtures: 2, samples: 11 });
    assert.ok(zh.includes("2") && en.includes("2"), "占位必须被替换");
  }

  // ── 2. 参数面：默认值 / 重复 --fixture / 非法参数 / 浏览器模式 ──────────
  {
    const defaults = parseBenchArgs([]);
    assert.ok(defaults.ok, "空参数只给默认值");
    assert.deepStrictEqual(defaults.options.fixtures, [], "默认没有夹具（不做默认扫描）");
    assert.strictEqual(defaults.options.samples, 11);
    assert.strictEqual(defaults.options.warmup, 2);

    const repeated = parseBenchArgs(["--fixture", "a.json", "--fixture", "b.json", "--samples", "21", "--warmup", "3", "--json"]);
    assert.ok(repeated.ok && repeated.options.fixtures.length === 2 && repeated.options.samples === 21 && repeated.options.warmup === 3 && repeated.options.json);

    for (const bad of [["--samples", "10"], ["--samples", "x"], ["--samples"], ["--warmup", "1"], ["--warmup"], ["--expect-derive-sha256", "ZZ"], ["--expect-derive-sha256"], ["--nope"], ["--emit-browser"]]) {
      const parsed = parseBenchArgs(bad);
      assert.strictEqual(parsed.ok, false, `非法参数必须被拒：${bad.join(" ")}`);
      assert.notStrictEqual(parsed.ok === false && parsed.error.key, "usage", "非法参数不是 --help 那一路");
    }
    assert.strictEqual(parseBenchArgs(["--help"]).ok, false, "--help 走用法出口");

    // 浏览器两种模式互斥，且都不在量测路径上。
    const both = parseBenchInvocation(["--emit-browser", "d", "--serve-browser", "d"]);
    assert.strictEqual(both.kind, "usage", "两种浏览器模式同时给必须是用法错误");
    const emit = parseBenchInvocation(["--emit-browser", BROWSER_DIR, "--fixture", smallFile]);
    assert.deepStrictEqual(emit, { kind: "emit-browser", directory: BROWSER_DIR, fixtures: [smallFile] });
    const serve = parseBenchInvocation(["--serve-browser", BROWSER_DIR]);
    assert.deepStrictEqual(serve, { kind: "serve-browser", directory: BROWSER_DIR, port: 0 });
    // 纯模块不执行浏览器模式，但**要如实说**由入口处理。
    const browserOutcome = runBenchCli(["--emit-browser", BROWSER_DIR, "--fixture", smallFile]);
    assert.strictEqual(browserOutcome.exitCode, BENCH_EXIT.usage);
    assert.ok(browserOutcome.stderr.includes("OS 入口") && browserOutcome.stderr.includes("OS entry"), "必须说清由入口处理");

    // emit 模式必须**留住** pin（旧实现悄悄丢过）；不适用于该模式的开关要明确拒。
    const pin = "a".repeat(64);
    const emitPinned = parseBenchInvocation(["--emit-browser", BROWSER_DIR, "--fixture", smallFile, "--expect-derive-sha256", pin]);
    assert.strictEqual(emitPinned.kind, "emit-browser");
    assert.strictEqual(emitPinned.kind === "emit-browser" ? emitPinned.expectDeriveSha256 : undefined, pin, "emit 必须带上显式 pin");
    const emitWithPort = parseBenchInvocation(["--emit-browser", BROWSER_DIR, "--fixture", smallFile, "--port", "8080"]);
    assert.deepStrictEqual(emitWithPort, { kind: "usage", error: { key: "portNotApplicable", params: {} } }, "--port 对 emit 无意义，必须拒");
    const serveWithPin = parseBenchInvocation(["--serve-browser", BROWSER_DIR, "--expect-derive-sha256", pin]);
    assert.deepStrictEqual(serveWithPin, { kind: "usage", error: { key: "deriveShaNotApplicable", params: {} } }, "serve 不读夹具，pin 必须拒");
  }

  // ── 3. 资格闸门：一绿五红（每条判据各自独立） ──────────────────────────
  {
    const ok = qualifyFixturePayload(payloadLarge, {});
    assert.strictEqual(ok.eligible, true, `正常载荷必须可测：${JSON.stringify(ok.reasons)}`);
    assert.strictEqual(ok.registrationIssues, "");
    assert.strictEqual(ok.derivePinned, false, "默认不钉 derive 摘要");

    const reduced = qualifyFixturePayload(payloadReduced, {});
    assert.strictEqual(reduced.eligible, false, "降载载荷必须被拒");
    assert.deepStrictEqual(
      reduced.reasons.map((reason) => reason.code),
      ["payload-reduced", "not-measurement-eligible", "truncated-fields-not-empty"],
      "降载三处必须各自报出",
    );

    // 变体 1：谎报 payloadReduced=false —— 独立判据仍要拦住。
    const liar = JSON.parse(JSON.stringify(payloadReduced)) as { provenance: Record<string, unknown> };
    liar.provenance.payloadReduced = false;
    liar.provenance.payloadMeasurementEligible = true;
    const liarResult = qualifyFixturePayload(liar, {});
    assert.strictEqual(liarResult.eligible, false, "谎报未降载也必须被拒");
    assert.ok(liarResult.reasons.some((reason) => reason.code === "truncated-fields-not-empty"), "非空 truncatedFields 是独立判据");
    assert.ok(liarResult.reasons.some((reason) => reason.code === "registration-invalid"), "登记互反也要报出");

    // 变体 2：缺资格成员 —— 登记校验必须报缺成员，而不是当「没声明」放行。
    const stripped = JSON.parse(JSON.stringify(payloadLarge)) as { provenance: Record<string, unknown> };
    delete stripped.provenance.payloadMeasurementEligible;
    const strippedResult = qualifyFixturePayload(stripped, {});
    assert.strictEqual(strippedResult.eligible, false, "缺资格成员必须被拒");
    assert.ok(strippedResult.registrationIssues.includes("provenance.missing:"), `缺成员要在登记校验里点名：${strippedResult.registrationIssues}`);

    // 变体 3：显式钉 derive 摘要不符。
    const pinned = qualifyFixturePayload(payloadLarge, { expectDeriveSha256: "0".repeat(64) });
    assert.strictEqual(pinned.eligible, false);
    assert.strictEqual(pinned.derivePinned, true);
    assert.deepStrictEqual(pinned.reasons.map((reason) => reason.code), ["derive-sha-mismatch"]);
    const pinnedOk = qualifyFixturePayload(payloadLarge, {
      expectDeriveSha256: (payloadLarge.provenance as { derive: { sha256: string } }).derive.sha256,
    });
    assert.strictEqual(pinnedOk.eligible, true, "摘要相符时必须放行");

    // 变体 4：结构计数被改（登记不自洽）。
    const tampered = JSON.parse(JSON.stringify(payloadLarge)) as { provenance: { structure: { cells: number } } };
    tampered.provenance.structure.cells += 1;
    const tamperedResult = qualifyFixturePayload(tampered, {});
    assert.strictEqual(tamperedResult.eligible, false, "结构计数被改必须被拒");
    assert.ok(tamperedResult.reasons.some((reason) => reason.code === "registration-invalid"));

    // 变体 5：模型被改（modelSha256 对不上）。
    const modelTampered = JSON.parse(JSON.stringify(payloadLarge)) as { model: { cellCount: number } };
    modelTampered.model.cellCount += 1;
    const modelResult = qualifyFixturePayload(modelTampered, {});
    assert.strictEqual(modelResult.eligible, false, "模型被改必须被拒");
    assert.ok(modelResult.registrationIssues.includes("model-sha256-mismatch"), `要报模型摘要不符：${modelResult.registrationIssues}`);
  }

  // ── 4. 量测：顺序执行基准与重复实验分开、raw 样本整组保留、性质标注 ──────
  {
    const read = JSON.parse(readFileSync(largeFile, "utf8")) as unknown;
    const report = measureFixturePayload({ payload: read, file: largeFile }, { samples: 11, warmup: 2 });
    assert.strictEqual(report.eligible, true);
    assert.strictEqual(report.samples, 11);
    assert.strictEqual(report.warmup, 2);
    assert.match(report.fingerprint, /^[0-9a-f]{16}$/);
    assert.strictEqual(report.fixture, "bench-large");
    assert.ok(report.fixtureBytes > 0 && report.fixtureSha256.length === 64);

    // 执行序列必须与清单一致（子集且保序）——它证明的是**本基准自己的顺序**。
    const declared = CHAIN_STAGES.map((stage) => stage.stage);
    assert.deepStrictEqual(report.executionOrder.slice(0, declared.length), declared, "executionOrder 必须是清单顺序");
    assert.strictEqual(report.executionOrder.includes("fixture.read"), true, "给了 file 就要计读盘");

    // 顺序执行的两份各含每一段原值。
    for (const pass of [report.orderedPass.cold, report.orderedPass.warm]) {
      assert.ok(pass.totalMs >= 0);
      for (const stage of declared) {
        assert.strictEqual(typeof pass.stagesMs[stage], "number", `orderedPass 缺段：${stage}`);
        assert.ok(Number.isFinite(pass.stagesMs[stage] as number));
      }
    }

    // isolated：每段 11 份 raw 样本，分布自洽，性质与互斥标注齐全。
    assert.strictEqual(report.isolated.length, CHAIN_STAGES.length);
    for (const stage of report.isolated) {
      assert.strictEqual(stage.samplesMs.length, 11, `${stage.stage} 必须有 11 份原值`);
      assert.ok(stage.samplesMs.every((value) => Number.isFinite(value) && value >= 0));
      assert.ok(stage.minMs <= stage.medianMs && stage.medianMs <= stage.maxMs, `${stage.stage} 分布必须自洽`);
      assert.strictEqual(stage.p95Ms, stage.maxMs, "n=11 时最近秩 p95 就是 max（文件头写明的定义）");
      assert.ok(["real-io", "real-function", "synthetic-lower-bound", "static-count"].includes(stage.kind), `${stage.stage} 必须标性质`);
    }
    const foldStage = report.isolated.find((stage) => stage.stage === "fold.rebuild");
    assert.strictEqual(foldStage?.kind, "synthetic-lower-bound", "反推折叠必须标成合成下限");
    assert.strictEqual(report.products.foldKind, "synthetic-lower-bound");
    const mutuallyExclusive = report.isolated.filter((stage) => stage.branch === "mutually-exclusive-alternative").map((stage) => stage.stage);
    assert.ok(mutuallyExclusive.includes("ledger.rows.collapsed") && mutuallyExclusive.includes("timeline.duration"), `互斥分支要标出来：${mutuallyExclusive.join(",")}`);

    // 产物一致性：两份时间线模式的条数必须相等，否则就是投影漏记录。
    assert.strictEqual(report.products.timelineSpans, report.products.timelineDurationSpans);
    assert.ok(report.products.ledgerRows > 0 && report.products.searchEntries > 0);
    assert.ok(report.products.allocationElements >= report.products.ledgerRows * 3);
    assert.ok(report.products.foldCells > 0, "重建折叠必须折出记录");

    // 措辞：不许再把顺序执行说成「产品实际顺序」。
    const notes = report.notes.join("\n");
    assert.ok(notes.includes("不是产品一次实际请求的顺序"), "必须写明顺序执行不是产品实际顺序");
    assert.ok(notes.includes("合成下限"), "必须写明反推折叠是合成下限");
  }

  // ── 5. 指纹：区分载荷、同载荷可复现 ────────────────────────────────────
  {
    const readSmall = JSON.parse(readFileSync(smallFile, "utf8")) as unknown;
    const readLarge = JSON.parse(readFileSync(largeFile, "utf8")) as unknown;
    const a = measureFixturePayload({ payload: readSmall }, { samples: 11, warmup: 2 });
    const b = measureFixturePayload({ payload: readLarge }, { samples: 11, warmup: 2 });
    const bAgain = measureFixturePayload({ payload: readLarge }, { samples: 11, warmup: 2 });
    assert.notStrictEqual(a.fingerprint, b.fingerprint, "不同载荷的指纹必须不同");
    assert.strictEqual(b.fingerprint, bAgain.fingerprint, "同一份载荷两次量测指纹必须一致");
    assert.deepStrictEqual(b.products, bAgain.products, "同一份载荷两次量测产物必须逐字一致");
    // 没有 file 时不伪造读盘段。
    assert.strictEqual(a.executionOrder.includes("fixture.read"), false, "没给 file 就不该有读盘段");
  }

  // ── 6. 计时器自测：注入时间源必须真的被读到 ────────────────────────────
  {
    const summary = summarizeSamples("synthetic", "real-function", "always", "注入时间源", [5.5, 1.25, 9.75, 3, 7, 2, 8, 4, 6, 10, 0.5]);
    assert.deepStrictEqual(summary.samplesMs, [5.5, 1.25, 9.75, 3, 7, 2, 8, 4, 6, 10, 0.5], "raw 样本必须按采集顺序整组保留");
    assert.strictEqual(summary.minMs, 0.5);
    assert.strictEqual(summary.maxMs, 10);
    assert.strictEqual(summary.medianMs, 5.5);
    assert.strictEqual(summary.p95Ms, 10);
    // 对抗变异：恒零时间源下分布必须全零（证明读数来自时间源，不是预置常量）。
    const zero = summarizeSamples("synthetic", "real-function", "always", "恒零", [0, 0, 0]);
    assert.deepStrictEqual([zero.minMs, zero.medianMs, zero.p95Ms, zero.maxMs], [0, 0, 0, 0]);
    // 注入一个可预测的时间源：分两跳 1ms / 3ms。
    let tick = 0;
    const injected = (): number => (tick += 1) % 2 === 0 ? 4 : 1;
    const read = JSON.parse(readFileSync(smallFile, "utf8")) as unknown;
    const report = measureFixturePayload({ payload: read }, { samples: 11, warmup: 2, now: injected });
    assert.strictEqual(report.orderedPass.cold.totalMs > 0, true, "注入时间源必须被真的读到");
    assert.ok(report.isolated.every((stage) => stage.samplesMs.every((value) => value === 3)), "注入源每段都必须报 3ms");
  }

  // ── 7. CLI 面（纯函数）：无默认扫描 / 缺夹具 / 降载 / 重复 / 不回显路径 ──
  {
    const missing = runBenchCli([]);
    assert.strictEqual(missing.exitCode, BENCH_EXIT.usage, "没给 --fixture 退出 2");
    assert.ok(missing.stderr.includes("不做默认扫描") && missing.stderr.includes("never scans by default"));
    assert.strictEqual(missing.stdout, "", "失败不写 stdout");

    const unknown = runBenchCli(["--fixture", smallFile, "--totally-unknown", join(CONTROLLED, "secret-shape.json")]);
    assert.strictEqual(unknown.exitCode, BENCH_EXIT.usage);
    assert.strictEqual(unknown.stderr.includes("secret-shape"), false, "未知参数的**值**不得回显");

    const unreadable = runBenchCli(["--fixture", join(FIXTURES, "nope.json")]);
    assert.strictEqual(unreadable.exitCode, BENCH_EXIT.usage);
    assert.strictEqual(unreadable.stderr.includes(CONTROLLED), false, "失败输出不得回显本机路径");

    const reduced = runBenchCli(["--fixture", reducedFile]);
    assert.strictEqual(reduced.exitCode, BENCH_EXIT.refused, "降载夹具退出 3");
    assert.ok(reduced.stderr.includes("payloadReduced") && reduced.stderr.includes("truncatedFields"), "降载拒绝要说明资格");

    const duplicate = runBenchCli(["--fixture", smallFile, "--fixture", smallFile]);
    assert.strictEqual(duplicate.exitCode, BENCH_EXIT.refused, "同一路径重复必须拒绝");

    const measured = runMeasure({ fixtures: [smallFile, largeFile], samples: 11, warmup: 2, json: true });
    assert.strictEqual(measured.outcome.exitCode, BENCH_EXIT.ok);
    assert.strictEqual(measured.reports.length, 2);
    assert.ok(measured.outcome.stdout.includes("fixture: bench-small"));
    assert.ok(measured.outcome.stdout.includes("repeated-consumption experiment"), "必须如实标注重复消费实验");
    assert.ok(measured.outcome.stdout.includes("NOT one real product request"), "执行顺序必须标注不是产品实际顺序");
    assert.ok(measured.outcome.stdout.includes("static allocation count (NOT React allocation)"), "静态计数不得说成 React 分配");
    const machine = machineReport(measured.reports, { fixtures: [smallFile, largeFile], samples: 11, warmup: 2, json: true });
    assert.strictEqual(machine.tool, "trajectory-payload-bench");
    assert.strictEqual(machine.fixtures.length, 2);
    assert.ok(machine.p95Definition.includes("nearest-rank"));
    assert.strictEqual(JSON.stringify(machine).includes(CONTROLLED.replace(/\\/g, "\\\\")), false, "机器报告里不得出现本机绝对路径");
  }

  // ── 8. 真实 OS 入口子进程：受控 HOME / DSH_HOME，诱饵不得出现 ───────────
  {
    const runCli = (args: readonly string[]): { code: number; output: string } => {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        cwd: REPO,
        timeout: 120_000,
        env: { ...process.env, HOME: DECOY_HOME, USERPROFILE: DECOY_HOME, DSH_HOME: DECOY_HOME },
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      assert.ok(typeof result.status === "number", `子进程必须有退出码：${output.slice(0, 300)}`);
      return { code: result.status as number, output };
    };

    const noFixture = runCli([]);
    assert.strictEqual(noFixture.code, BENCH_EXIT.usage, "真实入口：没给夹具退出 2");
    assert.strictEqual(noFixture.output.includes("decoy"), false, "不得扫到受控 HOME 里的诱饵");

    const okRun = runCli(["--fixture", smallFile, "--json"]);
    assert.strictEqual(okRun.code, BENCH_EXIT.ok, `真实入口量测必须成功：${okRun.output.slice(0, 400)}`);
    assert.ok(okRun.output.includes("fixture: bench-small"));
    assert.strictEqual(okRun.output.includes(DECOY_HOME), false, "输出不得回显受控 HOME");
    assert.strictEqual(okRun.output.includes(CONTROLLED), false, "输出不得回显受控根");

    const reducedRun = runCli(["--fixture", reducedFile]);
    assert.strictEqual(reducedRun.code, BENCH_EXIT.refused, "真实入口：降载夹具退出 3");

    const pinnedRun = runCli(["--fixture", smallFile, "--expect-derive-sha256", "0".repeat(64)]);
    assert.strictEqual(pinnedRun.code, BENCH_EXIT.refused, "真实入口：摘要不符退出 3");

    const outFile = join(CONTROLLED, "report.json");
    const outRun = runCli(["--fixture", smallFile, "--out", outFile]);
    assert.strictEqual(outRun.code, BENCH_EXIT.ok);
    const written = JSON.parse(readFileSync(outFile, "utf8")) as { tool: string; fixtures: { fixture: string }[] };
    assert.strictEqual(written.tool, "trajectory-payload-bench");
    assert.strictEqual(written.fixtures[0]?.fixture, "bench-small");

    // `--out` 写不成（目标是个目录）：**必须按失败退**，不许 exit0 + ignored。
    const outAsDirectory = join(CONTROLLED, "out-is-a-directory");
    mkdirSync(outAsDirectory, { recursive: true });
    const outFailRun = runCli(["--fixture", smallFile, "--out", outAsDirectory]);
    assert.strictEqual(outFailRun.code, BENCH_EXIT.refused, "指定交付文件写失败必须退 3");
    assert.ok(outFailRun.output.includes("指定交付文件的失败就是失败") && outFailRun.output.includes("A requested deliverable that fails is a failure"));
    assert.strictEqual(outFailRun.output.includes(outAsDirectory), false, "失败输出不得回显本机路径");
  }

  // ── 9. emit 复用同一闸门：不合格 → 退 3 且零工件 ───────────────────────
  {
    const refusedDir = join(CONTROLLED, "emit-refused");
    const run = spawnSync(process.execPath, [CLI, "--fixture", reducedFile, "--emit-browser", refusedDir], {
      encoding: "utf8",
      cwd: REPO,
      timeout: 120_000,
      env: { ...process.env, HOME: DECOY_HOME, USERPROFILE: DECOY_HOME, DSH_HOME: DECOY_HOME },
    });
    assert.strictEqual(run.status, BENCH_EXIT.refused, `emit 必须与 Node 闸门同判：${(run.stderr ?? "").slice(0, 300)}`);
    assert.strictEqual(existsSync(refusedDir), false, "拒绝时**零工件**（连目录都不该建）");
    assert.ok((run.stderr ?? "").includes("payloadReduced") && (run.stderr ?? "").includes("truncatedFields"), "emit 拒绝要给与量测同一套资格文案");

    // pin 不匹配同样拒（emit 真的读了 pin，不是收下就丢）。
    const pinDir = join(CONTROLLED, "emit-pin");
    const pinRun = spawnSync(process.execPath, [CLI, "--fixture", smallFile, "--emit-browser", pinDir, "--expect-derive-sha256", "0".repeat(64)], {
      encoding: "utf8",
      cwd: REPO,
      timeout: 120_000,
    });
    assert.strictEqual(pinRun.status, BENCH_EXIT.refused, "emit：pin 不匹配必须退 3");
    assert.strictEqual(existsSync(pinDir), false, "pin 不匹配同样零工件");

    // 模块层：拒测错误带规则码，且不带路径。
    await assert.rejects(
      () => emitBrowserArtifacts(join(CONTROLLED, "emit-refused-module"), [reducedFile]),
      (error: unknown) => error instanceof BrowserEmitError && error.code === "not-qualified" && error.refusals.length > 0,
      "模块层也要拒",
    );
  }

  // ── 10. 浏览器工件：多夹具逐份 / 生产样式同字节 / 打点见证 ──────────────
  {
    const written = await emitBrowserArtifacts(BROWSER_DIR, [smallFile, largeFile]);
    for (const required of ["index.html", "fixture.js", "runner.src.js", "runner.js", "README.txt", "browser-witness.json", "tokens.css", "app.css", "vscode-bridge.css"]) {
      assert.ok(written.some((file) => file.endsWith(required)), `工件缺 ${required}`);
      assert.ok(existsSync(join(BROWSER_DIR, required)), `工件缺 ${required}`);
    }
    // 页面只加载两个脚本 + 三份样式，且都指向工件目录内的文件（无外链）。
    const html = readFileSync(join(BROWSER_DIR, "index.html"), "utf8");
    assert.ok(html.includes("./fixture.js") && html.includes("./runner.js"));
    assert.ok(html.includes('./tokens.css') && html.includes('./app.css') && html.includes('./vscode-bridge.css'), "必须载入生产样式与离线桥");
    assert.strictEqual(/https?:\/\//.test(html), false, "页面不得引外链");
    // 夹具以普通脚本内联（避免 fetch / CORS 面），且确实是脱敏载荷；**多份**都要在。
    const fixtureJs = readFileSync(join(BROWSER_DIR, "fixture.js"), "utf8");
    assert.ok(fixtureJs.startsWith("window.__FIXTURES__ = "));
    assert.ok(fixtureJs.includes("payloadMeasurementEligible"));
    const entries = JSON.parse(fixtureJs.slice("window.__FIXTURES__ = ".length).trim().replace(/;$/, "")) as { name: string }[];
    assert.deepStrictEqual(entries.map((entry) => entry.name), ["bench-small", "bench-large"], "两份夹具都要写进 fixture.js");
    assert.strictEqual(fixtureJs.includes(CONTROLLED), false, "工件不得内嵌受控根路径");

    // 生产样式**同字节**：复制品摘要 = 仓当前字节摘要。
    for (const source of PRODUCTION_STYLE_SOURCES) {
      const name = source.split("/").pop() as string;
      assert.strictEqual(sha256File(join(BROWSER_DIR, name)), sha256File(join(REPO, source)), `${name} 必须与生产字节逐字节相同`);
    }

    const witness = JSON.parse(readFileSync(join(BROWSER_DIR, "browser-witness.json"), "utf8")) as {
      bundle: { bytes: number; sha256: string };
      fixtures: { name: string }[];
      styles: { file: string; source: string | null; bytes: number; sha256: string; generated: boolean }[];
      instrumentation: { file: string; originalBytes: number; originalSha256: string; transformedBytes: number; transformedSha256: string; hits: { id: string; anchorHits: number }[] }[];
      foldedProductionSources: { file: string; bytes: number; sha256: string; instrumented: boolean; originalBytes: number; originalSha256: string; instrumentation: { id: string; anchorHits: number }[] }[];
    };
    assert.match(witness.bundle.sha256, /^[0-9a-f]{64}$/);
    assert.strictEqual(witness.bundle.sha256, sha256File(join(BROWSER_DIR, "runner.js")), "见证摘要必须等于磁盘上的 runner.js");
    assert.strictEqual(witness.bundle.bytes, statSync(join(BROWSER_DIR, "runner.js")).size);
    assert.deepStrictEqual(witness.fixtures.map((entry) => entry.name), ["bench-small", "bench-large"]);

    // 样式见证：生产两份 generated=false 且摘要 = 生产字节；离线桥 generated=true。
    const styleWitness = new Map(witness.styles.map((entry) => [entry.file, entry]));
    for (const source of PRODUCTION_STYLE_SOURCES) {
      const name = source.split("/").pop() as string;
      const entry = styleWitness.get(name);
      assert.ok(entry !== undefined, `样式见证缺 ${name}`);
      assert.strictEqual(entry?.generated, false, `${name} 必须是生产原样`);
      assert.strictEqual(entry?.sha256, sha256File(join(REPO, source)), `${name} 见证摘要必须等于生产字节`);
      assert.strictEqual(entry?.bytes, statSync(join(REPO, source)).size);
    }
    assert.strictEqual(styleWitness.get("vscode-bridge.css")?.generated, true, "离线桥必须标注为生成物");

    // 折入的生产源：原字节 / 变换后字节 / 命中数都在，且打点文件真的被改过。
    const folded = new Map(witness.foldedProductionSources.map((entry) => [entry.file, entry]));
    for (const source of ["src/webview/components/Trajectory.tsx", "src/webview/trajectoryLedgerRows.ts", "src/webview/trajectoryVirtual.ts", "src/shared/trajectory.ts", "src/vendor/ui-trajectory/trajectory-search-index.ts"]) {
      const entry = folded.get(source);
      assert.ok(entry !== undefined, `折入见证缺 ${source}`);
      assert.strictEqual(entry?.originalSha256, sha256File(join(REPO, source)), `${source} 的原字节摘要必须等于当前磁盘字节`);
      assert.strictEqual(entry?.originalBytes, statSync(join(REPO, source)).size);
    }
    const instrumented = witness.instrumentation.map((entry) => entry.file).sort();
    assert.deepStrictEqual(instrumented, ["src/vendor/ui-trajectory/trajectory-search-index.ts", "src/webview/components/Trajectory.tsx"], "两份文件必须被打点");
    const allHits = witness.instrumentation.flatMap((entry) => entry.hits);
    assert.strictEqual(allHits.length, INSTRUMENTATION_POINTS.length, "打点命中清单必须覆盖全部锚点（不许缺一个也算过）");
    assert.ok(allHits.every((hit) => hit.anchorHits === 1), `每个锚点必须恰好命中一次：${JSON.stringify(allHits)}`);
    for (const entry of witness.instrumentation) {
      assert.notStrictEqual(entry.transformedSha256, entry.originalSha256, `${entry.file} 打点后必须真的变了（否则等于没折进去）`);
      assert.ok(entry.transformedBytes > entry.originalBytes, `${entry.file} 打点后字节应变大`);
    }
    // 工件不得内嵌受控根路径（否则见证哈希会随目录名漂，也不该把本机路径带出去）。
    assert.strictEqual(readFileSync(join(BROWSER_DIR, "runner.js"), "utf8").includes(CONTROLLED), false, "bundle 不得内嵌本机路径");
    assert.strictEqual(readFileSync(join(BROWSER_DIR, "runner.js"), "utf8").includes("__M06_PROBE__"), true, "bundle 里必须有打点运行时");
    // runner 逐份量测：不许只取 fixtures[0]。
    const runnerSource = readFileSync(join(BROWSER_DIR, "runner.src.js"), "utf8");
    assert.strictEqual(/const entry = fixtures\[0\]/.test(runnerSource), false, "runner 不得只用第一份夹具");
    assert.ok(/index < fixtures\.length/.test(runnerSource), "runner 必须逐份量测");
    // 依赖缺失 / 长模型没有真实滚动时要有明确失败出口，不许只 note + done。
    for (const needle of ["out.status", "out.success", "out.exitCode", "M06.fixture.", "virtual-window", "real-scroll"]) {
      assert.ok(runnerSource.includes(needle), `runner 缺少可判定出口：${needle}`);
    }
  }

  // ── 11. 打点变换：唯一命中 / 变异 prove / 当前生产源码锚点全命中 ────────
  {
    // 每个打点 id 都必须被 runner 需要的阶段名覆盖（begin/end 合成同一个阶段）。
    const declaredStages = new Set(INSTRUMENTATION_POINTS.map((point) => point.id.replace(/\.(begin|end)$/, "")));
    for (const stage of ["view.timeline", "view.vendorTurns", "view.ledgerRows", "view.allRows", "view.commitLayoutEffect", "vendor.searchIndex.update", "vendor.searchIndex.schedule"]) {
      assert.ok(declaredStages.has(stage), `打点清单缺阶段：${stage}`);
    }
    // 当前生产源码：每个锚点必须恰好命中一次（S04 等作者改了源码时这里必须红，不许静默）。
    for (const point of INSTRUMENTATION_POINTS) {
      const text = readFileSync(join(REPO, point.file), "utf8");
      const result = instrumentSource(text, [point]);
      assert.strictEqual(result.hits[0]?.anchorHits, 1, `${point.id} 在 ${point.file} 必须恰好命中一次`);
    }
    // 变异 prove：锚点变了 → 0 命中；锚点重复 → 2 命中；两种都必须被看见。
    const sample = "const a = 1;\nconst b = 2;\n";
    const point = { id: "mut", file: "x.ts", anchor: "const a = 1;", replacement: "const a = 99;" };
    const zero = instrumentSource(sample, [{ ...point, anchor: "const a = 7;" }]);
    assert.strictEqual(zero.hits[0]?.anchorHits, 0, "锚点不存在必须报 0 命中");
    assert.strictEqual(zero.text, sample, "0 命中时不得改动文本");
    const twice = instrumentSource("const a = 1;\nconst a = 1;\n", [point]);
    assert.strictEqual(twice.hits[0]?.anchorHits, 2, "锚点出现两次必须报 2 命中");
    assert.strictEqual(twice.text, "const a = 1;\nconst a = 1;\n", "多命中时不得改动文本");
    const once = instrumentSource(sample, [point]);
    assert.strictEqual(once.hits[0]?.anchorHits, 1);
    assert.strictEqual(once.text, "const a = 99;\nconst b = 2;\n", "恰好一次时必须替换");
    // 换行风格：CRLF 文件里的多行锚点（写成 \n）也必须命中，且不改整份文件的换行。
    const crlf = "line1\r\nconst x = 1;\r\n  }));\r\nline4\r\n";
    const crlfPoint = { id: "crlf", file: "x.ts", anchor: "const x = 1;\n  }));", replacement: "const x = 1;\n  }));\nmark();" };
    const crlfResult = instrumentSource(crlf, [crlfPoint]);
    assert.strictEqual(crlfResult.hits[0]?.anchorHits, 1, "CRLF 文件里的多行锚点必须命中");
    assert.strictEqual(crlfResult.text.includes("\r\nmark();\r\n"), true, "插入的换行必须跟随文件风格");
    assert.strictEqual(crlfResult.text.replace(/\r\n/g, "").includes("\n"), false, "不得引入 LF 混排");
  }

  // ── 11b. 归因时间窗口：同步样本与异步节流索引**分开**，含红/绿受控对照 ──
  {
    // 判据只存在一份：runner 里嵌的就是这段源码，这里编译同一段做离线红/绿对照。
    assert.ok(PROBE_WINDOW_VERDICT_SOURCE.includes("m06ProbeWindowVerdict"), "判据源码必须可被 runner 嵌入");
    const verdict = compileProbeWindowVerdict();
    const syncProbe = (): Record<string, { calls: number; totalMs: number }> => ({
      "view.timeline": { calls: 1, totalMs: 0.1 },
      "view.vendorTurns": { calls: 1, totalMs: 0.2 },
      "view.ledgerRows": { calls: 1, totalMs: 0.3 },
      "view.allRows": { calls: 1, totalMs: 0.4 },
      "view.commitLayoutEffect": { calls: 1, totalMs: 0 },
    });
    const refreshProbes = Array.from({ length: 11 }, () => syncProbe());
    /**
     * **真的跑产物里那份 probe runtime**（`PROBE_RUNTIME_SOURCE`），时钟可脚本化。
     *
     * 这是父级真浏览器读到的那份运行时：`searchScheduled/searchFired/searchUpdateLanded/searchWitness`
     * 以及 raw witness 的字段形状都由它自己产生——本块**不再手写已经规范化过的
     * `schedulesAfterModelSet/firstPair` 之类字段**（那正是上一轮漏掉「基线取晚了」的原因）。
     */
    interface RawSearchEvent {
      nonce: number | null;
      requestedDelayMs?: number;
      timerId: unknown;
      firedTimerId?: unknown;
      timerIdMatched?: boolean | null;
      atMs: number;
      landed?: boolean;
    }
    interface RawSearchPair {
      nonce: number | null;
      requestedDelayMs: number;
      scheduledAtMs: number;
      firedAtMs: number;
      fireDelayMs: number;
      landed: boolean;
      timerId: unknown;
      firedTimerId: unknown;
      timerIdMatched: boolean | null;
    }
    interface RawWitness {
      schedules: RawSearchEvent[];
      fires: RawSearchEvent[];
      coalesced: RawSearchEvent[];
      cancelled: RawSearchEvent[];
      pairs: RawSearchPair[];
    }
    interface FakeClockRuntime {
      reset(): void;
      now(): number;
      searchScheduled(requestedDelayMs: number, timerId: unknown): number;
      searchCoalesced(): void;
      searchFired(timerId: unknown): void;
      searchUpdateLanded(landed: boolean): void;
      searchCancelled(timerId: unknown): void;
      searchWitness(): RawWitness;
    }
    const makeRuntime = (): { runtime: FakeClockRuntime; at: (value: number) => void } => {
      let clock = 0;
      const runtime = new Function("performance", `${PROBE_RUNTIME_SOURCE}\nreturn globalThis.__M06_PROBE__;`)({
        now: () => clock,
      }) as FakeClockRuntime;
      return { runtime, at: (value: number) => { clock = value; } };
    };
    /** 组装一份判据输入：witness 是**runtime 的原样输出**，判据自己按 modelSetAtMs 筛窗口。 */
    const inputFor = (
      runtime: FakeClockRuntime,
      modelSetAtMs: number,
      overrides: Record<string, unknown> = {},
    ): { firstLoadProbe: unknown; refreshProbes: unknown[]; search: Record<string, unknown> } => ({
      firstLoadProbe: syncProbe(),
      refreshProbes,
      search: {
        mountEmptyCalls: 1,
        mountEmptyAtMs: 3.1,
        throttledExecuted: true,
        callsAfterModelSet: 1,
        delayAfterModelSetMs: 2992.2,
        modelSetAtMs: modelSetAtMs,
        firstLoadWallMs: 900,
        cpuMsAfterModelSet: 12.5,
        updateCallsTotal: 3,
        updatesDuringRefresh: 1,
        refreshBatches: 13,
        scheduleWitness: { modelSetAtMs: modelSetAtMs, witness: runtime.searchWitness() },
        ...overrides,
      },
    });

    // ── 绿 1：**受控矩阵**——真实 runtime + 脚本化时钟，喂父级记录的那几个时间点 ────
    // 这**不是**生产真实时间回放（时钟是脚本化的）：它复现的是「窗口起点取晚就会漏掉 schedule」的
    // 形状与判据口径；生产 timer 的真绿仍须父级在真浏览器里取。
    // small schedule90.3/fire3094.5；long 7959/10959.6；comp 117703.1/120710.2（timer id 也不同）。
    const realRuns = [
      { name: "real-small", modelSetAt: 88, scheduleAt: 90.3, fireAt: 3094.5, timerId: 1 },
      { name: "real-long", modelSetAt: 7940, scheduleAt: 7959, fireAt: 10959.6, timerId: 232 },
      { name: "real-compaction", modelSetAt: 117680, scheduleAt: 117703.1, fireAt: 120710.2, timerId: 371 },
    ];
    for (const run of realRuns) {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(run.modelSetAt);
      const modelSetAtMs = runtime.now();
      at(run.scheduleAt);
      runtime.searchScheduled(3000, run.timerId);
      // 旧口径的基线（首载 flushSync + 下一 rAF 之后）里 schedule **已经在**——这就是上一轮读到的形状。
      const lateBaseline = runtime.searchWitness();
      at(run.fireAt);
      runtime.searchFired(run.timerId);
      runtime.searchUpdateLanded(true);
      const witness = runtime.searchWitness();

      // 旧「按快照长度切片」口径在真实数据上必然是 schedule 空、pair 在：
      assert.strictEqual(witness.schedules.slice(lateBaseline.schedules.length).length, 0, `${run.name}: 旧切片口径下 schedule 列表为空（父级读到的 schedules:[]）`);
      assert.strictEqual(witness.pairs.slice(lateBaseline.pairs.length).length, 1, `${run.name}: 旧切片口径下 pair 仍在（父级读到的 pairsAfterModelSet:1）`);
      // **同一份 raw witness** 交给判据、起点取在真实 model set：必须绿。
      const green = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(green.pass, true, `${run.name} 的真实 runtime（脚本化时钟）见证必须绿：${JSON.stringify(green.indexFailures)}`);
      assert.strictEqual(green.index.scheduleObserved, true, `${run.name}: schedule 门必须成立（不许删）`);
      assert.strictEqual(green.index.schedulesAfterModelSet, 1, `${run.name}: 窗口里正好 1 次生产调度`);
      assert.strictEqual(green.index.pairsAfterModelSet, 1, `${run.name}: 一次完整配对`);
      assert.strictEqual(green.index.schedulesBeforeWindow, 0, `${run.name}: 起点取对时窗口外不该有调度`);
      assert.strictEqual(green.index.pairLanded, true, `${run.name}: 落地`);
      assert.strictEqual(green.index.timerIdMatched, true, `${run.name}: 同一 timer id 配对`);
      assert.strictEqual(green.index.pairBinding.idsEqual, true, `${run.name}: 原始 schedule/fire 的 timer id 必须相等`);
      assert.strictEqual(green.index.pairBinding.landedVerified, true, `${run.name}: 落地要由原始 fire 事件核出`);
      assert.deepStrictEqual(green.indexFailures, [], `${run.name}: 合法同 timer 正例不许有任何判据失败`);
      assert.strictEqual(green.index.nonce, 1, `${run.name}: 每个夹具 reset 后 nonce 从 1 起`);
      assert.ok(green.index.selectedPair !== null, `${run.name}: 判据要给出选中的那一对事件`);
      const expectedDelay = Math.round((run.fireAt - run.scheduleAt) * 10) / 10;
      assert.ok(
        Math.abs((green.index.fireDelayMs as number) - expectedDelay) < 0.01,
        `${run.name}: 判据量必须是该 pair 的 firedAt-scheduledAt（${expectedDelay}），实际 ${String(green.index.fireDelayMs)}`,
      );
      // 起点取晚（把 modelSetAtMs 放到 schedule 之后）：schedule 门立刻失守 —— 起晚不能装绿。
      const lateStart = verdict(inputFor(runtime, run.scheduleAt + 5));
      assert.strictEqual(lateStart.pass, false, `${run.name}: 起点晚于调度必须红`);
      assert.ok(lateStart.indexFailures.includes("timer-not-scheduled"), `${run.name}: 要点名缺调度：${lateStart.indexFailures.join(",")}`);
      assert.strictEqual(lateStart.index.schedulesBeforeWindow, 1, `${run.name}: 窗口外的调度要报出来`);
    }

    // ── 红 1：永不 fire（调度了但回调没跑）──────────────────────────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(100);
      const modelSetAtMs = runtime.now();
      at(102);
      runtime.searchScheduled(3000, 1);
      const neverFired = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(neverFired.pass, false, "永不 fire 必须红");
      assert.ok(
        neverFired.indexFailures.includes("timer-not-fired") && neverFired.indexFailures.includes("no-landed-update"),
        `要点名：${neverFired.indexFailures.join(",")}`,
      );
      assert.strictEqual(neverFired.index.scheduleObserved, true, "调度在窗口里，schedule 门成立");
      assert.strictEqual(neverFired.index.firedAfterModelSet, 0);
    }
    // ── 红 1b：根本没有 schedule（生产没调度 / 打点没折进去）──────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(50);
      const modelSetAtMs = runtime.now();
      const noSchedule = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(noSchedule.pass, false, "缺 schedule 见证必须判红");
      assert.ok(noSchedule.indexFailures.includes("timer-not-scheduled"), `要点名缺调度：${noSchedule.indexFailures.join(",")}`);
    }
    // ── 红 1c：挂起被批次复用 / 卸载取消**不算已执行** ──────────────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(200);
      const modelSetAtMs = runtime.now();
      at(201);
      runtime.searchScheduled(3000, 1);
      at(202);
      runtime.searchCoalesced();
      at(203);
      runtime.searchCoalesced();
      at(204);
      runtime.searchCancelled(1);
      const reusedOnly = verdict(inputFor(runtime, modelSetAtMs, { callsAfterModelSet: 0, cpuMsAfterModelSet: 0, updatesDuringRefresh: 0 }));
      assert.strictEqual(reusedOnly.pass, false, "挂起复用/取消不算已执行");
      assert.strictEqual(reusedOnly.index.schedulesAfterModelSet, 1, "调度本身要在窗口里");
      assert.strictEqual(reusedOnly.index.coalescedAfterModelSet, 2, "复用次数要报出来");
      assert.strictEqual(reusedOnly.index.cancelledAfterModelSet, 1, "取消次数要报出来");
      assert.strictEqual(reusedOnly.index.pairsAfterModelSet, 0, "没有 fire 就没有配对");
      assert.ok(reusedOnly.indexFailures.includes("no-landed-update") && reusedOnly.indexFailures.includes("timer-not-fired"), reusedOnly.indexFailures.join(","));
    }
    // ── 红 2：立即回调（12ms）不算通过；首载再慢也不许洗绿 ─────────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(5000); // 首载很慢：真实 model set 在 5000ms
      const modelSetAtMs = runtime.now();
      at(8512);
      runtime.searchScheduled(3000, 7);
      at(8524);
      runtime.searchFired(7);
      runtime.searchUpdateLanded(true);
      const immediate = verdict(inputFor(runtime, modelSetAtMs, { callsAfterModelSet: 11, updatesDuringRefresh: 11, firstLoadWallMs: 5200, delayAfterModelSetMs: 3512 }));
      assert.strictEqual(immediate.pass, false, "没走节流的立即回调必须判红");
      assert.ok(immediate.indexFailures.includes("update-not-throttled"), `要报未节流：${immediate.indexFailures.join(",")}`);
      assert.strictEqual(immediate.index.fireDelayMs, 12, "判据量仍是该 pair 的真实 fire 延迟");
    }
    // ── 绿 2：真 3000ms（首载同样慢，导致 modelSetAt 口径看起来只是 3512）仍绿 ──
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(5000);
      const modelSetAtMs = runtime.now();
      at(8512);
      runtime.searchScheduled(3000, 7);
      at(11516);
      runtime.searchFired(7);
      runtime.searchUpdateLanded(true);
      const slowLoadRealThrottle = verdict(inputFor(runtime, modelSetAtMs, { firstLoadWallMs: 5200, delayAfterModelSetMs: 3512 }));
      assert.strictEqual(slowLoadRealThrottle.pass, true, `真 3000ms + 慢首载必须绿：${JSON.stringify(slowLoadRealThrottle.indexFailures)}`);
      assert.ok(Math.abs((slowLoadRealThrottle.index.fireDelayMs as number) - 3004) < 0.01);
    }
    // ── 红 3：请求延迟不是生产那个 3000（被悄悄改快）必须红 ─────────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(10);
      const modelSetAtMs = runtime.now();
      at(11);
      runtime.searchScheduled(12, 9);
      at(3100);
      runtime.searchFired(9);
      runtime.searchUpdateLanded(true);
      const wrongDelay = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(wrongDelay.pass, false, "请求延迟不符必须红");
      assert.ok(wrongDelay.indexFailures.includes("requested-delay-mismatch"), wrongDelay.indexFailures.join(","));
      assert.strictEqual(wrongDelay.index.requestedDelayMs, 12);
    }
    // ── 红 3b：fire 了但 `searchIndex.update` 返回 false（没落地）不算已执行 ──
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(20);
      const modelSetAtMs = runtime.now();
      at(21);
      runtime.searchScheduled(3000, 3);
      at(3021);
      runtime.searchFired(3);
      runtime.searchUpdateLanded(false);
      const notLanded = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(notLanded.pass, false, "没落地的 fire 不算通过");
      assert.ok(notLanded.indexFailures.includes("no-landed-update"), notLanded.indexFailures.join(","));
      assert.strictEqual(notLanded.index.firedWithoutLanding, 1);
    }
    // ── 红 4：没有 CPU 时间（索引没真跑）也红 ──────────────────────────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(30);
      const modelSetAtMs = runtime.now();
      at(31);
      runtime.searchScheduled(3000, 4);
      at(3031);
      runtime.searchFired(4);
      runtime.searchUpdateLanded(true);
      const noCpu = verdict(inputFor(runtime, modelSetAtMs, { cpuMsAfterModelSet: 0 }));
      assert.strictEqual(noCpu.pass, false, "CPU 时间为零必须红");
      assert.ok(noCpu.indexFailures.includes("no-cpu-time"), noCpu.indexFailures.join(","));
    }
    // ── 红 5：同步阶段在 refresh 样本里缺调用（打点没折进去）也必须红 ────────
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(40);
      const modelSetAtMs = runtime.now();
      const missingSync = verdict({
        firstLoadProbe: syncProbe(),
        refreshProbes: refreshProbes.map((probe) => ({ ...probe, "view.allRows": { calls: 0, totalMs: 0 } })),
        search: { ...(inputFor(runtime, modelSetAtMs).search as Record<string, unknown>) },
      });
      assert.strictEqual(missingSync.pass, false, "同步阶段缺调用必须红");
      assert.deepStrictEqual(missingSync.sync.missingAcrossRefresh, ["view.allRows"]);
    }
    // ── 红 6：timer 身份绑定——不同 id / 伪 matched 标签 / 缺身份 / 矛盾一律不通过 ─────
    // 判据必须回原始 schedule / fire 事件核对，不接受 pair 自带的 `timerIdMatched` 标签。
    {
      const { runtime, at } = makeRuntime();
      runtime.reset();
      at(1000);
      const modelSetAtMs = runtime.now();
      at(1002);
      runtime.searchScheduled(3000, 10);
      at(4004);
      runtime.searchFired(10);
      runtime.searchUpdateLanded(true);

      /** 把判据输入里的 raw witness 换成给定的一份（以拷贝的方式改，不改 runtime 内部状态）。 */
      const patchWitness = (input: ReturnType<typeof inputFor>, mutate: (witness: RawWitness) => RawWitness): void => {
        const search = input.search as unknown as { scheduleWitness: { modelSetAtMs: number; witness: RawWitness } };
        search.scheduleWitness = { modelSetAtMs: modelSetAtMs, witness: mutate(search.scheduleWitness.witness) };
      };
      const patchFirstPair = (witness: RawWitness, patch: (pair: RawSearchPair) => RawSearchPair): RawWitness => ({
        ...witness,
        pairs: witness.pairs.map((row, index) => (index === 0 ? patch(row) : row)),
      });

      // 控制组：同 nonce + 同 timer id(10) —— 必须绿，且绑定由判据自己核出。
      const control = verdict(inputFor(runtime, modelSetAtMs));
      assert.strictEqual(control.pass, true, `控制组（同 nonce + 同 timer id 10）必须绿：${JSON.stringify(control.indexFailures)}`);
      assert.deepStrictEqual(control.indexFailures, [], "控制组不许有任何判据失败");
      assert.strictEqual(control.index.pairBinding.nonce, 1, "控制组 nonce 从 1 起");
      assert.strictEqual(control.index.pairBinding.idsEqual, true, "控制组两个 timer id 相等");
      assert.strictEqual(control.index.pairBinding.landedVerified, true, "控制组落地由原始 fire 事件核出");

      // 红 6a：同 nonce，只把 fire 的 timer id 换成 11、pair 标签同步为 false —— 必须不通过。
      {
        const input = inputFor(runtime, modelSetAtMs);
        patchWitness(input, (witness) => patchFirstPair(witness, (row) => ({ ...row, firedTimerId: 11, timerIdMatched: false })));
        const red = verdict(input);
        assert.strictEqual(red.pass, false, "same nonce with mismatched timer IDs must not qualify");
        assert.ok(red.indexFailures.includes("timer-id-mismatch"), `要点名 timer id 不一致：${red.indexFailures.join(",")}`);
        assert.strictEqual(red.index.pairBinding.pairIdsAgree, false, "pair 自己的 id 与原始事件不一致必须被核出");
      }
      // 红 6b：伪 `timerIdMatched: true` —— 原始 schedule=10 / fire=11 不同，标签再真也不算通过。
      {
        const input = inputFor(runtime, modelSetAtMs);
        patchWitness(input, (witness) => {
          const patched = patchFirstPair(witness, (row) => ({ ...row, firedTimerId: 11, timerIdMatched: true }));
          return {
            ...patched,
            fires: witness.fires.map((row, index) => (index === 0 ? { ...row, timerId: 11 } : row)),
          };
        });
        const red = verdict(input);
        assert.strictEqual(red.pass, false, "a forged timerIdMatched=true label must not qualify");
        assert.ok(red.indexFailures.includes("timer-id-mismatch"), `伪标签下必须点名 id 不一致：${red.indexFailures.join(",")}`);
        assert.strictEqual(red.index.pairBinding.pairLabelMatched, true, "伪标签本身仍是 true——判据不看它");
        assert.strictEqual(red.index.pairBinding.idsEqual, false, "判据按原始两条事件的 id 判不等");
      }
      // 红 6c：身份缺失（timer id 为 null）——不许通过。
      {
        const missing = makeRuntime();
        missing.runtime.reset();
        missing.at(2000);
        const missingSetAt = missing.runtime.now();
        missing.at(2002);
        missing.runtime.searchScheduled(3000, undefined);
        missing.at(5004);
        missing.runtime.searchFired(undefined);
        missing.runtime.searchUpdateLanded(true);
        const red = verdict(inputFor(missing.runtime, missingSetAt));
        assert.strictEqual(red.pass, false, "missing timer identity must not qualify");
        assert.ok(red.indexFailures.includes("timer-identity-missing"), `要点名身份缺失：${red.indexFailures.join(",")}`);
        assert.strictEqual(red.index.pairBinding.idsPresent, false, "id 缺失必须被核出");
      }
      // 红 6d：pair 的落地与原始 fire 事件矛盾（原始没落地，标签写 true）——不许通过。
      {
        const notLanded = makeRuntime();
        notLanded.runtime.reset();
        notLanded.at(3000);
        const notLandedSetAt = notLanded.runtime.now();
        notLanded.at(3002);
        notLanded.runtime.searchScheduled(3000, 12);
        notLanded.at(6010);
        notLanded.runtime.searchFired(12);
        notLanded.runtime.searchUpdateLanded(false);
        const input = inputFor(notLanded.runtime, notLandedSetAt);
        patchWitness(input, (witness) => patchFirstPair(witness, (row) => ({ ...row, landed: true })));
        const red = verdict(input);
        assert.strictEqual(red.pass, false, "a landed flag that contradicts the raw fire event must not qualify");
        assert.ok(red.indexFailures.includes("timer-pair-inconsistent"), `要点名矛盾：${red.indexFailures.join(",")}`);
        assert.strictEqual(red.index.pairBinding.landedVerified, false, "真实落地位必须来自原始 fire 事件");
        assert.strictEqual(red.index.pairBinding.landedMatches, false, "标签与原始事件不一致必须被核出");
      }
      // 红 6e：窗口内同 nonce 的回调不唯一（绑定不唯一）——不许通过。
      {
        const input = inputFor(runtime, modelSetAtMs);
        patchWitness(input, (witness) => ({ ...witness, fires: [...witness.fires, { ...witness.fires[0] }] }));
        const red = verdict(input);
        assert.strictEqual(red.pass, false, "an ambiguous same-nonce fire binding must not qualify");
        assert.ok(red.indexFailures.includes("timer-identity-missing"), `绑定不唯一必须点名：${red.indexFailures.join(",")}`);
        assert.strictEqual(red.index.pairBinding.fireHits, 2, "同 nonce 的回调条数要报出来");
      }
    }
    // runner 侧：用的是同一份判据，且筛选与起点都在判据源码里（runner 不另写一套）。
    const runnerSource = readFileSync(join(BROWSER_DIR, "runner.src.js"), "utf8");
    assert.ok(runnerSource.includes("function m06ProbeWindowVerdict(input)"), "runner 必须嵌入同一份判据函数");
    assert.ok(runnerSource.includes("throttleFloorMs: 2500"), "runner 里嵌的必须是同一段判据源码（floor 不放宽）");
    assert.ok(runnerSource.includes("declaredThrottleMs: 3000"), "生产节流常量必须钉在判据源码里");
    assert.strictEqual(/var PROBE_IDS = \[\s*"view\.timeline"/.test(runnerSource), false, "同步样本清单不许再手写一份");
    assert.ok(/var PROBE_IDS = m06ProbeStages\.sync;/.test(runnerSource), "同步样本清单必须来自判据源码");
    assert.ok(runnerSource.includes("m06ProbeWindowVerdict({"), "runner 必须用判据算 internal-probes");
    assert.ok(runnerSource.includes("scheduleWitness"), "runner 必须把生产调度见证交给判据");
    assert.ok(runnerSource.includes("witness: witnessAfterSet"), "runner 必须把**原始** runtime witness 交给判据（不许先规范化）");
    assert.strictEqual(/scheduleWitness\.schedulesAfterModelSet\s*=/.test(runnerSource), false, "runner 不许自己算规范化字段");
    assert.strictEqual(/slice\(witnessBeforeSet/.test(runnerSource), false, "runner 不许再用「快照长度切片」当窗口");
    assert.ok(runnerSource.includes("var modelSetAtMs = probe.now();"), "筛选起点必须取在生产 model set 之前（probe 时钟）");
    // 顺序要在**首载那一次** commit 之前（`refreshOnce` 里还有一处同形 flushSync，不能拿它比）。
    const beforeFirstAt = runnerSource.indexOf("var beforeFirst = probe.snapshot();");
    const modelSetAtAt = runnerSource.indexOf("var modelSetAtMs = probe.now();");
    const firstLoadCommitAt = runnerSource.indexOf("flushSync(function () { window.__M06_SET_MODEL__(clone); })", beforeFirstAt);
    assert.ok(
      beforeFirstAt >= 0 && modelSetAtAt > beforeFirstAt && firstLoadCommitAt > modelSetAtAt,
      "筛选起点必须在首载 commit 之前取（不是首载 rAF 之后）",
    );
    assert.ok(runnerSource.includes("selectedPair"), "runner 要把判据选中的那一对回填给父级");
    // 半途读到不是结论：初始 status 是 running，收尾才落 passed/failed。
    assert.ok(runnerSource.includes('status: "running"'), "runner 初始状态必须是 running");
  }

  // ── 11c. 滚动 / 虚拟窗口：逐 sweep 单调 + 同单位 logical/rendered（同一段判据源码） ──
  {
    assert.ok(PROBE_WINDOW_VERDICT_SOURCE.includes("m06ScrollWindowVerdict"), "滚动判据必须也在同一段源码里");
    const scrollVerdict = compileScrollWindowVerdict();
    /** 父级第二跑记录的 real-long 第一条 sweep 的 applied 原值（首尾都单调）。 */
    const longApplied = [4870, 9740, 14610, 19480, 24350, 29220, 34089, 38959, 43829, 48699, 53569, 58402];
    const sweepOf = (values: readonly number[], rows: number, pads: number) => ({
      steps: values.map((value) => ({ target: value, applied: value, rows, pads })),
      frames: [1, 2, 3],
      ms: 6,
    });
    const longSweeps = (overrides: { rows?: number; pads?: number; applied?: number[] } = {}) => {
      const values = overrides.applied ?? longApplied;
      return Array.from({ length: 11 }, () => ({
        steps: values.map((value) => ({ target: value, applied: value, rows: overrides.rows ?? 45, pads: overrides.pads ?? 2 })),
        frames: [1, 2, 3],
        ms: 6,
      }));
    };
    const longInput = (overrides: Record<string, unknown> = {}) => ({
      warmup: [sweepOf(longApplied, 45, 2), sweepOf(longApplied, 45, 2)],
      samples: longSweeps(),
      maxScroll: 58439,
      initialRenderedRows: 40,
      logicalLedgerRows: 2047,
      logicalAllRows: 2047,
      virtualizedExpected: true,
      harnessLedgerRows: 2047,
      ...overrides,
    });
    // 绿：**跨 sweep 回到 step1 是正常回落**——旧判据把它拼起来判单调才误红。
    const longGreen = scrollVerdict(longInput());
    assert.strictEqual(longGreen.pass, true, `父级真实 long 原样回放必须绿：${JSON.stringify(longGreen)}`);
    assert.strictEqual(longGreen.applicable, true);
    assert.strictEqual(longGreen.outcome, "virtualized-window-observed");
    assert.strictEqual(longGreen.scroll.pass, true, "real-scroll 那一条也必须绿");
    assert.strictEqual(longGreen.scroll.appliedMonotone, true, "每个 sweep 内部单调");
    assert.strictEqual(longGreen.scroll.withinSweepDecreases.length, 0);
    assert.strictEqual(longGreen.scroll.crossSweepResets.length, 11, "11 个跨界回落只作诊断");
    // 旧判据确实红：把 11 份拼起来判，跨界回落必然非单调。
    const concatenated = longSweeps().flatMap((sweep) => sweep.steps.map((step) => step.applied));
    const concatenatedMonotone = concatenated.every((value, index) => index === 0 || value >= concatenated[index - 1]);
    assert.strictEqual(concatenatedMonotone, false, "拼接判法在父级真实数据上必然误红");
    // 红 1：**某个 sweep 内**意外倒退必须红（跨 sweep 回落不算）。
    const regressed = longSweeps();
    regressed[5]!.steps[7]!.applied = 100;
    const withinSweep = scrollVerdict(longInput({ samples: regressed }));
    // 「组内倒退必须红」落在 real-scroll 那一条（`scroll.pass`）；runner 的夹具状态要求两条都过。
    assert.strictEqual(withinSweep.scroll.pass, false, "组内倒退必须红");
    assert.strictEqual(withinSweep.scroll.appliedMonotone, false);
    assert.deepStrictEqual(withinSweep.scroll.failures, ["applied-decreased-within-sample-sweep"]);
    assert.strictEqual(withinSweep.scroll.withinSweepDecreases.length, 1);
    // 红 2：没有垫行（没虚拟化）必须红。
    const noPads = scrollVerdict(longInput({ warmup: [sweepOf(longApplied, 45, 0), sweepOf(longApplied, 45, 0)], samples: longSweeps({ pads: 0 }) }));
    assert.strictEqual(noPads.pass, false, "无垫行必须红");
    assert.ok(noPads.virtual.failures.includes("no-virtual-pad"), noPads.virtual.failures.join(","));
    // 红 3：容器根本不能滚（无溢出）必须红。
    const noScroll = scrollVerdict(longInput({ maxScroll: 0 }));
    assert.strictEqual(noScroll.pass, false, "不滚动必须红");
    assert.ok(noScroll.virtual.failures.includes("no-scrollable-overflow"), noScroll.virtual.failures.join(","));
    assert.ok(noScroll.scroll.failures.includes("no-scrollable-overflow"), noScroll.scroll.failures.join(","));
    // 红 4：渲染全量（窗口 == 逻辑总量）必须红。
    const renderAll = scrollVerdict(longInput({ samples: longSweeps({ rows: 2047 }), initialRenderedRows: 2047 }));
    assert.strictEqual(renderAll.pass, false, "渲染全量必须红");
    assert.ok(renderAll.virtual.failures.includes("rendered-all-logical-rows"), renderAll.virtual.failures.join(","));
    // 红 5：缺组件内部逻辑见证必须红（不许拿 harness 镜象顶替）。
    const noLogical = scrollVerdict(longInput({ logicalLedgerRows: null, logicalAllRows: null }));
    assert.strictEqual(noLogical.pass, false, "缺 logical 见证必须红");
    assert.ok(noLogical.virtual.failures.includes("no-logical-rows-witness"), noLogical.virtual.failures.join(","));
    // 红 6：两个逻辑量不同单位（allRows < ledgerRows）必须红。
    const unitMismatch = scrollVerdict(longInput({ logicalLedgerRows: 2048, logicalAllRows: 2047 }));
    assert.strictEqual(unitMismatch.pass, false, "单位不符必须红");
    assert.ok(unitMismatch.virtual.failures.includes("logical-units-mismatch"), unitMismatch.virtual.failures.join(","));
    // 红 7：组件内见证与 harness 调同一纯函数的交叉校验不符必须红。
    const crossCheck = scrollVerdict(longInput({ harnessLedgerRows: 2046 }));
    assert.strictEqual(crossCheck.pass, false, "交叉校验不符必须红");
    assert.ok(crossCheck.virtual.failures.includes("logical-witness-cross-check-mismatch"), crossCheck.virtual.failures.join(","));
    // N/A：短模型（低于阈值）全量渲染 —— 判据适用性必须**明示为假**，不当虚拟化性能证明。
    const shortSweep = () => ({ steps: Array.from({ length: 12 }, () => ({ target: 0, applied: 0, rows: 21, pads: 0 })), frames: [1], ms: 1 });
    const short = scrollVerdict({
      warmup: [shortSweep(), shortSweep()],
      samples: Array.from({ length: 11 }, () => shortSweep()),
      maxScroll: 0,
      initialRenderedRows: 21,
      logicalLedgerRows: 21,
      logicalAllRows: 21,
      virtualizedExpected: false,
      harnessLedgerRows: 21,
    });
    assert.strictEqual(short.pass, true, `短模型状态一致必须绿：${JSON.stringify(short)}`);
    assert.strictEqual(short.applicable, false, "短模型必须明示 N/A");
    assert.strictEqual(short.outcome, "not-applicable-non-virtual-model");
    assert.strictEqual(short.virtual.virtualizedExpected, false);
    // 短模型若出现垫行/窗口切片，说明状态与预期不符 —— 也必须红。
    const slicedShortSweep = { steps: Array.from({ length: 12 }, () => ({ target: 0, applied: 0, rows: 12, pads: 1 })), frames: [1], ms: 1 };
    const shortInconsistent = scrollVerdict({
      warmup: [shortSweep(), shortSweep()],
      samples: Array.from({ length: 11 }, () => slicedShortSweep),
      maxScroll: 0,
      initialRenderedRows: 21,
      logicalLedgerRows: 21,
      logicalAllRows: 21,
      virtualizedExpected: false,
      harnessLedgerRows: 21,
    });
    assert.strictEqual(shortInconsistent.pass, false, "非虚拟却切片必须红");
    // runner 侧：滚动判据来自同一段源码，且不再用「首次 DOM 窗口」当逻辑总量。
    const runnerSource = readFileSync(join(BROWSER_DIR, "runner.src.js"), "utf8");
    assert.ok(runnerSource.includes("function m06ScrollWindowVerdict(input)"), "runner 必须嵌入滚动判据");
    assert.ok(runnerSource.includes("m06ScrollWindowVerdict({"), "runner 必须用滚动判据");
    assert.ok(runnerSource.includes("m06ProbeStages.ledgerRowsStage") && runnerSource.includes("m06ProbeStages.allRowsStage"), "逻辑行数阶段名必须来自同一份判据源码");
    assert.strictEqual(/var totalRows = document\.querySelectorAll/.test(runnerSource), false, "不得再把首次 DOM 窗口当 totalRows");
    assert.strictEqual(/scroll\.totalRows/.test(runnerSource), false, "不得再比较 scroll.totalRows");
    assert.strictEqual(/minRows < scroll\.totalRows/.test(runnerSource), false, "不得再用错单位的 minRows 比较");
    assert.ok(runnerSource.includes("logicalAllRows"), "runner 必须报组件内部逻辑行数");
  }

  // ── 12. 静态服务器：纯路由 + 实连真实端口 + 绑失败可判定 ───────────────
  {
    // 12a 纯路由判定：不依赖 socket，因此在禁止回环连接的沙箱里也照样有牙。
    const page = resolveServedFile(BROWSER_DIR, "/");
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.file, join(BROWSER_DIR, "index.html"));
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/index.html?x=1").status, 200, "查询串要被就地截掉");
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/runner.js").status, 200);
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/app.css").status, 200, "样式也要服务");
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/../package.json").status, 403, "路径穿越必须被拒");
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/..%2Fpackage.json").status, 404, "编码后的名字只当普通文件名，落不到仓库文件");
    assert.strictEqual(resolveServedFile(BROWSER_DIR, "/nope.js").status, 404);

    // 12b 真起一次服务器：**公布真实端口**并实连拿到本工件页面。实连失败不静默 skip。
    const server = await serveBrowserArtifacts(BROWSER_DIR, 0);
    try {
      const parsed = new URL(server.url);
      assert.ok(server.port > 0 && server.port <= 65535, `必须公布真实端口，实际 ${server.port}`);
      assert.strictEqual(Number(parsed.port), server.port, "URL 里的端口必须等于实际绑定端口");
      const http = createRequire(import.meta.url)("node:http") as typeof import("node:http");
      const httpGet = (path: string): Promise<{ status: number; body: Buffer; contentType: string }> =>
        new Promise((done, reject) => {
          const request = http.request(
            { host: "127.0.0.1", port: server.port, path, method: "GET", family: 4 },
            (response) => {
              // **按块收集 Buffer 再拼**：`body += chunk` 会在多字节字符跨 TCP 块时插进替换
              // 字符，拿它去比摘要必然对不上——那是测试自己的坑，不是服务的。
              const chunks: Buffer[] = [];
              response.on("data", (chunk) => chunks.push(Buffer.from(chunk as Buffer)));
              response.on("end", () => done({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), contentType: String(response.headers["content-type"] ?? "") }));
            },
          );
          request.on("error", reject);
          request.end();
        });
      const live = await httpGet("/index.html");
      assert.strictEqual(live.status, 200, "实连必须拿到页面（失败不跳过）");
      assert.ok(live.body.toString("utf8").includes("M06 browser end-to-end harness"), "拿到的必须是**本工件**的页面");
      const css = await httpGet("/app.css");
      assert.strictEqual(css.status, 200);
      assert.ok(css.contentType.startsWith("text/css"), `样式 content-type 必须是 text/css：${css.contentType}`);
      assert.strictEqual(createHash("sha256").update(css.body).digest("hex"), sha256File(join(REPO, PRODUCTION_STYLE_SOURCES[1])), "服务出去的就是生产 app.css 的字节");
      // 原始 `..` 段必须被目录包含性判据拒掉（不能靠客户端先规范化）。
      const traversal = await httpGet("/../package.json");
      assert.notStrictEqual(traversal.status, 200, "路径穿越必须被拒");
    } finally {
      server.close();
    }

    // 12c 绑失败：端口被占 → 可判定错误（不是「公布一个假端口」）。
    const occupied = await serveBrowserArtifacts(BROWSER_DIR, 0);
    try {
      await assert.rejects(
        () => serveBrowserArtifacts(BROWSER_DIR, occupied.port),
        (error: unknown) => error instanceof BrowserServerError && error.code === "bind-failed",
        "端口被占必须抛 bind-failed",
      );
      // CLI 层：同一场景必须退非 0 且给中英两行。
      const cliRun = spawnSync(process.execPath, [CLI, "--serve-browser", BROWSER_DIR, "--port", String(occupied.port)], {
        encoding: "utf8",
        cwd: REPO,
        timeout: 60_000,
      });
      assert.strictEqual(cliRun.status, BENCH_EXIT.refused, `绑失败必须退 3：${(cliRun.stderr ?? "").slice(0, 200)}`);
      assert.ok((cliRun.stderr ?? "").includes("端口无法绑定") && (cliRun.stderr ?? "").includes("could not be bound"), "绑失败必须固定中英两行");
      assert.strictEqual((cliRun.stdout ?? "").includes("已启动"), false, "绑失败不得声称已启动");
    } finally {
      occupied.close();
    }
  }

  // ── 13. 写出前后产品源逐字不变（工件只落在受控目录） ────────────────────
  {
    assert.deepStrictEqual(hashAll(), before, "量测与写出不得改动任何产品源码");
  }

  console.log("trajectoryPayloadBench.test.ts: 全部断言通过");
  console.log("[coverage] 资格闸门 1 绿 5 红 / emit 同闸门零工件 / 真实 CLI 入口（现场打包）/ --out 失败即失败 / 多夹具逐份 / 生产样式同字节 / 打点唯一命中与变异 / 服务器真实端口与绑失败");
  console.log("[not-covered] 浏览器里的实际量测（真收帧 / 组件内部打点 / commit / 滚动帧）由主代理在真浏览器跑一次，看 window.__M06__.status 与 checks[]");
} catch (error) {
  failed = true;
  console.error(`[trajectoryPayloadBench] 断言失败，受控材料保留在：${tmpRoot}`);
  throw error;
} finally {
  if (!failed) rmSync(tmpRoot, { recursive: true, force: true });
}
