/**
 * 端到端探针：多窗口共享同一个 DSH 后台（`docs/design-shared-server.md` 的 R1/R3/R4）。
 *
 * 为什么用**两个真实进程**当窗口：判据是"还剩几个**活着的窗口**"，而
 * `liveHosts()` 判活靠 pid + 心跳。同一个进程里造两个 manager 只能算一个窗口，
 * 测不出"owner 先退、joiner 后退"（R4）。所以这里：
 *
 * - 主进程 = 窗口 A（起后台）；
 * - 子进程（`--window B`）= 窗口 B（应当复用 A 的后台）；
 * - 关掉 A → 后台必须还活着；再关掉 B → 后台才被带走。
 *
 * 隔离：整场跑在 `DSH_CHAT_LEASE_DIR` 指向的临时目录里，绝不碰用户自己那份租约
 * （否则会接入/清理用户正在用的后台，结论不可信）。但 `dsh web` 本身仍用真实
 * DSH_HOME（会话、凭据都是真的），每次启动约 5~20 秒。
 *
 * 运行：npm run build:scripts && node build/shared-server-probe.mjs
 */
import { spawn, type ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
// 必须排在最前面：它在模块求值期把租约目录指到本次探针专用的临时目录
// （`processRegistry` 在初始化时读一次环境变量，晚了就固化成用户的真实目录了）
import { PROBE_LEASE_DIR } from "./sharedServerProbeEnv";
import { ServerManager } from "../src/dsh/serverManager";
import { isProcessAlive, leaseDirectory, readHostLeases, readLeases } from "../src/dsh/processRegistry";

const COMMAND = "dsh web --port 0 --no-open";
/**
 * 固定端口模式（`--fixed`）：两个窗口都用**同一个写死端口**的命令。
 *
 * 用来验证一个容易想当然的点：共享模式下"固定端口"是否同样能复用？
 * 预期是能——第二个窗口读到租约直接接入，根本不会去起进程，所以不存在端口冲突。
 * 唯一真会冲突的情形是用户自己在那个端口上跑着 dsh（那时该走 `dshChat.url`）。
 */
const FIXED_PORT = 21997;
const FIXED_COMMAND = `dsh web --port ${FIXED_PORT} --no-open`;
const useFixedPort = process.argv.includes("--fixed");
const command = useFixedPort ? FIXED_COMMAND : COMMAND;

// ---------- 子进程模式：当"窗口 B" ----------

if (process.argv.includes("--window")) {
  const manager = new ServerManager({
    url: "",
    command,
    startTimeoutMs: 120_000,
    workspace: "D:/dev/dsh-chat#B",
    log: (line) => console.error(`[B] ${line}`),
  });
  // 决策前先把"我看到了哪些租约"打出来：诊断"为什么没复用"只能靠这个
  const seen = readLeases().map((item) => ({
    pid: item.lease.serverPid,
    url: item.lease.baseUrl,
    token: item.lease.token ? "有" : "无",
    hosts: item.lease.hosts?.length ?? 0,
    alive: isProcessAlive(item.lease.serverPid),
  }));
  console.error(
    `[B] 决策前看到的租约：${JSON.stringify(seen)}` +
      `；心跳=${JSON.stringify(readHostLeases().map((h) => ({ key: h.serverPid, pid: h.pid, url: h.baseUrl })))}` +
      `；租约目录=${leaseDirectory()}`,
  );
  const info = await manager.ensure();
  // 唯一一条 stdout：父进程读它就知道 B 接到哪儿了。
  // 包 try：父进程若提前退出，这条管道就断了，写它会抛 EPIPE——那种情况下要
  // 立刻走清理（下面的 finally 是同步路径，但这里必须自己兜住，否则会留下后台）
  let reported = false;
  try {
    console.log(JSON.stringify({ baseUrl: info.baseUrl, ownership: info.ownership, owned: info.owned }));
    reported = true;
  } catch {
    manager.dispose();
  }
  if (!reported) process.exit(0);
  // 等父进程关上 stdin 再退出（模拟用户关窗 → deactivate → dispose）。
  // **不要 process.exit()**：那会把 dispose 里"同步发起"的清理之后的收尾逻辑掐断
  // （实测踩过：kill 还没发出去进程就没了）。这里顺序反一下：先 dispose，再退出。
  process.stdin.resume();
  process.stdin.on("end", () => {
    manager.dispose();
    process.exit(0);
  });
} else {
  const log = (line: string) => console.log(`[probe] ${line}`);
  let failures = 0;
  function check(label: string, ok: boolean, detail = ""): void {
    console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  }

  const leaseDir = PROBE_LEASE_DIR;
  console.log(`[probe] 租约目录（隔离）：${leaseDir} / 本进程用的是 ${leaseDirectory()}`);
  console.log(`[probe] 启动命令：${command}${useFixedPort ? "（固定端口模式）" : ""}`);

  /**
   * 现在有几条租约（只有本探针自己写的租约在这个隔离目录里）。
   *
   * 注意它数的是**租约条数**，不是"活着的后台数"：僵尸态下 `isProcessAlive`
   * 会假报活着（见 `stillServing` 的注释），所以判"后台还在不在"一律用 HTTP，
   * 这个方法只用来数"有没有多出第二个后台的文件"。
   */
  const leasedServers = (): number[] =>
    readLeases()
      .filter((item) => isProcessAlive(item.lease.serverPid))
      .map((item) => item.lease.serverPid);

  /**
   * 某个后台**还在服务吗**（唯一可靠的判据）。
   *
   * 为什么不用 `isProcessAlive(pid)`：它只回答"这个 pid 还在不在"，而
   * **我们自己 spawn 的子进程被杀之后、只要 Node 还握着句柄，pid 就一直算"在"**
   * （僵尸态）。实测后果很严重：
   * - 断言假失败（进程早退了，`isProcessAlive` 还说在）；
   * - `while (isProcessAlive(pid)) await …` 永远等不到头；
   * - 那个僵尸仍继承着调用方（`build` 工具）的 stdout，管道不关 → **工具永不返回**，
   *   看起来就是"卡死"。
   *
   * 端口不会骗人：`dsh web` 一旦退出，监听就没了，连不上就是连不上。
   */
  async function stillServing(baseUrl: string): Promise<boolean> {
    try {
      await fetch(baseUrl, { redirect: "manual", signal: AbortSignal.timeout(1_200) });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 轮询等某个后台**不再服务**，最多 `timeoutMs`。返回说明文字或 undefined（超时）。
   *
   * `taskkill /T /F` 是异步的：实测一个 `dsh web`（要拆掉整棵插件树）从收到
   * taskkill 到端口关闭可能花十几秒，所以这里给足时间并逐步报告进度。
   */
  async function waitServerGone(baseUrl: string, timeoutMs: number): Promise<string | undefined> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!(await stillServing(baseUrl))) return `端口已关闭（${Date.now() - started}ms）`;
      await delay(500);
    }
    return undefined;
  }

  /**
   * 安全网：把还活着的后台杀干净。
   *
   * **必须有界且可观测**：一轮 taskkill + 最多等 30 秒，然后无论结果如何都返回。
   * 曾经写成 `while (isProcessAlive(pid))`——那个循环在僵尸态下永远不退出，
   * 直接把 `build` 工具拖到超时。
   */
  async function killLeftovers(): Promise<void> {
    const sockets = [serverBaseUrl].filter(Boolean) as string[];
    const alive = await Promise.all(sockets.map((url) => stillServing(url)));
    if (!alive.some(Boolean)) return;
    const pids = leasedServers();
    console.log(`[probe] 收尾：还有后台在服务（pid=${pids.join(",")}），杀掉它`);
    for (const pid of pids) {
      try {
        spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // 忽略
      }
    }
    await Promise.all(sockets.map((url) => waitServerGone(url, 30_000)));
  }

  let a: ServerManager | undefined;
  let b: ChildProcess | undefined;
  /** 探针 A 那个后台的地址：判"它还活着吗"一律用它，不用 pid（见 stillServing）。 */
  let serverBaseUrl: string | undefined;

  try {
    console.log("\n1) 窗口 A 起后台…");
    a = new ServerManager({
      url: "",
      command,
      startTimeoutMs: 120_000,
      workspace: "D:/dev/dsh-chat#A",
      log,
    });
    const infoA = await a.ensure();
    serverBaseUrl = infoA.baseUrl;
    const pids = leasedServers();
    check("A 拿到后台且 ownership=self", infoA.ownership === "self", infoA.baseUrl);
    check("机器上有且只有一个后台", pids.length === 1, `pids=${pids.join(",")}`);
    const serverPid = pids[0];

    console.log("\n2) 窗口 B（真实子进程）激活 —— 应当复用 A 的后台…");
    // **先等 6 秒**：A 的心跳要跑过至少一轮（5 秒节拍）才会把"真实在服务的 pid"写进心跳。
    // 这一等正是为了覆盖 F1 那类回归——心跳的身份键一旦与被接入方用的键不一致，
    // B 就会找不到可接入的后台而自己起一个（多出一个 dsh 进程）。
    console.log("   （先等 6 秒，让 A 的心跳跑过一轮）");
    await delay(6_000);
    b = spawn(process.execPath, [process.argv[1], "--window"], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
      env: { ...process.env, DSH_CHAT_LEASE_DIR: leaseDir },
    });
    let stdout = "";
    b.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    const deadline = Date.now() + 150_000;
    while (!stdout.includes("\n") && Date.now() < deadline && b.exitCode === null) await delay(300);
    const parsed = (() => {
      try {
        return JSON.parse(stdout.trim().split(/\r?\n/)[0] ?? "") as {
          baseUrl?: string;
          ownership?: string;
        };
      } catch {
        return undefined;
      }
    })();
    check("B 报告了它接上的后台", Boolean(parsed?.baseUrl), stdout.trim().slice(0, 120));
    check("B 复用了 A 的地址", parsed?.baseUrl === infoA.baseUrl, `${infoA.baseUrl} vs ${parsed?.baseUrl}`);
    check("B 的 ownership=peer", parsed?.ownership === "peer");
    check("没有新增第二个后台", leasedServers().length === 1, `pids=${leasedServers().join(",")}`);
    // 判"有几个窗口在用"看**心跳文件**（每个扩展实例一份），不是租约里的 hosts[]：
    // hosts[] 按 pid 去重，而本探针的两个"窗口"同进程同 pid，压根区分不开。
    check(
      "两个实例各有一份心跳（即两个窗口在用）",
      readHostLeases().length === 2,
      `心跳数=${readHostLeases().length}`,
    );

    console.log("\n3) 关闭窗口 A（B 还在用 → 后台必须活着）…");
    a.dispose();
    a = undefined;
    await delay(2_000);
    check("A 关闭后后台仍在服务", await stillServing(infoA.baseUrl), infoA.baseUrl);
    check("A 已从租约的 hosts 里摘除", (readLeases()[0]?.lease.hosts?.length ?? 0) === 1);

    console.log("\n4) 关闭窗口 B（最后一个 → 后台被带走）…");
    b.stdin?.end();
    await Promise.race([
      new Promise((resolve) => b?.on("close", resolve)),
      delay(45_000).then(() => console.log("   （等子进程退出超时，继续）")),
    ]);
    b = undefined;
    const gone = await waitServerGone(infoA.baseUrl, 60_000);
    check("B 关闭后后台不再服务", gone !== undefined, gone ?? `等了 60s 仍在服务 ${infoA.baseUrl}`);
    check("租约也被清掉", readLeases().length === 0);
  } catch (error) {
    failures++;
    console.error("探针失败：", error instanceof Error ? error.message : String(error));
  } finally {
    a?.dispose();
    b?.kill();
    await delay(500);
    // 安全网：把还活着的后台杀干净**并等它们退出**。绝不能留下继承 stdout 的进程——
    // 那会让调用方的管道一直开着，表现为"探针卡住不返回"（排查成本很高）。
    await killLeftovers();
    try {
      rmSync(leaseDir, { recursive: true, force: true });
    } catch {
      // 忽略：临时目录残留不影响什么
    }
  }

  console.log(failures === 0 ? "\n✓ 共享后台可用（R1/R3/R4）" : `\n✗ ${failures} 项未通过`);
  if (failures > 0) process.exitCode = 1;
}
