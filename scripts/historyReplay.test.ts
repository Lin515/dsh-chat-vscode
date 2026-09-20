/**
 * 「加载更早的历史」这条链路的两个用户口径（2026-09-14）：
 *
 * A. **重放期间不发帧**：`prependRecords` 会把所有已记录事件从头折一遍
 *    （`refold`）。中间态（每条 `message/append`、每轮开头那个 `running: true`）
 *    此前是一帧一帧发给界面的，于是滚到顶自动翻页时，新加载进来的旧轮次会先被
 *    画成「运行中 / 展开」的样子，过一会儿才收成折叠态——用户看到的就是
 *    「加载时把旧轮次实时渲染了一遍」。现在重放静默，界面只收到
 *    「hasMoreHistory 变了」+ 一整份 `messages/reset`。
 *
 * B. **两档语义**（2026-09-20 用户口径）：服务端按条数分页、不认轮次，一页会切在
 *    半轮中间；加载更早因此改为**按需**——不带目标取一页即停（官方 `loadOlder`），
 *    带目标取到窗口覆盖该 seq 为止（官方 `loadThrough`）。判据在
 *    `src/dsh/historyPaging.ts`（纯函数），这里一并钉住。
 *
 * C. **连取多页只结算一次**：每页只 `absorbRecords`，循环结束后 `settleHistory` 一次
 *    ——逐页重折 + 逐页整份 reset 会让一次跨轮跳转变成十几次全量重渲染。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionAdapter } from "../src/dsh/adapter";
import type { MessageView, Segment } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";
import { foldTurnProcess } from "../src/webview/turnProcess";
import { dictionaryFor } from "../src/webview/texts";
import { MAX_HISTORY_PAGES, shouldContinuePaging } from "../src/dsh/historyPaging";

/** 收集帧（与 thinkingStream.test.ts 同一套：深拷贝，模拟 postMessage）。 */
function harness() {
  const frames: HostToWebview[] = [];
  const messages: MessageView[] = [];
  const adapter = new SessionAdapter((original) => {
    const frame = structuredClone(original) as HostToWebview;
    frames.push(frame);
    if (frame.type === "messages/reset") {
      messages.length = 0;
      messages.push(...frame.messages);
    }
  });
  return { adapter, frames, messages };
}

/** 一轮完整事件：过程（工具 + 中间话）→ 答案步 → turn/end。 */
function turnEvents(turn: number, base: number, time: number) {
  return [
    { type: "turn/start", seq: base, time, data: { turn } },
    {
      type: "user/message",
      seq: base + 1,
      time: time + 1,
      data: { id: `u${turn}`, role: "user", content: [{ type: "text", text: `问题 ${turn}` }], source: { kind: "user" } },
    },
    { type: "step/start", seq: base + 2, time: time + 2, data: { turn, step: 0 } },
    {
      type: "tool/call",
      seq: base + 3,
      time: time + 3,
      data: { callId: `c${turn}`, name: "read", arguments: '{"file_path":"a.ts"}' },
    },
    {
      type: "tool/result",
      seq: base + 4,
      time: time + 4,
      data: {
        message: {
          source: { callId: `c${turn}` },
          content: [{ type: "tool-result", content: [{ type: "text", text: `第 ${turn} 轮的文件内容` }] }],
        },
      },
    },
    {
      type: "assistant/message",
      seq: base + 5,
      time: time + 5,
      data: { turn, step: 0, message: { id: `m${turn}`, role: "assistant", content: [{ type: "text", text: `第 ${turn} 轮的过程话` }] } },
    },
    { type: "step/start", seq: base + 6, time: time + 6, data: { turn, step: 1 } },
    {
      type: "assistant/message",
      seq: base + 7,
      time: time + 7,
      data: { turn, step: 1, message: { id: `m${turn}`, role: "assistant", content: [{ type: "text", text: `第 ${turn} 轮的答案` }] } },
    },
    { type: "turn/end", seq: base + 8, time: time + 8, data: { turn, reason: { kind: "stop" } } },
  ] as never[];
}

