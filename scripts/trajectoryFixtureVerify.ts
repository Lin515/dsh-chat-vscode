/**
 * 【脚本定位】工具型 · 零 token · **只读夹具、不读源日志** —— 离线校验段。
 *
 * 对一份**已经写在磁盘上**的夹具载荷（`test/fixtures/trajectory/<name>.json`）跑与生成器
 * 读回校验**同一套**判据：成员级肯定证据（缺 / 未知 / 类型不符）+ 自洽重算
 * （`modelSha256` / `structure` / `capabilities` / `seqMapping` / 截断闸门与资格互反 /
 * 结构不变量）+ 整份秘密扫描（键与值都扫，白名单只豁免四个精确摘要位置）。
 *
 * ## 它证明什么、不证明什么
 *
 * 绿灯只说明**这份载荷自己跟自己一致**。它**不**证明：
 * - **来源真实**：摘要只是锚点，把 `sourceSha256` / `extractor.sha256` / `derive.sha256`
 *   换成任意 64 位十六进制串照样通过；
 * - **`redaction.version` 的语义兼容**：校验器只检查它是正整数，不认识任何版本的规则语义；
 * - **帧完整性**：解码器的帧尾容忍与残尾 / 空串情形未作认证。
 *
 * 这三条边界在成功输出里逐条打印（中英两套），避免把绿灯读成来源或完整性背书。
 *
 * ## 深度的安全失败
 *
 * 载荷先过**迭代**测深（`exceedsDepth`）：超过 `MAX_FIXTURE_DEPTH` 就固定报
 * `provenance.depth-exceeded` 并**立即返回**，不进入任何递归（`canonicalJson` /
 * `scanFixtureSecrets` 都是递归实现，超深会抛 `RangeError`，异常原文可能带路径与内容）。
 *
 * ## 退出码
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 校验通过（唯一算成功的情形） |
 * | 2 | 用法 / 输入问题：没给 `--fixture`、文件不存在或不是普通文件、不是合法 JSON、`--name` 非法 |
 * | 3 | 校验未通过（只报规则码与计数，不含任何载荷内容） |
 *
 * 用法：
 *   node build/trajectory-fixture-verify.mjs --fixture test/fixtures/trajectory/<name>.json [--name <name>]
 *
 * 选项：
 *   --fixture <path>  待校验的夹具载荷（必填；只读）
 *   --name <name>     期望的夹具名（给了就核对 `provenance.fixture`）
 *   --help / -h       打印用法（退出码 2，不声称成功）
 *
 * 可见文案同样在 `fixtureCliText.ts` 里，中英两套；失败与成功都**不回显**原路径、夹具名、
 * 载荷或异常栈。
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { FIXTURE_CLI_EXIT, fixtureCliLines, type FixtureCliMessageKey } from "./fixtureCliText";
import { FIXTURE_INVARIANT_CODES, validateFixturePayload, type ProvenanceIssue } from "./trajectoryFixture";

interface ParsedArgs {
  fixture?: string;
  name?: string;
}

/** 与生成器写盘前扫描共用同一份摘要白名单（四处精确位置）。 */
const DIGEST_WHITELIST = [
  "$.provenance.sourceSha256",
  "$.provenance.extractor.sha256",
  "$.provenance.derive.sha256",
  "$.provenance.modelSha256",
] as const;

const USAGE = fixtureCliLines("verifyUsage");

/** 唯一的失败出口：退出码 + 中英两行固定文案，绝不回显数据。 */
function fail(code: number, key: FixtureCliMessageKey, params?: Record<string, string | number | boolean>): never {
  const [zh, en] = fixtureCliLines(key, params);
  process.stderr.write(`${zh}\n${en}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixture" || arg === "--name") {
      const value = argv[++i];
      /**
       * **显式给了开关就必须给值**：`--fixture <文件> --name` 这种末尾缺值，以前会把 `name`
       * 设成 `undefined` —— 于是「调用方明确要求核对夹具名」被静默跳过，还会以 0 退出。
       * 缺值一律按**用法错误**退出 2、打印中英两行用法，且不回显任何参数原文。
       */
      if (value === undefined || value === "") return undefined;
      if (arg === "--fixture") parsed.fixture = value;
      else parsed.name = value;
    } else if (arg === "--help" || arg === "-h") return undefined;
    else {
      // **不回显参数原文**：参数里可能带着秘密（凭据、路径）。
      const [zh, en] = fixtureCliLines("verifyUnknownArgument");
      process.stderr.write(`${zh}\n${en}\n${USAGE[0]}\n${USAGE[1]}\n`);
      return undefined;
    }
  }
  return parsed;
}

/** 摘要函数：helper 保持零 Node 依赖，由调用方注入。 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 问题摘要：**只有规则码与计数**（`at` 也是固定成员名或序号），不含载荷内容。 */
function summarizeIssues(issues: readonly ProvenanceIssue[]): string {
  return issues.map((issue) => `${issue.code}×${issue.count}`).join(",");
}

const args = parseArgs(process.argv.slice(2));
if (args === undefined) {
  process.stderr.write(`${USAGE[0]}\n${USAGE[1]}\n`);
  process.exit(FIXTURE_CLI_EXIT.usage);
}
if (args.fixture === undefined || args.fixture === "") {
  fail(FIXTURE_CLI_EXIT.usage, "verifyFixtureMissing");
}
if (args.name !== undefined && !/^[a-z0-9][a-z0-9-]*$/.test(args.name)) {
  fail(FIXTURE_CLI_EXIT.usage, "verifyNameInvalid");
}

/**
 * 读盘只接受**普通文件**：目录 / 设备 / 权限问题的异常原文（带本机路径）不得外泄，
 * 所以整段包在 try/catch 里，任何失败都走同一条固定文案。
 */
const fixturePath = resolve(args.fixture);
let parsed: unknown;
try {
  if (!statSync(fixturePath).isFile()) fail(FIXTURE_CLI_EXIT.usage, "verifyFixtureUnreadable");
  parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
} catch {
  fail(FIXTURE_CLI_EXIT.usage, "verifyFixtureUnreadable");
}

const issues = validateFixturePayload(parsed, {
  sha256Hex,
  digestPaths: DIGEST_WHITELIST,
  expectedChecks: FIXTURE_INVARIANT_CODES,
  ...(args.name === undefined ? {} : { expectedFixtureName: args.name }),
});
if (issues.length > 0) {
  fail(FIXTURE_CLI_EXIT.failed, "verifyIssues", { detail: summarizeIssues(issues) });
}

const [okZh, okEn] = fixtureCliLines("verifyOk");
const [boundaryZh, boundaryEn] = fixtureCliLines("verifyBoundary");
process.stdout.write(`${okZh}\n${okEn}\n${boundaryZh}\n${boundaryEn}\n`);
