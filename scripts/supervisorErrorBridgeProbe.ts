/**
 * 【探针定位】防线型 · 零模型 token —— 验「守护进程 error → 窗口」的协议桥
 *   （用假守护进程，不依赖真实故障时序）；动错误桥后跑，可自由运行。
 *
 * 探针：**"守护进程报错 → 窗口收到"这条桥**（2026-09-15 用户要求）。
 *
 * 背景：守护进程内部抛错时，错误只落在它自己的 `supervisor.log` 里——
 * 那是 `~/.dsh/dsh-chat-vscode/supervisors/<分组>/` 下的文件，用户不会去翻。表现就是
 * "后台莫名不工作"。用户口径："抛错可以捕获，并将错误发回 VSCode 的日志吗？"
 *
 * ## 为什么这个探针用"假守护进程"而不是真让它抛错
 *
 * 试过两条"让真守护进程自然出错"的路（构造坏参数、删它的日志文件），都**不可靠**：
 * 故障是否真的抛、抛在哪一步，受时序影响（第一次跑就没抛成，白等 20 秒）。
 * 而这条桥要验的东西跟"怎么抛的"无关——**协议能不能把 error 送到窗口**才是关键。
 * 所以这里起一个只说协议、只发一条 error 的迷你 socket 服务端（1:1 复刻 supervisor
 * 的报文形状），用**真的** `SupervisorConnection` 去连它。
 *
 * 真守护进程那半边由别处保证：
 * - 上报器本体（两处都发 / 绝不外抛 / 补发）→ `scripts/supervisorErrors.test.ts`（离线）；
 * - 回调抛错不让进程死 → `scripts/supervisorChildExitProbe.ts`（真守护进程 + 真故障）。
 *
 * 用法：node build/supervisor-error-bridge-probe.mjs [日志文件]
 */
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// 必须排在最前面：会合目录指到本次探针专用目录（模块求值期读一次）
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { encodeMessage } from "../src/dsh/supervisorWire";
import { SupervisorConnection } from "../src/dsh/supervisorClient";

const LOG = process.argv[2] ?? ".tmp/supervisor-fault.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string): void => {
  appendFileSync(LOG, `${line}\n`, "utf8");
};

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const isolated = PROBE_SUPERVISOR_ROOT;
if (!isolated || !/dsh-chat-sup-probe-/.test(isolated)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${isolated}\n`);
  process.exit(2);
}

const pipeDir = mkdtempSync(join(tmpdir(), "dsh-chat-fault-"));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 迷你"守护进程"：接受一条连接，按 supervisor 的真实报文形状回东西。 */
function startFakeSupervisor(socketPath: string, script: (socket: import("node:net").Socket) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(script);
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

const servers: Server[] = [];

try {
  say(`会合根目录（隔离）：${isolated}`);
  say("（本探针只起一个只说协议的迷你 socket 服务端，不杀任何进程、不碰真实后台）");

  // ============ A：error 报文能被窗口侧收下并还原 ============
  say("\n【A】守护进程发一条 error → 窗口侧必须收到（kind + message 原样）…");
  const socketA = `\\\\.\\pipe\\dsh-chat-faultbridge-a-${process.pid}`;
  const receivedA: { kind: string; message: string }[] = [];
  const serverA = await startFakeSupervisor(socketA, (socket) => {
    // 守护进程连上就先补发历史错误、再推状态——这里按同样的顺序发
    socket.write(encodeMessage({ t: "error", kind: "shutdown", message: "TypeError: 日志不可写 @ at openSync" }));
    socket.write(
      encodeMessage({
        t: "state",
        state: null,
        clients: 1,
      }),
    );
    socket.on("data", () => {
      // 客户端的 ping/hello 一律不理
    });
  });
  servers.push(serverA);
  const connectionA = new SupervisorConnection(
    socketA,
    {
      onState: () => {},
      onGoodbye: () => {},
      onClosed: () => {},
      onError: (kind, message) => receivedA.push({ kind, message }),
      log: () => {},
    },
    { hostId: `probe-${process.pid}`, workspace: "D:/dev/dsh-chat#probe" },
  );
  check("窗口连上了（协议握手成功）", await connectionA.open());
  const arrivedA = await waitFor(() => receivedA.length > 0, 5_000);
  check("error 报文到达窗口回调", arrivedA, receivedA.length ? `${receivedA[0].kind}: ${receivedA[0].message}` : "一条都没到");
  check("kind 原样保留（排查时按来源定位）", receivedA[0]?.kind === "shutdown", receivedA[0]?.kind ?? "（无）");
  check(
    "message 原样保留（含原始错误文本）",
    /TypeError: 日志不可写/.test(receivedA[0]?.message ?? ""),
    receivedA[0]?.message ?? "（无）",
  );
  connectionA.close();

  // ============ B：旧扩展不吃这条报文（协议向后兼容） ============
  say("\n【B】旧扩展不认识 `t:\"error\"`：只能忽略，绝不能把连接弄坏…");
  const socketB = `\\\\.\\pipe\\dsh-chat-faultbridge-b-${process.pid}`;
  const statesB: (unknown | null)[] = [];
  const closedB: string[] = [];
  const serverB = await startFakeSupervisor(socketB, (socket) => {
    // 先发一条旧扩展读不懂的消息，再发一条它必须能读懂的
    socket.write(`${JSON.stringify({ t: "some-future-message", payload: { a: 1 } })}\n`);
    socket.write(encodeMessage({ t: "state", state: null, clients: 2 }));
  });
  servers.push(serverB);
  const connectionB = new SupervisorConnection(
    socketB,
    {
      onState: (state) => statesB.push(state),
      onGoodbye: () => {},
      onClosed: (reason) => closedB.push(reason),
      onError: () => {},
      log: () => {},
    },
    { hostId: `probe-${process.pid}`, workspace: "D:/dev/dsh-chat#probe" },
  );
  check("窗口连上了", await connectionB.open());
  const arrivedB = await waitFor(() => statesB.length > 0, 5_000);
  check("读不懂的消息被忽略后，后续的正常消息照样收得到", arrivedB, `states=${statesB.length}`);
  check("连接没有被那条读不懂的消息弄断", connectionB.connected && closedB.length === 0, closedB.join(" / ") || "（没断）");
  connectionB.close();

  say(`\n结论：${failures === 0 ? "全部符合预期（见上）" : `${failures} 条不符合预期`}`);
} catch (error) {
  say(`[probe] 异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  failures++;
} finally {
  for (const server of servers) {
    try {
      server.close();
    } catch {
      // 忽略
    }
  }
  await sleep(200);
  try {
    rmSync(pipeDir, { recursive: true, force: true });
  } catch {
    // 忽略
  }
  process.exit(failures === 0 ? 0 : 1);
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}
