/**
 * 「编辑器当前选区」芯片的**投递与发送安全**（评审 2026-11-24 第 1–5 条）：驱动真
 * `ChatController`（offline stub），只看发给窗口的帧与假客户端收到的调用。
 *
 * - **只投递给最近活动的窗口**：后台挂载和 ready 不切换活动窗口；目标切换撤下旧引用，
 *   清掉待投递选区；切回来也不恢复，直到下一次编辑器操作；
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
import { setTimeout as delay } from "node:timers/promises";
import { relativeMentionPath } from "../src/shared/mentions";
import type { SelectionContextView, WebviewToHost } from "../src/shared/ipc";
import type { SelectionFacts } from "../src/dsh/selection";

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
  const logs: string[] = [];
  const controller = new ChatController(
    fakeServer() as never,
    (message) => logs.push(message),
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
    clearSelectionContext(reason: string): void;
    setSelectionFacts(facts: SelectionFacts): void;
    handle(message: WebviewToHost, viewId: string): Promise<void>;
    scopeOfView(viewId: string): { sessionId: string } | undefined;
    applyWorkingDirectoryProjection(scope: { sessionId: string }, value: string, present: boolean, source: "snapshot"): void;
    bindViewToSession(viewId: string, sessionId: string, scope: { sessionId: string }): void;
    detachView(viewId: string): void;
    afterRootChanged(viewId: string, action: { viewId: string; epoch: number }): Promise<void>;
  };
  c.newSessionCwd = CWD;
  c.client = client;
  c.connection = "connected";
  return { c, frames, client, logs };
}

function chipsFor(frames: Captured[], viewId: string): (SelectionContextView | null)[] {
  return frames.filter(({ target, frame }) => target === viewId && frame.type === "ui/selectionContext")
    .map(({ frame }) => frame.context as SelectionContextView | null);
}

/** 等实际防抖结束（包括应当什么也不投递的情形）。 */
function settleSelection(): Promise<void> {
  return delay(340);
}

async function showSelection(c: ReturnType<typeof makeController>["c"], frames: Captured[], viewId: string, facts = FACTS) {
  c.setSelectionFacts(facts);
  await settleSelection();
  const chip = chipsFor(frames, viewId).at(-1);
  assert.ok(chip, "活动窗口应收到有效的选区投递");
  return chip;
}

function send(text: string, selection?: SelectionContextView): WebviewToHost {
  return {
    type: "send", text, gesture: "enter",
    ...(selection && { autoReference: selection.token, autoReferenceId: selection.id }),
  };
}

function promptText(client: ReturnType<typeof fakeClient>): string | undefined {
  const block = client.prompts.at(-1)?.content.at(-1) as { type?: string; text?: string } | undefined;
  return block?.type === "text" ? block.text : undefined;
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

// ---------- 1. 首次开窗、被动 ready、窗口往返与待投递失效 ----------
{
  const { c, frames } = makeController();
  c.setSelectionFacts(FACTS);
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [], "ready 不抢跑首次防抖");
  await settleSelection();
  const initial = chipsFor(frames, "v1").at(-1);
  assert.ok(initial, "首次同目录的自动空会话可接收先开的选区");
  assert.strictEqual(initial.token, REF);
  assert.strictEqual(initial.preview, FACTS.preview);

  c.bindView("v2");
  await c.handle({ type: "ready" }, "v2");
  assert.deepStrictEqual(chipsFor(frames, "v2"), [], "后台窗口挂载及 ready 不抢活动，也不继承引用");
  c.noteActiveView("v1");
  await c.handle({ type: "ready" }, "v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [initial, initial], "同一活动窗口只重放已生效的引用");
  c.noteActiveView("v2");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "切走时同步撤下已显示的引用");
  c.setSelectionFacts(FACTS);
  c.noteActiveView("v1");
  c.noteActiveView("v2");
  await c.handle({ type: "ready" }, "v1");
  await c.handle({ type: "ready" }, "v2");
  await settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [initial, initial, null], "回原窗口及重载均不恢复旧选区");
  assert.deepStrictEqual(chipsFor(frames, "v2"), [], "切走再回来也不能保留待投递选区");
  console.log("selectionSend: 首次开窗、防抖、窗口往返与被动 ready ✓");
}

// ---------- 2. 收起与同窗口的会话绑定 / 脱离 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  const first = await showSelection(c, frames, "v1");
  await c.handle({ type: "selectionContextDismiss", id: first.id }, "v1");
  await c.handle({ type: "ready" }, "v1");
  c.noteActiveView("v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null], "收起后被动 ready 和同目标活动均不复活");

  const fresh = await showSelection(c, frames, "v1");
  assert.strictEqual(fresh.token, first.token);
  assert.notStrictEqual(fresh.id, first.id, "下一次真实选区操作可显示同 token，但必须是新投递");
  await c.handle({ type: "selectionContextDismiss", id: first.id }, "v1");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), fresh, "迟到的旧收起帧不影响同 token 的新投递");

  const scope = c.scopeOfView("v1");
  assert.ok(scope, "ready 已经绑定同目录空会话");
  c.detachView("v1");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "脱离会话同步清除已显示的引用");
  c.setSelectionFacts(FACTS);
  c.bindViewToSession("v1", scope.sessionId, scope);
  await c.handle({ type: "ready" }, "v1");
  await settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null, fresh, null], "显式绑定同目录会话也作废待投递引用");
  console.log("selectionSend: 收起不复活、迟到收起帧与会话边界 ✓");
}

