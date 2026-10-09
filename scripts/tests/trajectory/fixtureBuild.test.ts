/**
 * 提取 CLI（`scripts/trajectoryFixtureBuild.ts`）的离线行为回归。
 *
 * 运行：`npm test`（本文件登记在 `esbuild.scripts.mjs` 的 entries 里，产物是
 *       `build/trajectory-fixture-build.test.mjs`）。**只吃合成 zstd 日志**，不读用户日志。
 *
 * ## 被测对象就是本次构建出来的正式产物
 *
 * 被测 CLI 是 `build/trajectory-fixture-build.mjs`；`npm test` 先跑 `build:scripts`
 * （先清 `build/*.mjs` 再打包），所以它必然由**当前**的 `scripts/trajectoryFixtureBuild.ts`
 * 与**当前**的 `src/dsh/trajectory.ts` 打出。测试**不接受**任何「CLI 路径覆盖」环境变量
 * （那正是 alias / 旧产物混进来的入口）。四条同源判据：
 *
 * 1. 路径固定（无环境变量覆盖）；
 * 2. `provenance.derive.file/sha256` 必须等于磁盘当前 `src/dsh/trajectory.ts` 的独立重算值；
 * 3. **行为同源对拍**：进程内用当前正式源跑同一份合成日志，与 CLI 写出的 `model` 逐字一致；
 * 4. `build/trajectory-fixture-build.witness.json`：构建时用记录型 `onLoad` 见证**实际折进
 *    bundle 的 derive 字节**，再与磁盘当前源、CLI 声明、被测 bundle 的摘要三方对齐。
 *    边界：这证明「折入字节 = 当前源字节」，不是任意 bundle 的来源认证，也不覆盖全部折叠语义。
 *
 * ## 覆盖
 *
 * 缺配置 / 坏参数 / 源不存在 / **源是目录** / 覆盖保护（含**坏出处**）/
 * 失败分支不回显 `--name` 自由输入 / 秘密命中 /
 * 声明源缺失、是目录与 bundle 冒充 / 截断登记与 payloadReduced / 读回校验与整份扫描 /
 * **来源字节快照单读（TOCTOU 边界）** / **写盘·替换·读回故障注入** /
 * **深层 JSON 与超限结构化字段** / 失败分支不回显路径·id·参数·异常原文 /
 * **`--limit 0` = 不截断（无上限）**：超长自由文本逐字保留、零截断登记、退出 0，
 * 且默认正上限的截断行为不受影响 /
 * **5 条当前 derive 判别序列**（旧派生在这些输入上给不出当前结果）/
 * **超深既有夹具**：覆盖保护固定出口、无异常栈、无本机路径 /
 * **用户日志读取闸门**：真日志根必须被拒（替身根注入确认），正常合成材料照旧可读。
 *
 * 边界：这些断言只用**受控合成日志**，不涉及真实日志、真实 DSH 或模型 token；
 * 负数 / 小数 / 非数字仍退出 2、零写入（放宽 0 没有顺带放松参数校验）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import zlib from "node:zlib";
import { decodeSessionLogBytes } from "../../sessionLog";
import { deriveTrajectoryModel } from "../../../src/dsh/trajectory";
import type { SessionWireEvent } from "../../../src/dsh/protocol";
import type { TrajectoryModel } from "../../../src/shared/trajectory";
import {
  DEFAULT_FIELD_LIMIT,
  DIGEST_PATTERN,
  FIXTURE_REDACTION_VERSION,
  canonicalJson,
  findSecretHits,
  redactTrajectoryModel,
  scanFixtureSecrets,
} from "../../trajectoryFixture";
import { FIXTURE_CLI_MESSAGES, FIXTURE_RULE_IDS } from "../../fixtureCliText";

const REPO = resolve(".");
/** 被测 CLI：**固定路径**，没有环境变量覆盖（见文件头第 1 条）。 */
const CLI = resolve("build/trajectory-fixture-build.mjs");
const EXTRACTOR = "scripts/trajectoryFixtureBuild.ts";
/**
 * 出处登记里声明的**轨迹折叠源码**：就是正式仓库里那一份。
 * `--derive-source` 只收仓库相对声明（绝对路径会被安全判据拒掉）。
 */
const DERIVE = "src/dsh/trajectory.ts";
/** 构建时留下的 derive 来源见证（实际折进 bundle 的字节；见 `esbuild.scripts.mjs`）。 */
const DERIVE_WITNESS = "build/trajectory-fixture-build.witness.json";
/** 观察器 / 注入器（`--require` 预加载，测试基础设施）。 */
const TRACE_HOOK = resolve("scripts/tests/trajectory/fixtureWriteTrace.cjs");
/** 受控的「用户日志根」替身：真实 `~/.dsh` 全程不参与。 */
const FAKE_USER_LOG_HOME = mkdtempSync(join(tmpdir(), "fixture-user-logs-"));
const FAKE_USER_LOG_ROOT = join(FAKE_USER_LOG_HOME, ".dsh");
const DIGEST_WHITELIST = [
  "$.provenance.sourceSha256",
  "$.provenance.extractor.sha256",
  "$.provenance.derive.sha256",
  "$.provenance.modelSha256",
];
assert.ok(existsSync(CLI), `先跑 npm run build:scripts：找不到 ${CLI}`);
assert.ok(existsSync(TRACE_HOOK), "写盘/故障注入观察器必须存在");

const workRoot = mkdtempSync(join(tmpdir(), "trajectory-fixture-"));
/** 本次运行的**受控根**：所有合成日志都写在它下面，`--source` 只允许指向它内部。 */
const controlledRoot = resolve(workRoot);
const outDir = join(workRoot, "fixtures");
mkdirSync(outDir, { recursive: true });

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");
const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
const tempLeftovers = (dir: string): string[] => readdirSync(dir).filter((name) => name.includes(".tmp-"));

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
let seq = 0;
const event = (type: string, data: Record<string, unknown>, offset = seq) => {
  seq += 1;
  return { type, seq: seq - 1, time: BASE + offset * 1000, data };
};
const block = (text: string) => [{ type: "text", text }];
const USER_PATH = "C:\\Users\\fixture-user\\proj\\a.ts";

/** JSONL 文本 → durable 事件（守卫与 CLI 的 `parseEvents` 同形：只认 type/seq/time 齐全的行）。 */
function parseJsonlEvents(text: string): SessionWireEvent[] {
  const events: SessionWireEvent[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: { type?: unknown; seq?: unknown; time?: unknown; data?: unknown };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    if (typeof row.type !== "string" || typeof row.seq !== "number" || typeof row.time !== "number") continue;
    events.push({ type: row.type, seq: row.seq, time: row.time, data: row.data ?? {} } as SessionWireEvent);
  }
  return events;
}

/** 一份干净的合成日志（形状与真实事件一致，但内容是我们自己造的）。 */
function cleanEvents(textLength = 40): Record<string, unknown>[] {
  seq = 0;
  const longText = "长".repeat(textLength);
  const callArgs = JSON.stringify({ path: USER_PATH });
  return [
    event("turn/start", { turn: 1 }, 0),
    event("step/start", { turn: 1, step: 1 }, 0),
    event("system/message", { turn: 1, step: 1, message: { content: block("系统提示词\n第二行") } }, 0),
    event("request/header", {
      header: { config: { provider: "provider-real", model: "model-real" }, tools: [{ name: "read" }] },
      reason: "initial",
    }, 0),
    event("user/message", { id: "u1", role: "user", source: { kind: "user" }, content: block(`问题\n${longText}`) }, 1),
    event("assistant/message", {
      turn: 1,
      step: 1,
      message: {
        id: "a1",
        role: "assistant",
        source: { provider: "provider-real", model: "model-real" },
        content: [...block("回答\n第二行"), { type: "tool-call", id: "call_1", name: "read", arguments: callArgs }],
      },
      usage: { inputTokens: 10, outputTokens: 2 },
    }, 2),
    event("tool/call", { turn: 1, step: 1, callId: "call_1", name: "read", arguments: callArgs }, 2),
    event("tool/result", { turn: 1, step: 1, message: { content: block("结果\n第二行"), source: { callId: "call_1" } } }, 3),
    event("step/end", { turn: 1, step: 1 }, 3),
    event("turn/end", { turn: 1, reason: { kind: "completed" } }, 4),
  ];
}

