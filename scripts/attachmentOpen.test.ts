/**
 * 「单击打开附件」的本地落点回归（`src/dsh/attachmentOpen.ts`，离线、不碰 vscode）：
 * 叶子名清洗与扩展名补齐、data URL 解码、内容寻址的临时副本落盘，
 * 「内容身份 → 本地可打开路径」索引的等待与淘汰，以及同一条对应关系的**持久化口径**
 * （`src/dsh/attachmentOpenStore.ts`：一条身份一把键、形状校验、按写入时间有界淘汰）。
 *
 * 这一族的行为在真机上只有点了才知道对不对，而且错法都很安静：叶子名没洗干净会在
 * Windows 上建不出文件（整个打开动作静默失败）、扩展名没补上会让一张 PNG 按二进制打开、
 * 索引不等待在途落盘会让「上传成功那一瞬间点一下」偶发打不开、持久记录丢了则会让
 * **重开 VS Code 之后**历史消息里的文件附件点不开（用户的文件还在原处）。
 */
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_TEMP_DIR,
  AttachmentOpenIndex,
  attachmentTempPath,
  attachmentTempRoot,
  contentDigest,
  materializeAttachment,
  parseBase64DataUrl,
  safeAttachmentFileName,
} from "../src/dsh/attachmentOpen";
import {
  ATTACHMENT_TARGET_KEY_PREFIX,
  ATTACHMENT_TARGET_LIMIT,
  readAttachmentTarget,
  readOriginalTarget,
  writeAttachmentTarget,
  type AttachmentTargetStorage,
} from "../src/dsh/attachmentOpenStore";

/**
 * 最小 Memento：`vscode.Memento` 结构上就是这个形状（`keys` / `get` / `update`）。
 * 值写 `undefined` 等于**删键**——真 Memento 也这样（JSON 化时整个键消失，见 `unreadStore.ts`）。
 */
function fakeStorage(): AttachmentTargetStorage {
  const map = new Map<string, unknown>();
  return {
    keys: () => [...map.keys()],
    get: <T,>(key: string, fallback?: T): T | undefined => (map.has(key) ? (map.get(key) as T) : fallback),
    update: (key, value) => {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    },
  };
}

