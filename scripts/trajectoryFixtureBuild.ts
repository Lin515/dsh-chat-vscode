/**
 * 【脚本定位】工具型 · 零 token · **读本机会话日志** —— 显式调用，绝不进 `npm test`。
 *
 * 把一份**真实会话日志**派生（用产品自己的 `deriveTrajectoryModel`）成可提交的
 * 预览夹具：`test/fixtures/trajectory/<name>.json`。
 *
 * 成功之后由同批的 `trajectoryFixtureVerify.ts`（离线、只看夹具、不看源日志）复核。
 *
 * ## 它不做什么
 *
 * - **不是 `npm test` 的一部分**：标准测试不得读用户日志目录。本脚本只在被**显式**
 *   调用时才跑，产物是普通文件，之后由离线校验段读它。
 * - 不打印正文、不打印路径、不打印会话 id、不打印参数原文、不打印异常原文。
 * - 不修改源日志（只读）。
 *
 * ## 可见文案
 *
 * 全部固定文案在 `fixtureCliText.ts` 的 `FIXTURE_CLI_MESSAGES` 里，**中英两套**，失败与成功
 * 输出都同时给出两种语言（不引入语言开关，结果与机器 locale 无关）。
 *
 * ## 退出码（「明确未执行」必须非零）
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 写出并**读回做完整登记校验**通过（唯一算成功的情形） |
 * | 2 | 用法/配置问题：没给 `--source`、源文件不存在或不是普通文件、`--name` 非法或**形状命中秘密规则**、拒绝覆盖、仓库根/声明源定位不到 |
 * | 3 | 读取/解码/派生/深度超限/结构不变量/写盘或读回校验失败（**不落盘**或清理临时文件） |
 * | 4 | 脱敏后（或加上 `provenance` 之后）的内容**仍然命中秘密扫描规则**（**任何文件都不写**） |
 *
 * ## 秘密防线（顺序固定）
 *
 * 1. **入口**：`--name` 形状命中秘密规则 → 退出 2，在读源与写盘之前；
 * 2. **写盘前**：扫整份 `{ provenance, model }` 对象（键与值都扫）→ 命中即退出 4，
 *    **零次 `writeFileSync`**（`provenance` 的 metadata 同样不能先落 `.tmp`）；
 * 3. **写盘后**：读回临时文件，做**完整登记校验**（成员级肯定证据 + 自洽重算 + 整份扫描）
 *    → 通过才原子改名。
 *
 * ## 来源字节快照（TOCTOU）与**严格**解码口径
 *
 * 源日志**只读一次**（`readSourceBytes`）：摘要、字节数与派生事件全部吃同一份字节，
 * 解码走 `decodeSessionLogBytesStrict`（字节接口）。**不得**再按路径解码一次 —— 两次读盘
 * 之间文件可变，摘要与事件就会异源。
 *
 * 严格口径（与 `sessionLog.ts` 里 `decodeSessionLogBytes` 的宽容默认并存，互不影响）：
 *
 * - **整份输入必须由完整合法 zstd 帧构成**：不搜索下一个魔数、不把「完整前缀 + 垃圾」当成功；
 *   `Last_Block` / `Block_Type`（保留值 3 直接拒）/ 有效载荷 / 声明了的校验和字节都要在；
 * - 每一帧都由**原生引擎**解压（`rejectGarbageAfterEnd`）：内容大小与校验和由引擎判定
 *   （错误校验和抛 `ZSTD_error_checksum_wrong`），引擎回报的消耗字节数必须恰为该帧长度；
 * - **拼接全部解压字节之后按字节判 fatal UTF-8**（`TextDecoder(..., {fatal:true})`）：
 *   合法跨帧多字节码点照旧通过；**源里本来就合法的字面 U+FFFD 必须原样保留** ——
 *   不能拿「解出的字符串里有没有 U+FFFD」当判据（那会把合法源误拒）；
 * - 非空 JSONL 行必须是**完整 JSON 对象**：合法非 durable 元数据对象允许，坏 JSON /
 *   `null` / 数组 / 标量统一走固定出口（退出 3、不写任何文件）；最后一行无换行本身合法。
 * - 完整空帧不算解码失败；「零 durable 事件」仍由下面既有的 `noDurableEvents` 语义拒绝。
 *
 * ## 深度与结构化字段
 *
 * - 模型对象图或结构化 JSON 文本超过 `MAX_FIXTURE_DEPTH` → 退出 3 的**固定文案**
 *   （递归实现会抛 `RangeError`，那种异常原文可能带内容与路径）；
 * - 结构化 JSON（`schemaDetail` / `inputDetail` 等）先做**深层完整脱敏**，再按字段上限截断：
 *   整体超限时记进 `truncatedFields`（`payloadReduced` 因此为真、`payloadMeasurementEligible`
 *   为假），不静默放行、也不靠调大 `--limit` 掩盖。
 *
 * ## 字段上限的 0 值语义
 *
 * `--limit 0`（以及负值）= **不截断（无上限）**，不是「上限为零」：脱敏原样放行、结构不变量
 * 不做长度上限比较，两处共用 `limitApplies` 这一个判定点；登记里的 `redaction.fieldLimit`
 * 就是调用方给的值。默认上限 2000 的行为不变。负数 / 小数 / 非数字仍是配置错误（退出 2）。
 *
 * ## 登记校验的边界
 *
 * `validateFixturePayload` 的绿灯只说明**这份载荷自己跟自己一致**：把 `sourceSha256` /
 * `extractor.sha256` / `derive.sha256` 换成任意摘要它照样通过。**来源真实性**只能靠读那份源
 * （需单独批准），不能由登记自洽反推。
 *
 * 用法：
 *   node build/trajectory-fixture-build.mjs --source <日志路径> --name default
 *   node build/trajectory-fixture-build.mjs --source <日志路径> --name long --out test/fixtures/trajectory
 *
 * 选项：
 *   --source <path>      源会话日志（也可用环境变量 DSH_FIXTURE_SOURCE）
 *   --name <name>        夹具名（同时是文件名主键；`[a-z0-9-]+`，且形状不得命中秘密规则）
 *   --out <dir>          输出目录（默认 test/fixtures/trajectory）
 *   --limit <n>          单字段截断上限（默认 2000；0 = 不截断，不做长度上限比较）
 *   --accept-new-source  仅允许覆盖「既有出处登记**完整成立**、但源 sha256 不同」的夹具；
 *                        坏 JSON / 缺成员 / 未知成员 / 类型不符时该开关无效
 *   --repo-root <dir>    仓库根（默认从脚本位置向上找含 package.json 与 src/dsh/trajectory.ts 的目录；
 *                        也可用 DSH_FIXTURE_REPO_ROOT）
 *   --extractor-source <repo 相对路径>  出处登记里 `extractor` 的**源码**文件（必须是 .ts/.tsx，
 *                        且真实存在；默认 scripts/trajectoryFixtureBuild.ts）
 *   --derive-source <repo 相对路径>     出处登记里 `derive` 的**源码**文件（默认 src/dsh/trajectory.ts）
 *
 * ## 出处登记的 hash 口径
 *
 * `extractor.sha256` / `derive.sha256` 是**声明的那份 TS 源码**的哈希：写盘前先确认文件存在、
 * 是普通文件、且扩展名是 `.ts`/`.tsx`；**绝不**拿正在运行的 bundle（`build/*.mjs`）的哈希
 * 冒称源码哈希。定位不到就当作配置错误退出 2，不写任何文件。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative as relativePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeSessionLogBytesStrict, parseSessionLogStrict } from "./sessionLog";
import { deriveTrajectoryModel } from "../src/dsh/trajectory";
import type { TrajectoryModel } from "../src/shared/trajectory";
import type { SessionWireEvent } from "../src/dsh/protocol";
import {
  DEFAULT_FIELD_LIMIT,
  FIXTURE_INVARIANT_CODES,
  FIXTURE_REDACTION_VERSION,
  FixtureDepthError,
  canonicalJson,
  capabilitiesOf,
  checkFixtureInvariants,
  exceedsDepth,
  findSecretHits,
  redactTrajectoryModel,
  scanFixtureSecrets,
  structureOf,
  validateFixturePayload,
  type FixtureInvariantIssue,
  type FixtureStructure,
  type RedactionStats,
} from "./trajectoryFixture";
import { FIXTURE_CLI_EXIT, FIXTURE_RULE_IDS, fixtureCliLines, type FixtureCliMessageKey } from "./fixtureCliText";

/** 允许出现**裸摘要**的精确位置（语义路径）。别处的 64 位串照旧扫。 */
const DIGEST_WHITELIST = [
  "$.provenance.sourceSha256",
  "$.provenance.extractor.sha256",
  "$.provenance.derive.sha256",
  "$.provenance.modelSha256",
] as const;

