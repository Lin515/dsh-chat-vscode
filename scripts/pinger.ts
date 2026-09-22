/**
 * 【探针定位】工具型 · 零模型 token —— 手工排查窗口（占住后台用），不发模型消息，
 *   可自由运行。
 *
 * **手工排查用的"窗口"**：在探针里扮演一个 VS Code 窗口。
 *
 * ## 它现在是什么（2026-09-19 收敛后）
 *
 * 从前这里把扩展侧那套流程（读会合文件 → 抢锁/拉起 → 等就绪 → 连 socket → ping）
 * **手抄了一遍**，于是与 `SupervisorManager` 成了两份实现，R1/R3/R4/R5 那几个探针验的
 * 是**副本**。现在本文件只剩一个**薄壳**：真正的那条路全在 `SupervisorManager` 里
 * （与扩展逐字同一份代码，见 `scripts/supervisorPingerHarness.ts` 的 `ProbeWindow`）。
 * 四个探针也改成直接构造管理器，不再经过这个 CLI；这里保留它只为**手工排查**
 * （想拿一个会占住后台的"窗口"时，一条命令就够）。
 *
 * 用法：
 *   node build/pinger.mjs <handshake 文件> <日志文件> [--command <启动命令>] [--idle-sec <秒>] [--exit-after <毫秒>]
 *
 * 握手文件（就绪后写一次）：
 *   { "ready": true, "baseUrl": "http://127.0.0.1:1234", "supervisorPid": 111, "serverPid": 222,
 *     "generation": "111@1700…", "windowPid": 333, "launched": false }
 *
 * **不变量**：退出时只关自己的连接，**绝不杀任何进程**（杀 dsh 永远是 supervisor 的事）。
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：把会合根目录指到本次专用的临时目录（模块求值期读一次）
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { IDLE_SEC_DEFAULT } from "../src/dsh/supervisorProtocol";
import { ProbeWindow } from "./supervisorPingerHarness";

const handshake = process.argv[2];
const logFile = process.argv[3];
if (!handshake) {
  console.error("usage: node pinger.mjs <handshake> <log> [--command <cmd>] [--idle-sec <n>] [--exit-after <ms>]");
  process.exit(2);
}
const value = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const command = value("--command") ?? "dsh web --port 0 --no-open";
// `--idle-sec` 优先；其次 `DSH_CHAT_IDLE_SEC`（把阈值压到下限，十几秒就能验完自退场）；
// 都没有就用协议默认值（10s）——与扩展里 `dshChat.supervisorIdleSec` 的默认一致。
const idleSec = Number(value("--idle-sec") ?? process.env.DSH_CHAT_IDLE_SEC ?? IDLE_SEC_DEFAULT);
const exitAfter = Number(value("--exit-after") ?? 0);

const say = (line: string): void => {
  if (logFile) appendFileSync(logFile, `${line}\n`, "utf8");
};
process.on("uncaughtException", (error) => {
  say(`[pinger] 未捕获异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exit(1);
});

// 隔离自检：`supervisorProbeEnv` 的副作用必须真的生效（esbuild 会摇掉没用到的副作用模块）
if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  say(`[pinger] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}`);
  process.exit(2);
}

const window = new ProbeWindow({ tag: "pinger", command, idleSec }, say);
say(`[pinger] 分组=${window.group} 会合目录=${window.directory} 命令=${command}`);

try {
  const info = await window.ensure({ start: true });
  const state = window.state();
  writeFileSync(
    handshake,
    JSON.stringify({
      ready: true,
      baseUrl: info.baseUrl,
      supervisorPid: state?.supervisorPid,
      serverPid: state?.serverPid,
      generation: window.generation,
      windowPid: process.pid,
      launched: window.launched,
    }),
    "utf8",
  );
  say(
    `[pinger] 就绪 ${info.baseUrl}（supervisor=${state?.supervisorPid} server=${state?.serverPid} 本窗口=${process.pid} 启动者=${window.launched}）`,
  );
} catch (error) {
  say(`[pinger] 起不来：${error instanceof Error ? error.message : String(error)}`);
  process.exit(3);
}

/** 退出：只关自己的连接（**不杀任何进程**）。 */
function exitCleanly(code: number): void {
  say("[pinger] 退出：只关闭自己的连接");
  window.dispose();
  process.exit(code);
}

process.stdin.resume();
process.stdin.on("end", () => exitCleanly(0));
process.on("SIGTERM", () => exitCleanly(0));
process.on("SIGINT", () => exitCleanly(0));
if (exitAfter > 0) setTimeout(() => exitCleanly(0), exitAfter);
