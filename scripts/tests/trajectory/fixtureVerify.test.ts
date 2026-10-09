/**
 * 离线校验 CLI（`scripts/trajectoryFixtureVerify.ts`）的行为回归。
 *
 * 运行：`npm test`（登记在 `esbuild.scripts.mjs` 的 entries 里，产物是
 *       `build/trajectory-fixture-verify.test.mjs`）。**只吃合成材料**，不读用户日志、
 *       不起 dsh、不花 token。
 *
 * 覆盖：
 * - **文案表契约**：每条固定文案都必须中英两套齐全（中文含 CJK、英文不含 CJK）；
 * - 用法：缺 `--fixture`、未知参数（**不回显参数原文**，参数里可能带秘密）；
 * - 输入：文件不存在 / 不是合法 JSON / 不是普通文件 → 退出 2、中英两行固定文案、不回显路径；
 * - `--name` 非法 → 退出 2；
 * - 校验通过：退出 0 + 中英两行结果 + **三条边界声明**（自洽 ≠ 来源真实 / 不代表版本语义兼容 /
 *   不代表帧完整性），且**不写任何文件**；
 * - 校验未通过：退出 3，只报规则码与计数；夹具名不符与载荷被改各自命中；
 * - **超深载荷**：退出 3、含 `provenance.depth-exceeded`，不抛异常、不回显异常栈或本机路径；
 * - 「生成器写出的夹具 → 校验器收得下」这条**跨 CLI** 一致性（两个 CLI 用同一套判据）。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import zlib from "node:zlib";
import { FIXTURE_CLI_MESSAGES, FIXTURE_RULE_IDS, fixtureCliLines } from "../../fixtureCliText";

/**
 * 带参数的文案断言要用**占位符之前的前缀**：
 * 表里存的是 `校验未通过：{detail}。…`，实际输出把 `{detail}` 换成了规则码与计数，
 * 直接拿整条模板去 `includes` 必然失败（这是「文案不拼字符串」的直接后果）。
 */
const prefixOf = (template: string): string => template.split("{")[0];

const REPO = resolve(".");
const BUILD_CLI = resolve("build/trajectory-fixture-build.mjs");
const VERIFY_CLI = resolve("build/trajectory-fixture-verify.mjs");
assert.ok(existsSync(BUILD_CLI), `先跑 npm run build:scripts：找不到 ${BUILD_CLI}`);
assert.ok(existsSync(VERIFY_CLI), `先跑 npm run build:scripts：找不到 ${VERIFY_CLI}`);

const workRoot = mkdtempSync(join(tmpdir(), "trajectory-fixture-verify-"));
const controlledRoot = resolve(workRoot);
const outDir = join(workRoot, "fixtures");
mkdirSync(outDir, { recursive: true });

/** 受控检查：凡带 `--source` 的调用，来源必须落在本次合成材料根内。 */
function assertSourcesControlled(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--source") continue;
    const value = args[i + 1];
    assert.ok(typeof value === "string" && value !== "", "受控检查：--source 必须有值");
    const relativePath = relative(controlledRoot, resolve(value));
    assert.ok(
      relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath)),
      "受控检查：--source 必须落在本次合成材料根内",
    );
  }
}

