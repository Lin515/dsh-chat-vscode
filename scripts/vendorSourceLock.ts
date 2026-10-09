/**
 * M01：**官方 UI 纯逻辑 vendor 副本的源锁**（内容锁 + 双向登记 + 来源自洽）。
 *
 * ## 为什么要有这一层
 *
 * `scripts/trajectoryVendor.test.ts` 是**行为断言**（输入 → 输出），它抓不住
 * 「编辑了但行为没被断言覆盖」的一类漂移：`src/vendor/**` 里多一个不参与计算的字段、
 * 某个 `> 0` 改成 `>= 0` 而负值路径没有对拍样本、对副本以外的地方排序……
 * 都能在行为断言全绿的情况下溜过去（`previousPromptTools` 那次就是这么过了一个季度的）。
 *
 * 这一层补的是**内容级**判据：`src/vendor/**\/*.ts` 与 `scripts/vendorSourceLock.json`
 * 之间的双向登记 + 每份副本的规范化摘要 + 来源声明自洽。它**不替代**行为断言，
 * 两者互补：行为断言管口径，源锁管「这份字节还是不是当初那份」。
 *
 * ## 规范化（允许漂移的边界，唯一一处）
 *
 * 上游原文与本仓库副本的**排版与注释本来就不同**（官方单行压缩 style、副本带一段
 * 中文「本仓库改动」头注释），所以摘要前先过一遍 `normalizeVendorSource`：
 *
 * - 用 TypeScript 解析源码（`createSourceFile`），把 `import` / `export ... from` 的
 *   **模块说明符**按 `normalization.specifierRewrites` 改写，再按
 *   `stripRelativeTsExtension` 去掉相对说明符的 `.ts`（本仓库构建不启用
 *   `allowImportingTsExtensions`）；
 * - 用 `createPrinter({ removeComments: true, newLine: LineFeed })` 打印。
 *
 * 于是**允许漂移的只有**：注释、空白与排版、以及上面那条登记过的说明符改写。
 * 不允许漂移的是：函数体、常量值、接口成员集合、字面量 / 模板串 / 正则的内容、
 * 以及 `return` 换行这类会改变语义的语句形态。
 *
 * **为什么不用全局 replaceAll / 折叠空白**：那样做会把字符串、模板串、正则里的
 * `./layout.ts`、两个连续空格、`return` 换行一起吞掉——判据会在语义已经变了的时候
 * 还报绿。走 AST 是**打印器负责排版、AST 负责语义**；`scripts/vendorSourceLock.test.ts`
 * 里对这几类陷阱各有一条正反断言。
 *
 * ## 上游那一侧的凭据（11/11 离线见证，不是签名认证）
 *
 * `npm test` **不联网、不读官方 checkout（也不用 HEAD）**。上游那一侧的唯一凭据是仓库内的
 * 固定见证素材：`<upstream.fixtureDir>/<upstream.tag>/<官方相对路径>`，逐字节等于固定 tag
 * 上的那一份（导出方式与逐份摘要见 `.agent/temp/trajectory-20261009/s01-m01-implementer/`
 * 的 `fixture-manifest.json`：每份都有字节数 / 文件 sha256 / git blob SHA）。
 *
 * 判据在 `upstreamCoverage: "complete"` 下要求**每一条登记都有原文**：
 * 素材少一份、多一份、改一个字节、或换了规范化规则，都会红——不只是「清单自己跟自己对得上」。
 *
 * 诚实边界：素材是**仓库内的固定见证**，它证明「这份字节从那时起没被改过」，
 * **不是**外部签名认证，也不证明「它确实出自那个 commit」——后者要靠导出时用
 * `git show <SHA>:<path>` 与独立对拍。
 *
 * 这一层的真正作用是：**上游版本一旦换、或本地副本一旦被改，就必须有人显式更新素材与
 * 锁清单并留下声明**——把静默漂移变成一次看得见的动作。
 *
 * ## 消费方
 *
 * - `scripts/vendorSourceLock.test.ts`（`npm test` 的离线断言）；
 * - 手工同步 `src/vendor/**` 时用同一套函数算摘要、写回锁清单（见 `src/vendor/README.md`）。
 * 两侧走同一个 seam：判据拿到的就是 `normalizeVendorSource` / `vendorSourceProblems`。
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import type { Node, SourceFile, StringLiteral, TransformerFactory, VisitResult } from "typescript";

/**
 * TypeScript 编译器**运行时**取（不进 bundle）。
 *
 * `npm run build:scripts` 把每个断言打成单文件 ESM；`typescript` 是 CJS 包，直接
 * `import` 会被整份折进产物、且其中的 `__filename` 在 ESM 里没有定义（实测打包后
 * 一跑就 `ReferenceError`）。这里走 `createRequire`，由 Node 从仓库 `node_modules`
 * 解析——判定脚本本来就跑在仓库里（`npm test`），不引入额外的运行时依赖。
 */
