/**
 * 工作区窗口状态缓存（`dsh/windowState.ts`）的语义断言。
 *
 * 这个功能的价值全在「下次打开工作区时各自接回原来的会话」上，而它横跨
 * 两次进程：**这一次写盘**、**下一次读回来**。所以测试重点不是「函数返回值」，
 * 而是**跨重启的往返**——写进去的形状，下一次能不能读成同样的语义：
 *
 *   1. 缓存键按工作区分份（不同文件夹不能共用，写法差异必须归一）；
 *   2. 坏数据逐条丢弃（磁盘上的旧值可能是别的版本/手改过的）；
 *   3. **`null` vs `undefined`**：Memento 走 JSON，`undefined` 值的键会被整个
 *      丢掉——「这个窗口当时是空态」必须显式写 `null` 才留得住（同
 *      `shared/wire.ts` 的坑，漏掉的症状是「清空指令静默失效」）；
 *   4. `WindowRestore` 的对位：侧栏按固定槽位、编辑区面板**按顺序**认领；
 *   5. `WorkspaceWindowStateStore` 的防抖与 `dispose()` 的收尾刷盘——
 *      关窗那一刻那一次写基本就是下次启动要用的那份，防抖没到点也必须落盘。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isBlank,
  mergeWindowCache,
  parseWindowCache,
  serializeWindowCache,
  trimCache,
  windowCacheKey,
  WindowRestore,
  WorkspaceWindowStateStore,
  type WindowCache,
  type WindowStateStorage,
} from "../src/dsh/windowState";

/** 内存版 Memento：`update` 也走一遍 JSON，模拟 state.vscdb 的真实行为。 */
class FakeStorage implements WindowStateStorage {
  readonly values = new Map<string, unknown>();
  writes = 0;

  constructor(seed?: Record<string, unknown>) {
    for (const [key, value] of Object.entries(seed ?? {})) this.values.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.writes += 1;
    // 真实落盘就是 JSON：undefined 的键在这里会被丢掉，测试要能抓到这一点
    this.values.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    return Promise.resolve();
  }
}

const KEY = windowCacheKey(["D:\\dev\\proj"])!;

function cacheOf(value: unknown): WindowCache {
  const record: Record<string, unknown> = { version: 1, ...(value as Record<string, unknown>) };
  return parseWindowCache(record).cache;
}

// ---------- 1. 缓存键：按工作区分份 + 路径写法归一 ----------

{
  const a = windowCacheKey(["D:\\dev\\proj"]);
  const b = windowCacheKey(["d:/dev/proj/"]);
  const c = windowCacheKey(["D:\\dev\\other"]);
  assert.ok(a && b && c, "有文件夹就必须有键");
  assert.strictEqual(a, b, "同一目录的不同写法（盘符大小写/斜杠/尾斜杠）必须归一成同一个键");
  assert.notStrictEqual(a, c, "不同文件夹不能共用一份缓存");
  // 多根工作区：根的书写顺序不同仍是同一个工作区
  assert.strictEqual(
    windowCacheKey(["D:\\dev\\a", "D:\\dev\\b"]),
    windowCacheKey(["d:/dev/b", "d:/dev/a"]),
    "多根工作区与根的顺序无关",
  );
  assert.strictEqual(windowCacheKey([]), undefined, "没有打开文件夹时不缓存（没有工作区身份可言）");
  assert.strictEqual(windowCacheKey(["   "]), undefined, "空白路径不算文件夹");
}
console.log("windowState: 缓存键按工作区分份 ✓");

// ---------- 2. 坏数据逐条丢弃，不整份丢 ----------

{
  const parsed = parseWindowCache({
    version: 1,
    primary: { sessionId: "s1" },
    secondary: { sessionId: 42 }, // 形状不对：只该丢这一条
    panels: [{ sessionId: "s2" }, null, { sessionId: "" }, "x", { sessionId: "s3" }],
    activeOrder: ["v1", 7, "v2", ""],
  });
  assert.strictEqual(parsed.cache.primary?.sessionId, "s1", "好的记录必须留下");
  assert.strictEqual(parsed.cache.secondary, undefined, "形状不对的槽位丢弃");
  assert.deepStrictEqual(
    parsed.cache.panels.map((panel) => panel.sessionId),
    ["s2", null, "s3"],
    "面板坏记录逐条丢：null 是合法空态、空串折成空态，数字与字符串整条丢",
  );
  assert.strictEqual(parsed.dropped, 3, "丢弃条数要能报出来（日志里靠它说明「怎么没恢复」）");
  assert.deepStrictEqual(parsed.cache.activeOrder, ["v1", "v2"], "活动顺序里非字符串丢弃");
}
console.log("windowState: 坏数据逐条丢弃 ✓");

