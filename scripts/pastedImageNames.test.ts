/**
 * `src/webview/pastedImageNames.ts` 的离线断言：粘贴图片的会话内编号名。
 *
 * 运行：npm test（登记在 esbuild.scripts.mjs 的 entries）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planIntake } from "../src/dsh/attachments";

// 桩：`attachIntake` 在 import 期就要 `window` 与 `acquireVsCodeApi`（见 `bridge.ts`）
type Listener = (event: unknown) => void;
const listeners = new Map<string, Listener[]>();
/** 抛给宿主的帧（`bridge.post` 最终落到 `postMessage`）。 */
const posted: unknown[] = [];
(globalThis as { window?: unknown }).window = {
  addEventListener(type: string, listener: Listener): void {
    const list = listeners.get(type) ?? [];
    list.push(listener);
    listeners.set(type, list);
  },
  removeEventListener(type: string, listener: Listener): void {
    const list = listeners.get(type) ?? [];
    const at = list.indexOf(listener);
    if (at >= 0) list.splice(at, 1);
  },
};
(globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
  postMessage: (message: unknown) => posted.push(message),
});

const {
  createPastedImageSequence,
  PASTED_IMAGE_SESSION_LIMIT,
  maxPastedImageIndex,
  nextPastedImageIndex,
  pastedImageIndex,
  pastedImageName,
  renamePastedImages,
  visibleImageNames,
} = await import("../src/webview/pastedImageNames");
const { ATTACH_BYTES_LIMIT, attachPastedFiles, clipboardFiles, imageExtensionFor } = await import(
  "../src/webview/attachIntake"
);

// ---------- 1. 编号名的识别 ----------
assert.strictEqual(pastedImageIndex("图12.png"), 12);
assert.strictEqual(pastedImageIndex("image7.jpeg"), 7, "jpeg 也是我们编出来的名字");
assert.strictEqual(pastedImageIndex("图1"), 1, "没有后缀的形态同样认（补后缀发生在改名之前）");
for (const name of ["image.png", "IMG_1234.png", "图.png", "图0.png", "image03.png", "截图 图1.png", "", undefined]) {
  assert.strictEqual(pastedImageIndex(name), undefined, `${String(name)} 不是编号名（不能参与基线）`);
}

// ---------- 2. 最大编号 / 起始编号 ----------
assert.strictEqual(
  maxPastedImageIndex(["图1.png", "image9.jpeg", "image.png", undefined]),
  9,
  "两种前缀都要认：中途切过语言的会话里编号得接着往下走，否则切语言就撞号",
);
assert.strictEqual(maxPastedImageIndex([]), 0);
assert.strictEqual(nextPastedImageIndex([], 0), 1, "没有历史的新会话从 1 起");
assert.strictEqual(nextPastedImageIndex(["图3.png"], 0), 4);
assert.strictEqual(
  nextPastedImageIndex(["图3.png"], 7),
  8,
  "本窗口已分配出去的编号更大时以它为准（连粘两张时芯片还没回帧）",
);

// ---------- 3. 名字形态 ----------
assert.strictEqual(pastedImageName(1, "png", "zh"), "图1.png");
assert.strictEqual(pastedImageName(2, "jpeg", "en"), "image2.jpeg");

// ---------- 4. 一批条目的改名 ----------
{
  const named = renamePastedImages({
    files: [
      new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" }),
      new File([new Uint8Array([1, 2, 3])], "photo.jpeg", { type: "image/jpeg" }),
      new File([new Uint8Array([4])], "图.png", { type: "image/png" }),
      new File([new Uint8Array([5])], "notes.md", { type: "text/markdown" }),
      new File([new Uint8Array([6])], "README", { type: "" }),
    ],
    startIndex: 3,
    locale: "zh",
  });
  assert.deepStrictEqual(
    named.files.map((file) => file.name),
    ["图3.png", "图4.jpeg", "图5.png", "notes.md", "README"],
    "只改图片；后缀沿用条目自己的（硬写 .png 会把 jpeg 标成名不副实）",
  );
  assert.strictEqual(named.lastIndex, 5, "本批分配到的最大编号");
  assert.strictEqual(named.files[1]!.type, "image/jpeg", "改名不动 MIME：宿主判图与上传归宿都看它");
}

