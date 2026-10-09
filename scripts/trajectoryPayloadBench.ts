/**
 * 【脚本定位】工具型 · 零 token · **只读显式夹具，不读源日志** —— M06 完整载荷整链路量测（纯模块）。
 *
 * 本文件是**纯模块**：没有顶层副作用、不读 `process.argv`、不写 stdout、不 `process.exit`。
 * OS 入口是薄壳 `scripts/trajectoryPayloadBenchCli.ts`（argv / IO / 退出码），
 * 浏览器整链路工件在 `scripts/trajectoryPayloadBenchBrowser.ts`。测试直接 import 本模块。
 *
 * ## 为什么需要它
 *
 * 旧数字（折叠中位 0.4ms、历史约 9.9MB 载荷）都不是**当前整链路**基线，也无法复现。
 * 本工具建立的是**长期可复现**的量法：吃一份**显式给路径**的脱敏夹具，把
 * 「读夹具 → 登记校验 → 线格式 → 界面解析 → 索引 / 账本行 / 时间线 / 虚拟窗口」
 * 这条真实消费路径逐段计时，并固定模型摘要与结构计数作为可比锚点。
 *
 * ## 四条硬口径
 *
 * 1. **绝无默认扫描**：只吃 `--fixture`，一次都不去 `~/.dsh` / `DSH_HOME` / 家目录找东西。
 *    没给 `--fixture` 就是用法错误，不是「自动找一份」。
 * 2. **资格闸门复用正式件**：复用 `scripts/trajectoryFixture.ts` 的 `validateFixturePayload`
 *    与 `FIXTURE_INVARIANT_CODES` 做完整登记校验，**再独立**要求
 *    `payloadReduced === false`、`payloadMeasurementEligible === true`、`truncatedFields` 为空。
 *    三条各自成立才算合格；谎报任何一条都拦得住。调用方**没有**降载开关。
 * 3. **只承诺「这份脱敏窗口的完整派生载荷」**：绿灯**不代表**来源真实、不代表等于真实全历史。
 *    登记自洽不是认证——`derive.sha256` 要不要钉由调用方用 `--expect-derive-sha256` 显式决定，
 *    本工具不自作主张取默认值。
 * 4. **不把镜像说成真实渲染**：`allocation.plan` 只是按生产 JSX 分支结构做的**静态计数**，
 *    既不是 React 元素分配、也不是 commit / DOM。真实元素分配、commit 与连续滚动帧由
 *    `scripts/trajectoryPayloadBenchBrowser.ts` 在真浏览器里量（本模块不声称已覆盖）。
 *
 * ## 两种量测各自是什么（不许混着读）
 *
 * - **orderedPass（顺序执行的真实函数基准）**：一次完整跑动里按本基准**自己的**顺序
 *   各跑一次，报 `cold`（首次触摸，单记）与 `warm`（预热后的一次）两份**逐段原值**。
 *   这个顺序**不是产品一次实际请求的顺序**：账本行投影那三档是**互斥**的 UI 分支、
 *   `fold.rebuild` 是由模型**反推出来的合成事件计划**——它们在同一趟里都跑了，只为让
 *   每段都有真实读数；产品侧一次只会走其中一支。每段的性质由 `kind` 显式标出
 *   （见下），别把「顺序执行了真实函数」读成「这是产品实际顺序」。
 * - **isolated（重复消费实验）**：把同一份载荷按阶段各跑 `samples` 次，给
 *   `min / median / p95 / max` 与**整组 raw 样本**。**产品不会这么跑**——它是为了让
 *   分布可比、让回归有牙而做的重复实验，读的时候必须与 orderedPass 分开。
 *
 * **p95 定义**（小样本必须写明）：升序后取**最近秩** `sorted[ceil(0.95 * n) - 1]`。
 * `n = 11` 时该秩就是最大值，所以 11 份样本下 **p95 === max**，它不表示尾部百分位。
 *
 * **合成下限**：`fold.rebuild` 的 `kind` 是 `synthetic-lower-bound`——它反推的事件计划
 * 不等于原始事件流，**不代表真实宿主的折叠代价**。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import type { SessionWireEvent } from "../src/dsh/protocol";
import {
  trajectoryTurnCells,
  type TrajectoryCell,
  type TrajectoryModel,
} from "../src/shared/trajectory";
import {
  FIXTURE_INVARIANT_CODES,
  canonicalJson,
  structureOf,
  validateFixturePayload,
  type FixtureStructure,
  type ProvenanceIssue,
} from "./trajectoryFixture";
import { trajectoryLedgerRows } from "../src/webview/trajectoryLedgerRows";
import { deriveTrajectoryTimeline } from "../src/webview/trajectoryTimeline";
import { trajectoryCellRecordId, vendorTurns } from "../src/webview/trajectoryVendor";
import { trajectoryGroupTitle } from "../src/webview/trajectoryDisplay";
import { trajectoryTexts } from "../src/webview/trajectoryTexts";
import { TrajectorySearchIndex } from "../src/vendor/ui-trajectory/trajectory-search-index";
import { VIRTUAL_ROW_HEIGHT, trajectoryRowPositions, trajectoryWindowPlan } from "../src/webview/trajectoryVirtual";

// ───────────────────────────── 文案（中英两套） ─────────────────────────────

/**
 * 固定文案：**中英两套一起给**，不引语言开关，结果与机器 locale 无关。
 * 变量只走 `{名字}` 占位，不拼字符串（中英语序不同）。
 *
 * 口径与 `scripts/fixtureCliText.ts` 一致：失败与成功都**不回显**路径、夹具名原文、
 * 载荷或异常原文（参数与路径形状上都可能是秘密）。
 */
