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
execFileSync(
  process.execPath,
  [join(root, "node_modules", "@vscode", "vsce", "vsce"), "package", "--no-dependencies", "-o", out],
  { cwd: root, stdio: "inherit" },
);
