/**
 * 轨迹预览夹具的**纯脱敏变换**与**秘密扫描**。
 *
 * 用途：把从真实会话日志派生出来的 `TrajectoryModel` 变成可以提交进仓库的
 * `test/fixtures/trajectory/*.json` —— 保留**结构 / 顺序 / 相对时序 / 长度**，
 * 只替换自由文本、路径、身份与绝对时刻。
 *
 * ## 为什么是「等长伪文」而不是「删掉正文」
 *
 * 预览页存在的意义是**肉眼看排版**：省略号、列宽、换行、折叠高度都取决于文本长度。
 * 把正文清空会让预览失去意义，所以这里用**低熵确定性伪文**按原长填充，并**逐字保留
 * 换行位置**。伪文是低熵的（固定词表 + 确定性 PRNG），不是随机高熵串 —— 高熵串会
 * 反过来触发「凭据」扫描规则，也会让 diff 无法阅读。
 *
 * ## 边界
 *
 * - 本模块**不读文件、不写文件、不联网**，纯函数；读日志与落盘在
 *   `trajectoryFixtureBuild.ts`。
 * - 扫描函数**不返回命中内容**（只给规则名与偏移），避免把凭据回显到日志/终端。
 * - 哈希是**锚点**，不是「内容真实」的独立证明；它能证明「这份夹具没被改过」以及
 *   「它派生自哪一份源日志」，不能证明夹具内容与源日志逐字一致（那正是脱敏要打破的）。
 */
import type {
  TrajectoryCell,
  TrajectoryGroup,
  TrajectoryModel,
  TrajectoryRequest,
  TrajectorySourceBlock,
  TrajectoryToolSchema,
  TrajectoryTurn,
} from "../src/shared/trajectory";

/**
 * 脱敏规则的版本。规则改动必须抬这个数，出处登记会跟着变。
 *
 * 当前为 **3**，对应的规则集：
 * - 结构化 JSON 字符串（`schemaDetail` / `inputDetail` 等）：先**完整深脱敏**
 *   （键与类型保留、字符串值按各自键的规则换），再 `JSON.stringify`，最后**按容器截断**；
 * - **深度闸门** `MAX_FIXTURE_DEPTH`：对象图或结构化 JSON 文本超过它就固定安全失败；
 * - 容器级截断照样进 `truncatedFields`，于是 `payloadReduced=true`、
 *   `payloadMeasurementEligible=false`（资格互反由生成器与校验器共同钉住）。
 *
 * **验证器的能力边界（不得说成兼容保证）**：`validateFixturePayload` 对 `redaction.version`
 * 只做「正整数」这一条形状检查，它**不认识**任何版本的规则语义；版本判别来自生成器盖章 +
 * 规则实现，不来自校验器的接受范围。因此「验证器收得下某个旧版本号」既不表示该版本产物
 * 可用，也不表示当前规则向下兼容它。
 */
export const FIXTURE_REDACTION_VERSION = 3;

/** 绝对路径被改写成这个根（仓库里唯一的“路径”约定，不带任何本机信息）。 */
export const REDACTED_WINDOWS_ROOT = "C:\\work\\demo-app";
export const REDACTED_POSIX_ROOT = "/work/demo-app";

/** 相对时刻的锚点：最早一条记录被平移到这个时刻。 */
export const TIME_ANCHOR_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 提供方 / 模型换成中性占位（个人环境不进仓库）。 */
export const PROVIDER_PLACEHOLDER = "provider-a";
export const MODEL_PLACEHOLDER = "model-a";

/** 伪文词表：**低熵**、无敏感语义、中英混排（贴合真实的字宽分布）。 */
const PSEUDO_WORDS = [
  "示例", "文本", "内容", "说明", "记录", "字段", "占位", "条目",
  "data", "text", "value", "item", "note", "info", "field", "sample",
];

/**
 * 默认单字段截断上限（字符）。逐字段登记在 `truncatedFields` 里。
 *
 * 截断与脱敏的**先后顺序不是一处**，别按一个口号理解：
 * - 普通字符串：先按上限砍尾（保留换行位置），再换成等长伪文 —— 长度因此已经是砍过的；
 * - 结构化 JSON 字符串（`schemaDetail` / `inputDetail` 等）：先解析、递归脱敏、序列化，
 *   最后才按上限**截容器**（见 `redactValue` 的 `json` 分支）。
 * 两条路径都会把命中字段记进 `truncatedFields`。
 */
export const DEFAULT_FIELD_LIMIT = 2000;

/**
 * 「字段上限是否真的生效」的**唯一判定点**。
 *
 * 约定：`0`（以及负数）= **不截断（无上限）**，只有正数才是上限。
 *
 * {@link truncate}（脱敏时截不截）与 {@link checkFixtureInvariants}（未截断样本判不判超限）
 * **必须共用这一处**。从前是两处各写一份（`limit <= 0` 与裸的 `value.length > fieldLimit`），
 * 于是 0 在截断路径上是「不截断」、在长度判据上却成了「上限为零」——任何非空字符串都被判
 * 超限，`--limit 0` 在结构不变量环节直接退出 3，「0 = 不截断」这条约定因此实际不可用。
 */
export function limitApplies(fieldLimit: number): boolean {
  return Number.isFinite(fieldLimit) && fieldLimit > 0;
}

/**
 * 夹具支持的**最大嵌套深度**（模型对象图与结构化 JSON 文本各算一次）。
 *
 * 超过它就是**固定安全失败**（调用方按固定文案出口）：脱敏 / 扫描 / `JSON.stringify` /
 * 规范化都是递归实现，深到一定程度会抛 `RangeError`（栈溢出），而那种异常原文可能带
 * 路径与内容。这里用**迭代**测深（显式 BFS，不递归），在进入递归之前先判掉。
 */
export const MAX_FIXTURE_DEPTH = 64;

/** 深度超限的专用失败信号。**消息里不含任何数据**，调用方按固定文案出口。 */
export class FixtureDepthError extends Error {
  constructor() {
    super("fixture-depth-exceeded");
    this.name = "FixtureDepthError";
  }
}

/** 迭代测深：对象图超过 `limit` 层就返回真（显式层数组，不用递归）。 */
export function exceedsDepth(value: unknown, limit: number = MAX_FIXTURE_DEPTH): boolean {
  let level: unknown[] = [value];
  let depth = 0;
  while (level.length > 0) {
    if (depth > limit) return true;
    const next: unknown[] = [];
    for (const entry of level) {
      if (Array.isArray(entry)) {
        for (const item of entry) if (item !== null && typeof item === "object") next.push(item);
      } else if (entry !== null && typeof entry === "object") {
        for (const item of Object.values(entry as Record<string, unknown>)) {
          if (item !== null && typeof item === "object") next.push(item);
        }
      }
    }
    level = next;
    depth += 1;
  }
  return false;
}