export const BENCH_MESSAGES = {
  usage: {
    zh: [
      "用法：node build/trajectory-payload-bench.mjs --fixture <夹具.json> [--fixture <夹具.json> …] [--samples <n>] [--warmup <n>] [--json] [--out <报告.json>]",
      "  --fixture  必填，可重复；**没有默认扫描**，不会去家目录 / ~/.dsh / DSH_HOME 找任何东西。",
      "  --samples  重复消费实验的样本数（默认 11，最小 11，整数）。",
      "  --warmup   重复实验前的整轮预热次数（默认 2，最小 2，整数）。",
      "  --json     同时打印机器可读报告。",
      "  --out      把机器可读报告写到这个路径。",
      "  --expect-derive-sha256 <64位小写十六进制>  要求夹具的 derive.sha256 等于它，否则拒测（可选）。",
      "浏览器整链路工件见 build/trajectory-payload-bench.mjs 的 --emit-browser / --serve-browser。",
    ].join("\n"),
    en: [
      "Usage: node build/trajectory-payload-bench.mjs --fixture <fixture.json> [--fixture <fixture.json> …] [--samples <n>] [--warmup <n>] [--json] [--out <report.json>]",
      "  --fixture  required, repeatable; there is NO default scan and it never looks into HOME / ~/.dsh / DSH_HOME.",
      "  --samples  sample count for the repeated-consumption experiment (default 11, minimum 11, integer).",
      "  --warmup   whole-run warmup rounds before the repeated experiment (default 2, minimum 2, integer).",
      "  --json     also print the machine-readable report.",
      "  --out      write the machine-readable report to this path.",
      "  --expect-derive-sha256 <64 lowercase hex>  require the fixture derive.sha256 to equal it, otherwise refuse (optional).",
      "Browser end-to-end artifacts: see --emit-browser / --serve-browser on build/trajectory-payload-bench.mjs.",
    ].join("\n"),
  },
  unknownArgument: { zh: "存在未知参数。", en: "Unknown argument." },
  argumentValueMissing: {
    zh: "某个开关缺少取值。**未执行任何量测**。",
    en: "An option is missing its value. **Nothing was measured**.",
  },
  fixtureMissing: {
    zh: "未给任何 --fixture。本工具不做默认扫描（不去家目录 / 会话目录 / DSH_HOME 找夹具）。**未执行任何量测**。",
    en: "No --fixture given. This tool never scans by default (it does not look into HOME / session directories / DSH_HOME). **Nothing was measured**.",
  },
  fixtureUnreadable: {
    zh: "第 {ordinal} 份夹具不存在、不是普通文件，或不是合法 JSON。**未执行任何量测**。",
    en: "Fixture #{ordinal} does not exist, is not a regular file, or is not valid JSON. **Nothing was measured**.",
  },
  fixtureDuplicate: {
    zh: "第 {ordinal} 份夹具与前面某一份是同一路径：拒绝在统计里静默重复计样。**未执行任何量测**。",
    en: "Fixture #{ordinal} resolves to the same path as an earlier one: refusing to silently double-count samples. **Nothing was measured**.",
  },
  sampleCountInvalid: {
    zh: "--samples 必须是 >= 11 的整数。**未执行任何量测**。",
    en: "--samples must be an integer >= 11. **Nothing was measured**.",
  },
  warmupCountInvalid: {
    zh: "--warmup 必须是 >= 2 的整数。**未执行任何量测**。",
    en: "--warmup must be an integer >= 2. **Nothing was measured**.",
  },
  deriveShaInvalid: {
    zh: "--expect-derive-sha256 必须是 64 位小写十六进制。**未执行任何量测**。",
    en: "--expect-derive-sha256 must be 64 lowercase hex characters. **Nothing was measured**.",
  },
  disqualifyPayloadReduced: {
    zh: "第 {ordinal} 份夹具声明 payloadReduced=true（截断／降载过）。全载荷量测不接受降载样本。",
    en: "Fixture #{ordinal} declares payloadReduced=true (truncated / reduced). Full-payload measurement refuses reduced samples.",
  },
  disqualifyNotEligible: {
    zh: "第 {ordinal} 份夹具的 payloadMeasurementEligible 不是 true（缺成员或为假）。",
    en: "Fixture #{ordinal} does not have payloadMeasurementEligible === true (missing or false).",
  },
  disqualifyTruncatedFields: {
    zh: "第 {ordinal} 份夹具的 truncatedFields 非空（逐字段截断登记不为零）。",
    en: "Fixture #{ordinal} has a non-empty truncatedFields record.",
  },
  disqualifyRegistration: {
    zh: "第 {ordinal} 份夹具的登记校验未通过：{detail}",
    en: "Fixture #{ordinal} failed registration validation: {detail}",
  },
  disqualifyDeriveSha: {
    zh: "第 {ordinal} 份夹具的 derive.sha256 与 --expect-derive-sha256 不符（折叠源码不是被要求的那一份）。",
    en: "Fixture #{ordinal} has a derive.sha256 that does not match --expect-derive-sha256.",
  },
  disqualifyModelShape: {
    zh: "第 {ordinal} 份夹具的 model 不是可折叠形状（turns / requests 不是数组）。",
    en: "Fixture #{ordinal} has a model that is not foldable (turns / requests are not arrays).",
  },
  stageThrew: {
    zh: "第 {ordinal} 份夹具的「{stage}」环节抛出异常（{error}）。按环境问题计，不算量测成功。",
    en: "Fixture #{ordinal} threw while running stage \"{stage}\" ({error}). Counted as an environment problem, not a successful measurement.",
  },
  measured: {
    zh: "已完成 {fixtures} 份夹具的整链路量测（orderedPass 顺序执行一次 + isolated 重复实验 {samples} 份）。",
    en: "Completed end-to-end measurement of {fixtures} fixture(s) (one ordered pass of real functions + {samples} isolated samples).",
  },
  notRunBrowser: {
    zh: "浏览器整链路阶段**本次未运行**：本工具不声称已覆盖真实收帧字节 / 索引 / allRows / commit / 滚动帧。",
    en: "The browser end-to-end stage was NOT run: this tool does not claim coverage of real frame bytes / indexing / allRows / commit / scroll frames.",
  },
  browserHandledByEntry: {
    zh: "浏览器工件模式由 OS 入口处理（不在纯模块里执行）。**未执行任何量测**。",
    en: "Browser artifact modes are handled by the OS entry (not executed in the pure module). **Nothing was measured**.",
  },
  outWriteFailed: {
    zh: "--out 指定的报告文件未能写出（{detail}）。**指定交付文件的失败就是失败**，这次运行按失败退出。",
    en: "The report file requested by --out could not be written ({detail}). **A requested deliverable that fails is a failure**; this run exits as a failure.",
  },
  serveBindFailed: {
    zh: "浏览器工件服务启动失败：端口无法绑定（{detail}）。**没有服务在监听**。",
    en: "Browser artifacts server could not start: the port could not be bound ({detail}). **Nothing is listening**.",
  },
  serveNotListening: {
    zh: "浏览器工件服务未能进入监听状态（{detail}）。**没有服务在监听**。",
    en: "Browser artifacts server never reached the listening state ({detail}). **Nothing is listening**.",
  },
  deriveShaNotApplicable: {
    zh: "--expect-derive-sha256 只对量测与 --emit-browser 有意义；--serve-browser 不读夹具，**不接受**这个开关。",
    en: "--expect-derive-sha256 only applies to measurement and --emit-browser; --serve-browser never reads a fixture and does **not** accept it.",
  },
  portNotApplicable: {
    zh: "--port 只对 --serve-browser 有意义；--emit-browser 不启动服务，**不接受**这个开关。",
    en: "--port only applies to --serve-browser; --emit-browser starts no server and does **not** accept it.",
  },
  emitFixtureDuplicate: {
    zh: "第 {ordinal} 份夹具与前面某一份是同一路径：拒绝把同一份载荷在浏览器工件里重复写出。**未写出任何工件**。",
    en: "Fixture #{ordinal} resolves to the same path as an earlier one: refusing to write the same payload twice into browser artifacts. **No artifact was written**.",
  },
  emitFixtureUnreadable: {
    zh: "第 {ordinal} 份夹具不存在、不是普通文件，或不是合法 JSON。**未写出任何工件**。",
    en: "Fixture #{ordinal} does not exist, is not a regular file, or is not valid JSON. **No artifact was written**.",
  },
  emitInstrumentationFailed: {
    zh: "组件内部打点未命中唯一锚点（{detail}）。**未写出任何工件**——打点缺命中或多命中都不许静默放行。",
    en: "Component-internal instrumentation did not hit a unique anchor ({detail}). **No artifact was written** — a missing or ambiguous hit is never waved through.",
  },
  emitStyleMissing: {
    zh: "生产样式文件缺失或不可读（{detail}）。**未写出任何工件**——浏览器工件必须载入同字节生产样式。",
    en: "A production stylesheet is missing or unreadable ({detail}). **No artifact was written** — browser artifacts must load byte-identical production styles.",
  },
} as const;

export type BenchMessageKey = keyof typeof BENCH_MESSAGES;

/** 取一条文案并按 `{名字}` 替换；返回 `[中文, 英文]`。 */
export function benchLines(
  key: BenchMessageKey,
  params: Record<string, string | number> = {},
): [string, string] {
  const entry = BENCH_MESSAGES[key];
  const fill = (template: string): string =>
    template.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
    );
  return [fill(entry.zh), fill(entry.en)];
}

/** 退出码契约：成功 0 / 用法与输入问题 2 / 有夹具未过闸门 3。 */
export const BENCH_EXIT = { ok: 0, usage: 2, refused: 3 } as const;

// ───────────────────────────── 参数 ─────────────────────────────

export interface BenchOptions {
  /** 显式夹具路径（可重复）；**没有默认值**。 */
  fixtures: string[];
  /** 重复消费实验的样本数（>= 11）。 */
  samples: number;
  /** 重复实验前的整轮预热次数（>= 2）。 */
  warmup: number;
  /** 是否同时给出机器可读报告。 */
  json: boolean;
  /** 报告落盘路径（可选）。 */
  out?: string;
  /** 要求夹具的 `derive.sha256` 等于该摘要（不给就不钉，见文件头第 3 条）。 */
  expectDeriveSha256?: string;
}

