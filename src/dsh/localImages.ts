/**
 * 正文里引用的**执行世界图片**：经 DSH 的认证读取通道换成 data URL。
 *
 * 路径是模型可控的外部输入，但它属于 DSH 执行世界，不是扩展宿主本机：
 * - 相对路径原样交给 `workspaceFiles.stat`，由 Host 用会话创建目录解析；缺创建
 *   目录也不回退 VS Code 工作区，不猜本机基准。
 * - 绝对路径不重新拼目录；根外能否读取由 provider 的访问策略裁决，**创建目录
 *   不是媒体白名单**，扩展名也不是授权条件。
 * - 客户端只拒绝 UNC、控制字符与盘符相对这类无法安全/无歧义表达的媒体路径；
 *   字节限额由 Host 的 `/api/file` 部署限额裁决，客户端**不另造图片字节门**。
 *
 * 张数也不截断：一段正文里几百个引用时，全部都要尝试，只把并发压在一个有界
 * 窗口里——截断会让第 25 张永久看不见，而这从来不是读取权限问题。
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
 * 同时进行中的图片读取数。
 *
 * 路径全由模型输出决定，几百个引用不该同时打满 Host，也不该因噎废食丢掉后面的
 * 图片：这是**并发窗口**，不是条目上限。
 */
export const LOCAL_IMAGE_CONCURRENCY = 8;

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

/** 读一张引用；失败写进 `failures`，不抛（一批里一张失败不影响其余）。 */
async function readOne(
  access: HostFileAccess,
  sessionId: string,
  ref: string,
  urls: Record<string, string>,
  failures: Record<string, string>,
): Promise<void> {
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
    // 字节预算交给 Host 的媒体路由：这里不按 stat.bytes 预拒绝，也不传客户端
    // maxBytes —— 那等于把本地常量冒充部署限额。
    const file = await access.readBytesAt(stat, path);
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
}

/**
 * 读一批引用 → data URL 表。
 *
 * 键保持**引用原文**（界面拿它匹配 `<img src>`，不能改写过的路径）。全部引用
 * 都会处理，只限制同时进行的条数。
 */
export async function readHostImages(
  access: HostFileAccess,
  sessionId: string,
  refs: readonly string[],
): Promise<HostImageResult> {
  const urls: Record<string, string> = {};
  const failures: Record<string, string> = {};
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const ref = refs[index];
      if (ref === undefined) return;
      await readOne(access, sessionId, ref, urls, failures);
    }
  };
  const workers = Math.min(LOCAL_IMAGE_CONCURRENCY, refs.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { urls, failures };
}
