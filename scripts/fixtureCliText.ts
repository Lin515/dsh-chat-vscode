/**
 * 夹具 CLI 的**固定文案表**（中英两套）与共享常量。
 *
 * 为什么单独成模块：CLI 本体是带副作用的可执行脚本，测试 import 它会真的跑一遍；
 * 文案放这里之后，「两套齐全」就变成**可断言的**事实（`fixtureBuild.test.ts` /
 * `fixtureVerify.test.ts` 直接 import 本表），而不是靠人工纪律。
 *
 * 口径：
 * - **不引入语言开关**：每次失败/成功输出都同时给中文行与英文行，结果与机器 locale 无关；
 * - 文案里的变量一律用 `{名字}` 占位，由 {@link fixtureCliLines} 替换，**不拼字符串**
 *   （中英语序不同）；
 * - 文案只描述**发生了什么**：不回显源路径、夹具名、载荷、参数原文或异常原文。
 *
 * 失败出口只有固定几个：见 {@link FIXTURE_CLI_EXIT}。
 */

/** 输出语言两套：`zh` 与 `en`。 */
export interface FixtureCliMessage {
  zh: string;
  en: string;
}

/** 退出码契约（与 CLI 文件头的表格一致）。 */
export const FIXTURE_CLI_EXIT = {
  /** 成功：写出并通过读回校验 / 离线校验通过。 */
  ok: 0,
  /** 用法与配置问题（含覆盖保护拒绝）。 */
  usage: 2,
  /** 读取 / 解码 / 派生 / 深度超限 / 不变量 / 写盘或读回校验失败。 */
  failed: 3,
  /** 脱敏后（或加上 provenance 后）仍命中秘密规则：任何文件都不写。 */
  secret: 4,
} as const;

/** 脱敏规则 id：**语言中立**，人读说明在各 README 与 CLI 摘要里，不进载荷散文。 */
export const FIXTURE_RULE_IDS: readonly string[] = [
  "text:pseudotext-equal-length",
  "path:placeholder-root-preserve-structure",
  "identity:pseudonym-unique-prefix-preserving",
  "provider-model:neutral-placeholder",
  "time:uniform-shift",
  "json:deep-redact-then-container-truncate",
];

/**
 * 全部固定文案。`{detail}` 是唯一的参数占位（只放**规则名与计数**这类无数据摘要）。
 */
