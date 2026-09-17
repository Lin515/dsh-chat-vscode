/**
 * 离线断言：supervisor 的会合协议（状态文件 / 启动锁 / socket 寻址）与运行时解析。
 *
 * 为什么这些断言重要：这里的每一处失真都会变成"多起一个后台、抢端口、会话全丢"
 * 或者"没人用了却留着后台"。而且它们是**纯文件 + 纯函数**，不需要起任何进程——
 * 新形态比旧的会合租约好验，首先就体现在这里。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, sep } from "node:path";
// 必须排在最前面：把会合根目录指到本次断言专用的临时目录（模块求值期读一次）
const TEST_ROOT = mkdtempSync(join(tmpdir(), "dsh-chat-supervisor-"));
process.env.DSH_CHAT_SUPERVISOR_DIR = TEST_ROOT;
const {
  IDLE_SEC_DEFAULT,
  IDLE_SEC_MAX,
  IDLE_SEC_MIN,
  STATE_VERSION,
  acquireStartLock,
  clampIdleSec,
  clearState,
  dropStaleStartLock,
  generationOf,
  lockHolder,
  readState,
  releaseStartLock,
  socketPathIn,
  stateFileIn,
  supervisorDirectory,
  supervisorRoot,
  writeState,
} = await import("../src/dsh/supervisorProtocol");
const { resolveNodeRuntime, runRuntimeSelfCheck, runtimeEnv } = await import("../src/dsh/runtimeResolve");
const { decodeServerMessage, encodeMessage } = await import("../src/dsh/supervisorWire");

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`   ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DIR = supervisorDirectory("group-a");

/** 一份形状完整的状态（各断言在此基础上改字段）。 */
function stateOf(patch: Record<string, unknown> = {}) {
  return {
    version: STATE_VERSION,
    supervisorPid: 1234,
    startedAt: 1_700_000_000_000,
    command: "dsh web --port 0 --no-open",
    idleSec: 10,
    socket: socketPathIn(DIR, "group-a"),
    starting: true,
    ...patch,
  } as Parameters<typeof writeState>[1];
}

// ---------- 1. 目录与寻址 ----------

{
  check("会合根目录受环境变量控制（探针与断言不会碰用户那套）", supervisorRoot() === TEST_ROOT, supervisorRoot());
  const filtered = supervisorDirectory("a/b\\c:d");
  const folder = filtered.split(/[\\/]/).pop() ?? "";
  check(
    "分组名做文件系统安全过滤（只过滤分组名本身，不动根路径）",
    filtered.startsWith(TEST_ROOT) && !/[\\/:]/.test(folder) && folder.startsWith("a"),
    filtered,
  );
  const socket = socketPathIn(DIR, "group-a");
  check(
    process.platform === "win32" ? "Windows 上用命名管道" : "非 Windows 上用 AF_UNIX 路径",
    process.platform === "win32" ? socket.startsWith("\\\\.\\pipe\\") : socket.endsWith("sup.sock"),
    socket,
  );

  // 隔离目录必须连**管道名**一起隔离（2026-09-15）。
  //
  // Windows 的管道名是全局命名空间里的名字，与目录无关：只看分组的话，探针那套
  // （`DSH_CHAT_SUPERVISOR_DIR` 指到临时目录）会和用户正在用的那套撞名，探针的
  // supervisor 一起来就 `EADDRINUSE` 退出、无限重起（`npm run smoke` 卡住就是这个）。
  // 两条一起钉：**默认根目录的管道名一字不变**（生产零影响）、隔离目录另有一个后缀。
  {
    const defaultRoot = join(homedir(), ".dsh", "dsh-chat-vscode", "supervisors");
    const production = socketPathIn(join(defaultRoot, "group-a"), "group-a");
    const isolated = socketPathIn(DIR, "group-a");
    const other = socketPathIn(mkdtempSync(join(tmpdir(), "dsh-chat-sup-probe-")), "group-a");
    if (process.platform === "win32") {
      check(
        "生产（默认会合根）的管道名与从前逐字节相同",
        production === "\\\\.\\pipe\\dsh-chat-group-a",
        production,
      );
      check(
        "隔离目录的管道名带自己的后缀（不再和用户那套撞名）",
        isolated.startsWith("\\\\.\\pipe\\dsh-chat-group-a-") &&
          isolated !== production &&
          /-[0-9a-f]{8}$/.test(isolated),
        isolated,
      );
      check(
        "两个不同的隔离目录 → 两个不同的管道名（探针之间也不撞）",
        other !== isolated && other.startsWith("\\\\.\\pipe\\dsh-chat-group-a-"),
        other,
      );
      check("同一目录反复算 → 同一个名字（两侧算法必须一致）", socketPathIn(DIR, "group-a") === isolated);
      // 大小写 / 尾部分隔符不该改变判定（Windows 路径不敏感）
      check(
        "尾部分隔符与大小写不影响判定",
        socketPathIn(`${DIR}\\`, "group-a") === isolated && socketPathIn(DIR.toUpperCase(), "group-a") === isolated,
      );
    } else {
      check(
        "Unix 的 socket 就在隔离目录里（无需额外后缀）",
        isolated.endsWith("sup.sock") && isolated.startsWith(TEST_ROOT) && other !== isolated,
        isolated,
      );
    }
  }
}