const requireFromHere = createRequire(import.meta.url);
const ts: typeof import("typescript") = requireFromHere("typescript");

/** 一条模块说明符改写：`from` 必须**整串相等**才改写（不做子串替换）。 */
export interface VendorSpecifierRewrite {
  readonly from: string;
  readonly to: string;
}

/** 摘要前的规范化参数（锁清单里的 `normalization` 段）。 */
export interface VendorNormalization {
  /** 相对说明符去掉 `.ts` 后缀。 */
  readonly stripRelativeTsExtension: boolean;
  /** 包名 / 跨包说明符 → 本地 vendor 路径的映射。 */
  readonly specifierRewrites: readonly VendorSpecifierRewrite[];
}

/** 官方那一侧的文件声明（固定 tag 内的仓库相对路径 + 原始字节 + 原始 sha256）。 */
export interface VendorUpstreamFileRef {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** 一条登记：本仓库副本 ↔ 上游文件，以及两侧规范化后的摘要。 */
export interface VendorLockEntry {
  readonly upstream: VendorUpstreamFileRef;
  /** 上游整份文件规范化后的摘要。 */
  readonly upstreamNormalizedSha256: string;
  /** 本仓库副本规范化后的摘要（判据每次重算并与它比对）。 */
  readonly vendorNormalizedSha256: string;
  /** `verbatim` = 一对一副本；`excerpt` = 从官方更大的文件里摘出来的片段。 */
  readonly relation: "verbatim" | "excerpt";
  /** 允许的本地差异，一条一句；空数组表示应当与上游逐字等价。 */
  readonly declaredEdits: readonly string[];
  /** 摘录型条目：摘的是官方那份文件里的哪一段（人读的登记）。 */
  readonly upstreamExtract?: string;
}

/** 锁清单（`scripts/vendorSourceLock.json`）。 */
export interface VendorSourceLock {
  readonly upstream: {
    readonly repo: string;
    readonly tag: string;
    readonly version: string;
    readonly sha: string;
    readonly packages: readonly string[];
    /**
     * 仓库内**离线见证素材**的根目录（仓库相对）：
     * `<fixtureDir>/<tag>/<官方相对路径>`，逐字节等于固定 tag 上的那一份。
     *
     * 它是「上游那一侧」的唯一凭据来源：判据拿全部 11 份逐一核对原始字节数 /
     * 原始 sha256 / 规范化摘要。素材是**仓库内的固定见证**，不是外部签名认证——
     * 它证明的是「这份字节从那时起没被改过」，不是「有人为它签过名」。
     */
    readonly fixtureDir: string;
  };
  readonly normalization: VendorNormalization;
  readonly files: Readonly<Record<string, VendorLockEntry>>;
}

/** 一份源码文本（路径是**仓库相对**、`/` 分隔）。 */
export interface VendorSourceText {
  readonly path: string;
  readonly text: string;
}

/** 判据输入。 */
export interface VendorSourceCheckInput {
  readonly lock: VendorSourceLock;
  /** 磁盘上真实存在的 vendor 副本（由 `collectVendorSources` 枚举）。 */
  readonly vendorFiles: readonly VendorSourceText[];
  /** `src/vendor/README.md` 的正文：来源表是第二处声明，与锁清单交叉校验。 */
  readonly vendorReadme: string;
  /**
   * 上游原文（正式判据传 `collectUpstreamFixtures` 的全量素材；同步期也可额外补充）。
   * 路径用**官方相对路径**（与登记里的 `upstream.path` 逐字对应）。
   */
  readonly upstreamFiles?: readonly VendorSourceText[];
  /**
   * `complete`：每一条登记的上游路径都**必须**有原文，缺一条就红（正式判据用）；
   * `partial`：只核对提供了的那几份（同步期的增量对拍用）。
   */
  readonly upstreamCoverage?: "partial" | "complete";
  /** 任务固定的上游身份锚（tag / SHA）：锁清单必须与它一致。 */
  readonly expectUpstream?: { readonly tag: string; readonly sha: string };
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const VENDOR_DIR = "src/vendor";
/** 官方客户端包的固定前缀：`@deepseek-ai/dsh-client-<目录名>`（包名与仓库目录同名）。 */
const PACKAGE_PREFIX = "dsh-client-";
/** 官方 monorepo 里客户端包的位置：`packages/client/<目录>/…`。 */
const CLIENT_PACKAGE_PATH = /^packages\/client\/([^/]+)\//;

/** `@deepseek-ai/dsh-client-ui-trajectory` → `ui-trajectory`。 */
function packageDirectory(packageName: string): string {
  const tail = packageName.slice(packageName.lastIndexOf("/") + 1);
  return tail.startsWith(PACKAGE_PREFIX) ? tail.slice(PACKAGE_PREFIX.length) : tail;
}

/** `packages/client/ui-trajectory/src/…` → `ui-trajectory`；形状不认识时不猜。 */
function upstreamDirectory(upstreamPath: string): string | undefined {
  return CLIENT_PACKAGE_PATH.exec(upstreamPath)?.[1];
}

/** 打印器只建一次（确定性：去注释 + 固定 LF，避免平台换行差异）。 */
const PRINTER = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });

