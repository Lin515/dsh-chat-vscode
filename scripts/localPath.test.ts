/**
 * 真实文件打开的原生准入（纯判据 + 真 ChatController 离线行为）。
 *
 * 标准内部启动 / 本机桌面端才允许编辑；外部回环、包装命令和证据缺失保持只读。
 * 路径形态与内容比较只是附加一致性检查，不能证明不同执行世界的副本是原件。
 * VS Code 和文件读取使用替身，不启动 DSH，不访问网络、不消耗模型 token。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { ChatController } from "../src/dsh/controller";
import type { Ownership, ServerState } from "../src/dsh/supervisorManager";
import { decodeRemoteFileAddress } from "../src/dsh/remoteFileAddress";
import {
  isLocalAbsolutePath,
  isNativeDshCommand,
  localPlatform,
  sameBytes,
} from "../src/dsh/localPath";

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

// ---------- 3. 已知原生启动命令 ----------
{
  for (const command of ["dsh web", "dsh web --port 0 --no-open", "dsh.cmd web --no-open --port 65535", " dsh.exe\tweb "]) {
    assert.strictEqual(isNativeDshCommand(command), true, `应认标准原生启动：${command}`);
  }
  for (const command of [undefined, "", "wsl dsh web", "ssh host dsh web", "docker run image dsh web",
    "bash -c 'dsh web'", "custom-launcher web", "/opt/tools/dsh web", "dsh web && ssh host",
    "dsh web; echo ready", "dsh web\nssh host", "dsh web --unknown", "dsh web --port", "dsh web --port -1",
    "dsh web --port 65536", "dsh web --port 0 --port 1", "dsh web --no-open --no-open"]) {
    assert.strictEqual(isNativeDshCommand(command), false, `未知启动不能算原生：${command}`);
  }
}
console.log("localPath: 原生启动命令收窄，WSL / SSH / 容器 / shell 包装一律未知 ✓");

// ---------- 4. 字节身份 ----------
{
  const base = new Uint8Array([1, 2, 3]);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 3])), true);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2])), false);
  assert.strictEqual(sameBytes(base, new Uint8Array([1, 2, 4])), false);
  assert.strictEqual(sameBytes(new Uint8Array(), new Uint8Array()), true);
}
console.log("localPath: 本机副本与执行世界必须逐字节一致 ✓");

// ---------- 5. 真打开链：原生准入 / 只读回退 ----------
interface Scenario {
  ownership?: Ownership;
  command?: string;
  state?: ServerState;
  remembered?: boolean;
  stateUrl?: string;
  baseUrl?: string;
  target?: "internal" | "desktop";
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
// 只替换 IO：控制器的 statOpenTarget、真实文件准入与只读回退均运行生产实现。
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
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:3456";
  const controller = Object.assign(Object.create(ChatController.prototype), {
    client: { baseUrl }, hostFiles: access,
    target: { kind: options.target ?? "internal" },
    viewSessions: new Map([["native-view", "native-session"]]),
    server: { snapshot: () => ({
      status: { state: options.state ?? "ready", info: { ownership: options.ownership, baseUrl } },
      state: { command: options.command, baseUrl: options.stateUrl ?? baseUrl },
      remembered: options.remembered ?? true,
    }) },
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
function assertReadonly(result: Awaited<ReturnType<typeof openScenario>>, notify = true): void {
  assert.strictEqual(result.opened.length, 1);
  assert.strictEqual(result.opened[0].scheme, "dsh-chat-world");
  const identity = decodeRemoteFileAddress((result.opened[0].query ?? "").slice(3));
  assert.strictEqual(identity?.sessionId, "native-session", "回退仍绑定原会话");
  assert.strictEqual(identity?.connectionId, "native-open-connection", "回退仍绑定原连接");
  assert.deepStrictEqual(result.notifications.map((item) => item.text), notify ? ["@realFileUnavailable"] : []);
}
for (const ownership of ["self", "peer", "desktop"] as const) {
  const result = await openScenario({ ownership, command: ownership === "desktop" ? undefined : "dsh web --port 0 --no-open" });
  assert.strictEqual(result.opened[0]?.scheme, "file", `${ownership} 原生链路可开真实文件`);
  assert.strictEqual(result.localStats, 1);
  assert.strictEqual(result.localReads, 1);
  assert.strictEqual(result.hostReads, 1);
  assert.strictEqual(result.notifications.length, 0);
}
// 同名、同内容的本地副本也不能给外部连接提供原件身份；大文件不比较字节也不能绕过。
for (const baseUrl of ["http://127.0.0.1:3456", "http://localhost:3456", "http://[::1]:3456", "https://remote.example"]) {
  for (const size of [DATA.length, 9 * 1024 * 1024]) {
    const result = await openScenario({ ownership: "external", command: "dsh web", baseUrl, size });
    assertReadonly(result);
    assert.strictEqual(result.localStats + result.localReads + result.hostReads, 0, "未知环境不得尝试本机副本");
  }
}
for (const scenario of [
  { target: "internal" }, { target: "desktop" },
  { ownership: "self" }, { ownership: "peer", command: "wsl dsh web" },
  { ownership: "self", command: "ssh host dsh web" },
  { ownership: "self", command: "docker run image dsh web" },
  { ownership: "self", command: "dsh web", remembered: false },
  { ownership: "self", command: "dsh web", stateUrl: "http://127.0.0.1:9999" },
  { ownership: "desktop", state: "stopped" },
] satisfies Scenario[]) {
  const result = await openScenario(scenario);
  assertReadonly(result);
  assert.strictEqual(result.localStats, 0, "目标偏好、旧状态和未知启动都不是原生证据");
}
for (const scenario of [
  { missingSize: true }, { localSize: 4 }, { localData: new Uint8Array([1, 2, 4]) }, { localMissing: true },
  { absolutePath: process.platform === "win32" ? "/remote/sample.txt" : "C:/remote/sample.txt" },
]) {
  assertReadonly(await openScenario({ ownership: "self", command: "dsh web", ...scenario }));
}
for (const ownership of ["self", "external"] as const) {
  const result = await openScenario({ ownership, command: "dsh web", real: false });
  assertReadonly(result, false);
  assert.strictEqual(result.localStats, 0, "普通单击仍只读，不进入本机校验");
}
console.log("localPath: 真 ChatController 验证原生打开、外部/未知零本机读取、原会话只读回退与一致性守门 ✓");
console.log("\nlocalPath: all assertions passed");