// 版本不认识（含「从没写过」）→ 当空缓存，而不是把旧形状读成新语义
{
  assert.deepStrictEqual(parseWindowCache(undefined).cache, { panels: [], activeOrder: [] });
  assert.deepStrictEqual(parseWindowCache({ version: 99, primary: { sessionId: "s1" } }).cache, {
    panels: [],
    activeOrder: [],
  });
  assert.deepStrictEqual(parseWindowCache("不是我写的").cache, { panels: [], activeOrder: [] });
}
console.log("windowState: 版本/形状不认识时给空缓存 ✓");

// ---------- 3. null vs undefined：跨 JSON 往返不能丢语义 ----------

{
  const cache: WindowCache = {
    primary: { sessionId: null },
    secondary: { sessionId: "s2" },
    panels: [{ sessionId: null }, { sessionId: "s3" }],
    activeOrder: ["v2", "v1"],
  };
  const wire = JSON.parse(JSON.stringify(serializeWindowCache(cache))) as unknown;
  const back = parseWindowCache(wire).cache;
  assert.strictEqual(back.primary?.sessionId, null, "空态必须留得住（写成 undefined 会被 JSON 丢掉键）");
  assert.strictEqual(back.secondary?.sessionId, "s2");
  assert.deepStrictEqual(
    back.panels.map((panel) => panel.sessionId),
    [null, "s3"],
  );
  assert.deepStrictEqual(back.activeOrder, ["v2", "v1"]);
  assert.ok(isBlank(back.primary) && isBlank(back.panels[0]), "空态判定的口径一致");
  assert.ok(!isBlank(back.secondary), "有会话的不是空态");
}
console.log("windowState: 空态过 JSON 不丢（null 而不是 undefined） ✓");

// ---------- 4. WindowRestore：侧栏按槽位、面板按顺序 ----------

{
  const logs: string[] = [];
  const restore = new WindowRestore(
    cacheOf({
      primary: { sessionId: "sidebar-main" },
      secondary: { sessionId: null },
      panels: [{ sessionId: "p1" }, { sessionId: null }, { sessionId: "p3" }],
    }),
    (line) => logs.push(line),
  );
  // 子代理地址随槽位一起回来（恢复路径只有它能重新进入子代理会话）
  assert.deepStrictEqual(restore.slot("primary"), { sessionId: "sidebar-main" });
  assert.strictEqual(restore.slot("secondary"), undefined, "缓存里是空态的槽位不接会话");
  // 面板按恢复顺序对位：第 2 个面板当初就是空态，不能被顶成 p3
  assert.strictEqual(restore.claimPanel()?.sessionId, "p1");
  assert.strictEqual(restore.claimPanel(), undefined);
  assert.strictEqual(restore.claimPanel()?.sessionId, "p3");
  const logsAfterLastClaim = logs.length;
  assert.ok(
    logs.some((line) => line.includes("编辑区面板认领完毕：3 个")),
    "认领完最后一个面板时要留下一行可核对的日志（窗口数对不上时唯一线索）",
  );
  assert.strictEqual(restore.claimPanel(), undefined, "缓存用完了：多出来的面板保持空态");
  assert.strictEqual(logs.length, logsAfterLastClaim, "日志只打一行，不应把输出通道刷屏");
}
console.log("windowState: 恢复期的槽位与顺序对位 ✓");

