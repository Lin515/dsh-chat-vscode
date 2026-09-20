/**
 * 【探针定位】工具型 · 零模型 token —— 供其它 supervisor 探针 import 的窗口壳
 *   （非 CLI），不发模型消息。
 *
 * supervisor 端到端探针共用的**窗口壳**（原来的 `pinger` 手抄流程已删除）。
 *
 * ## 为什么要换（2026-09-19 收敛）
 *
 * 从前每个探针都 spawn 一个 `build/pinger.mjs` 当"窗口"，而 `scripts/pinger.ts` 把
 * 扩展侧那套流程（读会合文件 → 抢锁/拉起 → 等就绪 → 连 socket → ping）**手抄了一遍**，
 * 于是"分组指纹公式、`usable()`、`startPinger`、握手文件结构"各存在两三份。后果不是啰嗦，
 * 而是**R1/R3/R4/R5 验的是副本**：真正在扩展里跑的是 `SupervisorManager`
 * （`ensure/接入/心跳/restart/stopAndExit/releaseInternal`），副本与它漂移了，
 * 探针照样全绿。现在探针直接构造 `SupervisorManager`——**与扩展逐字同一份代码**。
 *
 * > 只有 R5 的"窗口被**强杀**（来不及跑任何清理代码）"这一格没法用同一个对象表达：
 * > 它由 `killProcess()` 杀真进程来复现，而那本来就是探针才需要的能力。
 *
 * ## 隔离纪律（踩过，别再犯）
 *
 * 会合目录由 `supervisorProbeEnv` 负责（import 它就会把 `DSH_CHAT_SUPERVISOR_DIR`
 * 指到本次探针专用的临时目录）。**调用方必须第一个 import 它**，而且 esbuild 会把
 * "导出没被使用"的副作用模块整份摇掉——所以每个探针都要**用一下** `PROBE_SUPERVISOR_ROOT`
 * 并把它当硬前置条件断言（各探针文件里那一段 `隔离失效` 检查就是干这个的）。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  SupervisorManager,
  groupForConfig,
  type ServerInfo,
  type ServerStatus,
} from "../src/dsh/supervisorManager";
import { createDefaultSupervisorLauncher } from "../src/dsh/supervisorRunner";
import {
  generationOf,
  readState,
  supervisorDirectory,
  type SupervisorState,
} from "../src/dsh/supervisorProtocol";
import { isProcessAlive } from "../src/dsh/processRegistry";

/**
 * 等 `ms` 之后 reject——给"没有时长上限"的等待加一道**探针自己的**上限。
 *
 * 刻意不用 `timers/promises` 的 `delay`：那个定时器会**吊住事件循环**（探针明明已经拿到
 * 结果了也退不出去）。这里 unref 掉，没人等它就自然消失。
 */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
}

/**
 * 一个"窗口"：**就是扩展里那个管理器**（`ensure/接入/心跳/重启/停止` 一条都不少）。
 *
 * 字段都是给**判据**用的：`launched`/`generation` 回答"还是不是同一套"，
 * `directory`/`state()` 让探针能读会合文件（判"后台还在不在"），
 * `disposed` 用来表达"窗口没了"（R1 的强杀那一格用 `killProcess` 另说）。
 */
export class ProbeWindow {
  readonly manager: SupervisorManager;
  /** 分组（缺省按命令算，与扩展的 `groupForConfig` 同构）。 */
  readonly group: string;
  /** 会合目录（本探针的隔离根下）。 */
  readonly directory: string;
  /** 本窗口**拉起**了这一套（`ensure()` 的返回值）。 */
  launched = false;
  /** 最近一次 `ensure()` 拿到的信息（地址/令牌/归属）。 */
  info?: ServerInfo;
  disposed = false;

  constructor(
    options: {
      tag: string;
      command: string;
      url?: string;
      idleSec?: number;
      log?: (line: string) => void;
    },
    private readonly say: (line: string) => void = () => undefined,
  ) {
    this.group = groupForConfig(options.command);
    this.directory = supervisorDirectory(this.group);
    const log = (line: string) => {
      this.say(`   [${options.tag}] ${line}`);
      options.log?.(line);
    };
    this.manager = new SupervisorManager({
      group: this.group,
      url: options.url ?? "",
      command: options.command,
      idleSec: options.idleSec,
      workspace: `D:/dev/dsh-chat#${options.tag}`,
      // 真实启动器（与扩展同一条路：VS Code 自带运行时跑 `dist/supervisor.js`）
      launcher: createDefaultSupervisorLauncher({ log }),
      log,
    });
  }

