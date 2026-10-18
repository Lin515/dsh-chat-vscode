/**
 * 离线断言：**桌面端内置服务的发现与接入**（`desktopSession.ts` / `processTable.ts` 的解析
 * 与 `desktopAttach.ts` 的编排）。
 *
 * 这一组不查真的进程表、不读真的凭据文件、不发真的 HTTP：系统那三件事都在 `DesktopDeps`
 * 后面，夹具给假实现。于是"没找到进程""密钥读不出来""票被拒""等不到就绪"这些分支都能逐条
 * 钉住——它们在真机上要么很难复现（要装桌面端、要故意弄坏凭据），要么代价很大（要等 30 秒
 * 超时）。真实的联调属需当次批准的探针（见 `docs/design-desktop.md`「验证方式」）。
 *
 * 覆盖五层：
 * 1. **认人**（命令行匹配 + 可执行文件收窄）；
 * 2. **找口**（回环筛选、多端口、四个平台解析器）；
 * 3. **发现与鉴权**（`discoverDesktopEndpoint` / `attachDesktopHost` 的四种结论）；
 * 4. **拉起并等就绪**（`startDesktopAndWait` 的四档收场：就绪 / 超时 / 用户叫停 /
 *    刚起来就退出），以及给桌面端准备的**干净子进程环境**（`desktopLaunchEnv`）。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import {
  DesktopExitedError,
  DesktopNotReadyError,
  DesktopStartCancelledError,
  DesktopStartError,
  attachDesktopHost,
  desktopLaunchEnv,
  discoverDesktopEndpoint,
  startDesktopAndWait,
  type DesktopDeps,
} from "../src/dsh/desktopAttach";
import {
  desktopAuthority,
  desktopBaseUrl,
  desktopHostPids,
  isDesktopHostCommand,
  isLoopbackAddress,
  loopbackPorts,
  loopbackRows,
} from "../src/dsh/desktopSession";
import {
  parseLsofListen,
  parsePsCommandLines,
  parseSsListen,
  parseWindowsCommandLines,
  parseWindowsListen,
} from "../src/dsh/processTable";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 合成密钥（43 个 base64url 字符 → 32 字节）。 */
const SECRET = "s".repeat(43);

/** 凭据文件的真实形态（值是合成串）。 */
const CREDENTIALS = [
  "records:",
  "  client-connection/browser-session:",
  "    kind: grant",
  "    payload:",
  "      version: 1",
  `      secret: ${SECRET}`,
  "  deepseek-account-platform/default:",
  "    payload:",
  "      token: nope",
  "",
].join("\n");

/** 桌面端可执行文件（中性夹具路径）。 */
const EXE = "C:\\Apps\\DSH Desktop\\dsh-desktop.exe";

/** 一条真实的 spawn 形态：Electron 以 Node 模式跑 `dsh-desktop-host` 的入口。 */
const HOST_COMMAND =
  `"${EXE}" --expose-internals C:\\Apps\\DSH Desktop\\resources\\app.asar.unpacked\\node_modules\\` +
  "@deepseek-ai\\dsh-desktop-host\\lib\\index.js --host 127.0.0.1 --port 0";

// ---------- 1. 认人 ----------

{
  check("带 dsh-desktop-host 签名的命令行认", isDesktopHostCommand(HOST_COMMAND));
  check("配了可执行文件时，同一条命令行也认（路径收窄通过）", isDesktopHostCommand(HOST_COMMAND, EXE));
  check("别的进程不认（没有签名）", !isDesktopHostCommand("node /usr/lib/dsh/apps/cli/lib/bin.js web"));
  check("配置的是另一份安装 → 不认（收窄的用途就是这个）", !isDesktopHostCommand(HOST_COMMAND, "D:\\Other\\dsh-desktop.exe"));
  check("收窄时大小写与分隔符都不敏感（Windows 口径）", isDesktopHostCommand(HOST_COMMAND, "c:/apps/dsh desktop/DSH-DESKTOP.EXE"));
  check("空白的可执行文件按「不收窄」处理", isDesktopHostCommand(HOST_COMMAND, "   "));

  const commandLines = new Map<number, string>([
    [42, "node /usr/lib/dsh/apps/cli/lib/bin.js web"],
    [7, HOST_COMMAND],
    [13, "electron --other-thing"],
    [3, HOST_COMMAND],
  ]);
  check("按 pid 取出全部候选并升序", JSON.stringify(desktopHostPids(commandLines, EXE)) === "[3,7]", JSON.stringify(desktopHostPids(commandLines, EXE)));
  check("没有候选时给空数组", desktopHostPids(new Map([[1, "node x"]]), EXE).length === 0);
}

