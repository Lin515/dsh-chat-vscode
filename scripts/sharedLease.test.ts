/**
 * 离线断言：多窗口共享后台的会合租约（`docs/design-shared-server.md`）。
 *
 * 不需要 VS Code，也**不需要真的起 dsh**：租约模块是纯文件 + 进程存活查询，
 * 用当前进程当"活窗口"、用一个真实存活/已退出的子进程当"后台进程"就能覆盖全部分支。
 *
 * 为什么这些断言重要：这里判错的后果是**杀掉别的窗口正在用的后台**
 * （判死阈值太激进）或**留下孤儿 dsh 进程**（判活太宽松），两者都不会在
 * typecheck 或别的测试里暴露。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// 必须排在最前面：它在模块求值期把租约目录指到本次测试专用的临时目录
import { TEST_LEASE_DIR } from "./sharedLeaseEnv";
import {
  HOST_STALE_MS,
  acquireStartLock,
  clearHostLease,
  clearLease,
  dropDeadLeases,
  dropStaleHostLeases,
  findAdoptCandidates,
  findAttachable,
  findServingLeftoverLease,
  findStarting,
  hasLiveHostFor,
  isHostLive,
  isOrphanLease,
  STARTING_GRACE_MS,
  isServiceable,
  leaseDirectory,
  leaseHosts,
  liveHostIds,
  liveHosts,
  parseListeningPids,
  parseListeningPidsSync,
  readLeases,
  setLeaseGroup,
  registerHost,
  removeHost,
  touchHost,
  writeHostLease,
  writeLease,
  type ServerLease,
} from "../src/dsh/processRegistry";

const LEASE_DIR = leaseDirectory();
mkdirSync(LEASE_DIR, { recursive: true });
/** 占用 pid 号段：假装"别的窗口/别的后台"，绝不写真实存在的 pid（会被判成活的）。 */
const GHOST_PID = 2_000_000_001;
/**
 * 本进程造过的租约 pid。
 *
 * 收尾时**只删自己造的这些**：`npm test` 是并发跑的，其它测试（`tokenAndCleanup`）
 * 也在同一目录写租约，按"整个目录扫一遍全删"会踩到别人正在断言的中间态。
 */
