/**
 * 自动化任务变更路由的**上下文隔离**离线回归：驱真 `ChatController.handle` + 假客户端，
 * 不启动 DSH、不发真实消息。
 *
 * 钉住四件事：
 *
 * 1. **成功结算在权威刷新之后**：宿主先把变更响应里的最新条目并回目录、再读一次整份
 *    目录，最后才发 `schedules/result`。详情区据此把草稿与基线换成保存后的那一版
 *    （否则下一次刷新会把「自己刚保存的」误判成冲突）。读回失败也不许扣住结算。
 * 2. **迟到的上下文不写当前状态**：请求在飞时窗口换绑 / 连接换代，旧请求回来既不许
 *    把旧域降级成旧代（一次旧连接的 404 不能给当前域扣帽子），也不许用新客户端去读
 *    旧域的目录；结算帧仍发，但带 `code: 'stale'`。
 * 3. **当前上下文的 404 才降级**：run / create 的端点缺失是能力结论，必须落到发出请求
 *    的那个域上，并如实回 `unsupported`。
 * 4. **冲突失败也重读**：拿旧基准反复撞冲突没有意义，失败结算前先对齐目录。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert/strict";
import { ChatController } from "../src/dsh/controller";
import { scheduleEntriesFromCatalog } from "../src/dsh/scheduleView";
import type { HostToWebview, WebviewToHost } from "../src/shared/ipc";
import type { ScheduleItemView } from "../src/shared/chat";

type ScheduleResult = Extract<HostToWebview, { type: "schedules/result" }>;

interface Scope {
  sessionId: string;
  schedules: ScheduleItemView[];
  schedulesStatus?: "loading" | "ready" | "unsupported" | "error";
  schedulesCapability?: "modern" | "legacy" | "unknown";
  newSessionIntervalSeconds?: number;
  schedulesEpoch: number;
  scheduleExpected: Map<string, unknown>;
  schedulesWanted: boolean;
}

interface Harness {
  client?: FakeClient;
  scopes: Map<string, Scope>;
  viewSessions: Map<string, string>;
  emitToView(viewId: string, frame: HostToWebview): void;
  deliver(sessionId: string, frame: HostToWebview): void;
  sessionSource(scope: Scope): unknown;
  scopeOfView(viewId: string): Scope | undefined;
  log(message: string): void;
  handle(message: WebviewToHost, viewId: string): Promise<void>;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 新代目录条目（线格式）。 */
function wireEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1",
    kind: "every",
    title: "构建检查",
    prompt: "检查构建",
    everySeconds: 300,
    scheduledAt: "2026-11-06T02:00:00.000Z",
    target: { kind: "session", sessionId: "s1" },
    involvedSessionIds: ["s1"],
    status: "active",
    updatedAt: "rev-1",
    ...overrides,
  };
}

function makeScope(sessionId: string, entries: Record<string, unknown>[]): Scope {
  const parsed = scheduleEntriesFromCatalog(entries);
  return {
    sessionId,
    schedules: parsed.map((entry) => entry.item),
    schedulesStatus: "ready",
    schedulesCapability: "modern",
    schedulesEpoch: 0,
    scheduleExpected: new Map(parsed.filter((entry) => entry.expected).map((entry) => [entry.item.id, entry.expected])),
    schedulesWanted: true,
  };
}

/** 假客户端：各端点由用例给实现，目录读取计数用来断言「有没有真的重读」。 */
class FakeClient {
  catalogCalls = 0;
  catalog: () => Promise<unknown> = async () => [];
  edit: (id: string, patch: unknown, expected?: string | null) => Promise<unknown> = async () => {
    throw new Error("unexpected schedule/edit");
  };
  create: (request: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected schedule/create");
  };
  run: (id: string) => Promise<unknown> = async () => {
    throw new Error("unexpected schedule/run");
  };
  remove: (id: string, expected?: string, revision?: unknown) => Promise<unknown> = async () => {
    throw new Error("unexpected schedule/edit delete");
  };

  async scheduleCatalog(): Promise<unknown> {
    this.catalogCalls += 1;
    return this.catalog();
  }
  async scheduleEditPatch(id: string, patch: unknown, expected?: string | null): Promise<unknown> {
    return this.edit(id, patch, expected);
  }
  async scheduleCreate(request: unknown): Promise<unknown> {
    return this.create(request);
  }
  async scheduleRun(id: string): Promise<unknown> {
    return this.run(id);
  }
  async scheduleDelete(id: string, _sessionId: string, revision?: unknown): Promise<unknown> {
    return this.remove(id, undefined, revision);
  }
}