// ---------- 4a. 面板按**身份**认领（webview 存下来的会话 id） ----------
//
// 用户 2026-09-21 报：重载后两个标签的会话交叉了。根因是恢复**只用顺序**——
// `activeOrder` 记的是创建顺序，而 VS Code 复用的是上次的编辑器排布，两者不保证
// 一致。现在 webview 把当前会话 id 存进 `setState`，序列化器读回来按身份认领。
{
  const cache = cacheOf({
    panels: [{ sessionId: "A" }, { sessionId: "B" }],
  });
  // 第二个面板先来（VS Code 的恢复顺序与当初相反）：按身份仍然各就各位
  const restore = new WindowRestore(cache);
  assert.deepStrictEqual(
    restore.classifyPanel({ sessionId: "B" }),
    { sessionId: "B", by: "identity" },
    "第二个面板按身份认回 B，而不是被顺序认领成 A",
  );
  assert.deepStrictEqual(restore.classifyPanel({ sessionId: "A" }), { sessionId: "A", by: "identity" });
  assert.strictEqual(restore.pending, false, "两条都认领完了：恢复窗口结束");
  assert.ok(restore.panelClaimed(0) && restore.panelClaimed(1), "按身份认领同样算「已认领」");
}
// 身份缺失 / 对不上 / 撞车：退回按下标认领（能救一条是一条）
{
  // 没存过（旧版本写的面板）：按下标
  const legacy = new WindowRestore(cacheOf({ panels: [{ sessionId: "A" }, { sessionId: "B" }] }));
  assert.deepStrictEqual(legacy.classifyPanel(undefined), { sessionId: "A", by: "cursor" });
  assert.deepStrictEqual(legacy.classifyPanel(undefined), { sessionId: "B", by: "cursor" });

  // 存的会话不在缓存里（用户手工调过状态）：退回下标，不错认
  const stale = new WindowRestore(cacheOf({ panels: [{ sessionId: "A" }, { sessionId: "B" }] }));
  assert.deepStrictEqual(
    stale.classifyPanel({ sessionId: "已被删掉的会话" }),
    { sessionId: "A", by: "cursor" },
    "身份对不上缓存时按顺序接，而不是把窗口留成空态",
  );

  // 两个面板存了同一个会话（同一会话被两个窗口打开过）：都用一次，不重复认领
  const dup = new WindowRestore(cacheOf({ panels: [{ sessionId: "A" }, { sessionId: "A" }] }));
  assert.deepStrictEqual(dup.classifyPanel({ sessionId: "A" }), { sessionId: "A", by: "identity" });
  assert.deepStrictEqual(
    dup.classifyPanel({ sessionId: "A" }),
    { sessionId: "A", by: "identity" },
    "缓存里有两条 A 时第二个窗口也认 A（两边本来就开着同一条会话）",
  );
  assert.strictEqual(dup.pending, false);

  // 跳着认领之后的顺序认领不会重复吃掉同一条
  const mixed = new WindowRestore(
    cacheOf({ panels: [{ sessionId: "A" }, { sessionId: "B" }, { sessionId: "C" }] }),
  );
  assert.deepStrictEqual(mixed.classifyPanel({ sessionId: "C" }), { sessionId: "C", by: "identity" });
  assert.deepStrictEqual(mixed.classifyPanel(undefined), { sessionId: "A", by: "cursor" });
  assert.deepStrictEqual(mixed.classifyPanel(undefined), { sessionId: "B", by: "cursor" });
  assert.deepStrictEqual(
    mixed.classifyPanel(undefined),
    { sessionId: undefined, by: "cursor" },
    "缓存用完了：多出来的面板保持空态",
  );
}
console.log("windowState: 面板按身份认领（退回顺序）✓");

