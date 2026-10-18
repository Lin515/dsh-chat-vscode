/**
 * **进程表与监听端口的查询**（异步，只读）。
 *
 * 这个模块从 `dshLocks.ts` 里搬出来，因为它的用途从一件变成了两件：
 *
 * 1. 「残留 writer 锁的持有者到底是不是 dsh」——pid 会被回收，只看"进程在不在"会把
 *    已死的持有者当成活的，所以必须按命令行验身份；
 * 2. 「桌面端内置的那个 DSH 在哪儿」——认人同样要命令行，找口要该 pid 的监听地址
 *    （见 `desktopSession.ts` 与 `desktopAttach.ts`）。
 *
 * 两条用途都要**批量**取命令行：Windows 上只能起 PowerShell 查 CIM，而代价几乎全在解释器
 * 启动上——实测单查一个 pid 约 1600ms，一次查全部进程约 1800ms。逐个查会让 N 个持有者
 * 耗时 N×1600ms。**非 Windows 用 `ps`**（同样是"一次拿全部"）。
 *
 * 三条纪律：
 * - **一律异步**（`spawn`，不是 `spawnSync`）：这些查询会起解释器，阻塞扩展宿主比慢几百毫秒糟得多；
 * - **拿不到就返回 undefined**，绝不抛：调用方的判据都是"有肯定证据才动手"（不删锁、不认领端口）；
 * - 只读进程表与 socket，**不做任何进程操作**（不杀、不改）。
 */
import { spawn } from "node:child_process";
import type { ListenRow } from "./desktopSession";

/** 一次外部查询的产物（拿不到时为 undefined）。 */
interface CaptureOutcome {
  code: number | undefined;
  stdout: string;
  errorCode: string | undefined;
}

/**
 * 取「所有进程的命令行」快照（pid → 命令行）。拿不到返回 undefined。
 *
 * Windows 走 CIM（`Get-CimInstance Win32_Process`），其余平台走 `ps`。
 * 命令行里带引号、空格、非 ASCII 都是常态，所以整串**原样**带回来，由调用方按需匹配。
 */
export async function fetchCommandLines(): Promise<Map<number, string> | undefined> {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
    const stdout = await runPowerShell(script);
    return stdout === undefined ? undefined : parseWindowsCommandLines(stdout);
  }
  const outcome = await runCapture("ps", ["-A", "-o", "pid=,args="]);
  if (outcome.code !== 0) return undefined;
  return parsePsCommandLines(outcome.stdout);
}

/**
 * 取「这个 pid 正在监听的地址」（TCP LISTEN）。拿不到返回 undefined。
 *
 * 查询按平台分派，解析各自一个纯函数（可离线断言）：
 * - Windows：`Get-NetTCPConnection -State Listen -OwningProcess <pid>`（pid 是数字，可安全内联）；
 * - macOS / Linux：`lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN -F n`（`-F n` 是机器可读的字段输出）；
 * - Linux 上 lsof 可能没装：退到 `ss -H -ltnp`（按命令行里的 `pid=` 过滤）。
 */
export async function fetchListenPorts(pid: number): Promise<ListenRow[] | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "win32") {
    const script =
      `Get-NetTCPConnection -State Listen -OwningProcess ${pid} | ` +
      "Select-Object LocalAddress,LocalPort | ConvertTo-Json -Compress";
    const stdout = await runPowerShell(script);
    return stdout === undefined ? undefined : parseWindowsListen(stdout);
  }
  const lsof = await runCapture("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-F", "n"]);
  if (lsof.code === 0) return parseLsofListen(lsof.stdout);
  if (process.platform === "linux") {
    const ss = await runCapture("ss", ["-H", "-ltnp"]);
    if (ss.code === 0) return parseSsListen(ss.stdout, pid);
  }
  return undefined;
}

// ---------- 解析（纯函数，逐个可断言） ----------

/**
 * Windows CIM 的 JSON。
 *
 * `ConvertTo-Json` 在只有一个进程时给**对象**、多个时给数组；字段可能在别的行里带空值
 * （受保护的进程拿不到命令行），所以逐行验形状，丢掉不合格的行而不是整体失败。
 */
export function parseWindowsCommandLines(stdout: string): Map<number, string> {
  const lines = new Map<number, string>();
  const parsed = parseJsonLoose(stdout);
  for (const row of asRows(parsed)) {
    const pid = row.ProcessId;
    const command = row.CommandLine;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid)) continue;
    if (typeof command !== "string" || !command.trim()) continue;
    lines.set(pid, command.trim());
  }
  return lines;
}

