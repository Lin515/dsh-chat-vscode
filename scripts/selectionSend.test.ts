/**
 * 「编辑器当前选区」芯片的**投递与发送安全**（评审 2026-11-24 第 1–5 条）：驱动真
 * `ChatController`（offline stub），只看发给窗口的帧与假客户端收到的调用。
 *
 * - **只投递给最近活动的窗口**：后台挂载和 ready 不切换活动窗口；目标切换撤下旧引用，
 *   清掉待投递选区；切回来也不恢复，直到下一次编辑器操作；
 * - **按会话执行目录折引用**：目录之下才引用；另一个根 / 目录之外的文件不自动附带；
 * - **手动引用同一条链**：编辑器选区 / 空选区整文件 / 目录都按目标会话执行目录折算，
 *   目录之外退绝对路径；工作区相对拼写（多根会带文件夹名）不再被直接插入；
 * - **用户收起后不自动复活**：点 × / 发送收起后，仅重载页面（`ready` 重放）不得
 *   带回同一引用；下一次编辑器操作（`setSelectionFacts`）才解除，同引用也重显；
 * - **命令安全**：`/compact`、带参数的 `/model …` 带着芯片发送时仍走命令通道，
 *   命令行里**没有**引用；普通消息的实际提交（回显与 prompt 内容）才拼上引用。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络）。
 */
import assert from "node:assert";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import * as vscode from "vscode";
import { commands } from "./vscodeTestStub";
import { relativeMentionPath } from "../src/shared/mentions";
import type { ModelSelectionView } from "../src/shared/chat";
import type { SelectionContextView, WebviewToHost } from "../src/shared/ipc";
import { editorReferenceSource } from "../src/dsh/editorReference";
import { remoteFileReference, localFileReference, selectionLines, type SelectionFacts } from "../src/dsh/selection";
import { remoteFileUri } from "../src/dsh/remoteFileSystem";
import { AGENT_DIFF_SCHEME } from "../src/dsh/agentDiffDocuments";
import type { HostFileAccess } from "../src/dsh/remoteFiles";

process.on("unhandledRejection", (error) => {
  console.error("[selectionSend] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");

const CWD = "C:\\work\\demo";
const FILE = `${CWD}\\src\\a.ts`;
const REF = "@src/a.ts#L12-L18";
const FACTS = { filePath: FILE, lines: { start: 12, end: 18 }, preview: "const x = 1;" };
const MORE_LINES = { ...FACTS, lines: { start: 12, end: 19 } };

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
  const files = new Map<string, Set<string>>();
  const fileStats: { workspaceFileScopeId: string; path: string }[] = [];
  return {
    calls,
    executed,
    prompts,
    followers,
    rows,
    files,
    fileStats,
    async selectModel() {},
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
      if (method === "workspaceFiles/stat") {
        const workspaceFileScopeId = String(params?.workspaceFileScopeId);
        const path = String(params?.path);
        fileStats.push({ workspaceFileScopeId, path });
        if (!files.get(workspaceFileScopeId)?.has(path)) throw new Error("unexpected file stat");
        return { absolutePath: path, version: "v1" };
      }
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

function makeController({ cwd = CWD, remoteFiles = false } = {}) {
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
    adoptClient(client: ReturnType<typeof fakeClient>): void;
    hostFiles?: HostFileAccess;
    bindView(viewId: string): void;
    noteActiveView(viewId: string): void;
    clearSelectionContext(reason: string): void;
    deferSelectionCollapse(): void;
    setSelectionFacts(facts: SelectionFacts): void;
    handle(message: WebviewToHost, viewId: string): Promise<void>;
    scopeOfView(viewId: string): { sessionId: string; pendingModel?: ModelSelectionView } | undefined;
    applyWorkingDirectoryProjection(scope: { sessionId: string }, value: string, present: boolean, source: "snapshot"): void;
    bindViewToSession(viewId: string, sessionId: string, scope: { sessionId: string }): void;
    detachView(viewId: string): void;
    afterRootChanged(viewId: string, action: { viewId: string; epoch: number }): Promise<void>;
    attachmentIds(viewId: string): string[];
    putAttachment(
      viewId: string,
      attachment: {
        id: string;
        kind: "file" | "image";
        name: string;
        upload?: { status: "ready"; receiptId: string };
      },
    ): void;
  };
  const inner = controller as unknown as {
    attachments: {
      list(key: string | undefined): readonly { id: string }[];
      add(key: string, attachments: readonly { id: string }[]): void;
    };
    keyForView(viewId: string): string;
  };
  c.attachmentIds = (viewId) => inner.attachments.list(inner.keyForView(viewId)).map((item) => item.id);
  c.putAttachment = (viewId, attachment) => inner.attachments.add(inner.keyForView(viewId), [attachment]);
  c.newSessionCwd = cwd;
  if (remoteFiles) c.adoptClient(client);
  else c.client = client;
  c.connection = "connected";
  return { controller, c, frames, client, logs };
}

function chipsFor(frames: Captured[], viewId: string): (SelectionContextView | null)[] {
  return frames.filter(({ target, frame }) => target === viewId && frame.type === "ui/selectionContext")
    .map(({ frame }) => frame.context as SelectionContextView | null);
}

/** 推进真控制器的防抖，不依赖实际等待或事件循环负载。 */
function settleSelection(): void {
  mock.timers.tick(300);
}

async function showSelection(c: ReturnType<typeof makeController>["c"], frames: Captured[], viewId: string, facts: SelectionFacts = FACTS) {
  c.setSelectionFacts(facts);
  settleSelection();
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
mock.timers.enable({ apis: ["setTimeout"] });

// ---------- 同目标拖动只原子替换，ready 仍可重放旧外观，但旧引用不能发送 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const first = await showSelection(c, frames, "v1");
  c.setSelectionFacts(MORE_LINES);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first], "同目标拖动不得先发 null");
  mock.timers.tick(200);
  const latest = { ...FACTS, lines: { start: 12, end: 20 }, preview: "new preview" };
  c.setSelectionFacts(latest);
  await c.handle({ type: "ready" }, "v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first], "ready 只重放当前可见的占位引用");
  await c.handle(send("仍在拖动", first), "v1");
  assert.strictEqual(promptText(client), "仍在拖动", "待投递时占位引用不能随发送提交");
  mock.timers.tick(299);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first], "按最后一次选区事件计算防抖");
  mock.timers.tick(1);
  const replacement = chipsFor(frames, "v1").at(-1);
  assert.ok(replacement);
  assert.strictEqual(replacement.token, "@src/a.ts#L12-L20");
  assert.strictEqual(replacement.preview, latest.preview);
  assert.notStrictEqual(replacement.id, first.id);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first, replacement], "新引用原子替换且无中间空帧");
  await c.handle({ type: "selectionContextDismiss", id: first.id }, "v1");
  await c.handle(send("旧引用迟到", first), "v1");
  assert.strictEqual(promptText(client), "旧引用迟到");
  await c.handle(send("拖动结束", replacement), "v1");
  assert.strictEqual(promptText(client), `拖动结束\n\n${replacement.token}`, "迟到旧标识不能撤下已经替换的新引用");
}

