/**
 * 图片地址 → 字节、以及保存对话框的默认文件名（图片右键菜单「保存」的第一步）。
 *
 * 契约（用户 2026-09-24 口径：「保存由用户选择路径」）：
 *  - 地址只认 `data:`（附件 / 宿主读回来的本地图）与 `http(s):`（模型写的外链图），
 *    其余一律拒绝；两者都有字节上限；
 *  - 文件名优先级 = 界面给的建议名 → 地址里的文件名 → `image`；
 *  - **扩展名按真实媒体类型定**，不跟建议名走：建议名说 `.png` 而字节是 jpeg 时照它
 *    写，用户会得到一个打不开的文件；
 *  - 建议名里的路径与 Windows 非法字符一律剔掉（它是模型的文案，不是可信文件名）。
 *
 * 这一层不碰 `vscode`（那是 `imageFiles.ts` 的事），所以能离线逐条断言——
 * 而这几条规则错了的现场是「存下来的文件打不开 / 名字乱码」，靠手点很难覆盖。
 *
 * 运行：npm test（已在 esbuild.scripts.mjs 的 entries 里登记）
 */
import assert from "node:assert";
import {
  IMAGE_SAVE_MAX_BYTES,
  imageFileName,
  readDataUrlImage,
  resolveImageBytes,
} from "../src/dsh/imageBytes";

// ---------- 1. data URL → 字节 ----------

{
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const url = `data:image/png;base64,${bytes.toString("base64")}`;
  const image = readDataUrlImage(url);
  assert.ok(image, "标准 png data URL 应当解出字节");
  assert.strictEqual(image.mimeType, "image/png");
  assert.deepStrictEqual([...image.bytes], [...bytes], "字节必须逐位一致");

  // 大写 MIME、带 charset 参数、行内空白都要认（服务端与模型两边写法都可能不同）
  assert.strictEqual(readDataUrlImage("data:IMAGE/PNG;base64,AAAA")?.mimeType, "image/png");
  assert.strictEqual(readDataUrlImage("data:image/png;charset=utf-8;base64,AAAA")?.mimeType, "image/png");
  assert.strictEqual(readDataUrlImage("  data:image/png;base64,AAAA  ")?.mimeType, "image/png");

  // 不是图片 / 不是 base64 / 空载荷 / 根本不是 data URL：一律拒绝
  assert.strictEqual(readDataUrlImage("data:text/plain;base64,AAAA"), undefined, "非图片 MIME 拒绝");
  assert.strictEqual(readDataUrlImage("data:image/svg+xml,%3Csvg%2F%3E"), undefined, "百分号转义的载荷不认");
  assert.strictEqual(readDataUrlImage("data:image/png;base64,"), undefined, "空载荷拒绝");
  assert.strictEqual(readDataUrlImage("https://example.com/a.png"), undefined);
  assert.strictEqual(readDataUrlImage(""), undefined);

  // 超上限：字符串长度粗筛在解码之前就把大地址拦住
  const huge = `data:image/png;base64,${"A".repeat(IMAGE_SAVE_MAX_BYTES * 2 + 8)}`;
  assert.strictEqual(readDataUrlImage(huge), undefined, "超上限的 data URL 拒绝");
}
console.log("imageBytes: data URL 解码 ✓");

// ---------- 2. 其它 scheme 不碰网络，直接拒绝 ----------

{
  assert.strictEqual(await resolveImageBytes("file:///C:/shots/a.png"), undefined, "file: 不认（本地图是宿主换了 src 的 data URL）");
  assert.strictEqual(await resolveImageBytes("out/chart.png"), undefined, "相对路径不认");
  assert.strictEqual(await resolveImageBytes("vscode-webview://x/a.png"), undefined);
  // `data:` 走本地解码（不发网络请求），这里顺带确认它可以原样取回
  assert.ok(await resolveImageBytes("data:image/gif;base64,R0lGODlhAQABAAAAACw="));
}
console.log("imageBytes: 非 data / http(s) 的地址一律拒绝 ✓");

// ---------- 3. 保存对话框的默认文件名 ----------

// 建议名优先；扩展名跟着**真实媒体类型**走（建议名说 png、字节是 jpeg → 存成 .jpg）
assert.strictEqual(imageFileName("photo.png", "image/png"), "photo.png");
assert.strictEqual(
  imageFileName("photo.png", "image/jpeg"),
  "photo.jpg",
  "扩展名按真实媒体类型定（否则存下来的文件打不开）",
);
assert.strictEqual(imageFileName("out/chart.webp", "image/webp"), "chart.webp", "建议名里的路径被剥掉");
assert.strictEqual(imageFileName("C:\\shots\\图 1.png", "image/png"), "图 1.png");

// 建议名没有 / 不成名字 → 退回地址里的文件名 → 再退回 image
assert.strictEqual(
  imageFileName(undefined, "image/png", "https://cdn.example.com/dir/chart.webp?raw=1#top"),
  "chart.png",
  "外链取地址里的文件名，扩展名仍按真实类型",
);
assert.strictEqual(
  imageFileName(undefined, "image/jpeg", "https://cdn.example.com/a%20b.jpg"),
  "a b.jpg",
  "百分号转义要还原",
);
assert.strictEqual(imageFileName(undefined, "image/png", "data:image/png;base64,AAAA"), "image.png");
assert.strictEqual(imageFileName("", "image/webp"), "image.webp");
assert.strictEqual(imageFileName(undefined, "image/png"), "image.png");

// 非法字符与控制字符：剔掉而不是原样带进路径
assert.strictEqual(imageFileName('a<b>c:"d|e?f*g.png', "image/png"), "abcdefg.png");
assert.strictEqual(imageFileName("a\u0000b\nc.png", "image/png"), "abc.png");
// 只有扩展名 / 只有点号：不算名字
assert.strictEqual(imageFileName(".png", "image/png"), "image.png");
assert.strictEqual(imageFileName("...", "image/png"), "image.png");
// 认不出的媒体类型退回 png（宁可存成 png，也不要一个没扩展名的文件）
assert.strictEqual(imageFileName("shot", "image/tiff"), "shot.png");
// 名字过长要截断，但仍留着扩展名
{
  const long = `${"长".repeat(200)}.png`;
  const name = imageFileName(long, "image/png");
  assert.ok(name.endsWith(".png"), `扩展名不能被截掉：${name}`);
  assert.ok(name.length <= 84, `名字要截断（现在是 ${name.length} 个字符）`);
}
console.log("imageBytes: 默认文件名 ✓");

console.log("\nimageBytes: all assertions passed");
