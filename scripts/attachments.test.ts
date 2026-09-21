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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACH_BYTES_LIMIT,
  classifyDroppedBytes,
  classifyPath,
  imageMediaTypeFor,
  isDirectoryPath,
  isImagePath,
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
    files: { name: string; base64: string }[];
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
    "字节要原样 base64 过线（宿主据此判图片 / 上传）",
  );
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

// ---------- 6. 宿主侧分源措辞 + 粘贴优先走真路径 ----------
//
// `scripts/i18n.test.ts` 只保证「登记过的标记有字面量发射点」，但**分派对不对**
// （source === "paste" 时用的是哪一条）它看不到。这里把那段三元表达式钉住：
// 粘贴来的东西被拒时不许说「拖放上限」——用户手上根本没有那个可拖的文件。
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
  // 剪贴板取；取到就按**路径的类别**分流（用户当天两次口径合起来）：
  // **目录 → `@dir/` 引用**（写进正文的路径，不是附件——用户第二次明确「粘贴文件夹
  // 不该变成附件」）、**文件 → 附件通道**（图片内容块 / 其余不限大小地上传）。
  // 取不到路径才退回字节通道。顺序**不可反**：先走字节通道的话目录又变 0 字节附件、
  // 大文件又被 8 MB 挡掉。
  assert.ok(
    /if \(message\.source === "paste"\) \{\s*\n\s*const paths = await readClipboardPaths\(\);/.test(controller),
    "粘贴必须先在宿主侧取剪贴板真路径，再谈字节通道",
  );
  assert.ok(
    /for \(const path of paths\) \(isDirectoryPath\(path\) \? directories : files\)\.push\(path\)/.test(
      controller,
    ),
    "取到的路径要按「是不是目录」一次分流（stat 一次）",
  );
  assert.ok(
    /this\.insertMention\(viewId, formatFileMention\(this\.relativePath\(directory\), "directory"\)\)/.test(
      controller,
    ),
    "目录必须是 `@dir/` 引用（写进正文），不许再落成附件芯片",
  );
  assert.ok(
    /if \(files\.length\) await this\.addPaths\(viewId, files\)/.test(controller),
    "文件走附件通道（与回形针同一条：图片内容块 / 其余上传，不限大小）",
  );
  assert.ok(
    /readClipboardPaths\(\)[\s\S]{0,900}?applyBytesForView/.test(controller),
    "两条路的先后顺序：readClipboardPaths →（有路径就分流并结束）→ applyBytesForView",
  );
  console.log("attachments: 宿主按 source 分「拖放 / 粘贴」两套提示、粘贴按类别分流真路径 ✓");
}

console.log("\nattachments: all assertions passed");