function run(cli: string, args: string[]): { code: number | null; output: string } {
  assertSourcesControlled(args);
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_FIXTURE_SOURCE: "", DSH_FIXTURE_REPO_ROOT: "" },
  });
  return { code: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// ---------- 0. 文案表契约：每条都必须中英两套齐全 ----------
{
  const cjk = /[\u4e00-\u9fff]/;
  const entries = Object.entries(FIXTURE_CLI_MESSAGES);
  assert.ok(entries.length >= 25, `固定文案条目数应覆盖两个 CLI 的全部出口，实际 ${entries.length}`);
  for (const [key, message] of entries) {
    assert.ok(message.zh.trim() !== "", `${key}：中文文案非空`);
    assert.ok(message.en.trim() !== "", `${key}：英文文案非空`);
    assert.ok(cjk.test(message.zh), `${key}：中文文案必须真的是中文`);
    assert.ok(!cjk.test(message.en), `${key}：英文文案不得夹带中文（英文侧要能独立读懂）`);
  }
  assert.ok(FIXTURE_RULE_IDS.length >= 6, "规则 id 清单非空");
  for (const id of FIXTURE_RULE_IDS) {
    assert.ok(/^[a-z-]+:[a-z-]+$/.test(id), `规则 id 必须是语言中立的稳定形态：${id}`);
  }
}

// ---------- 1. 用法与未知参数 ----------
{
  const missing = run(VERIFY_CLI, []);
  assert.strictEqual(missing.code, 2, "缺 --fixture 必须退出 2");
  assert.ok(missing.output.includes(FIXTURE_CLI_MESSAGES.verifyFixtureMissing.zh), "缺 --fixture：中文固定文案");
  assert.ok(missing.output.includes(FIXTURE_CLI_MESSAGES.verifyFixtureMissing.en), "缺 --fixture：英文固定文案");

  const secret = "sk-verify-argument-secret-0123456789";
  const unknown = run(VERIFY_CLI, ["--", secret]);
  assert.strictEqual(unknown.code, 2, "未知参数必须退出 2");
  assert.ok(!unknown.output.includes(secret), "不回显未知参数原文（可能是秘密）");
  assert.ok(unknown.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.zh), "未知参数：给中文用法");
  assert.ok(unknown.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.en), "未知参数：给英文用法");
}

// ---------- 2. 输入不可读 / 不是合法 JSON / 不是普通文件 ----------
{
  const missingFile = join(workRoot, "sk-verify-missing-file-0123456789.json");
  const missing = run(VERIFY_CLI, ["--fixture", missingFile]);
  assert.strictEqual(missing.code, 2, "夹具不存在必须退出 2");
  assert.ok(missing.output.includes(FIXTURE_CLI_MESSAGES.verifyFixtureUnreadable.zh), "不存在：中文固定文案");
  assert.ok(missing.output.includes(FIXTURE_CLI_MESSAGES.verifyFixtureUnreadable.en), "不存在：英文固定文案");
  assert.ok(!missing.output.includes("sk-verify-missing-file"), "不回显原路径（含秘密形态文件名）");
  assert.ok(!missing.output.includes(workRoot), "不回显工作目录");

  const brokenPath = join(workRoot, "broken.json");
  writeFileSync(brokenPath, '{"provenance": {', "utf8");
  const broken = run(VERIFY_CLI, ["--fixture", brokenPath]);
  assert.strictEqual(broken.code, 2, "坏 JSON 必须退出 2");
  assert.ok(!broken.output.includes("SyntaxError"), "不回显 JSON 解析异常原文");
  assert.ok(!/\n\s+at /.test(broken.output), "不回显异常栈");

  const dirPath = join(workRoot, "a-directory.json");
  mkdirSync(dirPath, { recursive: true });
  const asDirectory = run(VERIFY_CLI, ["--fixture", dirPath]);
  assert.strictEqual(asDirectory.code, 2, "目录必须按输入问题退出 2（不是未捕获异常的 1）");
  assert.ok(!asDirectory.output.includes("EISDIR"), "不回显自由异常原文");

  const badName = run(VERIFY_CLI, ["--fixture", brokenPath, "--name", "Not-Lower-Case"]);
  assert.strictEqual(badName.code, 2, "非法 --name 必须退出 2");
  assert.ok(badName.output.includes(FIXTURE_CLI_MESSAGES.verifyNameInvalid.zh), "非法 --name：中文固定文案");
}