export const FIXTURE_CLI_MESSAGES = {
  usage: {
    zh: [
      "用法：node build/trajectory-fixture-build.mjs --source <会话日志> --name <name> [--out <dir>] [--limit <n>] [--accept-new-source]",
      "  --source 也可用环境变量 DSH_FIXTURE_SOURCE 提供。",
      "  --repo-root / --extractor-source / --derive-source 见文件头「出处登记的 hash 口径」。",
      "本脚本只在被显式调用时运行；`npm test` 不读本机日志。",
    ].join("\n"),
    en: [
      "Usage: node build/trajectory-fixture-build.mjs --source <session log> --name <name> [--out <dir>] [--limit <n>] [--accept-new-source]",
      "  --source may also come from the DSH_FIXTURE_SOURCE environment variable.",
      "  --repo-root / --extractor-source / --derive-source: see the provenance hash rules in the file header.",
      "This script runs only when invoked explicitly; `npm test` never reads local session logs.",
    ].join("\n"),
  },
  unknownArgument: {
    zh: "存在未知参数。",
    en: "Unknown argument.",
  },
  sourceMissing: {
    zh: "未配置来源：请给 --source <日志路径> 或设置环境变量 DSH_FIXTURE_SOURCE。**未执行任何操作**。",
    en: "No source configured: pass --source <log path> or set DSH_FIXTURE_SOURCE. **Nothing was executed**.",
  },
  nameInvalid: {
    zh: "缺少合法的 --name（只允许小写字母、数字与连字符）。**未执行任何操作**。",
    en: "Missing a valid --name (lowercase letters, digits and hyphens only). **Nothing was executed**.",
  },
  nameSecretShaped: {
    zh: "该 --name 的形状命中秘密规则，拒绝使用（请换一个中性夹具名）。**未执行任何操作**。",
    en: "The --name matches a secret pattern and is refused (pick a neutral fixture name). **Nothing was executed**.",
  },
  sourceUnreadable: {
    zh: "源日志不存在或不可读。**未执行任何操作**。",
    en: "The source log is missing or unreadable. **Nothing was executed**.",
  },
  limitInvalid: {
    zh: "--limit 必须是非负整数。**未执行任何操作**。",
    en: "--limit must be a non-negative integer. **Nothing was executed**.",
  },
  repoRootMissing: {
    zh: "定位不到仓库根（需要含 package.json / src/dsh/trajectory.ts / scripts/sessionLog.ts 的目录）。**未执行任何操作**。",
    en: "Cannot locate the repository root (a directory with package.json / src/dsh/trajectory.ts / scripts/sessionLog.ts). **Nothing was executed**.",
  },
  declaredSourceInvalid: {
    zh: "出处登记要声明并哈希的源码文件必须存在、是 .ts/.tsx，且位于仓库内（不接受用运行中的 bundle 冒充源码）。**未执行任何操作**。",
    en: "The source files declared in the provenance entry must exist, be .ts/.tsx, and live inside the repository (a running bundle is not accepted as source). **Nothing was executed**.",
  },
  previousProvenanceInvalid: {
    zh: "既有夹具的出处登记缺失或不可读（坏 JSON / 缺 provenance / 摘要格式或登记形状不合法）。该文件不可被覆盖，请先人工确认并移走它。**未写入**。",
    en: "The existing fixture provenance is missing or unreadable (bad JSON / no provenance / bad digest format or entry shape). That file must not be overwritten; confirm and move it away manually first. **Nothing was written**.",
  },
  previousSourceDiffers: {
    zh: "既有夹具派生自另一份源日志（sha256 不同）。确认要替换时加 --accept-new-source。**未写入**。",
    en: "The existing fixture derives from a different source log (different sha256). Add --accept-new-source to confirm the replacement. **Nothing was written**.",
  },
  decodeFailed: {
    zh: "解码失败（多帧 zstd 解不出来）。**未写入**。",
    en: "Decoding failed (multi-frame zstd could not be decoded). **Nothing was written**.",
  },
  noDurableEvents: {
    zh: "解码出来没有任何 durable 事件。**未写入**。",
    en: "Decoding produced no durable event at all. **Nothing was written**.",
  },
  deriveFailed: {
    zh: "派生账本失败（异常详情不回显）。**未写入**。",
    en: "Deriving the ledger failed (exception details are not echoed). **Nothing was written**.",
  },
  modelDepthExceeded: {
    zh: "派生出的结构嵌套超过夹具支持深度。**未写入**。",
    en: "The derived structure nests deeper than the fixture supports. **Nothing was written**.",
  },
  structuredDepthExceeded: {
    zh: "结构化字段的嵌套超过夹具支持深度。**未写入**。",
    en: "A structured field nests deeper than the fixture supports. **Nothing was written**.",
  },
  redactionFailed: {
    zh: "脱敏失败（异常详情不回显）。**未写入**。",
    en: "Redaction failed (exception details are not echoed). **Nothing was written**.",
  },
  secretHits: {
    zh: "脱敏后仍命中秘密规则：{detail}。**未写入**（请先补规则再重跑）。",
    en: "Redaction output still matches secret patterns: {detail}. **Nothing was written** (extend the rules and rerun).",
  },
  invariantIssues: {
    zh: "结构不变量未通过：{detail}。**未写入**。",
    en: "Structural invariants failed: {detail}. **Nothing was written**.",
  },
  statsFailed: {
    zh: "结构统计或校验失败（异常详情不回显）。**未写入**。",
    en: "Structural statistics or validation failed (exception details are not echoed). **Nothing was written**.",
  },
  prewriteSecretHits: {
    zh: "写盘前的整份扫描命中秘密规则：{detail}。**未写入任何文件**（含临时文件）。",
    en: "The pre-write whole-payload scan matched secret patterns: {detail}. **No file was written** (temporary files included).",
  },
  outputDirFailed: {
    zh: "输出目录不可创建。**未写入**。",
    en: "The output directory cannot be created. **Nothing was written**.",
  },
  readBackFailed: {
    zh: "读回校验失败：{detail}。**未写入目标**（临时文件已清理）。",
    en: "Read-back validation failed: {detail}. **The target was not written** (temporary files cleaned up).",
  },
  readBackThrew: {
    zh: "写盘或读回校验异常。**未写入目标**（临时文件已清理）。",
    en: "Writing or read-back validation raised an error. **The target was not written** (temporary files cleaned up).",
  },
  renameFailed: {
    zh: "原子替换失败。**未写入目标**（临时文件已清理）。",
    en: "The atomic replacement failed. **The target was not written** (temporary files cleaned up).",
  },
  successWritten: {
    zh: "夹具已写出（读回校验通过：哈希一致 + 整份扫描干净）",
    en: "Fixture written (read-back validation passed: hashes agree, whole-payload scan clean)",
  },
  successSource: {
    zh: "  源格式={format} 源字节={bytes} 源sha256={sha}…",
    en: "  source format={format} source bytes={bytes} source sha256={sha}…",
  },
  successStructure: {
    zh: "  结构：轮={turns} 组={groups} 记录={cells} 请求={requests}",
    en: "  structure: turns={turns} groups={groups} cells={cells} requests={requests}",
  },
  successKinds: {
    zh: "  记录种类={kinds}",
    en: "  cell kinds={kinds}",
  },
  successRedaction: {
    zh: "  脱敏：字符串{strings} 路径{paths} 身份{identities} 占位{placeholders} JSON{jsonParsed}/{jsonFallback}",
    en: "  redaction: strings={strings} paths={paths} identities={identities} placeholders={placeholders} JSON={jsonParsed}/{jsonFallback}",
  },
  successTruncation: {
    zh: "  时刻平移={shift}ms 截断字段={truncated} payloadReduced={reduced}",
    en: "  time shift={shift}ms truncated fields={truncated} payloadReduced={reduced}",
  },
  successModelBytes: {
    zh: "  模型 JSON 字节={bytes}（UTF-8） modelSha256={sha}…",
    en: "  model JSON bytes={bytes} (UTF-8) modelSha256={sha}…",
  },
  successSourceHashes: {
    zh: "  源码哈希：extractor={extractor} derive={derive}",
    en: "  source hashes: extractor={extractor} derive={derive}",
  },
  verifyUsage: {
    zh: [
      "用法：node build/trajectory-fixture-verify.mjs --fixture <夹具文件> [--name <夹具名>]",
      "  只读校验一份既有夹具载荷（成员级肯定证据 + 自洽重算 + 整份秘密扫描），不读源日志。",
      "  退出码：0 通过；2 用法 / 输入不可读；3 校验未通过。",
    ].join("\n"),
    en: [
      "Usage: node build/trajectory-fixture-verify.mjs --fixture <fixture file> [--name <fixture name>]",
      "  Read-only validation of an existing fixture payload (member-level positive evidence + self-consistency recomputation + whole-payload secret scan); never reads a source log.",
      "  Exit codes: 0 pass; 2 usage / unreadable input; 3 validation failed.",
    ].join("\n"),
  },
  verifyUnknownArgument: {
    zh: "存在未知参数。",
    en: "Unknown argument.",
  },
  verifyFixtureMissing: {
    zh: "未配置待校验的夹具：请给 --fixture <夹具文件>。**未执行任何操作**。",
    en: "No fixture to validate: pass --fixture <fixture file>. **Nothing was executed**.",
  },
  verifyFixtureUnreadable: {
    zh: "夹具文件不存在、不可读，或不是合法 JSON。**未执行任何操作**。",
    en: "The fixture file is missing, unreadable, or not valid JSON. **Nothing was executed**.",
  },
  verifyNameInvalid: {
    zh: "--name 只允许小写字母、数字与连字符。**未执行任何操作**。",
    en: "--name allows lowercase letters, digits and hyphens only. **Nothing was executed**.",
  },
  verifyIssues: {
    zh: "校验未通过：{detail}。**仅报告规则码与计数，不含载荷内容**。",
    en: "Validation failed: {detail}. **Only rule codes and counts are reported; no payload content**.",
  },
  verifyOk: {
    zh: "校验通过：成员级肯定证据齐全、自洽重算一致、整份扫描干净。",
    en: "Validation passed: member-level positive evidence complete, self-consistency recomputation agreed, whole-payload scan clean.",
  },
  verifyBoundary: {
    zh: [
      "  边界：① 自洽 ≠ 来源真实（摘要可被伪造，本校验不证明夹具来自某份真实日志）；",
      "        ② 不证明 redaction.version 的语义兼容（只检查是正整数）；",
      "        ③ 不证明帧完整性（帧尾容忍与残尾/空串未作认证）。",
    ].join("\n"),
    en: [
      "  Boundaries: (1) self-consistency is not source authenticity (digests can be forged; this check does not prove the fixture came from any real log);",
      "              (2) no semantic compatibility of redaction.version (only a positive integer is checked);",
      "              (3) no frame-level integrity (trailing-byte tolerance and residual/empty payloads are not certified).",
    ].join("\n"),
  },
} as const;

/** 文案 key 的类型（表里的键集合就是清单）。 */
export type FixtureCliMessageKey = keyof typeof FIXTURE_CLI_MESSAGES;

/** 参数替换：只认 `{名字}`，不拼字符串（中英语序不同）。 */
function fill(template: string, params: Record<string, string | number | boolean> | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 取一条文案的**两行**：`[中文, 英文]`（按需带参数）。
 *
 * 输出侧约定：失败时逐行写出（先中文后英文），成功摘要按块写出。
 * 参数值允许布尔（例如 `payloadReduced=true`），替换时统一转成字符串。
 */
export function fixtureCliLines(
  key: FixtureCliMessageKey,
  params?: Record<string, string | number | boolean>,
): [string, string] {
  const message: FixtureCliMessage = FIXTURE_CLI_MESSAGES[key];
  return [fill(message.zh, params), fill(message.en, params)];
}
