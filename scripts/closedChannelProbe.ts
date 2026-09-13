/**
 * 端到端探针：**关窗那一刻输出通道已经被关闭时，后台仍然必须被带走**。
 *
 * 为什么单独一条（用户 2026-09-13 报的缺陷）：`gracefulCloseProbe` 是绿的，但它模拟的
 * 窗口把日志写进文件（永不抛异常），而真实 VS Code 在扩展停用**之前**就关掉了输出通道
 * （实测 exthost.log：`terminate message from renderer` 后 20ms 就是
 * `Error: Channel has been closed`，栈顶落在 `ServerManager.release()`）。
 * `release()` 的第一条语句正是写日志——那句一抛，下面 `killOwnedServer` 就执行不到，
 * 后台被留在磁盘上；租约里的端口一直被它占着，用户配置了固定端口时下次启动
 * 就是 `EADDRINUSE`（用户看到的「无法连接 dsh 服务」）。
 *
 * 场景（每一步都起真实 dsh、用真实租约目录的隔离副本）：
 *   1) 窗口 A（日志写入**必定抛异常**）起后台 → 优雅关窗；
 *   2) 关窗后端口必须关闭、租约必须被清掉；
 *   3) 再起窗口 B（日志正常）→ 若 A 留下孤儿，这里必须判定为失败：
 *      **B 必须拿到一个能连上的后台**，且磁盘上不能同时挂着两份租约。
 *
 * 输出写文件、子进程 `stdio: "ignore"`（起真实 dsh，不能拖住调用方管道，见设计文档 §8）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：租约目录指到本次探针专用的临时目录（见 sharedServerProbeEnv）
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { leaseDirectory, readLeases } from "../src/dsh/processRegistry";

const LOG = process.argv[2] ?? ".tmp/closed-channel.log";
writeFileSync(LOG, "", "utf8");
const say = (line: string) => appendFileSync(LOG, `${line}\n`, "utf8");

/**
 * `--control`：**对照模式（红）**——把 0.6.0 那条"日志直接抛出去"的老行为注入回窗口的
 * 日志链路（见 `crashWindow.ts`），断言它确实会在关窗时挂掉。
 *
 * 为什么要有对照：修复之后探针变绿是必然的，问题在"绿"有没有判别力。
 * 对照证明**本探针抓得住这个缺陷**（AGENTS.md：断言只钉确定的事实，
 * 而"绿的探针"要先能红过一次）。
 */
const CONTROL = process.argv.includes("--control");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  say(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

interface Handshake {
  baseUrl: string;
  serverPid?: number;
  ownership?: string;
  windowPid?: number;
  ready?: boolean;
}

const scriptDir = process.cwd();
const handshakeFile = join(tmpdir(), `dsh-chat-closed-channel-${process.pid}.json`);

async function serving(url: string): Promise<boolean> {
  try {
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1_200) });
    return true;
  } catch {
    return false;
  }
}

/** 端口关闭（= 后台真的没了）的等待；返回一句人读的结论。 */
async function waitGone(url: string, timeoutMs: number): Promise<string | undefined> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await serving(url))) return `端口已关闭（${Date.now() - started}ms）`;
    await delay(400);
  }
  return undefined;
}

/** 起一个"窗口"进程并等它写出握手文件。 */
async function startWindow(tag: string, logFile: string): Promise<{ child: ChildProcess; info: Handshake }> {
  rmSync(handshakeFile, { force: true });
  const child = spawn(
    process.execPath,
    [join(scriptDir, "build", "crash-window.mjs"), handshakeFile, logFile],
    {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      // `DSH_CHAT_PROBE_RAW_LOG=1` 让窗口把日志直接抛出去（对照模式用的老行为）
      env: { ...process.env, DSH_CHAT_LEASE_DIR: PROBE_LEASE_DIR, DSH_CHAT_PROBE_RAW_LOG: CONTROL ? "1" : "" },
    },
  );
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const parsed = JSON.parse(readFileSync(handshakeFile, "utf8")) as Handshake;
      if (parsed.ready) return { child, info: parsed };
    } catch {
      // 还没写出来
    }
    await delay(300);
  }
  throw new Error(`窗口 ${tag} 未能在超时内就绪（exitCode=${child.exitCode}）`);
}

/** 优雅关窗：关掉 stdin → 子进程走 dispose（等价于 VS Code 的 deactivate）。返回退出码。 */
async function closeWindow(child: ChildProcess): Promise<number | null> {
  child.stdin?.end();
  await Promise.race([
    new Promise((resolve) => child.on("close", resolve)),
    delay(45_000).then(() => say("   （等子进程退出超时，继续）")),
  ]);
  return child.exitCode;
}

