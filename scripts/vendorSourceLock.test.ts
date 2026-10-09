/**
 * M01：`src/vendor/**` 官方纯逻辑副本的**源锁**断言（零 token、不联网、不读用户目录）。
 *
 * 判据本体在 `scripts/vendorSourceLock.ts`，登记在 `scripts/vendorSourceLock.json`，
 * 上游那一侧的凭据是仓库内 11/11 份离线见证素材
 * （`test/fixtures/vendor-sources/dsh-v0.2.0-rc.2/**`，逐字节等于固定 tag 上的原文）。
 *
 * 这一份做三件事：①基线（真实磁盘副本 + 真实锁清单 + **全部 11 份素材**）必须无漂移；
 * ②**可证伪** —— 逐类构造突变，判据必须红（含「素材缺一份 / 多一份 / 改一个字节」与
 * 「规范化规则被改」）；③**允许的漂移**必须绿（登记的说明符改写、已登记的类型壳 /
 * 省略 math 臂 / 本地图片判据差异、以及有意的排版与注释漂移）。
 *
 * 突变全部在**内存**里做（`structuredClone` 一份夹具），不碰 `src/vendor/**` 的真实文件，
 * 也不碰素材目录里的那 11 份原文。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import lockJson from "./vendorSourceLock.json";
import {
  collectUpstreamFixtures,
  collectVendorSources,
  normalizeVendorSource,
  vendorSourceDigest,
  vendorSourceProblems,
  type VendorSourceLock,
  type VendorSourceText,
} from "./vendorSourceLock";

/** 任务固定的上游身份：锁清单必须与它一致，**不许**用 HEAD 或别的 tag 替代。 */
const FIXED_UPSTREAM = {
  tag: "dsh-v0.2.0-rc.2",
  sha: "639ed015397290b3745d163aafe02ffee4aa3f84",
} as const;

/** 夹具是 `structuredClone` 出来的**可变**副本（判据只读它，突变只发生在这里）。 */
type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

const ROOT = process.cwd();
// JSON 里的字面量类型会被推导成 `string`（`relation` 之类）；形状由判据自己逐项校验
// （tag / SHA / 摘要 / relation / declaredEdits 都在 `vendorSourceProblems` 里），所以这里
// 的转换是安全的 —— 下面「来源声明被篡改」「登记自洽被破坏」两组断言就是在证明它真的会拦。
const LOCK = lockJson as unknown as VendorSourceLock;
const VENDOR_FILES = collectVendorSources(ROOT);
const VENDOR_README = readFileSync(join(ROOT, "src", "vendor", "README.md"), "utf8");
/** 上游那一侧的 11/11 离线见证（官方相对路径 → 原文）。 */
const FIXTURES = collectUpstreamFixtures(ROOT, LOCK.upstream.fixtureDir, LOCK.upstream.tag);

const TIMELINE = "src/vendor/ui-trajectory/timeline.ts";
const RECORD = "src/vendor/ui-trajectory/trajectory-record.ts";
const PREVIEW = "src/vendor/ui-trajectory/trajectory-preview.ts";
const PARSE = "src/vendor/ui-primitives/markdown/parse.ts";
const LOCAL_IMAGE = "src/vendor/ui-primitives/markdown/local-image-syntax.ts";
const INBOX = "src/vendor/ui-trajectory/inbox-state.ts";
const TURN_MODEL = "src/vendor/ui-trajectory/trajectory-turn-model.ts";

const TIMELINE_UPSTREAM = "packages/client/ui-trajectory/src/client/timeline.ts";
const PREVIEW_UPSTREAM = "packages/client/ui-trajectory/src/client/trajectory-preview.ts";

interface Draft {
  lock: Mutable<VendorSourceLock>;
  vendorFiles: Mutable<VendorSourceText>[];
  upstreamFiles: Mutable<VendorSourceText>[];
  upstreamCoverage: "partial" | "complete";
}

/** 取一个「必须有」的值（`undefined` 时直接失败，顺带把类型收窄）。 */
function required<T>(value: T | undefined, why: string): T {
  if (value === undefined) throw new Error(why);
  return value;
}

