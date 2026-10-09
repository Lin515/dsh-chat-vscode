/**
 * 并行跑四个 tsconfig 的 `--noEmit` 检查。
 *
 * 宿主与 webview 是两套独立的 TS 工程（后者含 JSX），互相没有依赖，
 * 串行跑纯属浪费——每次省下约一个 tsc 的启动与检查时间。
 *
 * 第三个工程（`tsconfig.trajectory-fixture.json`）是 S02 夹具工具链的窄覆盖：
 * `tsconfig.json` 只 include `src/**`，`scripts/**` 本来不在任何工程里，
 * 于是那批正式脚本的类型问题标准检查看不见。
 *
 * 第四个工程（`tsconfig.trajectory-tools.json`）同理，覆盖本批正式 `scripts/**` 文件与
 * 它们的测试：M06 完整载荷量测四份、D01 真实探针（事实层 / Gap / Align 与两条回归）、
 * M01 的 vendor 源锁与回归，加上轨迹页的宿主折叠／界面投影／交互端口／账本行／检查器／
 * 提示词差分／vendor 适配回归、两条探针 CLI，以及本批一并碰过的日志解码、预览夹具体检
 * 与相邻回归（sessionLog、previewFixture、inspectCall、nodeOpen、toolbarFit、styles、
 * thinkingStream）。它带 DOM/JSX 配置，因为量测工具与轨迹页回归的依赖闭包会走到
 * `src/webview/**`（TSX）。
 *
 * `scripts/**` 里**本批相关的**文件已全部纳入（含预览夹具体检）；其余历史 `scripts/**`
 * （多数旧断言）仍不在任何工程里——那是本批之前就有的状态（基线只有两个工程），
 * 要整体收编得另立一轮，别把「本批已覆盖」读成「全部 `scripts/**` 已覆盖」。
 *
 * 运行：npm run typecheck
 */
import { spawn } from "node:child_process";

const projects = [
  "tsconfig.json",
  "tsconfig.webview.json",
  "tsconfig.trajectory-fixture.json",
  "tsconfig.trajectory-tools.json",
];

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
