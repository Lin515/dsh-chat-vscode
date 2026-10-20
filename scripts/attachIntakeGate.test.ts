/**
 * 附件接入的**会话门**：没有可用会话时整批拒收，不收下再变成 `@uploadNoSession` 失败芯片。
 *
 * 口径（用户 2026-10-20）：附件入口**不**替用户建会话 / 连后台 / 弹目录选择器。点「添加附件」
 * 时若没有可用会话，连文件选择框都不弹，直接发一条黄色通知（请选择工作目录 / 后台未连接）；
 * 拖放 / 粘贴已经拿到内容，同样整批拒收。判据是「连接已就绪 + 窗口已绑会话」。
 *
 * 七档行为：
 * 1. 点附件且没有可用目录 → 0 次选择框、0 枚芯片、一条 `@attachNeedsWorkspace`；
 * 2. 点附件且后台未连接 → 0 次选择框、0 枚芯片、一条 `@attachBackendOffline`；
 * 3. 连接与目录都在、会话还没就绪 → 0 枚芯片、一条 `@attachSessionUnavailable`，入口不建会话；
 * 4. 正常空态 → 按钮只弹文件选择框，选完芯片与上传照旧；
 * 5. 混批（文件 + 图片）在失败时同样整批拒收，不留下半批芯片；
 * 6. 宿主 `send` 兜底：附件未就绪时直发的 send 不提交、草稿原样推回。
 * 7. 已绑定会话断线：按钮 / 拖放 / 粘贴拒收通知只归原会话；未绑定时仍共享。
 *
 * vscode 依赖由 esbuild.scripts.mjs 的 alias 指到 `vscodeTestStub.ts`（离线、无网络、
 * 无 token、亚秒级）；夹具与 `emptyComposer.test.ts` 同形。
 */
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotificationView } from "../src/shared/chat";

process.on("unhandledRejection", (error) => {
  console.error("[attachIntakeGate] 未处理的异步拒绝（当作失败）：", error);
  process.exit(1);
});

const { ChatController } = await import("../src/dsh/controller");
const vscode = await import("vscode");

/** 夹具目录：按宿主平台算绝对路径（`node:path` 的 isAbsolute 是平台相关的）。 */
const root = mkdtempSync(join(tmpdir(), "dsh-attach-intake-"));
const CWD = join(root, "workspace");
const filePath = join(root, "note.txt");
const imagePath = join(root, "shot.png");
writeFileSync(filePath, "hello");

interface Captured {
  target: string;
  frame: Record<string, unknown>;
}