function run(mutate: (draft: Draft) => void): string[] {
  const draft: Draft = {
    lock: structuredClone(LOCK) as Mutable<VendorSourceLock>,
    vendorFiles: structuredClone(VENDOR_FILES) as Mutable<VendorSourceText>[],
    upstreamFiles: structuredClone(FIXTURES) as Mutable<VendorSourceText>[],
    upstreamCoverage: "complete",
  };
  mutate(draft);
  return vendorSourceProblems({
    lock: draft.lock,
    vendorFiles: draft.vendorFiles,
    vendorReadme: VENDOR_README,
    upstreamFiles: draft.upstreamFiles,
    upstreamCoverage: draft.upstreamCoverage,
    expectUpstream: FIXED_UPSTREAM,
  });
}

function expectRed(needle: string, why: string, mutate: (draft: Draft) => void): void {
  const problems = run(mutate);
  assert.ok(
    problems.some((problem) => problem.includes(needle)),
    `应当报「${needle}」（${why}），实际：\n${problems.length === 0 ? "（没有报任何问题——判据漏了）" : problems.join("\n")}`,
  );
}

function expectGreen(why: string, mutate: (draft: Draft) => void): void {
  const problems = run(mutate);
  assert.deepStrictEqual(problems, [], `${why}（不该红，实际：\n${problems.join("\n")}）`);
}

function vendorText(draft: Draft, path: string): string {
  const file = draft.vendorFiles.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`夹具里找不到 ${path}`);
  return file.text;
}

function mutateVendorText(draft: Draft, path: string, from: string, to: string): void {
  const before = vendorText(draft, path);
  assert.ok(before.includes(from), `变异锚点找不到：${path} 里没有 ${JSON.stringify(from)}`);
  const after = before.replace(from, to);
  assert.notStrictEqual(after, before, "变异必须真的改了字节");
  const index = draft.vendorFiles.findIndex((candidate) => candidate.path === path);
  draft.vendorFiles[index] = { path, text: after };
}

function fixtureIndex(draft: Draft, upstreamPath: string): number {
  const index = draft.upstreamFiles.findIndex((candidate) => candidate.path === upstreamPath);
  if (index < 0) throw new Error(`素材里找不到 ${upstreamPath}`);
  return index;
}

function mutateFixture(draft: Draft, upstreamPath: string, from: string, to: string): void {
  const index = fixtureIndex(draft, upstreamPath);
  const before = draft.upstreamFiles[index].text;
  assert.ok(before.includes(from), `素材变异锚点找不到：${upstreamPath} 里没有 ${JSON.stringify(from)}`);
  const after = before.replace(from, to);
  assert.notStrictEqual(after, before, "素材变异必须真的改了字节");
  draft.upstreamFiles[index] = { path: upstreamPath, text: after };
}

// ---------- 1. 基线：真实磁盘副本 + 真实锁清单 + 全部 11 份素材 ----------
{
  const problems = vendorSourceProblems({
    lock: LOCK,
    vendorFiles: VENDOR_FILES,
    vendorReadme: VENDOR_README,
    upstreamFiles: FIXTURES,
    upstreamCoverage: "complete",
    expectUpstream: FIXED_UPSTREAM,
  });
  assert.deepStrictEqual(problems, [], `基线不该有漂移：\n${problems.join("\n")}`);
  console.log(
    `vendor-source-lock: ${VENDOR_FILES.length} 份副本 / ${Object.keys(LOCK.files).length} 条登记 / ` +
      `${FIXTURES.length} 份上游见证，基线无漂移 ✓`,
  );
}

