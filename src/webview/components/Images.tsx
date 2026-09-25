import { useEffect, useState } from "react";
import { IconClose } from "../icons";
import { failedImageText, resolveLocalImages } from "../localImages";
import { useTexts } from "../texts";

/**
 * 会话里的图片：用户发出的、模型给的、工具回带的、正文里引用的。
 *
 * 三处合成**一套**呈现，而不是各画一个 `<img>`：缩略图尺寸、点击放大、加载失败
 * 降级这三件待遇必须完全一致（`docs/AGENTS.md` 的「同语义元素待遇一致性」）。
 * 此前用户消息里的图只显示一个文件名芯片，工具行与助手消息各画一遍 `<img>`。
 *
 * `src` 可能是三种东西，组件不区分（浏览器也不该区分）：
 * - `data:` URL——服务端 durable 附件（`session/attachment` 换回来的字节）；
 * - `https:` URL——模型写在 markdown 里的外链（渲染时已加 `no-referrer`）；
 * - `data:` URL——宿主按会话工作目录读回来的本地文件图（见 `dsh/localImages.ts`）。
 */

export interface ImageSource {
  src: string;
  /** 无障碍文本；缺省用调用方给的通用文案。 */
  alt?: string;
  /**
   * 这张图对应的**引用**（磁盘路径 / 正文里的原文）。
   *
   * 只有调用方知道才给：服务端附件与工具回带的图是 `data:` URL，没有路径可缀；
   * 本地文件图（`LocalImageGallery`）给得出来。加载失败时它缀在降级文案后面。
   */
  ref?: string;
  /** 固有宽高：字节到达前按它占位，免得图加载完把消息顶一下。 */
  width?: number;
  height?: number;
}

/** 缩略图图库。空 `src`（字节还没回来）不占位——先闪一个碎图图标更难看。 */
export function ImageGallery({ sources, alt }: { sources: ImageSource[]; alt: string }) {
  const texts = useTexts();
  const [failed, setFailed] = useState<Record<number, true>>({});
  const [loaded, setLoaded] = useState<Record<number, true>>({});
  const shown = sources.filter((source) => source.src);
  if (!shown.length) return null;
  return (
    <div className="row-body-images">
      {shown.map((source, index) =>
        failed[index] ? (
          // 外链被 CSP 拦掉、本地文件被删、字节取不回来……都落到这里。
          // 不显示碎图图标，也不静默：说一句「加载失败」比一个灰框有用；
          // 知道是哪一张（`ref`）就把引用一起说出来。
          <span className="image-failed" key={index} title={source.ref}>
            {failedImageText(texts, source.ref)}
          </span>
        ) : (
          <button
            key={index}
            type="button"
            className="image-thumb"
            title={texts.imagePreview}
            onClick={() => openImagePreview(source.src, source.alt ?? alt)}
          >
            <img
              src={source.src}
              alt={source.alt ?? alt}
              loading="lazy"
              decoding="async"
              // 占用位比例只用**在字节到齐之前**：真实尺寸由图片自己给出。
              // 不摘掉的话，元数据与真实比例不一致的图会被 aspect-ratio 拉伸变形
              // （服务端按 mediaType 归一化过格式，宽高却可能不是原始比例）。
              style={
                !loaded[index] && source.width && source.height
                  ? { aspectRatio: `${source.width} / ${source.height}` }
                  : undefined
              }
              onLoad={() => setLoaded((prev) => (prev[index] ? prev : { ...prev, [index]: true }))}
              onError={() => setFailed((prev) => ({ ...prev, [index]: true }))}
            />
          </button>
        ),
      )}
    </div>
  );
}

/**
 * 磁盘上的图片文件 → 图库（文件路径先经宿主读成 data URL）。
 *
 * 用途是**agent 交付图片**的两种表达：`present` 申报的文件、以及本轮 write 出来的
 * 文件。实测（2026-09-18）agent 被要求"发一张图"时做的正是这两件事——下载一张 jpg、
 * 写一张 svg、再 `present` 它们——而界面上此前只有两行文件芯片，一张图都看不到。
 * 正文里显式写 `![](…)` 的那条路由 `Markdown` 的 `hydrateLocalImages` 处理，这里
 * 补的是"没有 markdown 引用"的情形。
 *
 * 解析不出来的（工作目录之外、文件被删、超上限）**不渲染任何东西**：那些路径在同一
 * 条消息的文件芯片里照常有名字，这里再画一句「加载失败」只是噪音。
 */
export function LocalImageGallery({ paths }: { paths: string[] }) {
  const texts = useTexts();
  const [urls, setUrls] = useState<Record<string, string>>({});
  // 路径数组每次渲染都是新的：用拼出来的键做依赖，避免每帧重复请求
  const key = paths.join("\n");
  useEffect(() => {
    if (!paths.length) return;
    let cancelled = false;
    // 缓存命中时同步返回（`resolveLocalImages` 会先查缓存），所以重渲染不会重新读盘
    void resolveLocalImages(paths).then((resolved) => {
      if (!cancelled) setUrls(resolved);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const sources = paths
    .filter((path) => urls[path])
    .map((path) => ({ src: urls[path], alt: path, ref: path }));
  return <ImageGallery alt={texts.messageImageAlt} sources={sources} />;
}

/** 浮层当前显示的图。 */
type PreviewValue = { src: string; alt: string } | null;
let previewValue: PreviewValue = null;
const previewListeners = new Set<(value: PreviewValue) => void>();

/**
 * 打开原图浮层。
 *
 * 走模块级订阅而不是 React Context：**markdown 注入的 `<img>` 也要能打开**
 * （见 `Markdown.tsx` 的点击委托），那条路不在某个组件的 props 树里。
 */
export function openImagePreview(src: string, alt: string): void {
  previewValue = { src, alt };
  for (const listener of previewListeners) listener(previewValue);
}

/** 关掉原图浮层（点背景 / 关闭按钮 / ESC 都走这里）。 */
export function closeImagePreview(): void {
  previewValue = null;
  for (const listener of previewListeners) listener(null);
}

/**
 * 原图浮层。挂在 App 根部**一次**，任何来源的图片共用它。
 *
 * ESC 用**捕获**阶段拦：App 自己也有一个 window 级 ESC（中止生成），不拦的话
 * 「关掉预览」会顺带把 agent 停掉。捕获阶段先于冒泡执行，`stopPropagation`
 * 把这次按键吃掉，只关预览。
 */
export function ImagePreviewLayer() {
  const texts = useTexts();
  const [value, setValue] = useState<PreviewValue>(previewValue);

  useEffect(() => {
    previewListeners.add(setValue);
    return () => {
      previewListeners.delete(setValue);
    };
  }, []);

  useEffect(() => {
    if (!value) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeImagePreview();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [value]);

  if (!value) return null;
  return (
    <div
      className="image-preview"
      role="dialog"
      aria-modal="true"
      aria-label={texts.imagePreview}
      onClick={closeImagePreview}
    >
      {/* 点图本身不该关掉浮层（只有点背景才关） */}
      <img src={value.src} alt={value.alt} onClick={(event) => event.stopPropagation()} />
      <button
        type="button"
        className="image-preview-close"
        title={texts.imagePreviewClose}
        aria-label={texts.imagePreviewClose}
        onClick={closeImagePreview}
      >
        <IconClose size={16} />
      </button>
    </div>
  );
}