/** 参数错误：**只带固定规则名，不带参数原文**。 */
export interface BenchUsageError {
  key: BenchMessageKey;
  params: Record<string, string | number>;
}

/** 一次命令行调用的解析结果。 */
export type BenchInvocation =
  | { kind: "measure"; options: BenchOptions }
  /**
   * emit 模式：`expectDeriveSha256` **显式带上**（不给 `undefined`）。
   * 早先这里把 pin 悄悄丢了——调用方以为钉住了来源，实际没有；现在解析层就留住它。
   */
  | { kind: "emit-browser"; directory: string; fixtures: string[]; expectDeriveSha256?: string }
  | { kind: "serve-browser"; directory: string; port: number }
  | { kind: "usage"; error: BenchUsageError };

function takeValue(argv: readonly string[], index: number): string | undefined {
  const value = argv[index];
  return value === undefined || value === "" ? undefined : value;
}

/** 默认监听端口：0 = 让系统挑一个空闲端口（避免与既有预览服务撞车）。 */
export const DEFAULT_BROWSER_PORT = 0;

/**
 * 解析命令行。**任何未知参数都按用法错误处理**，错误只给规则名（不回显参数原文）。
 */
export function parseBenchInvocation(argv: readonly string[]): BenchInvocation {
  const options: BenchOptions = { fixtures: [], samples: 11, warmup: 2, json: false };
  let emitBrowser: string | undefined;
  let serveBrowser: string | undefined;
  let port = DEFAULT_BROWSER_PORT;
  /** `--port` 是不是**真的给过**：默认值 0 与「显式给 0」必须分得开，否则没法拒绝误用。 */
  let portGiven = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      const value = takeValue(argv, index + 1);
      if (value === undefined) return { kind: "usage", error: { key: "argumentValueMissing", params: {} } };
      options.fixtures.push(value);
      index += 1;
    } else if (arg === "--samples") {
      const value = Number(takeValue(argv, index + 1));
      if (!Number.isInteger(value) || value < 11) return { kind: "usage", error: { key: "sampleCountInvalid", params: {} } };
      options.samples = value;
      index += 1;
    } else if (arg === "--warmup") {
      const value = Number(takeValue(argv, index + 1));
      if (!Number.isInteger(value) || value < 2) return { kind: "usage", error: { key: "warmupCountInvalid", params: {} } };
      options.warmup = value;
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--out") {
      const value = takeValue(argv, index + 1);
      if (value === undefined) return { kind: "usage", error: { key: "argumentValueMissing", params: {} } };
      options.out = value;
      index += 1;
    } else if (arg === "--expect-derive-sha256") {
      const value = takeValue(argv, index + 1);
      if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
        return { kind: "usage", error: { key: "deriveShaInvalid", params: {} } };
      }
      options.expectDeriveSha256 = value;
      index += 1;
    } else if (arg === "--emit-browser") {
      const value = takeValue(argv, index + 1);
      if (value === undefined) return { kind: "usage", error: { key: "argumentValueMissing", params: {} } };
      emitBrowser = value;
      index += 1;
    } else if (arg === "--serve-browser") {
      const value = takeValue(argv, index + 1);
      if (value === undefined) return { kind: "usage", error: { key: "argumentValueMissing", params: {} } };
      serveBrowser = value;
      index += 1;
    } else if (arg === "--port") {
      const value = Number(takeValue(argv, index + 1));
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        return { kind: "usage", error: { key: "argumentValueMissing", params: {} } };
      }
      port = value;
      portGiven = true;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      return { kind: "usage", error: { key: "usage", params: {} } };
    } else {
      return { kind: "usage", error: { key: "unknownArgument", params: {} } };
    }
  }
  // 浏览器两种模式互斥、且都不做量测；优先报「两个都给」为用法错误。
  if (emitBrowser !== undefined && serveBrowser !== undefined) {
    return { kind: "usage", error: { key: "unknownArgument", params: {} } };
  }
  if (emitBrowser !== undefined) {
    // 不适用就**明确拒**，不静默丢掉调用方给的开关（丢 pin 曾让「钉住来源」变成空话）。
    if (portGiven) return { kind: "usage", error: { key: "portNotApplicable", params: {} } };
    return {
      kind: "emit-browser",
      directory: emitBrowser,
      fixtures: options.fixtures,
      ...(options.expectDeriveSha256 === undefined ? {} : { expectDeriveSha256: options.expectDeriveSha256 }),
    };
  }
  if (serveBrowser !== undefined) {
    // 服务模式不读夹具：留着 pin 只会让调用方以为它生效了。
    if (options.expectDeriveSha256 !== undefined) {
      return { kind: "usage", error: { key: "deriveShaNotApplicable", params: {} } };
    }
    return { kind: "serve-browser", directory: serveBrowser, port };
  }
  return { kind: "measure", options };
}

/** 兼容旧名：只关心量测参数的调用方（测试 / 内部）用这个。 */
export function parseBenchArgs(argv: readonly string[]): { ok: true; options: BenchOptions } | { ok: false; error: BenchUsageError } {
  const invocation = parseBenchInvocation(argv);
  if (invocation.kind === "usage") return { ok: false, error: invocation.error };
  if (invocation.kind !== "measure") return { ok: false, error: { key: "browserHandledByEntry", params: {} } };
  return { ok: true, options: invocation.options };
}

// ───────────────────────────── 资格闸门 ─────────────────────────────

export type DisqualifyReason =
  | "payload-reduced"
  | "not-measurement-eligible"
  | "truncated-fields-not-empty"
  | "registration-invalid"
  | "derive-sha-mismatch"
  | "model-shape-invalid";

/** 一处拒测原因：**只有规则码与安全定位**，不含载荷内容。 */
export interface BenchReason {
  code: DisqualifyReason;
  /** 安全的补充信息（规则码串），绝不带载荷文本。 */
  detail?: string;
}

/** 一份夹具的资格判定结果。 */
export interface Qualification {
  eligible: boolean;
  reasons: BenchReason[];
  /** 登记校验的问题码摘要（`code×count` 连接），供人读；无问题时是空串。 */
  registrationIssues: string;
  /** 是否本次显式钉了 derive 摘要（`--expect-derive-sha256`）。 */
  derivePinned: boolean;
}

export type Sha256Hex = (text: string) => string;

/** 摘要白名单：与生成器 / 离线校验段**同一份精确位置清单**。 */
export const DIGEST_WHITELIST = [
  "$.provenance.sourceSha256",
  "$.provenance.extractor.sha256",
  "$.provenance.derive.sha256",
  "$.provenance.modelSha256",
] as const;

/** 稳定的 sha256。 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 问题摘要：只有规则码与计数。 */
export function registrationSummary(issues: readonly ProvenanceIssue[]): string {
  return issues.map((issue) => `${issue.code}×${issue.count}`).join(",");
}

/**
 * 资格闸门：先按**正式件**做完整登记校验，再**独立**检查三条资格判据。
 *
 * **不接受降载**：`payloadReduced === false`、`payloadMeasurementEligible === true`、
 * `truncatedFields` 为空——三条各自成立才算合格（谎报一条也拦得住）。没有绕过开关。
 */
