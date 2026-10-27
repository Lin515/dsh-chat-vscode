/**
 * 离线断言：**控制帧必须在对端读到之后才断开**。
 *
 * 这一条钉的是一个真实故障（用户 2026-10-27 报的「停止内部 DSH 之后守护进程还在，
 * 新窗口又自动连到内部 DSH」）：`SupervisorConnection.open()` 先写一条 hello，
 * `control("stop")` 再写一条控制帧，紧接着 `close()` 里 `socket.end()` 之后立刻
 * `socket.destroy()`——排队中的第二条 write 被丢掉，stop 永远到不了守护进程。
 *
 * 探针最小复现（命名管道，500 次）：只写一条时 500/500 到达；先 hello 再 stop 时
 * 500/500 只到达 hello。所以这里不依赖真 supervisor / 真 dsh，只用一个读数据的
 * 迷你服务端 + 真的 `SupervisorConnection`。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）。
 */
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SupervisorConnection } from "../src/dsh/supervisorClient";
import { decodeClientMessage } from "../src/dsh/supervisorWire";

const windows = process.platform === "win32";
const socketDir = windows ? undefined : mkdtempSync(join(tmpdir(), "dsh-chat-close-"));
const socketPath = windows
  ? `\\\\.\\pipe\\dsh-chat-close-${process.pid}-${Date.now()}`
  : join(socketDir as string, "sup.sock");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 每一条连接各自的完整行（服务端只读，不回应：要验的只是"写出去的东西到没到"）。 */
const received: string[][] = [];
const server = createServer((socket) => {
  const lines: string[] = [];
  received.push(lines);
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      lines.push(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
});

try {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  const closed: string[] = [];
  const connection = new SupervisorConnection(
    socketPath,
    {
      onState: () => undefined,
      onGoodbye: () => undefined,
      onClosed: (reason) => closed.push(reason),
      log: () => undefined,
    },
    { hostId: `test-${process.pid}`, workspace: "test#close" },
  );

  check("连上迷你服务端", await connection.open());

  // 与「停止内部 DSH」同一条路径：先写 hello（open 已经写了），再发 stop，然后断开
  connection.control("stop");
  connection.close();
  check("本窗口侧立刻认为自己不再连着（`connected === false`）", !connection.connected);

  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && !received.some((lines) => lines.some((line) => isStop(line)))) {
    await delay(20);
  }

  const all = received.flat();
  const stop = all.filter((line) => isStop(line));
  check("对端读到了 stop 控制帧", stop.length === 1, `收到 ${stop.length} 条；全部=${JSON.stringify(all)}`);
  if (stop.length === 1) {
    const decoded = decodeClientMessage(stop[0] as string);
    check(
      "stop 帧解码后仍是 control/stop（没有被截断成半行）",
      decoded?.t === "control" && decoded.action === "stop",
      JSON.stringify(decoded),
    );
  }
  check("主动关闭不触发 onClosed（那是给意外断线用的）", closed.length === 0, closed.join(" / "));
} finally {
  server.close();
  if (socketDir) {
    try {
      rmSync(socketDir, { recursive: true, force: true });
    } catch {
      // 忽略
    }
  }
}

if (failures > 0) {
  console.error(`\n✗ 控制帧与断开：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log("\n✓ 控制帧先刷出去、再断开（stop 不会丢）");
  assert.ok(true);
}

function isStop(line: string): boolean {
  const message = decodeClientMessage(line);
  return message?.t === "control" && message.action === "stop";
}