function rewriteSpecifier(text: string, normalization: VendorNormalization): string {
  for (const rule of normalization.specifierRewrites) {
    if (text === rule.from) return rule.to;
  }
  if (
    normalization.stripRelativeTsExtension &&
    text.startsWith(".") &&
    text.endsWith(".ts")
  ) {
    return text.slice(0, -3);
  }
  return text;
}

/**
 * 规范化一份 vendor 源码：只改 `import` / `export ... from` 的模块说明符，其余交给 AST 打印。
 *
 * @param source - 源码原文（本地副本或上游原文都走这一条）。
 * @param normalization - 允许漂移的说明符规则。
 * @returns 规范化文本（注释已去、排版已定、说明符已改写）。
 */
export function normalizeVendorSource(source: string, normalization: VendorNormalization): string {
  const sourceFile = ts.createSourceFile(
    "vendor-source.ts",
    source,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TS,
  );
  const rewrite = (node: StringLiteral): StringLiteral => {
    // 无论改没改都换成合成节点：打印器对「原文节点」直接切原字节、对合成节点按 AST 打印，
    // 两种路径的引号风格不同；统一走合成路径，上游与本地的输出才可比。
    return ts.factory.createStringLiteral(rewriteSpecifier(node.text, normalization));
  };
  const transformer: TransformerFactory<SourceFile> = (context) => {
    const visit = (node: Node): VisitResult<Node> => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        return context.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          rewrite(node.moduleSpecifier),
          node.attributes,
        );
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        return context.factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          rewrite(node.moduleSpecifier),
          node.attributes,
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    // 根节点本身不需要改（只改 import / export 说明符），所以直接走 `visitEachChild`，
    // 返回值类型就是 `SourceFile`。
    return (file) => ts.visitEachChild(file, visit, context);
  };
  const result = ts.transform(sourceFile, [transformer]);
  try {
    return PRINTER.printFile(result.transformed[0]);
  } finally {
    result.dispose();
  }
}

/**
 * 规范化后取 sha256（十六进制小写）。
 *
 * @param source - 源码原文。
 * @param normalization - 允许漂移的说明符规则。
 * @returns 64 位十六进制摘要。
 */
export function vendorSourceDigest(source: string, normalization: VendorNormalization): string {
  return createHash("sha256").update(normalizeVendorSource(source, normalization), "utf8").digest("hex");
}

/**
 * 递归枚举一个目录下的 `*.ts`，返回的路径以 `pathBase` 为基准（`/` 分隔）。
 *
 * @param dir - 要遍历的绝对目录。
 * @param pathBase - 生成相对路径用的基准目录。
 * @returns 按路径排序的源码文本列表。
 */
