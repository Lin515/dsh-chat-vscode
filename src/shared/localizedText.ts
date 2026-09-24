/**
 * 服务端给的**本地化文案**（`{en: string, [locale]: string}`）：形状校验 + 按界面语言取一条。
 *
 * 为什么单独一份：官方从 0.1.7-rc.2 起允许 asker 给审批请求附一条**只用于展示**的本地化
 * 理由（`ApprovalRequestEvent.displayReason`，不落审计），官方前端的读法是
 * 「有它就用它、没有才用审计用的 `reason`」（`dsh-client-ui-approval` 的 `ApprovalPanel`）。
 * 本扩展要按同一口径显示，于是需要两件事：宿主侧**逐字段验形状**（服务端给的值不可信），
 * 界面侧**按当前语言取一条**。
 *
 * 取值口径与官方 `ctx.locale.resolveText` 一致：键是小写语言 id、**必须带 `en`**，
 * 沿当前语言回退——先试完整标识（`zh-cn`），再试主语言（`zh`），最后 `en`。
 * 与语言无关的那本词典（`webview/messages.ts` 的 `MESSAGES`）是两回事：那些是**我们自己**
 * 的文案，这里是服务端发的。
 *
 * 纯函数、不引宿主，断言见 `scripts/localizedText.test.ts`。
 */

/**
 * 校验一份本地化文案；形状不对返回 `undefined`（调用方退回非本地化的原文）。
 *
 * 要求：是个普通对象（不是数组 / null）、`en` 是**非空**字符串、其余每个值都是字符串。
 * 少了可用的 `en` 就没有兜底可言——宁可整份不要，也不显示半截（与「结果形状不对就不认领」
 * 的既有口径一致）。键统一转小写，服务端大小写写歪了也能对上。
 */
export function localizedTextFrom(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== "string") return undefined;
    // 键来自服务端：用 defineProperty 落键，`__proto__` 这类键才不会走原型链上的
    // 赋值语义（普通赋值会静默丢掉它，defineProperty 则老老实实记成一个普通成员）
    Object.defineProperty(out, key.toLowerCase(), {
      value: text,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const fallback = out["en"];
  if (fallback === undefined || fallback === "") return undefined;
  return out;
}

/**
 * 按界面语言取一条；`text` 缺失时返回 `undefined`（调用方退回原文）。
 *
 * 语言标识按小写比对，先完整标识、再主语言（去掉 `-` / `_` 之后）、最后 `en`——
 * `normalizeLocale` 只认中英两种，而服务端给的键也只用 `en` / `zh`，两套在这里合流。
 */
export function pickLocalizedText(
  text: Record<string, string> | undefined,
  language: string | undefined,
): string | undefined {
  if (text === undefined) return undefined;
  const normalized = (language ?? "").toLowerCase();
  const primary = normalized.split(/[-_]/)[0] ?? "";
  return text[normalized] ?? text[primary] ?? text["en"];
}