// ---------- 手动引用与自动引用同一条链：按目标会话执行目录折算 ----------
//
// 编辑器命令只把**绝对路径**交给控制器，折算在这里完成。多根工作区的
// workspace.asRelativePath 会带上工作区文件夹名，那个拼写按会话目录再解释一次就会
// 指向 <cwd>/<文件夹名>/…；所以「工作区相对拼写」不能再被当成执行世界相对路径。
{
  const { controller, c, frames } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const insertions = () => frames.flatMap(({ target, frame }) =>
    frame.type === "ui/insertText" ? [{ target, text: frame.text }] : []);

  controller.addSelection(FILE, { start: 12, end: 18 });
  assert.deepStrictEqual(insertions().at(-1), { target: "v1", text: REF },
    "选区按目标会话执行目录折相对路径，而不是把本机绝对路径插进去");

  controller.addSelection("C:/work/other/src/a.ts", { start: 1, end: 2 });
  assert.deepStrictEqual(insertions().at(-1), { target: "v1", text: "@C:/work/other/src/a.ts#L1-L2" },
    "多根工作区的另一个根退回可表示的绝对路径，绝不带工作区文件夹名");

  // `Uri.fsPath` 给的是小写盘符；回退绝对路径时统一成大写（与工作目录显示同一口径）。
  controller.addSelection("c:/work/other/src/a.ts", { start: 1, end: 2 });
  assert.deepStrictEqual(insertions().at(-1), { target: "v1", text: "@C:/work/other/src/a.ts#L1-L2" },
    "完整路径的盘符统一大写，路径其余部分的大小写保持原样");

  const before = insertions().length;
  controller.addSelection("demo/src/a.ts", { start: 1, end: 2 });
  assert.strictEqual(insertions().length, before,
    "旧链路的工作区文件夹名拼写不能被当成执行世界相对路径直接插入");

  const scope = c.scopeOfView("v1");
  assert.ok(scope);
  c.applyWorkingDirectoryProjection(scope, "C:/work/moved", true, "snapshot");
  controller.addSelection(FILE, { start: 12, end: 18 });
  assert.deepStrictEqual(insertions().at(-1), { target: "v1", text: "@C:/work/demo/src/a.ts#L12-L18" },
    "绑定会话的执行目录不再是窗口根时，目录之外的文件退回绝对路径");
  controller.addFileContext(FILE);
  assert.deepStrictEqual(insertions().at(-1), { target: "v1", text: "@C:/work/demo/src/a.ts" },
    "整文件入口与选区委派同一份折算（不再按窗口根）");
}

// ---------- 往返同一选区及鼠标拖过锚点 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  const first = await showSelection(c, frames, "v1");
  c.setSelectionFacts(MORE_LINES);
  c.deferSelectionCollapse();
  await c.handle({ type: "ready" }, "v1");
  // 首次 ready 自动补同目录空会话，展示态与待投递态同时迁移。
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first], "鼠标拖过锚点不清除；ready 只同步占位");
  await c.handle(send("锚点处发送", first), "v1");
  assert.strictEqual(promptText(client), "锚点处发送", "暂时为空时不能发送占位引用");
  mock.timers.tick(100);
  c.setSelectionFacts(FACTS);
  c.setSelectionFacts(FACTS);
  mock.timers.tick(299);
  await c.handle(send("再次选中但尚未稳定", first), "v1");
  assert.strictEqual(promptText(client), "再次选中但尚未稳定", "重复事件不能抢跑、使旧标识提前有效");
  mock.timers.tick(1);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first], "回到相同选区不闪、不重新投递");
  await c.handle(send("稳定后原标识可用", first), "v1");
  assert.strictEqual(promptText(client), `稳定后原标识可用\n\n${REF}`);

  c.deferSelectionCollapse();
  mock.timers.tick(299);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first], "鼠标折叠到防抖结束前留作占位");
  mock.timers.tick(1);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first, null], "鼠标选区持续为空才清除");
  c.setSelectionFacts(FACTS);
  c.deferSelectionCollapse();
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, first, null], "无展示时鼠标折叠取消待投递选区");
}

// ---------- 收起占位同时取消替换，禁止重放和迟到发送 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const first = await showSelection(c, frames, "v1");
  c.setSelectionFacts(MORE_LINES);
  await c.handle({ type: "selectionContextDismiss", id: first.id }, "v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null], "点占位 × 同步收起");
  await c.handle({ type: "ready" }, "v1");
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null], "收起取消待投递；防抖与 ready 都不复活");
  await c.handle(send("收起后迟到发送", first), "v1");
  assert.strictEqual(promptText(client), "收起后迟到发送");
  const fresh = await showSelection(c, frames, "v1", MORE_LINES);
  assert.notStrictEqual(fresh.id, first.id, "下一次编辑器操作可显示新引用");
  c.setSelectionFacts(FACTS);
  await c.handle({ type: "selectionContextDismiss", id: first.id }, "v1");
  settleSelection();
  const replacement = chipsFor(frames, "v1").at(-1);
  assert.ok(replacement);
  assert.strictEqual(replacement.token, REF);
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null, fresh, replacement], "迟到标识不能收起另一张占位或取消替换");
}

// ---------- 1. 首次开窗、被动 ready、窗口往返与待投递失效 ----------
{
  const { c, frames } = makeController();
  c.setSelectionFacts(FACTS);
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [], "ready 不抢跑首次防抖");
  settleSelection();
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
  c.setSelectionFacts(MORE_LINES);
  c.noteActiveView("v2");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "切走时同步撤下已显示的引用");
  c.setSelectionFacts(FACTS);
  c.noteActiveView("v1");
  c.noteActiveView("v2");
  await c.handle({ type: "ready" }, "v1");
  await c.handle({ type: "ready" }, "v2");
  settleSelection();
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
  c.setSelectionFacts(MORE_LINES);
  c.detachView("v1");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "脱离会话同步清除已显示的引用");
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null, fresh, null], "脱离会话也取消替换");
  c.setSelectionFacts(FACTS);
  c.bindViewToSession("v1", scope.sessionId, scope);
  await c.handle({ type: "ready" }, "v1");
  settleSelection();
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

  c.setSelectionFacts(MORE_LINES);
  c.applyWorkingDirectoryProjection(scope, "C:/work/other", true, "snapshot");
  assert.strictEqual(chipsFor(frames, "v1").at(-1), null, "同会话切执行目录也同步撤下");
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [old, old, null], "切目录也取消替换");
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

// ---------- 文件不支持或非鼠标折叠仍立即撤下 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  const first = await showSelection(c, frames, "v1");
  c.setSelectionFacts(MORE_LINES);
  c.setSelectionFacts({ ...FACTS, filePath: "D:/unsupported.ts" });
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null], "不支持的路径不保留占位");
  settleSelection();
  const current = await showSelection(c, frames, "v1");
  c.deferSelectionCollapse();
  c.clearSelectionContext("选区为空");
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null, current, null], "明确折叠不等鼠标防抖");
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [first, null, current, null]);
}

// ---------- 5. 未绑窗口的根切换也中止待投递 ----------
{
  const { c, frames } = makeController();
  c.bindView("v1");
  c.setSelectionFacts(FACTS);
  c.newSessionCwd = "D:/work/other";
  await c.afterRootChanged("v1", { viewId: "v1", epoch: 0 });
  c.newSessionCwd = CWD;
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "v1"), [], "未绑定时切走再回原根，也不能继承待投递选区");
}