function collectSourceFiles(dir: string, pathBase: string): VendorSourceText[] {
  const found: VendorSourceText[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push({
          path: relative(pathBase, absolute).split(sep).join("/"),
          text: readFileSync(absolute, "utf8"),
        });
      }
    }
  };
  walk(dir);
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return found;
}

/**
 * 枚举 `src/vendor/` 下全部 `*.ts`（递归，路径用 `/` 分隔、仓库相对）。
 *
 * 清单**不硬编码在判据里**：登记完整性靠它与锁清单做集合相等——磁盘上多一份要红、
 * 锁清单里多一条也要红。
 *
 * @param root - 仓库根目录。
 * @returns 按路径排序的源码文本列表。
 */
export function collectVendorSources(root: string): VendorSourceText[] {
  return collectSourceFiles(join(root, VENDOR_DIR), root);
}

/**
 * 枚举仓库内**上游离线见证素材**：`<fixtureDir>/<tag>/**\/*.ts`，路径是**官方相对路径**。
 *
 * 目录不存在会直接抛（带一句说明），不静默返回空表——素材整目录丢失必须是响亮的失败。
 *
 * @param root - 仓库根目录。
 * @param fixtureDir - 素材根目录（仓库相对，登记在锁清单的 `upstream.fixtureDir`）。
 * @param tag - 上游 tag（素材按 tag 分目录，与 `upstream.tag` 同一个值）。
 * @returns 按官方相对路径排序的原文列表。
 */
export function collectUpstreamFixtures(
  root: string,
  fixtureDir: string,
  tag: string,
): VendorSourceText[] {
  const versionDir = join(root, fixtureDir, tag);
  try {
    return collectSourceFiles(versionDir, versionDir);
  } catch (error) {
    throw new Error(
      `上游离线见证素材缺失：${fixtureDir}/${tag} 读不出来（${String(error)}）。` +
        "这份素材是「上游那一侧」的唯一凭据来源，删掉或移动它都必须是有意的动作。",
    );
  }
}

function rawSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isRepoRelative(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.split("/").includes("..")
  );
}

/**
 * 跑完全部 M01 判据。
 *
 * 判据分五组：①双向登记完整性；②本地副本内容锁；③来源声明自洽（tag / repo / 包集合 /
 * SHA / 路径形态，并与 `src/vendor/README.md` 交叉）；④登记自洽（`declaredEdits` 与
 * `relation` 是否解释得了两侧摘要的异同）；⑤上游原文校验（仓库内 11 份离线见证的
 * 字节数 / 原始 sha256 / 规范化摘要，外加**覆盖完整**与**归属唯一**两条）。
 *
 * @param input - 锁清单、磁盘副本、README 正文、可选上游文本与身份锚。
 * @returns 问题清单；空数组表示通过。
 */
