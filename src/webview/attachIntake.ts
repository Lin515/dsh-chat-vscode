import { post } from "./bridge";

/**
 * 附件接取（拖放 + 剪贴板粘贴）—— 全页共享的**字节**通道。
 *
 * 两条入口，一个落点：都读成字节后发 `attachBytes`（见 `shared/ipc.ts`），
 * 宿主再按「文件名 + 模型收不收图」归类（`dsh/attachments.ts` 的 `classifyDroppedBytes`）。
 * 名字里带 `source` 只为**提示文案**分口径（「拖放上限 8 MB」/「粘贴上限 8 MB」）。
 *
 * ## 为什么只能拿字节
 *
 * VS Code 不把拖拽的资源注入 webview 的 DataTransfer（没有 `ResourceURLs`、没有
 * `text/uri-list`），而 `File.path` 自 Electron 32 起已被移除，webview 侧的
 * `window.vscode` 也只有 `acquireVsCodeApi`、拿不到 `webUtils.getPathForFile`
 * ——所以路径这条路根本不存在，字节是唯一通道。
 *
 * ## 拖放：Shift 门（平台行为，代码绕不开）
 *
 * webview 是 iframe，workbench 在**主窗口 DOM** 上盯着 drag/dragover——没按 Shift 就给
 * webview iframe 挂 `pointer-events: none`（`workbench.desktop.main.js` 的
 * `windowDidDragStart`），事件根本到不了界面，松手后 VS Code 把文件在编辑器里打开。
 * 监听在主窗口上，所以**从系统资源管理器拖也一样**：只要 dragover 扫过任何 workbench
 * 界面（标题栏 / 活动栏 / 视图头 / 甚至被阻塞的 iframe 本身），阻塞就激活并持续到 dragend。
 * 按住 Shift 是唯一的放行手势（`qse` 里 `n.shiftKey ? 放行 : 阻塞`，VS Code 1.138 逐字
 * 核对过，没有按 webview 配置的豁免开关）。
 *
 * ## 粘贴：Ctrl+V 被 VS Code 接管，但 **paste 事件照样会来**
 *
 * 这条链路 2026-09-21 逐行读过本机安装的 VS Code（`resources/app/out`），记下来免得
 * 下次再怀疑「webview 根本收不到粘贴」：
 *
 * 1. `webview/browser/pre/index.html` 的 `handleInnerKeydown`：**Electron 桌面版对
 *    Ctrl+C/V/X（含 Shift+Insert）一律 `preventDefault()`** ——「等浏览器自己发原生
 *    paste」这条路在本平台不成立（浏览器版走 `return`，交给浏览器）；
 * 2. 它把这次按键当 `did-keydown` 交给宿主，宿主 `WebviewElement.handleKeyEvent` 把
 *    按键**重新派发到主窗口**（`target` 被定义成 webview 元素），于是走到 VS Code 的
 *    键位解析 → `WebviewElement.paste()` → `this._send("execCommand", "paste")`；
 * 3. webview 的 pre 脚本收到 `execCommand` 后对**内容文档**执行
 *    `contentDocument.execCommand("paste")`。iframe 上的
 *    `allow="clipboard-read; clipboard-write"`（同一份 index.html 里设置）正是这条
 *    `execCommand` 需要的权限——于是 webview 文档里**真的触发一次 paste 事件**，
 *    `clipboardData` 带着系统剪贴板里的图片 / 文件。
 *
 * 所以粘贴的接取点与拖放一样是「window 上的那一个事件」，只是事件名不同；**不要**
 * 另外去挂 keydown 抢 Ctrl+V（那会在宿主之前吃掉按键，反而让 VS Code 不再补发
 * `execCommand`）。
 *
 * 剪贴板里的**目录**读不出字节（`arrayBuffer` 抛 IO 错误）→ 归到 `unreadable` 由宿主提示。
 */

/**
 * 字节通道的上限（拖放 / 粘贴共用），与宿主 `dsh/attachments.ts` 的
 * `ATTACH_BYTES_LIMIT` 同值。
 *
 * 界面侧先按它拦一道：超限的**根本不读**（读了再 base64 是白烧内存），
 * 只把名字报给宿主去提示。两处常量必须一致——不一致时界面要么白读，
 * 要么把宿主会拒的东西发过去。
 *
 * 这条限制**只关于 webview 这条通道**（base64 过线要 4/3 膨胀 + 一次字符串拷贝），
 * 不是「附件判据」：回形针 / 资源管理器右键那条路不限大小（官方也不限）。
 */
export const ATTACH_BYTES_LIMIT = 8 * 1024 * 1024;

/** 这一批附件是从哪条路进来的（只影响宿主给的提示文案）。 */
export type AttachSource = "drop" | "paste";

/** 一份 `File` 的字节 → base64（`postMessage` 两端的序列化都吃不掉 `Uint8Array`）。 */
export function fileToBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    // 分块拼接：一次 apply 传十万级参数会栈溢出
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  });
}

/**
 * 这次拖拽带不带文件。
 *
 * 只认 `dataTransfer.types` 里的 `"Files"`：纯文本 / uri 的拖拽（比如按住 Shift
 * 从编辑器拖一段代码进输入框）必须放行给原生行为（textarea 自己插入文本），
 * 不能 preventDefault 劫持。
 */