// ---------- 6. 真实 VS Code 事件与视图活动的接线；不依赖源码换行符 ----------
{
  const extension = readFileSync(join(process.cwd(), "src", "extension.ts"), "utf8");
  const selectionListener = extension.split("vscode.window.onDidChangeTextEditorSelection(")[1]
    ?.split("vscode.window.onDidChangeActiveTextEditor(")[0];
  assert.ok(selectionListener?.includes("const primary = selections[0]"));
  assert.ok(selectionListener.includes("captureEditorSelection(textEditor, primary, kind === vscode.TextEditorSelectionChangeKind.Mouse)"));
  assert.match(extension, /if \(mouse && editor === selectionSourceEditor\) return controller\.deferSelectionCollapse\(\);\s*return clearEditorSelection\("选区为空"\);/);
  assert.ok(!selectionListener.includes("activeTextEditor"));
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.match(chatView, /owner\.attachPanel\(panel, true\)/, "序列化器恢复必须把「恢复」身份传进 attachPanel");
  assert.match(
    chatView,
    /if \(restored && panel\.active\) this\.controller\.noteRestoredActiveView\(viewId\);/,
    "只有初始 active 的恢复面板才登记默认，且走独立入口而不是 noteActiveView",
  );
  assert.match(chatView, /message\?\.type === "view\/activity"\)\s*\{\s*this\.controller\.noteActiveView\(viewId\);\s*return;/);
  assert.match(chatView, /const activated = active && !wasActive;\s*wasActive = active;\s*if \(activated\) this\.controller\.noteActiveView\(viewId\);/);
  console.log("selectionSend: 选区事件和活动帧的宿主接线 ✓");
}

