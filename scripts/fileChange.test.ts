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
  hasGitRecord,
  hasWorkingChange,
  isNotFoundError,
  isUntracked,
  resolveChipPath,
  type GitChangeStateLike,
} from "../src/dsh/fileChange";

/** 造一条改动记录（与 git 扩展 API 里 `Change.uri.fsPath` 同形）。 */
function change(fsPath: string) {
  return { uri: { fsPath } };
}

/** 造一条带 status 的改动记录（公开 API 的 `Change.status`）。 */
function changeWithStatus(fsPath: string, status: number) {
  return { uri: { fsPath }, status };
}

/**
 * git 扩展 `Status` 枚举的**实测值**（本机 VS Code 1.137.0 的
 * `extensions/git/dist/main.js` 里那个冻结字面量：
 * `{INDEX_MODIFIED:0, …, MODIFIED:5, DELETED:6, UNTRACKED:7, IGNORED:8, …}`）。
 *
 * 这里**故意写成字面量**、不 import 源码里的常量：断言要钉住的是「源码用的是
 * 这个实测值」，import 进来就成了自证（源码改错、测试跟着一起错）。
 */
const MODIFIED = 5;
const UNTRACKED = 7;
const IGNORED = 8;

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

// ---------- 3. 未跟踪文件不算「有改动」，但要**认得出来** ----------
//
// 这条最初是为了「点了没反应」：`git.openChange` 内部走 `getSCMResource()`，而它只查
// 工作区 / 暂存 / 合并三组。未跟踪文件在 `untrackedGroup` 里（`git.untrackedChanges:
// "separate"` 时）→ 命令找不到资源 → 静默什么都不做。
//
// 但清单归属**取决于配置**（本机 VS Code 1.137.0 的 git 扩展实测：`case"??"` 按
// `git.untrackedChanges` 分流，"mixed" 进工作区组、"separate" 进未跟踪组、"hidden"
// 丢弃）。默认是 "mixed"，所以同一件事有两种形状：
//
// - separate：只在 `untrackedChanges` 里 → 三个清单都没它 → 不算改动（宿主回落普通打开）；
// - mixed：在**工作区清单**里、`status = UNTRACKED(7)` → 算「findable」，
//   `git.openChange` 找得到它，只是 git 对 UNTRACKED 解析出的左侧为空 → 最终执行
//   的是 `vscode.open`（打开文件本身）。点击链路因此**不必**为 [新增] 单开分支。
{
  const separate: GitChangeStateLike = {
    untrackedChanges: [change(TARGET)],
  };
  assert.strictEqual(
    hasWorkingChange(separate, TARGET),
    false,
    "separate 配置：未跟踪文件不在三组里 → 不算「有可对比的改动」，交给调用方回落普通打开",
  );
  const mixed: GitChangeStateLike = {
    workingTreeChanges: [changeWithStatus(TARGET, UNTRACKED)],
  };
  assert.strictEqual(
    hasWorkingChange(mixed, TARGET),
    true,
    "mixed 配置：未跟踪文件就在工作区清单里 → getSCMResource 找得到，点击会走 git.openChange" +
      "（git 自己对 UNTRACKED 解析出空左侧 → 实际执行 vscode.open，开的是文件本身）",
  );
  assert.strictEqual(
    hasWorkingChange(mixed, "D:\\dev\\app\\src\\other.ts"),
    false,
    "同目录的另一个文件不受影响",
  );
}
console.log("fileChange: 未跟踪文件不算「有改动」，但两种配置下都认得出来 ✓");

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
  // 会话状态字段的取值与折返收在 `dsh/sessionView.ts`（`sessionSourceOf` + 字段表）：
  // 「首帧快照带没带上某个字段」这类断言现在要同时看那个文件。
  const sessionViewModule = readFileSync(join(process.cwd(), "src", "dsh", "sessionView.ts"), "utf8");
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
    "对比窗口只准在「确认在改动清单里」的分支里开（无改动不进这条命令；" +
      "未跟踪文件在默认 mixed 配置下本就在工作区清单里，git 自己解析成 vscode.open，" +
      "被跟踪的删除**在**工作区清单里，走的正是这条——点开看得到删除前的内容）",
  );
  assert.ok(
    !/git\.refresh/.test(controller),
    "点击链路不做「轻推重扫 + 轮询」（用户 2026-09-14 拍板：即时感优先，宁可第一次点不出 diff）；" +
      "刷新只发生在轮次结束（refreshGitState 走 git API 的 repository.status()，不是这条命令）",
  );
  assert.ok(
    !/nudgeGitRefresh/.test(controller),
    "竞态修复机制已整体撤掉，别只删一半留下死代码",
  );
  assert.ok(
    /executeCommand\("git\.openChange", uri\)/.test(controller),
    "对比窗口复用 git 扩展的 git.openChange（SCM 的「打开更改」）",
  );
  // ---------- 轮次结束主动刷新 Git 状态（修「第一次点不是 diff」） ----------
  //
  // git 扩展按 fs 事件去抖刷新，模型刚写完的文件还没进改动清单 → 第一次点芯片
  // 被判定「没改动」、打开完整文件；过一会儿或点第二次才是 diff。解法是在轮次
  // 结束（文件都落盘了）时主动推一次 repo.status()，**不在点击链路里等**
  // （点击时轮询那个方案已被用户否决）。
  assert.ok(
    /adapter\.refreshFiles = \(\) => this\.refreshGitState\(\)/.test(controller),
    "适配器必须拿到「轮次结束刷新 git」的回调，否则第一次点芯片看不到 diff",
  );
  assert.ok(
    /await repository\.status\(\)/.test(controller),
    "刷新要用 git API 的 repository.status()（本机 git 扩展实测有 async status()），而不是点击时执行 git.refresh",
  );
  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(
    /this\.scheduleFileKinds\(true\)/.test(adapter),
    "turn/end 必须带 refreshGit 调一次（先推 Git 重扫再分类），这是记号与 diff 状态都准的前提",
  );
  // ---------- fileKinds 必须在首帧快照里 ----------
  //
  // patch 侧有「没变化不重发」的去重（lastFileKindsJson）：页面重载 / 第二个窗口
  // 绑上同一会话时，重算出的表与缓存相同 → 那个 patch 永远不发，新窗口的
  // [新增] / 删除线就会一直是空的。所以表必须随 state 快照一起给（controller.ts
  // 的 stickyState 那一类约定）。
  assert.ok(
    /fileKindsState\(\): Record<string, FileChangeKind> \| undefined/.test(adapter),
    "适配器要暴露分类表给宿主快照用",
  );
  assert.ok(
    /fileKinds: scope\?\.adapter\?\.fileKindsState\(\)/.test(controller) ||
      /fileKinds: \(\) => adapter\?\.fileKindsState\(\)/.test(sessionViewModule),
    "首帧快照必须带上 fileKinds（重载 / 第二窗口否则永远拿不到记号）——取值处现在在" +
      "`dsh/sessionView.ts` 的 `sessionSourceOf`（快照与 patch 共用同一份来源）",
  );
  assert.ok(
    /kinds = paths\.length \? await classify\(paths\) : \{\}/.test(adapter),
    "没有芯片时也要下发空表：整表替换的语义要求「空」也是一次下发，否则界面留着旧表",
  );
  // ---------- 轮尾文件行只在轮次结束后显示 ----------
  //
  // 官方把这两行挂在 turn-tail 节点上，`publication` 只在 turn/end 时 immediate
  // （dsh-client-ui-chat/lib/client.js 的 turnTailDefinition）；数据在轮次进行中
  // 就累积，但节点不发布、行不渲染。轮次没完就画一行不断变长的文件名既与官方
  // 不一致，也让「本轮改了什么」看起来像已经定稿。
  const message = readFileSync(join(process.cwd(), "src", "webview", "components", "Message.tsx"), "utf8");
  assert.ok(
    /\{!message\.streaming && producedFiles\.length \? \(/.test(message),
    "「本轮文件改动」必须等轮次结束（streaming=false）再显示",
  );
  assert.ok(
    /\{!message\.streaming && deliverables\.length \? \(/.test(message),
    "「交付文件」同样只在轮次结束后显示（且已过 withoutVanished：净效果为零的不列）",
  );
  assert.ok(
    /@chipFileDeleted/.test(controller),
    "内容找不回的已删除文件要明确提示，不能静默",
  );
  // 解析不了会话 cwd 时以前只写日志 → 用户点了完全没反应。现在必须明确告知。
  assert.ok(
    /@chipPathUnresolved/.test(controller),
    "相对路径 + 拿不到会话工作目录时必须提示，不能静默什么都不做",
  );
  // 修饰键点击（=「直接打开文件」）撞上已删除的文件，以前会静默失败：那条分支
  // 绕过了删除提示。现在两种情况都先试改动对比、再明确告知。
  assert.ok(
    /} else if \(existence === "absent"\) \{/.test(controller),
    "修饰键点已删除芯片也要有反应（退化成看改动对比 / 提示），不能静默",
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
    fileChangeKind(tracked, TARGET, "present"),
    "edited",
    "在工作区改动清单里 = edited（git.openChange 能开对比窗口）",
  );
  assert.strictEqual(
    fileChangeKind(staged, TARGET, "present"),
    "edited",
    "暂存过的改动同样算 edited（SCM 里它也是「打开更改」）",
  );
  assert.strictEqual(
    fileChangeKind(untracked, TARGET, "present"),
    "new",
    "未跟踪 = new（模型新建，点开直接看文件，不开 diff）",
  );
  assert.strictEqual(
    fileChangeKind(undefined, TARGET, "present"),
    undefined,
    "拿不到 git 状态 → 不标记号（没有记号是「不确定」，不是「没改动」）",
  );
  assert.strictEqual(
    fileChangeKind({}, TARGET, "present"),
    undefined,
    "哪个清单都不在 → 不标记号（无改动 / 被 .gitignore / 不在仓库）",
  );
  assert.strictEqual(
    fileChangeKind(untracked, TARGET, "absent"),
    "deleted",
    "磁盘上没有了 → deleted 优先于未跟踪（先写后删的临时文件就该这么显示）",
  );
  assert.strictEqual(
    fileChangeKind(tracked, TARGET, "absent"),
    "deleted",
    "跟踪中的删除也是 deleted：点开对比窗口还能看到删除前的内容",
  );
  // ---------- 磁盘上没有 + git 完全不认识 = 净效果为零（gone） ----------
  //
  // 用户 2026-09-14 报的现场：让模型提交时它把提交信息写进 `commit.msg.txt`，
  // 提交完再删掉。文件进过 write 调用，于是永远留在轮尾的「本轮改动」里；磁盘上
  // 已经没有了、git 四张清单里也都没有它 —— 界面按 deleted 画一条带删除线的芯片，
  // 看着像仓库里挂着一个待提交的删除。实际上这一轮对它的净效果是零。
  assert.strictEqual(
    fileChangeKind({}, TARGET, "absent"),
    "gone",
    "磁盘上没有 + git 不认识 → gone（界面据此整条不渲染）",
  );
  assert.strictEqual(
    fileChangeKind(undefined, TARGET, "absent"),
    "gone",
    "拿不到 git 状态时同理：absent 是肯定证据（文件确实没了），而没有任何清单提到它",
  );
  assert.strictEqual(
    hasGitRecord({ untrackedChanges: [change(TARGET)] }, TARGET),
    true,
    "未跟踪清单里有它 → git 认识它（不能判成净效果为零）",
  );
  assert.strictEqual(hasGitRecord({}, TARGET), false, "四张清单都没有 → git 不认识");
  // ---------- 存在性「查不出来」不等于「已删除」 ----------
  //
  // stat 抛错的原因不止「文件不在」：权限不足、离线共享盘、路径含非法字符、
  // 虚拟文件系统都可能抛。旧写法把任何异常都当「不存在」→ 给无辜文件画删除线、
  // 点击还弹「内容找不回来了」。现在只有明确 FileNotFound 才算 absent。
  assert.strictEqual(
    fileChangeKind(tracked, TARGET, "unknown"),
    undefined,
    "存在性未知 → 不标记号（拿不到证据时不动），哪怕它在改动清单里",
  );
  assert.strictEqual(
    fileChangeKind(untracked, TARGET, "unknown"),
    undefined,
    "存在性未知 → 也不能标 [新增]：可能已经被删了，只是查不出来",
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

// ---------- 7a. [新增] 记号必须两种 git 配置下都出得来 ----------
//
// 用户报的现场：纯新增文件头上不标 [new]。根因是清单归属看配置
// （`git.untrackedChanges`），而旧代码只查 `untrackedChanges` 一张清单 ——
// 默认的 "mixed" 下那张清单**永远是空的**，新文件全在**工作区清单**里，
// 于是先被 `hasWorkingChange` 判成 edited、记号永远不出现。
//
// 唯一能把它和工作区里的普通改动分开的是 `Change.status`（公开 API）。
{
  const separate: GitChangeStateLike = { untrackedChanges: [change(TARGET)] };
  const mixed: GitChangeStateLike = {
    workingTreeChanges: [changeWithStatus(TARGET, UNTRACKED)],
  };
  assert.strictEqual(
    fileChangeKind(mixed, TARGET, "present"),
    "new",
    'mixed（默认配置）：新文件在工作区清单里、status = UNTRACKED(7) → 必须判 new（这条就是用户报的 bug）',
  );
  assert.strictEqual(
    fileChangeKind(separate, TARGET, "present"),
    "new",
    "separate：新文件在未跟踪清单里 → 同样判 new（两种配置行为一致）",
  );
  // 反向：工作区清单里**不是**未跟踪的，绝不能跟着标 [新增]
  assert.strictEqual(
    fileChangeKind({ workingTreeChanges: [changeWithStatus(TARGET, MODIFIED)] }, TARGET, "present"),
    "edited",
    "已跟踪但改过（status = MODIFIED(5)）仍然是 edited —— 标成 [新增] 会让每个改过的文件都戴上新文件帽子",
  );
  assert.strictEqual(
    fileChangeKind({ workingTreeChanges: [changeWithStatus(TARGET, IGNORED)] }, TARGET, "present"),
    "edited",
    "被 .gitignore 的文件在版本库里从来不存在，不是本轮新建：绝不标 [新增]",
  );
  assert.strictEqual(
    fileChangeKind({ workingTreeChanges: [change(TARGET)] }, TARGET, "present"),
    "edited",
    "拿不到 status（旧版本 / 结构变了）→ 按「不确定」处理：不标 [新增]，退化成原来的 edited",
  );
  // `git add` / `git add -N` 过的新文件**刻意**不算 new：它们点下去真开得出对比窗口
  // （索引里有位子，git 能拿空树当基线给 diff），标 [新增] 与点击行为自相矛盾。
  assert.strictEqual(
    fileChangeKind({ indexChanges: [changeWithStatus(TARGET, 1)] }, TARGET, "present"),
    "edited",
    "git add 过的（INDEX_ADDED）不算 new：SCM 里点它是「打开更改」，确实有 diff",
  );
  assert.strictEqual(
    fileChangeKind({ workingTreeChanges: [changeWithStatus(TARGET, 9)] }, TARGET, "present"),
    "edited",
    "git add -N 的（INTENT_TO_ADD）同理不算 new",
  );
  // status 命中但路径是别的文件：不能误伤
  assert.strictEqual(
    fileChangeKind(
      { workingTreeChanges: [changeWithStatus("D:\\dev\\app\\src\\config.tsx", UNTRACKED)] },
      TARGET,
      "present",
    ),
    undefined,
    "未跟踪判定同样按整段路径相等（相邻文件 config.tsx 不算）",
  );
  assert.strictEqual(
    isUntracked({ workingTreeChanges: [changeWithStatus(TARGET, UNTRACKED)] }, "d:/dev/app/src/config.ts"),
    true,
    "mixed 口径与路径写法变体一起生效（分隔符 / 大小写不敏感）",
  );
  assert.strictEqual(
    isUntracked({ workingTreeChanges: [changeWithStatus(TARGET, UNTRACKED)] }, TARGET),
    true,
    "mixed 口径：工作区清单 + status 7 = 未跟踪",
  );
  // 数值本身就是判据：源码里的常量必须是实测的 7（写成别的值会让这条链路整体失效，
  // 且症状只是「记号不见了」——不报错、不崩，最容易被漏掉）
  const fileChangeSource = readFileSync(join(process.cwd(), "src", "dsh", "fileChange.ts"), "utf8");
  assert.ok(
    /const STATUS_UNTRACKED = 7;/.test(fileChangeSource),
    "STATUS_UNTRACKED 必须是 git 扩展 Status.UNTRACKED 的实测值 7（写成别的值 → 默认配置下 [新增] 永远不出现）",
  );
}
console.log("fileChange: [新增] 记号两种配置下都出得来（mixed / separate）✓");

// ---------- 7b. stat 错误的判读：只认 FileNotFound ----------
//
// `code` 的取值是本机 VS Code 实测出来的：`FileSystemError` 的构造函数是
// `this.code = n?.name ?? "Unknown"`，`n` 是静态工厂本身，所以 code 正好是
// 方法名（`FileNotFound` / `NoPermissions` / `Unavailable`），**不是**
// `FileSystemError.FileNotFound`，也不是内部那个 `EntryNotFound`。@types/vscode
// 只说「names of errors, like FileNotFound」——光看契约会写成前者，判据就永远
// 不成立、deleted 记号永远不会出现。这条断言把实测值钉住。
{
  assert.strictEqual(isNotFoundError({ code: "FileNotFound" }), true, "明确报找不到 = absent");
  assert.strictEqual(isNotFoundError({ code: "NoPermissions" }), false, "权限问题是 unknown");
  assert.strictEqual(isNotFoundError({ code: "Unavailable" }), false, "盘不可用是 unknown");
  assert.strictEqual(isNotFoundError({ code: "Unknown" }), false, "未指明的错误是 unknown");
  assert.strictEqual(
    isNotFoundError({ code: "FileSystemError.FileNotFound" }),
    false,
    "带前缀的写法不是本机实测值（写成它会永远判不出 absent）",
  );
  assert.strictEqual(isNotFoundError(new Error("ENOENT")), false, "普通 Error 没有 code");
  assert.strictEqual(isNotFoundError(undefined), false, "连错误对象都没有 → 不猜");
}
console.log("fileChange: stat 错误判读（只认 FileNotFound）✓");

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
