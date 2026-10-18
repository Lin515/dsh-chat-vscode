/**
 * 桌面端内置服务的**发现与接入**（编排层：读凭据、签票、验票、等就绪）。
 *
 * 与 `docs/design-desktop.md`「端点发现」的四步一一对应：
 * 1. **认人**：命令行带 `dsh-desktop-host` 的进程（可再按 `dshChat.desktopExecutable` 收窄）；
 * 2. **找口**：该 pid 的 loopback LISTEN 端口（可能不止一个，逐个试）；
 * 3. **确认**：`GET /` 回 401 + DSH 的认证提示 —— 只证明"这是 DSH"，**不代表鉴权可用**；
 * 4. **鉴权**：按该端口算 authority、用本机签名密钥签一张 v1 浏览器会话票，打一次只读
 *    一元调用（`settings/describe`）——成功才算可连接。
 *
 * 系统的三件事（进程表 / 监听端口 / 文件与 HTTP）都在 `DesktopDeps` 后面：离线断言
 * 可以给假实现，把"没找到进程""密钥读不出来""票被拒"这些分支逐条钉住
 * （`scripts/desktopAttach.test.ts`）。
 *
 * **票被拒的自愈**：服务端的有效期上限是配置项 `cookieMaxAgeDays`（默认 30 天，下限 1 天），
 * 而它不在凭据文件里。所以先按 30 天签，被拒就**重读密钥**、改用 1 天再签一次
 * （两次都拒才算"不可连接"）。
 *
 * 需求与边界见 `docs/design-desktop.md`；这里只落机制，不碰界面与选路。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_COOKIE_LIFETIME_MS, mintBrowserCookie, scanBrowserSessionSecret, SHORT_COOKIE_LIFETIME_MS } from "./browserSession";
import { dshHome } from "./dshLocks";
import {
  desktopAuthority,
  desktopBaseUrl,
  desktopHostPids,
  loopbackRows,
  type ListenRow,
} from "./desktopSession";
import { fetchCommandLines, fetchListenPorts } from "./processTable";

/**
 * 读不到可用凭据：**要用户动作**，重试解决不了。
 *
 * `missing` = 没有那条记录（这台机器从没启动过任何 DSH web / 桌面端服务），
 * `rejected` = 签出的票被服务端拒了（**通常是桌面端与本扩展的 DSH 主目录不是同一个**，
 * 那么密钥就不同）。两者都只报"读不到 / 不接受凭据"，**不弹输入令牌框**：
 * 桌面端根本没有可输入的令牌。
 */
export class DesktopCredentialError extends Error {
  constructor(readonly reason: "missing" | "rejected") {
    super(reason === "missing" ? "@desktopCredentialMissing" : "@desktopCredentialRejected");
    this.name = "DesktopCredentialError";
  }
}

/** 拉起桌面端可执行文件失败（路径错、权限不足……）。属**启动类**：不自动重试。 */
export class DesktopStartError extends Error {
  constructor(readonly detail: string) {
    super(`@desktopSpawnFailed:${detail}`);
    this.name = "DesktopStartError";
  }
}

/** 桌面端起来了，但等不到它的服务就绪。同样属**启动类**：不自动重试。 */
export class DesktopNotReadyError extends Error {
  constructor() {
    super("@desktopNotReady");
    this.name = "DesktopNotReadyError";
  }
}

/**
 * 拉起的桌面端进程在服务就绪之前就退出了，而且现在没有任何桌面端宿主进程在跑。
 *
 * 与"等超时"分开是为了**早报**：进程已经没了，再等下去不会有任何变化，所以这一档立刻
 * 给结论，不把它糊成"等不到就绪"。属**启动类**：不自动重试。
 *
 * `code` 为 `null`（被信号杀死）时标记不带参数，文案省掉"退出码"那一段。
 */
export class DesktopExitedError extends Error {
  constructor(readonly code: number | null) {
    super(code === null ? "@desktopExited" : `@desktopExited:${code}`);
    this.name = "DesktopExitedError";
  }
}

/** 等就绪期间用户叫停（「停止连接」）。调用方映射成它自己的"用户中止"。 */
export class DesktopStartCancelledError extends Error {
  constructor() {
    super("desktop start cancelled");
    this.name = "DesktopStartCancelledError";
  }
}

