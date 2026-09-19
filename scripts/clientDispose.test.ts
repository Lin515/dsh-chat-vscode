/**
 * 离线断言：**`DshClient.dispose()` 真的能停掉它自己的无限重连**。
 *
 * 为什么单独一条（2026-09-19）：`DshClient` 在 ws 断开后会按 1s→2s→…→15s **一直重连**
 * （见 `client.ts` 的 `ws.on("close")`），而且每次 close/connect 都回调状态。扩展侧的
 * 「停止连接」如果只置两个布尔量、不 dispose 客户端，那条重连循环照旧跑，界面会被反复
 * 拉回"连接中"——用户实测的"点了停止停不下来"就是这么来的。
 *
 * `scripts/connectionStop.test.ts` 钉的是"controller 代码里有没有写 dispose"（源码断言，
 * controller 依赖 `vscode` 起不了实例）；这一条钉的是**被依赖的那个事实**：对一个连接
 * 不上的地址，客户端确实会自己重连；`dispose()` 之后确实不再有任何一次状态变化。
 *
 * 用本机**关闭的端口**做对端（连不上是事实判据，不靠假实现）：`ECONNREFUSED` 立刻返回，
 * 所以观察窗口取 3 秒足够看到 1 次重连。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { createServer } from "node:net";
import { DshClient } from "../src/dsh/client";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 拿一个"确实没人监听"的回环端口：先监听、读到端口、立刻关掉。 */
async function deadBaseUrl(): Promise<string> {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseUrl = await deadBaseUrl();
const client = new DshClient(baseUrl, undefined, () => undefined);
const states: string[] = [];
client.onDidChangeState((state) => states.push(state));

client.connect();
await wait(2_600); // 首轮 connecting/disconnected + 1 秒后的第一次重连

const beforeDispose = states.length;
check(
  "对连不上的地址，客户端**自己**会重连（多轮 connecting/disconnected）",
  beforeDispose >= 3,
  `观察到的状态：${states.join(" → ") || "（无）"}`,
);
check(
  "首轮状态是 connecting（界面据此显示「正在连接」）",
  states[0] === "connecting",
  states[0] ?? "（无）",
);
check(
  "同一次断线里能看到 disconnected（掉线文案的来源）",
  states.includes("disconnected"),
  states.join(" → "),
);

client.dispose();
const afterDispose = states.length;
await wait(3_000); // 覆盖"下一个重连窗口"（退避已到 2s）

check(
  "dispose() 之后**一次状态变化都没有**（重连循环真的停了）",
  states.length === afterDispose,
  `dispose 后又多了 ${states.length - afterDispose} 次：${states.slice(afterDispose).join(" → ") || "（无）"}`,
);
check(
  "再次 connect() 也不会复活（disposed 是单向的）",
  (() => {
    client.connect();
    return states.length === afterDispose;
  })(),
);
client.dispose();

if (failures > 0) {
  console.error(`\n✗ 客户端 dispose 与无限重连：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 客户端 dispose（自己会重连 / dispose 后彻底安静 / 不会复活）全通过");
  assert.ok(true);
}