// ---------- 7. 执行世界只读文档：真实打开 → 编辑器来源 → 引用投递与实际发送 ----------
{
  const root = join(tmpdir(), "dsh-chat-readonly-selection");
  const creationCwd = join(root, "creation");
  const executionCwd = join(root, "execution");
  const basename = "shared file.ts";
  const insidePath = join(executionCwd, "src", basename);
  const outsidePath = join(creationCwd, "src", basename);
  const absoluteMention = outsidePath.split(sep).join("/");
  const relativeRange = '@"src/shared file.ts#L12-L18"';
  const absoluteRange = `@"${absoluteMention}#L12-L18"`;
  const wholeFile = '@"src/shared file.ts"';
  const { controller, c, frames, client } = makeController({ cwd: creationCwd, remoteFiles: true });
  c.bindView("owner");
  await c.handle({ type: "ready" }, "owner");
  const scope = c.scopeOfView("owner");
  const access = c.hostFiles;
  assert.ok(scope && access);
  const { sessionId } = scope;
  const { connectionId } = access;
  assert.strictEqual(client.rows.find((row) => row.sessionId === sessionId)?.cwd, creationCwd);
  client.files.set(sessionId, new Set([insidePath, outsidePath]));
  c.applyWorkingDirectoryProjection(scope, executionCwd, true, "snapshot");

  // 两条链接实际经过 controller 的打开入口和 Host stat；只截获 VS Code 最后的打开调用。
  const openCommand = mock.method(commands, "executeCommand");
  let opened: vscode.Uri[];
  try {
    await c.handle({ type: "openFile", path: join("src", basename), link: true }, "owner");
    await c.handle({ type: "openFile", path: outsidePath, link: true }, "owner");
    opened = openCommand.mock.calls.flatMap(({ arguments: [command, arg] }) =>
      command === "vscode.open" ? [arg as vscode.Uri] : []);
  } finally {
    openCommand.mock.restore();
  }
  assert.deepStrictEqual(client.fileStats, [
    { workspaceFileScopeId: sessionId, path: insidePath },
    { workspaceFileScopeId: sessionId, path: outsidePath },
  ]);
  assert.strictEqual(opened.length, 2);
  const [insideUri, outsideUri] = opened;
  assert.strictEqual(insideUri.scheme, "dsh-chat-world");
  assert.strictEqual(insideUri.path, outsideUri.path, "同名文件的展示路径没有身份信息");
  assert.notStrictEqual(insideUri.fsPath, insidePath, "只读资源的 fsPath 不是执行世界路径");
  const inside = editorReferenceSource(insideUri)?.remoteFile;
  const outside = editorReferenceSource(outsideUri)?.remoteFile;
  assert.deepStrictEqual(inside, { sessionId, connectionId, path: insidePath }, "编辑器取回真实 URI 的原始身份");
  assert.deepStrictEqual(outside, { sessionId, connectionId, path: outsidePath }, "同名文件不会被合并");
  assert.ok(inside && outside);

  const diff = new vscode.TabInputTextDiff(insideUri, outsideUri);
  assert.strictEqual(editorReferenceSource(insideUri, diff), undefined, "真实只读 URI 在 diff 左侧也不引用");
  assert.strictEqual(editorReferenceSource(outsideUri, diff), undefined, "真实只读 URI 在 diff 右侧也不引用");
  const snapshot = vscode.Uri.from({ scheme: AGENT_DIFF_SCHEME, path: `/src/${basename}`, query: "id=1&side=after" });
  assert.strictEqual(editorReferenceSource(snapshot), undefined, "单独打开的历史快照也不引用");
  const unrelatedDiff = new vscode.TabInputTextDiff(outsideUri, snapshot);
  assert.deepStrictEqual(editorReferenceSource(insideUri, unrelatedDiff), { remoteFile: inside }, "同名 URI 不代表同一个 diff 资源");
  const malformed = vscode.Uri.from({ scheme: insideUri.scheme, path: insideUri.path, query: "id=bad" });
  assert.strictEqual(editorReferenceSource(malformed), undefined, "无效身份不能回落到 URI 展示路径");

  const lines = selectionLines({ start: { line: 11, character: 0 }, end: { line: 18, character: 0 } });
  assert.deepStrictEqual(lines, { start: 12, end: 18 });
  const insideFacts = { remoteFile: inside, lines, preview: "选中的代码" };
  const outsideFacts = { ...insideFacts, remoteFile: outside };
  const relative = await showSelection(c, frames, "owner", insideFacts);
  assert.strictEqual(relative.token, relativeRange, "相对执行 cwd，而不是会话创建 cwd 或 basename");

  // 切到另一个同名文件所在的目录时，防抖内的旧选区不能按新 cwd 重新折算。
  c.setSelectionFacts(outsideFacts);
  c.applyWorkingDirectoryProjection(scope, creationCwd, true, "snapshot");
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "owner"), [relative, null]);
  await c.handle(send("切目录后的迟到帧", relative), "owner");
  assert.strictEqual(promptText(client), "切目录后的迟到帧");
  c.applyWorkingDirectoryProjection(scope, executionCwd, true, "snapshot");
  const relativeAgain = await showSelection(c, frames, "owner", insideFacts);
  await c.handle(send("引用执行目录中的文件", relativeAgain), "owner");
  assert.strictEqual(client.prompts.at(-1)?.sessionId, sessionId);
  assert.strictEqual(promptText(client), `引用执行目录中的文件\n\n${relativeRange}`);
  const absolute = await showSelection(c, frames, "owner", outsideFacts);
  assert.strictEqual(absolute.token, absoluteRange, "目录外同名文件保留带空格的绝对路径，锚点在引号内");
  await c.handle(send("引用创建目录中的文件", absolute), "owner");
  assert.strictEqual(client.prompts.at(-1)?.sessionId, sessionId);
  assert.strictEqual(promptText(client), `引用创建目录中的文件\n\n${absoluteRange}`);

  const cursor = { line: 11, character: 0 };
  const noLines = selectionLines({ start: cursor, end: cursor });
  assert.strictEqual(noLines, undefined);
  const full = await showSelection(c, frames, "owner", { remoteFile: inside, lines: noLines, preview: "" });
  assert.strictEqual(full.token, wholeFile, "file 档的空选区只附整文件引用");
  await c.handle(send("引用整文件", full), "owner");
  assert.strictEqual(promptText(client), `引用整文件\n\n${wholeFile}`);

  const revealed: string[] = [];
  controller.registerRevealer("owner", () => { revealed.push("owner"); });
  const insertions = () => frames.flatMap(({ target, frame }) =>
    frame.type === "ui/insertText" ? [{ target, text: frame.text }] : []);
  controller.addRemoteFileContext(outside, lines);
  controller.addRemoteFileContext(inside, noLines);
  const expectedInserts = [{ target: "owner", text: absoluteRange }, { target: "owner", text: wholeFile }];
  assert.deepStrictEqual(insertions(), expectedInserts, "手动选区和整文件都只向所属活动窗口插入引用");
  assert.deepStrictEqual(revealed, ["owner", "owner"]);

  c.bindView("other");
  await c.handle({ type: "ready" }, "other");
  const otherScope = c.scopeOfView("other");
  assert.ok(otherScope && otherScope.sessionId !== sessionId, "同一连接上确实还有另一条会话");
  c.applyWorkingDirectoryProjection(otherScope, executionCwd, true, "snapshot");
  controller.registerRevealer("other", () => { revealed.push("other"); });
  c.noteActiveView("other");
  const ownerChips = chipsFor(frames, "owner");
  c.setSelectionFacts(insideFacts);
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "other"), [], "同 cwd 的另一会话也不是源 URI 的目标");
  assert.deepStrictEqual(chipsFor(frames, "owner"), ownerChips, "不能跳过活动窗口，反向搜索源会话投递");
  controller.addRemoteFileContext(inside, lines);
  await c.handle(send("其他会话的迟到帧", full), "other");
  assert.strictEqual(client.prompts.at(-1)?.sessionId, otherScope.sessionId);
  assert.strictEqual(promptText(client), "其他会话的迟到帧");
  c.bindView("unbound");
  c.noteActiveView("unbound");
  assert.strictEqual(c.scopeOfView("unbound"), undefined);
  c.setSelectionFacts(insideFacts);
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "unbound"), [], "未绑定的活动窗口不能猜会话");
  controller.addRemoteFileContext(inside, noLines);
  assert.deepStrictEqual(insertions(), expectedInserts, "无效手势既不插入其他窗口，也不搜索源窗口");
  assert.deepStrictEqual(revealed, ["owner", "owner"]);

  c.noteActiveView("owner");
  const another = makeController({ cwd: creationCwd, remoteFiles: true }).c.hostFiles;
  assert.ok(another && another.connectionId !== connectionId);
  const rejectAddress = (remoteFile: NonNullable<SelectionFacts["remoteFile"]>, reason: string) => {
    const before = chipsFor(frames, "owner");
    c.setSelectionFacts({ ...insideFacts, remoteFile });
    settleSelection();
    assert.deepStrictEqual(chipsFor(frames, "owner"), before, reason);
    controller.addRemoteFileContext(remoteFile, lines);
    assert.deepStrictEqual(insertions(), expectedInserts, reason);
    assert.deepStrictEqual(revealed, ["owner", "owner"], reason);
  };
  // 仍然经过 URI 解析；地址可解码不等于该连接可用。
  for (const badId of ["unknown-connection", another.connectionId]) {
    const bad = editorReferenceSource(remoteFileUri({ ...inside, connectionId: badId }))?.remoteFile;
    assert.ok(bad, "连接是否有效应由控制器判断，而不是 URI 解码器猜测");
    rejectAddress(bad, "未知连接或属于另一控制器的连接不能回落到当前连接");
  }
  const replacement = fakeClient();
  replacement.rows.push(...client.rows);
  c.setSelectionFacts(insideFacts);
  c.adoptClient(replacement);
  assert.strictEqual(access.isClosed, true);
  settleSelection();
  assert.deepStrictEqual(chipsFor(frames, "owner").at(-1), null, "连接替换作废待投递的旧 URI");
  rejectAddress(inside, "原连接已关闭；即使会话 id 相同也不能重新解释旧 URI");
  await c.handle(send("连接更换后的迟到帧", full), "owner");
  assert.strictEqual(replacement.prompts.at(-1)?.sessionId, sessionId);
  assert.strictEqual(promptText(replacement), "连接更换后的迟到帧");
  const activeAccess = c.hostFiles;
  assert.ok(activeAccess && !activeAccess.isClosed);
  const closing = { ...inside, connectionId: activeAccess.connectionId };
  const beforeClose = await showSelection(c, frames, "owner", { ...insideFacts, remoteFile: closing });
  assert.strictEqual(beforeClose.token, relativeRange);
  activeAccess.close();
  assert.strictEqual(c.hostFiles, activeAccess, "连接已关闭但仍是当前文件访问对象");
  await c.handle(send("连接关闭后的迟到帧", beforeClose), "owner");
  assert.strictEqual(promptText(replacement), "连接关闭后的迟到帧");
  rejectAddress(closing, "当前连接 id 匹配，但访问对象已关闭，不能再接受自动或手动引用");
  assert.strictEqual(client.fileStats.length, 2, "引用不再次 stat 或读取文件");
  assert.strictEqual(replacement.fileStats.length, 0, "旧 URI 不发送到替换后的连接");
  another.close();
  console.log("selectionSend: 只读 URI 真实打开、发送、手动插入和会话/连接隔离 ✓");
}