/**
 * 建**自有数据属性**。
 *
 * 键名来自日志，可以是 `__proto__` / `constructor` 这类对象原型成员：直接赋值会改原型
 * 或撞上继承成员（`counts["constructor"] ?? 0` 会拿到一个函数）。重建对象一律走这里。
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** 一条扫描命中。**刻意不带命中内容**。 */
export interface SecretHit {
  /** 规则名（英文标识，便于断言与文档引用）。 */
  rule: string;
  /** 在传入字符串里的字符偏移。 */
  at: number;
  /** 命中长度（不含任何原文）。 */
  length: number;
}

/** 秘密扫描规则表。新增规则要同时补 `trajectoryFixture.test.ts` 的注入用例。 */
export const SECRET_RULES: { rule: string; pattern: RegExp }[] = [
  { rule: "url-token", pattern: /[?&]token=[^\s&"']+/gi },
  { rule: "bearer", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { rule: "authorization-header", pattern: /\bauthorization\s*[:=]/gi },
  { rule: "cookie-header", pattern: /\b(set-cookie|cookie)\s*[:=]/gi },
  { rule: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { rule: "github-token", pattern: /\b(ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{16,}/g },
  { rule: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { rule: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { rule: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}/g },
  { rule: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: "windows-user-path", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/g },
  { rule: "posix-home-path", pattern: /\/(home|Users)\/[^/\s"']+/g },
  // 私钥内容的 base64 主体：块头之外再兜一层（有人只贴正文）
  { rule: "base64-blob", pattern: /[A-Za-z0-9+/]{60,}={0,2}/g },
];

/** 在单个字符串里找秘密。**不返回内容**。 */
export function findSecretHits(value: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { rule, pattern } of SECRET_RULES) {
    // 规则表里的正则带 `g`，lastIndex 会跨调用残留 —— 每次都重建一份。
    const scan = new RegExp(pattern.source, pattern.flags);
    for (const match of value.matchAll(scan)) {
      hits.push({ rule, at: match.index ?? 0, length: match[0].length });
    }
  }
  return hits;
}

/** 摘要的合法格式：64 位十六进制（`sha256` 的十六进制写法）。 */
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/** 扫描选项。 */
export interface ScanOptions {
  /**
   * 允许出现「裸摘要」的**语义路径**白名单（点号连接的键名，数组下标写作 `[i]`，
   * 整体以 `$.` 开头，例如 `$.provenance.modelSha256`）。
   *
   * 两条约束缺一不可：**位置**必须精确命中，**值**必须恰好是 {@link DIGEST_PATTERN}。
   * 位置对而格式不对（例如摘要里混进了别的字符）照旧扫；别处（模型正文、未知 metadata、
   * `sourceEventCounts` 的键、自由文本）出现同样的 64 位串也照旧扫
   * ——**不按内容长度全局放行**。
   *
   * 路径里的**键名分段会被转义**（`.` / `[` / `]` / `\` 前面加 `\`）：带点号的恶意键
   * 不能把自己拼成白名单里那种「多级路径」的样子（`{"provenance.modelSha256": …}`
   * 得到的是 `$.provenance\.modelSha256`，与 `$.provenance.modelSha256` 不是同一个位置）。
   */
  digestPaths?: readonly string[];
}

/** 语义路径里一个键名分段的转义：让键名里的分隔符不可能伪装成路径分隔符。 */
function escapePathSegment(key: string): string {
  return key.replace(/([\\.[\]])/g, "\\$1");
}

/**
 * 把白名单里的路径字面量规范成**与内部 walk 同口径**的语义路径。
 *
 * 只认 `$` 开头的 `.<键>` / `[下标]` 串；解析不出来的返回 `undefined`（该条不参与
 * 豁免 —— 写错的白名单只会「少放行」，不会「多放行」）。
 */
function canonicalDigestPath(path: string): string | undefined {
  if (!path.startsWith("$")) return undefined;
  let rest = path.slice(1);
  let out = "$";
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      const match = /^[^.[\]]+/.exec(rest);
      if (match === null) return undefined;
      out += `.${escapePathSegment(match[0])}`;
      rest = rest.slice(match[0].length);
    } else if (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close < 0) return undefined;
      out += rest.slice(0, close + 1);
      rest = rest.slice(close + 1);
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * 递归扫描一份夹具（**键名与字符串值都扫**）。
 *
 * 键名也要扫：`{"sk-…": 1}` 这种把凭据当键用的写法同样会泄露。
 *
 * 返回的 `path` **不可能回显原始键名或值**：对象子项写成 `.<key#序号>`（序号是该键在
 * 所属对象里的位置），数组写 `[i]`，键名命中用 `#key` 结尾。白名单比对用的真实键名只在
 * 内部变量里，绝不进返回值（也不进任何日志）。
 */
export function scanFixtureSecrets(root: unknown, options: ScanOptions = {}): (SecretHit & { path: string })[] {
  const digestPaths = new Set(
    (options.digestPaths ?? [])
      .map(canonicalDigestPath)
      .filter((path): path is string => path !== undefined),
  );
  const hits: (SecretHit & { path: string })[] = [];
  const walk = (value: unknown, safePath: string, semanticPath: string): void => {
    if (typeof value === "string") {
      // 白名单位置 + 合法摘要格式才豁免；两条件任一不成立都照旧扫
      if (digestPaths.has(semanticPath) && DIGEST_PATTERN.test(value)) return;
      for (const hit of findSecretHits(value)) hits.push({ ...hit, path: safePath });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, at) => walk(entry, `${safePath}[${at}]`, `${semanticPath}[${at}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      let at = 0;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        for (const hit of findSecretHits(key)) hits.push({ ...hit, path: `${safePath}#key` });
        walk(entry, `${safePath}.<key#${at}>`, `${semanticPath}.${escapePathSegment(key)}`);
        at += 1;
      }
    }
  };
  walk(root, "$", "$");
  return hits;
}

/** Shannon 熵（bit/char）。伪文必须**低熵**；测试用它钉住「不是随机串」。 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** FNV-1a：把种子字符串折成一个 32 位整数。 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32：小而确定的 PRNG（同种子必得同序列）。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 低熵伪文，长度恰好 `length`。 */
export function pseudotext(length: number, seed: string): string {
  if (length <= 0) return "";
  const random = mulberry32(hashSeed(seed));
  let out = "";
  while (out.length < length) {
    const word = PSEUDO_WORDS[Math.floor(random() * PSEUDO_WORDS.length)] ?? "text";
    for (const ch of word) {
      if (out.length >= length) break;
      out += ch;
    }
    if (out.length < length && random() < 0.3) out += " ";
  }
  return out.slice(0, length);
}

/**
 * 与原串**等长**、且**逐字保留换行位置**的伪文。
 *
 * 换行必须留在原位：预览里的换行决定了行数与折叠高度，`\n` 少了就等于换了一份排版。
 */
export function pseudotextLike(original: string, seed: string): string {
  if (original.length === 0) return "";
  const filler = pseudotext(original.length, seed);
  let out = "";
  for (let i = 0; i < original.length; i += 1) {
    const ch = original[i];
    out += ch === "\n" || ch === "\r" ? ch : (filler[i] ?? " ");
  }
  return out;
}

/** 绝对路径？Windows 盘符 / UNC / POSIX 绝对路径都算。 */
export function isAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /^\/(?!\/)/.test(value);
}

/**
 * 把一个绝对路径改写成占位根，**保留相对结构与扩展名**。
 *
 * 「保留扩展名」不是装饰：文件芯片、`read` 卡片的语言判据都吃扩展名；
 * 「保留相对结构」让目录层级仍然看得见。
 */
export function redactPathValue(value: string): string {
  if (/^[A-Za-z]:\\Users\\/i.test(value)) {
    // C:\Users\<名>\rest → 占位根 + rest
    const rest = value.replace(/^[A-Za-z]:\\Users\\[^\\]+\\?/i, "");
    return rest === "" ? REDACTED_WINDOWS_ROOT : `${REDACTED_WINDOWS_ROOT}\\${rest}`;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const rest = value.replace(/^[A-Za-z]:[\\/]/, "");
    return rest === "" ? REDACTED_WINDOWS_ROOT : `${REDACTED_WINDOWS_ROOT}\\${rest.replace(/\//g, "\\")}`;
  }
  if (/^\\\\/.test(value)) {
    // UNC：丢掉主机名与共享名，只留后面的相对结构
    const rest = value.replace(/^\\\\[^\\]+\\[^\\]+\\?/, "");
    return rest === "" ? REDACTED_WINDOWS_ROOT : `${REDACTED_WINDOWS_ROOT}\\${rest}`;
  }
  if (/^\/(home|Users)\//.test(value)) {
    const rest = value.replace(/^\/(home|Users)\/[^/]+\/?/, "");
    return rest === "" ? REDACTED_POSIX_ROOT : `${REDACTED_POSIX_ROOT}/${rest}`;
  }
  if (/^\//.test(value)) {
    const rest = value.replace(/^\//, "");
    return rest === "" ? REDACTED_POSIX_ROOT : `${REDACTED_POSIX_ROOT}/${rest}`;
  }
  return value;
}

/** 改写串内**出现**的绝对路径（用于保留结构但对内容做脱敏的字符串）。 */
export function redactPathsInside(value: string): string {
  return value
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, (match) => redactPathValue(match))
    .replace(/[A-Za-z]:[\\/][^\s"':]*/g, (match) => (isAbsolutePath(match) ? redactPathValue(match) : match))
    .replace(/\/(?:home|Users)\/[^/\s"']+/g, (match) => redactPathValue(match));
}

/**
 * 身份字段的**确定性伪名**。
 *
 * 两条要求同时成立：① 唯一性（React key 与 `recordId` 的稳定身份靠它；
 * 重复会让后一行被静默丢掉）；② **前缀关系保留** —— `call_1` 与 `call_1:ptc:2`
 * 是父调用与子调用，伪名之后仍要一个是另一个的前缀（跨视图跳转的**等值匹配**
 * 判据靠这个区分「前缀相同但不是同一个 id」）。
 */
export class IdentityMap {
  private readonly byOriginal = new Map<string, string>();
  private next = 1;

  /** 前缀保留：只在 `:` 之前的第一段上做映射，后缀（`:ptc:2` / `:t3`）原样保留。 */
  map(original: string): string {
    const separator = original.indexOf(":");
    const head = separator < 0 ? original : original.slice(0, separator);
    const tail = separator < 0 ? "" : original.slice(separator);
    let mapped = this.byOriginal.get(head);
    if (mapped === undefined) {
      mapped = `id_${this.next}`;
      this.next += 1;
      this.byOriginal.set(head, mapped);
    }
    return `${mapped}${tail}`;
  }
}

/** 值转换时带的路径上下文（用于按字段名分派策略）。 */
type FieldPolicy =
  | "keep"            // 结构 / 枚举 / 标识符：原样保留
  | "identity"        // 身份：确定性伪名
  | "provider"        // 提供方：中性占位
  | "model"           // 模型：中性占位
  | "path"            // 路径：占位根 + 保留相对结构
  | "json"            // 内含 JSON 的字符串：结构保留、值替换
  | "text";           // 其余自由文本：等长低熵伪文

/** 顶层与嵌套的**保留**字段名（结构、枚举、标识符、以及真实工具名）。 */
const KEEP_KEYS = new Set([
  "kind", "status", "purpose", "promptChange", "type", "role", "format", "lang",
  "language", "toolName", "errorCode", "reasoningEffort", "plugin", "round",
  "name", "added", "removed", "attempt", "max", "step", "seq", "index", "number",
  "turn", "requestNumber", "cellCount", "totalSeconds", "hasOlder", "opensTurn",
  "steering", "requestOnly", "isError", "timingRecorded", "usageProvided",
  "images", "files", "count", "input", "cacheRead", "cacheWrite", "output", "think",
  "reasoning", "retryDelayMs", "maxTokens", "temperature",
  // JSON Schema 的**结构位**：键名与类型是结构，值里的自由文本（description）才脱敏
  "required", "enum", "properties", "items", "additionalProperties",
]);

/** 时刻类字段（要统一平移，不能只当数值保留）。 */
const TIME_KEYS = new Set([
  "time", "startedAt", "completedAt", "firstStartedAt", "stepStartTime",
  "firstTokenTime", "completedTime", "assistantFirstTokenTime",
]);

/** 身份字段。 */
const IDENTITY_KEYS = new Set(["callId", "callIds", "id", "recordId", "messageId", "attachmentId"]);

/** 路径字段（单个字符串就是一个路径）。 */
const PATH_KEYS = new Set(["path", "file_path", "filePath", "cwd", "command"]);

/** 可能内含 JSON 的字符串字段。 */
const JSON_STRING_KEYS = new Set(["schemaDetail", "inputDetail", "content", "parameters", "optionsDetail", "raw"]);

/** 子串里可能嵌路径、但整体要保留结构的字段。 */
function policyFor(key: string, value: unknown, parentKey: string): FieldPolicy {
  if (TIME_KEYS.has(key)) return "keep";
  if (key === "provider") return "provider";
  if (key === "model") return "model";
  if (IDENTITY_KEYS.has(key)) return "identity";
  if (key === "attachmentId") return "identity";
  if (PATH_KEYS.has(key)) return "path";
  if (JSON_STRING_KEYS.has(key)) return "json";
  // 附件名：属于「会泄露文件/路径」的自由文本，优先于 keep
  if (key === "name" && (parentKey === "attachment" || parentKey === "file")) return "path";
  if (KEEP_KEYS.has(key)) return "keep";
  if (typeof value === "number" || typeof value === "boolean") return "keep";
  if (value === null) return "keep";
  return "text";
}

/** 脱敏过程中累计的统计（进出处登记，便于判「脱敏真的跑了」）。 */
export interface RedactionStats {
  /** 被替换的字符串总数（伪文 / 路径 / 身份 / 占位合计）。 */
  strings: number;
  paths: number;
  identities: number;
  placeholders: number;
  /** 解析成功并做结构保留的 JSON 字符串数。 */
  jsonParsed: number;
  /** 解析失败、退回等长伪文的 JSON 候选数。 */
  jsonFallback: number;
  /** 逐字段截断计数。 */
  truncated: Record<string, number>;
}

/** 新建一份空统计。`truncated` 用**无原型对象**：键名来自日志，`__proto__` 不能把计数吃掉。 */
export function newRedactionStats(): RedactionStats {
  return {
    strings: 0,
    paths: 0,
    identities: 0,
    placeholders: 0,
    jsonParsed: 0,
    jsonFallback: 0,
    truncated: Object.create(null) as Record<string, number>,
  };
}

export interface RedactOptions {
  /** 时刻统一平移量（毫秒）。 */
  timeShiftMs: number;
  /**
   * 单字段截断上限。**只有正数才是上限**；`0`（或负值）= 不截断（无上限），
   * 与长度判据共用同一谓词 {@link limitApplies}。
   */
  fieldLimit?: number;
  /** 统计累加目标。 */
  stats: RedactionStats;
}

/**
 * 截断（保留换行位置，只砍尾巴）。
 *
 * `limit` 只有**正上限**才截；`0` / 负值 = 不截断（`limitApplies` 判假），原样放行。
 */
function truncate(value: string, limit: number, key: string, stats: RedactionStats): string {
  if (!limitApplies(limit) || value.length <= limit) return value;
  stats.truncated[key] = (stats.truncated[key] ?? 0) + 1;
  return value.slice(0, limit);
}

/** 递归转换任意值。`seed` 决定伪文内容（同输入必得同输出）。 */
function redactValue(
  value: unknown,
  key: string,
  parentKey: string,
  seed: string,
  options: RedactOptions,
  identities: IdentityMap,
): unknown {
  if (typeof value === "number") {
    return TIME_KEYS.has(key) ? value + options.timeShiftMs : value;
  }
  if (typeof value === "boolean" || value === null || value === undefined) return value;

  if (typeof value === "string") {
    const policy = policyFor(key, value, parentKey);
    if (policy === "keep") return value;
    if (policy === "provider") return PROVIDER_PLACEHOLDER;
    if (policy === "model") return MODEL_PLACEHOLDER;
    if (policy === "identity") {
      options.stats.identities += 1;
      return identities.map(value);
    }
    if (policy === "path") {
      options.stats.paths += 1;
      return isAbsolutePath(value) ? redactPathValue(value) : pseudotextLike(value, seed);
    }
    if (policy === "json") {
      const parsed = tryParseJson(value);
      if (parsed !== undefined) {
        // 结构化文本内部也会递归：先**迭代**测深，超限就固定安全失败（不抛 RangeError）
        if (exceedsDepth(parsed)) throw new FixtureDepthError();
        options.stats.jsonParsed += 1;
        const transformed = redactValue(parsed, key, parentKey, seed, options, identities);
        const serialized = JSON.stringify(transformed, null, 2);
        options.stats.strings += 1;
        /**
         * 结构化字段**不得绕过字段上限**：整体超过上限时按容器登记截断（`payloadReduced`
         * 因此为真、`payloadMeasurementEligible` 为假）——不静默放行、也不靠调大 `--limit`
         * 掩盖。内部各字符串值仍按各自的键走正常规则（该截的已经在上面截过）。
         */
        return truncate(serialized, options.fieldLimit ?? DEFAULT_FIELD_LIMIT, key, options.stats);
      }
      options.stats.jsonFallback += 1;
    }
    options.stats.strings += 1;
    const trimmed = truncate(value, options.fieldLimit ?? DEFAULT_FIELD_LIMIT, key, options.stats);
    // 保留结构、只换内容的字符串（例如 error 文案里嵌着路径）走「先抹路径再伪文」
    return pseudotextLike(trimmed, seed);
  }

  if (Array.isArray(value)) {
    return value.map((entry, at) =>
      redactValue(entry, key, parentKey, `${seed}#${at}`, options, identities));
  }

  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(record)) {
    // 键名可能是 `__proto__`：必须建自有属性，不能赋值（否则改掉原型、键整条消失）
    defineOwn(out, childKey, redactValue(childValue, childKey, key, `${seed}.${childKey}`, options, identities));
  }
  return out;
}

/** 只在「看起来像 JSON 且真的能解析」时返回解析结果。 */
function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * 把整份 `TrajectoryModel` 脱敏。
 *
 * 顺序很关键：**先算平移量 → 再逐字段转换**。平移量由原始模型的最早时刻决定，
 * 只算一次，所以所有时刻的**相对间隔逐字不变**（时长 / TTFT / 时间线几何因此不变）。
 */
export function redactTrajectoryModel(
  model: TrajectoryModel,
  options: { fieldLimit?: number } = {},
): { model: TrajectoryModel; stats: RedactionStats; timeShiftMs: number } {
  const timeShiftMs = computeTimeShift(model);
  const stats = newRedactionStats();
  const identities = new IdentityMap();
  const redacted = redactValue(
    model,
    "$model",
    "",
    "fixture",
    { timeShiftMs, fieldLimit: options.fieldLimit ?? DEFAULT_FIELD_LIMIT, stats },
    identities,
  ) as TrajectoryModel;
  return { model: redacted, stats, timeShiftMs };
}

/**
 * 把最早的时刻平移到固定锚点；没有可用时刻时给 0（调用方据此判「无时刻」）。
 *
 * 这里的时刻集合**必须与 {@link checkFixtureInvariants} 的锚点核对逐项一致**
 * （`firstStartedAt` / cells 的 `time`·`startedAt`·`assistantMetrics` 三个时刻 /
 * requests 的三个时刻）：集合一旦漂移，平移量就会偏小，脱敏后那些漏掉的时刻
 * 会落到锚点之前 —— 检查函数会报 `time-before-anchor`。
 */
export function computeTimeShift(model: TrajectoryModel): number {
  let earliest = Number.POSITIVE_INFINITY;
  const consider = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      earliest = Math.min(earliest, value);
    }
  };
  consider(model.firstStartedAt);
  for (const turn of model.turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) {
        consider(cell.startedAt);
        consider(cell.time);
        // 助手计时事实与 `TIME_KEYS` 同属一套平移，必须同样参与「最早时刻」的判定
        consider(cell.assistantMetrics?.stepStartTime);
        consider(cell.assistantMetrics?.firstTokenTime);
        consider(cell.assistantMetrics?.completedTime);
      }
    }
  }
  for (const request of model.requests) {
    consider(request.startedAt);
    consider(request.completedAt);
    consider(request.assistantFirstTokenTime);
  }
  if (!Number.isFinite(earliest)) return 0;
  return TIME_ANCHOR_MS - earliest;
}

/** 规范化 JSON（键排序），用于**稳定**的模型哈希。 */
export function canonicalJson(value: unknown): string {
  const walk = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(walk);
    if (entry !== null && typeof entry === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
        // 同 `redactValue`：键名可能是 `__proto__`，必须建自有属性
        defineOwn(out, key, walk((entry as Record<string, unknown>)[key]));
      }
      return out;
    }
    return entry;
  };
  return JSON.stringify(walk(value));
}

/** UTF-8 字节数（不引 `Buffer`，纯函数模块保持零 Node 依赖）。 */
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/** 结构统计：进出处登记的是**计数**，不是内容。 */
export interface FixtureStructure {
  turns: number;
  groups: number;
  cells: number;
  requests: number;
  kinds: Record<string, number>;
  /** 每条记录 1 基序号对应的源 `seq`（可追溯锚点；同时也是模型的字段）。 */
  seqRange: [number, number] | null;
  seqCount: number;
  /** 模型 JSON 的 **UTF-8 字节数**（M06 的载荷口径；不是 `string.length` 的字符数）。 */
  modelJsonBytes: number;
}

/** 数一遍模型的结构（不含任何文本内容）。 */
export function structureOf(model: TrajectoryModel): FixtureStructure {
  // 无原型对象：`kind` 来自被折叠的数据，`__proto__` 这类键不能把计数吃掉
  const kinds: Record<string, number> = Object.create(null) as Record<string, number>;
  let groups = 0;
  let cells = 0;
  let seqMin = Number.POSITIVE_INFINITY;
  let seqMax = Number.NEGATIVE_INFINITY;
  for (const turn of model.turns) {
    for (const group of turn.groups) {
      groups += 1;
      for (const cell of group.cells) {
        cells += 1;
        kinds[cell.kind] = (kinds[cell.kind] ?? 0) + 1;
        if (Number.isFinite(cell.seq)) {
          seqMin = Math.min(seqMin, cell.seq);
          seqMax = Math.max(seqMax, cell.seq);
        }
      }
    }
  }
  return {
    turns: model.turns.length,
    groups,
    cells,
    requests: model.requests.length,
    kinds,
    seqRange: Number.isFinite(seqMin) ? [seqMin, seqMax] : null,
    seqCount: cells,
    modelJsonBytes: utf8Bytes(JSON.stringify(model)),
  };
}

/** 一条结构不变量问题。**只有规则码与安全定位**，不含文本内容、真实键名或路径。 */
export interface FixtureInvariantIssue {
  code: string;
  count: number;
  /** 安全定位（序号 / 数组下标），例如 `cell#12`；绝不含内容。 */
  at?: string;
}

export interface InvariantOptions {
  /**
   * 脱敏时的单字段截断上限（判「未截断样本里有没有超限字段」）。
   * **仅在有正上限时可判定**：`0` 是「不截断（无上限）」，此时不做长度比较（见 {@link limitApplies}）。
   */
  fieldLimit?: number;
  /** 出处登记里的 `payloadReduced`；不给就按 `truncatedFields` 是否为空推。 */
  payloadReduced?: boolean;
  /** 出处登记里的逐字段截断计数。 */
  truncatedFields?: Record<string, number>;
}

/**
 * 夹具的**结构不变量**检查（离线、只吃模型，不需要源日志）。
 *
 * 钉住的是「脱敏不能改形状」这件事里**可离线核对**的部分：
 *
 * 1. `index` 从 1 连续到 N、`cellCount` 与账本一致、组非空；
 * 2. `seq` / `time` / `startedAt` / `timeSeconds` 的形状（有限数或 `null`，不出现 `undefined`/`NaN`）；
 * 3. 相对时差：脱敏是**统一平移**，所以全部非空时刻都 ≥ {@link TIME_ANCHOR_MS}，且最小值**正好**是它；
 * 4. 身份：`callId` 全局唯一（重复会让 React key / 跳转静默错行）、同一格的 `callIds` 不重复，
 *    且带 `:` 后缀的子调用 id（`c1:ptc:1`）**其前缀头必须也在账本里**（前缀关系是跨视图跳转判据）；
 * 5. 文本长度与截断登记：`payloadReduced` 必须与 `truncatedFields` 一致；**未截断**的样本里
 *    不允许出现超过 `fieldLimit` 的字符串（截断样本另外标记，且不得用于 M06 全载荷测量）。
 *    这条长度判据**仅在有正上限时可判定**：`fieldLimit` 为 `0` 表示不截断（无上限），
 *    此时不做长度比较（`limitApplies`），而不是「上限为零、任何非空串都超限」。
 *
 * 换行位置是否保留无法只靠模型核对（要有源），由脱敏的单测直接钉住。
 */
export function checkFixtureInvariants(
  model: TrajectoryModel,
  options: InvariantOptions = {},
): FixtureInvariantIssue[] {
  const counts = new Map<string, { count: number; at?: string }>();
  const report = (code: string, at?: string): void => {
    const current = counts.get(code);
    if (current === undefined) counts.set(code, { count: 1, ...(at === undefined ? {} : { at }) });
    else current.count += 1;
  };

  const turns = model.turns ?? [];
  const cells = turns.flatMap((turn) => turn.groups.flatMap((group) => group.cells));

  // 1. 序号连续 / 计数一致 / 组非空
  cells.forEach((cell, at) => {
    if (cell.index !== at + 1) report("cell-index-not-continuous", `cell#${at}`);
  });
  if (model.cellCount !== cells.length) report("cell-count-mismatch");
  turns.forEach((turn, t) => {
    turn.groups.forEach((group, g) => {
      if (group.cells.length === 0) report("group-empty", `turn#${t}.group#${g}`);
    });
  });

  // 2. 形状与 null 语义
  for (const cell of cells) {
    if (!Number.isFinite(cell.seq) || cell.seq < 0) report("cell-seq-invalid");
    if (!Number.isFinite(cell.time)) report("cell-time-invalid");
    if (!(cell.timeSeconds === null || (Number.isFinite(cell.timeSeconds) && cell.timeSeconds >= 0))) {
      report("cell-time-seconds-invalid");
    }
    if (!(cell.startedAt === null || (Number.isFinite(cell.startedAt) && cell.startedAt > 0))) {
      report("cell-started-at-invalid");
    }
  }
  for (const request of model.requests ?? []) {
    if (!Number.isFinite(request.seq) || request.seq < 0) report("request-seq-invalid");
    if (!Number.isFinite(request.number) || request.number < 1) report("request-number-invalid");
    if (!(request.startedAt === null || Number.isFinite(request.startedAt))) report("request-started-at-invalid");
    if (!(request.completedAt === null || Number.isFinite(request.completedAt))) report("request-completed-at-invalid");
  }

  // 3. 统一平移：最早时刻正好落在锚点上（相对间隔因此逐字保留）
  const times: number[] = [];
  const consider = (value: unknown): void => {
    if (typeof value === "number" && Number.isFinite(value)) times.push(value);
  };
  consider(model.firstStartedAt);
  for (const cell of cells) {
    consider(cell.time);
    consider(cell.startedAt);
    // 助手计时事实也走同一套平移（`TIME_KEYS` 含这三个键），所以同样纳入锚点核对
    consider(cell.assistantMetrics?.stepStartTime);
    consider(cell.assistantMetrics?.firstTokenTime);
    consider(cell.assistantMetrics?.completedTime);
  }
  for (const request of model.requests ?? []) {
    consider(request.startedAt);
    consider(request.completedAt);
    consider(request.assistantFirstTokenTime);
  }
  if (times.length > 0) {
    if (times.some((value) => value < TIME_ANCHOR_MS)) report("time-before-anchor");
    else if (Math.min(...times) !== TIME_ANCHOR_MS) report("time-anchor-mismatch");
  }

  // 4. 身份唯一与关联
  const allIds = new Set<string>();
  const seenCallIds = new Set<string>();
  for (const cell of cells) {
    if (cell.callId !== undefined) {
      if (seenCallIds.has(cell.callId)) report("call-id-duplicated");
      seenCallIds.add(cell.callId);
      allIds.add(cell.callId);
    }
    const own = new Set<string>();
    for (const id of cell.callIds ?? []) {
      if (own.has(id)) report("call-ids-duplicated-in-cell");
      own.add(id);
      allIds.add(id);
    }
  }
  for (const id of allIds) {
    const separator = id.indexOf(":");
    if (separator <= 0) continue;
    if (!allIds.has(id.slice(0, separator))) report("identity-head-missing");
  }

  // 5. 文本长度与截断登记
  const truncatedFields = options.truncatedFields ?? {};
  const declaredReduced = options.payloadReduced ?? Object.keys(truncatedFields).length > 0;
  if (declaredReduced !== Object.keys(truncatedFields).length > 0) report("payload-reduced-flag-mismatch");
  const fieldLimit = options.fieldLimit ?? DEFAULT_FIELD_LIMIT;
  if (!declaredReduced) {
    /**
     * **只有存在正上限时才做长度比较**（`limitApplies`）。
     *
     * `0` 是 `truncate()` 的「不截断（无上限）」约定，**不是「上限为零」**：不能写回
     * `value.length > fieldLimit` 这种裸比较 —— 那样 `fieldLimit === 0` 会把任何非空字符串
     * 都判超限，与脱敏路径的口径正好相反（`--limit 0` 因此退出 3）。
     * 两处判定共用 {@link limitApplies}，零值语义只有一个判定点。
     */
    if (limitApplies(fieldLimit)) {
      for (const value of allStrings(model)) {
        if (value.length > fieldLimit) report("string-exceeds-field-limit");
      }
    }
  }

  return [...counts.entries()].map(([code, entry]) => ({
    code,
    count: entry.count,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  }));
}

/** 模型里的全部字符串值（不返回键名，供长度类不变量用）。 */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) allStrings(entry, out);
    return out;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) allStrings(entry, out);
  }
  return out;
}

