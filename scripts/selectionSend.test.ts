/**
 * 「编辑器当前选区」芯片的**投递与发送安全**（评审 2026-11-24 第 1–5 条）：驱动真
 * `ChatController`（offline stub），只看发给窗口的帧与假客户端收到的调用。
 *
 * - **只投递给最近活动的窗口**：后台窗口不显示同一引用；活动目标切换时旧窗口的
 *   芯片被撤下，新活动窗口按**自己的会话执行目录**拿到引用；
 * - **按会话执行目录折引用**：目录之下才引用；另一个根 / 目录之外的文件不自动附带；
 * - **用户收起后不自动复活**：点 × / 发送收起后，仅重载页面（`ready` 重放）不得
 *   带回同一引用；下一次编辑器操作（`setSelectionFacts`）才解除，同引用也重显；
 * - **命令安全**：`/compact`、带参数的 `/model …` 带着芯片发送时仍走命令通道，
 *   命令行里**没有**引用；普通消息的实际提交（回显与 prompt 内容）才拼上引用。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络）。
 */
import assert from "node:assert";
import { join } from "node:path";
import { readFileSync } from "node:fs";

process.on("unhandledRejection", (error) => {
  console.error("[selectionSend] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const CWD = "C:\\work\\demo";
const FILE = `${CWD}\\src\\a.ts`;
const REF = "@src/a.ts#L12-L18";
const FACTS = { filePath: FILE, lines: { start: 12, end: 18 }, preview: "const x = 1;" };

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 假服务端：只记录调用；命令目录给「无参 /compact」与「带参 /model」两种形态。 */
function fakeClient() {
  const rows: { sessionId: string; cwd: string; blank: boolean; updatedAt: number; running: boolean }[] = [];
  const calls: string[] = [];
  /** `commands/execute` 收到的命令行（评审第 3 条的落点：命令行里不许混进引用）。 */
  const executed: string[] = [];
  const prompts: { sessionId: string; requestId: string; content: unknown[]; mode: string }[] = [];
  const followers: { session?: (value: unknown) => void; control?: (value: unknown) => void } = {};
  return {
    calls,
    executed,
    prompts,
    followers,
    rows,
    async cancel() {
      calls.push("session/cancel");
      return { accepted: true };
    },
    async createSession(target: { workspaceId?: string; cwd?: string }) {
      calls.push("session/create");
      const sessionId = `session-${rows.length + 1}`;
      rows.push({ sessionId, cwd: target.cwd ?? "", blank: true, updatedAt: Date.now() + rows.length, running: false });
      return { sessionId };
    },
    async listSessions() {
      return { items: rows.map((row) => ({ ...row })) };
    },
    async prompt(sessionId: string, content: unknown[], mode: string, requestId: string) {
      calls.push("session/prompt");
      prompts.push({ sessionId, content, mode, requestId });
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
          // `input.hint` 是服务端「声明了自由输入」的标记（带参数的行只对它成立）
          { name: "model", description: "切换模型", input: { hint: "<model>" } },
        ];
      }
      if (method === "commands/execute") {
        executed.push(String(params?.line ?? ""));
        return { result: { kind: "success", text: "ok" } };
      }
      if (method === "fileReferences/list") return [];
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "skills/list") return { skills: [] };
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

function makeController() {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  const client = fakeClient();
  (
    controller as never as { subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown }
  ).subscribe((target, frame) => {
    frames.push({ target, frame });
  });
  const c = controller as unknown as {
    client: unknown;
    connection: string;
    newSessionCwd?: string;
    bindView(viewId: string): void;
    noteActiveView(viewId: string): void;
    setSelectionFacts(facts: unknown): void;
    handle(message: Record<string, unknown>, viewId: string): Promise<void>;
  };
  c.newSessionCwd = CWD;
  c.client = client as never;
  c.connection = "connected";
  return { c, frames, client };
}

/** 最近一帧发给 viewId 的芯片帧；`frames` 里没有就是 undefined。 */
function lastChip(frames: Captured[], viewId: string): { context: unknown } | undefined {
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const { target, frame } = frames[i];
    if (target === viewId && frame.type === "ui/selectionContext") return frame as { context: unknown };
  }
  return undefined;
}

/** 轮询等一个测试侧条件成立（命令目录是异步预取的）。 */
async function waitFor(check: () => boolean, tries = 50): Promise<void> {
  for (let index = 0; index < tries; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(check(), "等待条件超时");
}

const commandLoadedOf = (c: unknown, viewId: string): boolean => {
  const inner = c as {
    viewSessions: Map<string, string>;
    scopes: Map<string, { commandsLoaded?: boolean } | undefined>;
  };
  const sessionId = inner.viewSessions.get(viewId);
  return inner.scopes.get(sessionId)?.commandsLoaded === true;
};

console.log("selectionSend: 芯片投递与发送安全（驱动真控制器，offline stub）");

// ---------- 1. 只投递给活动窗口；切换目标时撤下旧窗口 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  c.setSelectionFacts(FACTS);
  const chip = lastChip(frames, "v1")?.context as { token: string; preview: string } | null;
  assert.ok(chip, "活动窗口收到芯片帧");
  assert.strictEqual(chip.token, REF, "引用按会话执行目录（newSessionCwd）折出");
  assert.strictEqual(chip.preview, "const x = 1;", "预览原样随帧");

  // 目录之外的文件（多根工作区的另一个根）：不自动附带
  c.setSelectionFacts({ ...FACTS, filePath: "C:\\other\\proj\\b.ts" });
  assert.strictEqual(lastChip(frames, "v1")?.context, null, "执行目录之外的文件不附带（评审第 5 条）");
  c.setSelectionFacts(FACTS);

  // 第二个窗口成为活动目标：v1 的芯片被撤下，v2 拿到引用
  c.bindView("v2");
  c.noteActiveView("v2");
  assert.strictEqual(lastChip(frames, "v1")?.context, null, "目标切换时撤下旧窗口的芯片（评审第 1 条）");
  assert.strictEqual((lastChip(frames, "v2")?.context as { token: string } | null)?.token, REF, "新活动窗口拿到引用");
  console.log("selectionSend: 只投递活动窗口，切换撤旧 ✓");
}

// ---------- 2. 收起后不复活：ready 重放检查归属与「已收起」位 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  c.setSelectionFacts(FACTS);
  c.dismissSelectionContext("v1");
  assert.strictEqual(lastChip(frames, "v1")?.context, null, "点掉后撤下");

  // 仅重载页面（ready 重放）不得把同一引用带回来（评审第 2 条）
  await c.handle({ type: "ready" }, "v1");
  assert.strictEqual(
    lastChip(frames, "v1")?.context,
    null,
    "收起后 ready 重放不复活芯片",
  );

  // 下一次编辑器操作（哪怕算出的引用一模一样）解除「已收起」：重新显示
  c.setSelectionFacts(FACTS);
  assert.strictEqual(
    (lastChip(frames, "v1")?.context as { token: string } | null)?.token,
    REF,
    "新的编辑器操作重显芯片（同引用也算新操作）",
  );

  // 后台窗口的 ready 重放不投递：先把活动目标挪走，再让 v1 重载
  c.bindView("v2");
  c.noteActiveView("v2");
  const before = frames.filter(({ target, frame }) => target === "v1" && frame.type === "ui/selectionContext").length;
  await c.handle({ type: "ready" }, "v1");
  const after = frames.filter(({ target, frame }) => target === "v1" && frame.type === "ui/selectionContext").length;
  assert.strictEqual(after, before, "后台窗口的 ready 重放不重显引用（评审第 1 条）");
  console.log("selectionSend: 收起不复活，ready 检查归属 ✓");
}

// ---------- 3. 命令安全：引用不改变 /compact 与带参命令的含义 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  c.setSelectionFacts(FACTS);
  // 先发一条普通消息落壳（让窗口绑上会话、命令目录开始预取）
  await c.handle({ type: "send", text: "第一条", attachments: [], gesture: "enter" }, "v1");
  await waitFor(() => commandLoadedOf(c, "v1"));
  client.calls.length = 0;
  client.prompts.length = 0;

  // 无参命令 + 芯片：仍走命令通道，命令行不带引用，prompt 不被调用
  await c.handle(
    { type: "send", text: "/compact", attachments: [], gesture: "enter", autoReference: REF },
    "v1",
  );
  assert.ok(client.executed.includes("/compact"), "/compact 照常进命令通道（评审第 3 条）");
  assert.ok(
    client.executed.every((line) => !line.includes("@src")),
    "命令行里没有引用",
  );
  assert.strictEqual(client.prompts.length, 0, "命令不发给模型");
  const pending = frames
    .filter(({ target, frame }) => target === "v1" && frame.type === "patch")
    .map(({ frame }) => (frame.patch as { pendingMessages?: { text: string }[] } | undefined)?.pendingMessages)
    .at(-1);
  assert.strictEqual(pending?.length ?? 0, 0, "命令不留乐观回显（引用也没把它变成普通消息）");

  // 带参数命令 + 芯片：参数原样（声明了自由输入的命令），引用不混进去
  await c.handle(
    { type: "send", text: "/model gpt-5", attachments: [], gesture: "enter", autoReference: REF },
    "v1",
  );
  assert.ok(client.executed.includes("/model gpt-5"), "带参数命令整行照常执行");
  assert.strictEqual(client.prompts.length, 0, "带参数命令同样不发给模型");

  // 普通消息 + 芯片：实际提交（回显与 prompt 内容）拼上引用，原始草稿不变
  await c.handle(
    { type: "send", text: "帮我解释", attachments: [], gesture: "enter", autoReference: REF },
    "v1",
  );
  const prompt = client.prompts.at(-1);
  assert.ok(prompt, "普通消息照常 prompt");
  const textPart = prompt?.content.at(-1) as { type: string; text?: string } | undefined;
  assert.strictEqual(textPart?.type, "text");
  assert.strictEqual(
    textPart?.text,
    `帮我解释\n\n${REF}`,
    "prompt 内容带拼好的引用（正文与引用之间空一行）",
  );
  console.log("selectionSend: /compact 与带参数命令不受引用影响，普通消息才附加 ✓");
}

