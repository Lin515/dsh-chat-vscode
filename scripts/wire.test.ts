/**
 * 过线语义：宿主 → webview 的帧会被 VS Code `JSON.stringify` 一遍，
 * **值为 `undefined` 的键会被整条丢掉**。
 *
 * 这组断言钉住的是用户 2026-09-12 报的那个 bug 的根因：
 * 「进行中的目标」清不掉、切会话也一直在。服务端其实早就 `Goal cleared.`
 * （会话日志里能查到 `command/run /goal clear` → `command/done success`），
 * 但宿主发的 `patch: { goal: undefined }` 过线后变成 `patch: {}`，
 * 界面看到一个什么都不改的空 patch，目标条就永远停在那儿；
 * 用户接着去点「暂停目标」，服务端回 `No goal is currently set`。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSafeFrame, mergeWirePatch } from "../src/shared/wire";

/** 复刻 VS Code 的 postMessage：先 JSON.stringify，界面上再 JSON.parse。 */
const overTheWire = (frame: unknown): any => JSON.parse(JSON.stringify(frame));

// ---------- 0. 先钉住前提：不做转换时「清空」真的会凭空消失 ----------
//
// 这条是**对照**，不是产品行为：它证明后面那些断言不是形式主义。
{
  const raw = overTheWire({ type: "patch", patch: { goal: undefined, running: true } });
  assert.deepStrictEqual(
    raw.patch,
    { running: true },
    "（对照）不过线的 undefined 键会被 JSON 丢掉 —— 这正是 bug 现场",
  );
}
console.log("wire: 过线会丢掉 undefined（bug 现场可复现）✓");

// ---------- 1. 清空意图必须活着过线 ----------
{
  const sent = overTheWire(
    jsonSafeFrame({ type: "patch", patch: { goal: undefined, running: true } } as never),
  );
  assert.ok("goal" in sent.patch, "goal 键必须还在（否则界面读不到「清空」）");
  assert.strictEqual(sent.patch.goal, null, "清空要表达成 null");
  assert.strictEqual(sent.patch.running, true, "其余字段照常");
}
console.log("wire: 清空意图过线为 null ✓");

// ---------- 2. 界面侧：null = 清除该字段（折回 undefined） ----------
//
// 界面里所有可选字段的判断都按 undefined 写（`tps !== undefined`、
// `state.contextOccupancy?.percent`…），所以必须**删键**而不是留个 null。
{
  const state = { goal: { objective: "x" }, running: true, messages: [] };
  const next = mergeWirePatch(state, { goal: null, running: false });
  assert.strictEqual(next.goal, undefined, "null 要折回 undefined");
  assert.ok(!("goal" in next), "键要被删掉，而不是留 null（留 null 会让 `!== undefined` 的判断漏过去）");
  assert.strictEqual(next.running, false);
  assert.deepStrictEqual(next.messages, []);
}
console.log("wire: null 折回「键不存在」✓");

// ---------- 3. 端到端复刻用户场景 ----------
//
// 两条路径都要通：① 点「清除目标」；② 切到没有目标的会话（新会话开帧里
// `goal` 是 null，实测见 scripts/goalSessionProbe.ts）。
{
  const initial = { goal: { objective: "完成 DSH Chat 扩展的全部剩余工作" }, running: true };
  const patch = (value: unknown) => overTheWire(jsonSafeFrame({ type: "patch", patch: value } as never)).patch;

  const cleared = mergeWirePatch(initial, patch({ goal: undefined }));
  assert.strictEqual(cleared.goal, undefined, "清除目标后界面不该再挂着目标条");

  const switched = mergeWirePatch(initial, patch({ goal: null }));
  assert.strictEqual(switched.goal, undefined, "服务端回 goal: null（没有目标的会话）时同样要清掉");
}
console.log("wire: 清目标 / 切会话两条路径都清得掉 ✓");

// ---------- 4. 切会话时那一整包粘性值也必须全部过线 ----------
//
// `controller.clearedStickyPatch()` 清的是同一类「上一会话的残留」，
// 只是它们不如目标条显眼，坏了很久没人发现。
{
  const keys = [
    "contextBreakdown",
    "sessionStats",
    "contextOccupancy",
    "contextWindow",
    "lastSpeed",
    "tokenUsage",
    "turnOutline",
    "imageLimits",
  ] as const;
  const sent = overTheWire(
    jsonSafeFrame({
      type: "patch",
      patch: Object.fromEntries(keys.map((key) => [key, undefined])),
    } as never),
  ).patch;
  for (const key of keys) assert.strictEqual(sent[key], null, `${key} 的清除必须过线`);
}
console.log("wire: 切会话的粘性值清除全部过线 ✓");

// ---------- 5. 结构不变量：两端都真的挂了这两步 ----------
//
// 少了宿主那一步（jsonSafeFrame）清空会被丢掉；少了界面那一步（mergeWirePatch）
// null 会当成真值写进状态。
{
  const chatView = readFileSync(join(process.cwd(), "src", "chatView.ts"), "utf8");
  assert.ok(
    /const wire = jsonSafeFrame\(frame\);\s*\n\s*for \(const view of this\.views\) void view\.postMessage\(wire\);/.test(
      chatView,
    ),
    "chatView.broadcast 必须 postMessage(jsonSafeFrame(frame))——直接发原始帧会让清空失效",
  );

  const state = readFileSync(join(process.cwd(), "src", "webview", "state.ts"), "utf8");
  assert.ok(
    /case "patch":\s*\n\s*return mergeWirePatch\(state, action\.patch\)/.test(state),
    "webview 的 patch 分支必须走 mergeWirePatch（否则 null 会被当成真值写进状态）",
  );
  assert.ok(
    /mergeWirePatch\(state, action\.state\)/.test(state),
    "webview 的 state 分支要走 mergeWirePatch（首帧快照里的 null 同样要折回 undefined）",
  );
}
console.log("wire: 宿主与界面两端都接上了 ✓");

console.log("\nwire: all assertions passed");