const created = new Set<number>();

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** 一个真实存活、可随时杀掉的子进程（当作 dsh web 进程）。 */
function aliveChild(): ChildProcess {
  return spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function startLease(serverPid: number, patch: Partial<ServerLease> = {}): void {
  created.add(serverPid);
  writeLease({
    version: 2,
    serverPid,
    command: "dsh web --port 0 --no-open",
    startedAt: Date.now(),
    hosts: [{ pid: process.pid, workspace: "D:/dev/dsh-chat", seenAt: Date.now() }],
    ...patch,
  });
}

// ---------- 1. 旧格式（v1）向后兼容 ----------

{
  startLease(GHOST_PID, { token: undefined, baseUrl: undefined, hosts: undefined, hostPid: process.pid });
  const lease = readLeases().find((item) => item.lease.serverPid === GHOST_PID)?.lease;
  assert.ok(lease, "写入的租约应当读得回来");
  const hosts = leaseHosts(lease);
  check(
    "v1 租约（只有 hostPid）折成一个 host，seenAt 取 startedAt",
    hosts.length === 1 && hosts[0].pid === process.pid && hosts[0].seenAt === lease.startedAt,
  );
  check("v1 租约里的窗口算活着（当前进程真实存在）", liveHosts(lease).length === 1);
  clearLease(GHOST_PID);
}

// ---------- 2. 心跳判活：进程在 + seenAt 新，两个条件缺一不可 ----------

{
  const now = Date.now();
  check("进程在 + 心跳新 → 活", isHostLive({ pid: process.pid, seenAt: now }, now));
  check(
    "进程在但心跳陈旧 → 判死（pid 会被回收，只看进程存活会误判）",
    !isHostLive({ pid: process.pid, seenAt: now - HOST_STALE_MS - 1 }, now),
  );
  check(
    "心跳新但进程不在 → 判死（活着的进程是肯定证据）",
    !isHostLive({ pid: GHOST_PID, seenAt: now }, now),
  );
  check(
    "阈值边界：正好差 HOST_STALE_MS 仍算活（保守一档）",
    isHostLive({ pid: process.pid, seenAt: now - HOST_STALE_MS + 1 }, now),
  );
}

// ---------- 3. 可服务判据：进程在 + 地址在 + 令牌在 ----------

{
  const now = Date.now();
  const base: ServerLease = {
    serverPid: process.pid,
    command: "dsh web",
    startedAt: now,
    baseUrl: "http://127.0.0.1:1234",
    token: "tok",
    hosts: [{ pid: process.pid, seenAt: now }],
  };
  check("三样齐全 → 可服务", isServiceable(base));
  check("缺令牌（旧版租约）→ 不可服务", !isServiceable({ ...base, token: undefined }));
  check("缺地址（还在启动中）→ 不可服务", !isServiceable({ ...base, baseUrl: undefined }));
  check("进程不在 → 不可服务", !isServiceable({ ...base, serverPid: GHOST_PID }));
}

// ---------- 4. 接入选择：只接"活着、可服务、还有活窗口"的后台 ----------

{
  const live = aliveChild();
  const pid = live.pid as number;
  try {
    startLease(pid, { baseUrl: "http://127.0.0.1:1111", token: "tok-a" });
    // 判据看的是**各实例的心跳文件**（`hosts/<hostId>.json`），不是租约里按 pid 记的那份
    writeHostLease({ hostId: "pick-a", serverPid: pid });
    const picked = findAttachable();
    check("有活实例的可服务后台 → 被选中", picked?.serverPid === pid, `pid=${picked?.serverPid}`);

    // 实例心跳消失（窗口关了 / 扩展被禁用）→ 就是遗留，不该接入
    clearHostLease("pick-a");
    check("没有活实例（遗留）→ 不接入", findAttachable() === undefined);

    // 启动中的租约：进程在、还没地址 → 属于 findStarting 的范畴
    startLease(pid, { hosts: [{ pid: process.pid, seenAt: Date.now() }] });
    check("进程在但没有地址 → 认作启动中", findStarting(60_000)?.serverPid === pid);
    check("启动中不算可接入", findAttachable() === undefined);

    // 太久以前宣布的"启动中" → 不再等待（否则会一直等一个卡死的启动）
    startLease(pid, {
      startedAt: Date.now() - 120_000,
      hosts: [{ pid: process.pid, seenAt: Date.now() }],
    });
    check("超过等待窗口的启动中租约 → 不认", findStarting(60_000) === undefined);
  } finally {
    clearLease(pid);
    live.kill();
  }
}

// ---------- 5. 窗口登记：幂等、清理死窗口、摘除 ----------

{
  const live = aliveChild();
  const pid = live.pid as number;
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => dead.on("close", resolve));
  const deadPid = dead.pid as number;
  try {
    // 先塞一个已经死掉的窗口记录（并把自己那条的心跳弄陈旧，验证 registerHost 会刷新它）
    startLease(pid, {
      baseUrl: "http://127.0.0.1:2222",
      token: "tok-b",
      hosts: [
        { pid: deadPid, seenAt: Date.now() },
        { pid: process.pid, seenAt: Date.now() - HOST_STALE_MS - 5_000 },
      ],
    });

    registerHost(pid, { pid: process.pid, workspace: "D:/dev/dsh-chat", seenAt: Date.now() });
    const after = readLeases().find((item) => item.lease.serverPid === pid)!.lease;
    const hosts = leaseHosts(after);
    check("登记后死窗口的记录被清掉", !hosts.some((host) => host.pid === deadPid));
    check("登记后只剩自己一条（并刷新了心跳）", hosts.length === 1 && hosts[0].pid === process.pid);
    check("登记是幂等的（再来一次还是一条）", (() => {
      registerHost(pid, { pid: process.pid, seenAt: Date.now() });
      return leaseHosts(readLeases().find((item) => item.lease.serverPid === pid)!.lease).length === 1;
    })());

    touchHost(pid);
    check("只刷心跳不增删记录", leaseHosts(readLeases().find((item) => item.lease.serverPid === pid)!.lease).length === 1);

    // "最后一个"的判据与 pid 无关：由各实例的心跳文件决定
    writeHostLease({ hostId: "solo", serverPid: pid });
    check("有实例心跳 → 有人在用", hasLiveHostFor(pid));
    writeHostLease({ hostId: "mate", serverPid: pid });
    check("多了一个实例的心跳 → 依然有人在用", hasLiveHostFor(pid));
    clearHostLease("mate");
    check("另一个实例停更后仍有人在用（solo 还在）", hasLiveHostFor(pid));
    clearHostLease("solo");
    check("两个都停更 → 没人用了", !hasLiveHostFor(pid));

    // 摘掉自己的登记（租约里那条按 pid 的记录），心跳文件才是"还有没有实例在用"的判据
    removeHost(pid);
    check("摘除后自己不在 hosts 里", leaseHosts(readLeases().find((item) => item.lease.serverPid === pid)!.lease).length === 0);
    check("心跳文件都没了 → 无人使用（可回收）", !hasLiveHostFor(pid));
  } finally {
    clearLease(pid);
    live.kill();
  }
}