// ---------- 8. 按下发送之后、真正 prompt 之前，原工作目录 / 会话绑定 / 连接仍须成立 ----------
for (const change of ["cwd", "session", "connection"] as const) {
  const root = join(tmpdir(), "dsh-chat-readonly-selection-submit", change);
  const cwd = join(root, "before");
  const nextCwd = join(root, "after");
  const { c, client, frames } = makeController({ cwd, remoteFiles: true });
  c.bindView("owner");
  await c.handle({ type: "ready" }, "owner");
  const scope = c.scopeOfView("owner");
  const access = c.hostFiles;
  assert.ok(scope && access);

  // 另开同一会话的镜像窗口，用来观察原会话的回填（即使发起发送的窗口切走了）。
  c.bindView("mirror");
  c.bindViewToSession("mirror", scope.sessionId, scope);
  c.newSessionCwd = nextCwd;
  c.bindView("other");
  await c.handle({ type: "ready" }, "other");
  const otherScope = c.scopeOfView("other");
  assert.ok(otherScope && otherScope.sessionId !== scope.sessionId);
  c.noteActiveView("owner");

  const chip = await showSelection(c, frames, "owner", {
    remoteFile: { sessionId: scope.sessionId, connectionId: access.connectionId, path: join(cwd, "one file.ts") },
    preview: "",
  });
  assert.strictEqual(chip.token, '@"one file.ts"');
  scope.pendingModel = { provider: "test", model: "test", label: "test" };
  let releaseModel = () => {};
  const modelResponse = new Promise<void>((resolve) => { releaseModel = resolve; });
  const modelRpc = mock.method(client, "selectModel", () => modelResponse);
  const draft = "等待模型选择时发送";
  const sending = c.handle(send(draft, chip), "owner");
  const replacement = fakeClient();
  const before = frames.length;
  try {
    await waitFor(() => modelRpc.mock.callCount() === 1);
    assert.deepStrictEqual(client.prompts, [], "原模型选择 RPC 尚未返回");
    if (change === "cwd") {
      c.applyWorkingDirectoryProjection(scope, nextCwd, true, "snapshot");
    } else if (change === "session") {
      c.bindViewToSession("owner", otherScope.sessionId, otherScope);
    } else {
      replacement.rows.push(...client.rows);
      c.adoptClient(replacement);
    }
  } finally {
    releaseModel();
    await sending;
    modelRpc.mock.restore();
  }
  assert.deepStrictEqual(client.prompts, [], `${change}：旧目标不得收到 prompt`);
  assert.deepStrictEqual(replacement.prompts, [], `${change}：新目标不得收到旧引用`);
  const restored = frames.slice(before).flatMap(({ target, frame }) => {
    const patch = frame.patch as { draft?: string } | undefined;
    return frame.type === "patch" && patch?.draft ? [{ target, draft: patch.draft }] : [];
  });
  assert.deepStrictEqual(restored.filter(({ target }) => target === "mirror"), [{ target: "mirror", draft }],
    `${change}：只还回原始正文，不把失效的自动引用写进草稿`);
  assert.deepStrictEqual(restored.filter(({ target }) => target === "other" || (change === "session" && target === "owner")), [],
    `${change}：不回填到别的会话`);
  c.hostFiles?.close();
}
console.log("selectionSend: 发送在等待模型时变更目录/会话/连接，收回引用并回填原会话 ✓");

// ---------- 8b. 本机相对引用同样在真正 prompt 之前复核目标会话 / 执行目录 ----------
for (const change of ["cwd", "session"] as const) {
  const root = join(tmpdir(), "dsh-chat-local-selection-submit", change);
  const cwd = join(root, "before");
  const nextCwd = join(root, "after");
  const { c, client, frames } = makeController({ cwd });
  c.bindView("owner");
  await c.handle({ type: "ready" }, "owner");
  const scope = c.scopeOfView("owner");
  assert.ok(scope);

  // 同一会话的镜像窗口观察原会话回填；另一会话用来验证 stale 后不会改道。
  c.bindView("mirror");
  c.bindViewToSession("mirror", scope.sessionId, scope);
  c.newSessionCwd = nextCwd;
  c.bindView("other");
  await c.handle({ type: "ready" }, "other");
  const otherScope = c.scopeOfView("other");
  assert.ok(otherScope && otherScope.sessionId !== scope.sessionId);
  c.noteActiveView("owner");

  const chip = await showSelection(c, frames, "owner", {
    filePath: join(cwd, "one file.ts"),
    preview: "",
  });
  assert.strictEqual(chip.token, '@"one file.ts"', "本机选区按执行目录折相对引用");
  const attachment = {
    id: "local-cwd-a1",
    kind: "file" as const,
    name: "notes.txt",
    upload: { status: "ready" as const, receiptId: "r-local-cwd" },
  };
  if (change === "cwd") c.putAttachment("owner", attachment);
  scope.pendingModel = { provider: "test", model: "test", label: "test" };
  let releaseModel = () => {};
  const modelResponse = new Promise<void>((resolve) => { releaseModel = resolve; });
  const modelRpc = mock.method(client, "selectModel", () => modelResponse);
  const draft = "等待模型选择时发送的本机引用";
  const sending = c.handle(send(draft, chip), "owner");
  const before = frames.length;
  try {
    await waitFor(() => modelRpc.mock.callCount() === 1);
    assert.deepStrictEqual(client.prompts, [], "原模型选择 RPC 尚未返回");
    if (change === "cwd") {
      c.applyWorkingDirectoryProjection(scope, nextCwd, true, "snapshot");
    } else {
      c.bindViewToSession("owner", otherScope.sessionId, otherScope);
    }
  } finally {
    releaseModel();
    await sending;
    modelRpc.mock.restore();
  }
  assert.deepStrictEqual(client.prompts, [], `${change}：本机旧引用不得原样发出`);
  const restored = frames.slice(before).flatMap(({ target, frame }) => {
    const patch = frame.patch as { draft?: string } | undefined;
    return frame.type === "patch" && patch?.draft ? [{ target, draft: patch.draft }] : [];
  });
  assert.deepStrictEqual(
    restored.filter(({ target }) => target === "mirror"),
    [{ target: "mirror", draft }],
    `${change}：本机引用失效时只还回原始草稿，不携带旧 token`,
  );
  assert.ok(restored.every(({ draft: value }) => !value.includes("@src/a.ts") && !value.includes("@\"one file.ts\"")));
  assert.deepStrictEqual(
    restored.filter(({ target }) => target === "other" || (change === "session" && target === "owner")),
    [],
    `${change}：不回填到别的会话`,
  );
  if (change === "cwd") {
    assert.deepStrictEqual(c.attachmentIds("mirror"), [attachment.id], "附件随原始草稿回到原会话");
    assert.deepStrictEqual(c.attachmentIds("other"), [], "附件不得泄到别的会话");
  }
}

// 按下发送时还没有绑定：第一条消息按同一执行目录建会话时，`sessionId` 为空的冻结目标
// 不能因此被误判成 stale。
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  const chip = await showSelection(c, frames, "v1");
  assert.ok(c.scopeOfView("v1") === undefined, "前置：发送时窗口还没有会话");
  await c.handle(send("未绑定的第一条", chip), "v1");
  const scope = c.scopeOfView("v1");
  assert.ok(scope);
  assert.strictEqual(client.prompts.at(-1)?.sessionId, scope.sessionId);
  assert.strictEqual(promptText(client), `未绑定的第一条\n\n${REF}`, "同目录新建会话仍接受冻结目标");
}
console.log("selectionSend: 本机自动引用在发送前复核目标与会话目录 ✓");

