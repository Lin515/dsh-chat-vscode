/**
 * 代码高亮纯模块的离线断言（无 DOM、无 React）。
 *
 * 固定的事实：
 * - 语言别名只认显式表，继承成员（constructor / __proto__）不命中；
 * - token 偏移必须单调、安全整数、与源码切片相符；显示的文本始终由原 code 切片，
 *   CRLF / 空行 / 尾空白 / NUL 逐字不变；
 * - 颜色只可能是本地主题生成的 `var(--md-code-*)`，不接收任意 CSS；
 * - 成功与失败都进缓存，条数与总字符双限会清理；超长 / 未知语言直接回退。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  highlightCode,
  highlightLines,
  highlightCacheStats,
  languageForPath,
  MAX_CACHE_CHARS,
  MAX_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CHARS,
  MAX_HIGHLIGHT_LINE_CHARS,
  normalizeLang,
  resetHighlightCache,
  resolveLanguage,
  splitSpansByLine,
  type HighlightSpan,
} from "../src/webview/markdown/highlight";

function textOf(code: string, spans: readonly HighlightSpan[]): string {
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    assert.ok(Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end), "偏移是安全整数");
    assert.ok(span.start >= cursor && span.end > span.start, "偏移单调且非空");
    assert.ok(span.end <= code.length, "偏移不越界");
    out += code.slice(cursor, span.start) + code.slice(span.start, span.end);
    cursor = span.end;
  }
  return out + code.slice(cursor);
}

/** 断言 literal 落在单个 token 内，返回该 token 的颜色。 */
function colorOf(code: string, spans: readonly HighlightSpan[], literal: string): string | undefined {
  const at = code.indexOf(literal);
  assert.ok(at >= 0, `语料必须包含 ${literal}`);
  const span = spans.find((candidate) => candidate.start <= at && candidate.end >= at + literal.length);
  assert.ok(span !== undefined, `${literal} 必须落在单个 token 内`);
  return span.color;
}

// ---------- 1. 别名与不支持的输入 ----------
{
  assert.strictEqual(normalizeLang("js"), "javascript");
  assert.strictEqual(normalizeLang("TS"), "typescript");
  assert.strictEqual(normalizeLang("ts title=demo"), "typescript");
  assert.strictEqual(normalizeLang("sh"), "shellscript");
  assert.strictEqual(normalizeLang("ps1"), "powershell");
  assert.strictEqual(normalizeLang("c++"), "cpp");
  assert.strictEqual(normalizeLang("cs"), "csharp");
  assert.strictEqual(normalizeLang("yml"), "yaml");
  assert.strictEqual(normalizeLang("md"), "markdown");
  assert.strictEqual(normalizeLang("constructor"), undefined, "constructor 不能命中对象继承成员");
  assert.strictEqual(normalizeLang("__proto__"), undefined);
  assert.strictEqual(normalizeLang("toString"), undefined);
  assert.strictEqual(normalizeLang("text"), undefined);
  assert.strictEqual(normalizeLang(undefined), undefined);
  assert.strictEqual(normalizeLang("   "), undefined);
}
console.log("highlight: 语言别名与继承成员不命中 ✓");

// ---------- 1b. 文件路径 → 语言：只看显式扩展名 ----------
{
  assert.strictEqual(languageForPath("src/a.ts"), "typescript", "普通 POSIX 路径");
  assert.strictEqual(languageForPath("C:\\x\\A.TSX"), "tsx", "Windows 路径与大小写");
  assert.strictEqual(languageForPath("README.md"), "markdown");
  assert.strictEqual(languageForPath("a.jsonc"), "jsonc");
  assert.strictEqual(languageForPath("a.patch"), "diff");
  assert.strictEqual(languageForPath("noext"), undefined, "无扩展名回退");
  assert.strictEqual(languageForPath(".bashrc"), undefined, "点号在开头不算扩展名");
  assert.strictEqual(languageForPath("a."), undefined, "空扩展名回退");
  assert.strictEqual(languageForPath("a.constructor"), undefined, "继承成员不命中");
  assert.strictEqual(languageForPath("dir\\constructor"), undefined);
  assert.strictEqual(languageForPath(undefined), undefined);
}
console.log("highlight: 文件路径扩展名映射只认显式语言 ✓");

