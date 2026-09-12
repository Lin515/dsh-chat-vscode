/**
 * 单行标题里的路径拆分与省略口径。
 *
 * 用户反馈：读取节点的行号缀在**被省略的**路径后面，看起来违和。根因是
 * `.row-detail` 用 `text-overflow: ellipsis` 从右侧省略——`…/src/dsh/controller.ts`
 * 在窄侧栏会变成 `…/src/dsh/contro…`，`:100-120` 于是贴在半截文件名后面。
 *
 * 正确口径：拆成「目录 + 文件名」，**文件名不参与压缩**、目录从前段被裁，
 * 行号因此永远紧贴完整文件名。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { looksLikePath, splitPath } from "../src/webview/pathDisplay";

// ---------- 1. 路径拆分：文件名与目录各归各位 ----------

{
  const win = splitPath("D:\\dev\\dsh-chat\\src\\dsh\\controller.ts");
  assert.deepStrictEqual(win, { dir: "D:\\dev\\dsh-chat\\src\\dsh\\", name: "controller.ts" });

  const posix = splitPath("src/dsh/controller.ts");
  assert.deepStrictEqual(posix, { dir: "src/dsh/", name: "controller.ts" });

  // 分隔符原样保留：Windows 路径回显 `\`，不去改写用户看到的东西
  assert.ok(win!.dir.endsWith("\\"), "Windows 路径的目录分隔符要原样保留");
  assert.ok(posix!.dir.endsWith("/"), "POSIX 路径同上");

  // 混合分隔符（真实工具参数里出现过）取最后出现的那个
  assert.deepStrictEqual(splitPath("src\\sub/odd name/x.ts"), {
    dir: "src\\sub/odd name/",
    name: "x.ts",
  });

  // 相对路径 `./x.ts`
  assert.deepStrictEqual(splitPath("./x.ts"), { dir: "./", name: "x.ts" });
}
console.log("pathDisplay: 路径拆出目录与文件名，分隔符原样保留 ✓");

// ---------- 2. 不像路径的东西必须原样渲染（不能误伤） ----------

{
  // 命令行：首个 token（`cmake`）不含分隔符 → 更像命令行，走原来的右省略
  assert.strictEqual(looksLikePath("cmake --build build-agent --parallel 8"), false);
  assert.strictEqual(splitPath("cmake --build build-agent --parallel 8"), undefined);
  // 命令行里带相对路径也一样：首个 token 是程序名
  assert.strictEqual(looksLikePath("cmake --build ./build-agent"), false);
  assert.strictEqual(looksLikePath("npm run build --prefix examples/foo"), false);
  // grep 查询串
  assert.strictEqual(looksLikePath("listen("), false);
  // URL：主机名比末段有价值
  assert.strictEqual(looksLikePath("https://example.com/a/b/c"), false);
  assert.strictEqual(splitPath("http://127.0.0.1:3080/api/session/page"), undefined);
  // 无分隔符的裸文件名 / 普通文本
  assert.strictEqual(splitPath("package.json"), undefined);
  assert.strictEqual(splitPath(""), undefined);
}
console.log("pathDisplay: 命令行/URL/查询串都不按路径处理 ✓");

// ---------- 2b. **带空格的路径**必须仍按路径处理 ----------
//
// 反例驱动的修正：最初用「含空白就不是路径」当判据，于是
// `src/sub/odd name/x.ts` 与 `C:\Program Files\app\x.exe` 都被判成命令行——
// 而它们是货真价实的路径，文件名会被右省略切掉（正是这次要修的问题）。
// 真正的区别在**首个 token**：路径的分隔符出现在空白之前，命令行的程序名不含分隔符。
{
  assert.strictEqual(looksLikePath("src/sub/odd name/x.ts"), true, "目录名里的空格不该让它变成命令行");
  assert.deepStrictEqual(splitPath("src/sub/odd name/x.ts"), {
    dir: "src/sub/odd name/",
    name: "x.ts",
  });
  assert.strictEqual(looksLikePath("C:\\Program Files\\app\\x.exe"), true);
  assert.deepStrictEqual(splitPath("C:\\Program Files\\app\\x.exe"), {
    dir: "C:\\Program Files\\app\\",
    name: "x.exe",
  });
  // 相对路径开头的 `./` 也算路径
  assert.strictEqual(looksLikePath("./my dir/x.ts"), true);
}
console.log("pathDisplay: 带空格的路径仍按路径处理（文件名不被切） ✓");

// ---------- 3. 源码级不变量：Row 必须把文件名交给不压缩的那一段 ----------
//
// 这段逻辑读 CSS 看不出来（省略方向由 flex + overflow 的交互决定），
// 所以直接用源码断言钉住结构：路径类 detail 必须拆成两个 span，
// 且 detailSuffix 渲染在它们**之后**（= 紧贴文件名）。
{
  const primitives = readFileSync(
    join(process.cwd(), "src", "webview", "components", "primitives.tsx"),
    "utf8",
  );
  assert.ok(
    /splitPath\(detail\)/.test(primitives),
    "Row 必须用 splitPath 拆分路径类 detail，否则文件名会被右省略切掉",
  );
  assert.ok(
    /row-detail-dir/.test(primitives) && /row-detail-name/.test(primitives),
    "目录段与文件名段必须是两个独立元素（前者可裁、后者不压缩）",
  );
  const nameAt = primitives.indexOf("row-detail-name");
  const suffixAt = primitives.indexOf("row-detail-suffix");
  assert.ok(nameAt >= 0 && suffixAt > nameAt, "行号后缀必须渲染在文件名**之后**（紧贴文件名）");

  // CSS 侧：目录段必须允许被裁且从左侧溢出，文件名段不参与压缩
  const css = readFileSync(join(process.cwd(), "src", "webview", "styles", "app.css"), "utf8");
  const dirRule = /\n\.row-detail-dir\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(dirRule, "app.css 里找不到 .row-detail-dir");
  assert.ok(/overflow:\s*hidden/.test(dirRule[1]), "目录段必须 overflow:hidden 才能被裁");
  assert.ok(
    /justify-content:\s*flex-end/.test(dirRule[1]),
    "目录段必须 justify-content:flex-end——溢出才会发生在**起始侧**（省略前段路径）",
  );
  const nameRule = /\n\.row-detail-name\s*\{([\s\S]*?)\}/.exec(css);
  assert.ok(nameRule, "app.css 里找不到 .row-detail-name");
  assert.ok(
    /flex:\s*0 0 auto/.test(nameRule[1]),
    "文件名段必须 flex:0 0 auto（不压缩）——这是「保住文件名」的实现",
  );
}
console.log("pathDisplay: 结构不变量（目录可裁 / 文件名不压缩 / 行号紧贴文件名） ✓");

console.log("\npathDisplay: all assertions passed");
