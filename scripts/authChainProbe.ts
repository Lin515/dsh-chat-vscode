/**
 * 端到端探针：**扩展侧认证链**——"拿到会合信息之后，真的能连上 dsh 吗"。
 *
 * 为什么必须单独一条（2026-09-14 新增）：现有的四个 supervisor 探针全部停在
 * **socket 协议层**（pinger 连上 supervisor、ping、读状态），而扩展真正连的是
 * **dsh 的 HTTP/WS**：`controller` 拿 `ServerInfo.token` → `DshClient.authenticate()`
 * （`GET /?token=…` 换签名 cookie）→ `listSessions()`。这一段此前**一个断言都没有**，
 * 于是"窗口起来了、地址也有了、却连不上/要令牌"这类缺陷在探针里完全不可见。
 *
 * 覆盖：窗口 A（启动者 self）与窗口 B（接入者 peer）**各走一遍真实认证链**，
 * 并且都以**会合文件里的那份 token** 为凭据（这正是"token 落文件、多窗口复用"的口径）。
 *
 * 用法：node build/auth-chain-probe.mjs [日志文件]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：会合目录指到本次探针专用目录（见 supervisorProbeEnv 的说明）
import { PROBE_SUPERVISOR_ROOT } from "./supervisorProbeEnv";
import { SupervisorManager } from "../src/dsh/supervisorManager";
import { createDefaultSupervisorLauncher } from "../src/dsh/supervisorRunner";
import { readState, supervisorDirectory } from "../src/dsh/supervisorProtocol";
import { DshClient } from "../src/dsh/client";

const LOG = process.argv[2] ?? ".tmp/auth-chain.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

if (!PROBE_SUPERVISOR_ROOT || !/dsh-chat-sup-probe-/.test(PROBE_SUPERVISOR_ROOT)) {
  process.stderr.write(`[probe] 隔离失效：会合根目录=${PROBE_SUPERVISOR_ROOT}\n`);
  process.exit(2);
}

const COMMAND = "dsh web --port 0 --no-open";
const GROUP = "auth-chain-probe";

function makeWindow(tag: string): SupervisorManager {
  return new SupervisorManager({
    group: GROUP,
    url: "",
    command: COMMAND,
    startTimeoutMs: 120_000,
    idleSec: 5,
    workspace: `D:/dev/dsh-chat#${tag}`,
    launcher: createDefaultSupervisorLauncher({ log: (line) => say(`   [${tag}] ${line}`) }),
    log: (line) => say(`   [${tag}] ${line}`),
  });
}

/**
 * 扩展里 `controller.openOwnedClient()` 的逐字复刻（它只做这两件事）。
 *
 * 返回错误文本而不是抛：探针要区分"认证被拒"与"认证之后的第一次业务请求失败"。
 */
async function authenticateLikeHost(baseUrl: string, token: string | undefined): Promise<string | undefined> {
  const client = new DshClient(baseUrl, token, (line) => say(`      [client] ${line}`));
  try {
    await client.authenticate();
    if (!client.sessionCookie) return "authenticate() 之后没有拿到会话 cookie";
    const sessions = await client.listSessions();
    return Array.isArray(sessions?.items) ? undefined : "listSessions() 返回了非预期形状";
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    client.dispose();
  }
}

let windowA: SupervisorManager | undefined;
let windowB: SupervisorManager | undefined;

try {
  say(`会合根目录（隔离）：${PROBE_SUPERVISOR_ROOT}`);
  say(`会合目录：${supervisorDirectory(GROUP)}`);

  say("\n1) 窗口 A：ensure() 起一套后台（真实 dsh web）…");
  windowA = makeWindow("A");
  const infoA = await windowA.ensure();
  check("拿到地址与令牌", Boolean(infoA.baseUrl && infoA.token), `${infoA.baseUrl} ownership=${infoA.ownership}`);
  check("A 是启动者（ownership=self）", infoA.ownership === "self", infoA.ownership);

  say("\n2) 用会合文件里的 token 走真实认证链（= controller.openOwnedClient）…");
  const stateA = readState(supervisorDirectory(GROUP));
  check("会合文件里 token 有值（供多窗口复用）", Boolean(stateA?.token), stateA?.token ? "有" : "无");
  const errorA = await authenticateLikeHost(infoA.baseUrl, infoA.token);
  check("启动者窗口认证通过", errorA === undefined, errorA ?? "GET /?token=… 换 cookie，再 listSessions");

  say("\n3) 窗口 B（同分组）：接入同一套…");
  windowB = makeWindow("B");
  const infoB = await windowB.ensure();
  check("B 拿到同一个地址", infoB.baseUrl === infoA.baseUrl, `${infoA.baseUrl} vs ${infoB.baseUrl}`);
  check("B 是接入者（ownership=peer）", infoB.ownership === "peer", infoB.ownership);
  check("B 也拿到了令牌", Boolean(infoB.token), infoB.token ? "有" : "无");

  say("\n4) 接入者窗口同样走一遍认证链（peer 也应当能用文件里的 token）…");
  const errorB = await authenticateLikeHost(infoB.baseUrl, infoB.token);
  check("接入者窗口认证通过", errorB === undefined, errorB ?? "token 来自会合文件");

  say("\n5) 收尾：让 supervisor 把 dsh 一起带走…");
  await windowB.stopAndExit();
  const cleaned = await (async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (readState(supervisorDirectory(GROUP)) === undefined) return true;
      await delay(400);
    }
    return false;
  })();
  check("会合文件已清掉", cleaned);
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  await windowB?.stopAndExit().catch(() => undefined);
  windowA?.dispose();
  windowB?.dispose();
  const state = readState(supervisorDirectory(GROUP));
  if (state) {
    const { spawn } = await import("node:child_process");
    spawn("taskkill", ["/pid", String(state.supervisorPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
  say(failures === 0 ? "\n✓ 扩展侧认证链（启动者 / 接入者）全通" : `\n✗ ${failures} 项未通过`);
  process.exitCode = failures === 0 ? 0 : 1;
}