// ---------- 4b. 「恢复还没完」的判据：不能拿内存里的窗口覆写缓存 ----------
//
// 契约（vscode.d.ts 的 WebviewPanelSerializer）：webview 重启后**第一次变为可见**
// 时才回调序列化器——用户没点到的面板标签页可能过很久才认领。所以恢复期结束的
// 判据是「槽位都问过了」，而不是某个超时；在它结束前按内存里的窗口覆写缓存，
// 会把还没露面的面板连同它们的会话一起抹掉。
{
  const cache = cacheOf({
    primary: { sessionId: "sidebar-main" },
    panels: [{ sessionId: "p1" }, { sessionId: "p2" }],
  });
  const restore = new WindowRestore(cache);
  assert.ok(restore.pending, "缓存里还有窗口时恢复未结束");
  assert.strictEqual(restore.remaining, 3, "两个面板 + 一个侧栏槽位");

  assert.strictEqual(restore.slot("primary")?.sessionId, "sidebar-main");
  assert.strictEqual(restore.remaining, 2, "侧栏问过话就不再计入");

  assert.strictEqual(restore.claimPanel()?.sessionId, "p1");
  assert.ok(restore.pending, "还有一个面板没露面：恢复未结束（此时写缓存会抹掉它的会话）");
  assert.strictEqual(restore.remaining, 1);
  // 关键：另一个面板还没认领时，缓存里那条记录必须还在（否则它的会话永久失联）
  assert.deepStrictEqual(
    restore.value.panels.map((panel) => panel.sessionId),
    ["p1", "p2"],
  );

  assert.strictEqual(restore.claimPanel()?.sessionId, "p2");
  assert.strictEqual(restore.pending, false, "槽位都问过了：恢复窗口结束");
  assert.strictEqual(restore.remaining, 0);
}
// 缓存里本来就没有窗口：不该白等（否则缓存永远不更新）
{
  const restore = new WindowRestore(cacheOf({}));
  assert.strictEqual(restore.pending, false);
  assert.strictEqual(restore.remaining, 0);
}
// 只有空态记录：仍要等它来认领（空态也是「上次开着这个窗口」）
{
  const restore = new WindowRestore(cacheOf({ panels: [{ sessionId: null }] }));
  assert.ok(restore.pending);
  assert.strictEqual(restore.claimPanel(), undefined);
  assert.strictEqual(restore.pending, false);
}
console.log("windowState: 恢复窗口的结束判据 ✓");

// ---------- 4c. 写缓存的合并规则：已认领的用内存、未认领的按原位保留 ----------
//
// 用户 2026-09-15 报的：编辑区窗口从会话 A 切到 B，重启后打开的还是 A。
// 根因是恢复期内**整个不写**（旧实现只记「待写」标记，等最后一个窗口认领），
// 而 `pending` 可能永远为真（侧栏容器折叠着 → 它的视图这一代不会被实例化），
// 于是这一轮的变更加起来一次都没落盘，缓存停在启动时那份旧值上。
{
  const previous = cacheOf({
    primary: { sessionId: "sidebar-old" },
    secondary: { sessionId: "sidebar-2" },
    panels: [{ sessionId: "A" }, { sessionId: "B" }],
  });
  const memory: WindowCache = {
    panels: [{ sessionId: "B-final", lastActiveAt: 1 }],
    primary: { sessionId: "B-final" },
    activeOrder: ["v1"],
  };

  // 恢复未完：第一个面板已认领（内存里是切过会话之后的最终值），第二个还没露面
  const merged = mergeWindowCache({
    memory,
    previous,
    panelClaimed: (index) => index === 0,
    restorePending: true,
    slotClaimed: (slot) => slot === "primary",
  });
  assert.deepStrictEqual(
    merged.panels.map((panel) => panel.sessionId),
    ["B-final", "B"],
    "已认领的面板写最终会话；还没认领的按**原位**留在它那一格（顺序就是恢复对位）",
  );
  assert.strictEqual(merged.primary?.sessionId, "B-final", "问过话的侧栏槽位以内存为准");
  assert.deepStrictEqual(
    merged.secondary,
    { sessionId: "sidebar-2" },
    "这一代没露面的侧栏槽位保留旧值（否则它的会话永久失联）",
  );

  // 恢复结束（或本来就没有待认领的窗口）：旧的残留一律丢掉
  const settled = mergeWindowCache({
    memory,
    previous,
    panelClaimed: () => true,
    restorePending: false,
    slotClaimed: () => false,
  });
  assert.deepStrictEqual(settled.panels.map((panel) => panel.sessionId), ["B-final"]);
  assert.strictEqual(settled.secondary, undefined, "恢复结束后不再保留未认领的旧槽位");

  // 用户在恢复窗口里新开了一个面板：内存里比认领数多，不能再补旧的（会重复/错位）
  const extra = mergeWindowCache({
    memory: { panels: [{ sessionId: "new" }, { sessionId: "B-final" }], activeOrder: [] },
    previous,
    panelClaimed: (index) => index === 0,
    restorePending: true,
    slotClaimed: () => true,
  });
  assert.deepStrictEqual(
    extra.panels.map((panel) => panel.sessionId),
    ["new", "B-final"],
    "内存里的面板已经超过认领数时，后面的旧条目让位给新面板",
  );

  // 已认领的槽位即使内存里是空态（null）也照写：那是「用户把它清空了」
  const cleared = mergeWindowCache({
    memory: { panels: [], primary: { sessionId: null }, activeOrder: [] },
    previous,
    panelClaimed: () => false,
    restorePending: true,
    slotClaimed: (slot) => slot === "primary",
  });
  assert.deepStrictEqual(cleared.primary, { sessionId: null }, "空态（null）是明确状态，不能被旧值盖回");
  // **按身份认领时下标是跳着的**（第 2 个面板先露面）：拿「认领了几条」当游标的话，
  // 会把还没露面的第 1 条也算成已认领而丢掉它的会话
  const byIdentity = mergeWindowCache({
    memory: { panels: [{ sessionId: "B-final" }], activeOrder: [] },
    previous,
    panelClaimed: (index) => index === 1,
    restorePending: true,
    slotClaimed: () => true,
  });
  assert.deepStrictEqual(
    byIdentity.panels.map((panel) => panel.sessionId),
    ["B-final", "A"],
    "内存里补上认领到的那条，**没认领的那条按原位**接在后面（按条问，不拿总数切）",
  );
}
console.log("windowState: 写缓存的合并规则（最终会话一定落盘）✓");

