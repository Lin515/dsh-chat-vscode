/**
 * 乐观回显（用户消息预渲染）的**行为级**回归：驱动真 `ChatController`（offline stub），
 * 只看发给窗口的帧与假客户端收到的调用。
 *
 * 口径（用户 2026-09-25）：
 * - 按下发送那一刻**同步**产生回显，早于任何 await（连拉起后台都还没开始）；
 * - **只收「已经发出去」的那一类**：按下那一刻 agent 空闲 ⇒ 这一次会立刻
 *   `session/prompt`，回显进**对话流**（插在本轮助手行之前——真实行将来落在哪它就插在哪，
 *   交接不跳位）；
 * - **运行中发送（排队 / 插话）根本不进账本**：那条还没发出去，唯一的去处是输入框上方的
 *   排队区，那里由服务端名册驱动、与改动前逐字相同。它成功走队列/插话那条老路，失败也走
 *   老口径（正文回输入框 + 原生提示）——本次改动不碰它；
 * - 交接**无闪烁**：落位帧早于收回帧、durable 行带同一个 `rpcId`、图片借本地那份字节。
 *   这条在**直播**与**重放**（follow 开窗快照 / 加载更早的历史）两条路上都成立；
 * - **失败不撤回**：那一行留在对话流里标成 `failed`（红框 + 重发 / 撤回 + 原因），
 *   正文不回输入框；跨会话切换**不丢**（能切回来接着操作），只有宿主重启才消失；
 * - 失败行是纯界面对象：不进会话内容，只有「重发」能把同一段内容再发一次。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）。
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.on("unhandledRejection", (error) => {
  console.error("[pendingEcho] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
import type { PendingMessageView } from "../src/shared/chat";

const CWD = "C:\\work\\demo";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 假服务端：会话作用域的 RPC 只认它自己创建过的 agent id（与真服务端同一条约束）。 */
function fakeClient(options: { running?: boolean; failPrompt?: boolean } = {}) {
  const rows: {
    sessionId: string;
    cwd: string;
    blank: boolean;
    updatedAt: number;
    running: boolean;
  }[] = [];
  const calls: string[] = [];
  /** 时间线：调用与帧按发生顺序混在一条线上（比偏移要稳，见 fetch 的 `marks`）。 */
  const timeline: string[] = [];
  const prompts: { sessionId: string; requestId: string; content: unknown[]; mode: string }[] = [];
  /** `followSession` / `followControl` 的 `onItem`：测试据此注入服务端帧。 */
  const followers: { session?: (value: unknown) => void; control?: (value: unknown) => void } = {};
  /** `prompt` 是否抛错（测试中途可以改：先失败一次、重发时放行）。 */
  let failPrompt = options.failPrompt === true;
  /** 摘哪一条队列项时失败（`stopRunning` 的回滚档要它）。 */
  let failRemoveOf: string | undefined;
  /**
   * `session/cancel` 之后服务端会回 `turn/end`（`running` 翻假）。
   *
   * 测试里直接这么摆：`waitUntilIdle` 是 8 秒轮询，不模拟这个收尾每个用例都要等满。
   */
  let onCancel: (() => void) | undefined;
  return {
    calls,
    timeline,
    prompts,
    followers,
    rows,
    setFailPrompt(next: boolean) {
      failPrompt = next;
    },
    setFailRemove(itemId: string | undefined) {
      failRemoveOf = itemId;
    },
    setOnCancel(hook: () => void) {
      onCancel = hook;
    },
    async cancel() {
      calls.push("session/cancel");
      onCancel?.();
      return { accepted: true };
    },
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      timeline.push("call:session/create");
      const sessionId = `session-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd ?? "",
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: options.running === true,
      });
      return { sessionId };
    },
    async listSessions() {
      calls.push("session/list");
      return { items: rows.map((row) => ({ ...row })) };
    },
    async updateQueueRemove(_sessionId: string, itemId: string) {
      calls.push(`session/updateQueueRemove:${itemId}`);
      if (itemId === failRemoveOf) throw new Error("queue-item-not-found");
      return { accepted: true };
    },
    async updateQueueSteer(_sessionId: string, itemId: string) {
      calls.push(`session/updateQueueSteer:${itemId}`);
      return { accepted: true };
    },
    /** 一次发送的提交：默认受理；`failPrompt` 时抛错（模拟没发出去）。 */
    async prompt(sessionId: string, content: unknown[], mode: string, requestId: string) {
      calls.push("session/prompt");
      timeline.push("call:session/prompt");
      prompts.push({ sessionId, content, mode, requestId });
      if (failPrompt) throw new Error("prompt rejected");
      return { accepted: true };
    },
    async request(method: string, params?: Record<string, unknown>) {
      calls.push(method);
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
      if (method === "commands/list") {
        return [
          { name: "plan", description: "切换计划模式" },
          { name: "compact", description: "压缩上下文" },
        ];
      }
      if (method === "fileReferences/list") return [];
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "skills/list") return { skills: [] };
      if (method === "commands/execute") return { result: { kind: "success", text: "ok" } };
      return undefined;
    },
    async sessionProjections() {
      return { values: {} };
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    followSession(_sessionId: string, callbacks: { onItem: (value: unknown) => void }) {
      followers.session = callbacks.onItem;
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl(callbacks: { onItem: (value: unknown) => void }) {
      followers.control = callbacks.onItem;
      return { cancel() {} };
    },
  };
}

const fakeServer = () => ({
  externalUrl: undefined,
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

function makeController(options: { running?: boolean; failPrompt?: boolean } = {}) {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  const client = fakeClient(options);
  (
    controller as never as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => {
    frames.push({ target, frame });
    // 时间线上只记「回显非空」这一件事：它是本测试关心的那一帧
    const patch = (frame as { patch?: { pendingMessages?: unknown[] } }).patch;
    if (patch?.pendingMessages?.length) client.timeline.push("frame:echo");
  });
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    sessions: { id: string }[];
    viewSessions: Map<string, string>;
    scopes: Map<string, { running: boolean }>;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
    /** 这个窗口（按窗口键折算）名下的回显。 */
    pendingEchoesOfView(viewId: string): PendingMessageView[];
    /** 这个窗口名下的草稿。 */
    draftOf(viewId: string): string | undefined;
    /** 这个窗口名下的附件芯片 id。 */
    attachmentIds(viewId: string): string[];
    /** 给这个窗口挂一个附件芯片（模拟用户在输入框上加附件）。 */
    putAttachment(viewId: string, attachment: { id: string; kind: "file" | "image"; name: string }): void;
  };
  // 测试侧的读表口子：键的折算规则与控制器同一套（`keyForView`），
  // 不然「按 viewId 查会话键」会读到一个不存在的键、断言就成了空的
  const inner = controller as unknown as {
    pendingMessages: Map<string, PendingMessageView[]>;
    drafts: Map<string, string>;
    attachmentsBySession: Map<string, { id: string }[]>;
    keyForView(viewId: string): string;
  };
  c.pendingEchoesOfView = (viewId) => [...(inner.pendingMessages.get(inner.keyForView(viewId)) ?? [])];
  c.draftOf = (viewId) => inner.drafts.get(inner.keyForView(viewId));
  c.attachmentIds = (viewId) => (inner.attachmentsBySession.get(inner.keyForView(viewId)) ?? []).map((a) => a.id);
  c.putAttachment = (viewId, attachment) => {
    const key = inner.keyForView(viewId);
    const list = inner.attachmentsBySession.get(key) ?? [];
    list.push(attachment);
    inner.attachmentsBySession.set(key, list);
  };
  c.newSessionCwd = CWD;
  c.client = client as never;
  c.connection = "connected";
  return { c, frames, client };
}

/** 最近一帧发给 viewId 的某类型帧。 */
function lastFrame(frames: Captured[], viewId: string, type: string): Record<string, unknown> | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target === viewId && frame.type === type) return frame;
  }
  return undefined;
}

/** 最近一帧回显列表（`undefined` = 这一路从没发过）。 */
function pendingOf(frames: Captured[], viewId: string): PendingMessageView[] | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target !== viewId || frame.type !== "patch") continue;
    const patch = frame.patch as { pendingMessages?: PendingMessageView[] } | undefined;
    if (patch && "pendingMessages" in patch) return patch.pendingMessages ?? [];
  }
  return undefined;
}

/** 从一帧 `state` 里取快照（首帧 / 建会话后那一份）。 */
function stateOf(frames: Captured[], viewId: string): Record<string, any> | undefined {
  const frame = lastFrame(frames, viewId, "state");
  return frame?.state as Record<string, any> | undefined;
}

/** 一条 durable `user/message`（`rpcId` 缺省 = 旧服务端不回它）。 */
function userMessageEvent(seq: number, text: string, rpcId?: string) {
  return {
    type: "event",
    event: {
      type: "user/message",
      seq,
      time: Date.now(),
      surfaceOp: "append",
      data: {
        content: [{ type: "text", text }],
        source: { kind: "user", ...(rpcId ? { rpcId } : {}) },
      },
    },
  };
}

/**
 * 服务端把这一轮收掉。
 *
 * 真链路上适配器在 `turn/end` 时发 `running:false` 的 patch，控制器的 `deliver` 据此把
 * 域上的 `running` 翻假（`send` 里乐观置位的那一下就是这么收场的）。测试里不摆这一步的话，
 * 会话会一直停在「运行中」，后面那些空闲发送会全被当成排队（那是另一档语义）。
 */
function endTurn(client: ReturnType<typeof fakeClient>, turn = 1): void {
  client.followers.session?.({
    type: "event",
    event: {
      type: "turn/end",
      seq: 100 + turn,
      time: Date.now(),
      data: { turn, reason: { kind: "completed" } },
    },
  });
}

console.log("pendingEcho: 用户消息乐观回显（驱动真控制器，offline stub）");

// ---------- 一、空态第一条消息：回显早于建会话，且活过那一份整份快照 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle(
    {
      type: "send",
      text: "你好",
      // 带一个文件附件：顺带钉住「按下发送那一刻附件芯片就清了」——
      // 界面自己不清附件，晚清一步回显里那份与芯片那份会同时显示
      attachments: [{ id: "a1", kind: "file", name: "notes.txt" }],
      gesture: "enter",
    },
    "v1",
  );

  const echoAt = client.timeline.indexOf("frame:echo");
  const createAt = client.timeline.indexOf("call:session/create");
  console.log(`  时间线：回显 ${echoAt}、建会话 ${createAt}（共 ${client.timeline.length} 步）`);
  assert.ok(echoAt >= 0, "第一条消息必须产生一帧乐观回显（否则就是老行为：等整条链走完才画）");
  assert.ok(
    createAt >= 0 && echoAt < createAt,
    `回显必须早于 session/create（预渲染的意义就在这里）：回显 ${echoAt}、建会话 ${createAt}`,
  );

  const requestId = client.prompts[0]?.requestId;
  assert.ok(requestId, "prompt 必须被调用，且带一个 requestId");
  const echo = pendingOf(frames, "v1");
  assert.strictEqual(echo?.length, 1, "界面收到的回显应当正好一条");
  assert.strictEqual(
    echo?.[0]?.requestId,
    requestId,
    "回显的 requestId 必须就是交给 prompt 的那一个（durable 承认凭它配对）",
  );
  assert.deepStrictEqual(
    Object.keys(echo?.[0] ?? {}).sort(),
    ["attachments", "requestId", "status", "text", "ts"],
    "账本条目只有「这条已发出的消息」要用的字段（落点字段连同排队/插话那一档一起删了）",
  );
  assert.strictEqual(echo?.[0]?.status, "sending", "刚发出去时是 sending");

  const snapshot = stateOf(frames, "v1");
  assert.deepStrictEqual(
    (snapshot?.pendingMessages ?? []).map((entry: { requestId?: string }) => entry.requestId),
    [requestId],
    "createSession 那份整份快照里回显还在（窗口键 → 会话键的迁移生效）",
  );
  assert.strictEqual(snapshot?.draft, "", "快照里的草稿必须是空的（提交即清空）");
  assert.deepStrictEqual(snapshot?.attachments, [], "快照里的附件芯片也必须是空的");
  console.log(`  回显 requestId=${requestId}，迁移后仍在快照里 ✓`);
}

// ---------- 二、无闪烁交接：落位帧早于收回帧、身份一致、图片借本地那份字节 ----------
//
// 用户 2026-09-25 报的「消息立即显示，然后闪一下又回来」：收回帧（`pendingMessages: []`）
// 以前发在落位帧**之前**，中间有一帧两边都不在。现在次序反过来，且 durable 行带着
// 同一个 `rpcId`（界面据此去重 + 复用同一个 React key）。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  const image = {
    id: "img1",
    kind: "image" as const,
    name: "shot.png",
    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
    width: 8,
    height: 6,
  };
  await c.handle({ type: "send", text: "带图", attachments: [image], gesture: "enter" }, "v1");
  const requestId = client.prompts[0].requestId;

  frames.length = 0;
  client.followers.session?.({
    type: "event",
    event: {
      type: "user/message",
      seq: 1,
      time: Date.now(),
      surfaceOp: "append",
      data: {
        content: [
          { type: "image", attachment: { attachmentId: "sha256:abc", mediaType: "image/png", name: "shot.png" } },
          { type: "text", text: "带图" },
        ],
        source: { kind: "user", rpcId: requestId },
      },
    },
  });

  const placedAt = frames.findIndex(
    ({ target, frame }) =>
      target === "v1" && (frame.type === "message/upsert" || frame.type === "messages/reset"),
  );
  const retiredAt = frames.findIndex(
    ({ target, frame }) =>
      target === "v1" &&
      frame.type === "patch" &&
      Array.isArray((frame.patch as { pendingMessages?: unknown[] }).pendingMessages) &&
      ((frame.patch as { pendingMessages: unknown[] }).pendingMessages.length === 0),
  );
  console.log(`  交接帧序：落位 ${placedAt}、收回 ${retiredAt}（共 ${frames.length} 帧）`);
  assert.ok(placedAt >= 0, "durable 行必须落位（先有行，再收回显）");
  assert.ok(retiredAt >= 0, "回显必须被收回");
  assert.ok(
    placedAt < retiredAt,
    `落位帧必须早于收回帧（反了就是"消失一帧又回来"）：落位 ${placedAt}、收回 ${retiredAt}`,
  );

  const durable = (lastFrame(frames, "v1", "message/upsert")?.message ??
    lastFrame(frames, "v1", "messages/reset")?.messages?.at(-1)) as
    | { role?: string; rpcId?: string; attachments?: { kind?: string; dataUrl?: string; attachmentId?: string }[] }
    | undefined;
  assert.strictEqual(durable?.role, "user");
  assert.strictEqual(
    durable?.rpcId,
    requestId,
    "durable 行带上同一个身份（界面按 rpcId 去重 + 两边共用同一个 React key）",
  );
  const first = durable?.attachments?.[0];
  assert.strictEqual(first?.kind, "image");
  assert.strictEqual(
    first?.dataUrl,
    image.dataUrl,
    "durable 行借用了同一次提交的本地字节：交接时图不会退回文件名芯片再变回来",
  );
  assert.strictEqual(first?.attachmentId, "sha256:abc", "句柄仍用 durable 那一个（异步补字节照旧会跑）");
}

// ---------- 二之二、**重放路径**同样不闪：开窗快照里就带着这条 durable 行 ----------
//
// 上面那条是**直播**：`user/message` 作为一条 live 事件到达，落位帧当场就发出去。
// 重放（重连 / 重开窗口 / 「加载更早的历史」）走的是另一条路：`refold()` 期间 `emit` 静默，
// 落位帧被压住，界面要等调用方事后那一份整份 `messages/reset` 才拿得到 durable 行。
// 而收回回显的帧是**控制器直接发**的、不受这个静默影响——所以「承认」必须攒到那一份
// reset 发出去之后再通知，否则界面先收到「回显没了」、后收到行，就是「先显示 → 消失 → 再回显」。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "重放里承认", attachments: [], gesture: "enter" }, "v1");
  const requestId = client.prompts[0].requestId;

  frames.length = 0;
  client.followers.session?.({
    type: "snapshot",
    cursor: 1,
    hasMore: false,
    records: [userMessageEvent(1, "重放里承认", requestId)],
  });

  const placedAt = frames.findIndex(
    ({ target, frame }) =>
      target === "v1" &&
      frame.type === "messages/reset" &&
      ((frame.messages as { rpcId?: string }[] | undefined) ?? []).some((row) => row.rpcId === requestId),
  );
  const retiredAt = frames.findIndex(
    ({ target, frame }) =>
      target === "v1" &&
      frame.type === "patch" &&
      Array.isArray((frame.patch as { pendingMessages?: unknown[] }).pendingMessages) &&
      (frame.patch as { pendingMessages: unknown[] }).pendingMessages.length === 0,
  );
  console.log(`  重放帧序：落位 ${placedAt}、收回 ${retiredAt}（共 ${frames.length} 帧）`);
  assert.ok(placedAt >= 0, "重放里也要把 durable 行落位（那一份整份 messages/reset）");
  assert.ok(retiredAt >= 0, "重放结束后回显照样要收回（账本不许留幽灵）");
  assert.ok(
    placedAt < retiredAt,
    `重放路径上落位帧也必须早于收回帧（反了就是"消失一帧又回来"）：落位 ${placedAt}、收回 ${retiredAt}`,
  );
}

// ---------- 三、没发出去（prompt 抛错）→ 那一行留在原地、标成失败 ----------
//
// 用户 2026-09-25 口径：失败**不撤回显示**——行留在那里、红框、给重发/撤回按钮，
// 行尾写原因；正文**不回**输入框（回填会变成"输入框一份 + 消息流一份"）。
{
  const { c, frames } = makeController({ failPrompt: true });
  c.bindView("v1");
  await c.handle({ type: "send", text: "这条发不出去", attachments: [], gesture: "enter" }, "v1");

  const echo = pendingOf(frames, "v1");
  assert.strictEqual(echo?.length, 1, "失败的那一条**留在**回显里（不许收回）");
  assert.strictEqual(echo?.[0]?.status, "failed", "状态标成 failed（界面据此画红框 + 两个按钮）");
  assert.match(
    String(echo?.[0]?.error ?? ""),
    /^@sendFailed:/,
    "失败原因带上服务端 / 传输层的原文（@sendFailed:<detail>）",
  );
  const drafts = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { draft?: string }).draft)
    .filter((draft): draft is string => typeof draft === "string");
  console.log(`  失败后 draft 帧：${JSON.stringify(drafts)}，原因=${String(echo?.[0]?.error)}`);
  assert.deepStrictEqual(
    [...new Set(drafts)],
    [""],
    "失败不回填草稿（正文留在那一行里，回填会变成两份）",
  );
}

// ---------- 四、撤回 / 重发（失败行上的两个按钮） ----------
{
  const { c, frames, client } = makeController({ failPrompt: true });
  c.bindView("v1");
  await c.handle({ type: "send", text: "要重发的", attachments: [], gesture: "enter" }, "v1");
  const first = client.prompts[0].requestId;
  assert.strictEqual(pendingOf(frames, "v1")?.[0]?.status, "failed", "前置：失败了");

  // 重发：先撤回再按普通发送重走一遍（新的 requestId），失败的话新那一行也是失败态
  client.setFailPrompt(false);
  frames.length = 0;
  await c.handle({ type: "resendPending", requestId: first }, "v1");
  assert.strictEqual(client.prompts.length, 2, "重发必须真的再提交一次");
  const resent = pendingOf(frames, "v1");
  assert.strictEqual(resent?.length, 1, "旧那一行被撤回、新那一行顶上（不是两条）");
  assert.notStrictEqual(resent?.[0]?.requestId, first, "重发用新的 requestId（旧 id 已被服务端记为受理）");
  assert.strictEqual(resent?.[0]?.status, "sending", "重发后是 sending");
  // 「撤回」那一步**不单独推帧**：否则中间会有一帧两行都不在（撤回帧里新行还没建），
  // 界面上就是重发时那一行闪一下
  assert.strictEqual(
    frames.filter(
      ({ target, frame }) =>
        target === "v1" &&
        frame.type === "patch" &&
        "pendingMessages" in ((frame.patch as object) ?? {}),
    ).length,
    1,
    "重发只推一帧回显（撤回静默、由新那一帧带上最终状态）",
  );

  // 连点两次是安全的：第二下找不到那条回显，什么都不做
  await c.handle({ type: "resendPending", requestId: first }, "v1");
  assert.strictEqual(client.prompts.length, 2, "对已经不在的回显重发是 no-op（连点不会发两条）");

  // 撤回：删掉那一行，不把正文塞回输入框
  const current = String(pendingOf(frames, "v1")?.[0]?.requestId);
  frames.length = 0;
  await c.handle({ type: "retractPending", requestId: current }, "v1");
  assert.deepStrictEqual(pendingOf(frames, "v1"), [], "撤回 = 删掉那一行");
  const drafts = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { draft?: string }).draft)
    .filter((draft): draft is string => typeof draft === "string");
  assert.deepStrictEqual(drafts, [], "撤回不把正文还给输入框（用户口径：不需要返回编辑框）");
}

// ---------- 四之三、重发 / 撤回**只动这个窗口自己那份账本** ----------
//
// 两个动作都从界面来。按 id 全局找账本的话，一个（撞上别的会话 id 的）请求就能把别人那条
// 删掉；按窗口的键找就没有这个问题。
{
  const { c, frames, client } = makeController({ failPrompt: true });
  c.bindView("v1");
  await c.handle({ type: "send", text: "v1 的失败行", attachments: [], gesture: "enter" }, "v1");
  const mine = String(client.prompts[0]?.requestId);

  // 另一个窗口（同一控制器、另一条会话）也有一条失败的
  c.bindView("v2");
  await c.handle({ type: "send", text: "v2 的失败行", attachments: [], gesture: "enter" }, "v2");
  const other = String(client.prompts[1]?.requestId);
  assert.notStrictEqual(mine, other, "前置：两条回显身份不同");
  assert.strictEqual(pendingOf(frames, "v2")?.[0]?.status, "failed", "前置：v2 那条也失败了");

  // v1 拿着 v2 的 id 来撤回 / 重发：都不许动 v2 那条
  await c.handle({ type: "retractPending", requestId: other }, "v1");
  await c.handle({ type: "resendPending", requestId: other }, "v1");
  assert.strictEqual(client.prompts.length, 2, "拿别人的 id 重发不会提交任何东西");
  assert.strictEqual(
    c.pendingEchoesOfView("v2").length,
    1,
    "别的会话那条回显仍在（撤回 / 重发只认调用窗口自己那份账本）",
  );
  assert.strictEqual(c.pendingEchoesOfView("v2")[0]?.status, "failed", "它的状态也没被人从旁边改掉");

  // 自己的 id 照常能撤
  await c.handle({ type: "retractPending", requestId: mine }, "v1");
  assert.deepStrictEqual(c.pendingEchoesOfView("v1"), [], "自己的那条照常撤得掉");
}

// ---------- 四之四、重发**不许碰输入框**：用户可能正打着另一句话 ----------
//
// 重发的内容来自失败那一行，不是输入框里那份。这条路要是顺手清了草稿与附件芯片，
// 用户刚打的字就被擦了——「发一条消息」不该有这种副作用。
{
  const { c, frames, client } = makeController({ failPrompt: true });
  c.bindView("v1");
  await c.handle({ type: "send", text: "这条失败了", attachments: [], gesture: "enter" }, "v1");
  const failed = String(client.prompts[0]?.requestId);
  // 失败之后用户在输入框里打了下一句话，还挂了一个附件芯片
  await c.handle({ type: "setDraft", text: "我正在打的新草稿" }, "v1");
  c.putAttachment("v1", { id: "keep-1", kind: "file", name: "keep.txt" });
  client.setFailPrompt(false);

  frames.length = 0;
  await c.handle({ type: "resendPending", requestId: failed }, "v1");
  assert.strictEqual(client.prompts.length, 2, "重发真的提交了");
  const cleared = frames.filter(({ target, frame }) => {
    if (target !== "v1" || frame.type !== "patch") return false;
    const patch = frame.patch as { draft?: string; attachments?: unknown[] };
    return patch.draft === "" || Array.isArray(patch.attachments);
  });
  assert.deepStrictEqual(
    cleared.map(({ frame }) => frame.patch),
    [],
    "重发不推任何清空输入框的帧（草稿与附件芯片都不动）",
  );
  assert.strictEqual(c.draftOf("v1"), "我正在打的新草稿", "宿主的草稿表里那句话还在");
  assert.deepStrictEqual(
    c.attachmentIds("v1"),
    ["keep-1"],
    "附件芯片也还在（重发那段内容与输入框无关）",
  );
}

// ---------- 四之二、失败的那一行**跨会话切换留得住**（只有宿主重启才消失） ----------
//
// 用户 2026-09-25 口径：失败的消息留在那里、后续仍可操作；它不在会话内容里，删了就再也回不来。
// 单窗口下切走会话 = 最后一个观察者离开 ⇒ 域被回收（`destroyScope`）——那一刻**不许**动账本：
// 既不许丢（切回来还得能重发/撤回），也不许凭「域没了」把它改写成失败（还在飞的那条很可能
// 已经发出去了，改写成红框会诱导用户重发一遍）。
{
  const { c, frames, client } = makeController({ failPrompt: true });
  c.bindView("v1");
  await c.handle({ type: "send", text: "切走也要在", attachments: [], gesture: "enter" }, "v1");
  const sessionId = c.viewSessions.get("v1");
  assert.ok(sessionId, "前置：窗口已绑上会话");
  const requestId = String(client.prompts[0]?.requestId);
  assert.strictEqual(pendingOf(frames, "v1")?.[0]?.status, "failed", "前置：这条失败了");

  // 切走（新建对话）：域被回收
  await c.handle({ type: "newSession" }, "v1");
  assert.strictEqual(c.scopes.has(sessionId), false, "前置：切走即回收域（单窗口下它是最后一个观察者）");
  assert.deepStrictEqual(
    stateOf(frames, "v1")?.pendingMessages ?? [],
    [],
    "退回空态那一帧不带这条回显（它按会话键留着，不属于空态）",
  );

  // 切回来：账本里那一条还在，并且随整份快照重新画出来
  frames.length = 0;
  await c.handle({ type: "openSession", sessionId }, "v1");
  const back = pendingOf(frames, "v1");
  assert.ok(
    frames.some(({ target, frame }) => target === "v1" && frame.type === "state"),
    "切回来会推一份整份快照",
  );
  const snapshot = stateOf(frames, "v1");
  assert.deepStrictEqual(
    (snapshot?.pendingMessages ?? []).map((entry: { requestId?: string }) => entry.requestId),
    [requestId],
    "切回来那份快照里失败那一条还在（域回收不许丢它）",
  );
  const kept = (snapshot?.pendingMessages ?? [])[0] as { status?: string; error?: string } | undefined;
  assert.strictEqual(kept?.status, "failed", "还是失败态（不许被改写成别的，也不许被悄悄变成 sending）");
  assert.match(String(kept?.error ?? ""), /^@sendFailed:/, "原因照旧留着（用户要看得见为什么失败）");
  console.log(`  切走再切回：失败行仍在（requestId=${requestId}），可继续重发/撤回 ✓`);
}

// ---------- 五、运行中发送：**不进账本**，排队区与改动前一个字都不变 ----------
//
// 用户 2026-09-25 口径：排队中的消息**还没发出去**，它就该待在（服务端名册驱动的）
// 排队区里——「发出去就立刻显示」只针对真的发出去的那一类。所以这一档**不建账本条目**：
// 成功走队列/插话那条老路，失败也走老口径（正文回输入框 + 原生提示）。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  // 第一条消息照常建会话（此刻还没有域），随后被 durable 承认收回
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  client.followers.session?.(userMessageEvent(1, "第一条", client.prompts[0].requestId));
  assert.deepStrictEqual(pendingOf(frames, "v1"), [], "前置：第一条回显已被承认收回");
  const sessionId = c.viewSessions.get("v1");
  assert.ok(sessionId, "前置：窗口已绑上会话");
  // 模拟 agent 正在跑：下一条按 queue 提交（进排队区，不进对话流）
  const scope = c.scopes.get(sessionId);
  assert.ok(scope, "前置：会话域在");
  scope.running = true;
  frames.length = 0;

  await c.handle({ type: "send", text: "排上", attachments: [], gesture: "enter" }, "v1");
  assert.strictEqual(pendingOf(frames, "v1"), undefined, "运行中发送**不建账本**（它还没发出去）");
  const requestId = client.prompts[1]?.requestId;
  assert.strictEqual(client.prompts[1]?.mode, "queue", "照旧按 queue 提交（mode 由 resolveSubmitMode 定）");

  // 队列帧到达：那条老路径照旧（真实队列项带着 rpcId 到界面），本地这条不参与
  client.followers.control?.({
    type: "projection",
    sessionId,
    key: "inbox",
    seq: 5,
    value: {
      "next-turn": [
        { id: "m1", source: { kind: "user", rpcId: requestId }, content: [{ type: "text", text: "排上" }] },
      ],
      "next-step": [],
    },
  });
  const queuePatch = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { queueItems?: { id?: string; rpcId?: string }[] }).queueItems)
    .filter((items): items is { id?: string; rpcId?: string }[] => Array.isArray(items));
  assert.ok(
    queuePatch.some((items) => items.some((item) => item.id === "m1" && item.rpcId === requestId)),
    "排队区拿到的仍然是服务端那条真实队列项（本地不接管、不顶替）",
  );
  assert.strictEqual(pendingOf(frames, "v1"), undefined, "队列帧与账本无关（这一档压根没有账本条目）");

  // 被派发：durable 承认 → 只是多了一条真实行，与账本无关
  client.followers.session?.(userMessageEvent(2, "排上", requestId));
  assert.strictEqual(pendingOf(frames, "v1"), undefined, "派发也不产生 / 收回任何账本条目");
}

// 运行中发送**失败**（这一次 `session/prompt` 没成功）：账本里没有它 ⇒ 走改动前那条老口径
// （正文回输入框 + 原生错误提示）。这是既有的那一档，本次改动**刻意不碰**。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  client.followers.session?.(userMessageEvent(1, "第一条", client.prompts[0].requestId));
  const sessionId = c.viewSessions.get("v1");
  assert.ok(sessionId, "前置：窗口已绑上会话");
  const scope = c.scopes.get(sessionId);
  assert.ok(scope, "前置：会话域在");
  scope.running = true;

  client.setFailPrompt(true);
  frames.length = 0;
  await c.handle({ type: "send", text: "入队这句没成功", attachments: [], gesture: "enter" }, "v1");
  assert.strictEqual(pendingOf(frames, "v1"), undefined, "入队失败不产生红框（那一档不归本次改动管）");
  const drafts = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { draft?: string }).draft)
    .filter((draft): draft is string => typeof draft === "string");
  assert.ok(
    drafts.includes("入队这句没成功"),
    `入队失败照旧把正文还回输入框（改动前的老口径）：${JSON.stringify(drafts)}`,
  );
}

// ---------- 五之二、ESC 后把排队消息**接着发出去**：走统一路径 ----------
//
// 用户 2026-09-25 口径：「队列消息发出到会话」与「用户空闲主动发出到会话」是同一条路线。
// ESC 中止时客户端把队列摘空、按原顺序重新提交，首条就是「接着发出去」的那一条——
// 那一刻 agent 已经空闲 ⇒ 它是**真的发出去了** ⇒ 立刻产生回显、画进对话流，
// 失败也按统一口径留在原地（红框 + 重发 / 撤回），而不是另走一套。
// 判据是「这一刻 agent 在不在跑」，与手按发送完全同一条（`beginSend` 的 `goesOutNow`）。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  client.followers.session?.(userMessageEvent(1, "第一条", client.prompts[0].requestId));
  const sessionId = String(c.viewSessions.get("v1"));
  const scope = c.scopes.get(sessionId);
  assert.ok(scope, "前置：会话域在");
  // 本轮在跑：模拟 `session/cancel` 之后服务端回 `turn/end`（`waitUntilIdle` 才不是等 8 秒）
  client.setOnCancel(() => {
    scope.running = false;
  });
  scope.running = true;

  // 运行中发送 → 进队列（不进账本）
  await c.handle({ type: "send", text: "排队那条", attachments: [], gesture: "enter" }, "v1");
  const queuedId = String(client.prompts[1]?.requestId);
  assert.strictEqual(client.prompts[1]?.mode, "queue", "前置：运行中发送按 queue 提交");
  client.followers.control?.({
    type: "projection",
    sessionId,
    key: "inbox",
    seq: 5,
    value: {
      "next-turn": [
        { id: "m1", source: { kind: "user", rpcId: queuedId }, content: [{ type: "text", text: "排队那条" }] },
      ],
      "next-step": [],
    },
  });
  assert.deepStrictEqual(c.attachmentIds("v1"), [], "前置：入队那条没有留下附件芯片");
  // 用户在输入框里打了下一句话、还挂了个附件：ESC 派发排队消息时**都不许**被擦掉
  await c.handle({ type: "setDraft", text: "我正在打的新草稿" }, "v1");
  c.putAttachment("v1", { id: "keep-1", kind: "file", name: "keep.txt" });

  frames.length = 0;
  await c.handle({ type: "stop" }, "v1");

  assert.strictEqual(client.prompts.length, 3, "重新提交真的发出去了（统一路径里的那次 prompt）");
  assert.strictEqual(client.prompts[2]?.mode, "queue", "提交模式与改动前逐字相同：queue");
  const echo = pendingOf(frames, "v1");
  assert.strictEqual(echo?.length, 1, "这一刻 agent 空闲 = 这条真的发出去了 ⇒ 立刻产生回显");
  assert.strictEqual(echo?.[0]?.requestId, client.prompts[2]?.requestId, "回显身份就是这次提交的 requestId");
  assert.strictEqual(echo?.[0]?.text, "排队那条", "回显内容就是摘出来那条");
  assert.strictEqual(echo?.[0]?.status, "sending", "刚发出去，等 durable 承认");
  const cleared = frames.filter(({ target, frame }) => {
    if (target !== "v1" || frame.type !== "patch") return false;
    const patch = frame.patch as { draft?: string; attachments?: unknown[] };
    return patch.draft === "" || Array.isArray(patch.attachments);
  });
  assert.deepStrictEqual(
    cleared.map(({ frame }) => frame.patch),
    [],
    "排队来源的提交不许清空输入框（用户正打着的那句话要留住）",
  );
  assert.strictEqual(c.draftOf("v1"), "我正在打的新草稿", "草稿表里那句话原样在");
  assert.deepStrictEqual(c.attachmentIds("v1"), ["keep-1"], "附件芯片也原样在");

  // durable 承认照旧收回（与手按发送同一条交接）
  client.followers.session?.(userMessageEvent(2, "排队那条", client.prompts[2].requestId));
  assert.deepStrictEqual(pendingOf(frames, "v1"), [], "durable 承认后回显被收回（交接路径不分来源）");
}

// ---------- 五之三、回滚那一档（agent 还在跑）仍是排队语义 ----------
//
// `requeue` 用在「队列摘不动」与「等本轮结束超时」两条回滚路上——那一刻 agent 可能还在跑，
// 这条消息**还没发出去**：它不许进账本（唯一去处仍是排队区），提交模式必须仍是 `queue`
// （插话进正在跑的那一轮不是回滚），失败也照旧是「正文回输入框」那套。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  client.followers.session?.(userMessageEvent(1, "第一条", client.prompts[0].requestId));
  const sessionId = String(c.viewSessions.get("v1"));
  const scope = c.scopes.get(sessionId);
  assert.ok(scope, "前置：会话域在");
  scope.running = true;
  // 三条排队消息：第三条摘不动（模拟它恰好在执行）→ 前两条已摘出，走 requeue 回滚。
  // 前两条里第一条的重发会失败，第二条于是由 `resubmit` 统一还回输入框（第三条仍在
  // 服务端队列里，**不许**还回去——那会让同一条既在队列又在输入框）。
  await c.handle({ type: "send", text: "回滚一", attachments: [], gesture: "enter" }, "v1");
  await c.handle({ type: "send", text: "回滚二", attachments: [], gesture: "enter" }, "v1");
  await c.handle({ type: "send", text: "回滚三", attachments: [], gesture: "enter" }, "v1");
  const firstQueued = String(client.prompts[1]?.requestId);
  const secondQueued = String(client.prompts[2]?.requestId);
  const thirdQueued = String(client.prompts[3]?.requestId);
  client.followers.control?.({
    type: "projection",
    sessionId,
    key: "inbox",
    seq: 5,
    value: {
      "next-turn": [
        { id: "m1", source: { kind: "user", rpcId: firstQueued }, content: [{ type: "text", text: "回滚一" }] },
        { id: "m2", source: { kind: "user", rpcId: secondQueued }, content: [{ type: "text", text: "回滚二" }] },
        { id: "m3", source: { kind: "user", rpcId: thirdQueued }, content: [{ type: "text", text: "回滚三" }] },
      ],
      "next-step": [],
    },
  });
  client.setFailRemove("m3");
  // 回滚的重发会失败（这一档要断言的就是它失败后怎么收场）
  client.setFailPrompt(true);
  client.setOnCancel(() => {
    scope.running = false;
  });

  frames.length = 0;
  await c.handle({ type: "stop" }, "v1");

  // 回滚时 agent 还在跑（`cancel` 还没发生）⇒ 不产生回显
  const echoFrames = frames.filter(
    ({ target, frame }) =>
      target === "v1" &&
      frame.type === "patch" &&
      Array.isArray((frame.patch as { pendingMessages?: unknown[] }).pendingMessages),
  );
  assert.deepStrictEqual(
    echoFrames.map(({ frame }) => (frame.patch as { pendingMessages: unknown[] }).pendingMessages),
    [],
    "回滚那一档不进账本（这条还没发出去，它属于排队区）",
  );
  // 回滚的重发走统一路径：mode 仍是 queue、用新的 requestId，失败时正文回输入框（老口径）+ 提示
  const resent = client.prompts.at(-1);
  assert.strictEqual(resent?.mode, "queue", "回滚重发也按 queue 提交");
  assert.notStrictEqual(resent?.requestId, firstQueued, "回滚重发用新的 requestId（旧 id 已被服务端记为受理）");
  const drafts = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { draft?: string }).draft)
    .filter((draft): draft is string => typeof draft === "string");
  assert.ok(
    drafts.some((draft) => draft.includes("回滚一")),
    `回滚失败照旧把正文还回输入框（统一路径里「没有回显」那一档）：${JSON.stringify(drafts)}`,
  );
  assert.ok(
    drafts.some((draft) => draft.includes("回滚二")),
    "后面**已摘出但还没提交**的那些由 `resubmit` 统一还回输入框",
  );
  assert.ok(
    !drafts.some((draft) => draft.includes("回滚三")),
    "没摘下来的那条仍在服务端队列里，不许还回输入框（否则同一条既在队列又在输入框）",
  );
  assert.ok(
    frames.some(
      ({ target, frame }) =>
        target === "v1" &&
        frame.type === "toast" &&
        (frame as { text?: string }).text === "@queueDispatchFailed",
    ),
    "回滚失败照旧提示一次（提示文案不再说「内容已放回输入框」，两种收场各自在界面上看得见）",
  );
}

// ---------- 五之四、本地提交记录不在时，排队重发**照旧带上那份内容块** ----------
//
// 扩展重载过 / 提交记录被上限淘汰之后，`inbox` 投影里的内容块是这条消息唯一的原样副本
// （可能含内联图片字节）。统一路径必须把它原样送出去——按文本重建会丢图片。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  client.followers.session?.(userMessageEvent(1, "第一条", client.prompts[0].requestId));
  const sessionId = String(c.viewSessions.get("v1"));
  const scope = c.scopes.get(sessionId);
  assert.ok(scope, "前置：会话域在");
  client.setOnCancel(() => {
    scope.running = false;
  });
  scope.running = true;
  const parts = [
    { type: "text", text: "带图的排队消息" },
    { type: "image", mediaType: "image/png", data: "QUJD", name: "shot.png" },
  ];
  // 这条队列项的 `rpcId` 在本地认不出来（= 没有提交记录）：内容块只有投影带回来的这一份
  client.followers.control?.({
    type: "projection",
    sessionId,
    key: "inbox",
    seq: 5,
    value: {
      "next-turn": [{ id: "m9", source: { kind: "user", rpcId: "rpc-not-local" }, content: parts }],
      "next-step": [],
    },
  });
  frames.length = 0;
  await c.handle({ type: "stop" }, "v1");

  const resent = client.prompts.at(-1);
  assert.deepStrictEqual(
    resent?.content,
    parts,
    "内容块原样重发（投影那一份，含内联图片字节；按文本重建会丢图片）",
  );
  assert.strictEqual(resent?.mode, "queue", "提交模式照旧 queue");
  assert.strictEqual(pendingOf(frames, "v1")?.[0]?.text, "带图的排队消息", "这一刻空闲 ⇒ 同样立刻画出回显");
}

// ---------- 六、无 rpcId 的兜底收回；斜杠命令与技能调用的回显判据 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "只有正文", attachments: [], gesture: "enter" }, "v1");
  assert.strictEqual(pendingOf(frames, "v1")?.length, 1, "前置：回显已画出来");
  client.followers.session?.(userMessageEvent(1, "只有正文"));
  assert.deepStrictEqual(
    pendingOf(frames, "v1"),
    [],
    "没有 rpcId 时按正文兜底收回（旧服务端上不许永久重复一条）",
  );
}
// 六之二、**有会话**时判据是命令目录，不是正文长相（用户 2026-09-25 报的现场）：
// `/skill-name …` 是普通消息（技能不进命令目录，见 controller.skillCommands），
// 按「以 / 开头」一刀切会让整类技能调用都等 durable 事件才出现；真命令则照旧不回显。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  // 先发一条普通消息把会话建起来（命令目录随建会话预取，见 createSession 旁的 listCommandsFor）
  await c.handle({ type: "send", text: "建会话", attachments: [], gesture: "enter" }, "v1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.calls.includes("commands/list"), "前置：命令目录已预取");
  // 这一轮收尾（服务端 `turn/end`）：不摆的话会话一直停在「运行中」，下面的发送全算排队
  endTurn(client);
  // 那条 durable 承认（不带 rpcId 的旧口径）把第一条回显收掉，剩下要看的就只有后面这两条
  client.followers.session?.(userMessageEvent(1, "建会话"));
  assert.deepStrictEqual(c.pendingEchoesOfView("v1"), [], "前置：第一条回显已被承认收回");

  frames.length = 0;
  await c.handle({ type: "send", text: "/plan", attachments: [], gesture: "enter" }, "v1");
  assert.strictEqual(
    pendingOf(frames, "v1"),
    undefined,
    "目录里真有的命令不回显：它不是用户消息，执行记录由命令节点承载",
  );
  assert.ok(client.calls.includes("commands/execute"), "它确实走了命令通道");

  frames.length = 0;
  await c.handle({ type: "send", text: "/build 帮我构建", attachments: [], gesture: "enter" }, "v1");
  const echo = pendingOf(frames, "v1");
  assert.strictEqual(echo?.length, 1, "技能调用（长成 /xxx、但不在命令目录里）按下那一刻就回显");
  assert.strictEqual(echo?.[0]?.text, "/build 帮我构建", "回显里就是用户打的那一行（与 durable 行同文）");
  assert.strictEqual(client.prompts.at(-1)?.content.at(-1)?.text, "/build 帮我构建", "它作为普通消息发给模型");
  assert.strictEqual(
    client.prompts.at(-1)?.requestId,
    echo?.[0]?.requestId,
    "回显身份就是交给 prompt 的 requestId（durable 承认凭它配对）",
  );
}
// 六之三、**空态**第一条消息是 `/xxx`：按下那一刻还没有会话、没有命令目录，判不了——
// 那时不猜（不画一份可能要收回的回显），改在建好会话、确认「它不是命令」之后立刻补上。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "/build 帮我构建", attachments: [], gesture: "enter" }, "v1");

  const echoAt = client.timeline.indexOf("frame:echo");
  const createAt = client.timeline.indexOf("call:session/create");
  const promptAt = client.timeline.indexOf("call:session/prompt");
  console.log(`  空态斜杠：建会话 ${createAt}、补回显 ${echoAt}、发出去 ${promptAt}`);
  assert.ok(echoAt >= 0, "空态的技能调用也要回显（补判那一次）");
  assert.ok(createAt >= 0 && createAt < echoAt, "补回显必须在建会话之后（那时才有命令目录可查）");
  assert.ok(echoAt < promptAt, "补回显必须早于这一条真正发出去（否则还是「等发完才画」）");
  assert.strictEqual(pendingOf(frames, "v1")?.length, 1, "补出来的恰好一条");
  assert.strictEqual(client.prompts.at(-1)?.content.at(-1)?.text, "/build 帮我构建");
}
// 六之四、空态第一条消息是**真命令**：目录查得到就不补回显（一条都不许闪）
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "send", text: "/plan", attachments: [], gesture: "enter" }, "v1");
  assert.strictEqual(client.timeline.includes("frame:echo"), false, "真命令连补回显那一次都不发生");
  assert.strictEqual(pendingOf(frames, "v1"), undefined, "空态的真命令同样不进账本");
  assert.ok(client.calls.includes("commands/execute"), "它走了命令通道（不是发给模型）");
}

console.log("pendingEcho: 预渲染时机、迁移、无闪烁交接（直播+重放）、失败留存与跨会话保留、撤回重发、排队行为不变 ✓");

// ---------- 七、界面侧的折算（纯函数） ----------
{
  const {
    pendingRowKey,
    messageRowKey,
    pendingAsMessage,
    pendingVisible,
    pendingInsertIndex,
    pendingPlacement,
  } = await import("../src/webview/pendingMessage");
  type Echo = import("../src/shared/chat").PendingMessageView;
  const echo = (requestId: string, status: Echo["status"] = "sending"): Echo => ({
    requestId,
    ts: 1,
    text: `文本-${requestId}`,
    attachments: [{ id: "a1", kind: "file", name: "a.txt" }],
    status,
    ...(status === "failed" ? { error: "@sendFailed:boom" } : {}),
  });
  const user = (id: string, rpcId?: string): import("../src/shared/chat").MessageView => ({
    id,
    role: "user",
    ts: 0,
    text: "x",
    segments: [],
    ...(rpcId ? { rpcId } : {}),
  });

  // 1) 去重：durable 行已经在场时不再画回显；行 key 两边一致
  const echoes = [echo("e1"), echo("e2")];
  assert.deepStrictEqual(
    pendingVisible([user("u:1", "e1")], echoes).map((entry) => entry.requestId),
    ["e2"],
    "已被承认的那条让位给真实行（按 rpcId 去重）",
  );
  assert.strictEqual(
    messageRowKey(user("u:1", "e1")),
    pendingRowKey("e1"),
    "真实行与回显行必须是**同一个 key**（React 复用 DOM 节点，交接不重建）",
  );
  assert.strictEqual(messageRowKey(user("u:2")), "u:2", "没有 rpcId 的真实行照旧用消息 id");

  // 2) 插入位置：本轮助手行之前 / 末尾。判据与 `adapter` 的落位分支逐条对应：
  //    「助手行已经建出来、而它上方还没有用户消息」= 这一轮的提问还没落盘 → 插它前面
  const assistant = (id: string, streaming = false): import("../src/shared/chat").MessageView => ({
    id,
    role: "assistant",
    ts: 0,
    segments: [],
    streaming,
  });
  const openTurn = [assistant("a:1")];
  assert.strictEqual(
    pendingInsertIndex(openTurn),
    openTurn.length - 1,
    "末尾是本轮助手行、且它上方没有用户消息 → 插在它前面（真实行也落这里）",
  );
  const finishedTurn = [user("u:1", "a"), assistant("a:1")];
  assert.strictEqual(
    pendingInsertIndex(finishedTurn),
    finishedTurn.length,
    "上一轮的提问在助手行上方 → 这一轮还没开始，追加末尾（turn/start 后助手行会排在它下面）",
  );
  assert.strictEqual(pendingInsertIndex([user("u:1", "a")]), 1, "还没有助手行 → 追加末尾");
  const placement = pendingPlacement(openTurn, echoes);
  assert.deepStrictEqual(
    [placement.index, placement.before.map((e) => e.requestId), placement.after.map((e) => e.requestId)],
    [openTurn.length - 1, ["e1", "e2"], []],
    "账本里那几条都插在本轮助手行之前（保持发送先后）",
  );

  // 3) 折算成一行：身份 / 状态 / 动作字段都带过去
  const failed = pendingAsMessage(echo("f1", "failed"));
  assert.strictEqual(failed.role, "user", "回显在对话流里就是一条用户消息（复用 Message）");
  assert.strictEqual(failed.id, pendingRowKey("f1"), "行 id 带 p: 前缀（与 u:/a: 不撞）");
  assert.strictEqual(failed.rpcId, "f1", "行身份 = requestId");
  assert.strictEqual(failed.sendState, "failed");
  assert.strictEqual(failed.sendError, "@sendFailed:boom");
  assert.deepStrictEqual(failed.segments, [], "用户消息的正文不在 segments 里");
  assert.strictEqual(
    pendingAsMessage(echo("s1")).sendState,
    "sending",
    "还没落地的那条是 sending（界面不额外标记）",
  );
  assert.deepStrictEqual(
    Object.keys(pendingAsMessage(echo("s2"))).sort(),
    ["attachments", "id", "role", "rpcId", "segments", "sendState", "text", "ts"],
    "折算出来的用户行没有落点字段（落点连同排队/插话那一档一起删了）",
  );
}
console.log("pendingEcho: 界面侧去重、插入位置与折算 ✓");

// ---------- 八、界面接线：空态让位、行拼装、失败行的两个动作 ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /state\.messages\.length === 0 && visibleEchoes\.length === 0 \?/.test(app),
    "空态页要让位给回显：第一条消息发出去那一刻消息流就该出现",
  );
  assert.ok(
    /const messageRows = useMemo\(/.test(app) && /pushMessage\(pendingAsMessage\(echo\), false\)/.test(app),
    "真实消息与回显要在同一处拼装成行序列（两段各写一遍 props 迟早漂）",
  );
  assert.ok(
    /pendingPlacement\(state\.messages, visibleEchoes\)/.test(app),
    "账本里那几条都参与行拼装（它们全是「已经发出去」的；排队区那几条压根不在账本里）",
  );
  const message = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Message.tsx"),
    "utf8",
  );
  assert.ok(
    /message\.sendState === "failed" \? message\.rpcId : undefined/.test(message) &&
      /post\(\{ type: "resendPending", requestId: echoRequestId \}\)/.test(message) &&
      /post\(\{ type: "retractPending", requestId: echoRequestId \}\)/.test(message),
    "失败那一行要给出「重发 / 撤回」两个动作，并且真的发得出去（凭 rpcId 指认，不许发空身份）",
  );
  assert.ok(
    /resolveText\(message\.sendError, texts\)/.test(message) &&
      /className="msg-failed-reason"/.test(message),
    "失败原因要按当前语言解析后写在操作行里",
  );
  assert.ok(
    !/sendState === "queued"/.test(message),
    "排队那几条不在对话流里（它们在排队区，三枚队列动作由那里给），别在消息行上再抄一份",
  );
  assert.ok(
    !/transcriptEchoes/.test(app) && !/transcriptEchoes/.test(message),
    "界面侧不再有「哪些回显进对话流」这一档判据（账本里只有已发出的那一类）",
  );
  const composer = readFileSync(
    join(process.cwd(), "src", "webview", "components", "Composer.tsx"),
    "utf8",
  );
  assert.ok(
    !/pendingMessages|pendingDockItems|pendingRows/.test(composer),
    "排队区与改动前完全一样：只画服务端给的队列项，不吃乐观回显",
  );
}
console.log("pendingEcho: App / Message / Composer 的接线 ✓");