// ---------- 2. 找口 ----------

{
  check("127.0.0.1 / 127.x 都是回环", isLoopbackAddress("127.0.0.1") && isLoopbackAddress("127.1.2.3"));
  check("::1 与 [::1] 都是回环", isLoopbackAddress("::1") && isLoopbackAddress("[::1]"));
  check("IPv4-mapped 形态也算回环", isLoopbackAddress("::ffff:127.0.0.1"));
  check("通配地址**不算**回环（那种部署不归这条支路接）", !isLoopbackAddress("0.0.0.0") && !isLoopbackAddress("::"));
  check("局域网地址不算", !isLoopbackAddress("192.168.1.5"));
  check("主机名不算（我们不解析名字）", !isLoopbackAddress("localhost"));

  const rows = loopbackRows([
    { address: "127.0.0.1", port: 5674 },
    { address: "127.0.0.1", port: 5674 },
    { address: "0.0.0.0", port: 3080 },
    { address: "127.0.0.1", port: 9 },
    { address: "192.168.1.5", port: 8080 },
    { address: "::1", port: 5675 },
    { address: "127.0.0.1", port: 0 },
  ]);
  check(
    "只留回环、去重、按端口升序（多端口都要留着逐个确认）",
    JSON.stringify(rows) === JSON.stringify([
      { address: "127.0.0.1", port: 9 },
      { address: "127.0.0.1", port: 5674 },
      { address: "::1", port: 5675 },
    ]),
    JSON.stringify(rows),
  );
  check("端口投影与行一致", JSON.stringify(loopbackPorts(rows)) === "[9,5674,5675]");
}

{
  check("IPv4 权威 = host:port", desktopAuthority("127.0.0.1", 5674) === "127.0.0.1:5674");
  check("IPv6 权威带方括号（URL.host 那一形）", desktopAuthority("::1", 5674) === "[::1]:5674");
  check("已经带方括号时不重复加", desktopAuthority("[::1]", 5674) === "[::1]:5674");
  check("权威小写化（官网验签时用 URL.host 重算）", desktopAuthority("LOCALHOST", 1) === "localhost:1");
  check("连接地址 = http:// + 权威", desktopBaseUrl("[::1]:5674") === "http://[::1]:5674");
}

// ---------- 3. 四个解析器 ----------

{
  const single = parseWindowsCommandLines(JSON.stringify({ ProcessId: 7, CommandLine: HOST_COMMAND }));
  check("CIM 单个对象也吃得下", single.get(7) === HOST_COMMAND);
  const many = parseWindowsCommandLines(
    JSON.stringify([
      { ProcessId: 7, CommandLine: HOST_COMMAND },
      { ProcessId: 8, CommandLine: null },
      { ProcessId: "9", CommandLine: "x" },
      { CommandLine: "no pid" },
    ]),
  );
  check("CIM 数组里丢掉形状不合格的行（受保护进程拿不到命令行）", many.size === 1 && many.has(7), JSON.stringify([...many.keys()]));

  const ps = parsePsCommandLines(["  1234 /usr/bin/node /x/dsh-desktop-host/lib/index.js", "  12  ps -A -o pid=,args=", "garbage"].join("\n"));
  check("ps 的 pid 与命令行分开", ps.get(1234)?.endsWith("dsh-desktop-host/lib/index.js") === true && ps.size === 2);

  const win = parseWindowsListen(JSON.stringify({ LocalAddress: "127.0.0.1", LocalPort: 5674 }));
  check("Get-NetTCPConnection 单个对象", win.length === 1 && win[0].port === 5674 && win[0].address === "127.0.0.1");
  check(
    "Get-NetTCPConnection 数组",
    parseWindowsListen(JSON.stringify([{ LocalAddress: "127.0.0.1", LocalPort: 1 }, { LocalAddress: 5, LocalPort: 2 }])).length === 1,
  );

  const lsof = parseLsofListen(["p3812", "n127.0.0.1:5674", "p3812", "n[::1]:5675", "f23", "n*:80"].join("\n"));
  check(
    "lsof -F n 的地址行（IPv4 / IPv6 / 通配）",
    JSON.stringify(lsof) === JSON.stringify([
      { address: "127.0.0.1", port: 5674 },
      { address: "::1", port: 5675 },
      { address: "*", port: 80 },
    ]),
    JSON.stringify(lsof),
  );

  const ss = parseSsListen(
    [
      'LISTEN 0 511 127.0.0.1:5674 0.0.0.0:* users:(("node",pid=3812,fd=23))',
      'LISTEN 0 4096 127.0.0.53:53 0.0.0.0:* users:(("systemd-resolve",pid=700,fd=13))',
      'LISTEN 0 511 [::1]:5675 [::]:* users:(("DSH Chat Helper",pid=3812,fd=24))',
      "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
    ].join("\n"),
    3812,
  );
  check(
    "ss 按 pid 过滤（别人的端口不要；进程名里有空格也认）",
    JSON.stringify(ss) === JSON.stringify([
      { address: "127.0.0.1", port: 5674 },
      { address: "::1", port: 5675 },
    ]),
    JSON.stringify(ss),
  );
}

