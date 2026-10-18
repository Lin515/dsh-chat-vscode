/**
 * 队列消息「取回重新编辑」的**行为级**回归（驱动真 `ChatController`，离线、无网络、
 * 无 token、亚秒级）。vscode 由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`。
 *
 * 用户报障的现场：**带附件的排队消息取回重编，附件没了**（只剩正文回输入框，并弹
 * 一句「附件无法还原」）。
 *
 * 根因（本文件在修复前必须红）：`editQueuedMessage` 先 `await updateQueueRemove`，
 * **之后**才去读 `scope.queueOrigin.get(itemId)`。而摘除一旦生效，服务端会立刻推
 * 新的 `inbox` 投影（旧服务端是 `queue` 帧）——那条投影经 `syncQueue` **整表重建**
 * 队列来源索引（`queueOrigin.clear()`），被摘掉的那一项自然不在里面。于是回填时
 * 原文与附件双双落空，只剩投影里的线上正文，附件则按「找不到原始记录」处理。
 * RPC 回显**允许**先到（跟随流与控制流是两条 socket）——本文件用「先推空队列再 resolve」
 * 的排列复现了它，另有「resolve 之后才推」的差分对照把因果钉在时序上。实际发生率未测，
 * 这里只断言「这个排列成立时结果必须正确」。
 *
 * 修法（语义不变，仍是 remove 成功 → 回填）：**在 await 之前**把这一项的原文 / 附件 /
 * 内容块与草稿键一次抓好；remove 失败不动草稿也不动缓存（可重试）；await 期间切了
 * 会话就把内容写回**原来那条会话**的草稿，绝不写进新会话的输入框。
 *
 * 三条通道都要覆盖（队列来源有两条、附件来源有一条）：
 * - 新通道 `inbox` 投影（当前服务端）；
 * - 旧通道 `{type:'queue', items}` 帧（2026-09-09 之前的服务端）；
 * - 附件来源：本地提交记录（`submissions`，扩展没重载过）与 durable 内容块
 *   （扩展重载 / 记录被 TTL 淘汰：文件块只有 `attachmentId` 没有回执，恢复不了；
 *   图片块能用 `session/attachment` 换回字节）。
 */
import assert from "node:assert";
import type { Attachment } from "../src/shared/chat";