export function dragHasFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

/** 剪贴板图片的类型 → 文件名后缀（拿不到名字时用它拼一个可识别的名字）。 */
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

/**
 * 给剪贴板里**明确是图片**的条目补一个带后缀的名字。
 *
 * 为什么必须有后缀：宿主的归类判据是 `imageMediaTypeFor(name)`——**只看文件名后缀**
 * （见 `dsh/attachments.ts`）。Chromium 给截图起的名字一般是 `image.png`（已经可用），
 * 但空名字 / 无后缀（`image`）会让它退化成「普通文件上传」。
 *
 * **只有 MIME 说了是图片才补**，这是 2026-09-21 修的 bug：上一版写成
 * `IMAGE_EXTENSIONS[mime] ?? "png"`，于是从资源管理器复制的**任何**无后缀条目都被
 * 改名叫 `*.png`——实测复制 `LICENSE` 得到 `LICENSE.png`、复制 `docs` 目录得到
 * `docs.png`，用户看到的就是「粘贴什么都成了 png」。非图片条目（`type` 为空的普通
 * 文件、目录、二进制）一律**保留原名**，让宿主按文件名与内容自己归类。
 */
function namedClipboardEntry(file: File, mime: string): File {
  if (/\.[a-z0-9]+$/i.test(file.name)) return file;
  const extension = IMAGE_EXTENSIONS[mime];
  if (!extension) {
    // 不是图片：名字原样用；连名字都没有时才给一个中性名（不编造类型）
    return file.name ? file : new File([file], "pasted-file", { type: file.type });
  }
  const base = file.name || "pasted-image";
  return new File([file], `${base}.${extension}`, { type: file.type || mime });
}

/**
 * 这次粘贴带不带文件 / 图片。
 *
 * 判据分两层，缺一不可（两处都是实测里真出现过的形态）：
 * - `dataTransfer.files`：**资源管理器里复制文件**后粘贴走这条（Chromium 把 CF_HDROP
 *   映射成 File 列表），浏览器里复制图片也常常一并给出；
 * - `dataTransfer.items` 里 `kind === "file"` 的条目：只给 items 不给 files 的场合
 *   （截图工具 / 部分应用的图片剪贴板格式）走这条，名字可能为空。
 *
 * **纯文本一律返回空数组**：调用方据此放行原生插入（textarea 自己粘贴文本）。
 * 文本与图片同时存在时按「有文件就算附件」处理——与官方 dsh web 端一致
 * （`intakeFiles`），也比「粘进去一串图片 URL 文本」有用。
 *
 * **这里拿不到路径**（2026-09-21 实测，复制目录与复制文件各一遍）：粘贴的
 * `types` 只有 `["Files"]`，`text/uri-list` 与 `text/plain` **都是空串**，
 * `File.name` 只有 basename。所以「目录 → 路径引用、大文件 → 与添加附件同样不限
 * 大小」只能由宿主去系统剪贴板取真路径（`dsh/clipboardPaths.ts`）；这里给出的字节
 * 是**兜底**（截图这类剪贴板里本来就没有文件的形态）。
 */
export function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const listed = Array.from(data.files ?? []);
  if (listed.length) {
    return listed.map((file) => namedClipboardEntry(file, file.type));
  }
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) files.push(namedClipboardEntry(file, item.type || file.type));
  }
  return files;
}

/**
 * 把一批 `File` 读成字节并交给宿主（`attachBytes`）。
 *
 * **0 字节的条目一律不读，直接报 `unreadable`**：复制**目录**时 Chromium 给的就是
 * 一个 `size = 0`、`type = ""`、名字为目录名的 File（实测：`arrayBuffer()` 抛
 * 「A requested file or directory could not be found at the time an operation was
 * processed.」）。上一版把它当普通文件读，于是界面上多出一个 0 字节的假附件。
 * 真正的 0 字节文件也没有内容可发——同样报出来让用户知道。
 *
 * 目录在宿主侧另有更好的归宿：粘贴时宿主先从系统剪贴板取**真路径**，目录走 `@dir/`
 * **引用**（写进正文的路径，不是附件）、文件走附件通道。这里是那条路失败时的兜底。
 *
 * 超限的只报名字（`tooLarge`）。
 */
export function attachFiles(files: File[], source: AttachSource): void {
  if (!files.length) return;
  const accepted = files.filter((file) => file.size <= ATTACH_BYTES_LIMIT);
  const tooLarge = files.filter((file) => file.size > ATTACH_BYTES_LIMIT).map((f) => f.name);
  void (async () => {
    const payload: { name: string; base64: string }[] = [];
    const unreadable: string[] = [];
    for (const file of accepted) {
      if (file.size === 0) {
        unreadable.push(file.name);
        continue;
      }
      try {
        payload.push({ name: file.name, base64: await fileToBase64(file) });
      } catch {
        unreadable.push(file.name);
      }
    }
    if (!payload.length && !unreadable.length && !tooLarge.length) return;
    post({ type: "attachBytes", source, files: payload, unreadable, tooLarge });
  })();
}

/** 拖放进来的文件。 */
export function attachDroppedFiles(files: File[]): void {
  attachFiles(files, "drop");
}

/** 粘贴进来的文件 / 图片。 */
export function attachPastedFiles(files: File[]): void {
  attachFiles(files, "paste");
}
