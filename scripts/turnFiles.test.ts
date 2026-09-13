/**
 * 轮尾文件两行的去重口径：交付行说了的，「本轮文件改动」不重复。
 *
 * 用户 2026-09-12 反馈：模型申报交付的就是它刚改的那几个文件时，界面上
 * 「本轮文件改动」与「交付文件」把同一串文件名各列了一遍，像同一件事提示两次。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { producedOnly, withoutVanished } from "../src/webview/turnFiles";

// ---------- 1. 用户报的那个场景：两边一模一样 ----------
{
  const files = ["webview/styles/app.css", "webview/components/Composer.tsx"];
  const left = producedOnly(files, files.map((path) => ({ path })));
  assert.deepStrictEqual(left, [], "全部已申报交付时，「本轮文件改动」行不该再列一遍");
}
console.log("turnFiles: 两行完全相同 → 只留交付行 ✓");

// ---------- 2. 部分重叠：只留没申报的，顺序不变 ----------
{
  const left = producedOnly(
    ["a.ts", "b.ts", "c.ts", "d.ts"],
    [{ path: "b.ts", description: "方案" }, { path: "d.ts" }],
  );
  assert.deepStrictEqual(left, ["a.ts", "c.ts"], "只去掉申报过的，其余保持原顺序");
}
console.log("turnFiles: 部分重叠只去掉申报过的 ✓");

// ---------- 3. 同一文件的两种写法要判成同一个 ----------
//
// 写类调用与 present 申报是两次独立的工具调用，分隔符与大小写不保证一致。
{
  const left = producedOnly(
    ["D:\\dev\\app\\src\\config.ts", "D:/dev/app/src/other.ts"],
    [{ path: "d:/dev/app/src/config.ts" }],
  );
  assert.deepStrictEqual(left, ["D:/dev/app/src/other.ts"], "反斜杠/大小写不同仍是同一个文件");
}
console.log("turnFiles: 分隔符与大小写不影响判重 ✓");

// ---------- 4. 边界：只有一边有内容 ----------
{
  assert.deepStrictEqual(producedOnly(["a.ts"], undefined), ["a.ts"], "没有交付时原样列出");
  assert.deepStrictEqual(producedOnly(undefined, [{ path: "a.ts" }]), [], "没有改动时这一行不显示");
  assert.deepStrictEqual(producedOnly([], []), [], "两边都空");
  // Bash / 终端建的文件不在 produced 里，只在交付行出现——这条路径不受去重影响
  assert.deepStrictEqual(
    producedOnly([], [{ path: "out/report.html" }]),
    [],
    "只有交付（例如 Bash 建的文件）时，「本轮文件改动」行保持不显示",
  );
}
console.log("turnFiles: 单边与空输入安全 ✓");

// ---------- 5. 结构不变量：轮尾渲染必须走这个口径 ----------
{
  const message = readFileSync(join(process.cwd(), "src", "webview", "components", "Message.tsx"), "utf8");
  assert.ok(
    /withoutVanished\(\s*producedOnly\(message\.produced, message\.deliverables\)/.test(message),
    "Message 必须用 producedOnly(...) 推导「本轮文件改动」行（外面再套一层 withoutVanished）",
  );
  assert.ok(
    !/message\.produced\.map\(\(path\) => \(\{ path \}\)\)/.test(message),
    "不能直接用 message.produced 渲染——那会把已申报交付的文件重复列一遍",
  );
  assert.ok(
    !/paths=\{message\.deliverables\}/.test(message),
    "交付行也要过 withoutVanished：净效果为零的文件两行都不该出现",
  );
}
console.log("turnFiles: 轮尾渲染接了去重 ✓");

// ---------- 6. 净效果为零的文件不出现在轮尾两行里 ----------
//
// 用户 2026-09-14 报的现场：让模型提交时它把提交信息写进 `commit.msg.txt`，
// 提交完再删掉。文件进过 write 调用，于是永远留在 produced 里；磁盘上已经没有了，
// 宿主按存在性判成 deleted → 界面上冒出一条带删除线的 commit.msg.txt，
// 看着像仓库里挂着一个待提交的删除。宿主现在把它分类成 `gone`（磁盘上没有 +
// git 四张清单里都没有），界面据此**整条不渲染**。
{
  const kinds = {
    "commit.msg.txt": "gone" as const,
    "src/app.ts": "edited" as const,
  };
  assert.deepStrictEqual(
    withoutVanished(["commit.msg.txt", "src/app.ts"], kinds, (path) => path),
    ["src/app.ts"],
    "写了又删、git 也不认识的临时文件不列出来",
  );
  assert.deepStrictEqual(
    withoutVanished([{ path: "commit.msg.txt" }], kinds, (file) => file.path),
    [],
    "交付行同理（present 申报过的临时文件也一并消失）",
  );
  // 真被删掉的文件（git 有记录 = deleted）必须**留下**：那是仓库里真实的待提交改动
  assert.deepStrictEqual(
    withoutVanished(["old.ts"], { "old.ts": "deleted" as const }, (path) => path),
    ["old.ts"],
    "git 有记录的删除照旧显示——藏起来才是丢信息",
  );
  // 拿不到分类表时一律保留：不确定 ≠ 净效果为零
  assert.deepStrictEqual(
    withoutVanished(["a.ts"], undefined, (path) => path),
    ["a.ts"],
    "还没分类完时不能凭猜测隐藏文件",
  );
}
console.log("turnFiles: 净效果为零的文件两行都不列 ✓");

console.log("\nturnFiles: all assertions passed");