// ---------- 2b. 显式开关**缺值**：按用法错误退出 2，不得静默降级 ----------
{
  /**
   * 缺陷形态：`--fixture <文件> --name`（末尾缺值）以前把 `name` 设成 `undefined`，于是
   * 「调用方明确要求核对夹具名」被静默跳过、还以 0 退出。两个开关各钉一次：缺值必须是
   * **用法错误**（退出 2、中英两行用法、不回显参数原文），且校验**只读**。
   */
  const target = join(outDir, "missing-value-needle.json");
  writeFileSync(target, "{\"controlled\":\"needle\"}\n", "utf8");
  const before = readFileSync(target, "utf8");

  const nameWithoutValue = run(VERIFY_CLI, ["--fixture", target, "--name"]);
  assert.strictEqual(nameWithoutValue.code, 2, "显式 --name 缺值必须退出 2（不得静默跳过名核对）");
  assert.ok(nameWithoutValue.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.zh), "缺值：给中文用法");
  assert.ok(nameWithoutValue.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.en), "缺值：给英文用法");
  assert.ok(!nameWithoutValue.output.includes(target), "缺值：不回显 --fixture 原文");
  assert.strictEqual(readFileSync(target, "utf8"), before, "缺值：校验只读，夹具一字不动");

  const fixtureWithoutValue = run(VERIFY_CLI, ["--fixture"]);
  assert.strictEqual(fixtureWithoutValue.code, 2, "显式 --fixture 缺值仍必须退出 2");
  assert.ok(fixtureWithoutValue.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.zh), "缺值：中文用法");
  assert.ok(fixtureWithoutValue.output.includes(FIXTURE_CLI_MESSAGES.verifyUsage.en), "缺值：英文用法");

  // 对照：值给全时不得被这条规则误伤（同一份坏载荷 → 走到真正的校验分支，退出 3）
  const withValue = run(VERIFY_CLI, ["--fixture", target]);
  assert.strictEqual(withValue.code, 3, "值给全时按载荷内容判失败（3），不是用法错误");
}

