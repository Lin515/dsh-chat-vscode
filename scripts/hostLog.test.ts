/**
 * 日志写入器在**输出通道已关闭**时必须活下来。
 *
 * 钉住的是用户 2026-09-13 报的缺陷根因：关窗时 VS Code 先关掉输出通道，扩展随后才停用；
 * `ServerManager.release()` 的第一条语句就是写日志，`appendLine` 抛出
 * `Error: Channel has been closed` 之后，**下面杀后台的代码根本执行不到** ——
 * 后台 dsh 被留下、租约里的端口一直占着，下次启动固定端口就 `EADDRINUSE`
 * （用户看到「无法连接 dsh 服务」）。实测的 exthost.log 见 `src/dsh/hostLog.ts` 文件头。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { createHostLog, stamp, type OutputChannelLike } from "../src/dsh/hostLog";

/** 复刻 VS Code 关窗后的通道：`appendLine` 抛的就是这条真实报错。 */
function closedChannel(): OutputChannelLike {
  return {
    appendLine() {
      throw new Error("Channel has been closed");
    },
  };
}

// ---------- 0. 对照：直接写一个已关闭的通道，确实会抛 ----------
//
// 这条是**对照**，不是产品行为：证明后面的断言不是形式主义。
{
  const channel = closedChannel();
  assert.throws(
    () => channel.appendLine("x"),
    /Channel has been closed/,
    "（对照）已关闭的通道写入会抛 —— 这正是缺陷现场",
  );
}
console.log("host-log: 已关闭的通道写入确实会抛（缺陷现场可复现）✓");

// ---------- 1. 通道取用本身抛异常时也不得外抛 ----------
{
  const log = createHostLog(() => {
    throw new Error("Channel has been closed");
  });
  assert.doesNotThrow(() => log("[server] 本窗口退出：停止后台 pid=1"), "取通道抛异常不得外抛");
  assert.ok(log.pendingCount() >= 1, "写不进去的消息要攒着，不能凭空丢掉");
}
console.log("host-log: 取通道抛异常不外抛 ✓");

// ---------- 2. 通道关闭（这是真实情形）时：不抛、且消息留着 ----------
{
  let disposed = false;
  const log = createHostLog(() => (disposed ? closedChannel() : undefined));
  disposed = true;
  assert.doesNotThrow(() => {
    log("[server] 本窗口退出：停止后台 pid=1（按 pid + 端口两道清理）");
    log("[cleanup] 端口 20000 的监听者：1234");
  }, "release() 的两条关窗日志都必须能写下去（它们以前会抛，把杀进程的代码掐断）");
  assert.strictEqual(log.pendingCount(), 2, "两条都要留在队列里");
}
console.log("host-log: 关窗期写入不抛异常、消息留在队列 ✓");

// ---------- 3. 通道回来之后要把攒下的补写进去（含时间戳） ----------
{
  const written: string[] = [];
  let open = false;
  const log = createHostLog(() => (open ? { appendLine: (line: string) => written.push(line) } : closedChannel()));

  log("[server] 关窗前的第一条");
  assert.strictEqual(written.length, 0, "通道关闭时写不进去");
  assert.strictEqual(log.pendingCount(), 1);

  open = true; // 通道重新可用（重载窗口后重建了输出通道）
  log("[server] 通道回来之后的一条");

  assert.strictEqual(written.length, 2, "攒下的那条要在下一次写入时补上");
  assert.ok(written[0].includes("关窗前的第一条"), `补写的必须是原来那条：${written[0]}`);
  assert.ok(written[1].includes("通道回来之后的一条"), `顺序不能乱：${written[1]}`);
  assert.strictEqual(log.pendingCount(), 0, "补完之后队列要清空");
}
console.log("host-log: 通道恢复后补写、顺序不乱 ✓");

// ---------- 4. 空行照旧忽略；时间戳格式不变 ----------
{
  const written: string[] = [];
  const log = createHostLog(() => ({ appendLine: (line: string) => written.push(line) }));
  log("");
  assert.strictEqual(written.length, 0, "空行忽略（既有行为）");
  log("[x] 有内容");
  assert.match(written[0], /^\[\d{1,2}:\d{2}:\d{2}(?:\s?[AP]M)?\] \[x\] 有内容$/, `时间戳前缀不能丢：${written[0]}`);
  assert.match(stamp("[x] y"), /^\[.+\] \[x\] y$/, "stamp 仍是 [时间] 行 的格式");
}
console.log("host-log: 空行忽略、时间戳格式不变 ✓");
