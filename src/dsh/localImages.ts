import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { localImageMediaType, localImagePath } from "../shared/imageRef";

/**
 * 正文里引用的**本地图片**：把模型写的路径读成 data URL。
 *
 * 为什么非得宿主来做：webview 读不了磁盘，`<img src="out/chart.png">` 在
 * `vscode-webview://` 下只会 404。这是「agent 生成的图表/截图看不见」的根因。
 *
 * **安全口径**——这些路径是**模型可控的字符串**，必须当外部输入看：
 * - 解析后的绝对路径必须落在**当前会话的工作目录内**。模型可以写任意路径，
 *   宿主顺着它读盘，等于把整个磁盘变成可读内容；如果模型同时被注入着写外链图片，
 *   那就是一条「读本地文件 → 编进 URL 外传」的完整链路（`docs/audit-summary.md`
 *   记的同一条外传面）。工作目录之外一律不读，界面退回原样的文本引用。
 * - 扩展名必须在图片表里（[`localImageMediaType`]：png/jpg/jpeg/webp/gif/**svg**），
 *   与附件准入那张表分开——那张表管"模型能不能读字节"，这张管"浏览器能不能画"；
 * - 有大小上限，且**先 `stat` 再读**——不先看大小就把一个大文件读进内存，
 *   一个 2 GB 的 `huge.png` 就能把扩展宿主拖垮。
 */

/** 单张本地图片的读取上限（字节）。超过就不读，界面显示「加载失败」。 */
export const LOCAL_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 一次请求最多读几张。
 *
 * 路径全由模型输出决定，一段正文里塞几百个引用是它一句话的事——不设上限就等于
 * 给了个「一次读满磁盘小块」的按钮。截断而不是报错：多出来的图不显示，
 * 正文其余部分照常。
 */
export const LOCAL_IMAGE_MAX_REFS = 24;

/**
 * 引用 → 可读的绝对路径（不合格就 undefined）。
 *
 * 只做判断，不碰磁盘：调用方拿着它去 `stat`/`readFile`，测试也就能纯函数地
 * 覆盖白名单本身。
 */
export function resolveLocalImagePath(cwd: string | undefined, src: string): string | undefined {
  if (!cwd) return undefined;
  const path = localImagePath(src);
  if (!path) return undefined;
  let absolute: string;
  try {
    absolute = resolve(cwd, path);
  } catch {
    return undefined;
  }
  const inside = relative(cwd, absolute);
  // 跨盘符时 `relative` 会回一个绝对路径（`C:\x`），与 `..` 一样算越界；
  // `inside === ""` 是 cwd 自己（目录），扩展名那关也会拦掉
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) return undefined;
  if (!localImageMediaType(absolute)) return undefined;
  return absolute;
}

/**
 * 读一批引用 → `{ 引用原文: data URL }`。
 *
 * 键是**引用原文**（界面拿它匹配 `<img src>`，不能改写过的路径）；读不到的直接
 * 不进表——界面那条图会落到「加载失败」，而不是一直等一个不会来的响应。
 */
export async function readLocalImages(
  cwd: string | undefined,
  refs: readonly string[],
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {};
  await Promise.all(
    refs.slice(0, LOCAL_IMAGE_MAX_REFS).map(async (ref) => {
      const absolute = resolveLocalImagePath(cwd, ref);
      if (!absolute) return;
      const url = await readOneImage(absolute);
      if (url) urls[ref] = url;
    }),
  );
  return urls;
}

async function readOneImage(absolute: string): Promise<string | undefined> {
  try {
    const info = await stat(absolute);
    if (!info.isFile() || info.size <= 0 || info.size > LOCAL_IMAGE_MAX_BYTES) return undefined;
    const bytes = await readFile(absolute);
    const mediaType = localImageMediaType(absolute) ?? "image/png";
    return `data:${mediaType};base64,${bytes.toString("base64")}`;
  } catch {
    return undefined;
  }
}