// ---------- 2. 登记与来源：形式、固定身份、11/11 覆盖、已登记差异 ----------
{
  assert.strictEqual(
    Object.keys(LOCK.files).length,
    VENDOR_FILES.length,
    "登记条数要与磁盘上的 *.ts 一致（多一份少一份都由双向登记判据报红）",
  );
  assert.strictEqual(LOCK.upstream.tag, FIXED_UPSTREAM.tag);
  assert.strictEqual(LOCK.upstream.sha, FIXED_UPSTREAM.sha);

  // 上游那一侧：**11/11 逐字素材**，路径是官方相对路径，一条不多一条不少
  const upstreamPaths = [
    ...new Set(Object.values(LOCK.files).map((entry) => entry.upstream.path)),
  ].sort();
  assert.deepStrictEqual(
    FIXTURES.map((file) => file.path),
    upstreamPaths,
    "素材目录里的原文要与登记的上游路径逐条对上（缺一 / 多一都红）",
  );
  assert.strictEqual(FIXTURES.length, Object.keys(LOCK.files).length, "每条登记各有一份原文");
  for (const file of FIXTURES) {
    assert.ok(
      !file.path.startsWith("src/") && /^packages\/client\/[^/]+\/src\//.test(file.path),
      `素材路径要保持官方相对路径：${file.path}`,
    );
    assert.ok(!file.path.includes("\\") && !file.path.startsWith("/"), "素材路径不许带本机痕迹");
  }
  // 素材字节与登记值逐份相符（原始字节数）；这一条是「11/11」的落点
  for (const [vendorPath, entry] of Object.entries(LOCK.files)) {
    const file = required(
      FIXTURES.find((candidate) => candidate.path === entry.upstream.path),
      `${vendorPath} 的上游原文缺失`,
    );
    assert.strictEqual(
      Buffer.byteLength(file.text, "utf8"),
      entry.upstream.bytes,
      `${vendorPath} 的上游字节数与登记不一致`,
    );
  }

  // 已登记的本地差异：摘要必须**真的**不同，否则是死登记
  for (const path of [RECORD, PARSE, LOCAL_IMAGE, INBOX, TURN_MODEL]) {
    const entry = required(LOCK.files[path], `${path} 要登记`);
    assert.ok(entry.declaredEdits.length > 0, `${path} 的本地差异要逐条登记`);
    assert.notStrictEqual(
      entry.vendorNormalizedSha256,
      entry.upstreamNormalizedSha256,
      `${path} 登记了差异，两侧摘要就该不同`,
    );
  }
  for (const path of [INBOX, TURN_MODEL]) {
    const entry = required(LOCK.files[path], `${path} 要登记`);
    assert.strictEqual(entry.relation, "excerpt", `${path} 是从官方更大的文件里摘的`);
    assert.ok((entry.upstreamExtract ?? "").length > 0, `${path} 要写明摘的是哪一段`);
  }
  for (const path of [TIMELINE, PREVIEW]) {
    const entry = required(LOCK.files[path], `${path} 要登记`);
    assert.strictEqual(entry.declaredEdits.length, 0, `${path} 与上游逐字等价`);
    assert.strictEqual(entry.vendorNormalizedSha256, entry.upstreamNormalizedSha256);
  }
}

// ---------- 3. 红：本地逻辑突变（判据不许被排版规范化吞掉） ----------
{
  expectRed("内容漂移：" + TIMELINE, "排序比较子反向", (draft) => {
    mutateVendorText(
      draft,
      TIMELINE,
      "left.start - right.start || left.end - right.end",
      "right.start - left.start || right.end - left.end",
    );
  });
  expectRed("内容漂移：" + INBOX, "`removedCount > 0` 改成 `>= 0`（负值路径没有对拍样本）", (draft) => {
    mutateVendorText(
      draft,
      INBOX,
      "if (removedCount > 0 && splice.outcome !== 'canceled') {",
      "if (removedCount >= 0 && splice.outcome !== 'canceled') {",
    );
  });
  expectRed("内容漂移：" + TIMELINE, "在 vendor 文件里加一段本地分支", (draft) => {
    mutateVendorText(
      draft,
      TIMELINE,
      "export function deriveTrajectoryTimeline(",
      "const LOCAL_ONLY_FLAG = true\n\nexport function deriveTrajectoryTimeline(",
    );
  });
}

// ---------- 4. 红：接口多一列宿主字段（S01 的原始污染形态） ----------
{
  expectRed("内容漂移：" + RECORD, "往官方接口里插一列宿主字段", (draft) => {
    mutateVendorText(
      draft,
      RECORD,
      "export interface TrajectoryCellProps {",
      "export interface TrajectoryCellProps {\n  previousPromptTools?: unknown",
    );
  });
  expectRed("内容漂移：" + RECORD, "删掉官方接口里的一列", (draft) => {
    mutateVendorText(draft, RECORD, "  requestOnly?: boolean\n", "");
  });
}