export function qualifyFixturePayload(
  payload: unknown,
  options: { expectDeriveSha256?: string },
): Qualification {
  const reasons: BenchReason[] = [];
  const registration = validateFixturePayload(payload, {
    sha256Hex,
    digestPaths: [...DIGEST_WHITELIST],
    expectedChecks: [...FIXTURE_INVARIANT_CODES],
  });
  const summary = registrationSummary(registration);
  if (registration.length > 0) {
    reasons.push({ code: "registration-invalid", ...(summary === "" ? {} : { detail: summary }) });
  }
  const outer = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
  const provenance = outer?.provenance !== null && typeof outer?.provenance === "object" && !Array.isArray(outer?.provenance)
    ? (outer?.provenance as Record<string, unknown>)
    : undefined;
  const model = outer?.model;
  const derivePinned = options.expectDeriveSha256 !== undefined;
  if (provenance === undefined || model === null || typeof model !== "object" || Array.isArray(model)) {
    reasons.push({ code: "model-shape-invalid" });
    return { eligible: false, reasons, registrationIssues: summary, derivePinned };
  }
  // 肯定证据：只有**明确为真/假**才判；缺成员由登记校验报出（不在这里重复）。
  if (provenance.payloadReduced === true) reasons.push({ code: "payload-reduced" });
  if (provenance.payloadMeasurementEligible !== true) reasons.push({ code: "not-measurement-eligible" });
  const truncated = provenance.truncatedFields;
  if (truncated !== null && typeof truncated === "object" && !Array.isArray(truncated)
    && Object.keys(truncated as Record<string, unknown>).length > 0) {
    reasons.push({ code: "truncated-fields-not-empty" });
  }
  const typedModel = model as unknown as TrajectoryModel;
  if (!Array.isArray(typedModel.turns) || !Array.isArray(typedModel.requests)) {
    reasons.push({ code: "model-shape-invalid" });
  }
  if (derivePinned) {
    const derive = provenance.derive;
    const deriveSha = derive !== null && typeof derive === "object" && !Array.isArray(derive)
      ? (derive as Record<string, unknown>).sha256
      : undefined;
    if (deriveSha !== options.expectDeriveSha256) reasons.push({ code: "derive-sha-mismatch" });
  }
  const unique = new Map<DisqualifyReason, BenchReason>();
  for (const reason of reasons) if (!unique.has(reason.code)) unique.set(reason.code, reason);
  return { eligible: unique.size === 0, reasons: [...unique.values()], registrationIssues: summary, derivePinned };
}

// ───────────────────────────── 整链路 seam ─────────────────────────────

/** 一段在**性质**上属于哪一类（读报告时不许跨类比较）。 */
export type StageKind =
  /** 真实磁盘 IO（夹具读盘）。 */
  | "real-io"
  /** 真实生产函数在真实输入上的顺序执行。 */
  | "real-function"
  /** 由模型**反推**出来的合成事件计划：只是折叠代价的**下限**，不是原始事件流。 */
  | "synthetic-lower-bound"
  /** 静态计数（按 JSX 分支结构数元素 / 字符），不是运行期分配。 */
  | "static-count";

/** 这一段在「一次实际请求」里会不会与别的段同时发生。 */
export type StageBranch =
  | "always"
  /** 与同组其它段**互斥**：本基准把它们都跑了一遍，产品一次只走一支。 */
  | "mutually-exclusive-alternative";

/** 一段的分布（重复消费实验的读数）。 */
export interface StageTiming {
  /** 稳定 id（机器路径只输出它）。 */
  stage: string;
  /** 这一段属于哪一类（见 `StageKind`）。 */
  kind: StageKind;
  /** 是否与同组其它段互斥（见 `StageBranch`）。 */
  branch: StageBranch;
  /** 这一段量的是哪条真实消费路径（人读）。 */
  measures: string;
  /** 统计样本原值（毫秒，按采集顺序，**不排序**）。 */
  samplesMs: number[];
  minMs: number;
  medianMs: number;
  /** 最近秩定义的小样本上界，见文件头。 */
  p95Ms: number;
  maxMs: number;
}

/**
 * 一次完整跑动的逐段原值（**顺序执行**；不是产品一次实际请求的顺序）。
 */
export interface OrderedPass {
  totalMs: number;
  /** 逐段原值；键的顺序就是执行顺序（`executionOrder` 另给一份显式序列）。 */
  stagesMs: Record<string, number>;
}

/** 整链路一次完整跑动保留下来的**产物**（供一致性核对，不进长期材料）。 */
export interface ChainProducts {
  modelSha256: string;
  /** 模型 JSON 的 UTF-8 字节数。 */
  wireBytes: number;
  /** 线格式字符串的 sha256（收帧字节的等价物）。 */
  wireSha256: string;
  /** 界面侧解析回来的模型结构计数。 */
  structure: FixtureStructure;
  ledgerRows: number;
  summaryRows: number;
  timelineSpans: number;
  timelineBoundaries: number;
  /** `duration` 模式的时间线条数（与 `sequence` 必须一致，不一致就是投影漏记录）。 */
  timelineDurationSpans: number;
  searchEntries: number;
  searchHits: number;
  /** 虚拟窗口绘制计划的项数与其中的真实行数（三档滚动位次合计）。 */
  virtualPlanItems: number;
  virtualRows: number;
  /** **静态计数**：按生产 JSX 分支结构算这一份行表要建多少元素 / 多少字符（不是 React 分配）。 */
  allocationElements: number;
  allocationTextChars: number;
  /** 由模型反推的事件数（折叠代价的输入规模）。 */
  foldEvents: number;
  /** 重建事件计划再跑一次真实 `deriveTrajectoryModel` 得到的记录数。 */
  foldCells: number;
  /** `foldCells` 的性质：**合成下限**（反推事件计划），不是真实宿主折叠。 */
  foldKind: "synthetic-lower-bound";
}

/** 一份夹具的完整量测报告。 */
export interface FixtureBenchReport {
  /** 夹具名（登记里的 `provenance.fixture`）。 */
  fixture: string;
  fixtureBytes: number;
  fixtureSha256: string;
  eligible: boolean;
  reasons: BenchReason[];
  registrationIssues: string;
  /** 夹具自己声明的摘要与降载位（**只是锚点，不是来源认证**）。 */
  provenance: {
    deriveSha256: string;
    sourceSha256: string;
    payloadReduced: boolean;
    payloadMeasurementEligible: boolean;
    derivePinned: boolean;
  };
  /** 与登记复算一致的结构计数。 */
  structure: FixtureStructure;
  /** 端到端指纹：结构计数 + 模型摘要 + 载荷字节数。 */
  fingerprint: string;
  samples: number;
  warmup: number;
  /** 本基准自己的执行序列（证明顺序，不是猜测；**不是**产品实际顺序，见文件头）。 */
  executionOrder: string[];
  /** 顺序执行的真实函数基准：cold（首次触摸，单记）与 warm（预热后一次）各一份逐段原值。 */
  orderedPass: { cold: OrderedPass; warm: OrderedPass };
  /** 重复消费实验的分布（**产品不这么跑**，见文件头）。 */
  isolated: StageTiming[];
  products: ChainProducts;
  /** 未覆盖 / 边界声明。 */
  notes: string[];
}

/**
 * 逐段计时的环节清单。**顺序 = 本基准自己的执行顺序**（不是产品一次实际请求的顺序：
 * `ledger.rows.*` 三档互斥、`fold.rebuild` 是反推合成事件）。
 *
 * 机器可读报告输出 `stage` / `kind` / `branch`；人读摘要给 `measures`。
 */