// ---------- 1c. read 卡语言：可识别 lang 优先，缺失按路径回退，显式纯文不反悔 ----------
{
  assert.strictEqual(normalizeLang("typescriptreact"), "tsx", "VS Code language id 归一化");
  assert.strictEqual(normalizeLang("javascriptreact"), "jsx");
  assert.strictEqual(resolveLanguage("typescriptreact", "Editor.tsx"), "tsx");
  assert.strictEqual(resolveLanguage("javascriptreact", "Editor.jsx"), "jsx");
  assert.strictEqual(resolveLanguage(undefined, "src/Rows.tsx"), "tsx", "缺 lang 时按 .tsx 回退");
  assert.strictEqual(resolveLanguage(undefined, "schema.json"), "json", "缺 lang 的 read JSON 也着色");
  assert.strictEqual(resolveLanguage("json", "notes.txt"), "json", "服务端 lang 优先于扩展名");
  assert.strictEqual(resolveLanguage("text", "src/Rows.tsx"), undefined, "显式 text 保持纯文");
  assert.strictEqual(resolveLanguage("plaintext", "schema.json"), undefined, "显式 plaintext 保持纯文");
  assert.strictEqual(resolveLanguage(undefined, "src/a.unknown"), undefined, "未知扩展名仍纯文");
  assert.strictEqual(resolveLanguage("cobol", "src/a.cob"), undefined, "未识别 lang + 未知扩展名仍纯文");
  assert.strictEqual(resolveLanguage("constructor", "src/a.ts"), "typescript", "继承成员不命中语言表，回退路径");
}
console.log("highlight: read 语言提示优先、缺失按扩展名回退、显式纯文保持纯文 ✓");

// ---------- 2. 源码逐字保真（CRLF / 空行 / 尾空白 / NUL） ----------
{
  resetHighlightCache();
  const code = "const a = 1; // 注释\r\n\tconst b = \"x\";\r\n\r\nconst c = 'y'  \r\n";
  const spans = await highlightCode(code, "ts");
  assert.ok(spans !== null, "TypeScript 必须有高亮结果");
  assert.strictEqual(textOf(code, spans), code, "span 切片的合并文本必须等于原 code");
  assert.ok(spans.some((span) => span.color !== undefined), "至少有一个 token 带受控颜色");
  for (const span of spans) {
    if (span.color !== undefined) assert.match(span.color, /^var\(--md-code-[a-z-]+\)$/u);
  }

  const nul = "A\u0000\uFFFD\r\n\tB  \r\n\r\n";
  const nulSpans = await highlightCode(nul, "javascript");
  assert.ok(nulSpans !== null, "NUL 代码也必须能高亮");
  assert.strictEqual(textOf(nul, nulSpans), nul, "NUL / U+FFFD / CRLF / 尾空白逐字保留");
  assert.ok(textOf(nul, nulSpans).includes("\u0000"), "显示文本保留真实 NUL，不是替换字符");

  const markdownCode = "# 标题\n\n```js\nconst a = 1\n```\n";
  const mdSpans = await highlightCode(markdownCode, "markdown");
  assert.ok(mdSpans !== null);
  assert.strictEqual(textOf(markdownCode, mdSpans), markdownCode);
}
console.log("highlight: CRLF / 空行 / 尾空白 / NUL 由原 code 切片逐字保真 ✓");