/**
 * 夹具**能力表**：这份真实样本里到底有哪些形态。
 *
 * 为什么要有它：预览/断言的覆盖范围必须**由夹具自己声明并被测试复算**，
 * 否则「某个形态没样本」会被读成「断言通过 = 有这个形态」。
 */
export function capabilitiesOf(model: TrajectoryModel): Record<string, number | boolean> {
  const kinds = new Set<string>();
  let steering = 0;
  let errorRows = 0;
  let toolUpdates = 0;
  let sourceBlocks = 0;
  let schemaDetails = 0;
  let requestOnly = 0;
  let interrupted = 0;
  for (const turn of model.turns) {
    for (const group of turn.groups) {
      for (const cell of group.cells) {
        kinds.add(cell.kind);
        if (cell.steering === true) steering += 1;
        if (cell.status === "error" || cell.isError === true) errorRows += 1;
        if (cell.toolUpdate !== undefined) toolUpdates += 1;
        if ((cell.sourceBlocks?.length ?? 0) > 0) sourceBlocks += 1;
        if (typeof cell.schemaDetail === "string" && cell.schemaDetail !== "") schemaDetails += 1;
        if (cell.requestOnly === true) requestOnly += 1;
        if (cell.error === "@interrupted") interrupted += 1;
      }
    }
  }
  return {
    system: kinds.has("system"),
    user: kinds.has("user"),
    context: kinds.has("context"),
    message: kinds.has("message"),
    tool: kinds.has("tool"),
    subtool: kinds.has("subtool"),
    compacted: kinds.has("compacted"),
    steering,
    errorRows,
    toolUpdates,
    sourceBlocks,
    schemaDetails,
    requestOnly,
    interrupted,
    compactionRequests: model.requests.filter((request) => request.purpose === "compaction").length,
    exceedsVirtualizationThreshold: structureOf(model).cells > 100,
  };
}

