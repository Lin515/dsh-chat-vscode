/**
 * 图片链路的**适配器侧**断言：句柄怎么进来、字节怎么补回去。
 *
 * 这条链路的失效方式全是静默的，而且**只在真会话里才暴露**：
 * - 用户消息的 image 块里是 `attachmentId`（不透明 `sha256:…`），不是字节——
 *   不换成 data URL，界面上就只有一个文件名芯片（此前正是如此）；
 * - 字节是**异步**补的（一次 `session/attachment` RPC），补的方式是给消息的
 *   附件挂 `dataUrl` 再发 `message/upsert`；
 * - 补的时候**顺序必须对齐**：`loadImages` 的回调与 `refs` 等长，失败位是空串。
 *   一旦实现里「过滤掉失败项」，后面几张图会整体前移——把 A 的图贴到 B 的位置上，
 *   而界面看起来完全正常（这就是本次必须钉住的那条）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { SessionAdapter, type ImageRef } from "../src/dsh/adapter";
import type { MessageView } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";

/** 收集帧（与 historyReplay.test.ts 同一套：深拷贝，模拟 postMessage）。 */
function harness() {
  const frames: HostToWebview[] = [];
  const adapter = new SessionAdapter((original) => {
    frames.push(structuredClone(original) as HostToWebview);
  });
  /** 某条消息**最后**一次下发的样子（upsert 会覆盖前一次）。 */
  const lastMessage = (id: string): MessageView | undefined => {
    let found: MessageView | undefined;
    for (const frame of frames) {
      if (frame.type === "message/upsert" && frame.message.id === id) found = frame.message;
    }
    return found;
  };
  return { adapter, frames, lastMessage };
}

const imageBlock = (id: string, name: string, mediaType: string, width = 1024, height = 768) => ({
  type: "image",
  attachment: { attachmentId: `sha256:${id}`, mediaType, bytes: 1234, width, height, name },
});

// ---------- 1. 用户消息里的图片：句柄与元数据都要带出来 ----------
{
  const { adapter, frames, lastMessage } = harness();
  const asked: ImageRef[][] = [];
  adapter.loadImages = (refs, done) => {
    asked.push(refs);
    done([`data:image/jpeg;base64,AAA`]);
  };
  adapter.applyEvent({
    type: "user/message",
    seq: 1,
    time: 1000,
    data: {
      id: "u1",
      role: "user",
      content: [imageBlock("cat", "cat.jpg", "image/jpeg"), { type: "text", text: "看看这张" }],
      source: { kind: "user" },
    },
  });

  const message = lastMessage("u:1");
  assert.ok(message, "用户消息要落进消息流");
  const attachment = message!.attachments?.[0];
  assert.strictEqual(attachment?.kind, "image", "image 块要落成 image 附件");
  assert.strictEqual(attachment?.name, "cat.jpg", "附件名用于降级时的文件名芯片与 alt");
  assert.strictEqual(attachment?.attachmentId, "sha256:cat", "必须带 durable 句柄，否则取不到字节");
  assert.strictEqual(attachment?.mediaType, "image/jpeg", "媒体类型来自句柄（服务端归一化过，别按扩展名猜）");
  assert.strictEqual(attachment?.width, 1024, "宽高用于字节到达前占位");
  assert.strictEqual(attachment?.height, 768);
  assert.deepStrictEqual(
    asked.map((refs) => refs.map((ref) => ref.attachmentId)),
    [["sha256:cat"]],
    "适配器要把句柄交给注入的装载回调",
  );
  assert.strictEqual(
    attachment?.dataUrl,
    "data:image/jpeg;base64,AAA",
    "字节回来要挂到附件上（界面据此画缩略图）",
  );
  assert.ok(
    frames.some((frame) => frame.type === "message/upsert" && frame.message.id === "u:1"),
    "补字节后要重发这条消息（附件挂在消息上，没有更细的帧）",
  );
  console.log("image-attachments: 用户消息图片的句柄与字节回填 ✓");
}

// ---------- 2. 顺序对齐：中间一张取不到，不能把后面的图贴到它位置上 ----------
{
  const { adapter, lastMessage } = harness();
  adapter.loadImages = (_refs, done) => {
    // 第二张失败（空串占位）——`loadAttachmentImages` 的契约是「与 refs 等长」
    done(["", "data:image/png;base64,BBB"]);
  };
  adapter.applyEvent({
    type: "user/message",
    seq: 1,
    time: 1000,
    data: {
      id: "u1",
      role: "user",
      content: [imageBlock("first", "first.png", "image/png"), imageBlock("second", "second.png", "image/png")],
      source: { kind: "user" },
    },
  });
  const attachments = lastMessage("u:1")?.attachments ?? [];
  assert.strictEqual(attachments.length, 2, "两张图都要留下（取不到的也不删）");
  assert.strictEqual(attachments[0].name, "first.png");
  assert.strictEqual(attachments[0].dataUrl, undefined, "失败的那张留空 → 界面退回文件名芯片");
  assert.strictEqual(attachments[1].name, "second.png");
  assert.strictEqual(
    attachments[1].dataUrl,
    "data:image/png;base64,BBB",
    "成功的字节必须落在**自己的**位置上（错位会把 A 的图贴到 B 上，且看起来很正常）",
  );
  console.log("image-attachments: 位次对齐（失败位留空、不错位）✓");
}

