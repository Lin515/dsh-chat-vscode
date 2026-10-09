/**
 * `scripts/trajectoryGapProbe.ts` / `scripts/trajectoryAlignProbe.ts` 两条 CLI 的
 * **受控来源**与 **M04 缺失判定**的真实进程回归。
 *
 * 为什么需要它：`scripts/trajectoryProbeFacts.test.ts` 只能证明纯函数口径，
 * 证明不了「CLI 真的会报缺失、真的没去扫默认目录」。而 Align 的缺失路径
 * （`MISS_NO_LEDGER_CELL` / `MISS_DUPLICATE_SEQ` / `MISS_NO_LEDGER_USER`）在
 * **当前这条成功派生路径**、且输入带着有效 `seq` 与身份时是走不到的：折叠层对每个
 * `assistant/message` 事件恰好产出**一条同 seq** 的 message 记录，对每个
 * `source.kind === 'user'` 事件恰好产出一条同 seq 的 user 记录，建组循环也不丢记录。
 * **本文件不声称**畸形输入、折叠层抛异常、或将来改动后的派生路径同样已被穷尽；
 * 它只证明：这条防线在真的少了一条合法助手行时报缺失，而不是把「没比」吞掉。
 * 要证明这一点，只能在**受控替换**下制造一次故障。
 *
 * 本文件做三件事：
 * 1. **受控替换的真实 CLI 故障演练**：用 esbuild API 把 Align CLI 打进系统临时目录，
 *    把 `import "../src/dsh/trajectory"` 换成一份注入桩（转发真实现后**丢掉恰好一条合法
 *    助手行**）。对照（不注入）必须全绿，注入必须 `missing=1`、退出码 **2**。注入桩的
 *    字节、被替换真实模块的 sha256、两次运行的计数一起写进**见证**并打印。
 *    **仓库源码里没有、也不得有** `--drop` / 环境变量这类故障开关。
 * 2. **读路径闸门**：每次 spawn 之前，闸门断言 (a) 每个 `--source` 都落在本次合成材料根内，
 *    (b) 子进程的 `HOME` / `USERPROFILE` 被强制指向受控根——即 `npm test` **永远不会**
 *    扫真实 HOME / `~/.dsh`。闸门本身也有自测：拿仓库里的真实路径当 `--source` 必须被
 *    拒绝（不 spawn）。
 * 3. **来源模式与默认扫描的区分**：合成一份**诱饵**默认目录，`--source` 模式一个字都不许
 *    出现它，而不传 `--source`（同一受控环境）必须只看到这份诱饵——后者同时证明
 *    「HOME 覆盖真的生效」，否则看到的会是真实家目录。
 *
 * 材料**全部本进程合成**（会话日志是 `zlib.zstdCompressSync` 造的单帧），
 * 不读任何用户日志、不连服务、不花 token。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import type { Plugin } from "esbuild";

/**
 * 仓库根：从产物所在目录向上找到同时含 `scripts/trajectoryAlignProbe.ts` 与
 * `src/dsh/trajectory.ts` 的那一级。产物通常就在 `<仓库>/build/` 下，这样写是为了
 * 同一份产物被复制到别处（例如实施者的私有验证目录）时仍指向同一个仓库。
 */
function findRepo(from: string): string {
  for (let dir = from; ; ) {
    if (existsSync(join(dir, "scripts", "trajectoryAlignProbe.ts"))
      && existsSync(join(dir, "src", "dsh", "trajectory.ts"))) {
      return dir;
    }
    const parent = dirname(dir);
    assert.notStrictEqual(parent, dir, "找不到仓库根（缺少 scripts/trajectoryAlignProbe.ts）");
    dir = parent;
  }
}

const REPO = findRepo(dirname(fileURLToPath(import.meta.url)));
const ALIGN_ENTRY = join(REPO, "scripts", "trajectoryAlignProbe.ts");
const TRAJECTORY_MODULE = join(REPO, "src", "dsh", "trajectory.ts");
const VSCODE_STUB = join(REPO, "scripts", "vscodeTestStub.ts");
/** 运行期用 CJS `require` 取 esbuild：不让它被折进本测试产物（esbuild 的 JS API 依赖自身
 *  文件位置定位二进制，折进 bundle 会失效）。类型仍走 `import type`。 */
const esbuild = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");

