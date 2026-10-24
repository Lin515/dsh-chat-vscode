/**
 * 会话活动时间（`api-session/activity` 中继）的解码。
 *
 * 这条帧是子代理目录排序里「用户消息」那一半的实时来路（见 `src/dsh/sessionActivity.ts`）。
 * 形状校验必须严格：解不出来时调用方只能记日志并忽略，不能把 `undefined` 当 0 记进账本，
 * 否则那一行会被排到最后。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { decodeSessionActivity } from "../src/dsh/sessionActivity";

{
  assert.deepStrictEqual(
    decodeSessionActivity(["child-1", 1760000000000]),
    { sessionId: "child-1", updatedAt: 1760000000000 },
    "正常帧要解出会话 id 与时间",
  );
  assert.deepStrictEqual(
    decodeSessionActivity(["child-2", 0, "多余的"]),
    { sessionId: "child-2", updatedAt: 0 },
    "0 是合法时间（由上层决定要不要记）；多出来的参数忽略",
  );
  assert.strictEqual(decodeSessionActivity([""]), undefined, "空会话 id 认不出");
  assert.strictEqual(decodeSessionActivity([123, 1]), undefined, "会话 id 不是字符串时认不出");
  assert.strictEqual(decodeSessionActivity(["child-3"]), undefined, "缺时间时认不出");
  assert.strictEqual(decodeSessionActivity(["child-3", "1"]), undefined, "时间不是数字时认不出");
  assert.strictEqual(decodeSessionActivity(["child-3", Number.NaN]), undefined, "NaN 认不出");
  assert.strictEqual(decodeSessionActivity(["child-3", Number.POSITIVE_INFINITY]), undefined, "Infinity 认不出");
  assert.strictEqual(decodeSessionActivity([]), undefined, "空 args 认不出");
}
console.log("sessionActivity: 解码逐项校验（缺字段/错类型返回 undefined） ✓");