// ---------- 3. 纯图片消息不整条消失（没有正文也要渲染） ----------
{
  const { adapter, lastMessage } = harness();
  adapter.applyEvent({
    type: "user/message",
    seq: 1,
    time: 1000,
    data: { id: "u1", role: "user", content: [imageBlock("only", "only.png", "image/png")], source: { kind: "user" } },
  });
  const message = lastMessage("u:1");
  assert.ok(message, "只有图片、没有文字的消息也要出现（此前整条被跳过）");
  assert.strictEqual(message!.text, "");
  assert.strictEqual(message!.attachments?.length, 1);
  console.log("image-attachments: 纯图片消息不丢 ✓");
}

// ---------- 4. 文件块仍是文件附件（图片化不能把文件也带上） ----------
{
  const { adapter, lastMessage } = harness();
  let asked = 0;
  adapter.loadImages = () => {
    asked += 1;
  };
  adapter.applyEvent({
    type: "user/message",
    seq: 1,
    time: 1000,
    data: {
      id: "u1",
      role: "user",
      content: [
        { type: "file", attachment: { attachmentId: "sha256:doc", name: "spec.pdf", bytes: 100 } },
        imageBlock("pic", "pic.png", "image/png"),
      ],
      source: { kind: "user" },
    },
  });
  const attachments = lastMessage("u:1")?.attachments ?? [];
  assert.deepStrictEqual(
    attachments.map((a) => a.kind),
    ["file", "image"],
    "文件块仍是 file 附件（界面上是芯片）",
  );
  assert.strictEqual(attachments[0].attachmentId, undefined, "文件没有可显示的字节，不取");
  assert.strictEqual(asked, 1, "只为图片要字节");
  console.log("image-attachments: 文件块不参与取字节 ✓");
}

// ---------- 5. 助手消息里的图片块：空位留在数组里，由界面决定画不画 ----------
{
  const { adapter, frames } = harness();
  adapter.loadImages = (_refs, done) => {
    done(["", "data:image/png;base64,CCC"]);
  };
  adapter.applyEvent({ type: "turn/start", seq: 0, time: 900, data: { turn: 1 } });
  adapter.applyEvent({
    type: "assistant/message",
    seq: 1,
    time: 1000,
    data: {
      turn: 1,
      step: 0,
      message: {
        id: "m1",
        role: "assistant",
        content: [imageBlock("a", "a.png", "image/png"), imageBlock("b", "b.png", "image/png")],
      },
    },
  });
  const segments = frames
    .filter((frame): frame is Extract<HostToWebview, { type: "message/segment" }> => frame.type === "message/segment")
    .map((frame) => frame.segment)
    .filter((segment) => segment.kind === "images");
  assert.ok(segments.length >= 1, "助手消息里的 image 块要落成 images 段");
  const last = segments.at(-1) as Extract<(typeof segments)[number], { kind: "images" }>;
  assert.deepStrictEqual(
    last.images,
    ["", "data:image/png;base64,CCC"],
    "图库保留位次（空位由界面跳过，不在这里压缩数组）",
  );
  console.log("image-attachments: 助手图片段落成 images 段（位次保真）✓");
}

// ---------- 6. 并发闸门：一批一批取，不是几十个 RPC 一起涌 ----------
//
// 打开一个塞满图片的历史会话时，回放会对每条消息各发一次 `session/attachment`。
// 不设闸门的话，几十个并发 RPC 加几十 MB base64 会一起压到界面上。
{
  const { adapter } = harness();
  let active = 0;
  let peak = 0;
  const finish: (() => void)[] = [];
  adapter.loadImages = (_refs, done) => {
    active += 1;
    peak = Math.max(peak, active);
    finish.push(() => {
      active -= 1;
      done([""]);
    });
  };
  for (let index = 0; index < 6; index += 1) {
    adapter.applyEvent({
      type: "user/message",
      seq: index,
      time: 1000 + index,
      data: {
        id: `u${index}`,
        role: "user",
        content: [imageBlock(`p${index}`, `p${index}.png`, "image/png")],
        source: { kind: "user" },
      },
    });
  }
  assert.strictEqual(active, 2, `同时最多两批在取（闸门生效），实际 ${active}`);
  // 逐个放行：每放完一批，队列里补上一批
  while (finish.length) finish.shift()!();
  assert.strictEqual(peak, 2, `并发峰值必须被闸门压住，实际 ${peak}`);
  assert.strictEqual(active, 0, "全部批次都要收尾（没有卡在队列里的）");
  console.log("image-attachments: 取字节有并发闸门 ✓");
}

console.log("\nimage-attachments: all assertions passed");