// ---------- 4. 发现与鉴权 ----------

/** 一份可用的假依赖（逐例覆盖其中几项）。 */
function depsOf(patch: Partial<DesktopDeps> = {}): DesktopDeps {
  return {
    executable: EXE,
    commandLines: async () => new Map([[7, HOST_COMMAND]]),
    listenPorts: async () => [{ address: "127.0.0.1", port: 5674 }],
    credentialText: () => CREDENTIALS,
    confirmDsh: async () => ({ status: 401, body: "dsh web authentication required\n" }),
    verifyCookie: async () => "ok",
    now: () => 1_700_000_000_000,
    log: () => {},
    ...patch,
  };
}

/** 从票头里读回载荷（核对有效期用）。 */
function payloadOf(cookieHeader: string): Record<string, unknown> {
  const value = cookieHeader.slice(cookieHeader.indexOf("=") + 1);
  const body = value.split(".")[1];
  const padding = "=".repeat((4 - (body.length % 4)) % 4);
  return JSON.parse(Buffer.from(body.replaceAll("-", "+").replaceAll("_", "/") + padding, "base64").toString("utf8")) as Record<string, unknown>;
}

{
  const found = await discoverDesktopEndpoint(depsOf());
  check(
    "认领成功：权威按**实际绑定地址**算",
    found?.authority === "127.0.0.1:5674" && found.baseUrl === "http://127.0.0.1:5674" && found.port === 5674,
    JSON.stringify(found),
  );

  check("拿不到进程表 → 找不到（不猜）", (await discoverDesktopEndpoint(depsOf({ commandLines: async () => undefined }))) === undefined);
  check("没有候选进程 → 找不到", (await discoverDesktopEndpoint(depsOf({ commandLines: async () => new Map([[1, "node x"]]) }))) === undefined);
  check("拿不到监听端口 → 找不到", (await discoverDesktopEndpoint(depsOf({ listenPorts: async () => undefined }))) === undefined);
  check("逐个确认：200 的端口不算 DSH", (await discoverDesktopEndpoint(depsOf({ confirmDsh: async () => ({ status: 200, body: "hello" }) }))) === undefined);
  check(
    "逐个确认：401 但正文不是 DSH 的也不算",
    (await discoverDesktopEndpoint(depsOf({ confirmDsh: async () => ({ status: 401, body: "nginx basic auth" }) }))) === undefined,
  );
  check(
    "401 且正文为空也认（正文读不到时不强求）",
    (await discoverDesktopEndpoint(depsOf({ confirmDsh: async () => ({ status: 401, body: "" }) })))?.port === 5674,
  );

  // **不能只取一个端口**：先试的那个不是 DSH，后面那个才是
  const tried: number[] = [];
  const twoPorts = await discoverDesktopEndpoint(
    depsOf({
      listenPorts: async () => [
        { address: "127.0.0.1", port: 9 },
        { address: "127.0.0.1", port: 5674 },
      ],
      confirmDsh: async (baseUrl) => {
        tried.push(Number(new URL(baseUrl).port));
        return new URL(baseUrl).port === "5674" ? { status: 401, body: "dsh web authentication required" } : { status: 200, body: "nope" };
      },
    }),
  );
  check("多端口逐个试，认到第二个", twoPorts?.port === 5674 && JSON.stringify(tried) === "[9,5674]", JSON.stringify(tried));

  // 认人收窄：候选进程不在配置的可执行文件下 → 一个都不认
  check(
    "配置了另一份安装时认不到（收窄生效）",
    (await discoverDesktopEndpoint(depsOf({ executable: "D:\\Other\\dsh-desktop.exe" }))) === undefined,
  );
}

