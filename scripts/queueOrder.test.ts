/**
 * 待发送队列的**显示顺序**断言（`src/webview/queueOrder.ts`）。
 *
 * 用户 2026-09-15 口径：**插话发送的（`steering`）要排在排队发送的（`queued`）上方**。
 * 服务端给的是提交先后，后提交的插话会被压在排队的下面，看起来像插话没生效。
 * 这里同时钉住「只改显示」：数据顺序（宿主按原顺序重发队列）不能被顺手改掉。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedMessageView } from "../src/shared/chat";
import { queueDisplayOrder, queueRank } from "../src/webview/queueOrder";

const item = (id: string, placement: QueuedMessageView["placement"]): QueuedMessageView => ({
  id,
  text: id,
  placement,
});

// ---------- 1. 插话排在排队上方，两组内部保持原顺序 ----------
{
  // 服务端顺序 = 提交先后：先排三条队，最后插一句
  const wire = [item("q1", "queued"), item("q2", "queued"), item("s1", "steering")];
  assert.deepStrictEqual(
    queueDisplayOrder(wire).map((entry) => entry.id),
    ["s1", "q1", "q2"],
    "插话在最上面，排队按原顺序跟在后面",
  );
  assert.deepStrictEqual(
    wire.map((entry) => entry.id),
    ["q1", "q2", "s1"],
    "入参数组的顺序不许被改动（宿主按它重发队列）",
  );

  // 已经在上面的插话不会再被挪动；多条插话之间也保持原顺序
  const mixed = [item("s1", "steering"), item("q1", "queued"), item("s2", "steering")];
  assert.deepStrictEqual(
    queueDisplayOrder(mixed).map((entry) => entry.id),
    ["s1", "s2", "q1"],
    "多条插话之间保持服务端顺序（稳定排序）",
  );
}

// ---------- 2. 权重与边界 ----------
{
  assert.strictEqual(queueRank(item("s", "steering")), 0, "插话权重在前");
  assert.strictEqual(queueRank(item("q", "queued")), 1, "排队权重在后");
  assert.deepStrictEqual(queueDisplayOrder([]), [], "空队列安全");
  const only = [item("q1", "queued"), item("q2", "queued")];
  assert.deepStrictEqual(
    queueDisplayOrder(only).map((entry) => entry.id),
    ["q1", "q2"],
    "全是排队时顺序不变",
  );
  const all = [item("s1", "steering"), item("s2", "steering")];
  assert.deepStrictEqual(
    queueDisplayOrder(all).map((entry) => entry.id),
    ["s1", "s2"],
    "全是插话时顺序不变",
  );
}

// ---------- 3. 接线：状态条真的按这个顺序渲染 ----------
//
// 2026-09-25：排队区**只**画服务端给的队列项（`state.queueItems`），与改动前逐字相同。
// 「发出去的消息立即显示」只针对**按下那一刻 agent 空闲**的那一类（它真发出去了）；
// 排队中的消息**还没发出去**，它压根不进乐观回显账本，在界面上唯一的去处就是这个队列
// ——本地不另画一行、也不接管那一行的动作（取消 / 编辑 / 插话仍由真实队列项给）。
{
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    /const items = queueDisplayOrder\(state\.queueItems\)/.test(composer),
    "状态条渲染前要过一遍 queueDisplayOrder（直接 map state.queueItems = 顺序没变）",
  );
  assert.ok(
    /\{items\.map\(\(item\) => \(/.test(composer),
    "渲染的必须是排序后的那份（排完还用原数组等于没排）",
  );
  assert.ok(
    /texts\.queued, \{ n: items\.length \}/.test(composer),
    "条数取排序后的长度（同一个集合，只是不许两处各读一份）",
  );
  assert.ok(
    !/pendingMessages|pendingDockItems|pendingRows|localIds/.test(composer),
    "排队区不吃乐观回显：它只画服务端给的队列项（改动前就是这么画的）",
  );
}

console.log("\nqueueOrder: all assertions passed");
