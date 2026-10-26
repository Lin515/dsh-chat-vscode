/**
 * 适配器接线：工具行 / 产物 / 终端目录在实时结算与历史重放里走同一套判据。
 *
 * 关键点：
 * - `parentCallId` 从 `tool/call` 原始数据一直传到判据，嵌套调用不被计成根产物；
 * - 产物保留每次操作的 `path` / `argumentPath` / `seq` / `turn`，不按 canonical 去重；
 * - 记录值只在结算时采用，运行中的相对参数不提前成为打开目标；
 * - 改执行目录不改变已记录目标；历史重放得到同样的结果。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { SessionAdapter } from "../src/dsh/adapter";
import type { MessageView, ToolCallView } from "../src/shared/chat";
import type { HostToWebview } from "../src/shared/ipc";

interface Harness {
  adapter: SessionAdapter;
  frames: HostToWebview[];
  message(id?: string): MessageView;
  tool(callId: string): ToolCallView;
}

function harness(): Harness {
  const frames: HostToWebview[] = [];
  const adapter = new SessionAdapter((frame) => frames.push(frame));
  const message = (id = "a:1") => {
    const snapshot = adapter.snapshotMessages().find((candidate) => candidate.id === id);
    assert.ok(snapshot, `应存在消息 ${id}`);
    return snapshot;
  };
  const tool = (callId: string) => {
    for (const candidate of adapter.snapshotMessages()) {
      for (const segment of candidate.segments) {
        if (segment.kind === "tool" && segment.tool.id === callId) return segment.tool;
      }
    }
    throw new Error(`找不到工具调用 ${callId}`);
  };
  return { adapter, frames, message, tool };
}

let seq = 0;
function wire(type: string, data: unknown) {
  seq += 1;
  return { type, seq, time: 1_789_147_200_000 + seq, data };
}

function call(
  adapter: SessionAdapter,
  callId: string,
  name: string,
  args: Record<string, unknown>,
  options: { parentCallId?: string } = {},
): void {
  adapter.applyEvent(
    wire("tool/call", {
      turn: 1,
      step: 1,
      callId,
      name,
      arguments: JSON.stringify(args),
      ...(options.parentCallId === undefined ? {} : { parentCallId: options.parentCallId }),
    }) as never,
  );
}

function result(
  adapter: SessionAdapter,
  callId: string,
  options: { meta?: unknown; isError?: boolean; turn?: number } = {},
): void {
  adapter.applyEvent(
    wire("tool/result", {
      turn: options.turn ?? 1,
      step: 1,
      ...(options.meta === undefined ? {} : { meta: options.meta }),
      message: {
        id: `r-${callId}`,
        role: "tool",
        toolCallId: callId,
        isError: options.isError === true,
        content: [{ type: "text", text: options.isError ? "boom" : "ok" }],
        source: { kind: "tool", callId },
      },
    }) as never,
  );
}

// ---------- 1. 工具行：运行中相对参数不可点，结算记录值优先 ----------
{
  const { adapter, tool } = harness();
  call(adapter, "c1", "write", { file_path: "src/a.ts", content: "x" });
  assert.strictEqual(tool("c1").filePath, undefined, "运行中的相对参数还不是打开目标");
  result(adapter, "c1", { meta: { path: "/exec/src/a.ts" } });
  assert.strictEqual(tool("c1").filePath, "/exec/src/a.ts", "结算后记录值优先");
}
console.log("pathAdapter: 运行中不猜、结算后记录值优先 ✓");

// ---------- 2. 产物：每次操作保留别名与坐标，不按 canonical 去重 ----------
{
  const { adapter, message } = harness();
  call(adapter, "c1", "write", { file_path: "src/one.ts", content: "x" });
  result(adapter, "c1", { meta: { path: "/exec/src/one.ts" } });
  call(adapter, "c2", "edit", {
    file_path: "./src/one.ts",
    old_string: "x",
    new_string: "y",
  });
  result(adapter, "c2", { meta: { path: "/exec/src/one.ts" } });
  // 同一 canonical，第三个参数别名
  call(adapter, "c3", "write", { file_path: "src/../src/one.ts", content: "z" });
  result(adapter, "c3", { meta: { path: "/exec/src/one.ts" }, turn: 2 });

  const produced = message().produced ?? [];
  assert.deepStrictEqual(
    produced.map((operation) => [operation.path, operation.argumentPath]),
    [
      ["/exec/src/one.ts", "src/one.ts"],
      ["/exec/src/one.ts", "./src/one.ts"],
      ["/exec/src/one.ts", "src/../src/one.ts"],
    ],
    "同一 canonical 的多个参数别名必须都保留（正文行内代码唯一匹配要用）",
  );
  assert.ok(
    produced.every((operation) => Number.isInteger(operation.seq) && operation.seq > 0),
    "每条产物保留结算 event seq",
  );
  assert.deepStrictEqual(produced.map((operation) => operation.turn), [1, 1, 2], "保留所属轮次");
}
console.log("pathAdapter: 产物保留全部别名与 seq / turn，不按 canonical 去重 ✓");

// ---------- 3. 无效 meta 时工具行与产物分道 ----------
{
  const { adapter, tool, message } = harness();
  call(adapter, "c1", "write", { file_path: "src/keep.ts", content: "x" });
  result(adapter, "c1", { meta: { path: "relative-invalid" } });
  assert.strictEqual(tool("c1").filePath, "src/keep.ts", "成功根调用的工具行仍保留相对参数动作");
  assert.strictEqual(message().produced, undefined, "产物遇到无效 meta 且参数相对 → 不登记");

  call(adapter, "c2", "write", { file_path: "src/abs-arg.ts", content: "x" });
  result(adapter, "c2", { meta: { path: "" } });
  // 参数相对，自有 path 空串 → 产物不登记
  assert.strictEqual(message().produced, undefined);

  call(adapter, "c3", "write", { file_path: "/exec/abs.ts", content: "x" });
  result(adapter, "c3", { meta: { path: "relative-invalid" } });
  assert.strictEqual(
    message().produced?.at(-1)?.path,
    "/exec/abs.ts",
    "参数本身绝对时，无效记录值仍可回退参数登记",
  );
}
console.log("pathAdapter: 无效 meta 时工具行可保留、产物按三档不登记 ✓");

// ---------- 4. 失败 / 嵌套调用不计入根产物 ----------
{
  const { adapter, tool, message } = harness();
  call(adapter, "c1", "write", { file_path: "src/fail.ts", content: "x" });
  result(adapter, "c1", { isError: true, meta: { path: "/exec/src/fail.ts" } });
  assert.strictEqual(message().produced, undefined, "失败结果不登记为成功产物");

  call(adapter, "c2", "write", { file_path: "src/nested.ts", content: "x" }, { parentCallId: "root" });
  result(adapter, "c2", { meta: { path: "/exec/src/nested.ts" } });
  assert.strictEqual(message().produced, undefined, "PTC 子调用不重新计成根产物");
  assert.strictEqual(tool("c2").filePath, "/exec/src/nested.ts", "嵌套调用仍可使用绝对记录值");

  call(adapter, "c3", "write", { file_path: "src/nested-relative.ts", content: "x" }, { parentCallId: "root" });
  result(adapter, "c3", {});
  assert.strictEqual(tool("c3").filePath, undefined, "嵌套调用的相对参数不成为打开目标");
}
console.log("pathAdapter: 失败与嵌套调用不进根产物；嵌套相对参数不可点 ✓");

// ---------- 5. 终端目录：记录值原样，旧根调用按创建目录回退，运行/嵌套不猜 ----------
{
  const { adapter, tool } = harness();
  adapter.sessionCwd = "/A";

  call(adapter, "t1", "bash", { command: "echo x", workdir: "sub", description: "inspect" });
  const runningCard = tool("t1").card;
  assert.ok(runningCard && runningCard.kind === "terminal");
  assert.strictEqual(runningCard.cwd, undefined, "运行中的相对 workdir 不猜目录");
  result(adapter, "t1", { meta: { cwd: "/B/../recorded" } });
  const settledCard = tool("t1").card;
  assert.ok(settledCard && settledCard.kind === "terminal");
  assert.strictEqual(settledCard.cwd, "/B/../recorded", "结算记录 cwd 原样优先");

  call(adapter, "t2", "bash", { command: "echo x", workdir: "sub", description: "old result" });
  result(adapter, "t2", {});
  const oldCard = tool("t2").card;
  assert.ok(oldCard && oldCard.kind === "terminal");
  assert.strictEqual(oldCard.cwd, "/A/sub", "旧结果相对 workdir 拼创建目录");

  call(adapter, "t3", "bash", { command: "echo x", workdir: "sub", description: "nested" }, { parentCallId: "root" });
  result(adapter, "t3", {});
  const nestedCard = tool("t3").card;
  assert.ok(nestedCard && nestedCard.kind === "terminal");
  assert.strictEqual(nestedCard.cwd, undefined, "嵌套调用不借创建目录回退");
}
console.log("pathAdapter: 终端记录 cwd 原样、旧根调用回退、运行/嵌套不猜 ✓");

// ---------- 6. 历史重放：同一事件序列得到同样的目标与产物坐标 ----------
{
  const events = [
    wire("tool/call", {
      turn: 1,
      step: 1,
      callId: "h1",
      name: "write",
      arguments: JSON.stringify({ file_path: "src/history.ts", content: "x" }),
    }),
    wire("tool/result", {
      turn: 1,
      step: 1,
      meta: { path: "/exec/src/history.ts" },
      message: {
        id: "r-h1",
        role: "tool",
        toolCallId: "h1",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        source: { kind: "tool", callId: "h1" },
      },
    }),
    wire("tool/call", {
      turn: 1,
      step: 1,
      callId: "h2",
      name: "bash",
      arguments: JSON.stringify({ command: "pwd", workdir: "sub", description: "live" }),
    }),
    wire("tool/result", {
      turn: 1,
      step: 1,
      meta: { path: "ignore" },
      message: {
        id: "r-h2",
        role: "tool",
        toolCallId: "h2",
        isError: false,
        content: [{ type: "text", text: "pwd\n" }],
        source: { kind: "tool", callId: "h2" },
      },
    }),
  ] as never[];

  const live = harness();
  live.adapter.sessionCwd = "/A";
  for (const event of events) live.adapter.applyEvent(event);
  const liveProduced = live.message().produced;
  const livePath = live.tool("h1").filePath;
  const liveCwd = live.tool("h2").card?.kind === "terminal" ? live.tool("h2").card.cwd : undefined;

  const replay = harness();
  replay.adapter.sessionCwd = "/A";
  for (const event of events) replay.adapter.applyEvent(event);
  assert.deepStrictEqual(replay.message().produced, liveProduced, "重放得到同样的产物操作与坐标");
  assert.strictEqual(replay.tool("h1").filePath, livePath, "重放得到同样的打开目标");
  const replayCwd = replay.tool("h2").card?.kind === "terminal" ? replay.tool("h2").card.cwd : undefined;
  assert.strictEqual(replayCwd, liveCwd, "重放得到同样的终端目录标签");
  assert.deepStrictEqual(liveProduced?.map((operation) => operation.path), ["/exec/src/history.ts"]);
}
console.log("pathAdapter: 历史重放与实时结算得到同一目标 / 产物坐标 ✓");

console.log("\npathAdapter: all assertions passed");