{
  const attached = await attachDesktopHost(depsOf());
  check(
    "可连接：带票、带权威、带端点",
    attached.kind === "attached" &&
      attached.baseUrl === "http://127.0.0.1:5674" &&
      attached.cookie.startsWith("dsh-auth-") &&
      attached.cookie.includes("=v1."),
    JSON.stringify(attached),
  );

  check("没找到进程 → not-running", (await attachDesktopHost(depsOf({ commandLines: async () => undefined }))).kind === "not-running");
  check("读不到凭据文件 → no-credential", (await attachDesktopHost(depsOf({ credentialText: () => undefined }))).kind === "no-credential");
  check(
    "凭据文件里没有那条记录 → no-credential（不发无意义的探测）",
    (await attachDesktopHost(depsOf({ credentialText: () => "records:\n  other: 1", verifyCookie: async () => "ok" }))).kind === "no-credential",
  );
  check("票被服务端拒两次 → rejected", (await attachDesktopHost(depsOf({ verifyCookie: async () => "rejected" }))).kind === "rejected");
  check(
    "验票时地址不可达 → not-running（不是「票被拒」）",
    (await attachDesktopHost(depsOf({ verifyCookie: async () => "unreachable" }))).kind === "not-running",
  );

  // 有效期阶梯：30 天被拒 → 重读密钥、改用 1 天再签（两处都要钉住）
  let reads = 0;
  let calls = 0;
  const retried = await attachDesktopHost(
    depsOf({
      credentialText: () => {
        reads += 1;
        return CREDENTIALS;
      },
      verifyCookie: async () => (++calls === 1 ? "rejected" : "ok"),
    }),
  );
  check("第一次被拒后重签一次就成功", retried.kind === "attached", retried.kind);
  check("被拒后**重读**凭据（服务端可能刚换掉记录）", reads === 2, String(reads));
  if (retried.kind === "attached") {
    const payload = payloadOf(retried.cookie);
    const lifetime = Number(payload.expiresAt) - Number(payload.issuedAt);
    check("重签用的是**短票**（1 天，配置项下限就是它）", lifetime === 86_400_000, String(lifetime));
  }

  const first = await attachDesktopHost(depsOf());
  if (first.kind === "attached") {
    const payload = payloadOf(first.cookie);
    check(
      "首次用的是 30 天（官方默认）",
      Number(payload.expiresAt) - Number(payload.issuedAt) === 30 * 86_400_000,
      String(Number(payload.expiresAt) - Number(payload.issuedAt)),
    );
  }
}

// ---------- 5. 拉起并等就绪 ----------

/** 一个会走的假时钟：`sleep` 推进它，`now` 读它。 */
function clockOf(): { now(): number; sleep(ms: number): Promise<void> } {
  let at = 1_700_000_000_000;
  return { now: () => at, sleep: async (ms: number) => void (at += ms) };
}

{
  const clock = clockOf();
  let launches = 0;
  let calls = 0;
  const late = await startDesktopAndWait({
    deps: depsOf({
      now: clock.now,
      // 第一次还没起来，拉起之后再探才认到
      commandLines: async () => (++calls >= 2 ? new Map([[7, HOST_COMMAND]]) : new Map()),
    }),
    launch: async (executable) => {
      launches += 1;
      assert.strictEqual(executable, EXE, "launch 拿到的是配置的可执行文件");
    },
    timeoutMs: 30_000,
    pollMs: 1_000,
    stopped: () => false,
    sleep: clock.sleep,
  });
  check("拉起后轮询到就绪（不是等固定时长）", late.kind === "attached" && launches === 1 && calls === 2, `${late.kind}/${String(launches)}/${String(calls)}`);
}

