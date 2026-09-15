/**
 * 守护进程错误上报器的离线断言（2026-09-15）。
 *
 * 背景：我在 `child.on("exit")` 里加的一行诊断引用了不存在的变量，`ReferenceError`
 * 从事件回调冒到顶层，**整个守护进程以 code=1 静默消失**（窗口侧只看到"连不上"）。
 * 用户要求"抛错可以捕获，并把错误发回 VSCode 的日志"。
 *
 * 这一组钉住上报器本身的三条纪律：
 * ① 一条错误**两处都发**（supervisor.log 是底线，socket 广播是实时通道）；
 * ② 任何一处炸了（写日志抛、某个客户端 write 抛、消息编码出问题）**都不影响其余**、
 *    更**绝不外抛**——上报器自己抛错就等于换了个地方崩；
 * ③ 反复出错要有累计提示（只写一行会被当成偶发）。
 */
import assert from "node:assert";
import { createErrorReporter, describeError } from "../src/dsh/supervisorErrors";

/** 记录所有写到"客户端"的行（supervisor → 扩展的报文）。 */
function fakeClient(lines: string[]): { write(data: string): unknown } {
  return {
    write(data: string) {
      lines.push(data);
      return true;
    },
  };
}

console.log("supervisorErrors: 上报器（两处都发 / 自身绝不抛）");

// ---------- 1. 正常路径：两处都发，且报文能被协议解出来 ----------
{
  const logged: string[] = [];
  const wire: string[] = [];
  const reporter = createErrorReporter((line) => logged.push(line));
  reporter.publish(() => [fakeClient(wire)]);

  reporter.report("tick", new Error("boom"));

  assert.equal(reporter.count, 1, "上报一次要计一次数");
  assert.equal(logged.length, 1, "日志里要有一行");
  assert.match(logged[0], /内部错误（tick）/, `日志行要带来源分类：${logged[0]}`);
  assert.match(logged[0], /boom/, `日志行要有原始信息：${logged[0]}`);

  assert.equal(wire.length, 1, "广播要发一条");
  const parsed = JSON.parse(wire[0]) as { t: string; kind: string; message: string };
  assert.equal(parsed.t, "error", "报文类型必须是 error（扩展侧按它转发）");
  assert.equal(parsed.kind, "tick", "kind 要原样带上（排查时按它 grep）");
  assert.match(parsed.message, /boom/, "message 要带原始信息");
}

// ---------- 2. 日志写不进去：广播照发，且函数不抛 ----------
{
  const wire: string[] = [];
  const reporter = createErrorReporter(() => {
    throw new Error("日志文件被占用");
  });
  reporter.publish(() => [fakeClient(wire)]);

  assert.doesNotThrow(() => reporter.report("dsh-exit", new Error("x")), "上报器自身绝不能抛");
  assert.equal(wire.length, 1, "文件那条路断了，socket 这条路必须照走");
}

// ---------- 3. 某个客户端写失败：其余客户端照收，函数不抛 ----------
{
  const good: string[] = [];
  const reporter = createErrorReporter(() => {});
  reporter.publish(() => [
    {
      write() {
        throw new Error("这条连接已经断了");
      },
    },
    fakeClient(good),
  ]);

  assert.doesNotThrow(() => reporter.report("socket", new Error("y")));
  assert.equal(good.length, 1, "一条连接写失败不能连累其它窗口");
}

// ---------- 4. 还没接上客户端集合：只写文件，不抛 ----------
{
  const logged: string[] = [];
  const reporter = createErrorReporter((line) => logged.push(line));
  assert.doesNotThrow(() => reporter.report("global", new Error("早期错误")));
  assert.equal(logged.length, 1, "还没有窗口连着时也要落文件（那正是唯一的收件人）");
}

// ---------- 5. 累计提示：第 3 条起要多说一句 ----------
{
  const logged: string[] = [];
  const reporter = createErrorReporter((line) => logged.push(line));
  reporter.report("tick", new Error("1"));
  reporter.report("tick", new Error("2"));
  reporter.report("tick", new Error("3"));
  assert.equal(reporter.count, 3);
  assert.ok(
    logged.some((line) => /已累计捕获 3 次内部错误/.test(line)),
    `反复出错要给累计提示（否则看着像偶发）：${JSON.stringify(logged)}`,
  );
}

// ---------- 5b. 补发：没人连着时发生的错误，连上的那一刻要能拿到 ----------
//
// 这是探针第一次跑就抓到的真问题：守护进程"刚起来 / 日志不可写"这类最要命的错误，
// 恰恰发生在**一个窗口都还没连上**的时候。那时广播给的是空集合、只有文件知道；
// 而用户是后来才打开窗口的，他等到的是一份干净状态 → "后台为什么不动"又变成谜。
{
  const reporter = createErrorReporter(() => {});
  // 故意**先不接客户端**：模拟"错误发生在窗口连上之前"
  reporter.report("shutdown", new Error("日志不可写"));
  reporter.report("dsh-exit", new Error("起来了又退"));

  const late: string[] = [];
  assert.doesNotThrow(() => reporter.replayTo(fakeClient(late)));
  assert.equal(late.length, 2, "晚连上的窗口要把之前两条补发到手");

  const kinds = late.map((line) => (JSON.parse(line) as { kind: string }).kind);
  assert.deepEqual(kinds, ["shutdown", "dsh-exit"], `补发顺序要与发生顺序一致：${JSON.stringify(kinds)}`);

  // 补发是"尽力而为"：写入失败的客户端不该抛
  assert.doesNotThrow(() =>
    reporter.replayTo({
      write() {
        throw new Error("这条连接已经断了");
      },
    }),
  );

  // 上限：又要发一堆之后，补发只给最近 16 条（不能把窗口淹掉），且保留的是最近的
  for (let index = 0; index < 40; index++) reporter.report("tick", new Error(`第 ${index} 条`));
  const capped: string[] = [];
  reporter.replayTo(fakeClient(capped));
  assert.equal(capped.length, 16, `补发要封顶（实际 ${capped.length} 条）`);
  assert.match(capped[capped.length - 1], /第 39 条/, "封顶后保留的必须是**最近**的");
}

// ---------- 6. 非 Error 的抛出物也要能读 ----------
{
  assert.match(describeError("就是一个字符串"), /就是一个字符串/);
  assert.match(describeError({ code: 42 }), /\[object Object\]|42/);
  assert.match(describeError(new TypeError("坏了")), /TypeError: 坏了/);
}

console.log("supervisorErrors: all assertions passed");