// ---------- 6. 多实例：一个实例停更后，另一个仍是"最后一个" ----------

{
  const live = aliveChild();
  const pid = live.pid as number;
  try {
    startLease(pid, { baseUrl: "http://127.0.0.1:3333", token: "tok-c" });
    writeHostLease({ hostId: "win-a", serverPid: pid, workspace: "D:/dev/a" });
    writeHostLease({ hostId: "win-b", serverPid: pid, workspace: "D:/dev/b" });
    check("两个实例在用 → 还有别的实例", hasLiveHostFor(pid));
    check("liveHostIds 里能看到两个", liveHostIds().filter((id) => id.startsWith("win-")).length === 2);

    // 关掉一个窗口（或禁用它那个窗口的扩展）：只有它的心跳停更
    clearHostLease("win-a");
    check("一个实例停更后 → 另一个仍算在用", hasLiveHostFor(pid));

    clearHostLease("win-b");
    check("所有实例都停更 → 不再有人使用", !hasLiveHostFor(pid));
  } finally {
    clearLease(pid);
    live.kill();
  }
}

// ---------- 7. 崩溃处置：dropDeadLeases 删租约但不动进程 ----------

{
  const alive = aliveChild();
  const alivePid = alive.pid as number;
  const gone = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => gone.on("close", resolve));
  const gonePid = gone.pid as number;
  try {
    startLease(gonePid, { baseUrl: "http://127.0.0.1:4444", token: "tok-d" });
    startLease(alivePid, {
      baseUrl: "http://127.0.0.1:4445",
      token: "tok-e",
      hosts: [{ pid: process.pid, seenAt: Date.now() }],
    });
    // 权威判据是心跳文件（生产代码里由 ServerManager 写）：这个后台"有人用"
    writeHostLease({ hostId: "keep-alive", serverPid: alivePid });
    const dropped = dropDeadLeases();
    const remaining = readLeases().map((item) => item.lease.serverPid);
    check("进程已退出的租约被删", !remaining.includes(gonePid), `dropped=${dropped}`);
    check("有活窗口的租约保留", remaining.includes(alivePid));

    // 进程还在、只是没人用：**这个函数不删**（判据只认"进程不在"，见它的注释）——
    // 那种遗留后台要留给接管逻辑去用，删早了就再也找不回来
    removeHost(alivePid);
    clearHostLease("keep-alive");
    dropDeadLeases();
    check(
      "进程还活着的租约不被 dropDeadLeases 删掉（留给接管）",
      readLeases().some((item) => item.lease.serverPid === alivePid),
    );
    check("dropDeadLeases 不杀进程（进程仍在）", alive.exitCode === null);
  } finally {
    clearLease(alivePid);
    clearLease(gonePid);
    alive.kill();
  }
}

// ---------- 8. 启动锁：独占、可重入等待、残留锁清理 ----------