// ---------- 3. 命令安全：引用不改变 /compact 与带参命令的含义 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  // 先让窗口绑定会话、预取命令，再投递供命令和普通消息使用的有效引用。
  await c.handle({ type: "ready" }, "v1");
  await waitFor(() => commandLoadedOf(c, "v1"));
  const selection = await showSelection(c, frames, "v1");
  client.calls.length = 0;
  client.prompts.length = 0;

  // 无参命令 + 芯片：仍走命令通道，命令行不带引用，prompt 不被调用
  await c.handle(send("/compact", selection), "v1");
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
  await c.handle(send("/model gpt-5", selection), "v1");
  assert.ok(client.executed.includes("/model gpt-5"), "带参数命令整行照常执行");
  assert.strictEqual(client.prompts.length, 0, "带参数命令同样不发给模型");

  // 普通消息 + 芯片：实际提交（回显与 prompt 内容）拼上引用，原始草稿不变
  await c.handle(send("帮我解释", selection), "v1");
  assert.strictEqual(
    promptText(client),
    `帮我解释\n\n${REF}`,
    "prompt 内容带拼好的引用（正文与引用之间空一行）",
  );
  console.log("selectionSend: /compact 与带参数命令不受引用影响，普通消息才附加 ✓");
}

// ---------- 4. 执行目录投影、路径边界与迟到发送 ----------
{
  assert.strictEqual(relativeMentionPath("c:/work/demo/", FILE), "src/a.ts", "只忽略盘符大小写");
  assert.strictEqual(relativeMentionPath("C:/", FILE), "work/demo/src/a.ts", "盘根可用");
  assert.strictEqual(relativeMentionPath("/", "/workspace/src/a.ts"), "workspace/src/a.ts", "POSIX 根可用");
  assert.strictEqual(relativeMentionPath("//srv/share/", "\\\\srv\\share\\a.ts"), "a.ts", "同一 UNC 根可用");
  for (const [root, file] of [
    ["D:/work/demo", FILE], ["c:/Work/demo", FILE], ["C:/work/dem", FILE],
    ["C:/work/demo", "C:/work/demo/../secret.ts"], ["//srv/share", "//srv/share2/file.ts"],
    ["/", "//srv/share/a.ts"], ["C:work/demo", FILE],
  ]) assert.strictEqual(relativeMentionPath(root, file), undefined, `${root} 不得跨根引用 ${file}`);

  const { c, frames, client, logs } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const scope = c.scopeOfView("v1");
  assert.ok(scope);
  c.applyWorkingDirectoryProjection(scope, "c:/work/demo/src", true, "snapshot");
  const old = await showSelection(c, frames, "v1");
  assert.strictEqual(old.token, "@a.ts#L12-L18", "工作目录投影优先于会话创建目录");
  c.applyWorkingDirectoryProjection(scope, "C:/work/demo/src/", true, "snapshot");
  await c.handle({ type: "ready" }, "v1");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), old, "仅盘符大小写或尾分隔符变化不改变目标");

  c.applyWorkingDirectoryProjection(scope, "C:/work/other", true, "snapshot");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "同会话切执行目录也同步撤下");
  c.setSelectionFacts(FACTS);
  assert.ok(logs.some((line) => line.includes("文件不在执行目录或路径不支持")), "诊断记录实际拦截原因");
  assert.ok(logs.filter((line) => line.startsWith("[selection]")).every((line) =>
    !line.includes(FACTS.preview) && !line.includes(FILE) && !line.includes(old.token)), "选区诊断不记录文件、引用或正文");
  await c.handle(send("旧界面发送", old), "v1");
  assert.strictEqual(promptText(client), "旧界面发送", "旧界面迟到发送不能附带其他目录的文件");

  const current = await showSelection(c, frames, "v1", { ...FACTS, filePath: "C:/work/other/a.ts" });
  assert.strictEqual(current.token, old.token, "不同文件可折出同一个相对 token");
  assert.notStrictEqual(current.id, old.id);
  await c.handle(send("相同 token 也不采纳迟到帧", old), "v1");
  assert.strictEqual(promptText(client), "相同 token 也不采纳迟到帧");
  await c.handle(send("仅采纳新投递", current), "v1");
  assert.strictEqual(promptText(client), `仅采纳新投递\n\n${current.token}`);
  c.applyWorkingDirectoryProjection(scope, "C:/work/demo/src", true, "snapshot");
  await c.handle({ type: "ready" }, "v1");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "切回旧 cwd 并重载也不会复活引用");
  console.log("selectionSend: 执行目录、盘符和根边界、相同 token 的迟到发送 ✓");
}

// ---------- 5. 未绑窗口的根切换也中止待投递 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  c.setSelectionFacts(FACTS);
  c.newSessionCwd = "D:/work/other";
  await c.afterRootChanged("v1", { viewId: "v1", epoch: 0 });
  c.newSessionCwd = CWD;
  await settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [], "未绑定时切走再回原根，也不能继承待投递选区");
}

// ---------- 6. 真实 VS Code 事件与视图活动的接线；不依赖源码换行符 ----------
{
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  const selectionListener = extension.split("vscode.window.onDidChangeTextEditorSelection(")[1]
    ?.split("vscode.window.onDidChangeActiveTextEditor(")[0];
  assert.ok(selectionListener?.includes("const primary = selections[0]"));
  assert.ok(selectionListener.includes("captureEditorSelection(textEditor, primary)"));
  assert.ok(!selectionListener.includes("activeTextEditor"));
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.match(chatView, /message\?\.type === "view\/activity"\)\s*\{\s*this\.controller\.noteActiveView\(viewId\);\s*return;/);
  assert.match(chatView, /const activated = active && !wasActive;\s*wasActive = active;\s*if \(activated\) this\.controller\.noteActiveView\(viewId\);/);
  console.log("selectionSend: 选区事件和活动帧的宿主接线 ✓");
}

console.log("\nselectionSend: all assertions passed");
