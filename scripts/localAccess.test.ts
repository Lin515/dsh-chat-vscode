/**
 * 本地 FS 访问层（`src/dsh/localAccess.ts`）：有界等待、全局未完成操作上限与信任门。
 *
 * 这一层是「工作区外的发现」的地基（见 `docs/design-mentions.md`「信任门」与「补充决策」）：
 *
 * - **一次查询一条预算**（默认 1500ms），信任门、抑制判定、路径检查与目录读取共用；
 * - **全局未完成操作有上界**：Node 的 fs 调用取消不了，UNC / 映射盘挂死时只能放弃等待、
 *   把槽位留给底层操作自己结算，否则 libuv 默认那 4 个 FS worker 会被连续输入的探针占满；
 * - **门只缓存肯定的通过结果**：超时 / 未知 / 不存在的 cwd 不进缓存，网络短暂恢复后还能
 *   再试；迟到（查询已作废 / 预算已耗尽）的 ok 结果不许写缓存。
 *
 * 全部用注入的假 FS 或纯计算，不碰真实磁盘、不连任何共享。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import {
  classifyFsFailure,
  GATE_CACHE_LIMIT,
  isNativeAbsolutePath,
  LOCAL_FS_BUDGET_MS,
  LocalAccessGate,
  LocalFsBudget,
  MAX_PENDING_FS_OPS,
  pendingFsOperations,
  probeExistence,
  unsupportedLocalPathForm,
  withinBudget,
  type FsProbe,
  type FsStatsLike,
} from "../src/dsh/localAccess";

process.on("unhandledRejection", (error) => {
  console.error("[localAccess] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

/** 让排队的微任务 / 定时器先跑完（模拟「下一帧」）。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const stats = (kind: "dir" | "file" | "symlink"): FsStatsLike => ({
  isDirectory: () => kind === "dir",
  isFile: () => kind === "file",
  isSymbolicLink: () => kind === "symlink",
});

const missing = (code: string) => Object.assign(new Error(code), { code });

/** 只回答 stat 的假 FS（其余方法用不到就抛，避免「悄悄用了别的路」）。 */
function statOnly(handler: (path: string) => Promise<FsStatsLike>): FsProbe {
  return {
    stat: handler,
    async lstat() {
      throw missing("ENOENT");
    },
    async readdir() {
      throw missing("ENOENT");
    },
  };
}

console.log("localAccess: 有界等待 / 全局未完成上限 / 信任门");

// ---------- 1. 预算：一条查询一条，不逐步重置 ----------
{
  const budget = new LocalFsBudget(100);
  assert.strictEqual(LOCAL_FS_BUDGET_MS, 1500, "总预算是 1500ms（覆盖信任门、抑制判定与目录读取）");
  assert.ok(budget.remaining() <= 100 && budget.remaining() > 0, "剩余时间随构造时刻起算");
  assert.strictEqual(budget.expired(), false, "刚建出来没过期");
  assert.strictEqual(budget.usable(), true, "既没过期也没作废时可用");

  const expired = new LocalFsBudget(0);
  assert.strictEqual(expired.expired(), true, "0 预算当场耗尽");
  assert.strictEqual(expired.usable(), false);

  const controller = new AbortController();
  const cancellable = new LocalFsBudget(10_000, { signal: controller.signal });
  assert.strictEqual(cancellable.cancelled(), false);
  controller.abort();
  assert.strictEqual(cancellable.cancelled(), true, "查询作废（新的一次 @ 查询）立刻反映到预算上");
  assert.strictEqual(cancellable.usable(), false, "作废的预算不再可用（排队中的 FS 调用连启动都不启动）");
}

// ---------- 2. withinBudget：收场 ----------
{
  assert.deepStrictEqual(
    await withinBudget(new LocalFsBudget(1000), async () => "ok"),
    { ok: true, value: "ok" },
    "正常完成的操作为 ok",
  );
  const failure = await withinBudget(new LocalFsBudget(1000), async () => {
    throw missing("EACCES");
  });
  assert.strictEqual(failure.ok, false);
  assert.strictEqual(failure.ok === false ? failure.reason : "", "error", "抛错归 error（调用方按「没有证据」处理）");
  assert.deepStrictEqual(
    await withinBudget(new LocalFsBudget(0), async () => {
      throw new Error("不该被调用");
    }),
    { ok: false, reason: "timeout" },
    "预算已耗尽时连底层操作都不启动",
  );
}