// ---------- 2. 原子写：不留临时文件、内容完整可读 ----------

{
  check("写入成功", writeState(DIR, stateOf({ baseUrl: "http://127.0.0.1:1234", token: "tok" })));
  const read = readState(DIR);
  check("读回来字段一致", read?.baseUrl === "http://127.0.0.1:1234" && read?.token === "tok", JSON.stringify(read));
  const leftovers = readdirSync(DIR).filter((name) => name.includes(".tmp-"));
  check("写完不留临时文件（原子写的临时名不该留在目录里）", leftovers.length === 0, JSON.stringify(leftovers));
  // 覆盖一次，确认不会把旧内容读成新内容
  writeState(DIR, stateOf({ baseUrl: "http://127.0.0.1:2345", serverPid: 999, starting: false }));
  const again = readState(DIR);
  check("覆盖后读到的是新内容", again?.baseUrl === "http://127.0.0.1:2345" && again?.serverPid === 999);
}

// ---------- 3. 宽容读取：坏数据当"没有"，不让一个坏文件拖死链路 ----------

{
  const file = stateFileIn(DIR);
  writeFileSync(file, "{ 半个 JSON", "utf8");
  check("坏 JSON → undefined", readState(DIR) === undefined);

  writeFileSync(file, JSON.stringify({ ...stateOf(), version: 99 }), "utf8");
  check("版本不认识 → undefined", readState(DIR) === undefined);

  writeFileSync(file, JSON.stringify({ version: STATE_VERSION, supervisorPid: 1 }), "utf8");
  check("缺关键字段（command/socket/startedAt）→ undefined", readState(DIR) === undefined);

  // 缺 baseUrl/token 只是"还没就绪"，不该整份丢掉（扩展要靠它等待）
  writeFileSync(file, JSON.stringify(stateOf()), "utf8");
  const notReady = readState(DIR);
  check("只有 starting、没有地址 → 仍然读得到（扩展据此等待）", notReady?.starting === true && notReady.baseUrl === undefined);

  // idleSec 坏值要收敛到合法范围，而不是让整份状态不可用
  writeFileSync(file, JSON.stringify(stateOf({ idleSec: "abc" })), "utf8");
  check("idleSec 坏值收敛到默认", readState(DIR)?.idleSec === IDLE_SEC_DEFAULT, String(readState(DIR)?.idleSec));
  rmSync(file, { force: true });
  check("文件不在 → undefined", readState(DIR) === undefined);
}

// ---------- 4. 世代：pid 或启动时刻变了就是"换了新的一套" ----------

{
  const a = generationOf({ supervisorPid: 10, startedAt: 100 });
  const b = generationOf({ supervisorPid: 10, startedAt: 101 });
  const c = generationOf({ supervisorPid: 11, startedAt: 100 });
  check("pid 或 startedAt 任一变化 → 世代不同（扩展据此发现 supervisor 换代并重连）", a !== b && a !== c && a === generationOf({ supervisorPid: 10, startedAt: 100 }));
}

// ---------- 5. 阈值收敛 ----------

