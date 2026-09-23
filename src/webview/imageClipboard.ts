/**
 * 把界面里的图片写进**系统剪贴板**（图片右键菜单的「复制」）。
 *
 * 为什么在界面里做、而不是交给宿主：扩展宿主（Node）写不了富剪贴板——扩展 API 只有
 * `env.clipboard.writeText` 这一个**纯文本**入口，Electron 的 `clipboard` 模块在扩展
 * 宿主里拿不到（`dsh/clipboardPaths.ts` 用 PowerShell 也只是为了**读**文件拖放列表）。
 * 而 VS Code 给 webview 的 iframe 显式开了 `clipboard-write`
 * （`webview/browser/pre/index.html` 的 allow 列表），浏览器这边写图像是原生能力。
 *
 * 为什么必须先过 canvas：Chromium 的剪贴板写入**只认 `image/png`**（`ClipboardItem`
 * 里塞 `image/jpeg` 直接抛 `NotAllowedError`），所以任何格式都先画到画布上转 PNG。
 *
 * 代价说清楚：**跨域外链图复制不了**——没带 CORS 的图会污染画布，转 PNG 拿不到
 * 结果。系统菜单里那条「复制图片」是浏览器内部实现的，页面脚本没有这个能力；
 * 这里如实失败（界面提示一句），而不是悄悄复制成别的东西。
 */

/**
 * 画布边长上限。
 *
 * 浏览器对画布尺寸有硬上限（Chromium 单边约 16384），超了只会得到一个空结果。
 * 超过时按比例缩到上限之内——复制的是**图**，不是原始像素。
 */
const MAX_CANVAS_SIDE = 8192;

/** 复制一张已经画在界面上的图；成功 `true`，失败 `false`（由调用方提示）。 */
export async function copyImageElement(image: HTMLImageElement): Promise<boolean> {
  try {
    await decodeImage(image);
    const blob = await toPngBlob(image);
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    // 剪贴板被别的程序占住、浏览器不给写权限、`ClipboardItem` 不存在……都落这里
    return false;
  }
}

/**
 * 等图片解码完再画。
 *
 * 原图浮层是**点开时新建的 `<img>`**：点开之后立刻右键「复制」时它可能还在加载，
 * 这时 `drawImage` 画的是一张空图（甚至直接抛）。`decode()` 让这一下等它加载完；
 * 图本身是坏的（解码失败）就交给 `toPngBlob` 按「没自然尺寸」判失败。
 */
async function decodeImage(image: HTMLImageElement): Promise<void> {
  if (image.complete) return;
  try {
    await image.decode();
  } catch {
    // 坏图：下面的自然尺寸判定会给出 false
  }
}

/** 把 `<img>` 画到画布上并转成 PNG（图没画完 / 画布被污染 / 转不出来时 null）。 */
function toPngBlob(image: HTMLImageElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    // 还没解码完的图（原图浮层刚打开那一下）画不出来：如实失败，别写一张空白图
    if (!image.complete || !width || !height) {
      resolve(null);
      return;
    }
    const scale = Math.min(1, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      resolve(null);
      return;
    }
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      // 跨域图污染画布：`drawImage` / `toBlob` 都可能在这里抛
      resolve(null);
    }
  });
}