/** 组装一个只服务 schedule 路由的控制器实例（跳过构造器的后台依赖）。 */
function harness(initial: { scopes: Scope[]; client: FakeClient; viewId?: string }): {
  controller: Harness;
  frames: HostToWebview[];
} {
  const controller = Object.create(ChatController.prototype) as Harness;
  const frames: HostToWebview[] = [];
  controller.scopes = new Map(initial.scopes.map((scope) => [scope.sessionId, scope]));
  controller.viewSessions = new Map([[initial.viewId ?? "v1", initial.scopes[0].sessionId]]);
  controller.client = initial.client;
  controller.emitToView = (_viewId, frame) => frames.push(frame);
  controller.deliver = (_sessionId, frame) => frames.push(frame);
  controller.sessionSource = (scope) => ({
    schedules: () => scope.schedules,
    schedulesStatus: () => scope.schedulesStatus,
    schedulesCapability: () => scope.schedulesCapability,
    newSessionIntervalSeconds: () => scope.newSessionIntervalSeconds,
  });
  controller.scopeOfView = (viewId) => {
    const sessionId = controller.viewSessions.get(viewId);
    return sessionId === undefined ? undefined : controller.scopes.get(sessionId);
  };
  controller.log = () => {};
  return { controller, frames };
}

/** 只取最近一条 `schedules/result`。 */
function lastResult(frames: HostToWebview[]): ScheduleResult {
  const result = [...frames].reverse().find((frame): frame is ScheduleResult => frame.type === "schedules/result");
  assert.ok(result, "每条路都必须回一帧 schedules/result");
  return result;
}

/** 目录 patch 帧（宿主读回后推给界面的那一条）。 */
function schedulePatches(frames: HostToWebview[]): { patch: { schedules?: ScheduleItemView[] } }[] {
  return frames.filter((frame): frame is Extract<HostToWebview, { type: "patch" }> => frame.type === "patch")
    .filter((frame) => Array.isArray((frame.patch as { schedules?: unknown }).schedules)) as unknown as {
      patch: { schedules?: ScheduleItemView[] };
    }[];
}

const editMessage = (opId: number, title = "B"): WebviewToHost =>
  ({
    type: "editSchedule",
    id: "task-1",
    patch: { title },
    expectedUpdatedAt: "rev-1",
    opId,
  }) as WebviewToHost;

// ---------- 1. 成功：先把权威目录并回 / 重读，再发结算帧 ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  client.edit = async () => wireEntry({ title: "B", updatedAt: "rev-2" });
  client.catalog = async () => [wireEntry({ title: "B", updatedAt: "rev-2" })];
  const { controller, frames } = harness({ scopes: [scope], client });

  await controller.handle(editMessage(7), "v1");

  assert.equal(client.catalogCalls, 1, "成功之后必须重读一次目录");
  assert.equal(scope.schedules[0].title, "B");
  assert.equal(scope.schedules[0].updatedAt, "rev-2");
  const result = lastResult(frames);
  assert.equal(result.op, "update");
  assert.equal(result.ok, true);
  assert.equal(result.opId, 7);
  const resultIndex = frames.lastIndexOf(result);
  const patchIndex = frames.findIndex((frame) => frame.type === "patch");
  assert.ok(patchIndex >= 0 && patchIndex < resultIndex, "目录 patch 必须先于成功结算（界面据此推进基线）");
  assert.equal(schedulePatches(frames).at(-1)?.patch.schedules?.[0]?.title, "B");
}
console.log("scheduleConcurrency: 成功结算前先读回目录 ✓");

// ---------- 2. 成功但目录读取失败：仍要结算，变更条目已并回 ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  client.edit = async () => wireEntry({ title: "B", updatedAt: "rev-2" });
  client.catalog = async () => {
    throw new Error("HTTP 500");
  };
  const { controller, frames } = harness({ scopes: [scope], client });

  await controller.handle(editMessage(8), "v1");

  const result = lastResult(frames);
  assert.equal(result.ok, true, "读回失败也不能把一次成功保存说成失败或永远挂着");
  assert.equal(scope.schedules[0].title, "B", "变更响应本身就是权威条目：刷新失败时也要并回目录");
  assert.equal(scope.schedulesStatus, "ready", "后台刷新失败不把已读到的目录打回空态");
}
console.log("scheduleConcurrency: 刷新失败仍结算并保留变更条目 ✓");

