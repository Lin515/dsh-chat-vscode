/**
 * 会话状态位（`api-session/status` 中继）的解码与采纳策略。
 *
 * 这一条链修的是用户 2026-09-22 报的现场：生成中离开会话再回来，界面显示发送按钮、
 * 深度求索栏消失，而发出去的消息进了队列（服务端那一轮**一直在跑**）。成因是 running
 * 此前只有「适配器从 durable 轮次边界推导」一条来源，而它在「跟随窗口被截断 + 服务端
 * 没有活跃 attempt」（工具执行 / 等审批 / 等子代理）时给不出结论，却硬发了一个 false。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { acceptSessionStatus, decodeSessionStatus } from "../src/dsh/sessionStatus";

// ---------- 1. 解码：形状不可信，认不出就返回 undefined ----------

{
  const ok = decodeSessionStatus(["session-1", true]);
  assert.deepStrictEqual(ok, { sessionId: "session-1", running: true }, "正常帧要解出两个字段");
  assert.deepStrictEqual(
    decodeSessionStatus(["session-2", false]),
    { sessionId: "session-2", running: false },
    "false 也要解出来（它是最常来的那条）",
  );
  // 多带的参数忽略（服务端将来加字段不该让整条帧失效）
  assert.deepStrictEqual(
    decodeSessionStatus(["session-3", true, "多余的"]),
    { sessionId: "session-3", running: true },
    "多出来的参数应当忽略",
  );
  assert.strictEqual(decodeSessionStatus(["", true]), undefined, "空会话 id 认不出");
  assert.strictEqual(decodeSessionStatus([123, true]), undefined, "会话 id 不是字符串时认不出");
  assert.strictEqual(decodeSessionStatus(["session-4", "true"]), undefined, "running 不是布尔时认不出");
  assert.strictEqual(decodeSessionStatus(["session-5"]), undefined, "缺 running 时认不出（不能当 false 用）");
  assert.strictEqual(decodeSessionStatus([]), undefined, "空 args 认不出");
}
console.log("sessionStatus: 解码逐项校验（缺字段/错类型返回 undefined） ✓");

// ---------- 2. 采纳策略：有肯定证据就拒绝「不在跑」 ----------

{
  assert.strictEqual(acceptSessionStatus(true, false), true, "说「在跑」一律采纳（认不出时它就是唯一线索）");
  assert.strictEqual(acceptSessionStatus(true, true), true, "说「在跑」一律采纳，与本地证据无关");
  assert.strictEqual(acceptSessionStatus(false, false), true, "本地认不出时接受「不在跑」（重连期间已收尾的正常情形）");
  // 关键的一条：本地日志明明有一轮开着（`turn/start` 之后还没等到 `turn/end`）时，
  // 不信外来的 false——两条流（$events 与 session/follow）不同源，乱序的旧边缘会把
  // 停止按钮和 `waitUntilIdle`（等不到本轮结束就会把队列重新提交）一起骗掉。
  // durable 的 `turn/end` 到了才是权威。
  assert.strictEqual(acceptSessionStatus(false, true), false, "本地有肯定证据时不接受「不在跑」");
}
console.log("sessionStatus: 采纳策略（肯定证据优先，反方向一律接受） ✓");