// ---------- 5. 发不出去的条目不改名（提示里要报原名） ----------
{
  const skipped = renamePastedImages({
    files: [
      // 复制目录时 Chromium 给的就是 0 字节、无类型的条目
      new File([new Uint8Array(0)], "photos.png", { type: "" }),
      new File([new Uint8Array(1)], "说明.png", { type: "image/png" }),
    ],
    startIndex: 1,
    locale: "zh",
  });
  assert.deepStrictEqual(
    skipped.files.map((file) => file.name),
    ["photos.png", "图1.png"],
    "0 字节条目不编号（它会走 unreadable 提示，名字必须还是用户认得的那个）",
  );
  assert.strictEqual(skipped.lastIndex, 1, "被拒的条目不占编号");

  const oversized = renamePastedImages({
    files: [
      new File([new Uint8Array(ATTACH_BYTES_LIMIT + 1)], "huge.png", { type: "image/png" }),
      new File([new Uint8Array(1)], "small.png", { type: "image/png" }),
    ],
    startIndex: 4,
    locale: "en",
  });
  assert.deepStrictEqual(
    oversized.files.map((file) => file.name),
    ["huge.png", "image4.png"],
    "超上限条目同样不编号（提示里报的 tooLarge 名字要认得出来）",
  );
  assert.strictEqual(oversized.lastIndex, 4);
}

// ---------- 6. 基线来源：只看用户贴的图 ----------
assert.deepStrictEqual(
  visibleImageNames({
    messages: [
      { role: "user", attachments: [{ kind: "image", name: "图1.png" }, { kind: "file", name: "notes.md" }] },
      { role: "assistant", attachments: [{ kind: "image", name: "图9.png" }] },
    ],
    pendingMessages: [{ attachments: [{ kind: "image", name: "image2.png" }] }],
    attachments: [{ kind: "image", name: "图3.png" }],
  }),
  ["图1.png", "image2.png", "图3.png"],
  "助手/工具图片不是用户贴的，不该占编号",
);

// ---------- 7. 判图（改名的准入门） ----------
assert.strictEqual(imageExtensionFor("image/png", "image.png"), "png");
assert.strictEqual(
  imageExtensionFor("image/jpeg", "photo.jpeg"),
  "jpeg",
  "原名已有后缀就沿用它的写法（photo.jpeg 不该被改写成 .jpg）",
);
assert.strictEqual(imageExtensionFor("image/jpeg", "shot"), "jpg", "没有后缀才按 MIME 补");
assert.strictEqual(imageExtensionFor("image/png; charset=binary", "x"), "png", "带参数的 MIME 要归一化");
assert.strictEqual(imageExtensionFor(undefined, "shot.png"), "png");
assert.strictEqual(imageExtensionFor("", "photo.jpeg"), "jpeg", "表里没有 jpeg 这个键，但它确实是图片");
assert.strictEqual(imageExtensionFor(undefined, "README"), undefined);
assert.strictEqual(imageExtensionFor("application/pdf", "report.pdf"), undefined);
assert.strictEqual(imageExtensionFor("text/plain", "notes.md"), undefined);
assert.strictEqual(
  imageExtensionFor("image/bmp", "x.bmp"),
  "bmp",
  "表外的 image/* 仍按后缀认：宿主会把它当文件上传，但名字该有编号",
);

