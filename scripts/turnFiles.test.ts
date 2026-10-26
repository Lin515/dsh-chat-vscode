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
import { producedOnly } from "../src/webview/turnFiles";

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

// ---------- 3. 同一文件的两种写法要判成同一个（只限能证明的拼写） ----------
//
// 写类调用与 present 申报是两次独立的工具调用，分隔符可能不同。Windows 形态路径的
// 两种分隔符在 provider 里等价，可以合并；**大小写不能**：POSIX 上 `A.ts` 与 `a.ts`
// 是两个文件，「多半是同一个」不是身份证据。
{
  const left = producedOnly(
    ["D:\\dev\\app\\src\\config.ts", "D:/dev/app/src/other.ts"],
    [{ path: "D:/dev/app/src/config.ts" }],
  );
  assert.deepStrictEqual(left, ["D:/dev/app/src/other.ts"], "反斜杠/正斜杠不同仍是同一个文件");
}
{
  const left = producedOnly(
    ["D:\\dev\\app\\src\\Config.ts", "D:/dev/app/src/other.ts"],
    [{ path: "D:/dev/app/src/config.ts" }],
  );
  assert.deepStrictEqual(
    left,
    ["D:\\dev\\app\\src\\Config.ts", "D:/dev/app/src/other.ts"],
    "大小写不同的全路径是两个身份，不按本机平台一刀切",
  );
  assert.deepStrictEqual(
    producedOnly(["/work/A.ts", "/work/a.ts"], []),
    ["/work/A.ts", "/work/a.ts"],
    "POSIX 同名不同大小写必须各自保留",
  );
  assert.deepStrictEqual(
    producedOnly([{ path: "/work/A.ts" }, { path: "/work/A.ts" }], []),
    ["/work/A.ts"],
    "完全相同的展示路径仍只列一次",
  );
}
console.log("turnFiles: 分隔符可合并；大小写/点段不当作同一身份 ✓");

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
    /producedOnly\(message\.produced, presented\)/.test(message) &&
      /deliverablesForClosing\(message\.deliverables\)/.test(message),
    "Message 必须先用 deliverablesForClosing 去重，再用 producedOnly(message.produced, presented) 推导「本轮文件改动」行",
  );  assert.ok(
    !/withoutVanished/.test(message),
    "不能再过 withoutVanished：执行世界无法证明净效果为零，删除线是唯一可证明的记号",
  );
  assert.ok(
    !/message\.produced\.map\(\(path\) => \(\{ path \}\)\)/.test(message),
    "不能直接用 message.produced 渲染——那会把已申报交付的文件重复列一遍",
  );
  assert.ok(
    !/paths=\{message\.deliverables\}/.test(message),
    "交付行必须先经 deliverablesForClosing，不能直接渲染原始申报列表",
  );
}
console.log("turnFiles: 轮尾渲染接了去重 ✓");

console.log("\nturnFiles: all assertions passed");
