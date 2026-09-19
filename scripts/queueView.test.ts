/**
 * 离线验证队列项的视图映射（两种线格式 → `QueuedMessageView`）。
 *
 * 覆盖两件事：
 * 1. **两条通道折算结果必须一致**：当前服务端的 `inbox` 投影
 *    （`{'next-turn','next-step'}`）与旧服务端的 `SessionQueuedItem[]`
 *    （`session/control` 的 `queues` / `queue` 帧）。扩展两条都读，任何一侧
 *    折算错了，界面上的待发列表就会缺项或多出假消息——而这个故障**不会**让
 *    typecheck 变红（2026-09-18 用户报的「待发列表消失」就是这么发生的：
 *    服务端换了通道，扩展还在读旧的）。
 * 2. 必须优先用客户端存的原始输入：提交给服务端的正文已经把文件/目录上下文
 *    内联进去了，直接回填会把那一大坨倒回输入框。这是「重新编辑」的正确性基础。
 *
 * 运行：npm run test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { queueItemsFromInbox, queueItemsFromWire, type QueuedItemEntry } from "../src/dsh/queueView";

const originText = "把这两个文件的启动逻辑合并到一个入口";
const wireText = "文件 src/server/index.ts 的内容：\n```\n...\n```\n\n" + originText;

/** 同一批消息的两份线格式夹具（内容逐条对齐，用来对拍两条通道）。 */
const wireFixture = [
  {
    id: "q1",
    placement: "queued",
    rpcId: "rpc-1",
    message: { content: [{ type: "text", text: wireText }] },
  },
  {
    id: "q2",
    placement: "queued",
    message: { content: [{ type: "text", text: "第二条" }] },
  },
  {
    id: "s1",
    placement: "steering",
    rpcId: "rpc-s",
    message: { content: [{ type: "text", text: "插一句" }] },
  },
];
const inboxFixture = {
  "next-turn": [
    { id: "q1", content: [{ type: "text", text: wireText }], source: { kind: "user", rpcId: "rpc-1" } },
    { id: "q2", content: [{ type: "text", text: "第二条" }], source: { kind: "user" } },
  ],
  "next-step": [
    { id: "s1", content: [{ type: "text", text: "插一句" }], source: { kind: "user", rpcId: "rpc-s" } },
  ],
};
/** 有本地提交记录时的 origin 解析器（只有 q1 认识）。 */
const originOf = (rpcId: string | undefined) =>
  rpcId === "rpc-1" ? { text: originText, attachments: [{ id: "a" }, { id: "b" }] } : undefined;

const brief = (entries: QueuedItemEntry[]) =>
  entries.map((entry) => ({
    id: entry.view.id,
    placement: entry.view.placement,
    text: entry.view.text,
    rpcId: entry.view.rpcId,
    attachments: entry.view.attachments,
    hasMedia: entry.view.hasMedia,
    content: entry.content,
  }));

// ---------- 1. 两条通道对拍：同一批消息折算结果必须逐条一致 ----------
{
  const fromInbox = brief(queueItemsFromInbox(inboxFixture, originOf));
  const fromWire = brief(queueItemsFromWire(wireFixture, originOf));
  assert.deepStrictEqual(fromInbox, fromWire, "inbox 投影与旧队列帧必须折出同一份视图");
  assert.strictEqual(fromInbox.length, 3, "三条都要在");
  assert.deepStrictEqual(
    fromInbox.map((entry) => entry.id),
    ["q1", "q2", "s1"],
    "顺序 = 排队在前、插话在后（宿主 ESC 重发按这个顺序，不许改）",
  );
  assert.strictEqual(fromInbox[0].text, originText, "必须用原始输入，而不是含内联上下文的线上文本");
  assert.strictEqual(fromInbox[0].attachments, 2);
  assert.strictEqual(fromInbox[0].rpcId, "rpc-1");
  assert.strictEqual(fromInbox[0].placement, "queued");
  assert.strictEqual(fromInbox[2].placement, "steering");
  assert.strictEqual(fromInbox[2].text, "插一句");
}
console.log("queueView: 两条通道对拍 ✓");

// ---------- 2. 没有原始记录（扩展重载过）：退回线上文本 ----------
{
  const fromInbox = brief(queueItemsFromInbox(inboxFixture, () => undefined));
  const fromWire = brief(queueItemsFromWire(wireFixture, () => undefined));
  assert.deepStrictEqual(fromInbox, fromWire);
  assert.strictEqual(fromWire[0].text, wireText, "取不到原始输入时至少有线上文本可编辑");
  assert.strictEqual(fromWire[0].attachments, undefined, "没有原始记录就没有附件数量");
}
console.log("queueView: 无原始记录 → 退回线上文本 ✓");

// ---------- 3. `next-step` 里插件注入的环境上下文不下发 ----------
{
  const views = brief(
    queueItemsFromInbox({
      "next-turn": [],
      "next-step": [
        { id: "c1", content: [{ type: "text", text: "MCP 服务器状态" }], source: { kind: "plugin" } },
        { id: "c2", content: [{ type: "text", text: "没有 source" }] },
        { id: "s2", content: [{ type: "text", text: "真的插话" }], source: { kind: "user" } },
      ],
    }),
  );
  assert.deepStrictEqual(views.map((entry) => entry.id), ["s2"], "只有 user source 的插话算用户消息");
  assert.strictEqual(views[0].placement, "steering");
  // 旧通道的等价语义：`context` 放置位丢弃（同一批 fixture 的老断言）
  assert.deepStrictEqual(
    queueItemsFromWire([
      { id: "c1", placement: "context", message: { content: [{ type: "text", text: "MCP 服务器状态" }] } },
      { id: "q4", placement: "queued", message: { content: [{ type: "text", text: "真的消息" }] } },
    ]).map((entry) => entry.view.id),
    ["q4"],
  );
}
console.log("queueView: 环境上下文被过滤 ✓");