// ---------- 2b. 整段 token → 逐行局部 span（一次 tokenize，不逐行重置） ----------
{
  // 纯区间切分：跨行 span 按行裁剪，换行字符不进入任何一行。
  const code = "ab\ncd\n";
  const spans: HighlightSpan[] = [
    { start: 0, end: 2, color: "var(--md-code-token-keyword)" },
    { start: 2, end: 3 },
    { start: 3, end: 5, color: "var(--md-code-token-string)" },
    { start: 5, end: 6 },
  ];
  const lines = splitSpansByLine(code, spans);
  assert.strictEqual(lines.length, 3, "行数等于 split(\\n) 的长度（含末尾空行）");
  assert.deepStrictEqual(lines[0], [{ start: 0, end: 2, color: "var(--md-code-token-keyword)" }]);
  assert.deepStrictEqual(lines[1], [{ start: 0, end: 2, color: "var(--md-code-token-string)" }]);
  assert.deepStrictEqual(lines[2], []);
  assert.strictEqual(textOf(code.split("\n")[0], lines[0]), "ab");
  assert.strictEqual(textOf(code.split("\n")[1], lines[1]), "cd");

  const cross = splitSpansByLine(code, [{ start: 1, end: 4, color: "var(--md-code-token-comment)" }]);
  assert.deepStrictEqual(cross[0], [{ start: 1, end: 2, color: "var(--md-code-token-comment)" }]);
  assert.deepStrictEqual(cross[1], [{ start: 0, end: 1, color: "var(--md-code-token-comment)" }]);

  // 真实引擎：CRLF / tab / 尾空白 / 多行注释 / NUL。整段先 tokenize 再切行，
  // 每一行按局部 span 重建出的文本必须逐字等于原行。
  const source = "const a = 1;\r\n\tconst b = 2;  \n/* multi\nline */\nconst c = \"x\";\n";
  const full = await highlightCode(source, "typescript");
  assert.ok(full !== null);
  const perLine = splitSpansByLine(source, full);
  const expected = source.split("\n");
  assert.strictEqual(perLine.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    assert.strictEqual(textOf(expected[index], perLine[index]), expected[index], `第 ${index} 行保真`);
  }
  const comment = "var(--md-code-token-comment)";
  assert.ok(perLine[2].some((span) => span.color === comment), "多行注释首行有注释色");
  assert.ok(perLine[3].some((span) => span.color === comment), "多行注释续行仍有注释色（未逐行重置）");

  const nul = "A\u0000\uFFFD\r\n\tB  \r\n\r\n";
  const nulSpans = await highlightCode(nul, "javascript");
  assert.ok(nulSpans !== null);
  const nulLines = splitSpansByLine(nul, nulSpans);
  const nulExpected = nul.split("\n");
  assert.strictEqual(nulLines.length, nulExpected.length);
  for (let index = 0; index < nulExpected.length; index++) {
    assert.strictEqual(textOf(nulExpected[index], nulLines[index]), nulExpected[index], `NUL 第 ${index} 行保真`);
  }
  assert.ok(textOf(nulExpected[0], nulLines[0]).includes("\u0000"), "切行后仍保留真实 NUL");

  resetHighlightCache();
  const highlighted = await highlightLines("const a = 1;\nconst b = 2;", "ts");
  assert.ok(highlighted !== null);
  assert.strictEqual(highlighted.length, 2);
  assert.strictEqual(textOf("const a = 1;", highlighted[0]), "const a = 1;");
  assert.strictEqual(await highlightLines("x", "brainfuck"), null, "未知语言仍回退纯文");
}
console.log("highlight: 整段 token 按行裁剪、CRLF / tab / NUL / 多行注释保真 ✓");