// ---------- A1. prependRecords 只发两帧：hasMoreHistory + messages/reset ----------
{
  const { adapter, frames, messages } = harness();
  const t = Date.now();
  // 先把「较新」的一轮当作实时事件应用（这就是当前窗口里已有的内容）
  for (const event of turnEvents(2, 100, t)) adapter.applyEvent(event);
  assert.ok(messages.length > 0, "先有较新的一轮作为窗口内容");

  // 再模拟 session/page 回来的一页更早历史
  frames.length = 0;
  adapter.prependRecords(
    turnEvents(1, 1, t - 10_000).map((event) => ({ type: "event", event })),
    false,
  );
  const kinds = frames.map((frame) => frame.type);
  assert.deepStrictEqual(
    kinds,
    ["patch", "messages/reset"],
    `重放期间必须静默（只发 hasMoreHistory 与整份 reset），实际发了：${JSON.stringify(kinds)}`,
  );
  assert.ok(
    !frames.some((frame) => frame.type === "message/upsert" || frame.type === "message/append" || frame.type === "message/delta"),
    "重放不该把逐帧中间态发给界面（那正是「实时渲染旧轮次」的来源）",
  );
  assert.ok(
    !frames.some((frame) => frame.type === "patch" && frame.patch.running === true),
    "重放不该发 `running: true`：界面会先把旧轮次画成「运行中」",
  );
}
console.log("historyReplay: 重放静默（只发 hasMoreHistory + messages/reset） ✓");

// ---------- A2. reset 到手时，更早的一轮是**折叠好的最终态** ----------
{
  const { adapter, frames, messages } = harness();
  const t = Date.now();
  for (const event of turnEvents(2, 100, t)) adapter.applyEvent(event);
  adapter.prependRecords(
    turnEvents(1, 1, t - 10_000).map((event) => ({ type: "event", event })),
    true,
  );
  const reset = frames.at(-1);
  assert.strictEqual(reset?.type, "messages/reset", "最后必须是整份 reset");
  const older = messages.find((m) => m.id === "a:1");
  assert.ok(older, `更早那一轮的助手消息要出现，实际：${messages.map((m) => m.id).join(", ")}`);
  assert.strictEqual(older!.streaming, false, "旧轮次不能被标成 streaming（那会让界面按「实时」画它）");
  const fold = foldTurnProcess(older!.segments, !older!.streaming);
  assert.deepStrictEqual(
    fold.runs,
    [],
    "这一段只有**一次**工具调用 → 不折（用户口径：单次工具折成一枚按钮没有意义，直接显示）",
  );
  assert.ok(
    older!.segments.some((s) => s.kind === "tool"),
    "工具段本身在流里（不折不等于丢）",
  );
  assert.deepStrictEqual(
    older!.segments
      .filter((s) => !fold.bySegment.has(s.id))
      .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
      .map((s) => s.text),
    ["第 1 轮的过程话", "第 1 轮的答案"],
    "这一段没折（只有一次工具调用），两段正文都在；折起来时留在流里的会是**最后**那段",
  );
}
console.log("historyReplay: 更早的一轮落盘即最终态 ✓");

// ---------- A3. 打开一个**正在生成**的会话：running 必须照样到达界面 ----------
//
// 重放静默之后，「这一轮还在跑」只能靠快照那条路径显式补一帧——不给的话界面会把
// 正在生成的会话显示成空闲（连控制器的 queue/steer 判定也会错）。
{
  const { adapter, frames } = harness();
  const t = Date.now();
  const records = [
    { type: "event", event: { type: "turn/start", seq: 1, time: t, data: { turn: 1 } } },
    {
      type: "event",
      event: {
        type: "assistant/message",
        seq: 2,
        time: t + 1,
        data: { turn: 1, step: 0, message: { id: "m1", role: "assistant", content: [{ type: "text", text: "正在写……" }] } },
      },
    },
  ] as never[];
  adapter.applyFrame({ type: "snapshot", cursor: 2, hasMore: false, records } as never);
  assert.ok(
    frames.some((frame) => frame.type === "patch" && frame.patch.running === true),
    "换成快照开窗时，正在跑的那一轮要显式补一帧 `running: true`",
  );

  // 反向：已结束的会话不该被说成在跑
  const ended = harness();
  ended.adapter.applyFrame({
    type: "snapshot",
    cursor: 3,
    hasMore: false,
    records: [...records, { type: "event", event: { type: "turn/end", seq: 3, time: t + 2, data: { turn: 1, reason: { kind: "stop" } } } }],
  } as never);
  const running = ended.frames.filter((frame) => frame.type === "patch" && typeof frame.patch.running === "boolean");
  assert.strictEqual(
    (running.at(-1) as { patch: { running: boolean } }).patch.running,
    false,
    "收尾后的会话最后一帧 running 必须是 false",
  );
}
console.log("historyReplay: 正在跑的会话靠显式一帧报 running ✓");