/** 出处登记：**只有哈希、版本、计数与派生量**（不含路径 / 会话 id / 内容）。 */
export interface FixtureProvenance {
  fixture: string;
  /** 源日志的 SHA-256 —— 可追溯的锚点（哈希是锚点，不是「内容真实」的独立证明）。 */
  sourceSha256: string;
  /** 日志格式版本：`v3` / `v4` / `legacy`。 */
  sourceFormat: string;
  /** 源日志里的事件类型计数（结构统计）。 */
  sourceEventCounts: Record<string, number>;
  sourceBytes: number;
  redaction: {
    version: number;
    rules: string[];
    stats: RedactionStats;
    timeShiftMs: number;
    fieldLimit: number;
  };
  /** 声明并实际存在的**源码**文件与它的 sha256（绝不是运行中的 bundle）。 */
  extractor: { file: string; sha256: string };
  derive: { file: string; sha256: string };
  structure: FixtureStructure;
  capabilities: Record<string, number | boolean>;
  /** `seq` 映射：逐条记录的源 `seq` 就保留在模型自身的 `cell.seq` 上。 */
  seqMapping: { retainedIn: "cell.seq"; count: number; range: [number, number] | null };
  /** 脱敏后模型的规范化 JSON 哈希（离线校验拿它比对，防手改）。 */
  modelSha256: string;
  /** 截断过的字段（逐字段计数）。 */
  truncatedFields: Record<string, number>;
  /** 为真表示**截断过载荷**：这份夹具**不得**用于 M06 全链路载荷测量。 */
  payloadReduced: boolean;
  /** 上一条的可读派生量（`!payloadReduced`），给测量脚本当闸门用。 */
  payloadMeasurementEligible: boolean;
  /** 写盘前的结构不变量检查：列出检查码；`issues` 必须为空（非空时本脚本退出 3）。 */
  invariants: { checks: string[]; issues: FixtureInvariantIssue[] };
  generatedBy: string;
}

