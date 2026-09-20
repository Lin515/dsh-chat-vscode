/**
 * 【探针定位】工具型 · 零 token —— 本地构建/测试耗时基准，不碰 dsh，可自由运行。
 *
 * 开发循环耗时分解：找出「哪一步慢」，用于验证优化是否真的有效。
 *
 * 运行：node scripts/bench.mjs
 *
 * 结论（2026-09 实测，本机）：
 *   - `npm run build` 本身很快（~0.7s），慢的从来不是它；
 *   - 曾经的瓶颈是 `token-cleanup` 断言要 11.6s——它逐个 pid 起 PowerShell
 *     取命令行，而 Windows 上每次要付 ~1600ms 的解释器启动成本；
 *   - 改成「一次取回全部进程的命令行」+ 用轮询替代固定 sleep 后降到 ~4.5s，
 *     同时把两套 tsconfig 与 14 个断言并行化。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function run(label, cmd, args, { quiet = true } = {}) {
  const started = Date.now();
  const result = spawnSync(cmd, args, {
    stdio: quiet ? "ignore" : "inherit",
    shell: process.platform === "win32",
  });
  const ms = Date.now() - started;
  console.log(`${label.padEnd(34)} ${String(ms).padStart(7)} ms${result.status ? `  ← 退出码 ${result.status}` : ""}`);
  return ms;
}

console.log("=== 各阶段（单次，冷启动）===\n");

const typecheck = run("npm run typecheck（两工程并行）", npm, ["run", "typecheck"]);
const scripts = run("npm run build:scripts", npm, ["run", "build:scripts"]);
const dist = run("npm run build（dist, minify）", npm, ["run", "build"]);
const test = run("npm test（含 build:scripts）", npm, ["test"]);

console.log("\n=== 汇总 ===\n");
console.log(`typecheck                ${String(typecheck).padStart(7)} ms`);
console.log(`build:scripts            ${String(scripts).padStart(7)} ms`);
console.log(`build (dist)             ${String(dist).padStart(7)} ms`);
console.log(`npm test（不含打包）      ${String(test - scripts).padStart(7)} ms`);
console.log(`---`);
console.log(`完整验证循环              ${String(typecheck + test + dist).padStart(7)} ms`);

// 逐个断言耗时：找出长尾
const tests = existsSync("build")
  ? readdirSync("build").filter((f) => f.endsWith(".test.mjs")).sort()
  : [];
if (tests.length) {
  console.log(`\n=== 各断言串行耗时（${tests.length} 个）===`);
  let total = 0;
  const rows = [];
  for (const file of tests) {
    const started = Date.now();
    spawnSync(node, [`build/${file}`], { stdio: "ignore" });
    const ms = Date.now() - started;
    total += ms;
    rows.push({ file, ms });
  }
  rows.sort((a, b) => b.ms - a.ms);
  for (const { file, ms } of rows) console.log(`  ${file.padEnd(32)} ${String(ms).padStart(6)} ms`);
  console.log(`  ${"串行合计".padEnd(31)} ${String(total).padStart(6)} ms`);
  console.log(`  （npm test 并行跑完更快；长尾决定下限）`);
}

const bare = Date.now();
spawnSync(node, ["-e", ""], { stdio: "ignore" });
console.log(`\n纯 node 启动基线          ${String(Date.now() - bare).padStart(7)} ms`);

if (existsSync("build")) {
  const files = readdirSync("build").filter((f) => f.endsWith(".mjs"));
  const total = files.reduce((sum, f) => sum + statSync(`build/${f}`).size, 0);
  console.log(`build/ 产物              ${String(files.length).padStart(7)} 个，${(total / 1024 / 1024).toFixed(1)} MB`);
}