/** 仅用于类型引用，避免「导入未使用」把类型擦除掉。 */
export type FixtureModelParts = {
  turn: TrajectoryTurn;
  group: TrajectoryGroup;
  cell: TrajectoryCell;
  request: TrajectoryRequest;
  block: TrajectorySourceBlock;
  schema: TrajectoryToolSchema;
};

/**
 * 结构不变量检查码的**规范清单**：CLI 写进 `provenance.invariants.checks`、验证器按它核对
 * 「清单齐不齐」，两处共用同一份，免得一边加了检查码另一边不知道。
 *
 * 其中 `string-exceeds-field-limit`（未截断样本里出现超限字段）**只在有正上限时才会产生**
 * —— `fieldLimit` 为 `0` 是「不截断」，不做长度比较（见 {@link limitApplies}）；检查码本身
 * 照旧留在清单里，不代表零上限时也会报。
 */
export const FIXTURE_INVARIANT_CODES = [
  "cell-index-not-continuous",
  "cell-count-mismatch",
  "group-empty",
  "cell-seq-invalid",
  "cell-time-invalid",
  "cell-time-seconds-invalid",
  "cell-started-at-invalid",
  "request-seq-invalid",
  "request-number-invalid",
  "request-started-at-invalid",
  "request-completed-at-invalid",
  "time-before-anchor",
  "time-anchor-mismatch",
  "call-id-duplicated",
  "call-ids-duplicated-in-cell",
  "identity-head-missing",
  "payload-reduced-flag-mismatch",
  "string-exceeds-field-limit",
] as const;