interface ParsedArgs {
  source?: string;
  name?: string;
  out: string;
  limit: number;
  acceptNewSource: boolean;
  repoRoot?: string;
  extractorSource: string;
  deriveSource: string;
}

/**
 * 用法文本（中英两套）与失败出口。
 *
 * `fail()` 是**唯一**的失败出口：退出码取 {@link FIXTURE_CLI_EXIT}，文案取文案表，
 * 先中文行后英文行；不回显源路径、夹具名、参数原文或异常原文。
 */
const USAGE = fixtureCliLines("usage");

function fail(code: number, key: FixtureCliMessageKey, params?: Record<string, string | number | boolean>): never {
  const [zh, en] = fixtureCliLines(key, params);
  process.stderr.write(`${zh}\n${en}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs | undefined {
  const parsed: ParsedArgs = {
    source: process.env.DSH_FIXTURE_SOURCE,
    out: join("test", "fixtures", "trajectory"),
    limit: DEFAULT_FIELD_LIMIT,
    acceptNewSource: false,
    extractorSource: join("scripts", "trajectoryFixtureBuild.ts"),
    deriveSource: join("src", "dsh", "trajectory.ts"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") parsed.source = argv[++i];
    else if (arg === "--name") parsed.name = argv[++i];
    else if (arg === "--out") parsed.out = argv[++i] ?? parsed.out;
    else if (arg === "--limit") parsed.limit = Number(argv[++i]);
    else if (arg === "--accept-new-source") parsed.acceptNewSource = true;
    else if (arg === "--repo-root") parsed.repoRoot = argv[++i];
    else if (arg === "--extractor-source") parsed.extractorSource = argv[++i] ?? parsed.extractorSource;
    else if (arg === "--derive-source") parsed.deriveSource = argv[++i] ?? parsed.deriveSource;
    else if (arg === "--help" || arg === "-h") return undefined;
    else {
      // **不回显参数原文**：参数里可能带着秘密（凭据、路径）。
      process.stderr.write(`${fixtureCliLines("unknownArgument")[0]}\n${fixtureCliLines("unknownArgument")[1]}\n${USAGE[0]}\n${USAGE[1]}\n`);
      return undefined;
    }
  }
  return parsed;
}

/** 从文件名判断日志格式版本（只看文件名，不读内容）。 */
function formatOf(file: string): string {
  const match = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/.exec(basename(file));
  if (match === null) return "unknown";
  return match[2] === undefined ? "legacy" : `v${match[2]}`;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 既有夹具出处登记的读取结果。
 *
 * `invalid` 表示这份文件**不能**被覆盖：坏 JSON、顶层不是对象、缺 `provenance`、
 * 或登记形状不合法（`fixture` 不是本文具名、四份摘要缺一或不是合法 sha256）。
 * `--accept-new-source` 只在 `valid` 且源不同时生效。
 */
type PreviousProvenance =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; sourceSha256: string };

/**
 * 判定既有夹具的出处登记是否**完整成立**（用肯定证据，不是只看 `sourceSha256` 一个字段）。
 *
 * 之所以要「看全部成员」：`--accept-new-source` 的授权范围只是「登记完整、但派生自另一份
 * 源日志」。登记不完整（缺成员 / 多出未知成员 / 类型不符）时「这份文件是什么」就无从确认，
 * 此时任何开关都不得把它当成可覆盖对象 —— 否则一个破损或被塞了额外含义的文件会被静默顶掉。
 *
 * 判据：交给 {@link validateFixturePayload} 做**成员级**校验（`provenance.` 前缀的问题码）。
 * 自洽性问题（重算对不上）**不**让文件变成不可覆盖 —— 那属于「内容可疑」，由人工另行处理，
 * 不在这里判（避免把「形状合法」与「内容自洽」混成一个拒绝理由）。
 *
 * **边界（不得外推）**：这是形状 + 自洽判据，不是来源真实性验证。哈希只是锚点，
 * 能说明「这份夹具自称派生自哪份源」，不能证明它确实来自那份源、也不能证明登记没被伪造；
 * 换掉 `sourceSha256` / `extractor.sha256` / `derive.sha256` 后验证器照样通过。
 */
function readPreviousProvenance(fixturePath: string, expectedName: string): PreviousProvenance {
  if (!existsSync(fixturePath)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  const issues = validateFixturePayload(parsed, {
    sha256Hex,
    digestPaths: DIGEST_WHITELIST,
    expectedChecks: INVARIANT_CHECKS,
    expectedFixtureName: expectedName,
  });
  if (issues.some((issue) => issue.code.startsWith("provenance."))) return { kind: "invalid" };
  const provenance = parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ? undefined
    : (parsed as { provenance?: unknown }).provenance;
  const sourceSha256 = provenance !== null && typeof provenance === "object" && !Array.isArray(provenance)
    ? (provenance as Record<string, unknown>).sourceSha256
    : undefined;
  if (typeof sourceSha256 !== "string") return { kind: "invalid" };
  return { kind: "valid", sourceSha256 };
}

/** 仓库根判据：`package.json` + `src/dsh/trajectory.ts` + `scripts/sessionLog.ts` 同时存在。 */
function looksLikeRepo(dir: string): boolean {
  return existsSync(join(dir, "package.json"))
    && existsSync(join(dir, "src", "dsh", "trajectory.ts"))
    && existsSync(join(dir, "scripts", "sessionLog.ts"));
}

/**
 * 定位仓库根：显式参数 → 环境变量 → 从**当前模块位置**向上找。
 *
 * 用 `import.meta.url` 只是为了拿到一个起点（打包后在 `build/` 或临时目录都行），
 * **不拿它当「源码所在路径」**——源码哈希走 {@link hashDeclaredSource} 的显式声明。
 */
function resolveRepoRoot(explicit?: string): string | undefined {
  const candidates = [explicit, process.env.DSH_FIXTURE_REPO_ROOT]
    .filter((value): value is string => typeof value === "string" && value !== "");
  for (const candidate of candidates) {
    const dir = resolve(candidate);
    if (looksLikeRepo(dir)) return dir;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 16; depth += 1) {
    if (looksLikeRepo(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 取「声明的源码文件」并算它的 sha256。
 *
 * 四条硬约束：路径必须在**仓库内**、扩展名必须是 `.ts`/`.tsx`、必须是存在的普通文件、
 * **真实路径**（跟着符号链接走）也必须落在仓库内。任何一条不成立都返回 `undefined`
 * （调用方按配置错误退出 2）——这样**不可能**把运行中的 bundle（`.mjs`）的哈希写进
 * `extractor.sha256` / `derive.sha256`。
 *
 * 包含性判据用 `path.relative`（**肯定证据**）：不能用「`resolved` 去掉 `repoRoot` 前缀再看
 * 有没有 `..`」那种写法 —— 仓库兄弟目录 `…/repo-sibling/foreign.ts` 去掉 `…/repo` 前缀后是
 * `-sibling/foreign.ts`，看着像仓库内，其实在仓库外。
 *
 * 整个函数包在 try/catch 里：`statSync` / `readFileSync` / `realpathSync` 的 I/O 异常
 * （权限、竞态、目录）同样返回 `undefined`，不让异常原文与本机路径漏到 stderr。
 */
function hashDeclaredSource(repoRoot: string, declared: string): { file: string; sha256: string } | undefined {
  try {
    if (!/\.(ts|tsx)$/.test(declared)) return undefined;
    // 必须是**仓库内的相对声明**：绝对路径会让下面的「仓库相对」换算失真。
    if (isAbsolute(declared)) return undefined;
    const resolved = resolve(repoRoot, declared);
    const relative = relativePath(repoRoot, resolved);
    // 空 = 就是仓库根本身；`..` 开头 = 在仓库外；仍为绝对路径 = 跨盘/跨根，同样不在仓库内
    if (relative === "" || relative.startsWith("..") || isAbsolute(relative)) return undefined;
    if (!existsSync(resolved)) return undefined;
    if (!statSync(resolved).isFile()) return undefined;
    // **链接真实路径**保护：符号链接指到仓库外时要按「不在仓库内」拒绝，哈希也吃真实文件
    const realFile = realpathSync(resolved);
    const realRelative = relativePath(realpathSync(repoRoot), realFile);
    if (realRelative === "" || realRelative.startsWith("..") || isAbsolute(realRelative)) return undefined;
    // `file` 保留声明里的仓库相对写法（人读的那一份），哈希取真实文件字节
    return { file: relative.replace(/\\/g, "/"), sha256: sha256File(realFile) };
  } catch {
    return undefined;
  }
}

/** 解析 JSONL 行 → durable 事件（严格：非空行必须是完整 JSON 对象，坏行直接固定出口）。 */
function parseEvents(text: string): { events: SessionWireEvent[]; counts: Record<string, number> } {
  /**
   * 严格行解析在 `sessionLog.ts` 里（`parseSessionLogStrict`）：坏 JSON / `null` / 数组 /
   * 标量都抛 `SessionLogError("jsonLine")`，不再静默 `continue`。这里只把结果搬成
   * `SessionWireEvent`，事件 `type` 依旧**不可信**，计数用**无原型对象**。
   */
  const { events: parsed, counts } = parseSessionLogStrict(text);
  const events: SessionWireEvent[] = parsed.map((event) => ({
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: event.data,
  } as SessionWireEvent));
  return { events, counts };
}

/**
 * 安全读取源日志：**只接受普通文件**，任何 I/O 异常（目录 / 设备 / 权限 / 竞态）都返回
 * `undefined`，由调用方落到固定文案。
 *
 * 为什么必须有这一层：`readFileSync` 对目录抛 `EISDIR`，未捕获时 Node 会把异常栈打到
 * stderr ——那里带本机绝对路径与 errno，属于「自由异常 + 本机路径」外泄。
 */
function readSourceBytes(file: string): Buffer | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    return readFileSync(file);
  } catch {
    return undefined;
  }
}

/** 清理临时文件：清理本身失败也不得让异常原文外泄（目标要么旧完整版、要么新完整版）。 */
function removeTempQuietly(file: string): void {
  try {
    rmSync(file, { force: true });
  } catch {
    // 刻意吞掉：这里只在失败出口调用，不能让清理异常盖掉固定文案
  }
}

/** 「这份夹具是不是可用作全载荷测量」的闸门：截断过就不行。清单与 helper 共用同一份。 */
const INVARIANT_CHECKS: string[] = [...FIXTURE_INVARIANT_CODES];

/** 摘要函数（写进出处登记 / 读回校验用；helper 保持零 Node 依赖，由这里注入）。 */
function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const args = parseArgs(process.argv.slice(2));
if (args === undefined) {
  // `--help` 与用法错误都走到这里：打印用法，但**不声称成功**（退出码非零）
  process.stderr.write(`${USAGE[0]}\n${USAGE[1]}\n`);
  process.exit(FIXTURE_CLI_EXIT.usage);
}
if (args.source === undefined || args.source === "") {
  fail(FIXTURE_CLI_EXIT.usage, "sourceMissing");
}
if (args.name === undefined || !/^[a-z0-9][a-z0-9-]*$/.test(args.name)) {
  fail(FIXTURE_CLI_EXIT.usage, "nameInvalid");
}
/**
 * 入口拒绝**秘密形态的** `--name`：名字会进入 `provenance.fixture`，并可能被回显到
 * stderr / 终端 / CI 日志。这里在读源与任何写盘**之前**就拒掉 —— 固定文案、不回显名字。
 */
if (findSecretHits(args.name).length > 0) {
  fail(FIXTURE_CLI_EXIT.usage, "nameSecretShaped");
}
const source = resolve(args.source);
// **不回显源路径 / basename**：那本身就是敏感信息。目录、设备与不可读文件走同一个出口。
const sourceBytes = readSourceBytes(source);
if (sourceBytes === undefined) {
  fail(FIXTURE_CLI_EXIT.usage, "sourceUnreadable");
}
if (!Number.isInteger(args.limit) || args.limit < 0) {
  fail(FIXTURE_CLI_EXIT.usage, "limitInvalid");
}

const repoRoot = resolveRepoRoot(args.repoRoot);
if (repoRoot === undefined) {
  fail(FIXTURE_CLI_EXIT.usage, "repoRootMissing");
}
const extractor = hashDeclaredSource(repoRoot, args.extractorSource);
const derive = hashDeclaredSource(repoRoot, args.deriveSource);
if (extractor === undefined || derive === undefined) {
  fail(FIXTURE_CLI_EXIT.usage, "declaredSourceInvalid");
}

const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");
const fixturePath = join(resolve(args.out), `${args.name}.json`);

/**
 * 覆盖保护：**既有出处登记连最小形状都不成立时一律拒绝**（坏 JSON / 缺 `provenance` /
 * 非法摘要格式 / 关键字段缺失），此时 `--accept-new-source` **不生效**——它只放宽
 * 「登记形状成立、但派生自另一份源日志」这一种情形。
 *
 * 失败文案**不回显 `--name`**：它虽由调用方给出，但形状上可以是凭据（例如
 * `sk-…`），回显到 stderr / CI 日志就是一次泄漏。
 */
const previous = readPreviousProvenance(fixturePath, args.name);
if (previous.kind === "invalid") {
  fail(FIXTURE_CLI_EXIT.usage, "previousProvenanceInvalid");
}
if (previous.kind === "valid" && previous.sourceSha256 !== sourceSha256 && !args.acceptNewSource) {
  fail(FIXTURE_CLI_EXIT.usage, "previousSourceDiffers");
}

/**
 * **唯一一次读盘**就在上面（`readSourceBytes`）：`sourceSha256`、`sourceBytes` 与
 * 派生事件全部吃这**同一份字节快照**。解码必须走**字节接口**
 * （`decodeSessionLogBytesStrict`），不能再按路径读一次 —— 那样两次读盘之间文件可变，
 * 摘要与事件就会来自两份不同的字节（TOCTOU）。
 *
 * **严格口径**：整份字节必须由完整合法 zstd 帧构成（`decodeSessionLogBytesStrict`），
 * 不是「找到完整前缀就算成功」；拼接后再判 fatal UTF-8，JSONL 非空行必须是完整 JSON 对象
 * （`parseSessionLogStrict`）。解码 / 行形状任何一条不成立都走固定的「解码失败」出口
 * （退出 3、不写任何文件、不回显路径或内容）。
 */
let decoded: string | undefined;
try {
  decoded = decodeSessionLogBytesStrict(sourceBytes);
} catch {
  // 严格入口的失败是**预期之内**的分支（帧不完整 / 坏 UTF-8 / 坏 JSON 行）：
  // 只落到固定出口，**不回显异常原文与位置细节**（它们可能带内容或本机路径）。
  decoded = undefined;
}
if (decoded === undefined) fail(FIXTURE_CLI_EXIT.failed, "decodeFailed");
const parsedLog = (() => {
  try {
    return parseEvents(decoded);
  } catch {
    // 坏 JSON / null / 数组 / 标量：统一固定的「解码失败」出口（退出 3、不写文件）
    fail(FIXTURE_CLI_EXIT.failed, "decodeFailed");
  }
})();
const { events, counts } = parsedLog;
if (events.length === 0) fail(FIXTURE_CLI_EXIT.failed, "noDurableEvents");

let model;
try {
  // `hasOlder: false`：夹具代表**整份**日志窗口（不是分页窗口的一页）。
  model = deriveTrajectoryModel(events, false);
} catch {
  // **不回显异常原文**：它可能带着数据（用户内容、路径、凭据）。
  fail(FIXTURE_CLI_EXIT.failed, "deriveFailed");
}

/**
 * **深度闸门**：模型对象图超过 {@link MAX_FIXTURE_DEPTH} 就固定安全失败。
 * 脱敏 / 扫描 / `JSON.stringify` / 规范化都是递归实现，深到一定程度会抛 `RangeError`，
 * 那种异常原文可能带路径与内容 —— 在进入递归**之前**用迭代测深判掉。
 */
if (exceedsDepth(model)) {
  fail(FIXTURE_CLI_EXIT.failed, "modelDepthExceeded");
}

let redacted: TrajectoryModel;
let stats: RedactionStats;
let timeShiftMs: number;
try {
  ({ model: redacted, stats, timeShiftMs } = redactTrajectoryModel(model, { fieldLimit: args.limit }));
} catch (error) {
  // 结构化 JSON 文本自身超深走同一个固定出口；其余异常也不回显原文
  if (error instanceof FixtureDepthError) {
    fail(FIXTURE_CLI_EXIT.failed, "structuredDepthExceeded");
  }
  fail(FIXTURE_CLI_EXIT.failed, "redactionFailed");
}

let structure: FixtureStructure;
let capabilities: Record<string, number | boolean>;
let payloadReduced = false;
try {
  structure = structureOf(redacted);
  capabilities = capabilitiesOf(redacted);

  // 落盘**之前**先扫模型：命中就不写，退出码 4。扫描只报规则名与计数，不回显内容。
  const modelHits = scanFixtureSecrets(redacted);
  if (modelHits.length > 0) {
    fail(FIXTURE_CLI_EXIT.secret, "secretHits", { detail: summarizeHits(modelHits) });
  }

  // 结构不变量：不通过就不写（只报规则码与计数，不回显内容）。
  payloadReduced = Object.keys(stats.truncated).length > 0;
  const issues = checkFixtureInvariants(redacted, {
    fieldLimit: args.limit,
    payloadReduced,
    truncatedFields: stats.truncated,
  });
  if (issues.length > 0) {
    fail(FIXTURE_CLI_EXIT.failed, "invariantIssues", { detail: summarizeIssues(issues) });
  }
} catch (error) {
  if (error instanceof FixtureDepthError) {
    fail(FIXTURE_CLI_EXIT.failed, "structuredDepthExceeded");
  }
  // 统计 / 扫描 / 不变量环节的意外异常：固定文案，不回显异常原文
  fail(FIXTURE_CLI_EXIT.failed, "statsFailed");
}

const provenance: FixtureProvenance = {
  fixture: args.name,
  sourceSha256,
  sourceFormat: formatOf(source),
  sourceEventCounts: Object.fromEntries(Object.entries(counts).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
  sourceBytes: sourceBytes.length,
  redaction: {
    version: FIXTURE_REDACTION_VERSION,
    // 规则清单是**语言中立的稳定 id**：载荷是数据，不进任何单一语言的散文。
    rules: [...FIXTURE_RULE_IDS],
    stats,
    timeShiftMs,
    fieldLimit: args.limit,
  },
  extractor,
  derive,
  structure,
  capabilities,
  seqMapping: { retainedIn: "cell.seq", count: structure.seqCount, range: structure.seqRange },
  modelSha256: sha256Hex(canonicalJson(redacted)),
  truncatedFields: stats.truncated,
  payloadReduced,
  payloadMeasurementEligible: !payloadReduced,
  invariants: { checks: INVARIANT_CHECKS, issues: [] },
  generatedBy: "scripts/trajectoryFixtureBuild.ts",
};

/**
 * **第一道防线：任何 `writeFileSync` 之前，先扫整份 `{ provenance, model }` 对象。**
 *
 * 为什么必须在这一步（而不是靠写盘后的读回校验）：`provenance` 里的 metadata 同样进载荷
 * —— `sourceEventCounts` 的**键**直接来自日志事件的 `type`，`fixture` 来自 `--name`。
 * 只有先扫对象，才能保证零次敏感写入；否则秘密会先落进 `.tmp`，事后删除并不等于没落盘。
 *
 * 摘要白名单仍按精确结构位置 + 合法格式豁免（四处哈希）。命中只报规则名与计数。
 */
const payloadObject = { provenance, model: redacted };
const prewriteHits = scanFixtureSecrets(payloadObject, { digestPaths: DIGEST_WHITELIST });
if (prewriteHits.length > 0) {
  fail(FIXTURE_CLI_EXIT.secret, "prewriteSecretHits", { detail: summarizeHits(prewriteHits) });
}

const payload = `${JSON.stringify(payloadObject, null, 2)}\n`;
try {
  mkdirSync(dirname(fixturePath), { recursive: true });
} catch {
  // 输出目录不可创建：固定文案，不回显路径 / 异常原文
  fail(FIXTURE_CLI_EXIT.failed, "outputDirFailed");
}

/**
 * **第二道防线：先写临时文件 → 读回做**完整登记校验** → 再原子改名**。
 *
 * 读回校验吃 {@link validateFixturePayload}：成员级肯定证据（缺 / 未知 / 类型不符）、
 * 自洽重算（modelSha256 / structure / capabilities / seq 映射 / 截断闸门 / 结构不变量）
 * 与整份秘密扫描。这样「写盘过程把内容弄坏」或「登记与模型不再一致」都在改名之前被拦下，
 * 目标要么是旧的完整版本、要么是校验通过的新版本。
 *
 * **仍然不是来源真实性证明**：它只说明这份载荷自己跟自己一致；换掉 `sourceSha256` /
 * `extractor.sha256` / `derive.sha256` 后照样通过（见 helper 的 `validateFixturePayload`）。
 */
const tmpPath = `${fixturePath}.tmp-${process.pid}`;
let readBackDetail: string | undefined;
let readBackThrew = false;
try {
  writeFileSync(tmpPath, payload, "utf8");
  const readBack = JSON.parse(readFileSync(tmpPath, "utf8")) as unknown;
  const readBackIssues = validateFixturePayload(readBack, {
    sha256Hex,
    digestPaths: DIGEST_WHITELIST,
    expectedChecks: INVARIANT_CHECKS,
    expectedFixtureName: args.name,
  });
  if (readBackIssues.length > 0) readBackDetail = summarizeIssues(readBackIssues);
} catch {
  readBackThrew = true;
}
if (readBackThrew || readBackDetail !== undefined) {
  removeTempQuietly(tmpPath);
  if (readBackThrew) fail(FIXTURE_CLI_EXIT.failed, "readBackThrew");
  fail(FIXTURE_CLI_EXIT.failed, "readBackFailed", { detail: readBackDetail ?? "" });
}
try {
  renameSync(tmpPath, fixturePath);
} catch {
  removeTempQuietly(tmpPath);
  fail(FIXTURE_CLI_EXIT.failed, "renameFailed");
}

/**
 * 成功摘要：**中英两块**（先中文块、后英文块），两块里的数值逐项对应。
 *
 * 刻意**不回显 `--name`**：参数形状可以是凭据（例如 `sk-…`），终端 / CI 日志都会留存。
 * 调用方自己知道传了什么名字；文件名本身在 `--out` 目录里可查。
 */
const successParams = {
  format: provenance.sourceFormat,
  bytes: provenance.sourceBytes,
  sha: sourceSha256.slice(0, 16),
  turns: structure.turns,
  groups: structure.groups,
  cells: structure.cells,
  requests: structure.requests,
  kinds: Object.entries(structure.kinds).map(([kind, count]) => `${kind}:${count}`).join(" "),
  strings: stats.strings,
  paths: stats.paths,
  identities: stats.identities,
  placeholders: stats.placeholders,
  jsonParsed: stats.jsonParsed,
  jsonFallback: stats.jsonFallback,
  shift: timeShiftMs,
  truncated: Object.keys(stats.truncated).join(",") || "—",
  reduced: payloadReduced,
  modelBytes: structure.modelJsonBytes,
  modelSha: provenance.modelSha256.slice(0, 16),
  extractor: `${extractor.file}@${extractor.sha256.slice(0, 16)}`,
  derive: `${derive.file}@${derive.sha256.slice(0, 16)}`,
};
const successKeys = [
  "successWritten", "successSource", "successStructure", "successKinds",
  "successRedaction", "successTruncation", "successModelBytes", "successSourceHashes",
] as const satisfies readonly FixtureCliMessageKey[];
process.stdout.write(`${successKeys.map((key) => fixtureCliLines(key, successParams)[0]).join("\n")}\n`);
process.stdout.write(`${successKeys.map((key) => fixtureCliLines(key, successParams)[1]).join("\n")}\n\n`);

/** 命中摘要：只有规则名与计数。 */
function summarizeHits(hits: readonly { rule: string }[]): string {
  const byRule = new Map<string, number>();
  for (const hit of hits) byRule.set(hit.rule, (byRule.get(hit.rule) ?? 0) + 1);
  return [...byRule.entries()].map(([rule, count]) => `${rule}×${count}`).join("、");
}

/** 不变量摘要：只有规则码与计数。 */
function summarizeIssues(issues: readonly FixtureInvariantIssue[]): string {
  return issues.map((issue) => `${issue.code}×${issue.count}`).join("、");
}