// ---------- 5. 红：登记缺 / 多（双向）与本地摘要被篡改 ----------
{
  expectRed("漏登记：" + TIMELINE, "磁盘有、清单无", (draft) => {
    draft.lock.files = Object.fromEntries(
      Object.entries(draft.lock.files).filter(([path]) => path !== TIMELINE),
    );
  });
  expectRed("多登记：src/vendor/ui-trajectory/ghost.ts", "清单有、磁盘无", (draft) => {
    draft.lock.files["src/vendor/ui-trajectory/ghost.ts"] = structuredClone(
      draft.lock.files[TIMELINE],
    );
  });
  expectRed("内容漂移：" + TIMELINE, "本地摘要登记被篡改", (draft) => {
    draft.lock.files[TIMELINE].vendorNormalizedSha256 = "0".repeat(64);
  });
}

// ---------- 6. 红：来源声明被篡改（tag / SHA / 包集合 / 仓库 / 路径 / 素材目录） ----------
{
  expectRed("来源自洽", "锁定 tag 与固定上游 tag 不一致", (draft) => {
    draft.lock.upstream.tag = "dsh-v0.2.0-rc.3";
  });
  expectRed("来源自洽", "锁定 SHA 与固定上游 SHA 不一致", (draft) => {
    draft.lock.upstream.sha = "0".repeat(40);
  });
  expectRed("来源自洽", "SHA 形状不对", (draft) => {
    draft.lock.upstream.sha = "639ED015";
  });
  expectRed("来源自洽", "包集合少一个（那份文件的头就没人认领了）", (draft) => {
    draft.lock.upstream.packages = draft.lock.upstream.packages.filter(
      (name) => name !== "@deepseek-ai/dsh-client-ui-primitives",
    );
  });
  expectRed("来源自洽", "包集合多一个（没有任何文件提到它）", (draft) => {
    draft.lock.upstream.packages = [
      ...draft.lock.upstream.packages,
      "@deepseek-ai/dsh-client-ui-ghost",
    ];
  });
  expectRed("来源自洽", "上游仓库被改成带本机痕迹的路径", (draft) => {
    draft.lock.upstream.repo = "D:\\somewhere\\deepseek-harness";
  });
  expectRed("来源自洽", "素材根目录被改成绝对路径", (draft) => {
    draft.lock.upstream.fixtureDir = "D:/repo/test/fixtures/vendor-sources";
  });
  expectRed("登记自洽", "登记条目的上游路径写成绝对路径（不许带本机痕迹）", (draft) => {
    draft.lock.files[TIMELINE].upstream.path =
      "D:/repo/packages/client/ui-trajectory/src/client/timeline.ts";
  });
  expectRed("来源自洽", "vendor 文件头与锁定 tag 对不上", (draft) => {
    mutateVendorText(draft, TIMELINE, "dsh-v0.2.0-rc.2", "dsh-v0.2.0-rc.9");
  });
}

// ---------- 7. 红：登记自洽被破坏（摘要关系与 declaredEdits 对不上） ----------
{
  expectRed("登记自洽", "上游摘要被篡改（verbatim 且无 declaredEdits 就不允许两侧不同）", (draft) => {
    draft.lock.files[TIMELINE].upstreamNormalizedSha256 = "f".repeat(64);
  });
  expectRed("登记自洽", "有差异却不登记 declaredEdits", (draft) => {
    draft.lock.files[RECORD].declaredEdits = [];
  });
  expectRed("登记自洽", "登记了差异但两侧摘要相同（死登记）", (draft) => {
    draft.lock.files[TIMELINE].declaredEdits = ["编一条不存在的差异"];
  });
  expectRed("登记自洽", "摘录型却没有写摘的是哪一段", (draft) => {
    draft.lock.files[INBOX].upstreamExtract = "";
  });
  expectRed("登记自洽", "relation 取值非法", (draft) => {
    draft.lock.files[TIMELINE].relation = "similar" as "verbatim";
  });
  expectRed("登记自洽", "上游字节数被改成 0", (draft) => {
    draft.lock.files[TIMELINE].upstream.bytes = 0;
  });
}