{
  const clock = clockOf();
  let launched = false;
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf({ now: clock.now, commandLines: async () => new Map() }),
      launch: async () => {
        launched = true;
      },
      timeoutMs: 3_000,
      pollMs: 1_000,
      stopped: () => false,
      sleep: clock.sleep,
    });
  } catch (caught) {
    error = caught;
  }
  check("等不到就绪 → DesktopNotReadyError（启动类，不自动重试）", error instanceof DesktopNotReadyError, String(error));
  check("确实拉起过（失败发生在等待阶段，不是没拉）", launched);
}

{
  const clock = clockOf();
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf({ now: clock.now, commandLines: async () => new Map() }),
      launch: async () => {},
      timeoutMs: 30_000,
      pollMs: 1_000,
      // 第一轮探测之后用户点了「停止连接」
      stopped: () => true,
      sleep: clock.sleep,
    });
  } catch (caught) {
    error = caught;
  }
  check("用户叫停 → DesktopStartCancelledError（不是失败）", error instanceof DesktopStartCancelledError, String(error));
}

{
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf(),
      launch: async () => {
        throw new DesktopStartError("ENOENT");
      },
      timeoutMs: 30_000,
      pollMs: 1_000,
      stopped: () => false,
      sleep: async () => {},
    });
  } catch (caught) {
    error = caught;
  }
  check(
    "拉起失败直接抛（带 @desktopSpawnFailed:ENOENT 标记）",
    error instanceof DesktopStartError && String((error as Error).message).startsWith("@desktopSpawnFailed:"),
    String(error),
  );
  check(
    "DesktopStartError 把 detail 单独带出来（控制器报通知时不必去切字符串）",
    error instanceof DesktopStartError && error.detail === "ENOENT",
    error instanceof DesktopStartError ? error.detail : String(error),
  );
}

// 刚起来就退出：**不能**白等满 30 秒（进程都没了，等下去不会有任何变化）
{
  const clock = clockOf();
  const started = clock.now();
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf({ now: clock.now, commandLines: async () => new Map() }),
      launch: async () => ({ exited: () => ({ code: 1 }) }),
      timeoutMs: 30_000,
      pollMs: 1_000,
      stopped: () => false,
      sleep: clock.sleep,
    });
  } catch (caught) {
    error = caught;
  }
  check(
    "进程已退出且没有宿主进程在跑 → DesktopExitedError（带 @desktopExited:<code> 标记）",
    error instanceof DesktopExitedError &&
      error.code === 1 &&
      String((error as Error).message) === "@desktopExited:1",
    String(error),
  );
  check("一轮都没睡就报出来（不是等满上限）", clock.now() === started, String(clock.now() - started));
}

// 被信号杀死（拿不到退出码）：标记不带参数，文案那一档由界面省掉
{
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf({ commandLines: async () => new Map() }),
      launch: async () => ({ exited: () => ({ code: null }) }),
      timeoutMs: 30_000,
      pollMs: 1_000,
      stopped: () => false,
      sleep: async () => {},
    });
  } catch (caught) {
    error = caught;
  }
  check(
    "拿不到退出码时标记不带参数（@desktopExited）",
    error instanceof DesktopExitedError && String((error as Error).message) === "@desktopExited",
    String(error),
  );
}

// 单实例：已经在跑的那个桌面端把窗口聚焦走、拉起的进程随即退出——这时**不能**报失败
{
  const clock = clockOf();
  let calls = 0;
  const started = clock.now();
  const result = await startDesktopAndWait({
    deps: depsOf({
      now: clock.now,
      // 第 1 次（本轮发现）：还没有宿主进程；第 2 次（判退出）：已经认到了；第 3 次：就绪
      commandLines: async () => (++calls >= 2 ? new Map([[7, HOST_COMMAND]]) : new Map()),
    }),
    launch: async () => ({ exited: () => ({ code: 0 }) }),
    timeoutMs: 30_000,
    pollMs: 1_000,
    stopped: () => false,
    sleep: clock.sleep,
  });
  check(
    "退出但认到桌面端宿主进程（单实例聚焦已有窗口）→ 继续等，随后接上",
    result.kind === "attached" && calls === 3,
    `${result.kind}/${String(calls)}`,
  );
  check("这种情况才会睡一轮（下一轮就探到了）", clock.now() === started + 1_000, String(clock.now() - started));
}