// ---------- 3. 挂死的操作有上界：只放弃等待，槽位等底层结算 ----------
{
  const baseline = pendingFsOperations();
  const releases: (() => void)[] = [];
  const hung = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releases.push(resolve);
    });
  const outcomes = await Promise.all([
    withinBudget(new LocalFsBudget(30), hung),
    withinBudget(new LocalFsBudget(30), hung),
    withinBudget(new LocalFsBudget(30), hung),
    withinBudget(new LocalFsBudget(30), hung),
  ]);
  assert.ok(outcomes.every((outcome) => !outcome.ok), "挂死的操作按超时收场（结果丢弃）");
  assert.strictEqual(
    releases.length,
    MAX_PENDING_FS_OPS,
    `超时后只有 ${MAX_PENDING_FS_OPS} 个底层操作真的启动过（排队者在预算耗尽时放弃）`,
  );
  assert.strictEqual(
    pendingFsOperations(),
    baseline + MAX_PENDING_FS_OPS,
    "槽位挂在底层操作上：超时不再新增，未完成操作数有上界",
  );
  for (const release of releases) release();
  await tick();
  assert.strictEqual(pendingFsOperations(), baseline, "底层操作结算后槽位归还（不会永久泄漏）");
}

// ---------- 3b. 排队者：接棒、作废 / 超时后不启动 ----------
//
// 第 3 节测的是「挂满之后超时」，这一节补的是**排队那一侧**的行为：槽位空出来时排队者
// 接棒（计数不变、直接转交），以及预算耗尽 / 查询作废时它**连底层操作都不启动**
// ——「未完成操作有界」的另一半（见 `localAccess.ts` 的 `acquireSlot` / `releaseSlot`）。
{
  const baseline = pendingFsOperations();
  const started: string[] = [];
  /** 每次调用都记一笔「谁启动了」，并留一个可释放的 deferred（不挂死、收尾能清干净）。 */
  const held = (tag: string) => () =>
    new Promise<string>((resolve) => {
      started.push(tag);
      releases.push(() => resolve(tag));
    });
  const releases: Array<() => void> = [];

  const occupied = [
    withinBudget(new LocalFsBudget(5_000), held("a")),
    withinBudget(new LocalFsBudget(5_000), held("b")),
  ];
  await tick();
  assert.deepStrictEqual(started, ["a", "b"], "前提：两个全局槽位被占满");
  assert.strictEqual(pendingFsOperations(), baseline + MAX_PENDING_FS_OPS);

  // 1) 接棒：排队者拿到释放的槽位、真的启动、正常结算
  const handoff = withinBudget(new LocalFsBudget(5_000), held("c"));
  await tick();
  assert.deepStrictEqual(started, ["a", "b"], "槽位满时排队者不启动底层操作");
  releases[0]?.();
  assert.deepStrictEqual(await occupied[0], { ok: true, value: "a" }, "释放的那个操作正常结算");
  await tick();
  assert.deepStrictEqual(started, ["a", "b", "c"], "槽位释放后排队者接棒并真的启动");
  assert.strictEqual(pendingFsOperations(), baseline + MAX_PENDING_FS_OPS, "转交不算新占：计数不变");
  releases[2]?.();
  assert.deepStrictEqual(await handoff, { ok: true, value: "c" }, "接棒者正常结算（槽位直接转交给它）");
  releases[1]?.();
  assert.deepStrictEqual(await occupied[1], { ok: true, value: "b" });
  await tick();
  assert.strictEqual(pendingFsOperations(), baseline, "全部结算后槽位归还");

  // 2) 排队者作废：连底层操作都不启动（不给没人要的探针抢槽位）
  const occupied2 = [
    withinBudget(new LocalFsBudget(5_000), held("d")),
    withinBudget(new LocalFsBudget(5_000), held("e")),
  ];
  await tick();
  const abortedController = new AbortController();
  const queuedAborted = withinBudget(
    new LocalFsBudget(5_000, { signal: abortedController.signal }),
    held("f"),
  );
  await tick();
  assert.ok(!started.includes("f"), "排队中的操作还没启动");
  abortedController.abort();
  assert.deepStrictEqual(await queuedAborted, { ok: false, reason: "cancelled" }, "排队者作废立刻收场");
  assert.ok(!started.includes("f"), "作废的排队者自始至终没启动底层操作");

  // 3) 排队者预算耗尽：同样不启动
  const queuedExpired = withinBudget(new LocalFsBudget(30), held("g"));
  await tick();
  assert.deepStrictEqual(await queuedExpired, { ok: false, reason: "timeout" }, "排队者预算耗尽后放弃等待");
  assert.ok(!started.includes("g"), "预算耗尽的排队者不启动底层操作");

  // 收尾：放掉还占着槽位的两个操作，把全局计数还给基线（后面的用例不隐式依赖空余槽位）
  for (const release of releases.slice(3)) release();
  assert.deepStrictEqual(await Promise.all(occupied2), [
    { ok: true, value: "d" },
    { ok: true, value: "e" },
  ]);
  await tick();
  assert.strictEqual(pendingFsOperations(), baseline, "收尾后槽位全部归还（不留隐式依赖）");
}