// ---------- 2c. 真实 token 色：关键词 / JSON 词元不等于 foreground，且语义分色 ----------
{
  const foreground = "var(--md-code-foreground)";
  const keyword = "var(--md-code-token-keyword)";
  const stringExpression = "var(--md-code-token-string-expression)";
  const constant = "var(--md-code-token-constant)";

  const source = 'import { value } from "mod";\nexport type T = { count: number; flag: boolean };\n// note\n';
  const spans = await highlightCode(source, "typescriptreact");
  assert.ok(spans !== null, "VS Code typescriptreact 标识必须能高亮");
  for (const word of ["import", "from", "export", "type"]) {
    assert.strictEqual(colorOf(source, spans, word), keyword, `${word} 必须是 keyword 色`);
  }
  const modColor = colorOf(source, spans, '"mod"');
  assert.strictEqual(modColor, stringExpression, "模块字符串必须是 string-expression 色");
  assert.notStrictEqual(modColor, keyword, "字符串与关键词必须分色");
  const commentColor = colorOf(source, spans, "// note");
  assert.notStrictEqual(commentColor, foreground, "注释不能落回 foreground");
  assert.notStrictEqual(commentColor, keyword, "注释与关键词必须分色");
  assert.notStrictEqual(modColor, commentColor, "字符串与注释必须分色");

  const jsonSource = '{\n  "key": "value",\n  "count": 123,\n  "flag": true,\n  "none": null\n}\n';
  const jsonSpans = await highlightCode(jsonSource, "json");
  assert.ok(jsonSpans !== null);
  const keyColor = colorOf(jsonSource, jsonSpans, '"key"');
  const valueColor = colorOf(jsonSource, jsonSpans, '"value"');
  const countColor = colorOf(jsonSource, jsonSpans, "123");
  const boolColor = colorOf(jsonSource, jsonSpans, "true");
  assert.strictEqual(keyColor, keyword, "JSON 键必须是 keyword 色");
  assert.strictEqual(valueColor, stringExpression, "JSON 字符串值必须是 string-expression 色");
  assert.strictEqual(countColor, constant, "JSON 数字必须是 constant 色");
  assert.strictEqual(boolColor, constant, "JSON 布尔必须是 constant 色");
  for (const [label, color] of [
    ["键", keyColor],
    ["字符串值", valueColor],
    ["数字", countColor],
    ["布尔", boolColor],
  ] as const) {
    assert.notStrictEqual(color, foreground, `JSON ${label}不能落回 foreground`);
  }
  assert.notStrictEqual(keyColor, valueColor, "JSON 键与字符串值必须分色");
  assert.notStrictEqual(keyColor, countColor, "JSON 键与数字必须分色");
  assert.notStrictEqual(valueColor, countColor, "JSON 字符串值与数字必须分色");
}
console.log("highlight: import/from/export/type 与 JSON key/string/number/bool 词元色 ≠ foreground 且语义分色 ✓");

// ---------- 3. 静态精选语言都能工作 ----------
{
  const samples: [string, string][] = [
    ["javascript", "const a = 1;\n"],
    ["typescript", "const a: number = 1;\n"],
    ["jsx", "const a = <div>hi</div>;\n"],
    ["tsx", "const a: JSX.Element = <div>hi</div>;\n"],
    ["json", '{"a":1}\n'],
    ["jsonc", '{"a":1 // c\n}\n'],
    ["python", "def f():\n    return 1\n"],
    ["shellscript", "echo hi\n"],
    ["powershell", "Get-Item .\n"],
    ["c", "int main(void) { return 0; }\n"],
    ["cpp", "int main() { return 0; }\n"],
    ["csharp", "class A { static void Main() {} }\n"],
    ["go", "package main\n"],
    ["rust", "fn main() {}\n"],
    ["java", "class A {}\n"],
    ["html", "<p class=\"a\">hi</p>\n"],
    ["css", "a { color: red; }\n"],
    ["sql", "SELECT 1;\n"],
    ["yaml", "a: 1\n"],
    ["markdown", "# t\n"],
    ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n"],
  ];
  for (const [lang, code] of samples) {
    const spans = await highlightCode(code, lang);
    assert.ok(spans !== null, `${lang} 必须能高亮`);
    assert.strictEqual(textOf(code, spans), code, `${lang} 文本保真`);
  }
}
console.log("highlight: 21 种静态语法均可 tokenize 且文本保真 ✓");