{
  check("默认值", clampIdleSec(undefined) === IDLE_SEC_DEFAULT);
  check("下限夹紧", clampIdleSec(0) === IDLE_SEC_MIN && clampIdleSec(1) === IDLE_SEC_MIN);
  check("上限夹紧", clampIdleSec(99999) === IDLE_SEC_MAX);
  check("非法值回落默认", clampIdleSec("abc") === IDLE_SEC_DEFAULT && clampIdleSec(NaN) === IDLE_SEC_DEFAULT);
  check("合法值原样（含小数四舍五入）", clampIdleSec(30) === 30 && clampIdleSec(30.6) === 31);
}

// ---------- 5.5 协议：守护进程的内部错误上报（`t:"error"`，2026-09-15 加） ----------

{
  // 编码 → 解码往返
  const line = encodeMessage({ t: "error", kind: "tick", message: "TypeError: x @ at foo" });
  const decoded = decodeServerMessage(line.trim());
  check(
    "`t:error` 能被解出来（kind/message 原样）",
    decoded?.t === "error" && decoded.kind === "tick" && decoded.message === "TypeError: x @ at foo",
    JSON.stringify(decoded),
  );

  // 缺字段 / 类型不对都不认（协议"读不懂就忽略"）
  check("缺 kind 不认", decodeServerMessage(JSON.stringify({ t: "error", message: "x" })) === undefined);
  check("缺 message 不认", decodeServerMessage(JSON.stringify({ t: "error", kind: "tick" })) === undefined);
  check("kind 不是字符串不认", decodeServerMessage(JSON.stringify({ t: "error", kind: 1, message: "x" })) === undefined);

  // 向后兼容：旧扩展见到不认识的 `t` 必须拿到 undefined（而不是抛/误判）
  check(
    "读不懂的消息返回 undefined（旧扩展遇到新报文只忽略，不弄坏连接）",
    decodeServerMessage(JSON.stringify({ t: "some-future-message", payload: 1 })) === undefined,
  );
  // 反过来：新扩展遇到旧守护进程（没有这条消息）当然也不受影响——它只是永远收不到 error
  check("旧的 goodbye/state 仍然照旧解出来", decodeServerMessage(encodeMessage({ t: "goodbye", reason: "idle" }).trim())?.t === "goodbye");
}

// ---------- 5.9 单行上限：对面一直发不含换行的数据，缓冲不能无限涨 ----------

{
  const { LineDecoder, MAX_LINE_CHARS } = await import("../src/dsh/supervisorWire");
  const decoder = new LineDecoder();
  // 正常的一行照旧切得开
  const lines = decoder.push('{"t":"ping"}\n');
  check("正常的一行照旧切出来", lines.length === 1 && lines[0] === '{"t":"ping"}');

  // 超长半行：缓冲被丢掉、标记成 overflowed，后续 chunk 一律忽略
  const flooded = decoder.push("x".repeat(MAX_LINE_CHARS + 1));
  check("超长半行不返回任何行", flooded.length === 0);
  check("超长之后标记 overflowed（调用方据此断开连接）", decoder.isOverflowed);
  check(
    "溢出之后不再解析后续内容（缓冲不会再涨）",
    decoder.push('{"t":"state"}\n'.repeat(1000)).length === 0,
  );
  // reset 之后恢复可用（同一对象复用）
  decoder.reset();
  check("reset 后恢复可解析", decoder.push('{"t":"ping"}\n').length === 1);
}

// ---------- 5.10 分组名不能跳出状态根目录 ----------

{
  // 分组在生产里是 sha256 前缀，但它是**参数**：探针/手工启动也能传
  const traversal = supervisorDirectory("..");
  check(
    "全点分组被折成 default（`join(root, '..')` 会跳出状态根）",
    traversal === join(supervisorRoot(), "default"),
    traversal,
  );
  check("`.` / 空串同样折成 default", supervisorDirectory(".") === join(supervisorRoot(), "default") && supervisorDirectory("") === join(supervisorRoot(), "default"));
  // 含分隔符的分组被压成一层目录名：结果必须**正好**是 root 下的直接子项
  const nested = supervisorDirectory("a/../b");
  check(
    "分组里的分隔符被过滤（结果仍是 root 的直接子项）",
    nested.startsWith(supervisorRoot() + sep) &&
      !nested.slice(supervisorRoot().length + 1).includes(sep),
    nested,
  );
}

