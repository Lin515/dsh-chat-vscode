/**
 * 桌面端内置服务的**认人与找口**（纯函数，可离线断言）。
 *
 * 桌面端的 DSH 是一个 Electron 以 Node 模式 spawn 的子进程（入口 `@deepseek-ai/dsh-desktop-host`），
 * 固定 `--host 127.0.0.1 --port 0`——端口**每次启动随机**，所以端点只能现场发现：
 *
 * 1. **认人**：命令行里带 `dsh-desktop-host` 的进程才是它（spawn 形态由桌面端自己的
 *    `host-process` 决定）；配了 `dshChat.desktopExecutable` 时**再收窄一层**（命令行必须
 *    落在那条路径下），免得同一台机器上另一份安装被误认；
 * 2. **找口**：取该 pid 的 loopback LISTEN 端口（同一进程可能还监听别的口，不能只取一个）；
 * 3. 认领前还要一次 HTTP 确认（见 `desktopAttach.ts`）——"进程像"不等于"端口是 DSH"。
 *
 * 本模块只管 1 与 2 里**与系统查询无关**的那部分；进程表与 socket 的查询在 `processTable.ts`，
 * 编排在 `desktopAttach.ts`。
 */

/**
 * 认人的**签名**：桌面端 spawn 的 DSH 子进程入口路径里一定带这段。
 *
 * 它不是公开契约（属桌面端实现），所以按仓库惯例登记为兼容分支（见 `docs/dsh-compat.md`）。
 */
export const DESKTOP_HOST_SIGNATURE = "dsh-desktop-host";

/** 一条监听地址（`processTable.ts` 的查询结果收窄后的形状）。 */
export interface ListenRow {
  /** 绑定地址（IPv4 点分或 IPv6 文本，不带方括号）。 */
  address: string;
  port: number;
}

/**
 * 这条命令行是不是桌面端内置的 DSH 子进程。
 *
 * `executable` 给出时（`dshChat.desktopExecutable` 非空）要求命令行**包含该路径**：
 * 收窄的代价是"配置写错时认不出"（表现为找不到服务），收益是"另一份安装不会被我连上"。
 * 两边都按斜杠归一 + 小写比较——Windows 路径分隔符与大小写都不敏感，而宽松比较最坏
 * 只是多认一个，真正把关的是后面的 HTTP 确认与鉴权。
 */
export function isDesktopHostCommand(commandLine: string, executable?: string): boolean {
  if (!commandLine.includes(DESKTOP_HOST_SIGNATURE)) return false;
  const wanted = executable?.trim();
  if (!wanted) return true;
  return normalizePathText(commandLine).includes(normalizePathText(wanted));
}

/** 进程表里所有"像桌面端内置 DSH"的 pid（升序，便于日志与断言）。 */
export function desktopHostPids(commandLines: ReadonlyMap<number, string>, executable?: string): number[] {
  const pids: number[] = [];
  for (const [pid, commandLine] of commandLines) {
    if (isDesktopHostCommand(commandLine, executable)) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}

/**
 * 这个绑定地址是不是**本机回环**。
 *
 * 通配地址（`0.0.0.0` / `::`）刻意**不算**：桌面端的宿主固定绑 `127.0.0.1`，而通配
 * 意味着那份服务对整个局域网开放——那种部署不归这条支路接（也说明对面不是桌面端）。
 */
export function isLoopbackAddress(address: string): boolean {
  const bare = address.trim().replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  if (bare === "::1" || bare === "0:0:0:0:0:0:0:1") return true;
  // IPv4 回环整段 127.0.0.0/8；IPv4-mapped 形态在部分系统上会以 `::ffff:127.0.0.1` 出现
  return /^127\./u.test(bare) || /^::ffff:127\./u.test(bare);
}

/**
 * 候选端口：该 pid 的 loopback 监听端口（去重 + 升序）。
 *
 * **不能只取一个**：同一个进程可能还监听别的口（端口 0 分配出来的那个才是我们要的），
 * 而顺序稳定只是为了让日志与断言可复现。
 */
export function loopbackRows(rows: readonly ListenRow[]): ListenRow[] {
  const seen = new Set<string>();
  const kept: ListenRow[] = [];
  for (const row of rows) {
    if (!Number.isSafeInteger(row.port) || row.port <= 0 || row.port > 65_535) continue;
    if (!isLoopbackAddress(row.address)) continue;
    const key = desktopAuthority(row.address, row.port);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ address: row.address.trim(), port: row.port });
  }
  return kept.sort((left, right) => left.port - right.port);
}

/** 候选端口（`loopbackRows` 的端口投影，升序去重）。 */
export function loopbackPorts(rows: readonly ListenRow[]): number[] {
  return loopbackRows(rows).map((row) => row.port);
}

/**
 * 端点权威（`authority`）：`URL.host` 那一形——**小写主机名 + 端口**，IPv6 带方括号。
 *
 * 票的名字与载荷都绑定它，且必须与请求的 `Host` 头**完全一致**：官方验签时用
 * `new URL('http://' + host).host` 重算（URL 会把主机名小写化），所以这里也小写化。
 * 统一用 `127.0.0.1` 而不是 `localhost`——两者是不同的 authority，混用会让票只对其中一边有效。
 */
export function desktopAuthority(address: string, port: number): string {
  const bare = address.trim().replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
  const host = bare.includes(":") ? `[${bare}]` : bare;
  return `${host}:${port}`;
}

/** 权威 → 连接地址。 */
export function desktopBaseUrl(authority: string): string {
  return `http://${authority}`;
}

/** 路径文本归一：分隔符统一成 `/`、小写（只用于"包含"比较，不用于真实寻址）。 */
function normalizePathText(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
