/**
 * supervisor 的**运行时**：固定用 VS Code 自带的那个 Node（用户口径 2026-09-13，见设计 §3.0.1）。
 *
 * 为什么不用 PATH 上的 `node`：dsh 是社区生态，发行形态很多——可能是 npm 装的 JS CLI
 * （那时机器上必然有 node），**也可能是别人打包好的独立可执行文件**（那时机器上可能压根没有 node）。
 * 所以"PATH 上有 node"不是可以依赖的前提；而扩展宿主本身就跑在 VS Code 自带的 Electron 上，
 * 那个必然存在。也不提供"手动指定运行时"的配置项：能跑起扩展就说明运行时在，
 * 多一个配置项只会多一类"填错/填了旧版"的故障面。
 *
 * 本机实测（`Code.exe` + `ELECTRON_RUN_AS_NODE=1`）：
 * ```text
 * {"execPath":"D:\\Software\\Microsoft VS Code\\Code.exe","node":"v24.18.1","abi":"146","electron":"42.10.0"}
 * ```
 * 安装目录里只有 `Code.exe`（没有随附的 node.exe），所以 `ELECTRON_RUN_AS_NODE` 是唯一入口，
 * 也是 VS Code 扩展生态里 spawn Node 子进程的标准手法。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 一份"可以直接拿来跑 JS 文件"的运行时。 */
export interface NodeRuntime {
  /** 可执行文件（通常是 `Code.exe`）。 */
  execPath: string;
  /**
   * 跑它必须补的环境变量。
   *
   * `ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 方式启动；
   * 其余 `ELECTRON_*` 变体一并清掉，避免"某个变体把这个进程又变成别的角色"。
   */
  env: NodeJS.ProcessEnv;
}

/**
 * 取 VS Code 自带的运行时。
 *
 * @param appRoot 宿主侧传 `vscode.env.appRoot`；拿不到就只试 `process.execPath`。
 *                传参而不是直接 import `vscode`：这样断言与探针都能离线用它。
 */
export function resolveNodeRuntime(appRoot?: string): NodeRuntime {
  const candidates: string[] = [];
  // 扩展宿主里 process.execPath 通常就是 Code.exe；远程/特殊安装形态下可能不是，所以再试 appRoot
  if (process.execPath) candidates.push(process.execPath);
  if (appRoot) {
    candidates.push(join(appRoot, process.platform === "win32" ? "Code.exe" : "code"));
    candidates.push(join(appRoot, "..", process.platform === "win32" ? "Code.exe" : "code"));
  }
  const execPath = candidates.find((candidate) => existsSync(candidate)) ?? process.execPath;
  return { execPath, env: runtimeEnv(process.env) };
}

/**
 * 找 `supervisor.js`：随扩展分发的那个脚本。
 *
 * 三处候选（按可靠性排序）：
 * 1. 扩展安装目录（`context.extensionPath`）——扩展运行时的正解；
 * 2. 本模块所在目录的 `../dist`（打包进 `build/*.mjs` 的探针走这条）；
 * 3. 当前工作目录下的 `dist`（在仓库根跑探针时的兜底）。
 *
 * 这条"自动找"是为了让**探针不必关心扩展目录**：它们只想要一个能跑的后台。
 */
export function findSupervisorScript(extensionPath?: string): string | undefined {
  const candidates: string[] = [];
  if (extensionPath) candidates.push(join(extensionPath, "dist", "supervisor.js"));
  // 打包后的探针里 __dirname 是 <repo>/build
  try {
    if (typeof __dirname === "string") candidates.push(join(__dirname, "..", "dist", "supervisor.js"));
  } catch {
    // ESM 下没有 __dirname
  }
  candidates.push(join(process.cwd(), "dist", "supervisor.js"));
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * 给"以 Node 方式跑"的子进程准备环境变量。
 *
 * **先清后设**是刻意的：`ELECTRON_RUN_AS_NODE` 必须由我们显式设置为 `"1"`，
 * 而不是继承——继承来的可能是 `"0"` 甚至是空串（语义随版本变化），
 * 而那些变体一旦生效，spawn 出来的就不是 Node，报错也会非常难懂。
 */
export function runtimeEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ELECTRON_RUN_AS_NODE: "1" };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.ELECTRON_FORCE_WINDOW_MENU_BAR;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ELECTRON_ENABLE_STACK_DUMPING;
  return env;
}

/** 把一段 JS 表达式交给该运行时执行（自检/诊断用；返回 stdout）。 */
export function runRuntimeSelfCheck(runtime: NodeRuntime, expression: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.execPath, ["-e", expression], {
      env: runtime.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("runtime self-check timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`runtime self-check exited ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

/**
 * 启动一个**与扩展宿主生命周期解耦**的子进程。
 *
 * 三个参数都是踩出来的：
 * - `detached: true` + `unref()`：不这么做，窗口一关 supervisor 就跟着陪葬
 *   （整个架构的前提就是"它不依赖 VS Code 活着"）；
 * - `windowsHide: true`：否则 Windows 上会闪一个控制台窗口；
 * - `stdio: ["ignore", fd, fd]`：输出直接进日志文件（管道会拖住调用方，见设计文档 §8）。
 */
export function spawnDetached(
  runtime: NodeRuntime,
  script: string,
  args: string[],
  logFd: number,
): ChildProcess {
  const child = spawn(runtime.execPath, [script, ...args], {
    env: runtime.env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child;
}