export function vendorSourceProblems(input: VendorSourceCheckInput): string[] {
  const { lock, vendorFiles, vendorReadme } = input;
  const problems: string[] = [];

  // ---- ① 双向登记完整性 ----
  const locked = Object.keys(lock.files).sort();
  const onDisk = vendorFiles.map((file) => file.path);
  for (const path of onDisk) {
    if (!Object.hasOwn(lock.files, path)) {
      problems.push(`漏登记：${path}（磁盘上有、锁清单里没有）`);
    }
  }
  for (const path of locked) {
    if (!onDisk.includes(path)) {
      problems.push(`多登记：${path}（锁清单里有、磁盘上没有）`);
    }
  }

  // ---- ③ 来源声明自洽 ----
  const upstream = lock.upstream;
  if (upstream.tag.length === 0) problems.push("来源自洽：锁定 tag 为空");
  if (!SHA1_HEX.test(upstream.sha)) {
    problems.push(`来源自洽：锁定 SHA 不是 40 位小写十六进制（${upstream.sha}）`);
  }
  if (upstream.version.length === 0) problems.push("来源自洽：锁定版本号为空");
  if (!/^https:\/\/[^\s]+$/.test(upstream.repo)) {
    problems.push(`来源自洽：上游仓库不是 https 地址（${upstream.repo}）`);
  }
  if (upstream.packages.length === 0) problems.push("来源自洽：登记的上游包集合为空");
  for (const name of upstream.packages) {
    if (!name.startsWith("@deepseek-ai/")) {
      problems.push(`来源自洽：登记的上游包名不是官方作用域（${name}）`);
    }
  }
  if (input.expectUpstream !== undefined) {
    if (upstream.tag !== input.expectUpstream.tag) {
      problems.push(
        `来源自洽：锁定 tag「${upstream.tag}」与固定上游 tag「${input.expectUpstream.tag}」不一致`,
      );
    }
    if (upstream.sha !== input.expectUpstream.sha) {
      problems.push(
        `来源自洽：锁定 SHA「${upstream.sha}」与固定上游 SHA「${input.expectUpstream.sha}」不一致`,
      );
    }
  }
  if (!vendorReadme.includes(upstream.tag)) {
    problems.push(`来源自洽：src/vendor/README.md 的来源表里没有锁定 tag「${upstream.tag}」`);
  }
  if (!vendorReadme.includes(upstream.repo)) {
    problems.push(`来源自洽：src/vendor/README.md 的来源表里没有锁定仓库「${upstream.repo}」`);
  }

  const norm = lock.normalization;
  if (norm.stripRelativeTsExtension !== true && norm.specifierRewrites.length === 0) {
    problems.push("来源自洽：规范化规则为空（允许的漂移必须显式登记）");
  }
  for (const rule of norm.specifierRewrites) {
    if (rule.from.length === 0 || rule.to.length === 0) {
      problems.push("来源自洽：说明符改写规则有空串");
    }
  }

  // 包集合 ↔ 文件头：双向，改多一个包或少一个包都要红
  const packageMentioned = new Map<string, number>();
  for (const name of upstream.packages) packageMentioned.set(name, 0);
  for (const file of vendorFiles) {
    const mentioned = upstream.packages.filter((name) => file.text.includes(name));
    if (mentioned.length === 0) {
      problems.push(`来源自洽：${file.path} 的头没有提到任何登记的上游包`);
    }
    for (const name of mentioned) packageMentioned.set(name, (packageMentioned.get(name) ?? 0) + 1);
    if (!file.text.includes(upstream.tag)) {
      problems.push(`来源自洽：${file.path} 的头没有提到锁定 tag「${upstream.tag}」`);
    }
  }
  for (const [name, count] of packageMentioned) {
    if (count === 0) problems.push(`来源自洽：登记的上游包「${name}」没有任何 vendor 文件提到`);
  }

  // 包集合 ↔ 登记条目的上游路径：双向。文件头会互相提到对方（`ui-primitives` 那几份的头里
  // 也写了 `ui-trajectory`），所以只靠「头提到了某个登记包」抓不住「包集合少一个」——
  // 这里再按**路径**钉一遍：每条登记所属的 `packages/client/<目录>` 都要有登记包认领，
  // 每个登记包也要真的有登记条目指向它的目录。
  const registeredDirs = new Map(upstream.packages.map((name) => [packageDirectory(name), name]));
  const usedDirs = new Set<string>();
  for (const [vendorPath, entry] of Object.entries(lock.files)) {
    const dir = upstreamDirectory(entry.upstream.path);
    if (dir === undefined) continue;
    usedDirs.add(dir);
    if (!registeredDirs.has(dir)) {
      problems.push(`来源自洽：${vendorPath} 的上游路径属于未登记的包目录「${dir}」`);
    }
  }
  for (const [dir, name] of registeredDirs) {
    if (!usedDirs.has(dir)) {
      problems.push(`来源自洽：登记的上游包「${name}」没有任何登记条目指向它的目录「${dir}」`);
    }
  }

  // ---- 上游原文集合（仓库内素材 + 显式补充）----
  const upstreamTexts = new Map<string, string>();
  for (const file of input.upstreamFiles ?? []) {
    upstreamTexts.set(file.path, file.text);
  }
  if (!isRepoRelative(upstream.fixtureDir) || upstream.fixtureDir.length === 0) {
    problems.push(`来源自洽：素材根目录不是仓库相对路径（${upstream.fixtureDir}）`);
  }
  if (upstream.fixtureDir.endsWith("/")) {
    problems.push("来源自洽：素材根目录不该带尾斜杠");
  }

  // ---- ②④⑤ 逐条登记 ----
  for (const path of locked) {
    const entry = lock.files[path];
    if (!isRepoRelative(path) || !path.startsWith(`${VENDOR_DIR}/`) || !path.endsWith(".ts")) {
      problems.push(`登记自洽：${path} 不是 src/vendor 下的仓库相对路径`);
    }
    if (!isRepoRelative(entry.upstream.path)) {
      problems.push(`登记自洽：${path} 的上游路径不是仓库相对路径（${entry.upstream.path}）`);
    }
    if (!Number.isInteger(entry.upstream.bytes) || entry.upstream.bytes <= 0) {
      problems.push(`登记自洽：${path} 的上游字节数不是正整数`);
    }
    if (!SHA256_HEX.test(entry.upstream.sha256)) {
      problems.push(`登记自洽：${path} 的上游原始摘要不是 64 位小写十六进制`);
    }
    if (!SHA256_HEX.test(entry.upstreamNormalizedSha256)) {
      problems.push(`登记自洽：${path} 的上游规范化摘要不是 64 位小写十六进制`);
    }
    if (!SHA256_HEX.test(entry.vendorNormalizedSha256)) {
      problems.push(`登记自洽：${path} 的本地规范化摘要不是 64 位小写十六进制`);
    }
    if (entry.relation !== "verbatim" && entry.relation !== "excerpt") {
      problems.push(`登记自洽：${path} 的 relation 只能是 verbatim / excerpt`);
    }
    if (entry.relation === "excerpt" && (entry.upstreamExtract ?? "").length === 0) {
      problems.push(`登记自洽：${path} 是摘录型，必须登记 upstreamExtract（摘的是哪一段）`);
    }
    const digestsDiffer = entry.vendorNormalizedSha256 !== entry.upstreamNormalizedSha256;
    if (entry.declaredEdits.length === 0) {
      if (entry.relation !== "verbatim") {
        problems.push(`登记自洽：${path} 没有 declaredEdits，只能是 verbatim 副本`);
      }
      if (digestsDiffer) {
        problems.push(
          `登记自洽：${path} 的 declaredEdits 为空，但上游与本地规范化摘要不一致（差异必须显式登记）`,
        );
      }
    } else if (!digestsDiffer) {
      problems.push(`登记自洽：${path} 登记了 declaredEdits，但两侧规范化摘要完全相同（差异登记是死的）`);
    }

    // 内容锁：磁盘上的字节必须就是登记的那一份
    const file = vendorFiles.find((candidate) => candidate.path === path);
    if (file === undefined) continue; // 上面已经报过「多登记」
    const actual = vendorSourceDigest(file.text, norm);
    if (actual !== entry.vendorNormalizedSha256) {
      problems.push(`内容漂移：${path}（规范化摘要与登记不一致）`);
    }

    // 上游原文校验（正式判据会提供全部 11 份素材）
    const upstreamText = upstreamTexts.get(entry.upstream.path);
    if (upstreamText === undefined) {
      if (input.upstreamCoverage === "complete") {
        problems.push(
          `缺上游见证：${path}（登记的上游路径「${entry.upstream.path}」没有对应原文；` +
            `素材应当逐份出现在 ${upstream.fixtureDir}/${upstream.tag}/ 下）`,
        );
      }
      continue;
    }
    if (Buffer.byteLength(upstreamText, "utf8") !== entry.upstream.bytes) {
      problems.push(`上游原文漂移：${path}（字节数与登记不一致）`);
    }
    if (rawSha256(upstreamText) !== entry.upstream.sha256) {
      problems.push(`上游原文漂移：${path}（原始摘要与登记不一致）`);
    }
    const upstreamDigest = vendorSourceDigest(upstreamText, norm);
    if (upstreamDigest !== entry.upstreamNormalizedSha256) {
      problems.push(`上游内容漂移：${path}（规范化摘要与登记不一致）`);
    }
  }

  // 提供的上游原文必须真的有人引用：素材目录里多出一份、或路径写错，都要红
  for (const path of upstreamTexts.keys()) {
    if (!locked.some((vendorPath) => lock.files[vendorPath].upstream.path === path)) {
      problems.push(`无法归属的上游原文：${path}（没有任何登记条目的 upstream.path 指向它）`);
    }
  }

  return problems;
}
