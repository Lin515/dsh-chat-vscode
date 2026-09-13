/**
 * supervisor 的**真实启动器**（设计 §3.0.1）：用 VS Code 自带的 Node 跑 `dist/supervisor.js`。
 *
 * 单独一个文件，是为了让"扩展宿主"与"无头探针"共用同一份启动逻辑：
 * - 扩展里 `createSupervisorLauncher()` 用 `vscode.env.appRoot` 取到 VS Code 的运行时；
 * - 探针里用当前运行时（Node 或 VS Code 的 Electron，都是"能跑 JS 的东西"）。
 *
 * **不变量**：supervisor 必须与调用它的那个进程解耦（detached + unref），
 * 否则窗口一关它就陪葬——整个架构的前提就没了。
 */
import { closeSync, mkdirSync, openSync } from "node:fs";
import { logFileIn } from "./supervisorProtocol";
import { findSupervisorScript, resolveNodeRuntime, spawnDetached, runRuntimeSelfCheck, type NodeRuntime } from "./runtimeResolve";
import type { LaunchOutcome, SupervisorLauncher } from "./supervisorClient";

/** 解析 VS Code 的安装根目录（appRoot）下的可执行文件；拿不到时返回 undefined。 */
export interface LauncherOptions {
  /**
   * 扩展宿主里传 `vscode.env.appRoot`；探针不传（用当前运行时）。
   *
   * 传 `undefined` 与传字符串都会走同一条解析链：见 `resolveNodeRuntime`。
   */
  appRoot?: string;
  /** 自检（跑一次 `-e` 确认运行时可用）：默认只在第一次启动时做一次。 */
  selfCheck?: boolean;
  log: (line: string) => void;
}

/** supervisor 脚本的位置（随扩展分发：`dist/supervisor.js`）。 */
export function supervisorScriptPath(extensionPath: string): string {
  return `${extensionPath}/dist/supervisor.js`;
}

/**
 * 默认启动器：脚本路径自动找（见 `findSupervisorScript`），运行时固定用 VS Code 自带的。
 *
 * 扩展里传 `context.extensionPath`；探针什么都不用传（`findSupervisorScript` 会按
 * "本模块所在目录的 ../dist" 找到它）。这样探针不必关心扩展目录，只管要一个后台。
 */
export function createDefaultSupervisorLauncher(options: { extensionPath?: string; appRoot?: string; log: (line: string) => void }): SupervisorLauncher {
  const path = findSupervisorScript(options.extensionPath) ?? supervisorScriptPath(options.extensionPath ?? process.cwd());
  return createSupervisorLauncherForScript(path, { appRoot: options.appRoot, log: options.log });
}

/**
 * 造一个真实启动器（脚本路径显式给定）。
 *
 * @param script `dist/supervisor.js` 的绝对路径。
 */
export function createSupervisorLauncherForScript(script: string, options: LauncherOptions): SupervisorLauncher {
  let checked = false;
  return {
    async launch(input): Promise<LaunchOutcome> {
      const runtime: NodeRuntime = resolveNodeRuntime(options.appRoot);
      try {
        mkdirSync(input.directory, { recursive: true });
      } catch (error) {
        return { ok: false, reason: `创建会合目录失败：${error instanceof Error ? error.message : String(error)}` };
      }

      // 起 supervisor 之前先确认"这个运行时真的能跑 JS"：不能的话后面所有症状都是"后台起不来"，
      // 很难看出根因。只自检一次（同一个扩展实例里运行时不会变）。
      if ((options.selfCheck ?? true) && !checked) {
        checked = true;
        try {
          const out = await runRuntimeSelfCheck(runtime, "process.stdout.write(process.version)");
          options.log(`[supervisor] 运行时 ${runtime.execPath}（node ${out}）`);
        } catch (error) {
          return {
            ok: false,
            reason: `VS Code 自带的运行时不可用（${runtime.execPath}）：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }

      let logFd: number;
      try {
        logFd = openSync(logFileIn(input.directory), "a");
      } catch (error) {
        return { ok: false, reason: `打开 supervisor 日志失败：${error instanceof Error ? error.message : String(error)}` };
      }
      try {
        // 分组名 = 会合目录的最后一段（目录本身就是按分组算出来的，见 `supervisorDirectory`）。
        // socket 路径用 `initialStartInput` 已经算好的那个，**不要在这里重算**：两处算法一旦漂移，
        // 扩展会连到一个没人监听的地址上。
        const group = input.directory.split(/[\\/]/).filter(Boolean).pop() ?? "default";
        const args = [
          "--directory",
          input.directory,
          "--group",
          group,
          // 命令走 base64：明文的"带空格一整串"会被中间层（shell / Start-Process / cmd）
          // 按空格拆开，supervisor 就只剩 `dsh` 了（实测：dsh 报 `--profile <name> is required`）
          "--command-b64",
          Buffer.from(input.command, "utf8").toString("base64"),
          "--idle-sec",
          String(input.idleSec),
          "--socket",
          input.socket,
        ];
        spawnDetached(runtime, script, args, logFd);
        options.log(`[supervisor] 已拉起 supervisor（脚本 ${script}）`);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: `拉起 supervisor 失败：${error instanceof Error ? error.message : String(error)}` };
      } finally {
        try {
          closeSync(logFd);
        } catch {
          // 忽略
        }
      }
    },
  };
}