// ---------- 6. 启动锁：独占、只删自己的、持有者已死可回收 ----------

{
  const dir = supervisorDirectory("lock-a");
  check("第一次抢到", acquireStartLock(dir));
  check("第二次抢不到（独占：同一时刻只有一个窗口能去起 supervisor）", !acquireStartLock(dir));
  check("锁里记的是持有者 pid", lockHolder(dir) === process.pid, String(lockHolder(dir)));

  // 别人的锁：不许动
  writeFileSync(join(dir, "supervisor.lock"), "999999 1700000000000", "utf8");
  releaseStartLock(dir);
  check("释放时只删自己持有的锁（别人的锁不动）", lockHolder(dir) === 999999, String(lockHolder(dir)));

  // 持有者已死 → 可以回收；活着 → 不动
  check("持有者已死 → 回收失败锁", dropStaleStartLock(dir, () => false) && lockHolder(dir) === undefined);
  writeFileSync(join(dir, "supervisor.lock"), "999999 1700000000000", "utf8");
  check("持有者还活着 → 不动手（拿不到证据时不动，沿用 isKillable 纪律）", !dropStaleStartLock(dir, () => true) && lockHolder(dir) === 999999);

  // 内容坏掉的锁：按"无主"回收
  writeFileSync(join(dir, "supervisor.lock"), "", "utf8");
  check("内容坏掉 → 按无主回收", dropStaleStartLock(dir, () => true) && lockHolder(dir) === undefined);

  rmSync(dir, { recursive: true, force: true });
}

// ---------- 7. clearState 只删会合文件 ----------

{
  const dir = supervisorDirectory("clear-a");
  writeState(dir, stateOf());
  writeFileSync(join(dir, "supervisor.log"), "log", "utf8");
  clearState(dir);
  check("会合文件被删", readState(dir) === undefined);
  const kept = readdirSync(dir);
  check("日志等其它文件不受影响", kept.includes("supervisor.log"), JSON.stringify(kept));
  rmSync(dir, { recursive: true, force: true });
}

// ---------- 8. 运行时：固定用 VS Code 自带的 Node（含真跑一次自检） ----------

{
  const runtime = resolveNodeRuntime(process.env.VSCODE_APP_ROOT);
  check("解析出可执行文件", Boolean(runtime.execPath), runtime.execPath);
  const env = runtimeEnv({ ELECTRON_RUN_AS_NODE: "0", ELECTRON_ENABLE_LOGGING: "1", PATH: "x" });
  check(
    "环境里 ELECTRON_RUN_AS_NODE 被显式设成 1（先清后设，不继承）",
    env.ELECTRON_RUN_AS_NODE === "1" && env.ELECTRON_ENABLE_LOGGING === undefined && env.PATH === "x",
    JSON.stringify(env.ELECTRON_RUN_AS_NODE),
  );
  check(
    "同源解析：扩展宿主此刻就跑在这个运行时上（process.execPath 必须能跑 JS）",
    runtime.execPath === process.execPath,
    `${runtime.execPath} vs ${process.execPath}`,
  );

  // 真跑一次：拿不到就说明 spawn 姿势不对（这正是"发布到别人机器上会不会翻车"的那一步）
  let selfCheck: string | undefined;
  try {
    selfCheck = await runRuntimeSelfCheck(
      runtime,
      "process.stdout.write(JSON.stringify({node:process.version,electron:process.versions.electron??null}))",
    );
  } catch (error) {
    selfCheck = undefined;
    check("运行时自检成功", false, error instanceof Error ? error.message : String(error));
  }
  if (selfCheck !== undefined) {
    const parsed = JSON.parse(selfCheck) as { node: string; electron: string | null };
    check("运行时自检成功且报出了 node 版本", /^v\d+/.test(parsed.node), selfCheck);
  }
}

rmSync(TEST_ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nsupervisorProtocol: all assertions passed" : `\nsupervisorProtocol: ${failures} 项未通过`);
if (failures > 0) process.exitCode = 1;