// ---------- 4. 作废 / 过期后的 ok 结果一律丢弃（不许写缓存） ----------
{
  // 4a. 已启动后作废：立刻收场，槽位等底层结算
  const controller = new AbortController();
  const budget = new LocalFsBudget(10_000, { signal: controller.signal });
  let releaseOp: ((value: string) => void) | undefined;
  const pending = withinBudget(budget, () => new Promise<string>((resolve) => {
    releaseOp = resolve;
  }));
  const baseline = pendingFsOperations();
  await tick();
  assert.ok(releaseOp, "前提：底层操作已经启动（这时才谈得上「作废后仍占槽」）");
  controller.abort();
  assert.deepStrictEqual(await pending, { ok: false, reason: "cancelled" }, "作废立刻放弃等待（不占着调用方）");
  assert.strictEqual(pendingFsOperations(), baseline, "槽位仍在底层操作手里（不提前释放）");
  releaseOp?.("迟到");
  await tick();
  assert.strictEqual(pendingFsOperations(), baseline - 1, "底层操作结算后才归还槽位");

  // 4b. 事件循环被阻塞到超过 deadline，底层操作「恰好先回来」也不算数
  const blocked = new LocalFsBudget(50);
  let releaseLate: ((value: string) => void) | undefined;
  const late = withinBudget(blocked, () => new Promise<string>((resolve) => {
    releaseLate = resolve;
  }));
  await tick();
  assert.ok(releaseLate, "前提：底层操作已经启动");
  const until = Date.now() + 80;
  while (Date.now() < until) {
    // 空转：把事件循环占住，让 deadline 过去而定时器回调还没轮到
  }
  releaseLate?.("其实已经过期");
  assert.deepStrictEqual(
    await late,
    { ok: false, reason: "timeout" },
    "收场时再查一次预算：过期之后回来的 ok 不算证据（否则会被写进门的缓存）",
  );
}

// ---------- 5. 三态存在性 ----------
{
  assert.strictEqual(classifyFsFailure(missing("ENOENT")), "absent", "ENOENT 是肯定的「不存在」");
  assert.strictEqual(classifyFsFailure(missing("ENOTDIR")), "absent", "路径中有一段不是目录也是肯定的「不存在」");
  assert.strictEqual(classifyFsFailure(missing("EACCES")), "unknown", "权限问题只是「不知道」");
  assert.strictEqual(classifyFsFailure(missing("ETIMEDOUT")), "unknown", "离线共享同样是「不知道」");
  assert.strictEqual(classifyFsFailure(undefined), "unknown");

  assert.strictEqual(
    await probeExistence("D:/x", new LocalFsBudget(1000), statOnly(async () => stats("file"))),
    "present",
  );
  assert.strictEqual(
    await probeExistence("D:/x", new LocalFsBudget(1000), statOnly(async () => {
      throw missing("ENOENT");
    })),
    "absent",
  );
  assert.strictEqual(
    await probeExistence("D:/x", new LocalFsBudget(1000), statOnly(async () => {
      throw missing("EACCES");
    })),
    "unknown",
  );
  assert.strictEqual(
    await probeExistence(
      "D:/x",
      new LocalFsBudget(10),
      // 200ms 才回来的操作：预算 10ms 内拿不到证据 → unknown；它自己稍后结算并归还槽位
      statOnly(() => new Promise<FsStatsLike>((resolve) => setTimeout(() => resolve(stats("file")), 200))),
    ),
    "unknown",
    "超时按 unknown 收（不猜）",
  );
}

