/**
 * **无头 pinger**：在探针里扮演一个"VS Code 窗口"（设计 §6.2）。
 *
 * 它走的就是扩展侧那条流程（读会合文件 → 没有就拉起 supervisor → 连 socket → 每 1s ping），
 * 所以**不必启动 VS Code** 就能验证"重载窗口后台不断""没人用就自退场"这类核心需求。
 *
 * 用法：
 *   node build/pinger.mjs <handshake 文件> <日志文件> [--command <启动命令>] [--idle-sec <秒>] [--exit-after <毫秒>]
 *
 * 握手文件（每次状态变化重写）：
 *   { "ready": true, "baseUrl": "http://127.0.0.1:1234", "supervisorPid": 111, "serverPid": 222,
 *     "generation": "111@1700…", "windowPid": 333, "launched": false }
 *
 * **不变量**：退出时只关自己的连接，**绝不杀任何进程**（杀 dsh 永远是 supervisor 的事）。
 */
import { appendFileSync, writeFileSync } from "node:fs";
// 必须排在最前面：把会合根目录指到本次探针专用的临时目录（模块求值期读一次）
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import {
  IDLE_SEC_DEFAULT,
  generationOf,
  readState,
  supervisorDirectory,
  type SupervisorState,
} from "../src/dsh/supervisorProtocol";
import { SupervisorConnection, ensureSupervisor, waitForReadyState } from "../src/dsh/supervisorClient";
import { createDefaultSupervisorLauncher } from "../src/dsh/supervisorRunner";
import { isProcessAlive, tcpReachableSync } from "../src/dsh/processRegistry";

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
// `--idle-sec` 优先；其次 `DSH_CHAT_IDLE_SEC`（探针用：把阈值压到下限，十几秒就能验完自退场）；
// 都没有就用协议默认值（10s）——与扩展里 `dshChat.supervisorIdleSec` 的默认一致。
const idleSec = Number(value("--idle-sec") ?? process.env.DSH_CHAT_IDLE_SEC ?? IDLE_SEC_DEFAULT);
const exitAfter = Number(value("--exit-after") ?? 0);
const workspace = value("--workspace") ?? "D:/dev/dsh-chat#pinger";

const say = (line: string): void => {
  if (logFile) appendFileSync(logFile, `${line}\n`, "utf8");
};
process.on("uncaughtException", (error) => {
  say(`[pinger] 未捕获异常：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
  process.exit(1);
});

/** 与扩展同构：有效配置 → 分组（这里只按命令算，等价于扩展里 url 为空的那支）。 */
const group = require("node:crypto")
  .createHash("sha256")
  .update(`internal:${command}`)
  .digest("hex")
  .slice(0, 12);

const directory = supervisorDirectory(group);
const launcher = createDefaultSupervisorLauncher({
  // 探针不启动 VS Code：用当前运行时（等价于扩展里"用 VS Code 自带的 Node"）。
  // 脚本路径也不用给：`findSupervisorScript` 会按"本模块所在目录的 ../dist"找到它。
  appRoot: process.env.VSCODE_APP_ROOT,
  log: say,
});

/** 会合文件里那一套还可用吗：supervisor 进程在 + 地址能连（就绪后）。 */
async function usable(state: SupervisorState): Promise<boolean> {
  if (!isProcessAlive(state.supervisorPid)) return false;
  if (!state.baseUrl) return state.starting; // 正在启动：算"可用"，交给 waitForReadyState 等
  return tcpReachableSync(state.baseUrl, 1_500);
}

say(`[pinger] 分组=${group} 会合目录=${directory} 命令=${command}`);

const ensured = await ensureSupervisor({ group, command, idleSec, launcher, log: say, usable });
if (ensured.error) {
  say(`[pinger] 启动 supervisor 失败：${ensured.error}`);
  process.exit(3);
}
const state = ensured.state?.baseUrl && (await usable(ensured.state))
  ? ensured.state
  : await waitForReadyState({ group, timeoutMs: 120_000, usable, onTick: (tick) => say(`[pinger] 等待就绪：${tick?.baseUrl ?? (tick?.starting ? "启动中" : "无会合文件")}`) });
if (!state?.baseUrl) {
  say("[pinger] 等不到就绪的后台");
  process.exit(4);
}

const connection = new SupervisorConnection(
  state.socket,
  {
    onState: (next) => say(`[pinger] 状态推送：${next?.baseUrl ?? "（无）"}`),
    onGoodbye: (reason) => say(`[pinger] 收到告别：${reason}`),
    onClosed: (reason) => say(`[pinger] 连接断开：${reason}`),
    log: say,
  },
  { hostId: `pinger-${process.pid}`, workspace },
);
const connected = await connection.open();
if (!connected) {
  say("[pinger] 连不上 supervisor 的 socket");
  process.exit(5);
}

const info = { ...state, generation: generationOf(state) };
writeFileSync(
  handshake,
  JSON.stringify({
    ready: true,
    baseUrl: state.baseUrl,
    supervisorPid: state.supervisorPid,
    serverPid: state.serverPid,
    generation: info.generation,
    windowPid: process.pid,
    launched: ensured.launched,
  }),
  "utf8",
);
say(`[pinger] 就绪 ${state.baseUrl}（supervisor=${state.supervisorPid} server=${state.serverPid} 本窗口=${process.pid} 启动者=${ensured.launched}）`);

/** 退出：只关自己的连接（**不杀任何进程**）。 */
function exitCleanly(code: number): void {
  say("[pinger] 退出：只关闭自己的连接");
  connection.close();
  process.exit(code);
}

process.stdin.resume();
process.stdin.on("end", () => exitCleanly(0));
process.on("SIGTERM", () => exitCleanly(0));
process.on("SIGINT", () => exitCleanly(0));
if (exitAfter > 0) setTimeout(() => exitCleanly(0), exitAfter);