// ---------- 4. 纯附件 / 多文本块 ----------
{
  const mediaOnly = queueItemsFromInbox({
    "next-turn": [{ id: "q5", content: [{ type: "image", attachment: { attachmentId: "x" } }], source: { kind: "user" } }],
  });
  assert.strictEqual(mediaOnly[0].view.text, "", "没有文本时 text 为空");
  assert.strictEqual(mediaOnly[0].view.hasMedia, true, "有图片块 → hasMedia（界面用「附件」占位）");

  const multi = queueItemsFromInbox({
    "next-turn": [
      { id: "q6", content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }], source: { kind: "user" } },
    ],
  });
  assert.strictEqual(multi[0].view.text, "第一段\n第二段", "多个文本块按顺序拼接");
}
console.log("queueView: 纯附件与多文本块 ✓");

// ---------- 5. 非法输入不崩（服务端形状改动的第一道防线） ----------
{
  assert.deepStrictEqual(queueItemsFromInbox(undefined), []);
  assert.deepStrictEqual(queueItemsFromInbox(null), []);
  assert.deepStrictEqual(queueItemsFromInbox({}), []);
  assert.deepStrictEqual(queueItemsFromInbox({ "next-turn": "not-an-array" }), [], "不是数组当空");
  assert.deepStrictEqual(queueItemsFromInbox({ "next-turn": [null, {}, { content: [] }] }), [], "没有 id 的项跳过");
  assert.deepStrictEqual(queueItemsFromInbox({ "next-turn": [{ id: "", content: [] }] }), [], "空 id 跳过");
  assert.deepStrictEqual(queueItemsFromInbox({ "next-turn": [{ id: 42, content: [] }] }), [], "非字符串 id 跳过");

  // content 不是数组：条目仍在（id 有效），文本为空、不带媒体——宁可少显示，不崩
  const loose = queueItemsFromInbox({ "next-turn": [{ id: "ok", content: "not-an-array" }] });
  assert.strictEqual(loose.length, 1);
  assert.strictEqual(loose[0].view.text, "");
  assert.strictEqual(loose[0].view.hasMedia, false, "内容块非法 → 不算带媒体");
  assert.deepStrictEqual(loose[0].content, [], "content 非法时按空内容块走，ESC 重发不会炸");

  assert.deepStrictEqual(queueItemsFromWire(undefined), []);
  assert.deepStrictEqual(queueItemsFromWire([null, {}, { placement: "queued" }]), [], "没有 id 的项直接跳过");
  assert.deepStrictEqual(queueItemsFromWire([{ id: "x", placement: "别的" }]), [], "未知 placement 不当用户消息");
}
console.log("queueView: 非法输入与未知 placement ✓");

// ---------- 6. 原始内容块：ESC 重发要靠它（含图片） ----------
{
  const wireContent = [
    { type: "text", text: "看这张图" },
    { type: "image", attachment: { attachmentId: "sha256:x" } },
  ];
  const entries = queueItemsFromInbox({
    "next-turn": [{ id: "q7", content: wireContent, source: { kind: "user" } }],
  });
  assert.deepStrictEqual(entries[0].content, wireContent, "没有本地记录时应回退到线上内容块");
  assert.strictEqual(entries[0].view.hasMedia, true);

  const localContent = [{ type: "text", text: "本地原文" }];
  const withLocal = queueItemsFromInbox(
    { "next-turn": [{ id: "q8", content: wireContent, source: { kind: "user", rpcId: "rpc-1" } }] },
    () => ({ text: "本地原文", attachments: [], content: localContent }),
  );
  assert.deepStrictEqual(withLocal[0].content, localContent, "有本地记录时应用本地内容块");
  assert.strictEqual(withLocal[0].view.text, "本地原文");
}
console.log("queueView: 原始内容块选择 ✓");

// ---------- 7. 接线：两条通道在宿主侧真的都被消费 ----------
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /case "inbox"/.test(controller) && /queueItemsFromInbox\(value/.test(controller),
    "新通道：`inbox` 投影必须有分支（没有它 = 待发列表恒空）",
  );
  assert.ok(
    /frame\.type === "queue"/.test(controller) && /queueItemsFromWire\(frame\.items/.test(controller),
    "旧通道：queue 帧分支必须保留（服务端 2026-09-09 之前的那一版还在用它）",
  );
  assert.ok(
    /value\.queues \?\? \{\}/.test(controller) && /queueItemsFromWire\(queue/.test(controller),
    "旧通道：baseline 的 queues 也必须保留（冷启动只有它）",
  );
  assert.ok(
    /sessionPatch\(this\.sessionSource\(scope\), \["queueItems"\]\)/.test(controller),
    "两条通道都要汇到同一个 patch（下游只认一个视图模型）——字段名与折返口径走 " +
      "`dsh/sessionView.ts` 的字段表，不再是手写的 `patch: { queueItems: … }`",
  );
}
console.log("queueView: 宿主侧两条通道接线 ✓");

console.log("\nqueueView: all assertions passed");
