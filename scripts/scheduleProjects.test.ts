/**
 * 自动化任务「创建目录」候选通道的**行为级**回归。
 *
 * 驱真 `ChatController`（offline vscode stub + 假 client），只看它实际发出的
 * `scheduleProjects` patch 与 `snapshotFor` 的整份状态；不读源码正则，也不起 React。
 *
 * 覆盖：
 * 1. `workspace/follow` 的 baseline / upsert / remove / order；
 * 2. **已注册但没有任何会话**的 Workspace 仍是候选；
 * 3. 标题更新与清空（upsert 是整行替换，缺标题必须退回路径）；
 * 4. `[]`（注册表明确为空）与 `null`（没有权威注册表 / 连接清理）分开；
 * 5. 旧供 / 旧世代迟到回调不写回当前候选；
 * 6. 换会话不丢部署级候选；换连接不复活旧候选；
 * 7. webview 专用 store 的 state / patch / null / images-scope 行为（假 window + 真 bridge）。
 *
 * 运行：私有用 `.agent` 里的 esbuild 配置打包本文件后执行；父代理负责登记到
 * `esbuild.scripts.mjs`。vscode 依赖由 alias 指到 `scripts/vscodeTestStub.ts`。
 */
import assert from "node:assert";

process.on("unhandledRejection", (error) => {
  console.error("[scheduleProjects] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

/** 假 window：bridge 在导入期挂 `message` 监听，store 的测试据此注入宿主帧。 */
const messageListeners: ((event: { data: unknown }) => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") messageListeners.push(listener);
  },
};

const { jsonSafeFrame } = await import("../src/shared/wire");
const { ChatController } = await import("../src/dsh/controller");

const DIR_A = "C:\\work\\alpha";
const DIR_B = "C:\\work\\beta";

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

interface StreamRecord {
  endpoint: string;
  callbacks: { onItem(value: unknown): void };
  cancelled: boolean;
}

/** 假服务端：会话列表有一行（刷新会话列表那条异步链需要它），workspace 流由测试手动推。 */
function fakeClient() {
  const calls: string[] = [];
  const streams: StreamRecord[] = [];
  return {
    calls,
    streams,
    async listSessions() {
      calls.push("session/list");
      return {
        items: [{ sessionId: "s1", cwd: DIR_A, updatedAt: 1, running: false, blank: false }],
      };
    },
    async request(method: string) {
      calls.push(method);
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
    followSession() {
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl() {
      return { cancel() {} };
    },
    /** `workspace/follow` 的唯一打开入口：记下回调，测试按世代手动投递。 */
    openStream(endpoint: string, _args: unknown, callbacks: StreamRecord["callbacks"]) {
      const record: StreamRecord = { endpoint, callbacks, cancelled: false };
      streams.push(record);
      return {
        cancel() {
          record.cancelled = true;
        },
      };
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

interface ControllerInternals {
  client: unknown;
  connection: string;
  viewSessions: Map<string, string>;
  openWorkspaceStream(): void;
  teardownStreams(): void;
  snapshotFor(viewId: string): Record<string, unknown>;
}

function makeHarness() {
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame: frame as unknown as Record<string, unknown> }));
  const c = controller as unknown as ControllerInternals;
  const client = fakeClient();
  c.client = client as never;
  c.connection = "connected";
  return { c, client, frames };
}

/** 最近一次带 `scheduleProjects` 的 patch（`undefined` = 还没发过）。 */
function lastSchedulePatch(frames: Captured[]): Record<string, unknown> | undefined {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index].frame as {
      type?: string;
      patch?: Record<string, unknown>;
    };
    if (frame.type === "patch" && frame.patch && Object.prototype.hasOwnProperty.call(frame.patch, "scheduleProjects")) {
      return frame;
    }
  }
  return undefined;
}

/** 最近一次 patch 里的候选（`undefined` 是清空意图本身，调用方按需用 `hasOwn` 区分「没发过」）。 */
function latestProjects(frames: Captured[]): unknown {
  return lastSchedulePatch(frames)?.patch?.scheduleProjects;
}

/** 最近一次候选表（只接受数组；清空 / 没发过返回 undefined）。 */
function latestProjectList(frames: Captured[]): { path: string; title?: string }[] | undefined {
  const value = latestProjects(frames);
  return Array.isArray(value) ? (value as { path: string; title?: string }[]) : undefined;
}

/** 取一帧 patch 的过线形态（宿主清空的 `undefined` 必须看 `null`）。 */
function patchWire(frame: Record<string, unknown> | undefined): { patch?: { scheduleProjects?: unknown } } {
  if (frame === undefined) return {};
  return jsonSafeFrame(frame as never) as unknown as { patch?: { scheduleProjects?: unknown } };
}

/** 快照字段的**过线形态**（顶层 undefined 在 `jsonSafeFrame` 里变 null）。 */
function snapshotWire(c: ControllerInternals, viewId = "v1"): Record<string, unknown> {
  const frame = jsonSafeFrame({
    type: "state",
    state: c.snapshotFor(viewId) as never,
  } as never) as unknown as { state: Record<string, unknown> };
  return frame.state;
}

function settle(): Promise<void> {
  // `refreshSessions` 是 `void` 的异步链；给微任务两拍即可落定，断言不依赖它。
  return Promise.resolve().then(() => Promise.resolve());
}

// ---------- 1. baseline：注册零会话的目录 + 标题；snapshot 也带 ----------
{
  const { c, client, frames } = makeHarness();
  c.openWorkspaceStream();
  assert.equal(client.streams.length, 1);
  assert.equal(client.streams[0].endpoint, "workspace/follow");

  client.streams[0].callbacks.onItem({
    type: "baseline",
    value: {
      items: [
        { workspaceId: "ws-a", path: DIR_A, title: "工作区 A", sessionIds: [] },
        { workspaceId: "ws-b", path: DIR_B, title: "", sessionIds: [] },
      ],
      archivedSessionIds: [],
    },
  });
  await settle();

  assert.deepEqual(
    latestProjects(frames),
    [
      { path: DIR_A, title: "工作区 A" },
      { path: DIR_B },
    ],
    "已注册但零会话的 Workspace 也是候选；空标题退回路径",
  );
  assert.deepEqual(
    snapshotWire(c).scheduleProjects,
    [
      { path: DIR_A, title: "工作区 A" },
      { path: DIR_B },
    ],
    "首帧快照与增量 patch 带同一份候选",
  );

  // 标题更新：upsert 是整行替换
  client.streams[0].callbacks.onItem({
    type: "upsert",
    workspace: { workspaceId: "ws-b", path: DIR_B, title: "改名后", sessionIds: [] },
  });
  assert.deepEqual(latestProjectList(frames)?.[1], { path: DIR_B, title: "改名后" }, "upsert 更新标题");

  // 标题清空：缺 title 必须清掉旧值（否则界面一直显示别人刚改掉的旧名）
  client.streams[0].callbacks.onItem({
    type: "upsert",
    workspace: { workspaceId: "ws-b", path: DIR_B, sessionIds: [] },
  });
  assert.deepEqual(latestProjectList(frames)?.[1], { path: DIR_B }, "upsert 缺 title 时清空标题、退回路径");

  // order：候选顺序跟注册表（官方 Workspace 列表口径）
  client.streams[0].callbacks.onItem({ type: "order", workspaceIds: ["ws-b", "ws-a"] });
  assert.deepEqual(
    latestProjectList(frames)?.map((project) => project.path),
    [DIR_B, DIR_A],
    "order 帧重排候选",
  );

  // remove：整条消失
  client.streams[0].callbacks.onItem({ type: "remove", workspaceId: "ws-a" });
  assert.deepEqual(latestProjects(frames), [{ path: DIR_B }], "remove 去掉候选");
}

// ---------- 2. 未支持端点 / 注册表为空 / 连接清理：null 与 [] 分开 ----------
{
  const { c, client, frames } = makeHarness();
  // 旧服务端没有 workspace 流（或还没到 baseline）：没有权威注册表，不能编一份空表。
  c.openWorkspaceStream();
  assert.equal(snapshotWire(c).scheduleProjects, null, "未知注册表过线为 null");
  assert.equal(lastSchedulePatch(frames), undefined, "未知注册表不发候选 patch");

  client.streams[0].callbacks.onItem({ type: "baseline", value: { items: [], archivedSessionIds: [] } });
  assert.deepEqual(latestProjects(frames), [], "baseline 明确为空 = []（不是 null）");
}

// ---------- 3. 空表快照 / teardown 的 null 清空 —— 单独一组，避免上面注释误导 ----------
{
  const { c, client, frames } = makeHarness();
  c.openWorkspaceStream();
  client.streams[0].callbacks.onItem({ type: "baseline", value: { items: [], archivedSessionIds: [] } });
  assert.deepEqual(snapshotWire(c).scheduleProjects, [], "注册表明确为空时快照是 []");
  c.teardownStreams();
  assert.equal(
    Object.prototype.hasOwnProperty.call(lastSchedulePatch(frames)?.patch ?? {}, "scheduleProjects"),
    true,
    "teardown 必须发一帧清空",
  );
  assert.equal(latestProjects(frames), undefined, "宿主清空意图是 undefined");
  assert.equal(patchWire(lastSchedulePatch(frames)).patch?.scheduleProjects, null, "过线清空是 null");
  assert.equal(snapshotWire(c).scheduleProjects, null, "清理后快照过线为 null");
}

// ---------- 4. 旧世代迟到回调：换流后旧 baseline 不写回 ----------
{
  const { c, client, frames } = makeHarness();
  c.openWorkspaceStream();
  const first = client.streams[0];
  first.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-a", path: DIR_A, title: "A", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.deepEqual(latestProjects(frames), [{ path: DIR_A, title: "A" }]);

  // 新开一条流（reconnect / 新连接）：旧流的回调即使已经排队，也必须被世代号丢掉。
  c.openWorkspaceStream();
  const second = client.streams[1];
  frames.length = 0;
  first.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-old", path: "C:\\work\\old", title: "旧", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.equal(lastSchedulePatch(frames), undefined, "旧世代 baseline 不发 patch");
  assert.deepEqual(snapshotWire(c).scheduleProjects, [{ path: DIR_A, title: "A" }], "旧世代 baseline 不写快照");

  // 新世代正常落地：之后的旧世代仍然无效。
  second.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-b", path: DIR_B, title: "B", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.deepEqual(latestProjects(frames), [{ path: DIR_B, title: "B" }]);
  first.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-old", path: "C:\\work\\old", title: "旧", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.deepEqual(latestProjects(frames), [{ path: DIR_B, title: "B" }], "新世代落地后旧世代仍不得复活");

  // 换连接（teardown）再开一条：teardown 之后旧连接任何回调都不许写回。
  c.teardownStreams();
  const afterTeardown = lastSchedulePatch(frames);
  assert.equal(patchWire(afterTeardown).patch?.scheduleProjects, null);
  frames.length = 0;
  second.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-old", path: "C:\\work\\old", title: "旧", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.equal(lastSchedulePatch(frames), undefined, "teardown 后旧流回调被丢弃");
  assert.equal(snapshotWire(c).scheduleProjects, null, "teardown 后旧流回调不写快照");

  // 新连接的新流：先给新候选，再让旧两条流补发，都不得覆盖。
  c.openWorkspaceStream();
  const third = client.streams[2];
  third.callbacks.onItem({
    type: "baseline",
    value: { items: [{ workspaceId: "ws-c", path: "C:\\work\\gamma", title: "C", sessionIds: [] }], archivedSessionIds: [] },
  });
  assert.deepEqual(latestProjects(frames), [{ path: "C:\\work\\gamma", title: "C" }]);
  first.callbacks.onItem({ type: "baseline", value: { items: [{ workspaceId: "x", path: "C:\\work\\x", sessionIds: [] }] } });
  second.callbacks.onItem({ type: "baseline", value: { items: [{ workspaceId: "y", path: "C:\\work\\y", sessionIds: [] }] } });
  assert.deepEqual(
    latestProjects(frames),
    [{ path: "C:\\work\\gamma", title: "C" }],
    "换连接后旧候选不得复活",
  );
}

// ---------- 5. 切会话不丢部署级候选（快照按窗口现算，候选与会话无关） ----------
{
  const { c, client } = makeHarness();
  c.openWorkspaceStream();
  client.streams[0].callbacks.onItem({
    type: "baseline",
    value: {
      items: [
        { workspaceId: "ws-a", path: DIR_A, title: "A", sessionIds: [] },
        { workspaceId: "ws-b", path: DIR_B, title: "B", sessionIds: [] },
      ],
      archivedSessionIds: [],
    },
  });
  c.viewSessions.set("v1", "s1");
  c.viewSessions.set("v2", "s2");
  const first = snapshotWire(c, "v1").scheduleProjects;
  const second = snapshotWire(c, "v2").scheduleProjects;
  assert.deepEqual(first, second, "两个不同会话的窗口拿到同一份部署级候选");
  assert.deepEqual(first, [
    { path: DIR_A, title: "A" },
    { path: DIR_B, title: "B" },
  ]);
}

// ---------- 6. webview store：state / patch / null / images-scope ----------
{
  const store = await import("../src/webview/scheduleProjects");
  const deliver = (frame: unknown): void => {
    for (const listener of messageListeners) listener({ data: frame });
  };
  const snapshot = () => store.scheduleProjectsSnapshot();
  assert.equal(snapshot().projects, undefined, "初始没有权威注册表");

  deliver({ type: "state", state: { scheduleProjects: [{ path: DIR_A, title: "A" }] } });
  assert.deepEqual(snapshot().projects, [{ path: DIR_A, title: "A" }], "state 快照落地");

  const version = snapshot().version;
  deliver({ type: "patch", patch: { schedules: [] } });
  assert.equal(snapshot().version, version, "patch 缺键时不动候选");
  assert.deepEqual(snapshot().projects, [{ path: DIR_A, title: "A" }]);

  deliver({ type: "patch", patch: { scheduleProjects: null } });
  assert.equal(snapshot().projects, undefined, "null 清空（不是空表）");

  deliver({ type: "patch", patch: { scheduleProjects: [] } });
  assert.deepEqual(snapshot().projects, [], "[] 是注册表明确为空");

  deliver({ type: "patch", patch: { scheduleProjects: [{ path: DIR_B, title: "B" }] } });
  // 首帧 scope 只记认、不清（快照可能已经带着同一条连接的候选）
  deliver({ type: "images/scope", connectionId: "c1" });
  assert.deepEqual(snapshot().projects, [{ path: DIR_B, title: "B" }], "首帧 images/scope 不清候选");
  // 连接换代：上一条连接的候选必须清掉，等新 baseline
  deliver({ type: "images/scope", connectionId: "c2" });
  assert.equal(snapshot().projects, undefined, "执行世界换代清空候选");

  deliver({ type: "patch", patch: { scheduleProjects: [{ path: DIR_A, title: "A" }] } });
  deliver({ type: "state", state: {} });
  assert.equal(snapshot().projects, undefined, "旧宿主 state 没有该键时按未知清空，不沿用上一页");
}

console.log("scheduleProjects: 宿主 baseline / upsert / remove / order ✓");
console.log("scheduleProjects: 零会话项 / 标题更新与清空 / [] vs null ✓");
console.log("scheduleProjects: 旧世代迟到帧 / teardown / 换连接不复活 ✓");
console.log("scheduleProjects: 切会话不丢部署级候选 ✓");
console.log("scheduleProjects: webview store state / patch / images-scope ✓");
console.log("\nscheduleProjects: all assertions passed");
