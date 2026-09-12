/**
 * 「点文件芯片 → 开 VS Code 的改动对比」这条链路的判定：**哪些文件算有改动**。
 *
 * 用户 2026-09-12 要求：文件改动里点文件时直接打开 VS Code 的改动对比窗口。
 * 实现走 git 扩展的 `git.openChange`，而这条命令对**不在改动清单里的文件是
 * 静默无操作**（内部 `getSCMResource()` 找不到资源就 return）——所以判定写错的
 * 症状是「点了没反应」，不是报错，只能靠断言钉住。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hasWorkingChange, type GitChangeStateLike } from "../src/dsh/fileChange";

/** 造一条改动记录（与 git 扩展 API 里 `Change.uri.fsPath` 同形）。 */
function change(fsPath: string) {
  return { uri: { fsPath } };
}

const TARGET = "D:\\dev\\app\\src\\config.ts";

// ---------- 1. 三个清单都算改动：工作区 / 暂存区 / 合并 ----------
{
  assert.ok(
    hasWorkingChange({ workingTreeChanges: [change(TARGET)] }, TARGET),
    "工作区改动必须算（这是最常见的一种）",
  );
  assert.ok(
    hasWorkingChange({ indexChanges: [change(TARGET)] }, TARGET),
    "已暂存（git add 过）的改动也算——SCM 里点它同样是打开更改",
  );
  assert.ok(
    hasWorkingChange({ mergeChanges: [change(TARGET)] }, TARGET),
    "冲突文件算改动（git.openChange 也查 mergeGroup）",
  );
  assert.ok(
    hasWorkingChange(
      { workingTreeChanges: [change("D:\\dev\\app\\other.ts")], indexChanges: [change(TARGET)] },
      TARGET,
    ),
    "命中在第二个清单里也要算",
  );
}
console.log("fileChange: 三个改动清单都能命中 ✓");

// ---------- 2. 路径写法不保证一致：分隔符 / 大小写 / 结尾分隔符 ----------
{
  const variants = ["d:/dev/app/src/config.ts", "D:/dev/app/src/config.ts", "d:\\dev\\app\\src\\config.ts"];
  for (const written of variants) {
    assert.ok(
      hasWorkingChange({ workingTreeChanges: [change(written)] }, TARGET),
      `改动清单里的写法 ${written} 必须与芯片路径判成同一个文件`,
    );
    assert.ok(
      hasWorkingChange({ workingTreeChanges: [change(TARGET)] }, written),
      `反向也一样：${written} 作为芯片路径时要能命中`,
    );
  }
}
console.log("fileChange: 分隔符与大小写不影响判定 ✓");

// ---------- 3. 未跟踪文件**刻意不算**改动 ----------
//
// 这条是本次最容易踩的坑：把 untrackedChanges 也当改动 → `git.openChange` 内部
// 在 untrackedGroup 里找不到资源 → 命令静默什么都不做 → 用户点了没反应。
// 正确做法是不算改动，让宿主回落成普通打开（至少文件会打开）。
{
  const state: GitChangeStateLike & { untrackedChanges?: { uri: { fsPath: string } }[] } = {
    untrackedChanges: [change(TARGET)],
  };
  assert.strictEqual(
    hasWorkingChange(state, TARGET),
    false,
    "未跟踪文件不算「有可对比的改动」——交给调用方回落普通打开",
  );
}
console.log("fileChange: 未跟踪文件不算改动（否则点了没反应）✓");

// ---------- 4. 没有改动 / 拿不到状态：一律 false ----------
{
  assert.strictEqual(hasWorkingChange(undefined, TARGET), false, "拿不到 git 状态时不动手");
  assert.strictEqual(hasWorkingChange({}, TARGET), false, "三个清单都缺");
  assert.strictEqual(
    hasWorkingChange({ workingTreeChanges: [], indexChanges: [], mergeChanges: [] }, TARGET),
    false,
    "清单是空数组",
  );
  assert.strictEqual(
    hasWorkingChange({ workingTreeChanges: [change("D:\\dev\\app\\src\\other.ts")] }, TARGET),
    false,
    "同目录的另一个文件不算",
  );
  assert.strictEqual(hasWorkingChange({ workingTreeChanges: [change(TARGET)] }, ""), false, "空路径不成事");
}
console.log("fileChange: 无改动/无状态安全返回 false ✓");

// ---------- 5. 相邻路径不能被前缀匹配误伤 ----------
{
  const state: GitChangeStateLike = {
    workingTreeChanges: [change("D:\\dev\\app\\src\\config.tsx"), change("D:\\dev\\app\\sr\\config.ts")],
  };
  assert.strictEqual(
    hasWorkingChange(state, TARGET),
    false,
    "config.tsx / sr\\config.ts 都不是 config.ts（判据必须是整段路径相等，不是前缀）",
  );
  // 反过来：真命中时不能被别的项掩盖
  assert.ok(
    hasWorkingChange({ workingTreeChanges: [...state.workingTreeChanges!, change(TARGET)] }, TARGET),
    "同清单里混着别的文件时仍要命中",
  );
}
console.log("fileChange: 相邻路径不误判 ✓");

// ---------- 6. 结构不变量：界面发 diff、宿主先判定再开对比 ----------
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  assert.ok(
    /post\(\{ type: "openFile", path: file\.path, diff: wantsChanges\(event\) \}\)/.test(rows),
    "文件芯片必须带 diff 意图（并按修饰键决定），否则点击只会普通打开",
  );
  assert.ok(
    /function wantsChanges\(event: MouseEvent\): boolean \{/.test(rows),
    "修饰键判定要留在界面侧（Alt/Ctrl/Cmd/Shift 直接打开文件）",
  );

  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /await this\.openFile\(message\.path, message\.diff\)/.test(controller),
    "openFile 分支必须把 diff 传下去",
  );
  assert.ok(
    /if \(diff === true && \(await this\.openChanges\(uri\)\)\) return;/.test(controller),
    "有改动就走对比窗口，并且不给普通打开留第二次机会（否则会多开一个标签）",
  );
  assert.ok(
    /hasWorkingChange\(state, uri\.fsPath\)/.test(controller),
    "调 git.openChange 之前必须先自己判定有没有改动",
  );
  assert.ok(
    !/untrackedChanges/.test(controller),
    "不能把未跟踪文件当改动：git.openChange 对它们静默无操作 → 点了没反应",
  );
  assert.ok(
    /executeCommand\("git\.openChange", uri\)/.test(controller),
    "对比窗口复用 git 扩展的 git.openChange（SCM 的「打开更改」）",
  );
}
console.log("fileChange: 界面与宿主都接上了这条链路 ✓");

console.log("\nfileChange: all assertions passed");
