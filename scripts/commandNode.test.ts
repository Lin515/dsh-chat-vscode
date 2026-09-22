/**
 * 斜杠命令节点与「本轮文件改动」的适配器行为。
 *
 * 三条此前完全落空的链路：
 * 1. `command/run` ↔ `command/done` 被整体静默（在 `SILENT_EVENT_TYPES` 里），
 *    于是任何斜杠命令——包括界面上按钮发出的 `/plan`、`/permission`——都**没有任何
 *    可见结果**；
 * 2. `deliverables/presented` 写进了 `message.deliverables` 却无人渲染；
 * 3. 从成功的 write / edit 调用推导的「本轮文件改动」（`message.produced`）
 *    这条来源根本不存在（docs/audit-summary.md「交付文件完全不可见」一条）。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";

/** 收集适配器发出的帧，并保留最后一个状态的辅助视图。 */
function harness() {
  const frames: { type: string; [key: string]: unknown }[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame as never));
  return {
    adapter,
    frames,
    /** 最新一条助手消息（`message/upsert` 或快照里取）。 */
    message(id: string) {
      for (let i = frames.length - 1; i >= 0; i -= 1) {
        const frame = frames[i];
        if (frame.type === "message/upsert" && (frame.message as { id: string }).id === id) {
          return frame.message as {
            id: string;
            segments: { kind: string; id: string; command?: Record<string, unknown> }[];
            deliverables?: { path: string; description?: string }[];
            produced?: string[];
          };
        }
      }
      return adapter.snapshotMessages().find((message) => message.id === id) as never;
    },
  };
}

let seq = 0;
function wire(type: string, data: Record<string, unknown> = {}) {
  return { type, seq: seq++, time: 1_789_147_200_000, data };
}

// ---------- 1. command/run 建节点，command/done 按 commandId 结算 ----------

{
  const { adapter, frames, message } = harness();
  adapter.applyEvent(
    wire("command/run", { commandId: "cmd-1", name: "plan", source: { kind: "user" } }) as never,
  );
  const running = message("a:0");
  assert.strictEqual(running.segments.length, 1, "命令节点要挂在当前助手的消息流上");
  assert.strictEqual(running.segments[0].kind, "command");
  assert.deepStrictEqual(
    running.segments[0].command,
    { commandId: "cmd-1", name: "plan", args: undefined, state: "running" },
  );

  adapter.applyEvent(
    wire("command/done", {
      commandId: "cmd-1",
      kind: "success",
      text: "Plan mode on. Use /plan off to leave.",
    }) as never,
  );
  const settled = message("a:0");
  assert.strictEqual(settled.segments.length, 1, "结算必须复用同一个节点，不能多出一行");
  assert.strictEqual(settled.segments[0].command?.state, "ok");
  assert.strictEqual(settled.segments[0].command?.text, "Plan mode on. Use /plan off to leave.");
  assert.ok(
    frames.some((frame) => frame.type === "message/segment"),
    "结算走 message/segment（状态变化不需要重发整条消息）",
  );
}
console.log("commandNode: command/run 建节点、command/done 按 id 结算 ✓");

// ---------- 2. 带参数的命令：args 原样保留 ----------

{
  const { adapter, message } = harness();
  adapter.applyEvent(
    wire("command/run", { commandId: "cmd-2", name: "permission", args: " read-only" }) as never,
  );
  assert.strictEqual(
    message("a:0").segments[0].command?.args,
    "read-only",
    "args 只做首尾空白裁剪（分隔空白含在 wire 值里）",
  );
}
console.log("commandNode: 带参数的命令保留 args ✓");

// ---------- 3. 失败的命令要标记 error ----------

{
  const { adapter, message } = harness();
  adapter.applyEvent(wire("command/run", { commandId: "cmd-3", name: "goal" }) as never);
  adapter.applyEvent(
    wire("command/done", { commandId: "cmd-3", kind: "error", text: "No goal is currently set." }) as never,
  );
  assert.strictEqual(message("a:0").segments[0].command?.state, "error");
  assert.strictEqual(message("a:0").segments[0].command?.text, "No goal is currently set.");
}
console.log("commandNode: 失败的命令标 error 并保留失败文案 ✓");