// 同一 sessionId 切走再切回会重建**新的 scope 对象**（执行目录也可能不同）：
// 只比 sessionId 会放行旧目标，必须按域对象身份拒绝。原 A 的 cwd 保持不变。
{
  const root = join(tmpdir(), "dsh-chat-local-selection-recreated-scope");
  const cwd = join(root, "before");
  const nextCwd = join(root, "after");
  const { c, client, frames } = makeController({ cwd });
  c.bindView("owner");
  await c.handle({ type: "ready" }, "owner");
  const scopeA = c.scopeOfView("owner");
  assert.ok(scopeA);
  const sessionIdA = scopeA.sessionId;
  const inner = c as unknown as {
    ensureScope(sessionId: string): { sessionId: string; workingDirectory?: string } | undefined;
    executionCwdOf(scope: { sessionId: string }): string | undefined;
  };
  assert.strictEqual(inner.executionCwdOf(scopeA), cwd);
  const chip = await showSelection(c, frames, "owner", {
    filePath: join(cwd, "one file.ts"),
    preview: "",
  });

  scopeA.pendingModel = { provider: "test", model: "test", label: "test" };
  let releaseModel = () => {};
  const modelResponse = new Promise<void>((resolve) => { releaseModel = resolve; });
  const modelRpc = mock.method(client, "selectModel", () => modelResponse);
  const draft = "切走再切回前的本机草稿";
  const sending = c.handle(send(draft, chip), "owner");
  try {
    await waitFor(() => modelRpc.mock.callCount() === 1);
    // A → B：owner 离开 A，独占的旧 scope 被回收。
    c.newSessionCwd = nextCwd;
    c.bindView("other");
    await c.handle({ type: "ready" }, "other");
    const scopeB = c.scopeOfView("other");
    assert.ok(scopeB && scopeB.sessionId !== sessionIdA);
    c.bindViewToSession("owner", scopeB.sessionId, scopeB);
    // B → A：同一 sessionId 重新建域，并换成新的执行目录。
    const recreatedA = inner.ensureScope(sessionIdA);
    assert.ok(recreatedA);
    c.applyWorkingDirectoryProjection(recreatedA, nextCwd, true, "snapshot");
    c.bindViewToSession("owner", sessionIdA, recreatedA);
    assert.strictEqual(inner.executionCwdOf(scopeA), cwd, "原 A 的 cwd 不被改写");
  } finally {
    releaseModel();
    await sending;
    modelRpc.mock.restore();
  }
  assert.deepStrictEqual(client.prompts, [], "同 sessionId 的新 scope 不能放行旧引用");
  const restored = frames.flatMap(({ target, frame }) => {
    const patch = frame.patch as { draft?: string } | undefined;
    return target === "owner" && frame.type === "patch" && patch?.draft ? [patch.draft] : [];
  });
  assert.ok(restored.includes(draft), "失效后原始草稿回到当前窗口/会话");
}

// ---------- 10. 只解析执行世界的路径字符串，不探测本机文件系统 ----------
for (const [path, cwd, expected, reason] of [
  ["/work/project/src/a b.ts", "/work/project", '@"src/a b.ts#L2-L4"', "POSIX 目录内相对引用"],
  ["/work/project2/src/a b.ts", "/work/project", '@"/work/project2/src/a b.ts#L2-L4"', "同名前缀不算子目录"],
  ["/work/project/a.ts", undefined, "@/work/project/a.ts#L2-L4", "缺少 cwd 时保留绝对路径"],
  [String.raw`d:\Work\a b.ts`, "D:/Work", '@"a b.ts#L2-L4"', "只折叠 Windows 盘符大小写与分隔符"],
  [String.raw`d:\Work\a b.ts`, "D:/work", '@"D:/Work/a b.ts#L2-L4"', "盘符统一大写，但不猜 Windows 目录名大小写"],
  [String.raw`\\server\Share\root\a b.ts`, "//server/Share/root", '@"a b.ts#L2-L4"', "UNC 同名共享内相对引用"],
  [String.raw`\\server\Share\root\a b.ts`, "//server/share/root", '@"//server/Share/root/a b.ts#L2-L4"', "不猜 UNC 共享名大小写"],
  ["/work/D:", "/work", "@/work/D:#L2-L4", "POSIX 裸盘符名不能变成盘符查询"],
  ["/work/D:/a.ts", "/work", "@/work/D:/a.ts#L2-L4", "POSIX 目录名不能变成 Windows 绝对路径"],
  [String.raw`/work/name\with-backslash.ts`, "/work", undefined, "POSIX 文件名的反斜杠不是分隔符"],
  ["/work/a.ts#L22", "/work", undefined, "不能把文件名的后缀误解析为行号"],
] as const) {
  assert.strictEqual(remoteFileReference(path, cwd, { start: 2, end: 4 }), expected, reason);
}
assert.strictEqual(remoteFileReference("/work/D:", "/work"), "@/work/D:", "整文件引用也不能变成裸盘符查询");
assert.strictEqual(remoteFileReference("/work/a.ts#L22-L30", "/work"), undefined, "整文件名不能误解析为既有行号范围");

// ---------- 9. 恢复时初始 active 的面板：无用户活动时才作默认 ----------
// 恢复时初始 active 的编辑区面板：无用户活动时是默认窗口，已经按先登记侧栏折算过的
// 选择要迁过去；真实活动之后才迟到的恢复不能抢回默认。
{
  const { c, frames } = makeController();
  const inner = c as unknown as {
    activeViewId(): string | undefined;
    noteRestoredActiveView(viewId: string): void;
    selectionDisplayed?: { target: { kind: string; viewId: string } };
  };
  c.bindView("sidebar");
  const chip = await showSelection(c, frames, "sidebar");
  const oldTarget = inner.selectionDisplayed?.target;
  assert.ok(oldTarget);
  c.bindView("panel");
  assert.strictEqual(inner.activeViewId(), "sidebar", "只登记新窗口不抢占已有默认");
  inner.noteRestoredActiveView("panel");
  assert.strictEqual(inner.activeViewId(), "panel", "无用户活动时恢复的 active 面板成为默认");
  assert.strictEqual(chipsFor(frames, "sidebar").at(-1), null, "先登记侧栏的旧芯片被撤下");
  assert.strictEqual(chipsFor(frames, "panel").at(-1)?.token, chip.token, "选择迁到恢复出来的默认窗口");
  const newTarget = inner.selectionDisplayed?.target;
  assert.notStrictEqual(newTarget, oldTarget, "迁移换新 target 对象，不改写已冻结的发送目标");
  assert.strictEqual(oldTarget.viewId, "sidebar", "旧 target 的归属保持不变");

  // 真实活动正好落在 MRU 栈尾的侧栏：更新前的有效目标是恢复面板，必须撤下它的 chip。
  assert.strictEqual(inner.activeViewId(), "panel");
  c.noteActiveView("sidebar");
  assert.strictEqual(inner.activeViewId(), "sidebar", "真实活动后侧栏成为活动窗口");
  assert.strictEqual(chipsFor(frames, "panel").at(-1), null, "侧栏虽是栈尾，旧 pane 的 chip 也要撤下");

  c.bindView("late");
  inner.noteRestoredActiveView("late");
  assert.strictEqual(inner.activeViewId(), "sidebar", "真实活动之后迟到的恢复不覆盖");
  assert.deepStrictEqual(chipsFor(frames, "late"), [], "迟到恢复不接收选择");

  // 点中当前恢复面板时目标其实没变（只是它在 MRU 里的下标不同），不能误撤它的 chip。
  const clicked = makeController();
  const clickInner = clicked.c as unknown as {
    activeViewId(): string | undefined;
    noteRestoredActiveView(viewId: string): void;
  };
  clicked.c.bindView("sidebar");
  const clickedChip = await showSelection(clicked.c, clicked.frames, "sidebar");
  clicked.c.bindView("panel");
  // 无效 view 不记活动：随后的恢复仍应生效。
  clicked.c.noteActiveView("missing");
  clickInner.noteRestoredActiveView("panel");
  assert.strictEqual(clickInner.activeViewId(), "panel");
  clicked.c.noteActiveView("panel");
  assert.strictEqual(clickInner.activeViewId(), "panel", "点击当前恢复面板不改变活动目标");
  assert.strictEqual(chipsFor(clicked.frames, "panel").at(-1)?.token, clickedChip.token, "目标未变时 chip 保留");

  // 同一窗口上的首次真实活动即便本来就在栈尾，也要把「恢复默认」清掉。
  const only = makeController();
  const other = only.c as unknown as {
    activeViewId(): string | undefined;
    noteRestoredActiveView(viewId: string): void;
  };
  only.c.bindView("only");
  only.c.setSelectionFacts(FACTS);
  settleSelection();
  other.noteRestoredActiveView("only");
  only.c.noteActiveView("only");
  only.c.bindView("late");
  other.noteRestoredActiveView("late");
  assert.strictEqual(other.activeViewId(), "only", "栈尾 early return 之前已记下真实活动");
}
console.log("selectionSend: 恢复的 active 面板只在无用户活动时作默认 ✓");

