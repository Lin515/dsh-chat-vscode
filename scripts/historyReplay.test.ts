/**
 * 「加载更早的历史」这条链路的两个用户口径（2026-09-15）：
 *
 * A. **重放期间不发帧**：`prependRecords` 会把所有已记录事件从头折一遍
 *    （`refold`）。中间态（每条 `message/append`、每轮开头那个 `running: true`）
 *    此前是一帧一帧发给界面的，于是滚到顶自动翻页时，新加载进来的旧轮次会先被
 *    画成「运行中 / 展开」的样子，过一会儿才收成折叠态——用户看到的就是
 *    「加载时把旧轮次实时渲染了一遍」。现在重放静默，界面只收到
 *    「hasMoreHistory 变了」+ 一整份 `messages/reset`。
 *
 * B. **取到轮次边界为止**：服务端按条数分页、不认轮次，一页会切在半轮中间。
 *    判据在 `src/webview/historyPaging.ts`（纯函数），这里一并钉住。
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
import { atTurnBoundary, shouldContinuePaging } from "../src/dsh/historyPaging";

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
  assert.strictEqual(fold.foldable, true, "旧轮次应当可折叠（过程 + 答案步都在）");
  assert.ok(fold.folded.length > 0, "过程段要进折叠集合");
  assert.ok(
    fold.folded.some((s) => s.kind === "tool"),
    "工具行是折叠成员——它们正是「x 次工具调用」里的那些",
  );
  assert.deepStrictEqual(
    fold.visible.filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text").map((s) => s.text),
    ["第 1 轮的答案"],
    "折叠后可见的只有答案步正文（旧轮次一出现就是折叠态）",
  );
}
console.log("historyReplay: 更早的一轮落盘即折叠态 ✓");

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

// ---------- B. 取到「用户的上一条消息」为止（判据在宿主侧） ----------
//
// 用户口径（2026-09-15 两轮澄清）：**至少取到用户的上一条消息**——也就是取到一轮的
// 开头（顶部变成用户消息）。三条停止条件：到轮次边界 / 服务端说没有更早的 / 这一页
// 没带来新事件。
//
// 关键教训：第三条必须用**真实的新增事件数**。用户报的「并没有加载到上一条消息就已经
// 停了」，根因就是当时拿「首条消息 id 变没变」当进展判据——更早的事件常常只是把现有的
// 第一条助手消息**补长**（id 是按轮次派生的 `a:<turn>`，不会变），于是被误判成「没进展」
// 而在半轮中间收手（现场见 `scripts/pageLoopProbe.ts`）。
{
  const user = (id: string): MessageView => ({ id, role: "user", ts: 0, text: "问", segments: [] });
  const assistant = (id: string): MessageView => ({ id, role: "assistant", ts: 0, segments: [] });

  assert.strictEqual(atTurnBoundary([user("u1"), assistant("a:1")]), true, "顶部是用户消息 = 一轮的开头");
  assert.strictEqual(atTurnBoundary([assistant("a:1"), user("u2")]), false, "顶部是助手消息 = 半轮中间");
  assert.strictEqual(atTurnBoundary([]), true, "没有消息时不再取");

  // 半轮中间 + 还有更早 + 这一页确实带来了事件 → 接着取（这正是被误判掉的那一步）
  assert.strictEqual(
    shouldContinuePaging(250, true, [assistant("a:0")]),
    true,
    "「首条消息没换、但并入了 250 条事件」必须继续取——否则就是用户报的提前停",
  );
  // 到了轮次边界 → 停
  assert.strictEqual(shouldContinuePaging(12, true, [user("u1"), assistant("a:0")]), false, "到边界 → 停");
  // 没有更早了 → 停
  assert.strictEqual(shouldContinuePaging(12, false, [assistant("a:0")]), false, "服务端说没有了 → 停");
  // 这一页没带来事件 → 停（防死循环）
  assert.strictEqual(shouldContinuePaging(0, true, [assistant("a:0")]), false, "零进展 → 停");
  // 判据里不能有「取了几页」这种输入：那等于把页数上限又加回来
  assert.strictEqual(shouldContinuePaging.length, 3, "只吃 (added, hasMore, messages)");
}
console.log("historyReplay: 取到用户的上一条消息为止 ✓");

// ---------- C. 结构不变量：宿主连取、界面只管视口与按钮 ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(/post\(\{ type: "loadMore" \}\)/.test(app), "界面只发一次 loadMore（连取由宿主驱动）");
  assert.ok(
    !/shouldContinuePaging|chaining/.test(app),
    "界面侧不再自己判断要不要接着取（判据只有宿主有真凭据）",
  );
  assert.ok(
    /el\.scrollTop \+= el\.scrollHeight - height\.current/.test(app),
    "每落一页要按**高度差**把视口钉回去（不按首条消息 id 判断）",
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
  assert.ok(
    /patch: \{ historyLoading: true \}/.test(controller) && /patch: \{ historyLoading: false \}/.test(controller),
    "宿主取一页前后要各发一帧 historyLoading",
  );
  assert.ok(
    /shouldContinuePaging\(added, Boolean\(page\.hasMore\), scope\.adapter\.snapshotMessages\(\)\)/.test(controller),
    "宿主用「真实新增事件数 + hasMore + 顶部角色」决定要不要继续取",
  );
  const adapter = readFileSync(join(process.cwd(), "src", "dsh", "adapter.ts"), "utf8");
  assert.ok(
    /prependRecords\(records: readonly SessionHistoryRecord\[\], hasMore: boolean\): number/.test(adapter),
    "prependRecords 要返回新并入的事件条数（进展判据的唯一真凭据）",
  );
  const texts = readFileSync(join(process.cwd(), "src", "webview", "texts.ts"), "utf8");
  assert.ok(/historyLoading: "正在加载更早消息…"/.test(texts), "中文文案");
  assert.ok(/historyLoading: "Loading earlier messages…"/.test(texts), "英文文案");
  assert.ok(/this\.replaying = true;/.test(adapter) && /if \(this\.replaying\) return;/.test(adapter), "适配器要有重放静默开关");
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /ref=\{popoverRef\}/.test(composer) && /popover-item\.is-selected/.test(composer),
    "候选弹层要接上「把选中行滚进视野」（键盘上下键导航）",
  );
}
console.log("historyReplay: 界面与适配器接上了口径 ✓");

console.log("\nhistoryReplay: all assertions passed");