// ---------- 8. 编号文件的恢复：真实宿主降级结果 → 消息 / 回显 / 草稿 ----------
{
  for (const options of [
    { acceptsImage: false, maxImageBytes: 100 },
    { acceptsImage: true, maxImageBytes: 1 },
  ]) {
    const plan = planIntake({
      items: [{ from: "bytes", name: "图9.png", mimeType: "image/png", bytes: Buffer.from([1, 2]) }],
      ...options,
    });
    assert.strictEqual(plan.attachments[0]!.kind, "file", "不收图 / 超内联上限都降级为文件");
    for (const source of ["messages", "pendingMessages", "attachments"] as const) {
      const restored = {
        messages: [], pendingMessages: [], attachments: [],
        [source]: source === "messages"
          ? [{ role: "user", attachments: plan.attachments }]
          : source === "pendingMessages" ? [{ attachments: plan.attachments }] : plan.attachments,
      };
      const names = visibleImageNames(restored);
      assert.deepStrictEqual(names, ["图9.png"], `${source} 中的编号图片文件必须参与恢复`);
      const named = createPastedImageSequence().rename({
        sessionId: "restored", names, locale: "en",
        files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })],
      });
      assert.strictEqual(named.files[0]!.name, "image10.png", "新编号器（切回 / 重载）从降级图9续号");
    }
  }
  assert.deepStrictEqual(visibleImageNames({
    messages: [{ role: "assistant", attachments: [{ kind: "file", name: "图99.png" }] }],
    pendingMessages: [],
    attachments: [
      ...["notes.md", "image99.txt", "image88.pdf", "image77", "image03.png", "photo.png", "图0.gif"]
        .map((name) => ({ kind: "file", name })),
      { kind: "file", name: "image11.BMP" }, { kind: "file", name: "图12.svg" },
    ],
  }), ["image11.BMP", "图12.svg"], "普通文件不占号；表外图片被上传成文件也能恢复编号");
}

