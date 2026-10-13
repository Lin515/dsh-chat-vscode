import { ATTACH_BYTES_LIMIT, imageExtensionFor } from "./attachIntake";
import type { Locale } from "./texts";

/**
 * 粘贴图片的**会话内编号名**：中文 `图3.png`、英文 `image3.png`。
 *
 * ## 为什么需要它
 *
 * 剪贴板里的位图没有文件名：Chromium 一律给 `image.png`（见 `attachIntake.ts` 的
 * `namedClipboardEntry`）。这个名字**不是磁盘文件名**——图片按内容摘要
 * （`sha256:`）落进附件存储，同名的两张图本来就互不覆盖——但它会随图片块进会话
 * 日志、显示在附件芯片与消息图片上，并且出现在模型可见的身份文本里
 * （`Image "image.png" (sha256:…)`，见官方 `llm/content.ts` 的 `imageIdentity`）。
 * 于是连粘几张图时，人和模型都只能靠摘要前缀区分它们。
 *
 * 用户 2026-10-13 口径：**同一会话里给每张粘贴进来的图片一个递增编号**，
 * 这样可以直接说「看图3」。
 *
 * ## 编号规则
 *
 * - **只改图片条目**：非图片的真名有意义（`notes.md`、`report.pdf`），原样保留；
 * - **只改真的会发出去的条目**：0 字节（复制目录就是这个形态）与超上限的条目会被
 *   `attachFiles` 拒掉，提示里必须还是用户认得的原名；
 * - 从 1 开始、单调递增，**删掉附件不回收编号**——回收会让「图3」在同一个会话里
 *   先后指到两张不同的图；
 * - **后缀沿用条目自己的**（截图就是 `png`），不硬写成 `.png`：宿主判图看的是
 *   MIME 与后缀（`imageMediaTypeForEntry`），硬改后缀会让一张 jpeg 变成名不副实；
 * - 中文界面 `图N`、英文界面 `imageN`；中途切语言后编号接着往下走——恢复最大
 *   编号时**两种前缀都认**，否则切换语言就会撞号。
 *
 * ## 编号基线从哪来
 *
 * 剪贴板没有会话记忆，所以基线取**看得见的事实**里的最大值：已加载消息里的
 * 图片名、乐观回显里的、当前草稿芯片里的（`visibleImageNames`），再加本窗口这次
 * 会话**已经分配出去**的编号（一次连粘两张时第二张粘贴发生在草稿芯片回帧之前，
 * 只靠那三处会撞号，所以调用方要记住已分配的最大编号）。
 *
 * 已分配编号按会话保留：A → B → A 不回收 A 已删除芯片的编号；新会话从自己的
 * 基线开始。尚未绑定会话的空态编号在首次绑定时迁移，离开已绑定会话再进空态则归零。
 * 本窗口最多保留 256 个最近访问的已编号会话；淘汰或重载后仅由可见事实恢复，
 * 已删除且未出现在可见事实里的编号无法恢复。宿主列表有过滤，不按列表缺席清理。
 *
 * **已知边界**：同一会话开着两个窗口时，两端各自记「已分配编号」，并发粘贴的
 * 一瞬间可能各分到同一个号（草稿芯片是宿主广播给同会话所有窗口的，帧一到两端
 * 就重新对齐）。编号只是给人看的名字，撞号不影响图片本身。
 */

/** 编号名的主干：`图12` / `image12`（数字不含前导 0）。 */
const INDEXED_NAME = /^(?:图|image)([1-9]\d*)$/;

/**
 * 名字里的编号（`图12.png` / `image12.jpeg` → 12）。
 *
 * 只认「前缀 + 数字」这**整段**主干：Chromium 的原名 `image.png`（没有数字）、
 * `IMG_1234.png`、`图.png` 一律 `undefined`——它们不是我们编出来的名字，
 * 不该参与编号基线。
 */
export function pastedImageIndex(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const match = INDEXED_NAME.exec(base);
  return match ? Number(match[1]) : undefined;
}

/** 一批名字里最大的编号（一个都认不出 → 0）。 */
export function maxPastedImageIndex(names: Iterable<string | undefined>): number {
  let max = 0;
  for (const name of names) {
    const index = pastedImageIndex(name);
    if (index !== undefined && index > max) max = index;
  }
  return max;
}

/**
 * 本批粘贴的起始编号（从 1 起）。
 *
 * @param names - 看得见的图片名（历史消息 + 乐观回显 + 草稿芯片）。
 * @param remembered - 本窗口这个会话里已经分配出去的最大编号（没有 → 0）。
 */
export function nextPastedImageIndex(names: Iterable<string | undefined>, remembered = 0): number {
  return Math.max(remembered, maxPastedImageIndex(names)) + 1;
}

/** 本窗口保留的已编号会话数上限；未绑定空态另占一个标量。 */
export const PASTED_IMAGE_SESSION_LIMIT = 256;

/**
 * 会话编号器：同步分配先于附件异步读字节 / 草稿回帧，切会话不丢编号。
 * 只保存数字、不保存图片；最近访问顺序淘汰，窗口销毁后整份释放。
 */
