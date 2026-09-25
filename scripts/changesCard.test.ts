/**
 * 改动文件卡片（`workspace/changes`）的三段链路。
 *
 * 背景：dsh 0.1.6-alpha 起，内核在**每个顶层轮次停止**时追加一条 log-only 的
 * `workspace/changes` 事件，只带轮号；本轮改了哪些文件、各增删多少行留在 Host 内存里，
 * 由认证路由 `/api/changes.summary?sessionId&seq` 提供（官方 web 端把它渲染成
 * 「改动文件卡片」）。本客户端此前把这个事件当「不认识的事件」弹提示条——因为名单
 * 还停在 0.1.5-rc.1——而卡片从未有过。
 *
 * 这里钉三件事：
 *  1. 清单的形状校验（服务端给的值不可信，验不过就整份丢弃）；
 *  2. 折叠口径（3 行）与缓存键（带会话 id，防两个会话的同号事件串清单）；
 *  3. 两端的接线（适配器折叠坐标、宿主按 seq 去 Host 读、界面按需请求并渲染）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import { decodeChangesSummary } from "../src/dsh/changes";
import { CHANGES_CARD_VISIBLE, changesSummaryKey, turnsWithChangesCard, visibleChangeFiles } from "../src/shared/changesSummary";
import { reducer, initialState, type AppState } from "../src/webview/state";

const SRC = join(process.cwd(), "src");

// ---------- 1. 清单形状校验：验不过就整份丢弃 ----------

const goodSummary = {
  turn: 3,
  files: [
    { path: "src/a.ts", display: "src/a.ts", added: 12, deleted: 4 },
    { path: "D:/out/b.png", display: "D:/out/b.png", added: 0, deleted: 0, binary: true },
  ],
  total: 5,
  added: 30,
  deleted: 9,
};

{
  const decoded = decodeChangesSummary(goodSummary);
  assert.deepStrictEqual(decoded, goodSummary, "合规清单应原样解出");
}
console.log("changesCard: 合规清单原样解出 ✓");

{
  const bad: [string, unknown][] = [
    ["非对象", "nope"],
    ["null", null],
    ["数组", []],
    ["缺 turn", { ...goodSummary, turn: undefined }],
    ["turn 为 0", { ...goodSummary, turn: 0 }],
    ["total 为负", { ...goodSummary, total: -1 }],
    ["files 不是数组", { ...goodSummary, files: {} }],
    ["文件缺 display", { ...goodSummary, files: [{ path: "a.ts", added: 0, deleted: 0 }] }],
    ["文件 added 为负", { ...goodSummary, files: [{ ...goodSummary.files[0]!, added: -2 }] }],
    ["binary 写成 false", { ...goodSummary, files: [{ ...goodSummary.files[0]!, binary: false }] }],
    ["added 是字符串", { ...goodSummary, added: "30" }],
    ["added 是 NaN", { ...goodSummary, added: Number.NaN }],
  ];
  for (const [label, value] of bad) {
    assert.strictEqual(decodeChangesSummary(value), null, `${label} 应整份丢弃`);
  }
}
console.log("changesCard: 形状不合规的清单整份丢弃（半个卡片比没有更误导） ✓");

// ---------- 2. 折叠口径与缓存键 ----------

{
  const files = Array.from({ length: 7 }, (_, index) => ({
    path: `f${index}.ts`,
    display: `f${index}.ts`,
    added: 1,
    deleted: 0,
  }));
  assert.strictEqual(visibleChangeFiles(files, false).length, CHANGES_CARD_VISIBLE);
  assert.deepStrictEqual(
    visibleChangeFiles(files, false).map((file) => file.path),
    ["f0.ts", "f1.ts", "f2.ts"],
    "折叠时按 Host 排好的顺序取前 3 行",
  );
  assert.strictEqual(visibleChangeFiles(files, true).length, 7, "展开后铺满");
  assert.deepStrictEqual(visibleChangeFiles([], true), [], "空清单安全");
  assert.strictEqual(
    visibleChangeFiles(files.slice(0, CHANGES_CARD_VISIBLE), false).length,
    CHANGES_CARD_VISIBLE,
    "恰好 3 个时既不截断也不报错",
  );
}
console.log("changesCard: 折叠 3 行、展开铺满 ✓");

{
  // 只用 seq 做键会让两个会话的同号事件互相串清单——这个断言是那条口径的钉子
  assert.notStrictEqual(changesSummaryKey("s1", 41), changesSummaryKey("s2", 41));
  assert.strictEqual(changesSummaryKey("s1", 41), changesSummaryKey("s1", 41));
  assert.notStrictEqual(changesSummaryKey("s1", 41), changesSummaryKey("s1", 42));
}
console.log("changesCard: 缓存键带会话 id（同号事件不串清单） ✓");

// ---------- 3. 适配器折叠：坐标挂到该轮消息上 ----------

function wire(type: string, data: unknown, extra: Record<string, unknown> = {}) {
  return { type, seq: extra.seq ?? 1, time: 1789147200000, data, ...extra };
}

{
  const adapter = new SessionAdapter(() => {});
  adapter.applyEvent(wire("workspace/changes", { turn: 2 }, { seq: 41 }) as never);
  const message = adapter.snapshotMessages().find((m) => m.id === "a:2");
  assert.ok(message, "坐标要挂在**宣告的那一轮**的消息上（不是当前轮 a:0）");
  assert.deepStrictEqual(message!.changes, { turn: 2, seq: 41 });
}
console.log("changesCard: 事件只有轮号，坐标挂到该轮消息上 ✓");

{
  // 同一轮后来的宣告替代先前的（官方 DeliverablesTurnData.changes 同口径）
  const adapter = new SessionAdapter(() => {});
  adapter.applyEvent(wire("workspace/changes", { turn: 1 }, { seq: 10 }) as never);
  adapter.applyEvent(wire("workspace/changes", { turn: 1 }, { seq: 18 }) as never);
  const message = adapter.snapshotMessages().find((m) => m.id === "a:1");
  assert.deepStrictEqual(message!.changes, { turn: 1, seq: 18 }, "同轮后者覆盖前者");
  assert.strictEqual(adapter.snapshotMessages().length, 1, "一轮里只该有一条助手消息被标坐标");
}
console.log("changesCard: 同一轮后来者覆盖（不堆多张卡片） ✓");

{
  // turn 不是数字：定位不到轮次就不挂（挂错轮次比少一张卡片更难排查）
  const adapter = new SessionAdapter(() => {});
  adapter.applyEvent(wire("workspace/changes", { turn: "2" }, { seq: 7 }) as never);
  assert.deepStrictEqual(adapter.snapshotMessages(), [], "认不出轮号时不凭空建消息");
}
console.log("changesCard: 认不出轮号时不挂到当前轮 ✓");

// ---------- 3b. 半轮首帧：轮号归位（不再多出一条 a:0） ----------
//
// 首帧只带最近 N 条，可能**从一轮中间开始**：那时还没有 `turn/start`，`currentTurn`
// 是 undefined，这一轮的内容会被挂到凭空建出的 `a:0` 上；往上翻、加载更早的历史后
// 重折，内容归并回 `a:N`——界面上先看到「同一轮的两条消息」（一条带本轮改动/交付、
// 一条带卡片），加载全历史后又少一条（用户 2026-09-21 报告）。

{
  const adapter = new SessionAdapter(() => {});
  adapter.applyEvent(wire("step/start", { turn: 3, step: 1 }, { seq: 100 }) as never);
  adapter.applyEvent(
    wire("tool/call", { turn: 3, step: 1, callId: "c1", name: "write", arguments: '{"file_path":"a.ts"}' }, { seq: 101 }) as never,
  );
  adapter.applyEvent(wire("workspace/changes", { turn: 3 }, { seq: 120 }) as never);
  const ids = adapter.snapshotMessages().map((message) => message.id);
  assert.deepStrictEqual(ids, ["a:3"], `首帧半轮要归位到真实轮号，实际 ${ids.join(",")}`);
  assert.deepStrictEqual(adapter.snapshotMessages()[0]!.changes, { turn: 3, seq: 120 });
}
console.log("changesCard: 首帧从半轮开始也落到真实轮号（不再多出一条 a:0） ✓");

{
  // 轮前内容（斜杠命令行不带 turn）仍走幻影轮 a:0——turnRail 的既有语义不能改坏
  const adapter = new SessionAdapter(() => {});
  adapter.applyEvent(
    wire("command/run", { commandId: "cmd1", name: "plan", source: { kind: "user" } }, { seq: 5 }) as never,
  );
  assert.deepStrictEqual(
    adapter.snapshotMessages().map((message) => message.id),
    ["a:0"],
    "轮前的命令行仍拼成幻影轮 a:0",
  );
}
console.log("changesCard: 轮前的命令行仍拼成幻影轮 a:0 ✓");

// ---------- 3c. 让位按轮判定（同轮多段不再并排三样） ----------
//
// 一轮被插话切成多段时（`a:N` / `a:N:2`），卡片挂在最后一段、`produced` 挂在前一段。
// 按消息判定会让「卡片」与「本轮改动」在同一轮尾部并排——用户 2026-09-21 报的混乱。

{
  const summary = decodeChangesSummary(goodSummary)!;
  const messages = [
    { id: "a:5", produced: 3 },
    { id: "a:5:2", changes: { turn: 5, seq: 41 } },
    { id: "a:6", produced: 1 },
  ];
  assert.deepStrictEqual(
    [...turnsWithChangesCard(messages, () => summary)],
    [5],
    "卡片在第 2 段，整轮都算「有卡片」（第 1 段的本轮改动行随之让位）",
  );
  // 清单没到手（还没问到 / Host 说没有 / 列了 0 个文件）都不算有卡片：
  // 那一轮「本轮改动」行必须留着，否则文件两头都没了
  assert.deepStrictEqual([...turnsWithChangesCard(messages, () => null)], []);
  assert.deepStrictEqual([...turnsWithChangesCard(messages, () => undefined)], []);
  assert.deepStrictEqual([...turnsWithChangesCard(messages, () => ({ files: [] }))], []);
}
console.log("changesCard: 让位按轮判定（同轮多段不并排） ✓");

// ---------- 4. 界面归约：只收当前会话、null 与「还没问过」分开 ----------

function baseState(sessionId: string): AppState {
  return { ...initialState, session: { id: sessionId, title: "", updatedAt: 0, running: false } };
}

{
  const state = baseState("s1");
  const withSummary = reducer(state, {
    type: "changes/summary",
    sessionId: "s1",
    seq: 41,
    summary: decodeChangesSummary(goodSummary)!,
  });
  assert.ok(withSummary.changesSummaries?.[changesSummaryKey("s1", 41)], "当前会话的清单要收下");

  // 切会话瞬间在途的旧帧必须丢掉（否则新会话会拿旧会话的清单渲染同号事件）
  const otherSession = reducer(withSummary, {
    type: "changes/summary",
    sessionId: "s2",
    seq: 41,
    summary: decodeChangesSummary(goodSummary)!,
  });
  assert.strictEqual(otherSession, withSummary, "不是当前会话的清单：整帧丢弃");
}
console.log("changesCard: 只收当前会话的清单 ✓");

{
  // null（Host 说没有）与「键不存在」（还没问）是两种状态，界面靠它决定是否再问
  const state = baseState("s1");
  const asked = reducer(state, { type: "changes/summary", sessionId: "s1", seq: 9, summary: null });
  const key = changesSummaryKey("s1", 9);
  assert.ok(Object.prototype.hasOwnProperty.call(asked.changesSummaries, key), "null 也要落表（问过了）");
  assert.strictEqual(asked.changesSummaries?.[key], null);
  assert.strictEqual(state.changesSummaries, undefined, "还没问过时键不存在");
}
console.log("changesCard: 「Host 说没有」与「还没问过」分开 ✓");

{
  // 换会话清缓存（旧会话的清单再也用不上）
  const state = baseState("s1");
  const filled = reducer(state, { type: "changes/summary", sessionId: "s1", seq: 1, summary: null });
  const switched = reducer(filled, {
    type: "state",
    state: { session: { id: "s2", title: "", updatedAt: 0, running: false } },
  } as never);
  assert.strictEqual(switched.changesSummaries, undefined, "换会话要整体丢掉旧清单");
}
console.log("changesCard: 换会话丢掉旧清单 ✓");

// ---------- 5. 接线：宿主按需去 Host 读、界面渲染卡片 ----------

{
  const controller = readFileSync(join(SRC, "dsh", "controller.ts"), "utf8");
  assert.ok(/case "requestChanges":/.test(controller), "宿主必须处理界面的按需请求");
  assert.ok(/loadChangesSummary\(/.test(controller), "请求要落到 loadChangesSummary");
  assert.ok(
    /\/api\/changes\.summary\?\$\{new URLSearchParams/.test(controller),
    "清单必须走 Host 的认证路由 /api/changes.summary（官方 ui-deliverables 的同一份契约）",
  );
  assert.ok(
    /changesSummaryOwner !== client/.test(controller),
    "换了连接要整体作废缓存：seq 只在同一条连接里有意义",
  );

  const client = readFileSync(join(SRC, "dsh", "client.ts"), "utf8");
  assert.ok(/async getJson\(path: string/.test(client), "客户端要有认证的 GET");
  assert.ok(/res\.status === 404\) return undefined/.test(client), "404 = Host 说没有，不是错误");
}
console.log("changesCard: 宿主按需读取（认证路由 + 按连接作废） ✓");

{
  const card = readFileSync(join(SRC, "webview", "components", "ChangesCard.tsx"), "utf8");
  assert.ok(/post\(\{ type: "requestChanges", sessionId, seq \}\)/.test(card), "缺清单时卡片要发一次请求");
  assert.ok(/summary === undefined/.test(card), "「还没问过」与「Host 说没有」在卡片里必须分开判");
  assert.ok(/summary\.files\.length === 0\) return null/.test(card), "Host 没列出文件时没有卡片");

  const message = readFileSync(join(SRC, "webview", "components", "Message.tsx"), "utf8");
  assert.ok(/<ChangesCard sessionId=\{sessionId\}/.test(message), "轮尾要渲染卡片");
  assert.ok(
    /!message\.streaming && !changesCardShown && producedFiles\.length/.test(message),
    "卡片显示出来了，「本轮改动」文件行才让位（拿不到清单时那一行还留着）",
  );

  const app = readFileSync(join(SRC, "webview", "App.tsx"), "utf8");
  assert.ok(
    /changesSummaryKey\(state\.session\.id, row\.message\.changes\.seq\)/.test(app),
    "App 按坐标查缓存（行序列把消息包成 row，见 messageRows）",
  );
  assert.ok(/sessionId=\{state\.session\?\.id\}/.test(app), "会话 id 要传给消息（卡片发请求要用）");
  assert.ok(
    /turnsWithChangesCard\(state\.messages/.test(app) && /changesCardShown=\{/.test(app),
    "让位判定要按轮算好再传给消息（卡片可能在同轮的另一段上）",
  );
}
console.log("changesCard: 界面按需请求、卡片取代「本轮改动」行 ✓");

{
  // `+N` / `−N` 要能分别上色：必须拆成两个节点，且用 diff 视图那对类名
  // （`.diff-add` 绿 / `.diff-del` 红）——「同语义元素待遇一致」。
  const card = readFileSync(join(SRC, "webview", "components", "ChangesCard.tsx"), "utf8");
  assert.ok(
    /className="diff-add"/.test(card) && /className="diff-del"/.test(card),
    "行数与标题的 ± 都要走 diff 那对配色类名",
  );
  assert.ok(
    !/changesCardCounts/.test(card),
    "不能再拼成一整串：拼了就分别上不了色",
  );
  const css = readFileSync(join(SRC, "webview", "styles", "app.css"), "utf8");
  assert.ok(
    /\.changes-card-counts,\s*\n\.changes-card-delta \{[\s\S]{0,120}display: inline-flex/.test(css),
    "两个数字之间要留缝（inline-flex + gap），贴在一起会读成一个数",
  );
  assert.ok(
    /\.changes-card \.diff-add \{[\s\S]{0,80}color: var\(--success\)/.test(css) &&
      /\.changes-card \.diff-del \{[\s\S]{0,80}color: var\(--error\)/.test(css),
    "卡片里的 ± 要显式上色：`.diff-stat` 那两条规则限定作用域，光复用类名只会是灰的" +
      "（第一版实测颜色就是 rgb(140,140,140)）",
  );
}
console.log("changesCard: ± 行数分色（复用 diff 的绿/红） ✓");

// ---------- 6. 标题栏：可折时是折展入口，任何形态都不打开文件 ----------
//
// 官方那张卡片的标题带文件类型图标、点它打开侧边栏复查面板（`ChangedFiles.tsx` 的
// header → `openReview(0)`）；本客户端没有复查面板，先前照搬成「点标题 = 打开第一个
// 文件的改动」——标题看着是表头，实际是第一个文件的行，用户报「第一个文件的触发区
// 一直高到标题栏」。现在标题栏的点击只用于**开合文件列表**（与底部那枚按钮同一个
// 动作、同一个 `expanded`），文件不多（没东西可折）时退回纯表头；打开文件只从文件行
// 发起。

{
  const card = readFileSync(join(SRC, "webview", "components", "ChangesCard.tsx"), "utf8");
  assert.ok(!/summary\.files\[0\]/.test(card), "标题栏不该再摸第一个文件");

  assert.ok(
    /const toggle = \(\) => setExpanded\(\(value\) => !value\)/.test(card),
    "开合只有一处实现（两处各写一遍 setExpanded 迟早走岔）",
  );
  assert.strictEqual(
    (card.match(/onClick=\{toggle\}/g) ?? []).length,
    2,
    "标题栏与底部那枚按钮必须共用同一个开合动作，否则「同步」只是句话",
  );

  const headButton = card.match(/<button[\s\S]{0,200}?className="changes-card-head"[\s\S]{0,200}?>/);
  assert.ok(headButton, "有可折叠内容时标题栏要是按钮（点了要有反应）");
  assert.ok(/aria-expanded=\{expanded\}/.test(headButton![0]), "标题栏要把开合状态暴露给无障碍");
  assert.ok(!/openFile/.test(headButton![0]), "标题栏的点击只能开合，不能打开文件");
  assert.ok(
    /<div className="changes-card-head">\{heading\}<\/div>/.test(card),
    "没有可折叠内容时标题栏退回纯表头（不做点了没反应的控件）",
  );
  assert.ok(
    /\{foldable \? <IconChevronDown/.test(card),
    "折展箭头只在真有东西可折时画",
  );
  assert.ok(
    /<button[\s\S]{0,400}?className="changes-card-row"[\s\S]{0,400}?onClick/.test(card),
    "文件行仍要可点（点它看该文件的改动）",
  );

  const css = readFileSync(join(SRC, "webview", "styles", "app.css"), "utf8");
  const shared = css.match(/\.changes-card-head,\s*\n\.changes-card-row \{([^}]*)\}/);
  assert.ok(shared, "标题栏与文件行的共用排版规则要还在");
  assert.ok(!/cursor/.test(shared![1]), "光标按形态给，不写进共用排版");
  const clickable = css.match(/button\.changes-card-head,\s*\n\.changes-card-row \{([^}]*)\}/);
  assert.ok(clickable, "可点形态要有一条自己的规则");
  assert.ok(/cursor:\s*pointer/.test(clickable![1]), "可点形态才给手型光标（纯表头不许装作可点）");
  assert.ok(
    /\.changes-card-head\[aria-expanded="true"\] \.changes-card-chevron \{[\s\S]{0,60}rotate\(180deg\)/.test(css),
    "展开后箭头朝上：只靠 CSS 翻 180°，不换图标",
  );
  assert.ok(
    /\.changes-card-chevron \{[\s\S]{0,120}transition: transform/.test(css),
    "箭头翻转要有过渡（与 .turn-process-chevron / .job-chevron 同款）",
  );
  assert.ok(
    /button\.changes-card-head:hover \.changes-card-chevron/.test(css),
    "悬停只亮可点形态的箭头：标题本身已是 --fg，行数有自己的绿/红",
  );
  assert.ok(
    /\.changes-card-row:hover \{[\s\S]{0,60}color: var\(--fg\)/.test(css),
    "文件行的悬停高亮要留着",
  );
  assert.ok(/\.changes-card-counts \{[\s\S]{0,60}margin-left: auto/.test(css), "标题与箭头靠左、行数靠右");
}
console.log("changesCard: 标题栏可折时是折展入口、任何形态都不打开文件 ✓");