export const CHAIN_STAGES: readonly {
  stage: string;
  kind: StageKind;
  branch: StageBranch;
  measures: string;
}[] = [
  { stage: "fixture.read", kind: "real-io", branch: "always", measures: "读夹具文件字节（含磁盘 I/O）" },
  { stage: "fixture.parse", kind: "real-function", branch: "always", measures: "夹具 JSON.parse" },
  { stage: "fixture.validate", kind: "real-function", branch: "always", measures: "validateFixturePayload 完整登记校验（成员级 + 自洽重算 + 秘密扫描）" },
  { stage: "model.extract", kind: "real-function", branch: "always", measures: "取出 model 对象（不复制）" },
  { stage: "wire.stringify", kind: "real-function", branch: "always", measures: "JSON.stringify(model) —— 宿主 `{type:'trajectory', json}` 帧的载荷生成" },
  { stage: "wire.hash", kind: "real-function", branch: "always", measures: "对线格式字符串取 sha256" },
  { stage: "wire.parse", kind: "real-function", branch: "always", measures: "JSON.parse(json) —— 界面侧收帧解析" },
  { stage: "model.structure", kind: "real-function", branch: "always", measures: "structureOf 结构计数（对**解析回来**的模型做一次全树遍历）" },
  { stage: "vendor.turns", kind: "real-function", branch: "always", measures: "vendorTurns：本扩展账本 → 官方形状（逐记录字段适配）" },
  { stage: "ledger.ids", kind: "real-function", branch: "always", measures: "逐记录算稳定身份 trajectoryCellRecordId（React key / 折叠键）" },
  { stage: "ledger.rows.default", kind: "real-function", branch: "mutually-exclusive-alternative", measures: "trajectoryLedgerRows（默认：轮次折叠 / 调用折叠 / 搜索优先三档全不启用）" },
  { stage: "ledger.rows.collapsed", kind: "real-function", branch: "mutually-exclusive-alternative", measures: "trajectoryLedgerRows（全部可折叠轮次 + 可折叠调用都收起）——与上面那档互斥" },
  { stage: "ledger.rows.search", kind: "real-function", branch: "mutually-exclusive-alternative", measures: "trajectoryLedgerRows（搜索命中集合非空，折叠一概不参与）——与上面两档互斥" },
  { stage: "timeline.sequence", kind: "real-function", branch: "always", measures: "deriveTrajectoryTimeline（sequence 模式，vendor 投影 + 归一化）" },
  { stage: "timeline.duration", kind: "real-function", branch: "mutually-exclusive-alternative", measures: "deriveTrajectoryTimeline（duration 模式，真实毫秒域 + 扣空闲）——产品上由工具栏开关在两种模式间二选一" },
  { stage: "search.build", kind: "real-function", branch: "always", measures: "TrajectorySearchIndex.update（首次建索引：逐记录重解析 markdown 预览）" },
  { stage: "search.update", kind: "real-function", branch: "always", measures: "TrajectorySearchIndex.update（同一份 layouts 引用，短路返回）" },
  { stage: "search.query", kind: "real-function", branch: "always", measures: "TrajectorySearchIndex.search（分词 AND 扫全表）" },
  { stage: "allocation.plan", kind: "static-count", branch: "always", measures: "按生产 renderRow / renderTurnSummary 的分支结构做**静态计数**（元素 / 字符）——**不是** React 元素分配，也不是 DOM" },
  { stage: "virtual.plan", kind: "real-function", branch: "always", measures: "trajectoryRowPositions + trajectoryWindowPlan（首帧 / 中段 / 末尾三档滚动窗口）" },
  { stage: "fold.rebuild", kind: "synthetic-lower-bound", branch: "always", measures: "把模型**反推**成事件计划再跑一次真实 deriveTrajectoryModel（**合成下限**，不是原事件流，也不代表真实宿主折叠）" },
];

/** 时间源（可注入，便于断言计时真的接上了）。 */
export type TimeSource = () => number;

const defaultTimeSource: TimeSource = () => performance.now();

/**
 * 跑一次完整链路并逐段计时（**本基准自己的顺序**，不是产品一次实际请求的顺序）。
 *
 * @param payload - 已通过资格闸门的 `{ provenance, model }`。
 * @param options - 时间源；给了 `file` 就把「读盘 + JSON.parse + 登记校验」计进 `fixture.*`。
 * @returns 逐段原值、总时长、产物、以及**实际执行顺序**。
 */
export function runChainOnce(
  payload: { provenance: Record<string, unknown>; model: TrajectoryModel },
  options: { now?: TimeSource; file?: string } = {},
): { stages: Record<string, number>; totalMs: number; products: ChainProducts; order: string[] } {
  const now = options.now ?? defaultTimeSource;
  const durations: Record<string, number> = {};
  const order: string[] = [];
  const timed = <T>(stage: string, run: () => T): T => {
    if (!order.includes(stage)) order.push(stage);
    const start = now();
    const value = run();
    durations[stage] = now() - start;
    return value;
  };
  // 夹具三层（读盘 / 解析 / 登记校验）也落在链上：真实链路的入口就是「拿一份脱敏夹具」。
  let effective: { provenance: Record<string, unknown>; model: TrajectoryModel } = payload;
  if (options.file !== undefined) {
    const file = options.file;
    const raw = timed("fixture.read", () => readFileSync(file));
    const parsedPayload = timed("fixture.parse", () => JSON.parse(raw.toString("utf8")) as unknown);
    timed("fixture.validate", () => validateFixturePayload(parsedPayload, {
      sha256Hex,
      digestPaths: [...DIGEST_WHITELIST],
      expectedChecks: [...FIXTURE_INVARIANT_CODES],
    }));
    effective = parsedPayload as { provenance: Record<string, unknown>; model: TrajectoryModel };
  }
  const texts = trajectoryTexts("zh");
  const extracted = timed("model.extract", () => effective.model);

  const wireJson = timed("wire.stringify", () => JSON.stringify(extracted));
  const wireSha256 = timed("wire.hash", () => sha256Hex(wireJson));
  const wireBytes = wireJson.length === 0 ? 0 : Buffer.byteLength(wireJson, "utf8");
  const parsed = timed("wire.parse", () => JSON.parse(wireJson) as TrajectoryModel);
  const structure = timed("model.structure", () => structureOf(parsed));

  const officialTurns = timed("vendor.turns", () => vendorTurns(parsed.turns, (title) => trajectoryGroupTitle(title, texts)));
  const flat = parsed.turns.flatMap(trajectoryTurnCells);
  timed("ledger.ids", () => flat.map((cell) => trajectoryCellRecordId(cell)));

  // 折叠集合按生产同一套判据现算（界面里由 `trajectoryCollapsible*` 给出）。
  const collapsibleTurns = new Set<number>();
  for (const turn of parsed.turns) {
    if (turn.turn === null) continue;
    const content = trajectoryTurnCells(turn).filter((cell) => cell.requestOnly !== true && cell.kind !== "system");
    if (content.length > 1) collapsibleTurns.add(turn.turn);
  }
  const collapsibleCalls = new Set<string>();
  for (let position = 0; position < flat.length - 1; position += 1) {
    const cell = flat[position];
    const next = flat[position + 1];
    if (cell === undefined || next === undefined) continue;
    if (cell.kind === "message" && (next.kind === "tool" || next.kind === "subtool")) {
      collapsibleCalls.add(trajectoryCellRecordId(cell));
    }
  }
  const matchIndexes = new Set<number>(flat.filter((cell) => cell.kind === "message").map((cell) => cell.index));

  const rowsDefault = timed("ledger.rows.default", () =>
    trajectoryLedgerRows({ turns: parsed.turns, collapsedTurns: new Set<number>(), collapsedCalls: new Set<string>(), matchIndexes: null }));
  timed("ledger.rows.collapsed", () =>
    trajectoryLedgerRows({ turns: parsed.turns, collapsedTurns: collapsibleTurns, collapsedCalls: collapsibleCalls, matchIndexes: null }));
  timed("ledger.rows.search", () =>
    trajectoryLedgerRows({ turns: parsed.turns, collapsedTurns: collapsibleTurns, collapsedCalls: collapsibleCalls, matchIndexes }));

  const timelineSequence = timed("timeline.sequence", () => deriveTrajectoryTimeline(parsed.turns, "sequence"));
  const timelineDuration = timed("timeline.duration", () => deriveTrajectoryTimeline(parsed.turns, "duration"));

  const index = new TrajectorySearchIndex();
  const layouts = [officialTurns] as const;
  timed("search.build", () => index.update(layouts));
  timed("search.update", () => index.update(layouts));
  const hits = timed("search.query", () => index.search(searchQuery()));

  const allocation = timed("allocation.plan", () => allocationPlan(rowsDefault));
  const virtualItems = timed("virtual.plan", () => virtualPlan(flat, rowsDefault));
  const fold = timed("fold.rebuild", () => rebuildFold(parsed));

  return {
    stages: durations,
    totalMs: Object.values(durations).reduce((sum, value) => sum + value, 0),
    order,
    products: {
      modelSha256: sha256Hex(canonicalJson(parsed)),
      wireBytes,
      wireSha256,
      structure,
      ledgerRows: rowsDefault.length,
      summaryRows: rowsDefault.filter((row) => row.summary === "turn").length,
      timelineSpans: timelineSequence.spans.length,
      timelineBoundaries: timelineSequence.boundaries.length,
      timelineDurationSpans: timelineDuration.spans.length,
      searchEntries: indexEntryCount([officialTurns]),
      searchHits: hits?.size ?? 0,
      virtualPlanItems: virtualItems.items,
      virtualRows: virtualItems.rows,
      allocationElements: allocation.elements,
      allocationTextChars: allocation.textChars,
      foldEvents: fold.events,
      foldCells: fold.cells,
      foldKind: "synthetic-lower-bound",
    },
  };
}

