/**
 * 时刻写法：轮尾时间、会话列表、任务行共用 `formatClock`，按离「现在」的远近分级。
 *
 * 用户 2026-11-02 口径：当日只有 `hh:mm`；不是当日要给 `mm-dd hh:mm`；不是当年要给
 * `yyyy-mm-dd hh:mm`。基准时间由参数注入，断言不依赖跑测试时的系统日期。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { formatClock } from "../src/webview/components/primitives";

const now = new Date(2026, 10, 2, 20, 42); // 2026-11-02 20:42 本地时间

assert.strictEqual(formatClock(new Date(2026, 10, 2, 9, 5).getTime(), now), "09:05", "当日只给时刻");
assert.strictEqual(
  formatClock(new Date(2026, 10, 2, 23, 59).getTime(), now),
  "23:59",
  "当日跨过零点前的同一日仍是只有时刻",
);
assert.strictEqual(
  formatClock(new Date(2026, 9, 31, 8, 7).getTime(), now),
  "10-31 08:07",
  "同年不同日给月日与时刻，且月日补零",
);
assert.strictEqual(
  formatClock(new Date(2026, 0, 5, 0, 0).getTime(), now),
  "01-05 00:00",
  "年内较早的日期同样补零",
);
assert.strictEqual(
  formatClock(new Date(2025, 11, 31, 23, 30).getTime(), now),
  "2025-12-31 23:30",
  "跨年给完整年月日与时刻",
);
assert.strictEqual(
  formatClock(new Date(2025, 0, 1, 0, 0).getTime(), now),
  "2025-01-01 00:00",
  "跨年的个位数月日也补零",
);

// 同一日但年份不同不可能发生；这里固定「跨年判定优先于月日」：同月同日不同年仍给完整年月日。
assert.strictEqual(
  formatClock(new Date(2024, 10, 2, 20, 42).getTime(), now),
  "2024-11-02 20:42",
  "同月同日不同年按跨年处理",
);
