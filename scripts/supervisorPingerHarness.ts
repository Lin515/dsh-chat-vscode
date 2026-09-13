/**
 * pinger 探针共用的小工具：起/停"窗口"、读会合状态、杀进程树。
 *
 * 单独成文件是因为 Race / Crash / Share / Stop 四个探针用的是同一套动作；
 * 各写一份迟早漂移（本仓库已经吃过"两处算法漂移"的亏）。
 * 会合目录的隔离由 `supervisorProbeEnv` 负责——调用方必须**先 import 它**。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface PingerInfo {
  ready?: boolean;
  baseUrl?: string;
  supervisorPid?: number;
  serverPid?: number;
  generation?: string;
  windowPid?: number;
  launched?: boolean;
}

export interface StartedPinger {
  child: ChildProcess;
  info: PingerInfo;
}

/** 起一个"窗口"（`build/pinger.mjs`）并等它写出手握文件。 */
export async function startPinger(tag: string, command: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<StartedPinger> {
  const handshake = join(tmpdir(), `dsh-chat-pinger-${tag}-${process.pid}.json`);
  rmSync(handshake, { force: true });
  const child = spawn(process.execPath, [join(process.cwd(), "build", "pinger.mjs"), handshake, `${handshake}.log`, "--command", command], {
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  });
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const parsed = JSON.parse(readFileSync(handshake, "utf8")) as PingerInfo;
      if (parsed.ready) return { child, info: parsed };
    } catch {
      // 还没写出来
    }
    await delay(200);
  }
  throw new Error(`窗口 ${tag} 未能在超时内就绪（exitCode=${child.exitCode}）`);
}

/** 优雅关窗（关掉 stdin → pinger 只关自己的连接）。 */
export async function closePinger(pinger: StartedPinger, waitMs = 30_000): Promise<void> {
  pinger.child.stdin?.end();
  await Promise.race([new Promise((resolve) => pinger.child.on("close", resolve)), delay(waitMs)]);
}

/** 强杀一个窗口（**不加 /T**：要的是"窗口没了、后台还在"）。 */
export function killPinger(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

/** 连子孙一起杀（收尾用）。 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/** 端口上还有没有监听者（事实判据，不看进程表）。 */
export async function portListening(port: number): Promise<boolean> {
  const net = spawn("netstat", ["-ano", "-p", "TCP"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  net.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => net.on("close", resolve));
  return out.split(/\r?\n/).some((line) => /LISTENING/i.test(line) && line.includes(`:${port} `));
}

/** 等一个条件成立（轮询）；返回是否在超时内成立。 */
export async function waitUntil(label: string, predicate: () => Promise<boolean>, timeoutMs: number, onTick?: (elapsed: number) => void): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    onTick?.(Date.now() - started);
    await delay(400);
  }
  return false;
}
