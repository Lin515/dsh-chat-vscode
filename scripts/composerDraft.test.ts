/**
 * 草稿（输入框内容）在「提交」这条链路上的顺序契约。
 *
 * 用户 2026-09-23 报的现场：消息发出后输入框先清空，又闪回一下，再消失。
 *
 * 机制（§0 是可执行的**对照**）：界面在按下发送那一刻就乐观清空了自己的草稿
 * （`Composer.send` → `ui/setDraft`），而宿主的草稿表要等到 `send` 后段才清。
 * 空态第一次发消息时 `send` 会先 `ensureSession` → `createSession`，它在绑定后推一份
 * **整份状态快照**，快照里的 `draft` 读的正是那张表——于是刚发出去的正文被塞回输入框
 * （闪回），随后提交那条 patch 再把它清掉（消失）。
 *
 * 因此有两条不变量，且都在宿主侧：
 *  1. 「提交即清空」必须早于任何可能推整份快照的 await（`ensureSession`）；
 *  2. 只要没真的发出去，就必须把草稿还回输入框（界面那边已经清空了）。
 *
 * 宿主这两条只能按源码钉：`controller.ts` 依赖 `vscode`，离线断言跑不了它
 * （抠方法体比偏移是既有手法，见 `invariants.test.ts` 的「没有第一条消息就不建会话」）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initialState, reducer } from "../src/webview/state";

const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");

/** 抠出一个方法体：从签名到下一个同缩进的成员 / 文档注释（与 invariants.test.ts 同一手法）。 */
function bodyOf(signature: string): string {
  const start = controller.indexOf(signature);
  assert.ok(start >= 0, `controller.ts 里找不到 ${signature}`);
  const rest = controller.slice(start + signature.length);
  const end = rest.search(/\n  \/\*\*|\n  (?:private|public|protected|async|readonly|get|set) /);
  return end < 0 ? rest : rest.slice(0, end);
}

// ---------- 0. 对照：整份快照会把「已经提交过的」草稿塞回输入框 ----------
//
// 这条是**对照**，不是产品行为：它证明后面两条顺序钉子不是形式主义。
// 序列 = 界面按下发送（乐观清空）+ 宿主建会话时推的那一份整份快照。
{
  const typed = reducer(initialState, { type: "ui/setDraft", text: "hello" });
  assert.strictEqual(typed.draft, "hello", "打字：草稿在界面里");

  const submitted = reducer(typed, { type: "ui/setDraft", text: "" });
  assert.strictEqual(submitted.draft, "", "按下发送：界面立刻清空输入框（乐观）");

  // 宿主 `snapshotFor` 出的整份快照（这里只摆与草稿有关的那一项）
  const snapshot = reducer(submitted, { type: "state", state: { draft: "hello" } } as never);
  assert.strictEqual(
    snapshot.draft,
    "hello",
    "（对照）整份快照带着已提交的正文 → 输入框闪回；这就是 bug 现场",
  );
}
console.log("composerDraft: 整份快照会把已提交的草稿塞回输入框（bug 现场可复现）✓");

// ---------- 1. 提交即清空，必须早于建会话 ----------
//
// 空态第一次发消息这条路：send 顶部 → ensureSession → createSession → 推整份快照
// （快照里的 draft 读 `this.drafts`）。清空晚于它一步，那一帧就把正文塞回输入框。
{
  const send = bodyOf("private async send(");

  const clears = ["this.commitDraft(viewId)", "this.drafts.set("]
    .map((needle) => send.indexOf(needle))
    .filter((at) => at >= 0);
  assert.ok(clears.length > 0, "send 里必须有一处「提交即清空草稿」");
  const firstClear = Math.min(...clears);

  const ensure = send.indexOf("ensureSession(viewId)");
  assert.ok(ensure >= 0, "send 必须先走 ensureSession（空态第一次发消息才建会话）");

  assert.ok(
    firstClear < ensure,
    "清空草稿必须早于 ensureSession：ensureSession 会建会话并推一份整份快照" +
      "（createSession → snapshotFor），而快照里的 draft 读的正是宿主这张表——" +
      "晚清一步，界面上就是「清空 → 闪回 → 消失」。" +
      `（实测偏移：清空 ${firstClear}、ensureSession ${ensure}）`,
  );
}
console.log("composerDraft: 提交即清空早于 ensureSession ✓");

// ---------- 1b. 绑定会话时这份（已经是空的）草稿要跟着迁到会话键 ----------
//
// 空态清的是**窗口键**（那时还没有会话），随后 `bindViewToSession` 把它迁到会话键，
// 而整份快照读的正是会话键。迁移判据必须是「值不是 undefined」而不是「值非空」：
// 提交后的草稿刚好是空串，按「非空」判就会把它留在窗口键上，会话键下读到的是
// 更早的值（老值早被清则无事，但有旧值时就是同一族闪回的另一个入口）。
{
  assert.ok(
    /if \(draft !== undefined\) \{/.test(controller),
    "窗口↔会话的草稿迁移必须按「值不是 undefined」搬：提交后的空串也要搬走",
  );
}
console.log("composerDraft: 空草稿同样按会话键迁移 ✓");

// ---------- 2. 没真的发出去，就必须把草稿还回去 ----------
//
// 界面在按下发送那一刻已经清空了自己的输入框（§0 的对照）。所以宿主只要没把这条
// 发出去，就必须把正文推回去，否则等于把用户那句话吞掉：
//  - 用户取消了工作目录选择（ensureSession 返回 undefined）；
//  - 拼出来的内容块是空的；
//  - prompt 抛错（这一轮没提交成功，与队列发送失败同一条兜底口径）。
{
  const send = bodyOf("private async send(");
  assert.ok(
    !/if \(!scope\) return;/.test(send),
    "ensureSession 拿不到会话时不能裸 return：界面已经清空了输入框，必须把草稿还回去",
  );
  const restored = (send.match(/appendDraft\(/g) ?? []).length;
  assert.ok(
    restored >= 2,
    "「没发出去」的路径都要还草稿（取消目录选择 / prompt 抛错），" +
      `send 里只找到 ${restored} 处 appendDraft`,
  );
}
console.log("composerDraft: 没发出去的路径都把草稿还回去 ✓");

// ---------- 3. 连不上后台时同样不许吞掉正文 ----------
//
// `ensureConnected` 失败后 `send` 会因为 `!this.client` 静默返回，而界面已经清空了
// 输入框（关掉 autoConnect、内部后台又起不来时就能撞上）。
{
  const start = controller.indexOf('case "send":');
  assert.ok(start >= 0, "controller.ts 里找不到 send 分支");
  const stop = controller.indexOf('case "stop":', start);
  const branch = controller.slice(start, stop < 0 ? start + 800 : stop);
  assert.ok(
    /patch: \{ draft: message\.text \}/.test(branch),
    "连不上时要把正文推回输入框（界面按下发送就已经乐观清空了）",
  );
}
console.log("composerDraft: 连不上后台时正文回输入框 ✓");

console.log("\ncomposerDraft: all assertions passed");