// ---------- 4d. 结构不变量：控制器必须按这套规则写，不再「整个恢复期不写」 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /mergeWindowCache\(\{/.test(controller),
    "persistWindowState 必须走 mergeWindowCache（纯函数、带断言）",
  );
  assert.ok(
    !/restoreWritePending/.test(controller),
    "不能再回到「恢复期只记待写、等最后一个窗口认领再落盘」——pending 可能永远为真，" +
      "那样缓存会停在初始会话上（用户 2026-09-15 报的就是这个）",
  );
  assert.ok(
    /if \(!this\.windowState\.key\) this\.ensureWindowState\(\);/.test(controller),
    "写缓存前要惰性绑一次工作区身份：只用编辑区面板、从没有侧栏被实例化时，" +
      "键不绑就一个字节都写不出去",
  );
  // 面板那一段必须**按条问**（按身份认领时下标是跳着的，拿认领总数当游标会丢会话）
  assert.ok(
    /panelClaimed: \(index\) => this\.windowRestore\.panelClaimed\(index\)/.test(controller),
    "persistWindowState 要把「某个下标认领过没有」交给 mergeWindowCache（按条问）",
  );
  // 认领必须是**按身份优先**：只按顺序对位就是用户 2026-09-21 报的标签交叉
  assert.ok(
    /classifyPanel\(known\)/.test(controller) &&
      /deserializeWebviewPanel: \(panel: vscode\.WebviewPanel, state: unknown\)/.test(
        readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8"),
      ),
    "面板认领要走 classifyPanel（webview 存的身份优先，顺序兜底）",
  );
}
console.log("windowState: 控制器接线（惰性绑键 + 合并写）✓");

// ---------- 4e. 结构不变量：ready 的首帧快照必须先于接回会话 ----------
//
// 接回会话（resumeRestoreHint → restoreViewSession）要先 ensureConnected，
// 整个自动连接期间它不结算；首帧快照（locale/字号都在里面）若排在它后面，
// 界面就要在词典缺省（英文）下过完整个连接期，直到连接结算才翻成中文
// （用户报的「启动总是先英文」）。快照先行后，接回绑上时 openSession 会
// 再推一份带会话内容的完整快照，内容回填不受影响。
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const readyCase = controller.slice(
    controller.indexOf('case "ready":'),
    controller.indexOf('case "send":'),
  );
  assert.ok(
    readyCase.includes("this.snapshotFor(viewId)") && readyCase.includes("resumeRestoreHint(viewId)"),
    "ready 分支必须既发首帧快照、又接回会话（少一件都是功能丢了）",
  );
  assert.ok(
    readyCase.indexOf("snapshotFor(viewId)") < readyCase.indexOf("resumeRestoreHint(viewId)"),
    "ready 的首帧快照必须先于 resumeRestoreHint 发出——接回要先连接，排在后面会把语言等首帧设置拖到连接结算之后",
  );
}
console.log("windowState: ready 首帧快照先于接回（语言不等待连接）✓");

