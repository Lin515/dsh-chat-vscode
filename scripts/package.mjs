/**
 * 打包 vsix：读 package.json 的 version，命名 Releases/dsh-chat-<version>.vsix。
 *
 * 不用 `vsce package -o ...$npm_package_version` 的 shell 变量展开：
 * 新版 npm 在 Windows 上把脚本参数直接交给 PowerShell，`$npm_package_version`
 * 会被 PS 当成（空）变量先解析掉，产出文件名变成 `dsh-chat-.vsix`。
 * 这里改用 node 读 manifest 的 version，跨平台一致。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "Releases", `dsh-chat-${manifest.version}.vsix`);
mkdirSync(join(root, "Releases"), { recursive: true });

// 直接 node 执行 vsce 入口（node_modules/@vscode/vsce/vsce），
// 绕开 .cmd shim / npx 在 Windows 上的 PATH 问题
//
// README 演示图走 GitHub raw 外链：README 保持相对路径（docs/demo.png），
// vsce 按 repository.url 自动改写成 raw 绝对 URL——所以仓库必须公开且
// 图片已推送，否则扩展详情页 404 裂图。
// --no-githubIssueLinking：README 里的 "#982" 指的是官方 dsh 仓库的
// discussion，不要被改写成自己仓库的 issue 链接。
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "@vscode", "vsce", "vsce"),
    "package",
    "--no-dependencies",
    "--no-gitHubIssueLinking",
    "-o",
    out,
  ],
  { cwd: root, stdio: "inherit" },
);