// ---------- 4. 未知 / 超长 / 超长单行 / 空代码回退 ----------
{
  resetHighlightCache();
  assert.strictEqual(await highlightCode("x", "brainfuck"), null, "未知语言回退纯文本");
  assert.strictEqual(await highlightCode("", "ts"), null, "空代码不增强");
  const long = "x".repeat(MAX_HIGHLIGHT_CHARS + 1);
  assert.strictEqual(await highlightCode(long, "ts"), null, "超长代码跳过增强");
  assert.strictEqual(highlightCacheStats().entries, 0, "回退路径不写缓存");

  // 单行上限：恰好 4000 字符仍着色；多一个字符整块回退（先于引擎，不缓存）。
  const atCap = "x".repeat(MAX_HIGHLIGHT_LINE_CHARS);
  const overCap = "x".repeat(MAX_HIGHLIGHT_LINE_CHARS + 1);
  assert.ok(await highlightCode(atCap, "ts") !== null, "单行恰好达到上限仍可高亮");
  resetHighlightCache();
  assert.strictEqual(await highlightCode(overCap, "ts"), null, "LF 超长单行整块回退");
  assert.strictEqual(await highlightCode(`${overCap}\r\nconst b = 2;\r\n`, "ts"), null, "CRLF 超长单行整块回退");
  assert.strictEqual(highlightCacheStats().entries, 0, "超长单行回退不写缓存");
  const crlfAtCap = `${atCap}\r\nconst b = 2;\r\n`;
  assert.ok(await highlightCode(crlfAtCap, "ts") !== null, "CRLF 下行尾不计入单行长度");
}
console.log("highlight: 未知 / 空 / 超长 / 超长单行回退纯文本 ✓");

// ---------- 5. 成功与失败都缓存，条数 + 字符双限清理 ----------
{
  resetHighlightCache();
  const code = "const cached = 1;\n";
  const first = await highlightCode(code, "ts");
  const statsAfterFirst = highlightCacheStats();
  assert.strictEqual(statsAfterFirst.entries, 1);
  const second = await highlightCode(code, "ts");
  assert.strictEqual(second, first, "同一 code + lang 命中缓存（同一结果对象）");
  assert.strictEqual(highlightCacheStats().entries, 1, "命中不新增条目");

  // 失败缓存：构造超过 span 上限的代码（4500 行，每行至少一段），第一次失败后第二次命中失败缓存。
  const fragmented = Array.from({ length: 4500 }, () => "v").join("\n");
  assert.ok(fragmented.length < MAX_HIGHLIGHT_CHARS);
  assert.strictEqual(await highlightCode(fragmented, "ts"), null, "超过 span 上限回退纯文本");
  const failStats = highlightCacheStats();
  assert.strictEqual(failStats.failures, 1, "失败结果进入缓存");
  assert.strictEqual(await highlightCode(fragmented, "ts"), null, "第二次仍失败（命中失败缓存）");
  assert.strictEqual(highlightCacheStats().failures, 1, "失败缓存命中不重复计数");

  for (let index = 0; index < MAX_CACHE_ENTRIES + 8; index += 1) {
    await highlightCode(`const value${index} = ${index};\n`, "ts");
  }
  const stats = highlightCacheStats();
  assert.ok(stats.entries <= MAX_CACHE_ENTRIES, "缓存条数不超过上限");
  assert.ok(stats.chars <= MAX_CACHE_CHARS, "缓存总字符不超过上限");
}
console.log("highlight: 成功 / 失败缓存与条数、字符双限清理 ✓");

// ---------- 6. 同一 key 并发只 tokenize / 记账一次 ----------
{
  resetHighlightCache();
  const code = "const shared = 1;\n";
  const results = await Promise.all(Array.from({ length: 30 }, () => highlightCode(code, "ts")));
  const stats = highlightCacheStats();
  assert.strictEqual(stats.entries, 1, "并发同 key 只产生一个缓存条目");
  assert.strictEqual(stats.chars, code.length, "并发同 key 的字符数只记一次，不翻倍");
  assert.strictEqual(stats.failures, 0);
  for (const result of results) assert.strictEqual(result, results[0], "并发调用共享同一结果");

  const failed = Array.from({ length: 4500 }, () => "v").join("\n");
  resetHighlightCache();
  const failedResults = await Promise.all(Array.from({ length: 30 }, () => highlightCode(failed, "ts")));
  const failedStats = highlightCacheStats();
  assert.strictEqual(failedStats.entries, 1, "并发同 key 失败也只产生一个条目");
  assert.strictEqual(failedStats.chars, failed.length, "失败结果的字符数只记一次");
  assert.strictEqual(failedStats.failures, 1, "失败计数只记一次");
  for (const result of failedResults) assert.strictEqual(result, null);
}
console.log("highlight: 并发同 key 只 tokenize / 记账一次 ✓");

console.log("\nhighlight: all assertions passed");
