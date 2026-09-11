/**
 * 并行跑两个 tsconfig 的 `--noEmit` 检查。
 *
 * 宿主与 webview 是两套独立的 TS 工程（后者含 JSX），互相没有依赖，
 * 串行跑纯属浪费——每次省下约一个 tsc 的启动与检查时间。
 *
 * 运行：npm run typecheck
 */
import { spawn } from "node:child_process";

const projects = ["tsconfig.json", "tsconfig.webview.json"];

function check(project) {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsc", "--noEmit", "-p", project], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ project, code: code ?? 1, output }));
  });
}

const results = await Promise.all(projects.map(check));

let failed = false;
for (const { project, code, output } of results) {
  if (output.trim()) process.stdout.write(output);
  if (code !== 0) {
    failed = true;
    console.error(`\n[typecheck] ${project} 失败（退出码 ${code}）`);
  } else {
    console.log(`[typecheck] ${project} 通过`);
  }
}

process.exit(failed ? 1 : 0);