/** 代表性查询串：固定词，保证有命中面且不随载荷内容变化。 */
export function searchQuery(): string {
  return "assistant";
}

/** 索引能吃的**最小形状**（只读 `groups[].cells[].requestOnly`，不依赖具体模型类型）。 */
export interface IndexableTurn {
  groups: readonly { cells: readonly { requestOnly?: boolean }[] }[];
}

/**
 * 索引条目数：官方类不暴露条数，按它自己的入库规则数一遍（`requestOnly` 行不入库）。
 * 只用于**一致性核对**，不进计时区间。
 */
export function indexEntryCount(layouts: readonly (readonly IndexableTurn[])[]): number {
  let count = 0;
  for (const turns of layouts) {
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const cell of group.cells) if (cell.requestOnly !== true) count += 1;
      }
    }
  }
  return count;
}

/**
 * **静态计数**：按生产 `allRows` 的 JSX 分支结构数这一份行表要建多少元素 / 多少字符。
 *
 * **它不是 React 元素分配**：这里一行都不画，只是把「真渲染时会走哪些分支」算一遍。
 * 真实元素分配、commit 与 DOM 由浏览器阶段量（`scripts/trajectoryPayloadBenchBrowser.ts`）。
 */
export function allocationPlan(
  rows: readonly { record?: TrajectoryCell; summary?: "turn" | "assistant" }[],
): { elements: number; textChars: number } {
  let elements = 0;
  let textChars = 0;
  for (const row of rows) {
    if (row.summary === "turn") {
      // 摘要行：tr + 两个 td + 标签 span + 两枚内层 span + 内容格文本
      elements += 7;
      textChars += 40;
      continue;
    }
    const cell = row.record;
    if (cell === undefined) continue;
    elements += 3; // tr + 2 td
    elements += 8; // 事件格：轮次标签（外层 + 两枚内层）、index、running 点、kind 徽章 + 图标 + 文字
    textChars += 8;
    if (cell.requestNumber !== undefined) elements += 1; // 请求边界按钮
    elements += 1; // 内容格主文本
    textChars += (cell.text ?? "").length;
    if (cell.result !== undefined || cell.resultPreviewMarkdown !== undefined) {
      elements += 2; // 箭头 + 结果
      textChars += (cell.result ?? cell.resultPreviewMarkdown ?? "").length;
    }
  }
  return { elements, textChars };
}

/** 虚拟窗口三档滚动位次下的计划规模（首帧 / 中段 / 末尾）。 */
function virtualPlan(cells: readonly TrajectoryCell[], rows: readonly { cellIndex: number }[]): { items: number; rows: number } {
  const rowCount = rows.length;
  const pinned = trajectoryRowPositions(
    rows,
    [cells[0]?.index ?? -1, cells[cells.length - 1]?.index ?? -1].filter((value) => value > 0),
  );
  const variants = [0, Math.max(0, Math.floor(rowCount / 2)), Math.max(0, rowCount - 20)];
  let items = 0;
  let rendered = 0;
  for (const scrollTop of variants) {
    const plan = trajectoryWindowPlan({
      rowCount,
      hasOlder: false,
      scrollTop,
      viewportHeight: 600,
      rowHeight: VIRTUAL_ROW_HEIGHT,
      pinned,
    });
    items += plan.items.length;
    rendered += plan.items.filter((item) => item.kind === "row").length;
  }
  return { items, rows: rendered };
}

/**
 * 把模型反推成**事件计划**，再跑一次真实 `deriveTrajectoryModel`。
 *
 * **边界**：夹具只存派生后的模型，所以这不是原事件流，而是「每个 cell 至少由哪几类事件
 * 产生」的重建；它给的是折叠代价的**下限**与一条真实调用路径，不是原样重折的证明。
 */
export function rebuildFold(model: TrajectoryModel): { events: number; cells: number } {
  const events: SessionWireEvent[] = [];
  let seq = 0;
  const base = model.firstStartedAt ?? Date.UTC(2026, 0, 1);
  const push = (type: string, time: number, data: Record<string, unknown>): void => {
    events.push({ type, seq: seq++, time, data } as SessionWireEvent);
  };
  for (const turn of model.turns) {
    const turnId = turn.turn ?? 1;
    push("turn/start", base, { turn: turnId });
    for (const group of turn.groups) {
      const step = group.title.kind === "step" ? group.title.step : 1;
      push("step/start", base, { turn: turnId, step });
      for (const cell of group.cells) {
        push(cell.kind === "user" || cell.kind === "context" ? "user/message" : "assistant/message", cell.time, {
          turn: turnId,
          step,
          ...(cell.kind === "message"
            ? { message: { id: `bench-${cell.index}`, role: "assistant", source: {}, content: [{ type: "text", text: cell.text }] } }
            : {}),
        });
      }
    }
    push("turn/end", base, { turn: turnId, reason: { kind: "completed" } });
  }
  const derived = deriveTrajectoryModel(events, false);
  return { events: events.length, cells: derived.cellCount };
}

/** 最小/中位/最近秩 p95/max，以及**整组 raw 样本**。 */
export function summarizeSamples(
  stage: string,
  kind: StageKind,
  branch: StageBranch,
  measures: string,
  samplesMs: readonly number[],
): StageTiming {
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const pick = (rank: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
  return {
    stage,
    kind,
    branch,
    measures,
    samplesMs: [...samplesMs],
    minMs: pick(0),
    medianMs: pick(Math.floor((sorted.length - 1) / 2)),
    p95Ms: pick(Math.ceil(0.95 * sorted.length) - 1),
    maxMs: pick(sorted.length - 1),
  };
}

/** 端到端指纹：结构计数 + 模型摘要 + 载荷字节数（任一漂移都会换指纹）。 */
export function fingerprintOf(structure: FixtureStructure, modelSha256: string, wireBytes: number): string {
  return sha256Hex(canonicalJson({ structure, modelSha256, wireBytes })).slice(0, 16);
}

// ───────────────────────────── 读夹具 ─────────────────────────────

/**
 * 读一份夹具文件并解析。**只读普通文件**，任何 I/O 异常都收敛成 `undefined`
 * （异常原文可能带本机路径与内容）。
 */
export function readFixtureFile(path: string): { bytes: number; sha256: string; payload: unknown } | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    const raw = readFileSync(path);
    const payload = JSON.parse(raw.toString("utf8")) as unknown;
    return { bytes: raw.length, sha256: sha256Hex(raw.toString("utf8")), payload };
  } catch {
    return undefined;
  }
}

