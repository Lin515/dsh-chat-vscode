/**
 * 正文里引用的**执行世界图片**：经 DSH 的认证读取通道换成 data URL。
 *
 * 路径是模型可控的外部输入，但它属于 DSH 执行世界，不是扩展宿主本机：
 * - 相对路径原样交给 `workspaceFiles.stat`，由 Host 用会话创建目录解析；缺创建
 *   目录也不回退 VS Code 工作区，不猜本机基准。
 * - 绝对路径不重新拼目录；根外能否读取由 provider 的访问策略裁决，**创建目录
 *   不是媒体白名单**，扩展名也不是授权条件。
 * - 客户端只拒绝 UNC、控制字符与盘符相对这类无法安全/无歧义表达的媒体路径；
 *   字节限额由 Host 的部署限额裁决。`LOCAL_IMAGE_MAX_BYTES` 只是本客户端的 IPC
 *   传输预算，不是官方读取权限。
 *
 * 读取失败按引用原文记一条失败原因（诊断日志用），不进 data URL 表；界面那条图
 * 落到既有「加载失败」降级。回帧之前浏览器那次失败仍由 webview 的
 * `hydrateLocalImages` 处理（不在本模块）。
 */

import { localImageMediaType, localImagePath } from "../shared/imageRef";
import {
  HostFileError,
  describeHostFileError,
  unsupportedMediaPath,
  type HostFileAccess,
} from "./remoteFiles";

/**
 * 一次请求最多读几张：一段正文塞几百个引用是模型一句话的事，不设上限等于给一个
 * 「一次读满执行世界小块」的按钮。截断而不是报错，正文其余部分照常。
 */
export const LOCAL_IMAGE_MAX_REFS = 24;

/**
 * 单张图片的客户端传输预算（字节）。
 *
 * **不是** provider 的读权限，也不代表官方限额：官方 `/api/file` 的限额由部署配置
 * 决定（可能大于或小于此值）。这里只防止一次 IPC 搬回一个过大的字符串。
 */
export const LOCAL_IMAGE_MAX_BYTES = 16 * 1024 * 1024;

/** 一批引用的解析结果：成功表 + 失败原因表（键都是引用原文）。 */
export interface HostImageResult {
  /** 引用原文 → data URL。读不到的不进这张表。 */
  readonly urls: Record<string, string>;
  /** 引用原文 → 失败原因（只进日志，不改写正文）。 */
  readonly failures: Record<string, string>;
}

/** Host 给出的媒体类型优先；它不认时只按扩展名补一个「浏览器能画」的类型。 */
function displayMediaType(path: string, reported: string | undefined): string | undefined {
  if (reported && reported.startsWith("image/")) return reported;
  return localImageMediaType(path);
}

function toDataUrl(bytes: Uint8Array, mediaType: string): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * 读一批引用 → data URL 表。
 *
 * 键保持**引用原文**（界面拿它匹配 `<img src>`，不能改写过的路径）。
 */
export async function readHostImages(
  access: HostFileAccess,
  sessionId: string,
  refs: readonly string[],
): Promise<HostImageResult> {
  const urls: Record<string, string> = {};
  const failures: Record<string, string> = {};
  await Promise.all(
    refs.slice(0, LOCAL_IMAGE_MAX_REFS).map(async (ref) => {
      const path = localImagePath(ref);
      if (!path) {
        failures[ref] = "unsupported reference";
        return;
      }
      const unsupported = unsupportedMediaPath(path);
      if (unsupported) {
        failures[ref] = unsupported;
        return;
      }
      try {
        const stat = await access.stat(sessionId, path);
        if (stat.bytes !== undefined && stat.bytes > LOCAL_IMAGE_MAX_BYTES) {
          failures[ref] = `over the client transfer budget (${stat.bytes} bytes)`;
          return;
        }
        const file = await access.readBytesAt(stat, path, { maxBytes: LOCAL_IMAGE_MAX_BYTES });
        if (file.data.byteLength === 0) {
          failures[ref] = "empty file";
          return;
        }
        const mediaType = displayMediaType(path, file.mediaType);
        if (!mediaType) {
          failures[ref] = "no image media type";
          return;
        }
        urls[ref] = toDataUrl(file.data, mediaType);
      } catch (error) {
        failures[ref] = error instanceof HostFileError ? error.reason : describeHostFileError(error);
      }
    }),
  );
  return { urls, failures };
}