/** `ps -A -o pid=,args=` 的输出：每行「pid 命令行」。 */
export function parsePsCommandLines(stdout: string): Map<number, string> {
  const lines = new Map<number, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    lines.set(Number.parseInt(match[1], 10), match[2].trim());
  }
  return lines;
}

/** `Get-NetTCPConnection … | Select-Object LocalAddress,LocalPort` 的 JSON。 */
export function parseWindowsListen(stdout: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const row of asRows(parseJsonLoose(stdout))) {
    const address = row.LocalAddress;
    const port = row.LocalPort;
    if (typeof address !== "string" || typeof port !== "number") continue;
    rows.push({ address, port });
  }
  return rows;
}

/**
 * `lsof -F n` 的输出：每个字段一行，`n` 打头的是"名字"字段（这里就是 `地址:端口`）。
 *
 * IPv6 的写法是 `[::1]:5674`，端口取**最后一个**冒号之后的部分。
 */
export function parseLsofListen(stdout: string): ListenRow[] {
  const rows: ListenRow[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (!line.startsWith("n")) continue;
    const row = splitHostPort(line.slice(1).trim());
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * `ss -H -ltnp` 的输出：本机地址在第 4 列，进程信息在最后一列（`users:(("node",pid=123,fd=7))`）。
 *
 * 只有 Linux 的 `ss` 会带进程信息，而它需要权限才能看到**别人的**进程——看不到时这一行
 * 少了 `users:` 段，于是这个 pid 查不出端口（调用方按"找不到服务"处置，不猜）。
 */
export function parseSsListen(stdout: string, pid: number): ListenRow[] {
  const rows: ListenRow[] = [];
  const wanted = new RegExp(`\\bpid=${pid}\\b`, "u");
  for (const line of stdout.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length < 5 || columns[0] !== "LISTEN") continue;
    // 整行找 pid：进程名里可能有空格，最后一列未必完整
    if (!wanted.test(line)) continue;
    const row = splitHostPort(columns[3]);
    if (row) rows.push(row);
  }
  return rows;
}

/** `地址:端口` → 收窄后的行（端口必须是 1–65535 的整数）。 */
function splitHostPort(text: string): ListenRow | undefined {
  const at = text.lastIndexOf(":");
  if (at <= 0) return undefined;
  const port = Number.parseInt(text.slice(at + 1), 10);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) return undefined;
  const host = text.slice(0, at).replace(/^\[/u, "").replace(/\]$/u, "");
  return host ? { address: host, port } : undefined;
}

/** `JSON.parse` 的宽松版（解析不了给 undefined，绝不抛）。 */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

/** 把"单对象 / 数组"两种形态统一成行集合（`ConvertTo-Json` 两种都会给）。 */
function asRows(parsed: unknown): Record<string, unknown>[] {
  const list = Array.isArray(parsed) ? parsed : parsed === undefined || parsed === null ? [] : [parsed];
  return list.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
}

// ---------- 执行 ----------

/** 起一次 PowerShell 拿 stdout（超时/超限都当"拿不到"，绝不抛）。 */
async function runPowerShell(script: string): Promise<string | undefined> {
  const candidates = process.platform === "win32" ? ["pwsh.exe", "powershell.exe"] : ["pwsh", "powershell"];
  for (const executable of candidates) {
    const outcome = await runCapture(executable, ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (outcome.errorCode !== undefined) {
      if (outcome.errorCode === "ENOENT") continue; // 解释器不存在：换一个再试
      return undefined;
    }
    if (outcome.code !== 0) return undefined;
    return outcome.stdout;
  }
  return undefined;
}

/**
 * 起一个只读的外部查询并接住 stdout。
 *
 * 输出**有上限**（64MB）：超限说明数据不可信，宁可不确认（不删锁、不认领端口）
 * 也不要截断后误判。超时同样按"拿不到"处置。
 */
function runCapture(command: string, args: string[], timeoutMs = 20_000): Promise<CaptureOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({ code: undefined, stdout: "", errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已退出
      }
      finish({ code: undefined, stdout: "", errorCode: "TIMEOUT" });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        finish({ code: undefined, stdout: "", errorCode: "MAXBUFFER" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error) => {
      finish({ code: undefined, stdout: "", errorCode: (error as NodeJS.ErrnoException).code ?? "SPAWN_FAILED" });
    });
    child.on("close", (code) => {
      finish({ code: code ?? undefined, stdout: Buffer.concat(chunks).toString("utf8"), errorCode: undefined });
    });
  });
}
