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
import {
  fileChangeKind,
  hasWorkingChange,
  isUntracked,
  resolveChipPath,
  type GitChangeStateLike,
} from "../src/dsh/fileChange";

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
  const state: GitChangeStateLike = {
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
    /await this\.openFile\(message\.path, message\.diff, viewId, scope \? this\.cwdOf\(scope\) : undefined\)/.test(
      controller,
    ),
    "openFile 分支必须把 diff、viewId（删除提示 toast 要发给对应窗口）与会话 cwd（相对路径解析基准）传下去",
  );
  assert.ok(
    /adapter\.classifyFiles = \(paths\) => this\.classifyFiles\(this\.cwdOf\(scope\), paths\)/.test(controller),
    "分类回调必须带会话 cwd：芯片相对路径不解析会被误判成 deleted",
  );
  assert.ok(
    /const resolved = resolveChipPath\(cwd, path\);\s*if \(!resolved\) return undefined;/.test(controller),
    "classifyFiles 必须先解析再查盘：解析不了 = 不确定（无记号），不猜 deleted",
  );
  assert.ok(
    /await this\.openChanges\(uri\)/.test(controller),
    "openChanges 不再吃 exists：磁盘存在性只由 openFile 决定「删除提示 vs 普通打开」",
  );
  assert.ok(
    /if \(hasWorkingChange\(repo\.state, uri\.fsPath\)\) \{\s*await vscode\.commands\.executeCommand\("git\.openChange", uri\);/.test(
      controller,
    ),
    "对比窗口只准在「确认在改动清单里」的分支里开（未跟踪/已删除/无改动一律不进这条命令）",
  );
  assert.ok(
    !/git\.refresh/.test(controller),
    "点击链路不做「轻推重扫 + 轮询」（用户 2026-09-14 拍板：即时感优先，宁可第一次点不出 diff）",
  );
  assert.ok(
    !/nudgeGitRefresh/.test(controller),
    "竞态修复机制已整体撤掉，别只删一半留下死代码",
  );
  assert.ok(
    /executeCommand\("git\.openChange", uri\)/.test(controller),
    "对比窗口复用 git 扩展的 git.openChange（SCM 的「打开更改」）",
  );
  assert.ok(
    /@chipFileDeleted/.test(controller),
    "内容找不回的已删除文件要明确提示，不能静默",
  );
}
console.log("fileChange: 界面与宿主都接上了这条链路 ✓");

// ---------- 7. 种类判定：新文件 / 改动 / 已删除 / 不确定 ----------
//
// 芯片记号（[新增] / 删除线）与点击行为共用这一份判定（fileChangeKind）；
// 优先级是「磁盘说了算」：文件没了就是 deleted，哪怕 git 清单里还有它。
{
  const tracked: GitChangeStateLike = { workingTreeChanges: [change(TARGET)] };
  const staged: GitChangeStateLike = { indexChanges: [change(TARGET)] };
  const untracked: GitChangeStateLike = { untrackedChanges: [change(TARGET)] };

  assert.strictEqual(
    fileChangeKind(tracked, TARGET, true),
    "edited",
    "在工作区改动清单里 = edited（git.openChange 能开对比窗口）",
  );
  assert.strictEqual(
    fileChangeKind(staged, TARGET, true),
    "edited",
    "暂存过的改动同样算 edited（SCM 里它也是「打开更改」）",
  );
  assert.strictEqual(
    fileChangeKind(untracked, TARGET, true),
    "new",
    "未跟踪 = new（模型新建，点开直接看文件，不开 diff）",
  );
  assert.strictEqual(
    fileChangeKind(undefined, TARGET, true),
    undefined,
    "拿不到 git 状态 → 不标记号（没有记号是「不确定」，不是「没改动」）",
  );
  assert.strictEqual(
    fileChangeKind({}, TARGET, true),
    undefined,
    "哪个清单都不在 → 不标记号（无改动 / 被 .gitignore / 不在仓库）",
  );
  assert.strictEqual(
    fileChangeKind(untracked, TARGET, false),
    "deleted",
    "磁盘上没有了 → deleted 优先于未跟踪（先写后删的临时文件就该这么显示）",
  );
  assert.strictEqual(
    fileChangeKind(tracked, TARGET, false),
    "deleted",
    "跟踪中的删除也是 deleted：点开对比窗口还能看到删除前的内容",
  );
  assert.strictEqual(
    isUntracked(untracked, "d:/dev/app/src/config.ts"),
    true,
    "isUntracked 与 hasWorkingChange 同一口径：路径写法变体要能命中",
  );
  assert.strictEqual(
    isUntracked({}, TARGET),
    false,
    "空状态不算未跟踪（不会把没分类的文件误标成 [新增]）",
  );
}
console.log("fileChange: 种类判定（new/edited/deleted/不确定）✓");

// ---------- 8. 相对芯片路径解析（基准 = 会话工作目录） ----------
//
// 芯片路径取自工具调用参数的原样拼写，模型常用相对路径（本扩展自己发起的
// edit / write 调用就是）。不先解析就 Uri.file → stat 必失败 → fileChangeKind
// 把刚改过的文件误判成 deleted（用户报的 Composer.tsx 删除线）。
{
  assert.strictEqual(
    resolveChipPath("D:\\dev\\app", "src/config.ts"),
    "D:\\dev\\app\\src\\config.ts",
    "相对路径必须拼到会话 cwd 下",
  );
  assert.strictEqual(
    resolveChipPath("D:\\dev\\app", "src/webview/components/Composer.tsx"),
    "D:\\dev\\app\\src\\webview\\components\\Composer.tsx",
    "多级相对路径同样拼到 cwd 下",
  );
  assert.strictEqual(
    resolveChipPath("D:\\dev\\app", "D:\\other\\config.ts"),
    "D:\\other\\config.ts",
    "绝对路径原样透传（不二次拼接）",
  );
  assert.strictEqual(
    resolveChipPath(undefined, "src/config.ts"),
    undefined,
    "相对但拿不到 cwd → 解析不了（调用方退化为无记号，绝不猜 deleted）",
  );
  assert.strictEqual(resolveChipPath("D:\\dev\\app", ""), undefined, "空路径解析不了（调用方跳过）");
}
console.log("fileChange: 相对路径解析（基准是会话 cwd）✓");

console.log("\nfileChange: all assertions passed");