// ---------- 6. 宿主形态判据 ----------
{
  for (const path of ["D:/dev", "D:\\dev", "d:/dev", "//server/share/dev", "\\\\server\\share\\dev"]) {
    assert.strictEqual(isNativeAbsolutePath(path, "win32"), true, `"${path}" 是 Windows 原生绝对形态`);
  }
  for (const path of ["D:", "D:dev", "//server", "//server/", "//", "/home/u", "src/dev"]) {
    assert.strictEqual(isNativeAbsolutePath(path, "win32"), false, `"${path}" 不是可列举的 Windows 根`);
  }
  for (const path of ["//?/UNC/server/share", "\\\\?\\C:\\dev", "\\\\.\\C:\\dev"]) {
    assert.strictEqual(
      isNativeAbsolutePath(path, "win32"),
      false,
      `"${path}" 是设备 / 扩展长度命名空间：本轮不支持（解析出来的根不是共享名）`,
    );
  }
  assert.strictEqual(isNativeAbsolutePath("/home/u", "posix"), true);
  assert.strictEqual(isNativeAbsolutePath("D:/dev", "posix"), false, "POSIX 宿主上盘符形态判假");
  assert.strictEqual(isNativeAbsolutePath("", "win32"), false);

  // 不支持的根 / 盘符形态（`unsupportedLocalPathForm`）：判据是**纯字符串**的，两条消费
  // 路径（`fileRefListing.listingTarget` 与 `controller.mentionResolves`）都用它，
  // 所以在这里逐字钉住两个平台的答案。
  for (const path of ["/foo", "\\foo", "/foo/", "/", "D:foo", "D:", "//server/", "//", "\\\\.\\C:\\dev", "\\\\?\\C:\\dev"]) {
    assert.strictEqual(
      unsupportedLocalPathForm(path, "win32"),
      true,
      `"${path}" 是 Windows 上不支持的根 / 盘符形态：不做本地解释`,
    );
  }
  for (const path of ["", "src/a.ts", "../x", "sub\\dir", "D:/dev", "D:\\dev", "//server/share", "//server/share/dev"]) {
    assert.strictEqual(
      unsupportedLocalPathForm(path, "win32"),
      false,
      `"${path}" 是普通相对形态或合法绝对形态：照旧本地解释`,
    );
  }
  assert.strictEqual(unsupportedLocalPathForm("D:/dev", "posix"), true, "POSIX 宿主上盘符写法不做本地解释");
  assert.strictEqual(unsupportedLocalPathForm("\\\\.\\C:\\dev", "posix"), true, "POSIX 宿主上设备命名空间同理");
  assert.strictEqual(unsupportedLocalPathForm("/home/u/proj", "posix"), false, "POSIX 宿主上原生绝对形态照旧");
  assert.strictEqual(unsupportedLocalPathForm("src/a.ts", "posix"), false, "普通相对路径不受影响");
  assert.strictEqual(unsupportedLocalPathForm("", "posix"), false, "空串不是形态问题（由调用方各自判空）");
}

