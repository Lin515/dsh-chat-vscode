/**
 * 正文里图片引用的分类：远程 / 内联 / 本地路径。
 *
 * 模型写出来的 `![图表](out/chart.png)` 在 webview 里是**加载不了**的：
 * `<img src="out/chart.png">` 会按 `vscode-webview://…` 去解析，只会 404。
 * 这类引用要由宿主读成 data URL（见 `dsh/localImages.ts`），而
 * 「哪些引用该交给宿主」这条判断 webview 与宿主都要用，所以放在 shared。
 *
 * 纯字符串逻辑（不碰 `node:path`、不碰 DOM）：webview 是浏览器环境，宿主是 Node。
 */

/** 按 RFC 3986 的 scheme 形状：`https:` / `data:` / `file:` / `vscode-webview:` … */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Windows 盘符（`C:` / `D:\` / `c:/x`）。
 *
 * **必须先于 scheme 判断**：`C:/shots/a.png` 完全符合 scheme 的形状，
 * 按 scheme 判就会被当成「有协议的远程引用」直接交给浏览器——而那在 webview 里
 * 永远加载不出来（这正是本次要修的那件事）。单字母 scheme 在现实中不存在图片，
 * 盘符才是真会遇到的输入。
 */
const DRIVE = /^[a-z]:/i;

/**
 * 这个引用是不是「不用宿主操心」的（远程或内联）。
 *
 * **按肯定证据判断**：只有明确带非 `file:` 的 scheme 才算远程；没 scheme 的
 * （`./a.png`、`out/a.png`、`C:/x/a.png`）一律当本地候选。反过来写（"不像本地"
 * 才交给宿主）会把 `C:\…` 这类路径漏给浏览器，等于永远加载不出来。
 */
export function isRemoteImageRef(src: string): boolean {
  const value = src.trim();
  if (!value) return true;
  if (DRIVE.test(value)) return false;
  if (!SCHEME.test(value)) return false;
  return !/^file:/i.test(value);
}

/**
 * 本地引用 → 路径文本。
 *
 * 处理三件事（都是实测会遇到的形状）：
 * - `file:` 外壳：`file:///C:/shots/a.png` → `C:/shots/a.png`（`file://host/share/x`
 *   的 host 丢掉——本扩展只认本机路径）；
 * - **百分号转义**：markdown 渲染器会把空格等字符编码，`my%20chart.png` 要还原；
 * - 查询串/锚点：`a.png?raw=1#top` 只取 `a.png`。
 *
 * 还原不了（转义序列畸形）就返回 undefined：宁可这张图不显示，也不要拿半个路径去读盘。
 */
export function localImagePath(src: string): string | undefined {
  let value = src.trim();
  if (!value) return undefined;
  if (/^file:/i.test(value)) {
    value = value.slice("file:".length);
    // `file:///C:/x` / `file:////tmp/x`：去掉 `//` 之后的位置，再把多重斜杠收成一个
    value = value.replace(/^\/\//, "").replace(/^\/+/, "/");
    // `file:///C:/x` 去过斜杠之后是 `/C:/x`：盘符前那条斜杠要去掉
    if (/^\/[a-z]:/i.test(value)) value = value.slice(1);
  } else if (SCHEME.test(value) && !DRIVE.test(value)) {
    return undefined;
  }
  value = value.split(/[?#]/)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  return value.trim() || undefined;
}

/**
 * 本地图片的扩展名表（**含 `svg`**）。
 *
 * 与服务端附件那条路的 `imageMediaTypeFor`（png/jpg/jpeg/webp/gif）**故意不同**：
 * 那张表管的是「模型能不能读这张图的字节」，svg 不在其中；这张表管的是「浏览器能
 * 不能把它画出来」——agent 生成的插画常见就是 `.svg`（实测那次就是），画不出来才怪。
 * `<img>` 里的 SVG **不执行脚本**（img 上下文不允许脚本与外部引用），所以放进来
 * 不引入 XSS 面。
 */
const LOCAL_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * 路径的图片媒体类型；不认识的扩展名返回 undefined。
 *
 * 大小写不敏感（`IMG.PNG` 也是图片），查询串/锚点不算扩展名的一部分。
 */
export function localImageMediaType(path: string): string | undefined {
  const match = /\.([a-z0-9]+)$/i.exec(path.split(/[?#]/)[0]);
  return match ? LOCAL_IMAGE_TYPES[match[1].toLowerCase()] : undefined;
}
