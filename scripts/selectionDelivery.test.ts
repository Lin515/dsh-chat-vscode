import assert from "node:assert/strict";
import { mock } from "node:test";
import { SelectionContext } from "../src/dsh/selectionContext";
import type { SelectionContextView } from "../src/shared/ipc";

const cwd = "/work/project";
const local = { filePath: `${cwd}/src/a.ts`, lines: { start: 2, end: 4 }, preview: "let x = 1;" };

/** 只提供宿主事实并观察模块公开的投递与发送结果，不构造控制器或读取内部状态。 */
function fixture() {
  let active: string | undefined;
  let initialCwd = cwd;
  const views = new Map<string, { sessionId: string | undefined; cwd: string | undefined }>();
  const connections = new Set<string>();
  const frames: { viewId: string; chip: SelectionContextView | null }[] = [];
  const selection = new SelectionContext({
    activeViewId: () => active,
    view: (id) => views.get(id) ?? { sessionId: undefined, cwd: initialCwd },
    initialCwd: () => initialCwd,
    connectionCurrent: (id) => connections.has(id),
    publish: (viewId, chip) => frames.push({ viewId, chip }),
    log() {},
  });
  return {
    selection, connections, frames, views,
    setInitialCwd: (path: string) => { initialCwd = path; },
    activate: (viewId: string) => { active = viewId; },
    chipFor: (viewId: string) => frames.filter((frame) => frame.viewId === viewId).at(-1)?.chip,
  };
}

mock.timers.enable({ apis: ["setTimeout"] });
try {
  {
    const { selection, views, frames, activate, chipFor } = fixture();
    activate("first");
    selection.viewRegistered("first");
    selection.capture(local);
    mock.timers.tick(300);
    const chip = chipFor("first");
    assert.ok(chip);
    assert.equal(selection.referenceForSend("elsewhere", chip.id, chip.token), undefined);
    assert.equal(selection.referenceForSend("first", chip.id + 1, chip.token), undefined);
    assert.equal(selection.referenceForSend("first", chip.id, "@different.ts"), undefined);
    const clicked = selection.referenceForSend("first", chip.id, chip.token);
    assert.ok(clicked);
    assert.equal(clicked.sessionId, undefined, "按下发送时窗口尚未绑定");

    // 展示、替换、首次绑定和已提交的快照是不同概念；只更新今后的投递归属。
    selection.capture({ ...local, lines: { start: 2, end: 6 } });
    const bound = { sessionId: "first-session", cwd };
    selection.bindingChanged("first", { ...bound, automaticBlank: true });
    views.set("first", bound);
    selection.replay("first");
    assert.deepEqual(frames, [{ viewId: "first", chip }, { viewId: "first", chip }]);
    assert.equal(selection.referenceForSend("first", chip.id, chip.token), undefined, "已绑定的旧占位仍不能发送");
    mock.timers.tick(300);
    const replacement = chipFor("first");
    assert.ok(replacement);
    assert.equal(replacement.token, "@src/a.ts#L2-L6");
    const later = selection.referenceForSend("first", replacement.id, replacement.token);
    assert.ok(later);
    assert.equal(later.sessionId, bound.sessionId, "绑定后的发送指向已绑定会话");

    activate("elsewhere");
    selection.activeViewChanged("first");
    assert.equal(chipFor("first"), null);
    const otherSession = { ...bound, sessionId: "another-session" };
    assert.equal(later.matches(otherSession), false, "绑定后的快照不接受同目录的别的会话");
    assert.equal(clicked.sessionId, undefined, "首次绑定不得改写已取出的快照归属");
    assert.equal(clicked.token, "@src/a.ts#L2-L4", "之后的选区不改写已取出的 token");
    assert.equal(clicked.matches(otherSession), true, "未绑定时取出的快照只认执行目录，不认后来提交的绑定或焦点");
    assert.equal(clicked.matches({ ...bound, cwd: "/different" }), false);
  }

  {
    const { selection, views, connections, activate, chipFor } = fixture();
    const bound = { sessionId: "session-a", cwd: "/work/../opaque" };
    activate("panel");
    selection.viewRegistered("panel");
    views.set("panel", bound);
    connections.add("origin");
    selection.capture({ remoteFile: { sessionId: bound.sessionId, connectionId: "origin", path: "/remote/a.ts" }, preview: "" });
    mock.timers.tick(300);
    const chip = chipFor("panel");
    assert.ok(chip);
    assert.equal(chip.token, "@/remote/a.ts", "只读副本允许安全的绝对路径回退");
    const clicked = selection.referenceForSend("panel", chip.id, chip.token);
    assert.ok(clicked);
    assert.equal(clicked.matches(bound), true);
    assert.equal(clicked.matches({ ...bound, cwd: "/opaque" }), false, "不可折算的目录仍要按原值比较");
    assert.equal(clicked.matches({ ...bound, sessionId: "other" }), false);
    connections.delete("origin");
    selection.refresh();
    assert.equal(chipFor("panel"), null, "原连接失效时撤下芯片");
    assert.equal(clicked.matches(bound), false, "原连接失效后，已点击的引用也不能交给发送");
  }

  {
    const { selection, activate, setInitialCwd, frames } = fixture();
    selection.capture(local);
    setInitialCwd("/different");
    selection.refresh();
    setInitialCwd(cwd);
    activate("first");
    selection.viewRegistered("first");
    mock.timers.tick(300);
    assert.deepEqual(frames, [], "开窗前目录切走再切回也不能恢复曾暂存的选区");
    selection.capture(local);
    selection.dispose();
    mock.timers.tick(300);
    assert.deepEqual(frames, [], "释放模块后未完成的投递不会漏出帧");
  }
} finally {
  mock.timers.reset();
}

console.log("selectionDelivery: 投递、首次绑定、发送快照与原连接复核 ✓");