// ---------- 7. 信任门：形状 + 证据 + 缓存 ----------
{
  /**
   * 建一个记账的门：`handler` 是这次 stat 的答案，`calls()` 是真实发出去的 stat 次数。
   */
  const build = (handler: () => Promise<FsStatsLike>) => {
    let calls = 0;
    const instance = new LocalAccessGate({
      platform: "win32",
      fs: statOnly(async () => {
        calls += 1;
        return handler();
      }),
    });
    return { instance, calls: () => calls };
  };

  // 7a. 形状不过：一次 FS 调用都不发
  {
    const shape = build(async () => stats("dir"));
    for (const cwd of ["/home/u/proj", "//server", "D:", "relative/path", ""]) {
      assert.strictEqual(await shape.instance.allows(cwd, new LocalFsBudget(1000)), false, `"${cwd}" 形状不过 → 门关`);
    }
    assert.strictEqual(shape.calls(), 0, "形状判据零 FS 成本（不拿不像本机路径的 cwd 去 stat）");
  }

  // 7b. 证据：只有明确是目录才算通过；不存在 / 不是目录 / 权限问题 / 超时一律判关
  {
    const dir = build(async () => stats("dir"));
    assert.strictEqual(await dir.instance.allows("D:/dev/proj", new LocalFsBudget(1000)), true, "本机真目录 → 门开");
    assert.strictEqual(dir.instance.size, 1, "通过的结果进缓存");
    assert.strictEqual(await dir.instance.allows("D:/dev/proj", new LocalFsBudget(1000)), true);
    assert.strictEqual(dir.calls(), 1, "同一条 cwd 第二次直接命中缓存（不再 stat）");
  }
  const denials: [string, () => Promise<FsStatsLike>][] = [
    ["文件", async () => stats("file")],
    ["不存在", async () => {
      throw missing("ENOENT");
    }],
    ["权限问题", async () => {
      throw missing("EACCES");
    }],
  ];
  for (const [name, handler] of denials) {
    const denied = build(handler);
    assert.strictEqual(await denied.instance.allows("D:/dev/proj", new LocalFsBudget(1000)), false, `${name} → 门关`);
    assert.strictEqual(denied.instance.size, 0, `${name} 不进缓存（网络 / 权限抖动之后还能再试）`);
    assert.strictEqual(await denied.instance.allows("D:/dev/proj", new LocalFsBudget(1000)), false);
    assert.strictEqual(denied.calls(), 2, `${name} 第二次仍要重新 stat（负结果不缓存）`);
  }
  {
    // 挂死的 stat：超时收场，但槽位仍挂在它手里（不提前释放）；用**可释放的** deferred
    // 而不是永久 pending 的 Promise——否则这个槽位会一直占到用例结束，后面几节隐式
    // 依赖「还剩一个空槽」而自己不知道（见 7d 与第 3b 节）。
    const baseline = pendingFsOperations();
    let releaseSlow: ((value: FsStatsLike) => void) | undefined;
    const slow = build(() => new Promise<FsStatsLike>((resolve) => {
      releaseSlow = resolve;
    }));
    assert.strictEqual(await slow.instance.allows("D:/dev/proj", new LocalFsBudget(10)), false, "超时 → 门关");
    assert.strictEqual(slow.instance.size, 0, "超时同样不缓存");
    assert.ok(releaseSlow, "前提：底层 stat 真的启动过（超时只放弃等待，不取消底层操作）");
    assert.strictEqual(pendingFsOperations(), baseline + 1, "槽位仍挂在未结算的底层操作上");
    releaseSlow?.(stats("dir"));
    await tick();
    assert.strictEqual(pendingFsOperations(), baseline, "底层结算后归还槽位");
  }

  // 7c. 作废 / 耗尽的预算不给通过结果：缓存命中也一样
  {
    const cached = build(async () => stats("dir"));
    assert.strictEqual(await cached.instance.allows("D:/dev/proj", new LocalFsBudget(1000)), true);
    const controller = new AbortController();
    const budget = new LocalFsBudget(1000, { signal: controller.signal });
    controller.abort();
    assert.strictEqual(
      await cached.instance.allows("D:/dev/proj", budget),
      false,
      "已经作废的查询不许拿到门（哪怕缓存里就是通过）",
    );
    assert.strictEqual(await cached.instance.allows("D:/dev/proj", new LocalFsBudget(0)), false, "预算耗尽同理");
  }

  // 7d. FS 启动后作废、随后才回来：不许允许、也不许写缓存
  //
  // 「启动了」这一步必须**等到**：`allows` 返回后立刻 abort 时，`withinBudget` 还停在
  // `await acquireSlot(...)` 那一跳上，底层 stat 一次都没跑——那样这条断言测的是
  // 「作废前就没启动」，槽位与缓存两条都空转（见第 3b 节：那才是「排队者作废不启动」）。
  {
    const baseline = pendingFsOperations();
    let releaseStat: ((value: FsStatsLike) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gateSlow = new LocalAccessGate({
      platform: "win32",
      fs: statOnly(() => {
        markStarted?.();
        return new Promise<FsStatsLike>((resolve) => {
          releaseStat = resolve;
        });
      }),
    });
    const controller = new AbortController();
    const budget = new LocalFsBudget(10_000, { signal: controller.signal });
    const pending = gateSlow.allows("D:/dev/proj", budget);
    await began;
    assert.ok(releaseStat, "前提：底层 stat 已经启动（这时才谈得上「作废后仍占槽」）");
    assert.strictEqual(pendingFsOperations(), baseline + 1, "未结算的 stat 占着一个槽位");
    controller.abort();
    assert.strictEqual(await pending, false, "作废立刻收场（不等那次 stat）");
    assert.strictEqual(pendingFsOperations(), baseline + 1, "槽位仍在底层操作手里（不提前释放）");
    releaseStat?.(stats("dir"));
    await tick();
    assert.strictEqual(pendingFsOperations(), baseline, "底层结算后归还槽位");
    assert.strictEqual(gateSlow.size, 0, "迟到的肯定结果不许写进缓存（它属于一条已作废的查询）");
  }

  // 7e. 缓存有界（按插入顺序淘汰最老的）
  {
    const bounded = build(async () => stats("dir"));
    for (let index = 0; index < GATE_CACHE_LIMIT + 5; index += 1) {
      await bounded.instance.allows(`D:/dev/p${index}`, new LocalFsBudget(1000));
    }
    assert.strictEqual(bounded.instance.size, GATE_CACHE_LIMIT, "缓存条数有上界");
    const before = bounded.calls();
    assert.strictEqual(await bounded.instance.allows("D:/dev/p0", new LocalFsBudget(1000)), true);
    assert.strictEqual(bounded.calls(), before + 1, "最早那条已被淘汰：再问一次要重新查盘");
  }
}

console.log("localAccess: 有界等待 / 全局未完成上限 / 信任门 ✓");