const BANNER = {
  js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
};
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** 本次运行的全部材料都在这一个系统临时根下（不在仓库内，录制见证后清理）。 */
const tmpRoot = mkdtempSync(join(tmpdir(), "trajectory-probe-cli-"));
const CONTROLLED_ROOT = resolve(tmpRoot);
const SOURCES_ROOT = join(tmpRoot, "sources");
const CONTROLLED_HOME = join(tmpRoot, "home");

// ── 1. 闸门：来源与子进程环境 ─────────────────────────────────────────────

/** 受控根内？`relative` 为空或不是 `..` 开头（且不是绝对路径）即在内。 */
function insideControlled(path: string): boolean {
  const rel = relative(CONTROLLED_ROOT, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** spawn 前的**读路径闸门**：`--source` 只允许受控根内的合成材料。 */
function assertSourceGate(args: readonly string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--source") continue;
    const value = args[index + 1];
    assert.ok(typeof value === "string" && value !== "", "闸门：--source 必须有值");
    assert.ok(insideControlled(value), "闸门：--source 必须落在本次合成材料根内");
  }
}

/** 子进程环境闸门：`HOME` / `USERPROFILE` 必须被改成受控根（否则默认扫描会打真实家目录）。 */
function controlledEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: CONTROLLED_HOME, HOME: CONTROLLED_HOME };
  assert.strictEqual(env.USERPROFILE, CONTROLLED_HOME, "闸门：子进程 USERPROFILE 必须是受控根");
  assert.strictEqual(env.HOME, CONTROLLED_HOME, "闸门：子进程 HOME 必须是受控根");
  assert.notStrictEqual(env.USERPROFILE, process.env.USERPROFILE, "闸门：必须真的覆盖进程的 USERPROFILE");
  assert.notStrictEqual(env.HOME, process.env.HOME, "闸门：必须真的覆盖进程的 HOME");
  return env;
}

/** 真实家目录不得出现在 CLI 输出里（`--source` 模式本就不打印路径）。 */
const REAL_HOME = process.env.USERPROFILE ?? homedir();
function runCli(cli: string, args: readonly string[]): { code: number; output: string } {
  assertSourceGate(args);
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: controlledEnv(),
    cwd: REPO,
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.ok(typeof result.status === "number", `子进程必须有退出码：${output.slice(0, 400)}`);
  if (REAL_HOME !== "") {
    assert.ok(!output.includes(REAL_HOME), "闸门：输出不得出现真实家目录路径");
  }
  assert.ok(!output.includes(CONTROLLED_HOME), "受控运行也不回显受控根路径");
  return { code: result.status as number, output };
}

const countOf = (output: string, pattern: RegExp): number => {
  const matched = pattern.exec(output);
  assert.ok(matched !== null, `输出里找不到 ${pattern}`);
  return Number(matched[1]);
};

/** 「输入覆盖缺口 N 条」只在缺口 > 0 时打印；缺行就是 0（不是解析失败）。 */
const countOr = (output: string, pattern: RegExp, fallback: number): number => {
  const matched = pattern.exec(output);
  return matched === null ? fallback : Number(matched[1]);
};

/** 从 CLI 输出里取出判定用的五个字面量。 */
function countsOf(output: string): { expected: number; compared: number; missing: number; mismatched: number; gaps: number } {
  return {
    expected: countOf(output, /应当比较 (\d+) 条/),
    compared: countOf(output, /已比较 (\d+) 条/),
    missing: countOf(output, /未比较（缺失） (\d+) 条/),
    mismatched: countOf(output, /错配 (\d+) 条/),
    gaps: countOr(output, /输入覆盖缺口 (\d+) 条/, 0),
  };
}

// ── 2. 合成材料（会话日志 + 诱饵默认目录） ───────────────────────────────

const BASE = Date.UTC(2026, 9, 9, 0, 0, 0);
const logBytes = (events: readonly unknown[]): Buffer =>
  zlib.zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8"));