const failures: { name: string; error: unknown }[] = [];
async function scenario(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    console.log(`  ${name} ✓`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  ${name} ✗ ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("attachmentOpen: 附件临时副本与打开索引");

const root = mkdtempSync(join(tmpdir(), "dsh-attachment-open-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 清理失败不影响断言结论
  }
});

await scenario("叶子名清洗：两种分隔符都剥、非法字符换掉、空名兜底", () => {
  assert.strictEqual(safeAttachmentFileName("C:\\ws\\out\\图1.png"), "图1.png");
  assert.strictEqual(safeAttachmentFileName("/tmp/a/b.txt"), "b.txt");
  assert.strictEqual(safeAttachmentFileName('a<b>c:d"e|f?g*h.txt'), "a_b_c_d_e_f_g_h.txt");
  assert.strictEqual(safeAttachmentFileName("   "), "attachment");
  assert.strictEqual(safeAttachmentFileName("."), "attachment");
  assert.strictEqual(safeAttachmentFileName(".."), "attachment");
  // 结尾的点与空格在 Windows 上建不出文件
  assert.strictEqual(safeAttachmentFileName("report.  "), "report");
});

await scenario("扩展名：名字给得出就沿用，给不出才按媒体类型补", () => {
  assert.strictEqual(safeAttachmentFileName("image", "image/png"), "image.png");
  assert.strictEqual(safeAttachmentFileName("shot.JPEG", "image/png"), "shot.JPEG");
  assert.strictEqual(safeAttachmentFileName("notes.md", "text/plain"), "notes.md");
  // 认不出的媒体类型不硬塞一个（塞错扩展名比没有更糟：编辑器会按错的类型打开）
  assert.strictEqual(safeAttachmentFileName("blob", "application/x-unknown"), "blob");
});

await scenario("临时路径：内容摘要分目录，同名不同内容不撞", () => {
  const a = attachmentTempPath(root, "a".repeat(64), "图1.png");
  const b = attachmentTempPath(root, "b".repeat(64), "图1.png");
  assert.notStrictEqual(a, b);
  assert.ok(a.endsWith(join("a".repeat(12), "图1.png")), `摘要在路径里：${a}`);
  assert.strictEqual(attachmentTempRoot("X:\\tmp"), join("X:\\tmp", ATTACHMENT_TEMP_DIR));
});

await scenario("data URL 解码：只认 base64，超上限与畸形一律 undefined", () => {
  const hello = Buffer.from("hello").toString("base64");
  assert.deepStrictEqual(parseBase64DataUrl(`data:image/png;base64,${hello}`), {
    bytes: Buffer.from("hello"),
    mediaType: "image/png",
  });
  assert.strictEqual(parseBase64DataUrl(`data:image/png,${encodeURIComponent("hello")}`), undefined);
  assert.strictEqual(parseBase64DataUrl("not a data url"), undefined);
  assert.strictEqual(parseBase64DataUrl("data:image/png;base64,"), undefined);
  // 上限按字符串长度先粗筛一次（base64 约 4/3 体积），再按解出来的字节判
  assert.strictEqual(parseBase64DataUrl(`data:image/png;base64,${hello}`, 2), undefined);
});

await scenario("落盘：内容寻址、重复调用复用同一份，改内容换文件", async () => {
  const bytes = Buffer.from("first content");
  const path = await materializeAttachment({ root, bytes, name: "a.txt" });
  assert.ok(existsSync(path), "文件应已落盘");
  assert.strictEqual(readFileSync(path, "utf8"), "first content");
  assert.strictEqual(path, join(root, contentDigest(bytes).slice(0, 12), "a.txt"));
  const again = await materializeAttachment({ root, bytes, name: "a.txt" });
  assert.strictEqual(again, path, "同一份内容复用同一个文件");
  const other = await materializeAttachment({ root, bytes, name: "b.txt" });
  assert.notStrictEqual(other, path, "叶子名不同就是另一个文件（展示名要保住）");
  const changed = await materializeAttachment({ root, bytes: Buffer.from("second"), name: "a.txt" });
  assert.notStrictEqual(changed, path);
  assert.strictEqual(readFileSync(changed, "utf8"), "second");
  assert.strictEqual(contentDigest(bytes), contentDigest(Buffer.from("first content")));
});

await scenario("索引：记路径、等在途落盘、落盘失败即丢、超上限丢最旧", async () => {
  const index = new AttachmentOpenIndex(2);
  index.remember("sha256:one", "C:\\ws\\one.txt");
  assert.strictEqual(await index.pathFor("sha256:one"), "C:\\ws\\one.txt");
  assert.strictEqual(await index.pathFor("sha256:missing"), undefined, "没记过的不猜");

  let release!: (value: string | undefined) => void;
  const pending = new Promise<string | undefined>((resolve) => {
    release = resolve;
  });
  index.remember("sha256:pending", pending);
  const waited = index.pathFor("sha256:pending");
  release("C:\\tmp\\pending.txt");
  assert.strictEqual(await waited, "C:\\tmp\\pending.txt", "在途落盘要等它落地再打开");

  index.remember("sha256:broken", Promise.resolve(undefined));
  assert.strictEqual(await index.pathFor("sha256:broken"), undefined);

  // 上限是**唯一的清理路径**：丢最旧的一条（只丢索引，不动磁盘上的副本）
  const capped = new AttachmentOpenIndex(2);
  capped.remember("sha256:old", "old.txt");
  capped.remember("sha256:mid", "mid.txt");
  capped.remember("sha256:new", "new.txt");
  assert.strictEqual(capped.size, 2, "上限 2 时不能留第三份");
  assert.strictEqual(await capped.pathFor("sha256:old"), undefined, "丢的是最旧的一条");
  assert.strictEqual(await capped.pathFor("sha256:mid"), "mid.txt");
  assert.strictEqual(await capped.pathFor("sha256:new"), "new.txt");
});

await scenario("打开记录：一条身份一把键、原文件与副本分开、形状不对就忽略、超上限丢最旧", () => {
  const storage = fakeStorage();
  assert.strictEqual(readAttachmentTarget(storage, "sha256:a"), undefined, "没记过的不猜");

  writeAttachmentTarget(storage, "sha256:a", { path: "C:\\ws\\a.txt", copy: false }, 1);
  writeAttachmentTarget(storage, "sha256:b", { path: "C:\\tmp\\b.txt", copy: true }, 2);
  assert.deepStrictEqual(readAttachmentTarget(storage, "sha256:a"), { path: "C:\\ws\\a.txt", copy: false });
  assert.deepStrictEqual(readAttachmentTarget(storage, "sha256:b"), { path: "C:\\tmp\\b.txt", copy: true });
  // 悬停提示只展示**用户的文件**：临时副本能打开，但不是「文件路径」
  assert.strictEqual(readOriginalTarget(storage, "sha256:a"), "C:\\ws\\a.txt");
  assert.strictEqual(readOriginalTarget(storage, "sha256:b"), undefined, "副本不当原文件路径");
  assert.strictEqual(
    storage.keys().filter((key) => key.startsWith(ATTACHMENT_TARGET_KEY_PREFIX)).length,
    2,
    "一条身份一把键（不是整份集合，见 attachmentOpenStore.ts 文件头）",
  );

  // 重复记同一个身份就是覆盖：后一次见到的那个文件更可信
  writeAttachmentTarget(storage, "sha256:a", { path: "D:\\moved\\a.txt", copy: false }, 3);
  assert.strictEqual(readOriginalTarget(storage, "sha256:a"), "D:\\moved\\a.txt");
  // 同一条句柄从「临时副本」变成「原文件」（用户后来把它存到了磁盘上）：跟着覆盖
  writeAttachmentTarget(storage, "sha256:b", { path: "D:\\keep\\b.txt", copy: false }, 4);
  assert.strictEqual(readOriginalTarget(storage, "sha256:b"), "D:\\keep\\b.txt");

  // 别的功能写在同一个 Memento 里的键不受影响，也不被当成记录
  void storage.update("unread:session-a", true);
  assert.strictEqual(readAttachmentTarget(storage, "session-a"), undefined);
  assert.strictEqual(storage.get("unread:session-a"), true, "不碰别人的键");

  // 形状不对（旧版本 / 脏数据）当作没有：宁可说打不开，也不能拿一个不是路径的值去开
  void storage.update(`${ATTACHMENT_TARGET_KEY_PREFIX}sha256:broken`, { path: "" });
  assert.strictEqual(readAttachmentTarget(storage, "sha256:broken"), undefined);
  void storage.update(`${ATTACHMENT_TARGET_KEY_PREFIX}sha256:legacy`, "C:\\ws\\legacy.txt");
  assert.strictEqual(readAttachmentTarget(storage, "sha256:legacy"), undefined, "不是记录形状的整条忽略");
  // 没有 `copy` 字段的旧记录按**原文件**解释：最坏是悬停多显示一个路径，比丢掉一条能打开的记录轻
  void storage.update(`${ATTACHMENT_TARGET_KEY_PREFIX}sha256:older`, { path: "C:\\ws\\older.txt", at: 1 });
  assert.strictEqual(readOriginalTarget(storage, "sha256:older"), "C:\\ws\\older.txt");
  void storage.update(ATTACHMENT_TARGET_KEY_PREFIX, { path: "C:\\ws\\no-id.txt", at: 1 });
  assert.strictEqual(readAttachmentTarget(storage, ""), undefined, "空身份不读");

  // 越过上限丢最旧的那些（按写入时刻，不按 keys() 顺序）
  const capped = fakeStorage();
  for (let i = 0; i < ATTACHMENT_TARGET_LIMIT + 3; i++) {
    writeAttachmentTarget(capped, `sha256:${i}`, { path: `C:\\ws\\${i}.txt`, copy: false }, i);
  }
  assert.strictEqual(
    capped.keys().filter((key) => key.startsWith(ATTACHMENT_TARGET_KEY_PREFIX)).length,
    ATTACHMENT_TARGET_LIMIT,
    "条数压回上限之内",
  );
  assert.strictEqual(readOriginalTarget(capped, "sha256:0"), undefined, "丢的是最旧的三条");
  assert.strictEqual(readOriginalTarget(capped, "sha256:2"), undefined);
  assert.strictEqual(readOriginalTarget(capped, "sha256:3"), "C:\\ws\\3.txt");
  assert.strictEqual(
    readOriginalTarget(capped, `sha256:${ATTACHMENT_TARGET_LIMIT + 2}`),
    `C:\\ws\\${ATTACHMENT_TARGET_LIMIT + 2}.txt`,
    "最新的一条一定在",
  );
});

if (failures.length) {
  console.error(`\nattachmentOpen: ${failures.length} 个场景失败`);
  for (const failure of failures) {
    console.error(`- ${failure.name}: ${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`);
  }
  process.exit(1);
}
console.log("attachmentOpen: 全部场景通过 ✓");