  /**
   * 拉起或接入，等到真的就绪。
   *
   * **管理器那边的等待没有时长上限**（用户 2026-09-14 口径），但探针不能跟着无限等：
   * 超时就抛（与从前 `startPinger` 的 150s 上限同一个作用——探针要能自己红，而不是挂死）。
   */
  async ensure(options: { start?: boolean; timeoutMs?: number } = {}): Promise<ServerInfo> {
    const timeoutMs = options.timeoutMs ?? 150_000;
    const pending = this.manager.ensure({ start: options.start ?? true });
    // 超时之后那一轮可能才失败/成功：那个 rejection 必须有人接住，否则 Node 会以
    // unhandledRejection 结束整个探针（而真正的原因已经被上面的超时错误报了）。
    pending.catch(() => undefined);
    const info = await Promise.race([pending, rejectAfter(timeoutMs, `窗口 ${this.group} 未能在 ${timeoutMs}ms 内就绪`)]);
    this.info = info;
    this.launched = info.ownership === "self";
    return info;
  }

  /** 会合文件里**现读**的那一份（判据用；不读管理器记忆）。 */
  state(): SupervisorState | undefined {
    return readState(this.directory);
  }

  /** 本窗口当前这套的世代（`pid@时刻`）；没有时 undefined。 */
  get generation(): string | undefined {
    const state = this.state();
    return state ? generationOf(state) : undefined;
  }

  status(): ServerStatus {
    return this.manager.getStatus();
  }

  get baseUrl(): string | undefined {
    return this.info?.baseUrl;
  }

  /** 端口（判"后台还在不在服务"用）。 */
  get port(): number | undefined {
    const url = this.info?.baseUrl;
    if (!url) return undefined;
    const port = Number(new URL(url).port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  }

  /**
   * 关窗（= 扩展的 `dispose()`）：**只关自己的连接，不杀任何进程**。
   *
   * 这就是"窗口关闭/重载"的正确行为，也是 R1 的判据来源：它之后 dsh 必须照旧服务。
   * 幂等。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.manager.dispose();
  }

  /** 请守护进程连 dsh 一起收场（「停止内部 DSH」那条路）。 */
  async stopAndExit(): Promise<boolean> {
    const sent = await this.manager.stopAndExit();
    this.disposed = true;
    return sent;
  }
}

/**
 * 等一个条件成立（轮询）；返回是否在超时内成立。
 *
 * 判据一律是**事实**（端口在不在听、进程还在不在、会合文件在不在），不看日志。
 */
export async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  onTick?: (elapsed: number) => void,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return true;
    onTick?.(Date.now() - started);
    await delay(400);
  }
  return false;
}

/** 端口上还有没有监听者（事实判据，不看进程表）。 */
export async function portListening(port: number): Promise<boolean> {
  const net = spawn("netstat", ["-ano", "-p", "TCP"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let out = "";
  net.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
  await new Promise((resolve) => net.on("close", resolve));
  return out.split(/\r?\n/).some((line) => /LISTENING/i.test(line) && line.includes(`:${port} `));
}

/**
 * 强杀一个进程（**不加 `/T`**：要的就是"这个进程没了、它的子进程留下"）。
 *
 * 只有探针需要它：R1 要复现"窗口被强杀、来不及跑任何清理代码"，
 * R5 要复现"守护进程被强杀、它拉起的 dsh 成了孤儿"。
 */
export function killProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
}

/** 连子孙一起杀（收尾用）。 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

/**
 * 收尾：把本探针起过的一切带走（**绝不留给用户机器**）。
 *
 * 三步，顺序不能反：
 * 1. 手里还活着的窗口里挑一个，让它请守护进程收场（`stopAndExit()`：守护进程自己杀 dsh、
 *    清会合文件、退出）——没有活窗口时跳过（R3 那种"窗口早关了"的探针只能走第 3 步）；
 * 2. 等会合文件消失（= 守护进程真的收场了）；
 * 3. 还有残留（守护进程被强杀过、或等了超时）就按 `directory` 或各窗口目录里的 pid 强杀
 *    ——留一条"按会合文件兜底"的路是必须的，否则探针一旦中途抛错就会给用户机器留下后台。
 */
export async function stopAllProbeProcesses(options: {
  windows?: ProbeWindow[];
  /** 会合目录（没有活窗口时也得知道去哪儿看残留）。 */
  directory?: string;
  /** 假 dsh 这类"守护进程不一定知道"的进程（可选）。 */
  extraPids?: (number | undefined)[];
  waitMs?: number;
}): Promise<void> {
  const windows = options.windows ?? [];
  const stopper = windows.find((window) => !window.disposed);
  for (const window of windows) {
    if (window !== stopper) window.dispose();
  }
  if (stopper) {
    await stopper.stopAndExit().catch(() => false);
    await waitUntil("守护进程收场", () => readState(stopper.directory) === undefined, options.waitMs ?? 20_000);
  }
  const directories = new Set<string>();
  if (options.directory) directories.add(options.directory);
  for (const window of windows) directories.add(window.directory);
  for (const directory of directories) {
    const state = readState(directory);
    if (!state) continue;
    killTree(state.serverPid);
    killTree(state.supervisorPid);
  }
  for (const pid of options.extraPids ?? []) killTree(pid);
  await delay(300);
}

/** `pid` 还活着吗（转调 `processRegistry`，探针判据统一走这里）。 */
export function alive(pid: number | undefined): boolean {
  return pid !== undefined && isProcessAlive(pid);
}