{
  const lockFile = join(LEASE_DIR, "start.lock");
  rmSync(lockFile, { force: true });

  const unlock = await acquireStartLock(1_000);
  check("第一次抢锁成功", typeof unlock === "function");
  // 内容必须是**纯 pid 文本**：写成 JSON 时 readLockPid 会判成坏锁并清掉，
  // 于是锁形同虚设（实测踩过的坑，这条断言就是钉它的）
  check("锁文件内容是一行纯 pid", readFileSync(lockFile, "utf8") === String(process.pid), readFileSync(lockFile, "utf8"));

  // 持有者是自己（活着）→ 第二次抢锁会等到超时
  const blocked = await acquireStartLock(800);
  check("锁被活着的进程持有时，第二次抢锁超时返回 undefined", blocked === undefined);
  check("抢锁失败时不能把别人的锁删掉", existsSync(lockFile));

  unlock?.();
  check("解锁后锁文件消失", !existsSync(lockFile));

  // 残留锁：写一个已死进程的 pid → 应当被清掉并抢到
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => dead.on("close", resolve));
  writeFileSync(lockFile, String(dead.pid), "utf8");
  const afterStale = await acquireStartLock(1_000);
  check("残留锁（持有者已死）被清掉并抢到", typeof afterStale === "function");
  afterStale?.();

  // 内容坏掉（读不出 pid）→ 也当残留处理
  writeFileSync(lockFile, "not json", "utf8");
  const afterBroken = await acquireStartLock(1_000);
  check("坏掉的锁文件被清掉并抢到", typeof afterBroken === "function");
  afterBroken?.();
  rmSync(lockFile, { force: true });
}

// ---------- 9. netstat 解析：端口兜底靠它找到真正的监听者 ----------

{
  // 真实 `netstat -ano -p TCP` 的片段（IPv4/IPv6、状态列、末尾 pid）
  const sample = [
    "  TCP    127.0.0.1:14302        0.0.0.0:0              LISTENING       123780",
    "  TCP    127.0.0.1:14302        127.0.0.1:1168         TIME_WAIT       0",
    "  TCP    [::1]:14302            [::]:0                 LISTENING       123781",
    "  TCP    127.0.0.1:3080         0.0.0.0:0              LISTENING       555",
    "  TCP    127.0.0.1:143021       0.0.0.0:0              LISTENING       999",
  ].join("\r\n");

  const owners = parseListeningPids(sample, 14302);
  check(
    "只认 LISTENING，且带上 IPv4/IPv6 两个监听者",
    owners.length === 2 && owners.includes(123780) && owners.includes(123781),
    `owners=${JSON.stringify(owners)}`,
  );
  check(
    "端口号不做前缀匹配（143021 不该被当成 14302）",
    !parseListeningPids(sample, 143021).includes(999) || parseListeningPids(sample, 143021).length === 1,
  );
  check("不匹配的端口返回空", parseListeningPids(sample, 4444).length === 0);
  check("pid 0（TIME_WAIT 行）不会被当成目标", !owners.includes(0));

  // 真实机器上跑一次（Windows 才有 netstat -ano 的这种输出）
  const port = 14302;
  const live = parseListeningPidsSync(port);
  check("本机同步查端口不抛错（当前大概率没人监听）", Array.isArray(live), `listeners=${JSON.stringify(live)}`);
}

// ---------- 10. 心跳文件：按实例记，"被禁用"才可能被发现 ----------