/**
 * 在**就绪之后**把窗口的输出通道"关掉"（经 stdin 发 `closed`，等它回执）。
 *
 * 顺序就是真实顺序：VS Code 先关输出通道，扩展随后才停用。等回执是必须的——
 * 注入没生效的话，后面的"通过"就是假的（AGENTS.md 里那条纪律）。
 */
async function closeChannel(child: ChildProcess): Promise<boolean> {
  if (!child.stdin) return false;
  child.stdin.write("closed\n");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(readFileSync(handshakeFile, "utf8")) as Handshake & { channelClosed?: boolean };
      if (parsed.channelClosed) return true;
    } catch {
      // 还没写出来
    }
    await delay(150);
  }
  return false;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

let window: ChildProcess | undefined;
let urlA: string | undefined;

try {
  say(`租约目录（隔离）：${leaseDirectory()}`);
  say(
    CONTROL
      ? "模式：**对照（红）** —— 把 0.6.0 那条「日志直接抛出去」的老行为注入回链路，证明本探针抓得住缺陷；\n" +
          "      判据是「关窗后端口仍在服务」+「异常一路抛给了宿主」。"
      : "模式：修复后 —— 窗口的日志链路就是扩展里那条（createHostLog 包着输出通道）。",
  );

  say("\n1) 窗口 A 起后台（日志暂正常，与真实一致）…");
  const a = await startWindow("A", join(PROBE_LEASE_DIR, "closed-a.log"));
  window = a.child;
  urlA = a.info.baseUrl;
  check("A 就绪", Boolean(urlA), urlA);

  say("\n1b) 关掉 A 的输出通道（此后日志写不出去，与 VS Code 关窗那一刻一致）…");
  check("注入生效：A 已回执 channelClosed", await closeChannel(a.child));

  say("\n2) 优雅关窗 A → **即便日志写不出去，后台也必须被带走**…");
  const codeA = await closeWindow(a.child);
  window = undefined;
  check(
    CONTROL ? "（对照）老行为把异常一路抛给了宿主（非 0 退出）" : "A 干净退出（dispose 不把异常抛给宿主）",
    CONTROL ? codeA !== 0 : codeA === 0,
    `exitCode=${codeA}`,
  );

  const goneA = await waitGone(urlA, 45_000);
  if (!CONTROL) {
    check("关窗后后台停止（日志写不出去不得掐断 kill）", goneA !== undefined, goneA ?? "等了 45s 仍在服务");
    check("租约被清掉", readLeases().length === 0, `剩余=${readLeases().length}`);

    say("\n3) 再起窗口 B（日志正常）→ 必须能连上，且不该再挂着第二份租约…");
    const b = await startWindow("B", join(PROBE_LEASE_DIR, "closed-b.log"));
    window = b.child;
    check("B 就绪", Boolean(b.info.baseUrl), b.info.baseUrl);
    check("B 的后台在服务（能连上 = 用户不会再看到「无法连接」）", await serving(b.info.baseUrl));
    check(
      "磁盘上只有一份租约（A 没有留下占着端口的孤儿）",
      readLeases().length === 1,
      `租约=${JSON.stringify(readLeases().map((item) => ({ pid: item.lease.serverPid, url: item.lease.baseUrl })))}`,
    );

    say("\n4) 关窗 B 收尾…");
    const codeB = await closeWindow(b.child);
    window = undefined;
    check("B 干净退出", codeB === 0, `exitCode=${codeB}`);
    const goneB = await waitGone(b.info.baseUrl, 60_000);
    check("关窗后后台停止", goneB !== undefined, goneB ?? "等了 60s 仍在服务");
  } else {
    // 对照的判据：老行为下清理根本没发起 —— 端口必须**还在服务**（这就是用户看到的孤儿）。
    check(
      "（对照）老行为确实漏掉了清理：端口仍在服务",
      goneA === undefined,
      goneA === undefined ? "仍在服务（缺陷现场）" : `意外：${goneA}`,
    );
  }
} catch (error) {
  failures++;
  say(`探针失败：${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}`);
} finally {
  killTree(window?.pid);
  window = undefined;
  await delay(500);
  if (urlA && (await serving(urlA))) {
    for (const { lease } of readLeases()) killTree(lease.serverPid);
    await waitGone(urlA, 30_000);
  }
  say(
    failures === 0
      ? CONTROL
        ? "\n✓ 对照成立：老行为确实会被关掉的通道打死（本探针有判别力）"
        : "\n✓ 输出通道已关闭也拦不住关窗清理"
      : `\n✗ ${failures} 项未通过`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}
