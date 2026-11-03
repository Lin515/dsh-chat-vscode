/**
 * 真实文件打开的本机一致性校验（纯判据 + 真 ChatController 离线行为）。
 *
 * 连接类型不参与准入：内部后台、桌面端与外部连接都只在路径形态、本机存在性、
 * 大小与逐字节内容一致时用 `file:` 打开；任何一项不满足都回退只读并提示。
 * 外部连接不再因为“地址不是本机”被提前拒绝，但内容比较也不证明另一执行世界的
 * 副本就是原件——这是用户显式按住 Alt 时接受的风险。
 *
 * VS Code 和文件读取使用替身，不启动 DSH，不访问网络、不消耗模型 token。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { ChatController } from "../src/dsh/controller";
import { decodeRemoteFileAddress } from "../src/dsh/remoteFileAddress";
import { isLocalAbsolutePath, localPlatform, sameBytes } from "../src/dsh/localPath";

// ---------- 1. 平台家族 ----------
{
  assert.strictEqual(localPlatform("win32"), "win32");
  assert.strictEqual(localPlatform("darwin"), "posix");
  assert.strictEqual(localPlatform("linux"), "posix");
}
console.log("localPath: process.platform 归一到 win32 / posix ✓");

// ---------- 2. 本机绝对路径形态 ----------
{
  for (const path of ["C:/dev/a.ts", "C:\\dev\\a.ts", "\\\\server\\share\\a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "win32"), true, `Windows 应认：${path}`);
  }
  for (const path of ["/work/demo/a.ts", "C:a.ts", "src/a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "win32"), false, `Windows 不应认：${path}`);
  }
  for (const path of ["/work/demo/a.ts", "//server/share/a.ts"]) {
    assert.strictEqual(isLocalAbsolutePath(path, "posix"), true, `POSIX 应认：${path}`);
  }
  for (const path of ["C:/dev/a.ts", "/", "src/a.ts", "\\\\server\\share\\a.ts"]) {
    // "/" 是根目录，不是可打开的文件；形态上仍然是本机绝对路径。
    if (path === "/") continue;
    assert.strictEqual(isLocalAbsolutePath(path, "posix"), false, `POSIX 不应认：${path}`);
  }
  assert.strictEqual(isLocalAbsolutePath("/", "posix"), true);
}
console.log("localPath: 本机绝对路径形态按平台收窄（盘符 / UNC / POSIX 根） ✓");

// ---------- 3. 字节身份 ----------
{
  const base = new Uint8Array([1, 2, 3]);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 3])), true);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2])), false);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 4])), false);
  assert.strictEqual(sameBytes(new Uint8Array(), new Uint8Array()), true);
}
console.log("localPath: 本机副本与执行世界必须逐字节一致 ✓");

// ---------- 4. 真打开链：外部也按内容准入 / 不一致回退 ----------
interface Scenario {
  baseUrl?: string;
  real?: boolean;
  size?: number;
  missingSize?: boolean;
  localSize?: number;
  localData?: Uint8Array;
  localMissing?: boolean;
  absolutePath?: string;
}
interface OpenPort {
  openFile(path: string, diff: boolean, viewId: string, sessionId: string,
    line: undefined, fromLink: boolean, changes: undefined, real: boolean): Promise<void>;
}
const FILE = join(tmpdir(), "dsh-chat-native-open", "sample.txt");
const DATA = new Uint8Array([1, 2, 3]);
const VERIFY_LIMIT = 8 * 1024 * 1024;
// 只替换 IO：控制器的 statOpenTarget、真实文件校验与只读回退均运行生产实现。
async function openScenario(options: Scenario) {
  const opened: { scheme: string; path?: string; query?: string }[] = [];
  const notifications: { text?: string }[] = [];
  let localStats = 0;
  let localReads = 0;
  let hostReads = 0;
  const size = options.size ?? DATA.length;
  const stat = { absolutePath: options.absolutePath ?? FILE, version: "v1", ...(options.missingSize ? {} : { bytes: size }) };
  const access = {
    connectionId: "native-open-connection",
    async stat(sessionId: string, path: string) {
      assert.strictEqual(sessionId, "native-session");
      assert.strictEqual(path, FILE);
      return stat;
    },
    async readBytes() { hostReads++; return { stat, data: DATA }; },
  };
  const controller = Object.assign(Object.create(ChatController.prototype), {
    client: { baseUrl: options.baseUrl ?? "http://127.0.0.1:3456" }, hostFiles: access,
    viewSessions: new Map([["native-view", "native-session"]]),
    log: () => undefined,
    notify: (notification: { text?: string }) => notifications.push(notification),
  }) as OpenPort;
  const oldFs = vscode.workspace.fs;
  const oldCommand = vscode.commands.executeCommand;
  Object.assign(vscode.workspace, { fs: {
    async stat() {
      localStats++;
      if (options.localMissing) throw new Error("fixture: local missing");
      return { type: vscode.FileType.File, size: options.localSize ?? size };
    },
    async readFile() { localReads++; return options.localData ?? DATA; },
  } });
  vscode.commands.executeCommand = async (_command: string, uri: unknown) => {
    opened.push(uri as typeof opened[number]);
    return undefined as never;
  };
  try {
    await controller.openFile(FILE, false, "native-view", "native-session", undefined, true, undefined, options.real ?? true);
  } finally {
    Object.assign(vscode.workspace, { fs: oldFs });
    vscode.commands.executeCommand = oldCommand;
  }
  return { opened, notifications, localStats, localReads, hostReads };
}
function assertReal(result: Awaited<ReturnType<typeof openScenario>>): void {
  assert.strictEqual(result.opened.length, 1);
  assert.strictEqual(result.opened[0].scheme, "file");
  assert.strictEqual(result.notifications.length, 0);
  assert.strictEqual(result.localStats, 1);
  assert.strictEqual(result.localReads, 1);
  assert.strictEqual(result.hostReads, 1);
}
function assertReadonly(result: Awaited<ReturnType<typeof openScenario>>, notify = true): void {
  assert.strictEqual(result.opened.length, 1);
  assert.strictEqual(result.opened[0].scheme, "dsh-chat-world");
  const identity = decodeRemoteFileAddress((result.opened[0].query ?? "").slice(3));
  assert.strictEqual(identity?.sessionId, "native-session", "回退仍绑定原会话");
  assert.strictEqual(identity?.connectionId, "native-open-connection", "回退仍绑定原连接");
  assert.deepStrictEqual(result.notifications.map((item) => item.text), notify ? ["@realFileUnavailable"] : []);
}
// 外部连接（含远端地址）也走同一套内容校验：本机同路径且内容一致即可编辑。
for (const baseUrl of ["http://127.0.0.1:3456", "http://localhost:3456", "http://[::1]:3456", "https://remote.example"]) {
  assertReal(await openScenario({ baseUrl }));
}
// 路径形态不符：不得碰本机文件系统。
{
  const result = await openScenario({
    absolutePath: process.platform === "win32" ? "/remote/sample.txt" : "C:/remote/sample.txt",
  });
  assertReadonly(result);
  assert.strictEqual(result.localStats + result.localReads + result.hostReads, 0, "形态不符不得读本机或 Host");
}
// 本机缺失 / 大小不一致 / Host 缺大小 / 内容不一致：回退只读。
assertReadonly(await openScenario({ localMissing: true }));
for (const scenario of [
  { localSize: 4 },
  { missingSize: true },
  { localData: new Uint8Array([1, 2, 4]) },
]) {
  const result = await openScenario(scenario);
  assertReadonly(result);
  assert.strictEqual(result.localStats, 1, "走到本机校验后才判定不一致");
}
{
  const result = await openScenario({ localData: new Uint8Array([1, 2, 4]) });
  assert.strictEqual(result.localReads, 1);
  assert.strictEqual(result.hostReads, 1);
}
// 超过逐字节校验上限：无法证明内容一致，不读本机字节也不读 Host 字节。
{
  const size = VERIFY_LIMIT + 1;
  const result = await openScenario({ size, localSize: size });
  assertReadonly(result);
  assert.strictEqual(result.localReads, 0, "超限文件不得读本机字节");
  assert.strictEqual(result.hostReads, 0, "超限文件不得读 Host 字节");
}
// 普通单击仍只读，不进入本机校验。
{
  const result = await openScenario({ baseUrl: "https://remote.example", real: false });
  assertReadonly(result, false);
  assert.strictEqual(result.localStats, 0, "普通单击仍只读，不进入本机校验");
}
console.log("localPath: 真 ChatController 验证按内容打开、不一致零误读与原连接只读回退 ✓");
console.log("\nlocalPath: all assertions passed");
