/**
 * 安装 vsix 到本机 VS Code（**顺带压掉 VS Code CLI 自己的弃用警告**）。
 *
 * 为什么需要这个脚本——`code --install-extension <vsix>` 会打印：
 *
 * ```text
 * (node:402216) [DEP0169] DeprecationWarning: `url.parse()` behavior is not
 * standardized and prone to errors that have security implications.
 * Use the WHATWG URL API instead. CVEs are not issued for `url.parse()` vulnerabilities.
 * ```
 *
 * **这不是本扩展的问题**，也不是 vsix 里的任何代码：安装阶段扩展根本没被加载。
 * 用 `--trace-deprecation` 取到的调用栈指向 VS Code 自己的 CLI：
 *
 * ```text
 * at urlParse (node:url:136:13)
 * at ly (…/resources/app/out/vs/code/node/cliProcessMain.js:475:22292)
 * at async Qi.queryRawGalleryExtensions (…cliProcessMain.js:453:51826)
 * at async Ds.updateMetadata (…cliProcessMain.js:464:64646)
 * ```
 *
 * 即：VS Code 1.137 的 CLI 在**安装后向应用市场查询该扩展的元数据**
 * （`updateMetadata` → gallery 查询）时用了 `url.parse()`，而它内嵌的 Node 24
 * 把 `url.parse()` 提升为运行时弃用（DEP0169）。命令本身完全成功（退出码 0）。
 *
 * 本扩展无法修改 VS Code 的源码，唯一能做的是**在装的那一刻静音这一类警告**：
 * `NODE_OPTIONS=--no-deprecation` 会被 Electron 的 run-as-node 读取（`code.cmd`
 * 里就有 `ELECTRON_RUN_AS_NODE=1`），实测警告消失、安装照常成功。
 *
 * 用法：
 *   npm run install:vsix                 # 装 Releases/ 下版本号最新的 vsix
 *   npm run install:vsix -- <path.vsix>  # 装指定的那一个
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const releases = join(root, "Releases");

/** 没给参数时：Releases/ 下修改时间最新的 .vsix。 */
function latestVsix() {
  let entries;
  try {
    entries = readdirSync(releases).filter((name) => name.endsWith(".vsix"));
  } catch {
    throw new Error(`没有找到 Releases 目录：${releases}（先跑 npm run package）`);
  }
  if (entries.length === 0) throw new Error(`Releases 下没有 .vsix（先跑 npm run package）`);
  return entries
    .map((name) => ({ name, path: join(releases, name), mtime: statSync(join(releases, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime)[0].path;
}

const target = process.argv[2] ?? latestVsix();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
console.log(`[install] 目标：${target}（package.json 版本 ${version}）`);
console.log(
  "[install] 说明：下面若出现 DEP0169 url.parse 警告，来源是 VS Code 自己的 CLI" +
    "（安装后向市场查元数据），不是本扩展；本脚本已用 NODE_OPTIONS=--no-deprecation 静音。",
);

/**
 * 找到 VS Code 的 CLI 入口（`Code.exe` + `out/cli.js`），绕开 `.cmd`。
 *
 * 为什么不直接调 `code`：Windows 上它是 `code.cmd`，而
 * - Node 不允许直接 spawn `.cmd`（安全修复 CVE-2024-27980）；
 * - `shell: true` 会引入 DEP0190（正是本次要消除的那类噪音）；
 * - 手拼 `cmd.exe /d /s /c "…"` 的引号剥离规则会把路径连引号一起当字面量
 *   （实测报 `'"d:\…vsix"' not found`）。
 *
 * 所以自己解析路径，直接起 `Code.exe` 并把 `ELECTRON_RUN_AS_NODE=1` 设上——
 * `bin\code.cmd` 干的就是这件事，只是它经了一层 cmd。
 */
function resolveCli() {
  const dirs = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const dir of dirs) {
    const cmdPath = join(dir, "code.cmd");
    if (!existsSync(cmdPath)) continue;
    const base = dirname(dir); // <Code>\bin\code.cmd → <Code>
    // 新版布局把 app 放在一个哈希目录里（bin\code.cmd 里就写着那个名字）
    const candidates = [join(base, "resources", "app", "out", "cli.js")];
    for (const entry of readdirSync(base)) {
      candidates.push(join(base, entry, "resources", "app", "out", "cli.js"));
    }
    const cli = candidates.find((path) => existsSync(path));
    const exe = join(base, "Code.exe");
    if (cli && existsSync(exe)) return { exe, cli };
  }
  return undefined;
}

const env = { ...process.env, NODE_OPTIONS: "--no-deprecation" };
const resolved = process.platform === "win32" ? resolveCli() : undefined;
if (process.platform === "win32" && !resolved) {
  throw new Error(
    "没能在 PATH 里定位 VS Code 的 Code.exe / out/cli.js。请手动执行：\n" +
      `  $env:NODE_OPTIONS='--no-deprecation'; code --install-extension "${target}" --force`,
  );
}

if (resolved) {
  execFileSync(resolved.exe, [resolved.cli, "--install-extension", target, "--force"], {
    cwd: root,
    stdio: "inherit",
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
} else {
  execFileSync("code", ["--install-extension", target, "--force"], { cwd: root, stdio: "inherit", env });
}
