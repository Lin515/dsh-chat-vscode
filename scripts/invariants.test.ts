/**
 * 源码级不变量：`switch` 里不能有重复的 `case`。
 *
 * 为什么需要这条：**重复 case 不会报错**——后面的那个永远不会执行，
 * 是彻底的死代码，但 TypeScript、eslint、测试全都不说话。本次就撞上了一次：
 * `applyProjection` 里我先加了一个新的 `case "contextPressure"`（占用条口径），
 * 而旧的那个（只同步模型胶囊的 contextWindow）还在下面 —— 新逻辑生效了，
 * **旧的那件事被静默丢掉**（模型胶囊不再更新窗口上限）。最后是 esbuild 的
 * `[duplicate-case]` 警告发现的，`npm run typecheck` 一路绿灯。
 *
 * 所以这条断言的价值不在「现在的代码是对的」，而在「下次改 `applyProjection`
 * 这种几十个 case 的长 switch 时，不会又悄悄盖掉一个分支」。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 递归收集 src 下的 .ts（不含 .d.ts）与 .tsx。 */
function sourceFiles(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * 去掉行注释与块注释，**保留字符串字面量**（case 标签本身就是字符串）。
 *
 * 必须自己写而不是用正则：`//` 出现在字符串里（例如 `"https://x"`）不是注释，
 * 而注释里出现的 `case "x":` 又不该被当成 case。两者只能靠一个真正的扫描器区分。
 */
function stripComments(source: string): string {
  let out = "";
  let inString: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        // 保留换行，行号才不会跑偏
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 找一个 switch 块内所有 `case "字面量"`，返回重复的字面量。
 *
 * 用花括号配平界定 switch 体，避免把两个不同 switch 里的同名 case 误判成重复
 * （这在 `projections.ts` 那种文件里很容易发生）。
 */
function duplicateCases(source: string): { name: string; line: number }[] {
  const duplicates: { name: string; line: number }[] = [];
  const switchRe = /\bswitch\s*\([^)]*\)\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = switchRe.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    let inString: string | null = null;
    for (let i = bodyStart; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (ch === "\\") i += 1;
        else if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
      // 注释里的花括号不算（注释内容不进 out，所以这里只需跳过）
      if (ch === "/" && source[i + 1] === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && source[i + 1] === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 1;
        continue;
      }
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    // 注释会**保持原长度**地去掉（换行保留），所以行号仍然对得上原文件
    const body = stripComments(source.slice(bodyStart, end + 1));
    const seen = new Map<string, number>();
    const caseRe = /\bcase\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
    let caseMatch: RegExpExecArray | null;
    while ((caseMatch = caseRe.exec(body)) !== null) {
      const name = caseMatch[1];
      const line = source.slice(0, bodyStart + caseMatch.index).split("\n").length;
      const previous = seen.get(name);
      if (previous !== undefined) duplicates.push({ name, line });
      else seen.set(name, line);
    }
  }
  return duplicates;
}

// ---------- 1. 探测能力自检：假源码必须被抓到 ----------
//
// 一条永远不报错的断言等于没有断言，所以先证明它认得出重复 case。
{
  const bad = `
    switch (key) {
      case "a": return 1;
      case "b": return 2;
      case "a": return 3;
    }
  `;
  const found = duplicateCases(bad);
  assert.strictEqual(found.length, 1, "重复 case 必须被抓到（否则这条断言没有价值）");
  assert.strictEqual(found[0].name, '"a"');
}
console.log("invariants: 重复 case 探测能力自检 ✓");

// ---------- 2. 两个不同 switch 里的同名 case 不算重复 ----------

{
  const fine = `
    switch (a) { case "x": break; }
    switch (b) { case "x": break; }
  `;
  assert.deepStrictEqual(duplicateCases(fine), [], "不同 switch 的同名 case 是正常的");
  // 注释里的同名 case 也不算
  const commented = `
    switch (a) {
      case "x": break;
      // case "x": 这行是注释
    }
  `;
  assert.deepStrictEqual(duplicateCases(commented), [], "注释里的 case 不算");
}
console.log("invariants: 不误报（不同 switch / 注释） ✓");

// ---------- 3. 真实源码：每个 switch 内 case 唯一 ----------

{
  const files = sourceFiles(join(process.cwd(), "src"));
  const problems: string[] = [];
  for (const file of files) {
    for (const dup of duplicateCases(readFileSync(file, "utf8"))) {
      problems.push(`${file.replace(process.cwd() + "\\", "")}:${dup.line} 重复的 case ${dup.name}`);
    }
  }
  assert.deepStrictEqual(
    problems,
    [],
    `同一个 switch 里有重复 case（后者永远不会执行，是静默死代码）：\n${problems.join("\n")}`,
  );
  console.log(`invariants: 扫了 ${files.length} 个源文件，无重复 case ✓`);
}

console.log("\ninvariants: all assertions passed");
