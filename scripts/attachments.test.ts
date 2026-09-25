/**
 * 附件归类里**不属于** `pathInsert.test.ts` 的两块：
 *
 * 1. 扩展名 → mediaType 的纯映射（最便宜的落点）；
 * 2. `showOpenDialog` 的跨平台约束——这条无法在无头环境测行为，只能扫源码。
 *
 * `classifyPath` 的完整覆盖（目录 / 图片 / 文本 / 二进制 / 非 UTF-8 / 过大 /
 * 读不出来 / 模型不支持图片）在 `pathInsert.test.ts`，那里有真实临时文件。
 *
 * 运行：npm test
 */
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attachment } from "../src/shared/chat";
import {
  ATTACH_BYTES_LIMIT,
  buildPromptContent,
  classifyDroppedBytes,
  classifyPath,
  imageMediaTypeFor,
  imageMediaTypeForEntry,
  includedAttachments,
  isDirectoryPath,
  isImagePath,
  planIntake,
} from "../src/dsh/attachments";

// ---------- 1. 扩展名 → mediaType ----------

assert.strictEqual(imageMediaTypeFor("a.png"), "image/png");
assert.strictEqual(imageMediaTypeFor("D:\\shots\\a.JPG"), "image/jpeg");
assert.strictEqual(imageMediaTypeFor("a.jpeg"), "image/jpeg");
assert.strictEqual(imageMediaTypeFor("a.webp"), "image/webp");
assert.strictEqual(imageMediaTypeFor("a.gif"), "image/gif");
// 非图片 / 无扩展名 / 路径里有点但不是扩展名
assert.strictEqual(imageMediaTypeFor("a.txt"), undefined);
assert.strictEqual(imageMediaTypeFor("Makefile"), undefined);
assert.strictEqual(imageMediaTypeFor("a.png.txt"), undefined);
assert.strictEqual(imageMediaTypeFor("archive.tar.gz"), undefined);
assert.strictEqual(isImagePath("logo.webp"), true);
assert.strictEqual(isImagePath("logo.svg"), false, "svg 不在支持列表内");
// MIME 优先（官方 `isImageMediaType(file.type)`）：有 MIME 就只看 MIME，
// 表外的 `image/*` 一律按普通文件走——否则一个 `a.png` 的文本文件会被当图片内联，
// 提交时被服务端整批拒掉
assert.strictEqual(imageMediaTypeForEntry("image/png", "a.bin"), "image/png", "MIME 说了算");
assert.strictEqual(imageMediaTypeForEntry("image/jpeg; charset=x", "a.jfif"), "image/jpeg", "带参数也认");
assert.strictEqual(imageMediaTypeForEntry("image/bmp", "a.bmp"), undefined, "表外的 image/* 不当图片");
assert.strictEqual(imageMediaTypeForEntry("text/plain", "a.png"), undefined, "MIME 与后缀冲突时听 MIME");
assert.strictEqual(imageMediaTypeForEntry("", "a.png"), "image/png", "没声明 MIME 才退回后缀");
assert.strictEqual(imageMediaTypeForEntry(undefined, "a.PNG"), "image/png");
assert.strictEqual(imageMediaTypeForEntry("", "Makefile"), undefined);
console.log("attachments: 扩展名归类 ✓");

// ---------- 2. 目录静态探测 + 附件 id 唯一 ----------

