/**
 * 未知 JSON 值的形状收窄（宿主与 webview 共用）。
 *
 * 服务端与工具结果给的值一律按不可信处理，读字段前先过这一道：只有普通对象才有
 * 「自有键」语义。数组与 `null` 在 `typeof` 上都算 `object`，但它们的字段读取
 * （`value.path`、`value.type`）没有意义，所以一并排除。函数不碰原型链、不做深拷贝。
 */

/**
 * 是否为可按下标读字段的普通对象（非 `null`、非数组）。
 *
 * 只回答「这个值能不能当记录读」，不校验任何具体字段；各处的字段校验仍由调用方
 * 自己做。`assistantStream.ts` 里那份宽松版（把数组当记录读）是流式增量处理的
 * 特例，不使用本判据。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
