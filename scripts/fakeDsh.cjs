/**
 * 探针用的**假 dsh**：一个只会"宣布地址然后一直开着"的服务器。
 *
 * 它顶替真 `dsh web` 的位置，是因为探针要验的是**守护进程怎么看待子进程的生死**，
 * 而真 dsh 冷启要好几秒、还会拉起 MCP 子进程（噪音大、结论被掩盖）。
 * 行为上它和真 dsh 一致的三点才是关键：
 *   ① 由 `shell: true` 经 cmd.exe 启动（真 dsh 那条 `dsh web …` 命令同样如此，
 *      本机实测链路：`Code.exe`(supervisor) → `cmd.exe /d /s /c "dsh web …"` → `node.exe bin.js web …`）；
 *   ② 往 stdout 打公告行 `dsh web: http://127.0.0.1:<port>/?token=<token>`；
 *   ③ 每次启动往 `DSH_FAKE_BOOT_LOG`（由探针设、supervisor 原样透传）追加一行
 *      `boot pid=<pid> shell=<ppid> port=<port>`——探针据此精确判断"守护进程真把 dsh
 *      重新拉起来了几次"。**不能数日志里的 `--- dsh attempt` marker**：那个是每次
 *      `bringUp` 尝试都写，里面那次 dsh 可能起来就退（第一版探针正是栽在这里）。
 *
 * 用法：node fakeDsh.cjs <port> <token> [--hang-after <ms>]
 *   `--hang-after`：到时间后**停止应答**，但进程不退（= "卡死"形态：进程在、端口不响应）。
 */
const http = require("node:http");
const { appendFileSync } = require("node:fs");

const port = Number(process.argv[2]);
const token = process.argv[3] ?? "probe-token";
const hangIndex = process.argv.indexOf("--hang-after");
const hangAfter = hangIndex >= 0 ? Number(process.argv[hangIndex + 1]) : 0;

const bootLog = process.env.DSH_FAKE_BOOT_LOG;
const record = (line) => {
  if (!bootLog) return;
  try {
    appendFileSync(bootLog, `${line}\n`, "utf8");
  } catch {
    // 记不上不影响主流程
  }
};
record(`boot pid=${process.pid} shell=${process.ppid} port=${port}`);

// 自证：真 dsh 不会自己退，探针里出现的"就绪即退"必须查出是谁干的——
// 把自己的退出原因也写进同一份文件（退出码、信号、未捕获异常）。
process.on("exit", (code) => record(`exit pid=${process.pid} code=${code} at=${Date.now()}`));
process.on("uncaughtException", (error) => record(`uncaught pid=${process.pid} error=${error && error.message}`));
process.on("SIGHUP", () => record(`sighup pid=${process.pid} at=${Date.now()}`));
process.on("SIGBREAK", () => record(`sigbreak pid=${process.pid} at=${Date.now()}`));
process.on("SIGTERM", () => record(`sigterm pid=${process.pid} at=${Date.now()}`));
process.on("SIGINT", () => record(`sigint pid=${process.pid} at=${Date.now()}`));

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("ok\n");
});
server.listen(port, "127.0.0.1", () => {
  // 公告行必须与 `parseAnnouncement` 的正则一致（含 token 段）
  process.stdout.write(`dsh web: http://127.0.0.1:${port}/?token=${token}\n`);
  // 再打一行自己的 pid：探针要拿"真正在跑的那个 node"来杀，而不是外壳
  process.stdout.write(`[fake-dsh] pid=${process.pid} shell=${process.ppid}\n`);
});

if (hangAfter > 0) {
  setTimeout(() => {
    process.stdout.write(`[fake-dsh] 进入卡死形态：停止应答（进程不退）\n`);
    // 停止应答：拒绝新连接（等价于"进程活着但不干活"）。
    // **不加 unref 的 interval 是必须的**：Node 在事件循环空了之后会自己退出，
    // 那样就变成"进程真的退了"（= 另一码事），验不出"卡死"这一档。
    server.close();
    setInterval(() => {}, 1_000);
  }, hangAfter);
}