/**
 * 一条登记问题。
 *
 * **`code` 前缀 `provenance.` = 成员级问题**（关键成员缺失 / 未知成员 / 类型不符）。
 * 调用方（CLI 的覆盖保护）据此判定「这份登记连形状都不成立」，`--accept-new-source`
 * 不得把它当成可覆盖对象。没有该前缀的是**自洽性**问题（重算对不上）。
 */
export interface ProvenanceIssue {
  code: string;
  count: number;
  /** 安全定位：固定成员名或固定检查码，**绝不含数据**。 */
  at?: string;
}

export interface ValidateFixtureOptions {
  /** 计算 sha256 十六进制。helper 保持零 Node 依赖，哈希函数由调用方注入。 */
  sha256Hex: (text: string) => string;
  /** 允许出现裸摘要的精确语义路径（与写盘前扫描同一份白名单）。 */
  digestPaths?: readonly string[];
  /** 必须全部出现在 `provenance.invariants.checks` 里的检查码。 */
  expectedChecks?: readonly string[];
  /** 期望的夹具名；给了就核对 `provenance.fixture`。 */
  expectedFixtureName?: string;
}

const PROVENANCE_MEMBERS = [
  "fixture", "sourceSha256", "sourceFormat", "sourceEventCounts", "sourceBytes", "redaction",
  "extractor", "derive", "structure", "capabilities", "seqMapping", "modelSha256",
  "truncatedFields", "payloadReduced", "payloadMeasurementEligible", "invariants", "generatedBy",
] as const;
const REDACTION_MEMBERS = ["version", "rules", "stats", "timeShiftMs", "fieldLimit"] as const;
const STATS_MEMBERS = [
  "strings", "paths", "identities", "placeholders", "jsonParsed", "jsonFallback", "truncated",
] as const;
const EXTRACTOR_MEMBERS = ["file", "sha256"] as const;
const STRUCTURE_MEMBERS = [
  "turns", "groups", "cells", "requests", "kinds", "seqRange", "seqCount", "modelJsonBytes",
] as const;
const SEQ_MAPPING_MEMBERS = ["retainedIn", "count", "range"] as const;
const INVARIANTS_MEMBERS = ["checks", "issues"] as const;

