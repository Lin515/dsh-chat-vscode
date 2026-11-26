/** 底栏偏好的离线宿主回归：驱动真控制器，不连接 DSH。 */
import assert from "node:assert/strict";
import * as vscode from "vscode";
import { ChatController } from "../src/dsh/controller";
import type { HostToWebview, WebviewToHost } from "../src/shared/ipc";
import { DEFAULT_TOOLBAR_PREFERENCE, type ToolbarPreference } from "../src/shared/toolbarPreference";

const key = "toolbarPreference";
const panel = { type: "ui/openPanel", panel: "toolbar-preferences" } as const;
const preference = (value: ToolbarPreference) => ({ type: "toolbar/preference", preference: value } as const);

function fakeMemento(seed: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(seed));
  const writes: Array<{ key: string; value: unknown }> = [];
  let beforeUpdate: (() => Promise<void>) | undefined;
  return {
    get: (key: string) => data.get(key),
    keys: () => [...data.keys()],
    writes,
    beforeNextUpdate: (callback: () => Promise<void>) => { beforeUpdate = callback; },
    async update(key: string, value: unknown) {
      writes.push({ key, value });
      const callback = beforeUpdate;
      beforeUpdate = undefined;
      if (callback) await callback();
      if (value === undefined) data.delete(key);
      else data.set(key, value);
    },
  };
}

function makeHarness(state = fakeMemento()) {
  const workspaceState = fakeMemento();
  const logs: string[] = [];
  const controller = new ChatController(
    {
      commandConfigured: true,
      desktopConfigured: false,
      freshToken: () => undefined,
      onHeartbeat() {},
      dispose() {},
      snapshot: () => ({ status: {}, supervisorAlive: false }),
    } as never,
    (line) => logs.push(line),
    state as never,
    workspaceState as never,
    { delete: async () => undefined } as never,
  );
  const frames: Array<{ target: string; frame: HostToWebview }> = [];
  const subscription = controller.subscribe((target, frame) => frames.push({ target, frame }));
  return {
    controller, frames, logs, workspaceState,
    dispose() { subscription.dispose(); controller.dispose(); },
  };
}

const relevantFrames = (frames: ReturnType<typeof makeHarness>["frames"]) =>
  frames.filter(({ frame }) => frame.type === "toolbar/preference" || frame.type === "ui/openPanel");

// 未知项和跨分组的重复项不进入首帧；没有窗口时只让主侧栏消费待开意图。
{
  const state = fakeMemento({ [key]: { enabled: ["tps:full", "obsolete"], hidden: ["tps:full", "attach:full"] } });
  const normalized: ToolbarPreference = {
    enabled: ["tps:full", ...DEFAULT_TOOLBAR_PREFERENCE.enabled.filter((id) => id !== "tps:full" && id !== "attach:full")],
    hidden: ["attach:full", "tokens:full"],
  };
  const { controller, frames, dispose } = makeHarness(state);
  const calls: string[] = [];
  const commands = vscode.commands as unknown as { executeCommand(command: string): Promise<void> };
  const executeCommand = commands.executeCommand;
  commands.executeCommand = async (command) => { calls.push(command); };
  try {
    controller.openToolbarPreferences();
    assert.deepEqual(calls, ["dshChat.view.focus"]);
    assert.deepEqual(relevantFrames(frames), []);

    controller.bindView("editor");
    controller.bindViewKind("editor", "panel");
    await controller.handle({ type: "ready" }, "editor");
    assert.deepEqual(relevantFrames(frames), [{ target: "editor", frame: preference(normalized) }]);

    controller.bindView("sidebar");
    controller.bindViewKind("sidebar", "primary");
    await controller.handle({ type: "ready" }, "sidebar");
    assert.deepEqual(relevantFrames(frames).slice(1), [
      { target: "sidebar", frame: preference(normalized) },
      { target: "sidebar", frame: panel },
    ]);
    const snapshotAt = frames.findIndex(({ target, frame }) => target === "sidebar" && frame.type === "state");
    const preferenceAt = frames.findIndex(({ target, frame }) => target === "sidebar" && frame.type === "toolbar/preference");
    assert.ok(snapshotAt >= 0 && snapshotAt < preferenceAt, "底栏偏好应在首帧快照之后、打开抽屉之前到达");

    const afterReady = frames.length;
    controller.openToolbarPreferences();
    assert.deepEqual(relevantFrames(frames.slice(afterReady)), [
      { target: "editor", frame: preference(normalized) },
      { target: "editor", frame: panel },
    ], "侧栏 ready 消费原命令，但不抢走当前活动窗口");

    controller.bindView("late");
    controller.bindViewKind("late", "panel");
    const afterAttach = frames.length;
    controller.openToolbarPreferences();
    assert.deepEqual(relevantFrames(frames.slice(afterAttach)), [
      { target: "editor", frame: preference(normalized) },
      { target: "editor", frame: panel },
    ], "后台登记也不抢走当前活动窗口");

    controller.noteActiveView("late");
    const beforeLate = frames.length;
    controller.openToolbarPreferences();
    assert.deepEqual(relevantFrames(frames.slice(beforeLate)), [], "已切到未就绪窗口时，命令等待该窗口 ready");
    await controller.handle({ type: "ready" }, "late");
    assert.deepEqual(relevantFrames(frames.slice(beforeLate)), [
      { target: "late", frame: preference(normalized) },
      { target: "late", frame: panel },
    ]);
    assert.deepEqual(calls, ["dshChat.view.focus"], "已有活动视图不应唤起主侧栏");
    assert.deepEqual(state.writes.filter((write) => write.key === key), [], "读取历史偏好不触发写入");
  } finally {
    commands.executeCommand = executeCommand;
    dispose();
  }
}

