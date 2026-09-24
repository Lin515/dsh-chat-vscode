/**
 * 服务端本地化文案的**形状校验**与**按语言取值**（`src/shared/localizedText.ts`）。
 *
 * 为什么单独一层：0.1.7-rc.2 起审批请求可以带一条只用于展示的本地化理由
 * （`ApprovalRequestEvent.displayReason`），官方界面「有它就用它、没有才用审计用的
 * `reason`」。这份映射是**服务端给的值**，形状不对时必须整份退回原文，而不是画半截；
 * 取值又要跟官方 `ctx.locale.resolveText` 同一口径（小写键、必须有 `en`、按语言回退）。
 * 两件事都在这里钉住，界面与宿主的接线另在 `npm run preview` 上看。
 *
 * 运行：npm test（记得登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { localizedTextFrom, pickLocalizedText } from "../src/shared/localizedText";

/** 逐条打印，失败即退出（与本仓库其它断言脚本同一风格）。 */
function check(label: string, run: () => void): void {
  run();
  console.log(`  ✓ ${label}`);
}

// ---------- 1. 形状校验 ----------

check("正常映射原样收下（键转小写）", () => {
  assert.deepStrictEqual(localizedTextFrom({ en: "Denied", zh: "已拒绝" }), { en: "Denied", zh: "已拒绝" });
  assert.deepStrictEqual(localizedTextFrom({ en: "Denied", ZH: "已拒绝" }), { en: "Denied", zh: "已拒绝" });
});

check("没有可用的 en 一律整份作废（没有兜底就没有本地化可言）", () => {
  assert.strictEqual(localizedTextFrom(undefined), undefined);
  assert.strictEqual(localizedTextFrom(null), undefined);
  assert.strictEqual(localizedTextFrom([{ en: "x" }]), undefined);
  assert.strictEqual(localizedTextFrom({ zh: "只有中文" }), undefined);
  assert.strictEqual(localizedTextFrom({ en: "" , zh: "空兜底" }), undefined);
  assert.strictEqual(localizedTextFrom({ en: 42 }), undefined);
  assert.strictEqual(localizedTextFrom("就是一句话"), undefined);
});

check("任何一个值不是字符串都整份作废（服务端给的值不可信）", () => {
  assert.strictEqual(localizedTextFrom({ en: "Denied", zh: 7 }), undefined);
  assert.strictEqual(localizedTextFrom({ en: "Denied", zh: null }), undefined);
  assert.strictEqual(localizedTextFrom({ en: "Denied", zh: { text: "已拒绝" } }), undefined);
});

check("服务端写歪的键不会撞上原型链，也不污染 Object.prototype", () => {
  const parsed = localizedTextFrom(JSON.parse('{"en":"Denied","__proto__":"x"}') as unknown);
  assert.strictEqual(parsed?.["en"], "Denied");
  assert.strictEqual(Object.getPrototypeOf(parsed), Object.prototype);
  assert.strictEqual(({} as Record<string, unknown>)["x"], undefined);
});

// ---------- 2. 按界面语言取值 ----------

check("命中当前语言 / 主语言 / en 三级回退", () => {
  const text = { en: "Denied", zh: "已拒绝" };
  assert.strictEqual(pickLocalizedText(text, "zh"), "已拒绝");
  assert.strictEqual(pickLocalizedText(text, "zh-cn"), "已拒绝", "完整标识没命中就试主语言");
  assert.strictEqual(pickLocalizedText(text, "zh_CN"), "已拒绝");
  assert.strictEqual(pickLocalizedText(text, "en"), "Denied");
  assert.strictEqual(pickLocalizedText(text, "en-US"), "Denied");
  assert.strictEqual(pickLocalizedText(text, "ja"), "Denied", "没有的语言回退 en");
  assert.strictEqual(pickLocalizedText(text, undefined), "Denied", "拿不到语言也回退 en");
  assert.strictEqual(pickLocalizedText(text, ""), "Denied");
});

check("没有这份映射时给 undefined（调用方据此退回审计原文）", () => {
  assert.strictEqual(pickLocalizedText(undefined, "zh"), undefined);
});

console.log("localizedText: 服务端本地化文案的校验与取值 ✓");