// ---------- 4. 接线源码钉：ready 重放的归属判据、事件即快照、点消息框即切换 ----------
{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  assert.ok(
    /viewId === this\.activeViewId\(\) && !this\.selectionDismissed/.test(source),
    "ready 重放必须同时检查「活动窗口」与「用户已收起」两道判据",
  );
  const extensionSource = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  for (const event of [
    "onDidChangeTextEditorSelection",
    "onDidChangeActiveTextEditor",
    "onDidChangeVisibleTextEditors",
  ]) {
    assert.ok(
      new RegExp(`${event}\\(\\(\\) => \\{\\n\\s+snapshotSelectionFacts\\(\\);`).test(extensionSource),
      `${event} 必须在事件那一刻快照（防抖只延迟投递，评审第 2 条）`,
    );
  }
  // 「点一下消息框就切窗口」的落点信号：文本域聚焦发 composerFocus（评审 1 的实机
  // 反馈——侧栏单击本来不产生任何宿主帧，活动窗口切不过去）；两处视图容器也要把
  // 「激活」算作活动。
  const composer = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    /onFocus=\{\(event\) => \{\s*\n\s*completion\.textareaProps\.onFocus\?\.\(event\);\s*\n\s*post\(\{ type: "composerFocus" \}\);/.test(composer),
    "文本域聚焦必须先跑补全的 onFocus 再发 composerFocus（两条都不许顶掉）",
  );
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.ok(
    /event\.webviewPanel\.visible \|\| event\.webviewPanel\.active/.test(chatView),
    "编辑区面板的激活（点进去）也要记活动窗口（侧栏视图公开 API 没有「激活」事件，靠 composerFocus 兜底）",
  );
  const controllerSource = source;
  assert.ok(
    /case "composerFocus":/.test(controllerSource),
    "宿主要显式接住 composerFocus 帧（活动登记在 attach 层，本身无语义）",
  );
  console.log("selectionSend: ready 归属判据、事件即快照、点消息框即切换的接线钉住 ✓");
}

console.log("\nselectionSend: all assertions passed");