// ---------- 9. 接线的形状钉子 ----------
{
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /const onPaste = \(event: ClipboardEvent\) => \{[\s\S]{0,600}?event\.preventDefault\(\);[\s\S]{0,600}?assigned\.current\.rename\(\{/.test(
      app,
    ) &&
      /assigned\.current\.rename\(\{[\s\S]{0,400}?\}\);[\s\S]{0,200}?attachPastedFiles\(named\.files\);/.test(app),
    "必须先认文件、再改名、最后才走 attachBytes：顺序反了芯片上还是 image.png",
  );
  assert.ok(
    /useLayoutEffect\(\(\) => \{\s*assigned\.current\.selectSession\(state\.session\?\.id\);/.test(app),
    "会话切换必须同步到编号器：即使空态 / 绑定之间没粘贴，也不能串用上一会话的号",
  );
  assert.ok(
    /usePagePaste\(state\);/.test(app),
    "粘贴命名要用得到当前会话状态（历史编号 + 草稿芯片 + 语言），所以 hook 得收 state",
  );
}

// ---------- 10. 真编号器 + 接取 + attachBytes：切回、快粘、中英与空态绑定 ----------
{
  const sequence = createPastedImageSequence();
  const empty = { messages: [], pendingMessages: [], attachments: [] };
  const paste = (sessionId: string | undefined, locale: "zh" | "en") => {
    const files = clipboardFiles({ files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })], items: [] } as unknown as DataTransfer);
    const named = sequence.rename({ sessionId, names: visibleImageNames(empty), files, locale });
    attachPastedFiles(named.files);
    return named.files[0]!.name;
  };
  posted.length = 0;
  sequence.selectSession("A");
  assert.strictEqual(paste("A", "zh"), "图1.png");
  // 删除草稿芯片：此后所有可见来源保持空表。B 的编号独立，切回 A 不回收 1。
  sequence.selectSession("B");
  assert.strictEqual(paste("B", "zh"), "图1.png");
  sequence.selectSession("A");
  assert.strictEqual(paste("A", "zh"), "图2.png", "A删除 → B粘贴 → A 仍续号");
  assert.strictEqual(paste("A", "en"), "image3.png", "无回帧连续快粘且切英文仍续号");
  assert.strictEqual(paste("A", "zh"), "图4.png", "切回中文不回收英文编号");

  // 已有 A → 新空态 → 绑定 C；空态和绑定后的芯片都未回帧。
  sequence.selectSession(undefined);
  assert.strictEqual(paste(undefined, "zh"), "图1.png", "新空态不继承 A 的4");
  assert.strictEqual(paste(undefined, "en"), "image2.png", "空态快粘也占号");
  sequence.selectSession("C");
  assert.strictEqual(paste("C", "zh"), "图3.png", "首次绑定迁移空态已分配编号");
  sequence.selectSession("A");
  sequence.selectSession(undefined);
  sequence.selectSession("D");
  assert.strictEqual(paste("D", "zh"), "图1.png", "空态没粘贴就绑定也不能继承 A");
  sequence.selectSession("C");
  assert.strictEqual(paste("C", "en"), "image4.png", "新建不改变已有 C 的编号");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frames = posted as { type: string; source: string; files: { name: string; mimeType: string }[] }[];
  assert.deepStrictEqual(frames.map((frame) => frame.files[0]!.name), [
    "图1.png", "图1.png", "图2.png", "image3.png", "图4.png", "图1.png", "image2.png", "图3.png", "图1.png", "image4.png",
  ], "这些编号实际发给宿主，不只是起点算术");
  assert.ok(frames.every((frame) => frame.type === "attachBytes" && frame.source === "paste" && frame.files[0]!.mimeType === "image/png"));
}

// ---------- 11. 有界保留窗口：最近访问保留、淘汰后回可见基线 ----------
{
  const sequence = createPastedImageSequence();
  const paste = (sessionId: string, names: string[] = []) => sequence.rename({
    sessionId, names, locale: "zh", files: [new File([new Uint8Array([1])], "image.png", { type: "image/png" })],
  }).files[0]!.name;
  assert.strictEqual(paste("old"), "图1.png");
  assert.strictEqual(paste("recent"), "图1.png");
  for (let i = 0; i < PASTED_IMAGE_SESSION_LIMIT - 2; i += 1) paste(`session-${i}`);
  sequence.selectSession("recent");
  paste("overflow");
  assert.strictEqual(paste("recent"), "图2.png", "最近访问会话不能被当成最早分配的会话淘汰");
  assert.strictEqual(paste("old", ["图9.png"]), "图10.png", "被淘汰会话仍恢复可见最大编号");
  for (let i = 0; i < PASTED_IMAGE_SESSION_LIMIT; i += 1) paste(`later-${i}`);
  assert.strictEqual(paste("old"), "图1.png", "超保留窗口且没有可见事实时不能恢复已删编号");
}

// ---------- 12. 与接取链路的联合：真的粘两张位图 ----------
{
  const clipboard = (files: File[]) => ({ files, items: [] }) as unknown as DataTransfer;
  const shots = clipboardFiles(
    clipboard([
      new File([new Uint8Array([0x89, 0x50])], "image.png", { type: "image/png" }),
      // 截图工具那条路：名字是空的，接取阶段先补成 `pasted-image.png`
      new File([new Uint8Array([1, 2])], "", { type: "image/png" }),
    ]),
  );
  assert.deepStrictEqual(
    shots.map((file) => file.name),
    ["image.png", "pasted-image.png"],
    "接取阶段先补齐后缀（宿主的图片判据要看它）",
  );

  const named = renamePastedImages({ files: shots, startIndex: 1, locale: "zh" });
  posted.length = 0;
  attachPastedFiles(named.files);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frame = posted.at(-1) as { files: { name: string; mimeType?: string }[] };
  assert.deepStrictEqual(
    frame.files.map((file) => file.name),
    ["图1.png", "图2.png"],
    "两张位图到宿主手里已经是编号名，后缀与 MIME 都还在",
  );
  assert.deepStrictEqual(
    frame.files.map((file) => file.mimeType),
    ["image/png", "image/png"],
    "改名不动 MIME：宿主判图与上传归宿都看它",
  );
}

console.log("pastedImageNames: 会话内图片编号（图N / imageN）✓");