// ---------- 3. 请求在飞时窗口换绑：不重读旧域、不写当前状态、结算标 stale ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const other = makeScope("s2", []);
  const client = new FakeClient();
  const gate = deferred<unknown>();
  const started = deferred<void>();
  client.edit = async () => {
    started.resolve();
    return gate.promise;
  };
  client.catalog = async () => [wireEntry({ title: "B", updatedAt: "rev-2" })];
  const { controller, frames } = harness({ scopes: [scope, other], client });

  const running = controller.handle(editMessage(9), "v1");
  await started.promise;
  controller.viewSessions.set("v1", "s2");
  gate.resolve(wireEntry({ title: "B", updatedAt: "rev-2" }));
  await running;

  assert.equal(client.catalogCalls, 0, "换绑之后不许再读旧域的目录");
  assert.equal(scope.schedules[0].title, "构建检查", "旧域不许被迟到的成功写回");
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "stale", "迟到结算按「未确认」发，界面不会把旧结果当成当前这行");
}
console.log("scheduleConcurrency: 换绑后不写旧域 ✓");

// ---------- 4. 旧连接的 404 不给当前域降级；换客户端后不拿新客户端读旧域 ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  const gate = deferred<unknown>();
  const started = deferred<void>();
  client.run = async () => {
    started.resolve();
    return gate.promise;
  };
  const { controller, frames } = harness({ scopes: [scope], client });
  const next = new FakeClient();

  const running = controller.handle({ type: "runSchedule", id: "task-1", opId: 10 } as WebviewToHost, "v1");
  await started.promise;
  controller.client = next;
  gate.reject(new Error("HTTP 404"));
  await running;

  assert.equal(scope.schedulesCapability, "modern", "旧连接的 404 不得把域降级为旧代");
  assert.equal(next.catalogCalls, 0, "不得用新客户端去读旧域的目录");
  const result = lastResult(frames);
  assert.equal(result.code, "stale");
  assert.equal(result.ok, false);
}
console.log("scheduleConcurrency: 旧连接 404 不降级当前域 ✓");

// ---------- 5. 当前上下文的端点缺失：降级 + unsupported ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  client.run = async () => {
    throw new Error("HTTP 404");
  };
  const { controller, frames } = harness({ scopes: [scope], client });

  await controller.handle({ type: "runSchedule", id: "task-1", opId: 11 } as WebviewToHost, "v1");

  assert.equal(scope.schedulesCapability, "legacy", "当前连接明确 404：能力结论落到这个域");
  assert.equal(client.catalogCalls, 0, "端点缺失时不必再读一次目录");
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported");
}
console.log("scheduleConcurrency: 当前上下文 404 才降级 ✓");

// ---------- 6. 冲突失败先对齐目录再结算 ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  client.edit = async () => ({ code: "schedule_conflict" });
  client.catalog = async () => [wireEntry({ prompt: "别人改的指令", updatedAt: "rev-2" })];
  const { controller, frames } = harness({ scopes: [scope], client });

  await controller.handle(editMessage(12), "v1");

  assert.equal(client.catalogCalls, 1, "冲突之后要重读，别让用户拿着过期基准反复撞");
  assert.equal(scope.schedules[0].prompt, "别人改的指令");
  const result = lastResult(frames);
  assert.equal(result.ok, false);
  assert.equal(result.code, "schedule_conflict");
  assert.equal(result.opId, 12);
}
console.log("scheduleConcurrency: 冲突后重读再结算 ✓");

// ---------- 7. 删除成功后目录重读，行从域里消失 ----------
{
  const scope = makeScope("s1", [wireEntry()]);
  const client = new FakeClient();
  client.remove = async () => ({ deleted: true });
  client.catalog = async () => [];
  const { controller, frames } = harness({ scopes: [scope], client });

  await controller.handle({ type: "deleteSchedule", id: "task-1", expectedUpdatedAt: "rev-1", opId: 13 } as WebviewToHost, "v1");

  assert.equal(client.catalogCalls, 1);
  assert.equal(scope.schedules.length, 0);
  const result = lastResult(frames);
  assert.equal(result.op, "delete");
  assert.equal(result.ok, true);
  assert.equal(result.opId, 13);
}
console.log("scheduleConcurrency: 删除后重读目录 ✓");

console.log("\nscheduleConcurrency: all assertions passed");