/** 夹具名（登记里的 `provenance.fixture`）；取不到给空串。 */
export function fixtureNameOf(payload: unknown): string {
  const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as { provenance?: unknown }).provenance
    : undefined;
  const name = record !== null && typeof record === "object" && !Array.isArray(record)
    ? (record as { fixture?: unknown }).fixture
    : undefined;
  return typeof name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(name) ? name : "";
}

// ───────────────────────────── 量测 ─────────────────────────────

/**
 * 量一份夹具（给 `file` 就每份样本重新读盘，夹具三层计入链路）。
 *
 * @param input - `payload` 必给；`file` 给了才是「从磁盘来的」那条路径。
 * @param options - 样本数 / 预热次数 / 期望的 derive 摘要 / 时间源。
 */
export function measureFixturePayload(
  input: { payload: unknown; file?: string },
  options: { samples: number; warmup: number; expectDeriveSha256?: string; now?: TimeSource },
): FixtureBenchReport {
  const now = options.now ?? defaultTimeSource;
  const qualification = qualifyFixturePayload(input.payload, {
    ...(options.expectDeriveSha256 === undefined ? {} : { expectDeriveSha256: options.expectDeriveSha256 }),
  });
  const meta = input.file === undefined
    ? { bytes: 0, sha256: "" }
    : readFixtureFile(input.file) ?? { bytes: 0, sha256: "", payload: undefined };
  const record = input.payload as { provenance: Record<string, unknown>; model: TrajectoryModel };
  const provenance = record !== null && typeof record === "object" && record.provenance !== null
    && typeof record.provenance === "object" && !Array.isArray(record.provenance)
    ? record.provenance
    : undefined;
  const derive = provenance?.derive;
  const deriveSha256 = derive !== null && typeof derive === "object" && !Array.isArray(derive)
    ? String((derive as { sha256?: unknown }).sha256 ?? "")
    : "";
  const name = fixtureNameOf(input.payload);
  const base: FixtureBenchReport = {
    fixture: name === "" ? "unnamed" : name,
    fixtureBytes: meta.bytes,
    fixtureSha256: meta.sha256,
    eligible: qualification.eligible,
    reasons: qualification.reasons,
    registrationIssues: qualification.registrationIssues,
    provenance: {
      deriveSha256,
      sourceSha256: typeof provenance?.sourceSha256 === "string" ? provenance.sourceSha256 : "",
      payloadReduced: provenance?.payloadReduced === true,
      payloadMeasurementEligible: provenance?.payloadMeasurementEligible === true,
      derivePinned: qualification.derivePinned,
    },
    structure: structureOf(record.model),
    fingerprint: "",
    samples: options.samples,
    warmup: options.warmup,
    executionOrder: [],
    orderedPass: { cold: { totalMs: 0, stagesMs: {} }, warm: { totalMs: 0, stagesMs: {} } },
    isolated: [],
    products: emptyProducts(),
    notes: [],
  };
  if (!qualification.eligible) return base;

  const chainOptions = { now, ...(input.file === undefined ? {} : { file: input.file }) };
  // cold 首次触摸：**单记**，不进统计（首帧整份载荷的真实代价）。
  const cold = runChainOnce(record, chainOptions);
  base.orderedPass.cold = { totalMs: cold.totalMs, stagesMs: cold.stages };
  base.executionOrder = cold.order;
  for (let round = 0; round < options.warmup; round += 1) runChainOnce(record, chainOptions);

  // isolated：每阶段各跑 samples 次（**重复消费实验**，产品不这么跑）。
  const collected = new Map<string, number[]>();
  for (const stage of CHAIN_STAGES) collected.set(stage.stage, []);
  let warm = cold;
  for (let sample = 0; sample < options.samples; sample += 1) {
    warm = runChainOnce(record, chainOptions);
    for (const stage of CHAIN_STAGES) {
      const value = warm.stages[stage.stage];
      if (typeof value === "number" && Number.isFinite(value)) collected.get(stage.stage)?.push(value);
    }
  }
  base.orderedPass.warm = { totalMs: warm.totalMs, stagesMs: warm.stages };
  base.isolated = CHAIN_STAGES.map((stage) =>
    summarizeSamples(stage.stage, stage.kind, stage.branch, stage.measures, collected.get(stage.stage) ?? []));
  base.products = warm.products;
  base.fingerprint = fingerprintOf(warm.products.structure, warm.products.modelSha256, warm.products.wireBytes);
  base.notes = [
    "orderedPass.cold 是首次触摸的单次原值；orderedPass.warm 是预热后的一次原值——两者都是**顺序执行的真实函数**各跑一遍，**不是产品一次实际请求的顺序**。",
    "顺序执行里含互斥分支：ledger.rows 三档与 timeline 两种模式在产品上各自二选一/三选一，本基准为让每段都有读数把它们全跑了（`branch: mutually-exclusive-alternative`）。",
    "isolated 是**重复消费实验**：同一份载荷按阶段各跑 samples 次取分布（`samplesMs` 是整组 raw 样本）；产品不会这么跑，别把它当一次请求的耗时。",
    "p95 用最近秩定义（见文件头），n=11 时 p95 === max，不表示尾部百分位。",
    "allocation.plan 是按生产 JSX 分支结构做的静态计数，**不是** React 元素分配，也不是 DOM。",
    "fold.rebuild 由模型**反推**事件计划再跑真实 deriveTrajectoryModel：`kind: synthetic-lower-bound`，是合成下限，不是原事件流重折、也不代表真实宿主折叠。",
    "search.build 的首次建索引包含 markdown 预览重解析；search.update 是同一 layouts 引用的短路路径。",
    "绿灯只说明这份载荷与登记自洽、且声明未降载：**不代表来源真实、不代表等于真实全历史**。",
    "浏览器整链路（真实收帧字节 / 索引 / allRows 元素分配 / 首次 commit / 连续滚动帧）本阶段未运行。",
  ];
  return base;
}

function emptyProducts(): ChainProducts {
  return {
    modelSha256: "",
    wireBytes: 0,
    wireSha256: "",
    structure: { turns: 0, groups: 0, cells: 0, requests: 0, kinds: {}, seqRange: null, seqCount: 0, modelJsonBytes: 0 },
    ledgerRows: 0,
    summaryRows: 0,
    timelineSpans: 0,
    timelineBoundaries: 0,
    timelineDurationSpans: 0,
    searchEntries: 0,
    searchHits: 0,
    virtualPlanItems: 0,
    virtualRows: 0,
    allocationElements: 0,
    allocationTextChars: 0,
    foldEvents: 0,
    foldCells: 0,
    foldKind: "synthetic-lower-bound",
  };
}

// ───────────────────────────── CLI 结果（纯函数，不写 IO） ─────────────────────────────

/** 一次 CLI 调用的结果：文本与退出码，由 OS 入口负责写与退。 */
export interface BenchCliOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 机器可读报告的形状（`--json` 与 `--out` 共用）。 */
export interface BenchMachineReport {
  tool: "trajectory-payload-bench";
  version: 1;
  node: string;
  platform: string;
  arch: string;
  samples: number;
  warmup: number;
  p95Definition: string;
  fixtures: readonly FixtureBenchReport[];
}

/** 一条拒测记录：第几份夹具 + 原因。 */
export interface BenchRefusal {
  ordinal: number;
  reason: BenchReason;
}

/**
 * 拒测文本（中英两套，逐条列出原因）。
 *
 * **emit-browser 与 measure 共用这一份**：同一个资格闸门、同一套话术，
 * 不允许浏览器工件那条路自己造一套（那正是它先前能绕过闸门的地方）。
 */
export function refusalText(refusals: readonly BenchRefusal[]): string {
  let stderr = "";
  for (const refusal of refusals) {
    const [zh, en] = benchLines(reasonKey(refusal.reason.code), {
      ordinal: refusal.ordinal,
      detail: refusal.reason.detail ?? "",
    });
    stderr += `${zh}\n${en}\n`;
  }
  return stderr;
}