/** 一次发现/鉴权的结论。`running` 与 `attachable` 两轴都由它出（见 `docs/design-desktop.md`）。 */
export type DesktopAttachResult =
  /** 发现 + 鉴权都通过：可以直接建客户端。 */
  | { kind: "attached"; baseUrl: string; authority: string; port: number; cookie: string }
  /** 认人失败（没有匹配进程 / 端口不是 DSH）或服务在鉴权途中消失。 */
  | { kind: "not-running" }
  /** 凭据读不出来（记录缺失、格式非法）。 */
  | { kind: "no-credential" }
  /** 票被服务端拒（两次都拒）。 */
  | { kind: "rejected" };

/** 认领一次"这是 DSH"的判据（`GET /` 的响应形状）。 */
export interface ProbeResponse {
  status: number;
  body: string;
}

/**
 * 系统能力（全部注入）。生产实现在 `productionDesktopDeps`；离线测试给假实现。
 *
 * `log` 只写**开发日志**：凭据与票**一个字都不许进去**（见 `docs/design-desktop.md`
 * 「安全与凭据处置」），所以这里需要说明的时候只报阶段，不报值。
 */
export interface DesktopDeps {
  /** `dshChat.desktopExecutable`（已 trim；空白 = 整条支路关闭，调用方不该走到这里）。 */
  executable: string;
  /** pid → 命令行；拿不到给 undefined。 */
  commandLines(): Promise<Map<number, string> | undefined>;
  /** 一个 pid 的监听地址；拿不到给 undefined。 */
  listenPorts(pid: number): Promise<ListenRow[] | undefined>;
  /** 读 `<DSH_HOME>/.credentials.yaml` 原文；读不到给 undefined。 */
  credentialText(): string | undefined;
  /** 探一次"这个地址上是不是 DSH"（只发 `GET /`，不带凭据）。 */
  confirmDsh(baseUrl: string): Promise<ProbeResponse | undefined>;
  /** 用票打一次只读一元调用：`ok` / 票被拒 / 地址不可达。 */
  verifyCookie(baseUrl: string, cookie: string): Promise<"ok" | "rejected" | "unreachable">;
  now(): number;
  log(line: string): void;
}

/**
 * 发现端点（认人 + 找口 + 确认）。找不到给 undefined。
 *
 * 多个候选时**逐个确认**：同一个进程可能有别的监听端口（端口 0 是随机的，
 * 而它自己还可能开着 IPC 类端口），确认失败就试下一个，都不行才算"端口不是 DSH"。
 */
export async function discoverDesktopEndpoint(
  deps: Pick<DesktopDeps, "executable" | "commandLines" | "listenPorts" | "confirmDsh" | "log">,
): Promise<{ baseUrl: string; authority: string; port: number } | undefined> {
  const commandLines = await deps.commandLines();
  if (!commandLines) {
    deps.log("[desktop] 拿不到进程表，本次无法发现桌面端服务");
    return undefined;
  }
  const pids = desktopHostPids(commandLines, deps.executable);
  if (!pids.length) return undefined;
  deps.log(`[desktop] 认到 ${pids.length} 个候选进程：${pids.join(", ")}`);
  for (const pid of pids) {
    const rows = await deps.listenPorts(pid);
    if (!rows) continue;
    for (const row of loopbackRows(rows)) {
      // 权威取**实际绑定地址**（桌面端固定绑 127.0.0.1，但回环也可能是 ::1）：
      // 票的名字与载荷都绑它，写死一个就等于对自己无效
      const authority = desktopAuthority(row.address, row.port);
      const baseUrl = desktopBaseUrl(authority);
      const probe = await deps.confirmDsh(baseUrl);
      if (!probe) continue;
      if (probe.status !== 401) continue;
      // 401 是主判据（loopback + 认人已经收窄过一轮）；正文能读到时再核对一眼认证提示
      if (probe.body.trim() && !/dsh/iu.test(probe.body)) continue;
      deps.log(`[desktop] 认领端点 ${baseUrl}`);
      return { baseUrl, authority, port: row.port };
    }
  }
  return undefined;
}