// ---------- 8. 红：上游素材（少一份 / 多一份 / 改一字节 / 改注释） ----------
{
  expectRed("缺上游见证：" + TIMELINE, "素材少一份（覆盖不完整）", (draft) => {
    draft.upstreamFiles = draft.upstreamFiles.filter((file) => file.path !== TIMELINE_UPSTREAM);
  });
  expectRed(
    "无法归属的上游原文：packages/client/ui-trajectory/src/client/ghost.ts",
    "素材多一份（没人引用）",
    (draft) => {
      draft.upstreamFiles.push({
        path: "packages/client/ui-trajectory/src/client/ghost.ts",
        text: "export const ghost = 1\n",
      });
    },
  );
  expectRed("上游内容漂移：" + TIMELINE, "素材里的标识符被改一个字符（同长度）", (draft) => {
    mutateFixture(
      draft,
      TIMELINE_UPSTREAM,
      "left.start - right.start || left.end - right.end",
      "left.start - right.start || left.end - right.enD",
    );
  });
  expectRed("上游原文漂移：" + TIMELINE, "素材里多一行注释（注释不进规范化摘要，但原始字节必须逐字）", (draft) => {
    const index = fixtureIndex(draft, TIMELINE_UPSTREAM);
    draft.upstreamFiles[index] = {
      path: TIMELINE_UPSTREAM,
      text: `${draft.upstreamFiles[index].text}\n/** 素材外被追加的一行注释 */\n`,
    };
  });
  expectRed("上游原文漂移：" + PREVIEW, "素材少一行（字节数对不上）", (draft) => {
    const index = fixtureIndex(draft, PREVIEW_UPSTREAM);
    const lines = draft.upstreamFiles[index].text.split("\n");
    lines.splice(0, 1);
    draft.upstreamFiles[index] = { path: PREVIEW_UPSTREAM, text: lines.join("\n") };
  });
  expectRed("上游原文漂移：" + TIMELINE, "把素材整个换成另一份（路径没变、内容变了）", (draft) => {
    const index = fixtureIndex(draft, TIMELINE_UPSTREAM);
    draft.upstreamFiles[index] = { path: TIMELINE_UPSTREAM, text: "export const timeline = 1\n" };
  });

  // partial 模式只核对给了的那几份：这是给「同步期增量对拍」留的口子，
  // 正式判据必须用 complete —— 下面这条断言就是在钉这个区别
  expectGreen("partial 模式允许只给一部分（正式判据不用它）", (draft) => {
    draft.upstreamCoverage = "partial";
    draft.upstreamFiles = draft.upstreamFiles.filter((file) => file.path === TIMELINE_UPSTREAM);
  });
}

// ---------- 9. 红：规范化规则被改（normalized 逻辑必须真的参与判据） ----------
{
  expectRed("上游内容漂移：" + TIMELINE, "关掉相对说明符去后缀（上游摘要不再匹配）", (draft) => {
    draft.lock.normalization.stripRelativeTsExtension = false;
  });
  expectRed("上游内容漂移：" + TIMELINE, "说明符改写目标被改掉", (draft) => {
    const rule = draft.lock.normalization.specifierRewrites.find(
      (item) => item.from === "./locales.ts",
    );
    required(rule, "登记里应当有 ./locales.ts 的改写规则").to = "./locales";
  });
  expectRed("内容漂移：" + TIMELINE, "给本地已有的说明符加一条改写（本地摘要随之改变）", (draft) => {
    draft.lock.normalization.specifierRewrites.push({
      from: "./trajectory-record",
      to: "./trajectory-record-renamed",
    });
  });
}

// ---------- 10. 绿：登记的模块说明符调整（允许的漂移） ----------
{
  expectGreen("跨包说明符改回官方包名（登记过的改写）", (draft) => {
    mutateVendorText(
      draft,
      PREVIEW,
      "'../ui-primitives/markdown/plain-text'",
      "'@deepseek-ai/dsh-client-ui-primitives'",
    );
  });
  expectGreen("本地类型壳说明符改回官方 ./layout.ts（登记过的改写）", (draft) => {
    mutateVendorText(draft, TIMELINE, "'./trajectory-turn-model'", "'./layout.ts'");
  });
  expectGreen("相对说明符补回 .ts 后缀（登记过的去后缀规则）", (draft) => {
    mutateVendorText(draft, TIMELINE, "'./trajectory-record'", "'./trajectory-record.ts'");
  });
}