// 启动同目录迁移时防抖仍在途：迁移必须保留 pending 容器身份，到点后照常投递并可发送。
{
  const { c, frames, client } = makeController();
  const inner = c as unknown as {
    noteRestoredActiveView(viewId: string): void;
    selectionPending?: { target: { viewId: string } };
    selectionDisplayed?: { target: { viewId: string } };
  };
  c.bindView("sidebar");
  c.setSelectionFacts(FACTS);
  assert.ok(inner.selectionPending, "前置：防抖中的待投递选区");
  c.bindView("panel");
  inner.noteRestoredActiveView("panel");
  assert.deepStrictEqual(chipsFor(frames, "panel"), [], "未到点不提前投递");
  settleSelection();
  const chip = chipsFor(frames, "panel").at(-1);
  assert.ok(chip, "迁移后的 pending 到点仍能投递");
  assert.strictEqual(chip.token, REF);
  await c.handle(send("防抖迁移后发送", chip), "panel");
  assert.strictEqual(promptText(client), `防抖迁移后发送\n\n${REF}`, "到点后的引用真的随 prompt 送出");
}

// 展示 + 防抖替换共享同一个 target：迁移后两者仍必须指向同一新对象，新的防抖不能被丢。
{
  const { c, frames, client } = makeController();
  const inner = c as unknown as {
    noteRestoredActiveView(viewId: string): void;
    selectionPending?: { target: unknown };
    selectionDisplayed?: { target: unknown };
  };
  c.bindView("sidebar");
  await showSelection(c, frames, "sidebar");
  c.setSelectionFacts(MORE_LINES); // pending 复用 displayed.target
  c.bindView("panel");
  inner.noteRestoredActiveView("panel");
  assert.strictEqual(inner.selectionPending?.target, inner.selectionDisplayed?.target,
    "pending 与 displayed 共用同一个迁移后的 target，不能分裂");
  settleSelection();
  const chip = chipsFor(frames, "panel").at(-1);
  assert.ok(chip);
  assert.strictEqual(chip.token, "@src/a.ts#L12-L19", "新的防抖证据没有被旧 pending 容器身份丢弃");
  await c.handle(send("共享目标迁移后发送", chip), "panel");
  assert.strictEqual(promptText(client), "共享目标迁移后发送\n\n@src/a.ts#L12-L19");
}

// 旧窗口只有只读副本引用：恢复默认切到新面板时立即撤下，不能遗留。
{
  const { c, frames } = makeController({ remoteFiles: true });
  c.bindView("sidebar");
  await c.handle({ type: "ready" }, "sidebar");
  const scope = c.scopeOfView("sidebar");
  const access = c.hostFiles;
  assert.ok(scope && access);
  c.setSelectionFacts({
    remoteFile: {
      sessionId: scope.sessionId,
      connectionId: access.connectionId,
      path: join(tmpdir(), "dsh-chat-restore-remote", "a.ts"),
    },
    lines: { start: 1, end: 2 },
    preview: "",
  });
  settleSelection();
  const remoteChip = chipsFor(frames, "sidebar").at(-1);
  assert.ok(remoteChip);
  c.bindView("panel");
  (c as unknown as { noteRestoredActiveView(viewId: string): void }).noteRestoredActiveView("panel");
  assert.strictEqual(chipsFor(frames, "sidebar").at(-1), null, "只读副本不能迁移，旧 chip 立即撤下");
  assert.deepStrictEqual(chipsFor(frames, "panel"), [], "不把旧窗口的只读引用留给新默认");
  access.close();
}

// 恢复面板已经绑在别的会话 / 别的执行目录：迁移既不 emit A 的 token 给 B，也不重算。
{
  const { c, frames } = makeController();
  c.bindView("sidebar");
  const chip = await showSelection(c, frames, "sidebar");
  c.bindView("panel");
  c.newSessionCwd = join(tmpdir(), "dsh-chat-restore-mismatch", "elsewhere");
  c.bindView("other");
  await c.handle({ type: "ready" }, "other");
  const otherScope = c.scopeOfView("other");
  assert.ok(otherScope);
  c.bindViewToSession("panel", otherScope.sessionId, otherScope);
  (c as unknown as { noteRestoredActiveView(viewId: string): void }).noteRestoredActiveView("panel");
  assert.strictEqual(chipsFor(frames, "sidebar").at(-1), null, "不匹配时旧 chip 直接撤下");
  assert.deepStrictEqual(chipsFor(frames, "panel"), [], "不把 A 的 token emit 给不同 session/cwd 的 B");
  assert.strictEqual((c as unknown as { activeViewId(): string | undefined }).activeViewId(), "panel");
  assert.ok(chip.token, "前置：旧目标本来有 token");
}

// 本机自动引用：只允许安全的目录内相对路径，POSIX 字面反斜杠 / 行号后缀 / 盘符样式
// 都必须在这里被拒绝（不能生成看起来指向另一个位置的 token）。
for (const [path, cwd, expected, reason] of [
  ["/work/src/a b.ts", "/work", '@"src/a b.ts#L2-L4"', "POSIX 目录内相对引用"],
  [String.raw`C:\work\src\a.ts`, "C:/work", "@src/a.ts#L2-L4", "Windows 两种分隔符与盘符大小写"],
  [String.raw`/work/name\with-backslash.ts`, "/work", undefined, "POSIX 文件名的反斜杠不是分隔符"],
  ["/work/a.ts#L22", "/work", undefined, "行号后缀文件名不能拼第二段行号"],
  ["/work/a.ts#L22-L30", "/work", undefined, "行号区间后缀文件名同样拒绝"],
  ["/work/C:/x", "/work", undefined, "POSIX 目录下的 C:/x 不能变成本机盘径"],
  ["/work/C:", "/work", undefined, "POSIX 目录下的 C: 不能变成盘符查询"],
  ["/work/../secret.ts", "/work", undefined, "点段不参与相对化"],
  ["/work2/a.ts", "/work", undefined, "同名前缀不是目录边界"],
  ["//?/C:/work/a.ts", "//?/C:/work", undefined, "设备命名空间不能生成自动引用"],
] as const) {
  assert.strictEqual(localFileReference(path, cwd, { start: 2, end: 4 }), expected, reason);
}

// 控制器真实路径：同样这些拼写不投递芯片（不会把用户引到错误文件）。
{
  const { c, frames } = makeController({ cwd: "/work" });
  c.bindView("posix");
  for (const filePath of [
    String.raw`/work/name\with-backslash.ts`,
    "/work/a.ts#L22",
    "/work/C:/x",
    "/work/C:",
  ]) {
    c.setSelectionFacts({ filePath, preview: "" });
    settleSelection();
    assert.deepStrictEqual(chipsFor(frames, "posix"), [], `${filePath} 不生成歧义自动引用`);
  }
  const positive = await showSelection(c, frames, "posix", { filePath: "/work/src/a b.ts", lines: { start: 2, end: 4 }, preview: "" });
  assert.strictEqual(positive.token, '@"src/a b.ts#L2-L4"', "安全相对引用照常投递");
}
console.log("selectionSend: 执行世界的 POSIX、盘符与 UNC 路径按语法折算，不猜路径身份 ✓");