/** 发现 + 鉴权：可连接时连票一起给（票按凭据对待，调用方只在本次连接里持有）。 */
export async function attachDesktopHost(deps: DesktopDeps): Promise<DesktopAttachResult> {
  const endpoint = await discoverDesktopEndpoint(deps);
  if (!endpoint) return { kind: "not-running" };
  // 有效期阶梯：先默认 30 天，被拒再重读密钥、改用 1 天（见文件头）
  const lifetimes = [DEFAULT_COOKIE_LIFETIME_MS, SHORT_COOKIE_LIFETIME_MS];
  for (const [attempt, lifetimeMs] of lifetimes.entries()) {
    // 第二次**重读**密钥：服务端可能刚把记录换掉（凭据文件是活文件）
    const text = deps.credentialText();
    if (text === undefined) return { kind: "no-credential" };
    const secret = scanBrowserSessionSecret(text);
    if (secret === undefined) return { kind: "no-credential" };
    const cookie = mintBrowserCookie({ authority: endpoint.authority, secret, issuedAt: deps.now(), lifetimeMs });
    if (!cookie) return { kind: "no-credential" };
    const verdict = await deps.verifyCookie(endpoint.baseUrl, cookie.header);
    if (verdict === "ok") return { kind: "attached", ...endpoint, cookie: cookie.header };
    if (verdict === "unreachable") return { kind: "not-running" };
    deps.log(`[desktop] 票被拒（第 ${attempt + 1} 次，有效期 ${Math.round(lifetimeMs / 3_600_000)}h）`);
  }
  return { kind: "rejected" };
}

/**
 * 给桌面端可执行文件准备的**干净子进程环境**。
 *
 * 扩展宿主自己是被 VS Code 以 `ELECTRON_RUN_AS_NODE=1` 拉起来的（`runtimeResolve.ts`
 * 的 `runtimeEnv` 讲的是同一件事的另一面），而 `spawn` 默认继承 `process.env`：那个
 * 变量会让 Electron 应用**以纯 Node 方式启动**——没有窗口、起一个 REPL，stdin 一被
 * `ignore` 就立刻退出；而 `spawn` 事件在进程**创建成功**时就已触发，光看它察觉不到。
 *
 * 所以这里把能让 Electron 换角色的变量与 `NODE_OPTIONS` 一并删掉。**只删不加**：
 * 桌面端要的是它自己那个正常的 GUI 启动形态。
 */
export function desktopLaunchEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  // 与 `runtimeResolve.ts` 的 `runtimeEnv` 同一份变体清单：那边是"清掉再设成 1"，
  // 这边是"彻底清掉"，两边都不留能让 Electron 换角色的变量
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_FORCE_WINDOW_MENU_BAR;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_ENABLE_STACK_DUMPING;
  // 它可能带 `--require` / `--inspect` 这类开发期注入，桌面端不该受这套影响
  delete env.NODE_OPTIONS;
  return env;
}

/** 拉起的桌面端进程句柄：只回答"它退出了没有"（等就绪那一轮据此早报）。 */
export interface DesktopLaunch {
  /** 已退出给退出码（被信号杀死时 `code` 为 `null`）；还在跑给 `undefined`。 */
  exited(): { code: number | null } | undefined;
}

export interface DesktopStartOptions {
  deps: DesktopDeps;
  /**
   * 拉起可执行文件（抛 `DesktopStartError` 表示起不来）。
   *
   * 给得出句柄就给：等就绪那一轮靠它把"进程已经没了"从 30 秒的静默等待变成一次明确的
   * 失败（见 `startDesktopAndWait`）。
   */
  launch(executable: string): Promise<DesktopLaunch | void>;
  /** 等就绪的上限（毫秒）。 */
  timeoutMs: number;
  /** 轮询间隔（毫秒）。 */
  pollMs: number;
  /** 用户叫停的判据（「停止连接」）。 */
  stopped(): boolean;
  /** 一次等待（可被叫停：实现里用 abort signal 或短睡轮询）。 */
  sleep(ms: number): Promise<void>;
}

/**
 * 现在还有没有桌面端宿主进程在跑（复用认人那一步的判据）。
 *
 * 拿不到进程表时**保守判为有**：宁可多等一会儿，也不要把"本来就在跑的那个桌面端"
 * 报成"拉起的进程退出了"。
 */