// 写入必须串行；拒绝不能改变权威状态，随后动作从最近一次成功提交继续。
{
  const state = fakeMemento();
  const { controller, frames, logs, workspaceState, dispose } = makeHarness(state);
  controller.bindView("a");
  controller.bindView("b");
  try {
    let rejectWrite!: (reason: Error) => void;
    const blocked = new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    state.beforeNextUpdate(() => blocked);
    const first = controller.handle({ type: "toolbar/change", action: { type: "hide", id: "effort:full" } }, "a");
    const second = controller.handle({ type: "toolbar/change", action: { type: "hide", id: "attach:full" } }, "b");
    const third = controller.handle({ type: "toolbar/change", action: { type: "enable", id: "tokens:full" } }, "a");
    await Promise.resolve();
    assert.equal(state.writes.filter((write) => write.key === key).length, 1, "前一笔写入完成前不尝试后续写入");
    assert.deepEqual(relevantFrames(frames), [], "存储成功前不广播");
    assert.equal(state.get(key), undefined);

    rejectWrite(new Error("测试存储失败"));
    await Promise.all([first, second, third]);
    const afterHide = {
      enabled: DEFAULT_TOOLBAR_PREFERENCE.enabled.filter((id) => id !== "attach:full"),
      hidden: ["tokens:full", "attach:full"],
    } satisfies ToolbarPreference;
    const committed = { enabled: [...afterHide.enabled, "tokens:full"], hidden: ["attach:full"] } satisfies ToolbarPreference;
    assert.deepEqual(relevantFrames(frames), [
      { target: "a", frame: preference(DEFAULT_TOOLBAR_PREFERENCE) },
      { target: "all", frame: preference(afterHide) },
      { target: "all", frame: preference(committed) },
    ]);
    assert.ok(logs.some((line) => line.includes("保存底栏显示偏好失败")));
    assert.deepEqual(state.get(key), committed);
    assert.equal(workspaceState.get(key), undefined, "偏好不写入工作区存储");

    const invalid = { type: "toolbar/change", action: { type: "enable", id: "obsolete" } } as unknown as WebviewToHost;
    const afterWrites = frames.length;
    await controller.handle(invalid, "a");
    await controller.handle({ type: "toolbar/change", action: { type: "hide", id: "attach:full" } }, "b");
    assert.equal(state.writes.filter((write) => write.key === key).length, 3, "无效动作和空操作不落盘");
    assert.deepEqual(relevantFrames(frames.slice(afterWrites)), [
      { target: "a", frame: preference(committed) },
      { target: "b", frame: preference(committed) },
    ]);

    const restarted = makeHarness(state);
    try {
      restarted.controller.bindView("reload");
      await restarted.controller.handle({ type: "ready" }, "reload");
      assert.deepEqual(relevantFrames(restarted.frames), [{ target: "reload", frame: preference(committed) }]);
    } finally {
      restarted.dispose();
    }
  } finally {
    dispose();
  }
}

console.log("toolbar-preferences-host: 就绪顺序、活动窗口路由、全局持久化与串行回显 ✓");