/** 假服务端：会话作用域 RPC 只认自己创建过的会话（与真服务端 resolveAgent 同形）。 */
function fakeClient() {
  const rows: { sessionId: string; cwd: string; blank: boolean; updatedAt: number; running: boolean }[] = [];
  const uploads: string[] = [];
  const prompts: string[] = [];
  return {
    rows,
    uploads,
    prompts,
    async prompt(_sessionId: string, content: unknown[]) {
      prompts.push(JSON.stringify(content));
      return { ok: true };
    },
    async createSession(target: { workspaceId?: string; cwd?: string }, reuse?: string) {
      if (reuse !== undefined) {
        const row = rows.find((item) => item.sessionId === reuse);
        if (row) return { sessionId: row.sessionId };
      }
      const sessionId = `session-blank-${rows.length + 1}`;
      rows.push({
        sessionId,
        cwd: target.cwd ?? "",
        blank: true,
        updatedAt: Date.now() + rows.length,
        running: false,
      });
      return { sessionId };
    },
    async listSessions() {
      return { items: rows.map((row) => ({ ...row })) };
    },
    async uploadFile(_sessionId: string, _bytes: Uint8Array, name: string) {
      uploads.push(name);
      return { receiptId: `receipt-${name}`, file: { attachmentId: `attachment-${name}` } };
    },
    async request(method: string, params?: Record<string, unknown>) {
      if (method === "workspace/create") return { workspace: { workspaceId: "ws-1" } };
      if (method === "agentPresets/list") return { presets: [] };
      if (method === "subagents/list") return { entries: [] };
      if (method === "session/projections") return { values: {} };
      const agentId = String(params?.agentId ?? "");
      if (!rows.some((row) => row.sessionId === agentId)) throw new Error("session not found");
      if (method === "commands/list") return [];
      if (method === "fileReferences/list") return [];
      if (method === "sessionReferenceResolver/candidates") return [];
      if (method === "skills/list") return { skills: [] };
      return undefined;
    },
    async scheduleCatalog() {
      return [];
    },
    async sessionProjections() {
      return { values: {} };
    },
    async getJson() {
      return undefined;
    },
    async settingsDescribe() {
      return { namespaces: [] };
    },
    followSession(sessionId: string, handler: { onItem(value: unknown): void }) {
      handler.onItem({
        type: "snapshot",
        header: { version: 3, id: sessionId, createdAt: 1, cwd: CWD, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
        projections: { asOfSeq: 0, values: {} },
      });
      return { cancel() {} };
    },
    followJobs() {
      return { cancel() {} };
    },
    followControl() {
      return { cancel() {} };
    },
  };
}

const fakeServer = () => ({
  externalUrl: undefined,
  commandConfigured: true,
  onHeartbeat() {},
  snapshot() {
    return { status: { info: undefined }, supervisorAlive: false };
  },
});

const fakeMemento = () => {
  const map = new Map<string, unknown>();
  return {
    get: (key: string, fallback?: unknown) => (map.has(key) ? map.get(key) : fallback),
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
    keys: () => [...map.keys()],
  };
};

type Internals = {
  client: unknown;
  connection: string;
  viewSessions: Map<string, string>;
  newSessionCwd?: string;
  drafts: Map<string, string>;
  attachments: {
    list(key: string): { id: string; name: string; upload?: { status?: string } }[];
    add(key: string, list: unknown[]): void;
  };
  bindView(viewId: string): void;
  teardownStreams(): void;
  notificationMirror(viewId: string): NotificationView[];
  newSession(viewId: string): Promise<void>;
  ensureConnected(options?: unknown): Promise<void>;
  addPaths(viewId: string, paths: readonly string[], source: string): Promise<void>;
  handle(message: Record<string, unknown>, viewId: string): Promise<void>;
};

/** 建一个控制器并接上假客户端；`offline` 那一档把客户端留空、连接置 stopped。 */
function makeController(options: { dir?: string; offline?: boolean } = {}) {
  const client = fakeClient();
  const controller = new ChatController(
    fakeServer() as never,
    () => undefined,
    fakeMemento() as never,
    fakeMemento() as never,
    { delete: async () => undefined, get: async () => undefined, store: async () => undefined } as never,
  );
  const c = controller as unknown as Internals;
  if (options.dir !== undefined) c.newSessionCwd = options.dir;
  if (options.offline) {
    c.client = undefined;
    c.connection = "stopped";
  } else {
    c.client = client as never;
    c.connection = "connected";
  }
  const frames: Captured[] = [];
  (
    controller as unknown as {
      subscribe(listener: (target: string, frame: Record<string, unknown>) => void): unknown;
    }
  ).subscribe((target, frame) => frames.push({ target, frame }));
  c.bindView("v1");
  return { c, client, frames };
}

/** 这个窗口镜像里的通知（取最后一份带 notifications 的 state / patch）。 */
function notices(frames: Captured[], viewId: string): NotificationView[] {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const { target, frame } = frames[index];
    if (target !== "all" && target !== viewId) continue;
    const holder = frame.type === "state" ? frame.state : frame.type === "patch" ? frame.patch : undefined;
    if (!holder || typeof holder !== "object") continue;
    const value = (holder as { notifications?: unknown }).notifications;
    if (Array.isArray(value)) return value as NotificationView[];
  }
  return [];
}

/** 本场景关心的拒收通知（不带参数的三条标记之一）。 */
function rejectNotices(frames: Captured[], viewId = "v1"): string[] {
  return notices(frames, viewId)
    .map((item) => item.text)
    .filter((text) => /^@attach(BackendOffline|NeedsWorkspace|SessionUnavailable)$/.test(text));
}

/** 这个窗口当前键上的芯片（绑定前是窗口键，绑定后是会话键）。 */
function chips(c: Internals, viewId = "v1") {
  return c.attachments.list(c.viewSessions.get(viewId) ?? viewId);
}

/** 等一次异步上传结算（真账本的上传链是 `void` 起的）。 */
async function waitForReady(c: Internals, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const list = chips(c);
    if (list.length === expected && list.every((item) => item.upload?.status === "ready")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`上传没有在预期时间内就绪：${JSON.stringify(chips(c))}`);
}

const originalDialog = vscode.window.showOpenDialog;

console.log("attachIntakeGate: 附件接入的会话门（真控制器，offline stub）");

