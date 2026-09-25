/**
 * 正文里**本地图片**引用的解析与白名单断言。
 *
 * 这条链路是「agent 生成的图表看不见」的修复，同时也是**外部输入**入口：
 * 引用原文完全由模型输出决定，模型可以写 `![](../../.ssh/id_rsa)`、
 * `![](C:/Users/x/.aws/credentials)`。所以白名单必须逐条钉住：
 *
 * 1. **只有工作目录内的路径才读**（越界、跨盘符一律不读）；
 * 2. **只有图片扩展名才读**（不能变成任意文件读取）；
 * 3. **先 `stat` 再读**，有字节上限（不能一个 2 GB 的文件把宿主读爆）；
 * 4. 引用原文 → 键原样回给界面（界面按它匹配 `<img src>`）。
 *
 * 另一半（webview 侧的缓存与降级）在 `imageRender.test.ts` 与
 * `src/webview/localImages.ts` 里，Node 侧只能钉白名单——那才是危险的那一半。
 *
 * 运行：npm test（已登记到 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { imageRefLabel, isRemoteImageRef, localImageMediaType, localImagePath } from "../src/shared/imageRef";
import {
  LOCAL_IMAGE_MAX_BYTES,
  LOCAL_IMAGE_MAX_REFS,
  readLocalImages,
  resolveLocalImagePath,
} from "../src/dsh/localImages";

// ---------- 1. 引用分类：远程/内联 vs 本地候选 ----------
{
  for (const remote of [
    "https://example.com/a.png",
    "http://example.com/a.png",
    "data:image/png;base64,AAAA",
    "blob:https://x/1",
    "vscode-webview://x/a.png",
    "",
  ]) {
    assert.strictEqual(isRemoteImageRef(remote), true, `${remote} 应当交给浏览器/CSP，不该问宿主`);
  }
  for (const local of ["./out/chart.png", "out/chart.png", "C:/shots/a.png", "file:///C:/shots/a.png",
    "/home/x/a.png", "..\\up.png"]) {
    assert.strictEqual(isRemoteImageRef(local), false, `${local} 是本地候选，必须交给宿主去读`);
  }
  console.log("local-images: 引用分类（远程 vs 本地）✓");
}

// ---------- 2. 路径还原（file: 外壳 / 转义 / 查询串） ----------
{
  const cases: [string, string | undefined][] = [
    ["file:///C:/shots/a.png", "C:/shots/a.png"],
    ["file:///home/x/a.png", "/home/x/a.png"],
    ["out/my%20chart.png", "out/my chart.png"],
    ["./a.png?raw=1#top", "./a.png"],
    ["https://example.com/a.png", undefined],
    ["data:image/png;base64,AA", undefined],
    ["bad%zz.png", undefined],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(localImagePath(input), expected, `${input} 的路径还原不对`);
  }
  console.log("local-images: file:/转义/查询串 还原 ✓");
}

// ---------- 2b. 扩展名表：含 svg，且只看最后一段 ----------
//
// 这张表**故意**与附件准入那张（png/jpg/jpeg/webp/gif）不同：那张管「模型能不能读
// 字节」，这张管「浏览器能不能画」。agent 生成的插画常见就是 `.svg`（2026-09-18
// 实测那次就是），把它排除掉等于「agent 说给你一张图，界面上什么都没有」。
{
  assert.strictEqual(localImageMediaType("a/b/c.png"), "image/png");
  assert.strictEqual(localImageMediaType("C:\\shots\\scene.JPG"), "image/jpeg", "大小写不敏感");
  assert.strictEqual(localImageMediaType("scene.svg?v=2"), "image/svg+xml", "查询串不算扩展名");
  assert.strictEqual(localImageMediaType("shot.webp#top"), "image/webp");
  assert.strictEqual(localImageMediaType("notes.txt"), undefined);
  assert.strictEqual(localImageMediaType("archive.png.zip"), undefined, "扩展名只看最后一段");
  console.log("local-images: 图片扩展名表（含 svg）✓");
}

// ---------- 2c. 失败文案里缀的引用标签 ----------
//
// 加载失败的降级文案要把「是哪一张」说出来：本地引用给**规整后的路径**，远程引用
// 给原样 URL；`data:` 与空引用没有可缀的东西（渲染侧据此退回不带引用那一句）。
{
  const cases: [string, string | undefined][] = [
    ["out/chart.png", "out/chart.png"],
    ["./out/my%20chart.png", "./out/my chart.png"],
    ["file:///C:/shots/a.png", "C:/shots/a.png"],
    ["https://example.com/a.png", "https://example.com/a.png"],
    ["data:image/png;base64,AAAA", undefined],
    ["", undefined],
    ["   ", undefined],
  ];
  for (const [input, expected] of cases) {
    assert.strictEqual(imageRefLabel(input), expected, `${input} 的失败标签不对`);
  }
  console.log("local-images: 失败文案的引用标签 ✓");
}

// ---------- 3. 白名单：工作目录内才读 ----------
const root = await mkdtemp(join(tmpdir(), "dsh-local-img-"));
try {
  const workdir = join(root, "work");
  await mkdir(join(workdir, "out"), { recursive: true });
  await writeFile(join(workdir, "out", "chart.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(workdir, "notes.txt"), "not an image");
  // agent 生成的插画（本次实测里 agent 就是写了一张 svg 再 present 它）
  await writeFile(join(workdir, "scene.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>');
  // 工作目录**之外**的一张真图：读得到也不读（越界就是越界）
  await writeFile(join(root, "secret.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  assert.strictEqual(
    resolveLocalImagePath(workdir, "out/chart.png"),
    join(workdir, "out", "chart.png"),
    "工作目录内的相对路径要解析成绝对路径",
  );
  assert.strictEqual(
    resolveLocalImagePath(workdir, "./out/chart.png"),
    join(workdir, "out", "chart.png"),
    "`./` 前缀不影响解析",
  );
  assert.strictEqual(resolveLocalImagePath(workdir, "../secret.png"), undefined, "`../` 越界必须拒绝");
  assert.strictEqual(
    resolveLocalImagePath(workdir, resolve(root, "secret.png")),
    undefined,
    "工作目录外的绝对路径必须拒绝",
  );
  assert.strictEqual(
    resolveLocalImagePath(workdir, "file:///" + resolve(root, "secret.png").replace(/\\/g, "/")),
    undefined,
    "file:// 外壳不能绕过越界检查",
  );
  assert.strictEqual(resolveLocalImagePath(workdir, "notes.txt"), undefined, "非图片扩展名必须拒绝");
  assert.strictEqual(resolveLocalImagePath(undefined, "out/chart.png"), undefined, "没有工作目录就不读");
  assert.strictEqual(
    resolveLocalImagePath(workdir, "scene.svg"),
    join(workdir, "scene.svg"),
    "svg 是能画的图片（agent 生成的插画多半是它）",
  );
  if (process.platform === "win32") {
    assert.strictEqual(
      resolveLocalImagePath("C:\\workspace", "D:/other/a.png"),
      undefined,
      "跨盘符（relative 会回绝对路径）必须拒绝",
    );
  }
  console.log("local-images: 越界/非图片/无 cwd 全部拒绝 ✓");

  // ---------- 4. 真读一张图 → data URL ----------
  {
    const urls = await readLocalImages(workdir, ["out/chart.png", "../secret.png", "missing.png"]);
    assert.deepStrictEqual(
      Object.keys(urls),
      ["out/chart.png"],
      "只有工作目录内那张真的存在且合格的图进表（越界与不存在都不进）",
    );
    assert.ok(
      urls["out/chart.png"].startsWith("data:image/png;base64,"),
      `进表的必须是 data URL，实际：${urls["out/chart.png"]}`,
    );
    console.log("local-images: 读成 data URL（越界/缺失不进表）✓");
  }

  // ---------- 4b. svg 的 data URL 媒体类型 ----------
  {
    const urls = await readLocalImages(workdir, ["scene.svg"]);
    assert.ok(
      urls["scene.svg"]?.startsWith("data:image/svg+xml;base64,"),
      `svg 的媒体类型要是 image/svg+xml，实际：${urls["scene.svg"]}`,
    );
    console.log("local-images: svg 读成 data:image/svg+xml ✓");
  }

  // ---------- 5. 上限：超大文件与目录都不读 ----------
  {
    const huge = join(workdir, "huge.png");
    await writeFile(huge, Buffer.alloc(LOCAL_IMAGE_MAX_BYTES + 1, 1));
    const urls = await readLocalImages(workdir, ["huge.png"]);
    assert.deepStrictEqual(Object.keys(urls), [], "超过上限的图不读（先 stat 再读，不能读进内存再判断）");

    // 目录带图片扩展名（`shots.png/` 这种东西真会出现）：不是普通文件就不读
    await mkdir(join(workdir, "folder.png"), { recursive: true });
    const dirUrls = await readLocalImages(workdir, ["folder.png"]);
    assert.deepStrictEqual(Object.keys(dirUrls), [], "目录不读");
    console.log("local-images: 超大文件与目录都不读 ✓");
  }

  // ---------- 6. 单次批量有上限（模型能写几百个引用） ----------
  {
    const paths: string[] = [];
    for (let index = 0; index < LOCAL_IMAGE_MAX_REFS + 8; index += 1) {
      const name = `b${index}.png`;
      await writeFile(join(workdir, name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      paths.push(name);
    }
    const urls = await readLocalImages(workdir, paths);
    assert.strictEqual(
      Object.keys(urls).length,
      LOCAL_IMAGE_MAX_REFS,
      `一次最多读 ${LOCAL_IMAGE_MAX_REFS} 张（多的截断，正文其余部分照常）`,
    );
    console.log("local-images: 单次批量截断 ✓");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("\nlocal-images: all assertions passed");