/**
 * 量测一次（给已解析的选项），返回退出码 / 文本 / **报告对象**。
 *
 * 纯函数：不 `process.exit`、不直接写 stdout / stderr、不落盘（`--out` 由 OS 入口写），
 * 因此测试可以直接调用并断言 `reports`。
 */
export function runMeasure(options: BenchOptions): {
  outcome: BenchCliOutcome;
  reports: FixtureBenchReport[];
} {
  if (options.fixtures.length === 0) {
    const [zh, en] = benchLines("fixtureMissing");
    return { outcome: { exitCode: BENCH_EXIT.usage, stdout: "", stderr: `${zh}\n${en}\n` }, reports: [] };
  }
  const seen = new Set<string>();
  const reports: FixtureBenchReport[] = [];
  for (let index = 0; index < options.fixtures.length; index += 1) {
    const ordinal = index + 1;
    const absolute = resolve(options.fixtures[index] as string);
    // 重复路径：**不静默重复计样**，整轮拒测。
    if (seen.has(absolute)) {
      const [zh, en] = benchLines("fixtureDuplicate", { ordinal });
      return { outcome: { exitCode: BENCH_EXIT.refused, stdout: "", stderr: `${zh}\n${en}\n` }, reports: [] };
    }
    seen.add(absolute);
    const read = readFixtureFile(absolute);
    if (read === undefined) {
      const [zh, en] = benchLines("fixtureUnreadable", { ordinal });
      return { outcome: { exitCode: BENCH_EXIT.usage, stdout: "", stderr: `${zh}\n${en}\n` }, reports: [] };
    }
    try {
      reports.push(measureFixturePayload({ payload: read.payload, file: absolute }, {
        samples: options.samples,
        warmup: options.warmup,
        ...(options.expectDeriveSha256 === undefined ? {} : { expectDeriveSha256: options.expectDeriveSha256 }),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.name : "unknown";
      const [zh, en] = benchLines("stageThrew", { ordinal, stage: "chain", error: message });
      return { outcome: { exitCode: BENCH_EXIT.refused, stdout: "", stderr: `${zh}\n${en}\n` }, reports: [] };
    }
  }
  const refused = reports.filter((report) => !report.eligible);
  if (refused.length > 0) {
    const refusals: BenchRefusal[] = [];
    for (const report of refused) {
      const ordinal = reports.indexOf(report) + 1;
      for (const reason of report.reasons) refusals.push({ ordinal, reason });
    }
    return { outcome: { exitCode: BENCH_EXIT.refused, stdout: "", stderr: refusalText(refusals) }, reports };
  }
  return { outcome: { exitCode: BENCH_EXIT.ok, stdout: reportText(reports, options), stderr: "" }, reports };
}

/**
 * 量测入口：给 argv，返回 `{ exitCode, stdout, stderr }`。
 *
 * 浏览器工件模式在这里**不执行**（由 OS 入口经 `parseBenchInvocation` 分派）。
 */
export function runBenchCli(argv: readonly string[]): BenchCliOutcome {
  const invocation = parseBenchInvocation(argv);
  if (invocation.kind === "usage") {
    const [zh, en] = benchLines(invocation.error.key, invocation.error.params);
    const [usageZh, usageEn] = benchLines("usage");
    const withUsage = invocation.error.key === "usage" ? `${zh}\n${en}\n` : `${zh}\n${en}\n${usageZh}\n${usageEn}\n`;
    return { exitCode: BENCH_EXIT.usage, stdout: "", stderr: withUsage };
  }
  if (invocation.kind !== "measure") {
    const [zh, en] = benchLines("browserHandledByEntry");
    return { exitCode: BENCH_EXIT.usage, stdout: "", stderr: `${zh}\n${en}\n` };
  }
  return runMeasure(invocation.options).outcome;
}

/** 拒测原因 → 文案键。 */
export function reasonKey(code: BenchReason["code"]): BenchMessageKey {
  switch (code) {
    case "payload-reduced": return "disqualifyPayloadReduced";
    case "not-measurement-eligible": return "disqualifyNotEligible";
    case "truncated-fields-not-empty": return "disqualifyTruncatedFields";
    case "registration-invalid": return "disqualifyRegistration";
    case "derive-sha-mismatch": return "disqualifyDeriveSha";
    case "model-shape-invalid": return "disqualifyModelShape";
    default: return "disqualifyRegistration";
  }
}

/** 机器可读报告（**不含任何路径**）。 */
export function machineReport(reports: readonly FixtureBenchReport[], options: BenchOptions): BenchMachineReport {
  return {
    tool: "trajectory-payload-bench",
    version: 1,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    samples: options.samples,
    warmup: options.warmup,
    p95Definition: "nearest-rank: sorted[ceil(0.95*n)-1]; with n=11 p95 === max",
    fixtures: reports,
  };
}

/** 人读 + 机器可读的完整 stdout 文本。 */
export function reportText(reports: readonly FixtureBenchReport[], options: BenchOptions): string {
  let text = "";
  for (const report of reports) {
    text += `fixture: ${report.fixture}\n`;
    text += `  payload bytes=${report.products.wireBytes} model sha256=${report.products.modelSha256}\n`;
    text += `  structure: turns=${report.structure.turns} groups=${report.structure.groups} cells=${report.structure.cells} requests=${report.structure.requests} seqRange=${JSON.stringify(report.structure.seqRange)}\n`;
    text += `  fingerprint=${report.fingerprint} eligible=${report.eligible} derivePinned=${report.provenance.derivePinned} derive.sha256=${report.provenance.deriveSha256}\n`;
    text += `  orderedPass cold total=${report.orderedPass.cold.totalMs.toFixed(4)}ms warm total=${report.orderedPass.warm.totalMs.toFixed(4)}ms\n`;
    text += "  execution order (bench order, NOT one real product request): " + report.executionOrder.join(" → ") + "\n";
    text += "  cold (ms, one ordered pass of real functions): " + JSON.stringify(report.orderedPass.cold.stagesMs) + "\n";
    text += "  warm (ms, one ordered pass of real functions): " + JSON.stringify(report.orderedPass.warm.stagesMs) + "\n";
    text += "  isolated (repeated-consumption experiment; NOT one product pass; samplesMs holds the raw samples)\n";
    text += "  stage                    kind                   branch                            min      median   p95      max      n\n";
    for (const stage of report.isolated) {
      text += `  ${stage.stage.padEnd(24)} ${stage.kind.padEnd(22)} ${stage.branch.padEnd(33)} ${stage.minMs.toFixed(4).padStart(9)} ${stage.medianMs.toFixed(4).padStart(9)} ${stage.p95Ms.toFixed(4).padStart(9)} ${stage.maxMs.toFixed(4).padStart(9)} ${String(stage.samplesMs.length).padStart(3)}\n`;
    }
    text += `  ledgerRows=${report.products.ledgerRows} summaryRows=${report.products.summaryRows} timeline spans=${report.products.timelineSpans}/${report.products.timelineDurationSpans} boundaries=${report.products.timelineBoundaries}\n`;
    text += `  search entries=${report.products.searchEntries} hits=${report.products.searchHits} virtual plan items=${report.products.virtualPlanItems} rows=${report.products.virtualRows}\n`;
    text += `  static allocation count (NOT React allocation): elements=${report.products.allocationElements} textChars=${report.products.allocationTextChars}\n`;
    for (const note of report.notes) text += `  · ${note}\n`;
  }
  const [zh, en] = benchLines("measured", { fixtures: reports.length, samples: options.samples });
  text += `${zh}\n${en}\n`;
  const [nbZh, nbEn] = benchLines("notRunBrowser");
  text += `${nbZh}\n${nbEn}\n`;
  if (options.json) text += `${JSON.stringify(machineReport(reports, options), null, 2)}\n`;
  return text;
}
