/**
 * `@` 候选的**两条帧**：文件那一半先到先渲染，对话那一半各自结算。
 *
 * 报障现场（用户 2026-09-25 报的「@ 列表切换目录感觉慢」）：两个候选源在服务端的
 * 成本差三个数量级——文件那一半是一次 `readdir`，对话那一半要扫**全部**会话日志
 * （`sessionReferenceResolver/candidates` → `sessionQuery.listSessions` → 逐个会话
 * stat + 读头部）。此前宿主用 `Promise.all` 合成一条帧，于是「切进一个只有几个
 * 文件的目录」也要等那趟全语料扫描。本机实测（`.agent/temp` 的复刻脚本，
 * 339 条会话）：会话源 130ms 以上、目录 readdir 0.1ms。
 *
 * 这一组断言钉三件事：
 *
 * 1. **界面侧的合并**（第 1 节，驱动真 reducer）：`files/list` 只换文件那一半、
 *    对话候选留在屏上（官方的 stale-while-revalidate）；`files/sessions` 只在
 *    `query` 与当前列表同属一次查询时才收，旧批次丢掉（否则混出「文件是这一层的、
 *    对话是上一层筛出来的」）。
 * 2. **宿主侧的发射**（第 2 节，函数体级判据）：两个源各自发帧、文件那帧永远先发、
 *    每次查询作废上一次、窗口下线时作废并清表。
 * 3. **界面侧只有一个重取点**（第 3 节）：导航（下钻 / 回上一层）不再自己发一遍
 *    （那会让服务端那趟扫描翻倍、先后无保证），命令目录也不再跟着每次敲字重取。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRefView, SessionRefView } from "../src/shared/chat";
import type { Action } from "../src/webview/state";
import { initialState, reducer } from "../src/webview/state";

// `composerCompletion` 连带 `bridge.ts` 在**模块求值期**就挂 `window.addEventListener`
// （webview 里那是真实存在的宿主），无头环境先补一个最小 window 再动态 import 它——
// 同 `scripts/mentionNav.test.ts` 的手法（静态 import 会被提升到补桩之前）。
(globalThis as { window?: unknown; acquireVsCodeApi?: unknown }).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
};
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: () => undefined,
});

const FILE_A: FileRefView = { path: "src/a.ts", kind: "file" };
const FILE_B: FileRefView = { path: "src/webview/", kind: "directory" };
const SESSION_1: SessionRefView = {
  sessionId: "s1",
  label: "上一个会话",
  mention: "@[上一个会话](dsh-session:s1)",
};
const SESSION_2: SessionRefView = {
  sessionId: "s2",
  label: "另一个会话",
  mention: "@[另一个会话](dsh-session:s2)",
};

const apply = (state: typeof initialState, ...actions: Action[]): typeof initialState =>
  actions.reduce((acc, action) => reducer(acc, action), state);

// ---------- 1. 两条帧的合并语义 ----------
{
  // 第一次打开 `@`：文件那一帧先到（对话候选还在路上）
  const filesOnly = apply(initialState, {
    type: "files/list",
    query: "",
    items: [FILE_A],
  });
  assert.deepStrictEqual(filesOnly.fileRefs.items, [FILE_A], "`files/list` 装文件那一半");
  assert.deepStrictEqual(filesOnly.fileRefs.sessions, [], "对话候选还没到（此前是空）");
  assert.strictEqual(filesOnly.fileRefs.query, "", "`files/list` 同时记下这是哪一次查询");

  const withSessions = apply(filesOnly, {
    type: "files/sessions",
    query: "",
    sessions: [SESSION_1],
  });
  assert.deepStrictEqual(withSessions.fileRefs.sessions, [SESSION_1], "同一次查询的对话候选收下");
  assert.deepStrictEqual(withSessions.fileRefs.items, [FILE_A], "收对话候选不影响文件那一半");

  // 下钻：文件那一帧先到——对话候选还是**上一次查询**那一批，先留在屏上
  // （官方 menuReduce 的 stale-while-revalidate：新一代替换之前旧条目继续渲染）
  const drilled = apply(withSessions, { type: "files/list", query: "src/", items: [FILE_B] });
  assert.deepStrictEqual(drilled.fileRefs.items, [FILE_B], "新查询的文件候选立刻换上去");
  assert.strictEqual(drilled.fileRefs.query, "src/", "记下新的查询串");
  assert.deepStrictEqual(
    drilled.fileRefs.sessions,
    [SESSION_1],
    "对话候选留着不闪：它慢，等它自己那一帧回来才换（清掉会让列表先塌一块再长回来）",
  );

  // 对话候选那一帧回来：带上它属于哪一次查询
  const settled = apply(drilled, {
    type: "files/sessions",
    query: "src/",
    sessions: [SESSION_2],
  });
  assert.deepStrictEqual(settled.fileRefs.sessions, [SESSION_2], "同一次查询的对话候选整批替换");
  assert.deepStrictEqual(settled.fileRefs.items, [FILE_B], "文件那一半不动");

  // 旧批次晚到（敲字快时后到的回答）：`query` 对不上 → **整帧丢掉**
  const stale = apply(settled, {
    type: "files/sessions",
    query: "src/web", // 界面已经在别的查询上了
    sessions: [SESSION_1],
  });
  assert.strictEqual(stale, settled, "属于别的查询的对话候选整帧丢掉（同一引用 = 不触发重渲染）");
  assert.deepStrictEqual(stale.fileRefs.sessions, [SESSION_2], "屏上仍是当前查询那一批");
}
console.log("mentionCandidates: 两条帧的合并语义（文件先到 / 对话候选 stale-while-revalidate） ✓");

// ---------- 1b. 对话候选只在工作区根目录列（用户 2026-09-25 口径） ----------
//
// 现场：下钻之后先看到「文件 + 对话」两组，过一会儿对话那一组才消失——因为显示与否
// 只取决于宿主发没发那批帧，而帧要等一个往返。修法是把判据放到**渲染**这一层
// （`rankCandidates`）：下钻是同步改正文的，查询串一变就只剩文件与 `..`。
{
  const { rankCandidates } = await import("../src/webview/composerCompletion");
  const files: FileRefView[] = [{ path: "src/a.ts", kind: "file" }];
  const sessions: SessionRefView[] = [SESSION_1];
  assert.deepStrictEqual(
    rankCandidates({ kind: "mention", start: 0, query: "" }, [], files, sessions).map((c) =>
      "sessionId" in c ? "session" : (c as FileRefView).path,
    ),
    ["src/a.ts", "session"],
    "工作区根目录（查询串里没有分隔符）照常列对话候选",
  );
  for (const query of ["src/", "src/webview/", "src\\webview\\", "src/we"]) {
    const ranked = rankCandidates({ kind: "mention", start: 0, query }, [], files, sessions);
    assert.deepStrictEqual(
      ranked.filter((c) => "sessionId" in c),
      [],
      `查询 "${query}" 已经进了目录：对话候选一个都不许出现（同步判掉，不是先渲染再消失）`,
    );
  }
}
console.log("mentionCandidates: 对话候选只在工作区根目录列（渲染层判据） ✓");

// ---------- 2. 宿主侧：两个源各自发帧 + 每次查询作废上一次 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const start = controller.indexOf("private async queryFiles(");
  assert.ok(start > 0, "取不到 queryFiles");
  const rest = controller.slice(start + "private async queryFiles(".length);
  const end = rest.search(/\n  \/\*\*|\n  (?:private|public|protected|async|readonly|get|set) /);
  const body = end < 0 ? rest : rest.slice(0, end);

  for (const type of ["files/list", "files/sessions"]) {
    assert.ok(body.includes(`type: "${type}"`), `queryFiles 要发 \`${type}\` 帧`);
  }
  assert.ok(
    /this\.emitToView\(viewId, \{ type: "files\/list", query, items: items \?\? \[\] \}\)/.test(body),
    "文件那一帧必须带上这次查询的 query（界面靠它认「这是哪一次查询」）",
  );
  assert.ok(
    !/Promise\.all\(\[\s*this\.client/.test(body),
    "不许再把两个源 `Promise.all` 成一条帧——对话候选会把文件列表一起拖住（本次修复的现场）",
  );
  assert.ok(
    /filesFrame\.then\(\(\) => sessions\)/.test(body),
    "对话候选那一帧排在文件帧之后发（只串发帧顺序，两个 RPC 仍并行）",
  );
  assert.ok(
    /this\.menuQueries\.get\(viewId\)\?\.abort\(\);/.test(body) &&
      /isCurrentMenuQuery\(viewId, controller\)/.test(body),
    "每次查询先作废上一次，并且发帧前都要过「还是不是当前那一次」这一关",
  );
  assert.ok(
    /const controller = new AbortController\(\);\s*\n\s*this\.menuQueries\.set\(viewId, controller\);/.test(
      body,
    ),
    "句柄要存进 menuQueries（它同时是作废入口与身份判据）",
  );
  // 对话候选只在根目录列：进了目录连查都不查（那趟是全语料扫描，查了也只能丢掉）。
  // 判据在两处同源：宿主这里不查、界面 `rankCandidates` 不渲染（第 1b 节）。
  assert.ok(
    /const wantsSessions = !isDirectoryQuery\(query\);/.test(body) &&
      /const sessions = !wantsSessions\s*\n?\s*\? undefined/.test(body),
    "进了目录就不发对话候选那次 RPC（`sessions` 直接是 undefined）",
  );
  assert.ok(
    /if \(wantsSessions\) this\.emitToView\(viewId, \{ type: "files\/sessions", query, sessions: \[\] \}\)/.test(
      body,
    ),
    "没有会话可查时也只在那一次查询该列对话候选时才发空帧",
  );
  // 作废导致的失败是正常结果：两个 catch 都要先看 signal 再写日志
  // （否则敲字快时日志会被刷爆，而那不是故障）
  const logged = (body.match(/this\.log\(`\[files\]/g) ?? []).length;
  const guarded = (body.match(/if \(!controller\.signal\.aborted\)/g) ?? []).length;
  assert.strictEqual(logged, 2, "两条 RPC 各自兜错（对话候选失败不拖文件候选下水）");
  assert.strictEqual(
    guarded,
    logged,
    "每一条「查询失败」日志前都要过 signal 判据：作废掉的查询不是故障，不许写日志",
  );

  // 窗口下线：作废 + 清表（句柄按 viewId 建，留着就是泄漏）
  const unbindStart = controller.indexOf("unbindView(viewId: string): void {");
  assert.ok(unbindStart > 0, "取不到 unbindView");
  const unbind = controller.slice(unbindStart, controller.indexOf("\n  }", unbindStart));
  assert.ok(
    /this\.menuQueries\.get\(viewId\)\?\.abort\(\);\s*\n\s*this\.menuQueries\.delete\(viewId\);/.test(unbind),
    "窗口下线时要作废这次 @ 查询并清掉句柄",
  );
  // 请求本身要能取消（否则 abort 只是丢掉回来的结果，服务端照样扫完全部会话）
  const client = readFileSync(join(process.cwd(), "src", "dsh", "client.ts"), "utf8");
  assert.ok(
    /async request<T>\(\s*method: string,\s*args: Record<string, unknown>,\s*timeoutMs = 60_000,\s*signal\?: AbortSignal,/.test(
      client,
    ) && /AbortSignal\.any\(\[deadline, signal\]\)/.test(client),
    "DshClient.request 要接受调用方的取消信号（与超时信号合成）",
  );
}
console.log("mentionCandidates: 宿主侧各自发帧 + 取消旧查询 + 下线清表 ✓");

// ---------- 3. 界面侧只有一个重取点 ----------
{
  const source = readFileSync(
    join(process.cwd(), "src", "webview", "composerCompletion.tsx"),
    "utf8",
  );
  // 为什么用「出现次数」而不是行为断言：`post({type:"queryFiles"})` 住在 effect 里，
  // 而本仓库的界面测试用 `react-dom/server` 渲染（**effect 不跑**），所以「下钻只发
  // 一次」这件事在无头环境里造不出来。能钉的是它的**结构前提**：发射点只有一个。
  const posts = source.match(/post\(\{ type: "queryFiles"/g) ?? [];
  assert.strictEqual(
    posts.length,
    1,
    "`@` 候选的重取点只能有一个（下钻 / 回上一层不再自己发一遍：那会让服务端那趟扫描翻倍）",
  );
  assert.ok(
    /if \(trigger\?\.kind === "mention"\) post\(\{ type: "queryFiles", query: trigger\.query \}\)/.test(source),
    "那唯一一处就是「查询串变了就重取」的 effect",
  );
  assert.ok(
    /const replace = useCallback\(\s*\(token: string\) =>/.test(source),
    "`replace`（下钻 / 回上一层）只负责改正文，不再接收查询串去自己发帧",
  );
  // 命令目录：与查询串无关（过滤在本地做），所以只在命令通道打开时取一次
  assert.ok(
    /const commandChannel = trigger\?\.kind === "command";/.test(source) &&
      /if \(commandChannel\) post\(\{ type: "listCommands" \}\)/.test(source),
    "`/` 命令目录只在通道打开时取一次，不许跟着每次敲字重取",
  );
}
console.log("mentionCandidates: 界面侧重取点唯一 + 命令目录不跟敲字重取 ✓");

console.log("\nmentionCandidates: all assertions passed");