try {
  // ---------- 一、点附件直接拒收：连文件框都不弹，提示选目录 ----------
  {
    const dialogs: { folders?: boolean; files?: boolean }[] = [];
    (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = async (options: {
      canSelectFolders?: boolean;
      canSelectFiles?: boolean;
    }) => {
      dialogs.push({ folders: options.canSelectFolders, files: options.canSelectFiles });
      return undefined;
    };
    try {
      const { c, client, frames } = makeController();
      await c.handle({ type: "addFiles" }, "v1");
      console.log(`  无目录：选择器 ${dialogs.length} 次、芯片 ${chips(c).length} 枚、上传 ${client.uploads.length} 次`);
      assert.strictEqual(dialogs.length, 0, "没有可用会话时连文件选择框都不弹（更不许换成目录选择框）");
      assert.strictEqual(chips(c).length, 0, "不留下任何芯片（不再落 uploadNoSession）");
      assert.strictEqual(client.uploads.length, 0, "没有会话就不发上传请求");
      assert.deepStrictEqual(client.rows, [], "也不建半条会话");
      assert.deepStrictEqual(rejectNotices(frames), ["@attachNeedsWorkspace"], "提示请选择工作目录");
    } finally {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = originalDialog;
    }
  }

  // ---------- 二、后台连不上：点附件直接拒收，提示后台未连接 ----------
  {
    const dialogs: unknown[] = [];
    (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => {
      dialogs.push("showOpenDialog");
      return undefined;
    };
    try {
      const { c, client, frames } = makeController({ offline: true });
      c.bindView("unbound");
      await c.handle({ type: "addFiles" }, "v1");
      console.log(`  后台未连接：选择器 ${dialogs.length} 次、芯片 ${chips(c).length} 枚、上传 ${client.uploads.length} 次`);
      assert.strictEqual(dialogs.length, 0, "后台未连接时也不弹任何选择框");
      assert.strictEqual(chips(c).length, 0, "连不上后台时不收附件");
      assert.strictEqual(client.uploads.length, 0, "也不发上传请求");
      assert.deepStrictEqual(rejectNotices(frames), ["@attachBackendOffline"], "提示后台未连接");
      assert.deepStrictEqual(rejectNotices(frames, "unbound"), ["@attachBackendOffline"], "未绑定会话时仍用共享通知");
      assert.strictEqual(notices(frames, "v1")[0]?.sessionId, undefined, "未绑定会话的拒收通知没有会话归属");
    } finally {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = originalDialog;
    }
  }

  // ---------- 断线保留会话绑定：按钮与字节接入的拒收通知只归发起会话 ----------
  for (const source of ["button", "drop", "paste"] as const) {
    const { c, client, frames } = makeController({ dir: CWD });
    await c.newSession("v1");
    const sessionA = c.viewSessions.get("v1");
    assert.ok(sessionA, "发起视图已绑定会话 A");
    c.bindView("v2");
    await c.newSession("v2");
    const sessionB = c.viewSessions.get("v2");
    assert.ok(sessionB && sessionB !== sessionA, "另一视图绑定不同的会话 B");
    c.bindView("same-session");
    c.viewSessions.set("same-session", sessionA);
    c.bindView("unbound");

    c.teardownStreams();
    c.client = undefined;
    c.connection = "stopped";
    assert.strictEqual(c.viewSessions.get("v1"), sessionA, "真实断线清理保留原会话绑定");
    frames.length = 0;
    if (source === "button") {
      await c.handle({ type: "addFiles" }, "v1");
    } else {
      await c.handle({
        type: "attachBytes",
        source,
        files: [{ name: "shot.png", base64: "aGVsbG8=", mimeType: "image/png" }],
        unreadable: [],
        tooLarge: [],
      }, "v1");
    }

    assert.deepStrictEqual(rejectNotices(frames), ["@attachBackendOffline"], `${source}：发起会话看得到拒收通知`);
    assert.strictEqual(notices(frames, "v1")[0]?.sessionId, sessionA, `${source}：断线拒收仍保留发起会话归属`);
    assert.deepStrictEqual(rejectNotices(frames, "same-session"), ["@attachBackendOffline"], `${source}：同会话其它视图同步通知`);
    assert.deepStrictEqual(rejectNotices(frames, "v2"), [], `${source}：不得泄漏到另一会话`);
    assert.deepStrictEqual(rejectNotices(frames, "unbound"), [], `${source}：不得泄漏到未绑定视图`);
    assert.strictEqual(client.uploads.length, 0, "断线拒收不上传");
    assert.strictEqual(chips(c).length, 0, "断线拒收不落芯片");

    c.client = client;
    c.connection = "connected";
    c.viewSessions.set("v1", sessionB);
    assert.deepStrictEqual(c.notificationMirror("v1"), [], "恢复连接后切往会话 B 也看不到 A 的拒收通知");
    c.viewSessions.set("v1", sessionA);
    assert.strictEqual(c.notificationMirror("v1")[0]?.sessionId, sessionA, "返回会话 A 时通知仍归 A");
    console.log(`  ${source} 断线拒收：归属 A、同会话同步、其它会话与空态隔离 ✓`);
  }

  // ---------- 三、连接与目录都在、会话还没就绪：整批拒收，兜底提示 ----------
  {
    const { c, client, frames } = makeController({ dir: CWD });
    await c.addPaths("v1", [filePath], "button");
    console.log(`  会话未就绪：芯片 ${chips(c).length} 枚、上传 ${client.uploads.length} 次`);
    assert.strictEqual(chips(c).length, 0, "没有会话时不收附件");
    assert.strictEqual(client.uploads.length, 0, "也不发上传请求");
    assert.deepStrictEqual(client.rows, [], "入口不替用户建会话（连 create 都没打）");
    assert.deepStrictEqual(rejectNotices(frames), ["@attachSessionUnavailable"], "提示会话未就绪");
  }

  // ---------- 四、正常空态：按钮打开文件框，选完立刻上传 ----------
  {
    const dialogs: { folders?: boolean; files?: boolean }[] = [];
    (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = async (options: {
      canSelectFolders?: boolean;
      canSelectFiles?: boolean;
    }) => {
      dialogs.push({ folders: options.canSelectFolders, files: options.canSelectFiles });
      return [{ fsPath: filePath }];
    };
    try {
      const { c, client, frames } = makeController({ dir: CWD });
      await c.newSession("v1");
      await c.handle({ type: "addFiles" }, "v1");
      const sessionId = c.viewSessions.get("v1");
      await waitForReady(c, 1);
      console.log(`  正常空态：选择器 ${dialogs.length} 次、空壳 ${sessionId}、芯片 ${chips(c).length} 枚、上传 ${client.uploads.length} 次`);
      assert.strictEqual(dialogs.length, 1, "有可用会话时只弹一次文件选择框");
      assert.strictEqual(dialogs[0]?.files, true, "弹的是文件选择器");
      assert.strictEqual(dialogs[0]?.folders, false, "不是目录选择器（用户 2026-10-20 报的困惑）");
      assert.strictEqual(client.rows.length, 1, "会话是先前落好的那一条，入口不再另建");
      assert.strictEqual(chips(c).length, 1, "文件芯片照旧收下");
      assert.strictEqual(chips(c)[0]?.upload?.status, "ready", "上传结算为 ready（带内容身份）");
      assert.strictEqual(client.uploads.length, 1, "上传的是这一枚文件");
      assert.ok(client.uploads[0]?.endsWith("note.txt"), `上传名取自附件路径：${client.uploads[0]}`);
      assert.deepStrictEqual(rejectNotices(frames), [], "成功路径不出现拒收提示");
    } finally {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog = originalDialog;
    }
  }

  // ---------- 五、混批失败：整批拒收，不留下半批芯片 ----------
  {
    const { c, client, frames } = makeController();
    await c.addPaths("v1", [filePath, imagePath], "button");
    console.log(`  混批无目录：芯片 ${chips(c).length} 枚、上传 ${client.uploads.length} 次`);
    assert.strictEqual(chips(c).length, 0, "文件 + 图片的混批整批拒收（图片也不单独留下）");
    assert.strictEqual(client.uploads.length, 0, "没有任何上传");
    assert.deepStrictEqual(rejectNotices(frames), ["@attachNeedsWorkspace"], "只报会话门这一条原因");
  }

  // ---------- 六、宿主兜底：投影里有未就绪文件时，直发的 send 帧不提交、草稿原样推回 ----------
  {
    const { c, client, frames } = makeController({ dir: CWD });
    c.attachments.add("v1", [
      { id: "a1", kind: "file", name: "note.txt", upload: { status: "uploading", loaded: 0 } },
    ]);
    c.drafts.set("v1", "还没发出去的一句话");
    frames.length = 0;
    await c.handle({ type: "send", text: "还没发出去的一句话", gesture: "enter" }, "v1");
    const patch = (() => {
      for (let index = frames.length - 1; index >= 0; index -= 1) {
        const frame = frames[index].frame;
        const holder = frame.type === "patch" ? frame.patch : undefined;
        if (holder && typeof holder === "object" && "draft" in holder) {
          return holder as { draft?: string; attachments?: unknown[] };
        }
      }
      return undefined;
    })();
    console.log(
      `  宿主兜底：prompt ${client.prompts.length} 次、芯片 ${chips(c).length} 枚、回推草稿 ${JSON.stringify(patch?.draft)}`,
    );
    assert.strictEqual(client.prompts.length, 0, "文件未就绪时宿主不提交 prompt");
    assert.strictEqual(chips(c).length, 1, "芯片没有被移走（beginSend 没执行）");
    assert.strictEqual(chips(c)[0]?.upload?.status, "uploading", "芯片仍是上传中");
    assert.strictEqual(patch?.draft, "还没发出去的一句话", "宿主账本里的草稿原样重新镜像一帧");
    assert.strictEqual(patch?.attachments?.length, 1, "同一帧把附件列表也推回去（界面不必等下一次投影）");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("attachIntakeGate: 无会话整批拒收、按原因提示、正常空态照旧上传 ✓");
