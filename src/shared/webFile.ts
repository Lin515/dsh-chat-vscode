/**
 * 本地 web 文件：**可以交给系统浏览器直接打开、不需要先起 web 服务**的那几类。
 *
 * 界面与宿主共用同一份白名单（这里只做纯字符串判断，不碰文件系统）：
 *
 * - 界面用它决定悬停是否补一句「按住 Ctrl/Cmd 单击在浏览器中打开」，
 *   以及按住修饰键的那一下该发哪条帧；
 * - 宿主用它**再验一次**。webview 发来的帧不该被当成可信输入：放宽这里等于
 *   允许把任意本地文件交给系统默认程序，`.exe` / `.bat` 会被直接执行。
 *
 * 只认 HTML 家族（`.html` / `.htm` / `.xhtml` / `.shtml`）。`.svg` 归图片、
 * `.mht` / `.mhtml` 是归档格式，都不在这里替系统决定怎么打开。
 */

const BROWSER_OPENABLE_EXTENSIONS = new Set([".html", ".htm", ".xhtml", ".shtml"]);

/**
 * 这个路径是不是可以用系统浏览器直接打开的本地 web 文件。
 *
 * 只看最后一段的扩展名，大小写不敏感；查询串与片段先剥掉（调用方一般已经
 * 交给 `parseFileLink` 处理过，这里兜住直接拿原始路径来问的情况）。
 *
 * @param path 本地路径（相对或绝对均可，扩展名与目录无关）。
 */
export function isBrowserOpenableFile(path: string): boolean {
  const clean = path.split(/[?#]/u, 1)[0] ?? "";
  const match = /\.([^./\\]+)$/u.exec(clean);
  return match !== null && BROWSER_OPENABLE_EXTENSIONS.has(`.${match[1]?.toLowerCase() ?? ""}`);
}