// 拿不到进程表时保守判为"还有宿主在跑"：宁可多等，也不要把已在跑的那个报成失败
{
  const clock = clockOf();
  let error: unknown;
  try {
    await startDesktopAndWait({
      deps: depsOf({ now: clock.now, commandLines: async () => undefined }),
      launch: async () => ({ exited: () => ({ code: 1 }) }),
      timeoutMs: 3_000,
      pollMs: 1_000,
      stopped: () => false,
      sleep: clock.sleep,
    });
  } catch (caught) {
    error = caught;
  }
  check(
    "拿不到进程表 → 不早报，照旧走超时那一档",
    error instanceof DesktopNotReadyError,
    String(error),
  );
}

// 取消先于一切副作用与迟到成功；不能以「已连上」覆盖用户叫停。
{
  let launches = 0;
  await assert.rejects(startDesktopAndWait({
    deps: depsOf(),
    launch: async () => { launches += 1; },
    timeoutMs: 30_000, pollMs: 1_000, stopped: () => true, sleep: async () => {},
  }), DesktopStartCancelledError);
  check("启动前已取消时不调用 launch", launches === 0, String(launches));

  let stopped = false;
  await assert.rejects(startDesktopAndWait({
    deps: depsOf({ verifyCookie: async () => { stopped = true; return "ok"; } }),
    launch: async () => {},
    timeoutMs: 30_000, pollMs: 1_000, stopped: () => stopped, sleep: async () => {},
  }), DesktopStartCancelledError);
  check("发现与鉴权期间取消，迟到成功不能返回 attached", stopped);
}

// ---------- 6. 拉起桌面端时的子进程环境 ----------
//
// 扩展宿主自己带着 `ELECTRON_RUN_AS_NODE=1`（VS Code 就是这么起扩展宿主的），而 `spawn`
// 默认继承 `process.env`：桌面端可执行文件会因此**以纯 Node 方式启动**——没有窗口、REPL
// 的 stdin 一被 `ignore` 就立刻 EOF 退出，而 `spawn` 事件照旧报"创建成功"。这条断言钉住
// "交给桌面端的环境是洗过的"。
{
  const dirty: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    ELECTRON_FORCE_WINDOW_MENU_BAR: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    ELECTRON_ENABLE_STACK_DUMPING: "1",
    NODE_OPTIONS: "--require ./probe.js",
  };
  const clean = desktopLaunchEnv(dirty);
  check(
    "清掉 ELECTRON_RUN_AS_NODE（留着它桌面端就是没有窗口的 Node）",
    !("ELECTRON_RUN_AS_NODE" in clean),
  );
  check(
    "另外四个 ELECTRON_* 变体一并清掉（换角色的变量一个都不留）",
    !["ELECTRON_NO_ATTACH_CONSOLE", "ELECTRON_FORCE_WINDOW_MENU_BAR", "ELECTRON_ENABLE_LOGGING", "ELECTRON_ENABLE_STACK_DUMPING"].some(
      (key) => key in clean,
    ),
  );
  check("NODE_OPTIONS 也清掉（开发期的注入不带进桌面端）", !("NODE_OPTIONS" in clean));
  check("别的变量原样保留（**只删不加**，桌面端要的是它自己的正常形态）", clean.PATH === "/usr/bin");
  check("不动调用方给的那份对象（返回的是副本）", dirty.ELECTRON_RUN_AS_NODE === "1");

  // 默认形参那一支：本进程真的带着那个变量时也必须清掉
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ELECTRON_RUN_AS_NODE = "1";
  check("默认取 process.env 时同样清掉", !("ELECTRON_RUN_AS_NODE" in desktopLaunchEnv()));
  if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
  else process.env.ELECTRON_RUN_AS_NODE = saved;
}

if (failures > 0) {
  console.error(`\n✗ 桌面端发现与接入：${failures} 项未通过`);
  process.exitCode = 1;
} else {
  console.log(
    "\n✓ 桌面端发现与接入（认人 / 找口 / 四个解析器 / 四种结论 / 拉起等就绪四档 / 子进程环境）全通过",
  );
  assert.ok(true);
}