// ---------- 5. Store：跨「两次进程」往返 + 防抖 + dispose 刷盘 ----------

{
  const storage = new FakeStorage();
  // 第一次会话：主侧栏接了 s1、两个面板
  const first = new WorkspaceWindowStateStore({
    storage,
    folders: ["D:\\dev\\proj"],
    debounceMs: 5,
  });
  assert.strictEqual(first.key, KEY);
  first.load({ panels: [{ sessionId: "p1" }, { sessionId: "p2" }], activeOrder: ["v1"] });
  assert.strictEqual(storage.writes, 0, "markDirty 之前不该写盘");
  first.markDirty();
  first.markDirty();
  first.markDirty();
  assert.strictEqual(storage.writes, 0, "防抖窗口内多次变更只合并成一次写");
  first.dispose(); // 停用：必须立刻刷盘，等不到防抖到点
  assert.strictEqual(storage.writes, 1, "dispose 要把待写的状态刷下去（关窗那次写就是下次启动用的）");
  first.dispose();
  assert.strictEqual(storage.writes, 1, "重复 dispose 是幂等的");

  // 第二次会话（模拟重开工作区）：新进程只从存储里读
  const second = new WorkspaceWindowStateStore({ storage, folders: ["d:/dev/proj/"] });
  assert.strictEqual(second.key, KEY, "路径写法不同也必须命中同一份缓存");
  const restored = new WindowRestore(second.snapshot());
  assert.strictEqual(restored.claimPanel()?.sessionId, "p1");
  assert.strictEqual(restored.claimPanel()?.sessionId, "p2");
  assert.strictEqual(restored.claimPanel(), undefined);
}
console.log("windowState: 跨重启往返（写盘 → 重开读回） ✓");

// 没有工作区时不写盘：不该出现「没有工作区身份」的缓存键
{
  const storage = new FakeStorage();
  const store = new WorkspaceWindowStateStore({ storage, folders: [] });
  assert.strictEqual(store.key, undefined);
  store.markDirty();
  store.dispose();
  assert.strictEqual(storage.writes, 0, "无工作区时一个字节都不该写");
}
console.log("windowState: 无工作区时不写入 ✓");

// 身份晚到：面板恢复可能正是扩展被激活的原因，那一刻 workspaceFolders 还没就绪，
// 所以缓存键要能**事后再绑**（绑上时重新读一次磁盘上的缓存）
{
  const seed = new FakeStorage();
  const earlier = new WorkspaceWindowStateStore({ storage: seed, folders: ["D:\\dev\\proj"] });
  earlier.load({ panels: [{ sessionId: "p1" }], activeOrder: [] });
  earlier.markDirty();
  earlier.dispose();

  const store = new WorkspaceWindowStateStore({ storage: seed }); // 此刻还不知道工作区
  assert.strictEqual(store.key, undefined);
  assert.deepStrictEqual(store.snapshot().panels, [], "还没绑键时只能是空缓存");
  const cache = store.bindFolders(["D:/dev/proj/"]);
  assert.strictEqual(store.key, KEY, "绑上工作区身份后才有键（写法差异仍归一）");
  assert.strictEqual(cache.panels[0]?.sessionId, "p1", "绑定时必须重新读一次缓存，而不是继续用空的");
  // 幂等：已经绑过就不重读（否则会把运行期写进去的最新状态覆盖回磁盘上的旧值）
  store.load({ panels: [{ sessionId: "p2" }], activeOrder: [] });
  assert.deepStrictEqual(
    store.bindFolders(["D:\\dev\\other"]).panels.map((panel) => panel.sessionId),
    ["p2"],
  );
  assert.strictEqual(store.key, KEY, "已经绑过的键不因再次调用而改变");
}
console.log("windowState: 工作区身份晚到（事后绑键）✓");

// 上限裁剪：手改过状态文件也不能塞进一个巨大数组
{
  const panels = Array.from({ length: 200 }, (_value, index) => ({ sessionId: `p${index}` }));
  const trimmed = trimCache({ panels, activeOrder: [] });
  assert.strictEqual(trimmed.panels.length, 64);
  assert.strictEqual(trimmed.panels[63].sessionId, "p199", "保留的是最近的那一批");
}
console.log("windowState: 缓存条数上限 ✓");

console.log("\nwindowState: all assertions passed");