{
  const fakeServer = aliveChild();
  // 这一节的判据是"还有没有活实例"，但 `isOrphanLease` 现在还会问"端口有没有人在听"
  // （`isServiceable` 里的 TCP 探测）。要让结论只由心跳决定，就把租约写成
  // **进程已不在 + 端口没人听**的形状：用一个真实存在过的死 pid 当 serverPid。
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve) => dead.on("close", resolve));
  const deadPid = dead.pid as number;
  try {
    startLease(deadPid, {
      baseUrl: "http://127.0.0.1:1",
      token: "tok-h",
      startedAt: Date.now() - STARTING_GRACE_MS - 1_000,
    });
    const leaseOf = () => readLeases().find((item) => item.lease.serverPid === deadPid)!.lease;
    check("没有心跳文件时，租约里也没有活窗口 → 视为孤儿", isOrphanLease(leaseOf()));

    writeHostLease({ hostId: "host-a", serverPid: deadPid, workspace: "D:/dev/a" });
    writeHostLease({ hostId: "host-b", serverPid: deadPid, workspace: "D:/dev/b" });
    check("两个实例写了心跳 → 不是孤儿", !isOrphanLease(leaseOf()));
    check("liveHostIds 数出两个实例", liveHostIds().filter((id) => id.startsWith("host-")).length === 2);

    // 模拟"一个窗口的扩展被禁用"：它不再刷心跳 → 判死（这是 pid 判据做不到的）
    clearHostLease("host-a");
    const stillThere = liveHostIds().includes("host-a");
    check("被禁用的实例不再算活着", !stillThere);
    check("另一个实例仍在 → 后台仍不算孤儿", !isOrphanLease(leaseOf()));

    clearHostLease("host-b");
    check("所有实例都停了 → 变成孤儿（等待下一次激活回收）", isOrphanLease(leaseOf()));

    // 陈旧心跳文件也要被清掉
    writeHostLease({ hostId: "host-stale", serverPid: deadPid });
    const hostFile = join(LEASE_DIR, "hosts", "host-stale.json");
    writeFileSync(hostFile, JSON.stringify({ hostId: "host-stale", serverPid: deadPid, seenAt: Date.now() - HOST_STALE_MS - 1000 }), "utf8");
    const dropped = dropStaleHostLeases();
    check("陈旧心跳文件被清理", dropped.includes("host-stale"), `dropped=${JSON.stringify(dropped)}`);
  } finally {
    clearLease(deadPid);
    clearHostLease("host-a");
    clearHostLease("host-b");
    fakeServer.kill();
  }
}

// ---------- 11. 租约目录里的杂散 JSON 不能被当成租约 ----------

{
  // 实测教训：探针的握手文件（也有 serverPid 字段）混进租约目录，被当真租约读了出来，
  // 于是"有几个后台""还有没有后台"全线失真（数出两个后台，其实是同一份）。
  const stray = join(LEASE_DIR, "stray.json");
  writeFileSync(stray, JSON.stringify({ baseUrl: "http://127.0.0.1:1", serverPid: 999, ready: true }), "utf8");
  check("形状不符的 JSON 不被当成租约", !readLeases().some((item) => item.file === stray));
  check("也不会被误删（不碰别人的文件）", existsSync(stray));
  rmSync(stray, { force: true });

  // 子目录（hosts/ 里的心跳）同样不能被当成租约
  writeHostLease({ hostId: "shape-check", serverPid: GHOST_PID, baseUrl: "http://127.0.0.1:1", token: "t" });
  check(
    "hosts/ 下的心跳不被当成租约",
    !readLeases().some((item) => item.lease.serverPid === GHOST_PID),
    `租约=${JSON.stringify(readLeases().map((item) => item.lease.serverPid))}`,
  );
  clearHostLease("shape-check");
}

// ---------- 12. 配置分组：不同有效配置的窗口不许共享后台 ----------

{
  // 用户口径（2026-09-14）：设置是有作用域的，A/B 工作区各自写"内部"、全局是"外部"，
  // 那就只有 A/B 该共用一个后台，其余窗口走外部。靠"按有效配置分组"实现。
  const groupA = leaseDirectory();
  const serverPid = GHOST_PID;
  startLease(serverPid, { baseUrl: "http://127.0.0.1:1", token: "tok-g" });
  check("默认组里能看到这条租约", readLeases().some((item) => item.lease.serverPid === serverPid));

  setLeaseGroup("another-group");
  check("换组后租约目录真的变了", leaseDirectory() !== groupA, `${groupA} → ${leaseDirectory()}`);
  check(
    "换组后读不到别组的租约（配置不同的窗口不会互相抢后台）",
    !readLeases().some((item) => item.lease.serverPid === serverPid),
  );

  // 在别组写一条，两边互不可见
  startLease(serverPid + 1, { baseUrl: "http://127.0.0.1:2", token: "tok-h" });
  check("别组里有自己的租约", readLeases().length === 1);
  setLeaseGroup("default");
  const back = readLeases().map((item) => item.lease.serverPid);
  check("切回原组只看到原组那条", back.includes(serverPid) && !back.includes(serverPid + 1), `看到=${JSON.stringify(back)}`);

  // 组名做文件系统安全过滤：非法字符不落成怪路径
  setLeaseGroup("a/b\\c:d");
  check("组名里的非法字符被过滤", !/[\\/:]/.test(leaseDirectory().slice(groupA.length)), leaseDirectory());
  setLeaseGroup("default");
  clearLease(serverPid);
  setLeaseGroup("another-group");
  clearLease(serverPid + 1);
  setLeaseGroup("default");
}