async function hasLiveHost(deps: Pick<DesktopDeps, "executable" | "commandLines">): Promise<boolean> {
  const commandLines = await deps.commandLines();
  if (!commandLines) return true;
  return desktopHostPids(commandLines, deps.executable).length > 0;
}

/**
 * 拉起桌面端并等它的服务就绪。
 *
 * 等就绪是**轮询发现**而不是"等固定时间"：Electron 冷启动几秒、更新替换宿主时更久，
 * 而这个循环的每一步都是一次完整的发现 + 鉴权，所以它返回的就是可以直接建客户端的结论。
 * 超过上限仍未就绪 → `DesktopNotReadyError`（启动类失败：不自动重试，避免 spawn 风暴）；
 * 拉起的进程先退了、而且没有任何宿主进程在跑 → `DesktopExitedError`（同样是启动类，
 * 但立刻给结论，不等满上限）。
 */
export async function startDesktopAndWait(options: DesktopStartOptions): Promise<DesktopAttachResult> {
  const { deps } = options;
  const checkStopped = () => {
    if (options.stopped()) throw new DesktopStartCancelledError();
  };
  checkStopped();
  const launched = await options.launch(deps.executable);
  checkStopped();
  const deadline = deps.now() + options.timeoutMs;
  /** 这个判据只算一次：算过之后照旧等超时，免得每一轮都去查一次进程表。 */
  let exitJudged = false;
  for (;;) {
    checkStopped();
    const result = await attachDesktopHost(deps);
    checkStopped();
    if (result.kind === "attached") return result;
    // 凭据类失败重试也没用（与"还没起来"不同）：立刻如实报出去
    if (result.kind === "no-credential" || result.kind === "rejected") return result;
    const exit = launched?.exited();
    if (exit && !exitJudged) {
      exitJudged = true;
      // 单实例：已经有一个桌面端在跑时，重复拉起只会聚焦已有窗口，拉起的那个进程随即
      // 退出——而服务本来就在。所以"退出"本身不是失败判据，"退出且没有宿主进程在跑"才是。
      const live = await hasLiveHost(deps);
      checkStopped();
      if (!live) throw new DesktopExitedError(exit.code);
      deps.log("[desktop] 拉起的进程已退出，但仍认到桌面端宿主进程（多半是聚焦了已有窗口），继续等就绪");
    }
    if (deps.now() >= deadline) throw new DesktopNotReadyError();
    await options.sleep(options.pollMs);
  }
}

/**
 * 生产实现：进程表 / 端口查询走 `processTable`，凭据读 `<DSH_HOME>/.credentials.yaml`，
 * HTTP 走 `fetch`（短超时——都是 loopback，慢就等于没有）。
 */
export function productionDesktopDeps(executable: string, log: (line: string) => void): DesktopDeps {
  return {
    executable: executable.trim(),
    commandLines: fetchCommandLines,
    listenPorts: fetchListenPorts,
    credentialText: () => {
      try {
        return readFileSync(join(dshHome(), ".credentials.yaml"), "utf8");
      } catch {
        // 读不到就是读不到：不把路径与失败原因带出去（错误详情里只报"读不到凭据"）
        return undefined;
      }
    },
    confirmDsh: async (baseUrl) => {
      try {
        const response = await fetch(baseUrl, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(2_000) });
        return { status: response.status, body: await response.text().catch(() => "") };
      } catch {
        return undefined;
      }
    },
    verifyCookie: async (baseUrl, cookie) => {
      try {
        const response = await fetch(`${baseUrl}/api/settings/describe`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({
            type: "client-request",
            rpcId: `desktop-probe-${Date.now()}`,
            method: "settings/describe",
            payload: { args: {} },
          }),
          signal: AbortSignal.timeout(5_000),
        });
        if (response.status === 401 || response.status === 403) return "rejected";
        if (!response.ok) return "unreachable";
        const body = (await response.json().catch(() => undefined)) as { result?: { ok?: unknown } } | undefined;
        return body?.result?.ok === true ? "ok" : "rejected";
      } catch {
        return "unreachable";
      }
    },
    now: () => Date.now(),
    log,
  };
}