/** 两个轮次：正文 / 思考+工具调用 / 现代与旧信封结果 / 两次 attempt（其一无首帧时刻）。 */
const CLEAN_A = [
  { type: "turn/start", seq: 0, time: BASE, data: { turn: 1 } },
  { type: "step/start", seq: 1, time: BASE, data: { turn: 1, step: 1 } },
  { type: "user/message", seq: 2, time: BASE + 1000, data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "受控合成问题一" }] } },
  { type: "assistant/attempt", seq: 3, time: BASE + 1500, data: { turn: 1, step: 1, stream: [{ time: BASE + 1800, text: "受" }] } },
  {
    type: "assistant/message", seq: 4, time: BASE + 2000,
    data: {
      turn: 1, step: 1,
      message: { id: "a1", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "受控合成回答一" }] },
      stream: [{ time: BASE + 1900, text: "受" }],
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  },
  { type: "turn/end", seq: 5, time: BASE + 3000, data: { turn: 1, reason: { kind: "completed" } } },
  { type: "turn/start", seq: 6, time: BASE + 4000, data: { turn: 2 } },
  { type: "step/start", seq: 7, time: BASE + 4000, data: { turn: 2, step: 1 } },
  { type: "user/message", seq: 8, time: BASE + 5000, data: { id: "u2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "受控合成问题二" }] } },
  { type: "assistant/attempt", seq: 9, time: BASE + 5500, data: { turn: 2, step: 1, stream: [{ time: BASE + 5600 }] } },
  {
    type: "assistant/message", seq: 10, time: BASE + 6000,
    data: {
      turn: 2, step: 1,
      message: {
        id: "a2", role: "assistant", source: { provider: "p", model: "m" },
        content: [{ type: "reasoning", text: "受控合成思考" }, { type: "tool-call", name: "Read", arguments: '{"file_path":"/controlled/read.md"}' }],
      },
    },
  },
  { type: "tool/result", seq: 11, time: BASE + 6500, data: { turn: 2, step: 1, message: { role: "tool", content: [{ type: "text", text: '{"outer":{"inner":[1,2]}}' }, { type: "image", attachment: { name: "synthetic" } }] } } },
  { type: "tool/result", seq: 12, time: BASE + 6600, data: { turn: 2, step: 1, message: { role: "tool", content: [{ type: "tool-result", content: [null, { type: "text", text: "{oops" }] }] } } },
  { type: "turn/end", seq: 13, time: BASE + 8000, data: { turn: 2, reason: { kind: "completed" } } },
];

/** 诱饵：只有扫到「受控 HOME」才会出现（`DecoyTool` 是它的指纹）。 */
const DECOY = [
  { type: "turn/start", seq: 0, time: BASE, data: { turn: 1 } },
  { type: "step/start", seq: 1, time: BASE, data: { turn: 1, step: 1 } },
  { type: "user/message", seq: 2, time: BASE + 1000, data: { id: "d1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "诱饵" }] } },
  { type: "assistant/message", seq: 3, time: BASE + 2000, data: { turn: 1, step: 1, message: { id: "da", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "tool-call", name: "DecoyTool", arguments: "{}" }] } } },
  { type: "turn/end", seq: 4, time: BASE + 3000, data: { turn: 1, reason: { kind: "completed" } } },
];

const CLEAN_A_FILE = join(SOURCES_ROOT, "clean-a", "session.v4.jsonl.zstd");
mkdirSync(dirname(CLEAN_A_FILE), { recursive: true });
writeFileSync(CLEAN_A_FILE, logBytes(CLEAN_A));
const DECOY_FILE = join(CONTROLLED_HOME, ".dsh", "sessions", "decoy-ws", "decoy-session", "session.v4.jsonl.zstd");
mkdirSync(dirname(DECOY_FILE), { recursive: true });
writeFileSync(DECOY_FILE, logBytes(DECOY));

// ── 3. 用 esbuild API 私有构建（控制组 / 注入组） ─────────────────────────

/**
 * 注入桩：转发真实派生模块，然后丢掉**恰好一条合法助手行**，并写下运行期命中记录。
 *
 * 命中记录写在**本 bundle 旁边**（由 `import.meta.url` 推出来），不把临时路径写进桩里：
 * 这样注入产物的字节只随「被替换的真实模块」变化，跨运行可复现（见证里的 sha256 才有意义）。
 */
function stubSource(realSha: string, realBytes: number): string {
  const specifier = TRAJECTORY_MODULE.replace(/\\/g, "/");
  return `/**
 * 【受控故障注入桩】由 scripts/trajectoryProbeCli.test.ts 在运行时生成，
 * **只在本次测试的临时目录里存在**；仓库源码里没有这份文件，也没有任何对应开关。
 * 行为：转发真实 \`src/dsh/trajectory.ts\`，丢掉恰好一条合法助手行（kind==="message"
 * 且 seq 命中某个 assistant/message 事件），并把丢行事实写进运行期命中记录。
 */
import { writeFileSync } from "node:fs";
import * as real from "${specifier}";

export * from "${specifier}";

const RECORD = new URL("./fault-runtime-record.json", import.meta.url);
const REAL = { file: "src/dsh/trajectory.ts", sha256: ${JSON.stringify(realSha)}, bytes: ${realBytes} };
let droppedOnce = false;

export function deriveTrajectoryModel(events: readonly any[], includeCompaction: boolean): any {
  const model: any = real.deriveTrajectoryModel(events as any, includeCompaction as any);
  const assistantSeqs = new Set<unknown>();
  for (const event of events as readonly any[]) {
    if (event?.type === "assistant/message") assistantSeqs.add(event.seq);
  }
  let dropped: any = null;
  if (!droppedOnce) {
    for (const turn of model.turns) {
      for (const group of turn.groups) {
        const at = group.cells.findIndex((cell: any) => cell.kind === "message" && assistantSeqs.has(cell.seq));
        if (at < 0) continue;
        const cell = group.cells.splice(at, 1)[0];
        model.cellCount -= 1;
        dropped = { kind: cell.kind, seq: cell.seq, index: cell.index, turn: cell.turn, step: cell.step, group: group.title };
        droppedOnce = true;
        break;
      }
      if (dropped !== null) break;
    }
  }
  writeFileSync(RECORD, JSON.stringify({ hits: dropped === null ? 0 : 1, dropped, real: REAL }, null, 2) + "\\n", "utf8");
  return model;
}
`;
}

/** 把 Align CLI 打进临时目录；`stubFile` 给了就把派生模块换成注入桩。 */
async function buildAlign(outfile: string, stubFile?: string): Promise<{ outfile: string; bundleSha256: string; bytes: number }> {
  assert.ok(insideControlled(outfile), "闸门：产物必须落在受控临时根内");
  assert.ok(resolve(ALIGN_ENTRY).startsWith(resolve(REPO)), "闸门：构建入口只能来自本仓库");
  const plugins: Plugin[] = [];
  if (stubFile !== undefined) {
    assert.ok(insideControlled(stubFile), "闸门：注入桩必须在受控临时根内");
    plugins.push({
      name: "trajectory-probe-cli-controlled-replacement",
      setup(build) {
        /**
         * 用一个**语言中立的虚拟路径**当模块名（内容仍从临时目录读）：否则 esbuild 会把
         * 桩的绝对路径写进产物注释，注入产物的 sha256 就会随机取到目录名而漂——
         * 见证里的哈希也就不再可复现。`resolveDir` 指向桩所在目录，让桩里那条
         * 「真实派生模块」的绝对引用照常解析。
         */
        build.onResolve({ filter: /^\.\.\/src\/dsh\/trajectory$/ }, () => ({
          path: "trajectory-controlled-replacement.ts",
          namespace: "trajectory-probe-cli-controlled",
        }));
        build.onLoad({ filter: /.*/, namespace: "trajectory-probe-cli-controlled" }, () => ({
          contents: readFileSync(stubFile, "utf8"),
          loader: "ts",
          resolveDir: dirname(stubFile),
        }));
      },
    });
  }
  await esbuild.build({
    entryPoints: [ALIGN_ENTRY],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
    banner: BANNER,
    jsx: "automatic",
    absWorkingDir: REPO,
    alias: { vscode: VSCODE_STUB },
    ...(plugins.length === 0 ? {} : { plugins }),
  });
  const bytes = readFileSync(outfile);
  return { outfile, bundleSha256: sha256(bytes), bytes: bytes.length };
}

const CONTROL_CLI = join(tmpRoot, "align-control.mjs");
const FAULT_CLI = join(tmpRoot, "align-fault.mjs");
const STUB_FILE = join(tmpRoot, "injected-stub", "trajectory-controlled-replacement.ts");
/** 注入桩按 `import.meta.url` 把命中记录写在自己旁边 —— 即注入产物的同级目录。 */
const RUNTIME_RECORD = join(tmpRoot, "fault-runtime-record.json");
mkdirSync(dirname(STUB_FILE), { recursive: true });

const realTrajectoryBytes = readFileSync(TRAJECTORY_MODULE);
const control = await buildAlign(CONTROL_CLI);
writeFileSync(STUB_FILE, stubSource(sha256(realTrajectoryBytes), realTrajectoryBytes.length), "utf8");
const fault = await buildAlign(FAULT_CLI, STUB_FILE);

const witness: Record<string, unknown> = {
  suite: "trajectoryProbeCli",
  controlledRoot: CONTROLLED_ROOT,
  entry: "scripts/trajectoryAlignProbe.ts",
  control: { outfile: relative(REPO, control.outfile), bundleSha256: control.bundleSha256, bytes: control.bytes },
  fault: {
    outfile: relative(REPO, fault.outfile),
    bundleSha256: fault.bundleSha256,
    bytes: fault.bytes,
    injected: {
      stub: { file: relative(REPO, STUB_FILE), sha256: sha256(readFileSync(STUB_FILE)), bytes: readFileSync(STUB_FILE).length },
      replacedModule: { file: "src/dsh/trajectory.ts", sha256: sha256(realTrajectoryBytes), bytes: realTrajectoryBytes.length },
    },
  },
};

let failed = false;
try {
  // ── 4. 闸门自测：非受控来源必须被拒绝 ─────────────────────────────────
  {
    assert.throws(
      () => runCli(CONTROL_CLI, ["--source", TRAJECTORY_MODULE]),
      /闸门/,
      "闸门：拿仓库里的真实文件当 --source 必须被拒绝（不 spawn）",
    );
    assert.throws(
      () => runCli(CONTROL_CLI, ["--source", join(homedir(), ".dsh", "sessions")]),
      /闸门/,
      "闸门：真实家目录路径必须被拒绝",
    );
    assert.ok(insideControlled(CLEAN_A_FILE), "合成材料必须在受控根内");
  }

  // ── 5. 来源模式：默认扫描看不见（受控 HOME 的诱饵），--source 只看显式文件 ──
  {
    // 不传 --source：在受控 HOME 上必须只看到诱饵那一份（2 条样本）。
    // 这条同时证明 HOME 覆盖真的生效——否则读到的是真实家目录。
    const scan = runCli(CONTROL_CLI, []);
    assert.ok(scan.output.includes("来源：默认会话目录扫描"), "默认分支要如实声明自己走了默认扫描");
    assert.strictEqual(countOf(scan.output, /发现 (\d+) 份会话日志/), 1, "受控 HOME 里只放了一份诱饵日志");
    assert.strictEqual(countsOf(scan.output).expected, 2, "受控 HOME 里只有诱饵那一份（1 助手 + 1 用户）");

    const controlled = runCli(CONTROL_CLI, ["--source", CLEAN_A_FILE]);
    assert.strictEqual(controlled.code, 0, `受控对照必须全绿：${controlled.output}`);
    assert.ok(controlled.output.includes("Source: controlled --source mode, 1 explicit file(s)"), "英文受控来源声明");
    assert.strictEqual(controlled.output.includes(".dsh"), false, "受控模式不得回显默认目录路径");
  }

  // ── 6. M04 对照：同源不注入 → expected=compared=4、missing=0、退出码 0 ──
  const controlRun = runCli(CONTROL_CLI, ["--source", CLEAN_A_FILE]);
  const controlCounts = countsOf(controlRun.output);
  {
    assert.strictEqual(controlRun.code, 0, `退出码必须是字面值 0：${controlRun.output}`);
    assert.deepStrictEqual(controlCounts, { expected: 4, compared: 4, missing: 0, mismatched: 0, gaps: 0 });
    assert.ok(controlRun.output.includes("轨迹账本展示口径与官方一致 ✓"), "对照必须宣告一致");
  }

  // ── 7. M04 注入：丢一条合法助手行 → missing=1、退出码字面值 2 ──────────
  const faultRun = runCli(FAULT_CLI, ["--source", CLEAN_A_FILE]);
  const faultCounts = countsOf(faultRun.output);
  {
    assert.strictEqual(faultRun.code, 2, `退出码必须是字面值 2（缺失，不是错配 1、不是零样本 3、不是覆盖 4）：${faultRun.output}`);
    assert.deepStrictEqual(faultCounts, { expected: 4, compared: 3, missing: 1, mismatched: 0, gaps: 0 });
    assert.ok(faultRun.output.includes("账本没有该 seq 的助手记录（来源无法折出）"), "缺失原因必须是稳定的固定串");
    assert.ok(!faultRun.output.includes("轨迹账本展示口径与官方一致 ✓"), "缺失不得宣告一致");
    assert.ok(faultRun.output.includes("有应当比较却没能比较的样本"), "判定文案要落在缺失上");
  }

  // ── 8. 命中身份固定 + 两次运行逐字同判 ────────────────────────────────
  const record = JSON.parse(readFileSync(RUNTIME_RECORD, "utf8")) as {
    hits: number;
    dropped: { kind: string; seq: number; index: number; turn: number; step: number; group: { kind: string; step: number } };
    real: { file: string; sha256: string; bytes: number };
  };
  {
    assert.strictEqual(record.hits, 1, "注入桩必须真的丢掉了一行");
    assert.deepStrictEqual(
      { kind: record.dropped.kind, seq: record.dropped.seq, index: record.dropped.index, turn: record.dropped.turn, step: record.dropped.step },
      { kind: "message", seq: 4, index: 2, turn: 1, step: 1 },
      "被丢的必须是第一条合法助手行（固定身份）",
    );
    assert.deepStrictEqual(record.dropped.group, { kind: "step", step: 1 }, "丢行后分组不变量仍成立，缺失才是唯一信号");
    assert.strictEqual(record.real.file, "src/dsh/trajectory.ts", "被替换的必须是真实派生模块");
    assert.strictEqual(record.real.sha256, sha256(realTrajectoryBytes), "命中记录里的 sha256 必须等于被替换模块的当前字节");
    assert.strictEqual(record.real.bytes, realTrajectoryBytes.length);

    const again = runCli(FAULT_CLI, ["--source", CLEAN_A_FILE]);
    const againRecord = JSON.parse(readFileSync(RUNTIME_RECORD, "utf8")) as { hits: number; dropped: unknown };
    assert.strictEqual(again.code, 2, "第二次注入运行同样退出 2");
    assert.deepStrictEqual(countsOf(again.output), faultCounts, "两次运行的计数必须逐字一致");
    assert.strictEqual(againRecord.hits, 1);
    assert.deepStrictEqual(againRecord.dropped, record.dropped, "两次丢的是同一条合法助手行");

    witness.runtime = { hits: record.hits, dropped: record.dropped, runs: { control: controlCounts, fault: faultCounts } };
  }

  // ── 9. 见证自洽：写下的 sha256 必须等于磁盘上的字节 ──────────────────
  {
    const injected = witness.fault as { bundleSha256: string; injected: { stub: { sha256: string }; replacedModule: { sha256: string } } };
    assert.strictEqual((witness.control as { bundleSha256: string }).bundleSha256, sha256(readFileSync(CONTROL_CLI)));
    assert.strictEqual(injected.bundleSha256, sha256(readFileSync(FAULT_CLI)));
    assert.strictEqual(injected.injected.stub.sha256, sha256(readFileSync(STUB_FILE)));
    assert.strictEqual(injected.injected.replacedModule.sha256, sha256(realTrajectoryBytes));
    assert.match(injected.bundleSha256, /^[0-9a-f]{64}$/);
    // 两个产物都不许把临时目录路径写进字节：否则见证里的哈希会随目录名漂，
    // 「同一次替换的产物可复现」就不成立。
    assert.strictEqual(readFileSync(FAULT_CLI, "utf8").includes(tmpRoot), false, "注入产物不得内嵌临时路径");
    assert.strictEqual(readFileSync(CONTROL_CLI, "utf8").includes(tmpRoot), false, "对照产物不得内嵌临时路径");
  }

  console.log(`trajectoryProbeCli.test.ts: 全部断言通过（受控故障演练：对照 0 / 注入 2）`);
  console.log(`[witness] ${JSON.stringify(witness)}`);
} catch (error) {
  failed = true;
  console.error(`[trajectoryProbeCli] 断言失败，临时材料保留在：${tmpRoot}`);
  throw error;
} finally {
  if (!failed) rmSync(tmpRoot, { recursive: true, force: true });
}