// ---------- 11. 规范化：只改模块说明符，字面量 / 模板串 / 正则 / ASI 一律不许被吞 ----------
{
  const NORM = LOCK.normalization;
  const normalized = (source: string): string => normalizeVendorSource(source, NORM);
  const digest = (source: string): string => vendorSourceDigest(source, NORM);

  // 只有 import / export 的模块说明符会被改写；同名文本出现在字符串里不算
  const literalFixture = `import { a } from './layout.ts'\nconst s = './layout.ts'\n`;
  const printedLiteral = normalized(literalFixture);
  assert.ok(
    /from "\.\/trajectory-turn-model"/.test(printedLiteral),
    `import 说明符要按登记改写，实际：${printedLiteral}`,
  );
  assert.ok(
    /const s = '\.\/layout\.ts'/.test(printedLiteral),
    `字符串字面量里的 ./layout.ts 不许被改写，实际：${printedLiteral}`,
  );
  assert.ok(
    digest(literalFixture) !== digest(`import { a } from './layout.ts'\nconst s = './layout.ts '\n`),
    "字符串字面量末尾多一个空格是语义变化，摘要必须不同",
  );

  // 两个连续空格：在字符串字面量里是**语义**，折叠空白会把它吞掉
  assert.ok(
    digest("const s = 'a  b'\n") !== digest("const s = 'a b'\n"),
    "字符串里的两个空格不能被规范化吞掉",
  );
  assert.ok(normalized("const s = 'a  b'\n").includes("'a  b'"), "字符串原样保留");

  // 模板串：正文与 `${}` 里的两个空格同样不许被吞
  assert.ok(
    digest("const t = `a  b ${x}  c`\n") !== digest("const t = `a b ${x} c`\n"),
    "模板串里的空格不能被规范化吞掉",
  );
  assert.ok(normalized("const t = `a  b ${x}  c`\n").includes("`a  b ${x}  c`"), "模板串原样保留");

  // 正则字面量
  assert.ok(
    digest("const r = /a  b/g\n") !== digest("const r = /a b/g\n"),
    "正则里的空格不能被规范化吞掉",
  );
  assert.ok(normalized("const r = /a  b\\/c/g\n").includes("/a  b\\/c/g"), "正则原样保留");

  // 模板串里的 `./layout.ts` 不是模块说明符
  assert.ok(
    normalized("const t = `./layout.ts`\n").includes("`./layout.ts`"),
    "模板串里的 ./layout.ts 不许被改写",
  );

  // `return` 换行（ASI）：打印器不许把它接成 `return 1`
  const asi = normalized("function f() {\n  return\n  1\n}\n");
  assert.ok(asi.includes("return;"), `return 后换行必须保留分号（实际：${asi}）`);
  assert.ok(
    digest("function f() {\n  return\n  1\n}\n") !== digest("function f() {\n  return 1\n}\n"),
    "`return` 换行与同行的语义不同，摘要必须不同",
  );

  // 幂等：规范化两次与一次相同（同一份源码反复过判据不会漂）
  for (const source of [literalFixture, "const t = `a  b ${x}`\n", "const r = /a  b/g\n", asi]) {
    assert.strictEqual(normalized(normalized(source)), normalized(source), "规范化要幂等");
  }

  // 有意允许的漂移（诚实边界，写成可执行的）：排版与注释不算漂移
  assert.strictEqual(
    digest("import {a}  from   './a.ts'\n\n\nconst   x=1\n"),
    digest("import { a } from './a';\nconst x = 1;\n"),
    "排版漂移是允许的（判据看 AST，不看空白）",
  );
  assert.strictEqual(
    digest("// 本仓库的改动说明\nconst x = 1\n"),
    digest("const x = 1\n"),
    "注释漂移是允许的（上游 JSDoc 与本地头注释本来就不同）",
  );
}

// ---------- 12. 判据自身不许静默失效（对口径的自证） ----------
{
  const NORM = LOCK.normalization;
  const clean = "export const answer = 42\n";
  const mutated = "export const answer = 43\n";
  assert.notStrictEqual(
    vendorSourceDigest(clean, NORM),
    vendorSourceDigest(mutated, NORM),
    "摘要判据必须能区分差一个字符的两份源码",
  );
  assert.strictEqual(
    vendorSourceDigest(clean, NORM),
    vendorSourceDigest(clean, NORM),
    "同一份源码的摘要必须稳定",
  );
  assert.notStrictEqual(
    normalizeVendorSource(clean, NORM),
    normalizeVendorSource(mutated, NORM),
    "规范化不得把两份不同源码映射成同一份（否则内容锁会在语义已变时报绿）",
  );
}

console.log("\nvendor-source-lock: 内容锁 / 双向登记 / 11/11 上游见证 / 来源自洽（含突变自证） ✓");
