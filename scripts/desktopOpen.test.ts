/**
 * 离线断言：**「打开 DSH 桌面端」的宿主侧接线**（顶栏那颗「打开」按钮的第二种形态）。
 *
 * 用户 2026-10-18 口径：**当前连的是桌面端内置服务**时，顶栏那颗「在浏览器中打开」改成
 * 「打开 DSH 桌面端」——那套服务对浏览器是关着的（它只认自己按进程生成的启动令牌，见
 * `docs/design-desktop.md`「浏览器访问」），在浏览器里打开只会得到一页 401；桌面端应用
 * 本来就在这台机器上，打开它（已在跑则聚焦已有窗口）才是同一件事的正确入口。
 *
 * 这里钉住五件事：
 * 1. `desktopConnected` 的判据：归属是 `desktop` **且**这一轮真的连上了，其余一律保持浏览器；
 * 2. **切会话那一帧仍带它**（顶栏那颗按钮的两种形态不许在切会话时跳回去）；
 * 3. 点它的动作：只把桌面端拉起来，**不动连接、不出声**；
 * 4. 起不来时给一条**共享**通知（窗口级动作，没有会话归属），标记带上 spawn 的原因；
 * 5. 防御路径：没配 `dshChat.desktopExecutable` 时连 spawn 都不做（真管理器那一支）。
 *
 * 按钮本身的接线（`state.desktopConnected` 二分与三颗图标两两不同）由 `styles.test.ts`
 * 的图标那一段覆盖；桌面端的拉起与等就绪在 `desktopAttach.test.ts`。
 * vscode 由 esbuild.scripts.mjs 的 alias 指到 `scripts/vscodeTestStub.ts`（同
 * `notificationsController.test.ts` 的夹具形态）。
 */
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopStartError } from "../src/dsh/desktopAttach";