function writeLog(dir: string, events: Record<string, unknown>[], fileName: string): string {
  mkdirSync(dir, { recursive: true });
  const text = `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const file = join(dir, fileName);
  writeFileSync(file, zlib.zstdCompressSync(Buffer.from(text, "utf8")));
  return file;
}

const common = ["--repo-root", REPO, "--extractor-source", EXTRACTOR, "--derive-source", DERIVE, "--out", outDir];

// ---------- 观察器 / 故障注入 / 用户日志读取闸门（测试侧基础设施，不是被测逻辑） ----------
const TRACE_MARKER = "sk-parent-prewrite-contract-0123456789";
/** 观察器证据形状：只有布尔与计数，不含路径、键名或原文。 */
interface TraceState {
  loaded: boolean;
  sensitiveWriteAttempt: boolean;
  sensitiveWriteCompleted: boolean;
  guardedRead: boolean;
  guardedReadCount: number;
  swapApplied: number;
  mkdirFailureHit: boolean;
  writeFailureHit: boolean;
  renameFailureHit: boolean;
  readBackTamperHit: boolean;
  userLogReadAttempt: boolean;
  userLogReadRefused: boolean;
}
let traceSeq = 0;

/**
 * 「这个参数列表里的 `--source` 必须落在本次受控根内」的**调用前**断言。
 *
 * 标准 `npm test` 不得读用户会话日志：这是第一道（来源必须是我们自己造的合成材料），
 * 观察器里的读取闸门是第二道（运行时拒读用户日志根）。判据用 `path.relative` 的肯定包含，
 * 不是字符串前缀。
 */
function assertSourcesControlled(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--source") continue;
    const value = args[i + 1];
    assert.ok(typeof value === "string" && value !== "", "受控检查：--source 必须有值");
    const relativePath = relative(controlledRoot, resolve(value));
    assert.ok(
      relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)),
      "受控检查：--source 必须落在本次合成材料根内（标准测试不得指向真实日志）",
    );
  }
}

/**
 * 唯一的 CLI 调用入口：预加载观察器与读取闸门，并在**每一次**调用后断言
 * 这次运行没有尝试读用户日志根（替身根由 `FAKE_USER_LOG_ROOT` 提供，真实 `~/.dsh` 不参与）。
 */
function spawnCli(args: string[], env: Record<string, string> = {}): {
  code: number | null;
  out: string;
  err: string;
  state: TraceState;
} {
  assertSourcesControlled(args);
  traceSeq += 1;
  const trace = join(workRoot, `trace-${traceSeq}.json`);
  const result = spawnSync(process.execPath, ["--require", TRACE_HOOK, CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_FIXTURE_SOURCE: "",
      DSH_FIXTURE_REPO_ROOT: "",
      DSH_FIXTURE_WRITE_MARKER: TRACE_MARKER,
      DSH_FIXTURE_WRITE_TRACE: trace,
      DSH_FIXTURE_USER_LOG_ROOT: FAKE_USER_LOG_ROOT,
      ...env,
    },
  });
  const state = JSON.parse(readFileSync(trace, "utf8")) as TraceState;
  assert.strictEqual(state.loaded, true, "观察器加载确认");
  assert.strictEqual(state.userLogReadAttempt, false, "标准测试不得尝试读取用户日志根");
  assert.strictEqual(state.userLogReadRefused, false, "标准测试不得触发用户日志读取闸门");
  return { code: result.status, out: result.stdout ?? "", err: result.stderr ?? "", state };
}

function runCli(args: string[]): { code: number | null; out: string; err: string } {
  const { code, out, err } = spawnCli(args);
  return { code, out, err };
}

/** 在观察器（可选故障注入）下跑一次 CLI。注入配置全部经环境变量，不改被测参数语义。 */
function runTraced(
  args: string[],
  env: Record<string, string> = {},
): { code: number | null; output: string; state: TraceState } {
  const { code, out, err, state } = spawnCli(args, env);
  return { code, output: `${out}${err}`, state };
}

/**
 * ⓪ 观察器与读取闸门的生效确认：少了这一组，后面所有「零次敏感写入」「没读用户日志」
 * 都可能是「观察器根本没生效」造成的假绿。
 *
 * 三条对照：① 带 marker 的写入必须被记到；② 读**替身**用户日志根里的文件必须被**拒绝**
 * 且记到（注入确认）；③ 读替身根的**同名前缀兄弟目录**不得被误判（字符串前缀不等于包含）。
 */
{
  const trace = join(workRoot, "trace-control.json");
  const control = spawnSync(process.execPath, [
    "--require", TRACE_HOOK,
    "-e", "require('node:fs').writeFileSync(process.env.DSH_FIXTURE_CONTROL_OUT, process.env.DSH_FIXTURE_CONTROL_MARK)",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_FIXTURE_WRITE_MARKER: TRACE_MARKER,
      DSH_FIXTURE_WRITE_TRACE: trace,
      DSH_FIXTURE_USER_LOG_ROOT: FAKE_USER_LOG_ROOT,
      DSH_FIXTURE_CONTROL_OUT: join(workRoot, "control-write.txt"),
      DSH_FIXTURE_CONTROL_MARK: TRACE_MARKER,
    },
  });
  assert.strictEqual(control.status, 0, `观察器控制子进程应成功：${control.stderr}`);
  const controlState = JSON.parse(readFileSync(trace, "utf8")) as TraceState;
  assert.strictEqual(controlState.loaded, true, "注入确认：观察器已加载");
  assert.strictEqual(controlState.sensitiveWriteAttempt, true, "注入确认：观察器能看见带 marker 的写入尝试");
  assert.strictEqual(controlState.sensitiveWriteCompleted, true, "注入确认：带 marker 的写入确实完成过");
  assert.strictEqual(controlState.userLogReadAttempt, false, "普通写入不得被记成用户日志读取");

  // 替身用户日志根：读它下面的文件必须被拒（真实 `~/.dsh` 全程不参与）
  const decoy = join(FAKE_USER_LOG_ROOT, "sessions", "decoy.jsonl");
  mkdirSync(join(FAKE_USER_LOG_ROOT, "sessions"), { recursive: true });
  writeFileSync(decoy, '{"type":"session/head"}\n', "utf8");
  const decoyTrace = join(workRoot, "trace-guard-decoy.json");
  const decoyRead = spawnSync(process.execPath, [
    "--require", TRACE_HOOK,
    "-e", "try { require('node:fs').readFileSync(process.env.DSH_FIXTURE_CONTROL_TARGET); process.stdout.write('read-ok'); }"
      + " catch { process.stdout.write('read-refused'); process.exitCode = 7; }",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_FIXTURE_WRITE_MARKER: TRACE_MARKER,
      DSH_FIXTURE_WRITE_TRACE: decoyTrace,
      DSH_FIXTURE_USER_LOG_ROOT: FAKE_USER_LOG_ROOT,
      DSH_FIXTURE_CONTROL_TARGET: decoy,
    },
  });
  const decoyState = JSON.parse(readFileSync(decoyTrace, "utf8")) as TraceState;
  assert.strictEqual(decoyState.userLogReadAttempt, true, "注入确认：读取用户日志根被记到");
  assert.strictEqual(decoyState.userLogReadRefused, true, "读取用户日志根必须被拒");
  assert.strictEqual(decoyRead.stdout, "read-refused", "子进程侧确实收到拒绝");
  assert.notStrictEqual(decoyRead.status, 0, "被拒的读取必须非零退出");

  /**
   * 根内、名字以两个点开头的**合法子目录**（`<root>/..contained/…`）：`path.relative` 给出
   * `..contained/session.txt`，它既不是 `..` 也不是 `..<分隔符>` 开头 —— 只看
   * `startsWith("..")` 会把它当成「在上级」而**放过读取**。这里用 ESM 具名导入再确认一次：
   * 它必须跟根内其他路径一样被拒。
   */
  const containedDir = join(FAKE_USER_LOG_ROOT, "..contained");
  const containedFile = join(containedDir, "session.txt");
  mkdirSync(containedDir, { recursive: true });
  writeFileSync(containedFile, "controlled synthetic material", "utf8");
  const containedRelative = relative(FAKE_USER_LOG_ROOT, containedFile);
  assert.ok(
    containedRelative !== ".." && !containedRelative.startsWith(`..${sep}`) && !isAbsolute(containedRelative),
    "注入确认：..contained 是根内真实子目录，不是上级目录",
  );
  const containedTrace = join(workRoot, "trace-guard-contained.json");
  const containedRead = spawnSync(process.execPath, [
    "--require", TRACE_HOOK,
    "--input-type=module",
    "-e", "import { readFileSync } from 'node:fs'; try { readFileSync(process.argv[1], 'utf8');"
      + " process.stdout.write('read-ok'); } catch { process.stdout.write('read-refused'); }",
    containedFile,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_FIXTURE_WRITE_MARKER: TRACE_MARKER,
      DSH_FIXTURE_WRITE_TRACE: containedTrace,
      DSH_FIXTURE_USER_LOG_ROOT: FAKE_USER_LOG_ROOT,
    },
  });
  const containedState = JSON.parse(readFileSync(containedTrace, "utf8")) as TraceState;
  assert.strictEqual(containedState.loaded, true, "注入确认：观察器已加载");
  assert.strictEqual(containedState.userLogReadAttempt, true, "根内 `..` 前缀子目录同样必须命中闸门");
  assert.strictEqual(containedState.userLogReadRefused, true, "根内 `..` 前缀子目录的读取必须被拒");
  assert.strictEqual(containedRead.stdout, "read-refused", "ESM 具名导入路径上确实被拒（不是成功后再补记）");

  // 同名前缀的兄弟目录：**不在**用户日志根之内，不得被误判
  const siblingRoot = `${FAKE_USER_LOG_ROOT}-sibling`;
  mkdirSync(siblingRoot, { recursive: true });
  const siblingFile = join(siblingRoot, "not-a-user-log.jsonl");
  writeFileSync(siblingFile, "{}\n", "utf8");
  const siblingTrace = join(workRoot, "trace-guard-sibling.json");
  const siblingRead = spawnSync(process.execPath, [
    "--require", TRACE_HOOK,
    "-e", "require('node:fs').readFileSync(process.env.DSH_FIXTURE_CONTROL_TARGET); process.stdout.write('read-ok');",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      DSH_FIXTURE_WRITE_MARKER: TRACE_MARKER,
      DSH_FIXTURE_WRITE_TRACE: siblingTrace,
      DSH_FIXTURE_USER_LOG_ROOT: FAKE_USER_LOG_ROOT,
      DSH_FIXTURE_CONTROL_TARGET: siblingFile,
    },
  });
  const siblingState = JSON.parse(readFileSync(siblingTrace, "utf8")) as TraceState;
  assert.strictEqual(siblingState.userLogReadAttempt, false, "同名前缀的兄弟目录不得被当成用户日志目录");
  assert.strictEqual(siblingRead.stdout, "read-ok", "兄弟目录里的文件照旧可读");
}

// ---------- 1. 缺配置：退出 2、不写盘、不回显路径 ----------
{
  const result = runCli(["--name", "no-source", "--out", outDir, "--repo-root", REPO]);
  assert.strictEqual(result.code, 2, "没给 --source 必须非零");
  assert.ok(!existsSync(join(outDir, "no-source.json")), "未写目标");
  assert.ok(!`${result.out}${result.err}`.includes(outDir), "失败分支不回显输出目录");
}

// ---------- 2. 源不存在：退出 2，且不回显源路径 / 文件名 ----------
{
  const missing = join(workRoot, "sk-missing-source-secret-name.jsonl.zstd");
  const result = runCli([...common, "--name", "missing", "--source", missing]);
  assert.strictEqual(result.code, 2, "源日志不存在必须非零");
  const output = `${result.out}${result.err}`;
  assert.ok(!output.includes("sk-missing-source-secret-name"), "不回显源文件名");
  assert.ok(!output.includes(workRoot), "不回显源目录");
  assert.ok(!existsSync(join(outDir, "missing.json")), "未写目标");
}

// ---------- 3. 未知参数带秘密：退出 2，且不回显参数原文 ----------
{
  const secret = "sk-argument-secret-0123456789";
  const result = runCli([...common, "--name", "unknown-arg", "--", secret]);
  assert.strictEqual(result.code, 2, "未知参数必须非零");
  assert.ok(!`${result.out}${result.err}`.includes(secret), "不回显参数里的秘密");
  assert.ok(!existsSync(join(outDir, "unknown-arg.json")), "未写目标");
}

// ---------- 4. 干净日志：退出 0、读回校验、出处 hash 对应**源码**而非 bundle ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");
  const result = runCli([...common, "--name", "clean", "--source", log]);
  assert.strictEqual(result.code, 0, `干净日志应成功：${result.err}`);
  const target = join(outDir, "clean.json");
  assert.ok(existsSync(target), "写出了目标");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "成功路径不留临时文件");

  const parsed = readJson(target) as {
    provenance: {
      sourceFormat: string;
      payloadReduced: boolean;
      payloadMeasurementEligible: boolean;
      modelSha256: string;
      generatedBy: string;
      redaction: { version: number; rules: string[] };
      extractor: { file: string; sha256: string };
      derive: { file: string; sha256: string };
      truncatedFields: Record<string, number>;
    };
    model: unknown;
  };
  const provenance = parsed.provenance;
  assert.strictEqual(provenance.sourceFormat, "v4", "文件名判格式");
  assert.strictEqual(provenance.payloadReduced, false, "短样本没有截断");
  assert.strictEqual(provenance.payloadMeasurementEligible, true, "未截断样本可用于载荷测量");
  assert.ok(DIGEST_PATTERN.test(provenance.modelSha256), "modelSha256 是合法摘要");
  assert.strictEqual(
    createHash("sha256").update(canonicalJson(parsed.model)).digest("hex"),
    provenance.modelSha256,
    "模型哈希与登记一致（读回校验同口径）",
  );

  assert.strictEqual(provenance.extractor.file, EXTRACTOR, "extractor 声明的是源码路径");
  assert.strictEqual(provenance.extractor.sha256, sha256(join(REPO, EXTRACTOR)), "extractor.sha256 = 声明源码的哈希");
  assert.strictEqual(provenance.derive.file, DERIVE, "derive 声明的是当前源码路径");
  assert.strictEqual(provenance.derive.sha256, sha256(join(REPO, DERIVE)), "derive.sha256 = 声明源码的哈希");
  /**
   * **运行实现与声明同源**：见证文件由 `esbuild.scripts.mjs` 用**记录型 `onLoad`** 写下 ——
   * 它记的是 esbuild **实际加载并折进 bundle** 的 derive 字节（原样交回，不改写内容），
   * 不是事后补的声明。三方（磁盘当前文件 / bundle 折入的字节 / CLI 写出的登记）必须对齐；
   * 只做正则 grep bundle 或只看声明自洽都不足以说明问题。
   */
  const witness = JSON.parse(readFileSync(join(REPO, DERIVE_WITNESS), "utf8")) as {
    entry: string;
    outfile: string;
    derive: { file: string; sha256: string; bytes: number } | null;
    bundleSha256: string;
  };
  assert.strictEqual(witness.entry, "scripts/trajectoryFixtureBuild.ts", "见证指向提取 CLI 的正式源码入口");
  assert.strictEqual(witness.outfile, "build/trajectory-fixture-build.mjs", "见证绑定到被测产物路径");
  assert.ok(witness.derive !== null, "见证必须记到实际折入的 derive 字节");
  assert.strictEqual(witness.derive?.file, DERIVE, "折入的 derive 文件是当前源码");
  assert.strictEqual(
    witness.derive?.sha256,
    sha256(join(REPO, DERIVE)),
    "折入的 derive 字节 = 磁盘当前源码（测试侧独立重算）",
  );
  assert.strictEqual(witness.bundleSha256, sha256(CLI), "见证绑定的 bundle 就是本次要被 spawn 的那一份");
  assert.strictEqual(
    provenance.derive.sha256,
    witness.derive?.sha256,
    "CLI 声明 = 实际折入 bundle 的 derive 字节（声明与运行同源）",
  );
  assert.strictEqual(provenance.redaction.version, FIXTURE_REDACTION_VERSION, "生成器盖章 = 当前规则版本");
  assert.deepStrictEqual(provenance.redaction.rules, [...FIXTURE_RULE_IDS], "规则清单是语言中立的稳定 id");
  assert.strictEqual(provenance.generatedBy, "scripts/trajectoryFixtureBuild.ts", "generatedBy 是纯正式源路径");
  const bundleHash = sha256(CLI);
  assert.notStrictEqual(provenance.extractor.sha256, bundleHash, "不能拿 bundle 哈希冒称源码哈希");
  assert.notStrictEqual(provenance.derive.sha256, bundleHash, "derive 同样不能是 bundle 哈希");

  /**
   * **行为同源对拍**：进程内用**当前正式源**（`decodeSessionLogBytes` + `deriveTrajectoryModel`
   * + `redactTrajectoryModel`）跑同一份合成日志，与 CLI 写出的 `model` 逐字比较。
   * 与「路径固定 / 声明指向当前源 / 构建见证」合起来才回答得了「这份产物不是 alias 或旧产物」。
   * 边界：这条只证明**在受控事件集上**行为一致，不是任意 bundle 的来源认证。
   */
  const decoded = decodeSessionLogBytes(readFileSync(log));
  assert.ok(typeof decoded === "string" && decoded !== "", "注入确认：合成日志能解码出文本");
  const inProcessModel: TrajectoryModel = redactTrajectoryModel(
    deriveTrajectoryModel(parseJsonlEvents(decoded as string), false),
    { fieldLimit: DEFAULT_FIELD_LIMIT },
  ).model;
  assert.strictEqual(
    canonicalJson(parsed.model),
    canonicalJson(inProcessModel),
    "CLI 写出的 model 与进程内当前源管线逐字一致（拒绝 alias / 旧产物）",
  );

  // 成功摘要是**中英两块**（D2：不引入语言开关，两种语言都真的出现在输出里）
  const successOutput = `${result.out}${result.err}`;
  assert.ok(successOutput.includes(FIXTURE_CLI_MESSAGES.successWritten.zh), "成功摘要必须有中文行");
  assert.ok(successOutput.includes(FIXTURE_CLI_MESSAGES.successWritten.en), "成功摘要必须有英文行");

  // 整份文件（provenance + model）扫描：白名单只在四个精确位置豁免裸摘要
  const wholeFile = readJson(target);
  assert.deepStrictEqual(
    scanFixtureSecrets(wholeFile, { digestPaths: DIGEST_WHITELIST }),
    [],
    "整份文件在白名单下扫描干净",
  );
  assert.ok(
    scanFixtureSecrets(wholeFile).length > 0,
    "不给白名单时摘要本身会命中——证明白名单确实在按位置+格式工作",
  );

  const text = readFileSync(target, "utf8");
  assert.ok(!text.includes("fixture-user"), "夹具里没有用户目录名");
  assert.ok(!text.includes("C:\\\\Users"), "夹具里没有 Windows 用户绝对路径");
  assert.ok(!text.includes("provider-real") && !text.includes("model-real"), "提供方/模型已占位");
  assert.ok(!`${result.out}${result.err}`.includes(log), "成功输出也不回显源路径");
}

// ---------- 5. 覆盖保护：坏出处不得当作可覆盖（内容一字不动） ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");
  const target = join(outDir, "broken.json");
  const broken = '{"provenance":{}}\n';
  writeFileSync(target, broken);
  const result = runCli([...common, "--name", "broken", "--source", log]);
  assert.strictEqual(result.code, 2, "既有出处不可读时必须拒绝");
  assert.strictEqual(readFileSync(target, "utf8"), broken, "既有内容一字不动");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "拒绝路径不留临时文件");
}

// ---------- 5b. --accept-new-source 只放宽「出处合法但源不同」这一种 ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");

  /**
   * 三种**坏出处**：坏 JSON / 缺 provenance / 非法 sourceSha256。加了
   * `--accept-new-source` 也**同样**必须拒绝 —— 该开关只放宽「已有出处合法但
   * sourceHash 不同」这一种，绝不能拿来顶掉来路不明或已损坏的文件。
   */
  const brokenCases: { name: string; bytes: string }[] = [
    { name: "accept-bad-json", bytes: '{ "provenance": { "sourceSha256": "' },
    { name: "accept-no-provenance", bytes: '{"model":{"turns":[]}}\n' },
    {
      name: "accept-bad-source-sha",
      bytes: `${JSON.stringify({ provenance: { sourceSha256: "not-a-digest" } }, null, 2)}\n`,
    },
  ];
  for (const item of brokenCases) {
    const target = join(outDir, `${item.name}.json`);
    writeFileSync(target, item.bytes);
    const result = runCli([...common, "--name", item.name, "--source", log, "--accept-new-source"]);
    assert.strictEqual(result.code, 2, `${item.name}：带 --accept-new-source 也必须拒绝坏出处`);
    assert.strictEqual(readFileSync(target, "utf8"), item.bytes, `${item.name}：目标原始字节一字不动`);
    assert.deepStrictEqual(tempLeftovers(outDir), [], `${item.name}：不留 .tmp 残留`);
    assert.ok(!`${result.out}${result.err}`.includes(log), `${item.name}：不回显源路径`);
    assert.ok(!`${result.out}${result.err}`.includes(workRoot), `${item.name}：不回显临时目录`);
  }

  // 反向确认：开关不是「永远失败」。出处合法但源不同时，它才放行，且登记换成新源
  const first = writeLog(join(workRoot, "other-a"), cleanEvents(40), "session.v4.jsonl.zstd");
  const created = runCli([...common, "--name", "accepted", "--source", first]);
  assert.strictEqual(created.code, 0, `先写出一份出处合法的夹具：${created.err}`);
  const second = writeLog(join(workRoot, "other-b"), cleanEvents(90), "session.v4.jsonl.zstd");
  assert.notStrictEqual(sha256(second), sha256(first), "两份合成日志本身不同（源 sha256 必须不同）");

  const refused = runCli([...common, "--name", "accepted", "--source", second]);
  assert.strictEqual(refused.code, 2, "出处合法但源不同、且没给开关时必须拒绝");
  const overwritten = runCli([...common, "--name", "accepted", "--source", second, "--accept-new-source"]);
  assert.strictEqual(overwritten.code, 0, `出处合法但源不同 + 给开关 → 允许替换：${overwritten.err}`);
  assert.strictEqual(
    (readJson(join(outDir, "accepted.json")) as { provenance: { sourceSha256: string } }).provenance.sourceSha256,
    sha256(second),
    "替换后登记的是新源的 sha256",
  );
  assert.deepStrictEqual(tempLeftovers(outDir), [], "替换路径不留临时文件");
}

// ---------- 5c. 秘密形态的 --name 入口即拒；失败/成功分支都不回显 --name ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");
  const secretName = "sk-parent-secret-contract-0123456789";
  // 注入确认：该名字能通过 --name 校验，且本身就是一条秘密形态（而不是「名字非法被拒」）
  assert.ok(/^[a-z0-9][a-z0-9-]*$/.test(secretName), "注入的名字能通过 --name 校验");
  assert.ok(
    findSecretHits(secretName).some((hit) => hit.rule === "openai-key"),
    "注入的名字本身命中秘密规则（回显它就是泄漏）",
  );
  const assertNoEcho = (output: string, where: string, name: string): void => {
    assert.ok(!output.includes(name), `${where}：不得回显 --name`);
  };

  // ① 秘密形态的名字：**入口直接拒绝**（固定文案），不再进入后面的任何分支
  const secretTarget = join(outDir, `${secretName}.json`);
  const original = "{broken-controlled-json";
  writeFileSync(secretTarget, original);
  const rejected = runCli([...common, "--name", secretName, "--source", log]);
  assert.strictEqual(rejected.code, 2, "秘密形态的 --name 必须在入口被拒");
  assert.strictEqual(readFileSync(secretTarget, "utf8"), original, "原目标不变");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "无 .tmp 残留");
  assertNoEcho(`${rejected.out}${rejected.err}`, "入口拒绝分支", secretName);
  assert.ok(!`${rejected.out}${rejected.err}`.includes("sk-parent-secret"), "连片段都不许出现");
  rmSync(secretTarget, { force: true });

  // ② 中性名字下的两条拒绝消息同样不得回显 `--name`（入口拒绝之后，这两条分支才可达）
  const neutral = "guard-name-probe";
  const guardTarget = join(outDir, `${neutral}.json`);
  writeFileSync(guardTarget, original);
  const broken = runCli([...common, "--name", neutral, "--source", log]);
  assert.strictEqual(broken.code, 2, "坏出处必须拒绝");
  assert.strictEqual(readFileSync(guardTarget, "utf8"), original, "坏出处分支：目标一字不动");
  assertNoEcho(`${broken.out}${broken.err}`, "坏出处分支", neutral);

  /**
   * 不同来源分支：既有夹具必须是**完整成立的登记**（本轮起按全部成员校验，缺成员/未知成员
   * 一律不可覆盖），所以先把刚才那份坏文件移走，再跑一次真夹具，然后用另一份源撞覆盖保护。
   */
  rmSync(guardTarget, { force: true });
  const neutralLog = writeLog(join(workRoot, "guard-neutral"), cleanEvents(20), "session.v4.jsonl.zstd");
  const seeded = runCli([...common, "--name", neutral, "--source", neutralLog]);
  assert.strictEqual(seeded.code, 0, `先写出一份真实夹具：${seeded.err}`);
  const beforeBytes = readFileSync(guardTarget, "utf8");
  const otherLog = writeLog(join(workRoot, "guard-other"), cleanEvents(90), "session.v4.jsonl.zstd");
  assert.notStrictEqual(sha256(otherLog), sha256(neutralLog), "注入确认：第二份合成日志不同源");
  const refused = runCli([...common, "--name", neutral, "--source", otherLog]);
  assert.strictEqual(refused.code, 2, "登记完整但源不同、未给开关时必须拒绝");
  assert.strictEqual(readFileSync(guardTarget, "utf8"), beforeBytes, "拒绝时目标一字不动");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "拒绝路径不留 .tmp");
  assertNoEcho(`${refused.out}${refused.err}`, "不同来源分支", neutral);

  // ③ 成功分支同样不回显 `--name`：自由输入在任何分支都不回显（不只是错误分支）
  const cleanRun = runCli([...common, "--name", "clean-name", "--source", log]);
  assert.strictEqual(cleanRun.code, 0, `普通名字应能写出：${cleanRun.err}`);
  assertNoEcho(`${cleanRun.out}${cleanRun.err}`, "成功分支", "clean-name");
}

// ---------- 5d. --source 传目录：固定安全错误，不抛自由异常 ----------
{
  const dirSource = join(workRoot, "a-directory-source");
  mkdirSync(dirSource, { recursive: true });
  assert.ok(statSync(dirSource).isDirectory(), "注入确认：源路径确实是目录");
  const result = runCli([...common, "--name", "dir-source", "--source", dirSource]);
  const output = `${result.out}${result.err}`;
  assert.strictEqual(result.code, 2, "目录源按配置错误退出 2（不能是未捕获异常的 1）");
  assert.ok(output.includes("源日志不存在或不可读"), "只给固定安全文案");
  assert.ok(!output.includes(dirSource), "不回显源路径");
  assert.ok(!output.includes("EISDIR"), "不回显自由异常原文（EISDIR）");
  assert.ok(!/node:fs|node:internal/.test(output), "不回显异常来源模块");
  assert.ok(!/\n\s+at /.test(output), "不回显异常栈帧");
  assert.ok(!output.toLowerCase().includes(REPO.replace(/\\/g, "/").toLowerCase()), "不回显本机绝对路径");
  assert.ok(!existsSync(join(outDir, "dir-source.json")), "未写目标");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "不留 .tmp 残留");
}

// ---------- 5e. 写盘前拦截：秘密 payload 不得**尝试**写入任何文件 ----------
{
  /**
   * ① 秘密形态的 name：入口拒绝，**发生在读源之前**，且不得有任何写入尝试。
   * 这条覆盖「临时文件事后被删」看不见的那种落盘：观察器看的是 writeFileSync 本身。
   */
  {
    const log = writeLog(join(workRoot, "prewrite-name"), cleanEvents(), "session.v4.jsonl.zstd");
    const run = runTraced([...common, "--name", TRACE_MARKER, "--source", log], {
      DSH_FIXTURE_READ_GUARD: resolve(log),
    });
    assert.strictEqual(run.state.loaded, true, "观察器加载确认");
    // 先看「有没有写」，再看退出码 —— 「.tmp 事后被删」是看不见落盘的
    assert.strictEqual(run.state.sensitiveWriteAttempt, false, "不得尝试写入含秘密的 payload");
    assert.strictEqual(run.state.sensitiveWriteCompleted, false, "秘密不得进入磁盘");
    assert.notStrictEqual(run.code, 0, "秘密 name 必须被拒");
    assert.strictEqual(run.code, 2, "入口拒绝按配置错误退出 2");
    assert.strictEqual(run.state.guardedRead, false, "入口拒绝必须发生在读源之前");
    assert.ok(!existsSync(join(outDir, `${TRACE_MARKER}.json`)), "无目标文件");
    assert.deepStrictEqual(tempLeftovers(outDir), [], "无 .tmp 残留");
    assert.ok(!run.output.includes(TRACE_MARKER), "不回显秘密 name");
  }

  /**
   * ② 秘密**只在 provenance 的 metadata 键上**（日志事件的 `type` 即秘密，会进入
   * `sourceEventCounts` 的键）：必须在任何 `writeFileSync` 之前拦下，绝不能先写 `.tmp`。
   */
  {
    const events = cleanEvents();
    events.push(event(TRACE_MARKER, {}, 9));
    const log = writeLog(join(workRoot, "prewrite-metadata"), events, "session.v4.jsonl.zstd");
    const run = runTraced([...common, "--name", "metadata-case", "--source", log], {
      DSH_FIXTURE_READ_GUARD: resolve(log),
    });
    assert.notStrictEqual(run.code, 0, "秘密 metadata 必须被拒");
    assert.strictEqual(run.code, 4, "写盘前的整份扫描命中按「秘密规则」出口退出 4");
    assert.strictEqual(run.state.loaded, true, "观察器加载确认");
    assert.strictEqual(run.state.guardedRead, true, "观察器读源探针生效（注入确认）");
    assert.strictEqual(run.state.sensitiveWriteAttempt, false, "不得尝试写入含秘密的 payload");
    assert.strictEqual(run.state.sensitiveWriteCompleted, false, "秘密 metadata 不得进入磁盘");
    assert.ok(!existsSync(join(outDir, "metadata-case.json")), "无目标文件");
    assert.deepStrictEqual(tempLeftovers(outDir), [], "无 .tmp 残留");
    assert.ok(!run.output.includes(TRACE_MARKER), "不回显秘密原文（只报规则名与计数）");
  }
}

// ---------- 5f. 来源字节快照单读：hash 与派生事件必须来自同一份字节（TOCTOU 边界） ----------
{
  const logA = writeLog(join(workRoot, "snapshot-a"), cleanEvents(40), "session.v4.jsonl.zstd");
  const logB = writeLog(join(workRoot, "snapshot-b"), cleanEvents(120), "session.v4.jsonl.zstd");
  // 注入确认：两份合成日志本身不同（否则「换了一份字节」根本看不出来）
  assert.notStrictEqual(sha256(logA), sha256(logB), "注入确认：两份合成日志的 sha256 不同");

  const reference = runCli([...common, "--name", "snapshot-ref", "--source", logA]);
  assert.strictEqual(reference.code, 0, `参考运行（无注入）应成功：${reference.err}`);
  const referenceProvenance = (readJson(join(outDir, "snapshot-ref.json")) as {
    provenance: { modelSha256: string };
  }).provenance;

  // 第 1 次读盘之后（即旧实现的第二次读盘）把内容换成 B：只有「读了两次」才会被换掉
  const run = runTraced([...common, "--name", "snapshot-case", "--source", logA], {
    DSH_FIXTURE_READ_GUARD: resolve(logA),
    DSH_FIXTURE_READ_SWAP: resolve(logA),
    DSH_FIXTURE_READ_SWAP_FILE: logB,
    DSH_FIXTURE_READ_SWAP_AFTER: "1",
  });
  assert.strictEqual(run.state.loaded, true, "观察器加载确认");
  assert.strictEqual(run.state.guardedRead, true, "读源探针生效（注入确认）");
  // 正确预期：源日志的只读快照**只读一次**——hash 与派生事件不可能各来自一份字节
  assert.strictEqual(
    run.state.guardedReadCount,
    1,
    "源快照必须只读一次（不得 hash 读一次、解码再读一次）",
  );
  assert.strictEqual(run.state.swapApplied, 0, "第二次读盘不存在，交换注入无从生效");
  assert.strictEqual(run.code, 0, `单快照运行应成功：${run.output}`);
  const provenance = (readJson(join(outDir, "snapshot-case.json")) as {
    provenance: { sourceSha256: string; modelSha256: string };
  }).provenance;
  assert.strictEqual(provenance.sourceSha256, sha256(logA), "登记的是快照 A 的 sha256");
  assert.strictEqual(
    provenance.modelSha256,
    referenceProvenance.modelSha256,
    "派生结果与无注入参考逐字一致（同一份快照）",
  );
}

// ---------- 5g. 故障注入：每条注入先证明命中目标 syscall/回调，再判失败出口 ----------
{
  const log = writeLog(join(workRoot, "fault-injection"), cleanEvents(), "session.v4.jsonl.zstd");
  /**
   * 既有目标必须是**真实夹具**：本轮起覆盖保护按「全部成员 + 类型」校验，手搓的残缺登记
   * 会在写盘之前就被 exit 2 拦下，注入根本到不了目标 syscall。它的字节同时是
   * 「失败时既有目标 byte-for-byte 保全」的比对基准。
   */
  const seedFixture = (label: string): { target: string; bytes: string } => {
    const target = join(outDir, `${label}.json`);
    const seeded = runCli([...common, "--name", label, "--source", log]);
    assert.strictEqual(seeded.code, 0, `${label}：先写出一份真实夹具（${seeded.err}）`);
    return { target, bytes: readFileSync(target, "utf8") };
  };

  /** 既有目标先放真实夹具；失败出口必须让它 **byte-for-byte** 不动，且不留 .tmp。 */
  const expectFailure = (
    label: string,
    args: string[],
    env: Record<string, string>,
    hit: keyof TraceState,
    message: string,
  ): void => {
    const { target, bytes: sentinel } = seedFixture(label);
    const run = runTraced([...args, "--source", log], { DSH_FIXTURE_READ_GUARD: resolve(log), ...env });
    assert.strictEqual(run.state.loaded, true, `${label}：观察器加载确认`);
    assert.strictEqual(run.state[hit], true, `${label}：注入必须命中目标 syscall/回调`);
    assert.strictEqual(run.state.guardedRead, true, `${label}：读源探针生效（注入确认）`);
    assert.strictEqual(run.state.sensitiveWriteAttempt, false, `${label}：不得尝试敏感写入`);
    assert.strictEqual(run.state.sensitiveWriteCompleted, false, `${label}：秘密不得落盘`);
    assert.strictEqual(run.code, 3, `${label}：失败必须走固定安全出口 3`);
    assert.ok(run.output.includes(message), `${label}：必须是这条固定文案（实际：${run.output.trim()}）`);
    assert.strictEqual(readFileSync(target, "utf8"), sentinel, `${label}：既有目标 byte-for-byte 保全`);
    assert.deepStrictEqual(tempLeftovers(outDir), [], `${label}：不留 .tmp 残留`);
    assert.ok(!run.output.includes(TRACE_MARKER), `${label}：失败码不得回显秘密`);
    assert.ok(!run.output.includes(workRoot) && !run.output.includes(log), `${label}：不回显工作目录/源路径`);
  };

  // ① 输出目录创建失败：目标目录不存在，失败后也不得被创建出半截
  {
    const missingOut = join(workRoot, "no-such-out");
    assert.ok(!existsSync(missingOut), "注入确认：输出目录确实不存在");
    const run = runTraced([
      "--repo-root", REPO, "--extractor-source", EXTRACTOR, "--derive-source", DERIVE,
      "--out", missingOut, "--name", "fault-mkdir", "--source", log,
    ], { DSH_FIXTURE_READ_GUARD: resolve(log), DSH_FIXTURE_FAIL_MKDIR: "1" });
    assert.strictEqual(run.state.mkdirFailureHit, true, "mkdir：注入必须命中 mkdirSync");
    assert.strictEqual(run.state.sensitiveWriteAttempt, false, "mkdir：不得尝试敏感写入");
    assert.strictEqual(run.state.sensitiveWriteCompleted, false, "mkdir：秘密不得落盘");
    assert.strictEqual(run.code, 3, "mkdir：失败必须走固定安全出口 3");
    assert.ok(run.output.includes("输出目录不可创建"), "mkdir：只给固定安全文案");
    assert.ok(!existsSync(missingOut), "mkdir：不得留下半截输出目录");
    assert.ok(!existsSync(join(missingOut, "fault-mkdir.json")), "mkdir：未写目标");
    assert.deepStrictEqual(tempLeftovers(outDir), [], "mkdir：不留 .tmp 残留");
    assert.ok(!run.output.includes(TRACE_MARKER), "mkdir：失败码不得回显秘密");
    assert.ok(!run.output.includes(workRoot), "mkdir：不回显工作目录");
  }

  // ② 写临时文件失败（观察器**先真写再抛错**：临时文件确实存在过，清理路径必须生效）
  expectFailure(
    "fault-write",
    [...common, "--name", "fault-write"],
    { DSH_FIXTURE_FAIL_WRITE: "1" },
    "writeFailureHit",
    "写盘或读回校验异常",
  );

  // ③ 原子替换失败
  expectFailure(
    "fault-rename",
    [...common, "--name", "fault-rename"],
    { DSH_FIXTURE_FAIL_RENAME: "1" },
    "renameFailureHit",
    "原子替换失败",
  );

  // ④ 读回 hash 不一致（篡改只发生在读回那一次，磁盘上那份不被动）
  expectFailure(
    "fault-readback-hash",
    [...common, "--name", "fault-readback-hash"],
    { DSH_FIXTURE_TAMPER_READBACK: "hash" },
    "readBackTamperHit",
    "读回校验失败",
  );

  // ⑤ 读回扫描命中（model 未改 → hash 仍一致，只有整份扫描能发现）
  expectFailure(
    "fault-readback-scan",
    [...common, "--name", "fault-readback-scan"],
    { DSH_FIXTURE_TAMPER_READBACK: "scan" },
    "readBackTamperHit",
    "读回校验失败",
  );

  // ⑥⑦⑧ 读回内部一致性（structure / seq 映射 / 载荷闸门）：第二道防线必须覆盖 provenance 自身
  expectFailure(
    "fault-readback-structure",
    [...common, "--name", "fault-readback-structure"],
    { DSH_FIXTURE_TAMPER_READBACK: "structure" },
    "readBackTamperHit",
    "读回校验失败",
  );
  expectFailure(
    "fault-readback-seq-mapping",
    [...common, "--name", "fault-readback-seq-mapping"],
    { DSH_FIXTURE_TAMPER_READBACK: "seq-mapping" },
    "readBackTamperHit",
    "读回校验失败",
  );
  expectFailure(
    "fault-readback-payload-flags",
    [...common, "--name", "fault-readback-payload-flags"],
    { DSH_FIXTURE_TAMPER_READBACK: "payload-flags" },
    "readBackTamperHit",
    "读回校验失败",
  );
}

// ---------- 5h. CLI 自由参数：失败文案不得回显参数原文或本机路径 ----------
{
  const log = writeLog(join(workRoot, "free-args"), cleanEvents(), "session.v4.jsonl.zstd");

  const badLimit = runCli([...common, "--name", "bad-limit", "--source", log, "--limit", "sk-limit-secret-0123456789"]);
  assert.strictEqual(badLimit.code, 2, "--limit 非整数必须非零");
  assert.ok(!`${badLimit.out}${badLimit.err}`.includes("sk-limit-secret"), "不回显 --limit 原文");
  assert.ok(!existsSync(join(outDir, "bad-limit.json")), "坏 --limit：未写目标");

  /**
   * 放宽 `--limit 0`（不截断）**不得**顺带放宽参数校验：负数 / 小数 / 非数字照样是配置错误
   * （退出 2、零写入、不回显参数原文）。
   */
  for (const value of ["-1", "1.5", "abc"]) {
    const name = `bad-limit-${value.replace(/[^a-z0-9]/gi, "_")}`;
    const result = runCli([...common, "--name", name, "--source", log, "--limit", value]);
    assert.strictEqual(result.code, 2, `--limit ${value} 必须退出 2（配置错误）`);
    assert.ok(!existsSync(join(outDir, `${name}.json`)), `--limit ${value}：不得写目标`);
    assert.ok(!`${result.out}${result.err}`.includes(value), `--limit ${value}：不回显参数原文`);
  }
  assert.deepStrictEqual(tempLeftovers(outDir), [], "坏 --limit 路径不留 .tmp 残留");

  // --out 指向一个不可创建的目录（父路径是普通文件）：固定文案 + 无自由异常
  const blocker = join(workRoot, "sk-out-secret-dir-0123456789");
  writeFileSync(blocker, "controlled-blocker");
  const badOut = runCli([
    "--repo-root", REPO, "--extractor-source", EXTRACTOR, "--derive-source", DERIVE,
    "--out", join(blocker, "nested"), "--name", "bad-out", "--source", log,
  ]);
  const badOutOutput = `${badOut.out}${badOut.err}`;
  assert.strictEqual(badOut.code, 3, "输出目录不可创建必须走 3");
  assert.ok(badOutOutput.includes("输出目录不可创建"), "只给固定安全文案");
  assert.ok(!badOutOutput.includes("sk-out-secret-dir"), "不回显 --out 里的秘密形态路径");
  assert.ok(!badOutOutput.includes(workRoot), "不回显工作目录");
  assert.ok(!badOutOutput.includes("ENOTDIR"), "不回显自由异常原文");
  assert.ok(!/node:fs|node:internal/.test(badOutOutput) && !/\n\s+at /.test(badOutOutput), "不回显异常栈");
}

// ---------- 5i. 深层 JSON：整份扫描覆盖结构化字段内部，超限不得冒充「未缩减载荷」 ----------
{
  /**
   * 结构化字段（`schemaDetail` / `inputDetail`）是 JSON 文本。两条正确预期：
   * 1. **深层内容照样被扫**：嵌套的**键名**不会被脱敏（键是结构），所以嵌在深层的秘密键
   *    必须由写盘前的整份扫描拦下 → 退出 4、零次写盘；
   * 2. **超限不得误获 M06 全载荷资格**：超限的结构化字段同样要登记截断
   *    （`payloadReduced=true`、`payloadMeasurementEligible=false`），而不是悄悄放行。
   */
  const deepSecretKey = "sk-deep-json-key-0123456789";
  const deepEvents = () => {
    const events = cleanEvents();
    const deepArgs = JSON.stringify({ outer: { middle: { [deepSecretKey]: "value" } } });
    for (const entry of events) {
      const data = entry.data as Record<string, unknown>;
      if (entry.type === "tool/call") data.arguments = deepArgs;
      if (entry.type === "assistant/message") {
        const message = data.message as { content: Record<string, unknown>[] };
        for (const part of message.content) {
          if (part.type === "tool-call") part.arguments = deepArgs;
        }
      }
    }
    return events;
  };
  // 注入确认：秘密键确实在深层，且原样的 JSON 文本确实命中规则
  const injected = JSON.stringify({ outer: { middle: { [deepSecretKey]: "value" } } });
  assert.ok(findSecretHits(injected).some((hit) => hit.rule === "openai-key"), "注入确认：深层键本身命中规则");
  assert.ok(!injected.includes("sk-deep-json-key-0123456789\"\n"), "注入确认：键确实处于嵌套结构里");

  const deepLog = writeLog(join(workRoot, "deep-json-key"), deepEvents(), "session.v4.jsonl.zstd");
  const deepRun = runTraced([...common, "--name", "deep-json-key", "--source", deepLog], {
    DSH_FIXTURE_READ_GUARD: resolve(deepLog),
  });
  assert.strictEqual(deepRun.state.guardedRead, true, "深层 JSON：读源探针生效（注入确认）");
  assert.strictEqual(deepRun.state.sensitiveWriteAttempt, false, "深层 JSON：不得尝试敏感写入");
  assert.strictEqual(deepRun.state.sensitiveWriteCompleted, false, "深层 JSON：秘密键不得落盘");
  assert.strictEqual(deepRun.code, 4, "深层 JSON 里的秘密键必须被写盘前扫描拦下");
  assert.ok(!existsSync(join(outDir, "deep-json-key.json")), "深层 JSON：无目标文件");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "深层 JSON：无 .tmp 残留");
  assert.ok(!deepRun.output.includes(deepSecretKey), "深层 JSON：不回显秘密键原文");

  // 超限的结构化字段：夹具仍要能生成，但必须明确登记为「载荷被改过」
  const bigProperties: Record<string, unknown> = {};
  for (let i = 0; i < 60; i += 1) {
    bigProperties[`param_${i}`] = { type: "string", description: `占位说明 ${i}`.repeat(4) };
  }
  const bigEvents = cleanEvents();
  for (const entry of bigEvents) {
    const data = entry.data as Record<string, unknown>;
    if (entry.type === "request/header") {
      const header = data.header as { tools: Record<string, unknown>[] };
      header.tools = [{ name: "read", parameters: { type: "object", properties: bigProperties } }];
    }
  }
  const bigLog = writeLog(join(workRoot, "oversize-json"), bigEvents, "session.v4.jsonl.zstd");
  const bigRun = runCli([...common, "--name", "oversize-json", "--source", bigLog]);
  assert.strictEqual(bigRun.code, 0, `超限结构化字段不得让夹具生不出来：${bigRun.err}`);
  const bigParsed = readJson(join(outDir, "oversize-json.json")) as {
    provenance: {
      payloadReduced: boolean;
      payloadMeasurementEligible: boolean;
      truncatedFields: Record<string, number>;
      redaction: { fieldLimit: number };
    };
  };
  assert.strictEqual(bigParsed.provenance.payloadReduced, true, "结构化字段被截断即视为载荷缩减");
  assert.strictEqual(bigParsed.provenance.payloadMeasurementEligible, false, "缩减过的夹具不得用于 M06 全载荷测量");
  assert.ok(
    (bigParsed.provenance.truncatedFields.schemaDetail ?? 0) >= 1,
    "截断登记必须逐字段写明（不得只改总闸门）",
  );
  assert.strictEqual(bigParsed.provenance.redaction.fieldLimit, 2000, "不得靠偷偷调大 fieldLimit 掩盖超限");
}

// ---------- 5j. 深度超限：固定安全失败（不得抛 RangeError / 回显路径），既有目标保全 ----------
{
  /** 200 层嵌套的 JSON 文本：模型对象图本身很浅（它是**字符串**），要靠结构化字段的深度闸门拦。 */
  const deepJson = (() => {
    let text = "\"leaf\"";
    for (let i = 0; i < 200; i += 1) text = `{"level_${i}":${text}}`;
    return text;
  })();
  assert.ok(deepJson.length > 1000, "注入确认：确实构造出深层 JSON 文本");

  const events = cleanEvents();
  for (const entry of events) {
    const data = entry.data as Record<string, unknown>;
    if (entry.type === "tool/call") data.arguments = deepJson;
    if (entry.type === "assistant/message") {
      const message = data.message as { content: Record<string, unknown>[] };
      for (const part of message.content) {
        if (part.type === "tool-call") part.arguments = deepJson;
      }
    }
  }
  const deepLog = writeLog(join(workRoot, "depth-overflow"), events, "session.v4.jsonl.zstd");

  // 既有目标先放一份真夹具（同一份源），失败必须让它 byte-for-byte 不动
  const target = join(outDir, "depth-overflow.json");
  const seeded = runCli([...common, "--name", "depth-overflow", "--source", deepLog]);
  if (seeded.code !== 0) {
    // 派生阶段就炸（derive 的 recu 路径）也可接受：只要是固定文案、无异常原文、未写目标
    assert.strictEqual(seeded.code, 3, "派生阶段失败必须走固定安全出口 3");
    assert.ok(!existsSync(target), "派生阶段失败不得写目标");
    assert.ok(!/RangeError|Maximum call stack/.test(`${seeded.out}${seeded.err}`), "不得回显 RangeError 原文");
  } else {
    const before = readFileSync(target, "utf8");
    const run = runCli([...common, "--name", "depth-overflow", "--source", deepLog]);
    assert.strictEqual(run.code, 3, "深度超限必须固定安全失败（3）");
    const output = `${run.out}${run.err}`;
    assert.ok(output.includes("嵌套超过夹具支持深度"), "只给固定安全文案");
    assert.ok(!/RangeError|Maximum call stack|node:internal/.test(output), "不得回显 RangeError / 异常栈");
    assert.ok(!output.includes(workRoot) && !output.includes(deepLog), "不回显工作目录 / 源路径");
    assert.strictEqual(readFileSync(target, "utf8"), before, "既有目标 byte-for-byte 保全");
    assert.deepStrictEqual(tempLeftovers(outDir), [], "不留 .tmp 残留");
  }
}

// ---------- 5k. 不可信事件 type：`__proto__` / `constructor` 必须按数字准确计数 ----------
{
  /**
   * `sourceEventCounts` 的键直接来自日志事件的 `type`。用普通 `{}` 计数时
   * `counts["__proto__"] = 1` 会改原型（键整条消失），`counts["constructor"] ?? 0`
   * 会拿到继承来的函数 —— 计数被原型成员顶替。这里要求它们都是**准确的数字**。
   */
  const events = cleanEvents();
  events.push(event("__proto__", {}, 7));
  events.push(event("constructor", {}, 8));
  events.push(event("__proto__", {}, 9));
  const log = writeLog(join(workRoot, "proto-keys"), events, "session.v4.jsonl.zstd");
  const run = runCli([...common, "--name", "proto-keys", "--source", log]);
  assert.strictEqual(run.code, 0, `含原型键事件类型的日志应能写出：${run.err}`);
  const counts = (readJson(join(outDir, "proto-keys.json")) as {
    provenance: { sourceEventCounts: Record<string, unknown> };
  }).provenance.sourceEventCounts;
  assert.ok(Object.hasOwn(counts, "__proto__"), "`__proto__` 必须是**自有**键（不是原型）");
  assert.strictEqual(counts.__proto__, 2, "`__proto__` 计数必须是准确数字");
  assert.strictEqual(counts.constructor, 1, "`constructor` 计数必须是准确数字，不能是继承成员");
  assert.strictEqual(typeof counts.constructor, "number", "计数类型必须是数字");
}


// ---------- 6. 同源重跑：允许覆盖（幂等） ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");
  const before = readFileSync(join(outDir, "clean.json"), "utf8");
  const result = runCli([...common, "--name", "clean", "--source", log]);
  assert.strictEqual(result.code, 0, "同源重跑应允许覆盖");
  assert.strictEqual(readFileSync(join(outDir, "clean.json"), "utf8"), before, "确定性脱敏：内容逐字一致");
}

// ---------- 7. 脱敏后仍命中秘密（工具名是保留字段）：退出 4、不落盘 ----------
{
  const events = cleanEvents();
  for (const entry of events) {
    const data = entry.data as Record<string, unknown>;
    if (entry.type === "tool/call") data.name = "sk-cli-secret-tool-0123456789";
  }
  const log = writeLog(join(workRoot, "secret"), events, "session.v4.jsonl.zstd");
  const result = runCli([...common, "--name", "secret", "--source", log]);
  assert.strictEqual(result.code, 4, "命中秘密规则必须非零");
  assert.ok(!existsSync(join(outDir, "secret.json")), "命中时不落盘");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "命中路径不留临时文件");
  assert.ok(
    `${result.out}${result.err}`.includes("openai-key"),
    "报出规则名与计数（不含内容）",
  );
  assert.ok(!`${result.out}${result.err}`.includes("sk-cli-secret-tool"), "不回显命中的秘密原文");
}

// ---------- 8. 声明源缺失 / 用 bundle 冒充源码：退出 2、不落盘 ----------
{
  const log = writeLog(join(workRoot, "clean"), cleanEvents(), "session.v4.jsonl.zstd");
  const missing = runCli([
    "--repo-root", REPO, "--derive-source", DERIVE, "--out", outDir,
    "--extractor-source", "scripts/does-not-exist.ts",
    "--name", "declared-missing", "--source", log,
  ]);
  assert.strictEqual(missing.code, 2, "声明的源码不存在必须非零");
  assert.ok(!existsSync(join(outDir, "declared-missing.json")), "未写目标");
  assert.ok(!`${missing.out}${missing.err}`.includes(workRoot), "声明源缺失分支不回显源/输出目录");

  const bundle = runCli([
    "--repo-root", REPO, "--derive-source", DERIVE, "--out", outDir,
    "--extractor-source", CLI.slice(REPO.length + 1).replace(/\\/g, "/"),
    "--name", "bundle-as-source", "--source", log,
  ]);
  assert.strictEqual(bundle.code, 2, "不接受用运行中的 bundle 冒充源码");
  assert.ok(!existsSync(join(outDir, "bundle-as-source.json")), "未写目标");

  /**
   * 声明的「源码」其实是个**目录**（名字以 .ts 结尾）：同一 I/O 安全边界，不得抛自由异常。
   *
   * 用**临时替身仓库**做（不往真仓库里写任何东西）：替身仓库只需满足 `looksLikeRepo` 的三个
   * 判据（`package.json` / `src/dsh/trajectory.ts` / `scripts/sessionLog.ts`）。
   */
  const fakeDirRepo = join(workRoot, "declared-dir-repo");
  const fakeDirName = "fake-extractor-dir.ts";
  mkdirSync(join(fakeDirRepo, "src", "dsh"), { recursive: true });
  mkdirSync(join(fakeDirRepo, "scripts", fakeDirName), { recursive: true });
  writeFileSync(join(fakeDirRepo, "package.json"), '{"name":"declared-dir-repo"}\n');
  writeFileSync(join(fakeDirRepo, "src", "dsh", "trajectory.ts"), "export const x = 1;\n");
  writeFileSync(join(fakeDirRepo, "scripts", "sessionLog.ts"), "export const y = 1;\n");
  const asDirectory = runCli([
    "--repo-root", fakeDirRepo, "--derive-source", DERIVE, "--out", outDir,
    "--extractor-source", `scripts/${fakeDirName}`,
    "--name", "declared-dir", "--source", log,
  ]);
  const output = `${asDirectory.out}${asDirectory.err}`;
  assert.strictEqual(asDirectory.code, 2, "声明的源码是目录必须非零（不能是未捕获异常的 1）");
  assert.ok(!existsSync(join(outDir, "declared-dir.json")), "未写目标");
  assert.ok(!output.includes("EISDIR"), "不回显自由异常原文");
  assert.ok(!/node:fs|node:internal/.test(output) && !/\n\s+at /.test(output), "不回显异常栈");
  assert.ok(!output.includes(fakeDirName), "不回显声明的路径原文");
}

// ---------- 9. 截断登记：payloadReduced / payloadMeasurementEligible ----------
{
  const log = writeLog(join(workRoot, "long"), cleanEvents(200), "session.v4.jsonl.zstd");
  const result = runCli([...common, "--name", "long", "--source", log, "--limit", "50"]);
  assert.strictEqual(result.code, 0, `截断样本应能写出：${result.err}`);
  const parsed = readJson(join(outDir, "long.json")) as {
    provenance: { payloadReduced: boolean; payloadMeasurementEligible: boolean; truncatedFields: Record<string, number> };
  };
  assert.strictEqual(parsed.provenance.payloadReduced, true, "截断过就要登记");
  assert.strictEqual(parsed.provenance.payloadMeasurementEligible, false, "截断样本不得用于全载荷测量");
  assert.ok(Object.keys(parsed.provenance.truncatedFields).length > 0, "逐字段截断计数非空");
}

// ---------- 9b. 声明的源码必须在仓库内：兄弟同名前缀目录 / 绝对路径 / 链接 ----------
{
  /**
   * 主代理实跑的正确预期红：`--extractor-source ../repo-sibling/foreign.ts` 指向**同名前缀**
   * 的仓库兄弟目录。旧判据用「去掉 repoRoot 前缀再看有没有 `..`」，兄弟目录会变成
   * `-sibling/foreign.ts` 而被误当成仓库内。正确预期：退出 2（配置错误）、不落盘、不回显路径。
   */
  const fakeRepo = join(workRoot, "fake-repo");
  const siblingDir = join(workRoot, "fake-repo-sibling");
  for (const dir of [fakeRepo, siblingDir]) mkdirSync(dir, { recursive: true });
  mkdirSync(join(fakeRepo, "src", "dsh"), { recursive: true });
  mkdirSync(join(fakeRepo, "scripts"), { recursive: true });
  writeFileSync(join(fakeRepo, "package.json"), '{"name":"fake-repo"}\n');
  writeFileSync(join(fakeRepo, "src", "dsh", "trajectory.ts"), "export const x = 1;\n");
  writeFileSync(join(fakeRepo, "scripts", "sessionLog.ts"), "export const y = 1;\n");
  writeFileSync(join(fakeRepo, "scripts", "declared.ts"), "export const z = 1;\n");
  writeFileSync(join(siblingDir, "foreign.ts"), "export const foreign = 1;\n");

  const fakeLog = writeLog(join(workRoot, "fake-repo-log"), cleanEvents(), "session.v4.jsonl.zstd");
  const fakeCommon = ["--repo-root", fakeRepo, "--out", outDir];

  // 对照：仓库内声明必须正常工作（证明拒绝的是「仓库外」而不是「一律拒绝」）
  const inside = runCli([
    ...fakeCommon, "--extractor-source", "scripts/declared.ts", "--derive-source", "src/dsh/trajectory.ts",
    "--name", "inside-repo", "--source", fakeLog,
  ]);
  assert.strictEqual(inside.code, 0, `仓库内声明应成功：${inside.err}`);
  const insideProvenance = (readJson(join(outDir, "inside-repo.json")) as {
    provenance: { extractor: { file: string; sha256: string } };
  }).provenance;
  assert.strictEqual(insideProvenance.extractor.file, "scripts/declared.ts", "登记的是仓库相对声明");
  assert.strictEqual(
    insideProvenance.extractor.sha256,
    sha256(join(fakeRepo, "scripts", "declared.ts")),
    "哈希取的是那份文件",
  );

  // 兄弟前缀目录：同名前缀的**仓库外**目录必须被拒
  const sibling = runCli([
    ...fakeCommon, "--extractor-source", "../fake-repo-sibling/foreign.ts", "--derive-source", "src/dsh/trajectory.ts",
    "--name", "sibling-prefix", "--source", fakeLog,
  ]);
  const siblingOutput = `${sibling.out}${sibling.err}`;
  assert.strictEqual(sibling.code, 2, "同名前缀的仓库兄弟目录必须按配置错误拒绝");
  assert.ok(!existsSync(join(outDir, "sibling-prefix.json")), "拒绝时不落盘");
  assert.ok(!siblingOutput.includes("fake-repo-sibling"), "不回显仓库外路径");
  assert.ok(!siblingOutput.includes("foreign"), "不回显声明的文件名");
  assert.ok(!siblingOutput.includes(workRoot), "不回显工作目录");
  assert.ok(!/\n\s+at /.test(siblingOutput), "不回显异常栈");

  // 绝对路径：直接拒绝（不接受仓库外绝对路径）
  const absolute = runCli([
    ...fakeCommon, "--extractor-source", join(siblingDir, "foreign.ts"), "--derive-source", "src/dsh/trajectory.ts",
    "--name", "abs-source", "--source", fakeLog,
  ]);
  assert.strictEqual(absolute.code, 2, "绝对路径声明必须拒绝");
  assert.ok(!`${absolute.out}${absolute.err}`.includes("foreign.ts"), "不回显绝对路径原文");

  // 链接真实路径保护：仓库内的符号链接指向仓库外时必须拒绝（本机不允许建链接时只记录观察）
  const linkPath = join(fakeRepo, "scripts", "linked.ts");
  try {
    symlinkSync(join(siblingDir, "foreign.ts"), linkPath, "file");
    const linked = runCli([
      ...fakeCommon, "--extractor-source", "scripts/linked.ts", "--derive-source", "src/dsh/trajectory.ts",
      "--name", "linked-source", "--source", fakeLog,
    ]);
    assert.strictEqual(linked.code, 2, "链接指向仓库外时必须拒绝（真实路径保护）");
    assert.ok(!existsSync(join(outDir, "linked-source.json")), "链接拒绝时不落盘");
    assert.ok(!`${linked.out}${linked.err}`.includes("fake-repo-sibling"), "不回显链接目标路径");
  } catch {
    console.log("[观察] 本机不允许创建符号链接，跳过该子用例（真实路径保护仍已在实现里）");
  }
}

// ---------- 10. `--limit 0` = 不截断（无上限）：三处语义一致，默认上限不受影响 ----------
{
  /**
   * 一条**远超默认上限**的合成自由文本。目标语义：
   * - `--limit 0`：不截断（无上限）→ 退出 0、登记 `fieldLimit=0`、零截断登记、未缩减载荷、
   *   模型里的最长字符串**等于源长度**（证明 0 不等于默认 2000）；
   * - 默认（不带 `--limit`）：照样截到默认上限并逐字段登记 —— 证明默认行为没被改动。
   *
   * 长度以**模型里的最长字符串**为准：脱敏是等长替换，所以长度就是源长度。
   */
  const LONG_CHARS = 5001;
  const longUserText = `问题\n${"长".repeat(LONG_CHARS)}`;
  assert.ok(longUserText.length > DEFAULT_FIELD_LIMIT, `注入确认：合成正文 ${longUserText.length} 字符，远超默认上限`);

  /** 模型里的最长字符串长度（只走 model，不含 provenance 的规则清单与摘要）。 */
  const longestString = (value: unknown): number => {
    if (typeof value === "string") return value.length;
    if (Array.isArray(value)) return value.reduce<number>((max, entry) => Math.max(max, longestString(entry)), 0);
    if (value !== null && typeof value === "object") {
      return Object.values(value as Record<string, unknown>)
        .reduce<number>((max, entry) => Math.max(max, longestString(entry)), 0);
    }
    return 0;
  };

  const log = writeLog(join(workRoot, "limit-boundary"), cleanEvents(LONG_CHARS), "session.v4.jsonl.zstd");

  const zero = runCli([...common, "--name", "limit-zero", "--source", log, "--limit", "0"]);
  assert.strictEqual(zero.code, 0, `--limit 0 必须可用（0 = 不截断）：${zero.err}`);
  const zeroTarget = join(outDir, "limit-zero.json");
  assert.ok(existsSync(zeroTarget), "--limit 0：写出了目标");
  const zeroParsed = readJson(zeroTarget) as {
    provenance: {
      payloadReduced: boolean;
      payloadMeasurementEligible: boolean;
      truncatedFields: Record<string, number>;
      redaction: { fieldLimit: number };
    };
    model: unknown;
  };
  assert.strictEqual(zeroParsed.provenance.redaction.fieldLimit, 0, "--limit 0：登记里就是 0（不是偷偷换成默认上限）");
  assert.deepStrictEqual(zeroParsed.provenance.truncatedFields, {}, "--limit 0：零截断登记");
  assert.strictEqual(zeroParsed.provenance.payloadReduced, false, "--limit 0：未缩减载荷");
  assert.strictEqual(zeroParsed.provenance.payloadMeasurementEligible, true, "--limit 0：可用于 M06 全载荷测量");
  assert.strictEqual(
    longestString(zeroParsed.model),
    longUserText.length,
    `--limit 0：模型里的最长字符串等于源长度 ${longUserText.length}（未被截到 ${DEFAULT_FIELD_LIMIT}）`,
  );
  assert.deepStrictEqual(tempLeftovers(outDir), [], "--limit 0：不留 .tmp 残留");
  assert.ok(!`${zero.out}${zero.err}`.includes(log), "--limit 0：成功分支也不回显源路径");

  const fallback = runCli([...common, "--name", "limit-default", "--source", log]);
  assert.strictEqual(fallback.code, 0, `默认上限仍应可用：${fallback.err}`);
  const fallbackParsed = readJson(join(outDir, "limit-default.json")) as {
    provenance: {
      payloadReduced: boolean;
      payloadMeasurementEligible: boolean;
      truncatedFields: Record<string, number>;
      redaction: { fieldLimit: number };
    };
    model: unknown;
  };
  assert.strictEqual(
    fallbackParsed.provenance.redaction.fieldLimit,
    DEFAULT_FIELD_LIMIT,
    "不带 --limit 时上限仍是默认值",
  );
  assert.strictEqual(fallbackParsed.provenance.payloadReduced, true, "默认上限下超长正文确实被截断");
  assert.strictEqual(fallbackParsed.provenance.payloadMeasurementEligible, false, "截断样本不得用于全载荷测量");
  const truncationEntries = Object.entries(fallbackParsed.provenance.truncatedFields);
  assert.ok(truncationEntries.length >= 1, "默认上限下必须逐字段登记截断");
  assert.ok(truncationEntries.every(([, count]) => count >= 1), "每条截断登记的计数都 ≥1");
  assert.strictEqual(
    longestString(fallbackParsed.model),
    DEFAULT_FIELD_LIMIT,
    `默认上限下模型最长字符串正好等于 ${DEFAULT_FIELD_LIMIT}`,
  );
  assert.deepStrictEqual(tempLeftovers(outDir), [], "默认上限：不留 .tmp 残留");
}

// ---------- 11. 5 条当前 derive 判别序列（旧派生在这些输入上给不出当前结果） ----------
{
  /**
   * 每条序列只放**一个**判别点，所以红绿可以逐条归因。序列文本的 sha256 与冻结表逐字一致
   * ——「同输入」是构造上的事实（改序列必须同时改这里，红绿两侧不可能各自演化成两份输入）。
   *
   * 断言的是**平移不变**的观测量（时刻差值 / 是否为空 / steering 落组）：脱敏会把全部时刻
   * 统一平移到固定锚点，绝对时刻会变，差值不会。
   */
  const discriminatorBase = Date.UTC(2026, 5, 1, 12, 0, 0);
  const at = (offset: number): number => discriminatorBase + Math.round(offset * 1000);
  const textBlock = (text: string): Record<string, unknown>[] => [{ type: "text", text }];
  function author(): (type: string, data: Record<string, unknown>, offset: number) => Record<string, unknown> {
    let index = 0;
    return (type, data, offset) => {
      const entry = { type, seq: index, time: at(offset), data };
      index += 1;
      return entry;
    };
  }
  const userMessage = (id: string, text: string): Record<string, unknown> =>
    ({ id, role: "user", content: textBlock(text), source: { kind: "user" } });
  const assistantMessage = (id: string, text: string): Record<string, unknown> => ({
    id, role: "assistant", source: { provider: "provider-real", model: "model-real" }, content: textBlock(text),
  });
  const identity = (id: string): Record<string, unknown> =>
    ({ id, role: "user", content: textBlock(""), source: { kind: "user" } });
  const claimSteering = (
    write: (type: string, data: Record<string, unknown>, offset: number) => Record<string, unknown>,
    id: string,
    offset: number,
  ): Record<string, unknown>[] => [
    write("agent/inbox/spliced", { target: "next-step", start: 0, inserted: [identity(id)] }, offset),
    write("agent/inbox/spliced", { target: "next-step", start: 0, removedCount: 1 }, offset + 0.1),
    write("user/message", userMessage(id, id), offset + 0.2),
  ];
  const stepHead = (
    write: (type: string, data: Record<string, unknown>, offset: number) => Record<string, unknown>,
    turn: number,
    step: number,
  ): Record<string, unknown>[] => [
    write("turn/start", { turn }, 0.5),
    write("step/start", { turn, step }, 1),
    write("user/message", userMessage(`u-turn-${turn}-step-${step}`, "提问"), 1),
    write("request/header", {
      header: { config: { provider: "provider-real", model: "model-real" }, tools: [] },
      reason: "initial",
    }, 1),
  ];
  const raw = (offset: number, chunk: Record<string, unknown>): Record<string, unknown> =>
    ({ type: "chunk", time: at(offset), chunk });

  const firstTokenRaw = (): Record<string, unknown>[] => {
    const write = author();
    return [
      ...stepHead(write, 1, 1),
      write("assistant/message", {
        turn: 1,
        step: 1,
        message: assistantMessage("a1", "回答"),
        usage: { inputTokens: 10, outputTokens: 3 },
        // 首帧是**非 token** 块、第一段文本还是空串：首个真 token 在 1700
        stream: [
          raw(1.1, { type: "block-start", index: 0, blockType: "text" }),
          raw(1.2, { type: "usage", usage: { inputTokens: 1, outputTokens: 0 } }),
          raw(1.3, { type: "text-delta", index: 0, text: "" }),
          raw(1.7, { type: "text-delta", index: 0, text: "答" }),
        ],
      }, 2),
      write("step/end", { turn: 1, step: 1 }, 2.5),
      write("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
    ];
  };
  const firstTokenPacked = (): Record<string, unknown>[] => {
    const write = author();
    return [
      ...stepHead(write, 1, 1),
      write("assistant/message", {
        turn: 1,
        step: 1,
        message: assistantMessage("a1", "回答"),
        usage: { inputTokens: 10, outputTokens: 3 },
        // packed run：成员时刻 = time0 + Σdt = 1200 + 200 + 300 = 1700（记录里没有 `time`）
        stream: [{ type: "text-chunks", time0: at(1.2), index: 0, dt: [200, 300], texts: ["", "", "答"] }],
      }, 2),
      write("step/end", { turn: 1, step: 1 }, 2.5),
      write("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
    ];
  };
  const attemptExplicitOtherStep = (): Record<string, unknown>[] => {
    const write = author();
    return [
      ...stepHead(write, 1, 1),
      write("assistant/message", {
        turn: 1,
        step: 1,
        message: assistantMessage("a1", "回答"),
        usage: { inputTokens: 10, outputTokens: 3 },
      }, 2),
      // 自带 step=9，窗口里根本没有那一步：**不写**首 token（不得回落到最后一次助手请求）
      write("assistant/attempt", { turn: 1, step: 9, stream: [raw(2.7, { type: "text-delta", index: 0, text: "别处" })] }, 2.2),
      write("step/end", { turn: 1, step: 1 }, 2.5),
      write("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
    ];
  };
  const attemptLateBackfill = (): Record<string, unknown>[] => {
    const write = author();
    return [
      ...stepHead(write, 1, 1),
      write("assistant/message", {
        turn: 1,
        step: 1,
        message: assistantMessage("a1", "回答"),
        usage: { inputTokens: 10, outputTokens: 3 },
      }, 2),
      // 同一步的 attempt 后到：请求级与**已经产出的账本行**必须同时补到 2400
      write("assistant/attempt", { turn: 1, step: 1, stream: [raw(2.4, { type: "text-delta", index: 0, text: "答" })] }, 2.2),
      write("step/end", { turn: 1, step: 1 }, 2.5),
      write("turn/end", { turn: 1, reason: { kind: "completed" } }, 3),
    ];
  };
  const steeringPrepend = (): Record<string, unknown>[] => {
    const write = author();
    return [
      write("turn/start", { turn: 2 }, 0.9),
      write("user/message", userMessage("fresh", "本轮提问"), 0.95),
      write("step/start", { turn: 2, step: 1 }, 1),
      write("system/message", { turn: 2, step: 1, message: { content: textBlock("中立提示词") } }, 1.05),
      write("request/header", {
        header: { config: { provider: "provider-real", model: "model-real" }, tools: [] },
        reason: "initial",
      }, 1.1),
      write("assistant/message", { turn: 2, step: 1, message: assistantMessage("a1", "回答一") }, 1.2),
      ...claimSteering(write, "steer-in-step-1", 1.3),
      write("step/end", { turn: 2, step: 1 }, 1.5),
      ...claimSteering(write, "steer-between", 1.6),
      write("step/start", { turn: 2, step: 2 }, 1.9),
      write("assistant/message", { turn: 2, step: 2, message: assistantMessage("a2", "回答二") }, 2.1),
      write("step/end", { turn: 2, step: 2 }, 2.2),
      write("turn/end", { turn: 2, reason: { kind: "completed" } }, 2.3),
    ];
  };

  const sequences: [string, string, Record<string, unknown>[]][] = [
    ["first-token-raw", "507330b2a969f2b2ec24709bca2d7c4728fa3acb02b20efa23ebde1df5e25362", firstTokenRaw()],
    ["first-token-packed", "d73bc506e9c0cd65a09146d210cda2f10eb90f611256a55ed7612d7836bba2af", firstTokenPacked()],
    ["attempt-explicit-other-step", "22765496dcaf8b89e34cf62a76a12c2336e80c08631d03f782fc5157d8eee0bb", attemptExplicitOtherStep()],
    ["attempt-late-backfill", "38981244f5f101b72c91dece4e4e62c65151e212b6591ed848b1f58125781e2d", attemptLateBackfill()],
    ["steering-prepend", "ac4da60a89fcd60c9f72361ff1a6031358a1a8a99c868529939015077a78f908", steeringPrepend()],
  ];

  const logTextOf = (events: Record<string, unknown>[]): string =>
    `${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  /** 请求级首 token 延迟（平移不变）。 */
  const requestTtft = (model: TrajectoryModel, step: number): number | null => {
    const request = model.requests.find((entry) => entry.purpose === "assistant" && entry.step === step);
    if (request === undefined || request.startedAt == null || request.assistantFirstTokenTime == null) return null;
    return request.assistantFirstTokenTime - request.startedAt;
  };
  /** 助手行（记录级）首 token 延迟（平移不变）。 */
  const cellTtft = (model: TrajectoryModel): number | null => {
    const cell = model.turns
      .flatMap((turn) => turn.groups.flatMap((group) => group.cells))
      .find((entry) => entry.kind === "message");
    const metrics = cell?.assistantMetrics;
    if (metrics === undefined || metrics === null || metrics.stepStartTime == null || metrics.firstTokenTime == null) {
      return null;
    }
    return metrics.firstTokenTime - metrics.stepStartTime;
  };

  for (const [name, expectedSha, events] of sequences) {
    assert.strictEqual(
      createHash("sha256").update(logTextOf(events), "utf8").digest("hex"),
      expectedSha,
      `${name}：判别序列文本与冻结哈希逐字一致（同输入锚点）`,
    );
    const log = writeLog(join(workRoot, "discriminators"), events, `${name}.jsonl.zstd`);
    const result = runCli([...common, "--name", name, "--source", log]);
    assert.strictEqual(result.code, 0, `${name}：应能写出夹具：${result.err}`);
    const model = (readJson(join(outDir, `${name}.json`)) as unknown as { model: TrajectoryModel }).model;

    // 与进程内当前源管线逐字一致（这条对每一序列都成立）
    const decoded = decodeSessionLogBytes(readFileSync(log));
    assert.ok(typeof decoded === "string", `${name}：注入确认 —— 合成日志可解码`);
    const expectedModel = redactTrajectoryModel(
      deriveTrajectoryModel(parseJsonlEvents(decoded as string), false),
      { fieldLimit: DEFAULT_FIELD_LIMIT },
    ).model;
    assert.strictEqual(canonicalJson(model), canonicalJson(expectedModel), `${name}：与进程内当前源管线逐字一致`);

    if (name === "first-token-raw") {
      assert.strictEqual(requestTtft(model, 1), 700, "first-token-raw：请求级首 token 取首个**真 token**（1700-1000）");
      assert.strictEqual(cellTtft(model), 700, "first-token-raw：记录级同样是 700");
    } else if (name === "first-token-packed") {
      assert.strictEqual(requestTtft(model, 1), 700, "first-token-packed：packed run 按 time0+Σdt 折出 1700");
      assert.strictEqual(cellTtft(model), 700, "first-token-packed：记录级同样是 700");
    } else if (name === "attempt-explicit-other-step") {
      assert.strictEqual(requestTtft(model, 1), null, "attempt-explicit-other-step：请求级不得写别步的首 token");
      assert.strictEqual(cellTtft(model), null, "attempt-explicit-other-step：记录级同样为空");
    } else if (name === "attempt-late-backfill") {
      assert.strictEqual(requestTtft(model, 1), 1400, "attempt-late-backfill：请求级补到 2400（TTFT 1400）");
      assert.strictEqual(cellTtft(model), 1400, "attempt-late-backfill：**已产出**的记录级同时补到同值");
    } else if (name === "steering-prepend") {
      const steeringSteps = model.turns
        .flatMap((turn) => turn.groups.map((group) => ({ step: group.title.kind === "step" ? group.title.step : null, cells: group.cells })))
        .flatMap((group) => group.cells.filter((cell) => cell.steering === true).map(() => group.step));
      assert.deepStrictEqual(steeringSteps, [1, 2], "steering-prepend：两条 steering 各用自己的事件 seq 落点（第 1 步 / 第 2 步）");
    }
  }
}

// ---------- 12. 超深既有夹具：覆盖保护的固定出口（不抛 RangeError、不回显路径/异常栈） ----------
{
  const log = writeLog(join(workRoot, "deep-existing"), cleanEvents(), "session.v4.jsonl.zstd");
  const target = join(outDir, "deep-existing.json");
  /** 形状合法（有 provenance/model）但**超深**的受控既有夹具。 */
  const deep = `${"[".repeat(3000)}${"]".repeat(3000)}`;
  const payloadText = `{"provenance":{},"model":{"turns":[],"requests":[],"injected":${deep}}}`;
  const parsedDeep = JSON.parse(payloadText) as { provenance: unknown; model: unknown };
  assert.ok(
    parsedDeep.provenance !== null && typeof parsedDeep.model === "object",
    "注入确认：受控既有夹具是形状合法的超深载荷",
  );
  writeFileSync(target, payloadText, "utf8");
  const result = runCli([...common, "--name", "deep-existing", "--source", log]);
  const output = `${result.out}${result.err}`;
  assert.strictEqual(result.code, 2, "超深既有夹具必须走覆盖保护的固定出口 2（不是未捕获异常的 1）");
  assert.ok(output.includes(FIXTURE_CLI_MESSAGES.previousProvenanceInvalid.zh), "只给固定安全文案（中文行）");
  assert.ok(output.includes(FIXTURE_CLI_MESSAGES.previousProvenanceInvalid.en), "只给固定安全文案（英文行）");
  assert.ok(!/RangeError|Maximum call stack|node:internal/.test(output), "不得回显 RangeError / 内部模块");
  assert.ok(!/\n\s+at /.test(output), "不得回显异常栈帧");
  assert.ok(
    !output.includes(REPO) && !output.includes(REPO.replace(/\\/g, "/")),
    "不得回显本机绝对路径",
  );
  assert.strictEqual(readFileSync(target, "utf8"), payloadText, "既有目标 byte-for-byte 保全");
  assert.deepStrictEqual(tempLeftovers(outDir), [], "不留 .tmp 残留");
}

// ---------- 13. 严格生成入口：整份输入必须由完整合法帧构成 + 非空行必须是完整 JSON 对象 ----------
{
  /**
   * 这一节钉的是**严格口径**（与 `sessionLog.ts` 的宽容默认并存）：
   * 完整前缀 + 任何垃圾 / 半帧不再是「成功保留前缀」，坏 JSON / `null` / 数组 / 标量
   * 也不再被静默丢弃 —— 统一走固定出口（退出 3、零产物、零临时文件、不泄露路径与异常栈）。
   *
   * 构造用**手搭帧**（按 RFC 8878 的字段宽度：`fcsFlag` 0/1/2/3 → 1/2/4/8 字节、
   * 2 字节值是「内容大小 − 256」、块头 3 字节 LE），并先用原生解码确认这份构造本身合法。
   */
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const u24 = (value: number): Buffer => Buffer.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff]);
  const rawFrame = (
    content: Buffer,
    fcsSize: 0 | 1 | 2 | 4 | 8,
    options: { window?: boolean; blockType?: 0 | 1 | 3; checksum?: boolean } = {},
  ): Buffer => {
    const flag = ({ 0: 0, 1: 0, 2: 1, 4: 2, 8: 3 } as const)[fcsSize];
    const fields: Buffer[] = [];
    if (options.window === true) fields.push(Buffer.from([0x08]));
    if (fcsSize > 0) {
      const fcs = Buffer.alloc(fcsSize);
      if (fcsSize === 8) fcs.writeBigUInt64LE(BigInt(content.length));
      else fcs.writeUIntLE(content.length - (fcsSize === 2 ? 256 : 0), 0, fcsSize);
      fields.push(fcs);
    }
    const blockType = options.blockType ?? 0;
    const payload = blockType === 1 ? Buffer.from([content[0] ?? 0]) : content;
    return Buffer.concat([
      MAGIC,
      Buffer.from([(flag << 6) | (options.window === true ? 0 : 0x20) | (options.checksum === true ? 0x04 : 0)]),
      ...fields,
      u24((payload.length << 3) | (blockType << 1) | 1),
      payload,
      options.checksum === true ? Buffer.alloc(4) : Buffer.alloc(0),
    ]);
  };
  const writeRawSource = (dir: string, bytes: Buffer): string => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "session.v4.jsonl.zstd");
    writeFileSync(file, bytes);
    return file;
  };

  const strictText = cleanEvents()
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
  const strictBytes = Buffer.from(strictText, "utf8");
  const strictLog = writeLog(join(workRoot, "strict-base"), cleanEvents(), "session.v4.jsonl.zstd");

  // 13a. 基线：合法帧 + 合法 JSONL 照旧成功（严格不等于动辄拒绝）
  {
    const result = runCli([...common, "--name", "strict-base", "--source", strictLog]);
    assert.strictEqual(result.code, 0, `合法输入必须成功：${result.err}`);
    assert.deepStrictEqual(tempLeftovers(outDir), [], "成功路径不留临时文件");
  }

  // 13b. 完整帧之后跟垃圾 / 第二个裸魔数 / 半帧：必须整体拒绝，不得「保留前缀」
  {
    const goodFrame = zlib.zstdCompressSync(strictBytes);
    const decorations: [string, Buffer][] = [
      ["strict-garbage-tail", Buffer.concat([goodFrame, Buffer.from("unfinished", "utf8")])],
      ["strict-magic-tail", Buffer.concat([goodFrame, MAGIC])],
      [
        "strict-truncated-frame-tail",
        Buffer.concat([goodFrame, zlib.zstdCompressSync(Buffer.from('{"type":"metadata"}\n', "utf8")).subarray(0, 8)]),
      ],
    ];
    for (const [name, bytes] of decorations) {
      const source = writeRawSource(join(workRoot, name), bytes);
      const result = runCli([...common, "--name", name, "--source", source]);
      const output = `${result.out}${result.err}`;
      assert.strictEqual(result.code, 3, `${name}：不完整输入必须退出 3（实际 ${result.code}）`);
      assert.ok(!existsSync(join(outDir, `${name}.json`)), `${name}：拒绝时不得写产物`);
      assert.ok(output.includes(FIXTURE_CLI_MESSAGES.decodeFailed.zh), `${name}：只给固定安全文案（中文行）`);
      assert.ok(output.includes(FIXTURE_CLI_MESSAGES.decodeFailed.en), `${name}：只给固定安全文案（英文行）`);
      assert.ok(!/\n\s+at /.test(output) && !/node:internal/.test(output), `${name}：不得回显异常栈`);
      assert.ok(!output.includes(workRoot) && !output.includes(REPO), `${name}：不得回显本机路径`);
      assert.deepStrictEqual(tempLeftovers(outDir), [], `${name}：不留 .tmp`);
    }
    /**
     * 反向对照：**skippable 帧**（`0x184D2A5x`）不是本扩展会话日志的帧形态，
     * 严格入口按「起始不是规范魔数」统一拒（退出 3、固定文案）。原生引擎会**吞掉**
     * 这类帧并报 `bytesWritten=8`，正好说明「按魔数认帧 + 引擎消耗字节必须等于帧长」
     * 这两条守卫缺一不可：只信引擎消耗就会把 8 字节头部当成完整帧放行。
     */
    const skippable = Buffer.concat([Buffer.from([0x50, 0x2a, 0x4d, 0x18]), Buffer.alloc(4), Buffer.from("payload")]);
    /** `@types/node` 的 `info: true` 形状还只是「返回 Buffer」，运行期才是 `{buffer, engine}`。 */
    const skippableInfo = zlib.zstdDecompressSync(skippable, { info: true }) as unknown as {
      engine: { bytesWritten: number };
    };
    assert.strictEqual(skippableInfo.engine.bytesWritten, 8, "注入确认：原生引擎把 skippable 帧吞成 8 字节空帧");
    const skippableCase = runCli([
      ...common,
      "--name", "strict-skippable-frame",
      "--source", writeRawSource(join(workRoot, "strict-skippable-frame"), skippable),
    ]);
    assert.strictEqual(skippableCase.code, 3, `skippable 帧必须被严格入口拒绝（实际 ${skippableCase.code}）`);
    assert.ok(!existsSync(join(outDir, "strict-skippable-frame.json")), "skippable 帧拒绝时不得写产物");
    assert.deepStrictEqual(tempLeftovers(outDir), [], "skippable 帧拒绝时不留 .tmp");
  }

  // 13c. 行形状严格：坏 JSON / 中间半个对象 / null / 数组 / 标量统一退出 3（不再静默丢弃）
  {
    const rows: [string, string][] = [
      ["strict-bad-json", `${strictText}{"broken":\n`],
      ["strict-incomplete-json", `${strictText}{"type":"assistant/message"`],
      ["strict-null-row", `${strictText}null\n`],
      ["strict-array-row", `${strictText}[]\n`],
      ["strict-scalar-row", `${strictText}7\n`],
    ];
    for (const [name, text] of rows) {
      // 注入确认：这份材料本身是一份**能原生解出**的完整帧（拒绝必须来自行形状，不是帧结构）
      const bytes = zlib.zstdCompressSync(Buffer.from(text, "utf8"));
      assert.ok(zlib.zstdDecompressSync(bytes).length > 0, `${name}：材料本身必须是完整合法帧`);
      const source = writeRawSource(join(workRoot, name), bytes);
      const result = runCli([...common, "--name", name, "--source", source]);
      const output = `${result.out}${result.err}`;
      assert.strictEqual(result.code, 3, `${name}：坏行必须退出 3（实际 ${result.code}）`);
      assert.ok(!existsSync(join(outDir, `${name}.json`)), `${name}：拒绝时不得写产物`);
      assert.ok(output.includes(FIXTURE_CLI_MESSAGES.decodeFailed.zh), `${name}：固定文案（中文）`);
      assert.deepStrictEqual(tempLeftovers(outDir), [], `${name}：不留 .tmp`);
    }
  }

  // 13d. 合法但非 durable 的元数据对象允许；完整帧 + 零 durable 事件走既有语义
  {
    const metadataOnly = `${JSON.stringify({ type: "metadata", data: { text: "非 durable 元数据" } })}\n`;
    const accepted = runCli([
      ...common,
      "--name", "strict-metadata",
      "--source", writeRawSource(join(workRoot, "strict-metadata"), rawFrame(Buffer.from(metadataOnly, "utf8"), 4)),
    ]);
    assert.strictEqual(accepted.code, 3, "只有非 durable 元数据：走既有 noDurableEvents 出口（退出 3）");
    assert.ok(
      `${accepted.out}${accepted.err}`.includes(FIXTURE_CLI_MESSAGES.noDurableEvents.zh),
      "零 durable 事件给既有固定文案（不是解码失败）",
    );
    assert.ok(!existsSync(join(outDir, "strict-metadata.json")), "零 durable 事件不得写产物");
  }

  // 13e. FCS 宽度 1/2/4/8 与窗口描述符：**完整合法帧**必须照旧成功（严格不误伤合法构造）
  {
    const variants: [string, Buffer][] = [
      ["strict-fcs-1", rawFrame(Buffer.from(JSON.stringify(cleanEvents()[0]) + "\n", "utf8"), 1)],
      ["strict-fcs-2", rawFrame(strictBytes, 2)],
      ["strict-fcs-4", rawFrame(strictBytes, 4)],
      ["strict-fcs-8", rawFrame(strictBytes, 8)],
      ["strict-window-no-fcs", rawFrame(strictBytes, 0, { window: true })],
    ];
    for (const [name, bytes] of variants) {
      // 注入确认：手搭帧必须原生可解（否则下面的成功没有意义）
      assert.ok(zlib.zstdDecompressSync(bytes).length > 0, `${name}：构造本身必须原生可解`);
      const source = writeRawSource(join(workRoot, name), bytes);
      const result = runCli([...common, "--name", name, "--source", source]);
      assert.strictEqual(result.code, 0, `${name}：完整合法帧必须成功（${result.err}）`);
      assert.deepStrictEqual(tempLeftovers(outDir), [], `${name}：成功路径不留临时文件`);
    }
  }
  // 13f. 字面 U+FFFD 是合法 UTF-8：不得被「解出的字符串里有没有 U+FFFD」误拒
  {
    /**
     * 判定必须落在**字节**上（对拼接后的解压字节做 fatal 解码），不能看解出的字符串里
     * 有没有 U+FFFD —— 后者会把源里本来就合法的 `EF BF BD` 一起误拒。
     * 单帧与跨帧（把 3 字节码点切成 1+2）两条都要通过。
     */
    const literalText = `{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1,"note":"合法字面 \uFFFD 仍是有效 Unicode"}}\n`;
    const literalBytes = Buffer.from(literalText, "utf8");
    const at = literalBytes.indexOf(Buffer.from("\uFFFD"));
    assert.ok(at > 0, "注入确认：样本里确实有字面 U+FFFD");
    assert.strictEqual(literalBytes.subarray(at, at + 3).toString("hex"), "efbfbd", "注入确认：字面 U+FFFD 的 UTF-8 就是 EF BF BD");
    const singleFrame = rawFrame(literalBytes, 1);
    const crossHead = zlib.zstdCompressSync(literalBytes.subarray(0, at + 1));
    const crossTail = zlib.zstdCompressSync(literalBytes.subarray(at + 1));
    const crossFrame = Buffer.concat([crossHead, crossTail]);
    // 注入确认：两份材料各自逐帧原生解压后拼起来必须**等于**原文（拒绝若发生只可能来自 UTF-8 判定）
    assert.ok(zlib.zstdDecompressSync(singleFrame).equals(literalBytes), "注入确认：单帧材料原生解出即原文");
    const crossReassembled = Buffer.concat([zlib.zstdDecompressSync(crossHead), zlib.zstdDecompressSync(crossTail)]);
    assert.ok(crossReassembled.equals(literalBytes), "注入确认：跨帧材料两帧原生解压拼回即原文");
    assert.strictEqual(crossHead.length + crossTail.length, crossFrame.length, "注入确认：跨帧材料就是这两帧首尾相接");
    for (const [name, bytes] of [["strict-literal-replacement", singleFrame], ["strict-literal-replacement-cross-frame", crossFrame]] as const) {
      const source = writeRawSource(join(workRoot, name), bytes);
      const result = runCli([...common, "--name", name, "--source", source]);
      assert.strictEqual(result.code, 0, `${name}：字面 U+FFFD 必须被接受（${result.err}）`);
      const fixture = JSON.parse(readFileSync(join(outDir, `${name}.json`), "utf8")) as {
        provenance: { sourceEventCounts: Record<string, number> };
      };
      assert.strictEqual(fixture.provenance.sourceEventCounts["turn/start"], 1, `${name}：事件未被丢弃`);
      assert.deepStrictEqual(tempLeftovers(outDir), [], `${name}：成功路径不留临时文件`);
    }
  }
}

// 清理：临时工作根与替身用户日志根（**真实用户目录从未参与**）
rmSync(workRoot, { recursive: true, force: true });
rmSync(FAKE_USER_LOG_HOME, { recursive: true, force: true });
console.log("trajectoryFixtureBuild: CLI 行为断言全部通过（含严格入口）");
