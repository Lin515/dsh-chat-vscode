/**
 * 折叠节点的展开态（`src/webview/nodeOpen.ts`）+ 过程折叠的新口径。
 *
 * 用户 2026-09-21 两条口径落在这一层：
 * ① 生成中**用户主动点开**的节点，跑完不许自己收回去；
 * ② 那是「在它还跑着的时候点开的」，所以跑完那一刻**新出现**的正文盒子（运行状态块 +
 *    输入卡 → 结果卡 / 终端卡）要贴底（延续「跟着最新一行」），而不是置顶。
 *
 * 第一半（纯逻辑真调用）：状态是「段 id → {open, openedWhileActive}」，写一条要返回
 * 新的 Map（React 靠引用变化重渲染），收起时把展开意图一起清掉。
 * 第二半（接线源码正则）：状态必须由 `Message` 持有并只经端口下发、行里不许再自持
 * `useState`；过程折叠的默认展开判据必须是「这一段里有用户点开且还开着的节点」，
 * 而按钮照旧在（用户想手动收起这一整段随时可以）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NO_NODE_OPEN,
  hasUserOpenedNode,
  nodePortOf,
  withNodeOpen,
  type NodeOpenState,
} from "../src/webview/nodeOpen";

// ---------- 1. 状态写入：新引用、意图成对 ----------
{
  const empty = NO_NODE_OPEN;
  const opened = withNodeOpen(empty, "r1", true, true);
  assert.notStrictEqual(opened, empty, "写一条必须返回新的 Map（原地改不会触发重渲染）");
  assert.strictEqual(empty.size, 0, "旧的一份不许被改动");
  assert.deepStrictEqual(
    opened.get("r1"),
    { open: true, openedWhileActive: true },
    "展开态与「点开时在不在跑」要成对记下来",
  );

  const closed = withNodeOpen(opened, "r1", false, true);
  assert.deepStrictEqual(
    closed.get("r1"),
    { open: false, openedWhileActive: false },
    "收起时把展开意图一起清掉——下次展开重新判，不继承上一次",
  );

  // 结束后才点开：跑完那一刻新出现的盒子要置顶，所以意图是 false
  const openedAfterDone = withNodeOpen(empty, "t2", true, false);
  assert.strictEqual(openedAfterDone.get("t2")?.openedWhileActive, false);
}
console.log("nodeOpen: 展开态与展开意图成对记录 ✓");

// ---------- 2. 「这一段里有没有用户点开的节点」----------
{
  const runs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.strictEqual(hasUserOpenedNode(NO_NODE_OPEN, runs), false, "谁都没点过 → 不自动展开");
  const state: NodeOpenState = withNodeOpen(NO_NODE_OPEN, "b", true, true);
  assert.strictEqual(hasUserOpenedNode(state, runs), true, "有一个开着的 → 这一段不自动折");
  assert.strictEqual(
    hasUserOpenedNode(withNodeOpen(state, "b", false, false), runs),
    false,
    "用户自己又收起的，没有要保住的东西 → 照旧自动折",
  );
  assert.strictEqual(
    hasUserOpenedNode(state, [{ id: "z" }]),
    false,
    "只认这一段自己的成员，别的段的 id 不算",
  );
}
console.log("nodeOpen: 有用户点开的节点才不自动折这一段 ✓");

// ---------- 3. 端口：读展开态、写回状态 ----------
{
  const seen: NodeOpenState[] = [];
  const port = nodePortOf(NO_NODE_OPEN, "r1", (action) => {
    seen.push(typeof action === "function" ? action(NO_NODE_OPEN) : action);
  });
  assert.strictEqual(port.open, undefined, "用户没动过时是 undefined（行用各自的默认值）");
  assert.strictEqual(port.openedWhileActive, false, "没动过就没有「跑着的时候点开的」这回事");
  port.setOpen(true, true);
  assert.deepStrictEqual(seen.at(-1)?.get("r1"), { open: true, openedWhileActive: true });
  // 更新走 updater 形式：同一批里连点两次也不会拿旧的 state 覆盖
  const current: NodeOpenState = withNodeOpen(NO_NODE_OPEN, "r1", true, false);
  const second = nodePortOf(current, "r1", (action) => {
    seen.push(typeof action === "function" ? action(current) : action);
  });
  assert.strictEqual(second.open, true, "读的是当下那一份状态");
  second.setOpen(false);
  assert.deepStrictEqual(seen.at(-1)?.get("r1"), { open: false, openedWhileActive: false });
}
console.log("nodeOpen: 端口读写与默认值 ✓");

// ---------- 4. 接线：状态在消息里，行里不自持；折叠按钮照旧在 ----------
{
  const rows = readFileSync(join(process.cwd(), "src", "webview", "components", "Rows.tsx"), "utf8");
  // 七处可展开节点里有五处是「过程折叠的成员」：思考 / 工具 / 注入 / 命令 / 未知块
  for (const name of ["ToolRow", "ThinkingRow", "InjectedRow", "CommandRow", "UnknownBlockRow"]) {
    assert.ok(
      new RegExp(`export function ${name}\\([^)]*node(: NodeOpenPort|,)`, "s").test(rows),
      `${name} 必须接展开态端口（状态由 Message 持有，见 src/webview/nodeOpen.ts）`,
    );
  }
  assert.ok(
    /const open = node\.open \?\? false;/.test(rows),
    "行的展开态只来自端口（默认收起），不许再自持 useState",
  );
  assert.ok(
    !/const \[manual, setManual\] = useState/.test(rows) && !/const \[open, setOpen\] = useState\(false\);\s*\n\s*const failed/.test(rows),
    "行里不许再留一份自己的展开态（两份状态必然漂移）",
  );
  assert.ok(
    /if \(hasBody\) node\.setOpen\(!open, running\);/.test(rows),
    "工具行要把「点开这一刻还在不在跑」一起报上去（决定跑完后新盒子贴底还是置顶）",
  );
  assert.ok(
    /onToggle=\{\(\) => node\.setOpen\(!open, streaming === true\)\}/.test(rows) &&
      /onToggle=\{\(\) => node\.setOpen\(!open, command\.state === "running"\)\}/.test(rows),
    "思考 / 命令同样把「点开时在不在跑」报上去",
  );

  const message = readFileSync(join(process.cwd(), "src", "webview", "components", "Message.tsx"), "utf8");
  assert.ok(
    /const nodeOpen = useNodeOpen\(\);/.test(message),
    "Message 是展开态的唯一持有者",
  );
  assert.ok(
    /const node = nodeOpen\.portOf\(segment\.id\);/.test(message) &&
      /<ToolRow key=\{segment\.id\} node=\{node\}/.test(message) &&
      /<InjectedRow key=\{segment\.id\} node=\{node\}/.test(message),
    "每一行都接同一个端口对象（一条交互链路一个端口）",
  );
  assert.ok(
    /runChoice\.get\(run\.anchorId\) \?\? hasUserOpenedNode\(nodeOpen\.state, run\.segments\)/.test(message),
    "过程折叠默认展不展开 = 用户点过按钮就听他的，否则看这一段里有没有用户点开的节点",
  );
  assert.ok(
    /<TurnProcessRow[\s\S]{0,200}?onToggle=\{\(\) => toggleRun\(run\)\}/.test(message),
    "折叠按钮照旧在（用户想收起这一整段随时可以点）",
  );
  assert.ok(
    /new Map\(prev\)\.set\(run\.anchorId, !runOpen\(run\)\)/.test(message),
    "点按钮 = 明确选择：覆盖自动展开的判据（否则按钮点不动）",
  );
}
console.log("nodeOpen: 状态在消息里、行里只读端口，折叠按钮保留 ✓");

console.log("\nnodeOpen: all assertions passed");