process.on("unhandledRejection", (error) => {
  console.error("[desktopOpen] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

// 动态 import：让 alias（esbuild 打包期）把 controller 依赖的 vscode 换成 stub。
const { ChatController } = await import("../src/dsh/controller");
const { SupervisorManager } = await import("../src/dsh/supervisorManager");

/** 夹具工作目录（会话行的 cwd 用；按宿主平台算绝对路径）。 */
const DIR = mkdtempSync(join(tmpdir(), "desktop-open-ws"));

interface Captured {
  target: "all" | string;
  frame: Record<string, unknown>;
}

/** 队列里本回归用到的只读面（真实例，不另造一份语义）。 */
interface QueueProbe {
  visible(sessionId?: string): Array<{ text: string; level: string; sessionId?: string }>;
  pendingCount(): number;
}

interface Harness {
  controller: InstanceType<typeof ChatController>;
  frames: Captured[];
  calls: string[];
  queue: QueueProbe;
}

const fakeMemento = (seed: Record<string, unknown> = {}) => {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

/**
 * 一份够用的假客户端：`openSession` 那条链要的几件（跟随流 / 目录 / 一元调用）。
 *
 * 这一条断言只关心"切会话那一帧里 `desktopConnected` 是什么"，所以其它面一律给空实现。
 */
function fakeClient() {
  const cancel = { cancel() {} };
  return {
    baseUrl: "http://127.0.0.1:5674",
    sessionCookie: "dsh-auth-x=v1.x.x",
    onDidChangeState: () => ({ dispose() {} }),
    useSessionCookie() {},
    dispose() {},
    async authenticate() {},
    async createSession(_target: unknown, reuse?: string) {
      return { sessionId: reuse ?? "s-new" };
    },
    async listSessions() {
      return {
        items: [
          { sessionId: "s1", cwd: DIR, blank: false, updatedAt: 1, running: false },
          { sessionId: "s2", cwd: DIR, blank: false, updatedAt: 2, running: false },
        ],
      };
    },
    async sessionProjections() {
      return { values: {} };
    },
    async request() {
      return undefined;
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    followSession: () => cancel,
    followJobs: () => cancel,
    followControl: () => cancel,
    openStream: () => cancel,
    openEvents: () => cancel,
  };
}

/**
 * 一份够用的假后台管理器。
 *
 * `ownership` 决定 `snapshot().status.info`（那一份就是 `ensure()` 最近一次的结果，
 * `desktopConnected` 的判据读它）；不给 = 这一刻没有连接（`status` 里没有 `info`）。
 */
function makeHarness(
  options: {
    ownership?: "desktop" | "self" | "peer" | "external";
    connection?: "connected" | "connecting" | "stopped";
    fail?: Error;
  } = {},
): Harness {
  const calls: string[] = [];
  const server = {
    desktopConfigured: true,
    externalUrl: undefined,
    commandConfigured: true,
    activeBaseUrl: undefined,
    onHeartbeat() {},
    freshToken: () => undefined,
    dispose() {},
    async openDesktopApp() {
      calls.push("openDesktopApp");
      if (options.fail) throw options.fail;
    },
    snapshot: () => ({
      status: options.ownership
        ? {
            state: "ready",
            info: { baseUrl: "http://127.0.0.1:5674", owned: false, ownership: options.ownership },
          }
        : { state: "stopped" },
    }),
  };
  const controller = new ChatController(
    server as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const internals = controller as unknown as { connection: string; client: unknown };
  internals.connection = options.connection ?? "connected";
  internals.client = fakeClient();
  const frames: Captured[] = [];
  controller.subscribe((target, frame) => frames.push({ target, frame: frame as unknown as Record<string, unknown> }));
  return {
    controller,
    frames,
    calls,
    queue: (controller as unknown as { notifications: QueueProbe }).notifications,
  };
}

/**
 * 这一刻会发给界面的那组连接字段。
 *
 * 首帧快照与增量 patch 共用 `connectionPatch()`（见 `snapshotFor` / `emitConnection`），
 * 所以这里就是"界面会收到什么"的取值来源。取私有成员靠 cast，与既有夹具取
 * `internals.client` 同一手法。
 */
const connectFields = (controller: unknown): Record<string, unknown> =>
  (controller as { connectionPatch(): Record<string, unknown> }).connectionPatch();

console.log("desktopOpen: 顶栏「打开 DSH 桌面端」的宿主接线（真控制器，offline stub）");

// ---------- 一、desktopConnected：归属是 desktop 且这一轮连上了 ----------
{
  const desktop = connectFields(makeHarness({ ownership: "desktop" }).controller);
  assert.strictEqual(desktop.desktopConnected, true, "连的是桌面端内置服务 → 那颗按钮改形态");

  const connecting = connectFields(
    makeHarness({ ownership: "desktop", connection: "connecting" }).controller,
  );
  assert.strictEqual(
    connecting.desktopConnected,
    undefined,
    "目标粘在桌面端、这一轮还没连上时不许提前改成「打开桌面端」",
  );

  for (const ownership of ["self", "peer", "external"] as const) {
    const other = connectFields(makeHarness({ ownership }).controller);
    assert.strictEqual(other.desktopConnected, undefined, `归属 ${ownership} 时照旧开浏览器`);
  }

  const none = connectFields(makeHarness().controller);
  assert.strictEqual(none.desktopConnected, undefined, "没有连接（status 里没有 info）时也不改");
  console.log("  只有「归属 desktop + 已连上」才是打开桌面端，其余一律保持浏览器 ✓");
}

// ---------- 一·补、切会话那一帧仍带它 ----------
//
// 切会话推的是**整份快照**，所以这一条钉住它真的带着这个字段——漏掉或发成 `null`
// （过线后的"清除"形态）都会让界面退回浏览器形态。
{
  const h = makeHarness({ ownership: "desktop" });
  h.controller.bindView("v1");
  await h.controller.handle({ type: "openSession", sessionId: "s1" } as never, "v1");

  const states = h.frames.filter((item) => item.frame.type === "state");
  assert.ok(states.length >= 1, "切会话要推一份整份快照");
  const last = states[states.length - 1].frame.state as Record<string, unknown>;
  assert.strictEqual(last.session !== undefined, true, "最后那一帧是绑上新会话的整份快照");
  assert.strictEqual(last.desktopConnected, true, "整份快照必须带 desktopConnected: true");
  assert.notStrictEqual(last.desktopConnected, null, "不许发 null（那是「清除该字段」的过线形态）");
  console.log("  切会话那一帧仍带 desktopConnected: true ✓");
}

// ---------- 二、点它：只把桌面端拉起来，不动连接、不出声 ----------
{
  const h = makeHarness({ ownership: "desktop" });
  await h.controller.handle({ type: "openDesktop" } as never, "v1");
  assert.deepStrictEqual(
    h.calls,
    ["openDesktopApp"],
    "动作就是「把桌面端拉起来」（已在跑时它自己的单实例会聚焦已有窗口）",
  );
  assert.strictEqual(h.queue.pendingCount(), 0, "成功不出声（与其它窗口级成功动作同口径）");
  assert.strictEqual(h.frames.length, 0, "也不推任何状态：连接还是那一条");
  console.log("  成功：拉一次桌面端，不推帧、不报通知 ✓");
}

// ---------- 三、起不来：一条共享通知（窗口级动作，不带会话归属） ----------
{
  const h = makeHarness({ ownership: "desktop", fail: new DesktopStartError("ENOENT") });
  await h.controller.handle({ type: "openDesktop" } as never, "v1");
  assert.deepStrictEqual(h.calls, ["openDesktopApp"], "失败也只调一次");
  assert.strictEqual(h.queue.pendingCount(), 1, "失败要报一次");
  const notice = h.queue.visible(undefined)[0];
  assert.strictEqual(notice.text, "@desktopSpawnFailed:ENOENT", "标记里带上 spawn 的原因");
  assert.strictEqual(notice.level, "warn", "与「在浏览器中打开」失败同一档");
  assert.strictEqual(notice.sessionId, undefined, "窗口级动作 → 共享通知（没有会话归属）");
  console.log("  失败：一条共享黄灯通知，标记带原因（界面按语言翻译）✓");
}

// ---------- 四、没配可执行文件（真管理器的防御分支）：连 spawn 都不做 ----------
{
  const logs: string[] = [];
  const manager = new SupervisorManager({
    url: "",
    command: "dsh web --port 0 --no-open",
    desktopExecutable: "   ",
    log: (line) => logs.push(line),
  });
  manager.dispose();
  await manager.openDesktopApp();
  assert.ok(
    logs.some((line) => line.includes("没有配置")),
    `应当记一行「没有配置」（而不是拿空路径去 spawn）：${logs.join(" | ")}`,
  );
  console.log("  没配可执行文件：只记一行、不 spawn ✓");
}

console.log("\ndesktopOpen: all assertions passed");
