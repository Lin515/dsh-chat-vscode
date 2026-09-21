/**
 * `dsh/clipboardPaths.ts` 的离线断言。
 *
 * 为什么值得单独一套：这是**唯一**能拿到「粘贴进来的文件/目录真路径」的地方
 * （webview 侧实测拿不到，见 `src/webview/attachIntake.ts` 的文件头）。它一旦坏掉，
 * 症状是「粘贴目录又变成 0 字节附件 / 大文件又被 8 MB 挡住」——不是报错，是**静默退化**，
 * 所以把判据里最容易坏的三处钉住：
 *
 * 1. **解析**：PowerShell 逐行输出 → 路径列表（空输出 = 没有）；
 * 2. **脚本形状**：UTF-8 输出编码（否则中文路径乱码）、`-Sta`（WinForms 剪贴板要求）、
 *    `GetFileDropList`、`windowsHide`、超时——少一条都会变成「读不出来」；
 * 3. **平台闸门**：非 Windows 直接返回空数组，不猜路径（上层随即退回字节通道）。
 *
 * 另有一条**真调用**：在 Windows 上跑一次真的读取，断言它 resolves 成数组而不是抛
 * （脚本引号 / 参数写错时只有真跑才会暴露）。**只读**，不动用户的剪贴板内容。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseClipboardPaths, readClipboardPaths } from "../src/dsh/clipboardPaths";

// ---------- 1. 解析：逐行、去空、去行尾空白 ----------

assert.deepStrictEqual(parseClipboardPaths(""), [], "空输出 = 剪贴板里没有文件（不是错误）");
assert.deepStrictEqual(parseClipboardPaths("\r\n"), [], "只有空行 = 没有");
assert.deepStrictEqual(parseClipboardPaths("D:\\a\\b.txt"), ["D:\\a\\b.txt"], "单行原样");
assert.deepStrictEqual(
  parseClipboardPaths("C:\\a.txt\r\n\r\n  D:\\目录 with space\\b.png  \r\n"),
  ["C:\\a.txt", "D:\\目录 with space\\b.png"],
  "多行：空行丢掉、行尾空白去掉（路径里的空格不动）",
);
assert.deepStrictEqual(
  parseClipboardPaths("\\\\server\\share\\a.txt\n//posix/style\n"),
  ["\\\\server\\share\\a.txt", "//posix/style"],
  "UNC 与 posix 形态一视同仁（解析不假设平台）",
);
console.log("clipboardPaths: 输出解析（空 / 多行 / 行尾空白 / UNC）✓");

// ---------- 2. 脚本形状：五条缺一不可的细节 ----------

{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "clipboardPaths.ts"), "utf8");
  assert.ok(
    /process\.platform !== "win32"[\s\S]{0,80}?return \[\]/.test(source),
    "非 Windows 直接返回空数组：拿不到路径不是错误，交给上层的字节通道兜底",
  );
  assert.ok(
    /\[Console\]::OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(source),
    "必须显式设 UTF-8：5.1 默认按 OEM 代码页写管道，中文路径会乱码（表现为「粘贴没反应」）",
  );
  assert.ok(/"-Sta"/.test(source), "WinForms 的 Clipboard 要求 STA 线程（MTA 下直接抛 ThreadStateException）",
  );
  assert.ok(/GetFileDropList\(\)/.test(source), "读的就是文件拖放列表");
  assert.ok(/windowsHide: true/.test(source), "别在用户面前闪一个黑框（扩展宿主是后台进程）");
  assert.ok(/timeout: TIMEOUT_MS/.test(source), "卡住要能超时放弃，不能让粘贴一直悬着");
  // 脚本是常量、不经插值：路径只从剪贴板出来，不会被拼进脚本（没有注入面）
  const scriptBlock = /const CLIPBOARD_SCRIPT = \[([\s\S]*?)\]\.join/.exec(source)?.[1] ?? "";
  assert.ok(scriptBlock.length > 0, "找不到 CLIPBOARD_SCRIPT —— 结构变了，这条断言要跟着改");
  assert.ok(!/\$\{/.test(scriptBlock), "脚本里不许有模板插值");
  console.log("clipboardPaths: 脚本形状（UTF-8 / STA / 超时 / 无插值）✓");
}

// ---------- 3. 真调用：脚本能跑起来并 resolve 成数组 ----------
//
// 只断言形状，**不断言内容**：内容取决于用户此刻剪贴板里有什么，那是不确定的事实
// （AGENTS.md：断言只钉确定的事实）。这条防的是「参数/引号写错导致 spawn 就失败」。
{
  const paths = await readClipboardPaths();
  assert.ok(Array.isArray(paths), `readClipboardPaths 必须 resolve 成数组，实际 ${typeof paths}`);
  assert.ok(
    paths.every((path) => typeof path === "string" && path.length > 0),
    `路径列表里不该有空串或非字符串：${JSON.stringify(paths)}`,
  );
  const note = process.platform === "win32" ? `本机剪贴板里有 ${paths.length} 个路径` : "非 Windows，按约定返回空数组";
  console.log(`clipboardPaths: 真调用一次（${note}）✓`);
}

console.log("\nclipboardPaths: all assertions passed");