const dir = mkdtempSync(join(tmpdir(), "dsh-attach-"));
try {
  const txtPath = join(dir, "notes.txt");
  writeFileSync(txtPath, "hello", "utf8");

  assert.strictEqual(isDirectoryPath(dir), true, "真实目录要认出来");
  assert.strictEqual(isDirectoryPath(txtPath), false, "普通文件不能被判成目录");
  assert.strictEqual(isDirectoryPath(join(dir, "nope")), false, "不存在的路径不能抛错");

  // 同一次选择里的两个附件不能撞 id
  const a = classifyPath({ path: txtPath, name: "notes.txt", acceptsImage: true });
  const b = classifyPath({ path: txtPath, name: "notes.txt", acceptsImage: true });
  assert.ok(a.kind === "attachment" && b.kind === "attachment");
  assert.notStrictEqual(a.attachment.id, b.attachment.id);

  // 读取失败要能报出来（而不是静默变成空结果）
  const messages: string[] = [];
  classifyPath({
    path: join(dir, "missing.txt"),
    name: "missing.txt",
    acceptsImage: true,
    onError: (message) => messages.push(message),
  });
  assert.strictEqual(messages.length, 1, "应当报告读取失败");
  assert.ok(messages[0].includes("missing.txt"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("attachments: 目录探测 / id / 错误上报 ✓");

// ---------- 3. 回归防线：OpenDialog 的 canSelectFiles / canSelectFolders 不能同时为 true ----------
//
// VS Code 的 OpenDialogOptions 明确写着（@types/vscode/index.d.ts:2063）：
//   "On Windows and Linux, a file dialog cannot be both a file selector and a
//    folder selector, so if you set both `canSelectFiles` and `canSelectFolders`
//    to `true` on these platforms, a folder selector will be shown."
//
// 也就是说「同时置 true」在 Windows 上会**只**弹目录选择器、文件全被过滤掉。
// 这个 bug 真实发生过（pickFiles 曾是无人调用的死代码，接上按钮后才暴露），
// 所以直接扫源码把这个不变量钉住——showOpenDialog 无法在无头环境里测行为。
{
  const source = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  const calls = [...source.matchAll(/showOpenDialog\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 2, `应当至少有两个 showOpenDialog 调用，实际 ${calls.length}`);

  for (const body of calls) {
    const files = /canSelectFiles:\s*(true|false)/.exec(body)?.[1];
    const folders = /canSelectFolders:\s*(true|false)/.exec(body)?.[1];
    assert.ok(
      !(files === "true" && folders === "true"),
      `不能同时选文件与目录（Windows 上只会弹目录选择器）：\n${body.trim()}`,
    );
  }
  console.log(`attachments: showOpenDialog 标志互斥（扫到 ${calls.length} 处）✓`);
}

// ---------- 4. 拖放（只有字节 + 文件名，没有路径） ----------
//
// webview 拿不到被拖文件的路径：VS Code 不把资源注入 webview 的 DataTransfer
// （没有 ResourceURLs / text/uri-list），`File.path` 自 Electron 32 起也已移除。
// 所以拖放只能走字节，归类判据也只剩「文件名 + 模型收不收图」。
{
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const image = classifyDroppedBytes({ name: "shot.png", bytes: pngBytes, acceptsImage: true });
  assert.strictEqual(image.attachment.kind, "image", "模型收图时图片内联成内容块");
  assert.strictEqual(
    image.attachment.dataUrl,
    `data:image/png;base64,${Buffer.from(pngBytes).toString("base64")}`,
    "dataUrl 必须由字节直接拼（没有路径可读）",
  );
  assert.strictEqual(image.attachment.bytes, pngBytes.length, "字节数要如实带上");
  assert.strictEqual(image.attachment.path, undefined, "拖放来的附件没有路径");

  // 模型不收图：不能退回「插入路径」——拖放根本没有路径可插，改走上传
  const unsupported = classifyDroppedBytes({ name: "shot.png", bytes: pngBytes, acceptsImage: false });
  assert.strictEqual(
    unsupported.attachment.kind,
    "file",
    "模型不收图时图片退化为普通文件上传，而不是丢掉（拖放没有路径可插）",
  );

  const text = classifyDroppedBytes({
    name: "notes.md",
    bytes: new TextEncoder().encode("# hi"),
    acceptsImage: true,
  });
  assert.strictEqual(text.attachment.kind, "file", "普通文件走上传");
  assert.strictEqual(text.attachment.name, "notes.md", "文件名原样保留（芯片上显示它）");

  // id 必须唯一：两个同名文件拖两次是两条附件
  const a = classifyDroppedBytes({ name: "same.txt", bytes: new Uint8Array([1]), acceptsImage: true });
  const b = classifyDroppedBytes({ name: "same.txt", bytes: new Uint8Array([2]), acceptsImage: true });
  assert.notStrictEqual(a.attachment.id, b.attachment.id, "同名文件的附件 id 不能相同");

  // 上限：界面按它拦掉超大文件（读了再 base64 是白烧内存），宿主侧同值
  assert.strictEqual(ATTACH_BYTES_LIMIT, 8 * 1024 * 1024, "webview 字节通道上限 8 MB");
  // 接取逻辑在 attachIntake.ts（App 的全页监听用它），不在 Composer——
  // Composer 里若再留一份 attachBytes，同一份文件会被接两次、出两条附件
  const composer = readFileSync(join(process.cwd(), "src", "webview", "components", "Composer.tsx"), "utf8");
  assert.ok(
    !/post\(\{\s*type:\s*"attachBytes"/.test(composer),
    "Composer 里不得再发 attachBytes：全页统一由 App 的 window 监听接 drop / paste，留在输入框会双发",
  );
  const intake = readFileSync(join(process.cwd(), "src", "webview", "attachIntake.ts"), "utf8");
  assert.ok(
    /const ATTACH_BYTES_LIMIT = 8 \* 1024 \* 1024;/.test(intake),
    "界面侧的上限必须与宿主同值：不一致时要么白读，要么发过去被拒",
  );
  assert.ok(
    /post\(\{ type: "attachBytes", source, files: payload, unreadable, tooLarge \}\)/.test(intake),
    "接取结果必须走 attachBytes（只有字节，没有路径），且带上 source 供宿主分措辞",
  );
  // 全页接取的钉子：dragover/drop 的 preventDefault 是「本页接受投放」的声明，
  // 缺了浏览器走默认行为（导航到文件）= VS Code 把文件在编辑器里打开
  const app = readFileSync(join(process.cwd(), "src", "webview", "App.tsx"), "utf8");
  assert.ok(
    /window\.addEventListener\("dragover", onDragOver\)/.test(app) &&
      /window\.addEventListener\("drop", onDrop\)/.test(app),
    "拖放监听必须挂 window（整页都是 drop 目标）——只挂输入框时拖到消息区会被 VS Code 打开文件",
  );
  assert.ok(
    /const onDrop = \(event: DragEvent\) => \{\s*\n\s*if \(!dragHasFiles\(event\)\) return;\s*\n\s*event\.preventDefault\(\);/.test(app),
    "onDrop 必须 preventDefault（且只拦文件拖拽）：文本拖拽要放行给 textarea 的原生插入",
  );
  // 粘贴同理挂 window（事件从焦点元素冒泡上来，一处接住就够），且**只在认出文件时**
  // 才 preventDefault——先 preventDefault 再判断会把文本粘贴一起吃掉
  assert.ok(
    /const onPaste = \(event: ClipboardEvent\) => \{\s*\n\s*const files = clipboardFiles\(event\.clipboardData\);\s*\n\s*if \(!files\.length\) return;[\s\S]{0,200}?event\.preventDefault\(\);/.test(
      app,
    ) &&
      /window\.addEventListener\("paste", onPaste\)/.test(app) &&
      /usePagePaste\(\);/.test(app),
    "粘贴必须挂 window、只在认出文件后才 preventDefault，且真的被 App 调用",
  );
  console.log("attachments: 拖放字节归类 ✓");
}

// ---------- 5. 粘贴（剪贴板里的文件 / 图片） ----------
//
// 用户 2026-09-21 需求：「支持剪切板文件传入、图片传入」。
//
// 这一段的断言是**真调用**（不读源码）：把 `window` / `acquireVsCodeApi` 补成最小桩，
// 动态 import 界面侧的 `attachIntake`，再喂假的 DataTransfer——抛给宿主的 `attachBytes`
// 帧长什么样，就在这里对拍（`src/webview/attachIntake.ts` 的文件头记了 VS Code 桌面版
// 是怎么把 Ctrl+V 接过去又补发一次 paste 的）。
{
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Listener[]>();
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
  const posted: unknown[] = [];
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
  });

  const { ATTACH_BYTES_LIMIT: WEB_LIMIT, attachPastedFiles, clipboardFiles } = await import(
    "../src/webview/attachIntake"
  );

  // 界面侧的上限与宿主同一个值（两处都叫同一个名字，不一致时要么白读、要么被拒）
  assert.strictEqual(WEB_LIMIT, ATTACH_BYTES_LIMIT, "界面与宿主的字节上限必须同值");

  /** 一个只够 `clipboardFiles` 用的假 DataTransfer。 */
  function clipboard(files: File[], items: { kind: string; type: string; file: File | null }[]) {
    return {
      files,
      items: items.map((item) => ({
        kind: item.kind,
        type: item.type,
        getAsFile: () => item.file,
      })),
    } as unknown as DataTransfer;
  }

  const shot = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });
  const notes = new File([new TextEncoder().encode("hello")], "notes.md", { type: "text/markdown" });

  // ① 纯文本粘贴必须返回空数组：调用方据此**放行**原生插入（吃掉就等于粘贴失灵）
  assert.deepStrictEqual(
    clipboardFiles(clipboard([], [{ kind: "string", type: "text/plain", file: null }])),
    [],
    "纯文本粘贴不能算附件（否则 textarea 的粘贴被 preventDefault 吃掉）",
  );
  assert.deepStrictEqual(clipboardFiles(null), [], "拿不到 clipboardData 时返回空数组（不抛）");

  // ② 资源管理器里复制文件后粘贴：Chromium 把 CF_HDROP 放进 `files`
  assert.deepStrictEqual(
    clipboardFiles(clipboard([notes, shot], [])).map((f) => f.name),
    ["notes.md", "image.png"],
    "files 里的文件原样接住（含图片）",
  );

  // ③ 只给 items 的场合（截图工具 / 部分应用的图片剪贴板格式）：走 getAsFile
  const shotNoName = new File([new Uint8Array([1, 2, 3])], "", { type: "image/png" });
  const fromItems = clipboardFiles(clipboard([], [{ kind: "file", type: "image/png", file: shotNoName }]));
  assert.strictEqual(fromItems.length, 1, "items 里的文件条目也要接住");
  // **名字必须有后缀**：宿主的图片判据只看文件名后缀（`imageMediaTypeFor`），
  // 没后缀的会退化成「普通文件上传」——用户粘一张图却只得到文件芯片
  assert.strictEqual(fromItems[0].name, "pasted-image.png", "无名截图要补一个带后缀的名字");
  assert.strictEqual(imageMediaTypeFor(fromItems[0].name), "image/png", "补出来的名字必须能判成图片");
  assert.strictEqual(fromItems[0].size, 3, "包装过的 File 字节不变");

  // ④ 抛给宿主的那一帧：source 必须是 paste（提示措辞按它分「拖放 / 粘贴」两套）
  posted.length = 0;
  attachPastedFiles([shot]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(posted.length, 1, `粘贴一次应恰好发一帧 attachBytes，实际 ${posted.length} 帧`);
  const frame = posted[0] as {
    type: string;
    source: string;
    files: { name: string; mimeType?: string; base64: string }[];
    unreadable: string[];
    tooLarge: string[];
  };
  assert.strictEqual(frame.type, "attachBytes");
  assert.strictEqual(frame.source, "paste", "粘贴这条路必须带 source: paste");
  assert.strictEqual(frame.files.length, 1);
  assert.strictEqual(frame.files[0].name, "image.png");
  assert.strictEqual(
    frame.files[0].base64,
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
    "字节要原样 base64 过线（宿主据此上传 / 内联）",
  );
  // **MIME 必须过线**：宿主优先按它判图片（与官方 `isImageMediaType(file.type)` 同口径），
  // 丢掉的话后缀认不出来的图（`.jfif`、无后缀）就会被当成普通文件传上去
  assert.strictEqual(frame.files[0].mimeType, "image/png", "浏览器声明的 MIME 要带给宿主");
  assert.deepStrictEqual(frame.unreadable, []);
  assert.deepStrictEqual(frame.tooLarge, []);

  // ⑤ 超限的**根本不读**：只把名字报给宿主提示（读了再 base64 是白烧内存）
  const huge = new File([new Uint8Array(ATTACH_BYTES_LIMIT + 1)], "huge.bin");
  posted.length = 0;
  attachPastedFiles([huge]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const oversized = posted[0] as { files: unknown[]; tooLarge: string[] };
  assert.strictEqual(oversized.files.length, 0, "超限文件不进 payload");
  assert.deepStrictEqual(oversized.tooLarge, ["huge.bin"], "超限文件必须报出名字（不静默丢弃）");

  // ⑥ **不许把非图片条目改成 `*.png`**（用户 2026-09-21 报的 bug ②）
  //
  // 上一版写成 `IMAGE_EXTENSIONS[mime] ?? "png"`，于是任何无后缀的名字都被补成
  // `.png`。实测（VS Code 1.138 + 资源管理器复制的真实剪贴板形状）：
  //   - 复制目录 `docs` → File{ name:"docs", type:"", size:0 }（字节读不出来）
  //   - 复制无扩展名文件 `LICENSE` → File{ name:"LICENSE", type:"", size:2001 }
  //   - 复制 `icon.png` → File{ name:"icon.png", type:"image/png" }
  const folderEntry = new File([], "docs", { type: "" });
  const noExt = new File([new TextEncoder().encode("MIT")], "LICENSE", { type: "" });
  assert.deepStrictEqual(
    clipboardFiles(clipboard([folderEntry, noExt], [])).map((f) => f.name),
    ["docs", "LICENSE"],
    "type 为空的条目必须保留原名：只有 MIME 说了是图片才补后缀（否则目录/无扩展名文件都成 .png）",
  );
  assert.strictEqual(imageMediaTypeFor("docs"), undefined, "`docs` 不该被判成图片");
  // 名字空 + MIME 说是图片 → 才补 `.png`（截图工具那条路）
  assert.strictEqual(
    clipboardFiles(clipboard([], [{ kind: "file", type: "image/png", file: new File([new Uint8Array([1])], "", { type: "image/png" }) }]))[0]
      .name,
    "pasted-image.png",
    "无名**图片**才补后缀",
  );

  // ⑦ 0 字节目录条目：不读、直接报 unreadable，**不许**变成一个 0 字节的假附件
  posted.length = 0;
  attachPastedFiles([folderEntry]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const folderFrame = posted[0] as { files: { name: string; base64: string }[]; unreadable: string[] };
  assert.deepStrictEqual(folderFrame.files, [], "目录条目（0 字节）不进 payload——上一版发的是 `docs.png` + 空 base64");
  assert.deepStrictEqual(folderFrame.unreadable, ["docs"], "读不出来的条目要报名字，让宿主提示");

  console.log("attachments: 粘贴接取（纯文本放行 / files 与 items / 只给图片补后缀 / 0 字节报 unreadable / source / 超限）✓");
}

// ---------- 6. 宿主侧：三个入口一条管线（源码形态） ----------
//
// `scripts/i18n.test.ts` 只保证「登记过的标记有字面量发射点」，但**分派对不对**
// （source === "paste" 时用的是哪一条）它看不到。这里把那段三元表达式钉住：
// 粘贴来的东西被拒时不许说「拖放上限」——用户手上根本没有那个可拖的文件。
//
// 另外钉住**只有一份接入实现**：路径通道与字节通道曾经各写一遍
// （`applyPathsForView` / `applyBytesForView`），于是漂移出「字节附件发送时被丢掉」
// 的 BUG（行为断言在下面「发送装配」一节，这里是结构断言）。
{
  const controller = readFileSync(join(process.cwd(), "src", "dsh", "controller.ts"), "utf8");
  for (const [key, fallback] of [
    ["pasteUnreadable", "dropUnreadable"],
    ["pasteTooLarge", "dropTooLarge"],
  ] as const) {
    assert.ok(
      new RegExp(`source === "paste" \\? "@${key}" : "@${fallback}"`).test(controller),
      `宿主必须按 source 在 @${key} 与 @${fallback} 之间分派`,
    );
  }
  assert.ok(
    /message\.source === "paste" \? "paste" : "drop"/.test(controller),
    "帧里的 source 要按肯定证据判 paste，其余一律当拖放（旧帧没有这个字段）",
  );
  // **粘贴优先真路径**（用户 2026-09-21 口径④）：webview 拿不到路径，宿主去系统
  // 剪贴板取；取到的路径**不分流**，整批交给接入管线（目录 → `@dir/` 引用、
  // 文件 → 附件，由 `planIntake` 一处决定）。顺序**不可反**：先走字节通道的话
  // 目录又变 0 字节附件、大文件又被 8 MB 挡掉。
  assert.ok(
    /const clipboardPaths = message\.source === "paste" \? await readClipboardPaths\(\) : \[\]/.test(
      controller,
    ),
    "粘贴必须先在宿主侧取剪贴板真路径（非粘贴一律不取），再谈字节通道",
  );
  assert.ok(
    /if \(clipboardPaths\.length\) \{[\s\S]{0,400}?await this\.addPaths\(viewId, clipboardPaths, "paste"\)/.test(
      controller,
    ),
    "取到路径就整批（含目录）交给接入管线，宿主不再自己按类别分流",
  );
  assert.ok(
    /private addDirectoryReference\(viewId: string, path: string\): void \{\s*\n\s*this\.insertMention\(viewId, formatFileMention\(this\.relativePath\(path\), "directory"\)\)/.test(
      controller,
    ),
    "目录只有一个落点：`@dir/` 引用文本（分隔符归一与尾斜杠在 formatFileMention 里）",
  );
  assert.ok(
    (controller.match(/this\.addDirectoryReference\(/g) ?? []).length >= 3,
    "目录落点要覆盖三个入口：接入管线、选目录对话框、右键/命令面板的 addFileContext",
  );
  assert.ok(
    !/applyPathsForView|applyBytesForView|runUploadBytes/.test(controller),
    "两条平行通道必须已经收成一条（`ingestAttachments` + `planIntake` + `startUpload`）",
  );
  assert.ok(
    /private async ingestAttachments\(/.test(controller) &&
      /const plan = planIntake\(\{/.test(controller),
    "路径与字节都走同一个 ingestAttachments → planIntake",
  );
  console.log("attachments: 宿主按 source 分「拖放 / 粘贴」两套提示、三入口一条管线 ✓");
}

// ---------- 7. 发送装配：字节附件（没有路径）不许被丢掉 ----------
//
// **真调用**（不读源码）：2026-09-21 的 BUG 就出在这里——发送装配要求 `attachment.path`，
// 而拖放 / 粘贴进来的字节附件没有 path，于是上传照做、prompt 里却没有它，连
// 「有附件没传上去」的提示也被同一道门吞掉了。
{
  const file = (id: string, name: string, upload?: Attachment["upload"], path?: string): Attachment => ({
    id,
    kind: "file",
    name,
    ...(path ? { path } : {}),
    ...(upload ? { upload } : {}),
  });
  const image = (id: string, name: string, dataUrl?: string): Attachment =>
    ({ id, kind: "image", name, ...(dataUrl ? { dataUrl } : {}) });

  // ① 没有路径 + 上传成功 → 必须进 content（这条就是那个 BUG 的回归防线）
  const ready = buildPromptContent("看这个", [file("b1", "shot.pdf", { status: "ready", receiptId: "r1" })]);
  assert.deepStrictEqual(
    ready.content,
    [
      { type: "file", receiptId: "r1" },
      { type: "text", text: "看这个" },
    ],
    "无路径的文件附件上传成功后必须随消息发出（判据是上传回执，不是 path）",
  );
  assert.deepStrictEqual(ready.notUploaded, [], "传上去了就不该出现在「没发出去」清单里");

  // ② 有路径的附件同样按回执走（不许因为多了个 path 就换判据）
  const withPath = buildPromptContent("", [
    file("b2", "a.ts", { status: "ready", receiptId: "r2" }, "D:/app/a.ts"),
  ]);
  assert.deepStrictEqual(withPath.content, [{ type: "file", receiptId: "r2" }], "正文为空时只留附件");

  // ③ 未就绪（上传中 / 失败 / 状态丢了）→ 不进 content，但必须报出名字让宿主提示
  const pending = buildPromptContent("x", [
    file("b3", "uploading.bin", { status: "uploading", loaded: 10 }),
    file("b4", "failed.bin", { status: "error", message: "HTTP 413" }),
    file("b5", "lost.bin"),
    file("b6", "ok.bin", { status: "ready", receiptId: "r6" }),
  ]);
  assert.deepStrictEqual(
    pending.notUploaded,
    ["uploading.bin", "failed.bin", "lost.bin"],
    "没传上去的（含上传中）都要报名字——静默丢附件是这个 BUG 的另一半",
  );
  assert.deepStrictEqual(pending.content, [
    { type: "file", receiptId: "r6" },
    { type: "text", text: "x" },
  ]);

  // ④ 顺序 = 附件顺序，`text` 永远在最后（官方 `[...attachments, text]`）
  const ordered = buildPromptContent("正文", [
    file("o1", "a.bin", { status: "ready", receiptId: "ra" }),
    image("o2", "shot.png", "data:image/png;base64,QUJD"),
    file("o3", "b.bin", { status: "ready", receiptId: "rb" }),
  ]);
  assert.deepStrictEqual(
    ordered.content.map((part) => part.type),
    ["file", "image", "file", "text"],
    "附件之间保持列表顺序，正文最后（官方同序）",
  );
  assert.deepStrictEqual(
    ordered.content[1],
    { type: "image", mediaType: "image/png", data: "QUJD", name: "shot.png" },
    "图片内容块由 data URL 拆出 mediaType 与 base64",
  );

  // ⑤ 图片没有可解析的 data URL → 进 `dropped`（不再静默跳过）
  const broken = buildPromptContent("x", [image("i1", "broken.png")]);
  assert.deepStrictEqual(broken.dropped, ["broken.png"], "表示不出来的附件要报出来（宿主记日志）");
  assert.deepStrictEqual(broken.content, [{ type: "text", text: "x" }]);
  assert.deepStrictEqual(buildPromptContent("   ", []).content, [], "什么都没有时 content 为空（不发这条消息）");

  // ⑥ 「真的进了块的那些」要与内容块**同序**：按下标借本地字节的消费方（adapter 的
  //    `userMedia`）拿它对齐，不过这一遍就会因为被过滤掉的附件而整体错位。
  //    这里刻意把「没就绪的文件」与「表示不出来的图片」夹在中间。
  const filtered = buildPromptContent("正文", [
    file("f1", "uploading.bin", { status: "uploading", loaded: 1 }),
    image("i2", "shot.png", "data:image/png;base64,QUJD"),
    image("i3", "broken.png"),
    file("f4", "ok.bin", { status: "ready", receiptId: "r4" }),
  ]);
  assert.deepStrictEqual(
    filtered.content.map((part) => part.type),
    ["image", "file", "text"],
    "前置：没就绪的文件与表示不出来的图片都不进 content",
  );
  assert.deepStrictEqual(
    filtered.included.map((entry) => entry.id),
    ["i2", "f4"],
    "included 只收真的出了块的那些，且顺序与 content 里的附件块逐一对应",
  );
  assert.deepStrictEqual(
    includedAttachments([
      file("f1", "uploading.bin", { status: "uploading", loaded: 1 }),
      image("i2", "shot.png", "data:image/png;base64,QUJD"),
      image("i3", "broken.png"),
      file("f4", "ok.bin", { status: "ready", receiptId: "r4" }),
    ]).map((entry) => entry.id),
    ["i2", "f4"],
    "includedAttachments 与 buildPromptContent 是同一个判据（过滤规则只有一处）",
  );
  console.log("attachments: 发送装配（无路径附件进 prompt / 未就绪有提示 / 官方顺序 / 进块附件同序）✓");
}

// ---------- 8. 三个入口一条决策：planIntake ----------
//
// 判据、上限、去重、拒绝全部收在纯函数里（**真调用**）：路径项与字节项只是同一条
// 规则的两种输入。这一段就是「两条平行通道合成一条」的行为防线。
{
  const dir = mkdtempSync(join(tmpdir(), "dsh-intake-"));
  try {
    const pngPath = join(dir, "a.png");
    const bigPath = join(dir, "big.png");
    const txtPath = join(dir, "a.ts");
    const subdir = join(dir, "src");
    mkdirSync(subdir, { recursive: true });
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(pngPath, pngBytes);
    writeFileSync(bigPath, new Uint8Array(9));
    writeFileSync(txtPath, "export {};\n");

    // ① 同一张图：路径项与字节项给出同一种内容块（同判据才谈得上同管线）
    const byPath = planIntake({
      items: [{ from: "path", path: pngPath, name: "a.png" }],
      acceptsImage: true,
    });
    const byBytes = planIntake({
      items: [{ from: "bytes", name: "a.png", bytes: pngBytes, mimeType: "image/png" }],
      acceptsImage: true,
    });
    assert.strictEqual(byPath.attachments[0].kind, "image");
    assert.strictEqual(byBytes.attachments[0].kind, "image");
    assert.strictEqual(
      byPath.attachments[0].dataUrl,
      byBytes.attachments[0].dataUrl,
      "两条通道对同一份 png 必须给出同一个 data URL",
    );
    assert.deepStrictEqual(byPath.uploads, [], "图片不进上传队列");
    assert.deepStrictEqual(byBytes.uploads, [], "字节来的图片也不进上传队列");

    // ② MIME 优先（官方 `isImageMediaType(file.type)`）：后缀认不出来也按图片走；
    //    表外的 `image/*`（官方同样不当图片）一律按普通文件上传
    const jfif = planIntake({
      items: [{ from: "bytes", name: "shot.jfif", bytes: pngBytes, mimeType: "image/jpeg" }],
      acceptsImage: true,
    });
    assert.strictEqual(jfif.attachments[0].kind, "image", "MIME 说了是图片就按图片走");
    assert.ok(jfif.attachments[0].dataUrl?.startsWith("data:image/jpeg;base64,"), "mediaType 用 MIME 本身");
    const bmp = planIntake({
      items: [{ from: "bytes", name: "a.bmp", bytes: pngBytes, mimeType: "image/bmp" }],
      acceptsImage: true,
    });
    assert.strictEqual(bmp.attachments[0].kind, "file", "表外的图片类型按普通文件上传（官方同口径）");
    assert.deepStrictEqual(
      bmp.uploads,
      [{ id: bmp.attachments[0].id, source: { kind: "bytes", bytes: pngBytes } }],
      "文件附件要带上上传来源（字节来源没有路径可读）",
    );

    // ③ 图片内联上限：**两条通道都**降级为文件上传（此前只有路径那条会判）
    const pathOver = planIntake({
      items: [{ from: "path", path: bigPath, name: "big.png" }],
      acceptsImage: true,
      maxImageBytes: 8,
      onError: () => {},
    });
    assert.strictEqual(pathOver.attachments[0].kind, "file", "路径来的超大图降级为上传");
    assert.deepStrictEqual(pathOver.degradedImages, ["big.png"], "降级要报出来（提示 @imageTooLarge）");
    assert.deepStrictEqual(
      pathOver.uploads,
      [{ id: pathOver.attachments[0].id, source: { kind: "path", path: bigPath } }],
    );
    const bytesOver = planIntake({
      items: [{ from: "bytes", name: "big.png", bytes: new Uint8Array(9), mimeType: "image/png" }],
      acceptsImage: true,
      maxImageBytes: 8,
      onError: () => {},
    });
    assert.strictEqual(bytesOver.attachments[0].kind, "file", "字节来的超大图同样降级（此前这里不判）");
    assert.deepStrictEqual(bytesOver.degradedImages, ["big.png"]);

    // ④ 模型不收图：字节通道只能上传（没有路径可插）；路径通道退回路径文本
    const noImageBytes = planIntake({
      items: [{ from: "bytes", name: "a.png", bytes: pngBytes, mimeType: "image/png" }],
      acceptsImage: false,
    });
    assert.strictEqual(noImageBytes.attachments[0].kind, "file", "模型不收图时字节通道按文件上传");
    const noImagePath = planIntake({
      items: [{ from: "path", path: pngPath, name: "a.png" }],
      acceptsImage: false,
    });
    assert.deepStrictEqual(noImagePath.attachments, [], "路径通道没有内容块可给");
    assert.deepStrictEqual(noImagePath.pathOnly, [pngPath], "退回把路径插到光标处（最后一道兜底）");
    assert.strictEqual(noImagePath.unsupportedImages, 1, "并计数以便提示");

    // ⑤ 目录 → **引用**（附件列表里不出现目录），同一路径只插一次
    const dirs = planIntake({
      items: [
        { from: "path", path: subdir, name: "src" },
        { from: "path", path: subdir, name: "src" },
        { from: "path", path: txtPath, name: "a.ts" },
      ],
      acceptsImage: true,
    });
    assert.deepStrictEqual(dirs.directories, [subdir], "目录进引用清单（重复粘贴只插一次）");
    assert.deepStrictEqual(
      dirs.attachments.map((attachment) => attachment.path),
      [txtPath],
      "附件列表里只有文件，没有目录芯片",
    );
    assert.strictEqual(dirs.attachments[0].kind, "file", "文本文件按文件上传（内容不做可读性判定）");

    // ⑥ 路径去重按**已有列表**判；字节项没有身份可比，不去重（官方也不去重）
    const dedup = planIntake({
      items: [
        { from: "path", path: txtPath, name: "a.ts" },
        { from: "bytes", name: "a.ts", bytes: pngBytes },
        { from: "bytes", name: "a.ts", bytes: pngBytes },
      ],
      acceptsImage: true,
      existingPaths: [txtPath],
    });
    assert.strictEqual(dedup.attachments.length, 2, "已在列表里的路径跳过；字节条目各自成一条");

    // ⑦ 0 字节条目（拖进来的目录就是这个形状）→ 拒绝，不是 0 字节假附件
    const empty = planIntake({
      items: [{ from: "bytes", name: "docs", bytes: new Uint8Array(0) }],
      acceptsImage: true,
    });
    assert.deepStrictEqual(empty.attachments, [], "0 字节条目不许变成假附件");
    assert.deepStrictEqual(empty.rejected, [{ name: "docs", reason: "unreadable" }], "要报出来让用户知道");

    // ⑧ 界面报来的拒绝项原样带出去（提示只由调用方那一处发）
    const carried = planIntake({
      items: [],
      acceptsImage: true,
      rejected: [
        { name: "huge.bin", reason: "too-large" },
        { name: "docs", reason: "unreadable" },
      ],
    });
    assert.deepStrictEqual(
      carried.rejected.map((item) => item.reason),
      ["too-large", "unreadable"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("attachments: planIntake（两通道同判据 / MIME 优先 / 上限与拒绝 / 目录进引用）✓");
}

console.log("\nattachments: all assertions passed");