export function createPastedImageSequence() {
  const assigned = new Map<string, number>();
  let sessionId: string | undefined;
  let unbound = 0;

  function remember(id: string, lastIndex: number): void {
    if (lastIndex <= 0) return;
    assigned.delete(id);
    assigned.set(id, lastIndex);
    if (assigned.size > PASTED_IMAGE_SESSION_LIMIT) assigned.delete(assigned.keys().next().value!);
  }

  function selectSession(next: string | undefined): void {
    if (next === sessionId) return;
    if (next === undefined) {
      // 已绑定会话 → 新空态：不能继承上一个会话的编号。
      unbound = 0;
    } else {
      // 空态 → 首次绑定：尚未回帧的粘贴也已占号，迁移后不能重用。
      const inherited = sessionId === undefined ? unbound : 0;
      remember(next, Math.max(assigned.get(next) ?? 0, inherited));
      unbound = 0;
    }
    sessionId = next;
  }

  function rename(input: {
    sessionId: string | undefined;
    names: Iterable<string | undefined>;
    files: readonly File[];
    locale: Locale;
  }): PastedImageNaming {
    selectSession(input.sessionId);
    const remembered = sessionId === undefined ? unbound : assigned.get(sessionId) ?? 0;
    const named = renamePastedImages({
      files: input.files,
      startIndex: nextPastedImageIndex(input.names, remembered),
      locale: input.locale,
    });
    if (sessionId === undefined) unbound = named.lastIndex;
    else remember(sessionId, named.lastIndex);
    return named;
  }

  return { selectSession, rename };
}

/** 第 `index` 张粘贴图片的文件名（`index` 从 1 起）。 */
export function pastedImageName(index: number, extension: string, locale: Locale): string {
  return `${locale === "zh" ? "图" : "image"}${index}.${extension}`;
}

/** 一批条目的编号结果。 */
export interface PastedImageNaming {
  /** 与输入同序：图片条目换了名字，其余是原对象。 */
  files: File[];
  /** 本批分配到的最大编号；一个图片条目都没有时等于 `startIndex - 1`。 */
  lastIndex: number;
}

/**
 * 给一批粘贴条目编上会话内编号。
 *
 * **只给这一批真的会发出去的条目编号**：`attachFiles` 会把 0 字节（复制目录就是
 * 这个形态）与超上限的条目拦下来，提示里报的是 `file.name`——那些名字必须还是
 * 用户认得出来的原名，否则「粘贴的 `photos.png` 读不出来」会变成
 * 「`图1.png` 读不出来」。
 *
 * @param input.files - `clipboardFiles` 之后的那一批（图片条目已经保证有后缀）。
 * @param input.startIndex - 本批第一个可用编号（`nextPastedImageIndex` 给）。
 * @param input.locale - 界面语言，决定 `图` / `image` 前缀。
 */
export function renamePastedImages(input: {
  files: readonly File[];
  startIndex: number;
  locale: Locale;
}): PastedImageNaming {
  const files: File[] = [];
  let index = input.startIndex;
  for (const file of input.files) {
    const sendable = file.size > 0 && file.size <= ATTACH_BYTES_LIMIT;
    const extension = sendable ? imageExtensionFor(file.type, file.name) : undefined;
    if (extension === undefined) {
      files.push(file);
      continue;
    }
    files.push(
      new File([file], pastedImageName(index, extension, input.locale), {
        type: file.type,
        lastModified: file.lastModified,
      }),
    );
    index += 1;
  }
  return { files, lastIndex: index - 1 };
}

/**
 * 这个窗口**已经看得见**的图片名：已加载的用户消息 + 乐观回显 + 当前草稿芯片。
 *
 * 图片降级为文件时仍保留编号名，因此编号主干 + 图片后缀的 `file` 也参与基线；
 * 普通文件（即使叫 `image99.txt`）不占号。仅凭名字无法区分用户自带的同名图片文件。
 * 只取用户消息（`role === "user"`）：助手消息与工具行里的图片不是用户贴的，
 * 它们的名字不该占用编号。形状用结构化类型而不是 import 视图类型——这份逻辑
 * 要在离线断言里直接喂对象。
 */
export function visibleImageNames(input: {
  messages: readonly { role: string; attachments?: readonly { kind: string; name: string }[] }[];
  pendingMessages: readonly { attachments: readonly { kind: string; name: string }[] }[];
  attachments: readonly { kind: string; name: string }[];
}): string[] {
  const names: string[] = [];
  const collect = (attachment: { kind: string; name: string }): void => {
    if (
      attachment.kind === "image" ||
      (attachment.kind === "file" &&
        pastedImageIndex(attachment.name) !== undefined &&
        imageExtensionFor(undefined, attachment.name) !== undefined)
    ) names.push(attachment.name);
  };
  for (const message of input.messages) {
    if (message.role !== "user") continue;
    for (const attachment of message.attachments ?? []) {
      collect(attachment);
    }
  }
  for (const pending of input.pendingMessages) {
    for (const attachment of pending.attachments) {
      collect(attachment);
    }
  }
  for (const attachment of input.attachments) {
    collect(attachment);
  }
  return names;
}