// ---------- 11. 连接失败、从未交给 transport 的自动引用不能随「重发」重放 ----------
{
  const { c, client, frames } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const chip = await showSelection(c, frames, "v1");
  const inner = c as unknown as {
    client: unknown;
    connection: string;
    ensureConnected(options: unknown): Promise<void>;
    pendingMessages: Map<string, { requestId: string; text: string; status?: string }[]>;
    keyForView(viewId: string): string;
    drafts: Map<string, string>;
  };
  const originalEnsure = inner.ensureConnected.bind(c);
  // 首次发送时连接失败（客户端在 ensureConnected 之后仍为空）。
  inner.connection = "disconnected";
  inner.ensureConnected = async () => {
    inner.client = undefined;
    inner.connection = "disconnected";
  };
  const draft = "连接失败的原稿";
  try {
    await c.handle(send(draft, chip), "v1");
  } finally {
    inner.ensureConnected = originalEnsure;
    inner.client = client;
    inner.connection = "connected";
  }
  const failed = inner.pendingMessages.get(inner.keyForView("v1"))
    ?.find((entry) => entry.status === "failed");
  assert.ok(failed, "前置：失败行留在原地");
  assert.strictEqual(failed.text, draft, "从未交给 transport 的失败行只保留原始草稿");
  assert.ok(!failed.text.includes(REF), "失败行不携带旧自动引用 token");

  // 用户改 cwd 后点「重发」：不能把旧 token 当普通正文送出去。
  const scope = c.scopeOfView("v1");
  assert.ok(scope);
  c.applyWorkingDirectoryProjection(scope, join(tmpdir(), "dsh-chat-local-no-connection", "after"), true, "snapshot");
  client.prompts.length = 0;
  await c.handle({ type: "resendPending", requestId: failed.requestId }, "v1");
  assert.strictEqual(promptText(client), draft, "重发只送原始草稿，不重采选区、不带旧引用");
  assert.ok(client.prompts.at(-1)?.content.every((part) => {
    const text = (part as { type?: string; text?: string }).text ?? "";
    return !text.includes(REF);
  }));
  console.log("selectionSend: 连接失败的回显只保留原始草稿，重发不带旧引用 ✓");
}

// ---------- 12. 原始草稿与送达正文分开：lost / 重发 / 排队重发 ----------
{
  const { c, frames, client } = makeController();
  c.bindView("v1");
  await c.handle({ type: "ready" }, "v1");
  const scope = c.scopeOfView("v1");
  assert.ok(scope);
  const inner = c as unknown as {
    resubmit(
      viewId: string,
      entries: { origin: { text: string; draft?: string; attachments: unknown[]; content: unknown[] } }[],
    ): Promise<void>;
    settleLostSubmission(rpcId: string, reason: "lost" | "canceled"): void;
    submissions: Map<string, { text: string; draft: string }>;
    drafts: Map<string, string>;
    keyForView(viewId: string): string;
  };
  const lastDraft = (): string | undefined =>
    frames.flatMap(({ target, frame }) => {
      const patch = frame.patch as { draft?: string } | undefined;
      return target === "v1" && frame.type === "patch" && patch?.draft !== undefined ? [patch.draft] : [];
    }).at(-1);
  const chip = await showSelection(c, frames, "v1");

  // 运行中发送不建回显；lost 时不能把提交正文里的旧引用回填成草稿。
  scope.running = true;
  await c.handle(send("原始草稿", chip), "v1");
  const lostId = String(client.prompts.at(-1)?.requestId);
  assert.strictEqual(promptText(client), `原始草稿\n\n${REF}`, "前置：送达正文含冻结的自动引用");
  frames.length = 0;
  inner.settleLostSubmission(lostId, "lost");
  assert.strictEqual(lastDraft(), "原始草稿", "lost 回填原始草稿，不带旧引用 token");
  assert.strictEqual(inner.submissions.get(lostId)?.draft, "原始草稿");

  // 「重发」保留原送达正文，新提交记录的 draft 仍是旧记录的原稿（不重采选区）。
  inner.drafts.set(inner.keyForView("v1"), "");
  scope.running = false;
  client.prompts.length = 0;
  await c.handle(send("重发原稿", chip), "v1");
  const firstRetryId = String(client.prompts.at(-1)?.requestId);
  assert.strictEqual(promptText(client), `重发原稿\n\n${REF}`);
  client.prompts.length = 0;
  await c.handle({ type: "resendPending", requestId: firstRetryId }, "v1");
  const secondRetryId = String(client.prompts.at(-1)?.requestId);
  assert.notStrictEqual(secondRetryId, firstRetryId);
  assert.strictEqual(promptText(client), `重发原稿\n\n${REF}`, "重发仍送达原完整正文（保留当时的引用）");
  assert.strictEqual(inner.submissions.get(secondRetryId)?.text, `重发原稿\n\n${REF}`);
  assert.strictEqual(inner.submissions.get(secondRetryId)?.draft, "重发原稿", "新记录草稿是原稿，不是含引用的正文");

  // 排队重发：送达 origin.text，记录 / 回填用 origin.draft。
  scope.running = true;
  inner.drafts.set(inner.keyForView("v1"), "");
  client.prompts.length = 0;
  const delivered = `送达正文\n\n${REF}`;
  await inner.resubmit("v1", [
    { origin: { text: delivered, draft: "送达正文", attachments: [], content: [{ type: "text", text: delivered }] } },
  ]);
  const resubmittedId = String(client.prompts.at(-1)?.requestId);
  assert.strictEqual(promptText(client), delivered, "排队重发原样送达");
  assert.strictEqual(inner.submissions.get(resubmittedId)?.text, delivered);
  assert.strictEqual(inner.submissions.get(resubmittedId)?.draft, "送达正文");

  // 排队重发失败：这一条与后面未提交的都回填原始草稿，不把旧 token 带回输入框。
  inner.drafts.set(inner.keyForView("v1"), "");
  const promptFail = mock.method(client, "prompt", async () => {
    throw new Error("boom");
  });
  try {
    await inner.resubmit("v1", [
      { origin: { text: `第一行\n\n${REF}`, draft: "第一行", attachments: [], content: [{ type: "text", text: `第一行\n\n${REF}` }] } },
      { origin: { text: `第二行\n\n${REF}`, draft: "第二行", attachments: [], content: [{ type: "text", text: `第二行\n\n${REF}` }] } },
    ]);
  } finally {
    promptFail.mock.restore();
  }
  const failedDraft = inner.drafts.get(inner.keyForView("v1"));
  assert.strictEqual(failedDraft, "第一行\n第二行", "排队重发失败按原始草稿回填这一条与余项");
  assert.ok(!failedDraft.includes(REF), "失败回填不携带旧引用");
  console.log("selectionSend: 原始草稿与送达正文分开（lost / 重发 / 排队重发）✓");
}

mock.timers.reset();
console.log("\nselectionSend: all assertions passed");