/**
 * 校验一份完整夹具载荷（`{ provenance, model }`）：**迭代测深 → 成员级问题 + 自洽性重算 + 整份扫描**。
 *
 * 两条**必须说清楚**的边界：
 *
 * 1. **自洽 ≠ 来源真实**。这里的每一条重算（modelSha256 / structure / capabilities /
 *    seqMapping / 截断闸门）都只说明「这份载荷自己跟自己一致」。把 `sourceSha256`、
 *    `extractor.sha256`、`derive.sha256` 换成任意 64 位十六进制串，验证器**照样通过**
 *    —— 摘要只是锚点，证明不了它真来自那份日志或那份源码。要证来源只能去读那份源
 *    （需单独批准），不能靠这里的绿灯。
 * 2. 成员级判据是**肯定证据**：每个关键成员都必须存在且类型正确；未知成员同样报出来，
 *    不让「多塞一个成员」或「少一个成员」悄悄改变这份登记的含义。未知成员的定位只有**序号**
 *    （原始键名不进展），深度超限给固定码 `provenance.depth-exceeded` 并立即返回。
 */
export function validateFixturePayload(payload: unknown, options: ValidateFixtureOptions): ProvenanceIssue[] {
  const counts = new Map<string, { count: number; at?: string }>();
  const report = (code: string, at?: string): void => {
    const current = counts.get(code);
    if (current === undefined) counts.set(code, { count: 1, ...(at === undefined ? {} : { at }) });
    else current.count += 1;
  };
  const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const isInt = (value: unknown, min = 0): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= min;
  const isIntAny = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
  const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST_PATTERN.test(value);
  const isRange = (value: unknown): boolean =>
    value === null || (Array.isArray(value) && value.length === 2 && isInt(value[0]) && isInt(value[1]));
  const isCountRecord = (value: unknown): value is Record<string, number> =>
    isObject(value) && Object.values(value).every((entry) => isInt(entry));
  /** 成员集合的肯定证据：缺失与未知都报（`where` 是固定前缀，不含数据）。 */
  const checkMembers = (record: Record<string, unknown>, members: readonly string[], where: string): void => {
    for (const name of members) {
      if (!Object.prototype.hasOwnProperty.call(record, name)) report(`provenance.missing:${where}${name}`);
    }
    /**
     * **未知成员只能用序号定位**：键名来自不可信载荷，直接拼进问题码会让调用方
     * （CLI 的失败出口 / 读回校验 / 离线校验）把原始键名打到 stderr 与 CI 日志里，
     * 与「只给规则码与安全定位、不含数据」的承诺冲突。前缀 `provenance.unknown:` 不变
     * ——调用方的「不可覆盖」判据与既有断言都只认前缀，不认后面那段。
     */
    let ordinal = 0;
    for (const key of Object.keys(record)) {
      if (!members.includes(key)) report(`provenance.unknown:${where}#${ordinal}`);
      ordinal += 1;
    }
  };

  /**
   * **深度闸门必须最先做**：成员级校验之后的每一步（`canonicalJson` / `structureOf` /
   * `capabilitiesOf` / `scanFixtureSecrets`）都是递归实现，超深载荷会让它们抛 `RangeError`
   * —— 异常原文可能带路径与内容，而调用方拿不到「这份载荷根本没法校验」这个事实。
   * 这里用**迭代**测深（`exceedsDepth`，不递归），在进入任何递归之前判掉。
   *
   * 码前缀用 `provenance.` 是刻意的：覆盖保护据此判定「这份登记连形状都不成立」，
   * 于是超深既有夹具**不可被覆盖**，落在安全一侧。
   */
  if (exceedsDepth(payload)) {
    report("provenance.depth-exceeded");
    return [...counts.entries()].map(([code, entry]) => ({
      code,
      count: entry.count,
      ...(entry.at === undefined ? {} : { at: entry.at }),
    }));
  }

  if (!isObject(payload)) {
    report("provenance.missing:payload");
    return [...counts.entries()].map(([code, entry]) => ({ code, count: entry.count, ...(entry.at === undefined ? {} : { at: entry.at }) }));
  }
  const provenance = payload.provenance;
  const model = payload.model;
  if (!isObject(provenance)) report("provenance.missing:provenance");
  if (!isObject(model)) report("provenance.missing:model");

  if (isObject(provenance)) {
    checkMembers(provenance, PROVENANCE_MEMBERS, "");
    if (typeof provenance.fixture !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(provenance.fixture)) {
      report("provenance.invalid:fixture");
    } else if (options.expectedFixtureName !== undefined && provenance.fixture !== options.expectedFixtureName) {
      report("provenance.mismatch:fixture");
    }
    if (!isDigest(provenance.sourceSha256)) report("provenance.invalid:sourceSha256");
    if (typeof provenance.sourceFormat !== "string" || !/^(legacy|v\d+|unknown)$/.test(provenance.sourceFormat)) {
      report("provenance.invalid:sourceFormat");
    }
    if (!isCountRecord(provenance.sourceEventCounts)) report("provenance.invalid:sourceEventCounts");
    if (!isInt(provenance.sourceBytes, 1)) report("provenance.invalid:sourceBytes");
    if (!isDigest(provenance.modelSha256)) report("provenance.invalid:modelSha256");
    if (!isCountRecord(provenance.truncatedFields)) report("provenance.invalid:truncatedFields");
    if (typeof provenance.payloadReduced !== "boolean") report("provenance.invalid:payloadReduced");
    if (typeof provenance.payloadMeasurementEligible !== "boolean") {
      report("provenance.invalid:payloadMeasurementEligible");
    }
    if (typeof provenance.generatedBy !== "string" || provenance.generatedBy === "") {
      report("provenance.invalid:generatedBy");
    }

    const redaction = provenance.redaction;
    if (!isObject(redaction)) report("provenance.invalid:redaction");
    else {
      checkMembers(redaction, REDACTION_MEMBERS, "redaction.");
      if (!isInt(redaction.version, 1)) report("provenance.invalid:redaction.version");
      if (!Array.isArray(redaction.rules) || redaction.rules.length === 0
        || !redaction.rules.every((rule) => typeof rule === "string" && rule !== "")) {
        report("provenance.invalid:redaction.rules");
      }
      if (!isIntAny(redaction.timeShiftMs)) report("provenance.invalid:redaction.timeShiftMs");
      if (!isInt(redaction.fieldLimit, 0)) report("provenance.invalid:redaction.fieldLimit");
      const stats = redaction.stats;
      if (!isObject(stats)) report("provenance.invalid:redaction.stats");
      else {
        checkMembers(stats, STATS_MEMBERS, "redaction.stats.");
        for (const name of ["strings", "paths", "identities", "placeholders", "jsonParsed", "jsonFallback"]) {
          if (!isInt(stats[name], 0)) report(`provenance.invalid:redaction.stats.${name}`);
        }
        if (!isCountRecord(stats.truncated)) report("provenance.invalid:redaction.stats.truncated");
      }
    }

    for (const part of ["extractor", "derive"] as const) {
      const entry = provenance[part];
      if (!isObject(entry)) {
        report(`provenance.invalid:${part}`);
        continue;
      }
      checkMembers(entry, EXTRACTOR_MEMBERS, `${part}.`);
      const file = entry.file;
      if (typeof file !== "string" || !/\.(ts|tsx)$/.test(file) || /^[\\/]/.test(file) || /^[A-Za-z]:/.test(file)
        || file.split(/[\\/]/).includes("..") || file === "") {
        report(`provenance.invalid:${part}.file`);
      }
      if (!isDigest(entry.sha256)) report(`provenance.invalid:${part}.sha256`);
    }

    const structure = provenance.structure;
    if (!isObject(structure)) report("provenance.invalid:structure");
    else {
      checkMembers(structure, STRUCTURE_MEMBERS, "structure.");
      for (const name of ["turns", "groups", "cells", "requests", "seqCount", "modelJsonBytes"]) {
        if (!isInt(structure[name], 0)) report(`provenance.invalid:structure.${name}`);
      }
      if (!isCountRecord(structure.kinds)) report("provenance.invalid:structure.kinds");
      if (!isRange(structure.seqRange)) report("provenance.invalid:structure.seqRange");
    }

    if (!isObject(provenance.capabilities)
      || !Object.values(provenance.capabilities).every(
        (value) => typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)),
      )) {
      report("provenance.invalid:capabilities");
    }

    const seqMapping = provenance.seqMapping;
    if (!isObject(seqMapping)) report("provenance.invalid:seqMapping");
    else {
      checkMembers(seqMapping, SEQ_MAPPING_MEMBERS, "seqMapping.");
      if (seqMapping.retainedIn !== "cell.seq") report("provenance.invalid:seqMapping.retainedIn");
      if (!isInt(seqMapping.count, 0)) report("provenance.invalid:seqMapping.count");
      if (!isRange(seqMapping.range)) report("provenance.invalid:seqMapping.range");
    }

    const invariants = provenance.invariants;
    if (!isObject(invariants)) report("provenance.invalid:invariants");
    else {
      checkMembers(invariants, INVARIANTS_MEMBERS, "invariants.");
      if (!Array.isArray(invariants.checks) || !invariants.checks.every((code) => typeof code === "string")) {
        report("provenance.invalid:invariants.checks");
      }
      if (!Array.isArray(invariants.issues)) report("provenance.invalid:invariants.issues");
      else if (invariants.issues.length > 0) report("invariants-issues-not-empty");
      if (options.expectedChecks !== undefined && Array.isArray(invariants.checks)) {
        const checks = invariants.checks as string[];
        const missing = options.expectedChecks.filter((code) => !checks.includes(code));
        if (missing.length > 0) report("invariant-checks-incomplete", missing.join(","));
      }
    }
  }

  // ---- 自洽性重算（**不是**来源真实性验证，见函数头第 1 条） ----
  if (isObject(provenance) && isObject(model)) {
    try {
      const typed = model as unknown as TrajectoryModel;
      if (!Array.isArray(model.turns) || !Array.isArray(model.requests)) throw new Error("shape");
      if (isDigest(provenance.modelSha256) && options.sha256Hex(canonicalJson(typed)) !== provenance.modelSha256) {
        report("model-sha256-mismatch");
      }
      const recomputed = structureOf(typed);
      if (isObject(provenance.structure) && canonicalJson(provenance.structure) !== canonicalJson(recomputed)) {
        report("structure-mismatch");
      }
      if (isObject(provenance.capabilities)
        && canonicalJson(provenance.capabilities) !== canonicalJson(capabilitiesOf(typed))) {
        report("capabilities-mismatch");
      }
      if (isObject(provenance.seqMapping)
        && (provenance.seqMapping.count !== recomputed.seqCount
          || canonicalJson(provenance.seqMapping.range) !== canonicalJson(recomputed.seqRange))) {
        report("seq-mapping-mismatch");
      }
      const truncatedFields = isCountRecord(provenance.truncatedFields) ? provenance.truncatedFields : undefined;
      const reduced = Object.keys(truncatedFields ?? {}).length > 0;
      if (typeof provenance.payloadReduced === "boolean" && provenance.payloadReduced !== reduced) {
        report("payload-reduced-flag-mismatch");
      }
      if (typeof provenance.payloadReduced === "boolean" && typeof provenance.payloadMeasurementEligible === "boolean"
        && provenance.payloadMeasurementEligible !== !provenance.payloadReduced) {
        report("payload-eligibility-mismatch");
      }
      if (isObject(provenance.redaction)) {
        const stats = provenance.redaction.stats;
        if (isObject(stats) && truncatedFields !== undefined && isCountRecord(stats.truncated)
          && canonicalJson(stats.truncated) !== canonicalJson(truncatedFields)) {
          report("payload-reduced-flag-mismatch");
        }
        if (isInt(provenance.redaction.fieldLimit, 0)) {
          const issues = checkFixtureInvariants(typed, {
            fieldLimit: provenance.redaction.fieldLimit,
            ...(typeof provenance.payloadReduced === "boolean" ? { payloadReduced: provenance.payloadReduced } : {}),
            ...(truncatedFields === undefined ? {} : { truncatedFields }),
          });
          if (issues.length > 0) {
            report("invariants-model-mismatch", issues.map((issue) => issue.code).join(","));
          }
        }
      }
    } catch {
      report("model-shape-invalid");
    }
  }

  // ---- 整份扫描：键与值都扫，白名单只豁免「精确位置 + 合法摘要」 ----
  const hits = scanFixtureSecrets(payload, { digestPaths: options.digestPaths ?? [] });
  if (hits.length > 0) report("secret-scan-hit", `hits=${hits.length}`);

  return [...counts.entries()].map(([code, entry]) => ({
    code,
    count: entry.count,
    ...(entry.at === undefined ? {} : { at: entry.at }),
  }));
}