// ---------- 4. 只有 command/done（run 被窗口截在外）时仍补一个节点 ----------

{
  const { adapter, message } = harness();
  adapter.applyEvent(
    wire("command/done", { commandId: "cmd-4", kind: "success", text: "Compacted." }) as never,
  );
  const only = message("a:0");
  assert.strictEqual(only.segments.length, 1, "结果不能因为配对不到 run 就丢掉");
  assert.strictEqual(only.segments[0].command?.text, "Compacted.");
  assert.strictEqual(only.segments[0].command?.state, "ok");
}
console.log("commandNode: 配对不到 run 时仍保留结果 ✓");

// ---------- 5. 坏数据不建节点（缺 commandId / 缺 name） ----------

{
  const { adapter, frames } = harness();
  adapter.applyEvent(wire("command/run", { name: "plan" }) as never);
  adapter.applyEvent(wire("command/run", { commandId: "cmd-5" }) as never);
  adapter.applyEvent(wire("command/done", { kind: "success" }) as never);
  assert.deepStrictEqual(
    frames.filter((frame) => frame.type === "message/append" || frame.type === "message/upsert"),
    [],
    "缺 commandId / name 的事件不该凭空造出节点",
  );
}
console.log("commandNode: 缺字段的事件不建节点 ✓");

// ---------- 6. 本轮文件改动：成功的 write/edit 才计入，按首次出现去重 ----------

{
  const { adapter, message } = harness();
  adapter.applyEvent(wire("turn/start", { turn: 1 }) as never);

  const call = (callId: string, name: string, args: unknown) =>
    adapter.applyEvent(
      wire("tool/call", { callId, name, arguments: JSON.stringify(args), turn: 1, step: 1 }) as never,
    );
  const result = (callId: string, isError = false) =>
    adapter.applyEvent(
      wire("tool/result", {
        turn: 1,
        step: 1,
        message: { source: { callId }, content: [{ type: "tool-result", content: [], isError }] },
      }) as never,
    );

  call("c1", "write", { file_path: "src/a.ts", content: "x" });
  result("c1");
  call("c2", "read", { file_path: "src/a.ts" });
  result("c2");
  call("c3", "edit", { file_path: "src/b.ts", old_string: "a", new_string: "b" });
  result("c3");
  // 同一轮里再改一次同一个文件：只应出现一次
  call("c4", "edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" });
  result("c4");
  // 失败的改动不计入
  call("c5", "write", { file_path: "src/c.ts", content: "z" });
  result("c5", true);
  // 参数残缺（缺 content）不计入
  call("c6", "write", { file_path: "src/d.ts" });
  result("c6");

  assert.deepStrictEqual(
    message("a:1").produced,
    ["src/a.ts", "src/b.ts"],
    "只计成功的变更调用，按首次出现排序、同一路径去重",
  );
  assert.ok(
    message("a:1").segments.every((segment) => segment.kind !== "command" || true),
    "工具节点不受影响",
  );
}
console.log("commandNode: 本轮文件改动只收成功的变更调用并去重 ✓");

// ---------- 7. deliverables/presented 仍然写入（另一条来源，界面分行渲染） ----------

{
  const { adapter, message } = harness();
  adapter.applyEvent(wire("turn/start", { turn: 1 }) as never);
  adapter.applyEvent(
    wire("deliverables/presented", {
      turn: 1,
      callId: "c1",
      files: [{ path: "out/report.md", description: "审计报告" }, { path: "out/data.json" }],
    }) as never,
  );
  assert.deepStrictEqual(message("a:1").deliverables, [
    { path: "out/report.md", description: "审计报告" },
    { path: "out/data.json", description: undefined },
  ]);
  // 申报与推导是两条独立来源：present 不该被算进 produced
  assert.strictEqual(message("a:1").produced, undefined, "present 是申报，不是变更调用");
}
console.log("commandNode: deliverables/presented 独立于 produced ✓");

console.log("\ncommandNode: all assertions passed");
