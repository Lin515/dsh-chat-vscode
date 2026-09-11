/**
 * 离线验证队列项的视图映射（`SessionQueuedItem` → `QueuedMessageView`）。
 *
 * 重点不是「能不能解析文本」，而是**必须优先用客户端存的原始输入**：
 * 提交给服务端的正文已经把文件/目录上下文内联进去了，直接回填会把那一大坨
 * 倒回输入框。这条正是「重新编辑」功能的正确性基础。
 *
 * 运行：npm run test
 */
import assert from "node:assert";
import { queueItems, queueItemsView } from "../src/dsh/queueView";

const originText = "把这两个文件的启动逻辑合并到一个入口";
const wireText = "文件 src/server/index.ts 的内容：\n```\n...\n```\n\n" + originText;

// 1. 有原始记录：文本回退到用户原话，并带上附件数量
{
  const views = queueItemsView(
    [
      {
        id: "q1",
        placement: "queued",
        rpcId: "rpc-1",
        message: { content: [{ type: "text", text: wireText }] },
      },
    ],
    (rpcId) => (rpcId === "rpc-1" ? { text: originText, attachments: [{ id: "a" }, { id: "b" }] } : undefined),
  );
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].text, originText, "必须用原始输入，而不是含内联上下文的线上文本");
  assert.strictEqual(views[0].attachments, 2);
  assert.strictEqual(views[0].rpcId, "rpc-1");
  assert.strictEqual(views[0].placement, "queued");
}
console.log("queueView: 有原始记录 → 回退到用户原话 ✓");

// 2. 没有原始记录（扩展重载过）：退回线上文本，至少有内容可编辑
{
  const views = queueItemsView(
    [{ id: "q2", placement: "queued", rpcId: "rpc-gone", message: { content: [{ type: "text", text: wireText }] } }],
    () => undefined,
  );
  assert.strictEqual(views[0].text, wireText);
  assert.strictEqual(views[0].attachments, undefined);
}
console.log("queueView: 无原始记录 → 退回线上文本 ✓");

// 3. 没有 rpcId（服务端没带）：同样退回线上文本，不崩
{
  const views = queueItemsView([
    { id: "q3", placement: "steering", message: { content: [{ type: "text", text: "插一句" }] } },
  ]);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].text, "插一句");
  assert.strictEqual(views[0].placement, "steering");
}
console.log("queueView: 缺 rpcId → 安全降级 ✓");

// 4. context 放置位不是用户消息：不下发（否则新会话一开场就是一堆「排队消息」）
{
  const views = queueItemsView([
    { id: "c1", placement: "context", message: { content: [{ type: "text", text: "MCP 服务器状态" }] } },
    { id: "q4", placement: "queued", message: { content: [{ type: "text", text: "真的消息" }] } },
  ]);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].id, "q4");
}
console.log("queueView: context 放置位被过滤 ✓");

// 5. 只有附件（无文本）：text 为空 + hasMedia，界面用「附件」占位
{
  const views = queueItemsView([
    { id: "q5", placement: "queued", message: { content: [{ type: "image", mediaType: "image/png", data: "x" }] } },
  ]);
  assert.strictEqual(views[0].text, "");
  assert.strictEqual(views[0].hasMedia, true);
}
console.log("queueView: 纯附件消息 ✓");

// 6. 多个文本块按顺序拼接；非法输入不崩
{
  const views = queueItemsView([
    { id: "q6", placement: "queued", message: { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } },
  ]);
  assert.strictEqual(views[0].text, "第一段\n第二段");
  assert.deepStrictEqual(queueItemsView(undefined), []);
  assert.deepStrictEqual(queueItemsView([null, {}, { placement: "queued" }]), [], "没有 id 的项直接跳过");
}
console.log("queueView: 多文本块与非法输入 ✓");

// 7. 原始内容块：本地没有记录时用队列项自带的（ESC 重发要靠它，含图片）
{
  const wireContent = [
    { type: "text", text: "看这张图" },
    { type: "image", mediaType: "image/png", data: "AAAA" },
  ];
  const entries = queueItems([
    { id: "q7", placement: "queued", message: { content: wireContent } },
  ]);
  assert.deepStrictEqual(entries[0].content, wireContent, "没有本地记录时应回退到线上内容块");
  assert.strictEqual(entries[0].view.hasMedia, true);

  // 有本地记录时以本地内容块为准（它才是我们当时真正提交的东西）
  const localContent = [{ type: "text", text: "本地原文" }];
  const withLocal = queueItems(
    [{ id: "q8", placement: "queued", rpcId: "rpc-8", message: { content: wireContent } }],
    () => ({ text: "本地原文", attachments: [], content: localContent }),
  );
  assert.deepStrictEqual(withLocal[0].content, localContent, "有本地记录时应用本地内容块");
  assert.strictEqual(withLocal[0].view.text, "本地原文");
}
console.log("queueView: 原始内容块选择 ✓");

console.log("\nqueueView: all assertions passed");