// ---------- B. 分页判据：两档语义（与官方 loadOlder / loadThrough 同构） ----------
//
// 用户口径（2026-09-20）：取消「一次触发取完整个历史」，加载更早改为**按需**——
// 单页档取一页即停（官方 `ISession.loadOlder()`），跨轮跳转走「到目标档」取到窗口
// 覆盖目标 seq 为止（官方 `ISession.loadThrough(seq)`）。两档都不再一路取到底。
//
// 停止条件：没进展 / 服务端说没有了 / 页数安全阀；到目标档另加「窗口已覆盖目标」，
// 单页档则取满一页即停。
{
  const target = { seq: 24, earliest: 60 };
  assert.strictEqual(
    shouldContinuePaging(12, true, 1, undefined),
    false,
    "单页档（不带目标）取满一页就停——不再一路取到底",
  );
  assert.strictEqual(
    shouldContinuePaging(12, true, 1, target),
    true,
    "到目标档：窗口最早 seq(60) 还没盖住目标(24) → 接着取",
  );
  assert.strictEqual(
    shouldContinuePaging(12, true, 1, { seq: 60, earliest: 60 }),
    false,
    "到目标档：窗口已经盖住目标（earliest === seq）→ 停",
  );
  assert.strictEqual(
    shouldContinuePaging(12, true, 1, { seq: 24, earliest: 12 }),
    false,
    "已经越过目标（earliest < seq）→ 停",
  );
  assert.strictEqual(
    shouldContinuePaging(12, false, 1, target),
    false,
    "服务端说没有了 → 停（两档都适用）",
  );
  assert.strictEqual(shouldContinuePaging(0, true, 1, target), false, "零进展 → 停（防死循环）");
  assert.strictEqual(
    shouldContinuePaging(12, true, MAX_HISTORY_PAGES, target),
    false,
    "到页数安全阀 → 停（服务端病态时不至于把宿主拖死）",
  );
  assert.strictEqual(
    shouldContinuePaging.length,
    4,
    "判据吃 (added, hasMore, pages, target)——target 缺席就是单页档",
  );
}
console.log("historyReplay: 分页两档语义（单页 / 到目标）✓");

// ---------- C. 连取多页只结算一次（重折不逐页做） ----------
//
// 「到目标档」可能连取十几页。逐页结算（重折 + 整份 reset）会让一次跨轮跳转变
// 十几次全量重折 + 十几次全量重渲染——消息列表没有虚拟滚动，那个代价直接吃掉
// 「跨轮跳转」的可用性。所以宿主每页只 `absorbRecords`，循环结束后 `settleHistory`。
{
  const { adapter, frames, messages } = harness();
  const t = Date.now();
  for (const event of turnEvents(3, 200, t)) adapter.applyEvent(event);
  frames.length = 0;
  const olderPage = (turn: number, base: number) =>
    turnEvents(turn, base, t - (10 - turn) * 10_000).map((event) => ({ type: "event", event }));

  // 两页：每页只吸收
  const added2 = adapter.absorbRecords(olderPage(2, 100) as never[], true);
  const added1 = adapter.absorbRecords(olderPage(1, 1) as never[], true);
  assert.ok(added2 > 0 && added1 > 0, "两页都要有进展，才谈得上「连取」");
  assert.deepStrictEqual(
    frames,
    [],
    "吸收期间**一帧都不发**（连取 N 页不该有 N 次重折、N 份 reset）",
  );
  assert.ok(
    !messages.some((m) => m.id === "a:1"),
    "未结算时消息流里还没有更早那一轮（重折只在结算时发生）",
  );

  adapter.settleHistory();
  assert.deepStrictEqual(
    frames.map((frame) => frame.type),
    ["patch", "messages/reset"],
    `连取两页后只结算一次：一帧 hasMoreHistory + 一份 reset，实际：${JSON.stringify(frames.map((f) => f.type))}`,
  );
  assert.ok(messages.some((m) => m.id === "a:1"), "结算后更早那一轮出现");

  // 幂等：没有新吸收时再结算，不再重折、不再发 reset
  frames.length = 0;
  adapter.settleHistory();
  assert.deepStrictEqual(
    frames.map((frame) => frame.type),
    ["patch"],
    "结算幂等：没有新吸收就只补一帧 hasMoreHistory",
  );
}
console.log("historyReplay: 连取多页只结算一次（幂等）✓");

