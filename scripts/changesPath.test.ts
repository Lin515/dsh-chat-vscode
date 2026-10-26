/**
 * 改动清单的坐标关联：根内相对 / 根外绝对 / 规范化根只能确定时关联。
 *
 * 清单是 Host 的固定根产物（`durablePathOf`：根内相对、根外绝对），而芯片路径可能是
 * 产物记录值或 `present` 申报。这里只做纯字符串比较：不用 basename、不转小写、
 * 不消点、不猜规范化根。证明不了同一目标时**不挂坐标**——真正打开只用清单自己的
 * `seq` / `index`，错误关联会让一行打开另一行的快照。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { changeIndexForPath } from "../src/shared/changesSummary";
import type { ChangedFileView } from "../src/shared/chat";

const file = (path: string, display = path): ChangedFileView => ({
  path,
  display,
  added: 1,
  deleted: 0,
});

// ---------- 1. 根内相对与根外绝对共存 ----------
{
  const files = [file("src/a.ts"), file("D:/out/b.png")];
  const cwd = "D:/dev/app";
  // 绝对候选（产物记录值）能对上根内相对行
  assert.strictEqual(changeIndexForPath(files, cwd, "D:/dev/app/src/a.ts"), 0);
  // 相对候选（旧产物 / present 申报）也能对上同一行
  assert.strictEqual(changeIndexForPath(files, cwd, "src/a.ts"), 0);
  // 根外绝对行只能由绝对候选证明
  assert.strictEqual(changeIndexForPath(files, cwd, "D:/out/b.png"), 1);
  assert.strictEqual(changeIndexForPath(files, cwd, "out/b.png"), undefined);
  // basename 不参与：`a.ts` 不是清单里的路径
  assert.strictEqual(changeIndexForPath(files, cwd, "a.ts"), undefined);
}
console.log("changesPath: 根内相对 / 根外绝对各自只接受能证明的候选 ✓");

// ---------- 2. 规范化根与 header 拼写不同：拼不上就不挂坐标 ----------
{
  const files = [file("src/a.ts")];
  // header 是符号链接拼写，Host 记的是 realpath：绝对候选与拼出来的都不同 → 不关联
  assert.strictEqual(changeIndexForPath(files, "D:/link/app", "D:/real/app/src/a.ts"), undefined);
  assert.strictEqual(changeIndexForPath(files, "D:/link/app", "src/a.ts"), 0, "相对对相对仍是同一根");
  // 清单给绝对行、候选是相对：只有拼出来逐字相等才关联
  assert.strictEqual(changeIndexForPath([file("D:/real/app/src/a.ts")], "D:/link/app", "src/a.ts"), undefined);
  assert.strictEqual(changeIndexForPath([file("D:/link/app/src/a.ts")], "D:/link/app", "src/a.ts"), 0);
}
console.log("changesPath: 规范化根不同且拼不上时宁可没有坐标 ✓");

// ---------- 3. 大小写与点段不是身份证据 ----------
{
  const files = [file("src/A.ts"), file("src/b.ts")];
  assert.strictEqual(changeIndexForPath(files, "/work", "src/A.ts"), 0);
  assert.strictEqual(changeIndexForPath(files, "/work", "src/a.ts"), undefined, "POSIX 大小写是不同身份");
  assert.strictEqual(changeIndexForPath(files, "/work", "/work/src/A.ts"), 0);
  assert.strictEqual(changeIndexForPath(files, "/work", "/work/src/a.ts"), undefined);
  // 不消 `.` / `..`：字符串层面证明不了（符号链接下还可能真的不同）
  assert.strictEqual(changeIndexForPath(files, "/work", "./src/A.ts"), undefined);
  assert.strictEqual(changeIndexForPath(files, "/work", "src/../src/A.ts"), undefined);
}
console.log("changesPath: 不 lowercase、不消点（错误关联比没有坐标更糟） ✓");

// ---------- 4. 分隔符：只对 Windows 形态做等价合并 ----------
{
  const files = [file("src/a.ts")];
  assert.strictEqual(changeIndexForPath(files, "D:\\dev\\app", "D:\\dev\\app\\src\\a.ts"), 0);
  assert.strictEqual(changeIndexForPath(files, "D:\\dev\\app", "D:/dev/app/src/a.ts"), 0);
  // POSIX 反斜杠是字面字符：不能因为看起来像分隔符就合并
  assert.strictEqual(changeIndexForPath([file("src/a.ts")], "/work", "src\\a.ts"), undefined);
  assert.strictEqual(changeIndexForPath([file("src\\a.ts")], "/work", "src/a.ts"), undefined);
}
console.log("changesPath: Windows 分隔符可合并，POSIX 反斜杠保持字面身份 ✓");

// ---------- 5. 空清单 / 空候选安全 ----------
{
  assert.strictEqual(changeIndexForPath([], "/work", "a.ts"), undefined);
  assert.strictEqual(changeIndexForPath([file("a.ts")], "/work", ""), undefined);
}
console.log("changesPath: 空清单 / 空候选安全 ✓");

// ---------- 6. 唯一命中才挂坐标：多行可证明同一目标时返回 undefined ----------
//
// 真实 Host 的清单通常不重复，但外部 wire / 规范化拼写仍可能造出「相对 x」与
// 「绝对 cwd/x」并存、或同一路径出现两次。首次命中即返回会静默选第一行；设计禁止
// 这种推断——猜错会让一行打开另一行的快照。
{
  const cwd = "D:/w";
  assert.strictEqual(
    changeIndexForPath([file("src/x.ts"), file("D:/w/src/x.ts")], cwd, "src/x.ts"),
    undefined,
    "相对行与绝对行都能被同一候选证明时，不能取先出现的那一行",
  );
  assert.strictEqual(
    changeIndexForPath([file("D:/w/src/x.ts"), file("src/x.ts")], cwd, "D:/w/src/x.ts"),
    undefined,
    "反过来的顺序同样歧义",
  );
  assert.strictEqual(
    changeIndexForPath([file("src/x.ts"), file("src/x.ts")], cwd, "src/x.ts"),
    undefined,
    "同一路径重复出现也是多行，不能默选第一行",
  );
  assert.strictEqual(
    changeIndexForPath([file("src/x.ts"), file("src/y.ts")], cwd, "src/x.ts"),
    0,
    "唯一命中照旧给下标",
  );
}
console.log("changesPath: 多行可证明同一目标时不挂坐标（唯一才关联） ✓");

console.log("\nchangesPath: all assertions passed");