// ---------- 13. 残留后台的接管：为什么不能只认"心跳能证明主人已死" ----------

{
  // 用户 2026-09-13 报的「残留后台不被接管」：判决依赖进程表查询，而查询可能给不出结论
  // （心跳文件丢失、pid 被回收、查询被挡），于是新窗口去起一个新的、撞上端口占用。
  // 修法是把"接不接"交给**实测 HTTP**，这里钉住为此新增的两个兜底取数。
  const serverPid = GHOST_PID + 10;
  const url = "http://127.0.0.1:59999";
  startLease(serverPid, { baseUrl: url, token: "tok-leftover" });

  // 13.1 只剩租约（心跳丢了）也要能被找到
  check(
    "只剩租约时也能给出接管候选（这是缺陷现场的那条路径）",
    findServingLeftoverLease()?.serverPid === serverPid,
    `拿到=${JSON.stringify(findServingLeftoverLease()?.serverPid)}`,
  );

  // 13.2 但"还有活窗口在用"时不能动它：那属于别人正在用的共享后台
  writeHostLease({ hostId: "still-using", serverPid, baseUrl: url, token: "tok-leftover" });
  registerHost(serverPid, { pid: process.pid, workspace: "D:/dev/dsh-chat", seenAt: Date.now() });
  check("有活窗口在用 → 不再是「可接管的遗留」", findServingLeftoverLease()?.serverPid !== serverPid);
  clearHostLease("still-using");
  removeHost(serverPid);
  check("窗口退出后 → 又变回可接管", findServingLeftoverLease()?.serverPid === serverPid);

  // 13.3 采纳候选列表里必须**包含**它（哪怕首选判据说"主人还活着"）：
  // 心跳里写一个活着的 pid，首选判据会认为"还有人用"，兜底列表绝不能因此漏掉它。
  writeHostLease({
    hostId: "reused-pid",
    serverPid,
    baseUrl: url,
    token: "tok-leftover",
    command: "dsh web --port 0 --no-open",
  });
  const fallback = findAdoptCandidates("dsh web --port 0 --no-open").map((item) => item.serverPid);
  check("兜底候选包含这条记录", fallback.includes(serverPid), `候选=${JSON.stringify(fallback)}`);
  check(
    "命令不一致的记录不进候选（防误接别人的后台）",
    findAdoptCandidates("dsh web --port 3000 --no-open").length === 0,
  );
  clearHostLease("reused-pid");

  // 13.4 心跳里必须记下"写它的进程启动时刻"：pid 被回收时，这是唯一的辨别依据
  writeHostLease({ hostId: "stamp-check", serverPid, baseUrl: url, token: "tok-leftover" });
  const stampRaw = JSON.parse(readFileSync(join(LEASE_DIR, "hosts", "stamp-check.json"), "utf8")) as {
    ownerStartedAt?: number;
    pid?: number;
  };
  check(
    "心跳记下了写它的进程启动时刻（判 pid 复用用）",
    typeof stampRaw.ownerStartedAt === "number" && stampRaw.ownerStartedAt > 0 &&
      stampRaw.ownerStartedAt <= Date.now() && stampRaw.pid === process.pid,
    `ownerStartedAt=${stampRaw.ownerStartedAt} pid=${stampRaw.pid}`,
  );
  clearHostLease("stamp-check");
  clearLease(serverPid);
}

// ---------- 收尾：整个临时租约目录删掉（本文件全程只用它，不会碰到用户的租约） ----------

clearLease(GHOST_PID);
for (const pid of created) clearLease(pid);
rmSync(TEST_LEASE_DIR, { recursive: true, force: true });

console.log(failures === 0 ? "\nsharedLease: all assertions passed" : `\nsharedLease: ${failures} 项未通过`);
if (failures > 0) process.exitCode = 1;
