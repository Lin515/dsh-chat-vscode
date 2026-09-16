import { post } from "./bridge";

/**
 * 拖放添加附件 —— 全页共享的接取逻辑（原在 `Composer.tsx` 的 onDrop 里，只接输入框；
 * 现在迁出来给 App 的全页监听用：消息区、面板……任何位置松手都是「添加附件」，
 * 而不是让 VS Code 把文件在编辑器里打开）。
 *
 * **只能拿字节**：VS Code 不把拖拽的资源注入 webview 的 DataTransfer
 * （没有 `ResourceURLs`、没有 `text/uri-list`），而 `File.path` 自 Electron 32
 * 起已被移除，webview 侧的 `window.vscode` 也只有 `acquireVsCodeApi`、拿不到
 * `webUtils.getPathForFile`——所以路径这条路根本不存在，字节是唯一通道
 * （见 `shared/ipc.ts` 的 `attachBytes`）。
 *
 * **Shift 门（平台行为，代码绕不开）**：webview 是 iframe，workbench 在**主窗口
 * DOM** 上盯着 drag/dragover——没按 Shift 就给 webview iframe 挂
 * `pointer-events: none`（`workbench.desktop.main.js` 的 `windowDidDragStart`），
 * 事件根本到不了界面，松手后 VS Code 把文件在编辑器里打开。监听在主窗口上，
 * 所以**从系统资源管理器拖也一样**：只要 dragover 扫过任何 workbench 界面
 * （标题栏 / 活动栏 / 视图头 / 甚至被阻塞的 iframe 本身），阻塞就激活并持续到
 * dragend。按住 Shift 是唯一的放行手势（`qse` 里 `n.shiftKey ? 放行 : 阻塞`，
 * VS Code 1.138 逐字核对过，没有按 webview 配置的豁免开关）。
 */

/**
 * 拖放的字节上限，与宿主 `attachments.ts` 的 `DROP_BYTES_LIMIT` 同值。
 *
 * 界面侧先按它拦一道：超限的**根本不读**（读了再 base64 是白烧内存），
 * 只把名字报给宿主去提示。两处常量必须一致——不一致时界面要么白读，
 * 要么把宿主会拒的东西发过去。
 */
export const DROP_BYTES_LIMIT = 8 * 1024 * 1024;

/** 一份 `File` 的字节 → base64（`postMessage` 两端的序列化都吃不掉字符串）。 */
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

/**
 * 把一次拖放进来的文件读成字节并交给宿主（`attachBytes`）。
 *
 * 目录拖进来就是一个读不出字节的 `File`（`arrayBuffer` 抛 IO 错误）→ 进
 * `unreadable`，由宿主提示；超限的只报名字（`tooLarge`）。
 */
export function attachDroppedFiles(files: File[]): void {
  if (!files.length) return;
  const accepted = files.filter((file) => file.size <= DROP_BYTES_LIMIT);
  const tooLarge = files.filter((file) => file.size > DROP_BYTES_LIMIT).map((f) => f.name);
  void (async () => {
    const payload: { name: string; base64: string }[] = [];
    const unreadable: string[] = [];
    for (const file of accepted) {
      try {
        payload.push({ name: file.name, base64: await fileToBase64(file) });
      } catch {
        unreadable.push(file.name);
      }
    }
    if (!payload.length && !unreadable.length && !tooLarge.length) return;
    post({ type: "attachBytes", files: payload, unreadable, tooLarge });
  })();
}