process.on("unhandledRejection", (error) => {
  console.error("[queueRestore] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");

const S1 = "session-one";
const S2 = "session-two";
const TEXT = "原始问题";

/** 本地已提交的附件（文件带上传回执、图片带 data URL）——「取回」要还原的就是它们。 */
const IMAGE: Attachment = {
  id: "a-img",
  kind: "image",
  name: "图.png",
  dataUrl: "data:image/png;base64,AAAA",
  bytes: 3,
};
const FILE: Attachment = {
  id: "a-file",
  kind: "file",
  name: "报告.pdf",
  path: "C:\\ws\\报告.pdf",
  upload: { status: "ready", receiptId: "rcpt-1" },
};
/** 输入框里本来就有的一枚附件：回填是**追加**，不能把它弄丢、也不能重复。 */
const KEEP: Attachment = {
  id: "a-keep",
  kind: "file",
  name: "旧.txt",
  path: "C:\\ws\\旧.txt",
  upload: { status: "ready", receiptId: "rcpt-keep" },
};

/** `rememberSubmission` 记的是**装配后**的内容块（`buildPromptContent` 的 PromptContentPart）。 */
const SUBMITTED_CONTENT = [
  { type: "image", mediaType: "image/png", data: "AAAA", name: "图.png" },
  { type: "file", receiptId: "rcpt-1" },
  { type: "text", text: TEXT },
];

/**
 * `inbox` 投影回来的是 durable 形态（`protocol.ts` 的 `ImageBlock` / `FileBlock`）：
 * 图片是 `attachment{attachmentId,mediaType,bytes,name}`、文件是
 * `attachment{attachmentId,name,bytes}`——**都没有上传回执**。
 */
const DURABLE_CONTENT = [
  { type: "image", attachment: { attachmentId: "sha256:img-1", mediaType: "image/png", bytes: 3, name: "图.png" } },
  { type: "file", attachment: { attachmentId: "sha256:file-1", name: "报告.pdf", bytes: 10 } },
  { type: "text", text: TEXT },
];

/** 只有图片的 durable 内容：重载后**完全**可还原（字节经 `session/attachment` 取回）。 */
const DURABLE_IMAGE_ONLY = [
  { type: "image", attachment: { attachmentId: "sha256:img-1", mediaType: "image/png", bytes: 3, name: "图.png" } },
  { type: "text", text: TEXT },
];

/** 只有文件的 durable 内容：没有上传回执，**无法**还原成能发送的芯片。 */
const DURABLE_FILE_ONLY = [
  { type: "file", attachment: { attachmentId: "sha256:file-1", name: "报告.pdf", bytes: 10 } },
  { type: "text", text: TEXT },
];

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

interface Internals {
  client: unknown;
  connection: string;
  scopes: Map<string, unknown>;
  drafts: Map<string, string>;
  /** 附件草稿的账本（`dsh/attachmentLifecycle.ts`）：读列表、整份替换、追加。 */
  attachments: {
    list(key: string | undefined): readonly Attachment[];
    add(key: string, attachments: readonly Attachment[]): void;
    replace(key: string, attachments: readonly Attachment[]): void;
  };
  subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
  bindView(viewId: string): void;
  openSession(viewId: string, sessionId: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  rememberSubmission(
    requestId: string,
    text: string,
    content: unknown[],
    attachments: Attachment[],
    sessionId: string,
  ): void;
  onControlFrame(frame: Record<string, unknown>): void;
  /** 通知队列（宿主权威的那一份，见 `docs/design-notifications.md`）。 */
  notifications: { visible(sessionId: string | undefined): { text: string; count: number }[] };
}

/** inbox 投影的一条待发消息（新通道）。 */
function inboxItem(id: string, rpcId: string, content: unknown[]) {
  return { id, source: { kind: "user", rpcId }, content };
}

/** 旧通道的一条 `SessionQueuedItem`。 */
function wireItem(id: string, rpcId: string, content: unknown[]) {
  return { id, placement: "queued", rpcId, message: { content } };
}

const fakeServer = () => ({
  externalUrl: undefined,
  commandConfigured: true,
  onHeartbeat() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = () => {
  const map = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

interface Harness {
  c: Internals;
  frames: Captured[];
  requests: { method: string; params?: unknown }[];
  /** 假客户端本身（场景要临时改它的行为，例如让图片字节取不到）。 */
  client: { request: (method: string, params?: unknown) => Promise<unknown> };
  /** 每一次 `updateQueueRemove` 调用（`{sessionId,itemId}`）——「不许摘」的断言看它。 */
  removes: { sessionId: string; itemId: string }[];
  /** 每条队列来源的水位（投影 store 要求严格递增）。 */
  seq: { n: number };
  /** 服务端 remove 的行为：默认成功。 */
  remove: (sessionId: string, itemId: string) => Promise<{ accepted: true }>;
  /** 把一条 `inbox` 投影推给会话（真实入口：`projection` 增量帧）。 */
  pushInbox(sessionId: string, items: unknown[]): void;
  /** 把一条旧通道 `queue` 帧推给会话。 */
  pushQueue(sessionId: string, items: unknown[]): void;
  /** 场景建好后的会话域（`scene` 填）。 */
  scope?: unknown;
}

function harness(): Harness {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  const requests: { method: string; params?: unknown }[] = [];
  const c = controller as unknown as Internals;
  const subscribe = (
    controller as unknown as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  void subscribe;

  // 假客户端随后补上（`client` 是场景可临时改的字段），所以这里先断言成 Harness
  const state = {
    c,
    frames,
    requests,
    removes: [] as { sessionId: string; itemId: string }[],
    seq: { n: 0 },
    remove: async () => ({ accepted: true }),
    pushInbox(sessionId: string, items: unknown[]) {
      c.onControlFrame({
        type: "projection",
        sessionId,
        key: "inbox",
        value: { "next-turn": items, "next-step": [] },
        seq: ++state.seq.n,
      });
    },
    pushQueue(sessionId: string, items: unknown[]) {
      c.onControlFrame({ type: "queue", sessionId, items });
    },
  } as Harness;

  const client = {
    request: async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "commands/list") return [];
      // durable 图片句柄 → base64 字节（与回放图片同一条 RPC）
      if (method === "session/attachment") return { data: "AAAA", attachment: {} };
      return undefined;
    },
    sessionProjections: async () => ({ values: {} }),
    getJson: async () => undefined,
    settingsDescribe: async () => ({ namespaces: [] }),
    followSession: () => ({ cancel() {} }),
    followJobs: () => ({ cancel() {} }),
    followControl: () => ({ cancel() {} }),
    updateQueueRemove: (sessionId: string, itemId: string) => {
      state.removes.push({ sessionId, itemId });
      return state.remove(sessionId, itemId);
    },
  };
  state.client = client;
  c.client = client as never;
  c.connection = "connected";
  return state;
}

/** 铺一条排队消息：本地提交记录（可选）+ 队列来源（新 / 旧通道二选一）。 */
async function scene(options: {
  remember: boolean;
  channel: "inbox" | "wire";
  content: unknown[];
  /** 本地提交记录里的附件（默认图片 + 文件各一枚）。 */
  local?: Attachment[];
}): Promise<Harness> {
  const h = harness();
  h.c.bindView("v1");
  await h.c.openSession("v1", S1);
  const scope = h.c.scopes.get(S1);
  assert.ok(scope, "S1 的域应已建立（回路自身前提）");
  if (options.remember) {
    h.c.rememberSubmission("r1", TEXT, SUBMITTED_CONTENT, options.local ?? [IMAGE, FILE], S1);
  }
  const item = { inbox: inboxItem, wire: wireItem }[options.channel]("q1", "r1", options.content);
  if (options.channel === "inbox") h.pushInbox(S1, [item]);
  else h.pushQueue(S1, [item]);
  h.c.drafts.set(S1, "已有草稿");
  h.c.attachments.replace(S1, [{ ...KEEP }]);
  h.frames.length = 0;
  // 返回**同一个** harness 对象：场景里的 `remove` 覆写要落到客户端闭包持有的那份上
  h.scope = scope;
  return h;
}

const draftOf = (h: Harness, key: string) => h.c.drafts.get(key) ?? "";
const attachmentsOf = (h: Harness, key: string) => [...h.c.attachments.list(key)];
const namesOf = (list: Attachment[]) => list.map((a) => a.id).sort().join(",");
/**
 * 某个窗口**最近一次**收到的通知镜像（宿主权威队列按视图过滤后下发的 `notifications` 补丁）。
 *
 * 通知取代了从前的瞬时 `toast` 帧：断言口径不变（「这一条该不该出现」），只是通道换了。
 */
const noticesOf = (h: Harness, target: string): { text: string; count: number }[] => {
  let latest: { text: string; count: number }[] = [];
  for (const f of h.frames) {
    if (f.target !== target) continue;
    const patch = (f.frame as { patch?: { notifications?: { text: string; count: number }[] } }).patch;
    if (patch?.notifications) latest = patch.notifications;
  }
  return latest;
};
const toastsOf = (h: Harness, target: string) => noticesOf(h, target).map((notice) => notice.text);

/** S1 的域（队列项与来源索引都挂在它上面）。 */
const scopeOf = (h: Harness) =>
  h.c.scopes.get(S1) as { queueItems: { id: string }[]; queueOrigin: Map<string, unknown> };

/**
 * 「这一条根本不该被动过」的整套断言：没摘队列、队列项与来源索引都在、原草稿与附件不变、
 * 并且**说清楚了**为什么没取回（提示按会话投递）。
 */
function assertKeepsQueue(h: Harness, label: string): void {
  const scope = scopeOf(h);
  assert.strictEqual(h.removes.length, 0, `${label}：不许调用 updateQueueRemove`);
  assert.deepStrictEqual(scope.queueItems.map((entry) => entry.id), ["q1"], `${label}：队列项必须还在`);
  assert.ok(scope.queueOrigin.has("q1"), `${label}：队列来源索引必须还在（还能再点一次）`);
  assert.strictEqual(draftOf(h, S1), "已有草稿", `${label}：原草稿必须一字不动`);
  assert.strictEqual(namesOf(attachmentsOf(h, S1)), "a-keep", `${label}：原附件必须一枚不差`);
  assert.ok(
    toastsOf(h, "v1").includes("@queueAttachmentsLost"),
    `${label}：要说清楚「附件还原不了、消息留在队列里」：${toastsOf(h, "v1").join(" / ")}`,
  );
}

console.log("queueRestore: 驱动真控制器（offline stub）");

// ---------- 场景零（差分对照）：回显**迟到**（RPC resolve 之后才推空队列）----------
// 同一份代码、同样的输入，只把「摘除回显」的时刻挪到 resolve 之后：修复前这条是绿的
// （读缓存时还没被清），场景一才是红的——两者的差别就是「回显早于读取」这一个变量，
// 于是把因果钉在「先 await 后读缓存」上，而不是别的什么东西。
{
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT });
  h.remove = async () => ({ accepted: true });
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  h.pushInbox(S1, []); // 回显此刻才到
  assert.strictEqual(
    namesOf(attachmentsOf(h, S1)),
    "a-file,a-img,a-keep",
    `回显迟到时附件必须还原（差分对照）：${namesOf(attachmentsOf(h, S1))}`,
  );
  console.log("  场景零（对照）：回显迟到 → 附件还原 ✓");
}

// ---------- 场景一：inbox 投影的摘除回显先到，附件与正文都要活下来 ----------
{
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT });
  h.remove = async () => {
    // 服务端 remove 生效后立刻推新投影：队列里这条没了（该帧先于 RPC 的 resolve 到达）
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  assert.strictEqual(draftOf(h, S1), `已有草稿\n${TEXT}`, `正文应回填草稿：${JSON.stringify(draftOf(h, S1))}`);
  assert.strictEqual(
    namesOf(attachmentsOf(h, S1)),
    "a-file,a-img,a-keep",
    `原有附件 + 两个还原的附件都在：${namesOf(attachmentsOf(h, S1))}`,
  );
  assert.strictEqual(toastsOf(h, "v1").length, 0, `不该报「附件无法还原」：${toastsOf(h, "v1").join(" / ")}`);
  console.log("  场景一：inbox 回显先到 → 原文与附件都回填 ✓");
}

// ---------- 场景二：旧通道（queue 帧）同一条路 ----------
{
  const h = await scene({ remember: true, channel: "wire", content: DURABLE_CONTENT });
  h.remove = async () => {
    h.pushQueue(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  assert.strictEqual(draftOf(h, S1), `已有草稿\n${TEXT}`, `旧通道回填正文：${JSON.stringify(draftOf(h, S1))}`);
  assert.strictEqual(
    namesOf(attachmentsOf(h, S1)),
    "a-file,a-img,a-keep",
    `旧通道也要还原附件：${namesOf(attachmentsOf(h, S1))}`,
  );
  console.log("  场景二：旧 wire 通道 → 同一条回填路径 ✓");
}

// ---------- 场景三：await 期间切了会话 → 不许写进新会话 ----------
{
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.remove = async () => {
    await gate;
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  const editing = h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  await h.c.openSession("v1", S2); // 用户等不及，切到了另一条会话
  release?.();
  await editing;

  assert.strictEqual(draftOf(h, S2), "", `新会话的草稿必须原样：${JSON.stringify(draftOf(h, S2))}`);
  assert.strictEqual(attachmentsOf(h, S2).length, 0, `新会话的附件必须原样：${namesOf(attachmentsOf(h, S2))}`);
  assert.strictEqual(
    draftOf(h, S1),
    `已有草稿\n${TEXT}`,
    `内容要落在原会话，别丢：${JSON.stringify(draftOf(h, S1))}`,
  );
  assert.strictEqual(
    namesOf(attachmentsOf(h, S1)),
    "a-file,a-img,a-keep",
    `原会话的附件也要还原：${namesOf(attachmentsOf(h, S1))}`,
  );
  const painted = h.frames.filter(
    (f) => f.target === "v1" && String((f.frame.patch as { draft?: unknown } | undefined)?.draft ?? "").includes(TEXT),
  );
  assert.strictEqual(painted.length, 0, "切换后的窗口不得收到原会话的草稿 patch（会画进新会话的输入框）");
  console.log("  场景三：await 期间切会话 → 写回原会话、新会话不受污染 ✓");
}

// ---------- 场景四：remove 失败 → 草稿与队列来源都不动（可重试） ----------
{
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT });
  h.remove = async () => {
    throw new Error("session/queue-item-not-found");
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  assert.strictEqual(draftOf(h, S1), "已有草稿", `失败不得回填：${JSON.stringify(draftOf(h, S1))}`);
  assert.strictEqual(namesOf(attachmentsOf(h, S1)), "a-keep", `失败不得塞附件：${namesOf(attachmentsOf(h, S1))}`);
  h.remove = async () => ({ accepted: true });
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  assert.strictEqual(
    draftOf(h, S1),
    `已有草稿\n${TEXT}`,
    `失败后重试仍要能还原（缓存没被清）：${JSON.stringify(draftOf(h, S1))}`,
  );
  console.log("  场景四：remove 失败 → 草稿/缓存不动，重试可还原 ✓");
}

// ---------- 场景五（对照）：重载但**完全**可还原（纯 durable 图片）→ 照常取回 ----------
{
  const h = await scene({ remember: false, channel: "inbox", content: DURABLE_IMAGE_ONLY });
  h.remove = async () => {
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  assert.strictEqual(h.removes.length, 1, `完全可还原时必须摘除：${JSON.stringify(h.removes)}`);
  assert.strictEqual(draftOf(h, S1), `已有草稿\n${TEXT}`, `重载后退回线上正文：${JSON.stringify(draftOf(h, S1))}`);
  const list = attachmentsOf(h, S1);
  const image = list.find((a) => a.kind === "image");
  assert.ok(image, `durable 图片块应换成图片附件：${namesOf(list)}`);
  assert.strictEqual(image?.dataUrl, "data:image/png;base64,AAAA", "图片字节来自 session/attachment");
  assert.ok(
    h.requests.some((r) => r.method === "session/attachment"),
    "还原 durable 图片必须走 session/attachment",
  );
  assert.strictEqual(toastsOf(h, "v1").length, 0, `完全可还原时不该有丢失提示：${toastsOf(h, "v1").join(" / ")}`);
  assert.deepStrictEqual(
    scopeOf(h).queueItems.map((entry) => entry.id),
    [],
    "摘除成功后队列里不该还有这一项",
  );
  console.log("  场景五（对照）：重载后完全可还原（纯图片）→ 照常取回 ✓");
}

// ---------- 场景六：草稿里已经有**同一份**附件 → 追加去重 ----------
{
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT });
  // 用户已经自己把那份文件重新加过一次（id 不同、回执相同）
  h.c.attachments.replace(S1, [
    { ...KEEP },
    { id: "a-again", kind: "file", name: "报告.pdf", path: "C:\\ws\\报告.pdf", upload: { status: "ready", receiptId: "rcpt-1" } },
  ]);
  h.remove = async () => {
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  const list = attachmentsOf(h, S1);
  const sameReceipt = list.filter((a) => a.upload?.status === "ready" && a.upload.receiptId === "rcpt-1");
  assert.strictEqual(sameReceipt.length, 1, `同一份文件不许出现两次：${namesOf(list)}`);
  assert.strictEqual(list.length, 3, `keep + 用户那份 + 还原的图片：${namesOf(list)}`);
  assert.strictEqual(list.filter((a) => a.kind === "image").length, 1, `图片也要在：${namesOf(list)}`);
  console.log("  场景六：草稿里已有的同一份附件 → 追加去重 ✓");
}

// ---------- 场景七：同名同字节数的**两张不同图**不许合并（截图常都叫 image）----------
{
  const first: Attachment = { id: "img-a", kind: "image", name: "image", bytes: 3, dataUrl: "data:image/png;base64,AAAA" };
  const second: Attachment = { id: "img-b", kind: "image", name: "image", bytes: 3, dataUrl: "data:image/png;base64,BBBB" };
  const h = await scene({ remember: true, channel: "inbox", content: DURABLE_CONTENT, local: [first, second] });
  // 草稿里已经有第一张（同 id，应当去重）
  h.c.attachments.replace(S1, [{ ...first }]);
  h.remove = async () => {
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  const list = attachmentsOf(h, S1);
  const urls = list.filter((a) => a.kind === "image").map((a) => a.dataUrl).sort();
  assert.deepStrictEqual(
    urls,
    ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
    `同名同字节数的两张不同图必须都在：${namesOf(list)}`,
  );
  console.log("  场景七：同名同字节数的两张不同图 → 不合并、同 id 仍去重 ✓");
}

// ---------- 场景八：同路径但**不是同一份**（换了回执 / 没有回执）不许合并 ----------
{
  const WS = "C:\\ws\\a.txt";
  const uploaded: Attachment = {
    id: "f-1",
    kind: "file",
    name: "a.txt",
    path: WS,
    upload: { status: "ready", receiptId: "rcpt-1" },
  };
  const uploading: Attachment = {
    id: "u-1",
    kind: "file",
    name: "a.txt",
    path: WS,
    upload: { status: "uploading", loaded: 0 },
  };
  // 同一个文件被改了再传（路径相同、回执不同），以及一枚还没有回执的
  const reuploaded: Attachment = { ...uploaded, id: "f-2", upload: { status: "ready", receiptId: "rcpt-2" } };
  const noReceipt: Attachment = { id: "u-2", kind: "file", name: "a.txt", path: WS };
  const h = await scene({
    remember: true,
    channel: "inbox",
    content: DURABLE_CONTENT,
    local: [uploaded, uploading, reuploaded, noReceipt],
  });
  h.c.attachments.replace(S1, [{ ...uploaded }, { ...uploading }]);
  h.remove = async () => {
    h.pushInbox(S1, []);
    return { accepted: true };
  };
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");

  const list = attachmentsOf(h, S1);
  assert.deepStrictEqual(
    list.map((a) => a.id).sort(),
    ["f-1", "f-2", "u-1", "u-2"],
    `同路径但身份不同（换了回执 / 没回执）不许合并：${namesOf(list)}`,
  );
  console.log("  场景八：同路径不同回执 / 无回执 → 不合并、同回执仍去重 ✓");
}

// ---------- 场景九：还原不了时切了会话 → 队列一条不动、提示不许画进另一条会话 ----------
{
  const h = await scene({ remember: false, channel: "inbox", content: DURABLE_CONTENT });
  // 图片字节取不到（RPC 失败 / 离线）：让它挂在闸门上，好在「预备还原」期间切会话
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  h.client.request = async (method: string) => {
    if (method === "commands/list") return [];
    if (method === "session/attachment") await gate;
    return undefined;
  };
  const editing = h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  await h.c.openSession("v1", S2);
  release?.();
  await editing;

  assert.strictEqual(draftOf(h, S2), "", `新会话的草稿必须原样：${JSON.stringify(draftOf(h, S2))}`);
  assert.strictEqual(attachmentsOf(h, S2).length, 0, `新会话的附件必须原样：${namesOf(attachmentsOf(h, S2))}`);
  assert.strictEqual(draftOf(h, S1), "已有草稿", `队列留着时原草稿也不许动：${JSON.stringify(draftOf(h, S1))}`);
  assert.strictEqual(h.removes.length, 0, "还原不了时不许摘队列（切了会话也一样）");
  // 通知按**会话**归属：窗口切到新会话之后，这条失败不该出现在它的镜像里。
  // （断言升级过：从前只查「有没有 toast 帧」，现在查「这个窗口此刻可见的通知」，
  //  切会话真的换了过滤范围，才证得出归属没越界。）
  assert.deepStrictEqual(noticesOf(h, "v1"), [], `还原失败的提示不得画进新会话：${toastsOf(h, "v1").join(" / ")}`);
  assert.ok(
    h.c.notifications.visible(S1).some((notice) => notice.text === "@queueAttachmentsLost"),
    "失败要归属**发起取回的那个会话**（S1），不是完成时窗口看着的 S2",
  );
  console.log("  场景九：还原不了 + 切会话 → 队列保留、提示不越会话 ✓");
}

// ---------- 场景十：durable 文件缺回执 → 整条不动（不摘队列、不动草稿） ----------
{
  const h = await scene({ remember: false, channel: "inbox", content: DURABLE_FILE_ONLY });
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  assertKeepsQueue(h, "durable 文件缺回执");
  console.log("  场景十：durable 文件缺回执 → 不摘队列、原样保留 + 提示 ✓");
}

// ---------- 场景十一：图片字节取不到 → 同样整条不动（不是「摘了再只还原文本」）----------
{
  const h = await scene({ remember: false, channel: "inbox", content: DURABLE_IMAGE_ONLY });
  h.client.request = async (method: string) => (method === "commands/list" ? [] : undefined);
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  assertKeepsQueue(h, "图片字节取不到");
  console.log("  场景十一：图片字节取不到 → 不摘队列、原样保留 + 提示 ✓");
}

// ---------- 场景十二：文件 + 图片混在一起 → 不做「部分摘除」 ----------
{
  const h = await scene({ remember: false, channel: "inbox", content: DURABLE_CONTENT });
  await h.c.handle({ type: "queueEdit", id: "q1" }, "v1");
  assertKeepsQueue(h, "文件 + 图片混合");
  assert.strictEqual(
    attachmentsOf(h, S1).some((a) => a.kind === "image"),
    false,
    "既然不摘队列，图片也不许先塞进草稿",
  );
  console.log("  场景十二：文件 + 图片混合 → 不部分摘除、一枚都不塞 ✓");
}

console.log("queueRestore: 摘除回显先到 / 切会话 / 失败 / 完全可还原才摘 四条边界都成立 ✓");
