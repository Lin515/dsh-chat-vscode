/**
 * 并行跑全部离线断言（`build/*.test.mjs`）。
 *
 * 为什么要自己写：这些断言互不依赖，绝大多数在 110ms 内跑完，串行执行时
 * 时间几乎全花在**反复启动 Node** 上（14 次启动 ≈ 1.5s）。但其中一个
 * （token-cleanup）要起真实进程并做 taskkill，本身要数秒——并行正好把这个
 * 长尾与其余短任务重叠起来。
 *
 * 输出按固定顺序缓冲后打印，而不是边跑边穿插，避免多进程日志交错难读。
 * 任一失败 → 退出码 1，并完整打印该测试的输出。
 *
 * 运行：npm test
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { cpus } from "node:os";

const files = readdirSync("build")
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();

if (files.length === 0) {
  console.error("[test] build/ 下没有找到 *.test.mjs——先跑 npm run build:scripts");
  process.exit(1);
}

/** 并发上限：留一个核给系统，最多 8（这些测试是 IO/进程密集，不是 CPU 密集）。 */
const limit = Math.max(1, Math.min(8, cpus().length - 1));

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`build/${file}`], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ file, code: code ?? 1, output }));
  });
}

const results = new Map();
let next = 0;
let started = 0;
const failures = [];

await Promise.all(
  Array.from({ length: limit }, async () => {
    while (next < files.length) {
      const file = files[next++];
      started++;
      const result = await runOne(file);
      results.set(file, result);
      if (result.code !== 0) failures.push(result);
    }
  }),
);

// 按文件名顺序打印，保证输出稳定可比
for (const file of files) {
  const result = results.get(file);
  if (!result) continue;
  process.stdout.write(result.output);
}

const passed = files.length - failures.length;
console.log(`\n[test] ${passed}/${files.length} 套断言通过（并发 ${limit}）`);

if (failures.length) {
  console.error(`\n[test] 失败 ${failures.length} 套：`);
  for (const { file, code, output } of failures) {
    console.error(`\n===== ${file}（退出码 ${code}）=====\n${output}`);
  }
  process.exit(1);
}
