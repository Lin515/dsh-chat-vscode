import { execFile } from "node:child_process";

/**
 * 从**系统剪贴板**读「文件 / 目录」列表 —— 粘贴文件时唯一能拿到**真路径**的地方。
 *
 * ## 为什么非要有它
 *
 * webview 侧拿不到路径（2026-09-21 实测，VS Code 1.138 / Chromium）：
 * 复制目录或文件后粘贴，`clipboardData.types` 只有 `["Files"]`，
 * `text/uri-list` 与 `text/plain` **都是空串**，`File.name` 只有 basename，
 * `File.path` 自 Electron 32 起已移除。没有路径，「粘贴」就只能走字节通道：
 * 目录读不出字节（只能报错）、大文件被 8 MB 的 base64 通道上限挡住——
 * 而这两件事用户都明确要求「和添加附件一样」（用户 2026-09-21 口径）。
 *
 * 拿到真路径之后，粘贴按**路径的类别**分流（`controller` 的 `attachBytes` 分支）：
 * - **目录 → `@dir/` 引用**：把路径写进正文（与资源管理器右键文件夹、命令面板
 *   「添加文件夹」同一条路）。用户 2026-09-21 的二次口径明确：粘贴文件夹不该变成附件芯片；
 * - **文件 → 附件通道**：图片内联成内容块（超内联上限则改上传）、其余文件逐字节上传，
 *   不限大小也不挑类型——与回形针选同一个文件完全一样（用户同日一次口径：
 *   「通过剪切板粘贴文件，行为要和附件上传一样」）。
 *
 * ## 为什么是 Windows PowerShell
 *
 * VS Code 的扩展宿主是 Node（不是 Electron 渲染进程），拿不到 Electron 的
 * `clipboard` 模块；扩展 API 里也只有 `vscode.env.clipboard.readText()`（纯文本）。
 * Windows 上唯一现成的「读文件拖放列表」通道就是 WinForms 的
 * `Clipboard.GetFileDropList()`，它要求 **STA 线程**，所以脚本跑在
 * `powershell.exe -Sta` 里（Windows PowerShell 5.1 在每台 Windows 上都有；
 * 找不到时退回 `pwsh.exe`）。
 *
 * ## 拿不到就当作「没有」——绝不猜
 *
 * 非 Windows、PowerShell 缺失、剪贴板被别的程序锁住（`OpenClipboard Failed`）、
 * 超时……一律返回空数组，上层随即退回字节通道（截图那类剪贴板里本来就没有文件的
 * 形态走的正是这条路）。读取失败**不是**错误路径：它只是意味着这次粘贴没有路径可用。
 *
 * 脚本是**固定的常量**、不经任何插值：路径只从剪贴板**出来**，不会被拼进脚本。
 */

/** 打印剪贴板里的文件/目录路径，每行一个（没有时什么都不打印）。 */
const CLIPBOARD_SCRIPT = [
  // 非 ASCII 路径必须显式设成 UTF-8：Windows PowerShell 5.1 默认按 OEM 代码页
  // 往管道写，中文/日文路径会变成乱码（乱码路径 stat 不到，表现为「粘贴没反应」）
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Windows.Forms",
  "[System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { $_ }",
].join("; ");

/** 先试 Windows PowerShell（5.1 每台机器都有），再试 PowerShell 7。 */
const SHELLS = ["powershell.exe", "pwsh.exe"];

/** 读一次剪贴板的超时：卡住时立刻放弃并回退字节通道，不让用户干等。 */
const TIMEOUT_MS = 5000;

/**
 * PowerShell 输出 → 路径列表（纯函数，便于离线断言）。
 *
 * 逐行去空白、丢掉空行；`GetFileDropList()` 没有内容时脚本什么都不打印，
 * 于是这里得到空数组。
 */
export function parseClipboardPaths(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 跑一次 PowerShell 脚本并原样回传 stdout；失败（含超时）返回 undefined。 */
function runPowerShell(script: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const attempt = (index: number): void => {
      const shell = SHELLS[index];
      if (!shell) {
        resolve(undefined);
        return;
      }
      execFile(
        shell,
        ["-NoProfile", "-NonInteractive", "-Sta", "-Command", script],
        // windowsHide：别闪一个黑框出来（扩展宿主是后台进程，控制台窗口会很明显）
        { windowsHide: true, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          // ENOENT（没这个 shell）才值得换下一个；其余失败（策略禁止、剪贴板被占、
          // 超时）换 shell 也一样，直接给「没有」
          if (!error) {
            resolve(stdout);
            return;
          }
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            attempt(index + 1);
            return;
          }
          resolve(undefined);
        },
      );
    };
    attempt(0);
  });
}

/**
 * 读系统剪贴板里的文件 / 目录路径（没有或读不到时返回空数组）。
 *
 * **只读、不等待用户动作**：调用点是「用户刚按下 Ctrl+V」，剪贴板内容就是他粘的
 * 那一份。调用方（controller）只在 `source === "paste"` 时调它。
 */
export async function readClipboardPaths(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  const stdout = await runPowerShell(CLIPBOARD_SCRIPT);
  return stdout ? parseClipboardPaths(stdout) : [];
}