// ---------- 3. 生成器写出的夹具必须被校验器收下（跨 CLI 同一套判据） ----------
const validName = "verify-valid";
{
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  const events = [
    { type: "turn/start", seq: 0, time: base, data: { turn: 1 } },
    { type: "step/start", seq: 1, time: base, data: { turn: 1, step: 1 } },
    { type: "user/message", seq: 2, time: base + 1000, data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "受控合成问题" }] } },
    {
      type: "assistant/message",
      seq: 3,
      time: base + 2000,
      data: {
        turn: 1,
        step: 1,
        message: { id: "a1", role: "assistant", source: { provider: "p", model: "m" }, content: [{ type: "text", text: "受控合成回答" }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    },
    { type: "step/end", seq: 4, time: base + 2000, data: { turn: 1, step: 1 } },
    { type: "turn/end", seq: 5, time: base + 3000, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const log = join(workRoot, "session.v4.jsonl.zstd");
  writeFileSync(log, zlib.zstdCompressSync(Buffer.from(`${events.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8")));
  const built = run(BUILD_CLI, [
    "--repo-root", REPO, "--extractor-source", "scripts/trajectoryFixtureBuild.ts",
    "--derive-source", "src/dsh/trajectory.ts", "--out", outDir,
    "--name", validName, "--source", log,
  ]);
  assert.strictEqual(built.code, 0, `先写出一份自洽夹具：${built.output}`);

  const target = join(outDir, `${validName}.json`);
  const before = readdirSync(outDir).slice().sort();
  const ok = run(VERIFY_CLI, ["--fixture", target, "--name", validName]);
  assert.strictEqual(ok.code, 0, `自洽夹具必须通过校验：${ok.output}`);
  assert.ok(ok.output.includes(FIXTURE_CLI_MESSAGES.verifyOk.zh), "通过：中文结果行");
  assert.ok(ok.output.includes(FIXTURE_CLI_MESSAGES.verifyOk.en), "通过：英文结果行");
  // 三条边界必须逐条打印（绿灯不等于来源真实 / 版本语义兼容 / 帧完整）
  assert.ok(ok.output.includes(FIXTURE_CLI_MESSAGES.verifyBoundary.zh), "通过：中文边界声明");
  assert.ok(ok.output.includes(FIXTURE_CLI_MESSAGES.verifyBoundary.en), "通过：英文边界声明");
  assert.ok(!ok.output.includes(target) && !ok.output.includes(workRoot), "通过分支也不回显原路径");
  assert.ok(!ok.output.includes(validName), "通过分支不回显夹具名");
  // 校验是**只读**的：不新增、不删除、不改写任何文件
  assert.deepStrictEqual(readdirSync(outDir).slice().sort(), before, "校验不得增删输出目录里的文件");

  // 夹具名不符 → 退出 3（`provenance.mismatch:fixture`），只报码与计数
  const mismatched = run(VERIFY_CLI, ["--fixture", target, "--name", "another-name"]);
  assert.strictEqual(mismatched.code, 3, "夹具名不符必须退出 3");
  assert.ok(mismatched.output.includes("provenance.mismatch:fixture"), "报出成员级问题码");
  assert.ok(
    mismatched.output.includes(prefixOf(fixtureCliLines("verifyIssues")[0])),
    "未通过：中文固定文案（占位符之前的前缀）",
  );
  assert.ok(
    mismatched.output.includes(prefixOf(fixtureCliLines("verifyIssues")[1])),
    "未通过：英文固定文案（占位符之前的前缀）",
  );
  assert.ok(!mismatched.output.includes("another-name"), "不得回显 --name 原文");

  // 载荷被改（marker 只应出现在报错判据里，不得回显） → 退出 3、`model-sha256-mismatch`
  const payload = JSON.parse(readFileSync(target, "utf8")) as { model: { turns: { groups: { cells: { text?: string }[] }[] }[] } };
  const marker = "sk-verify-tamper-marker-0123456789";
  const firstCell = payload.model.turns[0]?.groups[0]?.cells[0];
  assert.ok(firstCell !== undefined, "注入确认：夹具里有可改的格");
  firstCell.text = marker;
  const tamperedPath = join(outDir, "tampered.json");
  writeFileSync(tamperedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const tampered = run(VERIFY_CLI, ["--fixture", tamperedPath]);
  assert.strictEqual(tampered.code, 3, "被改过的载荷必须退出 3");
  assert.ok(tampered.output.includes("model-sha256-mismatch"), "报出模型哈希不符");
  assert.ok(!tampered.output.includes(marker), "不得回显被改内容");
}

// ---------- 4. 超深载荷：固定 depth 码、不抛异常、不回显栈与路径 ----------
{
  const deep = `${"[".repeat(3000)}${"]".repeat(3000)}`;
  const deepPath = join(outDir, "deep.json");
  writeFileSync(deepPath, `{"provenance":{},"model":{"turns":[],"requests":[],"injected":${deep}},"deep":${deep}}`, "utf8");
  const parsedDeep = JSON.parse(readFileSync(deepPath, "utf8")) as { provenance: unknown; model: unknown };
  assert.ok(parsedDeep.provenance !== null && typeof parsedDeep.model === "object", "注入确认：受控载荷形状合法且超深");
  const result = run(VERIFY_CLI, ["--fixture", deepPath]);
  assert.strictEqual(result.code, 3, "超深载荷必须安全判失败（3），不能是未捕获异常的 1");
  assert.ok(result.output.includes("provenance.depth-exceeded"), "报出固定的成员级 depth 码");
  assert.ok(!/RangeError|Maximum call stack|node:internal/.test(result.output), "不得回显 RangeError / 内部模块");
  assert.ok(!/\n\s+at /.test(result.output), "不得回显异常栈");
  assert.ok(!result.output.includes(REPO) && !result.output.includes(workRoot), "不得回显本机路径");
  assert.ok(!result.output.includes("deep.json"), "不得回显夹具文件名");
}

rmSync(workRoot, { recursive: true, force: true });
console.log("trajectoryFixtureVerify: 离线校验 CLI 行为断言全部通过");
