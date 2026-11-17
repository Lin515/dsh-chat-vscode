/**
 * 多根工作区里新会话落在哪个根目录（`activeRootIndex`）。
 *
 * 口径（用户 2026-11-17）：默认第一个根目录、不弹框；用户在输入栏目录胶囊上换过之后沿用换的
 * 那个；记着的根被移出工作区就回到第一个。单根与没有文件夹时不受影响。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { activeRootIndex } from "../src/dsh/sessionList";

const roots = ["D:\\proj\\a", "D:\\proj\\b", "D:\\proj\\c"];

// 没有打开文件夹
assert.strictEqual(activeRootIndex([], undefined), -1);
assert.strictEqual(activeRootIndex([], "D:\\proj\\a"), -1);

// 单根：无论记着什么都是第一个
assert.strictEqual(activeRootIndex(["D:\\proj\\a"], undefined), 0);
assert.strictEqual(activeRootIndex(["D:\\proj\\a"], "D:\\proj\\zzz"), 0);

// 多根：没换过 / 空串 → 第一个（默认口径）
assert.strictEqual(activeRootIndex(roots, undefined), 0);
assert.strictEqual(activeRootIndex(roots, ""), 0);

// 多根：换过则沿用换的那个，而不是第一个
assert.strictEqual(activeRootIndex(roots, "D:\\proj\\b"), 1);
assert.strictEqual(activeRootIndex(roots, "D:\\proj\\c"), 2);

// 比较不区分盘符大小写、斜杠方向与尾斜杠
assert.strictEqual(activeRootIndex(roots, "d:/proj/b/"), 1);

// 记着的根已不在工作区 → 回到第一个
assert.strictEqual(activeRootIndex(roots, "D:\\proj\\gone"), 0);

console.log("activeRoot.test: ok");