// ---------- D. 结构不变量：宿主连取、界面只管视口与按钮 ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /post\(targetSeq === undefined \? \{ type: "loadMore" \} : \{ type: "loadMore", targetSeq \}\)/.test(app),
    "界面只发一次 loadMore：不带 targetSeq = 单页档，带 = 到目标档（两档共用同一个 start）",
  );
  assert.ok(
    !/HISTORY_TOP_PX/.test(app),
    "会话页没有「滚到顶自动加载」这条链路（2026-09-20 口径：只看按钮，与官方会话页一致）",
  );
  assert.ok(
    !/shouldContinuePaging|chaining/.test(app),
    "界面侧不再自己判断要不要接着取（判据只有宿主有真凭据）",
  );
  assert.ok(
    /el\.scrollTop \+= el\.scrollHeight - height\.current/.test(app),
    "落定要按**高度差**把视口钉回去（不按首条消息 id 判断）",
  );
  assert.ok(
    /onClick=\{\(\) => loadEarlier\(\)\}/.test(app),
    "手动「加载更早」按钮走同一个入口",
  );
  assert.ok(
    /disabled=\{state\.running \|\| loadingEarlier\}/.test(app) &&
      /loadingEarlier \? texts\.historyLoading : texts\.historyMore/.test(app),
    "加载期间按钮必须禁用并改文案（点了没反应 vs 还在取，要一眼可分）",
  );
  assert.ok(
    /loading: state\.historyLoading === true/.test(app),
    "按钮的加载态必须读宿主的 historyLoading",
  );

  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  // 帧的字段名与折返口径已收进 `dsh/sessionView.ts` 的字段表（`sessionPatch`），
  // 所以这条断言钉的是「取一页前后各发一次 patch」+「字段名走那张表」，不再是
  // 手写的 `patch: { historyLoading: … }` 字面量（那个字面量正是刚拆掉的漂移来源）。
  assert.strictEqual(
    [...controller.matchAll(/sessionPatch\(this\.sessionSource\(scope\), \["historyLoading"\]\)/g)].length,
    2,
    "宿主取一页前后要各发一帧 historyLoading（两处，都走同一张字段表）",
  );
  assert.ok(
    /scope\.historyLoading = true;/.test(controller) && /scope\.historyLoading = false;/.test(controller),
    "域上的闸门要真的置位/复位（界面拿到的是同一个值）",
  );
  assert.ok(
    /shouldContinuePaging\(added, Boolean\(page\.hasMore\), pages, target\)/.test(controller),
    "宿主用「真实新增事件数 + hasMore + 页数安全阀 + 目标」决定要不要继续取",
  );
  assert.ok(
    /scope\.adapter\.absorbRecords\(/.test(controller) &&
      /scope\.adapter\?\.settleHistory\(\)/.test(controller),
    "宿主每页只吸收、最后结算一次（连取 N 页 → 一次重折 + 一份 reset）",
  );
  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(
    /prependRecords\(records: readonly SessionHistoryRecord\[\], hasMore: boolean\): number/.test(adapter),
    "prependRecords 要返回新并入的事件条数（进展判据的唯一真凭据）",
  );
  // 文案走**词典断言**，不去 grep 源文件里的字面量：文案表搬到 `messages.ts` 之后，
  // 「某个文件里有这行字」只会随文件布局漂移（见 docs/audit-summary.md 第五批的结论）。
  assert.strictEqual(dictionaryFor("zh").historyLoading, "正在加载更早的历史…", "中文文案");
  assert.strictEqual(dictionaryFor("en").historyLoading, "Loading earlier history…", "英文文案");
  assert.ok(/this\.replaying = true;/.test(adapter) && /if \(this\.replaying\) return;/.test(adapter), "适配器要有重放静默开关");
  // 候选弹层（`ref` + 键盘导航要把选中行滚进视野）已收进 `composerCompletion.tsx`：
  // 这条断言跟着搬（它钉的是行为，不是「Composer 里有这行字」）。
  const completion = readFileSync(
    join(process.cwd(), "src", "webview", "composerCompletion.tsx"),
    "utf8",
  );
  assert.ok(
    /ref=\{popoverRef\}/.test(completion) && /popover-item\.is-selected/.test(completion),
    "候选弹层要接上「把选中行滚进视野」（键盘上下键导航）",
  );
}
console.log("historyReplay: 界面与适配器接上了口径 ✓");

console.log("\nhistoryReplay: all assertions passed");
