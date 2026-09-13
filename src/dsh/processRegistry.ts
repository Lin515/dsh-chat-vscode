/**
 * 进程与端口查询工具。
 *
 * 这个模块**只剩两件事**：进程在不在（`isProcessAlive`）与端口上有没有人在听
 * （`tcpReachableSync`）。历史上它承载过两套后台生命周期机制的大部分实现
 * （先是会合租约 / 心跳 / 接管判据，后是按命令行匹配的"残留进程"扫描），
 * 两者都已退役：
 *
 * - **会合租约那套**被 supervisor 架构取代（见 `docs/design-supervisor.md`）：dsh 的生死
 *   由独立守护进程按"还有几条活连接"裁决，扩展不再需要猜"还有没有人在用"；
 * - **"残留进程"扫描**被删掉（用户 2026-09-13 口径：**不准确的判定不如不要**）：
 *   它只能按命令行匹配 `dsh … web …`，分不清"用户正在用的"与"没人管的"
 *   （实测把当前后台也报成残留）。现在诊断信息只列**当前后台自己的**进程
 *   （守护进程 + 它持有的 dsh），不做任何扫描。
 *
 * 注释里保留的教训（僵尸进程假活、同步 spawnSync 会冻住宿主）对后来者仍然有用。
 */
import { spawnSync } from "node:child_process";
import { connect } from "node:net";

/** 进程是否还活着（活着但无权限访问也算活着）。 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 同步探一下"这个地址上有人在监听吗"（纯 TCP 连接，**同步**，失败即 false）。
 *
 * 为什么需要它，而不是看进程：Windows 上 `dsh web` 经 shell 启动，记录的 pid 可能是
 * `cmd.exe` 外壳；外壳先死时真正的 node 服务器**继续活着**。所以"服务器还在不在"
 * 只能问端口，不能问进程。
 *
 * 为什么是同步的：调用点在同步判定链里（心跳自检），而 TCP 连接是几毫秒级。
 */
export function tcpReachableSync(baseUrl: string, timeoutMs = 1_500): boolean {
  let host: string;
  let port: number;
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  } catch {
    return false;
  }
  if (!host || !Number.isInteger(port) || port <= 0) return false;
  if (process.platform !== "win32") {
    // 非 Windows：用 node 自己的同步 socket 探（没有 PowerShell 开销）
    return tcpReachableNode(host, port, timeoutMs);
  }
  const script =
    `$c = New-Object Net.Sockets.TcpClient; ` +
    `try { $null = $c.BeginConnect('${host}', ${port}, $null, $null); ` +
    `if ($c.Connected) { 'yes' } } catch { } finally { $c.Close() }`;
  const args = ["-NoProfile", "-NonInteractive", "-Command", script];
  const out = spawnSyncQuiet("pwsh.exe", args, timeoutMs + 3_000) ?? spawnSyncQuiet("powershell.exe", args, timeoutMs + 3_000);
  if (out === undefined) return tcpReachableNode(host, port, timeoutMs);
  return out.includes("yes");
}

/** 非 Windows 的同步 TCP 探测（用 net 模块 + Atomics.wait 把异步 socket 变同步）。 */
function tcpReachableNode(host: string, port: number, timeoutMs: number): boolean {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  let ok = false;
  const done = (success: boolean) => {
    ok = success;
    socket.destroy();
    Atomics.store(shared, 0, 1);
    Atomics.notify(shared, 0);
  };
  const socket = connect({ host, port });
  socket.setTimeout(timeoutMs);
  socket.on("connect", () => done(true));
  socket.on("error", () => done(false));
  socket.on("timeout", () => done(false));
  Atomics.wait(shared, 0, 0, timeoutMs + 500);
  return ok;
}

function spawnSyncQuiet(command: string, args: string[], timeoutMs: number): string | undefined {
  const result = spawnSync(command, args, {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
  return result.stdout;
}

/** 转出（`clearStaleDocumentLocks` 现在住在 `dshLocks.ts`，保持老入口可用）。 */
export { clearStaleDocumentLocks, dshHome, type StaleLockResult } from "./dshLocks";
